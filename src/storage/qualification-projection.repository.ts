import { isProxy } from 'node:util/types';
import { setTimeout } from 'node:timers/promises';
import { createTokenLaunchDetectedEvent } from '../domain/launchpad-events.js';
import {
  inheritTrustedTerminalAttribution,
  registerTrustedTerminalAttribution,
  trustedTerminalAttribution,
  type TerminalDiagnosticCode,
} from '../domain/terminal-attribution.js';
import type { DomainEvent, DomainEventType } from '../domain/events.js';
import type {
  MetadataFailureReason,
  TokenMetadataSnapshot,
} from '../domain/pumpfun-observation.js';
import { socialMetadataSnapshotId } from '../domain/social-evidence.js';
import type {
  ChainConfirmationStatus,
  ChainCursor,
  TokenLaunch,
} from '../domain/types.js';
import type {
  CanonicalQualificationProjection,
  QualificationCanonicalSnapshot,
  QualificationProjectionRepository,
  QualificationProjectionTransaction,
  QualificationTransactionReplayPolicy,
} from '../ports/qualification-projection-repository.js';
import { canonicalStringifyJson, fromJsonValue, toJsonValue } from '../utils/json.js';

interface QueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number | null;
}

interface QualificationProjectionClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(error?: Error | boolean): void;
}

export interface QualificationProjectionPool {
  connect(): Promise<QualificationProjectionClient>;
}

export interface QualificationProjectionAuthority {
  reauthorize(projection: CanonicalQualificationProjection): unknown;
}

const QUALIFICATION_LOCK_EVICTION_MESSAGE =
  'Qualification projection session lock eviction required.';
const SERIALIZATION_RETRY_DELAYS_MS = Object.freeze([10, 20]);

export class QualificationProjectionDataError extends Error {
  public constructor(message = 'Stored qualification projection data is invalid.') {
    super(message);
    this.name = 'QualificationProjectionDataError';
  }
}

export class QualificationProjectionRepositoryError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Qualification projection transaction failed.', options);
    this.name = 'QualificationProjectionRepositoryError';
  }
}

export class PostgresQualificationProjectionRepository
implements QualificationProjectionRepository {
  public constructor(
    private readonly database: QualificationProjectionPool,
    private readonly authority: QualificationProjectionAuthority,
    private readonly waitFor: (delayMs: number) => Promise<void> = setTimeout,
  ) {}

  public async transact<TResult>(
    mint: string,
    operation: (transaction: QualificationProjectionTransaction) => Promise<TResult>,
    replayPolicy: QualificationTransactionReplayPolicy = 'none',
  ): Promise<TResult> {
    if (
      mint.length === 0
      || mint.trim() !== mint
      || Buffer.byteLength(mint, 'utf8') > 16_384
    ) throw new TypeError('Qualification projection mint is required.');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Validate untyped callers before connecting.
    if (replayPolicy !== 'none' && replayPolicy !== 'bounded-serialization') {
      throw new TypeError('Qualification transaction replay policy is invalid.');
    }
    const retryableFailures = new WeakSet();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.transactOnce(mint, operation, retryableFailures);
      } catch (error: unknown) {
        const delayMs = replayPolicy === 'bounded-serialization'
          ? SERIALIZATION_RETRY_DELAYS_MS[attempt] : undefined;
        if (delayMs === undefined || typeof error !== 'object' || error === null
          || !retryableFailures.has(error)) throw error;
        try { await this.waitFor(delayMs); } catch { throw error; }
      }
    }
  }

  private async transactOnce<TResult>(
    mint: string,
    operation: (transaction: QualificationProjectionTransaction) => Promise<TResult>,
    retryableFailures: WeakSet<object>,
  ): Promise<TResult> {
    const querySerializationFailures = new WeakSet();
    let client: QualificationProjectionClient;
    try {
      client = diagnosticClient(await this.database.connect(), querySerializationFailures);
    } catch {
      throw attributed(new QualificationProjectionRepositoryError(), 'QUALIFICATION_CONNECT_FAILED');
    }
    let lockAcquired = false;
    let transactionStarted = false;
    let completed = false;
    let result: TResult | undefined;
    let primaryFailure: unknown;
    let primaryTransactionFailure = false;
    let evictClient = false;
    const failures: unknown[] = [];
    try {
      evictClient = true;
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended('qualification-projection:' || $1, 0))",
        [mint],
      );
      lockAcquired = true;
      evictClient = false;
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      transactionStarted = true;
      result = await operation(new PostgresQualificationProjectionTransaction(
        client,
        mint,
        this.authority,
      ));
      await client.query('COMMIT');
      transactionStarted = false;
      completed = true;
    } catch (error: unknown) {
      primaryFailure = error;
      primaryTransactionFailure = transactionStarted;
      failures.push(error);
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackFailure: unknown) {
          failures.push(rollbackFailure);
        }
        transactionStarted = false;
      }
    } finally {
      if (lockAcquired) {
        try {
          const unlocked = await client.query(
            "SELECT pg_advisory_unlock(hashtextextended('qualification-projection:' || $1, 0))",
            [mint],
          );
          if (unlocked.rows[0]?.pg_advisory_unlock !== true) {
            failures.push(new Error('Qualification projection session lock was not released.'));
            evictClient = true;
          }
        } catch (unlockFailure: unknown) {
          failures.push(unlockFailure);
          evictClient = true;
        }
      }
      try {
        client.release(evictClient ? new Error(QUALIFICATION_LOCK_EVICTION_MESSAGE) : undefined);
      } catch (releaseFailure: unknown) {
        failures.push(releaseFailure);
      }
    }
    if (failures.length !== 0) {
      const dataFailure = isDataFailure(primaryFailure);
      const fallback = completed ? 'QUALIFICATION_CLEANUP_FAILED'
        : dataFailure ? 'QUALIFICATION_DATA_INVALID' : 'QUALIFICATION_PERSISTENCE_UNKNOWN';
      if (failures.length === 1 && dataFailure
        && primaryFailure instanceof QualificationProjectionDataError) {
        throw attributed(primaryFailure, fallback);
      }
      if (
        failures.length === 1
        && dataFailure
      ) throw attributed(invalid(), fallback, primaryFailure);
      const redactedAggregate = new AggregateError(
        failures.map(() => new Error('Qualification projection operation or cleanup failed.')),
        'Qualification projection operation or cleanup failures were aggregated.',
      );
      const failure = attributed(new QualificationProjectionRepositoryError({ cause: redactedAggregate }),
        fallback, completed ? undefined : primaryFailure);
      // Only this attempt's actual driver rejection can authorize replay, never diagnostics.
      if (failures.length === 1 && primaryTransactionFailure && !completed
        && typeof primaryFailure === 'object' && primaryFailure !== null
        && querySerializationFailures.has(primaryFailure)) retryableFailures.add(failure);
      throw failure;
    }
    if (!completed) throw new QualificationProjectionRepositoryError();
    return result as TResult;
  }
}

/** Diagnostic failures must never replace the operation's existing outcome. */
function attributed<T extends object>(
  target: T,
  fallback: TerminalDiagnosticCode,
  source?: unknown,
): T {
  try {
    inheritTrustedTerminalAttribution(target, source);
    if (trustedTerminalAttribution(target) === null) {
      registerTrustedTerminalAttribution(target, {
        version: 1, diagnosticCode: fallback, causeKind: null, pumpWire: null,
      });
    }
  } catch { /* Attribution is best effort; preserve the original failure. */ }
  return target;
}

function isDataFailure(error: unknown): boolean {
  try {
    return typeof error === 'object' && error !== null && !isProxy(error)
      && (error instanceof QualificationProjectionDataError
        || error instanceof TypeError || error instanceof RangeError);
  } catch { return false; }
}

/** Inspect SQLSTATE only at the actual driver rejection boundary, never callbacks. */
function diagnosticClient(
  client: QualificationProjectionClient,
  querySerializationFailures: WeakSet<object>,
): QualificationProjectionClient {
  return {
    async query(text, values): Promise<QueryResult> {
      try {
        return await client.query(text, values);
      } catch (error: unknown) {
        try {
          if (typeof error === 'object' && error !== null && !isProxy(error)) {
            const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
            const code: unknown = descriptor !== undefined && 'value' in descriptor
              ? descriptor.value : undefined;
            if (code === '40001') querySerializationFailures.add(error);
            if (code === '40001' || code === '40P01') {
              attributed(error, code === '40001'
                ? 'QUALIFICATION_POSTGRES_SERIALIZATION' : 'QUALIFICATION_POSTGRES_DEADLOCK');
            }
          }
        } catch { /* Never let diagnostic inspection replace the driver's rejection. */ }
        throw error;
      }
    },
    release(error): void { client.release(error); },
  };
}

class PostgresQualificationProjectionTransaction
implements QualificationProjectionTransaction {
  public constructor(
    private readonly client: QualificationProjectionClient,
    private readonly lockedMint: string,
    private readonly authority: QualificationProjectionAuthority,
  ) {}

  public async loadCanonicalInput(mint: string): Promise<QualificationCanonicalSnapshot | null> {
    this.assertLockedMint(mint);
    const launchResult = await this.client.query(
      `SELECT /* qualification_launch */
          domain.event_id,domain.raw_event_id,domain.type,domain.mint,domain.source,
          domain.program,domain.signature,domain.slot::text AS slot,
          domain.transaction_index,domain.instruction_index,
          domain.inner_instruction_index,domain.confirmation_status,
          domain.blockchain_time,domain.observed_at,domain.payload_version,domain.payload,
          launch.creator,launch.token_program,launch.quote_assets,launch.launchpad,
          launch.program_id,
          launch.created_slot::text AS created_slot,
          launch.created_transaction_index,launch.created_instruction_index,
          launch.created_inner_instruction_index
       FROM token_launches AS launch
       JOIN domain_events AS domain
         ON domain.mint=launch.mint
        AND domain.type='TokenLaunchDetected'
        AND domain.signature=launch.created_signature
        AND domain.slot=launch.created_slot
        AND domain.transaction_index=launch.created_transaction_index
        AND domain.instruction_index=launch.created_instruction_index
        AND domain.inner_instruction_index
          IS NOT DISTINCT FROM launch.created_inner_instruction_index
       JOIN raw_chain_events AS raw ON raw.event_id=domain.raw_event_id
        AND raw.source=domain.source AND raw.program=domain.program
        AND raw.mint=domain.mint AND raw.signature=domain.signature
        AND raw.slot=domain.slot AND raw.transaction_index=domain.transaction_index
        AND raw.instruction_index=domain.instruction_index
        AND raw.inner_instruction_index IS NOT DISTINCT FROM domain.inner_instruction_index
       WHERE launch.mint=$1
         AND domain.raw_event_id IS NOT NULL
         AND domain.confirmation_status <> 'orphaned'
         AND raw.confirmation_status <> 'orphaned'
         AND domain.confirmation_status=raw.confirmation_status
       ORDER BY domain.event_id
       LIMIT 1`,
      [mint],
    );
    const launchRow = launchResult.rows[0];
    if (launchRow === undefined) return null;
    const launchEvent = domainEventFromRow(launchRow);
    const launch = launchFromRow(launchRow, launchEvent);

    const asOfResult = await this.client.query(
      `SELECT /* qualification_as_of */
          domain.event_id,domain.raw_event_id,domain.type,domain.mint,domain.source,
          domain.program,domain.signature,domain.slot::text AS slot,
          domain.transaction_index,domain.instruction_index,
          domain.inner_instruction_index,domain.confirmation_status,
          domain.blockchain_time,domain.observed_at,domain.payload_version,domain.payload
       FROM domain_events AS domain
       JOIN raw_chain_events AS raw ON raw.event_id=domain.raw_event_id
        AND raw.source=domain.source AND raw.program=domain.program
        AND raw.mint=domain.mint AND raw.signature=domain.signature
        AND raw.slot=domain.slot AND raw.transaction_index=domain.transaction_index
        AND raw.instruction_index=domain.instruction_index
        AND raw.inner_instruction_index IS NOT DISTINCT FROM domain.inner_instruction_index
       WHERE domain.mint=$1
         AND domain.raw_event_id IS NOT NULL
         AND domain.confirmation_status <> 'orphaned'
         AND raw.confirmation_status <> 'orphaned'
         AND domain.confirmation_status=raw.confirmation_status
         AND domain.type IN (
           'TokenLaunchDetected','BondingCurveTradeObserved','BondingCurveStateUpdated',
           'BondingCurveCompleted','MigrationObserved','PumpSwapPoolActivated'
         )
       ORDER BY domain.slot DESC,domain.transaction_index DESC,
         domain.instruction_index DESC,COALESCE(domain.inner_instruction_index,-1) DESC,
         domain.event_id DESC
       LIMIT 1`,
      [mint],
    );
    const asOfRow = asOfResult.rows[0];
    if (asOfRow === undefined) throw invalid();
    const asOfEvent = domainEventFromRow(asOfRow);
    const asOfRawEventId = text(asOfRow.raw_event_id);

    const metadataResult = await this.client.query(
      `SELECT /* qualification_metadata_launch */ snapshot_id,mint,uri,
          resolution_status,failure_reason,failure_message,failure_retryable,
          metadata,fetched_at,payload_version,source_launch_event_id
       FROM token_metadata_snapshots
       WHERE mint=$1 AND source_launch_event_id=$2
       ORDER BY fetched_at DESC,snapshot_id DESC LIMIT 1`,
      [mint, launchEvent.id],
    );
    const metadataRow = metadataResult.rows[0];
    const metadata = metadataRow === undefined
      ? null
      : metadataFromRow(metadataRow, launchEvent.id);
    const creatorSellResult = await this.client.query(
      `SELECT /* qualification_sell_by_creator */ EXISTS (
         SELECT 1
         FROM domain_events AS domain
         JOIN raw_chain_events AS raw ON raw.event_id=domain.raw_event_id
          AND raw.source=domain.source AND raw.program=domain.program
          AND raw.mint=domain.mint AND raw.signature=domain.signature
          AND raw.slot=domain.slot AND raw.transaction_index=domain.transaction_index
          AND raw.instruction_index=domain.instruction_index
          AND raw.inner_instruction_index IS NOT DISTINCT FROM domain.inner_instruction_index
         WHERE domain.mint=$1
           AND domain.type='BondingCurveTradeObserved'
           AND domain.raw_event_id IS NOT NULL
           AND domain.confirmation_status <> 'orphaned'
           AND raw.confirmation_status <> 'orphaned'
           AND domain.confirmation_status=raw.confirmation_status
           AND domain.payload #>> '{trade,kind}'='SELL'
           AND domain.payload #>> '{trade,trader}'=$2
       ) AS creator_has_sold`,
      [mint, launch.creator],
    );
    const creatorHasSold = creatorSellResult.rows[0]?.creator_has_sold === true;
    return Object.freeze({
      mint,
      asOfEvent,
      asOfRawEventId,
      launch,
      metadata,
      creatorHasSold,
    });
  }

  public async replaceProjection(
    projection: CanonicalQualificationProjection,
  ): Promise<'UPDATED' | 'UNCHANGED'> {
    this.assertLockedMint(projection.qualificationEvent.mint);
    this.authority.reauthorize(projection);
    const event = projection.qualificationEvent;
    if (
      event.type !== 'QualificationUpdated'
      || event.source !== 'qualification'
      || event.confirmationStatus === 'orphaned'
      || event.payloadVersion !== 1
    ) throw invalid();
    const sourceResult = await this.client.query(
      `SELECT /* qualification_source_mapping */ source.event_id,source.raw_event_id,
          source.type,source.mint,source.program,source.signature,source.slot::text AS slot,
          source.transaction_index,source.instruction_index,
          source.inner_instruction_index,source.confirmation_status,
          source.blockchain_time,source.observed_at,source.payload_version,source.payload
       FROM domain_events AS source
       JOIN raw_chain_events AS raw ON source.raw_event_id=raw.event_id
        AND raw.source=source.source AND raw.program=source.program
        AND raw.mint=source.mint AND raw.signature=source.signature
        AND raw.slot=source.slot AND raw.transaction_index=source.transaction_index
        AND raw.instruction_index=source.instruction_index
        AND raw.inner_instruction_index IS NOT DISTINCT FROM source.inner_instruction_index
       WHERE source.event_id=$1 AND source.raw_event_id=$2 AND source.mint=$3
         AND source.confirmation_status <> 'orphaned'
         AND raw.confirmation_status <> 'orphaned'
         AND source.confirmation_status=raw.confirmation_status
         AND source.type IN (
           'TokenLaunchDetected','BondingCurveTradeObserved','BondingCurveStateUpdated',
           'BondingCurveCompleted','MigrationObserved','PumpSwapPoolActivated'
         )
       FOR SHARE OF source,raw`,
      [projection.sourceEventId, projection.sourceRawEventId, this.lockedMint],
    );
    const sourceRow = sourceResult.rows[0];
    if (sourceRow === undefined) throw invalid();
    assertSourceMapping(sourceRow, projection);

    const profile = projection.report.ruleSet;
    const currentResult = await this.client.query(
      `SELECT /* qualification_current_report */ report_id
       FROM qualification_reports
       WHERE mint=$1 AND profile_id=$2 AND profile_version=$3
         AND superseded_at IS NULL
         AND purge_after > clock_timestamp()
       FOR UPDATE`,
      [event.mint, profile.id, profile.version],
    );
    const currentRow = currentResult.rows[0];
    if (currentRow !== undefined && text(currentRow.report_id) === projection.reportId) {
      await this.assertStoredProjection(projection);
      return 'UNCHANGED';
    }
    const historicalResult = await this.client.query(
      `SELECT /* qualification_historical_report */ report_id
       FROM qualification_reports WHERE report_id=$1
         AND purge_after > clock_timestamp()
       FOR UPDATE`,
      [projection.reportId],
    );
    if (historicalResult.rows[0] !== undefined) {
      await this.assertStoredProjection(projection);
      await this.supersedeCurrentReport(projection);
      const reactivated = await this.client.query(
        `UPDATE qualification_reports SET superseded_at=NULL
         WHERE report_id=$1 AND mint=$2 AND superseded_at IS NOT NULL
           AND purge_after > clock_timestamp()`,
        [projection.reportId, event.mint],
      );
      if (reactivated.rowCount !== 1) throw invalid();
      return 'UPDATED';
    }
    const expiredResult = await this.client.query(
      `SELECT /* qualification_expired_report */ report_id
       FROM qualification_reports WHERE report_id=$1
         AND purge_after <= clock_timestamp()
       FOR UPDATE`,
      [projection.reportId],
    );
    if (expiredResult.rows[0] !== undefined) {
      throw new QualificationProjectionDataError(
        'Stored qualification projection report has expired.',
      );
    }
    const evaluatedAt = retentionDate(projection.report.evaluatedAtMs, 0);
    const purgeAfter = retentionDate(projection.report.evaluatedAtMs, 14_400_000);
    if (!(await this.isFreshAtDatabase(purgeAfter))) throw staleProjection();
    await this.supersedeCurrentReport(projection);
    const existingEvent = await this.client.query(
      `SELECT /* qualification_existing_event */ event_id,raw_event_id,type,mint,source,
          program,signature,slot::text AS slot,transaction_index,instruction_index,
          inner_instruction_index,confirmation_status,blockchain_time,observed_at,
          payload_version,payload
       FROM domain_events WHERE event_id=$1 FOR UPDATE`,
      [event.id],
    );
    if (existingEvent.rows[0] === undefined) {
      const insertedEvent = await this.client.query(
        `INSERT INTO domain_events (
          event_id,raw_event_id,type,mint,source,program,signature,slot,
          transaction_index,instruction_index,inner_instruction_index,
          confirmation_status,blockchain_time,observed_at,payload_version,payload,
          terminal_at,purge_after
        ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
        WHERE $18::timestamptz > clock_timestamp()
        ON CONFLICT (event_id) DO NOTHING`,
        [
          event.id, projection.sourceRawEventId, event.type, event.mint, event.source,
          event.program, event.signature, event.cursor.slot.toString(),
          event.cursor.transactionIndex, event.cursor.instructionIndex,
          event.cursor.innerInstructionIndex, event.confirmationStatus,
          date(event.blockchainTimeMs), new Date(event.observedAtMs),
          event.payloadVersion, toJsonValue(event.payload), evaluatedAt, purgeAfter,
        ],
      );
      if (insertedEvent.rowCount !== 1) {
        if (!(await this.isFreshAtDatabase(purgeAfter))) throw staleProjection();
        const racedEvent = await this.client.query(
          `SELECT /* qualification_existing_event */ event_id,raw_event_id,type,mint,source,
              program,signature,slot::text AS slot,transaction_index,instruction_index,
              inner_instruction_index,confirmation_status,blockchain_time,observed_at,
              payload_version,payload
           FROM domain_events WHERE event_id=$1 FOR UPDATE`,
          [event.id],
        );
        const racedRow = racedEvent.rows[0];
        if (racedRow === undefined) throw invalid();
        assertQualificationEventRow(racedRow, projection);
      }
    } else {
      assertQualificationEventRow(existingEvent.rows[0], projection);
    }
    const insertedReport = await this.client.query(
      `INSERT INTO qualification_reports (
        report_id,mint,source_event_id,source_raw_event_id,qualification_event_id,
        profile_id,profile_version,profile_fingerprint,evidence_fingerprint,verdict,
        preparation_score,social_score,onchain_score,total_score,as_of_slot,
        as_of_transaction_index,as_of_instruction_index,as_of_inner_instruction_index,
        confirmation_status,evaluated_at,superseded_at,purge_after,payload_version,payload
      ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20,NULL,$21,1,$22
      WHERE $21::timestamptz > clock_timestamp()`,
      [
        projection.reportId, event.mint, projection.sourceEventId,
        projection.sourceRawEventId, event.id, profile.id, profile.version,
        profile.fingerprint, projection.evidenceFingerprint, projection.report.verdict,
        projection.report.scores.preparation.score,
        projection.report.scores.socialAuthenticity.score,
        projection.report.scores.onchainHealth.score,
        projection.report.scores.total.score, event.cursor.slot.toString(),
        event.cursor.transactionIndex, event.cursor.instructionIndex,
        event.cursor.innerInstructionIndex, event.confirmationStatus,
        evaluatedAt, purgeAfter, toJsonValue(projection.report),
      ],
    );
    if (insertedReport.rowCount !== 1) {
      if (!(await this.isFreshAtDatabase(purgeAfter))) throw staleProjection();
      throw invalid();
    }
    if (!(await this.isFreshAtDatabase(purgeAfter))) throw staleProjection();
    return 'UPDATED';
  }

  public async dissolveCurrent(mint: string): Promise<void> {
    this.assertLockedMint(mint);
    await this.client.query(
      `UPDATE qualification_reports /* qualification_dissolve */
       SET superseded_at=GREATEST(evaluated_at,LEAST(clock_timestamp(),purge_after))
       WHERE mint=$1 AND superseded_at IS NULL`,
      [mint],
    );
  }

  private async assertStoredProjection(
    projection: CanonicalQualificationProjection,
  ): Promise<void> {
    const stored = await this.client.query(
      `SELECT /* qualification_stored_report */ report.*,
          event.type AS event_type,event.mint AS event_mint,
          event.raw_event_id AS event_raw_event_id,event.source AS event_source,
          event.program AS event_program,event.signature AS event_signature,
          event.slot::text AS event_slot,
          event.transaction_index AS event_transaction_index,
          event.instruction_index AS event_instruction_index,
          event.inner_instruction_index AS event_inner_instruction_index,
          event.confirmation_status AS event_confirmation_status,
          event.blockchain_time AS event_blockchain_time,
          event.observed_at AS event_observed_at,
          event.payload_version AS event_payload_version,event.payload AS event_payload
       FROM qualification_reports AS report
       JOIN domain_events AS event ON event.event_id=report.qualification_event_id
       WHERE report.report_id=$1`,
      [projection.reportId],
    );
    const row = stored.rows[0];
    if (row === undefined) throw invalid();
    assertStoredProjectionRow(row, projection);
  }

  private async supersedeCurrentReport(
    projection: CanonicalQualificationProjection,
  ): Promise<void> {
    const profile = projection.report.ruleSet;
    await this.client.query(
      `UPDATE qualification_reports
       SET superseded_at=GREATEST(evaluated_at,$4)
       WHERE mint=$1 AND profile_id=$2 AND profile_version=$3
         AND superseded_at IS NULL`,
      [
        projection.qualificationEvent.mint,
        profile.id,
        profile.version,
        retentionDate(projection.evaluation.evaluatedAtMs, 0),
      ],
    );
  }

  private async isFreshAtDatabase(purgeAfter: Date): Promise<boolean> {
    const freshnessResult = await this.client.query(
      `SELECT /* qualification_write_freshness */
          $1::timestamptz > clock_timestamp() AS qualification_write_is_fresh`,
      [purgeAfter],
    );
    return booleanValue(freshnessResult.rows[0]?.qualification_write_is_fresh);
  }

  private assertLockedMint(mint: string): void {
    if (mint !== this.lockedMint) {
      throw new QualificationProjectionDataError(
        'Qualification projection mint does not match its lock.',
      );
    }
  }
}

function launchFromRow(row: Record<string, unknown>, event: DomainEvent): TokenLaunch {
  if (event.type !== 'TokenLaunchDetected') throw invalid();
  const payload = record(event.payload);
  if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'launch')) throw invalid();
  const rebuilt = createTokenLaunchDetectedEvent({
    source: event.source,
    program: event.program,
    transaction: Object.freeze({
      signature: event.signature,
      confirmationStatus: event.confirmationStatus,
      blockTimeMs: event.blockchainTimeMs,
      observedAtMs: event.observedAtMs,
      cursor: Object.freeze({
        slot: event.cursor.slot,
        transactionIndex: event.cursor.transactionIndex,
      }),
      raw: null,
    }),
    launch: payload.launch as TokenLaunch,
  }).payload.launch;
  if (
    rebuilt.mint !== text(row.mint)
    || rebuilt.creator !== text(row.creator)
    || event.program !== text(row.program_id)
    || rebuilt.tokenProgram !== tokenProgram(row.token_program)
    || rebuilt.launchpad !== text(row.launchpad)
    || rebuilt.createdAt.slot !== unsignedBigInt(row.created_slot)
    || rebuilt.createdAt.transactionIndex !== index(row.created_transaction_index)
    || rebuilt.createdAt.instructionIndex !== index(row.created_instruction_index)
    || rebuilt.createdAt.innerInstructionIndex !== nullableIndex(row.created_inner_instruction_index)
    || canonicalStringifyJson(rebuilt.quoteAssets)
      !== canonicalStringifyJson(decodeJson(row.quote_assets))
  ) throw invalid();
  return rebuilt;
}

function metadataFromRow(
  row: Record<string, unknown>,
  launchEventId: string,
): TokenMetadataSnapshot {
  const status = row.resolution_status;
  let resolution: TokenMetadataSnapshot['resolution'];
  if (status === 'resolved') {
    if (
      row.failure_reason !== null
      || row.failure_message !== null
      || row.failure_retryable !== null
    ) throw invalid();
    resolution = Object.freeze({
      status: 'RESOLVED',
      metadata: exactPublicMetadata(decodeJson(row.metadata)),
    });
  } else if (status === 'failed') {
    if (row.metadata !== null || typeof row.failure_retryable !== 'boolean') throw invalid();
    resolution = Object.freeze({
      status: 'FAILED',
      reason: metadataFailureReason(row.failure_reason),
      message: text(row.failure_message),
      retryable: row.failure_retryable,
    });
  } else {
    throw invalid();
  }
  const snapshot = Object.freeze({
    mint: text(row.mint),
    uri: text(row.uri),
    resolution,
    fetchedAtMs: timestamp(row.fetched_at),
    payloadVersion: positiveIndex(row.payload_version),
  });
  if (
    text(row.source_launch_event_id) !== launchEventId
    || text(row.snapshot_id) !== socialMetadataSnapshotId({
      sourceLaunchEventId: launchEventId,
      snapshot,
    })
  ) throw invalid();
  return snapshot;
}

function exactPublicMetadata(value: unknown): Extract<
  TokenMetadataSnapshot['resolution'], { readonly status: 'RESOLVED' }
>['metadata'] {
  const fields = record(value);
  const names = [
    'name', 'symbol', 'description', 'imageUrl', 'videoUrl', 'websiteUrl',
    'twitterUrl', 'telegramUrl',
  ] as const;
  if (
    Object.keys(fields).length !== names.length
    || names.some((name) => !Object.hasOwn(fields, name))
  ) throw invalid();
  return Object.freeze({
    name: nullableText(fields.name),
    symbol: nullableText(fields.symbol),
    description: nullableText(fields.description),
    imageUrl: nullableText(fields.imageUrl),
    videoUrl: nullableText(fields.videoUrl),
    websiteUrl: nullableText(fields.websiteUrl),
    twitterUrl: nullableText(fields.twitterUrl),
    telegramUrl: nullableText(fields.telegramUrl),
  });
}

function assertSourceMapping(
  row: Record<string, unknown>,
  projection: CanonicalQualificationProjection,
): void {
  const event = projection.qualificationEvent;
  domainEventType(row.type);
  positiveIndex(row.payload_version);
  record(decodeJson(row.payload));
  if (
    text(row.event_id) !== projection.sourceEventId
    || text(row.raw_event_id) !== projection.sourceRawEventId
    || text(row.mint) !== event.mint
    || text(row.program) !== event.program
    || text(row.signature) !== event.signature
    || unsignedBigInt(row.slot) !== event.cursor.slot
    || index(row.transaction_index) !== event.cursor.transactionIndex
    || index(row.instruction_index) !== event.cursor.instructionIndex
    || nullableIndex(row.inner_instruction_index) !== event.cursor.innerInstructionIndex
    || confirmation(row.confirmation_status) !== event.confirmationStatus
    || nullableTimestamp(row.blockchain_time) !== event.blockchainTimeMs
    || timestamp(row.observed_at) !== event.observedAtMs
  ) throw invalid();
}

function assertQualificationEventRow(
  row: Record<string, unknown>,
  projection: CanonicalQualificationProjection,
): void {
  const event = projection.qualificationEvent;
  if (
    text(row.event_id) !== event.id
    || text(row.raw_event_id) !== projection.sourceRawEventId
    || row.type !== event.type
    || text(row.mint) !== event.mint
    || text(row.source) !== event.source
    || text(row.program) !== event.program
    || text(row.signature) !== event.signature
    || unsignedBigInt(row.slot) !== event.cursor.slot
    || index(row.transaction_index) !== event.cursor.transactionIndex
    || index(row.instruction_index) !== event.cursor.instructionIndex
    || nullableIndex(row.inner_instruction_index) !== event.cursor.innerInstructionIndex
    || confirmation(row.confirmation_status) !== event.confirmationStatus
    || nullableTimestamp(row.blockchain_time) !== event.blockchainTimeMs
    || timestamp(row.observed_at) !== event.observedAtMs
    || positiveIndex(row.payload_version) !== event.payloadVersion
    || canonicalStringifyJson(decodeJson(row.payload))
      !== canonicalStringifyJson(event.payload)
  ) throw invalid();
}

function assertStoredProjectionRow(
  row: Record<string, unknown>,
  projection: CanonicalQualificationProjection,
): void {
  const event = projection.qualificationEvent;
  const report = projection.report;
  const profile = report.ruleSet;
  const evaluatedAt = timestamp(row.evaluated_at);
  if (
    text(row.report_id) !== projection.reportId
    || text(row.mint) !== event.mint
    || text(row.source_event_id) !== projection.sourceEventId
    || text(row.source_raw_event_id) !== projection.sourceRawEventId
    || text(row.qualification_event_id) !== event.id
    || text(row.profile_id) !== profile.id
    || positiveIndex(row.profile_version) !== profile.version
    || hash(row.profile_fingerprint) !== profile.fingerprint
    || hash(row.evidence_fingerprint) !== projection.evidenceFingerprint
    || row.verdict !== report.verdict
    || index(row.preparation_score) !== report.scores.preparation.score
    || index(row.social_score) !== report.scores.socialAuthenticity.score
    || index(row.onchain_score) !== report.scores.onchainHealth.score
    || index(row.total_score) !== report.scores.total.score
    || unsignedBigInt(row.as_of_slot) !== event.cursor.slot
    || index(row.as_of_transaction_index) !== event.cursor.transactionIndex
    || index(row.as_of_instruction_index) !== event.cursor.instructionIndex
    || nullableIndex(row.as_of_inner_instruction_index) !== event.cursor.innerInstructionIndex
    || confirmation(row.confirmation_status) !== event.confirmationStatus
    || evaluatedAt !== report.evaluatedAtMs
    || timestamp(row.purge_after) !== evaluatedAt + 14_400_000
    || positiveIndex(row.payload_version) !== 1
    || canonicalStringifyJson(decodeJson(row.payload)) !== canonicalStringifyJson(report)
    || row.event_type !== event.type
    || text(row.event_mint) !== event.mint
    || text(row.event_raw_event_id) !== projection.sourceRawEventId
    || text(row.event_source) !== event.source
    || text(row.event_program) !== event.program
    || text(row.event_signature) !== event.signature
    || unsignedBigInt(row.event_slot) !== event.cursor.slot
    || index(row.event_transaction_index) !== event.cursor.transactionIndex
    || index(row.event_instruction_index) !== event.cursor.instructionIndex
    || nullableIndex(row.event_inner_instruction_index) !== event.cursor.innerInstructionIndex
    || confirmation(row.event_confirmation_status) !== event.confirmationStatus
    || nullableTimestamp(row.event_blockchain_time) !== event.blockchainTimeMs
    || timestamp(row.event_observed_at) !== event.observedAtMs
    || positiveIndex(row.event_payload_version) !== event.payloadVersion
    || canonicalStringifyJson(decodeJson(row.event_payload))
      !== canonicalStringifyJson(event.payload)
  ) throw invalid();
}

function domainEventFromRow(row: Record<string, unknown>): DomainEvent {
  const event = Object.freeze({
    id: text(row.event_id),
    type: domainEventType(row.type),
    mint: text(row.mint),
    source: text(row.source),
    program: text(row.program),
    signature: text(row.signature),
    cursor: cursorFromRow(row),
    confirmationStatus: confirmation(row.confirmation_status),
    blockchainTimeMs: nullableTimestamp(row.blockchain_time),
    observedAtMs: timestamp(row.observed_at),
    payloadVersion: positiveIndex(row.payload_version),
    payload: record(decodeJson(row.payload)),
  });
  return event;
}

function decodeJson(value: unknown): unknown {
  let decoded: unknown;
  try {
    decoded = fromJsonValue(value);
    canonicalStringifyJson(decoded);
    return deepFreeze(decoded);
  } catch {
    throw invalid();
  }
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  return value as Readonly<Record<string, unknown>>;
}

function cursorFromRow(row: Record<string, unknown>): ChainCursor {
  return Object.freeze({
    slot: unsignedBigInt(row.slot),
    transactionIndex: index(row.transaction_index),
    instructionIndex: index(row.instruction_index),
    innerInstructionIndex: nullableIndex(row.inner_instruction_index),
  });
}

function text(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > 16_384
  ) throw invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function hash(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw invalid();
  return result;
}

function unsignedBigInt(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) throw invalid();
  if (value.length > 78) throw invalid();
  return BigInt(value);
}

function index(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || Object.is(value, -0)
  ) throw invalid();
  return value;
}

function positiveIndex(value: unknown): number {
  const result = index(value);
  if (result === 0) throw invalid();
  return result;
}

function nullableIndex(value: unknown): number | null {
  return value === null ? null : index(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}

function timestamp(value: unknown): number {
  if (!(value instanceof Date)) throw invalid();
  const result = value.getTime();
  if (!Number.isSafeInteger(result) || result < 0) throw invalid();
  return result;
}

function nullableTimestamp(value: unknown): number | null {
  return value === null ? null : timestamp(value);
}

function date(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}

function retentionDate(value: number, offsetMs: number): Date {
  const timestampMs = value + offsetMs;
  if (!Number.isSafeInteger(timestampMs)) throw invalid();
  const result = new Date(timestampMs);
  if (!Number.isSafeInteger(result.getTime()) || result.getTime() < 0) throw invalid();
  return result;
}

function confirmation(value: unknown): ChainConfirmationStatus {
  if (
    value !== 'processed'
    && value !== 'confirmed'
    && value !== 'finalized'
    && value !== 'orphaned'
  ) throw invalid();
  return value;
}

function tokenProgram(value: unknown): TokenLaunch['tokenProgram'] {
  if (value !== 'SPL_TOKEN' && value !== 'TOKEN_2022') throw invalid();
  return value;
}

function domainEventType(value: unknown): DomainEventType {
  if (
    value !== 'TokenLaunchDetected'
    && value !== 'BondingCurveTradeObserved'
    && value !== 'BondingCurveStateUpdated'
    && value !== 'BondingCurveCompleted'
    && value !== 'MigrationObserved'
    && value !== 'PumpSwapPoolActivated'
  ) throw invalid();
  return value;
}

function metadataFailureReason(value: unknown): MetadataFailureReason {
  if (
    value !== 'URI_INVALID'
    && value !== 'UNSUPPORTED_URI_SCHEME'
    && value !== 'FETCH_FAILED'
    && value !== 'HTTP_STATUS_INVALID'
    && value !== 'REDIRECT_LIMIT_EXCEEDED'
    && value !== 'CONTENT_TOO_LARGE'
    && value !== 'JSON_INVALID'
    && value !== 'JSON_SHAPE_INVALID'
  ) throw invalid();
  return value;
}

function invalid(): QualificationProjectionDataError {
  return new QualificationProjectionDataError();
}

function staleProjection(): QualificationProjectionDataError {
  return new QualificationProjectionDataError(
    'Qualification projection report is already stale.',
  );
}

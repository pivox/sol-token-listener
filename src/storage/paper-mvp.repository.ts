import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import {
  createPaperMvpPositionSample,
  createPaperMvpReport,
  type PaperMvpCompletionReason,
  type PaperMvpPositionSample,
  type PaperMvpProviderUsage,
} from '../domain/paper-mvp.js';
import { assertValidTimestampMs } from '../domain/timestamp.js';
import type {
  PaperMvpProgress,
  PaperMvpRepository,
  PaperMvpProgressCounters,
  PaperMvpRun,
  PaperMvpRunConfiguration,
  PaperMvpRunCounters,
  PaperMvpRunSnapshot,
  PaperMvpTerminalization,
  PaperMvpUnknownPosition,
  PaperMvpUnknownReason,
} from '../ports/paper-mvp-repository.js';
import { canonicalStringifyJson } from '../utils/json.js';
import { getDatabasePool } from './database.js';

type Row = Readonly<Record<string, unknown>>;
interface Result { readonly rows: readonly Row[]; readonly rowCount: number | null }
interface Client {
  query(text: string, values?: readonly unknown[]): Promise<Result>;
  release(): void;
}
export interface PaperMvpPool { connect(): Promise<Client> }

type Operation = 'start' | 'progress' | 'load' | 'terminalize';
export type PaperMvpConflictCode =
  | 'ACTIVE_RUN_INCOMPATIBLE' | 'RUN_NOT_ACTIVE' | 'SAMPLE_CONTRADICTION'
  | 'RUN_OWNERSHIP_LOST'
  | 'PROGRESS_REGRESSION' | 'PROGRESS_LIMIT_EXCEEDED' | 'PROGRESS_SNAPSHOT_STALE'
  | 'TERMINALIZATION_CONTRADICTION';

export class PaperMvpConflictError extends Error {
  public constructor(public readonly code: PaperMvpConflictCode) {
    super('Paper MVP persisted state conflicts with the requested operation.');
    this.name = 'PaperMvpConflictError';
  }
}

export class PaperMvpRepositoryError extends Error {
  public constructor(public readonly operation: Operation) {
    super('Paper MVP repository operation failed.');
    this.name = 'PaperMvpRepositoryError';
  }
}

const RUN_COLUMNS = `run.*,
  (SELECT COUNT(*)::integer FROM paper_mvp_position_samples observation
    WHERE observation.run_id=run.run_id AND observation.sample_status='VALID') AS closed_positions`;
const UNKNOWN_REASONS = Object.freeze([
  'MISSING_CREATION_DETECTED_AT','MISSING_ENTRY_DECISION_AT','MISSING_ENTRY_QUOTE_AT',
  'MISSING_PAPER_BUY_AT','MISSING_EXIT_TRIGGER_AT','MISSING_EXIT_QUOTE_AT',
  'MISSING_PAPER_SELL_AT','INVALID_TIMESTAMP_ORDER','MISSING_BUY_TRADE',
  'MISSING_SELL_TRADE','UNSUPPORTED_EXIT_REASON','SOURCE_CONTRADICTION','POSITION_RETRACTED',
] as const);
const MAX_NUMERIC_78 = 10n ** 78n - 1n;
const OWNER_FENCE_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended('paper-mvp-owner-fence:v1', 0))";
const SHARED_OWNER_FENCE_SQL =
  "SELECT pg_advisory_xact_lock_shared(hashtextextended('paper-mvp-owner-fence:v1', 0))";

export class PostgresPaperMvpRepository implements PaperMvpRepository {
  public constructor(private readonly pool: PaperMvpPool = getDatabasePool()) {}

  public async startOrResume(
    configuration: PaperMvpRunConfiguration,
    runnerOwnerId: string,
    nowMs: number,
  ): Promise<PaperMvpRun> {
    const config = validateConfiguration(configuration);
    ownerId(runnerOwnerId);
    timestamp(nowMs, 'nowMs');
    timestamp(nowMs + config.maxDurationMs, 'deadlineAtMs');
    return this.transaction('start', async (client) => {
      await client.query(OWNER_FENCE_SQL);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('paper-mvp-active-run', 0))",
      );
      const active = await client.query(
        `SELECT ${RUN_COLUMNS} FROM paper_mvp_runs run
         WHERE run.state='RUNNING' ORDER BY run.started_at,run.run_id LIMIT 1 FOR UPDATE OF run`,
      );
      const row = active.rows[0];
      if (row !== undefined) {
        if (safeNumber(row.payload_version) !== 3) {
          throw new PaperMvpConflictError('ACTIVE_RUN_INCOMPATIBLE');
        }
        const run = runFromRow(row);
        if (!sameConfiguration(run.configuration, config)) {
          throw new PaperMvpConflictError('ACTIVE_RUN_INCOMPATIBLE');
        }
        const claimed = await client.query(
          `UPDATE paper_mvp_runs run SET runner_owner_id=$2
           WHERE run_id=$1 RETURNING run.*,
            (SELECT COUNT(*)::integer FROM paper_mvp_position_samples observation
              WHERE observation.run_id=run.run_id AND observation.sample_status='VALID') AS closed_positions`,
          [run.runId, runnerOwnerId],
        );
        return requiredRun(claimed.rows[0]);
      }
      const runId = `paper_mvp_run_${randomUUID()}`;
      const startedAt = new Date(nowMs);
      const deadlineAt = new Date(nowMs + config.maxDurationMs);
      const inserted = await client.query(
        `INSERT INTO paper_mvp_runs (
          run_id,strategy_id,strategy_version,quote_mint,target_closed_positions,
          initial_capital_raw,network_fee_raw_per_transaction,max_duration_ms,
          entry_quote_amount_raw,slippage_bps,minimum_confirmation,entry_window_ms,
          quote_max_age_ms,quote_max_slot_lag,creation_entry_max_age_ms,
          creation_entry_max_slot_lag,external_minimum_buy_amount_raw,
          external_unique_buyers_target,take_profit_multiplier_bps,manual_kill_switch,
          maximum_round_trip_loss_bps,decision_poll_interval_ms,decision_lease_ms,
          decision_retry_max_attempts,decision_retry_base_delay_ms,
          qualification_profile_fingerprint,provider_identity,
          state,started_at,deadline_at,updated_at,payload_version,
          configuration_payload,runner_owner_id
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
          $19,$20,$21,$22,$23,$24,$25,$26,$27,'RUNNING',$28,$29,$28,3,$30::jsonb,$31
        )
        RETURNING *,0::integer AS closed_positions`,
        [runId,config.strategyId,config.strategyVersion,config.quoteMint,
          config.targetClosedPositions,config.initialCapitalRaw.toString(),
          config.networkFeeRawPerTransaction.toString(),config.maxDurationMs,
          config.entryQuoteAmountRaw.toString(),config.slippageBps.toString(),
          config.minimumConfirmation,config.entryWindowMs,config.quoteMaxAgeMs,
          config.quoteMaxSlotLag,config.creationEntryMaxAgeMs,
          config.creationEntryMaxSlotLag,config.externalMinimumBuyAmountRaw.toString(),
          config.externalUniqueBuyersTarget,config.takeProfitMultiplierBps.toString(),
          config.manualKillSwitch,config.maximumRoundTripLossBps.toString(),
          config.decisionPollIntervalMs,config.decisionLeaseMs,
          config.decisionRetryMaxAttempts,config.decisionRetryBaseDelayMs,
          config.qualificationProfileFingerprint,config.providerIdentity,
          startedAt,deadlineAt,configurationJson(config),runnerOwnerId],
      );
      return requiredRun(inserted.rows[0]);
    });
  }

  public async recordProgress(progress: PaperMvpProgress): Promise<PaperMvpRun> {
    boundedText(progress.runId, 'runId');
    ownerId(progress.runnerOwnerId);
    timestamp(progress.expectedUpdatedAtMs, 'expectedUpdatedAtMs');
    timestamp(progress.observedAtMs, 'observedAtMs');
    const counters = validateCounters(progress.counters);
    const usage = validateProviderUsage(progress.providerUsage);
    if (!Array.isArray(progress.samples) || !Array.isArray(progress.unknownPositions)
      || progress.samples.length + progress.unknownPositions.length > 1_000) {
      throw new TypeError('Paper MVP observations are invalid.');
    }
    const samples = Object.freeze(progress.samples.map(canonicalSample));
    const unknowns = Object.freeze(progress.unknownPositions.map(validateUnknown));
    const ids = new Set<string>();
    for (const observation of [...samples, ...unknowns]) {
      const positionId = observation.positionId;
      if (ids.has(positionId)) throw new TypeError('Paper MVP observation is duplicated.');
      ids.add(positionId);
    }
    return this.transaction('progress', async (client) => {
      await client.query(SHARED_OWNER_FENCE_SQL);
      await lockRun(client, progress.runId);
      const before = await selectRun(client, progress.runId, true);
      if (before?.state !== 'RUNNING') {
        throw new PaperMvpConflictError('RUN_NOT_ACTIVE');
      }
      if (before.runnerOwnerId !== progress.runnerOwnerId) {
        throw new PaperMvpConflictError('RUN_OWNERSHIP_LOST');
      }
      if (before.updatedAtMs !== progress.expectedUpdatedAtMs) {
        throw new PaperMvpConflictError('PROGRESS_SNAPSHOT_STALE');
      }
      assertProgress(before, counters, usage, progress.observedAtMs);
      for (const sample of samples) {
        if (sample.networkFeeRawPerTransaction
          !== before.configuration.networkFeeRawPerTransaction) {
          throw new PaperMvpConflictError('SAMPLE_CONTRADICTION');
        }
        await insertValidObservation(client, progress.runId, progress.observedAtMs, sample);
      }
      for (const unknown of unknowns) {
        await insertUnknownObservation(client, progress.runId, progress.observedAtMs, unknown);
      }
      await assertObservationLimits(
        client, progress.runId, before.configuration.targetClosedPositions,
        counters.openedPositions ?? 0,
      );
      const updated = await client.query(
        `UPDATE paper_mvp_runs run SET
          creations_observed=$2,entries_rejected=$3,
          unknown_terminal_positions=(SELECT COUNT(*)::integer
            FROM paper_mvp_position_samples observation
            WHERE observation.run_id=run.run_id AND observation.sample_status='UNKNOWN'),
          duplicate_logical_buys=$4,duplicate_logical_sells=$5,
          opened_positions=$6,open_positions=$7,provider_status=$8,provider_credits_used_start=$9,
          provider_credits_used_end=$10,provider_rate_limited_count=$11,updated_at=$12
         WHERE run.run_id=$1 RETURNING run.*,
          (SELECT COUNT(*)::integer FROM paper_mvp_position_samples observation
            WHERE observation.run_id=run.run_id AND observation.sample_status='VALID') AS closed_positions`,
        [progress.runId,counters.creationsObserved,counters.entriesRejected,
          counters.duplicateLogicalBuys,counters.duplicateLogicalSells,
          counters.openedPositions,counters.openPositions,usage.status,
          decimal(usage.creditsUsedStart),decimal(usage.creditsUsedEnd),
          usage.rateLimitedCount,new Date(progress.observedAtMs)],
      );
      return requiredRun(updated.rows[0]);
    });
  }

  public async load(runId: string): Promise<PaperMvpRunSnapshot | null> {
    boundedText(runId, 'runId');
    return this.transaction('load', async (client) => {
      const run = await selectRun(client, runId, false);
      if (run === null) return null;
      const observations = await selectObservations(client, runId);
      assertObservationCounts(run, observations);
      return Object.freeze({
        run,
        samples: observations.samples,
        unknownPositions: observations.unknownPositions,
      });
    }, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }

  public async terminalize(input: PaperMvpTerminalization): Promise<PaperMvpRun> {
    validateTerminalization(input);
    return this.transaction('terminalize', async (client) => {
      await client.query(SHARED_OWNER_FENCE_SQL);
      await lockRun(client, input.runId);
      const before = await selectRun(client, input.runId, true);
      if (before === null) throw new PaperMvpConflictError('RUN_NOT_ACTIVE');
      let reportJson = input.report === null ? null : canonicalStringifyJson(input.report);
      if (before.state !== 'RUNNING') {
        const stored = await client.query(
          `SELECT state,terminal_at,failure_code,completion_reason,
            report_payload IS NOT DISTINCT FROM $2::jsonb AS same_report
           FROM paper_mvp_runs WHERE run_id=$1`, [input.runId,reportJson],
        );
        const row = stored.rows[0];
        if (row !== undefined && text(row.state, 'state') === input.state
          && nullableDateMs(row.terminal_at) === input.terminalAtMs
          && nullableText(row.failure_code) === input.failureCode
          && completionReason(row.completion_reason) === input.completionReason
          && row.same_report === true) return before;
        throw new PaperMvpConflictError('TERMINALIZATION_CONTRADICTION');
      }
      if (before.runnerOwnerId !== input.runnerOwnerId) {
        throw new PaperMvpConflictError('RUN_OWNERSHIP_LOST');
      }
      if (input.terminalAtMs < before.updatedAtMs) {
        throw new TypeError('Paper MVP terminalAtMs is invalid.');
      }
      if (input.state === 'COMPLETED') {
        const observations = await selectObservations(client, input.runId);
        assertObservationCounts(before, observations);
        const canonicalReport = createPaperMvpReport({
          runId: before.runId,
          completionReason: input.completionReason,
          startedAtMs: before.startedAtMs,
          completedAtMs: input.terminalAtMs,
          targetClosedPositions: before.configuration.targetClosedPositions,
          initialCapitalRaw: before.configuration.initialCapitalRaw,
          quoteMint: before.configuration.quoteMint,
          creationsObserved: before.counters.creationsObserved,
          entriesRejected: before.counters.entriesRejected,
          openedPositions: before.counters.openedPositions ?? 0,
          openPositions: before.counters.openPositions ?? 0,
          samples: observations.samples,
          unknownTerminalPositions: observations.unknownPositions.length,
          duplicateLogicalBuys: before.counters.duplicateLogicalBuys,
          duplicateLogicalSells: before.counters.duplicateLogicalSells,
          providerUsage: before.providerUsage,
        });
        const canonicalReportJson = canonicalStringifyJson(canonicalReport);
        if (canonicalStringifyJson(input.report) !== canonicalReportJson) {
          throw new PaperMvpConflictError('TERMINALIZATION_CONTRADICTION');
        }
        reportJson = canonicalReportJson;
      }
      const result = await client.query(
        `UPDATE paper_mvp_runs run SET state=$2,terminal_at=$3::timestamptz,
          purge_after=$3::timestamptz + INTERVAL '4 hours',updated_at=$3::timestamptz,
          verdict=$4,failure_code=$5,report_payload=$6::jsonb,
          completion_reason=$7,runner_owner_id=NULL
         WHERE run_id=$1 RETURNING run.*,
          (SELECT COUNT(*)::integer FROM paper_mvp_position_samples observation
            WHERE observation.run_id=run.run_id AND observation.sample_status='VALID') AS closed_positions`,
        [input.runId,input.state,new Date(input.terminalAtMs),
          input.report?.verdict ?? null,input.failureCode,reportJson,input.completionReason],
      );
      return requiredRun(result.rows[0]);
    });
  }

  private async transaction<TResult>(
    operation: Operation,
    action: (client: Client) => Promise<TResult>,
    beginStatement = 'BEGIN',
  ): Promise<TResult> {
    let client: Client;
    try {
      client = await this.pool.connect();
    } catch {
      throw new PaperMvpRepositoryError(operation);
    }
    try {
      await client.query(beginStatement);
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error: unknown) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the primary category */ }
      if (error instanceof PaperMvpConflictError || error instanceof TypeError
        || error instanceof PaperMvpRepositoryError) throw error;
      throw new PaperMvpRepositoryError(operation);
    } finally {
      client.release();
    }
  }
}

interface PersistedObservations {
  readonly samples: readonly PaperMvpPositionSample[];
  readonly unknownPositions: readonly PaperMvpUnknownPosition[];
}

async function selectObservations(
  client: Client,
  runId: string,
): Promise<PersistedObservations> {
  const result = await client.query(
    `SELECT * FROM paper_mvp_position_samples WHERE run_id=$1
     ORDER BY paper_sell_at NULLS LAST,position_id`, [runId],
  );
  const samples: PaperMvpPositionSample[] = [];
  const unknownPositions: PaperMvpUnknownPosition[] = [];
  for (const row of result.rows) {
    const status = text(row.sample_status, 'sample status');
    if (status === 'VALID') samples.push(sampleFromRow(row));
    else if (status === 'UNKNOWN') unknownPositions.push(Object.freeze({
      positionId: text(row.position_id, 'position id'),
      reason: unknownReason(row.unknown_reason),
    }));
    else throw new PaperMvpRepositoryError('load');
  }
  return Object.freeze({
    samples: Object.freeze(samples),
    unknownPositions: Object.freeze(unknownPositions),
  });
}

function assertObservationCounts(
  run: PaperMvpRun,
  observations: PersistedObservations,
): void {
  if (observations.samples.length !== run.closedPositions
    || observations.unknownPositions.length !== run.counters.unknownTerminalPositions) {
    throw new PaperMvpRepositoryError('load');
  }
}

async function lockRun(client: Client, runId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('paper-mvp-run:' || $1, 0))", [runId],
  );
}

async function selectRun(client: Client, runId: string, forUpdate: boolean): Promise<PaperMvpRun | null> {
  const result = await client.query(
    `SELECT ${RUN_COLUMNS} FROM paper_mvp_runs run WHERE run.run_id=$1${forUpdate ? ' FOR UPDATE OF run' : ''}`,
    [runId],
  );
  return result.rows[0] === undefined ? null : runFromRow(result.rows[0]);
}

async function insertValidObservation(
  client: Client, runId: string, observedAtMs: number, sample: PaperMvpPositionSample,
): Promise<void> {
  const payload = sampleJson(sample);
  const result = await client.query(
    `INSERT INTO paper_mvp_position_samples (
      run_id,position_id,sample_status,unknown_reason,mint,quote_mint,exit_reason,
      creation_detected_at,entry_decision_at,entry_quote_at,paper_buy_at,
      exit_trigger_at,exit_quote_at,paper_sell_at,buy_amount_in_raw,buy_amount_out_raw,
      buy_minimum_amount_out_raw,buy_fees_raw,buy_slippage_bps,buy_price_impact_bps,
      sell_amount_in_raw,sell_amount_out_raw,sell_minimum_amount_out_raw,sell_fees_raw,
      sell_slippage_bps,sell_price_impact_bps,network_fee_raw_per_transaction,
      gross_pnl_raw,model_net_pnl_raw,detection_to_entry_latency_ms,
      exit_trigger_to_sell_latency_ms,payload_version,sample_payload,created_at
    ) VALUES ($1,$2,'VALID',NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
      $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,1,$30::jsonb,$31)
    ON CONFLICT (run_id,position_id) DO NOTHING RETURNING position_id`,
    [runId,sample.positionId,sample.mint,sample.quoteMint,sample.exitReason,
      date(sample.creationDetectedAtMs),date(sample.entryDecisionAtMs),date(sample.entryQuoteAtMs),
      date(sample.paperBuyAtMs),date(sample.exitTriggerAtMs),date(sample.exitQuoteAtMs),
      date(sample.paperSellAtMs),sample.buyAmountInRaw.toString(),sample.buyAmountOutRaw.toString(),
      sample.buyMinimumAmountOutRaw.toString(),sample.buyFeesRaw.toString(),
      sample.buySlippageBps.toString(),sample.buyPriceImpactBps.toString(),
      sample.sellAmountInRaw.toString(),sample.sellAmountOutRaw.toString(),
      sample.sellMinimumAmountOutRaw.toString(),sample.sellFeesRaw.toString(),
      sample.sellSlippageBps.toString(),sample.sellPriceImpactBps.toString(),
      sample.networkFeeRawPerTransaction.toString(),sample.grossPnlRaw.toString(),
      sample.modelNetPnlRaw.toString(),sample.detectionToEntryLatencyMs,
      sample.exitTriggerToSellLatencyMs,payload,new Date(observedAtMs)],
  );
  if (result.rowCount === 0) await requireMatchingObservation(client, runId, sample.positionId, 'VALID', null, payload);
}

async function insertUnknownObservation(
  client: Client, runId: string, observedAtMs: number, value: PaperMvpUnknownPosition,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO paper_mvp_position_samples (
      run_id,position_id,sample_status,unknown_reason,payload_version,sample_payload,created_at
    ) VALUES ($1,$2,'UNKNOWN',$3,1,$4::jsonb,$5)
    ON CONFLICT (run_id,position_id) DO NOTHING RETURNING position_id`,
    [runId,value.positionId,value.reason,unknownJson(value),new Date(observedAtMs)],
  );
  if (result.rowCount === 0) await requireMatchingObservation(
    client,runId,value.positionId,'UNKNOWN',value.reason,unknownJson(value),
  );
}

async function requireMatchingObservation(
  client: Client, runId: string, positionId: string, status: string,
  reason: string | null, payload: string | null,
): Promise<void> {
  const result = await client.query(
    `SELECT sample_status=$3 AS same_status,unknown_reason IS NOT DISTINCT FROM $4 AS same_reason,
      sample_payload IS NOT DISTINCT FROM $5::jsonb AS same_payload
     FROM paper_mvp_position_samples WHERE run_id=$1 AND position_id=$2`,
    [runId,positionId,status,reason,payload],
  );
  const row = result.rows[0];
  if (row?.same_status !== true || row.same_reason !== true || row.same_payload !== true) {
    throw new PaperMvpConflictError('SAMPLE_CONTRADICTION');
  }
}

async function assertObservationLimits(
  client: Client,
  runId: string,
  targetClosedPositions: number,
  openedPositions: number,
): Promise<void> {
  const result = await client.query(
    `SELECT
      COUNT(*) FILTER (WHERE sample_status='VALID')::integer AS valid_count,
      COUNT(*) FILTER (WHERE sample_status='UNKNOWN')::integer AS unknown_count
     FROM paper_mvp_position_samples WHERE run_id=$1`,
    [runId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new PaperMvpConflictError('PROGRESS_LIMIT_EXCEEDED');
  const validCount = safeNumber(row.valid_count);
  if (validCount > targetClosedPositions || safeNumber(row.unknown_count) > 1_000) {
    throw new PaperMvpConflictError('PROGRESS_LIMIT_EXCEEDED');
  }
  if (validCount > openedPositions) {
    throw new PaperMvpConflictError('PROGRESS_REGRESSION');
  }
}

function validateConfiguration(value: PaperMvpRunConfiguration): PaperMvpRunConfiguration {
  boundedText(value.strategyId, 'strategy id');
  integer(value.strategyVersion, 1, 1_000_000, 'strategy version');
  boundedText(value.quoteMint, 'quote mint');
  integer(value.targetClosedPositions, 1, 1_000, 'target closed positions');
  positiveBigint(value.initialCapitalRaw, 'initial capital');
  nonNegativeBigint(value.networkFeeRawPerTransaction, 'network fee');
  integer(value.maxDurationMs, 60_000, 14_400_000, 'max duration');
  positiveBigint(value.entryQuoteAmountRaw, 'entry quote amount');
  nonNegativeBigint(value.slippageBps, 'slippage');
  if (value.slippageBps > 10_000n) throw new TypeError('Paper MVP slippage is invalid.');
  const confirmation = validateMinimumConfirmation(value.minimumConfirmation);
  integer(value.entryWindowMs, 1_000, 3_600_000, 'entry window');
  integer(value.quoteMaxAgeMs, 100, 60_000, 'quote maximum age');
  integer(value.quoteMaxSlotLag, 0, 10_000, 'quote maximum slot lag');
  integer(value.creationEntryMaxAgeMs, 100, 3_600_000, 'creation entry maximum age');
  integer(value.creationEntryMaxSlotLag, 0, 10_000, 'creation entry maximum slot lag');
  positiveBigint(value.externalMinimumBuyAmountRaw, 'external minimum buy amount');
  integer(value.externalUniqueBuyersTarget, 1, 1_000, 'external unique buyers target');
  positiveBigint(value.takeProfitMultiplierBps, 'take profit multiplier');
  if (value.takeProfitMultiplierBps < 10_000n || value.takeProfitMultiplierBps > 1_000_000n) {
    throw new TypeError('Paper MVP take profit multiplier is invalid.');
  }
  if (typeof value.manualKillSwitch !== 'boolean') {
    throw new TypeError('Paper MVP manual kill switch is invalid.');
  }
  nonNegativeBigint(value.maximumRoundTripLossBps, 'maximum round-trip loss');
  if (value.maximumRoundTripLossBps > 10_000n) {
    throw new TypeError('Paper MVP maximum round-trip loss is invalid.');
  }
  integer(value.decisionPollIntervalMs, 100, 60_000, 'decision poll interval');
  integer(value.decisionLeaseMs, 5_000, 900_000, 'decision lease');
  integer(value.decisionRetryMaxAttempts, 1, 100, 'decision retry maximum attempts');
  integer(value.decisionRetryBaseDelayMs, 100, 60_000, 'decision retry base delay');
  if (!/^[a-f0-9]{64}$/u.test(value.qualificationProfileFingerprint)) {
    throw new TypeError('Paper MVP qualification profile fingerprint is invalid.');
  }
  boundedText(value.providerIdentity, 'provider identity');
  return Object.freeze({
    strategyId: value.strategyId,
    strategyVersion: value.strategyVersion,
    quoteMint: value.quoteMint,
    targetClosedPositions: value.targetClosedPositions,
    initialCapitalRaw: value.initialCapitalRaw,
    networkFeeRawPerTransaction: value.networkFeeRawPerTransaction,
    maxDurationMs: value.maxDurationMs,
    entryQuoteAmountRaw: value.entryQuoteAmountRaw,
    slippageBps: value.slippageBps,
    minimumConfirmation: confirmation,
    entryWindowMs: value.entryWindowMs,
    quoteMaxAgeMs: value.quoteMaxAgeMs,
    quoteMaxSlotLag: value.quoteMaxSlotLag,
    creationEntryMaxAgeMs: value.creationEntryMaxAgeMs,
    creationEntryMaxSlotLag: value.creationEntryMaxSlotLag,
    externalMinimumBuyAmountRaw: value.externalMinimumBuyAmountRaw,
    externalUniqueBuyersTarget: value.externalUniqueBuyersTarget,
    takeProfitMultiplierBps: value.takeProfitMultiplierBps,
    manualKillSwitch: value.manualKillSwitch,
    maximumRoundTripLossBps: value.maximumRoundTripLossBps,
    decisionPollIntervalMs: value.decisionPollIntervalMs,
    decisionLeaseMs: value.decisionLeaseMs,
    decisionRetryMaxAttempts: value.decisionRetryMaxAttempts,
    decisionRetryBaseDelayMs: value.decisionRetryBaseDelayMs,
    qualificationProfileFingerprint: value.qualificationProfileFingerprint,
    providerIdentity: value.providerIdentity,
  });
}

function validateCounters(value: PaperMvpProgressCounters): PaperMvpProgressCounters {
  const openedPositions = value.openedPositions ?? 0;
  const openPositions = value.openPositions ?? 0;
  for (const field of [
    'creationsObserved','entriesRejected','duplicateLogicalBuys','duplicateLogicalSells',
    'openedPositions','openPositions',
  ] as const) integer(field === 'openedPositions' ? openedPositions
    : field === 'openPositions' ? openPositions : value[field], 0, 1_000_000, field);
  return Object.freeze({
    creationsObserved: value.creationsObserved,
    entriesRejected: value.entriesRejected,
    duplicateLogicalBuys: value.duplicateLogicalBuys,
    duplicateLogicalSells: value.duplicateLogicalSells,
    openedPositions,
    openPositions,
  });
}

function validateRunCounters(value: PaperMvpRunCounters): PaperMvpRunCounters {
  validateCounters(value);
  integer(value.unknownTerminalPositions, 0, 1_000_000, 'unknownTerminalPositions');
  return Object.freeze({
    creationsObserved: value.creationsObserved,
    entriesRejected: value.entriesRejected,
    unknownTerminalPositions: value.unknownTerminalPositions,
    duplicateLogicalBuys: value.duplicateLogicalBuys,
    duplicateLogicalSells: value.duplicateLogicalSells,
    openedPositions: value.openedPositions ?? 0,
    openPositions: value.openPositions ?? 0,
  });
}

function validateProviderUsage(value: PaperMvpProviderUsage): PaperMvpProviderUsage {
  const fields = providerUsageFields(value);
  if (typeof fields.rateLimitedCount !== 'number') {
    throw new TypeError('Paper MVP provider usage is invalid.');
  }
  integer(fields.rateLimitedCount, 0, 1_000_000, 'rate limited count');
  const status = fields.status;
  if (status === 'UNAVAILABLE') {
    if (fields.creditsUsedStart !== null || fields.creditsUsedEnd !== null) {
      throw new TypeError('Paper MVP provider usage is invalid.');
    }
  } else if (status === 'AVAILABLE') {
    if (typeof fields.creditsUsedStart !== 'bigint' || typeof fields.creditsUsedEnd !== 'bigint'
      || fields.creditsUsedStart < 0n || fields.creditsUsedStart > MAX_NUMERIC_78
      || fields.creditsUsedEnd < fields.creditsUsedStart || fields.creditsUsedEnd > MAX_NUMERIC_78) {
      throw new TypeError('Paper MVP provider usage is invalid.');
    }
  } else throw new TypeError('Paper MVP provider usage is invalid.');
  return Object.freeze({
    status,
    creditsUsedStart: fields.creditsUsedStart,
    creditsUsedEnd: fields.creditsUsedEnd,
    rateLimitedCount: fields.rateLimitedCount,
  });
}

function providerUsageFields(value: unknown): Readonly<Record<
  'status' | 'creditsUsedStart' | 'creditsUsedEnd' | 'rateLimitedCount', unknown
>> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || types.isProxy(value)) {
      throw new TypeError('Paper MVP provider usage is invalid.');
    }
    const result: Record<'status' | 'creditsUsedStart' | 'creditsUsedEnd' | 'rateLimitedCount', unknown> = {
      status: undefined, creditsUsedStart: undefined, creditsUsedEnd: undefined,
      rateLimitedCount: undefined,
    };
    for (const field of ['status','creditsUsedStart','creditsUsedEnd','rateLimitedCount'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new TypeError('Paper MVP provider usage is invalid.');
      }
      result[field] = descriptor.value;
    }
    return result;
  } catch {
    throw new TypeError('Paper MVP provider usage is invalid.');
  }
}

function assertProgress(
  run: PaperMvpRun,
  counters: PaperMvpProgressCounters,
  usage: PaperMvpProviderUsage,
  observedAtMs: number,
): void {
  for (const field of ['creationsObserved','entriesRejected','duplicateLogicalBuys','duplicateLogicalSells'] as const) {
    if (counters[field] < run.counters[field]) throw new PaperMvpConflictError('PROGRESS_REGRESSION');
  }
  if ((counters.openedPositions ?? 0) < (run.counters.openedPositions ?? 0)
    || (counters.openPositions ?? 0) > (counters.openedPositions ?? 0)) {
    throw new PaperMvpConflictError('PROGRESS_REGRESSION');
  }
  const old = run.providerUsage;
  if (observedAtMs <= run.updatedAtMs || usage.rateLimitedCount < old.rateLimitedCount
    || (old.status === 'AVAILABLE' && usage.status !== 'AVAILABLE')
    || (old.status === 'AVAILABLE' && usage.status === 'AVAILABLE'
      && (usage.creditsUsedStart !== old.creditsUsedStart
        || usage.creditsUsedEnd === null || old.creditsUsedEnd === null
        || usage.creditsUsedEnd < old.creditsUsedEnd))) {
    throw new PaperMvpConflictError('PROGRESS_REGRESSION');
  }
}

function validateTerminalization(value: PaperMvpTerminalization): void {
  boundedText(value.runId, 'runId');
  ownerId(value.runnerOwnerId);
  timestamp(value.terminalAtMs, 'terminalAtMs');
  const raw = value as unknown as Readonly<Record<string, unknown>>;
  if (value.state === 'FAILED') {
    boundedText(value.failureCode, 'failure code');
    if (raw.completionReason !== null || raw.report !== null) {
      throw new TypeError('Paper MVP terminalization is invalid.');
    }
  } else if ((raw.completionReason !== 'TARGET_REACHED'
      && raw.completionReason !== 'TIMEOUT'
      && raw.completionReason !== 'SIGINT'
      && raw.completionReason !== 'SIGTERM')
    || raw.failureCode !== null || typeof raw.report !== 'object' || raw.report === null
    || value.report.runId !== value.runId
    || value.report.completionReason !== value.completionReason) {
    throw new TypeError('Paper MVP terminalization is invalid.');
  }
}

function runFromRow(row: Row): PaperMvpRun {
  if (safeNumber(row.payload_version) !== 3) throw stored();
  const state = text(row.state, 'state');
  if (state !== 'RUNNING' && state !== 'COMPLETED' && state !== 'FAILED') throw stored();
  const providerStatus = text(row.provider_status, 'provider status');
  if (providerStatus !== 'AVAILABLE' && providerStatus !== 'UNAVAILABLE') throw stored();
  const configuration = validateConfiguration({
    strategyId:text(row.strategy_id,'strategy id'),strategyVersion:safeNumber(row.strategy_version),
    quoteMint:text(row.quote_mint,'quote mint'),targetClosedPositions:safeNumber(row.target_closed_positions),
    initialCapitalRaw:bigint(row.initial_capital_raw),
    networkFeeRawPerTransaction:bigint(row.network_fee_raw_per_transaction),
    maxDurationMs:safeNumber(row.max_duration_ms),
    entryQuoteAmountRaw:bigint(row.entry_quote_amount_raw),
    slippageBps:bigint(row.slippage_bps),
    minimumConfirmation:storedMinimumConfirmation(row.minimum_confirmation),
    entryWindowMs:safeNumber(row.entry_window_ms),
    quoteMaxAgeMs:safeNumber(row.quote_max_age_ms),
    quoteMaxSlotLag:safeNumber(row.quote_max_slot_lag),
    creationEntryMaxAgeMs:safeNumber(row.creation_entry_max_age_ms),
    creationEntryMaxSlotLag:safeNumber(row.creation_entry_max_slot_lag),
    externalMinimumBuyAmountRaw:bigint(row.external_minimum_buy_amount_raw),
    externalUniqueBuyersTarget:safeNumber(row.external_unique_buyers_target),
    takeProfitMultiplierBps:bigint(row.take_profit_multiplier_bps),
    manualKillSwitch:boolean(row.manual_kill_switch),
    maximumRoundTripLossBps:bigint(row.maximum_round_trip_loss_bps),
    decisionPollIntervalMs:safeNumber(row.decision_poll_interval_ms),
    decisionLeaseMs:safeNumber(row.decision_lease_ms),
    decisionRetryMaxAttempts:safeNumber(row.decision_retry_max_attempts),
    decisionRetryBaseDelayMs:safeNumber(row.decision_retry_base_delay_ms),
    qualificationProfileFingerprint:text(
      row.qualification_profile_fingerprint,'qualification profile fingerprint',
    ),
    providerIdentity:text(row.provider_identity,'provider identity'),
  });
  const counters = validateRunCounters({
    creationsObserved:safeNumber(row.creations_observed),entriesRejected:safeNumber(row.entries_rejected),
    unknownTerminalPositions:safeNumber(row.unknown_terminal_positions),
    duplicateLogicalBuys:safeNumber(row.duplicate_logical_buys),
    duplicateLogicalSells:safeNumber(row.duplicate_logical_sells),
    openedPositions:safeNumber(row.opened_positions),
    openPositions:safeNumber(row.open_positions),
  });
  const providerUsage = validateProviderUsage({
    status:providerStatus,creditsUsedStart:nullableBigint(row.provider_credits_used_start),
    creditsUsedEnd:nullableBigint(row.provider_credits_used_end),
    rateLimitedCount:safeNumber(row.provider_rate_limited_count),
  });
  const runnerOwnerId = nullableText(row.runner_owner_id);
  const durableCompletionReason = completionReason(row.completion_reason);
  if ((state === 'RUNNING' && (runnerOwnerId === null || durableCompletionReason !== null))
    || (state === 'COMPLETED' && (runnerOwnerId !== null || durableCompletionReason === null))
    || (state === 'FAILED' && (runnerOwnerId !== null || durableCompletionReason !== null))) {
    throw stored();
  }
  return Object.freeze({
    runId:text(row.run_id,'run id'),runnerOwnerId,
    completionReason:durableCompletionReason,configuration,state,counters,providerUsage,
    closedPositions:safeNumber(row.closed_positions),startedAtMs:dateMs(row.started_at),
    deadlineAtMs:dateMs(row.deadline_at),updatedAtMs:dateMs(row.updated_at),
    terminalAtMs:nullableDateMs(row.terminal_at),purgeAfterMs:nullableDateMs(row.purge_after),
    verdict:verdict(row.verdict),failureCode:nullableText(row.failure_code),
  });
}

function sampleFromRow(row: Row): PaperMvpPositionSample {
  const sample = createPaperMvpPositionSample({
    positionId:text(row.position_id,'position id'),mint:text(row.mint,'mint'),
    quoteMint:text(row.quote_mint,'quote mint'),exitReason:exitReason(row.exit_reason),
    creationDetectedAtMs:dateMs(row.creation_detected_at),entryDecisionAtMs:dateMs(row.entry_decision_at),
    entryQuoteAtMs:dateMs(row.entry_quote_at),paperBuyAtMs:dateMs(row.paper_buy_at),
    exitTriggerAtMs:dateMs(row.exit_trigger_at),exitQuoteAtMs:dateMs(row.exit_quote_at),
    paperSellAtMs:dateMs(row.paper_sell_at),buyAmountInRaw:bigint(row.buy_amount_in_raw),
    buyAmountOutRaw:bigint(row.buy_amount_out_raw),buyMinimumAmountOutRaw:bigint(row.buy_minimum_amount_out_raw),
    buyFeesRaw:bigint(row.buy_fees_raw),buySlippageBps:bigint(row.buy_slippage_bps),
    buyPriceImpactBps:bigint(row.buy_price_impact_bps),sellAmountInRaw:bigint(row.sell_amount_in_raw),
    sellAmountOutRaw:bigint(row.sell_amount_out_raw),sellMinimumAmountOutRaw:bigint(row.sell_minimum_amount_out_raw),
    sellFeesRaw:bigint(row.sell_fees_raw),sellSlippageBps:bigint(row.sell_slippage_bps),
    sellPriceImpactBps:bigint(row.sell_price_impact_bps),
    networkFeeRawPerTransaction:bigint(row.network_fee_raw_per_transaction),
  });
  if (signedBigint(row.gross_pnl_raw) !== sample.grossPnlRaw
    || derivedSignedBigint(row.model_net_pnl_raw) !== sample.modelNetPnlRaw
    || safeNumber(row.detection_to_entry_latency_ms) !== sample.detectionToEntryLatencyMs
    || safeNumber(row.exit_trigger_to_sell_latency_ms) !== sample.exitTriggerToSellLatencyMs) {
    throw stored();
  }
  return sample;
}

function canonicalSample(value: PaperMvpPositionSample): PaperMvpPositionSample {
  const canonical = createPaperMvpPositionSample({
    positionId: value.positionId,
    mint: value.mint,
    quoteMint: value.quoteMint,
    exitReason: value.exitReason,
    creationDetectedAtMs: value.creationDetectedAtMs,
    entryDecisionAtMs: value.entryDecisionAtMs,
    entryQuoteAtMs: value.entryQuoteAtMs,
    paperBuyAtMs: value.paperBuyAtMs,
    exitTriggerAtMs: value.exitTriggerAtMs,
    exitQuoteAtMs: value.exitQuoteAtMs,
    paperSellAtMs: value.paperSellAtMs,
    buyAmountInRaw: value.buyAmountInRaw,
    buyAmountOutRaw: value.buyAmountOutRaw,
    buyMinimumAmountOutRaw: value.buyMinimumAmountOutRaw,
    buyFeesRaw: value.buyFeesRaw,
    buySlippageBps: value.buySlippageBps,
    buyPriceImpactBps: value.buyPriceImpactBps,
    sellAmountInRaw: value.sellAmountInRaw,
    sellAmountOutRaw: value.sellAmountOutRaw,
    sellMinimumAmountOutRaw: value.sellMinimumAmountOutRaw,
    sellFeesRaw: value.sellFeesRaw,
    sellSlippageBps: value.sellSlippageBps,
    sellPriceImpactBps: value.sellPriceImpactBps,
    networkFeeRawPerTransaction: value.networkFeeRawPerTransaction,
  });
  if (value.exitCategory !== canonical.exitCategory
    || value.grossPnlRaw !== canonical.grossPnlRaw || value.modelNetPnlRaw !== canonical.modelNetPnlRaw
    || value.detectionToEntryLatencyMs !== canonical.detectionToEntryLatencyMs
    || value.exitTriggerToSellLatencyMs !== canonical.exitTriggerToSellLatencyMs) {
    throw new TypeError('Paper MVP sample projection is invalid.');
  }
  return canonical;
}

function validateUnknown(value: PaperMvpUnknownPosition): PaperMvpUnknownPosition {
  boundedText(value.positionId, 'position id');
  return Object.freeze({ positionId:value.positionId, reason:unknownReason(value.reason) });
}

function unknownReason(value: unknown): PaperMvpUnknownReason {
  if (typeof value !== 'string' || !UNKNOWN_REASONS.includes(value as PaperMvpUnknownReason)) throw stored();
  return value as PaperMvpUnknownReason;
}

function sampleJson(value: PaperMvpPositionSample): string {
  return JSON.stringify({
    schemaVersion:'paper-mvp-position-sample.v1',
    positionId:value.positionId,mint:value.mint,quoteMint:value.quoteMint,
    exitReason:value.exitReason,creationDetectedAtMs:value.creationDetectedAtMs,
    entryDecisionAtMs:value.entryDecisionAtMs,entryQuoteAtMs:value.entryQuoteAtMs,
    paperBuyAtMs:value.paperBuyAtMs,exitTriggerAtMs:value.exitTriggerAtMs,
    exitQuoteAtMs:value.exitQuoteAtMs,paperSellAtMs:value.paperSellAtMs,
    buyAmountInRaw:value.buyAmountInRaw.toString(),buyAmountOutRaw:value.buyAmountOutRaw.toString(),
    buyMinimumAmountOutRaw:value.buyMinimumAmountOutRaw.toString(),buyFeesRaw:value.buyFeesRaw.toString(),
    buySlippageBps:value.buySlippageBps.toString(),buyPriceImpactBps:value.buyPriceImpactBps.toString(),
    sellAmountInRaw:value.sellAmountInRaw.toString(),sellAmountOutRaw:value.sellAmountOutRaw.toString(),
    sellMinimumAmountOutRaw:value.sellMinimumAmountOutRaw.toString(),sellFeesRaw:value.sellFeesRaw.toString(),
    sellSlippageBps:value.sellSlippageBps.toString(),sellPriceImpactBps:value.sellPriceImpactBps.toString(),
    networkFeeRawPerTransaction:value.networkFeeRawPerTransaction.toString(),
    grossPnlRaw:value.grossPnlRaw.toString(),modelNetPnlRaw:value.modelNetPnlRaw.toString(),
    exitCategory:value.exitCategory,detectionToEntryLatencyMs:value.detectionToEntryLatencyMs,
    exitTriggerToSellLatencyMs:value.exitTriggerToSellLatencyMs,payloadVersion:value.payloadVersion,
  });
}

function configurationJson(value: PaperMvpRunConfiguration): string {
  return JSON.stringify({
    schemaVersion:'paper-mvp-run-configuration.v3',strategyId:value.strategyId,
    strategyVersion:value.strategyVersion,quoteMint:value.quoteMint,
    targetClosedPositions:value.targetClosedPositions,
    initialCapitalRaw:value.initialCapitalRaw.toString(),
    networkFeeRawPerTransaction:value.networkFeeRawPerTransaction.toString(),
    maxDurationMs:value.maxDurationMs,
    entryQuoteAmountRaw:value.entryQuoteAmountRaw.toString(),
    slippageBps:value.slippageBps.toString(),
    minimumConfirmation:value.minimumConfirmation,
    entryWindowMs:value.entryWindowMs,
    quoteMaxAgeMs:value.quoteMaxAgeMs,
    quoteMaxSlotLag:value.quoteMaxSlotLag,
    creationEntryMaxAgeMs:value.creationEntryMaxAgeMs,
    creationEntryMaxSlotLag:value.creationEntryMaxSlotLag,
    externalMinimumBuyAmountRaw:value.externalMinimumBuyAmountRaw.toString(),
    externalUniqueBuyersTarget:value.externalUniqueBuyersTarget,
    takeProfitMultiplierBps:value.takeProfitMultiplierBps.toString(),
    manualKillSwitch:value.manualKillSwitch,
    maximumRoundTripLossBps:value.maximumRoundTripLossBps.toString(),
    decisionPollIntervalMs:value.decisionPollIntervalMs,
    decisionLeaseMs:value.decisionLeaseMs,
    decisionRetryMaxAttempts:value.decisionRetryMaxAttempts,
    decisionRetryBaseDelayMs:value.decisionRetryBaseDelayMs,
    qualificationProfileFingerprint:value.qualificationProfileFingerprint,
    providerIdentity:value.providerIdentity,
  });
}

function unknownJson(value: PaperMvpUnknownPosition): string {
  return JSON.stringify({
    schemaVersion:'paper-mvp-unknown-position.v1',
    positionId:value.positionId,
    reason:value.reason,
  });
}

function sameConfiguration(a: PaperMvpRunConfiguration,b: PaperMvpRunConfiguration): boolean {
  return configurationJson(a) === configurationJson(b);
}
function requiredRun(row: Row | undefined): PaperMvpRun { if (row === undefined) throw stored(); return runFromRow(row); }
function stored(): PaperMvpRepositoryError { return new PaperMvpRepositoryError('load'); }
function timestamp(value:number,field:string):void { try { assertValidTimestampMs('occurredAtMs',value); } catch { throw new TypeError(`Paper MVP ${field} is invalid.`); } }
function boundedText(value:string,field:string):void { if(typeof value!=='string'||value.length===0||value!==value.trim()||Buffer.byteLength(value)>512)throw new TypeError(`Paper MVP ${field} is invalid.`); }
function ownerId(value:string):void { if(typeof value!=='string'||value.length===0||value!==value.trim()||Buffer.byteLength(value)>256)throw new TypeError('Paper MVP runner owner is invalid.'); }
function integer(value:number,min:number,max:number,field:string):void { if(!Number.isSafeInteger(value)||value<min||value>max)throw new TypeError(`Paper MVP ${field} is invalid.`); }
function positiveBigint(value:bigint,field:string):void { if(typeof value!=='bigint'||value<=0n||value.toString().length>78)throw new TypeError(`Paper MVP ${field} is invalid.`); }
function nonNegativeBigint(value:bigint,field:string):void { if(typeof value!=='bigint'||value<0n||value.toString().length>78)throw new TypeError(`Paper MVP ${field} is invalid.`); }
function date(ms:number):Date { return new Date(ms); }
function decimal(value:bigint|null):string|null { return value?.toString() ?? null; }
function text(value:unknown,field:string):string { if(typeof value!=='string'||value.length===0)throw new PaperMvpRepositoryError('load'); void field; return value; }
function safeNumber(value:unknown):number { const parsed=typeof value==='number'?value:typeof value==='string'?Number(value):NaN; if(!Number.isSafeInteger(parsed)||parsed<0)throw stored(); return parsed; }
function boolean(value:unknown):boolean { if(typeof value!=='boolean')throw stored(); return value; }
function validateMinimumConfirmation(value:unknown):'confirmed'|'finalized' { if(value!=='confirmed'&&value!=='finalized')throw new TypeError('Paper MVP minimum confirmation is invalid.'); return value; }
function storedMinimumConfirmation(value:unknown):'confirmed'|'finalized' { if(value!=='confirmed'&&value!=='finalized')throw stored(); return value; }
function bigint(value:unknown):bigint { if(typeof value!=='string'||!/^\d{1,78}$/u.test(value))throw stored(); return BigInt(value); }
function signedBigint(value:unknown):bigint { if(typeof value!=='string'||!/^-?\d{1,78}$/u.test(value))throw stored(); return BigInt(value); }
function derivedSignedBigint(value:unknown):bigint { if(typeof value!=='string'||!/^[-]?\d{1,79}$/u.test(value))throw stored(); return BigInt(value); }
function nullableBigint(value:unknown):bigint|null { return value===null?null:bigint(value); }
function dateMs(value:unknown):number { if(!(value instanceof Date)||!Number.isSafeInteger(value.getTime()))throw stored(); return value.getTime(); }
function nullableDateMs(value:unknown):number|null { return value===null?null:dateMs(value); }
function nullableText(value:unknown):string|null { return value===null?null:text(value,'text'); }
function completionReason(value:unknown):PaperMvpCompletionReason|null { if(value===null)return null; if(value==='TARGET_REACHED'||value==='TIMEOUT'||value==='SIGINT'||value==='SIGTERM'||value==='LEGACY')return value; throw stored(); }
function verdict(value:unknown):'PASS'|'FAIL'|null { if(value===null||value==='PASS'||value==='FAIL')return value; throw stored(); }
function exitReason(value:unknown):PaperMvpPositionSample['exitReason'] { if(value==='EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED'||value==='TAKE_PROFIT_2X_EXECUTABLE'||value==='CREATOR_EARLY_SELL'||value==='MANUAL_KILL_SWITCH')return value; throw stored(); }

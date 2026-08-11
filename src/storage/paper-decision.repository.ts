import { createHash, randomUUID } from 'node:crypto';
import { compareCursors } from '../domain/cursor.js';
import { createDeterministicDerivedEventId, type DomainEvent } from '../domain/events.js';
import type { BondingCurveTradeObservedEventV1 } from '../domain/launchpad-events.js';
import type { MarketTrade } from '../domain/market.js';
import type { PaperStrategySessionV1 } from '../domain/paper-strategy.js';
import type { PaperPosition } from '../domain/paper-trading.js';
import type { CreatorProfile, HolderDistribution } from '../domain/participant-analytics.js';
import type { TokenMetadataSnapshot } from '../domain/pumpfun-observation.js';
import type { SocialEvidenceCollectionV1 } from '../domain/social-evidence.js';
import type { TradingCandidateV1 } from '../domain/trading-candidate.js';
import type { ChainConfirmationStatus, TokenLaunch } from '../domain/types.js';
import type {
  WalletCluster,
  WalletClusterMember,
  WalletGraphAnalysis,
  WalletRelationship,
} from '../domain/wallet-graph.js';
import type {
  ClaimedPaperDecisionJob,
  PaperDecisionFailure,
  PaperDecisionJobInput,
  PaperDecisionQueueCounts,
  PaperDecisionRepository,
  PaperDecisionResult,
  PaperDecisionSnapshot,
} from '../ports/paper-decision-repository.js';
import type { CanonicalQualificationProjection } from '../ports/qualification-projection-repository.js';
import {
  canonicalStringifyJson,
  fromJsonValue,
  MAX_CANONICAL_JSON_TEXT_BYTES,
  stringifyJson,
  toJsonValue,
} from '../utils/json.js';
import { getDatabasePool } from './database.js';

interface Result { readonly rows: readonly unknown[]; readonly rowCount?: number | null }
interface Client { query(text: string, values?: readonly unknown[]): Promise<Result>; release(): void }
interface Pool { connect(): Promise<Client> }

type Operation = 'enqueue' | 'claim' | 'renew' | 'snapshot' | 'stage' | 'complete' | 'fail' | 'counts';

export class PaperDecisionRepositoryError extends Error {
  public constructor(public readonly operation: Operation, options?: ErrorOptions) {
    super('Paper decision repository operation failed.', options);
    this.name = 'PaperDecisionRepositoryError';
  }
}

export class PaperDecisionLeaseLostError extends Error {
  public constructor() {
    super('Paper decision job lease is no longer active.');
    this.name = 'PaperDecisionLeaseLostError';
  }
}

export interface PaperDecisionRepositoryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly retentionHours?: number;
  readonly clock?: () => number;
}

export class PostgresPaperDecisionRepository implements PaperDecisionRepository {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly retentionMs: number;
  private readonly clock: () => number;

  public constructor(
    private readonly pool: Pool = getDatabasePool(),
    options: PaperDecisionRepositoryOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    const retentionHours = options.retentionHours ?? 4;
    integerInRange(this.maxAttempts, 1, 100, 'maxAttempts');
    integerInRange(this.baseDelayMs, 1, 60_000, 'baseDelayMs');
    if (retentionHours !== 4) throw new RangeError('Paper decision retention must be four hours.');
    this.retentionMs = retentionHours * 3_600_000;
    this.clock = options.clock ?? Date.now;
  }

  public async enqueue(input: PaperDecisionJobInput): Promise<void> {
    assertJobInput(input);
    const jobId = `paper_job_${hash([
      input.mint,
      input.sourceEventId,
      input.sourceRawEventId,
      input.sourceConfirmationStatus,
      input.inputFingerprint,
    ])}`;
    const client = await this.connect('enqueue');
    try {
      const now = new Date(this.clock());
      await client.query(`INSERT INTO paper_decision_jobs (
        job_id,mint,source_event_id,source_raw_event_id,source_confirmation_status,
        input_fingerprint,status,max_attempts,base_delay_ms,created_at,updated_at,
        payload_version,payload
      ) VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9,$9,1,$10)
      ON CONFLICT (mint,source_event_id,input_fingerprint) DO NOTHING`, [
        jobId,input.mint,input.sourceEventId,input.sourceRawEventId,
        input.sourceConfirmationStatus,input.inputFingerprint,this.maxAttempts,
        this.baseDelayMs,now,toJsonValue({ input }),
      ]);
    } catch (error: unknown) {
      throw repositoryError('enqueue', error);
    } finally {
      release(client);
    }
  }

  public async enqueueLatest(
    mint: string,
    triggerSignature: string,
    triggerConfirmationStatus: ChainConfirmationStatus,
  ): Promise<void> {
    boundedText(mint, 'mint');
    boundedText(triggerSignature, 'triggerSignature');
    if (!['processed','confirmed','finalized','orphaned'].includes(triggerConfirmationStatus)) {
      throw new TypeError('triggerConfirmationStatus is invalid.');
    }
    const client = await this.connect('enqueue');
    let input: PaperDecisionJobInput | null = null;
    try {
      const result = await client.query(`SELECT event.event_id,event.raw_event_id,
        event.confirmation_status FROM domain_events event
        WHERE event.mint=$1 AND event.raw_event_id IS NOT NULL
          AND event.type IN (
            'TokenLaunchDetected','BondingCurveTradeObserved',
            'BondingCurveStateUpdated','BondingCurveCompleted',
            'MigrationObserved','PumpSwapPoolActivated'
          )
          AND (
            ($3='orphaned' AND event.signature=$2 AND event.confirmation_status='orphaned')
            OR ($3<>'orphaned' AND event.confirmation_status<>'orphaned')
          )
        ORDER BY event.slot DESC,event.transaction_index DESC,
          event.instruction_index DESC,COALESCE(event.inner_instruction_index,-1) DESC,
          event.event_id DESC LIMIT 1`, [mint,triggerSignature,triggerConfirmationStatus]);
      const row=result.rows[0];
      if (row !== undefined) {
        const sourceEventId=textField(row,'event_id');
        const sourceRawEventId=textField(row,'raw_event_id');
        const sourceConfirmationStatus=textField(row,'confirmation_status') as PaperDecisionJobInput['sourceConfirmationStatus'];
        input=Object.freeze({
          mint,sourceEventId,sourceRawEventId,sourceConfirmationStatus,
          inputFingerprint:hash([
            mint,sourceEventId,sourceRawEventId,sourceConfirmationStatus,
            triggerSignature,triggerConfirmationStatus,
          ]),
        });
      }
    } catch (error:unknown) {
      throw repositoryError('enqueue',error);
    } finally {
      release(client);
    }
    if (input !== null) await this.enqueue(input);
  }

  public async claim(options: Readonly<{ leaseMs: number; nowMs: number }>): Promise<ClaimedPaperDecisionJob | null> {
    positiveInteger(options.leaseMs, 'leaseMs');
    timestamp(options.nowMs, 'nowMs');
    const client = await this.connect('claim');
    try {
      await client.query('BEGIN');
      const now = new Date(options.nowMs);
      await client.query(`UPDATE paper_decision_jobs SET
        status='CANCELLED',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
        error_code='LEASE_EXPIRED',retry_exhausted_at=$1,terminal_at=$1,
        purge_after=$2,updated_at=$1
        WHERE status='PROCESSING' AND lease_expires_at <= $1
          AND attempts_in_cycle >= max_attempts`, [
        now,new Date(options.nowMs + this.retentionMs),
      ]);
      const leaseToken = `paper_lease_${randomUUID()}`;
      const result = await client.query(`WITH candidate AS (
        SELECT job.job_id
        FROM paper_decision_jobs job
        JOIN domain_events source ON source.event_id=job.source_event_id
        WHERE (source.confirmation_status <> 'orphaned'
            OR job.source_confirmation_status = 'orphaned')
          AND job.attempts_in_cycle < job.max_attempts
          AND (
            job.status='PENDING'
            OR (job.status='RETRYABLE_FAILED' AND job.next_attempt_at <= $1)
            OR (job.status='PROCESSING' AND job.lease_expires_at <= $1)
          )
        ORDER BY COALESCE(job.next_attempt_at,job.created_at),job.created_at,job.job_id
        FOR UPDATE OF job SKIP LOCKED
        LIMIT 1
      )
      UPDATE paper_decision_jobs job SET
        status='PROCESSING',attempts=job.attempts+1,
        attempts_in_cycle=job.attempts_in_cycle+1,lease_token=$2,
        lease_expires_at=$3,next_attempt_at=NULL,error_code=NULL,updated_at=$1
      FROM candidate WHERE job.job_id=candidate.job_id
      RETURNING job.*`, [now,leaseToken,new Date(options.nowMs + options.leaseMs)]);
      await client.query('COMMIT');
      const row = result.rows[0];
      return row === undefined ? null : claimedJob(row);
    } catch (error: unknown) {
      await rollback(client);
      throw repositoryError('claim', error);
    } finally {
      release(client);
    }
  }

  public async renew(job: ClaimedPaperDecisionJob, nowMs: number, leaseMs: number): Promise<boolean> {
    assertClaim(job);
    timestamp(nowMs, 'nowMs');
    positiveInteger(leaseMs, 'leaseMs');
    const client = await this.connect('renew');
    try {
      const result = await client.query(`UPDATE paper_decision_jobs SET
        lease_expires_at=$4,updated_at=$3
        WHERE job_id=$1 AND status='PROCESSING' AND lease_token=$2
          AND lease_expires_at > $3 RETURNING job_id`, [
        job.jobId,job.leaseToken,new Date(nowMs),new Date(nowMs + leaseMs),
      ]);
      return result.rowCount === 1;
    } catch (error: unknown) {
      throw repositoryError('renew', error);
    } finally {
      release(client);
    }
  }

  public async loadSnapshot(job: ClaimedPaperDecisionJob): Promise<PaperDecisionSnapshot> {
    assertClaim(job);
    const client = await this.connect('snapshot');
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await lockMint(client, job.mint);
      await lockQualificationMint(client,job.mint);
      await assertActiveLease(client, job);
      const sourceResult = await client.query(
        'SELECT * FROM domain_events WHERE event_id=$1 AND mint=$2',
        [job.sourceEventId,job.mint],
      );
      const asOfEvent = decodeDomainEvent(requiredRow(sourceResult, 'Source event is missing.'));
      const includeOrphaned = asOfEvent.confirmationStatus === 'orphaned';
      const launch = await loadLaunch(client, job.mint, includeOrphaned);
      const metadata = await latestMetadata(client, job.mint);
      const social = await latestPayload<SocialEvidenceCollectionV1>(client,
        `SELECT payload #> '{collection}' AS payload FROM domain_events
          WHERE mint=$1 AND type='SocialEvidenceCollected'
            AND confirmation_status<>'orphaned'
          ORDER BY observed_at DESC,event_id DESC LIMIT 1`,job.mint);
      const creatorProfile = await latestPayload<CreatorProfile>(client,
        'SELECT payload FROM creator_profiles WHERE mint=$1 LIMIT 1',job.mint);
      const holderSnapshot = await latestPayload<HolderDistribution>(client,
        'SELECT payload FROM token_holders_snapshots WHERE mint=$1 ORDER BY observed_at DESC,snapshot_id DESC LIMIT 1',job.mint);
      const walletGraph = await latestWalletGraph(client, job.mint);
      const currentQualification = await loadQualification(client, job.mint, true);
      let candidate = await loadCandidate(client, job, includeOrphaned);
      const session = await loadSession(client, job, candidate, includeOrphaned);
      if (includeOrphaned && candidate === null && session !== null) {
        candidate = await loadCandidateById(client, session.candidateId);
      }
      const currentDecision = candidate === null
        ? null
        : await loadCurrentDecision(client, candidate.id, includeOrphaned);
      const launchTrades = await activeLaunchTrades(client, job.mint, session);
      const marketTrades = await activeMarketTrades(client, job.mint, session);
      const position = await loadPosition(client, job.mint, session);
      await client.query('COMMIT');
      return deepFreeze({
        mint: job.mint,asOfEvent,launch,metadata,social,creatorProfile,holderSnapshot,
        walletGraph,activeLaunchTrades: launchTrades,activeMarketTrades: marketTrades,
        currentQualification,currentCandidate: candidate,currentDecision,
        currentSession: session,activePosition: position,
      });
    } catch (error: unknown) {
      await rollback(client);
      if (error instanceof PaperDecisionLeaseLostError) throw error;
      throw repositoryError('snapshot', error);
    } finally {
      release(client);
    }
  }

  public async stageDecision(job: ClaimedPaperDecisionJob, result: PaperDecisionResult): Promise<void> {
    await this.persist(job, result, false, 'stage');
  }

  public async complete(job: ClaimedPaperDecisionJob, result: PaperDecisionResult): Promise<void> {
    await this.persist(job, result, true, 'complete');
  }

  public async fail(job: ClaimedPaperDecisionJob, failure: PaperDecisionFailure): Promise<void> {
    assertClaim(job);
    assertFailure(failure);
    if (failure.terminalResult !== null) assertDecisionResult(job, failure.terminalResult);
    const client = await this.connect('fail');
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await lockMint(client, job.mint);
      await lockQualificationMint(client,job.mint);
      const selected = await client.query(`SELECT status,lease_token,lease_expires_at,
        attempts_in_cycle,max_attempts,base_delay_ms FROM paper_decision_jobs
        WHERE job_id=$1 FOR UPDATE`, [job.jobId]);
      const row = requiredRow(selected, 'Paper decision job is missing.');
      assertLeaseRow(row, job);
      const nowMs = this.clock();
      timestamp(nowMs, 'clock');
      const attemptsInCycle = integerField(row, 'attempts_in_cycle');
      const maxAttempts = integerField(row, 'max_attempts');
      if (failure.retryable && attemptsInCycle < maxAttempts) {
        const delay = retryDelay(integerField(row, 'base_delay_ms'), attemptsInCycle);
        await exact(client, `UPDATE paper_decision_jobs SET
          status='RETRYABLE_FAILED',lease_token=NULL,lease_expires_at=NULL,
          next_attempt_at=$3,error_code=$4,updated_at=$5
          WHERE job_id=$1 AND lease_token=$2`, [
          job.jobId,job.leaseToken,new Date(nowMs + delay),failure.code,new Date(nowMs),
        ]);
      } else {
        if (failure.terminalResult !== null) await writeDecision(client, job, failure.terminalResult);
        const terminalStatus = failure.terminalResult === null ? 'CANCELLED' : 'COMPLETED';
        await exact(client, `UPDATE paper_decision_jobs SET
          status=$3,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
          error_code=$4,retry_exhausted_at=$5,terminal_at=$6,purge_after=$7,updated_at=$6,
          payload=CASE WHEN $8::jsonb IS NULL THEN payload ELSE $8::jsonb END
          WHERE job_id=$1 AND lease_token=$2`, [
          job.jobId,job.leaseToken,terminalStatus,failure.code,
          failure.retryable ? new Date(nowMs) : null,new Date(nowMs),
          new Date(nowMs + this.retentionMs),failure.terminalResult === null
            ? null : toJsonValue(decisionPayload(job, failure.terminalResult)),
        ]);
      }
      await client.query('COMMIT');
    } catch (error: unknown) {
      await rollback(client);
      if (error instanceof PaperDecisionLeaseLostError) throw error;
      throw repositoryError('fail', error);
    } finally {
      release(client);
    }
  }

  public async counts(): Promise<PaperDecisionQueueCounts> {
    const client = await this.connect('counts');
    try {
      const result = await client.query(`SELECT
        COUNT(*) FILTER (WHERE status='PENDING')::int AS pending,
        COUNT(*) FILTER (WHERE status='PROCESSING')::int AS processing,
        COUNT(*) FILTER (WHERE status='RETRYABLE_FAILED')::int AS retryable_failed,
        COUNT(*) FILTER (WHERE retry_exhausted_at IS NOT NULL)::int AS exhausted
        FROM paper_decision_jobs`);
      const row = requiredRow(result, 'Paper decision counts are missing.');
      return Object.freeze({
        pending: integerField(row, 'pending'),processing: integerField(row, 'processing'),
        retryableFailed: integerField(row, 'retryable_failed'),
        exhausted: integerField(row, 'exhausted'),
      });
    } catch (error: unknown) {
      throw repositoryError('counts', error);
    } finally {
      release(client);
    }
  }

  private async persist(
    job: ClaimedPaperDecisionJob,
    result: PaperDecisionResult,
    terminal: boolean,
    operation: 'stage' | 'complete',
  ): Promise<void> {
    assertClaim(job);
    assertDecisionResult(job, result);
    const client = await this.connect(operation);
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await lockMint(client, job.mint);
      await lockQualificationMint(client,job.mint);
      const selected = await client.query(
        'SELECT status,lease_token,lease_expires_at FROM paper_decision_jobs WHERE job_id=$1 FOR UPDATE',
        [job.jobId],
      );
      const row = requiredRow(selected, 'Paper decision job is missing.');
      if (textField(row, 'status') === 'COMPLETED') {
        await assertDecisionReplay(client, result);
        await client.query('COMMIT');
        return;
      }
      assertLeaseRow(row, job);
      const source = await client.query(
        'SELECT confirmation_status FROM domain_events WHERE event_id=$1 AND mint=$2 FOR UPDATE',
        [job.sourceEventId,job.mint],
      );
      if (
        textField(requiredRow(source, 'Source event is missing.'), 'confirmation_status') === 'orphaned'
        && job.sourceConfirmationStatus !== 'orphaned'
      ) {
        throw new PaperDecisionLeaseLostError();
      }
      await writeDecision(client, job, result);
      const nowMs = Math.max(result.candidate.createdAtMs, result.session?.updatedAtMs ?? 0);
      if (terminal) {
        await exact(client, `UPDATE paper_decision_jobs SET
          status='COMPLETED',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
          error_code=NULL,staged_at=COALESCE(staged_at,$3),terminal_at=$3,
          purge_after=$4,updated_at=$3,payload=$5
          WHERE job_id=$1 AND lease_token=$2`, [
          job.jobId,job.leaseToken,new Date(nowMs),new Date(nowMs + this.retentionMs),
          toJsonValue(decisionPayload(job, result)),
        ]);
      } else {
        await exact(client, `UPDATE paper_decision_jobs SET staged_at=$3,updated_at=$3,payload=$4
          WHERE job_id=$1 AND lease_token=$2`, [
          job.jobId,job.leaseToken,new Date(nowMs),toJsonValue(decisionPayload(job, result)),
        ]);
      }
      await client.query('COMMIT');
    } catch (error: unknown) {
      await rollback(client);
      if (error instanceof PaperDecisionLeaseLostError) throw error;
      throw repositoryError(operation, error);
    } finally {
      release(client);
    }
  }

  private async connect(operation: Operation): Promise<Client> {
    try {
      return await this.pool.connect();
    } catch (error: unknown) {
      throw repositoryError(operation, error);
    }
  }
}

async function writeDecision(client: Client, job: ClaimedPaperDecisionJob, result: PaperDecisionResult): Promise<void> {
  const qualification=await assertPersistedQualification(client,result);
  const candidate = result.candidate;
  if(!qualification.existingCandidate){
    await insertDomainEventWithRaw(
      client,qualification.projection.sourceRawEventId,result.candidateEvent,
    );
    await client.query(`UPDATE trading_candidates
      SET superseded_at=GREATEST($4,created_at)
      WHERE mint=$1 AND strategy_id=$2 AND strategy_version=$3
        AND candidate_id<>$5 AND superseded_at IS NULL`, [
      job.mint,candidate.strategy.id,candidate.strategy.version,
      new Date(candidate.createdAtMs),candidate.id,
    ]);
    await client.query(`INSERT INTO trading_candidates (
    candidate_id,mint,report_id,source_event_id,candidate_event_id,strategy_id,
    strategy_version,evidence_fingerprint,confirmation_status,state,quote_mint,quote_decimals,
    quote_token_program,reason_codes,eligible_until,created_at,superseded_at,purge_after,
    payload_version,payload
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,1,$19)
  ON CONFLICT (candidate_id) DO NOTHING`, [
    candidate.id,job.mint,candidate.qualificationReportId,job.sourceEventId,
    result.candidateEvent.id,candidate.strategy.id,candidate.strategy.version,
    candidate.evidenceFingerprint,candidate.asOf.confirmationStatus,candidate.state,candidate.quoteAsset.mint,
    candidate.quoteAsset.decimals,candidate.quoteAsset.tokenProgram,
    stringifyJson(candidate.reasonCodes),date(candidate.eligibleUntilMs),
    new Date(candidate.createdAtMs),null,
    new Date(candidate.purgeAfterMs),toJsonValue(candidate),
  ]);
  }
  if (result.sessionEvent !== null) await insertDomainEvent(client, job, result.sessionEvent);
  if (result.session !== null && result.sessionEvent !== null) {
    await upsertSession(client, job, result.session, result.sessionEvent.id);
  }
  const countedBuyPurgeAfter = result.session === null ? null : sessionPurgeAfter(result.session);
  for (const evidence of result.countedExternalBuys) {
    const source = await client.query(`SELECT event_id,program,signature,blockchain_time
      FROM raw_chain_events
      WHERE mint=$1 AND slot=$2 AND transaction_index=$3 AND instruction_index=$4
        AND COALESCE(inner_instruction_index,-1)=COALESCE($5::integer,-1)
        AND confirmation_status<>'orphaned'
      ORDER BY observed_at DESC,event_id DESC LIMIT 1`, [
      job.mint,evidence.cursor.slot.toString(),evidence.cursor.transactionIndex,
      evidence.cursor.instructionIndex,evidence.cursor.innerInstructionIndex,
    ]);
    const sourceRow = requiredRow(source, 'External buy raw source is missing.');
    const rawEventId = textField(sourceRow, 'event_id');
    const countedEvent: DomainEvent = Object.freeze({
      id:createDeterministicDerivedEventId({
        type:'PaperExternalBuyCounted',mint:evidence.mint,source:'paper-decision',
        program:textField(sourceRow,'program'),signature:textField(sourceRow,'signature'),
        cursor:evidence.cursor,qualifier:`${evidence.sessionId}:${evidence.tradeId}`,
      }),
      type:'PaperExternalBuyCounted',mint:evidence.mint,source:'paper-decision',
      program:textField(sourceRow,'program'),signature:textField(sourceRow,'signature'),
      cursor:evidence.cursor,confirmationStatus:evidence.confirmationStatus,
      blockchainTimeMs:nullableDateField(sourceRow,'blockchain_time')?.getTime() ?? null,
      observedAtMs:evidence.observedAtMs,payloadVersion:1,
      payload:Object.freeze({ sessionId:evidence.sessionId,tradeId:evidence.tradeId }),
    });
    await insertDomainEventWithRaw(client, rawEventId, countedEvent);
    await client.query(`INSERT INTO paper_external_buy_events (
      session_id,trade_id,source_event_id,mint,quote_mint,trader,slot,
      transaction_index,instruction_index,inner_instruction_index,
      confirmation_status,observed_at,purge_after,payload_version,payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14)
    ON CONFLICT (session_id,trade_id) DO NOTHING`, [
      evidence.sessionId,evidence.tradeId,countedEvent.id,evidence.mint,evidence.quoteMint,
      evidence.trader,evidence.cursor.slot.toString(),evidence.cursor.transactionIndex,
      evidence.cursor.instructionIndex,evidence.cursor.innerInstructionIndex,
      evidence.confirmationStatus,new Date(evidence.observedAtMs),countedBuyPurgeAfter,
      toJsonValue(evidence),
    ]);
  }
}

async function assertPersistedQualification(
  client:Client,
  result:PaperDecisionResult,
):Promise<Readonly<{
  existingCandidate:boolean;
  projection:CanonicalQualificationProjection;
}>>{
  const candidate=result.candidate;
  const existing=await client.query(`SELECT candidate.report_id,candidate.evidence_fingerprint,
    candidate.payload,
    event.event_id AS candidate_event_id,event.type AS candidate_event_type,
    event.mint AS candidate_event_mint,event.source AS candidate_event_source,
    event.program AS candidate_event_program,event.signature AS candidate_event_signature,
    event.slot::text AS candidate_event_slot,
    event.transaction_index AS candidate_event_transaction_index,
    event.instruction_index AS candidate_event_instruction_index,
    event.inner_instruction_index AS candidate_event_inner_instruction_index,
    event.confirmation_status AS candidate_event_confirmation_status,
    event.blockchain_time AS candidate_event_blockchain_time,
    event.observed_at AS candidate_event_observed_at,
    event.payload_version AS candidate_event_payload_version,
    event.payload AS candidate_event_payload
    FROM trading_candidates candidate
    JOIN domain_events event ON event.event_id=candidate.candidate_event_id
    WHERE candidate.candidate_id=$1 FOR UPDATE OF candidate,event`,[candidate.id]);
  const existingRow=existing.rows[0];
  let projection:CanonicalQualificationProjection|null;
  if(existingRow===undefined){
    projection=await loadQualification(client,candidate.mint,true);
  }else{
    if(
      textField(existingRow,'report_id')!==candidate.qualificationReportId
      ||textField(existingRow,'evidence_fingerprint')!==candidate.evidenceFingerprint
      ||canonicalStringifyJson(decoded(field(existingRow,'payload'),'Candidate payload is invalid.'))
        !==canonicalStringifyJson(candidate)
      ||canonicalStringifyJson(decodePrefixedDomainEvent(existingRow,'candidate_event_'))
        !==canonicalStringifyJson(result.candidateEvent)
    )throw new TypeError('Persisted paper candidate is invalid.');
    projection=await loadQualification(client,candidate.qualificationReportId,false,true);
  }
  if(projection===null)throw new TypeError('Persisted qualification projection is missing.');
  assertQualificationMatches(projection,result);
  if(existingRow===undefined)assertCandidateEvent(result);
  return Object.freeze({
    existingCandidate:existingRow!==undefined,
    projection,
  });
}

function assertQualificationMatches(
  projection:CanonicalQualificationProjection,
  result:PaperDecisionResult,
):void{
  const candidate=result.candidate;
  const profile=projection.report.ruleSet;
  if(
    candidate.qualificationReportId!==projection.reportId
    ||candidate.mint!==projection.qualificationEvent.mint
    ||candidate.qualificationProfile.id!==profile.id
    ||candidate.qualificationProfile.version!==profile.version
    ||candidate.qualificationProfile.fingerprint!==profile.fingerprint
    ||candidate.evidenceFingerprint!==projection.evidenceFingerprint
    ||candidate.asOf.eventId!==projection.qualificationEvent.id
    ||compareCursors(candidate.asOf.cursor,projection.qualificationEvent.cursor)!==0
    ||candidate.asOf.confirmationStatus!==projection.qualificationEvent.confirmationStatus
    ||candidate.asOf.observedAtMs!==projection.qualificationEvent.observedAtMs
    ||canonicalStringifyJson(result.report)!==canonicalStringifyJson(projection.report)
    ||canonicalStringifyJson(result.qualificationEvent)
      !==canonicalStringifyJson(projection.qualificationEvent)
  )throw new TypeError('Paper candidate qualification is not the persisted projection.');
}

function assertCandidateEvent(result:PaperDecisionResult):void{
  const event=result.candidateEvent;
  if(
    event.type!=='TradingCandidateUpdated'||event.source!=='paper-decision'
    ||event.mint!==result.candidate.mint||event.payloadVersion!==1
    ||compareCursors(event.cursor,result.candidate.asOf.cursor)!==0
    ||event.confirmationStatus!==result.candidate.asOf.confirmationStatus
    ||canonicalStringifyJson(event.payload)
      !==canonicalStringifyJson(Object.freeze({ candidate:result.candidate }))
  )throw new TypeError('Paper candidate event is invalid.');
}

async function upsertSession(
  client: Client,
  job: ClaimedPaperDecisionJob,
  session: PaperStrategySessionV1,
  sessionEventId: string,
): Promise<void> {
  const terminal = ['PAPER_CLOSED','PAPER_RETRACTED','MANUAL_REVIEW'].includes(session.state);
  const purgeAfter = sessionPurgeAfter(session);
  await client.query(`INSERT INTO paper_strategy_sessions (
    session_id,mint,candidate_id,report_id,source_event_id,session_event_id,
    strategy_id,strategy_version,actor_kind,state,reason_code,quote_mint,
    quote_decimals,quote_token_program,position_id,open_command_id,close_command_id,
    entry_slot,entry_transaction_index,entry_instruction_index,
    entry_inner_instruction_index,external_buy_target,external_buy_count,
    minimum_confirmation,created_at,updated_at,terminal_at,purge_after,payload_version,payload
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
    $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,1,$29)
  ON CONFLICT (session_id) DO UPDATE SET
    session_event_id=EXCLUDED.session_event_id,state=EXCLUDED.state,
    reason_code=EXCLUDED.reason_code,position_id=EXCLUDED.position_id,
    close_command_id=EXCLUDED.close_command_id,external_buy_count=EXCLUDED.external_buy_count,
    updated_at=EXCLUDED.updated_at,terminal_at=EXCLUDED.terminal_at,
    purge_after=EXCLUDED.purge_after,payload=EXCLUDED.payload
  WHERE (
      paper_strategy_sessions.updated_at < EXCLUDED.updated_at
      OR (
        paper_strategy_sessions.updated_at = EXCLUDED.updated_at
        AND (
          EXCLUDED.external_buy_count >= paper_strategy_sessions.external_buy_count
          OR $30::boolean
        )
      )
    )
    AND (
      paper_strategy_sessions.state NOT IN ('PAPER_CLOSED','PAPER_RETRACTED','MANUAL_REVIEW')
      OR EXCLUDED.state IN ('PAPER_CLOSED','PAPER_RETRACTED','MANUAL_REVIEW')
    )`, [
    session.id,job.mint,session.candidateId,session.qualificationReportId,
    job.sourceEventId,sessionEventId,session.strategy.id,session.strategy.version,
    session.actorKind,session.state,session.reasonCode,session.quoteAsset.mint,
    session.quoteAsset.decimals,session.quoteAsset.tokenProgram,session.positionId,
    session.openCommandId,session.closeCommandId,session.entryCursor.slot.toString(),
    session.entryCursor.transactionIndex,session.entryCursor.instructionIndex,
    session.entryCursor.innerInstructionIndex,session.externalBuyTarget,
    session.externalBuyCount,session.minimumConfirmation,new Date(session.createdAtMs),
    new Date(session.updatedAtMs),terminal ? new Date(session.updatedAtMs) : null,
    purgeAfter,toJsonValue(session),job.sourceConfirmationStatus === 'orphaned',
  ]);
  if (purgeAfter !== null) {
    await client.query(`UPDATE paper_external_buy_events
      SET purge_after=COALESCE(purge_after,$2)
      WHERE session_id=$1`, [session.id,purgeAfter]);
  }
}

function sessionPurgeAfter(session: PaperStrategySessionV1): Date | null {
  return ['PAPER_CLOSED','PAPER_RETRACTED','MANUAL_REVIEW'].includes(session.state)
    ? new Date(session.updatedAtMs + 14_400_000)
    : null;
}

async function insertDomainEvent(client: Client, job: ClaimedPaperDecisionJob, event: DomainEvent): Promise<void> {
  await insertDomainEventWithRaw(client, job.sourceRawEventId, event);
}

async function insertDomainEventWithRaw(
  client: Client,
  rawEventId: string,
  event: DomainEvent,
): Promise<void> {
  await client.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
    instruction_index,inner_instruction_index,confirmation_status,blockchain_time,
    observed_at,payload_version,payload
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
  ON CONFLICT (event_id) DO NOTHING`, [
    event.id,rawEventId,event.type,event.mint,event.source,event.program,
    event.signature,event.cursor.slot.toString(),event.cursor.transactionIndex,
    event.cursor.instructionIndex,event.cursor.innerInstructionIndex,
    event.confirmationStatus,date(event.blockchainTimeMs),new Date(event.observedAtMs),
    event.payloadVersion,toJsonValue(event.payload),
  ]);
}

async function assertDecisionReplay(client: Client, result: PaperDecisionResult): Promise<void> {
  await assertPersistedQualification(client,result);
  const persisted = await client.query(`SELECT
    EXISTS(SELECT 1 FROM qualification_reports WHERE report_id=$1) AS report,
    EXISTS(SELECT 1 FROM trading_candidates WHERE candidate_id=$2) AS candidate,
    CASE WHEN $3::text IS NULL THEN TRUE ELSE
      EXISTS(SELECT 1 FROM paper_strategy_sessions WHERE session_id=$3) END AS session`, [
    result.candidate.qualificationReportId,result.candidate.id,result.session?.id ?? null,
  ]);
  const row = requiredRow(persisted, 'Paper decision replay is missing.');
  if (!booleanField(row, 'report') || !booleanField(row, 'candidate') || !booleanField(row, 'session')) {
    throw new TypeError('Completed paper decision does not match its persisted result.');
  }
}

async function assertActiveLease(client: Client, job: ClaimedPaperDecisionJob): Promise<void> {
  const result = await client.query(
    'SELECT status,lease_token,lease_expires_at FROM paper_decision_jobs WHERE job_id=$1 FOR UPDATE',
    [job.jobId],
  );
  assertLeaseRow(requiredRow(result, 'Paper decision job is missing.'), job);
}

function assertLeaseRow(row: unknown, job: ClaimedPaperDecisionJob): void {
  if (
    textField(row, 'status') !== 'PROCESSING'
    || nullableTextField(row, 'lease_token') !== job.leaseToken
    || dateField(row, 'lease_expires_at').getTime() < job.leaseExpiresAtMs
  ) throw new PaperDecisionLeaseLostError();
}

async function latestMetadata(client: Client, mint: string): Promise<TokenMetadataSnapshot | null> {
  const result = await client.query(`SELECT uri,resolution_status,failure_reason,
    failure_message,failure_retryable,metadata,fetched_at,payload_version
    FROM token_metadata_snapshots WHERE mint=$1 ORDER BY fetched_at DESC,snapshot_id DESC LIMIT 1`, [mint]);
  const row = result.rows[0];
  if (row === undefined) return null;
  const status = textField(row, 'resolution_status');
  const resolution = status === 'resolved'
    ? { status: 'RESOLVED' as const, metadata: (decoded(
      { status: 'RESOLVED', metadata: field(row, 'metadata') }, 'Metadata payload is invalid.',
    ) as Extract<TokenMetadataSnapshot['resolution'], { status: 'RESOLVED' }>).metadata }
    : {
      status: 'FAILED' as const,
      reason: textField(row, 'failure_reason') as Extract<TokenMetadataSnapshot['resolution'], { status: 'FAILED' }>['reason'],
      message: nullableTextField(row, 'failure_message') ?? 'Metadata resolution failed.',
      retryable: booleanField(row, 'failure_retryable'),
    };
  return deepFreeze({
    mint,uri:textField(row, 'uri'),resolution,
    fetchedAtMs:dateField(row, 'fetched_at').getTime(),payloadVersion:integerField(row, 'payload_version'),
  });
}

async function loadLaunch(
  client: Client,
  mint: string,
  includeOrphaned: boolean,
): Promise<TokenLaunch> {
  const result = await client.query(`SELECT * FROM domain_events
    WHERE mint=$1 AND type='TokenLaunchDetected'
      AND ($2::boolean OR confirmation_status<>'orphaned')
    ORDER BY slot,transaction_index,instruction_index,
      COALESCE(inner_instruction_index,-1),event_id LIMIT 1`, [mint,includeOrphaned]);
  const event = decodeDomainEvent(requiredRow(result, 'Token launch event is missing.'));
  return payloadProperty(event.payload, 'launch') as TokenLaunch;
}

async function loadCandidate(
  client: Client,
  job: ClaimedPaperDecisionJob,
  includeOrphaned: boolean,
): Promise<TradingCandidateV1 | null> {
  const result = includeOrphaned
    ? await client.query(`SELECT payload FROM trading_candidates
        WHERE mint=$1 AND source_event_id=$2
        ORDER BY created_at DESC,candidate_id DESC LIMIT 1`, [job.mint,job.sourceEventId])
    : await client.query(`SELECT candidate.payload FROM trading_candidates candidate
        JOIN domain_events source ON source.event_id=candidate.source_event_id
        WHERE candidate.mint=$1 AND candidate.superseded_at IS NULL
          AND source.confirmation_status<>'orphaned'
        ORDER BY candidate.created_at DESC,candidate.candidate_id DESC LIMIT 1`, [job.mint]);
  const row=result.rows[0];
  return row === undefined
    ? null
    : decoded(field(row,'payload'),'Trading candidate payload is invalid.') as TradingCandidateV1;
}

async function loadCandidateById(
  client: Client,
  candidateId: string,
): Promise<TradingCandidateV1 | null> {
  const result = await client.query(
    'SELECT payload FROM trading_candidates WHERE candidate_id=$1',
    [candidateId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : decoded(field(row,'payload'),'Trading candidate payload is invalid.') as TradingCandidateV1;
}

async function loadSession(
  client: Client,
  job: ClaimedPaperDecisionJob,
  candidate: TradingCandidateV1 | null,
  includeOrphaned: boolean,
): Promise<PaperStrategySessionV1 | null> {
  let result: Result;
  if (includeOrphaned && candidate !== null) {
    result=await client.query(`SELECT payload FROM paper_strategy_sessions
      WHERE mint=$1 AND candidate_id=$2
      ORDER BY updated_at DESC,session_id DESC LIMIT 1`, [job.mint,candidate.id]);
  } else if (includeOrphaned) {
    result=await client.query(`SELECT session.payload FROM paper_strategy_sessions session
      WHERE session.mint=$1 AND (
        session.session_id IN (
          SELECT event.payload #>> '{session,id}' FROM domain_events event
          WHERE event.raw_event_id=$2 AND event.type='PaperStrategySessionUpdated'
        )
        OR session.session_id IN (
          SELECT evidence.session_id FROM paper_external_buy_events evidence
          JOIN domain_events source ON source.event_id=evidence.source_event_id
          WHERE source.raw_event_id=$2
        )
      )
      ORDER BY session.updated_at DESC,session.session_id DESC LIMIT 1`, [
      job.mint,job.sourceRawEventId,
    ]);
    if (result.rows[0] === undefined) {
      result=await activeSession(client,job.mint);
    }
  } else {
    result=await activeSession(client,job.mint);
  }
  const row=result.rows[0];
  return row === undefined
    ? null
    : decoded(field(row,'payload'),'Paper strategy session payload is invalid.') as PaperStrategySessionV1;
}

function activeSession(client: Client, mint: string): Promise<Result> {
  return client.query(`SELECT session.payload FROM paper_strategy_sessions session
        JOIN domain_events source ON source.event_id=session.source_event_id
        WHERE session.mint=$1 AND source.confirmation_status<>'orphaned'
        ORDER BY session.updated_at DESC,session.session_id DESC LIMIT 1`, [mint]);
}

async function loadPosition(
  client: Client,
  mint: string,
  session: PaperStrategySessionV1 | null,
): Promise<PaperPosition | null> {
  const result = session === null
    ? await client.query(`SELECT position.payload FROM paper_positions position
        JOIN domain_events trigger ON trigger.event_id=position.trigger_event_id
        WHERE position.mint=$1 AND position.status='PAPER_HOLDING'
          AND trigger.confirmation_status<>'orphaned'
        ORDER BY position.opened_at DESC,position.position_id DESC LIMIT 1`, [mint])
    : await client.query(`SELECT payload FROM paper_positions
        WHERE mint=$1 AND strategy_session_id=$2
        ORDER BY opened_at DESC,position_id DESC LIMIT 1`, [mint,session.id]);
  const row=result.rows[0];
  return row === undefined
    ? null
    : decoded(field(row,'payload'),'Paper position payload is invalid.') as PaperPosition;
}

async function latestPayload<T>(client: Client, sql: string, mint: string): Promise<T | null> {
  const result = await client.query(sql, [mint]);
  const row = result.rows[0];
  return row === undefined ? null : decoded(field(row, 'payload'), 'Projection payload is invalid.') as T;
}

const QUALIFICATION_SELECT = `SELECT report.report_id,report.mint AS report_mint,
  report.source_event_id,report.source_raw_event_id,report.qualification_event_id,
  report.profile_id,report.profile_version,report.profile_fingerprint,
  report.evidence_fingerprint,report.verdict,report.preparation_score,
  report.social_score,report.onchain_score,report.total_score,
  report.as_of_slot::text AS as_of_slot,
  report.as_of_transaction_index,report.as_of_instruction_index,
  report.as_of_inner_instruction_index,report.confirmation_status AS report_confirmation_status,
  report.evaluated_at,report.superseded_at,report.purge_after,
  report.payload_version AS report_payload_version,report.payload AS report_payload,
  qualification.event_id AS qualification_id,qualification.raw_event_id AS qualification_raw_event_id,
  qualification.type AS qualification_type,qualification.mint AS qualification_mint,
  qualification.source AS qualification_source,qualification.program AS qualification_program,
  qualification.signature AS qualification_signature,qualification.slot::text AS qualification_slot,
  qualification.transaction_index AS qualification_transaction_index,
  qualification.instruction_index AS qualification_instruction_index,
  qualification.inner_instruction_index AS qualification_inner_instruction_index,
  qualification.confirmation_status AS qualification_confirmation_status,
  qualification.blockchain_time AS qualification_blockchain_time,
  qualification.observed_at AS qualification_observed_at,
  qualification.payload_version AS qualification_payload_version,
  qualification.payload AS qualification_payload,
  source.event_id AS source_id,source.raw_event_id AS source_raw_event_id_value,
  source.type AS source_type,source.mint AS source_mint,source.source AS source_source,
  source.program AS source_program,source.signature AS source_signature,
  source.slot::text AS source_slot,source.transaction_index AS source_transaction_index,
  source.instruction_index AS source_instruction_index,
  source.inner_instruction_index AS source_inner_instruction_index,
  source.confirmation_status AS source_confirmation_status,
  source.blockchain_time AS source_blockchain_time,
  raw.confirmation_status AS raw_confirmation_status
  FROM qualification_reports report
  JOIN domain_events qualification ON qualification.event_id=report.qualification_event_id
  JOIN domain_events source ON source.event_id=report.source_event_id
    AND source.raw_event_id=report.source_raw_event_id
  JOIN raw_chain_events raw ON raw.event_id=report.source_raw_event_id
    AND raw.source=source.source AND raw.program=source.program AND raw.mint=source.mint
    AND raw.signature=source.signature AND raw.slot=source.slot
    AND raw.transaction_index=source.transaction_index
    AND raw.instruction_index=source.instruction_index
    AND raw.inner_instruction_index IS NOT DISTINCT FROM source.inner_instruction_index`;

async function loadQualification(
  client:Client,
  identity:string,
  current:boolean,
  includeOrphaned=false,
):Promise<CanonicalQualificationProjection|null> {
  const result=current
    ? await client.query(`${QUALIFICATION_SELECT}
        WHERE report.mint=$1 AND report.superseded_at IS NULL
          AND report.purge_after > clock_timestamp()
          AND octet_length(report.payload::text)<=${MAX_CANONICAL_JSON_TEXT_BYTES}
          AND octet_length(qualification.payload::text)<=${MAX_CANONICAL_JSON_TEXT_BYTES}
          AND qualification.confirmation_status<>'orphaned'
          AND source.confirmation_status<>'orphaned'
          AND raw.confirmation_status<>'orphaned'
          AND qualification.confirmation_status=source.confirmation_status
          AND source.confirmation_status=raw.confirmation_status
        ORDER BY report.evaluated_at DESC,report.report_id DESC LIMIT 1`,[identity])
    : await client.query(`${QUALIFICATION_SELECT}
        WHERE report.report_id=$1
          AND octet_length(report.payload::text)<=${MAX_CANONICAL_JSON_TEXT_BYTES}
          AND octet_length(qualification.payload::text)<=${MAX_CANONICAL_JSON_TEXT_BYTES}
          AND ($2::boolean OR qualification.confirmation_status<>'orphaned')
          AND ($2::boolean OR source.confirmation_status<>'orphaned')
          AND ($2::boolean OR raw.confirmation_status<>'orphaned')`,[identity,includeOrphaned]);
  const row=result.rows[0];
  return row===undefined?null:qualificationFromRow(row,!current&&includeOrphaned);
}

function qualificationFromRow(
  row:unknown,
  allowHistoricalOrphan=false,
):CanonicalQualificationProjection {
  const report=decoded(
    field(row,'report_payload'),'Qualification report payload is invalid.',
  ) as CanonicalQualificationProjection['report'];
  const storedEvent=decodePrefixedDomainEvent(row,'qualification_');
  const reportConfirmationValue=textField(row,'report_confirmation_status');
  if(!['processed','confirmed','finalized','orphaned'].includes(reportConfirmationValue)){
    throw new TypeError('Stored qualification confirmation is invalid.');
  }
  const reportConfirmation=reportConfirmationValue as DomainEvent['confirmationStatus'];
  const historicalOrphan=allowHistoricalOrphan
    &&storedEvent.confirmationStatus==='orphaned'
    &&textField(row,'source_confirmation_status')==='orphaned'
    &&textField(row,'raw_confirmation_status')==='orphaned';
  const event=historicalOrphan
    ?deepFreeze({ ...storedEvent,confirmationStatus:reportConfirmation })
    :storedEvent;
  const payload=event.payload;
  const evaluation=payload.evaluation as CanonicalQualificationProjection['evaluation'];
  const projection=deepFreeze({
    reportId:textField(row,'report_id'),sourceEventId:textField(row,'source_event_id'),
    sourceRawEventId:textField(row,'source_raw_event_id'),
    evidenceFingerprint:textField(row,'evidence_fingerprint'),evaluation,report,
    qualificationEvent:event,
  });
  const sourceCursor=Object.freeze({
    slot:BigInt(textField(row,'source_slot')),
    transactionIndex:integerField(row,'source_transaction_index'),
    instructionIndex:integerField(row,'source_instruction_index'),
    innerInstructionIndex:field(row,'source_inner_instruction_index')===null
      ? null:integerField(row,'source_inner_instruction_index'),
  });
  const expectedPayload=Object.freeze({
    reportId:projection.reportId,evidenceFingerprint:projection.evidenceFingerprint,
    evaluation:projection.evaluation,report:projection.report,
  });
  if (
    event.type!=='QualificationUpdated'||event.source!=='qualification'
    ||event.payloadVersion!==1||event.id!==textField(row,'qualification_event_id')
    ||event.mint!==textField(row,'report_mint')
    ||event.mint!==textField(row,'source_mint')
    ||textField(row,'qualification_raw_event_id')!==projection.sourceRawEventId
    ||projection.sourceEventId!==textField(row,'source_id')
    ||projection.sourceRawEventId!==textField(row,'source_raw_event_id_value')
    ||!['TokenLaunchDetected','BondingCurveTradeObserved','BondingCurveStateUpdated',
      'BondingCurveCompleted','MigrationObserved','PumpSwapPoolActivated']
      .includes(textField(row,'source_type'))
    ||event.program!==textField(row,'source_program')
    ||event.signature!==textField(row,'source_signature')
    ||compareCursors(event.cursor,sourceCursor)!==0
    ||event.confirmationStatus!==reportConfirmation
    ||(!historicalOrphan&&event.confirmationStatus!==textField(row,'source_confirmation_status'))
    ||(!historicalOrphan&&event.confirmationStatus!==textField(row,'raw_confirmation_status'))
    ||event.blockchainTimeMs!==(nullableDateField(row,'source_blockchain_time')?.getTime()??null)
    ||report.ruleSet.id!==textField(row,'profile_id')
    ||report.ruleSet.version!==integerField(row,'profile_version')
    ||report.ruleSet.fingerprint!==textField(row,'profile_fingerprint')
    ||report.verdict!==textField(row,'verdict')
    ||report.scores.preparation.score!==integerField(row,'preparation_score')
    ||report.scores.socialAuthenticity.score!==integerField(row,'social_score')
    ||report.scores.onchainHealth.score!==integerField(row,'onchain_score')
    ||report.scores.total.score!==integerField(row,'total_score')
    ||event.cursor.slot!==BigInt(textField(row,'as_of_slot'))
    ||event.cursor.transactionIndex!==integerField(row,'as_of_transaction_index')
    ||event.cursor.instructionIndex!==integerField(row,'as_of_instruction_index')
    ||event.cursor.innerInstructionIndex!==(field(row,'as_of_inner_instruction_index')===null
      ?null:integerField(row,'as_of_inner_instruction_index'))
    ||report.evaluatedAtMs!==dateField(row,'evaluated_at').getTime()
    ||dateField(row,'purge_after').getTime()!==report.evaluatedAtMs+14_400_000
    ||integerField(row,'report_payload_version')!==1
    ||canonicalStringifyJson(payload)!==canonicalStringifyJson(expectedPayload)
  ) throw new TypeError('Stored qualification projection is invalid.');
  fingerprint(projection.evidenceFingerprint);
  canonicalStringifyJson(projection);
  return projection;
}

async function loadCurrentDecision(
  client: Client,
  candidateId: string,
  includeOrphaned: boolean,
): Promise<PaperDecisionSnapshot['currentDecision']> {
  const qualification=await loadQualificationByCandidate(client,candidateId,includeOrphaned);
  if(qualification===null)return null;
  const result = await client.query(`SELECT
    candidate_event.event_id AS candidate_event_id,
    candidate_event.type AS candidate_event_type,
    candidate_event.mint AS candidate_event_mint,
    candidate_event.source AS candidate_event_source,
    candidate_event.program AS candidate_event_program,
    candidate_event.signature AS candidate_event_signature,
    candidate_event.slot AS candidate_event_slot,
    candidate_event.transaction_index AS candidate_event_transaction_index,
    candidate_event.instruction_index AS candidate_event_instruction_index,
    candidate_event.inner_instruction_index AS candidate_event_inner_instruction_index,
    candidate_event.confirmation_status AS candidate_event_confirmation_status,
    candidate_event.blockchain_time AS candidate_event_blockchain_time,
    candidate_event.observed_at AS candidate_event_observed_at,
    candidate_event.payload_version AS candidate_event_payload_version,
    candidate_event.payload AS candidate_event_payload
    FROM trading_candidates candidate
    JOIN domain_events candidate_event ON candidate_event.event_id=candidate.candidate_event_id
    WHERE candidate.candidate_id=$1
      AND ($2::boolean OR candidate_event.confirmation_status<>'orphaned')`, [
    candidateId,includeOrphaned,
  ]);
  const row = result.rows[0];
  if (row === undefined) return null;
  return deepFreeze({
    qualification,
    candidateEvent:decodePrefixedDomainEvent(row,'candidate_event_'),
  });
}

async function loadQualificationByCandidate(
  client:Client,candidateId:string,includeOrphaned:boolean,
):Promise<CanonicalQualificationProjection|null>{
  const linked=await client.query(
    'SELECT report_id FROM trading_candidates WHERE candidate_id=$1',[candidateId],
  );
  const row=linked.rows[0];
  return row===undefined
    ?null
    :loadQualification(client,textField(row,'report_id'),false,includeOrphaned);
}

async function activeLaunchTrades(
  client: Client,
  mint: string,
  session: PaperStrategySessionV1 | null,
): Promise<readonly BondingCurveTradeObservedEventV1[]> {
  const cursor = session?.entryCursor ?? null;
  const result = await client.query(`SELECT event.* FROM domain_events event
    WHERE event.mint=$1 AND event.type='BondingCurveTradeObserved'
      AND event.confirmation_status<>'orphaned'
      AND ($2::numeric IS NULL OR (
        event.slot,event.transaction_index,event.instruction_index,
        COALESCE(event.inner_instruction_index,-1)
      ) > ($2::numeric,$3::integer,$4::integer,COALESCE($5::integer,-1)))
    ORDER BY event.slot,event.transaction_index,event.instruction_index,
      COALESCE(event.inner_instruction_index,-1),event.event_id`, [
    mint,cursor?.slot.toString() ?? null,cursor?.transactionIndex ?? null,
    cursor?.instructionIndex ?? null,cursor?.innerInstructionIndex ?? null,
  ]);
  return Object.freeze(result.rows.map((row) => {
    const event = decodeDomainEvent(row);
    if (event.type !== 'BondingCurveTradeObserved' || !('trade' in event.payload)) {
      throw new TypeError('Bonding curve trade event payload is invalid.');
    }
    return event as unknown as BondingCurveTradeObservedEventV1;
  }));
}

async function activeMarketTrades(
  client: Client,
  mint: string,
  session: PaperStrategySessionV1 | null,
): Promise<readonly MarketTrade[]> {
  const cursor = session?.entryCursor ?? null;
  const result = await client.query(`SELECT payload FROM market_trades WHERE mint=$1
    AND confirmation_status<>'orphaned'
    AND ($2::numeric IS NULL OR (
      slot,transaction_index,instruction_index,COALESCE(inner_instruction_index,-1)
    ) > ($2::numeric,$3::integer,$4::integer,COALESCE($5::integer,-1)))
    ORDER BY slot,transaction_index,instruction_index,
    COALESCE(inner_instruction_index,-1),trade_id`, [
    mint,cursor?.slot.toString() ?? null,cursor?.transactionIndex ?? null,
    cursor?.instructionIndex ?? null,cursor?.innerInstructionIndex ?? null,
  ]);
  return Object.freeze(result.rows.map((row) => decoded(
    field(row, 'payload'),
    'Market trade payload is invalid.',
  ) as MarketTrade));
}

async function latestWalletGraph(client: Client, mint: string): Promise<WalletGraphAnalysis | null> {
  const snapshotResult = await client.query(`SELECT snapshot.input_fingerprint,snapshot.coverage
    FROM wallet_graph_snapshots snapshot
    JOIN domain_events event ON event.event_id=snapshot.graph_event_id
    WHERE snapshot.mint=$1 AND event.confirmation_status<>'orphaned'
    ORDER BY snapshot.observed_at DESC,snapshot.snapshot_id DESC LIMIT 1`, [mint]);
  const snapshot = snapshotResult.rows[0];
  if (snapshot === undefined) return null;
  const inputFingerprint = textField(snapshot, 'input_fingerprint');
  const relationshipResult = await client.query(`SELECT * FROM wallet_relationships
    WHERE mint=$1 AND input_fingerprint=$2 ORDER BY relationship_id`, [mint,inputFingerprint]);
  const clusterResult = await client.query(`SELECT * FROM wallet_clusters
    WHERE mint=$1 AND input_fingerprint=$2 ORDER BY cluster_id`, [mint,inputFingerprint]);
  const memberResult = await client.query(`SELECT * FROM wallet_cluster_members
    WHERE mint=$1 AND input_fingerprint=$2 ORDER BY cluster_id,wallet`, [mint,inputFingerprint]);
  const membersByCluster = new Map<string, WalletClusterMember[]>();
  for (const row of memberResult.rows) {
    const clusterId = textField(row, 'cluster_id');
    const members = membersByCluster.get(clusterId) ?? [];
    members.push(deepFreeze({
      wallet:textField(row,'wallet'),role:textField(row,'member_role') as WalletClusterMember['role'],
      isCreator:booleanField(row,'is_creator'),
      observedNetBaseRaw:BigInt(textField(row,'observed_net_base_raw')),
    }));
    membersByCluster.set(clusterId, members);
  }
  const relationships = Object.freeze(relationshipResult.rows.map((row): WalletRelationship => deepFreeze({
    id:textField(row,'relationship_id'),mint,leftWallet:textField(row,'left_wallet'),
    rightWallet:textField(row,'right_wallet'),type:textField(row,'relationship_type') as WalletRelationship['type'],
    confidence:textField(row,'confidence') as WalletRelationship['confidence'],
    evidenceCount:integerField(row,'evidence_count'),
    quoteTotals:decodedArray(field(row,'quote_totals'),'Wallet relationship quote totals are invalid.') as WalletRelationship['quoteTotals'],
    firstObservedCursor:decoded(field(row,'first_observed_cursor'),'Wallet relationship cursor is invalid.') as WalletRelationship['firstObservedCursor'],
    lastObservedCursor:decoded(field(row,'last_observed_cursor'),'Wallet relationship cursor is invalid.') as WalletRelationship['lastObservedCursor'],
  })));
  const clusters = Object.freeze(clusterResult.rows.map((row): WalletCluster => {
    const clusterId = textField(row, 'cluster_id');
    return deepFreeze({
      id:clusterId,mint,members:Object.freeze(membersByCluster.get(clusterId) ?? []),
      participantWalletCount:integerField(row,'participant_wallet_count'),
      auxiliaryWalletCount:integerField(row,'auxiliary_wallet_count'),
      positiveHolderCount:integerField(row,'positive_holder_count'),
      observedPositiveBaseRaw:BigInt(textField(row,'observed_positive_base_raw')),
      concentrationBps:BigInt(textField(row,'concentration_bps')),
      containsCreator:booleanField(row,'contains_creator'),
      sharedFunderCount:integerField(row,'shared_funder_count'),
      strongRelationshipCount:integerField(row,'strong_relationship_count'),
      strongEvidenceCount:integerField(row,'strong_evidence_count'),
      quoteAssets:decodedArray(field(row,'quote_assets'),'Wallet cluster quote assets are invalid.') as WalletCluster['quoteAssets'],
    });
  }));
  return deepFreeze({
    relationships,clusters,
    coverage:decoded(field(snapshot,'coverage'),'Wallet graph coverage is invalid.') as WalletGraphAnalysis['coverage'],
  });
}

function decodeDomainEvent(row: unknown): DomainEvent {
  return deepFreeze({
    id:textField(row,'event_id'),type:textField(row,'type') as DomainEvent['type'],
    mint:textField(row,'mint'),source:textField(row,'source'),program:textField(row,'program'),
    signature:textField(row,'signature'),cursor:cursorFromRow(row),
    confirmationStatus:textField(row,'confirmation_status') as DomainEvent['confirmationStatus'],
    blockchainTimeMs:nullableDateField(row,'blockchain_time')?.getTime() ?? null,
    observedAtMs:dateField(row,'observed_at').getTime(),payloadVersion:integerField(row,'payload_version'),
    payload:decoded(field(row,'payload'),'Domain event payload is invalid.') as Readonly<Record<string, unknown>>,
  });
}

function decodePrefixedDomainEvent(row: unknown, prefix: string): DomainEvent {
  const projected = {
    event_id:field(row,`${prefix}id`),type:field(row,`${prefix}type`),
    mint:field(row,`${prefix}mint`),source:field(row,`${prefix}source`),
    program:field(row,`${prefix}program`),signature:field(row,`${prefix}signature`),
    slot:field(row,`${prefix}slot`),transaction_index:field(row,`${prefix}transaction_index`),
    instruction_index:field(row,`${prefix}instruction_index`),
    inner_instruction_index:field(row,`${prefix}inner_instruction_index`),
    confirmation_status:field(row,`${prefix}confirmation_status`),
    blockchain_time:field(row,`${prefix}blockchain_time`),
    observed_at:field(row,`${prefix}observed_at`),
    payload_version:field(row,`${prefix}payload_version`),payload:field(row,`${prefix}payload`),
  };
  return decodeDomainEvent(projected);
}

function cursorFromRow(row: unknown): DomainEvent['cursor'] {
  const inner = field(row, 'inner_instruction_index');
  return Object.freeze({
    slot:BigInt(textField(row,'slot')),transactionIndex:integerField(row,'transaction_index'),
    instructionIndex:integerField(row,'instruction_index'),
    innerInstructionIndex:inner === null ? null : integer(inner,'inner_instruction_index'),
  });
}

function claimedJob(row: unknown): ClaimedPaperDecisionJob {
  return Object.freeze({
    jobId:textField(row,'job_id'),mint:textField(row,'mint'),
    sourceEventId:textField(row,'source_event_id'),sourceRawEventId:textField(row,'source_raw_event_id'),
    sourceConfirmationStatus:textField(row,'source_confirmation_status') as ClaimedPaperDecisionJob['sourceConfirmationStatus'],
    inputFingerprint:textField(row,'input_fingerprint'),attempts:integerField(row,'attempts'),
    maxAttempts:integerField(row,'max_attempts'),leaseToken:textField(row,'lease_token'),
    leaseExpiresAtMs:dateField(row,'lease_expires_at').getTime(),
  });
}

function assertDecisionResult(job: ClaimedPaperDecisionJob, result: PaperDecisionResult): void {
  if (
    result.candidate.mint !== job.mint
    || result.qualificationEvent.mint !== job.mint
    || result.candidateEvent.mint !== job.mint
    || result.candidate.qualificationReportId.length === 0
    || (result.session !== null && result.session.mint !== result.candidate.mint)
    || (result.session === null) !== (result.sessionEvent === null)
    || (result.sessionEvent !== null && result.sessionEvent.mint !== job.mint)
    || result.countedExternalBuys.some((item) => item.mint !== job.mint)
  ) throw new TypeError('Paper decision result context is invalid.');
  canonicalStringifyJson(result);
}

function assertJobInput(input: PaperDecisionJobInput): void {
  boundedText(input.mint, 'mint');
  boundedText(input.sourceEventId, 'sourceEventId');
  boundedText(input.sourceRawEventId, 'sourceRawEventId');
  fingerprint(input.inputFingerprint);
  if (!['processed','confirmed','finalized','orphaned'].includes(input.sourceConfirmationStatus)) {
    throw new TypeError('Paper decision source confirmation is invalid.');
  }
  canonicalStringifyJson(input);
}

function assertClaim(job: ClaimedPaperDecisionJob): void {
  assertJobInput(job);
  if (!/^paper_job_[a-f0-9]{64}$/u.test(job.jobId)) throw new TypeError('Paper job id is invalid.');
  boundedText(job.leaseToken, 'leaseToken');
  positiveInteger(job.attempts, 'attempts');
  integerInRange(job.maxAttempts, 1, 100, 'maxAttempts');
  timestamp(job.leaseExpiresAtMs, 'leaseExpiresAtMs');
}

function assertFailure(failure: PaperDecisionFailure): void {
  if (!['RPC_TRANSIENT','QUOTE_UNAVAILABLE','LEASE_EXPIRED','DECISION_INVALID'].includes(failure.code)) {
    throw new TypeError('Paper decision failure code is invalid.');
  }
}

function decisionPayload(job: ClaimedPaperDecisionJob, result: PaperDecisionResult): object {
  return Object.freeze({
    input:Object.freeze({
      mint:job.mint,sourceEventId:job.sourceEventId,sourceRawEventId:job.sourceRawEventId,
      sourceConfirmationStatus:job.sourceConfirmationStatus,inputFingerprint:job.inputFingerprint,
    }),
    result:Object.freeze({
      qualificationReportId:result.candidate.qualificationReportId,
      qualificationEventId:result.qualificationEvent.id,candidateId:result.candidate.id,
      candidateEventId:result.candidateEvent.id,sessionId:result.session?.id ?? null,
      sessionEventId:result.sessionEvent?.id ?? null,requestedAction:result.requestedAction,
    }),
  });
}

function payloadProperty(payload: object, key: string): object {
  if (!(key in payload)) throw new TypeError(`Domain event payload ${key} is missing.`);
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`Domain event payload ${key} is invalid.`);
  }
  return deepFreeze(value);
}

function decoded(value: unknown, message: string): object {
  const decodedValue = fromJsonValue(value);
  if (typeof decodedValue !== 'object' || decodedValue === null) throw new TypeError(message);
  canonicalStringifyJson(decodedValue);
  return deepFreeze(decodedValue);
}

function decodedArray(value: unknown, message: string): readonly object[] {
  const decodedValue = fromJsonValue(value);
  if (!Array.isArray(decodedValue) || decodedValue.some((item) => typeof item !== 'object' || item === null)) {
    throw new TypeError(message);
  }
  return deepFreeze(decodedValue) as readonly object[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function hash(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function retryDelay(base: number, attempt: number): number {
  return Math.min(60_000, base * (2 ** Math.min(attempt - 1, 16)));
}

async function lockMint(client: Client, mint: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('paper-decision:' || $1, 0))", [mint]);
}

async function lockQualificationMint(client:Client,mint:string):Promise<void>{
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('qualification-projection:' || $1, 0))",
    [mint],
  );
}

async function exact(client: Client, sql: string, values: readonly unknown[]): Promise<void> {
  const result = await client.query(sql, values);
  if (result.rowCount !== 1) throw new PaperDecisionLeaseLostError();
}

async function rollback(client: Client): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
}

function release(client: Client): void {
  try { client.release(); } catch { /* connection is already unusable */ }
}

function repositoryError(operation: Operation, cause: unknown): PaperDecisionRepositoryError {
  return cause instanceof PaperDecisionRepositoryError ? cause : new PaperDecisionRepositoryError(operation, { cause });
}

function requiredRow(result: Result, message: string): unknown {
  const row = result.rows[0];
  if (row === undefined) throw new TypeError(message);
  return row;
}

function field(row: unknown, name: string): unknown {
  if (typeof row !== 'object' || row === null || !(name in row)) throw new TypeError(`Database field ${name} is missing.`);
  return (row as Record<string, unknown>)[name];
}

function textField(row: unknown, name: string): string {
  const value = field(row, name);
  if (typeof value !== 'string') throw new TypeError(`Database field ${name} is invalid.`);
  return value;
}

function nullableTextField(row: unknown, name: string): string | null {
  const value = field(row, name);
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`Database field ${name} is invalid.`);
  return value;
}

function integerField(row: unknown, name: string): number { return integer(field(row, name), name); }
function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`Database field ${name} is invalid.`);
  return value;
}

function booleanField(row: unknown, name: string): boolean {
  const value = field(row, name);
  if (typeof value !== 'boolean') throw new TypeError(`Database field ${name} is invalid.`);
  return value;
}

function dateField(row: unknown, name: string): Date {
  const value = field(row, name);
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`Database field ${name} is invalid.`);
  return value;
}

function nullableDateField(row: unknown, name: string): Date | null {
  const value = field(row, name);
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`Database field ${name} is invalid.`);
  return value;
}

function boundedText(value: string, name: string): void {
  if (value.length === 0 || value !== value.trim() || Buffer.byteLength(value, 'utf8') > 16_384) {
    throw new TypeError(`Paper decision ${name} is invalid.`);
  }
}

function fingerprint(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError('Paper decision fingerprint is invalid.');
}

function positiveInteger(value: number, name: string): void { integerInRange(value, 1, Number.MAX_SAFE_INTEGER, name); }
function integerInRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`Paper decision ${name} is invalid.`);
}

function timestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
    throw new RangeError(`Paper decision ${name} is invalid.`);
  }
}

function date(value: number | null): Date | null { return value === null ? null : new Date(value); }

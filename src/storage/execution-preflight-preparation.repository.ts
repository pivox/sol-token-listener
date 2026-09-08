import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  createExecutionPreflightPreparationIdentity,
  type ClaimedExecutionPreflightPreparation,
  type ExecutionPreflightPreparationErrorCode,
  type ExecutionPreflightPreparationState,
  type ExecutionPreflightPreparationV1,
} from '../domain/execution-preflight-preparation.js';
import type {
  ExecutionPreflightMarkPreparedOptions,
  ExecutionPreflightPairSelectionV1,
  ExecutionPreflightPreparationRepository,
  ExecutionPreflightPreparationStartOptions,
} from '../ports/execution-preflight-preparation-repository.js';
import { getDatabasePool } from './database.js';

type Row = Readonly<Record<string, unknown>>;

interface QueryResult {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

interface ExecutionPreflightPreparationClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(error?: boolean): void;
}

export interface ExecutionPreflightPreparationPool {
  connect(): Promise<ExecutionPreflightPreparationClient>;
}

export type ExecutionPreflightPreparationRepositoryErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_DATA'
  | 'DATABASE_FAILURE'
  | 'OPERATION_ABORTED'
  | 'PREPARATION_BUSY'
  | 'PREPARATION_LEASE_LOST'
  | 'PREFLIGHT_PAIR_CONFLICT'
  | 'PREFLIGHT_PAIR_LINEAGE_INVALID'
  | 'PREFLIGHT_ASSESSMENT_INVALID'
  | 'PREFLIGHT_SIMULATION_FAILED'
  | 'PREFLIGHT_PREPARATION_DEADLINE_EXCEEDED';

export class ExecutionPreflightPreparationRepositoryError extends Error {
  public constructor(
    public readonly code: ExecutionPreflightPreparationRepositoryErrorCode,
    options?: ErrorOptions,
  ) {
    super('Execution preflight preparation repository operation failed.', options);
    this.name = 'ExecutionPreflightPreparationRepositoryError';
  }
}

const HANDOFF_RESERVE_MS = 5_000;
const DATE_MAX_MS = 8_640_000_000_000_000;
const INT64_MAX = 9_223_372_036_854_775_807n;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const START_KEYS = Object.freeze(['ownerId', 'selectionWindowMs', 'leaseMs'] as const);
const MARK_PREPARED_KEYS = Object.freeze(['manifestFingerprint'] as const);
const CLAIM_KEYS = Object.freeze([
  'preparation', 'leaseOwner', 'leaseToken', 'leaseExpiresAtMs',
] as const);
const PREPARATION_KEYS = Object.freeze([
  'payloadVersion', 'runId', 'runFingerprint', 'state', 'stateRevision',
  'watermarkAtMs', 'deadlineAtMs', 'pairId', 'assessmentId', 'assessmentFingerprint',
  'artifactId', 'artifactFingerprint', 'manifestFingerprint', 'failureCode',
  'createdAtMs', 'updatedAtMs',
  'selectedAtMs', 'completedAtMs', 'purgeAfterMs',
] as const);
const PREPARATION_ROW_KEYS = Object.freeze([
  'run_id', 'payload_version', 'run_fingerprint', 'state', 'state_revision',
  'watermark_at_ms', 'deadline_at_ms', 'pair_id', 'assessment_id',
  'assessment_fingerprint', 'artifact_id', 'artifact_fingerprint', 'manifest_fingerprint',
  'failure_code',
  'created_at_ms', 'updated_at_ms', 'selected_at_ms', 'completed_at_ms', 'purge_after_ms',
] as const);
const CLAIM_ROW_KEYS = Object.freeze([
  ...PREPARATION_ROW_KEYS, 'lease_owner', 'lease_token', 'lease_expires_at_ms',
] as const);
const PAIR_ROW_KEYS = Object.freeze([
  'pair_id', 'pair_fingerprint', 'target_intent_id', 'simulation_intent_id',
  'decision_event_id', 'decision_fingerprint', 'pair_created_at_ms', 'pair_expires_at_ms',
] as const);

const PREPARATION_PROJECTION = `
  preparation.run_id,
  preparation.payload_version,
  preparation.run_fingerprint,
  preparation.state,
  preparation.state_revision::TEXT AS state_revision,
  trunc(EXTRACT(EPOCH FROM preparation.watermark_at)*1000)::TEXT AS watermark_at_ms,
  trunc(EXTRACT(EPOCH FROM preparation.deadline_at)*1000)::TEXT AS deadline_at_ms,
  preparation.pair_id,
  preparation.assessment_id,
  preparation.assessment_fingerprint,
  preparation.artifact_id,
  preparation.artifact_fingerprint,
  preparation.manifest_fingerprint,
  preparation.failure_code,
  trunc(EXTRACT(EPOCH FROM preparation.created_at)*1000)::TEXT AS created_at_ms,
  trunc(EXTRACT(EPOCH FROM preparation.updated_at)*1000)::TEXT AS updated_at_ms,
  CASE WHEN preparation.selected_at IS NULL THEN NULL ELSE
    trunc(EXTRACT(EPOCH FROM preparation.selected_at)*1000)::TEXT END AS selected_at_ms,
  CASE WHEN preparation.completed_at IS NULL THEN NULL ELSE
    trunc(EXTRACT(EPOCH FROM preparation.completed_at)*1000)::TEXT END AS completed_at_ms,
  CASE WHEN preparation.purge_after IS NULL THEN NULL ELSE
    trunc(EXTRACT(EPOCH FROM preparation.purge_after)*1000)::TEXT END AS purge_after_ms`;

const CLAIM_PROJECTION = `${PREPARATION_PROJECTION},
  preparation.lease_owner,
  preparation.lease_token::TEXT AS lease_token,
  trunc(EXTRACT(EPOCH FROM preparation.lease_expires_at)*1000)::TEXT AS lease_expires_at_ms`;

const PAIR_PROJECTION = `
  pair.pair_id,
  pair.pair_fingerprint,
  pair.target_intent_id,
  pair.simulation_intent_id,
  pair.decision_event_id,
  pair.decision_fingerprint,
  trunc(EXTRACT(EPOCH FROM pair.created_at)*1000)::TEXT AS pair_created_at_ms,
  trunc(EXTRACT(EPOCH FROM pair.expires_at)*1000)::TEXT AS pair_expires_at_ms`;

const BIND_TARGET_ASSESSMENT_SQL = `WITH operation AS MATERIALIZED (
  SELECT date_trunc('milliseconds',statement_timestamp()) AS at
), proof AS MATERIALIZED (
  SELECT preparation.run_id,assessment.assessment_id,assessment.result_fingerprint
  FROM operation
  JOIN execution_preflight_intent_preparation_runs AS preparation ON TRUE
  JOIN execution_preflight_intent_pairs AS pair ON pair.pair_id=preparation.pair_id
  JOIN execution_intents AS target ON target.id=pair.target_intent_id
  JOIN execution_preflight_intent_pair_memberships AS member
    ON member.pair_id=pair.pair_id AND member.intent_id=target.id AND member.lane='TARGET'
  JOIN execution_dry_run_assessments AS assessment ON assessment.intent_id=target.id
  WHERE preparation.run_id=$1 AND preparation.state='PREPARING'
    AND preparation.state_revision IN ($2::BIGINT,$2::BIGINT+1)
    AND preparation.lease_owner=$3 AND preparation.lease_token=$4::UUID
    AND preparation.lease_expires_at=TIMESTAMPTZ 'epoch'
      +($5::BIGINT*INTERVAL '1 millisecond')
    AND preparation.lease_expires_at>operation.at
    AND preparation.deadline_at>operation.at+INTERVAL '5 seconds'
    AND pair.created_at>preparation.watermark_at
    AND pair.created_at<preparation.deadline_at-INTERVAL '5 seconds'
    AND pair.expires_at>operation.at+INTERVAL '5 seconds'
    AND pair.decision_event_id=target.decision_event_id
    AND pair.decision_fingerprint=target.decision_fingerprint
    AND ${pristineIntent('target')}
    AND target.side='BUY' AND target.venue_policy='PUMP_FUN_ONLY'
    AND assessment.payload_version=1
    AND assessment.specification_version='1.4.0'
    AND assessment.evaluator_version=1
    AND assessment.strategy_id=target.strategy_id
    AND assessment.strategy_version=target.strategy_version
    AND assessment.decision_fingerprint=target.decision_fingerprint
    AND assessment.intent_state_revision=0
    AND assessment.intent_status='PENDING'
    AND assessment.outcome='FOUNDATION_VALIDATED'
    AND assessment.coverage='INTENT_AND_LEASE_ONLY'
    AND assessment.quote_status='NOT_RUN' AND assessment.build_status='NOT_RUN'
    AND assessment.simulation_status='NOT_RUN' AND assessment.signature_status='NOT_RUN'
    AND assessment.submission_status='NOT_RUN'
    AND assessment.recorded_at>=target.requested_at AND assessment.recorded_at<=operation.at
  FOR UPDATE OF preparation,pair,target
), updated AS MATERIALIZED (
  UPDATE execution_preflight_intent_preparation_runs AS preparation
  SET assessment_id=proof.assessment_id,
    assessment_fingerprint=proof.result_fingerprint,
    state_revision=preparation.state_revision+1
  FROM proof
  WHERE preparation.run_id=proof.run_id AND preparation.state_revision=$2::BIGINT
    AND preparation.assessment_id IS NULL AND preparation.assessment_fingerprint IS NULL
  RETURNING ${CLAIM_PROJECTION}
), replayed AS MATERIALIZED (
  SELECT ${CLAIM_PROJECTION}
  FROM proof
  JOIN execution_preflight_intent_preparation_runs AS preparation
    ON preparation.run_id=proof.run_id
  WHERE NOT EXISTS (SELECT 1 FROM updated)
    AND preparation.state_revision IN ($2::BIGINT,$2::BIGINT+1)
    AND preparation.assessment_id=proof.assessment_id
    AND preparation.assessment_fingerprint=proof.result_fingerprint
)
SELECT * FROM updated
UNION ALL
SELECT * FROM replayed`;

const BIND_SIMULATION_ARTIFACT_SQL = `WITH operation AS MATERIALIZED (
  SELECT date_trunc('milliseconds',statement_timestamp()) AS at
), proof AS MATERIALIZED (
  SELECT preparation.run_id,artifact.artifact_id,artifact.result_fingerprint
  FROM operation
  JOIN execution_preflight_intent_preparation_runs AS preparation ON TRUE
  JOIN execution_preflight_intent_pairs AS pair ON pair.pair_id=preparation.pair_id
  JOIN execution_intents AS target ON target.id=pair.target_intent_id
  JOIN execution_intents AS simulation ON simulation.id=pair.simulation_intent_id
  JOIN execution_preflight_intent_pair_memberships AS target_member
    ON target_member.pair_id=pair.pair_id
      AND target_member.intent_id=target.id AND target_member.lane='TARGET'
  JOIN execution_preflight_intent_pair_memberships AS simulation_member
    ON simulation_member.pair_id=pair.pair_id
      AND simulation_member.intent_id=simulation.id AND simulation_member.lane='SIMULATION'
  JOIN execution_dry_run_assessments AS assessment
    ON assessment.assessment_id=preparation.assessment_id
      AND assessment.result_fingerprint=preparation.assessment_fingerprint
  JOIN execution_attempts AS attempt
    ON attempt.intent_id=simulation.id AND attempt.attempt_number=1
  JOIN execution_simulation_artifacts AS artifact
    ON artifact.intent_id=simulation.id AND artifact.attempt_number=attempt.attempt_number
  WHERE preparation.run_id=$1 AND preparation.state='PREPARING'
    AND preparation.state_revision IN ($2::BIGINT,$2::BIGINT+1)
    AND preparation.lease_owner=$3 AND preparation.lease_token=$4::UUID
    AND preparation.lease_expires_at=TIMESTAMPTZ 'epoch'
      +($5::BIGINT*INTERVAL '1 millisecond')
    AND preparation.lease_expires_at>operation.at
    AND preparation.deadline_at>operation.at+INTERVAL '5 seconds'
    AND preparation.assessment_id IS NOT NULL
    AND preparation.assessment_fingerprint IS NOT NULL
    AND pair.created_at>preparation.watermark_at
    AND pair.created_at<preparation.deadline_at-INTERVAL '5 seconds'
    AND pair.expires_at>operation.at+INTERVAL '5 seconds'
    AND pair.decision_event_id=target.decision_event_id
    AND pair.decision_fingerprint=target.decision_fingerprint
    AND ${pristineIntent('target')}
    AND target.side='BUY' AND target.venue_policy='PUMP_FUN_ONLY'
    AND assessment.intent_id=target.id AND assessment.payload_version=1
    AND assessment.specification_version='1.4.0' AND assessment.evaluator_version=1
    AND assessment.strategy_id=target.strategy_id
    AND assessment.strategy_version=target.strategy_version
    AND assessment.decision_fingerprint=target.decision_fingerprint
    AND assessment.intent_state_revision=0 AND assessment.intent_status='PENDING'
    AND assessment.outcome='FOUNDATION_VALIDATED'
    AND assessment.coverage='INTENT_AND_LEASE_ONLY'
    AND assessment.quote_status='NOT_RUN' AND assessment.build_status='NOT_RUN'
    AND assessment.simulation_status='NOT_RUN' AND assessment.signature_status='NOT_RUN'
    AND assessment.submission_status='NOT_RUN'
    AND simulation.status='SUCCEEDED' AND simulation.attempt_count=1
    AND simulation.last_reason_code='INTENT_SUCCEEDED'
    AND simulation.lease_owner IS NULL AND simulation.lease_token IS NULL
    AND simulation.lease_expires_at IS NULL AND simulation.live_reserved=FALSE
    AND simulation.terminal_at IS NOT NULL
    AND simulation.reconciliation_completed_at=simulation.terminal_at
    AND simulation.purge_after=simulation.reconciliation_completed_at+INTERVAL '4 hours'
    AND target.strategy_id=simulation.strategy_id
    AND target.strategy_version=simulation.strategy_version
    AND target.position_id=simulation.position_id AND target.mint=simulation.mint
    AND target.side=simulation.side AND target.venue_policy=simulation.venue_policy
    AND target.quote_mint=simulation.quote_mint
    AND target.quote_token_program=simulation.quote_token_program
    AND target.quote_decimals=simulation.quote_decimals
    AND target.quote_amount_raw IS NOT DISTINCT FROM simulation.quote_amount_raw
    AND target.base_amount_raw IS NOT DISTINCT FROM simulation.base_amount_raw
    AND target.minimum_amount_out_raw=simulation.minimum_amount_out_raw
    AND target.decision_event_id=simulation.decision_event_id
    AND target.decision_fingerprint=simulation.decision_fingerprint
    AND target.requested_at=simulation.requested_at AND target.expires_at=simulation.expires_at
    AND attempt.status='COMPLETED' AND attempt.reason_code='ATTEMPT_COMPLETED'
    AND attempt.completed_at IS NOT NULL AND attempt.purge_after IS NULL
    AND artifact.payload_version=1 AND artifact.specification_version='1.5.0'
    AND artifact.evaluator_version=1 AND artifact.attempt_number=1
    AND artifact.intent_state_revision+2=simulation.state_revision
    AND artifact.strategy_id=simulation.strategy_id
    AND artifact.strategy_version=simulation.strategy_version
    AND artifact.decision_fingerprint=simulation.decision_fingerprint
    AND artifact.result_kind='SUCCESS' AND artifact.effective_venue='PUMP_FUN'
    AND artifact.terminal_reason_code='INTENT_SUCCEEDED'
    AND artifact.amount_in_raw=simulation.quote_amount_raw
    AND artifact.protected_amount_out_raw>=simulation.minimum_amount_out_raw
    AND artifact.quote_status='SUCCEEDED' AND artifact.build_status='SUCCEEDED'
    AND artifact.simulation_status='SUCCEEDED'
    AND artifact.failure_stage IS NULL AND artifact.failure_code IS NULL
    AND artifact.recorded_at=attempt.completed_at
    AND artifact.recorded_at=simulation.terminal_at
    AND artifact.recorded_at>=operation.at-INTERVAL '30 seconds'
    AND artifact.recorded_at<=operation.at
    AND artifact.recorded_at<preparation.deadline_at
  FOR UPDATE OF preparation,pair,target,simulation
), updated AS MATERIALIZED (
  UPDATE execution_preflight_intent_preparation_runs AS preparation
  SET artifact_id=proof.artifact_id,
    artifact_fingerprint=proof.result_fingerprint,
    state_revision=preparation.state_revision+1
  FROM proof
  WHERE preparation.run_id=proof.run_id AND preparation.state_revision=$2::BIGINT
    AND preparation.artifact_id IS NULL AND preparation.artifact_fingerprint IS NULL
  RETURNING ${CLAIM_PROJECTION}
), replayed AS MATERIALIZED (
  SELECT ${CLAIM_PROJECTION}
  FROM proof
  JOIN execution_preflight_intent_preparation_runs AS preparation
    ON preparation.run_id=proof.run_id
  WHERE NOT EXISTS (SELECT 1 FROM updated)
    AND preparation.state_revision IN ($2::BIGINT,$2::BIGINT+1)
    AND preparation.artifact_id=proof.artifact_id
    AND preparation.artifact_fingerprint=proof.result_fingerprint
)
SELECT * FROM updated
UNION ALL
SELECT * FROM replayed`;

const MARK_PREPARED_SQL = `WITH operation AS MATERIALIZED (
  SELECT date_trunc('milliseconds',statement_timestamp()) AS at
), eligible AS MATERIALIZED (
  SELECT preparation.run_id
  FROM operation
  JOIN execution_preflight_intent_preparation_runs AS preparation ON TRUE
  JOIN execution_preflight_intent_pairs AS pair ON pair.pair_id=preparation.pair_id
  JOIN execution_intents AS target ON target.id=pair.target_intent_id
  JOIN execution_intents AS simulation ON simulation.id=pair.simulation_intent_id
  JOIN execution_preflight_intent_pair_memberships AS target_member
    ON target_member.pair_id=pair.pair_id
      AND target_member.intent_id=target.id AND target_member.lane='TARGET'
  JOIN execution_preflight_intent_pair_memberships AS simulation_member
    ON simulation_member.pair_id=pair.pair_id
      AND simulation_member.intent_id=simulation.id AND simulation_member.lane='SIMULATION'
  JOIN execution_dry_run_assessments AS assessment
    ON assessment.assessment_id=preparation.assessment_id
      AND assessment.result_fingerprint=preparation.assessment_fingerprint
  JOIN execution_attempts AS attempt
    ON attempt.intent_id=simulation.id AND attempt.attempt_number=1
  JOIN execution_simulation_artifacts AS artifact
    ON artifact.artifact_id=preparation.artifact_id
      AND artifact.result_fingerprint=preparation.artifact_fingerprint
      AND artifact.intent_id=simulation.id AND artifact.attempt_number=1
  WHERE preparation.run_id=$1
    AND preparation.state_revision IN ($2::BIGINT,$2::BIGINT+1)
    AND preparation.assessment_id IS NOT NULL
    AND preparation.assessment_fingerprint IS NOT NULL
    AND preparation.artifact_id IS NOT NULL
    AND preparation.artifact_fingerprint IS NOT NULL
    AND pair.decision_event_id=target.decision_event_id
    AND pair.decision_fingerprint=target.decision_fingerprint
    AND ${pristineIntent('target')}
    AND target.side='BUY' AND target.venue_policy='PUMP_FUN_ONLY'
    AND assessment.intent_id=target.id AND assessment.payload_version=1
    AND assessment.specification_version='1.4.0' AND assessment.evaluator_version=1
    AND assessment.strategy_id=target.strategy_id
    AND assessment.strategy_version=target.strategy_version
    AND assessment.decision_fingerprint=target.decision_fingerprint
    AND assessment.intent_state_revision=0 AND assessment.intent_status='PENDING'
    AND assessment.outcome='FOUNDATION_VALIDATED'
    AND assessment.coverage='INTENT_AND_LEASE_ONLY'
    AND assessment.quote_status='NOT_RUN' AND assessment.build_status='NOT_RUN'
    AND assessment.simulation_status='NOT_RUN' AND assessment.signature_status='NOT_RUN'
    AND assessment.submission_status='NOT_RUN'
    AND simulation.status='SUCCEEDED' AND simulation.attempt_count=1
    AND simulation.last_reason_code='INTENT_SUCCEEDED'
    AND simulation.lease_owner IS NULL AND simulation.lease_token IS NULL
    AND simulation.lease_expires_at IS NULL AND simulation.live_reserved=FALSE
    AND target.strategy_id=simulation.strategy_id
    AND target.strategy_version=simulation.strategy_version
    AND target.position_id=simulation.position_id AND target.mint=simulation.mint
    AND target.side=simulation.side AND target.venue_policy=simulation.venue_policy
    AND target.quote_mint=simulation.quote_mint
    AND target.quote_token_program=simulation.quote_token_program
    AND target.quote_decimals=simulation.quote_decimals
    AND target.quote_amount_raw IS NOT DISTINCT FROM simulation.quote_amount_raw
    AND target.base_amount_raw IS NOT DISTINCT FROM simulation.base_amount_raw
    AND target.minimum_amount_out_raw=simulation.minimum_amount_out_raw
    AND target.decision_event_id=simulation.decision_event_id
    AND target.decision_fingerprint=simulation.decision_fingerprint
    AND target.requested_at=simulation.requested_at AND target.expires_at=simulation.expires_at
    AND attempt.status='COMPLETED' AND attempt.reason_code='ATTEMPT_COMPLETED'
    AND artifact.payload_version=1 AND artifact.specification_version='1.5.0'
    AND artifact.evaluator_version=1 AND artifact.intent_state_revision+2=simulation.state_revision
    AND artifact.strategy_id=simulation.strategy_id
    AND artifact.strategy_version=simulation.strategy_version
    AND artifact.decision_fingerprint=simulation.decision_fingerprint
    AND artifact.result_kind='SUCCESS' AND artifact.effective_venue='PUMP_FUN'
    AND artifact.terminal_reason_code='INTENT_SUCCEEDED'
    AND artifact.amount_in_raw=simulation.quote_amount_raw
    AND artifact.protected_amount_out_raw>=simulation.minimum_amount_out_raw
    AND artifact.quote_status='SUCCEEDED' AND artifact.build_status='SUCCEEDED'
    AND artifact.simulation_status='SUCCEEDED'
    AND artifact.failure_stage IS NULL AND artifact.failure_code IS NULL
    AND artifact.recorded_at=attempt.completed_at
    AND artifact.recorded_at=simulation.terminal_at
    AND artifact.recorded_at<preparation.deadline_at
    AND (
      (preparation.state='PREPARING'
        AND preparation.state_revision=$2::BIGINT
        AND preparation.lease_owner=$3 AND preparation.lease_token=$4::UUID
        AND preparation.lease_expires_at=TIMESTAMPTZ 'epoch'
          +($5::BIGINT*INTERVAL '1 millisecond')
        AND preparation.lease_expires_at>operation.at
        AND preparation.deadline_at>operation.at+INTERVAL '5 seconds'
        AND pair.expires_at>operation.at+INTERVAL '5 seconds'
        AND artifact.recorded_at>=operation.at-INTERVAL '30 seconds'
        AND artifact.recorded_at<=operation.at)
      OR (preparation.state='PREPARED'
        AND preparation.state_revision=$2::BIGINT+1
        AND preparation.manifest_fingerprint=$6
        AND preparation.completed_at IS NOT NULL
        AND artifact.recorded_at>=preparation.completed_at-INTERVAL '30 seconds'
        AND artifact.recorded_at<=preparation.completed_at)
    )
  FOR UPDATE OF preparation,pair,target,simulation
), updated AS MATERIALIZED (
  UPDATE execution_preflight_intent_preparation_runs AS preparation
  SET state='PREPARED',manifest_fingerprint=$6,
    state_revision=preparation.state_revision+1
  FROM eligible
  WHERE preparation.run_id=eligible.run_id AND preparation.state='PREPARING'
    AND preparation.state_revision=$2::BIGINT
  RETURNING ${PREPARATION_PROJECTION}
), replayed AS MATERIALIZED (
  SELECT ${PREPARATION_PROJECTION}
  FROM eligible
  JOIN execution_preflight_intent_preparation_runs AS preparation
    ON preparation.run_id=eligible.run_id
  WHERE NOT EXISTS (SELECT 1 FROM updated)
    AND preparation.state='PREPARED'
    AND preparation.state_revision=$2::BIGINT+1
    AND preparation.manifest_fingerprint=$6
)
SELECT * FROM updated
UNION ALL
SELECT * FROM replayed`;

export class ExecutionPreflightPreparationPostgresRepository
implements ExecutionPreflightPreparationRepository {
  public constructor(
    private readonly pool: ExecutionPreflightPreparationPool = getDatabasePool(),
    private readonly uuidFactory: () => string = randomUUID,
  ) {}

  public async startOrResume(
    optionsValue: ExecutionPreflightPreparationStartOptions,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ClaimedExecutionPreflightPreparation> {
    const options = startOptions(optionsValue);
    requireSignal(signal);
    const identity = createExecutionPreflightPreparationIdentity(this.uuidFactory());
    const leaseToken = validUuid(this.uuidFactory());
    const client = await this.connect(signal);
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('execution-preflight-preparation-active:v1',51009))",
      );
      requireActive(signal);
      const active = await client.query(`SELECT ${CLAIM_PROJECTION},
        trunc(EXTRACT(EPOCH FROM date_trunc('milliseconds',statement_timestamp()))*1000)::TEXT
          AS operation_at_ms
        FROM execution_preflight_intent_preparation_runs AS preparation
        WHERE state IN ('WAITING','PREPARING')
        ORDER BY preparation.created_at,preparation.run_id
        LIMIT 1 FOR UPDATE`);
      let claim: ClaimedExecutionPreflightPreparation;
      if (active.rowCount === 0 && active.rows.length === 0) {
        const inserted = await client.query(`WITH operation AS MATERIALIZED (
          SELECT date_trunc('milliseconds',statement_timestamp()) AS at
        )
        INSERT INTO execution_preflight_intent_preparation_runs AS preparation (
          run_id,payload_version,run_fingerprint,state_revision,deadline_at,
          lease_owner,lease_token,lease_expires_at
        ) SELECT $1,1,$2,0,
          operation.at+($3::BIGINT*INTERVAL '1 millisecond'),$4,$5::UUID,
          operation.at+($6::BIGINT*INTERVAL '1 millisecond')
        FROM operation
        RETURNING ${CLAIM_PROJECTION}`, [
          identity.runId,
          identity.runFingerprint,
          options.selectionWindowMs,
          options.ownerId,
          leaseToken,
          options.leaseMs,
        ]);
        claim = onlyClaim(inserted);
        if (claim.preparation.runId !== identity.runId
          || claim.preparation.runFingerprint !== identity.runFingerprint) throw dataError();
      } else {
        const activeRow = onlyRow(active);
        const operationAtMs = timestamp(activeRow.operation_at_ms);
        const previous = claimFromRowWithoutExtra(activeRow);
        if (previous.leaseExpiresAtMs > operationAtMs) throw repositoryError('PREPARATION_BUSY');
        if (operationAtMs + HANDOFF_RESERVE_MS >= previous.preparation.deadlineAtMs) {
          const failed = await client.query(`UPDATE execution_preflight_intent_preparation_runs
            AS preparation
            SET state='FAILED',state_revision=preparation.state_revision+1,
              failure_code='PREFLIGHT_PREPARATION_DEADLINE_EXCEEDED'
            WHERE preparation.run_id=$1
              AND preparation.state_revision=$2::BIGINT
              AND preparation.state IN ('WAITING','PREPARING')
              AND preparation.lease_expires_at<=statement_timestamp()
              AND preparation.deadline_at<=statement_timestamp()+INTERVAL '5 seconds'
            RETURNING ${PREPARATION_PROJECTION}`, [
            previous.preparation.runId,
            previous.preparation.stateRevision.toString(),
          ]);
          if (failed.rowCount !== 1 || failed.rows.length !== 1) {
            throw repositoryError('PREPARATION_LEASE_LOST');
          }
          await client.query('COMMIT');
          committed = true;
          throw repositoryError('PREFLIGHT_PREPARATION_DEADLINE_EXCEEDED');
        }
        const renewed = await client.query(`UPDATE execution_preflight_intent_preparation_runs
          AS preparation
          SET lease_owner=$2,lease_token=$3::UUID,
            lease_expires_at=LEAST(
              date_trunc('milliseconds',statement_timestamp()
                +($4::BIGINT*INTERVAL '1 millisecond')),
              preparation.deadline_at-INTERVAL '5 seconds'
            ),state_revision=preparation.state_revision+1
          WHERE preparation.run_id=$1
            AND preparation.state_revision=$5::BIGINT
            AND preparation.lease_expires_at<=statement_timestamp()
            AND preparation.deadline_at>statement_timestamp()+INTERVAL '5 seconds'
          RETURNING ${CLAIM_PROJECTION}`, [
          previous.preparation.runId,
          options.ownerId,
          leaseToken,
          options.leaseMs,
          previous.preparation.stateRevision.toString(),
        ]);
        claim = onlyClaimOr(renewed, 'PREPARATION_LEASE_LOST');
      }
      await client.query('COMMIT');
      committed = true;
      requireActive(signal);
      return claim;
    } catch (error: unknown) {
      if (!committed) await rollback(client);
      throw normalizeError(error, signal);
    } finally {
      client.release(!committed);
    }
  }

  public async selectFirstPair(
    claimValue: ClaimedExecutionPreflightPreparation,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ExecutionPreflightPairSelectionV1 | null> {
    const claim = claimedInput(claimValue);
    requireSignal(signal);
    const client = await this.connect(signal);
    let committed = false;
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT ${CLAIM_PROJECTION},
        trunc(EXTRACT(EPOCH FROM date_trunc('milliseconds',statement_timestamp()))*1000)::TEXT
          AS operation_at_ms
        FROM execution_preflight_intent_preparation_runs AS preparation
        WHERE preparation.run_id=$1 AND preparation.state=$2
          AND preparation.state_revision=$3::BIGINT
          AND preparation.lease_owner=$4 AND preparation.lease_token=$5::UUID
          AND preparation.lease_expires_at=TIMESTAMPTZ 'epoch'
            +($6::BIGINT*INTERVAL '1 millisecond')
          AND preparation.lease_expires_at>statement_timestamp()
          AND preparation.deadline_at>statement_timestamp()+INTERVAL '5 seconds'
        FOR UPDATE`, claimValues(claim));
      if (locked.rowCount !== 1 || locked.rows.length !== 1) {
        throw repositoryError('PREPARATION_LEASE_LOST');
      }
      requireActive(signal);
      if (claim.preparation.state === 'PREPARING') {
        const exact = await this.readSelectedPair(client, claim.preparation.runId);
        await client.query('COMMIT');
        committed = true;
        return exact === null ? failPairConflict() : selection(claim, exact);
      }
      if (claim.preparation.state !== 'WAITING') throw dataError();

      const candidate = await client.query(`SELECT ${PAIR_PROJECTION}
        FROM execution_preflight_intent_preparation_runs AS preparation
        JOIN execution_preflight_intent_pairs AS pair
          ON pair.created_at > preparation.watermark_at
          AND pair.created_at < preparation.deadline_at-INTERVAL '5 seconds'
        WHERE preparation.run_id=$1
        ORDER BY pair.created_at,pair.pair_id
        LIMIT 1
        FOR UPDATE OF pair`, [claim.preparation.runId]);
      if (candidate.rowCount === 0 && candidate.rows.length === 0) {
        await client.query('COMMIT');
        committed = true;
        return null;
      }
      const pair = pairFromResult(candidate);
      const parentLocks = await client.query(`SELECT
          target.id AS target_intent_id,simulation.id AS simulation_intent_id
        FROM execution_preflight_intent_pairs AS pair
        JOIN execution_intents AS target ON target.id=pair.target_intent_id
        JOIN execution_intents AS simulation ON simulation.id=pair.simulation_intent_id
        WHERE pair.pair_id=$1 AND target.id=$2 AND simulation.id=$3
        FOR UPDATE OF target,simulation`, [
        pair.pairId,
        pair.targetIntentId,
        pair.simulationIntentId,
      ]);
      if (parentLocks.rowCount !== 1 || parentLocks.rows.length !== 1) failPairConflict();
      const validated = await client.query(`SELECT ${PAIR_PROJECTION}
        FROM execution_preflight_intent_pairs AS pair
        JOIN execution_intents AS target ON target.id=pair.target_intent_id
        JOIN execution_intents AS simulation ON simulation.id=pair.simulation_intent_id
        JOIN execution_preflight_intent_pair_memberships AS target_member
          ON target_member.pair_id=pair.pair_id
            AND target_member.intent_id=target.id AND target_member.lane='TARGET'
        JOIN execution_preflight_intent_pair_memberships AS simulation_member
          ON simulation_member.pair_id=pair.pair_id
            AND simulation_member.intent_id=simulation.id
            AND simulation_member.lane='SIMULATION'
        WHERE pair.pair_id=$1
          AND pair.expires_at>statement_timestamp()+INTERVAL '5 seconds'
          AND pair.decision_event_id=target.decision_event_id
          AND pair.decision_fingerprint=target.decision_fingerprint
          AND pair.decision_event_id=simulation.decision_event_id
          AND pair.decision_fingerprint=simulation.decision_fingerprint
          AND target.strategy_id=simulation.strategy_id
          AND target.strategy_version=simulation.strategy_version
          AND target.position_id=simulation.position_id AND target.mint=simulation.mint
          AND target.side=simulation.side AND target.venue_policy=simulation.venue_policy
          AND target.quote_mint=simulation.quote_mint
          AND target.quote_token_program=simulation.quote_token_program
          AND target.quote_decimals=simulation.quote_decimals
          AND target.quote_amount_raw IS NOT DISTINCT FROM simulation.quote_amount_raw
          AND target.base_amount_raw IS NOT DISTINCT FROM simulation.base_amount_raw
          AND target.minimum_amount_out_raw=simulation.minimum_amount_out_raw
          AND target.requested_at=simulation.requested_at
          AND target.expires_at=simulation.expires_at
          AND ${pristineIntent('target')}
          AND ${pristineIntent('simulation')}
          AND NOT EXISTS (SELECT 1 FROM execution_dry_run_assessments AS evidence
            WHERE evidence.intent_id IN (target.id,simulation.id))
          AND NOT EXISTS (SELECT 1 FROM execution_attempts AS evidence
            WHERE evidence.intent_id IN (target.id,simulation.id))
          AND NOT EXISTS (SELECT 1 FROM execution_simulation_artifacts AS evidence
            WHERE evidence.intent_id IN (target.id,simulation.id))
        `, [pair.pairId]);
      if (validated.rowCount !== 1 || validated.rows.length !== 1) {
        const failed = await client.query(`UPDATE execution_preflight_intent_preparation_runs
          AS preparation
          SET state='FAILED',state_revision=preparation.state_revision+1,
            failure_code='PREFLIGHT_PAIR_CONFLICT'
          WHERE preparation.run_id=$1 AND preparation.state=$2
            AND preparation.state_revision=$3::BIGINT
            AND preparation.lease_owner=$4 AND preparation.lease_token=$5::UUID
            AND preparation.lease_expires_at=TIMESTAMPTZ 'epoch'
              +($6::BIGINT*INTERVAL '1 millisecond')
          RETURNING preparation.run_id`, claimValues(claim));
        if (failed.rowCount !== 1 || failed.rows.length !== 1) {
          throw repositoryError('PREPARATION_LEASE_LOST');
        }
        await client.query('COMMIT');
        committed = true;
        throw repositoryError('PREFLIGHT_PAIR_CONFLICT');
      }
      const exactPair = pairFromResult(validated);
      if (!sameStoredPair(pair, exactPair)) failPairConflict();
      const updated = await client.query(`UPDATE execution_preflight_intent_preparation_runs
        AS preparation
        SET state='PREPARING',pair_id=$7,state_revision=preparation.state_revision+1
        WHERE preparation.run_id=$1 AND preparation.state=$2
          AND preparation.state_revision=$3::BIGINT
          AND preparation.lease_owner=$4 AND preparation.lease_token=$5::UUID
          AND preparation.lease_expires_at=TIMESTAMPTZ 'epoch'
            +($6::BIGINT*INTERVAL '1 millisecond')
          AND preparation.lease_expires_at>statement_timestamp()
          AND preparation.deadline_at>statement_timestamp()+INTERVAL '5 seconds'
        RETURNING ${CLAIM_PROJECTION}`, [...claimValues(claim), pair.pairId]);
      const updatedClaim = onlyClaimOr(updated, 'PREFLIGHT_PAIR_CONFLICT');
      await client.query('COMMIT');
      committed = true;
      return selection(updatedClaim, pair);
    } catch (error: unknown) {
      if (!committed) await rollback(client);
      throw normalizeError(error, signal);
    } finally {
      client.release(!committed);
    }
  }

  public async expireWaitingWithoutPair(
    claimValue: ClaimedExecutionPreflightPreparation,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ExecutionPreflightPreparationV1 | null> {
    const claim = claimedInput(claimValue);
    if (claim.preparation.state !== 'WAITING' || claim.preparation.pairId !== null) {
      throw inputError();
    }
    requireSignal(signal);
    const client = await this.connect(signal);
    let committed = false;
    try {
      await client.query('BEGIN');
      const locked = await client.query(`WITH operation AS MATERIALIZED (
          SELECT date_trunc('milliseconds',statement_timestamp()) AS at
        )
        SELECT ${CLAIM_PROJECTION},
          trunc(EXTRACT(EPOCH FROM operation.at)*1000)::TEXT AS operation_at_ms
        FROM execution_preflight_intent_preparation_runs AS preparation
        CROSS JOIN operation
        WHERE preparation.run_id=$1 AND preparation.state=$2
          AND preparation.state_revision=$3::BIGINT
          AND preparation.lease_owner=$4 AND preparation.lease_token=$5::UUID
          AND preparation.lease_expires_at=TIMESTAMPTZ 'epoch'
            +($6::BIGINT*INTERVAL '1 millisecond')
          AND preparation.pair_id IS NULL
        FOR UPDATE`, claimValues(claim));
      if (locked.rowCount !== 1 || locked.rows.length !== 1) {
        throw repositoryError('PREPARATION_LEASE_LOST');
      }
      const lockedRow = onlyRow(locked);
      const operationAtMs = timestamp(lockedRow.operation_at_ms);
      const current = claimFromRowWithoutExtra(lockedRow);
      if (current.preparation.runId !== claim.preparation.runId
        || current.preparation.stateRevision !== claim.preparation.stateRevision
        || current.leaseOwner !== claim.leaseOwner
        || current.leaseToken !== claim.leaseToken
        || current.leaseExpiresAtMs !== claim.leaseExpiresAtMs) throw dataError();
      requireActive(signal);
      if (operationAtMs + HANDOFF_RESERVE_MS < current.preparation.deadlineAtMs) {
        await client.query('COMMIT');
        committed = true;
        return null;
      }
      const failed = await client.query(`UPDATE execution_preflight_intent_preparation_runs
        AS preparation
        SET state='FAILED',state_revision=preparation.state_revision+1,
          failure_code='PREFLIGHT_PAIR_NOT_FOUND'
        WHERE preparation.run_id=$1 AND preparation.state=$2
          AND preparation.state_revision=$3::BIGINT
          AND preparation.lease_owner=$4 AND preparation.lease_token=$5::UUID
          AND preparation.lease_expires_at=TIMESTAMPTZ 'epoch'
            +($6::BIGINT*INTERVAL '1 millisecond')
          AND preparation.pair_id IS NULL
          AND preparation.deadline_at<=statement_timestamp()+INTERVAL '5 seconds'
        RETURNING ${PREPARATION_PROJECTION}`, claimValues(claim));
      if (failed.rowCount !== 1 || failed.rows.length !== 1) {
        throw repositoryError('PREPARATION_LEASE_LOST');
      }
      const terminal = preparationFromRow(onlyRow(failed));
      await client.query('COMMIT');
      committed = true;
      requireActive(signal);
      return terminal;
    } catch (error: unknown) {
      if (!committed) await rollback(client);
      throw normalizeError(error, signal);
    } finally {
      client.release(!committed);
    }
  }

  public async bindTargetAssessment(
    claimValue: ClaimedExecutionPreflightPreparation,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ClaimedExecutionPreflightPreparation> {
    const claim = preparingClaimInput(claimValue, 'ASSESSMENT');
    requireSignal(signal);
    const client = await this.connect(signal);
    try {
      const bound = await client.query(BIND_TARGET_ASSESSMENT_SQL, proofClaimValues(claim));
      requireActive(signal);
      return onlyClaimOr(bound, 'PREFLIGHT_ASSESSMENT_INVALID');
    } catch (error: unknown) {
      throw normalizeError(error, signal);
    } finally {
      client.release();
    }
  }

  public async bindSimulationArtifact(
    claimValue: ClaimedExecutionPreflightPreparation,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ClaimedExecutionPreflightPreparation> {
    const claim = preparingClaimInput(claimValue, 'SIMULATION');
    requireSignal(signal);
    const client = await this.connect(signal);
    try {
      const bound = await client.query(BIND_SIMULATION_ARTIFACT_SQL, proofClaimValues(claim));
      requireActive(signal);
      return onlyClaimOr(bound, 'PREFLIGHT_SIMULATION_FAILED');
    } catch (error: unknown) {
      throw normalizeError(error, signal);
    } finally {
      client.release();
    }
  }

  public async markPrepared(
    claimValue: ClaimedExecutionPreflightPreparation,
    optionsValue: ExecutionPreflightMarkPreparedOptions,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ExecutionPreflightPreparationV1> {
    const claim = preparingClaimInput(claimValue, 'MANIFEST');
    const options = markPreparedOptions(optionsValue);
    requireSignal(signal);
    const client = await this.connect(signal);
    try {
      const prepared = await client.query(MARK_PREPARED_SQL, [
        ...proofClaimValues(claim), options.manifestFingerprint,
      ]);
      requireActive(signal);
      if (prepared.rowCount !== 1 || prepared.rows.length !== 1) {
        throw repositoryError('PREFLIGHT_PAIR_LINEAGE_INVALID');
      }
      return preparationFromRow(onlyRow(prepared));
    } catch (error: unknown) {
      throw normalizeError(error, signal);
    } finally {
      client.release();
    }
  }

  public async read(
    runId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ExecutionPreflightPreparationV1 | null> {
    if (!/^execution_preflight_preparation_[0-9a-f]{64}$/u.test(runId)) throw inputError();
    requireSignal(signal);
    const client = await this.connect(signal);
    try {
      const result = await client.query(`SELECT ${PREPARATION_PROJECTION}
        FROM execution_preflight_intent_preparation_runs AS preparation
        WHERE preparation.run_id=$1`, [runId]);
      if (result.rowCount === 0 && result.rows.length === 0) return null;
      return preparationFromRow(onlyRow(result));
    } catch (error: unknown) {
      throw normalizeError(error, signal);
    } finally {
      client.release();
    }
  }

  public async renew(
    claimValue: ClaimedExecutionPreflightPreparation,
    leaseMs: number,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ClaimedExecutionPreflightPreparation> {
    const claim = claimedInput(claimValue);
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 300_000) throw inputError();
    requireSignal(signal);
    const client = await this.connect(signal);
    try {
      const renewed = await client.query(`UPDATE execution_preflight_intent_preparation_runs
        AS preparation
        SET lease_expires_at=LEAST(
          date_trunc('milliseconds',statement_timestamp()
            +($7::BIGINT*INTERVAL '1 millisecond')),
          preparation.deadline_at-INTERVAL '5 seconds'
        ),state_revision=preparation.state_revision+1
        WHERE preparation.run_id=$1 AND preparation.state=$2
          AND preparation.state_revision=$3::BIGINT
          AND preparation.lease_owner=$4 AND preparation.lease_token=$5::UUID
          AND preparation.lease_expires_at=TIMESTAMPTZ 'epoch'
            +($6::BIGINT*INTERVAL '1 millisecond')
          AND preparation.lease_expires_at>statement_timestamp()
          AND preparation.deadline_at>statement_timestamp()+INTERVAL '5 seconds'
        RETURNING ${CLAIM_PROJECTION}`, [...claimValues(claim), leaseMs]);
      requireActive(signal);
      return onlyClaimOr(renewed, 'PREPARATION_LEASE_LOST');
    } catch (error: unknown) {
      throw normalizeError(error, signal);
    } finally {
      client.release();
    }
  }

  public async fail(
    claimValue: ClaimedExecutionPreflightPreparation,
    codeValue: ExecutionPreflightPreparationErrorCode,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ExecutionPreflightPreparationV1> {
    const claim = claimedInput(claimValue);
    const code = failureCodeInput(codeValue);
    requireSignal(signal);
    const client = await this.connect(signal);
    try {
      const failed = await client.query(`UPDATE execution_preflight_intent_preparation_runs
        AS preparation
        SET state='FAILED',state_revision=preparation.state_revision+1,failure_code=$7
        WHERE preparation.run_id=$1 AND preparation.state=$2
          AND preparation.state_revision=$3::BIGINT
          AND preparation.lease_owner=$4 AND preparation.lease_token=$5::UUID
          AND preparation.lease_expires_at=TIMESTAMPTZ 'epoch'
            +($6::BIGINT*INTERVAL '1 millisecond')
          AND preparation.lease_expires_at>statement_timestamp()
        RETURNING ${PREPARATION_PROJECTION}`, [...claimValues(claim), code]);
      requireActive(signal);
      if (failed.rowCount !== 1 || failed.rows.length !== 1) {
        throw repositoryError('PREPARATION_LEASE_LOST');
      }
      return preparationFromRow(onlyRow(failed));
    } catch (error: unknown) {
      throw normalizeError(error, signal);
    } finally {
      client.release();
    }
  }

  private async readSelectedPair(
    client: ExecutionPreflightPreparationClient,
    runId: string,
  ): Promise<StoredPair | null> {
    const result = await client.query(`SELECT ${PAIR_PROJECTION}
      FROM execution_preflight_intent_preparation_runs AS preparation
      JOIN execution_preflight_intent_pairs AS pair ON pair.pair_id=preparation.pair_id
      WHERE preparation.run_id=$1`, [runId]);
    if (result.rowCount === 0 && result.rows.length === 0) return null;
    return pairFromResult(result);
  }

  private async connect(signal: AbortSignal): Promise<ExecutionPreflightPreparationClient> {
    requireActive(signal);
    try {
      return await this.pool.connect();
    } catch (error: unknown) {
      throw new ExecutionPreflightPreparationRepositoryError('DATABASE_FAILURE', { cause: error });
    }
  }
}

interface StoredPair {
  readonly pairId: string;
  readonly pairFingerprint: string;
  readonly targetIntentId: string;
  readonly simulationIntentId: string;
  readonly decisionEventId: string;
  readonly decisionFingerprint: string;
  readonly pairCreatedAtMs: number;
  readonly pairExpiresAtMs: number;
}

function startOptions(value: unknown): ExecutionPreflightPreparationStartOptions {
  const row = exactFrozenRecord(value, START_KEYS);
  const ownerId = row.ownerId;
  const selectionWindowMs = row.selectionWindowMs;
  const leaseMs = row.leaseMs;
  if (typeof ownerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(ownerId)
    || !Number.isSafeInteger(selectionWindowMs) || (selectionWindowMs as number) <= 10_000
    || (selectionWindowMs as number) > 300_000
    || !Number.isSafeInteger(leaseMs) || (leaseMs as number) <= 0
    || (leaseMs as number) > (selectionWindowMs as number) - HANDOFF_RESERVE_MS) {
    throw inputError();
  }
  return Object.freeze({
    ownerId,
    selectionWindowMs: selectionWindowMs as number,
    leaseMs: leaseMs as number,
  });
}

function markPreparedOptions(value: unknown): ExecutionPreflightMarkPreparedOptions {
  const row = exactFrozenRecord(value, MARK_PREPARED_KEYS);
  if (typeof row.manifestFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/u.test(row.manifestFingerprint)) throw inputError();
  return Object.freeze({ manifestFingerprint: row.manifestFingerprint });
}

function claimedInput(value: unknown): ClaimedExecutionPreflightPreparation {
  const row = exactFrozenRecord(value, CLAIM_KEYS);
  const preparationRow = exactFrozenRecord(row.preparation, PREPARATION_KEYS);
  const preparation = preparationFromDomain(preparationRow);
  if (typeof row.leaseOwner !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(row.leaseOwner)
    || typeof row.leaseToken !== 'string' || !UUID_V4.test(row.leaseToken)
    || !validTimestamp(row.leaseExpiresAtMs)
    || row.leaseExpiresAtMs <= preparation.watermarkAtMs
    || preparation.state !== 'WAITING' && preparation.state !== 'PREPARING') throw inputError();
  return Object.freeze({
    preparation,
    leaseOwner: row.leaseOwner,
    leaseToken: row.leaseToken,
    leaseExpiresAtMs: row.leaseExpiresAtMs,
  });
}

function preparingClaimInput(
  value: unknown,
  phase: 'ASSESSMENT' | 'SIMULATION' | 'MANIFEST',
): ClaimedExecutionPreflightPreparation {
  const claim = claimedInput(value);
  const preparation = claim.preparation;
  const hasAssessment = preparation.assessmentId !== null
    && preparation.assessmentFingerprint !== null;
  const hasArtifact = preparation.artifactId !== null
    && preparation.artifactFingerprint !== null;
  if (preparation.state !== 'PREPARING' || preparation.pairId === null
    || preparation.manifestFingerprint !== null
    || (phase !== 'ASSESSMENT' && !hasAssessment)
    || (phase === 'MANIFEST' && !hasArtifact)) throw inputError();
  return claim;
}

function preparationFromDomain(row: Row): ExecutionPreflightPreparationV1 {
  const converted: Row = {
    run_id: row.runId,
    payload_version: row.payloadVersion,
    run_fingerprint: row.runFingerprint,
    state: row.state,
    state_revision: typeof row.stateRevision === 'bigint' ? row.stateRevision.toString() : row.stateRevision,
    watermark_at_ms: row.watermarkAtMs,
    deadline_at_ms: row.deadlineAtMs,
    pair_id: row.pairId,
    assessment_id: row.assessmentId,
    assessment_fingerprint: row.assessmentFingerprint,
    artifact_id: row.artifactId,
    artifact_fingerprint: row.artifactFingerprint,
    manifest_fingerprint: row.manifestFingerprint,
    failure_code: row.failureCode,
    created_at_ms: row.createdAtMs,
    updated_at_ms: row.updatedAtMs,
    selected_at_ms: row.selectedAtMs,
    completed_at_ms: row.completedAtMs,
    purge_after_ms: row.purgeAfterMs,
  };
  return preparationFromRow(converted);
}

function preparationFromRow(value: unknown): ExecutionPreflightPreparationV1 {
  const row = exactRecord(value, PREPARATION_ROW_KEYS);
  const state = preparationState(row.state);
  const result: ExecutionPreflightPreparationV1 = Object.freeze({
    payloadVersion: exactOne(row.payload_version),
    runId: text(row.run_id, /^execution_preflight_preparation_[0-9a-f]{64}$/u),
    runFingerprint: text(row.run_fingerprint, /^[0-9a-f]{64}$/u),
    state,
    stateRevision: unsignedInt64(row.state_revision),
    watermarkAtMs: timestamp(row.watermark_at_ms),
    deadlineAtMs: timestamp(row.deadline_at_ms),
    pairId: nullableText(row.pair_id),
    assessmentId: nullableText(row.assessment_id),
    assessmentFingerprint: nullableFingerprint(row.assessment_fingerprint),
    artifactId: nullableText(row.artifact_id),
    artifactFingerprint: nullableFingerprint(row.artifact_fingerprint),
    manifestFingerprint: nullableFingerprint(row.manifest_fingerprint),
    failureCode: nullableFailureCode(row.failure_code),
    createdAtMs: timestamp(row.created_at_ms),
    updatedAtMs: timestamp(row.updated_at_ms),
    selectedAtMs: nullableTimestamp(row.selected_at_ms),
    completedAtMs: nullableTimestamp(row.completed_at_ms),
    purgeAfterMs: nullableTimestamp(row.purge_after_ms),
  });
  if (result.watermarkAtMs !== result.createdAtMs
    || result.updatedAtMs < result.createdAtMs
    || result.deadlineAtMs <= result.watermarkAtMs + HANDOFF_RESERVE_MS) throw dataError();
  return result;
}

function claimFromRowWithoutExtra(value: Row): ClaimedExecutionPreflightPreparation {
  const preparationValues: Record<string, unknown> = {};
  for (const key of PREPARATION_ROW_KEYS) preparationValues[key] = value[key];
  const preparation = preparationFromRow(preparationValues);
  const leaseOwner = text(value.lease_owner, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
  const leaseToken = text(value.lease_token, UUID_V4);
  const leaseExpiresAtMs = timestamp(value.lease_expires_at_ms);
  return Object.freeze({ preparation, leaseOwner, leaseToken, leaseExpiresAtMs });
}

function onlyClaim(result: QueryResult): ClaimedExecutionPreflightPreparation {
  return onlyClaimOr(result, 'INVALID_DATA');
}

function onlyClaimOr(
  result: QueryResult,
  code: 'INVALID_DATA' | 'PREPARATION_LEASE_LOST' | 'PREFLIGHT_PAIR_CONFLICT'
    | 'PREFLIGHT_ASSESSMENT_INVALID' | 'PREFLIGHT_SIMULATION_FAILED',
): ClaimedExecutionPreflightPreparation {
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    throw code === 'INVALID_DATA' ? dataError() : repositoryError(code);
  }
  const row = exactRecord(result.rows[0], CLAIM_ROW_KEYS);
  return claimFromRowWithoutExtra(row);
}

function pairFromResult(result: QueryResult): StoredPair {
  if (result.rowCount !== 1 || result.rows.length !== 1) throw dataError();
  const row = exactRecord(result.rows[0], PAIR_ROW_KEYS);
  const pair: StoredPair = Object.freeze({
    pairId: text(row.pair_id),
    pairFingerprint: text(row.pair_fingerprint, /^[0-9a-f]{64}$/u),
    targetIntentId: text(row.target_intent_id),
    simulationIntentId: text(row.simulation_intent_id),
    decisionEventId: text(row.decision_event_id),
    decisionFingerprint: text(row.decision_fingerprint, /^[0-9a-f]{64}$/u),
    pairCreatedAtMs: timestamp(row.pair_created_at_ms),
    pairExpiresAtMs: timestamp(row.pair_expires_at_ms),
  });
  if (pair.targetIntentId === pair.simulationIntentId) throw dataError();
  return pair;
}

function selection(
  preparation: ClaimedExecutionPreflightPreparation,
  pair: StoredPair,
): ExecutionPreflightPairSelectionV1 {
  if (preparation.preparation.pairId !== pair.pairId) throw dataError();
  return Object.freeze({ preparation, ...pair });
}

function sameStoredPair(left: StoredPair, right: StoredPair): boolean {
  return left.pairId === right.pairId
    && left.pairFingerprint === right.pairFingerprint
    && left.targetIntentId === right.targetIntentId
    && left.simulationIntentId === right.simulationIntentId
    && left.decisionEventId === right.decisionEventId
    && left.decisionFingerprint === right.decisionFingerprint
    && left.pairCreatedAtMs === right.pairCreatedAtMs
    && left.pairExpiresAtMs === right.pairExpiresAtMs;
}

function pristineIntent(alias: 'target' | 'simulation'): string {
  return `${alias}.status='PENDING'
          AND ${alias}.attempt_count=0 AND ${alias}.state_revision=0
          AND ${alias}.lease_owner IS NULL AND ${alias}.lease_token IS NULL
          AND ${alias}.lease_expires_at IS NULL AND ${alias}.last_reason_code IS NULL
          AND ${alias}.terminal_at IS NULL AND ${alias}.reconciliation_completed_at IS NULL
          AND ${alias}.purge_after IS NULL AND ${alias}.live_reserved=FALSE`;
}

function claimValues(claim: ClaimedExecutionPreflightPreparation): readonly unknown[] {
  return [
    claim.preparation.runId,
    claim.preparation.state,
    claim.preparation.stateRevision.toString(),
    claim.leaseOwner,
    claim.leaseToken,
    claim.leaseExpiresAtMs,
  ];
}

function proofClaimValues(claim: ClaimedExecutionPreflightPreparation): readonly unknown[] {
  return [
    claim.preparation.runId,
    claim.preparation.stateRevision.toString(),
    claim.leaseOwner,
    claim.leaseToken,
    claim.leaseExpiresAtMs,
  ];
}

function exactFrozenRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (typeof value !== 'object' || value === null || isProxy(value) || !Object.isFrozen(value)) {
    throw inputError();
  }
  return exactRecord(value, keys, 'INVALID_INPUT');
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
  errorCode: 'INVALID_INPUT' | 'INVALID_DATA' = 'INVALID_DATA',
): Readonly<Record<Keys[number], unknown>> {
  if (typeof value !== 'object' || value === null || isProxy(value)) throw errorFor(errorCode);
  const prototype = Object.getPrototypeOf(value) as object | null;
  const ownKeys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw errorFor(errorCode);
  }
  const row = value as Readonly<Record<string, unknown>>;
  return row;
}

function onlyRow(result: QueryResult): Row {
  if (result.rowCount !== 1 || result.rows.length !== 1 || result.rows[0] === undefined) {
    throw dataError();
  }
  return result.rows[0];
}

function preparationState(value: unknown): ExecutionPreflightPreparationState {
  if (value === 'WAITING' || value === 'PREPARING' || value === 'PREPARED' || value === 'FAILED') {
    return value;
  }
  throw dataError();
}

function nullableFailureCode(value: unknown): ExecutionPreflightPreparationErrorCode | null {
  if (value === null) return null;
  const allowed: readonly ExecutionPreflightPreparationErrorCode[] = [
    'PREFLIGHT_PAIR_NOT_FOUND', 'PREFLIGHT_PAIR_CONFLICT',
    'PREFLIGHT_PAIR_LINEAGE_INVALID', 'PREFLIGHT_TARGET_NOT_PRISTINE',
    'PREFLIGHT_PROBE_NOT_PRISTINE', 'PREFLIGHT_TARGET_FENCE_LOST',
    'PREFLIGHT_PREPARATION_LEASE_LOST',
    'PREFLIGHT_PREPARATION_DEADLINE_EXCEEDED', 'PREFLIGHT_RPC_CAPACITY_UNVERIFIED',
    'PREFLIGHT_ASSESSMENT_INVALID', 'PREFLIGHT_SIMULATION_FAILED',
    'PREFLIGHT_RECOVERY_CONFLICT',
    'PREFLIGHT_PREPARATION_EXPORT_FAILED',
  ];
  if (typeof value !== 'string' || !allowed.includes(value as ExecutionPreflightPreparationErrorCode)) {
    throw dataError();
  }
  return value as ExecutionPreflightPreparationErrorCode;
}

function failureCodeInput(value: unknown): ExecutionPreflightPreparationErrorCode {
  const parsed = nullableFailureCode(value);
  if (parsed === null) throw inputError();
  return parsed;
}

function unsignedInt64(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) throw dataError();
  const parsed = BigInt(value);
  if (parsed > INT64_MAX) throw dataError();
  return parsed;
}

function timestamp(value: unknown): number {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : NaN;
  if (!validTimestamp(parsed)) throw dataError();
  return parsed;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= DATE_MAX_MS;
}

function nullableTimestamp(value: unknown): number | null {
  return value === null ? null : timestamp(value);
}

function exactOne(value: unknown): 1 {
  if (value !== 1) throw dataError();
  return 1;
}

function text(value: unknown, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512
    || (pattern !== undefined && !pattern.test(value))) throw dataError();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function nullableFingerprint(value: unknown): string | null {
  return value === null ? null : text(value, /^[0-9a-f]{64}$/u);
}

function validUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw inputError();
  return value;
}

function requireSignal(signal: unknown): asserts signal is AbortSignal {
  if (!(signal instanceof AbortSignal)) throw inputError();
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw repositoryError('OPERATION_ABORTED');
}

async function rollback(client: ExecutionPreflightPreparationClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve primary failure */ }
}

function normalizeError(error: unknown, signal: AbortSignal): ExecutionPreflightPreparationRepositoryError {
  if (error instanceof ExecutionPreflightPreparationRepositoryError) return error;
  if (signal.aborted) return repositoryError('OPERATION_ABORTED');
  return new ExecutionPreflightPreparationRepositoryError('DATABASE_FAILURE', { cause: error });
}

function failPairConflict(): never {
  throw repositoryError('PREFLIGHT_PAIR_CONFLICT');
}

function inputError(): ExecutionPreflightPreparationRepositoryError {
  return repositoryError('INVALID_INPUT');
}

function dataError(): ExecutionPreflightPreparationRepositoryError {
  return repositoryError('INVALID_DATA');
}

function errorFor(code: 'INVALID_INPUT' | 'INVALID_DATA'): ExecutionPreflightPreparationRepositoryError {
  return code === 'INVALID_INPUT' ? inputError() : dataError();
}

function repositoryError(
  code: ExecutionPreflightPreparationRepositoryErrorCode,
): ExecutionPreflightPreparationRepositoryError {
  return new ExecutionPreflightPreparationRepositoryError(code);
}

import { isProxy } from 'node:util/types';
import {
  assertExecutionDryRunAssessment,
  assertExecutionDryRunAssessmentDraft,
  createExecutionDryRunAssessment,
  type ExecutionDryRunAssessmentDraftV1,
  type ExecutionDryRunAssessmentV1,
} from '../domain/execution-dry-run.js';
import { assertExecutionIntent } from '../domain/execution-intent.js';
import type { ExecutionDryRunRepository } from '../ports/execution-dry-run-repository.js';
import type { ClaimedExecutionIntent } from '../ports/execution-intent-repository.js';
import { getDatabasePool } from './database.js';

type Row = Readonly<Record<string, unknown>>;

interface QueryResult {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

interface ExecutionDryRunClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(error?: boolean): void;
}

export interface ExecutionDryRunPool {
  connect(): Promise<ExecutionDryRunClient>;
}

export type ExecutionDryRunRepositoryErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_DATA'
  | 'DATABASE_FAILURE'
  | 'COMMIT_OUTCOME_UNKNOWN'
  | 'INTENT_FENCE_LOST'
  | 'ASSESSMENT_CONFLICT'
  | 'OPERATION_ABORTED';

export class ExecutionDryRunRepositoryError extends Error {
  public constructor(public readonly code: ExecutionDryRunRepositoryErrorCode) {
    super('Execution dry-run repository operation failed.');
    this.name = 'ExecutionDryRunRepositoryError';
  }
}

const DATE_MAX_MS = 8_640_000_000_000_000;
const INT64_MAX = 9_223_372_036_854_775_807n;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INTERNAL_ERRORS = new WeakSet<ExecutionDryRunRepositoryError>();

const CLAIM_KEYS = Object.freeze([
  'intent', 'leaseOwner', 'leaseToken', 'leaseExpiresAtMs',
] as const);
const DRAFT_KEYS = Object.freeze([
  'assessmentId', 'payloadVersion', 'specificationVersion', 'evaluatorVersion', 'intentId',
  'strategyId', 'strategyVersion', 'decisionFingerprint', 'intentStateRevision', 'intentStatus',
  'inputFingerprint', 'resultFingerprint', 'outcome', 'coverage', 'quoteStatus', 'buildStatus',
  'simulationStatus', 'signatureStatus', 'submissionStatus',
] as const);
const ASSESSMENT_ROW_KEYS = Object.freeze([
  'assessment_id', 'payload_version', 'specification_version', 'evaluator_version', 'intent_id',
  'strategy_id', 'strategy_version', 'decision_fingerprint', 'intent_state_revision',
  'intent_status', 'input_fingerprint', 'result_fingerprint', 'outcome', 'coverage',
  'quote_status', 'build_status', 'simulation_status', 'signature_status', 'submission_status',
  'recorded_at_ms',
] as const);
const COMPLETE_ROW_KEYS = Object.freeze([
  ...ASSESSMENT_ROW_KEYS, 'locked_count', 'inserted_count', 'released_count',
] as const);

const ASSESSMENT_PROJECTION = `
  assessment.assessment_id,
  assessment.payload_version,
  assessment.specification_version,
  assessment.evaluator_version,
  assessment.intent_id,
  assessment.strategy_id,
  assessment.strategy_version,
  assessment.decision_fingerprint,
  assessment.intent_state_revision::TEXT AS intent_state_revision,
  assessment.intent_status,
  assessment.input_fingerprint,
  assessment.result_fingerprint,
  assessment.outcome,
  assessment.coverage,
  assessment.quote_status,
  assessment.build_status,
  assessment.simulation_status,
  assessment.signature_status,
  assessment.submission_status,
  trunc(EXTRACT(EPOCH FROM assessment.recorded_at) * 1000)::TEXT AS recorded_at_ms`;

const COMPLETE_SQL = `WITH operation AS MATERIALIZED (
  SELECT date_trunc('milliseconds', statement_timestamp()) AS at
), locked AS MATERIALIZED (
  SELECT intent.id, EXISTS (
    SELECT 1 FROM execution_dry_run_assessments AS existing
    WHERE existing.assessment_id=$28
       OR (existing.intent_id=$1 AND existing.evaluator_version=$31)
  ) AS assessment_conflict
  FROM execution_intents AS intent CROSS JOIN operation
  WHERE intent.id=$1
    AND intent.status=$2
    AND intent.lease_owner=$3
    AND intent.lease_token=$4::UUID
    AND intent.lease_expires_at=TIMESTAMPTZ 'epoch'
      + ($5::BIGINT * INTERVAL '1 millisecond')
    AND intent.lease_expires_at > operation.at
    AND intent.expires_at > operation.at
    AND intent.state_revision=$6::BIGINT
    AND intent.payload_version=$7
    AND intent.logical_order_key=$8
    AND intent.strategy_id=$9
    AND intent.strategy_version=$10
    AND intent.position_id=$11
    AND intent.logical_command_id=$12
    AND intent.mint=$13
    AND intent.side=$14
    AND intent.venue_policy=$15
    AND intent.quote_mint=$16
    AND intent.quote_token_program=$17
    AND intent.quote_decimals=$18
    AND intent.quote_amount_raw IS NOT DISTINCT FROM $19::NUMERIC
    AND intent.base_amount_raw IS NOT DISTINCT FROM $20::NUMERIC
    AND intent.minimum_amount_out_raw=$21::NUMERIC
    AND intent.decision_event_id=$22
    AND intent.decision_fingerprint=$23
    AND intent.requested_at=TIMESTAMPTZ 'epoch'
      + ($24::BIGINT * INTERVAL '1 millisecond')
    AND intent.expires_at=TIMESTAMPTZ 'epoch'
      + ($25::BIGINT * INTERVAL '1 millisecond')
    AND intent.attempt_count=$26
    AND intent.last_reason_code IS NOT DISTINCT FROM $27::TEXT
  FOR UPDATE OF intent
), inserted AS MATERIALIZED (
  INSERT INTO execution_dry_run_assessments AS assessment (
    assessment_id,payload_version,specification_version,evaluator_version,intent_id,
    strategy_id,strategy_version,decision_fingerprint,intent_state_revision,intent_status,
    input_fingerprint,result_fingerprint,outcome,coverage,quote_status,build_status,
    simulation_status,signature_status,submission_status,recorded_at
  )
  SELECT $28,$29,$30,$31,$32,$33,$34,$35,$36::BIGINT,$37,$38,$39,$40,$41,$42,
    $43,$44,$45,$46,operation.at
  FROM locked CROSS JOIN operation
  WHERE NOT locked.assessment_conflict
  RETURNING assessment.*
), released AS MATERIALIZED (
  UPDATE execution_intents AS intent
  SET lease_owner=NULL,
      lease_token=NULL,
      lease_expires_at=NULL
  FROM locked CROSS JOIN inserted CROSS JOIN operation
  WHERE intent.id=locked.id
    AND inserted.intent_id=intent.id
    AND intent.id=$1
    AND intent.status=$2
    AND intent.lease_owner=$3
    AND intent.lease_token=$4::UUID
    AND intent.lease_expires_at=TIMESTAMPTZ 'epoch'
      + ($5::BIGINT * INTERVAL '1 millisecond')
    AND intent.lease_expires_at > operation.at
    AND intent.expires_at > operation.at
    AND intent.state_revision=$6::BIGINT
  RETURNING intent.id
)
SELECT
  (SELECT assessment_id FROM inserted) AS assessment_id,
  (SELECT payload_version FROM inserted) AS payload_version,
  (SELECT specification_version FROM inserted) AS specification_version,
  (SELECT evaluator_version FROM inserted) AS evaluator_version,
  (SELECT intent_id FROM inserted) AS intent_id,
  (SELECT strategy_id FROM inserted) AS strategy_id,
  (SELECT strategy_version FROM inserted) AS strategy_version,
  (SELECT decision_fingerprint FROM inserted) AS decision_fingerprint,
  (SELECT intent_state_revision::TEXT FROM inserted) AS intent_state_revision,
  (SELECT intent_status FROM inserted) AS intent_status,
  (SELECT input_fingerprint FROM inserted) AS input_fingerprint,
  (SELECT result_fingerprint FROM inserted) AS result_fingerprint,
  (SELECT outcome FROM inserted) AS outcome,
  (SELECT coverage FROM inserted) AS coverage,
  (SELECT quote_status FROM inserted) AS quote_status,
  (SELECT build_status FROM inserted) AS build_status,
  (SELECT simulation_status FROM inserted) AS simulation_status,
  (SELECT signature_status FROM inserted) AS signature_status,
  (SELECT submission_status FROM inserted) AS submission_status,
  (SELECT trunc(EXTRACT(EPOCH FROM recorded_at) * 1000)::TEXT FROM inserted) AS recorded_at_ms,
  (SELECT COUNT(*)::INTEGER FROM locked) AS locked_count,
  (SELECT COUNT(*)::INTEGER FROM inserted) AS inserted_count,
  (SELECT COUNT(*)::INTEGER FROM released) AS released_count`;

const FIND_EXACT_SQL = `SELECT ${ASSESSMENT_PROJECTION}
FROM execution_dry_run_assessments AS assessment
WHERE assessment.assessment_id=$1
  OR (assessment.intent_id=$2 AND assessment.evaluator_version=$3)`;

export class PostgresExecutionDryRunRepository implements ExecutionDryRunRepository {
  public constructor(private readonly pool: ExecutionDryRunPool = getDatabasePool()) {}

  public async complete(
    claimValue: ClaimedExecutionIntent,
    assessmentValue: ExecutionDryRunAssessmentDraftV1,
    signal: AbortSignal,
  ): Promise<ExecutionDryRunAssessmentV1> {
    let inputs: Readonly<{
      readonly claim: ClaimedExecutionIntent;
      readonly assessment: ExecutionDryRunAssessmentDraftV1;
    }>;
    try {
      const claim = claimInput(claimValue);
      const assessment = assessmentInput(assessmentValue);
      if (!sameAssessment(assessment, createExecutionDryRunAssessment(claim.intent))) {
        throw inputError();
      }
      inputs = Object.freeze({ claim, assessment });
    } catch (error) {
      if (isInternalError(error)) throw error;
      throw inputError();
    }

    if (cancellationRequested(signal)) throw repositoryError('OPERATION_ABORTED');

    let client: ExecutionDryRunClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw repositoryError('DATABASE_FAILURE');
    }
    if (cancellationRequested(signal)) abortBeforeQuery(client);
    let result: ExecutionDryRunAssessmentV1 | undefined;
    let primaryFailure: unknown;
    let completed = false;
    try {
      const queryResult = await client.query(COMPLETE_SQL, completeValues(inputs.claim, inputs.assessment));
      result = completeResult(queryResult, inputs.assessment);
      completed = true;
    } catch (error) {
      primaryFailure = error;
    }
    let releaseFailed = false;
    try {
      if (completed) client.release();
      else client.release(true);
    } catch {
      releaseFailed = true;
      if (completed) {
        try { client.release(true); } catch { /* The fixed error below remains authoritative. */ }
      }
    }
    if (completed && !releaseFailed) {
      if (result === undefined) throw dataError();
      return result;
    }
    if (!releaseFailed && isKnownCompleteOutcomeError(primaryFailure)) throw primaryFailure;
    throw repositoryError('COMMIT_OUTCOME_UNKNOWN');
  }

  public async findExact(
    assessmentValue: ExecutionDryRunAssessmentDraftV1,
    signal: AbortSignal,
  ): Promise<ExecutionDryRunAssessmentV1 | null> {
    let assessment: ExecutionDryRunAssessmentDraftV1;
    try {
      assessment = assessmentInput(assessmentValue);
    } catch (error) {
      if (isInternalError(error)) throw error;
      throw inputError();
    }
    if (cancellationRequested(signal)) throw repositoryError('OPERATION_ABORTED');
    let client: ExecutionDryRunClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw repositoryError('DATABASE_FAILURE');
    }
    if (cancellationRequested(signal)) abortBeforeQuery(client);
    let result: ExecutionDryRunAssessmentV1 | null | undefined;
    let primaryFailure: unknown;
    let completed = false;
    try {
      const queryResult = await client.query(FIND_EXACT_SQL, [
        assessment.assessmentId, assessment.intentId, assessment.evaluatorVersion,
      ]);
      result = findResult(queryResult, assessment);
      completed = true;
    } catch (error) {
      primaryFailure = error;
    }
    let releaseFailed = false;
    try {
      if (completed) client.release();
      else client.release(true);
    } catch {
      releaseFailed = true;
      if (completed) {
        try { client.release(true); } catch { /* The fixed error below remains authoritative. */ }
      }
    }
    if (completed && !releaseFailed) return result as ExecutionDryRunAssessmentV1 | null;
    if (!releaseFailed && isInternalError(primaryFailure)) throw primaryFailure;
    throw repositoryError('DATABASE_FAILURE');
  }
}

function completeValues(
  claim: ClaimedExecutionIntent,
  assessment: ExecutionDryRunAssessmentDraftV1,
): readonly unknown[] {
  const intent = claim.intent;
  return [
    intent.id, intent.status, claim.leaseOwner, claim.leaseToken,
    claim.leaseExpiresAtMs.toString(), intent.stateRevision.toString(), intent.payloadVersion,
    intent.logicalOrderKey, intent.strategyId, intent.strategyVersion, intent.positionId,
    intent.logicalCommandId, intent.mint, intent.side, intent.venuePolicy, intent.quoteMint,
    intent.quoteTokenProgram, intent.quoteDecimals, intent.quoteAmountRaw?.toString() ?? null,
    intent.baseAmountRaw?.toString() ?? null, intent.minimumAmountOutRaw.toString(),
    intent.decisionEventId, intent.decisionFingerprint, intent.requestedAtMs.toString(),
    intent.expiresAtMs.toString(), intent.attemptCount, intent.lastReasonCode,
    assessment.assessmentId, assessment.payloadVersion, assessment.specificationVersion,
    assessment.evaluatorVersion, assessment.intentId, assessment.strategyId,
    assessment.strategyVersion, assessment.decisionFingerprint,
    assessment.intentStateRevision.toString(), assessment.intentStatus,
    assessment.inputFingerprint, assessment.resultFingerprint, assessment.outcome,
    assessment.coverage, assessment.quoteStatus, assessment.buildStatus,
    assessment.simulationStatus, assessment.signatureStatus, assessment.submissionStatus,
  ];
}

function completeResult(
  result: QueryResult,
  expected: ExecutionDryRunAssessmentDraftV1,
): ExecutionDryRunAssessmentV1 {
  if (result.rowCount !== 1 || result.rows.length !== 1) throw dataError();
  const row = exactRecord(requiredRow(result.rows), COMPLETE_ROW_KEYS, 'INVALID_DATA', false);
  const lockedCount = cardinality(row.locked_count);
  const insertedCount = cardinality(row.inserted_count);
  const releasedCount = cardinality(row.released_count);
  if (lockedCount === 0) throw repositoryError('INTENT_FENCE_LOST');
  if (lockedCount !== 1) throw dataError();
  if (insertedCount === 0) throw repositoryError('ASSESSMENT_CONFLICT');
  if (insertedCount !== 1) throw dataError();
  if (releasedCount === 0) throw repositoryError('INTENT_FENCE_LOST');
  if (releasedCount !== 1) throw dataError();
  const assessmentRow: Record<string, unknown> = {};
  for (const key of ASSESSMENT_ROW_KEYS) assessmentRow[key] = row[key];
  return decodeExactAssessment(assessmentRow, expected);
}

function findResult(
  result: QueryResult,
  expected: ExecutionDryRunAssessmentDraftV1,
): ExecutionDryRunAssessmentV1 | null {
  if (result.rowCount === 0 && result.rows.length === 0) return null;
  if (result.rowCount !== 1 || result.rows.length !== 1) throw dataError();
  return decodeExactAssessment(requiredRow(result.rows), expected);
}

function decodeExactAssessment(
  value: unknown,
  expected: ExecutionDryRunAssessmentDraftV1,
): ExecutionDryRunAssessmentV1 {
  const row = exactRecord(value, ASSESSMENT_ROW_KEYS, 'INVALID_DATA', false);
  const candidate: unknown = Object.freeze({
    assessmentId: row.assessment_id,
    payloadVersion: row.payload_version,
    specificationVersion: row.specification_version,
    evaluatorVersion: row.evaluator_version,
    intentId: row.intent_id,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    decisionFingerprint: row.decision_fingerprint,
    intentStateRevision: stateRevisionFromDatabase(row.intent_state_revision),
    intentStatus: row.intent_status,
    inputFingerprint: row.input_fingerprint,
    resultFingerprint: row.result_fingerprint,
    outcome: row.outcome,
    coverage: row.coverage,
    quoteStatus: row.quote_status,
    buildStatus: row.build_status,
    simulationStatus: row.simulation_status,
    signatureStatus: row.signature_status,
    submissionStatus: row.submission_status,
    recordedAtMs: timestampFromDatabase(row.recorded_at_ms),
  });
  try {
    assertExecutionDryRunAssessment(candidate);
  } catch {
    throw dataError();
  }
  if (!sameAssessment(candidate, expected)) throw dataError();
  return candidate;
}

function claimInput(value: unknown): ClaimedExecutionIntent {
  const row = exactRecord(value, CLAIM_KEYS, 'INVALID_INPUT', true);
  try {
    assertExecutionIntent(row.intent);
  } catch {
    throw inputError();
  }
  const intent = row.intent;
  if (intent.status !== 'PENDING' && intent.status !== 'RETRY_READY') throw inputError();
  const leaseOwner = boundedText(row.leaseOwner);
  const leaseToken = uuid(row.leaseToken);
  const leaseExpiresAtMs = timestamp(row.leaseExpiresAtMs, 'INVALID_INPUT');
  return Object.freeze({ intent, leaseOwner, leaseToken, leaseExpiresAtMs });
}

function assessmentInput(value: unknown): ExecutionDryRunAssessmentDraftV1 {
  try {
    assertExecutionDryRunAssessmentDraft(value);
  } catch {
    throw inputError();
  }
  const row = exactRecord(value, DRAFT_KEYS, 'INVALID_INPUT', true);
  return Object.freeze({
    assessmentId: row.assessmentId,
    payloadVersion: row.payloadVersion,
    specificationVersion: row.specificationVersion,
    evaluatorVersion: row.evaluatorVersion,
    intentId: row.intentId,
    strategyId: row.strategyId,
    strategyVersion: row.strategyVersion,
    decisionFingerprint: row.decisionFingerprint,
    intentStateRevision: row.intentStateRevision,
    intentStatus: row.intentStatus,
    inputFingerprint: row.inputFingerprint,
    resultFingerprint: row.resultFingerprint,
    outcome: row.outcome,
    coverage: row.coverage,
    quoteStatus: row.quoteStatus,
    buildStatus: row.buildStatus,
    simulationStatus: row.simulationStatus,
    signatureStatus: row.signatureStatus,
    submissionStatus: row.submissionStatus,
  }) as ExecutionDryRunAssessmentDraftV1;
}

function sameAssessment(
  actual: ExecutionDryRunAssessmentDraftV1,
  expected: ExecutionDryRunAssessmentDraftV1,
): boolean {
  return DRAFT_KEYS.every((key) => actual[key] === expected[key]);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: 'INVALID_INPUT' | 'INVALID_DATA',
  requireFrozen: boolean,
): Row {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      throw new Error();
    }
    if (requireFrozen && !Object.isFrozen(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length) throw new Error();
    const record: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      if (!keys.includes(key)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error();
      }
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    throw repositoryError(code);
  }
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 256) {
    throw inputError();
  }
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw inputError();
  return value;
}

function cardinality(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 2) throw dataError();
  return value as number;
}

function stateRevisionFromDatabase(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(value)) throw dataError();
  const revision = BigInt(value);
  if (revision > INT64_MAX) throw dataError();
  return revision;
}

function timestampFromDatabase(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/u.test(value)) throw dataError();
  return timestamp(Number(value), 'INVALID_DATA');
}

function timestamp(value: unknown, code: 'INVALID_INPUT' | 'INVALID_DATA'): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0
    || (value as number) > DATE_MAX_MS || Object.is(value, -0)) throw repositoryError(code);
  return value as number;
}

function repositoryError(code: ExecutionDryRunRepositoryErrorCode): ExecutionDryRunRepositoryError {
  const error = new ExecutionDryRunRepositoryError(code);
  INTERNAL_ERRORS.add(error);
  return error;
}

function inputError(): ExecutionDryRunRepositoryError {
  return repositoryError('INVALID_INPUT');
}

function dataError(): ExecutionDryRunRepositoryError {
  return repositoryError('INVALID_DATA');
}

function isInternalError(value: unknown): value is ExecutionDryRunRepositoryError {
  return typeof value === 'object' && value !== null
    && INTERNAL_ERRORS.has(value as ExecutionDryRunRepositoryError);
}

function isKnownCompleteOutcomeError(value: unknown): value is ExecutionDryRunRepositoryError {
  return isInternalError(value)
    && (value.code === 'INTENT_FENCE_LOST' || value.code === 'ASSESSMENT_CONFLICT');
}

function cancellationRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}

function abortBeforeQuery(client: ExecutionDryRunClient): never {
  try {
    client.release();
  } catch {
    try { client.release(true); } catch { /* The fixed database error remains authoritative. */ }
    throw repositoryError('DATABASE_FAILURE');
  }
  throw repositoryError('OPERATION_ABORTED');
}

function requiredRow(rows: readonly Row[]): Row {
  const row = rows[0];
  if (row === undefined) throw dataError();
  return row;
}

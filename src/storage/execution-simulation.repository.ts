import { isProxy } from 'node:util/types';
import {
  assertExecutionSimulationArtifact,
  assertExecutionSimulationArtifactDraft,
  type ExecutionSimulationArtifactDraftV1,
  type ExecutionSimulationArtifactV1,
} from '../domain/execution-simulation.js';
import { assertExecutionIntent, type ExecutionIntentV1 } from '../domain/execution-intent.js';
import type { ExecutionSimulationRepository } from '../ports/execution-simulation-repository.js';
import type { ClaimedExecutionIntent } from '../ports/execution-intent-repository.js';
import { getDatabasePool } from './database.js';

type Row = Readonly<Record<string, unknown>>;

interface QueryResult {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

interface ExecutionSimulationClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(error?: boolean): void;
}

export interface ExecutionSimulationPool {
  connect(): Promise<ExecutionSimulationClient>;
}

export type ExecutionSimulationRepositoryErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_DATA'
  | 'DATABASE_FAILURE'
  | 'COMMIT_OUTCOME_UNKNOWN'
  | 'INTENT_FENCE_LOST'
  | 'ARTIFACT_CONFLICT'
  | 'OPERATION_ABORTED';

export class ExecutionSimulationRepositoryError extends Error {
  public constructor(public readonly code: ExecutionSimulationRepositoryErrorCode) {
    super('Execution simulation repository operation failed.');
    this.name = 'ExecutionSimulationRepositoryError';
  }
}

const DATE_MAX_MS = 8_640_000_000_000_000;
const INT32_MAX = 2_147_483_647;
const INT64_MAX = 9_223_372_036_854_775_807n;
const U64_MAX = 18_446_744_073_709_551_615n;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INTERNAL_ERRORS = new WeakSet<ExecutionSimulationRepositoryError>();

const CLAIM_KEYS = Object.freeze([
  'intent', 'leaseOwner', 'leaseToken', 'leaseExpiresAtMs',
] as const);
const DRAFT_KEYS = Object.freeze([
  'artifactId', 'payloadVersion', 'specificationVersion', 'evaluatorVersion',
  'intentId', 'attemptNumber', 'intentStateRevision', 'strategyId', 'strategyVersion',
  'decisionFingerprint', 'resultKind', 'effectiveVenue', 'providerId', 'executorPublicKey',
  'expectedGenesisHash', 'observedGenesisHash', 'configurationFingerprint', 'quoteFingerprint',
  'snapshotFingerprint', 'buildFingerprint', 'messageHash', 'blockhash',
  'lastValidBlockHeight', 'blockhashContextSlot', 'snapshotSlot', 'feeContextSlot',
  'simulationSlot', 'amountInRaw', 'expectedAmountOutRaw', 'protectedAmountOutRaw', 'feesRaw',
  'estimatedFeeLamports', 'simulatedFeePayerLamportDebit', 'unitsConsumed',
  'simulatedBaseDeltaRaw', 'simulatedQuoteDeltaRaw', 'rpcCallsUsed', 'rpcCallsLimit',
  'quoteStatus', 'buildStatus', 'simulationStatus', 'failureStage', 'failureCode',
  'terminalReasonCode', 'logsFingerprint', 'logsLineCount', 'resultFingerprint',
] as const);
const ARTIFACT_ROW_KEYS = Object.freeze([
  'artifact_id', 'payload_version', 'specification_version', 'evaluator_version',
  'intent_id', 'attempt_number', 'intent_state_revision', 'strategy_id', 'strategy_version',
  'decision_fingerprint', 'result_kind', 'effective_venue', 'provider_id',
  'executor_public_key', 'expected_genesis_hash', 'observed_genesis_hash',
  'configuration_fingerprint', 'quote_fingerprint', 'snapshot_fingerprint',
  'build_fingerprint', 'message_hash', 'blockhash', 'last_valid_block_height',
  'blockhash_context_slot', 'snapshot_slot', 'fee_context_slot', 'simulation_slot',
  'amount_in_raw', 'expected_amount_out_raw', 'protected_amount_out_raw', 'fees_raw',
  'estimated_fee_lamports', 'simulated_fee_payer_lamport_debit', 'units_consumed',
  'simulated_base_delta_raw', 'simulated_quote_delta_raw', 'rpc_calls_used', 'rpc_calls_limit',
  'quote_status', 'build_status', 'simulation_status', 'failure_stage', 'failure_code',
  'terminal_reason_code', 'logs_fingerprint', 'logs_line_count', 'result_fingerprint',
  'recorded_at_ms',
] as const);
const COMPLETE_ROW_KEYS = Object.freeze([
  ...ARTIFACT_ROW_KEYS, 'locked_count', 'attempt_count', 'inserted_count',
  'finished_count', 'transition_count', 'updated_count',
] as const);

const ARTIFACT_PROJECTION = `
  artifact.artifact_id,
  artifact.payload_version,
  artifact.specification_version,
  artifact.evaluator_version,
  artifact.intent_id,
  artifact.attempt_number,
  artifact.intent_state_revision::TEXT AS intent_state_revision,
  artifact.strategy_id,
  artifact.strategy_version,
  artifact.decision_fingerprint,
  artifact.result_kind,
  artifact.effective_venue,
  artifact.provider_id,
  artifact.executor_public_key,
  artifact.expected_genesis_hash,
  artifact.observed_genesis_hash,
  artifact.configuration_fingerprint,
  artifact.quote_fingerprint,
  artifact.snapshot_fingerprint,
  artifact.build_fingerprint,
  artifact.message_hash,
  artifact.blockhash,
  artifact.last_valid_block_height::TEXT AS last_valid_block_height,
  artifact.blockhash_context_slot::TEXT AS blockhash_context_slot,
  artifact.snapshot_slot::TEXT AS snapshot_slot,
  artifact.fee_context_slot::TEXT AS fee_context_slot,
  artifact.simulation_slot::TEXT AS simulation_slot,
  artifact.amount_in_raw::TEXT AS amount_in_raw,
  artifact.expected_amount_out_raw::TEXT AS expected_amount_out_raw,
  artifact.protected_amount_out_raw::TEXT AS protected_amount_out_raw,
  artifact.fees_raw::TEXT AS fees_raw,
  artifact.estimated_fee_lamports::TEXT AS estimated_fee_lamports,
  artifact.simulated_fee_payer_lamport_debit::TEXT AS simulated_fee_payer_lamport_debit,
  artifact.units_consumed::TEXT AS units_consumed,
  artifact.simulated_base_delta_raw::TEXT AS simulated_base_delta_raw,
  artifact.simulated_quote_delta_raw::TEXT AS simulated_quote_delta_raw,
  artifact.rpc_calls_used,
  artifact.rpc_calls_limit,
  artifact.quote_status,
  artifact.build_status,
  artifact.simulation_status,
  artifact.failure_stage,
  artifact.failure_code,
  artifact.terminal_reason_code,
  artifact.logs_fingerprint,
  artifact.logs_line_count,
  artifact.result_fingerprint,
  trunc(EXTRACT(EPOCH FROM artifact.recorded_at) * 1000)::TEXT AS recorded_at_ms`;

const INSERTED_SELECT = ARTIFACT_ROW_KEYS.map((key) => {
  const column = key === 'recorded_at_ms' ? 'recorded_at' : key;
  const expression = key === 'recorded_at_ms'
    ? `trunc(EXTRACT(EPOCH FROM ${column}) * 1000)::TEXT`
    : needsTextCast(key) ? `${column}::TEXT` : column;
  return `(SELECT ${expression} FROM inserted) AS ${key}`;
}).join(',\n  ');

const COMPLETE_SQL = `WITH operation AS MATERIALIZED (
  SELECT date_trunc('milliseconds', statement_timestamp()) AS at
), locked AS MATERIALIZED (
  SELECT intent.id,intent.side,intent.state_revision,EXISTS (
    SELECT 1 FROM execution_simulation_artifacts AS existing
    WHERE existing.artifact_id=$27
       OR (existing.intent_id=$1 AND existing.attempt_number=$26)
  ) AS artifact_conflict
  FROM execution_intents AS intent CROSS JOIN operation
  WHERE intent.id=$1 AND intent.status=$2
    AND intent.lease_owner=$3 AND intent.lease_token=$4::UUID
    AND intent.lease_expires_at=TIMESTAMPTZ 'epoch'
      + ($5::BIGINT * INTERVAL '1 millisecond')
    AND intent.lease_expires_at > operation.at
    AND intent.expires_at > operation.at
    AND intent.state_revision=$6::BIGINT
    AND intent.payload_version=$7 AND intent.logical_order_key=$8
    AND intent.strategy_id=$9 AND intent.strategy_version=$10
    AND intent.position_id=$11 AND intent.logical_command_id=$12
    AND intent.mint=$13 AND intent.side=$14 AND intent.venue_policy=$15
    AND intent.quote_mint=$16 AND intent.quote_token_program=$17
    AND intent.quote_decimals=$18
    AND intent.quote_amount_raw IS NOT DISTINCT FROM $19::NUMERIC
    AND intent.base_amount_raw IS NOT DISTINCT FROM $20::NUMERIC
    AND intent.minimum_amount_out_raw=$21::NUMERIC
    AND intent.decision_event_id=$22 AND intent.decision_fingerprint=$23
    AND intent.requested_at=TIMESTAMPTZ 'epoch'
      + ($24::BIGINT * INTERVAL '1 millisecond')
    AND intent.expires_at=TIMESTAMPTZ 'epoch'
      + ($25::BIGINT * INTERVAL '1 millisecond')
    AND intent.attempt_count=$26
    AND intent.last_reason_code='EXECUTION_STARTED'
    AND intent.state_revision <= 9223372036854775807
      - CASE WHEN $37='SUCCESS' THEN 2 ELSE 1 END
  FOR UPDATE OF intent
), attempt_locked AS MATERIALIZED (
  SELECT attempt.intent_id,attempt.attempt_number
  FROM execution_attempts AS attempt JOIN locked ON locked.id=attempt.intent_id
  WHERE attempt.attempt_number=$26 AND attempt.status='STARTED'
    AND attempt.effective_venue IS NULL AND attempt.provider_id IS NULL
    AND attempt.completed_at IS NULL AND attempt.reason_code IS NULL
  FOR UPDATE OF attempt
), inserted AS MATERIALIZED (
  INSERT INTO execution_simulation_artifacts (
    artifact_id,payload_version,specification_version,evaluator_version,intent_id,
    attempt_number,intent_state_revision,strategy_id,strategy_version,decision_fingerprint,
    result_kind,effective_venue,provider_id,executor_public_key,expected_genesis_hash,
    observed_genesis_hash,configuration_fingerprint,quote_fingerprint,snapshot_fingerprint,
    build_fingerprint,message_hash,blockhash,last_valid_block_height,blockhash_context_slot,
    snapshot_slot,fee_context_slot,simulation_slot,amount_in_raw,expected_amount_out_raw,
    protected_amount_out_raw,fees_raw,estimated_fee_lamports,
    simulated_fee_payer_lamport_debit,units_consumed,simulated_base_delta_raw,
    simulated_quote_delta_raw,rpc_calls_used,rpc_calls_limit,quote_status,build_status,
    simulation_status,failure_stage,failure_code,terminal_reason_code,logs_fingerprint,
    logs_line_count,result_fingerprint,recorded_at
  )
  SELECT $27,$28,$29,$30,$31,$32,$33::BIGINT,$34,$35,$36,$37,$38,$39,$40,$41,$42,
    $43,$44,$45,$46,$47,$48,$49::BIGINT,$50::BIGINT,$51::BIGINT,$52::BIGINT,
    $53::BIGINT,$54::NUMERIC,$55::NUMERIC,$56::NUMERIC,$57::NUMERIC,$58::NUMERIC,
    $59::NUMERIC,$60::BIGINT,$61::NUMERIC,$62::NUMERIC,$63,$64,$65,$66,$67,$68,
    $69,$70,$71,$72,$73,operation.at
  FROM locked JOIN attempt_locked ON attempt_locked.intent_id=locked.id CROSS JOIN operation
  WHERE NOT locked.artifact_conflict
    AND ($69 IS DISTINCT FROM 'SIMULATION_PROGRAM_ERROR'
      OR (locked.side='BUY' AND $70='BUY_SIMULATION_FAILED')
      OR (locked.side='SELL' AND $70='SELL_SIMULATION_FAILED'))
  RETURNING *
), finished AS MATERIALIZED (
  UPDATE execution_attempts AS attempt
  SET status=CASE WHEN inserted.result_kind='SUCCESS' THEN 'COMPLETED' ELSE 'ABANDONED' END,
      effective_venue=inserted.effective_venue,
      provider_id=inserted.provider_id,
      completed_at=operation.at,
      reason_code=CASE WHEN inserted.result_kind='SUCCESS'
        THEN 'ATTEMPT_COMPLETED' ELSE inserted.terminal_reason_code END
  FROM inserted CROSS JOIN operation
  WHERE attempt.intent_id=inserted.intent_id
    AND attempt.attempt_number=inserted.attempt_number
    AND attempt.status='STARTED' AND attempt.completed_at IS NULL
  RETURNING attempt.intent_id,attempt.attempt_number
), transition_rows AS MATERIALIZED (
  SELECT finished.intent_id AS intent_id,'PROCESSING' AS previous_status,
    CASE WHEN inserted.result_kind='SUCCESS' THEN 'SIMULATED' ELSE 'FAILED' END AS next_status,
    CASE WHEN inserted.result_kind='SUCCESS'
      THEN 'SIMULATION_SUCCEEDED' ELSE inserted.terminal_reason_code END AS reason_code,
    CASE WHEN inserted.result_kind='SUCCESS'
      THEN 'Unsigned execution simulation succeeded.'
      ELSE 'Simulation-only execution intent failed.' END AS human_message,
    'NONE' AS activation_phase,finished.attempt_number AS attempt_number,
    jsonb_build_object('payloadVersion',1,'attemptNumber',finished.attempt_number,
      'sourceEventId',NULL,'observedAtMs',
      (EXTRACT(EPOCH FROM operation.at) * 1000)::BIGINT) AS evidence,
    operation.at AS occurred_at,1 AS ordinal
  FROM finished JOIN inserted ON inserted.intent_id=finished.intent_id CROSS JOIN operation
  UNION ALL
  SELECT finished.intent_id,'SIMULATED','SUCCEEDED','INTENT_SUCCEEDED',
    'Simulation-only execution intent completed.','NONE',finished.attempt_number,
    jsonb_build_object('payloadVersion',1,'attemptNumber',finished.attempt_number,
      'sourceEventId',NULL,'observedAtMs',
      (EXTRACT(EPOCH FROM operation.at) * 1000)::BIGINT),operation.at,2
  FROM finished JOIN inserted ON inserted.intent_id=finished.intent_id CROSS JOIN operation
  WHERE inserted.result_kind='SUCCESS'
), journal AS MATERIALIZED (
  INSERT INTO execution_intent_transitions (
    intent_id,previous_status,next_status,reason_code,human_message,
    activation_phase,attempt_number,evidence,occurred_at
  )
  SELECT intent_id,previous_status,next_status,reason_code,human_message,
    activation_phase,attempt_number,evidence,occurred_at
  FROM transition_rows ORDER BY ordinal
  RETURNING intent_id
), updated AS MATERIALIZED (
  UPDATE execution_intents AS intent
  SET status=CASE WHEN inserted.result_kind='SUCCESS' THEN 'SUCCEEDED' ELSE 'FAILED' END,
      last_reason_code=CASE WHEN inserted.result_kind='SUCCESS'
        THEN 'INTENT_SUCCEEDED' ELSE inserted.terminal_reason_code END,
      terminal_at=operation.at,
      reconciliation_completed_at=operation.at,
      purge_after=operation.at + INTERVAL '4 hours',
      lease_owner=NULL,
      lease_token=NULL,
      lease_expires_at=NULL,
      updated_at=operation.at,
      state_revision=locked.state_revision +
        CASE WHEN inserted.result_kind='SUCCESS' THEN 2 ELSE 1 END
  FROM locked JOIN inserted ON inserted.intent_id=locked.id CROSS JOIN operation
  WHERE intent.id=locked.id AND intent.status='PROCESSING'
    AND intent.lease_token=$4::UUID AND intent.state_revision=locked.state_revision
    AND (SELECT COUNT(*) FROM journal)=
      CASE WHEN inserted.result_kind='SUCCESS' THEN 2 ELSE 1 END
  RETURNING intent.id
)
SELECT
  ${INSERTED_SELECT},
  (SELECT COUNT(*)::INTEGER FROM locked) AS locked_count,
  (SELECT COUNT(*)::INTEGER FROM attempt_locked) AS attempt_count,
  (SELECT COUNT(*)::INTEGER FROM inserted) AS inserted_count,
  (SELECT COUNT(*)::INTEGER FROM finished) AS finished_count,
  (SELECT COUNT(*)::INTEGER FROM journal) AS transition_count,
  (SELECT COUNT(*)::INTEGER FROM updated) AS updated_count`;

const FIND_EXACT_SQL = `SELECT ${ARTIFACT_PROJECTION}
FROM execution_simulation_artifacts AS artifact
WHERE artifact.artifact_id=$1
  OR (artifact.intent_id=$2 AND artifact.attempt_number=$3)`;

export class PostgresExecutionSimulationRepository implements ExecutionSimulationRepository {
  public constructor(private readonly pool: ExecutionSimulationPool = getDatabasePool()) {}

  public async complete(
    claimValue: ClaimedExecutionIntent,
    artifactValue: ExecutionSimulationArtifactDraftV1,
    signal: AbortSignal,
  ): Promise<ExecutionSimulationArtifactV1> {
    let inputs: Readonly<{
      readonly claim: ClaimedExecutionIntent;
      readonly artifact: ExecutionSimulationArtifactDraftV1;
    }>;
    try {
      const claim = claimInput(claimValue);
      const artifact = artifactInput(artifactValue);
      if (!matchesClaim(claim, artifact)) throw inputError();
      inputs = Object.freeze({ claim, artifact });
    } catch (error) {
      if (isInternalError(error)) throw error;
      throw inputError();
    }
    if (cancellationRequested(signal)) throw repositoryError('OPERATION_ABORTED');

    let client: ExecutionSimulationClient;
    try { client = await this.pool.connect(); } catch { throw repositoryError('DATABASE_FAILURE'); }
    if (cancellationRequested(signal)) abortBeforeQuery(client);
    let output: ExecutionSimulationArtifactV1 | undefined;
    let primaryFailure: unknown;
    let completed = false;
    try {
      output = completeResult(
        await client.query(COMPLETE_SQL, completeValues(inputs.claim, inputs.artifact)),
        inputs.artifact,
      );
      completed = true;
    } catch (error) { primaryFailure = error; }
    const releaseFailed = releaseClient(client, completed);
    if (completed && !releaseFailed) {
      if (output === undefined) throw dataError();
      return output;
    }
    if (!releaseFailed && isKnownCompleteOutcomeError(primaryFailure)) throw primaryFailure;
    throw repositoryError('COMMIT_OUTCOME_UNKNOWN');
  }

  public async findExact(
    artifactValue: ExecutionSimulationArtifactDraftV1,
    signal: AbortSignal,
  ): Promise<ExecutionSimulationArtifactV1 | null> {
    let artifact: ExecutionSimulationArtifactDraftV1;
    try { artifact = artifactInput(artifactValue); } catch (error) {
      if (isInternalError(error)) throw error;
      throw inputError();
    }
    if (cancellationRequested(signal)) throw repositoryError('OPERATION_ABORTED');
    let client: ExecutionSimulationClient;
    try { client = await this.pool.connect(); } catch { throw repositoryError('DATABASE_FAILURE'); }
    if (cancellationRequested(signal)) abortBeforeQuery(client);
    let output: ExecutionSimulationArtifactV1 | null | undefined;
    let primaryFailure: unknown;
    let completed = false;
    try {
      output = findResult(
        await client.query(FIND_EXACT_SQL, [artifact.artifactId, artifact.intentId,
          artifact.attemptNumber]), artifact,
      );
      completed = true;
    } catch (error) { primaryFailure = error; }
    const releaseFailed = releaseClient(client, completed);
    if (completed && !releaseFailed) return output as ExecutionSimulationArtifactV1 | null;
    if (!releaseFailed && isInternalError(primaryFailure)) throw primaryFailure;
    throw repositoryError('DATABASE_FAILURE');
  }
}

function completeValues(
  claim: ClaimedExecutionIntent,
  artifact: ExecutionSimulationArtifactDraftV1,
): readonly unknown[] {
  const intent = claim.intent;
  return [
    intent.id, intent.status, claim.leaseOwner, claim.leaseToken,
    String(claim.leaseExpiresAtMs), intent.stateRevision.toString(), intent.payloadVersion,
    intent.logicalOrderKey, intent.strategyId, intent.strategyVersion, intent.positionId,
    intent.logicalCommandId, intent.mint, intent.side, intent.venuePolicy, intent.quoteMint,
    intent.quoteTokenProgram, intent.quoteDecimals, decimal(intent.quoteAmountRaw),
    decimal(intent.baseAmountRaw), intent.minimumAmountOutRaw.toString(), intent.decisionEventId,
    intent.decisionFingerprint, String(intent.requestedAtMs), String(intent.expiresAtMs),
    artifact.attemptNumber,
    artifact.artifactId, artifact.payloadVersion, artifact.specificationVersion,
    artifact.evaluatorVersion, artifact.intentId, artifact.attemptNumber,
    artifact.intentStateRevision.toString(), artifact.strategyId, artifact.strategyVersion,
    artifact.decisionFingerprint, artifact.resultKind, artifact.effectiveVenue,
    artifact.providerId, artifact.executorPublicKey, artifact.expectedGenesisHash,
    artifact.observedGenesisHash, artifact.configurationFingerprint, artifact.quoteFingerprint,
    artifact.snapshotFingerprint, artifact.buildFingerprint, artifact.messageHash,
    artifact.blockhash, decimal(artifact.lastValidBlockHeight),
    decimal(artifact.blockhashContextSlot), decimal(artifact.snapshotSlot),
    decimal(artifact.feeContextSlot), decimal(artifact.simulationSlot),
    decimal(artifact.amountInRaw), decimal(artifact.expectedAmountOutRaw),
    decimal(artifact.protectedAmountOutRaw), decimal(artifact.feesRaw),
    decimal(artifact.estimatedFeeLamports), decimal(artifact.simulatedFeePayerLamportDebit),
    decimal(artifact.unitsConsumed), decimal(artifact.simulatedBaseDeltaRaw),
    decimal(artifact.simulatedQuoteDeltaRaw), artifact.rpcCallsUsed, artifact.rpcCallsLimit,
    artifact.quoteStatus, artifact.buildStatus, artifact.simulationStatus,
    artifact.failureStage, artifact.failureCode, artifact.terminalReasonCode,
    artifact.logsFingerprint, artifact.logsLineCount, artifact.resultFingerprint,
  ];
}

function completeResult(
  result: QueryResult,
  expected: ExecutionSimulationArtifactDraftV1,
): ExecutionSimulationArtifactV1 {
  if (result.rowCount !== 1 || result.rows.length !== 1) throw dataError();
  const row = exactRecord(requiredRow(result.rows), COMPLETE_ROW_KEYS, 'INVALID_DATA', false);
  const locked = cardinality(row.locked_count);
  const attempt = cardinality(row.attempt_count);
  const inserted = cardinality(row.inserted_count);
  const finished = cardinality(row.finished_count);
  const transitions = cardinality(row.transition_count);
  const updated = cardinality(row.updated_count);
  if (locked === 0 || attempt === 0) throw repositoryError('INTENT_FENCE_LOST');
  if (locked !== 1 || attempt !== 1) throw dataError();
  if (inserted === 0) throw repositoryError('ARTIFACT_CONFLICT');
  const expectedTransitions = expected.resultKind === 'SUCCESS' ? 2 : 1;
  if (inserted !== 1 || finished !== 1 || transitions !== expectedTransitions || updated !== 1) {
    throw dataError();
  }
  return decodeArtifact(pickRow(row, ARTIFACT_ROW_KEYS), expected, false);
}

function findResult(
  result: QueryResult,
  expected: ExecutionSimulationArtifactDraftV1,
): ExecutionSimulationArtifactV1 | null {
  if (result.rowCount === 0 && result.rows.length === 0) return null;
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    throw repositoryError('ARTIFACT_CONFLICT');
  }
  return decodeArtifact(requiredRow(result.rows), expected, true);
}

function decodeArtifact(
  value: unknown,
  expected: ExecutionSimulationArtifactDraftV1,
  mismatchIsConflict: boolean,
): ExecutionSimulationArtifactV1 {
  const row = exactRecord(value, ARTIFACT_ROW_KEYS, 'INVALID_DATA', false);
  const candidate: unknown = Object.freeze({
    artifactId: row.artifact_id,
    payloadVersion: row.payload_version,
    specificationVersion: row.specification_version,
    evaluatorVersion: row.evaluator_version,
    intentId: row.intent_id,
    attemptNumber: row.attempt_number,
    intentStateRevision: nonNegativeInt64(row.intent_state_revision),
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    decisionFingerprint: row.decision_fingerprint,
    resultKind: row.result_kind,
    effectiveVenue: row.effective_venue,
    providerId: row.provider_id,
    executorPublicKey: row.executor_public_key,
    expectedGenesisHash: row.expected_genesis_hash,
    observedGenesisHash: row.observed_genesis_hash,
    configurationFingerprint: row.configuration_fingerprint,
    quoteFingerprint: row.quote_fingerprint,
    snapshotFingerprint: row.snapshot_fingerprint,
    buildFingerprint: row.build_fingerprint,
    messageHash: row.message_hash,
    blockhash: row.blockhash,
    lastValidBlockHeight: nullableNonNegativeInt64(row.last_valid_block_height),
    blockhashContextSlot: nullableNonNegativeInt64(row.blockhash_context_slot),
    snapshotSlot: nullableNonNegativeInt64(row.snapshot_slot),
    feeContextSlot: nullableNonNegativeInt64(row.fee_context_slot),
    simulationSlot: nullableNonNegativeInt64(row.simulation_slot),
    amountInRaw: nullableU64(row.amount_in_raw),
    expectedAmountOutRaw: nullableU64(row.expected_amount_out_raw),
    protectedAmountOutRaw: nullableU64(row.protected_amount_out_raw),
    feesRaw: nullableU64(row.fees_raw),
    estimatedFeeLamports: nullableU64(row.estimated_fee_lamports),
    simulatedFeePayerLamportDebit: nullableU64(row.simulated_fee_payer_lamport_debit),
    unitsConsumed: nullablePositiveInt64(row.units_consumed),
    simulatedBaseDeltaRaw: nullableSignedU64(row.simulated_base_delta_raw),
    simulatedQuoteDeltaRaw: nullableSignedU64(row.simulated_quote_delta_raw),
    rpcCallsUsed: row.rpc_calls_used,
    rpcCallsLimit: row.rpc_calls_limit,
    quoteStatus: row.quote_status,
    buildStatus: row.build_status,
    simulationStatus: row.simulation_status,
    failureStage: row.failure_stage,
    failureCode: row.failure_code,
    terminalReasonCode: row.terminal_reason_code,
    logsFingerprint: row.logs_fingerprint,
    logsLineCount: row.logs_line_count,
    resultFingerprint: row.result_fingerprint,
    recordedAtMs: timestampFromDatabase(row.recorded_at_ms),
  });
  try { assertExecutionSimulationArtifact(candidate); } catch { throw dataError(); }
  if (!sameDraft(candidate, expected)) {
    throw repositoryError(mismatchIsConflict ? 'ARTIFACT_CONFLICT' : 'INVALID_DATA');
  }
  return candidate;
}

function claimInput(value: unknown): ClaimedExecutionIntent {
  const row = exactRecord(value, CLAIM_KEYS, 'INVALID_INPUT', true);
  try { assertExecutionIntent(row.intent); } catch { throw inputError(); }
  if (row.intent.status !== 'PROCESSING' || row.intent.lastReasonCode !== 'EXECUTION_STARTED') {
    throw inputError();
  }
  const leaseOwner = boundedText(row.leaseOwner);
  const leaseToken = uuid(row.leaseToken);
  const leaseExpiresAtMs = timestamp(row.leaseExpiresAtMs, 'INVALID_INPUT');
  return Object.freeze({ intent: row.intent, leaseOwner, leaseToken, leaseExpiresAtMs });
}

function artifactInput(value: unknown): ExecutionSimulationArtifactDraftV1 {
  try { assertExecutionSimulationArtifactDraft(value); } catch { throw inputError(); }
  const row = exactRecord(value, DRAFT_KEYS, 'INVALID_INPUT', true);
  return Object.freeze({ ...row }) as unknown as ExecutionSimulationArtifactDraftV1;
}

function matchesClaim(
  claim: ClaimedExecutionIntent,
  artifact: ExecutionSimulationArtifactDraftV1,
): boolean {
  const intent = claim.intent;
  const attemptMatches = artifact.attemptNumber === intent.attemptCount
    || (intent.attemptCount < INT32_MAX && artifact.attemptNumber === intent.attemptCount + 1);
  const revisionIncrement = artifact.resultKind === 'SUCCESS' ? 2n : 1n;
  return attemptMatches && artifact.intentId === intent.id
    && artifact.intentStateRevision === intent.stateRevision
    && artifact.strategyId === intent.strategyId
    && artifact.strategyVersion === intent.strategyVersion
    && artifact.decisionFingerprint === intent.decisionFingerprint
    && simulationFailureReasonMatchesSide(intent.side, artifact)
    && intent.stateRevision <= INT64_MAX - revisionIncrement;
}

function simulationFailureReasonMatchesSide(
  side: ExecutionIntentV1['side'],
  artifact: ExecutionSimulationArtifactDraftV1,
): boolean {
  if (artifact.failureCode !== 'SIMULATION_PROGRAM_ERROR') return true;
  return (side === 'BUY' && artifact.terminalReasonCode === 'BUY_SIMULATION_FAILED')
    || (side === 'SELL' && artifact.terminalReasonCode === 'SELL_SIMULATION_FAILED');
}

function sameDraft(
  actual: ExecutionSimulationArtifactV1,
  expected: ExecutionSimulationArtifactDraftV1,
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
    const output: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      if (!keys.includes(key)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error();
      }
      output[key] = descriptor.value;
    }
    return output;
  } catch { throw repositoryError(code); }
}

function pickRow(row: Row, keys: readonly string[]): Row {
  const output: Record<string, unknown> = {};
  for (const key of keys) output[key] = row[key];
  return output;
}

function needsTextCast(key: string): boolean {
  return key === 'intent_state_revision' || key === 'last_valid_block_height'
    || key.endsWith('_slot') || key.endsWith('_raw') || key === 'estimated_fee_lamports'
    || key === 'simulated_fee_payer_lamport_debit' || key === 'units_consumed';
}

function decimal(value: bigint | null): string | null {
  return value === null ? null : value.toString();
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
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 2) {
    throw dataError();
  }
  return value as number;
}

function nonNegativeInt64(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(value)) throw dataError();
  const parsed = BigInt(value);
  if (parsed > INT64_MAX) throw dataError();
  return parsed;
}

function nullableNonNegativeInt64(value: unknown): bigint | null {
  return value === null ? null : nonNegativeInt64(value);
}

function nullablePositiveInt64(value: unknown): bigint | null {
  const parsed = nullableNonNegativeInt64(value);
  if (parsed === 0n) throw dataError();
  return parsed;
}

function nullableU64(value: unknown): bigint | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/u.test(value)) throw dataError();
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw dataError();
  return parsed;
}

function nullableSignedU64(value: unknown): bigint | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]{0,19})$/u.test(value)
    || value === '-0') throw dataError();
  const parsed = BigInt(value);
  if (parsed < -U64_MAX || parsed > U64_MAX) throw dataError();
  return parsed;
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

function requiredRow(rows: readonly Row[]): Row {
  const row = rows[0];
  if (row === undefined) throw dataError();
  return row;
}

function releaseClient(client: ExecutionSimulationClient, completed: boolean): boolean {
  try { client.release(completed ? undefined : true); return false; } catch {
    if (completed) { try { client.release(true); } catch { /* fixed error remains authoritative */ } }
    return true;
  }
}

function abortBeforeQuery(client: ExecutionSimulationClient): never {
  let failed = false;
  try { client.release(); } catch { failed = true; try { client.release(true); } catch { /* fixed */ } }
  throw repositoryError(failed ? 'DATABASE_FAILURE' : 'OPERATION_ABORTED');
}

function cancellationRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}

function repositoryError(
  code: ExecutionSimulationRepositoryErrorCode,
): ExecutionSimulationRepositoryError {
  const error = new ExecutionSimulationRepositoryError(code);
  INTERNAL_ERRORS.add(error);
  return error;
}

function inputError(): ExecutionSimulationRepositoryError {
  return repositoryError('INVALID_INPUT');
}

function dataError(): ExecutionSimulationRepositoryError {
  return repositoryError('INVALID_DATA');
}

function isInternalError(value: unknown): value is ExecutionSimulationRepositoryError {
  return typeof value === 'object' && value !== null
    && INTERNAL_ERRORS.has(value as ExecutionSimulationRepositoryError);
}

function isKnownCompleteOutcomeError(value: unknown): boolean {
  return isInternalError(value)
    && (value.code === 'INTENT_FENCE_LOST'
      || value.code === 'ARTIFACT_CONFLICT');
}

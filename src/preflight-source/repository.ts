import { isProxy } from 'node:util/types';
import { assertExecutionIntent } from '../domain/execution-intent.js';
import type { ExecutionPreflightDraftSourceV1 } from '../domain/execution-preflight-draft.js';
import { createExecutionPreflightDraftSource } from '../domain/execution-preflight-draft.js';
import { createProviderUsageSnapshot } from '../domain/execution-provider-quota.js';
import { createExecutionReadinessManifest,
  createExecutionWalletGeneration } from '../domain/execution-readiness.js';
import { assertExecutionSimulationArtifact } from '../domain/execution-simulation.js';
import { createExecutionWalletSnapshot } from '../domain/execution-wallet-snapshot.js';

interface QueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number | null;
}
interface DatabaseClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(error?: boolean): void;
}
interface DatabaseSource { connect(): Promise<DatabaseClient>; }

export interface ExecutionPreflightSourceRequestV1 {
  readonly generationId: string;
  readonly targetIntentId: string;
  readonly simulationArtifactId: string;
}

export class ExecutionPreflightSourceRepositoryError extends Error {
  public readonly code = 'EXECUTION_PREFLIGHT_SOURCE_READ_FAILED' as const;
  public constructor() {
    super('Execution preflight source read failed.');
    this.name = 'ExecutionPreflightSourceRepositoryError';
  }
}

export class PostgresExecutionPreflightSourceRepository {
  readonly #source: DatabaseSource;
  public constructor(source: DatabaseSource) { this.#source = source; }

  public async export(request: ExecutionPreflightSourceRequestV1):
  Promise<ExecutionPreflightDraftSourceV1> {
    let client: DatabaseClient | undefined;
    let began = false;
    try {
      validateRequest(request);
      client = await this.#source.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      began = true;
      const databaseNowMs = timestampText(field(single(await client.query(`SELECT
        trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS database_now_ms`)),
      'database_now_ms'));
      const generation = generationFrom(single(await client.query(`SELECT generation_id,
        payload_version,wallet_public_key,cluster,genesis_hash,generation,retired_at
        FROM execution_wallet_generations WHERE generation_id=$1`, [request.generationId])));
      const wallet = walletFrom(single(await client.query(`SELECT snapshot_id,payload_version,
        snapshot_fingerprint,generation_id,provider_id,state_revision::TEXT AS state_revision,
        slot::TEXT AS slot,
        CASE WHEN block_time IS NULL THEN NULL ELSE
          trunc(EXTRACT(EPOCH FROM block_time)*1000)::TEXT END AS block_time_ms,
        trunc(EXTRACT(EPOCH FROM observed_at)*1000)::TEXT AS observed_at_ms,
        commitment,wallet_lamports::TEXT AS wallet_lamports,token_balance_count,open_positions,
        position_1_id,position_1_cost_basis_lamports::TEXT AS position_1_cost_basis_lamports,
        position_1_conservative_liquidation_lamports::TEXT
          AS position_1_conservative_liquidation_lamports,position_1_reconciliation_status,
        position_2_id,position_2_cost_basis_lamports::TEXT AS position_2_cost_basis_lamports,
        position_2_conservative_liquidation_lamports::TEXT
          AS position_2_conservative_liquidation_lamports,position_2_reconciliation_status,
        realized_net_pnl_raw::TEXT AS realized_net_pnl_raw,superseded_at
        FROM execution_wallet_snapshots
        WHERE generation_id=$1 AND superseded_at IS NULL`, [request.generationId])));
      const provider = providerFrom(single(await client.query(`SELECT snapshot_id,payload_version,
        snapshot_fingerprint,provider_id,plan_id,billing_period_id,
        trunc(EXTRACT(EPOCH FROM billing_period_started_at)*1000)::TEXT
          AS billing_period_started_at_ms,
        trunc(EXTRACT(EPOCH FROM billing_period_ends_at)*1000)::TEXT
          AS billing_period_ends_at_ms,limit_units::TEXT AS limit_units,
        used_units::TEXT AS used_units,
        trunc(EXTRACT(EPOCH FROM measured_at)*1000)::TEXT AS measured_at_ms,
        trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms,
        provenance,superseded_at FROM execution_provider_usage_snapshots
        WHERE provider_id=$1 AND superseded_at IS NULL`, [wallet.providerId])));
      const target = targetFrom(single(await client.query(`SELECT id,payload_version,
        logical_order_key,strategy_id,strategy_version,position_id,logical_command_id,mint,side,
        venue_policy,quote_mint,quote_token_program,quote_decimals,
        quote_amount_raw::TEXT AS quote_amount_raw,base_amount_raw::TEXT AS base_amount_raw,
        minimum_amount_out_raw::TEXT AS minimum_amount_out_raw,decision_event_id,
        decision_fingerprint,trunc(EXTRACT(EPOCH FROM requested_at)*1000)::TEXT AS requested_at_ms,
        trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms,status,attempt_count,
        state_revision::TEXT AS state_revision,lease_owner,
        CASE WHEN lease_expires_at IS NULL THEN NULL ELSE
          trunc(EXTRACT(EPOCH FROM lease_expires_at)*1000)::TEXT END AS lease_expires_at_ms,
        last_reason_code,
        CASE WHEN terminal_at IS NULL THEN NULL ELSE
          trunc(EXTRACT(EPOCH FROM terminal_at)*1000)::TEXT END AS terminal_at_ms,
        CASE WHEN reconciliation_completed_at IS NULL THEN NULL ELSE
          trunc(EXTRACT(EPOCH FROM reconciliation_completed_at)*1000)::TEXT END
          AS reconciliation_completed_at_ms,
        CASE WHEN purge_after IS NULL THEN NULL ELSE
          trunc(EXTRACT(EPOCH FROM purge_after)*1000)::TEXT END AS purge_after_ms,
        trunc(EXTRACT(EPOCH FROM created_at)*1000)::TEXT AS created_at_ms,
        trunc(EXTRACT(EPOCH FROM updated_at)*1000)::TEXT AS updated_at_ms
        FROM execution_intents WHERE id=$1`, [request.targetIntentId])));
      const simulation = simulationFrom(single(await client.query(`SELECT artifact_id,
        payload_version,specification_version,evaluator_version,intent_id,attempt_number,
        intent_state_revision::TEXT AS intent_state_revision,strategy_id,strategy_version,
        decision_fingerprint,result_kind,effective_venue,provider_id,executor_public_key,
        expected_genesis_hash,observed_genesis_hash,configuration_fingerprint,
        quote_fingerprint,snapshot_fingerprint,build_fingerprint,message_hash,blockhash,
        last_valid_block_height::TEXT AS last_valid_block_height,
        blockhash_context_slot::TEXT AS blockhash_context_slot,
        snapshot_slot::TEXT AS snapshot_slot,fee_context_slot::TEXT AS fee_context_slot,
        simulation_slot::TEXT AS simulation_slot,amount_in_raw::TEXT AS amount_in_raw,
        expected_amount_out_raw::TEXT AS expected_amount_out_raw,
        protected_amount_out_raw::TEXT AS protected_amount_out_raw,fees_raw::TEXT AS fees_raw,
        estimated_fee_lamports::TEXT AS estimated_fee_lamports,
        simulated_fee_payer_lamport_debit::TEXT AS simulated_fee_payer_lamport_debit,
        units_consumed::TEXT AS units_consumed,
        simulated_base_delta_raw::TEXT AS simulated_base_delta_raw,
        simulated_quote_delta_raw::TEXT AS simulated_quote_delta_raw,rpc_calls_used,
        rpc_calls_limit,quote_status,build_status,simulation_status,failure_stage,failure_code,
        terminal_reason_code,logs_fingerprint,logs_line_count,result_fingerprint,
        trunc(EXTRACT(EPOCH FROM recorded_at)*1000)::TEXT AS recorded_at_ms
        FROM execution_simulation_artifacts WHERE artifact_id=$1`,
      [request.simulationArtifactId])));
      const readiness = createExecutionReadinessManifest(Object.freeze({
        generationId: generation.generationId, walletPublicKey: generation.walletPublicKey,
        cluster: generation.cluster, providerId: provider.providerId,
        walletSnapshotId: wallet.snapshotId,
        walletSnapshotFingerprint: wallet.snapshotFingerprint,
        providerSnapshotId: provider.snapshotId,
        providerSnapshotFingerprint: provider.snapshotFingerprint,
        walletLamports: wallet.walletLamports, tokenBalanceCount: wallet.tokenBalanceCount,
        observedAtMs: wallet.observedAtMs, expiresAtMs: provider.expiresAtMs,
      }));
      const source = createExecutionPreflightDraftSource(Object.freeze({
        schemaVersion: 'execution-preflight-draft-source.v1', readiness, generation,
        walletSnapshot: wallet, providerSnapshot: provider, target, simulation, databaseNowMs,
      }));
      await client.query('COMMIT');
      began = false;
      return source;
    } catch {
      if (began && client !== undefined) {
        try { await client.query('ROLLBACK'); } catch { client.release(true); client = undefined; }
      }
      throw new ExecutionPreflightSourceRepositoryError();
    } finally { client?.release(); }
  }
}

function generationFrom(row: Readonly<Record<string, unknown>>):
ExecutionPreflightDraftSourceV1['generation'] {
  const value = exact(row, ['generation_id', 'payload_version', 'wallet_public_key', 'cluster',
    'genesis_hash', 'generation', 'retired_at'] as const);
  if (value.payload_version !== 1 || value.cluster !== 'mainnet-beta'
    || value.retired_at !== null) throw new TypeError();
  const generation = createExecutionWalletGeneration(Object.freeze({
    walletPublicKey: stringValue(value.wallet_public_key), cluster: 'mainnet-beta',
    genesisHash: stringValue(value.genesis_hash), generation: numberValue(value.generation),
  }));
  if (generation.generationId !== value.generation_id) throw new TypeError();
  return Object.freeze({ generationId: generation.generationId,
    walletPublicKey: generation.walletPublicKey, cluster: 'mainnet-beta',
    genesisHash: generation.genesisHash, generation: generation.generation });
}

function walletFrom(row: Readonly<Record<string, unknown>>):
ExecutionPreflightDraftSourceV1['walletSnapshot'] {
  const value = exact(row, ['snapshot_id', 'payload_version', 'snapshot_fingerprint',
    'generation_id', 'provider_id', 'state_revision', 'slot', 'block_time_ms', 'observed_at_ms',
    'commitment', 'wallet_lamports', 'token_balance_count', 'open_positions', 'position_1_id',
    'position_1_cost_basis_lamports', 'position_1_conservative_liquidation_lamports',
    'position_1_reconciliation_status', 'position_2_id', 'position_2_cost_basis_lamports',
    'position_2_conservative_liquidation_lamports', 'position_2_reconciliation_status',
    'realized_net_pnl_raw', 'superseded_at'] as const);
  if (value.payload_version !== 1 || value.commitment !== 'finalized'
    || value.superseded_at !== null) throw new TypeError();
  const openPositions = numberValue(value.open_positions);
  const positions = [positionFrom(value, 1), positionFrom(value, 2)].filter(
    (position): position is NonNullable<typeof position> => position !== null,
  );
  if (positions.length !== openPositions) throw new TypeError();
  const snapshotId = stringValue(value.snapshot_id);
  const snapshotFingerprint = stringValue(value.snapshot_fingerprint);
  const snapshot = createExecutionWalletSnapshot(Object.freeze({
    generationId: stringValue(value.generation_id), providerId: stringValue(value.provider_id),
    stateRevision: bigintValue(value.state_revision), slot: bigintValue(value.slot),
    blockTimeMs: nullableTimestamp(value.block_time_ms), observedAtMs: timestampText(value.observed_at_ms),
    commitment: 'finalized', walletLamports: bigintValue(value.wallet_lamports),
    tokenBalanceCount: numberValue(value.token_balance_count), openPositions: Object.freeze(positions),
    realizedNetPnlRaw: bigintValue(value.realized_net_pnl_raw),
  }));
  if (snapshot.snapshotId !== snapshotId || snapshot.snapshotFingerprint !== snapshotFingerprint) {
    throw new TypeError();
  }
  return snapshot;
}

function positionFrom(row: Readonly<Record<string, unknown>>, index: 1 | 2):
ExecutionPreflightDraftSourceV1['walletSnapshot']['openPositions'][number] | null {
  const id = row[`position_${index}_id`];
  const cost = row[`position_${index}_cost_basis_lamports`];
  const liquidation = row[`position_${index}_conservative_liquidation_lamports`];
  const status = row[`position_${index}_reconciliation_status`];
  if (id === null && cost === null && liquidation === null && status === null) return null;
  const reconciliationStatus = stringValue(status);
  if (reconciliationStatus !== 'RECONCILED' && reconciliationStatus !== 'UNKNOWN') {
    throw new TypeError();
  }
  return Object.freeze({ positionId: stringValue(id), costBasisLamports: bigintValue(cost),
    conservativeLiquidationLamports: nullableBigint(liquidation),
    reconciliationStatus });
}

function providerFrom(row: Readonly<Record<string, unknown>>):
ExecutionPreflightDraftSourceV1['providerSnapshot'] {
  const value = exact(row, ['snapshot_id', 'payload_version', 'snapshot_fingerprint', 'provider_id',
    'plan_id', 'billing_period_id', 'billing_period_started_at_ms', 'billing_period_ends_at_ms',
    'limit_units', 'used_units', 'measured_at_ms', 'expires_at_ms', 'provenance',
    'superseded_at'] as const);
  if (value.payload_version !== 1 || value.superseded_at !== null) throw new TypeError();
  const snapshotId = stringValue(value.snapshot_id);
  const snapshotFingerprint = stringValue(value.snapshot_fingerprint);
  const snapshot = createProviderUsageSnapshot(Object.freeze({
    providerId: stringValue(value.provider_id), planId: stringValue(value.plan_id),
    billingPeriodId: stringValue(value.billing_period_id),
    billingPeriodStartedAtMs: timestampText(value.billing_period_started_at_ms),
    billingPeriodEndsAtMs: timestampText(value.billing_period_ends_at_ms),
    limitUnits: bigintValue(value.limit_units), usedUnits: bigintValue(value.used_units),
    measuredAtMs: timestampText(value.measured_at_ms), expiresAtMs: timestampText(value.expires_at_ms),
    provenance: providerProvenance(value.provenance),
  }));
  if (snapshot.snapshotId !== snapshotId || snapshot.snapshotFingerprint !== snapshotFingerprint) {
    throw new TypeError();
  }
  return snapshot;
}

function targetFrom(row: Readonly<Record<string, unknown>>):
ExecutionPreflightDraftSourceV1['target'] {
  const keys = ['id', 'payload_version', 'logical_order_key', 'strategy_id', 'strategy_version',
    'position_id', 'logical_command_id', 'mint', 'side', 'venue_policy', 'quote_mint',
    'quote_token_program', 'quote_decimals', 'quote_amount_raw', 'base_amount_raw',
    'minimum_amount_out_raw', 'decision_event_id', 'decision_fingerprint', 'requested_at_ms',
    'expires_at_ms', 'status', 'attempt_count', 'state_revision', 'lease_owner',
    'lease_expires_at_ms', 'last_reason_code', 'terminal_at_ms',
    'reconciliation_completed_at_ms', 'purge_after_ms', 'created_at_ms', 'updated_at_ms'] as const;
  const value = exact(row, keys);
  if (value.lease_owner !== null || value.lease_expires_at_ms !== null) throw new TypeError();
  const intent = Object.freeze({ id: stringValue(value.id), payloadVersion: numberValue(value.payload_version),
    logicalOrderKey: stringValue(value.logical_order_key), strategyId: stringValue(value.strategy_id),
    strategyVersion: numberValue(value.strategy_version), positionId: stringValue(value.position_id),
    logicalCommandId: stringValue(value.logical_command_id), mint: stringValue(value.mint),
    side: stringValue(value.side), venuePolicy: stringValue(value.venue_policy),
    quoteMint: stringValue(value.quote_mint), quoteTokenProgram: stringValue(value.quote_token_program),
    quoteDecimals: numberValue(value.quote_decimals), quoteAmountRaw: nullableBigint(value.quote_amount_raw),
    baseAmountRaw: nullableBigint(value.base_amount_raw),
    minimumAmountOutRaw: bigintValue(value.minimum_amount_out_raw),
    decisionEventId: stringValue(value.decision_event_id),
    decisionFingerprint: stringValue(value.decision_fingerprint),
    requestedAtMs: timestampText(value.requested_at_ms), expiresAtMs: timestampText(value.expires_at_ms),
    status: stringValue(value.status), attemptCount: numberValue(value.attempt_count),
    stateRevision: bigintValue(value.state_revision), lastReasonCode: nullableString(value.last_reason_code),
    terminalAtMs: nullableTimestamp(value.terminal_at_ms),
    reconciliationCompletedAtMs: nullableTimestamp(value.reconciliation_completed_at_ms),
    purgeAfterMs: nullableTimestamp(value.purge_after_ms), createdAtMs: timestampText(value.created_at_ms),
    updatedAtMs: timestampText(value.updated_at_ms) });
  assertExecutionIntent(intent);
  return Object.freeze({ intent, leaseOwner: null, leaseToken: null, leaseExpiresAtMs: null });
}

function simulationFrom(row: Readonly<Record<string, unknown>>):
ExecutionPreflightDraftSourceV1['simulation'] {
  const names = ['artifact_id', 'payload_version', 'specification_version', 'evaluator_version',
    'intent_id', 'attempt_number', 'intent_state_revision', 'strategy_id', 'strategy_version',
    'decision_fingerprint', 'result_kind', 'effective_venue', 'provider_id', 'executor_public_key',
    'expected_genesis_hash', 'observed_genesis_hash', 'configuration_fingerprint',
    'quote_fingerprint', 'snapshot_fingerprint', 'build_fingerprint', 'message_hash', 'blockhash',
    'last_valid_block_height', 'blockhash_context_slot', 'snapshot_slot', 'fee_context_slot',
    'simulation_slot', 'amount_in_raw', 'expected_amount_out_raw', 'protected_amount_out_raw',
    'fees_raw', 'estimated_fee_lamports', 'simulated_fee_payer_lamport_debit', 'units_consumed',
    'simulated_base_delta_raw', 'simulated_quote_delta_raw', 'rpc_calls_used', 'rpc_calls_limit',
    'quote_status', 'build_status', 'simulation_status', 'failure_stage', 'failure_code',
    'terminal_reason_code', 'logs_fingerprint', 'logs_line_count', 'result_fingerprint',
    'recorded_at_ms'] as const;
  const value = exact(row, names);
  const simulation = Object.freeze({ artifactId: stringValue(value.artifact_id),
    payloadVersion: numberValue(value.payload_version),
    specificationVersion: stringValue(value.specification_version),
    evaluatorVersion: numberValue(value.evaluator_version), intentId: stringValue(value.intent_id),
    attemptNumber: numberValue(value.attempt_number),
    intentStateRevision: bigintValue(value.intent_state_revision), strategyId: stringValue(value.strategy_id),
    strategyVersion: numberValue(value.strategy_version),
    decisionFingerprint: stringValue(value.decision_fingerprint), resultKind: stringValue(value.result_kind),
    effectiveVenue: nullableString(value.effective_venue), providerId: stringValue(value.provider_id),
    executorPublicKey: stringValue(value.executor_public_key),
    expectedGenesisHash: stringValue(value.expected_genesis_hash),
    observedGenesisHash: nullableString(value.observed_genesis_hash),
    configurationFingerprint: stringValue(value.configuration_fingerprint),
    quoteFingerprint: nullableString(value.quote_fingerprint),
    snapshotFingerprint: nullableString(value.snapshot_fingerprint),
    buildFingerprint: nullableString(value.build_fingerprint), messageHash: nullableString(value.message_hash),
    blockhash: nullableString(value.blockhash), lastValidBlockHeight: nullableBigint(value.last_valid_block_height),
    blockhashContextSlot: nullableBigint(value.blockhash_context_slot),
    snapshotSlot: nullableBigint(value.snapshot_slot), feeContextSlot: nullableBigint(value.fee_context_slot),
    simulationSlot: nullableBigint(value.simulation_slot), amountInRaw: nullableBigint(value.amount_in_raw),
    expectedAmountOutRaw: nullableBigint(value.expected_amount_out_raw),
    protectedAmountOutRaw: nullableBigint(value.protected_amount_out_raw), feesRaw: nullableBigint(value.fees_raw),
    estimatedFeeLamports: nullableBigint(value.estimated_fee_lamports),
    simulatedFeePayerLamportDebit: nullableBigint(value.simulated_fee_payer_lamport_debit),
    unitsConsumed: nullableBigint(value.units_consumed),
    simulatedBaseDeltaRaw: nullableBigint(value.simulated_base_delta_raw),
    simulatedQuoteDeltaRaw: nullableBigint(value.simulated_quote_delta_raw),
    rpcCallsUsed: numberValue(value.rpc_calls_used), rpcCallsLimit: numberValue(value.rpc_calls_limit),
    quoteStatus: stringValue(value.quote_status), buildStatus: stringValue(value.build_status),
    simulationStatus: stringValue(value.simulation_status), failureStage: nullableString(value.failure_stage),
    failureCode: nullableString(value.failure_code), terminalReasonCode: stringValue(value.terminal_reason_code),
    logsFingerprint: nullableString(value.logs_fingerprint),
    logsLineCount: nullableNumber(value.logs_line_count), resultFingerprint: stringValue(value.result_fingerprint),
    recordedAtMs: timestampText(value.recorded_at_ms) });
  assertExecutionSimulationArtifact(simulation);
  return simulation;
}

function validateRequest(value: ExecutionPreflightSourceRequestV1): void {
  const request = exact(value, ['generationId', 'targetIntentId', 'simulationArtifactId'] as const);
  if (typeof request.generationId !== 'string'
    || !/^execution_wallet_generation_[0-9a-f]{64}$/u.test(request.generationId)
    || typeof request.targetIntentId !== 'string'
    || !/^execution_intent_[0-9a-f]{64}$/u.test(request.targetIntentId)
    || typeof request.simulationArtifactId !== 'string'
    || !/^execution_simulation_artifact_[0-9a-f]{64}$/u.test(request.simulationArtifactId)) {
    throw new TypeError();
  }
}
function single(result: QueryResult): Readonly<Record<string, unknown>> {
  if (result.rowCount !== 1 || result.rows.length !== 1 || result.rows[0] === undefined) {
    throw new TypeError();
  }
  return result.rows[0];
}
function exact<const K extends readonly string[]>(row: unknown, keys: K):
Readonly<Record<K[number], unknown>> {
  if (typeof row !== 'object' || row === null || Array.isArray(row) || isProxy(row)) {
    throw new TypeError();
  }
  const prototype = Reflect.getPrototypeOf(row);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const actual = Reflect.ownKeys(row);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) throw new TypeError();
  const result = Object.create(null) as Record<K[number], unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError();
    if (!Reflect.set(result, key, descriptor.value)) throw new TypeError();
  }
  return result;
}
function field(row: Readonly<Record<string, unknown>>, key: string): unknown { return row[key]; }
function stringValue(value: unknown): string { if (typeof value !== 'string') throw new TypeError(); return value; }
function nullableString(value: unknown): string | null { return value === null ? null : stringValue(value); }
function providerProvenance(value: unknown): 'AUTHORITATIVE_PROBE' | 'OPERATOR_REPORT' {
  if (value !== 'AUTHORITATIVE_PROBE' && value !== 'OPERATOR_REPORT') throw new TypeError();
  return value;
}
function numberValue(value: unknown): number { if (!Number.isSafeInteger(value)) throw new TypeError(); return value as number; }
function nullableNumber(value: unknown): number | null { return value === null ? null : numberValue(value); }
function bigintValue(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError();
  return BigInt(value);
}
function nullableBigint(value: unknown): bigint | null { return value === null ? null : bigintValue(value); }
function timestampText(value: unknown): number {
  const parsed = bigintValue(value);
  const number = Number(parsed);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError();
  return number;
}
function nullableTimestamp(value: unknown): number | null { return value === null ? null : timestampText(value); }

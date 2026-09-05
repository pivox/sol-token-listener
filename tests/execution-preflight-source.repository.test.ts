import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutionPreflightSourceRepositoryError,
  PostgresExecutionPreflightSourceRepository,
} from '../src/preflight-source/repository.js';
import { preflightDraftInputs } from './helpers/execution-preflight-draft-fixture.js';

void test('exports one exact source from a repeatable-read read-only snapshot', async () => {
  const input = preflightDraftInputs();
  const rows = rowsFrom(input.source);
  const queries: string[] = [];
  let index = 0;
  const repository = new PostgresExecutionPreflightSourceRepository({ connect: async () => ({
    query: async (sql) => {
      queries.push(sql);
      if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rows: [], rowCount: null };
      const row = rows[index++];
      if (row === undefined) throw new Error('unexpected query');
      return { rows: [row], rowCount: 1 };
    },
    release() {},
  }) });
  const exported = await repository.export({ generationId: input.source.generation.generationId,
    targetIntentId: input.source.target.intent.id,
    simulationArtifactId: input.source.simulation.artifactId });
  assert.deepEqual(exported, input.source);
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(queries.at(-1), 'COMMIT');
  assert.equal(index, 6);
});

void test('rolls back a contradictory snapshot and returns one redacted error', async () => {
  const input = preflightDraftInputs();
  const rows = rowsFrom(input.source);
  rows[2] = Object.freeze({ ...rows[2], generation_id: `execution_wallet_generation_${'f'.repeat(64)}` });
  const queries: string[] = [];
  let index = 0;
  const repository = new PostgresExecutionPreflightSourceRepository({ connect: async () => ({
    query: async (sql) => {
      queries.push(sql);
      if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') return { rows: [], rowCount: null };
      const row = rows[index++];
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    },
    release() {},
  }) });
  await assert.rejects(repository.export({ generationId: input.source.generation.generationId,
    targetIntentId: input.source.target.intent.id,
    simulationArtifactId: input.source.simulation.artifactId }), (error: unknown) =>
    error instanceof ExecutionPreflightSourceRepositoryError
    && error.code === 'EXECUTION_PREFLIGHT_SOURCE_READ_FAILED'
    && !error.message.includes('secret'));
  assert.equal(queries.at(-1), 'ROLLBACK');
});

function rowsFrom(source: ReturnType<typeof preflightDraftInputs>['source']):
Readonly<Record<string, unknown>>[] {
  const generation = source.generation;
  const wallet = source.walletSnapshot;
  const provider = source.providerSnapshot;
  const intent = source.target.intent;
  const simulation = source.simulation;
  const position = (index: number, key: string): unknown => {
    const item = wallet.openPositions[index];
    if (item === undefined) return null;
    return item[key as keyof typeof item] ?? null;
  };
  return [
    Object.freeze({ database_now_ms: String(source.databaseNowMs) }),
    Object.freeze({ generation_id: generation.generationId, payload_version: 1,
      wallet_public_key: generation.walletPublicKey, cluster: generation.cluster,
      genesis_hash: generation.genesisHash, generation: generation.generation, retired_at: null }),
    Object.freeze({ snapshot_id: wallet.snapshotId, payload_version: 1,
      snapshot_fingerprint: wallet.snapshotFingerprint, generation_id: wallet.generationId,
      provider_id: wallet.providerId, state_revision: String(wallet.stateRevision),
      slot: String(wallet.slot), block_time_ms: nullableText(wallet.blockTimeMs),
      observed_at_ms: String(wallet.observedAtMs), commitment: wallet.commitment,
      wallet_lamports: String(wallet.walletLamports), token_balance_count: wallet.tokenBalanceCount,
      open_positions: wallet.openPositions.length, position_1_id: position(0, 'positionId'),
      position_1_cost_basis_lamports: bigintText(position(0, 'costBasisLamports')),
      position_1_conservative_liquidation_lamports:
        bigintText(position(0, 'conservativeLiquidationLamports')),
      position_1_reconciliation_status: position(0, 'reconciliationStatus'),
      position_2_id: position(1, 'positionId'),
      position_2_cost_basis_lamports: bigintText(position(1, 'costBasisLamports')),
      position_2_conservative_liquidation_lamports:
        bigintText(position(1, 'conservativeLiquidationLamports')),
      position_2_reconciliation_status: position(1, 'reconciliationStatus'),
      realized_net_pnl_raw: String(wallet.realizedNetPnlRaw), superseded_at: null }),
    Object.freeze({ snapshot_id: provider.snapshotId, payload_version: 1,
      snapshot_fingerprint: provider.snapshotFingerprint, provider_id: provider.providerId,
      plan_id: provider.planId, billing_period_id: provider.billingPeriodId,
      billing_period_started_at_ms: String(provider.billingPeriodStartedAtMs),
      billing_period_ends_at_ms: String(provider.billingPeriodEndsAtMs),
      limit_units: String(provider.limitUnits), used_units: String(provider.usedUnits),
      measured_at_ms: String(provider.measuredAtMs), expires_at_ms: String(provider.expiresAtMs),
      provenance: provider.provenance, superseded_at: null }),
    Object.freeze({ id: intent.id, payload_version: intent.payloadVersion,
      logical_order_key: intent.logicalOrderKey, strategy_id: intent.strategyId,
      strategy_version: intent.strategyVersion, position_id: intent.positionId,
      logical_command_id: intent.logicalCommandId, mint: intent.mint, side: intent.side,
      venue_policy: intent.venuePolicy, quote_mint: intent.quoteMint,
      quote_token_program: intent.quoteTokenProgram, quote_decimals: intent.quoteDecimals,
      quote_amount_raw: bigintText(intent.quoteAmountRaw), base_amount_raw: bigintText(intent.baseAmountRaw),
      minimum_amount_out_raw: String(intent.minimumAmountOutRaw),
      decision_event_id: intent.decisionEventId, decision_fingerprint: intent.decisionFingerprint,
      requested_at_ms: String(intent.requestedAtMs), expires_at_ms: String(intent.expiresAtMs),
      status: intent.status, attempt_count: intent.attemptCount,
      state_revision: String(intent.stateRevision), lease_owner: null, lease_expires_at_ms: null,
      last_reason_code: intent.lastReasonCode, terminal_at_ms: nullableText(intent.terminalAtMs),
      reconciliation_completed_at_ms: nullableText(intent.reconciliationCompletedAtMs),
      purge_after_ms: nullableText(intent.purgeAfterMs), created_at_ms: String(intent.createdAtMs),
      updated_at_ms: String(intent.updatedAtMs) }),
    Object.freeze({ artifact_id: simulation.artifactId, payload_version: simulation.payloadVersion,
      specification_version: simulation.specificationVersion,
      evaluator_version: simulation.evaluatorVersion, intent_id: simulation.intentId,
      attempt_number: simulation.attemptNumber,
      intent_state_revision: String(simulation.intentStateRevision), strategy_id: simulation.strategyId,
      strategy_version: simulation.strategyVersion, decision_fingerprint: simulation.decisionFingerprint,
      result_kind: simulation.resultKind, effective_venue: simulation.effectiveVenue,
      provider_id: simulation.providerId, executor_public_key: simulation.executorPublicKey,
      expected_genesis_hash: simulation.expectedGenesisHash,
      observed_genesis_hash: simulation.observedGenesisHash,
      configuration_fingerprint: simulation.configurationFingerprint,
      quote_fingerprint: simulation.quoteFingerprint, snapshot_fingerprint: simulation.snapshotFingerprint,
      build_fingerprint: simulation.buildFingerprint, message_hash: simulation.messageHash,
      blockhash: simulation.blockhash, last_valid_block_height: bigintText(simulation.lastValidBlockHeight),
      blockhash_context_slot: bigintText(simulation.blockhashContextSlot),
      snapshot_slot: bigintText(simulation.snapshotSlot), fee_context_slot: bigintText(simulation.feeContextSlot),
      simulation_slot: bigintText(simulation.simulationSlot), amount_in_raw: bigintText(simulation.amountInRaw),
      expected_amount_out_raw: bigintText(simulation.expectedAmountOutRaw),
      protected_amount_out_raw: bigintText(simulation.protectedAmountOutRaw),
      fees_raw: bigintText(simulation.feesRaw),
      estimated_fee_lamports: bigintText(simulation.estimatedFeeLamports),
      simulated_fee_payer_lamport_debit: bigintText(simulation.simulatedFeePayerLamportDebit),
      units_consumed: bigintText(simulation.unitsConsumed),
      simulated_base_delta_raw: bigintText(simulation.simulatedBaseDeltaRaw),
      simulated_quote_delta_raw: bigintText(simulation.simulatedQuoteDeltaRaw),
      rpc_calls_used: simulation.rpcCallsUsed, rpc_calls_limit: simulation.rpcCallsLimit,
      quote_status: simulation.quoteStatus, build_status: simulation.buildStatus,
      simulation_status: simulation.simulationStatus, failure_stage: simulation.failureStage,
      failure_code: simulation.failureCode, terminal_reason_code: simulation.terminalReasonCode,
      logs_fingerprint: simulation.logsFingerprint, logs_line_count: simulation.logsLineCount,
      result_fingerprint: simulation.resultFingerprint, recorded_at_ms: String(simulation.recordedAtMs) }),
  ];
}
function bigintText(value: unknown): string | null { return typeof value === 'bigint' ? String(value) : null; }
function nullableText(value: number | null): string | null { return value === null ? null : String(value); }

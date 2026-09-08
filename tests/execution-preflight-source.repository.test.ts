import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { EXECUTION_PREFLIGHT_SOURCE_RESTRICTED_COLUMNS } from '../src/preflight-source/database.js';
import {
  ExecutionPreflightSourceRepositoryError,
  PostgresExecutionPreflightSourceRepository,
} from '../src/preflight-source/repository.js';
import { migrateDatabase } from '../src/storage/database.js';
import { preflightDraftInputs } from './helpers/execution-preflight-draft-fixture.js';
import {
  mutateWithTriggersDisabled,
  seedCanonicalV2Source,
} from './helpers/execution-preflight-v2-source-fixture.js';

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
  const exported = await repository.export({
    preparationRunId: input.source.lineage.preparationRunId,
  });
  assert.deepEqual(exported, input.source);
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(queries.at(-1), 'COMMIT');
  assert.equal(index, 7);
  assert.match(queries[1] ?? '', /target\.candidate_id/u);
  assert.match(queries[1] ?? '', /candidate\.confirmation_status='finalized'/u);
  assert.match(queries[1] ?? '', /source_raw\.confirmation_status='finalized'/u);
  assert.match(queries[1] ?? '', /decision\.confirmation_status='finalized'/u);
});

void test('bounds the exported proof expiry by candidate eligibility and retention', async () => {
  const input = preflightDraftInputs();
  const rows = rowsFrom(input.source);
  const candidateExpiryMs = input.source.capturedAtMs + 10_000;
  rows[0] = Object.freeze({ ...rows[0],
    candidate_eligible_until_ms: String(candidateExpiryMs),
    candidate_purge_after_ms: String(candidateExpiryMs + 1_000),
  });
  let index = 0;
  const repository = new PostgresExecutionPreflightSourceRepository({ connect: async () => ({
    query: async (sql) => {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rows: [], rowCount: null };
      const row = rows[index++];
      if (row === undefined) throw new Error('unexpected query');
      return { rows: [row], rowCount: 1 };
    },
    release() {},
  }) });
  const exported = await repository.export({
    preparationRunId: input.source.lineage.preparationRunId,
  });
  assert.equal(exported.expiresAtMs, candidateExpiryMs);
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
  await assert.rejects(repository.export({
    preparationRunId: input.source.lineage.preparationRunId,
  }), (error: unknown) =>
    error instanceof ExecutionPreflightSourceRepositoryError
    && error.code === 'EXECUTION_PREFLIGHT_SOURCE_READ_FAILED'
    && !error.message.includes('secret'));
  assert.equal(queries.at(-1), 'ROLLBACK');
});

void test('exports and rejects altered H2h v2 lineage on PostgreSQL 16', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: H2h v2 PostgreSQL 16 integration skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = await seedCanonicalV2Source(pool);
    const schema = (await pool.query<{ schema: string }>(
      'SELECT current_schema() AS schema',
    )).rows[0]?.schema;
    if (schema === undefined) throw new TypeError();
    const role = `h2h_v2_reader_${randomUUID().replaceAll('-', '')}`;
    await provisionRestrictedSourceRole(pool, role, schema);
    const restrictedPool = new pg.Pool({ connectionString: databaseUrl,
      options: `-c search_path="${schema}"`, max: 2 });
    const observations: string[] = [];
    try {
      const restrictedCheck = await restrictedPool.connect();
      try {
        await restrictedCheck.query(`SET ROLE "${role}"`);
        await restrictedCheck.query(`SELECT run_id
          FROM execution_preflight_intent_preparation_runs WHERE run_id=$1`, [fixture.runId]);
        await assert.rejects(restrictedCheck.query(`UPDATE trading_candidates SET state='REVOKED'
          WHERE candidate_id=$1`, [fixture.candidateId]), (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error && error.code === '42501');
      } finally { restrictedCheck.release(); }
      const repository = new PostgresExecutionPreflightSourceRepository({
        connect: async () => {
          const client = await restrictedPool.connect();
          await client.query(`SET ROLE "${role}"`);
          return {
            query: async (text: string, values?: readonly unknown[]) => {
              const result = values === undefined
                ? await client.query(text)
                : await client.query(text, [...values]);
              if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
                const settings = await client.query<{
                  transaction_isolation: string;
                  transaction_read_only: string;
                  server_version_num: string;
                  current_role: string;
                }>(`SELECT current_setting('transaction_isolation') AS transaction_isolation,
                  current_setting('transaction_read_only') AS transaction_read_only,
                  current_setting('server_version_num') AS server_version_num,
                  current_user AS current_role`);
                const row = settings.rows[0];
                if (row !== undefined) observations.push(row.transaction_isolation,
                  row.transaction_read_only, row.server_version_num, row.current_role);
              }
              return result;
            },
            release: () => { client.release(); },
          };
        },
      });
      const request = Object.freeze({ preparationRunId: fixture.runId });
      const exported = await repository.export(request);
      assert.equal(exported.schemaVersion, 'execution-preflight-draft-source.v2');
      assert.equal(exported.lineage.preparationRunId, fixture.runId);
      assert.equal(exported.target.intent.id, fixture.targetIntentId);
      assert.equal(exported.simulation.intentId, fixture.simulationIntentId);
      assert.deepEqual(observations.slice(0, 2), ['repeatable read', 'on']);
      assert.equal(observations[3], role);
      const serverVersion = Number(observations[2]);
      assert.equal(Number.isSafeInteger(serverVersion)
        && serverVersion >= 160_000 && serverVersion < 170_000, true);

      const mutations: readonly Readonly<{
        apply: string;
        restore: string;
        value: string;
        restoreValue?: string | Date;
      }>[] = [
        Object.freeze({
          apply: `UPDATE trading_candidates SET confirmation_status='orphaned'
            WHERE candidate_id=$1`,
          restore: `UPDATE trading_candidates SET confirmation_status='finalized'
            WHERE candidate_id=$1`,
          value: fixture.candidateId,
        }),
        Object.freeze({
          apply: `UPDATE execution_preflight_intent_preparation_runs
            SET artifact_fingerprint=repeat('f',64) WHERE run_id=$1`,
          restore: `UPDATE execution_preflight_intent_preparation_runs
            SET artifact_fingerprint=$2 WHERE run_id=$1`,
          value: fixture.runId,
          restoreValue: fixture.artifactFingerprint,
        }),
        Object.freeze({
          apply: `UPDATE execution_preflight_intent_pairs
            SET expires_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 second'
            WHERE pair_id=$1`,
          restore: `UPDATE execution_preflight_intent_pairs SET expires_at=$2 WHERE pair_id=$1`,
          value: fixture.pairId,
          restoreValue: new Date(fixture.expiresAtMs),
        }),
      ];
      for (const mutation of mutations) {
        await mutateWithTriggersDisabled(pool, mutation.apply, [mutation.value]);
        await assert.rejects(repository.export(request), ExecutionPreflightSourceRepositoryError);
        await mutateWithTriggersDisabled(pool, mutation.restore,
          mutation.restoreValue === undefined
            ? [mutation.value]
            : [mutation.value, mutation.restoreValue]);
        assert.equal((await repository.export(request)).lineage.preparationRunId, fixture.runId);
      }
    } finally {
      await restrictedPool.end();
      await pool.query(`DROP OWNED BY "${role}"`);
      await pool.query(`DROP ROLE "${role}"`);
    }
  });
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
    Object.freeze({
      run_id: source.lineage.preparationRunId,
      run_fingerprint: source.lineage.preparationRunFingerprint,
      run_state: 'PREPARED',
      manifest_fingerprint: source.lineage.preparationManifestFingerprint,
      run_expires_at_ms: String(source.expiresAtMs),
      pair_id: source.lineage.pairId,
      pair_fingerprint: source.lineage.pairFingerprint,
      target_intent_id: source.target.intent.id,
      simulation_intent_id: source.simulation.intentId,
      pair_expires_at_ms: String(source.expiresAtMs),
      assessment_id: source.lineage.targetAssessmentId,
      assessment_fingerprint: source.lineage.targetAssessmentFingerprint,
      artifact_id: source.simulation.artifactId,
      artifact_fingerprint: source.simulation.resultFingerprint,
      simulation_attempt_number: 1,
      candidate_id: source.lineage.candidateId,
      candidate_evidence_fingerprint: source.lineage.candidateEvidenceFingerprint,
      candidate_confirmation_status: source.lineage.candidateConfirmationStatus,
      candidate_eligible_until_ms: String(source.expiresAtMs),
      candidate_purge_after_ms: String(source.expiresAtMs),
      generation_id: source.generation.generationId,
    }),
    Object.freeze({ database_now_ms: String(source.capturedAtMs) }),
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
      candidate_id: intent.candidateId,
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


async function provisionRestrictedSourceRole(
  pool: InstanceType<typeof pg.Pool>,
  role: string,
  schema: string,
): Promise<void> {
  if (!/^[a-z0-9_]+$/u.test(role) || !/^[a-z0-9_]+$/u.test(schema)) throw new TypeError();
  await pool.query(`CREATE ROLE "${role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
    NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  for (const table of [
    'execution_wallet_generations', 'execution_wallet_snapshots',
    'execution_provider_usage_snapshots', 'execution_simulation_artifacts',
  ]) await pool.query(`GRANT SELECT ON TABLE "${schema}"."${table}" TO "${role}"`);
  for (const [table, columns] of Object.entries(EXECUTION_PREFLIGHT_SOURCE_RESTRICTED_COLUMNS)) {
    await pool.query(`GRANT SELECT (${columns.map((column) => `"${column}"`).join(',')})
      ON TABLE "${schema}"."${table}" TO "${role}"`);
  }
}

async function withTemporarySchema(
  databaseUrl: string,
  run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `h2h_v2_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString: databaseUrl,
    options: `-c search_path="${schema}"` });
  try {
    await migrateDatabase({ pool });
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

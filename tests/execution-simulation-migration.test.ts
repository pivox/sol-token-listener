import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '033_execution_simulation_artifacts.sql';
const latestMigrationName = '035_execution_preflight_operations.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);
const migrationsUrl = new URL('../migrations/', import.meta.url);
const hash = 'a'.repeat(64);
const publicKey = '11111111111111111111111111111111';

void test('simulation artifact migration defines the closed non-signable contract', async () => {
  const sql = withoutSqlComments(await readFile(migrationUrl, 'utf8'));
  const definition = /CREATE TABLE IF NOT EXISTS execution_simulation_artifacts \(([\s\S]*?)\);/u
    .exec(sql)?.[1];
  assert.ok(definition !== undefined);

  for (const column of [
    'artifact_id TEXT PRIMARY KEY', 'payload_version SMALLINT NOT NULL DEFAULT 1',
    "specification_version TEXT NOT NULL DEFAULT '1.5.0'",
    'evaluator_version INTEGER NOT NULL DEFAULT 1', 'intent_id TEXT NOT NULL',
    'attempt_number INTEGER NOT NULL', 'intent_state_revision BIGINT NOT NULL',
    'strategy_id TEXT NOT NULL', 'strategy_version INTEGER NOT NULL',
    'decision_fingerprint TEXT NOT NULL', 'result_kind TEXT NOT NULL',
    'effective_venue TEXT', 'provider_id TEXT NOT NULL', 'executor_public_key TEXT NOT NULL',
    'expected_genesis_hash TEXT NOT NULL', 'observed_genesis_hash TEXT',
    'configuration_fingerprint TEXT NOT NULL', 'quote_fingerprint TEXT',
    'snapshot_fingerprint TEXT', 'build_fingerprint TEXT', 'message_hash TEXT',
    'blockhash TEXT', 'last_valid_block_height BIGINT', 'blockhash_context_slot BIGINT',
    'snapshot_slot BIGINT', 'fee_context_slot BIGINT', 'simulation_slot BIGINT',
    'amount_in_raw NUMERIC', 'expected_amount_out_raw NUMERIC',
    'protected_amount_out_raw NUMERIC', 'fees_raw NUMERIC',
    'estimated_fee_lamports NUMERIC', 'simulated_fee_payer_lamport_debit NUMERIC',
    'units_consumed BIGINT', 'simulated_base_delta_raw NUMERIC',
    'simulated_quote_delta_raw NUMERIC', 'rpc_calls_used INTEGER NOT NULL',
    'rpc_calls_limit INTEGER NOT NULL', 'quote_status TEXT NOT NULL',
    'build_status TEXT NOT NULL', 'simulation_status TEXT NOT NULL',
    'failure_stage TEXT', 'failure_code TEXT', 'terminal_reason_code TEXT NOT NULL',
    'logs_fingerprint TEXT', 'logs_line_count INTEGER', 'result_fingerprint TEXT NOT NULL',
  ]) assert.match(definition, new RegExp(column.replaceAll(' ', '\\s+'), 'u'));

  assert.match(definition, /recorded_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+date_trunc\('milliseconds',\s*statement_timestamp\(\)\)/u);
  assert.doesNotMatch(definition, /NUMERIC\s*\(/u);
  assert.match(definition, /UNIQUE\s*\(intent_id,\s*attempt_number\)/u);
  assert.match(definition, /FOREIGN KEY\s*\(intent_id,\s*attempt_number\)\s*REFERENCES execution_attempts\s*\(intent_id,\s*attempt_number\)\s*ON DELETE CASCADE/u);
  assert.match(definition, /FOREIGN KEY\s*\(\s*intent_id,\s*strategy_id,\s*strategy_version,\s*decision_fingerprint\s*\)\s*REFERENCES execution_intents\s*\(\s*id,\s*strategy_id,\s*strategy_version,\s*decision_fingerprint\s*\)\s*ON DELETE CASCADE/u);
  assert.match(definition, /failure_code IS NULL OR failure_code IN \([\s\S]*?'GENESIS_MISMATCH'/u);

  for (const amount of [
    'amount_in_raw', 'expected_amount_out_raw', 'protected_amount_out_raw', 'fees_raw',
    'estimated_fee_lamports', 'simulated_fee_payer_lamport_debit',
  ]) {
    assert.match(definition, new RegExp(`${amount} <> 'NaN'::NUMERIC`, 'u'));
    assert.match(definition, new RegExp(`${amount} = trunc\\(${amount}\\)`, 'u'));
    assert.match(definition, new RegExp(`scale\\(${amount}\\) = 0`, 'u'));
    assert.match(definition, new RegExp(`${amount} < 18446744073709551616`, 'u'));
  }
  for (const delta of ['simulated_base_delta_raw', 'simulated_quote_delta_raw']) {
    assert.match(definition, new RegExp(`${delta} <> 'NaN'::NUMERIC`, 'u'));
    assert.match(definition, new RegExp(`${delta} = trunc\\(${delta}\\)`, 'u'));
    assert.match(definition, new RegExp(`scale\\(${delta}\\) = 0`, 'u'));
    assert.match(definition, new RegExp(`${delta} BETWEEN -18446744073709551615 AND 18446744073709551615`, 'u'));
  }
  for (const forbidden of [
    'transaction_bytes', 'message_bytes', 'instruction_bytes', 'signature', 'secret',
    'rpc_url', 'rpc_headers', 'raw_logs', 'sdk_payload', 'payload_json',
  ]) assert.doesNotMatch(definition, new RegExp(`\\b${forbidden}\\b`, 'u'));
  assert.match(sql, /CREATE TRIGGER execution_simulation_artifacts_reject_update/u);
  assert.match(sql, /RAISE EXCEPTION 'execution_simulation_artifacts is append-only'/u);
});

void test('migration extends only the three closed reason constraints append-only', async () => {
  const sql = withoutSqlComments(await readFile(migrationUrl, 'utf8'));
  for (const [table, constraint] of [
    ['execution_intents', 'execution_intents_reason_check'],
    ['execution_attempts', 'execution_attempts_reason_check'],
    ['execution_intent_transitions', 'execution_intent_transitions_reason_check'],
  ] as const) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table}\\s+DROP CONSTRAINT IF EXISTS ${constraint}`, 'u'));
    assert.match(sql, new RegExp(`ALTER TABLE ${table}\\s+ADD CONSTRAINT ${constraint}`, 'u'));
  }
  for (const reason of [
    'EXECUTION_PROVIDER_FAILED', 'EXECUTION_BUILD_FAILED', 'EXECUTION_EVIDENCE_INVALID',
  ]) assert.equal((sql.match(new RegExp(`'${reason}'`, 'gu')) ?? []).length >= 4, true);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN)|ALTER\s+COLUMN|UPDATE\s+execution_/iu);
});

void test('simulation artifact migration applies on empty/032 upgrade and replays safely', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution simulation migration apply test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_simulation_apply', async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), latestMigrationName);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await pool.query(await readFile(migrationUrl, 'utf8'));
  });

  const priorNames = (await readdir(migrationsUrl))
    .filter((name) => /^(?:00[1-9]|0[12][0-9]|03[0-2])_[a-z0-9_-]+\.sql$/u.test(name))
    .sort();
  await withTemporarySchema(databaseUrl, 'execution_simulation_upgrade', async (pool) => {
    await pool.query('CREATE TABLE migration_history (version TEXT PRIMARY KEY)');
    for (const name of priorNames) {
      await pool.query(await readFile(new URL(name, migrationsUrl), 'utf8'));
      await pool.query('INSERT INTO migration_history(version) VALUES ($1)', [name]);
    }
    const parent = parentDraft('upgrade');
    await insertParentAndAttempt(pool, parent);
    assert.deepEqual(await migrateDatabase({ pool }), [
      migrationName,
      '034_execution_risk_reconciliation.sql',
      latestMigrationName,
    ]);
    assert.equal((await pool.query('SELECT id FROM execution_intents WHERE id=$1', [parent.id])).rowCount, 1);
  });
});

void test('simulation artifacts enforce catalogue identity, cascade and append-only updates', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution simulation catalogue test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_simulation_catalogue', async (pool) => {
    await migrateDatabase({ pool });
    const parent = parentDraft('catalogue');
    await insertParentAndAttempt(pool, parent);
    await insertArtifact(pool, successArtifact(parent));

    const columns = await pool.query<{ readonly column_name: string; readonly data_type: string }>(`SELECT column_name,data_type
      FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='execution_simulation_artifacts' ORDER BY ordinal_position`);
    assert.equal(columns.rows.length, 48);
    for (const numeric of [
      'amount_in_raw', 'expected_amount_out_raw', 'protected_amount_out_raw', 'fees_raw',
      'estimated_fee_lamports', 'simulated_fee_payer_lamport_debit',
      'simulated_base_delta_raw', 'simulated_quote_delta_raw',
    ]) assert.deepEqual(columns.rows.find((row) => row.column_name === numeric), {
      column_name: numeric, data_type: 'numeric',
    });

    const foreignKeys = await pool.query<{ readonly definition: string }>(`SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      WHERE t.relnamespace=current_schema()::regnamespace
        AND t.relname='execution_simulation_artifacts' AND c.contype='f' ORDER BY c.conname`);
    assert.deepEqual(foreignKeys.rows.map(({ definition }) => definition), [
      'FOREIGN KEY (intent_id, attempt_number) REFERENCES execution_attempts(intent_id, attempt_number) ON DELETE CASCADE',
      'FOREIGN KEY (intent_id, strategy_id, strategy_version, decision_fingerprint) REFERENCES execution_intents(id, strategy_id, strategy_version, decision_fingerprint) ON DELETE CASCADE',
    ]);
    await assert.rejects(pool.query(`UPDATE execution_simulation_artifacts SET provider_id='other'`), /append-only/u);
    await pool.query('DELETE FROM execution_intents WHERE id=$1', [parent.id]);
    assert.equal((await pool.query('SELECT * FROM execution_simulation_artifacts')).rowCount, 0);
  });
});

void test('simulation artifact SQL closes every result shape and numeric boundary', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution simulation invariant test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_simulation_invariants', async (pool) => {
    await migrateDatabase({ pool });
    const validRows = [providerFailure, genesisMismatch, quoteFailure, buildFailure, blockhashFailure,
      feeFailure, simulationFailure, successArtifact];
    for (const [index, create] of validRows.entries()) {
      const parent = parentDraft(`valid-${index}`);
      await insertParentAndAttempt(pool, parent);
      await insertArtifact(pool, create(parent));
    }

    const invalid: readonly Partial<Artifact>[] = [
      { amountInRaw: '1.5' }, { feesRaw: 'NaN' },
      { estimatedFeeLamports: '18446744073709551616' },
      { simulatedBaseDeltaRaw: '-18446744073709551616' },
      { quoteStatus: 'FAILED' }, { failureStage: 'BUILD' },
      { buildFingerprint: null }, { protectedAmountOutRaw: '901' },
      { snapshotSlot: '901', blockhashContextSlot: '900' },
      { blockhashContextSlot: '902', simulationSlot: '901' },
      { logsLineCount: null }, { simulatedQuoteDeltaRaw: null },
      { unitsConsumed: '0' }, { resultFingerprint: 'A'.repeat(64) }, { rpcCallsUsed: 9 },
    ];
    for (const [index, overrides] of invalid.entries()) {
      const parent = parentDraft(`invalid-${index}`);
      await insertParentAndAttempt(pool, parent);
      await assert.rejects(insertArtifact(pool, { ...successArtifact(parent), ...overrides }));
    }

    for (const [index, create] of [
      (parent: Parent) => ({ ...genesisMismatch(parent), observedGenesisHash: null }),
      (parent: Parent) => ({ ...genesisMismatch(parent), observedGenesisHash: publicKey }),
      (parent: Parent) => ({
        ...quoteFailure(parent), observedGenesisHash: parent.quoteMint,
        failureCode: 'GENESIS_MISMATCH', terminalReasonCode: 'GENESIS_MISMATCH',
      }),
    ].entries()) {
      const parent = parentDraft(`invalid-genesis-mismatch-${index}`);
      await insertParentAndAttempt(pool, parent);
      await assert.rejects(insertArtifact(pool, create(parent)));
    }
  });
});

void test('new terminal reasons remain valid only in existing negative lifecycle positions', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution simulation reason test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_simulation_reasons', async (pool) => {
    await migrateDatabase({ pool });
    for (const [index, reason] of [
      'EXECUTION_PROVIDER_FAILED', 'EXECUTION_BUILD_FAILED', 'EXECUTION_EVIDENCE_INVALID',
    ].entries()) {
      const parent = parentDraft(`reason-${index}`);
      await insertParentAndAttempt(pool, parent);
      await pool.query(`UPDATE execution_attempts SET status='ABANDONED',completed_at=to_timestamp(0),reason_code=$2
        WHERE intent_id=$1 AND attempt_number=1`, [parent.id, reason]);
      await pool.query(`UPDATE execution_intents SET status='FAILED',last_reason_code=$2,
        terminal_at=to_timestamp(0),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        updated_at=to_timestamp(0) WHERE id=$1`, [parent.id, reason]);
      await pool.query(`INSERT INTO execution_intent_transitions (
        intent_id,previous_status,next_status,reason_code,human_message,activation_phase,
        attempt_number,evidence,occurred_at
      ) VALUES ($1,'PROCESSING','FAILED',$2,'terminal simulation failure','NONE',1,
        '{"payloadVersion":1,"attemptNumber":1,"sourceEventId":null,"observedAtMs":0}'::JSONB,
        to_timestamp(0))`, [parent.id, reason]);
    }
    const parent = parentDraft('positive-reason');
    await insertParentAndAttempt(pool, parent);
    await assert.rejects(pool.query(`UPDATE execution_attempts SET status='COMPLETED',completed_at=to_timestamp(0),
      reason_code='EXECUTION_PROVIDER_FAILED' WHERE intent_id=$1`, [parent.id]));
  });
});

type Parent = ReturnType<typeof createExecutionIntentDraft>;
type Artifact = Readonly<{
  artifactId: string; payloadVersion: number; specificationVersion: string; evaluatorVersion: number;
  intentId: string; attemptNumber: number; intentStateRevision: string; strategyId: string;
  strategyVersion: number; decisionFingerprint: string; resultKind: string;
  effectiveVenue: string | null; providerId: string; executorPublicKey: string;
  expectedGenesisHash: string; observedGenesisHash: string | null; configurationFingerprint: string;
  quoteFingerprint: string | null; snapshotFingerprint: string | null; buildFingerprint: string | null;
  messageHash: string | null; blockhash: string | null; lastValidBlockHeight: string | null;
  blockhashContextSlot: string | null; snapshotSlot: string | null; feeContextSlot: string | null;
  simulationSlot: string | null; amountInRaw: string | null; expectedAmountOutRaw: string | null;
  protectedAmountOutRaw: string | null; feesRaw: string | null; estimatedFeeLamports: string | null;
  simulatedFeePayerLamportDebit: string | null; unitsConsumed: string | null;
  simulatedBaseDeltaRaw: string | null; simulatedQuoteDeltaRaw: string | null;
  rpcCallsUsed: number; rpcCallsLimit: number; quoteStatus: string; buildStatus: string;
  simulationStatus: string; failureStage: string | null; failureCode: string | null;
  terminalReasonCode: string; logsFingerprint: string | null; logsLineCount: number | null;
  resultFingerprint: string; recordedAt: string;
}>;

function parentDraft(logicalCommandId: string): Parent {
  return createExecutionIntentDraft({
    strategyId: 'execution-simulation', strategyVersion: 1,
    positionId: `position-${logicalCommandId}`, logicalCommandId,
    mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: 1n,
    baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: `event-${logicalCommandId}`, decisionFingerprint: hash,
    requestedAtMs: 0, expiresAtMs: 1_000,
  });
}

async function insertParentAndAttempt(pool: InstanceType<typeof pg.Pool>, parent: Parent): Promise<void> {
  await pool.query(`INSERT INTO execution_intents (
    id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,
    logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,quote_decimals,
    quote_amount_raw,base_amount_raw,minimum_amount_out_raw,decision_event_id,
    decision_fingerprint,requested_at,expires_at,status,attempt_count,state_revision,
    lease_owner,lease_token,lease_expires_at,last_reason_code,created_at,updated_at
  ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,'BUY','PUMP_FUN_ONLY',$8,'SPL_TOKEN',9,1,NULL,1,$9,$10,
    to_timestamp(0),to_timestamp(1),'PROCESSING',1,1,'worker',
    '00000000-0000-4000-8000-000000000001',to_timestamp(0.5),'EXECUTION_STARTED',
    to_timestamp(0),to_timestamp(0))`, [
    parent.id,parent.logicalOrderKey,parent.strategyId,parent.strategyVersion,parent.positionId,
    parent.logicalCommandId,parent.mint,parent.quoteMint,parent.decisionEventId,parent.decisionFingerprint,
  ]);
  await pool.query(`INSERT INTO execution_attempts (intent_id,attempt_number,status,started_at)
    VALUES ($1,1,'STARTED',to_timestamp(0))`, [parent.id]);
}

function successArtifact(parent: Parent): Artifact {
  return baseArtifact(parent);
}

function providerFailure(parent: Parent): Artifact {
  return {
    ...baseArtifact(parent), resultKind: 'PROVIDER_FAILED', effectiveVenue: null,
    observedGenesisHash: null, quoteFingerprint: null, snapshotFingerprint: null,
    buildFingerprint: null, messageHash: null, blockhash: null, lastValidBlockHeight: null,
    blockhashContextSlot: null, snapshotSlot: null, feeContextSlot: null,
    simulationSlot: null, amountInRaw: null, expectedAmountOutRaw: null,
    protectedAmountOutRaw: null, feesRaw: null, estimatedFeeLamports: null,
    simulatedFeePayerLamportDebit: null, unitsConsumed: null,
    simulatedBaseDeltaRaw: null, simulatedQuoteDeltaRaw: null,
    rpcCallsUsed: 1, quoteStatus: 'FAILED', buildStatus: 'NOT_RUN',
    simulationStatus: 'NOT_RUN', failureStage: 'PROVIDER', failureCode: 'RPC_UNAVAILABLE',
    terminalReasonCode: 'EXECUTION_PROVIDER_FAILED', logsFingerprint: null, logsLineCount: null,
  };
}

function genesisMismatch(parent: Parent): Artifact {
  return {
    ...providerFailure(parent), observedGenesisHash: parent.quoteMint,
    failureCode: 'GENESIS_MISMATCH', terminalReasonCode: 'GENESIS_MISMATCH',
  };
}

function quoteFailure(parent: Parent): Artifact {
  return {
    ...providerFailure(parent), resultKind: 'QUOTE_FAILED', effectiveVenue: 'PUMP_FUN',
    observedGenesisHash: publicKey, snapshotFingerprint: hash, snapshotSlot: '899',
    failureStage: 'QUOTE', failureCode: 'QUOTE_REJECTED', terminalReasonCode: 'QUOTE_STALE',
  };
}

function buildFailure(parent: Parent): Artifact {
  return {
    ...baseArtifact(parent), resultKind: 'BUILD_FAILED', buildFingerprint: null,
    messageHash: null, blockhash: null, lastValidBlockHeight: null,
    blockhashContextSlot: null, feeContextSlot: null, simulationSlot: null,
    estimatedFeeLamports: null, simulatedFeePayerLamportDebit: null, unitsConsumed: null,
    simulatedBaseDeltaRaw: null, simulatedQuoteDeltaRaw: null,
    buildStatus: 'FAILED', simulationStatus: 'NOT_RUN', failureStage: 'BUILD',
    failureCode: 'BUILD_POLICY_REJECTED', terminalReasonCode: 'EXECUTION_BUILD_FAILED',
    logsFingerprint: null, logsLineCount: null,
  };
}

function blockhashFailure(parent: Parent): Artifact {
  return {
    ...buildFailure(parent), resultKind: 'BLOCKHASH_FAILED', buildFingerprint: hash,
    buildStatus: 'SUCCEEDED', failureStage: 'BLOCKHASH', failureCode: 'RPC_TIMEOUT',
    terminalReasonCode: 'EXECUTION_PROVIDER_FAILED',
  };
}

function feeFailure(parent: Parent): Artifact {
  return {
    ...blockhashFailure(parent), resultKind: 'FEE_FAILED', messageHash: hash,
    blockhash: publicKey, lastValidBlockHeight: '1000', blockhashContextSlot: '900',
    failureStage: 'FEE', failureCode: 'RPC_RESPONSE_INVALID',
    terminalReasonCode: 'EXECUTION_EVIDENCE_INVALID',
  };
}

function simulationFailure(parent: Parent): Artifact {
  return {
    ...baseArtifact(parent), resultKind: 'SIMULATION_FAILED', simulationStatus: 'FAILED',
    failureStage: 'SIMULATION', failureCode: 'SIMULATION_PROGRAM_ERROR',
    terminalReasonCode: 'BUY_SIMULATION_FAILED', simulationSlot: null,
    simulatedFeePayerLamportDebit: null, unitsConsumed: null,
    simulatedBaseDeltaRaw: null, simulatedQuoteDeltaRaw: null,
    logsFingerprint: null, logsLineCount: null,
  };
}

function baseArtifact(parent: Parent): Artifact {
  const identity = parent.id.slice('execution_intent_'.length);
  return {
    artifactId: `execution_simulation_artifact_${identity}`, payloadVersion: 1,
    specificationVersion: '1.5.0', evaluatorVersion: 1, intentId: parent.id,
    attemptNumber: 1, intentStateRevision: '1', strategyId: parent.strategyId,
    strategyVersion: parent.strategyVersion, decisionFingerprint: parent.decisionFingerprint,
    resultKind: 'SUCCESS', effectiveVenue: 'PUMP_FUN', providerId: 'primary',
    executorPublicKey: publicKey, expectedGenesisHash: publicKey,
    observedGenesisHash: publicKey, configurationFingerprint: hash,
    quoteFingerprint: hash, snapshotFingerprint: hash, buildFingerprint: hash,
    messageHash: hash, blockhash: publicKey, lastValidBlockHeight: '1000',
    blockhashContextSlot: '900', snapshotSlot: '899', feeContextSlot: '900',
    simulationSlot: '901', amountInRaw: '1000', expectedAmountOutRaw: '900',
    protectedAmountOutRaw: '850', feesRaw: '10', estimatedFeeLamports: '5000',
    simulatedFeePayerLamportDebit: '6000', unitsConsumed: '200000',
    simulatedBaseDeltaRaw: '900', simulatedQuoteDeltaRaw: '-1000',
    rpcCallsUsed: 5, rpcCallsLimit: 8, quoteStatus: 'SUCCEEDED',
    buildStatus: 'SUCCEEDED', simulationStatus: 'SUCCEEDED', failureStage: null,
    failureCode: null, terminalReasonCode: 'INTENT_SUCCEEDED', logsFingerprint: hash,
    logsLineCount: 1, resultFingerprint: hash, recordedAt: '1970-01-01T00:00:00.000Z',
  };
}

async function insertArtifact(pool: InstanceType<typeof pg.Pool>, row: Artifact): Promise<void> {
  await pool.query(`INSERT INTO execution_simulation_artifacts (
    artifact_id,payload_version,specification_version,evaluator_version,intent_id,
    attempt_number,intent_state_revision,strategy_id,strategy_version,decision_fingerprint,
    result_kind,effective_venue,provider_id,executor_public_key,expected_genesis_hash,
    observed_genesis_hash,configuration_fingerprint,quote_fingerprint,snapshot_fingerprint,
    build_fingerprint,message_hash,blockhash,last_valid_block_height,blockhash_context_slot,
    snapshot_slot,fee_context_slot,simulation_slot,amount_in_raw,expected_amount_out_raw,
    protected_amount_out_raw,fees_raw,estimated_fee_lamports,simulated_fee_payer_lamport_debit,
    units_consumed,simulated_base_delta_raw,simulated_quote_delta_raw,rpc_calls_used,
    rpc_calls_limit,quote_status,build_status,simulation_status,failure_stage,failure_code,
    terminal_reason_code,logs_fingerprint,logs_line_count,result_fingerprint,recorded_at
  ) VALUES (${Array.from({ length: 48 }, (_, index) => `$${index + 1}`).join(',')})`, [
    row.artifactId,row.payloadVersion,row.specificationVersion,row.evaluatorVersion,row.intentId,
    row.attemptNumber,row.intentStateRevision,row.strategyId,row.strategyVersion,row.decisionFingerprint,
    row.resultKind,row.effectiveVenue,row.providerId,row.executorPublicKey,row.expectedGenesisHash,
    row.observedGenesisHash,row.configurationFingerprint,row.quoteFingerprint,row.snapshotFingerprint,
    row.buildFingerprint,row.messageHash,row.blockhash,row.lastValidBlockHeight,row.blockhashContextSlot,
    row.snapshotSlot,row.feeContextSlot,row.simulationSlot,row.amountInRaw,row.expectedAmountOutRaw,
    row.protectedAmountOutRaw,row.feesRaw,row.estimatedFeeLamports,row.simulatedFeePayerLamportDebit,
    row.unitsConsumed,row.simulatedBaseDeltaRaw,row.simulatedQuoteDeltaRaw,row.rpcCallsUsed,
    row.rpcCallsLimit,row.quoteStatus,row.buildStatus,row.simulationStatus,row.failureStage,row.failureCode,
    row.terminalReasonCode,row.logsFingerprint,row.logsLineCount,row.resultFingerprint,row.recordedAt,
  ]);
}

function testDatabaseUrl(context: Readonly<{ skip(message?: string): void }>, label: string): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip(`TEST_DATABASE_URL absent: ${label} skipped`);
  return null;
}

async function withTemporarySchema(
  databaseUrl: string,
  prefix: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1,
    options: `-c search_path=${quoteIdentifier(schema)}` });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`); created = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`); await callback(pool);
  } finally {
    try { await pool.end(); } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally { await admin.end(); }
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}

function withoutSqlComments(sql: string): string {
  return sql.replace(/--[^\r\n]*/gu, ' ').replace(/\/\*[\s\S]*?\*\//gu, ' ');
}

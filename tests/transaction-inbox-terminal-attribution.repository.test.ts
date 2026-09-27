import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { captureMainnetTerminalAttribution } from '../scripts/capture-mainnet-terminal-attribution.js';
import { createCatchUpClassification } from '../src/domain/catch-up-classification.js';
import { registerTrustedTerminalAttribution, registerTrustedTerminalAttributionContext } from '../src/domain/terminal-attribution.js';
import type { IngestionFailure, TransactionNotification } from '../src/domain/transaction-ingestion.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import { PostgresTransactionInboxRepository } from '../src/storage/transaction-inbox.repository.js';

void test('terminal journal separates worker attempts and survives retry clearing and eventual success', async (context) => {
  await withDatabase(context, async (pool, repository) => {
    await repository.enqueue(notification('retry'));
    const first = await repository.claim(Date.now(), 30);
    assert.ok(first);
    await repository.saveSnapshot('retry', first.leaseToken, transaction('retry'));
    await repository.markFailed('retry', first.leaseToken, failure('retry', true));
    let rows = await occurrences(pool);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.diagnostic_code, 'WALLET_GRAPH_POSTGRES_SERIALIZATION');
    assert.equal(rows[0]?.completeness, 'COMPLETE');
    assert.equal(rows[0]?.stage, 'wallet_graph');
    assert.equal(rows[0]?.occurrence_number, 1);
    const retry = await claimRetry(pool, repository, 'retry');
    assert.equal((await parent(pool, 'retry')).error_code, null);
    await repository.markFailed('retry', retry.leaseToken, failure('retry', false));
    rows = await occurrences(pool);
    assert.deepEqual(rows.map((row) => row.occurrence_number), [1, 2]);
    assert.equal(rows[1]?.completeness, 'UNAVAILABLE');
    assert.equal(rows[1]?.diagnostic_code, 'UNAVAILABLE');
    const last = await claimRetry(pool, repository, 'retry');
    await repository.markProcessed('retry', last.leaseToken, 'confirmed');
    assert.equal((await parent(pool, 'retry')).processing_status, 'PROCESSED');
    assert.equal((await occurrences(pool)).length, 2);
  });
});

void test('real journal SQL rejection commits failure, survives later success and expires only after four hours', async (context) => {
  await withDatabase(context, async (pool, repository) => {
    await pool.query(`ALTER TABLE transaction_inbox_terminal_attributions ADD CONSTRAINT reject_test CHECK (signature<>'reject')`);
    await repository.enqueue(notification('reject'));
    const claim = await repository.claim(Date.now(), 30);
    assert.ok(claim);
    await repository.saveSnapshot('reject', claim.leaseToken, transaction('reject'));
    await repository.markFailed('reject', claim.leaseToken, failure('reject', true));
    const failed = await parent(pool, 'reject');
    assert.equal(failed.processing_status, 'FAILED');
    assert.equal(failed.terminal_attribution_incomplete_count, 1);
    assert.ok(failed.terminal_attribution_incomplete_at instanceof Date);
    assert.equal((await occurrences(pool)).length, 0);
    const retry = await claimRetry(pool, repository, 'reject');
    await repository.markProcessed('reject', retry.leaseToken, 'confirmed');
    assert.equal((await parent(pool, 'reject')).terminal_attribution_incomplete_count, 1);
    const artifact = await capture(pool, repository);
    assert.equal(artifact.currentPopulation.totalRows, 0);
    assert.deepEqual(artifact.incompleteAttribution, { parentRows: 1, missingOccurrences: 1 });
    await purgeExpiredFoundationData(pool);
    assert.equal((await parent(pool, 'reject')).terminal_attribution_incomplete_count, 1);
    await pool.query(`UPDATE chain_transaction_inbox SET terminal_attribution_incomplete_at=clock_timestamp()-INTERVAL '4 hours 1 second'
      WHERE signature='reject'`);
    await purgeExpiredFoundationData(pool);
    assert.equal((await parent(pool, 'reject')).terminal_attribution_incomplete_count, 0);
    assert.equal((await parent(pool, 'reject')).terminal_attribution_incomplete_at, null);
  });
});

void test('catch-up replay keeps immutable locator after runtime identity disappears and rejects no business writes', async (context) => {
  await withDatabase(context, async (pool, repository) => {
    await Promise.all([repository.recordCatchUpClassification(classification('catch-up')),
      repository.recordCatchUpClassification(classification('catch-up'))]);
    const first = (await occurrences(pool))[0];
    assert.ok(first);
    await repository.recordCatchUpClassification(classification('catch-up', Date.now() + 100));
    const rows = await occurrences(pool);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], first);
    assert.equal(first.transaction_index, '7');
    assert.equal(first.instruction_index, '3');
    assert.equal(first.inner_instruction_index, '2');
    assert.equal(first.confirmation_status, 'confirmed');
    assert.equal(first.origin, 'PUMP_BORSH_INVALID');
    assert.equal(first.wire_surface, 'CPI_EVENT');
    assert.equal(first.wire_location, 'INNER');
    const artifact = await capture(pool, repository);
    assert.equal(artifact.diagnosticOccurrences.totalOccurrences, 1);
    assert.deepEqual(artifact.diagnosticOccurrences.groups[0]?.representative, {
      signature: 'catch-up', slot: 1, transactionIndex: 7, confirmationStatus: 'confirmed',
      instructionIndex: 3, innerInstructionIndex: 2,
    });

    await pool.query(`ALTER TABLE transaction_inbox_terminal_attributions ADD CONSTRAINT reject_test CHECK (signature<>'catch-reject')`);
    await repository.recordCatchUpClassification(classification('catch-reject'));
    const rejected = await parent(pool, 'catch-reject');
    assert.equal(rejected.processing_status, 'QUARANTINED');
    assert.equal(rejected.terminal_attribution_incomplete_count, 1);
    await pool.query(`ALTER TABLE transaction_inbox_terminal_attributions DROP CONSTRAINT reject_test`);
    await repository.recordCatchUpClassification(classification('catch-reject'));
    assert.equal((await parent(pool, 'catch-reject')).terminal_attribution_incomplete_count, 1);
  });
});

void test('journal own expiry purges while successful parent remains and parent deletion cascades', async (context) => {
  await withDatabase(context, async (pool, repository) => {
    await repository.enqueue(notification('retained'));
    const claim = await repository.claim(Date.now(), 30);
    assert.ok(claim);
    await repository.saveSnapshot('retained', claim.leaseToken, transaction('retained'));
    await repository.markFailed('retained', claim.leaseToken, failure('retained', true));
    const retry = await claimRetry(pool, repository, 'retained');
    await repository.markProcessed('retained', retry.leaseToken, 'confirmed');
    await pool.query(`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
      UPDATE transaction_inbox_terminal_attributions
      SET captured_at=clock.at-INTERVAL '5 hours',purge_after=clock.at-INTERVAL '1 hour' FROM clock`);
    const purged = await purgeExpiredFoundationData(pool);
    assert.equal(purged.transactionInboxTerminalAttributions, 1);
    assert.equal((await parent(pool, 'retained')).processing_status, 'PROCESSED');
    await repository.recordCatchUpClassification(classification('cascade'));
    await pool.query(`DELETE FROM chain_transaction_inbox WHERE signature='cascade'`);
    assert.equal((await occurrences(pool)).length, 0);
  });
});

void test('worker Pump wire has no catch-up cause and complete cause-only capture needs no diagnostic', async (context) => {
  await withDatabase(context, async (pool, repository) => {
    await repository.enqueue(notification('worker-wire'));
    const claim = await repository.claim(Date.now(), 30);
    assert.ok(claim);
    const value: IngestionFailure = Object.freeze({ code: 'PIPELINE_STAGE_FAILED',
      errorName: 'ObservedPipelineFailure.v1.launchpad_observation.PUMP_BORSH_INVALID', retryable: false });
    const source = classification('worker-wire');
    const { trustedTerminalAttribution, trustedTerminalAttributionContext } = await import('../src/domain/terminal-attribution.js');
    registerTrustedTerminalAttribution(value, trustedTerminalAttribution(source));
    registerTrustedTerminalAttributionContext(value, trustedTerminalAttributionContext(source));
    await repository.markFailed('worker-wire', claim.leaseToken, value);
    const worker = (await occurrences(pool))[0];
    assert.equal(worker?.diagnostic_code, 'PUMP_BORSH_INVALID');
    assert.equal(worker.catch_up_cause_kind, null);
    assert.equal(worker.completeness, 'COMPLETE');
    assert.equal(worker.wire_surface, 'CPI_EVENT');
    await assert.rejects(pool.query(`UPDATE transaction_inbox_terminal_attributions
      SET catch_up_cause_kind='PUMP_DECODER' WHERE source='WORKER'`), { code: '23514' });
    await assert.rejects(pool.query(`UPDATE transaction_inbox_terminal_attributions
      SET wire_payload_bytes=NULL WHERE source='WORKER'`), { code: '23514' });
    await assert.rejects(pool.query(`UPDATE transaction_inbox_terminal_attributions
      SET completeness='UNAVAILABLE' WHERE source='WORKER'`), { code: '23514' });

    const causeOnly = createCatchUpClassification({ ...classification('cause-only'), signature: 'cause-only' });
    registerTrustedTerminalAttribution(causeOnly, { version: 1, diagnosticCode: 'UNAVAILABLE',
      causeKind: 'LOCATOR', pumpWire: null });
    registerTrustedTerminalAttributionContext(causeOnly, { originCode: null, locator: {
      signature: 'cause-only', slot: 1n, transactionIndex: null, confirmationStatus: 'confirmed',
      instructionIndex: null, innerInstructionIndex: null,
    } });
    await repository.recordCatchUpClassification(causeOnly);
    const cause = (await occurrences(pool)).find((row) => row.signature === 'cause-only');
    assert.equal(cause?.completeness, 'COMPLETE');
    assert.equal(cause.diagnostic_code, 'UNAVAILABLE');
    assert.equal(cause.catch_up_cause_kind, 'LOCATOR');
    await assert.rejects(pool.query(`UPDATE transaction_inbox_terminal_attributions
      SET catch_up_cause_kind=NULL WHERE signature='cause-only'`), { code: '23514' });
    const unavailable = createCatchUpClassification({ ...classification('unavailable'), signature: 'unavailable' });
    await repository.recordCatchUpClassification(unavailable);
    const absent = (await occurrences(pool)).find((row) => row.signature === 'unavailable');
    assert.equal(absent?.completeness, 'UNAVAILABLE');
    assert.equal(absent.diagnostic_code, 'UNAVAILABLE');
    assert.equal(absent.catch_up_cause_kind, null);
    assert.equal(absent.origin, null);
  });
});

void test('recent catch-up rejection retains its parent marker despite an old terminal timestamp', async (context) => {
  await withDatabase(context, async (pool, repository) => {
    await pool.query(`ALTER TABLE transaction_inbox_terminal_attributions ADD CONSTRAINT reject_test CHECK (FALSE)`);
    await repository.recordCatchUpClassification(classification('old-terminal'));
    await pool.query('ALTER TABLE chain_transaction_inbox DISABLE TRIGGER USER');
    try {
      await pool.query(`UPDATE chain_transaction_inbox SET first_detected_at=terminal_at WHERE signature='old-terminal'`);
    } finally {
      await pool.query('ALTER TABLE chain_transaction_inbox ENABLE TRIGGER USER');
    }
    await purgeExpiredFoundationData(pool);
    assert.equal((await parent(pool, 'old-terminal')).terminal_attribution_incomplete_count, 1);
    await pool.query(`UPDATE chain_transaction_inbox SET terminal_attribution_incomplete_count=2147483647
      WHERE signature='old-terminal'`);
    await repository.recordCatchUpClassification(classification('old-terminal'));
    assert.equal((await parent(pool, 'old-terminal')).terminal_attribution_incomplete_count, 2147483647);
  });
});

void test('trusted worker wire remains exportable when a wrapper removes decoder origin authority', async (context) => {
  await withDatabase(context, async (pool, repository) => {
    await repository.enqueue(notification('wire-no-origin'));
    const claim = await repository.claim(Date.now(), 30);
    assert.ok(claim);
    const value = failure('wire-no-origin', false);
    registerTrustedTerminalAttribution(value, { version: 1, diagnosticCode: 'PUMP_BORSH_INVALID',
      causeKind: 'PUMP_DECODER', pumpWire: { surface: 'INSTRUCTION', location: 'OUTER',
        discriminatorHex: '0000000000000000', idlName: 'buy', totalBytes: 12, payloadBytes: 4, suffixBytes: null } });
    registerTrustedTerminalAttributionContext(value, { originCode: null, locator: {
      signature: 'wire-no-origin', slot: 1n, transactionIndex: 0, confirmationStatus: 'confirmed',
      instructionIndex: 1, innerInstructionIndex: null,
    } });
    await repository.markFailed('wire-no-origin', claim.leaseToken, value);
    assert.equal((await occurrences(pool)).length, 1);
    const artifact = await capture(pool, repository);
    const group = artifact.diagnosticOccurrences.groups[0];
    assert.equal(group?.diagnosticCode, 'PUMP_BORSH_INVALID');
    assert.equal(group.originCode, null);
    assert.equal(group.catchUpCauseKind, null);
    assert.equal(group.completeness, 'COMPLETE');
    assert.equal(group.representative?.instructionIndex, 1);
  });
});

void test('journal marker rejection rolls back the entire transaction rather than claiming success', async (context) => {
  await withDatabase(context, async (pool, repository) => {
    await pool.query(`ALTER TABLE transaction_inbox_terminal_attributions ADD CONSTRAINT reject_test CHECK (FALSE)`);
    await pool.query(`ALTER TABLE chain_transaction_inbox ADD CONSTRAINT reject_marker CHECK (terminal_attribution_incomplete_count=0)`);
    await repository.enqueue(notification('rollback'));
    const claim = await repository.claim(Date.now(), 30);
    assert.ok(claim);
    await assert.rejects(repository.markFailed('rollback', claim.leaseToken, failure('rollback', true)));
    assert.equal((await parent(pool, 'rollback')).processing_status, 'PROCESSING');
    assert.equal((await occurrences(pool)).length, 0);
  });
});

void test('fresh journal retains an old terminal parent until the occurrence own four-hour expiry', async (context) => {
  await withDatabase(context, async (pool, repository) => {
    await repository.recordCatchUpClassification(classification('old-parent-fresh-journal'));
    await pool.query('ALTER TABLE chain_transaction_inbox DISABLE TRIGGER USER');
    try {
      await pool.query(`UPDATE chain_transaction_inbox SET first_detected_at=terminal_at
        WHERE signature='old-parent-fresh-journal'`);
    } finally { await pool.query('ALTER TABLE chain_transaction_inbox ENABLE TRIGGER USER'); }
    const first = await purgeExpiredFoundationData(pool);
    assert.equal(first.transactionInbox, 0);
    assert.equal((await occurrences(pool)).length, 1);
    assert.equal((await parent(pool, 'old-parent-fresh-journal')).processing_status, 'QUARANTINED');
    await pool.query(`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
      UPDATE transaction_inbox_terminal_attributions
      SET captured_at=clock.at-INTERVAL '5 hours',purge_after=clock.at-INTERVAL '1 hour' FROM clock`);
    const second = await purgeExpiredFoundationData(pool);
    assert.equal(second.transactionInboxTerminalAttributions, 1);
    assert.equal(second.transactionInbox, 1);
    assert.equal((await occurrences(pool)).length, 0);
  });
});

function failure(signature: string, trusted: boolean): IngestionFailure {
  const value: IngestionFailure = Object.freeze({ code: 'PIPELINE_STAGE_FAILED',
    errorName: 'ObservedPipelineFailure.v1.wallet_graph.UNKNOWN', retryable: true });
  if (trusted) {
    registerTrustedTerminalAttribution(value, { version: 1,
      diagnosticCode: 'WALLET_GRAPH_POSTGRES_SERIALIZATION', causeKind: null, pumpWire: null });
    registerTrustedTerminalAttributionContext(value, { originCode: null, locator: {
      signature, slot: 1n, transactionIndex: 0, confirmationStatus: 'confirmed',
      instructionIndex: null, innerInstructionIndex: null,
    } });
  }
  return value;
}

function classification(signature: string, classifiedAtMs = 1_000) {
  const value = createCatchUpClassification({ signature, slot: 1n,
    programIds: [PUMP_PROGRAM_ID], confirmationStatus: 'confirmed', observedAtMs: 1_000,
    ingestionHint: null, ingestionHintMint: null, classificationVersion: 1,
    disposition: 'QUARANTINED', reasonCode: 'PUMP_SCHEMA_UNSUPPORTED', mints: [],
    evidenceFingerprint: 'a'.repeat(64), classifiedAtMs });
  registerTrustedTerminalAttribution(value, { version: 1, diagnosticCode: 'PUMP_BORSH_INVALID',
    causeKind: 'PUMP_DECODER', pumpWire: { surface: 'CPI_EVENT', location: 'INNER',
      discriminatorHex: '0000000000000000', idlName: 'TradeEvent', totalBytes: 20, payloadBytes: 4, suffixBytes: null } });
  registerTrustedTerminalAttributionContext(value, { originCode: 'PUMP_BORSH_INVALID', locator: {
    signature, slot: 1n, transactionIndex: 7, confirmationStatus: 'confirmed', instructionIndex: 3, innerInstructionIndex: 2,
  } });
  return value;
}

function notification(signature: string): TransactionNotification {
  return Object.freeze({ signature, slot: 1n, source: 'WEBSOCKET', ingestionHint: null,
    ingestionHintMint: null, programIds: Object.freeze([PUMP_PROGRAM_ID]), confirmationStatus: 'confirmed', observedAtMs: 1_000 });
}

function transaction(signature: string): NormalizedTransaction {
  return { signature, slot: 1n, transactionIndex: 0, confirmationStatus: 'CONFIRMED', version: 'legacy',
    blockTimeMs: 999, accountKeys: [], signerKeys: [], instructions: [], preTokenBalances: [], postTokenBalances: [],
    preBalancesLamports: [], postBalancesLamports: [], feeLamports: 0n, computeUnits: null, logs: [], error: null };
}

async function parent(pool: pg.Pool, signature: string) {
  const result = await pool.query<{
    processing_status: string; error_code: string | null; next_attempt_at: Date;
    terminal_attribution_incomplete_count: number; terminal_attribution_incomplete_at: Date | null;
  }>('SELECT * FROM chain_transaction_inbox WHERE signature=$1', [signature]);
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

async function occurrences(pool: pg.Pool) {
  return (await pool.query<Record<string, unknown>>(`SELECT * FROM transaction_inbox_terminal_attributions
    ORDER BY signature,source,occurrence_number`)).rows;
}

async function claimRetry(pool: pg.Pool, repository: PostgresTransactionInboxRepository, signature: string) {
  const claim = await repository.claim((await parent(pool, signature)).next_attempt_at.getTime() + 1, 30);
  assert.ok(claim);
  return claim;
}

async function capture(pool: pg.Pool, repository: PostgresTransactionInboxRepository) {
  await repository.writeHeartbeat(Object.freeze({
    runtimeState: 'STOPPED', subscriberState: 'STOPPED', scannerState: 'STOPPED',
    workerState: 'STOPPED', reconcilerState: 'STOPPED', startedAtMs: 1_000,
    updatedAtMs: 2_000, lastHttpSlot: null, lastWebsocketSlot: null,
    lastFinalizedSlot: null, lastSignature: null, backlogCount: 0, leasedCount: 0, exhaustedCount: 0,
  }));
  const client = await pool.connect();
  try { return await captureMainnetTerminalAttribution(client); }
  finally { client.release(); }
}

async function withDatabase(context: TestContext,
  run: (pool: pg.Pool, repository: PostgresTransactionInboxRepository) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) { context.skip('TEST_DATABASE_URL absent'); return; }
  const schema = `terminal_repository_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await migrateDatabase({ pool });
    await run(pool, new PostgresTransactionInboxRepository(pool, { maxAttempts: 5, baseDelayMs: 1 }));
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresTransactionInboxRepository } from '../src/storage/transaction-inbox.repository.js';
import { createPumpFunWorkerAdmissionPolicy } from '../src/domain/worker-admission.js';

const countRow = Object.fromEntries([
  'pending', 'processing', 'processed', 'failed', 'retryable_failed', 'exhausted_failed',
  'decoder_quarantined', 'websocket_only', 'catch_up_only', 'websocket_and_catch_up',
  'normal', 'launch_candidate', 'tracked_trade', 'deferred', 'ignored', 'quarantined',
].map((key) => [key, '0']));
const sampleRow = {
  claimable_backlog_count: '0', classification_pending_count: '0',
  oldest_classification_pending_age_ms: null, fresh_mint_count: '0',
  extended_mint_count: '0', demoted_count: '0', sampled_at_ms: '1790894504593',
};

void test('heartbeat paired sample uses one client, one clock query and the existing read-only transaction', async () => {
  for (const enabled of [false, true]) {
    const statements: string[] = [];
    let released = 0;
    let connections = 0;
    const repository = new PostgresTransactionInboxRepository({
      async query() { throw new Error('Pool queries must not be used.'); },
      async connect() {
        connections += 1;
        return {
          async query(sql: string) {
            statements.push(sql);
            return { rows: sql.includes('AS pending') ? [countRow]
              : sql.includes('AS claimable_backlog_count') ? [sampleRow] : [], rowCount: 1 };
          },
          release() { released += 1; },
        };
      },
    }, undefined, createPumpFunWorkerAdmissionPolicy({ enabled, trackingWindowSeconds: 45 }));
    const snapshot = await repository.heartbeatSnapshot();
    assert.deepEqual(snapshot.workerAdmissionClock, {
      version: 1, sampledAtMs: 1_790_894_504_593,
    });
    assert.equal(connections, 1);
    assert.equal(released, 1);
    assert.equal(statements.length, 5);
    assert.deepEqual(statements.slice(0, 2), [
      'BEGIN', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    ]);
    assert.equal(statements.at(-1), 'COMMIT');
    const sql = statements[3] ?? '';
    assert.equal(sql.match(/date_trunc\('milliseconds',clock_timestamp\(\)\)/gu)?.length, 1);
    assert.match(sql, /WITH database_clock AS MATERIALIZED/u);
    assert.match(sql, /\(SELECT \(EXTRACT\(EPOCH FROM at\)\*1000\)::BIGINT FROM database_clock\) AS sampled_at_ms/u);
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.counts));
    assert.ok(Object.isFrozen(snapshot.workerAdmission));
    assert.ok(Object.isFrozen(snapshot.workerAdmissionClock));
    assert.equal(Reflect.ownKeys(snapshot.workerAdmission).length, 9);
    sampleRow.sampled_at_ms = '1790894504594';
    assert.equal(snapshot.workerAdmissionClock.sampledAtMs, 1_790_894_504_593);
    sampleRow.sampled_at_ms = '1790894504593';
  }
});

void test('standalone metrics retains nine fields and rejects invalid paired database clocks in one query', async () => {
  for (const sampledAtMs of [undefined, null, '0', '-1', '01', '1.5', 'secret',
    '8640000000000001', Number.MAX_SAFE_INTEGER, -0, Infinity]) {
    let queries = 0;
    const repository = new PostgresTransactionInboxRepository({
      async query() { queries += 1; return { rows: [{ ...sampleRow, sampled_at_ms: sampledAtMs }], rowCount: 1 }; },
      async connect() { throw new Error('Standalone metrics must not connect.'); },
    });
    await assert.rejects(repository.workerAdmissionMetrics(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /secret|8640000000000001/u);
      return true;
    });
    assert.equal(queries, 1);
  }
});

void test('heartbeat invalid paired clock rolls back and releases after the counts read', async () => {
  const statements: string[] = [];
  let released = false;
  const repository = new PostgresTransactionInboxRepository({
    async query() { throw new Error('Pool queries must not be used.'); },
    async connect() {
      return {
        async query(sql: string) {
          statements.push(sql);
          return { rows: sql.includes('AS pending') ? [countRow]
            : sql.includes('AS claimable_backlog_count') ? [{ ...sampleRow, sampled_at_ms: 'secret' }] : [], rowCount: 1 };
        },
        release() { released = true; },
      };
    },
  });
  await assert.rejects(repository.heartbeatSnapshot());
  assert.equal(statements.length, 5);
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});

void test('heartbeat snapshot rolls back and releases its shared read-only client on query failure', async () => {
  const statements: string[] = [];
  let released = false;
  const repository = new PostgresTransactionInboxRepository({
    async query() { throw new Error('Pool queries must not be used.'); },
    async connect() {
      return {
        async query(sql: string) {
          statements.push(sql);
          if (sql.includes('COUNT(*)')) throw new Error('private database failure');
          return { rows: [], rowCount: 0 };
        },
        release() { released = true; },
      };
    },
  });
  await assert.rejects(repository.heartbeatSnapshot(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /private database failure/u);
    return true;
  });
  assert.deepEqual(statements.slice(0, 2), [
    'BEGIN', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
  ]);
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});

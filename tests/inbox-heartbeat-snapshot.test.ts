import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresTransactionInboxRepository } from '../src/storage/transaction-inbox.repository.js';

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

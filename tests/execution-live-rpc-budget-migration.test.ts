import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../migrations/038_execution_live_rpc_budget.sql',
  import.meta.url,
);

void test('migration 038 persists a closed per-attempt RPC call budget', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS execution_live_rpc_budgets/u);
  assert.match(sql, /initial_calls_used INTEGER NOT NULL/u);
  assert.match(sql, /initial_calls_used BETWEEN 0 AND calls_reserved/u);
  assert.match(sql, /PRIMARY KEY \(intent_id, attempt_number\)/u);
  assert.match(sql, /artifact_id TEXT NOT NULL UNIQUE/u);
  assert.match(sql, /calls_reserved INTEGER NOT NULL/u);
  assert.match(sql, /calls_limit INTEGER NOT NULL/u);
  assert.match(sql, /calls_reserved BETWEEN 0 AND calls_limit/u);
  assert.match(sql, /calls_limit BETWEEN 12 AND 16/u);
  assert.match(sql, /ON DELETE CASCADE/u);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION|JSONB?)\b/iu);
  assert.doesNotMatch(sql, /private[_ ]?key|keypair|send[_ ]?transaction/iu);
});

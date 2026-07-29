import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('la migration PostgreSQL PumpSwap crée les projections bigint', async () => {
  const sql = await readFile(
    new URL('../migrations/005_pumpswap_market.sql', import.meta.url),
    'utf8',
  );
  for (const table of [
    'migrations',
    'market_pools',
    'market_reserve_snapshots',
    'market_trades',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'u'));
  }
  assert.match(sql, /NUMERIC\(78,0\)/u);
  assert.match(sql, /pool_index INTEGER NOT NULL CHECK \(pool_index = 0\)/u);
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS market_pools[\s\S]*?\n {2}slot NUMERIC\(78,0\) NOT NULL/u,
  );
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS market_reserve_snapshots[\s\S]*?\n {2}observed_slot NUMERIC\(78,0\) NOT NULL,[\s\S]*?\n {2}trigger_slot NUMERIC\(78,0\) NOT NULL/u,
  );
  assert.match(sql, /'processed'.*'confirmed'.*'finalized'.*'orphaned'/su);
  assert.match(sql, /COALESCE\(inner_instruction_index, -1\)/u);
  assert.doesNotMatch(sql, /private[_ ]?key|send[_ ]?transaction/iu);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('la migration crée les projections Pump.fun immuables', async () => {
  const sql = await readFile(
    new URL('../migrations/003_pumpfun_observations.sql', import.meta.url),
    'utf8',
  );

  for (const table of [
    'token_metadata_snapshots',
    'bonding_curve_snapshots',
    'launch_trades',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'u'));
  }
  assert.match(sql, /NUMERIC\(78,0\)/u);
  assert.match(sql, /ON DELETE CASCADE/u);
  assert.match(sql, /COALESCE\(inner_instruction_index, -1\)/u);
  assert.match(sql, /purge_after TIMESTAMPTZ/u);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS launch_trades_cursor_idx/u);
  assert.doesNotMatch(sql, /token_metadata_snapshots_mint_hash_idx/u);
});

void test('la migration ne contient ni secret ni exécution réelle', async () => {
  const sql = await readFile(
    new URL('../migrations/003_pumpfun_observations.sql', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(sql, /private[_ ]?key/iu);
  assert.doesNotMatch(sql, /send[_ ]?transaction/iu);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('crée les tables paper avec bigint, unicité et cascade', async () => {
  const sql = await readFile(
    new URL('../migrations/004_paper_trading.sql', import.meta.url),
    'utf8',
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS paper_positions/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS paper_trades/u);
  assert.match(sql, /NUMERIC\(78,0\)/u);
  assert.match(sql, /ON DELETE CASCADE/u);
  assert.match(sql, /paper_positions_active_strategy_idx/u);
  assert.match(sql, /UNIQUE\(position_id, side\)/u);
  assert.match(sql, /PAPER_HOLDING/u);
  assert.match(sql, /PAPER_CLOSED/u);
  assert.match(sql, /PAPER_RETRACTED/u);
});

void test('ne contient aucun chemin d’exécution Solana', async () => {
  const sql = await readFile(
    new URL('../migrations/004_paper_trading.sql', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(sql, /private[_ ]?key|sendTransaction|simulateTransaction/iu);
});

void test('branche les positions fermées sur la purge de rétention', async () => {
  const source = await readFile(
    new URL('../src/storage/database.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /paperPositions/u);
  assert.match(source, /DELETE FROM paper_positions position[\s\S]*position\.purge_after <= NOW\(\)/u);
  assert.match(source, /paper_mvp_runs run[\s\S]*run\.state = 'RUNNING'/u);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('la migration Pump.fun V1 crée le socle append-only et sa rétention', async () => {
  const sql = await readFile(
    new URL('../migrations/002_pumpfun_foundation.sql', import.meta.url),
    'utf8',
  );

  for (const table of [
    'token_launches',
    'raw_chain_events',
    'domain_events',
    'state_transitions',
    'processing_checkpoints',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'u'));
  }

  assert.match(sql, /NUMERIC\(78,0\)/u);
  assert.match(sql, /purge_after TIMESTAMPTZ/u);
  assert.match(sql, /'processed'.*'confirmed'.*'finalized'.*'orphaned'/su);
  assert.match(sql, /transaction_index INTEGER/u);
  assert.match(sql, /inner_instruction_index INTEGER/u);
});

void test('la migration ne crée aucun chemin de secret ou d’exécution réelle', async () => {
  const sql = await readFile(
    new URL('../migrations/002_pumpfun_foundation.sql', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(sql, /private[_ ]?key/iu);
  assert.doesNotMatch(sql, /keypair/iu);
  assert.doesNotMatch(sql, /send[_ ]?transaction/iu);
});

void test('la purge paper respecte l’ordre enfant avant parent et les lignées non expirées', async () => {
  const source = await readFile(new URL('../src/storage/database.ts', import.meta.url), 'utf8');
  const order = [
    'DELETE FROM paper_external_buy_events',
    'DELETE FROM paper_strategy_sessions',
    'DELETE FROM trading_candidates',
    'DELETE FROM qualification_reports',
    'DELETE FROM paper_decision_jobs',
    'DELETE FROM paper_trades',
    'DELETE FROM paper_positions',
    'DELETE FROM api_event_stream',
    'DELETE FROM domain_events',
    'DELETE FROM token_launches',
  ].map((statement) => source.indexOf(statement));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((left, right) => left - right), order);
  assert.match(source, /NOT EXISTS \([\s\S]*social_evidence_collections[\s\S]*purge_after > statement_timestamp\(\)/u);
  assert.match(source, /NOT EXISTS \([\s\S]*paper_strategy_sessions[\s\S]*purge_after IS NULL/u);
});

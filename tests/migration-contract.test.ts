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

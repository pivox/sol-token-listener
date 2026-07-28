import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const FORBIDDEN_IMPORTS = [
  'execution/wallet',
  'execution/transaction-confirmer',
  'execution/trade-executor',
  'dex/raydium-cpmm/transaction-builder',
] as const;

void test('le bootstrap V1 ne dépend d’aucun composant de signature ou envoi', async () => {
  const source = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');

  for (const forbidden of FORBIDDEN_IMPORTS) {
    assert.doesNotMatch(source, new RegExp(forbidden, 'u'));
  }
});

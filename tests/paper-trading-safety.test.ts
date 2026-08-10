import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PAPER_FILES = [
  '../src/domain/paper-trading.ts',
  '../src/paper/paper-math.ts',
  '../src/paper/paper-trading-engine.ts',
  '../src/paper/pumpfun-paper-quote.provider.ts',
  '../src/ports/paper-quote-router.ts',
  '../src/ports/paper-trading-repository.ts',
  '../src/storage/paper-trading.repository.ts',
  '../migrations/004_paper_trading.sql',
] as const;

void test('le flux paper Pump.fun ne dépend d’aucun mécanisme Solana actif', async () => {
  const source = (await Promise.all(PAPER_FILES.map(async (path) => (
    readFile(new URL(path, import.meta.url), 'utf8')
  )))).join('\n');

  assert.doesNotMatch(source, /WalletSigner|VersionedTransaction|sendTransaction|simulateTransaction/iu);
  assert.doesNotMatch(source, /private[_ ]?key|keypair/iu);
  assert.doesNotMatch(source, /executionMode\s*===?\s*['"]live['"]/u);
});

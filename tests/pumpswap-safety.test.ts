import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

void test('PumpSwap safety boundary contains no signing or submission path', async () => {
  const directory = new URL('../src/markets/pumpswap/', import.meta.url);
  const names = await readdir(directory);
  const sources = await Promise.all(
    names.filter((name) => name.endsWith('.ts')).map((name) =>
      readFile(new URL(name, directory), 'utf8')),
  );
  sources.push(await readFile(
    new URL('../src/application/market-observation.service.ts', import.meta.url),
    'utf8',
  ));
  const source = sources.join('\n');
  for (const forbidden of [
    /\bKeypair\b/u,
    /\bWallet\b/u,
    /sendTransaction/u,
    /sendRawTransaction/u,
    /TransactionBuilder/u,
    /signTransaction/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

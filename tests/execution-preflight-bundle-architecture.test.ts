import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('offline bundle producer cannot reach Solana, PostgreSQL, listener or live operations', async () => {
  const sources = await Promise.all([
    'src/preflight-bundle/config.ts',
    'src/preflight-bundle/service.ts',
    'src/preflight-bundle/main.ts',
    'src/domain/execution-preflight-bundle.ts',
  ].map((path) => readFile(path, 'utf8')));
  const source = sources.join('\n');
  assert.doesNotMatch(source, /from ['"](?:@solana\/web3\.js|pg|\.\.\/executor-live|\.\.\/executor-operations|\.\.\/application|\.\.\/storage)/u);
  assert.doesNotMatch(source, /(?:sendRawTransaction|sendTransaction|Keypair)/u);
});

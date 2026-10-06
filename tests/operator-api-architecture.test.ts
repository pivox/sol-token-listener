import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { literalRuntimeModuleSpecifiers } from './helpers/execution-boundary.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = resolve(repositoryRoot, 'src/operator-api/main.ts');

async function readGraph(entry: string): Promise<{
  readonly sources: ReadonlyMap<string, string>;
  readonly externals: ReadonlySet<string>;
}> {
  const sources = new Map<string, string>();
  const externals = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    if (sources.has(path)) return;
    const source = await readFile(path, 'utf8');
    sources.set(path, source);
    for (const specifier of literalRuntimeModuleSpecifiers(source, path)) {
      if (!specifier.startsWith('.')) {
        externals.add(specifier);
        continue;
      }
      const target = resolve(dirname(path), specifier.replace(/\.js$/u, '.ts'));
      await access(target);
      await visit(target);
    }
  };
  await visit(entry);
  return { sources, externals };
}

void test('the operator API graph cannot reach live execution, keypairs or signing', async () => {
  const { sources } = await readGraph(ENTRY);
  const paths = [...sources.keys()].map((path) => relative(repositoryRoot, path));
  assert.ok(paths.includes('src/operator-api/server.ts'));
  assert.ok(paths.includes('src/preflight-source/database.ts'));
  assert.deepEqual(paths.filter((path) => (
    /^src\/(?:executor-live|executor-live-recovery|executor-operations|execution)\//u.test(path)
    || /(?:keypair|transaction-signer|submission-gateway)/u.test(path)
  )), []);
  for (const [path, source] of sources) {
    assert.doesNotMatch(source,
      /\b(?:Keypair|sendRawTransaction|sendTransaction|signTransaction|signMessage|simulateTransaction)\b/u,
      `signing or submission capability in ${relative(repositoryRoot, path)}`);
  }
});

void test('the operator API graph contains no write SQL and a single RPC method', async () => {
  const { sources, externals } = await readGraph(ENTRY);
  for (const [path, source] of sources) {
    assert.doesNotMatch(source,
      /\b(?:INSERT\s+INTO|UPDATE\s+["\w]+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE)\b/iu,
      `write SQL in ${relative(repositoryRoot, path)}`);
  }
  const rpc = await readFile(resolve(repositoryRoot, 'src/operator-api/rpc-balance.ts'), 'utf8');
  assert.deepEqual([...rpc.matchAll(/jsonrpc:[^}]*?method:\s*'([A-Za-z]+)'/gu)].map((match) => match[1]), ['getBalance']);
  // @solana/web3.js is reached only through shared domain modules (address validation); the
  // Keypair and submission capabilities are excluded by the previous test.
  assert.deepEqual([...externals].sort(), [
    '@solana/web3.js', 'node:crypto', 'node:fs', 'node:http', 'node:url', 'node:util/types', 'pg',
  ]);
});

void test('the operator API server handles only GET and OPTIONS', async () => {
  const server = await readFile(resolve(repositoryRoot, 'src/operator-api/server.ts'), 'utf8');
  assert.deepEqual([...server.matchAll(/request\.method\s*[!=]==\s*'([A-Z]+)'/gu)].map((match) => match[1]),
    ['OPTIONS', 'GET']);
  assert.doesNotMatch(server, /\b(?:POST|PUT|PATCH|DELETE|HEAD)\b/u);
});

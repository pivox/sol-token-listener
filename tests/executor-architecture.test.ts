import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  executorBoundaryViolations,
  literalModuleSpecifiers,
} from './helpers/execution-boundary.js';
import { reportExecutorEntrypointFailure } from '../src/executor/main.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

void test('source and compiled executor graphs stay inside the strict dry-run allowlist', async () => {
  const entries = [
    resolve(repositoryRoot, 'src/executor/main.ts'),
    resolve(repositoryRoot, 'dist/src/executor/main.js'),
  ];
  for (const entry of entries) {
    await access(entry);
    const graph = await readGraph(entry);
    assert.ok(graph.size >= 8, `executor graph unexpectedly small: ${relative(repositoryRoot, entry)}`);
    const violations: string[] = [];
    for (const [path, source] of graph) {
      violations.push(...executorBoundaryViolations(source, path, repositoryRoot));
    }
    assert.deepEqual(violations, [], `unsafe executor graph from ${relative(repositoryRoot, entry)}`);
  }
});

void test('executor graph guard rejects forbidden SDKs, application paths, capabilities and non-allowlisted modules', () => {
  const fixturePath = resolve(repositoryRoot, 'src/executor/main.ts');
  const fixture = [
    "import { Keypair } from '@solana/web3.js';",
    "import '@solana/spl-token';",
    "import '@pump-fun/pump-sdk';",
    "import '@pump-fun/pump-swap-sdk';",
    "import '../execution/order-sender.js';",
    "import '../app.js';",
    "import '../config/env.js';",
    'await import(moduleName);',
    'client.simulateTransaction();',
    'client.sendTransaction();',
    'client.sendRawTransaction();',
    'client.signTransaction();',
    'loadSecret();',
  ].join('\n');
  const violations = executorBoundaryViolations(fixture, fixturePath, repositoryRoot);
  for (const expected of [
    '@solana/web3.js', '@solana/spl-token', '@pump-fun/pump-sdk',
    '@pump-fun/pump-swap-sdk', '../execution/order-sender.js', '../app.js',
    '../config/env.js', 'Nonliteral dynamic import', 'Keypair',
    'simulateTransaction', 'sendTransaction', 'sendRawTransaction', 'signTransaction',
    'loadSecret',
  ]) assert.ok(violations.some((violation) => violation.includes(expected)), expected);
});

void test('fatal bootstrap output uses only allowlisted stable error identity and never a message', () => {
  let output = '';
  const runtime = {
    exitCode: undefined as number | string | undefined,
    stderr: {
      write: (chunk: string) => { output += chunk; return true; },
    },
  } as unknown as Pick<NodeJS.Process, 'exitCode' | 'stderr'>;
  reportExecutorEntrypointFailure(Object.assign(new Error('postgresql://credential.invalid'), {
    name: 'CredentialSecret', code: 'credential-secret',
  }), runtime);

  assert.equal(runtime.exitCode, 1);
  assert.deepEqual(JSON.parse(output) as unknown, {
    service: 'sol-token-executor', event: 'executor.start_failed',
    errorName: 'UnknownError', errorCode: 'EXECUTOR_START_FAILED',
  });
  assert.doesNotMatch(output, /credential|postgresql/iu);
});

void test('main exposes only executor scripts, exact bounded pool options and no migration call', async () => {
  const [main, packageText] = await Promise.all([
    readFile(resolve(repositoryRoot, 'src/executor/main.ts'), 'utf8'),
    readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText) as { scripts?: Record<string, unknown> };
  assert.equal(packageJson.scripts?.['executor:dev'], 'tsx src/executor/main.ts');
  assert.equal(packageJson.scripts?.['executor:start'], 'node dist/src/executor/main.js');
  assert.match(main, /executor-dry-run-\$\{randomUUID\(\)\}/u);
  for (const option of [
    'connectionTimeoutMillis', 'query_timeout', 'statement_timeout',
    'lock_timeout', 'idle_in_transaction_session_timeout',
  ]) assert.match(main, new RegExp(`\\b${option}\\b`, 'u'));
  assert.doesNotMatch(main, /\bmigrateDatabase\b/u);
  assert.doesNotMatch(main, /(?:SOLANA_(?:HTTP|WS)_RPC_URL|PRIVATE_KEY|SECRET_KEY|KEYPAIR)/u);
});

async function readGraph(entry: string): Promise<ReadonlyMap<string, string>> {
  const graph = new Map<string, string>();
  const visit = async (path: string): Promise<void> => {
    if (graph.has(path)) return;
    const source = await readFile(path, 'utf8');
    graph.set(path, source);
    for (const specifier of literalModuleSpecifiers(source, path)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
      await visit(await resolveLocalModule(path, specifier));
    }
  };
  await visit(entry);
  return graph;
}

async function resolveLocalModule(importer: string, specifier: string): Promise<string> {
  const target = resolve(dirname(importer), specifier.replace(/[?#].*$/u, ''));
  const candidates = extname(target) === '.js' && importer.endsWith('.ts')
    ? [target.slice(0, -3) + '.ts', target]
    : [target];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try the next exact extension. */ }
  }
  throw new Error(`Missing local executor dependency: ${target}`);
}

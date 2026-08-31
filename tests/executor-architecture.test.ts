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
const EXPECTED_EXECUTOR_NODE_BUILTINS = Object.freeze([
  'node:crypto',
  'node:fs/promises',
  'node:path',
  'node:url',
  'node:util/types',
]);

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
    const nodeBuiltins = new Set<string>();
    for (const [path, source] of graph) {
      violations.push(...executorBoundaryViolations(source, path, repositoryRoot));
      for (const specifier of literalModuleSpecifiers(source, path)) {
        if (specifier.startsWith('node:')) nodeBuiltins.add(specifier);
      }
    }
    assert.deepEqual(violations, [], `unsafe executor graph from ${relative(repositoryRoot, entry)}`);
    assert.deepEqual(
      [...nodeBuiltins].sort(),
      EXPECTED_EXECUTOR_NODE_BUILTINS,
      `unexpected builtin dependency from ${relative(repositoryRoot, entry)}`,
    );
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

void test('executor graph guard fails closed on runtime module recovery and computed execution calls', () => {
  const fixturePath = resolve(repositoryRoot, 'src/executor/main.ts');
  const fixtures = [
    {
      source: "import { createRequire as factory } from 'node:module'; factory(import.meta.url)('@solana/web3.js');",
      expected: 'createRequire',
    },
    {
      source: "process.getBuiltinModule('module').createRequire(import.meta.url)('@solana/web3.js');",
      expected: 'getBuiltinModule',
    },
    {
      source: "eval(\"import('@solana/web3.js')\");",
      expected: 'eval',
    },
    {
      source: "new Function(\"return import('@solana/web3.js')\")();",
      expected: 'Function',
    },
    {
      source: "client['send' + 'Transaction']();",
      expected: 'Computed member call',
    },
  ] as const;
  for (const fixture of fixtures) {
    const violations = executorBoundaryViolations(fixture.source, fixturePath, repositoryRoot);
    assert.ok(
      violations.some((violation) => violation.includes(fixture.expected)),
      `${fixture.expected}: ${JSON.stringify(violations)}`,
    );
  }
});

void test('executor graph guard rejects a computed execution method captured before invocation', () => {
  const fixturePath = resolve(repositoryRoot, 'src/executor/main.ts');
  const fixture = "const submit=client['send'+'Transaction']; submit()";
  const violations = executorBoundaryViolations(fixture, fixturePath, repositoryRoot);
  assert.ok(
    violations.some((violation) => violation.includes('Computed member access')),
    JSON.stringify(violations),
  );
});

void test('executor graph guard rejects reflective access and reviewed alias bypasses', () => {
  const fixturePath = resolve(repositoryRoot, 'src/executor/main.ts');
  const fixtures = [
    "Reflect.get(client, 'sendTransaction')();",
    "Reflect['get'](client, 'sendRawTransaction')();",
    "const get = Reflect.get; get(client, 'signTransaction')();",
    "const { get: read } = Reflect; read(client, 'submitTransaction')();",
    "const { ['get']: read } = Reflect; read(client, 'signMessage')();",
    "let read; read = Reflect.get; read(client, 'submitRawTransaction')();",
    "const reflection = Reflect; Reflect.apply(reflection.get(client, 'sendAndConfirmTransaction'), client, []);",
    "Reflect.get.call(Reflect, client, 'submitRawTransaction')();",
    "Reflect.get.apply(Reflect, [client, 'sendTransaction'])();",
    "Reflect.apply(Reflect.get, Reflect, [client, 'signAllTransactions'])();",
    "const get = Reflect['get']; Reflect.apply(get, Reflect, [client, 'signMessage'])();",
    "Reflect.construct(Reflect.get(client, 'submitSignedTransaction'), []);",
    'Reflect.get(client, capability)();',
    'Reflect.apply(Reflect.get, Reflect, argumentsList)();',
    "const submit = () => get(client, 'sendTransaction')(); const get = Reflect.get; submit();",
    "let get = Reflect.get; if (condition) get = safeGet; get(client, 'sendTransaction')();",
    "for (const get of [Reflect.get]) get(client, 'sendTransaction')();",
    "switch (mode) { case 1: { const get = Reflect.get; get(client, 'sendTransaction')(); } }",
    "const call = Reflect.get.call.bind(Reflect.get); call(Reflect, client, 'sendTransaction')();",
    "const apply = Reflect.apply.bind(Reflect); apply(Reflect.get, Reflect, [client, 'sendTransaction'])();",
    "global.Reflect.get(client, 'sendTransaction')();",
    "globalThis['Reflect'].get(client, 'sendTransaction')();",
  ] as const;
  for (const fixture of fixtures) {
    const violations = executorBoundaryViolations(fixture, fixturePath, repositoryRoot);
    assert.ok(
      violations.length > 0,
      `${fixture}: ${JSON.stringify(violations)}`,
    );
  }
});

void test('executor graph guard rejects every Reflect form except the exact ownKeys call', () => {
  const fixturePath = resolve(repositoryRoot, 'src/executor/main.ts');
  for (const fixture of [
    "Reflect.get(record, 'status');",
    "Reflect['get'](record, 'reason');",
    "const get = Reflect.get; get(record, 'status');",
    "const { get: read } = Reflect; read(record, 'reason');",
    "const reflection = Reflect; reflection.get(record, 'status');",
    "Reflect.get.call(Reflect, record, 'status');",
    "Reflect.get.apply(Reflect, [record, 'reason']);",
    "Reflect.apply(Reflect.get, Reflect, [record, 'status']);",
    'Reflect.apply(validate, undefined, [value]);',
    'Reflect.construct(Date, []);',
    "const Reflect = { get: () => undefined }; Reflect.get(record, 'sendTransaction');",
    'Reflect?.ownKeys(value);',
    'Reflect.ownKeys?.(value);',
    'Reflect.ownKeys<unknown>(value);',
    'Reflect.ownKeys(value, extra);',
    'Reflect.ownKeys(...values);',
    "Reflect['ownKeys'](value);",
    'const ownKeys = Reflect.ownKeys; ownKeys(value);',
    'Reflect.ownKeys.call(Reflect, value);',
    "globalThis.Reflect.ownKeys(value);",
    "global['Reflect'].ownKeys(value);",
  ]) assert.ok(
    executorBoundaryViolations(fixture, fixturePath, repositoryRoot).length > 0,
    fixture,
  );
});

void test('executor graph guard permits only exact direct Reflect.ownKeys and non-reflective code', () => {
  const fixturePath = resolve(repositoryRoot, 'src/executor/main.ts');
  for (const fixture of [
    'Reflect.ownKeys(value);',
    'Object.keys(record);',
    'validate(value);',
    "const get = () => undefined; get(record, 'sendRawTransaction');",
  ]) assert.deepEqual(executorBoundaryViolations(fixture, fixturePath, repositoryRoot), [], fixture);
});

void test('executor graph guard rejects node:vm dynamic SDK execution', () => {
  const fixturePath = resolve(repositoryRoot, 'src/executor/main.ts');
  const fixture = [
    "import { runInThisContext } from 'node:vm';",
    "runInThisContext(\"import('@solana/web3.js')\");",
  ].join('\n');
  const violations = executorBoundaryViolations(fixture, fixturePath, repositoryRoot);
  assert.ok(violations.some((violation) => violation.includes('node:vm')), JSON.stringify(violations));
});

void test('executor graph guard rejects node:child_process sub-node SDK execution', () => {
  const fixturePath = resolve(repositoryRoot, 'src/executor/main.ts');
  const fixture = [
    "import { execFile } from 'node:child_process';",
    "execFile(process.execPath, ['-e', \"import('@solana/web3.js')\"]);",
  ].join('\n');
  const violations = executorBoundaryViolations(fixture, fixturePath, repositoryRoot);
  assert.ok(
    violations.some((violation) => violation.includes('node:child_process')),
    JSON.stringify(violations),
  );
});

void test('executor graph guard uses the exact builtin allowlist required by the real graph', () => {
  const fixturePath = resolve(repositoryRoot, 'src/executor/main.ts');
  for (const specifier of EXPECTED_EXECUTOR_NODE_BUILTINS) {
    assert.deepEqual(
      executorBoundaryViolations(`import '${specifier}';`, fixturePath, repositoryRoot),
      [],
      specifier,
    );
  }
  for (const specifier of [
    'node:module', 'node:vm', 'node:child_process', 'node:worker_threads',
  ]) {
    const violations = executorBoundaryViolations(`import '${specifier}';`, fixturePath, repositoryRoot);
    assert.ok(
      violations.some((violation) => violation.includes(specifier)),
      `${specifier}: ${JSON.stringify(violations)}`,
    );
  }
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

void test('operator documentation describes the PostgreSQL-only, non-consuming executor dry-run', async () => {
  const [environment, readme, architecture] = await Promise.all([
    readFile(resolve(repositoryRoot, '.env.example'), 'utf8'),
    readFile(resolve(repositoryRoot, 'README.md'), 'utf8'),
    readFile(resolve(repositoryRoot, 'docs/architecture/pumpfun-v1.md'), 'utf8'),
  ]);

  const executorEnvironment = Object.fromEntries(
    [...environment.matchAll(/^(EXECUTOR_[A-Z_]+|LIVE_TRADING_ENABLED)=(.*)$/gmu)]
      .map((match) => [match[1] ?? '', match[2] ?? '']),
  );
  assert.deepEqual(executorEnvironment, {
    EXECUTOR_MODE: 'dry-run',
    EXECUTOR_POLL_MS: '1000',
    EXECUTOR_LEASE_MS: '30000',
    EXECUTOR_DB_STATEMENT_TIMEOUT_MS: '3000',
    EXECUTOR_SHUTDOWN_GRACE_MS: '10000',
    LIVE_TRADING_ENABLED: 'false',
  });
  assert.equal((environment.match(/^DATABASE_URL=postgresql:\/\//gmu) ?? []).length, 1);
  assert.match(environment, /executor dry-run[\s\S]*?ne requiert ni RPC Solana ni wallet/iu);
  assert.doesNotMatch(environment, /EXECUTOR_(?:PRIVATE_KEY|SECRET_KEY|KEYPAIR|KEYPAIR_PATH)=/u);

  assert.match(readme, /npm run build:backend\s+npm run db:migrate\s+EXECUTOR_MODE=dry-run DATABASE_URL=postgresql:\/\/\.\.\. npm run executor:start/u);
  assert.match(readme, /listener[^\n]*`observe`\|`paper`/iu);
  assert.match(readme, /ne requiert ni RPC Solana ni wallet/iu);
  assert.match(readme, /FOUNDATION_VALIDATED/);
  assert.match(readme, /INTENT_AND_LEASE_ONLY/);
  assert.equal((readme.match(/NOT_RUN/g) ?? []).length, 5);
  assert.match(readme, /ne consomme pas l'intention/iu);
  assert.match(readme, /#51-D[^\n]*quote[^\n]*build[^\n]*simulateTransaction/iu);
  assert.match(readme, /live[^\n]*(?:impossible|inutilisable)/iu);
  assert.doesNotMatch(readme, /n'existe encore aucun processus executor/iu);
  assert.doesNotMatch(readme, /#51-C à #51-G[\s\S]{0,160}(?:pas disponibles|indisponibles)/iu);
  assert.match(readme, /#51-C[^.\n]*livr[^.\n]*dry-run/iu);
  assert.match(readme, /#51-D à #51-G[^.\n]*ne sont pas livrées/iu);

  assert.match(architecture, /### Exécuteur dry-run PostgreSQL non consommant \(#51-C\)/u);
  const executorSection = architecture.slice(
    architecture.indexOf('### Exécuteur dry-run PostgreSQL non consommant (#51-C)'),
    architecture.indexOf('\n## ', architecture.indexOf('### Exécuteur dry-run PostgreSQL non consommant (#51-C)') + 1),
  );
  assert.match(executorSection, /FOUNDATION_VALIDATED/);
  assert.match(executorSection, /INTENT_AND_LEASE_ONLY/);
  assert.equal((executorSection.match(/NOT_RUN/g) ?? []).length, 5);
  assert.match(executorSection, /ne consomme pas l'intention/iu);
  assert.match(executorSection, /#51-D[^\n]*quote[^\n]*build[^\n]*simulateTransaction/iu);
  assert.match(executorSection, /ne requiert ni RPC Solana ni wallet/iu);
  assert.match(executorSection, /live[^\n]*(?:impossible|inutilisable)/iu);
  assert.doesNotMatch(executorSection, /#51-[DEFG][^\n]*(?:livré|livrée|implemented|complete)/iu);
});

void test('process integration registers each child immediately and bounds TERM then KILL cleanup', async () => {
  const integration = await readFile(
    resolve(repositoryRoot, 'tests/executor-main.integration.test.ts'),
    'utf8',
  );
  assert.match(integration, /context\.after\(\(\) => stopExecutorChild\(child\)\)/u);
  assert.match(integration, /CHILD_TERM_TIMEOUT_MS/u);
  assert.match(integration, /CHILD_KILL_TIMEOUT_MS/u);
  assert.match(integration, /child\.kill\('SIGTERM'\)/u);
  assert.match(integration, /child\.kill\('SIGKILL'\)/u);
  assert.match(integration, /Promise\.race/u);
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

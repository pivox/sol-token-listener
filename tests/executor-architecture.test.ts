import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  executorBoundaryViolations,
  literalRuntimeModuleSpecifiers,
  operationsFoundationBoundaryViolations,
  riskFoundationBoundaryViolations,
  simulationOnlyExecutorBoundaryViolations,
} from './helpers/execution-boundary.js';
import { reportExecutorEntrypointFailure } from '../src/executor/main.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const EXPECTED_DRY_RUN_NODE_BUILTINS = Object.freeze([
  'node:crypto',
  'node:fs/promises',
  'node:path',
  'node:url',
  'node:util/types',
]);

void test('source and compiled operations graphs remain inert and non-signing', async () => {
  for (const entry of [
    resolve(repositoryRoot, 'src/executor-operations/main.ts'),
    resolve(repositoryRoot, 'dist/src/executor-operations/main.js'),
  ]) {
    await access(entry);
    const graph = await readGraph(entry);
    assert.ok(graph.size >= 8, `operations graph unexpectedly small: ${relative(repositoryRoot, entry)}`);
    const violations: string[] = [];
    for (const [path, source] of graph) {
      violations.push(...operationsFoundationBoundaryViolations(source, path, repositoryRoot));
    }
    assert.deepEqual(violations, [],
      `unsafe operations graph from ${relative(repositoryRoot, entry)}`);
  }
});

void test('source and compiled readiness graphs stay read-only and outside live paths', async () => {
  for (const entry of [
    resolve(repositoryRoot, 'src/executor-readiness/main.ts'),
    resolve(repositoryRoot, 'dist/src/executor-readiness/main.js'),
  ]) {
    await access(entry);
    const graph = await readGraph(entry);
    assert.ok(graph.size >= 8,
      `readiness graph unexpectedly small: ${relative(repositoryRoot, entry)}`);
    assert.deepEqual(
      [...graph.keys()].filter((path) => /\/executor-(?:live|operations|simulation)\//u.test(path)),
      [],
    );
    for (const [path, source] of graph) {
      assert.doesNotMatch(source,
        /\b(?:Keypair|sendRawTransaction|sendTransaction|simulateTransaction|signMessage)\b/u,
        `signable capability in ${relative(repositoryRoot, path)}`);
    }
  }
});

void test('source and compiled dry-run worker graphs stay inside the strict dry-run allowlist', async () => {
  const entries = [
    resolve(repositoryRoot, 'src/executor/dry-run-worker.ts'),
    resolve(repositoryRoot, 'dist/src/executor/dry-run-worker.js'),
  ];
  for (const entry of entries) {
    await access(entry);
    const graph = await readGraph(entry);
    assert.ok(graph.size >= 5, `dry-run graph unexpectedly small: ${relative(repositoryRoot, entry)}`);
    const violations: string[] = [];
    const nodeBuiltins = new Set<string>();
    for (const [path, source] of graph) {
      violations.push(...executorBoundaryViolations(source, path, repositoryRoot));
      for (const specifier of literalRuntimeModuleSpecifiers(source, path)) {
        if (specifier.startsWith('node:')) nodeBuiltins.add(specifier);
      }
    }
    assert.deepEqual(violations, [], `unsafe executor graph from ${relative(repositoryRoot, entry)}`);
    assert.deepEqual(
      [...nodeBuiltins].sort(),
      EXPECTED_DRY_RUN_NODE_BUILTINS,
      `unexpected builtin dependency from ${relative(repositoryRoot, entry)}`,
    );
  }
});

void test('simulation-only guard permits the audited provider RPC and rejects every capability escape', () => {
  const providerPath = resolve(repositoryRoot, 'src/executor-simulation/provider-session.ts');
  assert.deepEqual(
    simulationOnlyExecutorBoundaryViolations(
      "this.dispatch('simulateTransaction', Object.freeze([]), signal);",
      providerPath,
      repositoryRoot,
    ),
    [],
  );

  const fixturePath = resolve(repositoryRoot, 'src/executor-simulation/attempt-evaluator.ts');
  for (const fixture of [
    "this.dispatch('simulateTransaction', [], signal);",
    "import { Keypair as K } from '@solana/web3.js'; new K();",
    "const { signTransaction: sign } = client; sign();",
    "client?.sendTransaction?.();",
    "client['send' + 'RawTransaction']();",
    "const submit = client['send' + 'Transaction']; submit();",
    "const simulate = client['simulate' + 'Transaction']; simulate();",
    'const acquired = client[methodName]; acquired();',
    "const { simulateTransaction: simulate } = client; simulate();",
    "Reflect.get(client, 'submitTransaction')();",
    "globalThis['Reflect'].get(client, 'signMessage')();",
    "global.Reflect.get(client, 'signMessage')();",
    "const root = global; root.process.mainModule.require('module');",
    "const r = globalThis; r['process'].getBuiltinModule('module');",
    "await import('./provider-session.js');",
    "import '../paper/quote.js';",
    "import '../listener/live.js';",
    "import '../markets/raydium/raydium-cpmm.adapter.js';",
  ]) {
    assert.ok(
      simulationOnlyExecutorBoundaryViolations(fixture, fixturePath, repositoryRoot).length > 0,
      fixture,
    );
  }
});

void test('simulation-only guard distinguishes reviewed data names from runtime capabilities', () => {
  const fixturePath = resolve(repositoryRoot, 'src/executor-simulation/attempt-evaluator.ts');
  const fixture = [
    'const global = decodeGlobal(account);',
    'const state = global;',
    'if (!state.initialized) throw new Error();',
    'const signer = index < requiredSignatures;',
    'if (meta.signer !== signer) throw new Error();',
    'function validate(global: Global): boolean { return global.initialized; }',
    'const keys = Reflect.ownKeys(value);',
    'for (const key of Reflect.ownKeys(value)) void key;',
  ].join('\n');
  assert.deepEqual(
    simulationOnlyExecutorBoundaryViolations(fixture, fixturePath, repositoryRoot),
    [],
  );
});

void test('runtime graph ignores erased type edges without hiding value imports', () => {
  const fixture = [
    "import type { TypeOnly } from './type-only.js';",
    "import { type NamedTypeOnly } from './named-type-only.js';",
    "export type { ExportedType } from './export-type-only.js';",
    "export { type NamedExportType } from './named-export-type-only.js';",
    "type Queried = import('./import-type-only.js').Queried;",
    "import DefaultValue, { type MixedType } from './default-value.js';",
    "import { type MixedNamedType, runtimeValue } from './mixed-value.js';",
    "export { type MixedExportType, runtimeExport } from './mixed-export.js';",
    "import './side-effect.js';",
    "await import('./dynamic-value.js');",
    "require('./required-value.js');",
  ].join('\n');
  assert.deepEqual(literalRuntimeModuleSpecifiers(fixture, 'runtime-graph-fixture.ts'), [
    './default-value.js',
    './mixed-value.js',
    './mixed-export.js',
    './side-effect.js',
    './dynamic-value.js',
    './required-value.js',
  ]);
});

void test('simulation-only guard restricts official SDKs to exact audited bridges', () => {
  const evaluatorPath = resolve(repositoryRoot, 'src/executor-simulation/attempt-evaluator.ts');
  for (const sdk of ['@pump-fun/pump-sdk', '@pump-fun/pump-swap-sdk']) {
    assert.ok(
      simulationOnlyExecutorBoundaryViolations(`import '${sdk}';`, evaluatorPath, repositoryRoot).length > 0,
      sdk,
    );
  }
  const pumpFunBridgePath = resolve(repositoryRoot, 'src/launchpads/pumpfun/official-sdk.ts');
  assert.deepEqual(
    simulationOnlyExecutorBoundaryViolations(
      [
        "import { createRequire } from 'node:module';",
        "const sdk = createRequire(import.meta.url)('@pump-fun/pump-sdk');",
      ].join('\n'),
      pumpFunBridgePath,
      repositoryRoot,
    ),
    [],
  );
  for (const hostile of [
    "import '@pump-fun/pump-sdk';",
    "import * as sdk from '@pump-fun/pump-sdk';",
    "import { createRequire as load } from 'node:module'; const sdk = load(import.meta.url)('@pump-fun/pump-sdk');",
    "import { createRequire } from 'node:module'; const sdk = createRequire(import.meta.url)('@pump-fun/pump-swap-sdk');",
    "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); const sdk = load('@pump-fun/pump-sdk');",
    "import { createRequire } from 'node:module'; const sdk = createRequire(__filename)('@pump-fun/pump-sdk');",
    "import { createRequire } from 'node:module'; const sdk = createRequire(import.meta.url)('@pump-fun/pump-sdk'); const other = createRequire(import.meta.url)('node:fs');",
  ]) assert.ok(
    simulationOnlyExecutorBoundaryViolations(hostile, pumpFunBridgePath, repositoryRoot).length > 0,
    hostile,
  );

  const pumpSwapBridgePath = resolve(repositoryRoot, 'src/markets/pumpswap/official-sdk.ts');
  assert.deepEqual(
    simulationOnlyExecutorBoundaryViolations(
      "import { PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';",
      pumpSwapBridgePath,
      repositoryRoot,
    ),
    [],
  );
  assert.deepEqual(
    simulationOnlyExecutorBoundaryViolations(
      "export { PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';",
      pumpSwapBridgePath,
      repositoryRoot,
    ),
    [],
  );
  for (const hostile of [
    "import * as sdk from '@pump-fun/pump-swap-sdk';",
    "import sdk from '@pump-fun/pump-swap-sdk';",
    "import { PUMP_AMM_SDK as sdk } from '@pump-fun/pump-swap-sdk';",
  ]) assert.ok(
    simulationOnlyExecutorBoundaryViolations(hostile, pumpSwapBridgePath, repositoryRoot).length > 0,
    hostile,
  );
});

void test('simulation-only graph keeps build receipt, plan builders and gateway construction at exact sites', async () => {
  const expected = Object.freeze([
    'src/executor-simulation/attempt-evaluator.ts:BuildReceiptAuthority:issue',
    'src/executor-simulation/attempt-evaluator.ts:BuildReceiptAuthority:new',
    'src/executor-simulation/attempt-evaluator.ts:SolanaSimulationGateway:new',
    'src/executor-simulation/attempt-evaluator.ts:buildPumpFunPlan:call',
    'src/executor-simulation/attempt-evaluator.ts:buildPumpSwapPlan:call',
  ]);
  const sourceGraph = await readGraph(resolve(repositoryRoot, 'src/executor/main.ts'));
  assert.deepEqual(executorConstructionSites(sourceGraph), expected);
  assert.deepEqual(
    executorConstructionSites(await readGraph(resolve(repositoryRoot, 'dist/src/executor/main.js'))),
    expected.map((site) => site.replace(/^src\//u, 'dist/src/').replace(/\.ts:/u, '.js:')),
  );
});

void test('official SDK bridges expose only the exact spec 1.0.9 surfaces', async () => {
  const pumpFunSurface = {
    runtime: [
      'GLOBAL_PDA', 'PUMP_FEE_CONFIG_PDA', 'PUMP_FEE_PROGRAM_ID', 'PUMP_PROGRAM_ID',
      'PUMP_SDK', 'bondingCurvePda', 'getBuySolAmountFromTokenAmount',
      'getBuyTokenAmountFromSolAmount', 'getSellSolAmountFromTokenAmount',
    ],
    types: ['BondingCurve', 'FeeConfig', 'Global'],
  };
  const pumpSwapSurface = {
    runtime: [
      'GLOBAL_CONFIG_PDA', 'OFFLINE_PUMP_AMM_PROGRAM', 'POOL_ACCOUNT_NEW_SIZE',
      'PUMP_AMM_EVENT_AUTHORITY_PDA', 'PUMP_AMM_FEE_CONFIG_PDA', 'PUMP_AMM_PROGRAM_ID',
      'PUMP_AMM_SDK', 'PUMP_FEE_PROGRAM_ID', 'buyQuoteInput', 'coinCreatorVaultAtaPda',
      'coinCreatorVaultAuthorityPda', 'lpMintPda', 'poolPda', 'poolV2Pda', 'pumpAmmJson',
      'pumpPoolAuthorityPda', 'sellBaseInput', 'userVolumeAccumulatorPda',
    ],
    types: ['FeeConfig', 'GlobalConfig', 'Pool', 'SwapSolanaState'],
  };
  for (const [path, expected] of [
    ['src/launchpads/pumpfun/official-sdk.ts', pumpFunSurface],
    ['src/markets/pumpswap/official-sdk.ts', pumpSwapSurface],
  ] as const) {
    assert.deepEqual(
      sdkBridgeExportSurface(await readFile(resolve(repositoryRoot, path), 'utf8'), path),
      expected,
      path,
    );
    assert.deepEqual(
      sdkBridgeExportSurface(
        await readFile(resolve(repositoryRoot, path.replace(/^src\//u, 'dist/src/').replace(/\.ts$/u, '.js')), 'utf8'),
        path.replace(/\.ts$/u, '.js'),
      ),
      { runtime: expected.runtime, types: [] },
      `compiled ${path}`,
    );
  }
});

void test('source and compiled simulation-only graphs keep simulation, persistence, and raw evidence boundaries exact', async () => {
  const entries = [
    resolve(repositoryRoot, 'src/executor/main.ts'),
    resolve(repositoryRoot, 'dist/src/executor/main.js'),
  ];
  const violations: string[] = [];
  for (const entry of entries) {
    await access(entry);
    const graph = await readGraph(entry);
    violations.push(...[...graph].flatMap(([path, source]) =>
      simulationOnlyExecutorBoundaryViolations(source, path, repositoryRoot)
        .map((violation) => `${relative(repositoryRoot, entry)}: ${violation}`)));
    const rpcPaths = [...graph]
      .filter(([, source]) => /['"]simulateTransaction['"]/u.test(source))
      .map(([path]) => relative(repositoryRoot, path));
    const expectedRpcPath = entry.endsWith('.ts')
      ? 'src/executor-simulation/provider-session.ts'
      : 'dist/src/executor-simulation/provider-session.js';
    if (JSON.stringify(rpcPaths) !== JSON.stringify([expectedRpcPath])) {
      violations.push(`${relative(repositoryRoot, entry)}: simulateTransaction paths ${JSON.stringify(rpcPaths)}`);
    }
  }
  assert.deepEqual(violations, [], 'unsafe simulation-only executor graph');
});

void test('simulation artifacts persist only bounded derived evidence', async () => {
  for (const relativePath of [
    'src/domain/execution-simulation.ts',
    'src/ports/execution-simulation-repository.ts',
    'src/storage/execution-simulation.repository.ts',
  ]) {
    const source = await readFile(resolve(repositoryRoot, relativePath), 'utf8');
    assert.doesNotMatch(
      source,
      /(?:transaction|message|account)[_-]?(?:bytes|base64)|signature(?:s)?|raw[_-]?logs?|logs?[_-]?(?:raw|text)/iu,
      `${relativePath} must only persist hashes/counts, never raw simulation evidence`,
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
    "const key = 'Reflect'; const R = Object.getOwnPropertyDescriptor(globalThis, key)?.value; R.get(client, 'sendTransaction')();",
    "const record = globalThis; const key = 'Reflect'; const R = record[key]; R.get(client, 'sendTransaction')();",
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
  for (const specifier of EXPECTED_DRY_RUN_NODE_BUILTINS) {
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

void test('risk foundation source and dist graphs remain inert and closed', async () => {
  for (const relativeEntry of [
    'src/executor-risk/admission-service.ts',
    'src/executor-risk/reconciliation-service.ts',
    'src/storage/execution-risk.repository.ts',
    'dist/src/executor-risk/admission-service.js',
    'dist/src/executor-risk/reconciliation-service.js',
    'dist/src/storage/execution-risk.repository.js',
  ]) {
    const entry = resolve(repositoryRoot, relativeEntry);
    await access(entry);
    const violations = [...(await readGraph(entry)).entries()].flatMap(([path, source]) =>
      riskFoundationBoundaryViolations(source, path, repositoryRoot));
    assert.deepEqual(violations, [], relativeEntry);
  }
  const fixturePath = resolve(repositoryRoot, 'src/executor-risk/admission-service.ts');
  for (const fixture of [
    "import '../listener/service.js';",
    "import '../api/server.js';",
    "import '../paper/paper-trading-engine.js';",
    "import '../markets/raydium/raydium-cpmm.adapter.js';",
    "import { Keypair } from '@solana/web3.js'; new Keypair();",
    'client.sendTransaction();',
    'client.submitTransaction();',
    'client.signTransaction();',
    "await import('../storage/database.js');",
    "require('../storage/database.js');",
    'eval(source);',
  ]) assert.ok(
    riskFoundationBoundaryViolations(fixture, fixturePath, repositoryRoot).length > 0,
    fixture,
  );
});

void test('only the six inert operations commands expose live-prefixed operator vocabulary', async () => {
  const [main, packageText, environment] = await Promise.all([
    readFile(resolve(repositoryRoot, 'src/executor/main.ts'), 'utf8'),
    readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
    readFile(resolve(repositoryRoot, '.env.example'), 'utf8'),
  ]);
  assert.doesNotMatch(main, /executor-risk|execution-risk\.repository|admitBuy|reconcile/iu);
  const scripts = (JSON.parse(packageText) as { scripts?: Record<string, unknown> }).scripts ?? {};
  assert.equal(Object.keys(scripts).some((name) => /risk/iu.test(name)), false);
  const liveScripts = Object.entries(scripts).filter(([name]) => name.startsWith('live:'));
  assert.deepEqual(liveScripts.map(([name]) => name).sort(), [
    'live:arm', 'live:kill-switch', 'live:preflight',
    'live:report', 'live:resume', 'live:status',
  ]);
  for (const [, command] of liveScripts) {
    assert.equal(typeof command, 'string');
    assert.match(command as string, /dist\/src\/executor-operations\/main\.js/u);
    assert.doesNotMatch(command as string, /dist\/src\/executor\/main\.js/u);
  }
  assert.doesNotMatch(environment, /^EXECUTOR_(?:RISK|ADMISSION|RECONCILIATION|LIVE)_[A-Z_]*=/gmu);
  assert.doesNotMatch(environment, /^EXECUTOR_MODE=(?:risk|live|armed)$/gmu);
});

void test('operator documentation describes the PostgreSQL-only, non-consuming executor dry-run', async () => {
  const [environment, readme, architecture] = await Promise.all([
    readFile(resolve(repositoryRoot, '.env.example'), 'utf8'),
    readFile(resolve(repositoryRoot, 'README.md'), 'utf8'),
    readFile(resolve(repositoryRoot, 'docs/architecture/pumpfun-v1.md'), 'utf8'),
  ]);

  const executorEnvironment = Object.fromEntries(
    [...environment.matchAll(/^(EXECUTOR_[A-Z0-9_]+|LIVE_TRADING_ENABLED)=(.*)$/gmu)]
      .map((match) => [match[1] ?? '', match[2] ?? '']),
  );
  assert.deepEqual(executorEnvironment, {
    EXECUTOR_MODE: 'dry-run',
    EXECUTOR_POLL_MS: '1000',
    EXECUTOR_LEASE_MS: '35000',
    EXECUTOR_DB_STATEMENT_TIMEOUT_MS: '3000',
    EXECUTOR_SHUTDOWN_GRACE_MS: '10000',
    EXECUTOR_PUBLIC_KEY: '',
    EXECUTOR_KEYPAIR_PATH: '',
    EXECUTOR_RPC_PROVIDER_ID: 'primary',
    EXECUTOR_WALLET_GENERATION_ID: '',
    EXECUTOR_BUILD_HASH: '',
    EXECUTOR_CONFIGURATION_FINGERPRINT: '',
    EXECUTOR_STRATEGY_FINGERPRINT: '',
    EXECUTOR_ACTIVATION_PHASE: 'CANARY',
    EXECUTOR_OPERATOR_ID: '',
    EXECUTOR_PREFLIGHT_EVIDENCE_PATH: '',
    EXECUTOR_CANARY_EVIDENCE_PATH: '',
    EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: '',
    EXECUTOR_QUOTE_MAX_AGE_MS: '3000',
    EXECUTOR_SLIPPAGE_BPS: '500',
    EXECUTOR_SNAPSHOT_MAX_SLOT_LAG: '8',
    EXECUTOR_MAX_COMPUTE_UNITS: '300000',
    EXECUTOR_MAX_FEE_LAMPORTS: '100000',
    EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT: '2500000',
    EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS: '0',
    EXECUTOR_RPC_TIMEOUT_MS: '5000',
    EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '8',
    LIVE_TRADING_ENABLED: 'false',
  });
  assert.equal((environment.match(/^DATABASE_URL=postgresql:\/\//gmu) ?? []).length, 1);
  assert.match(environment, /mode executor[^\n]*dry-run[\s\S]*?sans RPC Solana ni wallet/iu);
  assert.doesNotMatch(environment, /EXECUTOR_(?:PRIVATE_KEY|SECRET_KEY|KEYPAIR)=/u);
  assert.match(environment, /^EXECUTOR_KEYPAIR_PATH=$/mu);

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
  assert.match(readme, /#51-D[^.\n]*(?:ajoute|simulation-only|preuve)/iu);

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
  assert.match(executorSection, /#51-D[^.\n]*(?:ajoute|simulation-only|preuve)/iu);
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

void test('source and compiled live capability remains isolated in exact files', async () => {
  const expectedLiveFiles = [
    'confirmation-worker',
    'config',
    'database',
    'deadline-exit.service',
    'execution-worker',
    'fresh-execution',
    'keypair-loader',
    'lanes',
    'logger',
    'main',
    'reconciliation-worker',
    'rpc-gateway',
    'runtime',
    'signed-simulation-context',
    'signed-simulation-gateway',
    'startup-validator',
    'submission-gateway',
    'transaction-preparer',
  ];
  for (const [prefix, extension] of [['src', 'ts'], ['dist/src', 'js']] as const) {
    for (const file of expectedLiveFiles) {
      await access(resolve(repositoryRoot, `${prefix}/executor-live/${file}.${extension}`));
    }
    const sources = await Promise.all(expectedLiveFiles.map(async (file) => Object.freeze({
      file,
      source: await readFile(resolve(repositoryRoot, `${prefix}/executor-live/${file}.${extension}`), 'utf8'),
    })));
    const signingSites = sources
      .filter(({ source }) => /\bsignMessage\s*\(/u.test(source))
      .map(({ file }) => `${prefix}/executor-live/${file}.${extension}`)
      .sort();
    assert.deepEqual(signingSites, [
      `${prefix}/executor-live/keypair-loader.${extension}`,
      `${prefix}/executor-live/transaction-preparer.${extension}`,
    ]);
    const submissionSites = sources
      .filter(({ source }) => /\.sendRawTransaction\s*\(/u.test(source))
      .map(({ file }) => `${prefix}/executor-live/${file}.${extension}`);
    assert.deepEqual(submissionSites, [`${prefix}/executor-live/submission-gateway.${extension}`]);
    const mainGraph = await readGraph(resolve(repositoryRoot, `${prefix}/executor-live/main.${extension}`));
    assert.equal(
      [...mainGraph.keys()].some((path) => path.endsWith(`/executor-live/submission-gateway.${extension}`)),
      true,
      'H2b production composition must reach the live submission boundary',
    );
    assert.deepEqual(
      [...mainGraph.keys()].filter((path) => path.includes('/executor-live-recovery/')),
      [],
      'H2b must not reach the H2a recovery graph',
    );
    const recoveryGraph = await readGraph(resolve(
      repositoryRoot, `${prefix}/executor-live-recovery/main.${extension}`,
    ));
    assert.deepEqual(
      [...recoveryGraph.keys()].filter((path) => path.includes('/executor-live/')),
      [],
      'H2a must not reach the H2b graph',
    );
  }
});

void test('listener, API, dry-run and operations graphs cannot reach executor-live', async () => {
  for (const entry of [
    'src/app.ts',
    'src/executor/main.ts',
    'src/executor-operations/main.ts',
    'dist/src/app.js',
    'dist/src/executor/main.js',
    'dist/src/executor-operations/main.js',
  ]) {
    const graph = await readGraph(resolve(repositoryRoot, entry));
    assert.deepEqual(
      [...graph.keys()].filter((path) => path.includes('/executor-live/')),
      [],
      entry,
    );
  }
});

async function readGraph(entry: string): Promise<ReadonlyMap<string, string>> {
  const graph = new Map<string, string>();
  const visit = async (path: string): Promise<void> => {
    if (graph.has(path)) return;
    const source = await readFile(path, 'utf8');
    graph.set(path, source);
    for (const specifier of literalRuntimeModuleSpecifiers(source, path)) {
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

const CONSTRUCTION_CAPABILITIES = Object.freeze([
  'BuildReceiptAuthority',
  'SolanaSimulationGateway',
  'buildPumpFunPlan',
  'buildPumpSwapPlan',
] as const);
type ConstructionCapability = typeof CONSTRUCTION_CAPABILITIES[number];

function executorConstructionSites(graph: ReadonlyMap<string, string>): readonly string[] {
  const sites: string[] = [];
  for (const [path, source] of graph) {
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
    const aliases = importedConstructionCapabilities(sourceFile);
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const capability = aliases.get(node.expression.text);
        if (capability === 'BuildReceiptAuthority' || capability === 'SolanaSimulationGateway') {
          sites.push(constructionSite(path, capability, 'new'));
        }
      }
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          const capability = aliases.get(node.expression.text);
          if (capability === 'buildPumpFunPlan' || capability === 'buildPumpSwapPlan') {
            sites.push(constructionSite(path, capability, 'call'));
          }
        }
        if (isIssueAccess(node.expression)) {
          sites.push(constructionSite(path, 'BuildReceiptAuthority', 'issue'));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return Object.freeze(sites.sort());
}

function importedConstructionCapabilities(sourceFile: ts.SourceFile): ReadonlyMap<string, ConstructionCapability> {
  const aliases = new Map<string, ConstructionCapability>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      const importedName = binding.propertyName?.text ?? binding.name.text;
      if (isConstructionCapability(importedName)) aliases.set(binding.name.text, importedName);
    }
  }
  return aliases;
}

function isConstructionCapability(value: string): value is ConstructionCapability {
  return CONSTRUCTION_CAPABILITIES.some((capability) => capability === value);
}

function isIssueAccess(expression: ts.LeftHandSideExpression): boolean {
  return (ts.isPropertyAccessExpression(expression) && expression.name.text === 'issue')
    || (ts.isElementAccessExpression(expression)
      && ts.isStringLiteralLike(expression.argumentExpression)
      && expression.argumentExpression.text === 'issue');
}

function constructionSite(path: string, capability: ConstructionCapability, operation: string): string {
  return `${relative(repositoryRoot, path).replaceAll('\\', '/')}:${capability}:${operation}`;
}

function sdkBridgeExportSurface(source: string, path: string): {
  readonly runtime: readonly string[];
  readonly types: readonly string[];
} {
  const runtime: string[] = [];
  const types: string[] = [];
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause)) {
        (statement.isTypeOnly ? types : runtime).push('*');
        continue;
      }
      for (const element of clause.elements) {
        (statement.isTypeOnly || element.isTypeOnly ? types : runtime).push(element.name.text);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      runtime.push('default');
      continue;
    }
    if (!hasExportModifier(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        appendBindingNames(declaration.name, runtime);
      }
      continue;
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isEnumDeclaration(statement)) && statement.name !== undefined) {
      runtime.push(statement.name.text);
      continue;
    }
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
      && statement.name !== undefined) {
      types.push(statement.name.text);
    }
  }
  return Object.freeze({ runtime: Object.freeze(runtime.sort()), types: Object.freeze(types.sort()) });
}

function appendBindingNames(name: ts.BindingName, output: string[]): void {
  if (ts.isIdentifier(name)) {
    output.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) appendBindingNames(element.name, output);
  }
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)
    ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function scriptKind(path: string): ts.ScriptKind {
  return path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

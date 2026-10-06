import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ApiProjectionPipelineState } from '../src/storage/api-projection.repository.js';
import { parseConfig } from '../src/config/env.js';
import {
  reportEntrypointFailure,
  runApplication,
  waitForShutdownSignal,
  parseListenerStartupOptions,
  type ApplicationDependencies,
} from '../src/app.js';
import { ListenerRuntimeError } from '../src/application/listener-runtime.js';
import type { ApiEventStreamRepository } from '../src/ports/api-event-stream-repository.js';
import type { ApiProjectionRepository } from '../src/ports/api-projection-repository.js';
import { QualificationProfileError } from '../src/qualification/qualification-profile.js';
import { createQualificationEngine as buildQualificationEngine } from '../src/qualification/qualification-engine.js';
import { executionBoundaryViolations } from './helpers/execution-boundary.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

const config = parseConfig({
  SOLANA_HTTP_RPC_URL: 'https://rpc.example.invalid',
  SOLANA_WS_RPC_URL: 'wss://rpc.example.invalid',
});

void test('bootstrap imports no signing, submission, or live execution path', async () => {
  const source = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');
  assert.deepEqual(executionBoundaryViolations(source, fileURLToPath(new URL('../src/app.ts', import.meta.url)), repositoryRoot), []);
});

void test('production qualification import graph has no signing, simulation, or submission path', async () => {
  const graph = await readLocalImportGraph(
    fileURLToPath(new URL('../src/application/production-listener-factory.ts', import.meta.url)),
  );
  const violations: string[] = [];
  for (const [path, source] of graph) {
    violations.push(...executionBoundaryViolations(source, path, repositoryRoot));
    if (/\b(?:Keypair|sendTransaction|signTransaction|simulateTransaction)\b/u.test(source)) {
      violations.push(`Forbidden execution symbol in ${path}`);
    }
  }
  assert.deepEqual(violations, []);
});

void test('paper dry-run bootstrap imports no signing, submission, or live execution path', async () => {
  const path = fileURLToPath(new URL('../src/cli/paper-dry-run.ts', import.meta.url));
  const source = await readFile(path, 'utf8');
  assert.deepEqual(executionBoundaryViolations(source, path, repositoryRoot), []);
  assert.doesNotMatch(source, /sendTransaction|simulateTransaction|signTransaction|Keypair|WalletSigner/iu);
});

void test('bootstrap boundary guard detects dynamic import and export-from execution dependencies', () => {
  const source = [
    'import type { Wallet } from "../execution/wallet.js";',
    'export {} from "../dex/raydium-cpmm/transaction-builder.js";',
    'await import("../execution/keypair.js");',
    'type SubmissionModule = import("../execution/submission.js").Submission;',
    'import Wallet = require("../execution/wallet.js");',
    'import "../execution/order-sender.js";',
    'import "../wallet-utils.js";',
  ].join('\n');
  assert.equal(executionBoundaryViolations(source, '/repo/src/qualification/engine.ts', '/repo').length, 7);
  assert.equal(executionBoundaryViolations('const module = "../execution/order-sender.js"; await import(module);', '/repo/src/qualification/engine.ts', '/repo').length, 1);
  assert.equal(executionBoundaryViolations('require("../execution/wallet.js");', '/repo/src/qualification/engine.ts', '/repo').length, 2);
  assert.equal(executionBoundaryViolations('require(module);', '/repo/src/qualification/engine.ts', '/repo').length, 2);
  assert.equal(executionBoundaryViolations("client['sendTransaction']();", '/repo/src/qualification/engine.ts', '/repo').length, 1);
  assert.deepEqual(executionBoundaryViolations('form.submit(); import "../wallet-utils.js";', '/repo/src/qualification/engine.ts', '/repo'), []);
});

void test('migrates, starts listener before API, then closes listener before API and database', async () => {
  const calls: string[] = [];
  const pool = {};
  const runtime = listener(calls, {
    httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING', qualification: 'RUNNING', paperDecision: 'RUNNING', social: 'RUNNING',
  });
  await runApplication(dependencies(calls, {
    loadConfig: () => ({ ...config, listenerEnabled: true, apiEnabled: true, autoMigrate: true }),
    getDatabasePool: () => { calls.push('pool'); return pool; },
    migrateDatabase: async (received) => {
      assert.equal(received, pool);
      calls.push('migrate');
      return [];
    },
    createListener: (received, receivedConfig) => {
      assert.equal(received, pool);
      assert.equal(receivedConfig.executionMode, 'observe');
      calls.push('listener.create');
      return runtime;
    },
    createProjectionRepository: (received, pipeline, _holderLimits, qualificationProfile) => {
      assert.equal(received, pool);
      assert.deepEqual(pipeline(), runtime.pipelineState());
      assert.deepEqual(qualificationProfile, {
        id: 'pumpfun-v1-initial', version: 1, status: 'UNVALIDATED_RULE_SET',
        fingerprint: 'a'.repeat(64), minimumTotalScore: 60,
      });
      calls.push('projections');
      return {} as ApiProjectionRepository;
    },
  }));

  assert.deepEqual(calls, [
    'log:listener.foundation_ready', 'pool', 'migrate', 'log:database.migrations_applied',
    'listener.create', 'listener.start', 'projections', 'stream', 'server.create',
    'server.listen', 'log:api.started', 'signal.wait', 'listener.close',
    'server.close', 'database.close',
  ]);
});

void test('keeps an API-disabled listener alive until shutdown', async () => {
  const calls: string[] = [];
  await runApplication(dependencies(calls, {
    loadConfig: () => ({ ...config, listenerEnabled: true, apiEnabled: false, autoMigrate: false }),
    createApiServer: () => { throw new Error('must not create API'); },
  }));
  assert.deepEqual(calls, [
    'log:listener.foundation_ready', 'pool', 'listener.create', 'listener.start',
    'signal.wait', 'listener.close', 'database.close',
  ]);
});

void test('explicit diagnostic disablement logs listener.disabled without opening resources', async () => {
  const calls: string[] = [];
  await runApplication(dependencies(calls, {
    loadConfig: () => ({ ...config, listenerEnabled: false, apiEnabled: false, autoMigrate: false }),
    getDatabasePool: () => { throw new Error('must not open database'); },
    waitForShutdownSignal: async () => { throw new Error('must not wait'); },
  }));
  assert.deepEqual(calls, ['log:listener.foundation_ready', 'log:listener.disabled']);
});

void test('logs only the effective qualification profile identity at foundation startup', async () => {
  const logs: object[] = [];
  await runApplication(dependencies([], {
    loadConfig: () => ({ ...config, listenerEnabled: false, apiEnabled: false, autoMigrate: false }),
    createQualificationEngine: () => ({
      minimumTotalScore: 60,
      profileSummary: Object.freeze({
        id: 'pumpfun-v1-initial',
        version: 1,
        status: 'UNVALIDATED_RULE_SET' as const,
        fingerprint: 'a'.repeat(64),
        minimumTotalScore: 60,
      }),
    }),
    logInfo: (context) => { logs.push(context); },
  }));

  assert.deepEqual(logs[0], {
    event: 'listener.foundation_ready',
    executionMode: 'observe',
    cluster: 'mainnet-beta',
    paperQuoteMintAllowlist: [config.wsolMint],
    qualificationProfileId: 'pumpfun-v1-initial',
    qualificationProfileVersion: 1,
    qualificationRuleSetStatus: 'UNVALIDATED_RULE_SET',
    qualificationProfileFingerprint: 'a'.repeat(64),
    qualificationMinimumScore: 60,
    pumpFunListenerActive: false,
    pumpSwapPipelineAvailable: true,
    transactionSubmissionEnabled: false,
  });
});

void test('selected invalid profile prevents every database, listener, and API resource', async () => {
  const calls: string[] = [];
  await assert.rejects(runApplication(dependencies(calls, {
    loadConfig: () => ({
      ...config,
      qualificationProfilePath: './tests/fixtures/not-a-qualification-profile.json',
    }),
    createQualificationEngine: (received) => {
      calls.push('profile.load');
      return buildQualificationEngine(received);
    },
    getDatabasePool: () => { calls.push('pool'); throw new Error('must not open pool'); },
    createListener: () => { calls.push('listener.create'); throw new Error('must not create listener'); },
    createApiServer: () => { calls.push('server.create'); throw new Error('must not create API'); },
  })), (error: unknown) => error instanceof QualificationProfileError && error.code === 'PROFILE_READ_FAILED');
  assert.deepEqual(calls, ['profile.load']);

  const logs: object[] = [];
  reportEntrypointFailure(new QualificationProfileError('PROFILE_SCHEMA_INVALID'), { exitCode: undefined }, (context) => { logs.push(context); });
  assert.match(JSON.stringify(logs), /QualificationProfileError/u);
  assert.match(JSON.stringify(logs), /PROFILE_SCHEMA_INVALID/u);
  assert.doesNotMatch(JSON.stringify(logs), /qualification-profile-path|file-content|"cause":/u);
});

void test('explicit listener disablement exposes STOPPED pipeline state to the API', async () => {
  const calls: string[] = [];
  let pipeline: (() => ApiProjectionPipelineState) | null = null;
  await runApplication(dependencies(calls, {
    loadConfig: () => ({ ...config, listenerEnabled: false, apiEnabled: true, autoMigrate: false }),
    createListener: () => { throw new Error('must not create listener'); },
    createProjectionRepository: (_pool, receivedPipeline) => {
      pipeline = receivedPipeline;
      return {} as ApiProjectionRepository;
    },
  }));
  assert.notEqual(pipeline, null);
  assert.deepEqual((pipeline as unknown as () => ApiProjectionPipelineState)(), {
    httpAvailable: true, pumpfun: 'STOPPED', pumpswap: 'STOPPED', qualification: 'STOPPED', paperDecision: 'STOPPED', social: 'STOPPED',
  });
  assert.ok(calls.includes('log:listener.disabled'));
  assert.doesNotMatch(calls.join(','), /listener\.create|listener\.start|listener\.close/u);
});

void test('listener startup failure fails the process and cleans listener before database', async () => {
  const calls: string[] = [];
  const startupFailure = new Error('listener startup failure');
  await assert.rejects(runApplication(dependencies(calls, {
    loadConfig: () => ({ ...config, listenerEnabled: true, apiEnabled: true }),
    createListener: () => ({
      async start() { calls.push('listener.start'); throw startupFailure; },
      async close() { calls.push('listener.close'); },
      state: () => 'DEGRADED',
      pipelineState: () => ({
        httpAvailable: true, pumpfun: 'DEGRADED', pumpswap: 'DEGRADED', qualification: 'DEGRADED', paperDecision: 'DEGRADED', social: 'DEGRADED',
      }),
    }),
  })), (error: unknown) => error === startupFailure);
  assert.deepEqual(calls, [
    'log:listener.foundation_ready', 'pool', 'listener.start', 'listener.close',
    'database.close',
  ]);
});

void test('API bind failure aggregates listener, server, and database cleanup in order', async () => {
  const calls: string[] = [];
  const bindFailure = new Error('bind failure');
  const listenerFailure = new Error('listener cleanup failure');
  const serverFailure = new Error('server cleanup failure');
  const databaseFailure = new Error('database cleanup failure');
  await assert.rejects(runApplication(dependencies(calls, {
    loadConfig: () => ({ ...config, listenerEnabled: true, apiEnabled: true }),
    createListener: () => ({
      async start() { calls.push('listener.start'); },
      async close() { calls.push('listener.close'); throw listenerFailure; },
      state: () => 'RUNNING',
      pipelineState: () => ({
        httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING', qualification: 'RUNNING', paperDecision: 'RUNNING', social: 'RUNNING',
      }),
    }),
    createApiServer: () => ({
      async listen() { calls.push('server.listen'); throw bindFailure; },
      async close() { calls.push('server.close'); throw serverFailure; },
    }),
    closeDatabase: async () => { calls.push('database.close'); throw databaseFailure; },
  })), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [bindFailure, listenerFailure, serverFailure, databaseFailure]);
    return true;
  });
  assert.ok(calls.indexOf('listener.close') < calls.indexOf('server.close'));
  assert.ok(calls.indexOf('server.close') < calls.indexOf('database.close'));
});

void test('terminal handler redacts the failure and sets exitCode', () => {
  const runtime: { exitCode: number | string | undefined } = { exitCode: undefined };
  const logs: object[] = [];
  reportEntrypointFailure(new Error('credential-like-detail'), runtime, (context) => { logs.push(context); });
  assert.equal(runtime.exitCode, 1);
  assert.match(JSON.stringify(logs), /"errorName":"Error"/u);
  assert.match(JSON.stringify(logs), /credential-like-detail/u);
});

void test('terminal handler reads only a bounded own enumerable name data descriptor', () => {
  let getterReads = 0;
  const getter = Object.defineProperty({}, 'name', {
    enumerable: true,
    get() { getterReads += 1; throw new Error('getter secret'); },
  });
  const prototype = Object.create(Object.defineProperty({}, 'name', {
    get() { getterReads += 1; throw new Error('prototype secret'); },
  })) as object;
  const proxy = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error('proxy descriptor secret'); },
    getPrototypeOf() { throw new Error('proxy prototype secret'); },
    get() { throw new Error('proxy get secret'); },
  });
  const errors: unknown[] = [getter, prototype, proxy, 'primitive secret', {
    name: 'x'.repeat(65), message: 'password=FAKE_SECRET_113',
  }];

  for (const error of errors) {
    const logs: object[] = [];
    assert.doesNotThrow(() => {
      reportEntrypointFailure(
        error,
        { exitCode: undefined },
        (context) => { logs.push(context); },
      );
    });
    assert.equal(logs.length, 1);
    assert.doesNotMatch(JSON.stringify(logs), /FAKE_SECRET_113/u);
  }
  assert.equal(getterReads, 0);

  const logs: object[] = [];
  reportEntrypointFailure(
    { name: 'ListenerStartupError', message: 'password=FAKE_PASSWORD_992' },
    { exitCode: undefined },
    (context) => { logs.push(context); },
  );
  assert.match(JSON.stringify(logs), /ListenerStartupError/u);
  assert.doesNotMatch(JSON.stringify(logs), /FAKE_PASSWORD_992/u);
});

void test('startup failure diagnostics retain stage, safe code, and nested causes while redacting credentials', () => {
  const runtime: { exitCode: number | string | undefined } = { exitCode: undefined };
  const logs: object[] = [];
  const rootCause = Object.assign(new Error('request failed https://rpc.example.invalid/path?api-key=FAKE_RPC_TOKEN_87'), {
    code: 'ECONNREFUSED',
    cause: new Error('database postgresql://user:FAKE_DB_PASSWORD_21@localhost/db failed'),
  });
  const runtimeError = new ListenerRuntimeError([{
    phase: 'startup', stage: 'subscriber-start', errorName: 'ListenerDependencyError', cause: rootCause,
  }]);
  const error = new AggregateError([runtimeError, new Error('password=FAKE_CLEANUP_SECRET_41')], 'shutdown failed');

  reportEntrypointFailure(error, runtime, (context) => { logs.push(context); });

  const serialized = JSON.stringify(logs);
  assert.match(serialized, /subscriber-start/u);
  assert.match(serialized, /ECONNREFUSED/u);
  assert.match(serialized, /request failed/u);
  assert.match(serialized, /database/u);
  assert.match(serialized, /application-cleanup/u);
  assert.doesNotMatch(serialized, /FAKE_RPC_TOKEN_87|FAKE_DB_PASSWORD_21|FAKE_CLEANUP_SECRET_41|user:/u);
  assert.equal(runtime.exitCode, 1);
});

void test('catch-up window diagnostics retain bounded scanner facts but never endpoints', () => {
  const logs: object[] = [];
  const scannerError = Object.assign(new Error('Catch-up scan window was exceeded.'), {
    name: 'CatchUpWindowExceededError',
    code: 'CATCH_UP_WINDOW_EXCEEDED',
    diagnostic: {
      program: 'launchpad',
      checkpointSlot: '453623653',
      checkpointSignature: '12345678…abcdefgh',
      frontierSlot: '453700000',
      frontierSignature: 'ABCDEFGH…abcdefgh',
      pageSize: 100,
      maxPages: 20,
      pageCount: 20,
      signaturesRead: 2_000,
      newestSlot: '453623700',
      oldestSlot: '453623690',
      checkpointSignatureFound: false,
      exhaustion: 'page-budget-exhausted',
      endpoint: 'https://rpc-user:FAKE_RPC_PASSWORD@rpc.invalid/?api-key=FAKE_RPC_KEY',
    },
  });
  const error = new ListenerRuntimeError([{
    phase: 'startup', stage: 'scanner-scan', errorName: 'ListenerDependencyError', cause: scannerError,
  }]);

  reportEntrypointFailure(error, { exitCode: undefined }, (context) => { logs.push(context); });

  const serialized = JSON.stringify(logs);
  assert.match(serialized, /CATCH_UP_WINDOW_EXCEEDED/u);
  assert.match(serialized, /"program":"launchpad"/u);
  assert.match(serialized, /"pageCount":20/u);
  assert.match(serialized, /"signaturesRead":2000/u);
  assert.match(serialized, /"frontierSignature":"ABCDEFGH…abcdefgh"/u);
  assert.match(serialized, /"checkpointSignatureFound":false/u);
  assert.doesNotMatch(serialized, /FAKE_RPC_PASSWORD|FAKE_RPC_KEY|rpc-user|endpoint/u);
});

void test('cutover failure keeps the initial window proof and a separately filtered cause', () => {
  const logs: object[] = [];
  const window = Object.assign(new Error('Catch-up scan window was exceeded.'), {
    name: 'CatchUpWindowExceededError',
    code: 'CATCH_UP_WINDOW_EXCEEDED',
    diagnostic: {
      program: 'launchpad', checkpointSlot: '10', checkpointSignature: '12345678…abcdefgh',
      frontierSlot: '20', frontierSignature: 'ABCDEFGH…abcdefgh', pageSize: 1_000, maxPages: 20,
      pageCount: 20, signaturesRead: 20_000, newestSlot: '20', oldestSlot: '11',
      checkpointSignatureFound: false, exhaustion: 'page-budget-exhausted',
    },
  });
  const failure = new AggregateError([
    window,
    new Error('RPC failed for https://user:FAKE_PASSWORD@rpc.invalid/?token=FAKE_TOKEN'),
  ], 'cutover failed');
  failure.name = 'CatchUpCutoverFailureError';
  const runtimeError = new ListenerRuntimeError([{
    phase: 'startup', stage: 'scanner-scan', errorName: 'ListenerDependencyError', cause: failure,
  }]);

  reportEntrypointFailure(runtimeError, { exitCode: undefined }, (context) => { logs.push(context); });

  const parsed = logs[0] as { diagnostics: readonly Record<string, unknown>[] };
  assert.equal(parsed.diagnostics[0]?.stage, 'scanner-scan');
  const causes = parsed.diagnostics[0]?.causes as readonly Record<string, unknown>[];
  const primary = causes.find((cause) => cause.code === 'CATCH_UP_WINDOW_EXCEEDED');
  assert.ok(primary);
  assert.equal((primary.catchUpWindow as Record<string, unknown>)?.frontierSlot, '20');
  assert.ok(causes.some((cause) => cause.errorName === 'CatchUpCutoverFailureError'));
  assert.ok(causes.some((cause) => cause.errorName === 'Error'));
  assert.doesNotMatch(JSON.stringify(parsed.diagnostics), /application-cleanup/u);
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /FAKE_PASSWORD|FAKE_TOKEN|rpc.invalid/u);
});

void test('isolated app startup honors DOTENV_CONFIG_PATH and does not read cwd .env', async () => {
  const root = await mkdtemp(join(tmpdir(), 'observe-env-isolation-'));
  const appPath = fileURLToPath(new URL('../src/app.ts', import.meta.url));
  const tsxLoader = fileURLToPath(import.meta.resolve('tsx'));
  try {
    await writeFile(join(root, '.env'), [
      'EXECUTION_MODE=paper',
      'PAPER_STRATEGY_ENABLED=true',
    ].join('\n'));
    await writeFile(join(root, 'live.env'), [
      'EXECUTION_MODE=observe',
      'SOLANA_HTTP_RPC_URL=https://rpc.example.invalid',
      'SOLANA_WS_RPC_URL=wss://rpc.example.invalid',
      'LISTENER_ENABLED=false',
      'API_ENABLED=false',
      'DASHBOARD_ENABLED=false',
      'POSTGRES_AUTO_MIGRATE=false',
    ].join('\n'));
    const child = spawnSync(process.execPath, [
      '--env-file=live.env', '--import', tsxLoader, appPath,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        HOME: root,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        DOTENV_CONFIG_PATH: '/dev/null',
      },
      timeout: 15_000,
    });

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /"executionMode":"observe"/u);
    assert.doesNotMatch(child.stdout + child.stderr, /PAPER_STRATEGY_ENABLED requires|FAKE_DOTENV_SENTINEL/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('signal waiter removes both listeners after the first signal', async () => {
  const signals = new EventEmitter();
  const waiting = waitForShutdownSignal(signals as unknown as Pick<NodeJS.Process, 'once' | 'off'>);
  signals.emit('SIGINT');
  assert.equal(await waiting, 'SIGINT');
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

void test('recorded live-edge cutover requires its exact explicit startup option', () => {
  assert.deepEqual(parseListenerStartupOptions([]), { allowRecordedLiveEdgeCutover: false });
  assert.deepEqual(parseListenerStartupOptions(['--allow-recorded-live-edge-cutover']), {
    allowRecordedLiveEdgeCutover: true,
  });
  assert.throws(() => parseListenerStartupOptions(['--force']), /Unsupported listener startup option/u);
  assert.throws(() => parseListenerStartupOptions([
    '--allow-recorded-live-edge-cutover', '--allow-recorded-live-edge-cutover',
  ]), /Unsupported listener startup option/u);
});

function dependencies(
  calls: string[],
  overrides: Partial<ApplicationDependencies> = {},
): Partial<ApplicationDependencies> {
  const runtime = listener(calls, {
    httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING', qualification: 'RUNNING', paperDecision: 'RUNNING', social: 'RUNNING',
  });
  return {
    loadConfig: () => config,
    createQualificationEngine: () => ({
      minimumTotalScore: 60,
      profileSummary: Object.freeze({
        id: 'pumpfun-v1-initial',
        version: 1,
        status: 'UNVALIDATED_RULE_SET' as const,
        fingerprint: 'a'.repeat(64),
        minimumTotalScore: 60,
      }),
    }),
    getDatabasePool: () => { calls.push('pool'); return {}; },
    migrateDatabase: async () => { calls.push('migrate'); return []; },
    createListener: () => { calls.push('listener.create'); return runtime; },
    createProjectionRepository: () => {
      calls.push('projections');
      return {} as ApiProjectionRepository;
    },
    createEventStreamRepository: () => {
      calls.push('stream');
      return {} as ApiEventStreamRepository;
    },
    createApiServer: () => {
      calls.push('server.create');
      return {
        async listen() { calls.push('server.listen'); return { host: '127.0.0.1', port: 32123 }; },
        async close() { calls.push('server.close'); },
      };
    },
    closeDatabase: async () => { calls.push('database.close'); },
    waitForShutdownSignal: async () => { calls.push('signal.wait'); return 'SIGTERM'; },
    logInfo: (context) => {
      const event = (context as { event?: unknown }).event;
      calls.push(`log:${typeof event === 'string' ? event : 'unknown'}`);
    },
    ...overrides,
  };
}

function listener(calls: string[], pipeline: ApiProjectionPipelineState): {
  start(): Promise<void>;
  close(): Promise<void>;
  state(): 'RUNNING';
  pipelineState(): ApiProjectionPipelineState;
} {
  return {
    async start() { calls.push('listener.start'); },
    async close() { calls.push('listener.close'); },
    state: () => 'RUNNING',
    pipelineState: () => Object.freeze({ ...pipeline }),
  };
}

async function readLocalImportGraph(entrypoint: string): Promise<ReadonlyMap<string, string>> {
  const graph = new Map<string, string>();
  const pending = [entrypoint];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || graph.has(path)) continue;
    const source = await readFile(path, 'utf8');
    graph.set(path, source);
    for (const match of source.matchAll(
      /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/gu,
    )) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const resolved = resolve(dirname(path), specifier.replace(/\.js$/u, '.ts'));
      if (!graph.has(resolved)) pending.push(resolved);
    }
  }
  return graph;
}

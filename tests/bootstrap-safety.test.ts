import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ApiProjectionPipelineState } from '../src/storage/api-projection.repository.js';
import { parseConfig } from '../src/config/env.js';
import {
  reportEntrypointFailure,
  runApplication,
  waitForShutdownSignal,
  type ApplicationDependencies,
} from '../src/app.js';
import { createPaperMvpRunnerLifecycle } from '../src/cli/paper-mvp-runtime.js';
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
    beforeStart: async (received) => {
      assert.equal(received, pool);
      calls.push('before.start');
    },
    migrateDatabase: async (received) => {
      assert.equal(received, pool);
      calls.push('migrate');
      return [];
    },
    afterMigrations: async (received) => {
      assert.equal(received, pool);
      calls.push('after.migrations');
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
    'log:listener.foundation_ready', 'pool', 'before.start', 'migrate',
    'log:database.migrations_applied', 'after.migrations',
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
  assert.deepEqual(logs, [{
    event: 'listener.start_failed',
    errorName: 'QualificationProfileError',
  }]);
  assert.doesNotMatch(JSON.stringify(logs), /path|content|cause/u);
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
    beforeDatabaseClose: async () => { calls.push('runner.release'); },
  })), (error: unknown) => error === startupFailure);
  assert.deepEqual(calls, [
    'log:listener.foundation_ready', 'pool', 'listener.start', 'listener.close',
    'runner.release', 'database.close',
  ]);
});

void test('lifecycle ownership loss during migration prevents listener startup', async () => {
  const calls: string[] = [];
  let ownershipLost = false;
  const loss = new Error('runner ownership lost');
  await assert.rejects(runApplication(dependencies(calls, {
    loadConfig: () => ({ ...config, listenerEnabled: true, apiEnabled: true, autoMigrate: true }),
    lifecycleGuard: Object.freeze({
      checkpoint: async () => {
        if (ownershipLost) throw loss;
      },
    }),
    migrateDatabase: async () => {
      calls.push('migrate');
      ownershipLost = true;
      return [];
    },
  })), (error: unknown) => error === loss);
  assert.equal(calls.includes('migrate'), true);
  assert.equal(calls.includes('listener.create'), false);
  assert.equal(calls.includes('server.create'), false);
  assert.equal(calls.at(-1), 'database.close');
});

void test('lifecycle ownership loss during listener start closes it before API startup', async () => {
  const calls: string[] = [];
  let ownershipLost = false;
  const loss = new Error('runner ownership lost');
  await assert.rejects(runApplication(dependencies(calls, {
    loadConfig: () => ({ ...config, listenerEnabled: true, apiEnabled: true, autoMigrate: false }),
    lifecycleGuard: Object.freeze({
      checkpoint: async () => {
        if (ownershipLost) throw loss;
      },
    }),
    createListener: () => ({
      async start() { calls.push('listener.start'); ownershipLost = true; },
      async close() { calls.push('listener.close'); },
      state: () => 'RUNNING',
      pipelineState: () => ({
        httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING', qualification: 'RUNNING', paperDecision: 'RUNNING', social: 'RUNNING',
      }),
    }),
  })), (error: unknown) => error === loss);
  assert.equal(calls.includes('listener.start'), true);
  assert.equal(calls.includes('server.create'), false);
  assert.ok(calls.indexOf('listener.close') < calls.indexOf('database.close'));
});

void test('lifecycle ownership loss during shutdown wait is observed before cleanup', async () => {
  const calls: string[] = [];
  let ownershipLost = false;
  const loss = new Error('runner ownership lost');
  await assert.rejects(runApplication(dependencies(calls, {
    loadConfig: () => ({ ...config, listenerEnabled: true, apiEnabled: false, autoMigrate: false }),
    lifecycleGuard: Object.freeze({
      checkpoint: async () => {
        if (ownershipLost) throw loss;
      },
    }),
    waitForShutdownSignal: async () => {
      calls.push('signal.wait');
      ownershipLost = true;
      return 'SIGTERM';
    },
  })), (error: unknown) => error === loss);
  assert.ok(calls.indexOf('signal.wait') < calls.indexOf('listener.close'));
  assert.ok(calls.indexOf('listener.close') < calls.indexOf('database.close'));
});

void test('paper MVP runner ownership remains held through listener and API teardown', async () => {
  const calls: string[] = [];
  const pool = Object.freeze({});
  const lifecycle = createPaperMvpRunnerLifecycle(async (receivedPool) => {
    assert.equal(receivedPool, pool);
    return Object.freeze({
      ownerId: 'paper-mvp-owner-test',
      lost: new Promise<void>(() => undefined),
      isLost: () => false,
      release: async () => { calls.push('runner.release'); },
    });
  });
  await runApplication(dependencies(calls, {
    loadConfig: () => ({ ...config, listenerEnabled: true, apiEnabled: true, autoMigrate: false }),
    getDatabasePool: () => { calls.push('pool'); return pool; },
    beforeStart: lifecycle.beforeStart,
    lifecycleGuard: Object.freeze({ checkpoint: lifecycle.checkpoint }),
    beforeDatabaseClose: lifecycle.beforeDatabaseClose,
    waitForShutdownSignal: async () => {
      const scopedLease = await lifecycle.acquireRunner(pool);
      await scopedLease.release();
      calls.push('runner.scope.closed');
      return 'SIGTERM';
    },
  }));
  assert.ok(calls.indexOf('runner.scope.closed') < calls.indexOf('listener.close'));
  assert.ok(calls.indexOf('listener.close') < calls.indexOf('server.close'));
  assert.ok(calls.indexOf('server.close') < calls.indexOf('runner.release'));
  assert.ok(calls.indexOf('runner.release') < calls.indexOf('database.close'));
  assert.equal(calls.filter((call) => call === 'runner.release').length, 1);
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
  assert.deepEqual(logs, [{ event: 'listener.start_failed', errorName: 'UnknownError' }]);
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
    name: 'x'.repeat(65), message: 'message secret',
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
    assert.deepEqual(logs, [{ event: 'listener.start_failed', errorName: 'UnknownError' }]);
    assert.doesNotMatch(JSON.stringify(logs), /secret/u);
  }
  assert.equal(getterReads, 0);

  const logs: object[] = [];
  reportEntrypointFailure(
    { name: 'ListenerStartupError', message: 'message secret' },
    { exitCode: undefined },
    (context) => { logs.push(context); },
  );
  assert.deepEqual(logs, [{ event: 'listener.start_failed', errorName: 'ListenerStartupError' }]);
  assert.doesNotMatch(JSON.stringify(logs), /secret/u);
});

void test('signal waiter removes both listeners after the first signal', async () => {
  const signals = new EventEmitter();
  const waiting = waitForShutdownSignal(signals as unknown as Pick<NodeJS.Process, 'once' | 'off'>);
  signals.emit('SIGINT');
  assert.equal(await waiting, 'SIGINT');
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
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

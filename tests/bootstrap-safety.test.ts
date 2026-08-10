import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
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
    httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING', social: 'RUNNING',
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
    createProjectionRepository: (received, pipeline) => {
      assert.equal(received, pool);
      assert.deepEqual(pipeline(), runtime.pipelineState());
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
    httpAvailable: true, pumpfun: 'STOPPED', pumpswap: 'STOPPED', social: 'STOPPED',
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
        httpAvailable: true, pumpfun: 'DEGRADED', pumpswap: 'DEGRADED', social: 'DEGRADED',
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
        httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING', social: 'RUNNING',
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
    httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING', social: 'RUNNING',
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

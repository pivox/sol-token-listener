import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { LiveRecoveryConfig } from '../src/executor-live-recovery/config.js';
import type { LiveRecoveryLogger } from '../src/executor-live-recovery/logger.js';
import {
  reportLiveRecoveryEntrypointFailure,
  startLiveRecovery,
  type LiveRecoveryBootstrapDependencies,
  type LiveRecoveryBootstrapDatabase,
} from '../src/executor-live-recovery/main.js';

const key = '11111111111111111111111111111111';

void test('bootstrap validates database and genesis before lanes and transfers cleanup to runtime', async () => {
  const calls: string[] = [];
  const database = fakeDatabase(calls);
  const dependencies: LiveRecoveryBootstrapDependencies = {
    parseConfig: () => { calls.push('config'); return config(); },
    openDatabase: async () => { calls.push('database'); return database; },
    validateStartup: async () => { calls.push('startup'); },
    verifyGenesis: async () => { calls.push('genesis'); },
    createLaneFactory: () => {
      calls.push('lane-factory');
      return () => ({
        reconciliation: async () => 'IDLE',
        confirmation: async () => 'IDLE',
        deadline: async () => 'IDLE',
      });
    },
    runtime: async (runtimeDependencies) => {
      calls.push('runtime');
      await runtimeDependencies.closeDatabase();
    },
    logger: logger(),
    forceExit: () => undefined,
  };

  await startLiveRecovery(Object.freeze({}), dependencies);
  assert.deepEqual(calls, [
    'config', 'database', 'startup', 'genesis', 'lane-factory', 'runtime', 'database.close',
  ]);
});

void test('startup or genesis rejection closes the database and never creates lanes', async () => {
  for (const failureAt of ['startup', 'genesis'] as const) {
    const calls: string[] = [];
    const expected = new Error(`${failureAt}-private-message`);
    await assert.rejects(startLiveRecovery(Object.freeze({}), {
      parseConfig: () => config(),
      openDatabase: async () => fakeDatabase(calls),
      validateStartup: async () => {
        calls.push('startup');
        if (failureAt === 'startup') throw expected;
      },
      verifyGenesis: async () => {
        calls.push('genesis');
        if (failureAt === 'genesis') throw expected;
      },
      createLaneFactory: () => { calls.push('lane-factory'); throw new Error('unexpected'); },
      runtime: async () => undefined,
      logger: logger(),
      forceExit: () => undefined,
    }), expected);
    assert.deepEqual(calls, failureAt === 'startup'
      ? ['startup', 'database.close']
      : ['startup', 'genesis', 'database.close']);
  }
});

void test('the published H2a graph and scripts contain no signer, keypair or submission authority', async () => {
  const [main, runtime, lanes, rpc, compiledMain, compiledRuntime, compiledLanes,
    compiledRpc, packageText] = await Promise.all([
    readFile(new URL('../src/executor-live-recovery/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/executor-live-recovery/runtime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/executor-live-recovery/lanes.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/executor-live-recovery/rpc-gateway.ts', import.meta.url), 'utf8'),
    readFile(new URL('../dist/src/executor-live-recovery/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../dist/src/executor-live-recovery/runtime.js', import.meta.url), 'utf8'),
    readFile(new URL('../dist/src/executor-live-recovery/lanes.js', import.meta.url), 'utf8'),
    readFile(new URL('../dist/src/executor-live-recovery/rpc-gateway.js', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);
  const graph = [
    main, runtime, lanes, rpc, compiledMain, compiledRuntime, compiledLanes, compiledRpc,
  ].join('\n');
  for (const forbidden of [
    'keypair-loader', 'execution-transaction-signer', 'submission-gateway',
    'beginSubmission', 'sendRawTransaction', "purpose: 'LIVE_EXECUTE'",
    "purpose: 'LIVE_RECOVER'", 'signed_transaction_bytes', '../executor-live/',
  ]) assert.equal(graph.includes(forbidden), false, forbidden);
  const packageJson = JSON.parse(packageText) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  assert.equal(
    packageJson.scripts?.['executor:live:recovery:start'],
    'node dist/src/executor-live-recovery/main.js',
  );
  assert.equal(
    packageJson.scripts?.['executor:live:recovery:dev'],
    'tsx src/executor-live-recovery/main.ts',
  );
  assert.equal(packageJson.scripts?.['executor:live:start'], undefined);
});

void test('fatal entrypoint output exposes only allowlisted identity', () => {
  let output = '';
  const runtime = {
    exitCode: undefined as number | undefined,
    stderr: { write: (chunk: string) => { output += chunk; return true; } },
  };
  reportLiveRecoveryEntrypointFailure(Object.assign(
    new Error('postgresql://credential@private.test'),
    { name: 'InjectedPrivateError', code: 'DATABASE_PASSWORD_SECRET' },
  ), runtime);
  assert.equal(runtime.exitCode, 1);
  assert.deepEqual(JSON.parse(output) as Record<string, unknown>, {
    service: 'sol-token-executor-live-recovery',
    event: 'executor_live_recovery.start_failed',
    errorName: 'UnknownError',
    errorCode: 'LIVE_RECOVERY_START_FAILED',
  });
  assert.equal(/credential|private|password/iu.test(output), false);
});

function fakeDatabase(calls: string[]): LiveRecoveryBootstrapDatabase {
  return Object.freeze({
    startup: Object.freeze({ query: () => Promise.reject(new Error('unexpected query')) }),
    intents: Object.freeze({}),
    live: Object.freeze({}),
    close: async () => { calls.push('database.close'); },
    evict: () => { calls.push('database.evict'); },
  }) as unknown as LiveRecoveryBootstrapDatabase;
}

function logger(): LiveRecoveryLogger {
  return Object.freeze({ info: () => undefined, warn: () => undefined, error: () => undefined });
}

function config(): LiveRecoveryConfig {
  return Object.freeze({
    mode: 'live', recoveryEnabled: true, cluster: 'mainnet-beta',
    databaseUrl: 'postgresql://ignored', pollMs: 100, leaseMs: 60_000,
    databaseStatementTimeoutMs: 3_000, shutdownGraceMs: 10_000,
    generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    executorPublicKey: key, providerId: 'primary',
    httpRpcUrl: 'https://rpc.example.test', expectedGenesisHash: key,
    rpcTimeoutMs: 5_000, maxRpcCallsPerPass: 8, ownerId: 'recovery-a',
  });
}

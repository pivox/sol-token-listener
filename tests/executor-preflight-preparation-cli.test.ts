import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ExecutionPreflightPreparationV1 } from
  '../src/domain/execution-preflight-preparation.js';
import type { ExecutionPreflightPreparationConfigV1 } from
  '../src/executor-preflight-preparation/config.js';
import {
  reportExecutionPreflightPreparationEntrypointFailure,
  startExecutionPreflightPreparation,
  type ExecutionPreflightPreparationBootstrapDependencies,
  type ExecutionPreflightPreparationBootstrapDatabase,
} from '../src/executor-preflight-preparation/main.js';
import type { ExecutionPreflightPreparationService } from
  '../src/executor-preflight-preparation/service.js';

void test('runs once, emits only a redacted terminal summary and closes the database', async () => {
  const calls: string[] = [];
  const signals = new EventEmitter();
  let output = '';
  let idleFailure: (() => void) | undefined;
  const database = fakeDatabase(calls);
  const dependencies: ExecutionPreflightPreparationBootstrapDependencies = Object.freeze({
    parseConfig: () => { calls.push('config'); return configValue; },
    openDatabase: async (
      _config: ExecutionPreflightPreparationConfigV1,
      onIdleError: () => void,
    ) => {
      calls.push('database');
      idleFailure = onIdleError;
      return database;
    },
    createService: (input: Readonly<{
      config: ExecutionPreflightPreparationConfigV1;
      database: ExecutionPreflightPreparationBootstrapDatabase;
    }>) => {
      calls.push('service');
      assert.equal(Object.isFrozen(input), true);
      assert.equal(input.config, configValue);
      assert.equal(input.database, database);
      return Object.freeze({ run: async (signal: AbortSignal) => {
        calls.push('run');
        assert.equal(signal.aborted, false);
        idleFailure?.();
        return prepared();
      } });
    },
  });

  await startExecutionPreflightPreparation(Object.freeze({}), dependencies, Object.freeze({
    signalSource: signals,
    stdout: Object.freeze({ write: (chunk: string) => { output += chunk; return true; } }),
  }));

  assert.deepEqual(calls, ['config', 'database', 'service', 'run', 'database.evict', 'database.close']);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(output.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(output) as Record<string, unknown>, {
    schemaVersion: 'execution-preflight-intent-preparation-result.v1',
    state: 'PREPARED',
    runId: `execution_preflight_preparation_${'a'.repeat(64)}`,
    failureCode: null,
    canaryStatus: 'CANARY_NOT_STARTED',
    paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
    liveCapabilityPresent: false,
  });
  assert.doesNotMatch(output,
    /"(?:pairId|targetIntentId|simulationIntentId|assessmentId|artifactId|runFingerprint|leaseToken)"|postgresql:|https:/u);
});

void test('propagates SIGTERM through one AbortSignal and still closes exactly once', async () => {
  const calls: string[] = [];
  const signals = new EventEmitter();
  const database = fakeDatabase(calls);
  const service: ExecutionPreflightPreparationService = Object.freeze({
    run: async (signal: AbortSignal) => {
      calls.push('run');
      signals.emit('SIGTERM');
      assert.equal(signal.aborted, true);
      return failed();
    },
  });
  await startExecutionPreflightPreparation(Object.freeze({}), Object.freeze({
    parseConfig: () => config(),
    openDatabase: async () => database,
    createService: () => service,
  }), Object.freeze({
    signalSource: signals,
    stdout: Object.freeze({ write: () => true }),
  }));
  assert.deepEqual(calls, ['run', 'database.close']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

void test('fatal entrypoint output exposes only allowlisted identity', () => {
  let output = '';
  const runtime = {
    exitCode: undefined as number | undefined,
    stderr: { write: (chunk: string) => { output += chunk; return true; } },
  };
  reportExecutionPreflightPreparationEntrypointFailure(Object.assign(
    new Error('postgresql://credential@private.test'),
    { name: 'InjectedPrivateError', code: 'DATABASE_PASSWORD_SECRET' },
  ), runtime);
  assert.equal(runtime.exitCode, 1);
  assert.deepEqual(JSON.parse(output) as Record<string, unknown>, {
    service: 'sol-token-executor-preflight-preparation',
    event: 'executor_preflight_preparation.start_failed',
    errorName: 'UnknownError',
    errorCode: 'EXECUTION_PREFLIGHT_PREPARATION_START_FAILED',
  });
  assert.equal(/credential|private|password/iu.test(output), false);
});

void test('publishes explicit source and compiled one-shot scripts', async () => {
  const packageJson = JSON.parse(await readFile(
    new URL('../package.json', import.meta.url), 'utf8',
  )) as { readonly scripts?: Readonly<Record<string, string>> };
  assert.equal(packageJson.scripts?.['executor:preflight-preparation:dev'],
    'tsx src/executor-preflight-preparation/main.ts');
  assert.equal(packageJson.scripts?.['executor:preflight-preparation:start'],
    'node dist/src/executor-preflight-preparation/main.js');
});

const configValue = config();

function config(): ExecutionPreflightPreparationConfigV1 {
  return Object.freeze({
    payloadVersion: 1,
    enabled: true,
    selectionWindowMs: 120_000,
    preparationLeaseMs: 60_000,
    outputPath: '/var/tmp/preflight-prepared.json',
    executor: Object.freeze({
      mode: 'simulation-only',
      databaseUrl: 'postgresql://unused',
      pollMs: 1_000,
      leaseMs: 35_000,
      databaseStatementTimeoutMs: 3_000,
      shutdownGraceMs: 10_000,
      executorPublicKey: 'gCr8XkSUeFUxTpZE8HrZMGC98XdGGVyakeocBNTDibJ',
      providerId: 'primary',
      httpRpcUrl: 'https://rpc.example.test',
      expectedGenesisHash: '2MPoZYQYPdDkMNKdb7Z3U6ypaiddzuNBAqKNBypSh3pN',
      quoteMaxAgeMs: 3_000,
      slippageBps: 500n,
      snapshotMaxSlotLag: 8,
      maxComputeUnits: 300_000n,
      maxFeeLamports: 100_000n,
      maxFeePayerLamportDebit: 2_500_000n,
      maxPriorityFeeLamports: 0n,
      rpcTimeoutMs: 5_000,
      maxRpcCallsPerAttempt: 8,
      quoteMintAllowlist: Object.freeze([
        'So11111111111111111111111111111111111111112',
      ] as const),
    }),
  });
}

function fakeDatabase(calls: string[]): ExecutionPreflightPreparationBootstrapDatabase {
  return Object.freeze({
    preparations: Object.freeze({}),
    intents: Object.freeze({}),
    assessments: Object.freeze({}),
    artifacts: Object.freeze({}),
    venues: Object.freeze({}),
    evict: () => { calls.push('database.evict'); },
    close: async () => { calls.push('database.close'); },
  }) as unknown as ExecutionPreflightPreparationBootstrapDatabase;
}

function prepared(): ExecutionPreflightPreparationV1 {
  return terminal('PREPARED', null);
}

function failed(): ExecutionPreflightPreparationV1 {
  return terminal('FAILED', 'PREFLIGHT_PAIR_NOT_FOUND');
}

function terminal(
  state: 'PREPARED' | 'FAILED',
  failureCode: ExecutionPreflightPreparationV1['failureCode'],
): ExecutionPreflightPreparationV1 {
  return Object.freeze({
    payloadVersion: 1,
    runId: `execution_preflight_preparation_${'a'.repeat(64)}`,
    runFingerprint: 'a'.repeat(64),
    state,
    stateRevision: 6n,
    watermarkAtMs: 1_788_825_600_000,
    deadlineAtMs: 1_788_825_720_000,
    pairId: state === 'PREPARED' ? `execution_preflight_intent_pair_${'b'.repeat(64)}` : null,
    assessmentId: state === 'PREPARED'
      ? `execution_dry_run_assessment_${'c'.repeat(64)}` : null,
    assessmentFingerprint: state === 'PREPARED' ? 'c'.repeat(64) : null,
    artifactId: state === 'PREPARED'
      ? `execution_simulation_artifact_${'d'.repeat(64)}` : null,
    artifactFingerprint: state === 'PREPARED' ? 'd'.repeat(64) : null,
    manifestFingerprint: state === 'PREPARED' ? 'e'.repeat(64) : null,
    failureCode,
    createdAtMs: 1_788_825_600_000,
    updatedAtMs: 1_788_825_605_000,
    selectedAtMs: state === 'PREPARED' ? 1_788_825_601_000 : null,
    completedAtMs: 1_788_825_605_000,
    purgeAfterMs: 1_788_840_005_000,
  });
}

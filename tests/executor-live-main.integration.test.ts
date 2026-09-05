import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import bs58 from 'bs58';
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import type { PublicKey } from '@solana/web3.js';
import { createSignedTransactionArtifact } from '../src/domain/execution-live.js';
import { compileInspectedV0Message } from '../src/executor-simulation/message-compiler.js';
import type { LiveExecutorConfig } from '../src/executor-live/config.js';
import type { LiveExecutorBootstrapDatabase } from '../src/executor-live/database.js';
import type { LiveRpcGenesisEvidenceV1 } from '../src/executor-live/rpc-gateway.js';
import {
  reportLiveExecutorEntrypointFailure,
  createLiveExecutionWorkerForWork,
  createProductionLiveExecutorLanes,
  startLiveExecutor,
  type LiveExecutorBootstrapDependencies,
} from '../src/executor-live/main.js';
import { resumeLivePersistedTransaction } from '../src/executor-live/execution-worker.js';
import { ProviderAffineSession } from '../src/executor-simulation/provider-session.js';
import { LiveRpcError, SolanaLiveRpcSession } from '../src/executor-live/rpc-gateway.js';
import { ExecutionLiveRepositoryError } from '../src/storage/execution-live.repository.js';
import { LiveSubmissionGatewayError } from '../src/executor-live/submission-gateway.js';
import {
  runLiveExecutorPass,
  runLiveExecutorRuntime,
  type LiveExecutorLane,
  type LiveExecutorRuntimeScheduler,
} from '../src/executor-live/runtime.js';
import type { ExecutionTransactionSigner } from '../src/ports/execution-transaction-signer.js';

const packageUrl = new URL('../package.json', import.meta.url);
const parentSpecificationUrl = new URL(
  '../docs/superpowers/specs/2026-08-30-executor-v1-design.md',
  import.meta.url,
);
const liveSpecificationUrl = new URL(
  '../docs/superpowers/specs/2026-08-31-executor-live-canary-design.md',
  import.meta.url,
);
const orchestrationSpecificationUrl = new URL(
  '../docs/superpowers/specs/2026-09-01-executor-live-orchestration-design.md',
  import.meta.url,
);
const recoverySpecificationUrl = new URL(
  '../docs/superpowers/specs/2026-09-04-executor-live-recovery-runtime-design.md',
  import.meta.url,
);
const signableSpecificationUrl = new URL(
  '../docs/superpowers/specs/2026-09-04-executor-live-signable-runtime-design.md',
  import.meta.url,
);
const operatorCanarySpecificationUrl = new URL(
  '../docs/superpowers/specs/2026-09-04-executor-live-operator-canary-design.md',
  import.meta.url,
);
const readinessSpecificationUrl = new URL(
  '../docs/superpowers/specs/2026-09-05-executor-readiness-bootstrap-design.md',
  import.meta.url,
);
const runbookUrl = new URL('../docs/operations/executor-live-canary.md', import.meta.url);
const deploymentSmokeUrl = new URL('../scripts/deployment-smoke.mjs', import.meta.url);

void test('documents H2d readiness evidence without starting a canary',
  async () => {
  const [
    packageText,
    parentSpecification,
    liveSpecification,
    orchestrationSpecification,
    recoverySpecification,
    signableSpecification,
    operatorCanarySpecification,
    readinessSpecification,
    runbook,
    deploymentSmoke,
  ] =
    await Promise.all([
      readFile(packageUrl, 'utf8'),
      readFile(parentSpecificationUrl, 'utf8'),
      readFile(liveSpecificationUrl, 'utf8'),
      readFile(orchestrationSpecificationUrl, 'utf8'),
      readFile(recoverySpecificationUrl, 'utf8'),
      readFile(signableSpecificationUrl, 'utf8'),
      readFile(operatorCanarySpecificationUrl, 'utf8'),
      readFile(readinessSpecificationUrl, 'utf8'),
      readFile(runbookUrl, 'utf8'),
      readFile(deploymentSmokeUrl, 'utf8'),
    ]);
  const packageJson = JSON.parse(packageText) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };

  assert.equal(
    packageJson.scripts?.['executor:live:start'],
    'node dist/src/executor-live/main.js',
  );
  assert.equal(
    packageJson.scripts?.['executor:live:recovery:start'],
    'node dist/src/executor-live-recovery/main.js',
  );
  assertContainsExactlyOnce(
    parentSpecification,
    '**Version de spécification :** 1.11.6',
    'parent specification version',
  );
  assertContainsExactlyOnce(
    parentSpecification,
    '**Périmètre livré à cette version :** #51-A à #51-G, primitives persistantes\n'
      + '#51-H1, runtime de finalité read-only #51-H2a, runtime signable désarmé #51-H2b,\n'
      + 'préparation opérateur exacte #51-H2c et bootstrap de readiness non signable\n'
      + '#51-H2d',
    'parent delivered scope',
  );
  assertContainsExactlyOnce(
    liveSpecification,
    '**Version de spécification :** 1.2.6',
    'live specification version',
  );
  assertContainsExactlyOnce(
    liveSpecification,
    '**Version de la spécification parente :** 1.11.6',
    'live parent specification version',
  );
  assertContainsExactlyOnce(
    orchestrationSpecification,
    '**Version de spécification :** 1.2.0',
    'orchestration specification version',
  );
  assertContainsExactlyOnce(
    orchestrationSpecification,
    '**Version de la spécification parente :** 1.10.0',
    'orchestration parent specification version',
  );
  assertContainsExactlyOnce(
    orchestrationSpecification,
    '**Version de la fondation live :** 1.1.0',
    'orchestration live foundation version',
  );
  assertContainsExactlyOnce(
    recoverySpecification,
    '**Version de spécification :** 1.1.9',
    'recovery specification version',
  );
  assertContainsExactlyOnce(
    recoverySpecification,
    '**Version de la spécification parente :** 1.11.3',
    'recovery parent specification version',
  );
  assertContainsExactlyOnce(
    recoverySpecification,
    "**Version de l'orchestration persistante :** 1.1.5",
    'recovery orchestration specification version',
  );
  assertContainsExactlyOnce(
    signableSpecification,
    '**Version de spécification :** 1.1.4',
    'signable specification version',
  );
  assertContainsExactlyOnce(
    signableSpecification,
    '**Version de la spécification parente :** 1.11.4',
    'signable parent specification version',
  );
  assertContainsExactlyOnce(
    signableSpecification,
    '**Version de l\'orchestration persistante H1 :** 1.2.0',
    'signable orchestration specification version',
  );
  assertContainsExactlyOnce(
    signableSpecification,
    '**Version de la fondation live :** 1.1.0',
    'signable live foundation version',
  );
  assertContainsExactlyOnce(
    operatorCanarySpecification,
    '**Version de spécification :** 1.1.4',
    'operator canary specification version',
  );
  assertContainsExactlyOnce(
    operatorCanarySpecification,
    '**Statut :** LIVRÉE — `READY_FOR_EXTERNAL_PREFLIGHT`, canary non démarré',
    'operator canary status',
  );
  assertContainsExactlyOnce(
    runbook,
    '**Version :** 1.6.0 — 2026-09-05',
    'runbook version',
  );
  assertContainsExactlyOnce(
    readinessSpecification,
    '**Version de spécification :** 1.0.2',
    'readiness specification version',
  );
  assertContainsExactlyOnce(
    readinessSpecification,
    '**Version de la spécification parente :** 1.11.6',
    'readiness parent specification version',
  );

  assertContainsExactlyOnce(
    signableSpecification,
    '```text\nLIVE_SIGNABLE_RUNTIME_COMPOSED\nCANARY_NOT_STARTED\nNON_EXECUTED / NON_VALIDATED\n```',
    'signable operational state',
  );
  assert.match(
    recoverySpecification,
    /`DEFERRED`.*`lane`.*`errorCode`[\s\S]*RPC_RATE_LIMITED[\s\S]*SESSION_FAILED/iu,
  );
  assert.match(
    recoverySpecification,
    /`NOT_FOUND`.*sans code[\s\S]*échéance/iu,
  );
  assert.match(
    recoverySpecification,
    /CONFIRMED.*FINALIZED[\s\S]*`bigint` non négatif[\s\S]*GATEWAY_FAILED/iu,
  );
  assert.match(
    recoverySpecification,
    /ni message, ni URL, ni signature/iu,
  );
  assertContainsExactlyOnce(
    runbook,
    'Le constat livré obligatoire est :\n'
      + '`LIVE_SIGNABLE_RUNTIME_COMPOSED`, `READY_FOR_EXTERNAL_PREFLIGHT`, `CANARY_NOT_STARTED`,\n'
      + '`NON_EXECUTED / NON_VALIDATED`.',
    'runbook operational state',
  );
  for (const document of [parentSpecification, liveSpecification,
    orchestrationSpecification, signableSpecification, runbook]) {
    assert.match(document,
      /recover SELL[\s\S]*execute SELL[\s\S]*recover BUY[\s\S]*execute BUY/iu);
    assert.match(document, /H2a[\s\S]*(?:finalité|confirmation)[\s\S]*réconciliation[\s\S]*deadline/iu);
    assert.match(document, /H2c[\s\S]*(?:armement|canary)/iu);
  }
  assert.match(signableSpecification,
    /PostgreSQL 16[\s\S]*PUBLIC[\s\S]*TEMP[\s\S]*(?:base de données|DATABASE)/iu);
  assert.match(runbook,
    /PostgreSQL 16[\s\S]*PUBLIC[\s\S]*TEMP[\s\S]*(?:base de données|DATABASE)/iu);
  assert.equal(runbook.includes('CANARY_STARTED'), false);
  assert.equal((deploymentSmoke.match(/'037_execution_live_orchestration\.sql'/gu) ?? []).length, 1);
  assert.equal((deploymentSmoke.match(/'038_execution_live_rpc_budget\.sql'/gu) ?? []).length, 1);
  assert.equal((deploymentSmoke.match(/'039_execution_canary_operator_binding\.sql'/gu) ?? []).length, 1);
  assert.equal(
    /const canonicalMigrations = Object\.freeze\(\[[\s\S]*?\n {2}'036_execution_live_canary\.sql',\n {2}'037_execution_live_orchestration\.sql',\n {2}'038_execution_live_rpc_budget\.sql',\n {2}'039_execution_canary_operator_binding\.sql',\n\]\);/u.test(deploymentSmoke),
    true,
    'deployment smoke migration head',
  );
});

function assertContainsExactlyOnce(source: string, expected: string, label: string): void {
  assert.equal(source.split(expected).length - 1, 1, label);
}

void test('one signable live pass prioritizes recovered SELL, fresh SELL, recovered BUY, BUY', async () => {
  const calls: string[] = [];
  const configuredLanes = buildLanes((name) => async () => {
    calls.push(name);
    return name === 'recoverBuy' ? 'WORKED' : 'IDLE';
  });

  assert.equal(
    await runLiveExecutorPass(configuredLanes, new AbortController().signal, async () => {
      calls.push('prePass');
    }),
    'RECOVER_BUY',
  );
  assert.deepEqual(calls, ['prePass', 'recoverSell', 'sell', 'recoverBuy']);
});

void test('bootstrap validates startup then genesis before opening the signer and binds exact evidence', async () => {
  const calls: string[] = [];
  const signer = fakeSigner(calls);
  const signals = new EventEmitter();
  const scheduler = manualScheduler();
  const environment = Object.freeze({ marker: 'environment' });
  const config = Object.freeze({
    ...liveConfig(), pollMs: 100, shutdownGraceMs: 1_000, executorPublicKey: signer.publicKey,
    phase: 'CANARY', buildHash: 'b'.repeat(64), configurationFingerprint: 'c'.repeat(64),
    strategyFingerprint: 'd'.repeat(64),
    providerId: 'primary', expectedGenesisHash: '11111111111111111111111111111111',
  }) as LiveExecutorConfig;
  const genesis = Object.freeze({
    payloadVersion: 1 as const,
    providerId: 'primary',
    expectedGenesisHash: '11111111111111111111111111111111',
    observedGenesisHash: '11111111111111111111111111111111',
  });
  const dependencies: LiveExecutorBootstrapDependencies = {
    parseConfig: (received) => {
      assert.equal(received, environment);
      calls.push('config');
      return config;
    },
    openDatabase: async () => {
      calls.push('database');
      return Object.freeze({
        validateStartup: async () => { calls.push('startup'); return Object.freeze({}) as never; },
        intents: {} as LiveExecutorBootstrapDatabase['intents'],
        venues: {} as LiveExecutorBootstrapDatabase['venues'],
        live: startupLiveFacade(calls),
        simulations: {} as LiveExecutorBootstrapDatabase['simulations'],
        close: async () => { calls.push('database.close'); },
        evict: () => { calls.push('database.evict'); },
      });
    },
    verifyGenesis: async () => { calls.push('genesis'); return genesis; },
    loadSigner: async () => {
      calls.push('secret');
      return signer;
    },
    createLanes: (input) => {
      calls.push('lanes');
      assert.deepEqual(input.runtime, liveRuntime(config, genesis));
      return buildLanes(() => async () => 'IDLE');
    },
    logger: testLogger,
    runtime: (runtimeDependencies, options) => runLiveExecutorRuntime(
      runtimeDependencies,
      { ...options, scheduler, signalSource: signals },
    ),
    forceExit: () => { calls.push('force'); },
  };

  const started = startLiveExecutor(environment, dependencies);
  await nextTurn();
  assert.deepEqual(
    calls.slice(0, 8),
    ['config', 'database', 'startup', 'prepass', 'work', 'genesis', 'secret', 'lanes'],
  );
  assert.equal(calls.includes('arm'), false);
  assert.equal(calls.includes('resume'), false);
  assert.equal(calls.includes('control'), false);
  signals.emit('SIGTERM');
  await started;
  assert.deepEqual(calls.slice(-2), ['signer.close', 'database.close']);
});

void test('startup validation rejection closes the database without ever opening the secret', async () => {
  const calls: string[] = [];
  const expected = new Error('schema unavailable');
  await assert.rejects(startLiveExecutor(Object.freeze({}), {
    parseConfig: () => Object.freeze({ pollMs: 100, shutdownGraceMs: 1_000 }) as LiveExecutorConfig,
    openDatabase: async () => Object.freeze({
      validateStartup: async () => { calls.push('startup'); throw expected; },
      intents: {} as LiveExecutorBootstrapDatabase['intents'],
      venues: {} as LiveExecutorBootstrapDatabase['venues'],
      live: startupLiveFacade(calls),
      simulations: {} as LiveExecutorBootstrapDatabase['simulations'],
      close: async () => { calls.push('database.close'); },
      evict: () => undefined,
    }),
    verifyGenesis: async () => Object.freeze({}) as LiveRpcGenesisEvidenceV1,
    loadSigner: async () => { calls.push('secret'); return fakeSigner(calls); },
    createLanes: () => buildLanes(() => async () => 'IDLE'),
    runtime: async () => undefined,
    forceExit: () => undefined,
    logger: testLogger,
  }), expected);
  assert.deepEqual(calls, ['startup', 'database.close']);
});

void test('startup without runnable work closes PostgreSQL before RPC or signer access', async () => {
  const calls: string[] = [];
  const noWork = Object.assign(new Error('redacted'), { code: 'LIVE_EXECUTOR_NO_WORK' });
  const config = liveConfig();
  await assert.rejects(startLiveExecutor(Object.freeze({}), {
    parseConfig: () => config,
    openDatabase: async () => Object.freeze({
      validateStartup: async () => { calls.push('startup'); return Object.freeze({}) as never; },
      intents: {} as LiveExecutorBootstrapDatabase['intents'],
      venues: {} as LiveExecutorBootstrapDatabase['venues'],
      live: Object.freeze({
        recoverStrandedPreSignatureLock: async () => {
          calls.push('prepass');
          return Object.freeze({ payloadVersion: 1 as const, kind: 'IDLE' as const });
        },
        assertRunnableWork: async () => { calls.push('work'); throw noWork; },
      }) as unknown as LiveExecutorBootstrapDatabase['live'],
      simulations: {} as LiveExecutorBootstrapDatabase['simulations'],
      close: async () => { calls.push('database.close'); },
      evict: () => undefined,
    }),
    verifyGenesis: async () => { calls.push('genesis'); return Object.freeze({}) as never; },
    loadSigner: async () => { calls.push('secret'); return fakeSigner(calls); },
    createLanes: () => buildLanes(() => async () => 'IDLE'),
    runtime: async () => undefined,
    forceExit: () => undefined,
    logger: testLogger,
  }), (error: unknown) => error === noWork);
  assert.deepEqual(calls, ['startup', 'prepass', 'work', 'database.close']);
});

void test('genesis rejection closes the database before opening the secret', async () => {
  const calls: string[] = [];
  const expected = new Error('wrong genesis');
  const config = Object.freeze({ pollMs: 100, shutdownGraceMs: 1_000 }) as LiveExecutorConfig;
  await assert.rejects(startLiveExecutor(Object.freeze({}), {
    parseConfig: () => config,
    openDatabase: async () => Object.freeze({
      validateStartup: async () => { calls.push('startup'); return Object.freeze({}) as never; },
      intents: {} as LiveExecutorBootstrapDatabase['intents'],
      venues: {} as LiveExecutorBootstrapDatabase['venues'],
      live: startupLiveFacade(calls),
      simulations: {} as LiveExecutorBootstrapDatabase['simulations'],
      close: async () => { calls.push('database.close'); },
      evict: () => undefined,
    }),
    verifyGenesis: async () => { calls.push('genesis'); throw expected; },
    loadSigner: async () => { calls.push('secret'); return fakeSigner(calls); },
    createLanes: () => buildLanes(() => async () => 'IDLE'),
    runtime: async () => undefined,
    forceExit: () => undefined,
    logger: testLogger,
  }), expected);
  assert.deepEqual(calls, ['startup', 'prepass', 'work', 'genesis', 'database.close']);
});

void test('a synchronous runtime bootstrap failure closes signer then database', async () => {
  const calls: string[] = [];
  const expected = new Error('runtime bootstrap failed');
  const config = liveConfig();
  await assert.rejects(startLiveExecutor(Object.freeze({}), {
    parseConfig: () => config,
    openDatabase: async () => Object.freeze({
      validateStartup: async () => Object.freeze({}) as never,
      intents: {} as LiveExecutorBootstrapDatabase['intents'],
      venues: {} as LiveExecutorBootstrapDatabase['venues'],
      live: startupLiveFacade(),
      simulations: {} as LiveExecutorBootstrapDatabase['simulations'],
      close: async () => { calls.push('database.close'); },
      evict: () => undefined,
    }),
    verifyGenesis: async () => Object.freeze({
      payloadVersion: 1, providerId: config.providerId,
      expectedGenesisHash: config.expectedGenesisHash,
      observedGenesisHash: config.expectedGenesisHash,
    }),
    loadSigner: async () => fakeSigner(calls),
    createLanes: () => buildLanes(() => async () => 'IDLE'),
    runtime: () => { throw expected; },
    forceExit: () => undefined,
    logger: testLogger,
  }), (error: unknown) => error === expected);
  assert.deepEqual(calls, ['signer.close', 'database.close']);
});

void test('shutdown aborts work, closes the signer first and forces a bounded exit when stuck', async () => {
  const calls: string[] = [];
  const signals = new EventEmitter();
  const scheduler = manualScheduler();
  let workSignal: AbortSignal | null = null;
  const runtime = runLiveExecutorRuntime({
    lanes: buildLanes((name) => name === 'recoverSell'
      ? async (signal) => {
        workSignal = signal;
        calls.push('work');
        return new Promise<'IDLE'>(() => undefined);
      }
      : async () => 'IDLE'),
    prePass: async () => undefined,
    closeSigner: async () => { calls.push('signer.close'); },
    closeDatabase: async () => { calls.push('database.close'); },
    evictDatabase: () => { calls.push('database.evict'); },
    forceExit: (code) => { calls.push(`force:${code}`); },
  }, {
    pollMs: 100,
    shutdownGraceMs: 1_000,
    scheduler,
    signalSource: signals,
  });

  await nextTurn();
  signals.emit('SIGINT');
  await nextTurn();
  assert.equal(abortState(workSignal), true);
  assert.deepEqual(calls, ['work', 'signer.close']);
  scheduler.fire(1_000);
  await runtime;
  assert.deepEqual(calls, ['work', 'signer.close', 'database.evict', 'force:1']);
});

void test('clean shutdown attempts database close even when signer close fails', async () => {
  const calls: string[] = [];
  const signals = new EventEmitter();
  const scheduler = manualScheduler();
  const failure = new Error('signer close failed');
  const runtime = runLiveExecutorRuntime({
    lanes: buildLanes(() => async () => 'IDLE'),
    prePass: async () => undefined,
    closeSigner: async () => { calls.push('signer.close'); throw failure; },
    closeDatabase: async () => { calls.push('database.close'); },
    evictDatabase: () => undefined,
    forceExit: () => undefined,
  }, { pollMs: 100, shutdownGraceMs: 1_000, scheduler, signalSource: signals });

  await nextTurn();
  signals.emit('SIGTERM');
  await assert.rejects(runtime, failure);
  assert.deepEqual(calls, ['signer.close', 'database.close']);
});

void test('runtime logs a closed lane failure and keeps polling', async () => {
  const events: unknown[] = [];
  const signals = new EventEmitter();
  const scheduler = manualScheduler();
  const runtime = runLiveExecutorRuntime({
    lanes: buildLanes((name) => name === 'recoverSell'
      ? async () => {
        throw Object.assign(new Error('hostile'), { code: 'DATABASE_FAILURE', url: 'https://secret' });
      }
      : async () => 'IDLE'),
    prePass: async () => undefined,
    logger: Object.freeze({
      info: (context: unknown) => { events.push(context); },
      warn: (context: unknown) => { events.push(context); },
      error: (context: unknown) => { events.push(context); },
    }),
    closeSigner: async () => undefined,
    closeDatabase: async () => undefined,
    evictDatabase: () => undefined,
    forceExit: () => undefined,
  }, { pollMs: 100, shutdownGraceMs: 1_000, scheduler, signalSource: signals });

  await nextTurn();
  assert.deepEqual(events, [Object.freeze({
    event: 'executor_live.lane_failed', lane: 'RECOVER_SELL', errorCode: 'DATABASE_FAILURE',
  })]);
  scheduler.fire(100);
  signals.emit('SIGTERM');
  await runtime;
});

void test('runtime runs the recovery pre-pass every cycle and redacts its failure', async () => {
  const events: unknown[] = [];
  const calls: string[] = [];
  const signals = new EventEmitter();
  const scheduler = manualScheduler();
  let prePassCount = 0;
  const runtime = runLiveExecutorRuntime({
    lanes: buildLanes((name) => async () => { calls.push(name); return 'IDLE'; }),
    prePass: async () => {
      prePassCount += 1;
      calls.push(`prePass:${prePassCount}`);
      if (prePassCount === 2) {
        throw Object.assign(new Error('hostile secret'), {
          code: 'LIVE_EXECUTOR_FOREIGN_LEASE_ACTIVE', url: 'https://secret.invalid',
        });
      }
    },
    logger: Object.freeze({
      info: (context: unknown) => { events.push(context); },
      warn: (context: unknown) => { events.push(context); },
      error: (context: unknown) => { events.push(context); },
    }),
    closeSigner: async () => undefined,
    closeDatabase: async () => undefined,
    evictDatabase: () => undefined,
    forceExit: () => undefined,
  }, { pollMs: 100, shutdownGraceMs: 1_000, scheduler, signalSource: signals });

  await nextTurn();
  assert.deepEqual(calls, ['prePass:1', 'recoverSell', 'sell', 'recoverBuy', 'buy']);
  scheduler.fire(100);
  await nextTurn();
  assert.deepEqual(calls.slice(-1), ['prePass:2']);
  assert.deepEqual(events, [Object.freeze({
    event: 'executor_live.prepass_failed',
    errorCode: 'LIVE_EXECUTOR_FOREIGN_LEASE_ACTIVE',
  })]);
  assert.equal(JSON.stringify(events).includes('secret'), false);
  scheduler.fire(100);
  await nextTurn();
  assert.deepEqual(calls.slice(-5), ['prePass:3', 'recoverSell', 'sell', 'recoverBuy', 'buy']);
  signals.emit('SIGTERM');
  await runtime;
});

void test('fatal handler redacts hostile errors and sets exit code', () => {
  const writes: string[] = [];
  const hostile = Object.freeze({
    name: 'Error', code: 'DATABASE_URL=https://user:secret@example.test',
    message: '/secret/keypair signature mint amount bytes',
  });
  const processLike: { exitCode?: string | number; stderr: { write(chunk: string): unknown } } = {
    stderr: { write: (chunk) => { writes.push(chunk); } },
  };
  reportLiveExecutorEntrypointFailure(hostile, processLike);
  assert.equal(processLike.exitCode, 1);
  const output = writes.join('');
  assert.equal(output.includes('secret'), false);
  assert.equal(output.includes('/secret'), false);
  assert.match(output, /LIVE_EXECUTOR_START_FAILED/u);
});

void test('fatal handler preserves closed H2b startup identities without exposing details', () => {
  for (const code of [
    'DATABASE_AUTHORITY_INVALID', 'GENERATION_BINDING_INVALID', 'OPEN_WORK_BINDING_INVALID',
  ] as const) {
    const writes: string[] = [];
    const processLike: { exitCode?: string | number; stderr: { write(chunk: string): unknown } } = {
      stderr: { write: (chunk) => { writes.push(chunk); } },
    };
    reportLiveExecutorEntrypointFailure(Object.freeze({
      name: 'LiveExecutorStartupError', code, message: 'database password secret',
    }), processLike);
    const output = writes.join('');
    assert.equal(processLike.exitCode, 1);
    assert.equal(output.includes('password'), false);
    assert.equal(output.includes('secret'), false);
    assert.match(output, /"errorName":"LiveExecutorStartupError"/u);
    assert.match(output, new RegExp(`"errorCode":"${code}"`, 'u'));
  }
});

void test('terminal recovery inspects durable state without constructing a tail RPC session', async () => {
  let tailSessions = 0;
  const worker = createLiveExecutionWorkerForWork(Object.freeze({
    providerId: 'primary', httpRpcUrl: 'https://rpc.example.test',
    expectedGenesisHash: '11111111111111111111111111111111', rpcTimeoutMs: 1,
    maxComputeUnits: 1n, maxFeePayerLamportDebit: 0n, leaseMs: 1,
  }) as LiveExecutorConfig, Object.freeze({
    intents: { renew: async () => { throw new Error('unexpected renew'); } },
    live: {
      inspectSignedTransaction: async () => Object.freeze({
        payloadVersion: 1 as const, artifactId: 'artifact', signature: 'signature',
        signedTransactionHash: 'a'.repeat(64), state: 'REVOKED_NO_SEND' as const, stateRevision: 0n,
      }),
    },
  }) as never, Object.freeze({
    createTail: () => { tailSessions += 1; throw new Error('tail must stay lazy'); },
  }));
  const result = await resumeLivePersistedTransaction(worker, Object.freeze({
    payloadVersion: 1, claim: {} as never, runtime: {} as never,
  }), new AbortController().signal);
  assert.equal(result.kind, 'REVOKED_NO_SEND');
  assert.equal(tailSessions, 0);
});

void test('fresh production claims create one unsigned provider session per work with total-minus-six budget', async () => {
  const configs: ConstructorParameters<typeof ProviderAffineSession>[0][] = [];
  const config = liveConfig(16);
  const lanes = createProductionLiveExecutorLanes(Object.freeze({
    config,
    signer: fakeSigner([]),
    runtime: liveRuntime(config, Object.freeze({
      payloadVersion: 1, providerId: config.providerId,
      expectedGenesisHash: config.expectedGenesisHash,
      observedGenesisHash: config.expectedGenesisHash,
    })),
    database: freshDatabase(),
  }), Object.freeze({
    createUnsigned: (sessionConfig: ConstructorParameters<typeof ProviderAffineSession>[0]) => {
      configs.push(sessionConfig);
      return new ProviderAffineSession(sessionConfig, localUnsignedFetch);
    },
    createTail: () => { throw new Error('fresh failure stops before signed tail'); },
  }));

  await lanes.sell(new AbortController().signal);
  await lanes.sell(new AbortController().signal);
  assert.equal(configs.length, 2);
  assert.notEqual(configs[0], configs[1]);
  assert.deepEqual(configs.map((value) => value.maxCalls), [10, 10]);
});

void test('tail workers use a distinct max-six session and consume genesis before blockhash proof', async () => {
  const configs: ConstructorParameters<typeof SolanaLiveRpcSession>[0][] = [];
  const methods: string[] = [];
  const factory = Object.freeze({
    createTail: (sessionConfig: ConstructorParameters<typeof SolanaLiveRpcSession>[0]) => {
      configs.push(sessionConfig);
      return new SolanaLiveRpcSession(sessionConfig, async (_url, init) => {
        const request = JSON.parse(init?.body as string) as { readonly method: string; readonly id: number };
        const method = request.method;
        methods.push(method);
        const result = method === 'getGenesisHash' ? '11111111111111111111111111111111'
          : method === 'isBlockhashValid' ? { context: { slot: 7 }, value: true } : 9;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      });
    },
  });
  const config = liveConfig();
  const database = Object.freeze({ intents: { renew: async () => { throw new Error(); } }, live: {} }) as never;
  const first = createLiveExecutionWorkerForWork(config, database, factory);
  const second = createLiveExecutionWorkerForWork(config, database, factory);
  await first.readBlockhashValidity(
    { blockhash: config.expectedGenesisHash } as never,
    6n,
    new AbortController().signal,
  );
  await assert.rejects(first.readBlockhashValidity(
    { blockhash: config.expectedGenesisHash } as never,
    6n,
    new AbortController().signal,
  ));
  await second.readBlockhashValidity(
    { blockhash: config.expectedGenesisHash } as never,
    6n,
    new AbortController().signal,
  );
  assert.equal(configs.length, 2);
  assert.deepEqual(configs.map((value) => value.maxCalls), [6, 6]);
  assert.deepEqual(methods, [
    'getGenesisHash', 'isBlockhashValid', 'getBlockHeight',
    'getGenesisHash', 'isBlockhashValid', 'getBlockHeight',
  ]);
});

void test('recovery workers share the durable per-attempt RPC budget across fresh sessions', async () => {
  const config = liveConfig(12);
  const artifactId = `execution_signed_transaction_${'e'.repeat(64)}`;
  const claim = Object.freeze({
    intent: Object.freeze({ id: `execution_intent_${'a'.repeat(64)}` }),
    leaseOwner: 'owner',
    leaseToken: '00000000-0000-4000-8000-000000000000',
  }) as never;
  let callsReserved = 9;
  let reservationAttempts = 0;
  let providerCalls = 0;
  const database = Object.freeze({
    intents: { renew: async () => { throw new Error('unexpected renew'); } },
    live: {
      reserveRpcCall: async () => {
        reservationAttempts += 1;
        if (callsReserved >= 12) {
          throw new ExecutionLiveRepositoryError('RPC_CALL_BUDGET_EXHAUSTED');
        }
        callsReserved += 1;
        return Object.freeze({
          payloadVersion: 1 as const,
          artifactId,
          providerId: config.providerId,
          callsReserved,
          callsLimit: 12,
        });
      },
    },
  }) as never;
  const factory = Object.freeze({
    createTail: (
      sessionConfig: ConstructorParameters<typeof SolanaLiveRpcSession>[0],
      fetchImplementation: typeof fetch,
    ) => new SolanaLiveRpcSession(sessionConfig, fetchImplementation),
  });
  const providerFetch: typeof fetch = async (_url, init) => {
    providerCalls += 1;
    const request = JSON.parse(init?.body as string) as {
      readonly id: number;
      readonly method: string;
    };
    const result = request.method === 'getGenesisHash' ? config.expectedGenesisHash
      : request.method === 'isBlockhashValid' ? { context: { slot: 7 }, value: true }
        : 9;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  };
  const first = createLiveExecutionWorkerForWork(config, database, factory, providerFetch);
  const second = createLiveExecutionWorkerForWork(config, database, factory, providerFetch);
  first.activateRpcBudget(claim, artifactId);
  second.activateRpcBudget(claim, artifactId);

  await first.readBlockhashValidity(
    { blockhash: config.expectedGenesisHash } as never,
    6n,
    new AbortController().signal,
  );
  await assert.rejects(
    second.readBlockhashValidity(
      { blockhash: config.expectedGenesisHash } as never,
      6n,
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof LiveRpcError
      && (error as Readonly<{ readonly code: unknown }>).code === 'RPC_CALL_BUDGET_EXHAUSTED',
  );

  assert.equal(callsReserved, 12);
  assert.equal(reservationAttempts, 4);
  assert.equal(providerCalls, 3, 'the rejected reservation must not reach the provider');
});

void test('a prepaid send slot remains consumed after a worker crash before submission', async () => {
  const config = liveConfig(12);
  const artifactId = `execution_signed_transaction_${'d'.repeat(64)}`;
  const claim = Object.freeze({
    intent: Object.freeze({ id: `execution_intent_${'c'.repeat(64)}` }),
    leaseOwner: 'owner',
    leaseToken: '00000000-0000-4000-8000-000000000000',
  }) as never;
  let callsReserved = 11;
  let reservationAttempts = 0;
  let tailSessions = 0;
  const database = Object.freeze({
    intents: { renew: async () => { throw new Error('unexpected renew'); } },
    live: {
      reserveRpcCall: async () => {
        reservationAttempts += 1;
        if (callsReserved >= 12) {
          throw new ExecutionLiveRepositoryError('RPC_CALL_BUDGET_EXHAUSTED');
        }
        callsReserved += 1;
        return Object.freeze({
          payloadVersion: 1 as const, artifactId, providerId: config.providerId,
          callsReserved, callsLimit: 12,
        });
      },
    },
  }) as never;
  const sessionFactory = Object.freeze({
    createTail: () => {
      tailSessions += 1;
      throw new Error('pre-reservation must not construct a provider session');
    },
  });
  const first = createLiveExecutionWorkerForWork(config, database, sessionFactory);
  const recovered = createLiveExecutionWorkerForWork(config, database, sessionFactory);
  first.activateRpcBudget(claim, artifactId);
  recovered.activateRpcBudget(claim, artifactId);

  await first.reserveSubmissionRpcCall(claim, artifactId);
  await assert.rejects(
    recovered.reserveSubmissionRpcCall(claim, artifactId),
    (error: unknown) => error instanceof LiveRpcError
      && error.code === 'RPC_CALL_BUDGET_EXHAUSTED',
  );

  assert.equal(callsReserved, 12);
  assert.equal(reservationAttempts, 2);
  assert.equal(tailSessions, 0);
});

void test('sendTransaction cannot reserve after the fence or reach the provider without prepayment',
  async () => {
    const fixture = completeTailFixture();
    const config = liveConfig(12);
    const methods: string[] = [];
    let reservationAttempts = 0;
    const worker = createLiveExecutionWorkerForWork(config, Object.freeze({
      intents: { renew: async () => { throw new Error('unexpected renew'); } },
      live: {
        reserveRpcCall: async () => {
          reservationAttempts += 1;
          return Object.freeze({
            payloadVersion: 1 as const,
            artifactId: fixture.artifact.artifactId,
            providerId: config.providerId,
            callsReserved: reservationAttempts,
            callsLimit: 12,
          });
        },
      },
    }) as never, Object.freeze({
      createTail: (sessionConfig, fetchImplementation) =>
        new SolanaLiveRpcSession(sessionConfig, fetchImplementation),
    }), async (_url, init) => {
      const request = JSON.parse(init?.body as string) as {
        readonly id: number;
        readonly method: string;
      };
      methods.push(request.method);
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: config.expectedGenesisHash,
      }));
    });
    const claim = Object.freeze({
      intent: Object.freeze({ id: fixture.artifact.intentId }),
      leaseToken: '00000000-0000-4000-8000-000000000000',
    }) as never;
    worker.activateRpcBudget(claim, fixture.artifact.artifactId);

    await assert.rejects(
      worker.submission.submitPersisted(
        fixture.submissionStarted, new AbortController().signal,
      ),
      (error: unknown) => error instanceof LiveSubmissionGatewayError
        && error.code === 'SUBMISSION_AMBIGUOUS'
        && error.dispatchMayHaveOccurred,
    );

    assert.deepEqual(methods, ['getGenesisHash']);
    assert.equal(reservationAttempts, 1);
  });

void test('one tail worker verifies genesis once before its complete five-call RPC path', async () => {
  const fixture = completeTailFixture();
  const methods: string[] = [];
  const sessions: GenesisObservedLiveRpcSession[] = [];
  let callsReserved = 6;
  let reservationAttempts = 0;
  const config = Object.freeze({
    ...liveConfig(), maxComputeUnits: 300_000n, maxFeePayerLamportDebit: 10_000n,
  });
  const worker = createLiveExecutionWorkerForWork(config, Object.freeze({
    intents: { renew: async () => { throw new Error('unexpected renew'); } },
    live: {
      reserveRpcCall: async () => {
        reservationAttempts += 1;
        if (callsReserved >= 12) {
          throw new ExecutionLiveRepositoryError('RPC_CALL_BUDGET_EXHAUSTED');
        }
        callsReserved += 1;
        return Object.freeze({
          payloadVersion: 1 as const,
          artifactId: fixture.artifact.artifactId,
          providerId: config.providerId,
          callsReserved,
          callsLimit: 12,
        });
      },
    },
  }) as never, Object.freeze({
    createTail: (
      sessionConfig: ConstructorParameters<typeof SolanaLiveRpcSession>[0],
      fetchImplementation: typeof fetch,
    ) => {
      const session = new GenesisObservedLiveRpcSession(sessionConfig, fetchImplementation);
      sessions.push(session);
      return session;
    },
  }), async (_url, init) => {
    const request = JSON.parse(init?.body as string) as {
      readonly method: string;
      readonly id: number;
    };
    methods.push(request.method);
    let result: unknown;
    if (request.method === 'getGenesisHash') result = config.expectedGenesisHash;
    else if (request.method === 'getMultipleAccounts') {
      result = { context: { slot: 124 }, value: fixture.pre };
    } else if (request.method === 'simulateTransaction') {
      result = {
        context: { slot: 125 },
        value: {
          err: null, logs: ['Program log: signed'], unitsConsumed: 26_000,
          accounts: fixture.post,
        },
      };
    } else if (request.method === 'isBlockhashValid') {
      result = { context: { slot: 126 }, value: true };
    } else if (request.method === 'getBlockHeight') result = 499;
    else if (request.method === 'sendTransaction') result = fixture.artifact.signature;
    else throw new Error(`unexpected RPC method ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  const signal = new AbortController().signal;
  const claim = Object.freeze({
    intent: Object.freeze({ id: fixture.artifact.intentId }),
    leaseToken: '00000000-0000-4000-8000-000000000000',
  }) as never;
  worker.activateRpcBudget(claim, fixture.artifact.artifactId);

  await worker.signedSimulation.simulate(fixture.signedSimulation, signal);
  await worker.readBlockhashValidity(
    fixture.artifact,
    fixture.signedSimulation.unsignedSimulation.blockhashContextSlot,
    signal,
  );
  await worker.reserveSubmissionRpcCall(claim, fixture.artifact.artifactId);
  await worker.submission.submitPersisted(fixture.submissionStarted, signal);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.genesisVerifications, 1);
  assert.deepEqual(sessions[0]?.usage(), Object.freeze({
    providerId: 'primary', rpcCallsUsed: 6, rpcCallsLimit: 6,
  }));
  assert.equal(callsReserved, 12);
  assert.equal(reservationAttempts, 6, 'sendTransaction must consume only its prepaid slot');
  assert.deepEqual(methods, [
    'getGenesisHash',
    'getMultipleAccounts', 'simulateTransaction',
    'isBlockhashValid', 'getBlockHeight',
    'sendTransaction',
  ]);
});

class GenesisObservedLiveRpcSession extends SolanaLiveRpcSession {
  public genesisVerifications = 0;

  public override verifyGenesis(signal: AbortSignal): Promise<LiveRpcGenesisEvidenceV1> {
    this.genesisVerifications += 1;
    return super.verifyGenesis(signal);
  }
}

function buildLanes(
  create: (name: 'recoverSell' | 'sell' | 'recoverBuy' | 'buy') => LiveExecutorLane,
) {
  return Object.freeze({
    recoverSell: create('recoverSell'),
    sell: create('sell'),
    recoverBuy: create('recoverBuy'),
    buy: create('buy'),
  });
}

function startupLiveFacade(calls?: string[]): LiveExecutorBootstrapDatabase['live'] {
  return Object.freeze({
    recoverStrandedPreSignatureLock: async () => {
      calls?.push('prepass');
      return Object.freeze({ payloadVersion: 1 as const, kind: 'IDLE' as const });
    },
    assertRunnableWork: async () => { calls?.push('work'); },
  }) as unknown as LiveExecutorBootstrapDatabase['live'];
}

function liveRuntime(config: LiveExecutorConfig, genesis: LiveRpcGenesisEvidenceV1) {
  return Object.freeze({
    payloadVersion: 1 as const, phase: config.phase, buildHash: config.buildHash,
    configurationFingerprint: config.configurationFingerprint,
    strategyFingerprint: config.strategyFingerprint,
    walletPublicKey: config.executorPublicKey, cluster: config.cluster,
    expectedGenesisHash: genesis.expectedGenesisHash,
    observedGenesisHash: genesis.observedGenesisHash, providerId: genesis.providerId,
    quoteMaxAgeMs: config.quoteMaxAgeMs, slippageBps: config.slippageBps,
    snapshotMaxSlotLag: config.snapshotMaxSlotLag, maxComputeUnits: config.maxComputeUnits,
    maxFeeLamports: config.maxFeeLamports,
    maxFeePayerLamportDebit: config.maxFeePayerLamportDebit,
    maxRpcCallsPerAttempt: config.maxRpcCallsPerAttempt, leaseMs: config.leaseMs,
  });
}

function fakeSigner(calls: string[]): ExecutionTransactionSigner {
  return Object.freeze({
    publicKey: '11111111111111111111111111111111',
    signMessage: async () => Object.freeze({ signature: new Uint8Array(64) }),
    close: async () => { calls.push('signer.close'); },
  });
}

const testLogger = Object.freeze({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

function liveConfig(maxRpcCallsPerAttempt = 12): LiveExecutorConfig {
  return Object.freeze({
    databaseUrl: 'postgresql://example.test/db', pollMs: 100, leaseMs: 60_000,
    databaseStatementTimeoutMs: 100, shutdownGraceMs: 1_000, mode: 'live',
    liveTradingEnabled: true, cluster: 'mainnet-beta',
    generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    executorPublicKey: '11111111111111111111111111111111', keypairPath: '/keypair.json',
    providerId: 'primary', httpRpcUrl: 'https://local.invalid/rpc',
    expectedGenesisHash: '11111111111111111111111111111111', buildHash: 'b'.repeat(64),
    configurationFingerprint: 'c'.repeat(64), strategyFingerprint: 'd'.repeat(64),
    phase: 'CANARY', quoteMaxAgeMs: 1_000, slippageBps: 0n, snapshotMaxSlotLag: 0,
    maxComputeUnits: 1n, maxFeeLamports: 0n, maxFeePayerLamportDebit: 0n,
    maxPriorityFeeLamports: 0n, rpcTimeoutMs: 1_000, maxRpcCallsPerAttempt,
    quoteMintAllowlist: Object.freeze(['So11111111111111111111111111111111111111112'] as const),
  });
}

function freshDatabase(): LiveExecutorBootstrapDatabase {
  const claim = Object.freeze({
    intent: Object.freeze({
      id: `execution_intent_${'a'.repeat(64)}`, payloadVersion: 1, logicalOrderKey: 'logical',
      strategyId: 'strategy', strategyVersion: 1, positionId: 'position', logicalCommandId: 'logical',
      mint: '11111111111111111111111111111111', side: 'SELL' as const,
      venuePolicy: 'CANONICAL_EXIT' as const, quoteMint: 'So11111111111111111111111111111111111111112',
      quoteTokenProgram: 'SPL_TOKEN' as const, quoteDecimals: 9, quoteAmountRaw: null, baseAmountRaw: 1n,
      minimumAmountOutRaw: 1n, decisionEventId: 'event', decisionFingerprint: 'b'.repeat(64),
      requestedAtMs: 0, expiresAtMs: 2_000, status: 'PENDING' as const, attemptCount: 0,
      stateRevision: 0n, lastReasonCode: null, terminalAtMs: null, reconciliationCompletedAtMs: null,
      purgeAfterMs: null, createdAtMs: 0, updatedAtMs: 0,
    }), leaseOwner: 'owner', leaseToken: '00000000-0000-4000-8000-000000000000', leaseExpiresAtMs: 60_000,
  });
  return Object.freeze({
    intents: {
      claim: async () => claim,
      transition: async (_claim: unknown, input: { nextStatus: 'PROCESSING' }) =>
        Object.freeze({ ...claim.intent, status: input.nextStatus, stateRevision: 1n }),
      beginAttempt: async (active: unknown) => Object.freeze({
        claim: active,
        attempt: Object.freeze({ intentId: claim.intent.id, attemptNumber: 1, startedAtMs: 1 }),
      }),
      renew: async (active: unknown) => active,
      release: async () => true,
    },
    venues: {}, live: {
      readPreparationBinding: async () => { throw new Error('unexpected binding'); },
      authorizeExactSigning: async () => { throw new Error('unexpected authorization'); },
    },
    simulations: { complete: async () => undefined }, close: async () => undefined, evict: () => undefined,
    validateStartup: async () => Object.freeze({}) as never,
  }) as unknown as LiveExecutorBootstrapDatabase;
}

async function localUnsignedFetch(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const method = (JSON.parse(init?.body as string) as { readonly method: string }).method;
  const result = method === 'getGenesisHash' ? '11111111111111111111111111111111' : null;
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
}

interface CompleteTailRpcAccount {
  readonly lamports: number;
  readonly owner: string;
  readonly executable: false;
  readonly rentEpoch: number;
  readonly space: number;
  readonly data: readonly [string, 'base64'];
}

function completeTailFixture() {
  const signer = Keypair.generate();
  const baseAccount = Keypair.generate().publicKey;
  const quoteAccount = getAssociatedTokenAddressSync(NATIVE_MINT, signer.publicKey);
  const baseMint = Keypair.generate().publicKey;
  const instruction = SystemProgram.transfer({
    fromPubkey: signer.publicKey, toPubkey: quoteAccount, lamports: 1,
  });
  const compiled = compileInspectedV0Message(Object.freeze({
    feePayer: signer.publicKey.toBase58(),
    instructions: Object.freeze([Object.freeze({
      programId: instruction.programId.toBase58(),
      accounts: Object.freeze(instruction.keys.map((account) => Object.freeze({
        address: account.pubkey.toBase58(),
        isSigner: account.isSigner,
        isWritable: account.isWritable,
      }))),
      dataBase64: Buffer.from(instruction.data).toString('base64'),
    })]),
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    maximumTransactionBytes: 1_232,
  }));
  const transaction = VersionedTransaction.deserialize(
    Uint8Array.from(compiled.unsignedTransactionBytes),
  );
  transaction.sign([signer]);
  const signature = transaction.signatures[0];
  assert.ok(signature);
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1,
    intentId: `execution_intent_${'1'.repeat(64)}`, attemptNumber: 1,
    generationId: `execution_wallet_generation_${'2'.repeat(64)}`,
    armamentId: `execution_activation_armament_${'3'.repeat(64)}`,
    reservationId: `execution_exposure_reservation_${'7'.repeat(64)}`,
    exitAuthorizationId: null, providerId: 'primary',
    walletPublicKey: signer.publicKey.toBase58(), side: 'BUY', effectiveVenue: 'PUMP_FUN',
    messageHash: compiled.messageHash, buildFingerprint: '4'.repeat(64),
    snapshotFingerprint: '5'.repeat(64), quoteFingerprint: '6'.repeat(64),
    quoteObservedAtMs: 1_786_698_999_900, quoteExpiresAtMs: 1_786_699_005_000,
    blockhash: compiled.recentBlockhash, lastValidBlockHeight: 500n,
    signature: bs58.encode(signature), signedTransactionBytes: transaction.serialize(),
    signedAtMs: 1_786_699_000_000,
  });
  const persisted = Object.freeze({
    payloadVersion: 1 as const, artifact, state: 'PERSISTED' as const, stateRevision: 0n,
  });
  const pre = Object.freeze([
    completeTailSystemAccount(10_000_000),
    completeTailTokenAccount(baseMint, signer.publicKey, 10n),
    completeTailTokenAccount(NATIVE_MINT, signer.publicKey, 200n),
  ] as const);
  const post = Object.freeze([
    completeTailSystemAccount(9_995_000),
    completeTailTokenAccount(baseMint, signer.publicKey, 105n),
    completeTailTokenAccount(NATIVE_MINT, signer.publicKey, 100n),
  ] as const);
  return Object.freeze({
    artifact,
    pre,
    post,
    signedSimulation: Object.freeze({
      payloadVersion: 1 as const,
      persisted,
      snapshotSlot: 123n,
      accountAddresses: Object.freeze([
        signer.publicKey.toBase58(), baseAccount.toBase58(), quoteAccount.toBase58(),
      ] as const),
      amountInRaw: 100n,
      protectedAmountOutRaw: 90n,
      unsignedSimulation: Object.freeze({
        outcome: 'SUCCESS' as const, snapshotFingerprint: '5'.repeat(64),
        buildFingerprint: '4'.repeat(64), messageHash: artifact.messageHash,
        blockhash: artifact.blockhash, lastValidBlockHeight: 500n,
        blockhashContextSlot: 124n, feeContextSlot: 124n, estimatedFeeLamports: 5_000n,
        simulationSlot: 125n, simulatedFeePayerLamportDebit: 5_000n,
        unitsConsumed: 25_000n, simulatedBaseDeltaRaw: 100n,
        simulatedQuoteDeltaRaw: -100n, logsFingerprint: '7'.repeat(64), logsLineCount: 1,
      }),
    }),
    submissionStarted: Object.freeze({
      payloadVersion: 1 as const, artifact,
      state: 'SUBMISSION_STARTED' as const, stateRevision: 1n,
    }),
  });
}

function completeTailSystemAccount(lamports: number): CompleteTailRpcAccount {
  return Object.freeze({
    lamports, owner: SystemProgram.programId.toBase58(), executable: false,
    rentEpoch: 0, space: 0, data: Object.freeze(['', 'base64'] as const),
  });
}

function completeTailTokenAccount(
  mint: PublicKey,
  holder: PublicKey,
  amount: bigint,
): CompleteTailRpcAccount {
  const data = Buffer.alloc(165);
  data.set(mint.toBytes(), 0);
  data.set(holder.toBytes(), 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return Object.freeze({
    lamports: Number(2_039_280n + (mint.equals(NATIVE_MINT) ? amount : 0n)),
    owner: TOKEN_PROGRAM_ID.toBase58(), executable: false,
    rentEpoch: 0, space: data.byteLength,
    data: Object.freeze([data.toString('base64'), 'base64'] as const),
  });
}

function manualScheduler(): LiveExecutorRuntimeScheduler & Readonly<{
  fire(delayMs: number): void;
}> {
  let nextId = 1;
  const tasks = new Map<number, Readonly<{ callback: () => void; delayMs: number }>>();
  return {
    setTimeout: (callback, delayMs) => {
      const id = nextId++;
      tasks.set(id, { callback, delayMs });
      return id;
    },
    clearTimeout: (handle) => { tasks.delete(handle as number); },
    fire: (delayMs) => {
      const entry = [...tasks].find(([, task]) => task.delayMs === delayMs);
      assert.ok(entry !== undefined, `missing timer ${delayMs}`);
      tasks.delete(entry[0]);
      entry[1].callback();
    },
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

function abortState(signal: AbortSignal | null): boolean | null {
  return signal?.aborted ?? null;
}

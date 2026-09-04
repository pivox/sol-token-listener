import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { LiveExecutorConfig } from '../src/executor-live/config.js';
import {
  startLiveExecutor,
  type LiveExecutorBootstrapDependencies,
} from '../src/executor-live/main.js';
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
const runbookUrl = new URL('../docs/operations/executor-live-canary.md', import.meta.url);
const deploymentSmokeUrl = new URL('../scripts/deployment-smoke.mjs', import.meta.url);

void test('H1 remains non-live and records its exact operational boundary', async () => {
  const [
    packageText,
    parentSpecification,
    liveSpecification,
    orchestrationSpecification,
    runbook,
    deploymentSmoke,
  ] =
    await Promise.all([
      readFile(packageUrl, 'utf8'),
      readFile(parentSpecificationUrl, 'utf8'),
      readFile(liveSpecificationUrl, 'utf8'),
      readFile(orchestrationSpecificationUrl, 'utf8'),
      readFile(runbookUrl, 'utf8'),
      readFile(deploymentSmokeUrl, 'utf8'),
    ]);
  const packageJson = JSON.parse(packageText) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };

  assert.equal(packageJson.scripts?.['executor:live:start'], undefined);
  assertContainsExactlyOnce(
    parentSpecification,
    '**Version de spécification :** 1.7.17',
    'parent specification version',
  );
  assertContainsExactlyOnce(
    parentSpecification,
    '**Périmètre livré à cette version :** #51-A à #51-G et primitives persistantes\n'
      + '#51-H1 (claims, read-models et scan atomique des sorties à deadline)',
    'parent delivered scope',
  );
  assertContainsExactlyOnce(
    liveSpecification,
    '**Version de spécification :** 1.0.17',
    'live specification version',
  );
  assertContainsExactlyOnce(
    liveSpecification,
    '**Version de la spécification parente :** 1.7.17',
    'live parent specification version',
  );
  assertContainsExactlyOnce(
    orchestrationSpecification,
    '**Version de spécification :** 1.0.4',
    'orchestration specification version',
  );
  assertContainsExactlyOnce(
    orchestrationSpecification,
    '**Version de la spécification parente :** 1.7.17',
    'orchestration parent specification version',
  );
  assertContainsExactlyOnce(
    orchestrationSpecification,
    '**Version de la fondation live :** 1.0.17',
    'orchestration live foundation version',
  );
  assertContainsExactlyOnce(
    runbook,
    '**Version :** 1.1.6 — 2026-09-04',
    'runbook version',
  );

  assertContainsExactlyOnce(
    orchestrationSpecification,
    '```text\nLIVE_RUNTIME_NOT_COMPOSED\nCANARY_NOT_STARTED\nNON_EXECUTED / NON_VALIDATED\n```',
    'orchestration operational state',
  );
  assertContainsExactlyOnce(
    runbook,
    "Pour l'instant, le constat obligatoire est : `LIVE_RUNTIME_NOT_COMPOSED`,\n"
      + '`CANARY_NOT_STARTED`, `NON_EXECUTED / NON_VALIDATED`.',
    'runbook operational state',
  );
  for (const contradictoryState of [
    'LIVE_RUNTIME_COMPOSED',
    'CANARY_STARTED',
    'EXECUTED / VALIDATED',
  ]) {
    assert.equal(orchestrationSpecification.includes(contradictoryState), false, contradictoryState);
    assert.equal(runbook.includes(contradictoryState), false, contradictoryState);
  }
  assert.equal((deploymentSmoke.match(/'037_execution_live_orchestration\.sql'/gu) ?? []).length, 1);
  assert.equal(
    /const canonicalMigrations = Object\.freeze\(\[[\s\S]*?\n {2}'036_execution_live_canary\.sql',\n {2}'037_execution_live_orchestration\.sql',\n\]\);/u.test(deploymentSmoke),
    true,
    'deployment smoke migration head',
  );
});

function assertContainsExactlyOnce(source: string, expected: string, label: string): void {
  assert.equal(source.split(expected).length - 1, 1, label);
}

void test('one live pass enforces reconciliation, confirmation, SELL, deadline, BUY priority', async () => {
  const calls: string[] = [];
  const configuredLanes = buildLanes((name) => async () => {
    calls.push(name);
    return name === 'deadlineSell' ? 'WORKED' : 'IDLE';
  });

  assert.equal(
    await runLiveExecutorPass(configuredLanes, new AbortController().signal),
    'DEADLINE_SELL',
  );
  assert.deepEqual(calls, ['reconciliation', 'confirmation', 'sell', 'deadlineSell']);
});

void test('bootstrap validates config and schema before loading the signer and never mutates controls', async () => {
  const calls: string[] = [];
  const signer = fakeSigner(calls);
  const signals = new EventEmitter();
  const scheduler = manualScheduler();
  const environment = Object.freeze({ marker: 'environment' });
  const config = Object.freeze({ pollMs: 100, shutdownGraceMs: 1_000 }) as LiveExecutorConfig;
  const dependencies: LiveExecutorBootstrapDependencies = {
    parseConfig: (received) => {
      assert.equal(received, environment);
      calls.push('config');
      return config;
    },
    openDatabase: async () => {
      calls.push('database');
      return Object.freeze({
        validateSchema: async () => { calls.push('schema'); },
        close: async () => { calls.push('database.close'); },
        evict: () => { calls.push('database.evict'); },
      });
    },
    loadSigner: async () => {
      calls.push('secret');
      return signer;
    },
    createLanes: () => {
      calls.push('lanes');
      return buildLanes(() => async () => 'IDLE');
    },
    runtime: (runtimeDependencies, options) => runLiveExecutorRuntime(
      runtimeDependencies,
      { ...options, scheduler, signalSource: signals },
    ),
    forceExit: () => { calls.push('force'); },
  };

  const started = startLiveExecutor(environment, dependencies);
  await nextTurn();
  assert.deepEqual(calls.slice(0, 5), ['config', 'database', 'schema', 'secret', 'lanes']);
  assert.equal(calls.includes('arm'), false);
  assert.equal(calls.includes('resume'), false);
  assert.equal(calls.includes('control'), false);
  signals.emit('SIGTERM');
  await started;
  assert.deepEqual(calls.slice(-2), ['signer.close', 'database.close']);
});

void test('schema rejection closes the database without ever opening the secret', async () => {
  const calls: string[] = [];
  const expected = new Error('schema unavailable');
  await assert.rejects(startLiveExecutor(Object.freeze({}), {
    parseConfig: () => Object.freeze({ pollMs: 100, shutdownGraceMs: 1_000 }) as LiveExecutorConfig,
    openDatabase: async () => Object.freeze({
      validateSchema: async () => { calls.push('schema'); throw expected; },
      close: async () => { calls.push('database.close'); },
      evict: () => undefined,
    }),
    loadSigner: async () => { calls.push('secret'); return fakeSigner(calls); },
    createLanes: () => buildLanes(() => async () => 'IDLE'),
    runtime: async () => undefined,
    forceExit: () => undefined,
  }), expected);
  assert.deepEqual(calls, ['schema', 'database.close']);
});

void test('shutdown aborts work, closes the signer first and forces a bounded exit when stuck', async () => {
  const calls: string[] = [];
  const signals = new EventEmitter();
  const scheduler = manualScheduler();
  let workSignal: AbortSignal | null = null;
  const runtime = runLiveExecutorRuntime({
    lanes: buildLanes((name) => name === 'reconciliation'
      ? async (signal) => {
        workSignal = signal;
        calls.push('work');
        return new Promise<'IDLE'>(() => undefined);
      }
      : async () => 'IDLE'),
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

function buildLanes(
  create: (name: 'reconciliation' | 'confirmation' | 'sell' | 'deadlineSell' | 'buy') => LiveExecutorLane,
) {
  return Object.freeze({
    reconciliation: create('reconciliation'),
    confirmation: create('confirmation'),
    sell: create('sell'),
    deadlineSell: create('deadlineSell'),
    buy: create('buy'),
  });
}

function fakeSigner(calls: string[]): ExecutionTransactionSigner {
  return Object.freeze({
    publicKey: '11111111111111111111111111111111',
    signMessage: async () => Object.freeze({ signature: new Uint8Array(64) }),
    close: async () => { calls.push('signer.close'); },
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

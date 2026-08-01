import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ListenerRuntimeError,
  SolanaListenerRuntime,
  type ListenerRuntimeDependencies,
} from '../src/application/listener-runtime.js';

void test('starts dependencies in exact order and exposes honest frozen pipeline state', async () => {
  const calls: string[] = [];
  const runtime = new SolanaListenerRuntime(dependencies(calls), { shutdownTimeoutMs: 100 });

  await runtime.start();

  assert.deepEqual(calls, [
    'rpc.health', 'scanner.scan', 'subscriber.start', 'worker.start',
    'reconciler.start', 'heartbeat.start',
  ]);
  assert.equal(runtime.state(), 'RUNNING');
  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING',
  });
  assert.ok(Object.isFrozen(runtime.pipelineState()));
});

void test('rolls back only started resources in reverse after startup failure', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  deps.worker.start = async () => { calls.push('worker.start'); throw new Error('private startup'); };
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });

  await assert.rejects(runtime.start(), (error: unknown) => {
    assert.ok(error instanceof ListenerRuntimeError);
    assert.deepEqual(error.failures, [
      Object.freeze({ stage: 'worker-start', errorName: 'ListenerDependencyError' }),
    ]);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
  assert.deepEqual(calls, [
    'rpc.health', 'scanner.scan', 'subscriber.start', 'worker.start', 'subscriber.close',
  ]);
  assert.equal(runtime.state(), 'DEGRADED');
});

void test('stops claims, closes producers, drains worker, and writes STOPPED heartbeat', async () => {
  const calls: string[] = [];
  const runtime = new SolanaListenerRuntime(dependencies(calls), { shutdownTimeoutMs: 100 });
  await runtime.start();
  calls.length = 0;

  await Promise.all([runtime.close(), runtime.close()]);

  assert.deepEqual(calls, [
    'worker.close', 'subscriber.close', 'scanner.close', 'reconciler.close',
    'heartbeat.stop:STOPPED',
  ]);
  assert.equal(runtime.state(), 'STOPPED');
  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true, pumpfun: 'STOPPED', pumpswap: 'STOPPED',
  });
});

void test('bounds worker drain and aggregates cleanup failures without raw errors', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  deps.worker.close = () => { calls.push('worker.close'); return new Promise<void>(() => {}); };
  deps.subscriber.close = async () => { calls.push('subscriber.close'); throw new Error('subscriber secret'); };
  deps.scanner.close = () => { calls.push('scanner.close'); throw new Error('scanner secret'); };
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 5 });
  await runtime.start();
  calls.length = 0;

  await assert.rejects(runtime.close(), (error: unknown) => {
    assert.ok(error instanceof ListenerRuntimeError);
    assert.deepEqual(error.failures, [
      Object.freeze({ stage: 'subscriber-close', errorName: 'ListenerDependencyError' }),
      Object.freeze({ stage: 'scanner-close', errorName: 'ListenerDependencyError' }),
      Object.freeze({ stage: 'worker-timeout', errorName: 'ListenerTimeoutError' }),
    ]);
    assert.doesNotMatch(String(error), /secret/u);
    return true;
  });
  assert.deepEqual(calls, [
    'worker.close', 'subscriber.close', 'scanner.close', 'reconciler.close',
    'heartbeat.stop:STOPPED',
  ]);
  assert.equal(runtime.state(), 'DEGRADED');
});

void test('reflects active component degradation and validates shutdown bounds', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  let workerState: 'RUNNING' | 'DEGRADED' = 'RUNNING';
  deps.worker.state = () => workerState;
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });
  await runtime.start();
  workerState = 'DEGRADED';
  assert.equal(runtime.state(), 'DEGRADED');
  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true, pumpfun: 'DEGRADED', pumpswap: 'DEGRADED',
  });
  assert.throws(() => new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 0 }), TypeError);
});

function dependencies(calls: string[]): ListenerRuntimeDependencies {
  return {
    rpc: { async checkHealth() { calls.push('rpc.health'); } },
    scanner: {
      async scan() { calls.push('scanner.scan'); },
      async close() { calls.push('scanner.close'); },
      state: () => 'RUNNING',
    },
    subscriber: {
      async start() { calls.push('subscriber.start'); },
      async close() { calls.push('subscriber.close'); },
      state: () => 'RUNNING',
    },
    worker: {
      async start() { calls.push('worker.start'); },
      async close() { calls.push('worker.close'); },
      state: () => 'RUNNING',
    },
    reconciler: {
      async start() { calls.push('reconciler.start'); },
      async close() { calls.push('reconciler.close'); },
      state: () => 'RUNNING',
    },
    heartbeat: {
      async start() { calls.push('heartbeat.start'); },
      async stop(state) { calls.push(`heartbeat.stop:${state}`); },
      state: () => 'RUNNING',
    },
  };
}

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
    'rpc.health', 'scanner.scan', 'subscriber.start', 'scanner.scan', 'worker.start',
    'socialWorker.start', 'reconciler.start', 'heartbeat.start',
  ]);
  assert.equal(runtime.state(), 'RUNNING');
  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING', social: 'RUNNING',
  });
  assert.ok(Object.isFrozen(runtime.pipelineState()));
});

void test('social degradation is visible without relabeling healthy chain pipelines', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  let socialState: 'RUNNING' | 'DEGRADED' = 'RUNNING';
  deps.socialWorker.state = () => socialState;
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });
  await runtime.start();
  socialState = 'DEGRADED';

  assert.equal(runtime.state(), 'DEGRADED');
  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING', social: 'DEGRADED',
  });
});

void test('rolls back the transaction worker and producers when social startup fails', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  deps.socialWorker.start = async () => {
    calls.push('socialWorker.start');
    throw new Error('private social startup');
  };
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });

  await assert.rejects(runtime.start(), (error: unknown) => {
    assert.ok(error instanceof ListenerRuntimeError);
    assert.deepEqual(error.failures, [
      Object.freeze({ stage: 'social-worker-start', errorName: 'ListenerDependencyError' }),
    ]);
    assert.doesNotMatch(String(error), /private/u);
    return true;
  });
  assert.deepEqual(calls, [
    'rpc.health', 'scanner.scan', 'subscriber.start', 'scanner.scan', 'worker.start',
    'socialWorker.start', 'worker.close', 'subscriber.close',
  ]);
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
    'rpc.health', 'scanner.scan', 'subscriber.start', 'scanner.scan',
    'worker.start', 'subscriber.close',
  ]);
  assert.equal(runtime.state(), 'DEGRADED');
});

void test('closes the subscriber when the post-subscription catch-up fails', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  let scans = 0;
  deps.scanner.scan = async () => {
    calls.push('scanner.scan');
    scans += 1;
    if (scans === 2) throw new Error('private gap scan');
  };
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });

  await assert.rejects(runtime.start(), (error: unknown) => {
    assert.ok(error instanceof ListenerRuntimeError);
    assert.deepEqual(error.failures, [
      Object.freeze({ stage: 'scanner-scan', errorName: 'ListenerDependencyError' }),
    ]);
    assert.doesNotMatch(String(error), /private|gap/u);
    return true;
  });
  assert.deepEqual(calls, [
    'rpc.health', 'scanner.scan', 'subscriber.start', 'scanner.scan',
    'subscriber.close',
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
    'socialWorker.close', 'worker.close', 'subscriber.close', 'scanner.close', 'reconciler.close',
    'heartbeat.stop:STOPPED',
  ]);
  assert.equal(runtime.state(), 'STOPPED');
  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true, pumpfun: 'STOPPED', pumpswap: 'STOPPED', social: 'STOPPED',
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
    'socialWorker.close', 'worker.close', 'subscriber.close', 'scanner.close', 'reconciler.close',
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
    httpAvailable: true, pumpfun: 'DEGRADED', pumpswap: 'DEGRADED', social: 'RUNNING',
  });
  assert.throws(() => new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 0 }), TypeError);
});

void test('uses one global deadline for startup and every shutdown dependency', async () => {
  const calls: string[] = [];
  const deps: ListenerRuntimeDependencies = {
    ...dependencies(calls),
    rpc: {
      async checkHealth() {
        calls.push('rpc.health');
        await new Promise<void>(() => undefined);
      },
    },
  };
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 5 });
  void runtime.start().catch(() => undefined);
  await Promise.resolve();
  const startedAt = Date.now();

  await assert.rejects(runtime.close(), (error: unknown) => {
    assert.ok(error instanceof ListenerRuntimeError);
    assert.deepEqual(error.failures, [
      Object.freeze({ stage: 'startup-timeout', errorName: 'ListenerTimeoutError' }),
    ]);
    return true;
  });
  assert.ok(Date.now() - startedAt < 50);
  assert.deepEqual(calls, [
    'rpc.health', 'socialWorker.close', 'worker.close', 'subscriber.close', 'scanner.close',
    'reconciler.close', 'heartbeat.stop:STOPPED',
  ]);
  assert.equal(runtime.state(), 'DEGRADED');
});

void test('attempts all hanging cleanup within one shared shutdown budget', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  const hanging = () => new Promise<void>(() => undefined);
  deps.worker.close = () => { calls.push('worker.close'); return hanging(); };
  deps.socialWorker.close = () => { calls.push('socialWorker.close'); return hanging(); };
  deps.subscriber.close = () => { calls.push('subscriber.close'); return hanging(); };
  deps.scanner.close = () => { calls.push('scanner.close'); return hanging(); };
  deps.reconciler.close = () => { calls.push('reconciler.close'); return hanging(); };
  deps.heartbeat.stop = (state) => { calls.push(`heartbeat.stop:${state}`); return hanging(); };
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 10 });
  await runtime.start();
  calls.length = 0;
  const startedAt = Date.now();

  await assert.rejects(runtime.close(), (error: unknown) => {
    assert.ok(error instanceof ListenerRuntimeError);
    assert.deepEqual(error.failures, [
      Object.freeze({ stage: 'social-worker-timeout', errorName: 'ListenerTimeoutError' }),
      Object.freeze({ stage: 'subscriber-close', errorName: 'ListenerTimeoutError' }),
      Object.freeze({ stage: 'scanner-close', errorName: 'ListenerTimeoutError' }),
      Object.freeze({ stage: 'reconciler-close', errorName: 'ListenerTimeoutError' }),
      Object.freeze({ stage: 'worker-timeout', errorName: 'ListenerTimeoutError' }),
      Object.freeze({ stage: 'heartbeat-stop', errorName: 'ListenerTimeoutError' }),
    ]);
    return true;
  });
  assert.ok(Date.now() - startedAt < 60);
  assert.deepEqual(calls, [
    'socialWorker.close', 'worker.close', 'subscriber.close', 'scanner.close', 'reconciler.close',
    'heartbeat.stop:STOPPED',
  ]);
  assert.equal(runtime.state(), 'DEGRADED');
});

void test('reports RUNNING only when every active component is explicitly RUNNING', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  const states = {
    scanner: 'RUNNING', subscriber: 'RUNNING', worker: 'RUNNING',
    reconciler: 'RUNNING', heartbeat: 'RUNNING',
  } as Record<string, string>;
  deps.scanner.state = () => states.scanner as 'RUNNING';
  deps.subscriber.state = () => states.subscriber as 'RUNNING';
  deps.worker.state = () => states.worker as 'RUNNING';
  deps.reconciler.state = () => states.reconciler as 'RUNNING';
  deps.heartbeat.state = () => states.heartbeat as 'RUNNING';
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });
  await runtime.start();

  for (const component of Object.keys(states)) {
    for (const state of ['STOPPED', 'STARTING', 'STOPPING', 'DEGRADED', 'UNKNOWN']) {
      states[component] = state;
      assert.equal(runtime.state(), 'DEGRADED', `${component}:${state}`);
      assert.equal(runtime.pipelineState().pumpfun, 'DEGRADED', `${component}:${state}`);
      states[component] = 'RUNNING';
    }
  }
  assert.equal(runtime.state(), 'RUNNING');
});

void test('retries only unresolved startup rollback cleanup before becoming STOPPED', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  let subscriberCloseAttempts = 0;
  deps.worker.start = async () => { calls.push('worker.start'); throw new Error('worker secret'); };
  deps.subscriber.close = async () => {
    calls.push('subscriber.close');
    subscriberCloseAttempts += 1;
    if (subscriberCloseAttempts === 1) throw new Error('rollback secret');
  };
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });

  await assert.rejects(runtime.start(), (error: unknown) => {
    assert.ok(error instanceof ListenerRuntimeError);
    assert.deepEqual(error.failures, [
      Object.freeze({ stage: 'worker-start', errorName: 'ListenerDependencyError' }),
      Object.freeze({ stage: 'subscriber-close', errorName: 'ListenerDependencyError' }),
    ]);
    return true;
  });
  calls.length = 0;

  await runtime.close();
  assert.deepEqual(calls, ['subscriber.close']);
  assert.equal(runtime.state(), 'STOPPED');
  await runtime.close();
  assert.deepEqual(calls, ['subscriber.close']);
});

void test('keeps persistent rollback cleanup failure DEGRADED and retryable', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  deps.worker.start = async () => { calls.push('worker.start'); throw new Error('worker secret'); };
  deps.subscriber.close = async () => {
    calls.push('subscriber.close');
    throw new Error('persistent cleanup secret');
  };
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });
  await assert.rejects(runtime.start(), ListenerRuntimeError);
  calls.length = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(runtime.close(), (error: unknown) => {
      assert.ok(error instanceof ListenerRuntimeError);
      assert.deepEqual(error.failures, [
        Object.freeze({ stage: 'subscriber-close', errorName: 'ListenerDependencyError' }),
      ]);
      assert.doesNotMatch(String(error), /secret/u);
      return true;
    });
    assert.equal(runtime.state(), 'DEGRADED');
  }
  assert.deepEqual(calls, ['subscriber.close', 'subscriber.close']);
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
    socialWorker: {
      async start() { calls.push('socialWorker.start'); },
      async close() { calls.push('socialWorker.close'); },
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

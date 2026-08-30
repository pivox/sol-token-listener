import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ListenerRuntimeError,
  SolanaListenerRuntime,
  type ListenerRuntimeDependencies,
} from '../src/application/listener-runtime.js';

void test('starts the supervisor before every consumer and exposes honest frozen pipeline state', async () => {
  const calls: string[] = [];
  const runtime = new SolanaListenerRuntime(dependencies(calls), { shutdownTimeoutMs: 100 });

  await runtime.start();

  assert.deepEqual(calls, [
    'supervisor.start',
    'worker.start',
    'reconciler.start',
    'paperWorker.start',
    'socialWorker.start',
    'heartbeat.start',
  ]);
  assert.equal(runtime.state(), 'RUNNING');
  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true,
    pumpfun: 'RUNNING',
    pumpswap: 'RUNNING',
    qualification: 'RUNNING',
    paperDecision: 'RUNNING',
    social: 'RUNNING',
  });
  assert.ok(Object.isFrozen(runtime.pipelineState()));
});

void test('chain health requires the supervisor, inbox worker, reconciler, and heartbeat only', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  const states: Record<string, string> = {
    supervisor: 'RUNNING',
    worker: 'RUNNING',
    reconciler: 'RUNNING',
    heartbeat: 'RUNNING',
    paperWorker: 'RUNNING',
    socialWorker: 'RUNNING',
  };
  deps.supervisor.state = () => states.supervisor as 'RUNNING';
  deps.worker.state = () => states.worker as 'RUNNING';
  deps.reconciler.state = () => states.reconciler as 'RUNNING';
  deps.heartbeat.state = () => states.heartbeat as 'RUNNING';
  deps.paperWorker.state = () => states.paperWorker as 'RUNNING';
  deps.socialWorker.state = () => states.socialWorker as 'RUNNING';
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });
  await runtime.start();

  for (const component of ['supervisor', 'worker', 'reconciler', 'heartbeat']) {
    states[component] = component === 'supervisor' ? 'STARTING' : 'DEGRADED';
    assert.equal(runtime.state(), 'DEGRADED', component);
    assert.deepEqual(runtime.pipelineState(), {
      httpAvailable: true,
      pumpfun: 'DEGRADED',
      pumpswap: 'DEGRADED',
      qualification: 'DEGRADED',
      paperDecision: 'RUNNING',
      social: 'RUNNING',
    });
    states[component] = 'RUNNING';
  }

  states.paperWorker = 'DEGRADED';
  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true,
    pumpfun: 'RUNNING',
    pumpswap: 'RUNNING',
    qualification: 'RUNNING',
    paperDecision: 'DEGRADED',
    social: 'RUNNING',
  });
  states.paperWorker = 'RUNNING';
  states.socialWorker = 'STOPPED';
  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true,
    pumpfun: 'RUNNING',
    pumpswap: 'RUNNING',
    qualification: 'RUNNING',
    paperDecision: 'RUNNING',
    social: 'STOPPED',
  });
});

void test('rolls back each startup failure in the fixed producer-first shutdown order', async () => {
  const cases = [
    {
      component: 'supervisor' as const,
      stage: 'supervisor-start',
      expected: ['supervisor.start', 'supervisor.close'],
    },
    {
      component: 'worker' as const,
      stage: 'worker-start',
      expected: ['supervisor.start', 'worker.start', 'supervisor.close', 'worker.close'],
    },
    {
      component: 'reconciler' as const,
      stage: 'reconciler-start',
      expected: [
        'supervisor.start', 'worker.start', 'reconciler.start',
        'supervisor.close', 'reconciler.close', 'worker.close',
      ],
    },
    {
      component: 'paperWorker' as const,
      stage: 'paper-worker-start',
      expected: [
        'supervisor.start', 'worker.start', 'reconciler.start', 'paperWorker.start',
        'supervisor.close', 'paperWorker.close', 'reconciler.close', 'worker.close',
      ],
    },
    {
      component: 'socialWorker' as const,
      stage: 'social-worker-start',
      expected: [
        'supervisor.start', 'worker.start', 'reconciler.start', 'paperWorker.start',
        'socialWorker.start', 'supervisor.close', 'paperWorker.close',
        'socialWorker.close', 'reconciler.close', 'worker.close',
      ],
    },
    {
      component: 'heartbeat' as const,
      stage: 'heartbeat-start',
      expected: [
        'supervisor.start', 'worker.start', 'reconciler.start', 'paperWorker.start',
        'socialWorker.start', 'heartbeat.start', 'supervisor.close',
        'paperWorker.close', 'socialWorker.close', 'reconciler.close', 'worker.close',
        'heartbeat.stop:STOPPED',
      ],
    },
  ];

  for (const scenario of cases) {
    const calls: string[] = [];
    const deps = dependencies(calls);
    deps[scenario.component].start = async () => {
      calls.push(`${scenario.component}.start`);
      throw new Error(`private-${scenario.component}`);
    };
    const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });

    await assert.rejects(runtime.start(), (error: unknown) => {
      assert.ok(error instanceof ListenerRuntimeError);
      assert.deepEqual(error.failures, [
        Object.freeze({ stage: scenario.stage, errorName: 'ListenerDependencyError' }),
      ]);
      assert.doesNotMatch(String(error), /private/u);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
    assert.deepEqual(calls, scenario.expected, scenario.component);
    assert.equal(runtime.state(), 'DEGRADED');
  }
});

void test('awaits supervisor shutdown before draining any consumer', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  const supervisorClosed = deferred<undefined>();
  deps.supervisor.close = async () => {
    calls.push('supervisor.close:start');
    await supervisorClosed.promise;
    calls.push('supervisor.close:done');
  };
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });
  await runtime.start();
  calls.length = 0;

  const closing = runtime.close();
  await Promise.resolve();
  assert.deepEqual(calls, ['supervisor.close:start']);
  supervisorClosed.resolve(undefined);
  await closing;

  assert.deepEqual(calls, [
    'supervisor.close:start',
    'supervisor.close:done',
    'paperWorker.close',
    'socialWorker.close',
    'reconciler.close',
    'worker.close',
    'heartbeat.stop:STOPPED',
  ]);
  assert.equal(runtime.state(), 'STOPPED');
});

void test('uses one global deadline while invoking every shutdown stage sequentially', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  const hanging = (): Promise<void> => new Promise<void>(() => undefined);
  deps.supervisor.close = () => { calls.push('supervisor.close'); return hanging(); };
  deps.paperWorker.close = () => { calls.push('paperWorker.close'); return hanging(); };
  deps.socialWorker.close = () => { calls.push('socialWorker.close'); return hanging(); };
  deps.reconciler.close = () => { calls.push('reconciler.close'); return hanging(); };
  deps.worker.close = () => { calls.push('worker.close'); return hanging(); };
  deps.heartbeat.stop = (state) => { calls.push(`heartbeat.stop:${state}`); return hanging(); };
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 10 });
  await runtime.start();
  calls.length = 0;
  const startedAt = Date.now();

  await assert.rejects(runtime.close(), (error: unknown) => {
    assert.ok(error instanceof ListenerRuntimeError);
    assert.deepEqual(error.failures, [
      Object.freeze({ stage: 'supervisor-timeout', errorName: 'ListenerTimeoutError' }),
      Object.freeze({ stage: 'paper-worker-timeout', errorName: 'ListenerTimeoutError' }),
      Object.freeze({ stage: 'social-worker-timeout', errorName: 'ListenerTimeoutError' }),
      Object.freeze({ stage: 'reconciler-timeout', errorName: 'ListenerTimeoutError' }),
      Object.freeze({ stage: 'worker-timeout', errorName: 'ListenerTimeoutError' }),
      Object.freeze({ stage: 'heartbeat-timeout', errorName: 'ListenerTimeoutError' }),
    ]);
    return true;
  });
  assert.ok(Date.now() - startedAt < 80);
  assert.deepEqual(calls, [
    'supervisor.close', 'paperWorker.close', 'socialWorker.close',
    'reconciler.close', 'worker.close', 'heartbeat.stop:STOPPED',
  ]);
  assert.equal(runtime.state(), 'DEGRADED');
});

void test('aggregates fixed close failures and retries only unresolved resources', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  let supervisorAttempts = 0;
  deps.supervisor.close = async () => {
    calls.push('supervisor.close');
    supervisorAttempts += 1;
    if (supervisorAttempts === 1) throw new Error('private endpoint and cause');
  };
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });
  await runtime.start();
  calls.length = 0;

  await assert.rejects(runtime.close(), (error: unknown) => {
    assert.ok(error instanceof ListenerRuntimeError);
    assert.deepEqual(error.failures, [
      Object.freeze({ stage: 'supervisor-close', errorName: 'ListenerDependencyError' }),
    ]);
    assert.doesNotMatch(String(error), /private|endpoint|cause/u);
    return true;
  });
  assert.deepEqual(calls, [
    'supervisor.close', 'paperWorker.close', 'socialWorker.close',
    'reconciler.close', 'worker.close', 'heartbeat.stop:STOPPED',
  ]);
  calls.length = 0;

  await runtime.close();
  assert.deepEqual(calls, ['supervisor.close']);
  assert.equal(runtime.state(), 'STOPPED');
});

void test('close owns every currently starting component before a late resolution or rejection', async () => {
  const cases = [
    { component: 'supervisor' as const, closeCall: 'supervisor.close', next: 'worker.start' },
    { component: 'worker' as const, closeCall: 'worker.close', next: 'reconciler.start' },
    { component: 'reconciler' as const, closeCall: 'reconciler.close', next: 'paperWorker.start' },
    { component: 'paperWorker' as const, closeCall: 'paperWorker.close', next: 'socialWorker.start' },
    { component: 'socialWorker' as const, closeCall: 'socialWorker.close', next: 'heartbeat.start' },
    { component: 'heartbeat' as const, closeCall: 'heartbeat.stop:STOPPED', next: null },
  ];

  for (const scenario of cases) {
    for (const lateOutcome of ['resolve', 'reject'] as const) {
      const calls: string[] = [];
      const deps = dependencies(calls);
      const pendingStart = deferred<undefined>();
      deps[scenario.component].start = async () => {
        calls.push(`${scenario.component}.start`);
        await pendingStart.promise;
      };
      const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 5 });
      const starting = runtime.start();
      void starting.catch(() => undefined);
      for (let index = 0; index < 16 && !calls.includes(`${scenario.component}.start`); index += 1) {
        await Promise.resolve();
      }
      assert.ok(calls.includes(`${scenario.component}.start`), scenario.component);

      await assert.rejects(runtime.close(), (error: unknown) => {
        assert.ok(error instanceof ListenerRuntimeError);
        assert.deepEqual(error.failures, [
          Object.freeze({ stage: 'startup-timeout', errorName: 'ListenerTimeoutError' }),
        ]);
        return true;
      });
      assert.equal(
        calls.filter((call) => call === scenario.closeCall).length,
        1,
        `${scenario.component}:${lateOutcome}:cleanup`,
      );
      assert.equal(runtime.state(), 'DEGRADED');

      if (lateOutcome === 'resolve') pendingStart.resolve(undefined);
      else pendingStart.reject(new Error(`private-${scenario.component}`));
      await assert.rejects(starting, ListenerRuntimeError);
      await Promise.resolve();

      assert.equal(
        calls.filter((call) => call === scenario.closeCall).length,
        1,
        `${scenario.component}:${lateOutcome}:late`,
      );
      if (scenario.next !== null) assert.equal(calls.includes(scenario.next), false);
      assert.notEqual(runtime.state(), 'RUNNING');
    }
  }
});

void test('coalesces close with startup rollback while a resource cleanup is pending', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  const pendingStart = deferred<undefined>();
  const pendingClose = deferred<undefined>();
  deps.supervisor.start = async () => {
    calls.push('supervisor.start');
    await pendingStart.promise;
  };
  deps.supervisor.close = async () => {
    calls.push('supervisor.close');
    await pendingClose.promise;
  };
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });
  const starting = runtime.start();
  void starting.catch(() => undefined);
  pendingStart.reject(new Error('private-start'));
  for (let index = 0; index < 8 && !calls.includes('supervisor.close'); index += 1) {
    await Promise.resolve();
  }
  assert.deepEqual(calls, ['supervisor.start', 'supervisor.close']);

  const closing = runtime.close();
  await Promise.resolve();
  assert.equal(calls.filter((call) => call === 'supervisor.close').length, 1);
  pendingClose.resolve(undefined);

  await assert.rejects(starting, ListenerRuntimeError);
  await closing;
  assert.equal(calls.filter((call) => call === 'supervisor.close').length, 1);
  assert.equal(runtime.state(), 'STOPPED');
});

void test('publishes the close fence before a synchronous reentrant dependency failure', async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  let supervisorCloses = 0;
  deps.supervisor.close = () => {
    calls.push('supervisor.close');
    supervisorCloses += 1;
    if (supervisorCloses === 1) {
      void runtime.close().catch(() => undefined);
      throw new Error('private-sync-close');
    }
    return Promise.resolve();
  };
  const runtime = new SolanaListenerRuntime(deps, { shutdownTimeoutMs: 100 });
  await runtime.start();
  calls.length = 0;

  await assert.rejects(runtime.close(), (error: unknown) => {
    assert.ok(error instanceof ListenerRuntimeError);
    assert.deepEqual(error.failures, [
      Object.freeze({ stage: 'supervisor-close', errorName: 'ListenerDependencyError' }),
    ]);
    return true;
  });
  assert.equal(supervisorCloses, 1);
  assert.equal(runtime.state(), 'DEGRADED');

  await runtime.close();
  assert.equal(supervisorCloses, 2);
  assert.equal(runtime.state(), 'STOPPED');
});

void test('validates shutdown bounds and returns STOPPED projections before startup', () => {
  const runtime = new SolanaListenerRuntime(dependencies([]), { shutdownTimeoutMs: 100 });
  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true,
    pumpfun: 'STOPPED',
    pumpswap: 'STOPPED',
    qualification: 'STOPPED',
    paperDecision: 'STOPPED',
    social: 'STOPPED',
  });
  assert.throws(
    () => new SolanaListenerRuntime(dependencies([]), { shutdownTimeoutMs: 0 }),
    TypeError,
  );
});

function dependencies(calls: string[]): ListenerRuntimeDependencies {
  return {
    supervisor: {
      async start() { calls.push('supervisor.start'); },
      async close() { calls.push('supervisor.close'); },
      state: () => 'RUNNING',
      activeProviderId: () => 'primary',
    },
    worker: {
      async start() { calls.push('worker.start'); },
      async close() { calls.push('worker.close'); },
      state: () => 'RUNNING',
    },
    paperWorker: {
      async start() { calls.push('paperWorker.start'); },
      async close() { calls.push('paperWorker.close'); },
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error('Deferred is unavailable.');
      resolvePromise(value as T | PromiseLike<T>);
    },
    reject(reason) {
      if (rejectPromise === undefined) throw new Error('Deferred is unavailable.');
      rejectPromise(reason);
    },
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeploymentHealthcheckError,
  checkDeploymentHealth,
} from '../src/operations/deployment-healthcheck.js';
import {
  DEPLOYMENT_HEALTHCHECK_EXIT_CODES,
  deploymentHealthcheckUrl,
  runDeploymentHealthcheckCli,
} from '../scripts/deployment-healthcheck.js';

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

const HEALTH_URL = 'http://127.0.0.1:3000/api/v1/health';

void test('accepts the public V1 health envelope when PostgreSQL is available and status is OK or DEGRADED', async () => {
  for (const status of ['OK', 'DEGRADED'] as const) {
    let request: RequestInit | undefined;
    await checkDeploymentHealth(HEALTH_URL, {
      fetch: async (_url, init) => {
        request = init;
        return healthResponse(status);
      },
    });
    assert.deepEqual(request, {
      method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: request?.signal,
    });
    assert.ok(request?.signal instanceof AbortSignal);
  }
  await checkDeploymentHealth('http://127.0.0.1:80/api/v1/health', { fetch: async () => healthResponse('OK') });
});

void test('requires an OK runtime status only when strict production health is requested', async () => {
  await assert.rejects(checkDeploymentHealth(HEALTH_URL, {
    fetch: async () => healthResponse('DEGRADED'),
    requireOk: true,
  }), errorCode('HEALTHCHECK_UNHEALTHY'));
  await checkDeploymentHealth(HEALTH_URL, {
    fetch: async () => healthResponse('OK'),
    requireOk: true,
  });
  await checkDeploymentHealth(HEALTH_URL, {
    fetch: async () => healthResponse('DEGRADED'),
  });
});

void test('rejects PostgreSQL unavailability, HTTP failures, redirects, and invalid public health envelopes with stable codes', async () => {
  const cases: readonly [Response, string][] = [
    [healthResponse('DEGRADED', 'UNAVAILABLE'), 'HEALTHCHECK_UNHEALTHY'],
    [new Response('no', { status: 503 }), 'HEALTHCHECK_HTTP_STATUS_INVALID'],
    [new Response('', { status: 302, headers: { location: HEALTH_URL } }), 'HEALTHCHECK_HTTP_STATUS_INVALID'],
    [new Response(JSON.stringify({ apiVersion: 'v2', data: { status: 'OK', postgresql: { status: 'AVAILABLE' } } })), 'HEALTHCHECK_ENVELOPE_INVALID'],
  ];
  for (const [response, code] of cases) {
    await assert.rejects(checkDeploymentHealth(HEALTH_URL, { fetch: async () => response }), errorCode(code));
  }
});

void test('rejects non-canonical, non-loopback, credentialed, and non-health probe URLs before fetching', async () => {
  const invalid = [
    'https://127.0.0.1:3000/api/v1/health',
    'http://localhost:3000/api/v1/health',
    'http://127.0.0.1:0/api/v1/health',
    'http://127.0.0.1:3000/api/v1/health?x=1',
    'http://127.0.0.1:3000/api/v1/health#hash',
    'http://user:pass@127.0.0.1:3000/api/v1/health',
    'http://127.0.0.1:3000/api/v1/health/',
    'http://127.0.0.1:3000/api/v1/other',
    'http://127.0.0.1:3000/api/v1/health%2fother',
    'http://127.0.0.1:03000/api/v1/health',
    'http://127.0.0.1/api/v1/health',
  ];
  for (const url of invalid) {
    let calls = 0;
    await assert.rejects(checkDeploymentHealth(url, { fetch: async () => { calls += 1; return healthResponse('OK'); } }), errorCode('HEALTHCHECK_URL_INVALID'));
    assert.equal(calls, 0);
  }
});

void test('rejects malformed and hostile response data without retaining attacker failures', async () => {
  const hostile = new Proxy({}, { get: () => { throw new Error('healthcheck proxy secret'); } }) as Response;
  for (const [response, code] of [
    [new Response(JSON.stringify({ apiVersion: 'v1', data: { status: 'OK', postgresql: {} } })), 'HEALTHCHECK_ENVELOPE_INVALID'],
    [hostile, 'HEALTHCHECK_REQUEST_FAILED'],
  ] as const) {
    await assert.rejects(checkDeploymentHealth(HEALTH_URL, { fetch: async () => response }), (error: unknown) => {
      assert.ok(error instanceof DeploymentHealthcheckError);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /healthcheck proxy secret/u);
      return true;
    });
  }
});

void test('bounds both declared and streamed response bodies at 65536 bytes', async () => {
  const tooLarge = new Uint8Array(65_537);
  await assert.rejects(checkDeploymentHealth(HEALTH_URL, {
    fetch: async () => new Response('x', { headers: { 'content-length': '65537' } }),
  }), errorCode('HEALTHCHECK_BODY_TOO_LARGE'));
  await assert.rejects(checkDeploymentHealth(HEALTH_URL, {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(tooLarge); controller.close(); },
    })),
  }), errorCode('HEALTHCHECK_BODY_TOO_LARGE'));
});

void test('strictly rejects invalid UTF-8 and invalid JSON without exposing response content', async () => {
  for (const response of [
    new Response(new Uint8Array([0xc3, 0x28])),
    new Response('{"apiVersion":"v1"'),
  ]) await assert.rejects(checkDeploymentHealth(HEALTH_URL, { fetch: async () => response }), errorCode('HEALTHCHECK_ENVELOPE_INVALID'));
});

void test('aborts at three seconds and cleans up timeout resources after success and failure', async () => {
  const callbacks: (() => void)[] = [];
  const cleared: unknown[] = [];
  const handle = Object.freeze({ timer: 1 });
  const timers = {
    setTimeout: (next: () => void, delayMs: number): unknown => { assert.equal(delayMs, 3_000); callbacks.push(next); return handle; },
    clearTimeout: (value: unknown): void => { cleared.push(value); },
  };
  await checkDeploymentHealth(HEALTH_URL, { fetch: async () => healthResponse('OK'), timers });
  assert.deepEqual(cleared, [handle]);

  callbacks.length = 0;
  cleared.length = 0;
  let signal: AbortSignal | undefined;
  const pending = checkDeploymentHealth(HEALTH_URL, {
    fetch: async (_url, init) => {
      signal = init?.signal ?? undefined;
      return await new Promise<Response>(() => undefined);
    },
    timers,
  });
  assert.equal(callbacks.length, 1);
  callbacks[0]?.();
  await assert.rejects(pending, errorCode('HEALTHCHECK_TIMEOUT'));
  assert.equal(signal?.aborted, true);
  assert.deepEqual(cleared, [handle]);
});

void test('bounds a fetch that never settles by the global deadline', async () => {
  const deadline = manualDeadline();
  let signal: AbortSignal | undefined;
  const probe = checkDeploymentHealth(HEALTH_URL, {
    fetch: async (_url, init) => {
      signal = init?.signal ?? undefined;
      return await new Promise<Response>(() => undefined);
    },
    timers: deadline.timers,
  });
  deadline.fire();
  await assert.rejects(settlesPromptly(probe), errorCode('HEALTHCHECK_TIMEOUT'));
  assert.equal(signal?.aborted, true);
});

void test('reports the deadline when abort makes the pending fetch reject', async () => {
  const deadline = manualDeadline();
  const probe = checkDeploymentHealth(HEALTH_URL, {
    fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('abort detail')); }, { once: true });
    }),
    timers: deadline.timers,
  });
  deadline.fire();
  await assert.rejects(settlesPromptly(probe), errorCode('HEALTHCHECK_TIMEOUT'));
});

void test('bounds a response read and does not await cancellation that never settles', async () => {
  const deadline = manualDeadline();
  let cancelCalls = 0;
  let signal: AbortSignal | undefined;
  const probe = checkDeploymentHealth(HEALTH_URL, {
    fetch: async (_url, init) => {
      signal = init?.signal ?? undefined;
      return fakeResponse({
        read: async () => await new Promise<StreamReadResult>(() => undefined),
        cancel: () => { cancelCalls += 1; return new Promise<void>(() => undefined); },
      });
    },
    timers: deadline.timers,
  });
  await nextTurn();
  deadline.fire();
  await assert.rejects(settlesPromptly(probe), errorCode('HEALTHCHECK_TIMEOUT'));
  assert.equal(signal?.aborted, true);
  assert.equal(cancelCalls, 1);
});

void test('defers hostile read-lock cleanup until the pending read settles and contains its rejection', async () => {
  const deadline = manualDeadline();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  let rejectRead: ((error: Error) => void) | undefined;
  let releaseCalls = 0;
  process.on('unhandledRejection', onUnhandled);
  try {
    const probe = checkDeploymentHealth(HEALTH_URL, {
      fetch: async () => fakeResponse({
        read: async () => await new Promise<StreamReadResult>((_resolve, reject) => { rejectRead = reject; }),
        cancel: () => new Promise<void>(() => undefined),
        releaseLock: () => { releaseCalls += 1; throw new Error('release lock secret'); },
      }),
      timers: deadline.timers,
    });
    await nextTurn();
    deadline.fire();
    await assert.rejects(settlesPromptly(probe), errorCode('HEALTHCHECK_TIMEOUT'));
    assert.equal(releaseCalls, 0);
    assert.ok(rejectRead);
    rejectRead(new Error('pending read secret'));
    await nextTurn();
    await nextTurn();
    assert.equal(releaseCalls, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

void test('aborts and asynchronously cancels bodies for non-200 and declared oversized responses', async () => {
  for (const responseOptions of [
    { status: 503 },
    { status: 200, contentLength: '65537' },
  ]) {
    let signal: AbortSignal | undefined;
    let cancelCalls = 0;
    const response = fakeResponse({
      ...responseOptions,
      cancelBody: async () => { cancelCalls += 1; },
    });
    await assert.rejects(checkDeploymentHealth(HEALTH_URL, {
      fetch: async (_url, init) => { signal = init?.signal ?? undefined; return response; },
    }), errorCode(responseOptions.status === 503
      ? 'HEALTHCHECK_HTTP_STATUS_INVALID'
      : 'HEALTHCHECK_BODY_TOO_LARGE'));
    await nextTurn();
    assert.equal(signal?.aborted, true);
    assert.equal(cancelCalls, 1);
  }
});

void test('contains an asynchronous body cancellation rejection without an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(checkDeploymentHealth(HEALTH_URL, {
      fetch: async () => fakeResponse({
        status: 503,
        cancelBody: async () => { throw new Error('cancel rejection secret'); },
      }),
    }), errorCode('HEALTHCHECK_HTTP_STATUS_INVALID'));
    await nextTurn();
    await nextTurn();
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

void test('constructs the exact loopback URL from a canonical API_PORT and returns only a redacted CLI log on failure', async () => {
  assert.equal(deploymentHealthcheckUrl({ API_PORT: '65535' }), 'http://127.0.0.1:65535/api/v1/health');
  assert.equal(deploymentHealthcheckUrl({}), 'http://127.0.0.1:3000/api/v1/health');
  for (const value of ['0', '65536', '03000', ' 3000', '3000x']) {
    assert.throws(() => deploymentHealthcheckUrl({ API_PORT: value }), errorCode('HEALTHCHECK_PORT_INVALID'));
  }

  const writes: string[] = [];
  assert.equal(await runDeploymentHealthcheckCli({
    environment: { API_PORT: '3000' },
    write: (line) => { writes.push(line); },
    check: async () => { throw new Error('http://credentials.example/internal secret'); },
  }), 1);
  assert.deepEqual(writes, ['{"event":"deployment.healthcheck","code":"HEALTHCHECK_REQUEST_FAILED"}\n']);

  writes.length = 0;
  assert.equal(await runDeploymentHealthcheckCli({
    environment: { API_PORT: '0' }, write: (line) => { writes.push(line); },
    check: async () => undefined,
  }), 2);
  assert.deepEqual(writes, ['{"event":"deployment.healthcheck","code":"HEALTHCHECK_PORT_INVALID"}\n']);
});

void test('returns the documented healthy exit code without writing stdout, stderr, or logs', async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logs: string[] = [];
  const exitCode = await runDeploymentHealthcheckCli({
    environment: { API_PORT: '3000' },
    write: (line) => { logs.push(line); },
    check: async (url) => checkDeploymentHealth(url, { fetch: async () => healthResponse('OK') }),
  });
  assert.equal(exitCode, DEPLOYMENT_HEALTHCHECK_EXIT_CODES.HEALTHY);
  assert.deepEqual({ stdout, stderr, logs }, { stdout: [], stderr: [], logs: [] });
});

void test('passes an explicit strict mode from the CLI and rejects every other argument safely', async () => {
  const requested: boolean[] = [];
  for (const [args, expected] of [[[], false], [['--require-ok'], true]] as const) {
    const logs: string[] = [];
    assert.equal(await runDeploymentHealthcheckCli({
      arguments: args,
      environment: { API_PORT: '3000' },
      write: (line) => { logs.push(line); },
      check: async (_url, options) => { requested.push(options.requireOk); },
    }), DEPLOYMENT_HEALTHCHECK_EXIT_CODES.HEALTHY);
    assert.deepEqual(logs, []);
    assert.equal(requested.at(-1), expected);
  }

  for (const args of [['--unknown'], ['--require-ok', '--require-ok']] as const) {
    const logs: string[] = [];
    let calls = 0;
    assert.equal(await runDeploymentHealthcheckCli({
      arguments: args,
      environment: { API_PORT: '3000' },
      write: (line) => { logs.push(line); },
      check: async () => { calls += 1; },
    }), DEPLOYMENT_HEALTHCHECK_EXIT_CODES.CONFIGURATION_INVALID);
    assert.equal(calls, 0);
    assert.deepEqual(logs, [
      '{"event":"deployment.healthcheck","code":"HEALTHCHECK_ARGUMENTS_INVALID"}\n',
    ]);
  }
});

function healthResponse(status: 'OK' | 'DEGRADED', postgresql = 'AVAILABLE'): Response {
  return new Response(JSON.stringify({
    apiVersion: 'v1',
    meta: { generatedAt: '2026-08-11T00:00:00.000Z', nextCursor: null },
    data: { status, postgresql: { status: postgresql } },
  }));
}

function errorCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof DeploymentHealthcheckError && error.code === code;
}

function manualDeadline(): Readonly<{
  timers: { setTimeout: (callback: () => void, delayMs: number) => unknown; clearTimeout: () => void };
  fire: () => void;
}> {
  let callback: (() => void) | undefined;
  return {
    timers: {
      setTimeout: (next, delayMs) => { assert.equal(delayMs, 3_000); callback = next; return 1; },
      clearTimeout: () => undefined,
    },
    fire: () => { assert.ok(callback); callback(); },
  };
}

function fakeResponse(options: Readonly<{
  status?: number;
  contentLength?: string;
  read?: () => Promise<StreamReadResult>;
  cancel?: () => Promise<void>;
  cancelBody?: () => Promise<void>;
  releaseLock?: () => void;
}>): Response {
  const reader = {
    read: options.read ?? (async () => ({ done: true, value: undefined })),
    cancel: options.cancel ?? (async () => undefined),
    releaseLock: options.releaseLock ?? (() => undefined),
  } as ReadableStreamDefaultReader<Uint8Array>;
  const body = {
    getReader: () => reader,
    cancel: options.cancelBody ?? (async () => undefined),
  } as ReadableStream<Uint8Array>;
  return {
    status: options.status ?? 200,
    headers: new Headers(options.contentLength === undefined ? {} : { 'content-length': options.contentLength }),
    body,
  } as Response;
}

async function settlesPromptly(promise: Promise<void>): Promise<void> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        watchdog = setTimeout(() => { reject(new Error('Healthcheck remained pending after its deadline.')); }, 100);
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

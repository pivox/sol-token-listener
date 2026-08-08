import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RpcSoakTransportError,
  RpcSoakSubscriptionError,
  runRpcSoak,
  type RpcSoakObservation,
  type RpcSoakRuntime,
  type RpcSoakTransport,
} from '../src/solana/rpc/rpc-soak.js';

void test('rejects soak bounds and unsafe sample counts before touching transport', async () => {
  const transport = new FakeTransport([1n]);
  for (const options of [
    { durationMs: 4_999, intervalMs: 1_000 },
    { durationMs: 3_600_001, intervalMs: 1_000 },
    { durationMs: 5_000, intervalMs: 249 },
    { durationMs: 60_000, intervalMs: 60_001 },
    { durationMs: 5_000, intervalMs: 6_000 },
    { durationMs: 2_500_001, intervalMs: 250 },
    { durationMs: 5_000.5, intervalMs: 1_000 },
  ]) {
    await assert.rejects(runRpcSoak(transport, options, runtime()), TypeError);
  }
  assert.equal(transport.subscriptionAttempts, 0);
  assert.equal(transport.httpAttempts, 0);
});

void test('produces a frozen passing report with deterministic timing and percentiles', async () => {
  const clock = runtime(1_000);
  const transport = new FakeTransport([100n, 102n, 105n], [10, 20, 30], clock);
  transport.onHttpSample = (sample, observe) => {
    if (sample === 0) observe({ program: 'pumpfun', slot: 100n });
    if (sample === 1) observe({ program: 'pumpswap', slot: 102n });
  };

  const report = await runRpcSoak(
    transport,
    { durationMs: 5_000, intervalMs: 2_500 },
    clock,
  );

  assert.deepEqual(report, {
    schemaVersion: 'rpc-soak.v1',
    startedAtMs: 1_000,
    completedAtMs: 3_520,
    deadlineAtMs: 6_000,
    deadlineExceeded: false,
    configuredDurationMs: 5_000,
    intervalMs: 2_500,
    plannedSampleCount: 2,
    sampleCount: 2,
    http: {
      attempted: 2, succeeded: 2, failed: 0, rateLimited: 0,
      failuresByCode: {
        RPC_DEADLINE_EXCEEDED: 0, RPC_RATE_LIMITED: 0,
        RPC_REQUEST_FAILED: 0, RPC_RESPONSE_INVALID: 0,
      },
      latencyMs: { min: 10, p50: 10, p95: 20, max: 20 },
      firstSlot: '100', lastSlot: '102',
    },
    websocket: {
      subscriptionState: 'ESTABLISHED', healthState: 'HEALTHY', cleanupState: 'COMPLETED',
      observations: 2, pumpfunObservations: 1, pumpswapObservations: 1,
      firstSlot: '100', lastSlot: '102',
    },
    verdict: 'PASS',
    reasonCodes: [],
  });
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.http));
  assert.ok(Object.isFrozen(report.http.latencyMs));
  assert.ok(Object.isFrozen(report.websocket));
  assert.ok(Object.isFrozen(report.reasonCodes));
  assert.equal(transport.closeAttempts, 1);
});

void test('reports rate limiting, partial failure, stalled slots and missing program evidence', async () => {
  const clock = runtime();
  const transport = new FakeTransport([
    200n,
    new RpcSoakTransportError('RPC_RATE_LIMITED'),
    200n,
  ], [5, 7, 9], clock);
  transport.onHttpSample = (_sample, observe) => { observe({ program: 'pumpfun', slot: 200n }); };

  const report = await runRpcSoak(
    transport,
    { durationMs: 5_000, intervalMs: 2_000 },
    clock,
  );

  assert.equal(report.verdict, 'DEGRADED');
  assert.deepEqual(report.reasonCodes, [
    'HTTP_PARTIAL_FAILURE',
    'HTTP_RATE_LIMITED',
    'HTTP_SLOT_STALLED',
    'WS_PUMPSWAP_UNOBSERVED',
  ]);
  assert.deepEqual(report.http, {
    attempted: 3, succeeded: 2, failed: 1, rateLimited: 1,
    failuresByCode: {
      RPC_DEADLINE_EXCEEDED: 0, RPC_RATE_LIMITED: 1,
      RPC_REQUEST_FAILED: 0, RPC_RESPONSE_INVALID: 0,
    },
    latencyMs: { min: 5, p50: 5, p95: 9, max: 9 },
    firstSlot: '200', lastSlot: '200',
  });
});

void test('fails with fixed reasons when subscriptions, HTTP and cleanup are unavailable', async () => {
  const noNetwork = new FakeTransport([
    new Error('private endpoint'),
    new RpcSoakTransportError('RPC_RESPONSE_INVALID'),
  ]);
  noNetwork.subscribeFailure = new Error('private websocket endpoint');
  const unavailable = await runRpcSoak(
    noNetwork,
    { durationMs: 5_000, intervalMs: 2_500 },
    runtime(),
  );
  assert.equal(unavailable.verdict, 'FAIL');
  assert.deepEqual(unavailable.reasonCodes, ['HTTP_UNAVAILABLE', 'WS_SUBSCRIBE_FAILED']);
  assert.doesNotMatch(JSON.stringify(unavailable), /private|endpoint/u);

  const cleanup = new FakeTransport([1n, 2n]);
  cleanup.closeFailure = new Error('private cleanup');
  cleanup.onHttpSample = (_sample, observe) => {
    observe({ program: 'pumpfun', slot: 1n });
    observe({ program: 'pumpswap', slot: 1n });
  };
  const cleanupReport = await runRpcSoak(
    cleanup,
    { durationMs: 5_000, intervalMs: 2_500 },
    runtime(),
  );
  assert.equal(cleanupReport.verdict, 'FAIL');
  assert.ok(cleanupReport.reasonCodes.includes('WS_CLEANUP_FAILED'));
  assert.doesNotMatch(JSON.stringify(cleanupReport), /private/u);

  const partialCleanup = new FakeTransport([1n, 2n]);
  partialCleanup.subscribeFailure = new RpcSoakSubscriptionError(true);
  const partialCleanupReport = await runRpcSoak(
    partialCleanup,
    { durationMs: 5_000, intervalMs: 2_500 },
    runtime(),
  );
  assert.equal(partialCleanupReport.websocket.cleanupState, 'FAILED');
  assert.ok(partialCleanupReport.reasonCodes.includes('WS_CLEANUP_FAILED'));
});

void test('fails if an acknowledged WebSocket becomes unhealthy during the soak', async () => {
  const transport = new FakeTransport([1n, 2n]);
  transport.onHttpSample = (_sample, observe) => {
    observe({ program: 'pumpfun', slot: 1n });
    observe({ program: 'pumpswap', slot: 1n });
    transport.websocketHealthy = false;
  };

  const report = await runRpcSoak(
    transport,
    { durationMs: 5_000, intervalMs: 2_500 },
    runtime(),
  );

  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.websocket.healthState, 'FAILED');
  assert.ok(report.reasonCodes.includes('WS_CONNECTION_LOST'));
});

void test('aborts a hung RPC at the wall-clock deadline and still attempts cleanup', async () => {
  const clock = deadlineRuntime(10_000, 2);
  const transport = new FakeTransport([1n], [], clock);
  transport.hangHttp = true;

  const report = await runRpcSoak(
    transport,
    { durationMs: 5_000, intervalMs: 2_500 },
    clock,
  );

  assert.equal(report.deadlineAtMs, 15_000);
  assert.equal(report.completedAtMs, 15_000);
  assert.equal(report.deadlineExceeded, true);
  assert.equal(report.verdict, 'FAIL');
  assert.ok(report.reasonCodes.includes('SOAK_DEADLINE_EXCEEDED'));
  assert.equal(report.http.failuresByCode.RPC_DEADLINE_EXCEEDED, 1);
  assert.equal(transport.httpAborted, true);
  assert.equal(transport.closeAttempts, 1);
});

class FakeTransport implements RpcSoakTransport {
  public subscriptionAttempts = 0;
  public httpAttempts = 0;
  public closeAttempts = 0;
  public subscribeFailure: Error | null = null;
  public closeFailure: Error | null = null;
  public websocketHealthy = true;
  public hangHttp = false;
  public httpAborted = false;
  public onHttpSample: ((sample: number, observe: (value: RpcSoakObservation) => void) => void)
    | null = null;
  private observer: ((value: RpcSoakObservation) => void) | null = null;

  public constructor(
    private readonly samples: readonly (bigint | Error)[],
    private readonly latencies: readonly number[] = [],
    private readonly clock: RpcSoakRuntime & { readonly advance?: (milliseconds: number) => void } = runtime(),
  ) {}

  public async subscribe(observe: (value: RpcSoakObservation) => void, _signal: AbortSignal): Promise<{
    readonly close: (_closeSignal: AbortSignal) => Promise<void>;
    readonly health: () => 'HEALTHY' | 'FAILED';
  }> {
    this.subscriptionAttempts += 1;
    if (this.subscribeFailure !== null) throw this.subscribeFailure;
    this.observer = observe;
    return {
      close: async (_closeSignal) => {
        this.closeAttempts += 1;
        if (this.closeFailure !== null) throw this.closeFailure;
      },
      health: () => this.websocketHealthy ? 'HEALTHY' : 'FAILED',
    };
  }

  public async sampleHttpSlot(signal: AbortSignal): Promise<bigint> {
    const sample = this.httpAttempts;
    this.httpAttempts += 1;
    if (this.hangHttp) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          this.httpAborted = true;
          reject(new Error('private hung endpoint'));
        }, { once: true });
      });
    }
    this.clock.advance?.(this.latencies[sample] ?? 0);
    if (this.observer !== null) this.onHttpSample?.(sample, this.observer);
    const value = this.samples[sample];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error('missing fake sample');
    return value;
  }
}

function runtime(initialMs = 0): RpcSoakRuntime & { readonly advance: (milliseconds: number) => void } {
  let current = initialMs;
  return {
    now: () => current,
    wait: async (milliseconds) => { current += milliseconds; },
    runUntil: async (_deadlineMs, operation) => operation(new AbortController().signal),
    advance: (milliseconds) => { current += milliseconds; },
  };
}

function deadlineRuntime(
  initialMs: number,
  abortOnOperation: number,
): RpcSoakRuntime & { readonly advance: (milliseconds: number) => void } {
  let current = initialMs;
  let operationCount = 0;
  return {
    now: () => current,
    wait: async (milliseconds) => { current += milliseconds; },
    advance: (milliseconds) => { current += milliseconds; },
    runUntil: async (deadlineMs, operation) => {
      operationCount += 1;
      const controller = new AbortController();
      const result = operation(controller.signal);
      if (operationCount === abortOnOperation || current >= deadlineMs) {
        current = deadlineMs;
        controller.abort();
      }
      return result;
    },
  };
}

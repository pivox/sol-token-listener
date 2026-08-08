export const RPC_SOAK_SCHEMA_VERSION = 'rpc-soak.v1' as const;
export const RPC_SOAK_MIN_DURATION_MS = 5_000;
export const RPC_SOAK_MAX_DURATION_MS = 3_600_000;
export const RPC_SOAK_MIN_INTERVAL_MS = 250;
export const RPC_SOAK_MAX_INTERVAL_MS = 60_000;
export const RPC_SOAK_MAX_SAMPLES = 10_000;

export type RpcSoakProgram = 'pumpfun' | 'pumpswap';
export type RpcSoakFailureCode =
  | 'RPC_RATE_LIMITED'
  | 'RPC_REQUEST_FAILED'
  | 'RPC_RESPONSE_INVALID';
export type RpcSoakReasonCode =
  | 'HTTP_UNAVAILABLE'
  | 'HTTP_PARTIAL_FAILURE'
  | 'HTTP_RATE_LIMITED'
  | 'HTTP_SLOT_STALLED'
  | 'WS_SUBSCRIBE_FAILED'
  | 'WS_CLEANUP_FAILED'
  | 'WS_PUMPFUN_UNOBSERVED'
  | 'WS_PUMPSWAP_UNOBSERVED';

export interface RpcSoakObservation {
  readonly program: RpcSoakProgram;
  readonly slot: bigint;
}

export interface RpcSoakSubscription {
  close(): Promise<void>;
}

export interface RpcSoakTransport {
  subscribe(observe: (value: RpcSoakObservation) => void): Promise<RpcSoakSubscription>;
  sampleHttpSlot(): Promise<bigint>;
}

export interface RpcSoakRuntime {
  now(): number;
  wait(milliseconds: number): Promise<void>;
}

export interface RpcSoakOptions {
  readonly durationMs: number;
  readonly intervalMs: number;
}

export interface RpcSoakReport {
  readonly schemaVersion: typeof RPC_SOAK_SCHEMA_VERSION;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly configuredDurationMs: number;
  readonly intervalMs: number;
  readonly sampleCount: number;
  readonly http: Readonly<{
    attempted: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
    failuresByCode: Readonly<Record<RpcSoakFailureCode, number>>;
    latencyMs: Readonly<{ min: number; p50: number; p95: number; max: number }> | null;
    firstSlot: string | null;
    lastSlot: string | null;
  }>;
  readonly websocket: Readonly<{
    subscriptionState: 'ESTABLISHED' | 'FAILED';
    cleanupState: 'COMPLETED' | 'FAILED' | 'NOT_REQUIRED';
    observations: number;
    pumpfunObservations: number;
    pumpswapObservations: number;
    firstSlot: string | null;
    lastSlot: string | null;
  }>;
  readonly verdict: 'PASS' | 'DEGRADED' | 'FAIL';
  readonly reasonCodes: readonly RpcSoakReasonCode[];
}

export class RpcSoakTransportError extends Error {
  public constructor(public readonly code: RpcSoakFailureCode) {
    super('RPC soak transport operation failed.');
    this.name = 'RpcSoakTransportError';
    Object.freeze(this);
  }
}

const defaultRuntime: RpcSoakRuntime = Object.freeze({
  now: Date.now,
  wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
  },
});

export async function runRpcSoak(
  transport: RpcSoakTransport,
  options: RpcSoakOptions,
  runtime: RpcSoakRuntime = defaultRuntime,
): Promise<RpcSoakReport> {
  const sampleCount = validateOptions(options);
  const startedAtMs = readClock(runtime, null);
  const httpSlots: bigint[] = [];
  const latencies: number[] = [];
  const failuresByCode: Record<RpcSoakFailureCode, number> = {
    RPC_RATE_LIMITED: 0,
    RPC_REQUEST_FAILED: 0,
    RPC_RESPONSE_INVALID: 0,
  };
  const observations = { pumpfun: 0, pumpswap: 0, firstSlot: null, lastSlot: null } as {
    pumpfun: number;
    pumpswap: number;
    firstSlot: bigint | null;
    lastSlot: bigint | null;
  };

  let subscription: RpcSoakSubscription | null = null;
  let subscriptionState: 'ESTABLISHED' | 'FAILED' = 'FAILED';
  try {
    subscription = await transport.subscribe((value) => { recordObservation(observations, value); });
    if (typeof subscription.close !== 'function') throw new TypeError('RPC soak subscription is invalid.');
    subscriptionState = 'ESTABLISHED';
  } catch {
    subscription = null;
  }

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const sampleStartedAtMs = readClock(runtime, startedAtMs);
    try {
      const slot = await transport.sampleHttpSlot();
      if (typeof slot !== 'bigint' || slot < 0n) {
        throw new RpcSoakTransportError('RPC_RESPONSE_INVALID');
      }
      const sampleCompletedAtMs = readClock(runtime, sampleStartedAtMs);
      latencies.push(sampleCompletedAtMs - sampleStartedAtMs);
      httpSlots.push(slot);
    } catch (error) {
      const code = error instanceof RpcSoakTransportError
        ? error.code
        : 'RPC_REQUEST_FAILED';
      failuresByCode[code] += 1;
    }
    if (sample + 1 < sampleCount) await runtime.wait(options.intervalMs);
  }

  let cleanupState: 'COMPLETED' | 'FAILED' | 'NOT_REQUIRED' = 'NOT_REQUIRED';
  if (subscription !== null) {
    try {
      await subscription.close();
      cleanupState = 'COMPLETED';
    } catch {
      cleanupState = 'FAILED';
    }
  }
  const completedAtMs = readClock(runtime, startedAtMs);
  const reasonCodes = reasons(
    sampleCount,
    httpSlots,
    failuresByCode,
    subscriptionState,
    cleanupState,
    observations,
  );
  const failed = reasonCodes.includes('HTTP_UNAVAILABLE')
    || reasonCodes.includes('WS_SUBSCRIBE_FAILED')
    || reasonCodes.includes('WS_CLEANUP_FAILED');
  const verdict = failed ? 'FAIL' : reasonCodes.length > 0 ? 'DEGRADED' : 'PASS';
  const failedSamples = Object.values(failuresByCode)
    .reduce((total, value) => total + value, 0);

  return Object.freeze({
    schemaVersion: RPC_SOAK_SCHEMA_VERSION,
    startedAtMs,
    completedAtMs,
    configuredDurationMs: options.durationMs,
    intervalMs: options.intervalMs,
    sampleCount,
    http: Object.freeze({
      attempted: sampleCount,
      succeeded: httpSlots.length,
      failed: failedSamples,
      rateLimited: failuresByCode.RPC_RATE_LIMITED,
      failuresByCode: Object.freeze({ ...failuresByCode }),
      latencyMs: latencySummary(latencies),
      firstSlot: decimalSlot(httpSlots[0]),
      lastSlot: decimalSlot(httpSlots.at(-1)),
    }),
    websocket: Object.freeze({
      subscriptionState,
      cleanupState,
      observations: observations.pumpfun + observations.pumpswap,
      pumpfunObservations: observations.pumpfun,
      pumpswapObservations: observations.pumpswap,
      firstSlot: decimalSlot(observations.firstSlot),
      lastSlot: decimalSlot(observations.lastSlot),
    }),
    verdict,
    reasonCodes: Object.freeze(reasonCodes),
  });
}

function validateOptions(options: RpcSoakOptions): number {
  integerInRange(
    options.durationMs,
    RPC_SOAK_MIN_DURATION_MS,
    RPC_SOAK_MAX_DURATION_MS,
    'RPC soak duration',
  );
  integerInRange(
    options.intervalMs,
    RPC_SOAK_MIN_INTERVAL_MS,
    RPC_SOAK_MAX_INTERVAL_MS,
    'RPC soak interval',
  );
  const sampleCount = Math.floor(options.durationMs / options.intervalMs) + 1;
  if (sampleCount < 2 || sampleCount > RPC_SOAK_MAX_SAMPLES) {
    throw new TypeError('RPC soak sample count is invalid.');
  }
  return sampleCount;
}

function integerInRange(value: number, minimum: number, maximum: number, field: string): void {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) {
    throw new TypeError(`${field} is invalid.`);
  }
}

function readClock(runtime: RpcSoakRuntime, minimum: number | null): number {
  const value = runtime.now();
  if (!Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < 0
    || (minimum !== null && value < minimum)) {
    throw new TypeError('RPC soak clock is invalid.');
  }
  return value;
}

function recordObservation(
  target: { pumpfun: number; pumpswap: number; firstSlot: bigint | null; lastSlot: bigint | null },
  value: RpcSoakObservation,
): void {
  if (typeof value.slot !== 'bigint'
    || value.slot < 0n) return;
  target[value.program] += 1;
  target.firstSlot ??= value.slot;
  target.lastSlot = value.slot;
}

function reasons(
  sampleCount: number,
  slots: readonly bigint[],
  failures: Readonly<Record<RpcSoakFailureCode, number>>,
  subscription: 'ESTABLISHED' | 'FAILED',
  cleanup: 'COMPLETED' | 'FAILED' | 'NOT_REQUIRED',
  observations: { readonly pumpfun: number; readonly pumpswap: number },
): RpcSoakReasonCode[] {
  const values: RpcSoakReasonCode[] = [];
  if (slots.length === 0) values.push('HTTP_UNAVAILABLE');
  else if (slots.length < sampleCount) values.push('HTTP_PARTIAL_FAILURE');
  if (failures.RPC_RATE_LIMITED > 0) values.push('HTTP_RATE_LIMITED');
  if (slots.length >= 2 && (slots.at(-1) ?? 0n) <= (slots[0] ?? 0n)) {
    values.push('HTTP_SLOT_STALLED');
  }
  if (subscription === 'FAILED') values.push('WS_SUBSCRIBE_FAILED');
  if (cleanup === 'FAILED') values.push('WS_CLEANUP_FAILED');
  if (subscription === 'ESTABLISHED') {
    if (observations.pumpfun === 0) values.push('WS_PUMPFUN_UNOBSERVED');
    if (observations.pumpswap === 0) values.push('WS_PUMPSWAP_UNOBSERVED');
  }
  return values;
}

function latencySummary(values: readonly number[]): Readonly<{
  min: number;
  p50: number;
  p95: number;
  max: number;
}> | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Object.freeze({
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1) ?? 0,
  });
}

function percentile(sorted: readonly number[], percentage: number): number {
  const rank = Math.max(1, Math.ceil(percentage * sorted.length / 100));
  return sorted[rank - 1] ?? 0;
}

function decimalSlot(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

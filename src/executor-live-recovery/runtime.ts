import type {
  LiveRecoveryDeferredResult,
  LiveRecoveryLaneResult,
  LiveRecoveryLanes,
  LiveRecoveryRetryableRpcErrorCode,
} from './lanes.js';
import type {
  LiveRecoveryLogContext,
  LiveRecoveryLaneName,
  LiveRecoveryLogger,
} from './logger.js';

export interface LiveRecoveryPassResultV1 {
  readonly payloadVersion: 1;
  readonly workedLane: LiveRecoveryLaneName | null;
  readonly deferredLanes: readonly LiveRecoveryDeferredLaneResultV1[];
}

export interface LiveRecoveryDeferredLaneResultV1 {
  readonly lane: LiveRecoveryLaneName;
  readonly errorCode: LiveRecoveryRetryableRpcErrorCode | null;
}

export interface LiveRecoveryRuntimeScheduler {
  readonly setTimeout: (callback: () => void, delayMs: number) => object | number;
  readonly clearTimeout: (handle: object | number) => void;
}

export interface LiveRecoveryRuntimeSignalSource {
  readonly on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
  readonly off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
}

export interface LiveRecoveryRuntimeDependencies {
  readonly createLanes: () => LiveRecoveryLanes;
  readonly logger: LiveRecoveryLogger;
  readonly closeDatabase: () => Promise<void>;
  readonly evictDatabase: () => void | Promise<void>;
  readonly forceExit: (code: 1) => void;
}

export interface LiveRecoveryRuntimeOptions {
  readonly pollMs: number;
  readonly shutdownGraceMs: number;
  readonly scheduler?: LiveRecoveryRuntimeScheduler;
  readonly signalSource?: LiveRecoveryRuntimeSignalSource;
}

const ORDERED_LANES = Object.freeze([
  ['reconciliation', 'RECONCILIATION'],
  ['confirmation', 'CONFIRMATION'],
  ['deadline', 'DEADLINE'],
] as const);
const SAFE_ERROR_CODES = new Set([
  'OPERATION_ABORTED', 'CLAIM_FAILED', 'READ_MODEL_FAILED', 'PROVIDER_MISMATCH',
  'GATEWAY_FAILED', 'LEASE_LOST', 'INVALID_EVIDENCE', 'COMMIT_FAILED',
  'RELEASE_FAILED', 'DEADLINE_FAILED', 'INVALID_INPUT', 'INVALID_DATA',
  'DATABASE_FAILURE', 'INTENT_LEASE_LOST', 'RPC_RATE_LIMITED', 'RPC_TIMEOUT',
  'RPC_UNAVAILABLE', 'RPC_RESPONSE_TOO_LARGE', 'RPC_RESPONSE_INVALID',
  'GENESIS_MISMATCH', 'CALL_BUDGET_EXCEEDED', 'SESSION_FAILED',
]);
const RETRYABLE_RPC_ERROR_CODES = new Set<LiveRecoveryRetryableRpcErrorCode>([
  'RPC_RATE_LIMITED', 'RPC_TIMEOUT', 'RPC_UNAVAILABLE', 'RPC_RESPONSE_TOO_LARGE',
  'RPC_RESPONSE_INVALID', 'CALL_BUDGET_EXCEEDED', 'SESSION_FAILED',
]);
const productionScheduler: LiveRecoveryRuntimeScheduler = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: object | number) => { clearTimeout(handle as NodeJS.Timeout); },
});

export async function runLiveRecoveryPass(
  lanes: LiveRecoveryLanes,
  signal: AbortSignal,
): Promise<LiveRecoveryPassResultV1> {
  requireSignal(signal);
  const deferred: LiveRecoveryDeferredLaneResultV1[] = [];
  for (const [key, lane] of ORDERED_LANES) {
    if (signal.aborted) break;
    let result: LiveRecoveryLaneResult;
    try {
      result = laneResult(await lanes[key](signal));
    } catch (error) {
      throw new LiveRecoveryPassError(lane, safeErrorCode(error));
    }
    if (typeof result === 'object') {
      deferred.push(Object.freeze({ lane, errorCode: result.errorCode }));
    }
    if (result === 'WORKED') return passResult(lane, deferred);
  }
  return passResult(null, deferred);
}

export function runLiveRecoveryRuntime(
  dependencies: LiveRecoveryRuntimeDependencies,
  options: LiveRecoveryRuntimeOptions,
): Promise<void> {
  assertDuration(options.pollMs);
  assertDuration(options.shutdownGraceMs);
  const scheduler = options.scheduler ?? productionScheduler;
  const signals = options.signalSource ?? process;
  const controller = new AbortController();
  let stopping = false;
  let pollTimer: object | number | null = null;
  let cancelPoll: (() => void) | null = null;
  let deadlineTimer: object | number | null = null;
  const forced = deferred<undefined>();
  const shutdownRequested = (): boolean => stopping;

  const removeSignals = (): void => {
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
  };
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    dependencies.logger.info(context({ event: 'executor_live_recovery.stopping' }));
    controller.abort();
    removeSignals();
    cancelPoll?.();
    deadlineTimer = scheduler.setTimeout(() => {
      deadlineTimer = null;
      void forceShutdown(dependencies).finally(() => { forced.resolve(undefined); });
    }, options.shutdownGraceMs);
  };
  const onSigint = (): void => { stop(); };
  const onSigterm = (): void => { stop(); };
  signals.on('SIGINT', onSigint);
  signals.on('SIGTERM', onSigterm);
  dependencies.logger.info(context({ event: 'executor_live_recovery.started' }));

  const loop = async (): Promise<void> => {
    while (!shutdownRequested()) {
      try {
        const result = await runLiveRecoveryPass(dependencies.createLanes(), controller.signal);
        logPassResult(dependencies.logger, result);
      } catch (error) {
        if (error instanceof LiveRecoveryPassError
          && !(shutdownRequested() && error.errorCode === 'OPERATION_ABORTED')) {
          dependencies.logger.error(context({
            event: 'executor_live_recovery.lane_failed',
            lane: error.lane,
            errorCode: error.errorCode,
          }));
        } else if (!(error instanceof LiveRecoveryPassError)) {
          dependencies.logger.error(context({
            event: 'executor_live_recovery.lane_failed',
            errorCode: 'LIVE_RECOVERY_PASS_FAILED',
          }));
        }
      }
      if (shutdownRequested()) break;
      await new Promise<void>((resolve) => {
        let settled = false;
        const complete = (): void => {
          if (settled) return;
          settled = true;
          pollTimer = null;
          cancelPoll = null;
          resolve();
        };
        cancelPoll = (): void => {
          if (pollTimer !== null) scheduler.clearTimeout(pollTimer);
          complete();
        };
        pollTimer = scheduler.setTimeout(complete, options.pollMs);
      });
    }
  };

  const clean = async (): Promise<void> => {
    await loop();
    await dependencies.closeDatabase();
    dependencies.logger.info(context({ event: 'executor_live_recovery.stopped' }));
  };

  return Promise.race([
    clean().finally(() => {
      if (deadlineTimer !== null) {
        scheduler.clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      removeSignals();
    }),
    forced.promise,
  ]);
}

class LiveRecoveryPassError extends Error {
  public constructor(
    public readonly lane: LiveRecoveryLaneName,
    public readonly errorCode: string,
  ) {
    super('Live recovery pass failed.');
    this.name = 'LiveRecoveryPassError';
  }
}

function logPassResult(logger: LiveRecoveryLogger, result: LiveRecoveryPassResultV1): void {
  for (const deferred of result.deferredLanes) {
    logger.warn(context(deferred.errorCode === null
      ? { event: 'executor_live_recovery.lane_completed', lane: deferred.lane, result: 'DEFERRED' }
      : {
        event: 'executor_live_recovery.lane_completed', lane: deferred.lane,
        result: 'DEFERRED', errorCode: deferred.errorCode,
      }));
  }
  if (result.workedLane !== null) {
    logger.info(context({
      event: 'executor_live_recovery.lane_completed',
      lane: result.workedLane,
      result: 'WORKED',
    }));
  }
}

async function forceShutdown(dependencies: LiveRecoveryRuntimeDependencies): Promise<void> {
  try { await dependencies.evictDatabase(); } catch { /* Forced exit remains authoritative. */ }
  dependencies.logger.error(context({
    event: 'executor_live_recovery.shutdown_forced',
    errorCode: 'SHUTDOWN_DEADLINE',
  }));
  dependencies.forceExit(1);
}

function context(
  input: Omit<LiveRecoveryLogContext, 'executionMode'>,
): LiveRecoveryLogContext {
  return Object.freeze({ ...input, executionMode: 'live-recovery' });
}

function passResult(
  workedLane: LiveRecoveryLaneName | null,
  deferredLanes: readonly LiveRecoveryDeferredLaneResultV1[],
): LiveRecoveryPassResultV1 {
  return Object.freeze({
    payloadVersion: 1,
    workedLane,
    deferredLanes: Object.freeze([...deferredLanes]),
  });
}

function safeErrorCode(error: unknown): string {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return 'LIVE_RECOVERY_PASS_FAILED';
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (descriptor === undefined || !('value' in descriptor)
      || typeof descriptor.value !== 'string' || !SAFE_ERROR_CODES.has(descriptor.value)) {
      return 'LIVE_RECOVERY_PASS_FAILED';
    }
    return descriptor.value;
  } catch {
    return 'LIVE_RECOVERY_PASS_FAILED';
  }
}

function laneResult(value: unknown): LiveRecoveryLaneResult {
  if (value === 'IDLE' || value === 'WORKED') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid live recovery lane result.');
  }
  try {
    if (!Object.isFrozen(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError('Invalid live recovery lane result.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('result') || !keys.includes('errorCode')) {
      throw new TypeError('Invalid live recovery lane result.');
    }
    const result = Object.getOwnPropertyDescriptor(value, 'result');
    const errorCode = Object.getOwnPropertyDescriptor(value, 'errorCode');
    if (result === undefined || errorCode === undefined
      || !result.enumerable || !errorCode.enumerable
      || !('value' in result) || !('value' in errorCode)
      || result.value !== 'DEFERRED'
      || (errorCode.value !== null
        && !isRetryableRpcErrorCode(errorCode.value))) {
      throw new TypeError('Invalid live recovery lane result.');
    }
    return value as LiveRecoveryDeferredResult;
  } catch {
    throw new TypeError('Invalid live recovery lane result.');
  }
}

function isRetryableRpcErrorCode(value: unknown): value is LiveRecoveryRetryableRpcErrorCode {
  return typeof value === 'string' && RETRYABLE_RPC_ERROR_CODES.has(
    value as LiveRecoveryRetryableRpcErrorCode,
  );
}

function requireSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) throw new TypeError('Invalid live recovery signal.');
}

function assertDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Invalid live recovery runtime duration.');
  }
}

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
}> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return Object.freeze({ promise, resolve });
}

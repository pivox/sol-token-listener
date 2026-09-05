export type LiveExecutorLaneResult = 'IDLE' | 'WORKED';
export type LiveExecutorPassResult =
  | 'IDLE'
  | 'RECOVER_SELL'
  | 'SELL'
  | 'RECOVER_BUY'
  | 'BUY';

export type LiveExecutorLane = (
  signal: AbortSignal,
) => Promise<LiveExecutorLaneResult>;

import type { LiveExecutorLaneName, LiveExecutorLogger } from './logger.js';
import { LIVE_EXECUTOR_SAFE_ERROR_CODE_SET } from './error-codes.js';

export interface LiveExecutorLanes {
  readonly recoverSell: LiveExecutorLane;
  readonly sell: LiveExecutorLane;
  readonly recoverBuy: LiveExecutorLane;
  readonly buy: LiveExecutorLane;
}

export interface LiveExecutorRuntimeScheduler {
  readonly setTimeout: (callback: () => void, delayMs: number) => object | number;
  readonly clearTimeout: (handle: object | number) => void;
}

export interface LiveExecutorRuntimeSignalSource {
  readonly on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
  readonly off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
}

export interface LiveExecutorRuntimeDependencies {
  readonly lanes: LiveExecutorLanes;
  readonly prePass: (signal: AbortSignal) => Promise<void>;
  readonly logger?: LiveExecutorLogger;
  readonly closeSigner: () => Promise<void>;
  readonly closeDatabase: () => Promise<void>;
  readonly evictDatabase: () => void | Promise<void>;
  readonly forceExit: (code: 1) => void;
}

export interface LiveExecutorRuntimeOptions {
  readonly pollMs: number;
  readonly shutdownGraceMs: number;
  readonly scheduler?: LiveExecutorRuntimeScheduler;
  readonly signalSource?: LiveExecutorRuntimeSignalSource;
}

const productionScheduler: LiveExecutorRuntimeScheduler = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: object | number) => { clearTimeout(handle as NodeJS.Timeout); },
});

const ORDERED_LANES = Object.freeze([
  ['recoverSell', 'RECOVER_SELL'],
  ['sell', 'SELL'],
  ['recoverBuy', 'RECOVER_BUY'],
  ['buy', 'BUY'],
] as const);

export async function runLiveExecutorPass(
  lanes: LiveExecutorLanes,
  signal: AbortSignal,
  prePass: (signal: AbortSignal) => Promise<void>,
): Promise<LiveExecutorPassResult> {
  requireSignal(signal);
  try {
    await prePass(signal);
  } catch (error) {
    throw new LiveExecutorPrePassError(safeErrorCode(error));
  }
  for (const [key, result] of ORDERED_LANES) {
    if (signal.aborted) return 'IDLE';
    let laneResult: LiveExecutorLaneResult;
    try {
      laneResult = await lanes[key](signal);
    } catch (error) {
      throw new LiveExecutorPassError(result, safeErrorCode(error));
    }
    if (laneResult === 'WORKED') return result;
  }
  return 'IDLE';
}

export function runLiveExecutorRuntime(
  dependencies: LiveExecutorRuntimeDependencies,
  options: LiveExecutorRuntimeOptions,
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
  let signerClosing: Promise<void> | null = null;
  const forced = deferred<undefined>();
  const shutdownRequested = (): boolean => stopping;

  const removeSignals = (): void => {
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
  };
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    removeSignals();
    cancelPoll?.();
    signerClosing = Promise.resolve().then(dependencies.closeSigner);
    void signerClosing.catch(() => undefined);
    deadlineTimer = scheduler.setTimeout(() => {
      deadlineTimer = null;
      void forceShutdown(dependencies).finally(() => { forced.resolve(undefined); });
    }, options.shutdownGraceMs);
  };
  const onSigint = (): void => { stop(); };
  const onSigterm = (): void => { stop(); };
  signals.on('SIGINT', onSigint);
  signals.on('SIGTERM', onSigterm);

  const loop = async (): Promise<void> => {
    while (!shutdownRequested()) {
      try {
        await runLiveExecutorPass(dependencies.lanes, controller.signal, dependencies.prePass);
      } catch (error) {
        if (shutdownRequested()) break;
        if (error instanceof LiveExecutorPassError) {
          dependencies.logger?.error(Object.freeze({
            event: 'executor_live.lane_failed', lane: error.lane, errorCode: error.errorCode,
          }));
        } else if (error instanceof LiveExecutorPrePassError) {
          dependencies.logger?.error(Object.freeze({
            event: 'executor_live.prepass_failed', errorCode: error.errorCode,
          }));
        } else {
          dependencies.logger?.error(Object.freeze({
            event: 'executor_live.lane_failed', errorCode: 'LIVE_EXECUTOR_PASS_FAILED',
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
    let signerFailure: unknown;
    try {
      if (signerClosing !== null) await signerClosing;
      else await dependencies.closeSigner();
    } catch (error) {
      signerFailure = error;
    }
    let databaseFailure: unknown;
    try { await dependencies.closeDatabase(); } catch (error) { databaseFailure = error; }
    if (signerFailure !== undefined && databaseFailure !== undefined) {
      throw new AggregateError(
        [signerFailure, databaseFailure],
        'Live executor shutdown failed.',
      );
    }
    if (signerFailure !== undefined) throw errorFrom(signerFailure);
    if (databaseFailure !== undefined) throw errorFrom(databaseFailure);
  };

  return Promise.race([
    clean().finally(() => {
      if (deadlineTimer !== null) scheduler.clearTimeout(deadlineTimer);
      removeSignals();
    }),
    forced.promise,
  ]);
}

class LiveExecutorPassError extends Error {
  public constructor(public readonly lane: LiveExecutorLaneName, public readonly errorCode: string) {
    super('Live executor pass failed.');
    this.name = 'LiveExecutorPassError';
  }
}

class LiveExecutorPrePassError extends Error {
  public constructor(public readonly errorCode: string) {
    super('Live executor pre-pass failed.');
    this.name = 'LiveExecutorPrePassError';
  }
}

function safeErrorCode(error: unknown): string {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return 'LIVE_EXECUTOR_PASS_FAILED';
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
      && LIVE_EXECUTOR_SAFE_ERROR_CODE_SET.has(descriptor.value)
      ? descriptor.value : 'LIVE_EXECUTOR_PASS_FAILED';
  } catch { return 'LIVE_EXECUTOR_PASS_FAILED'; }
}

async function forceShutdown(dependencies: LiveExecutorRuntimeDependencies): Promise<void> {
  try { await dependencies.evictDatabase(); } catch { /* Exit remains authoritative. */ }
  dependencies.forceExit(1);
}

function requireSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) throw new TypeError('Invalid live executor signal.');
}

function assertDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Invalid live executor runtime duration.');
  }
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error('Live executor shutdown failed.');
}

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
}> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return Object.freeze({ promise, resolve });
}

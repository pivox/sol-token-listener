export type LiveExecutorLaneResult = 'IDLE' | 'WORKED';
export type LiveExecutorPassResult =
  | 'IDLE'
  | 'RECONCILIATION'
  | 'CONFIRMATION'
  | 'SELL'
  | 'DEADLINE_SELL'
  | 'BUY';

export type LiveExecutorLane = (
  signal: AbortSignal,
) => Promise<LiveExecutorLaneResult>;

export interface LiveExecutorLanes {
  readonly reconciliation: LiveExecutorLane;
  readonly confirmation: LiveExecutorLane;
  readonly sell: LiveExecutorLane;
  readonly deadlineSell: LiveExecutorLane;
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
  ['reconciliation', 'RECONCILIATION'],
  ['confirmation', 'CONFIRMATION'],
  ['sell', 'SELL'],
  ['deadlineSell', 'DEADLINE_SELL'],
  ['buy', 'BUY'],
] as const);

export async function runLiveExecutorPass(
  lanes: LiveExecutorLanes,
  signal: AbortSignal,
): Promise<LiveExecutorPassResult> {
  requireSignal(signal);
  for (const [key, result] of ORDERED_LANES) {
    if (signal.aborted) return 'IDLE';
    const laneResult = await lanes[key](signal);
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
        await runLiveExecutorPass(dependencies.lanes, controller.signal);
      } catch {
        if (shutdownRequested()) break;
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

import type { DryRunPassResult } from './dry-run-worker.js';
import type { ExecutorLogger } from './logger.js';

export interface ExecutorRuntimeScheduler {
  readonly setTimeout: (callback: () => void, delayMs: number) => object | number;
  readonly clearTimeout: (handle: object | number) => void;
}

export interface ExecutorRuntimeSignalSource {
  readonly on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
  readonly off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
}

export interface ExecutorRuntimeDependencies {
  readonly runOnce: () => Promise<DryRunPassResult>;
  readonly logger: ExecutorLogger;
  readonly closeDatabase: () => Promise<void>;
  readonly evictDatabase: () => void | Promise<void>;
  readonly forceExit: (code: 1) => void;
}

export interface ExecutorRuntimeOptions {
  readonly pollMs: number;
  readonly shutdownGraceMs: number;
  readonly scheduler?: ExecutorRuntimeScheduler;
  readonly signalSource?: ExecutorRuntimeSignalSource;
}

const productionScheduler: ExecutorRuntimeScheduler = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: object | number) => { clearTimeout(handle as NodeJS.Timeout); },
});
const SAFE_PASS_ERROR_CODES = new Set([
  'EXECUTOR_DATABASE_BUSY', 'INVALID_INPUT', 'INVALID_DATA', 'DATABASE_FAILURE',
  'COMMIT_OUTCOME_UNKNOWN', 'INTENT_FENCE_LOST', 'ASSESSMENT_CONFLICT',
  'INTENT_DUPLICATE', 'INTENT_LEASE_LOST', 'ATTEMPT_EXHAUSTED', 'ATTEMPT_CONFLICT',
]);

export function runExecutorRuntime(
  dependencies: ExecutorRuntimeDependencies,
  options: ExecutorRuntimeOptions,
): Promise<void> {
  assertDuration(options.pollMs);
  assertDuration(options.shutdownGraceMs);
  const scheduler = options.scheduler ?? productionScheduler;
  const signals = options.signalSource ?? process;
  let stopping = false;
  let pollTimer: object | number | null = null;
  let cancelPoll: (() => void) | null = null;
  let deadlineTimer: object | number | null = null;
  let shutdownPrimary: Readonly<{ error: unknown }> | null = null;
  const forced = deferred<undefined>();
  const shutdownRequested = (): boolean => stopping;

  const removeSignalHandlers = (): void => {
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
  };
  const requestShutdown = (): void => {
    if (stopping) return;
    stopping = true;
    removeSignalHandlers();
    cancelPoll?.();
    deadlineTimer = scheduler.setTimeout(() => {
      deadlineTimer = null;
      void forceShutdown(dependencies).finally(() => { forced.resolve(undefined); });
    }, options.shutdownGraceMs);
  };
  const onSigint = (): void => { requestShutdown(); };
  const onSigterm = (): void => { requestShutdown(); };
  signals.on('SIGINT', onSigint);
  signals.on('SIGTERM', onSigterm);

  const runLoop = async (): Promise<void> => {
    while (!shutdownRequested()) {
      try {
        const result = await dependencies.runOnce();
        logPassResult(dependencies.logger, result);
      } catch (error) {
        dependencies.logger.error(Object.freeze({
          event: 'executor.pass_failed', errorCode: safeErrorCode(error),
        }));
        if (shutdownRequested()) shutdownPrimary = Object.freeze({ error });
      }
      if (shutdownRequested()) return;
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

  const cleanShutdown = async (): Promise<void> => {
    await runLoop();
    let closeFailure: Readonly<{ error: unknown }> | null = null;
    try { await dependencies.closeDatabase(); }
    catch (error) { closeFailure = Object.freeze({ error }); }
    if (shutdownPrimary !== null && closeFailure !== null) {
      throw new AggregateError(
        [shutdownPrimary.error, closeFailure.error],
        'Executor shutdown failed.',
      );
    }
    if (shutdownPrimary !== null) throw shutdownPrimary.error;
    if (closeFailure !== null) throw closeFailure.error;
  };

  return Promise.race([
    cleanShutdown().finally(() => {
      if (deadlineTimer !== null) {
        scheduler.clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      removeSignalHandlers();
    }),
    forced.promise,
  ]);
}

async function forceShutdown(dependencies: ExecutorRuntimeDependencies): Promise<void> {
  try { await dependencies.evictDatabase(); } catch { /* Forced exit remains authoritative. */ }
  dependencies.logger.error(Object.freeze({
    event: 'executor.shutdown_forced', errorCode: 'SHUTDOWN_DEADLINE',
  }));
  dependencies.forceExit(1);
}

function logPassResult(logger: ExecutorLogger, result: DryRunPassResult): void {
  if (result === 'RECORDED') {
    logger.info(Object.freeze({
      event: 'executor.assessment_recorded', mode: 'dry-run', outcome: 'FOUNDATION_VALIDATED',
    }));
  } else if (result === 'COMMIT_RECOVERED') {
    logger.info(Object.freeze({
      event: 'executor.assessment_recovered', mode: 'dry-run', outcome: 'FOUNDATION_VALIDATED',
    }));
  }
}

function safeErrorCode(error: unknown): string {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return 'EXECUTOR_PASS_FAILED';
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (descriptor === undefined || !('value' in descriptor)
      || typeof descriptor.value !== 'string'
      || !SAFE_PASS_ERROR_CODES.has(descriptor.value)) {
      return 'EXECUTOR_PASS_FAILED';
    }
    return descriptor.value;
  } catch {
    return 'EXECUTOR_PASS_FAILED';
  }
}

function assertDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Invalid executor runtime duration.');
}

function deferred<Value>(): Readonly<{ promise: Promise<Value>; resolve(value: Value): void }> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return Object.freeze({ promise, resolve });
}

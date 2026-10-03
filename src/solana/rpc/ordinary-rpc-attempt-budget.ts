import { performance } from 'node:perf_hooks';

// Fixed local experiment policy, not provider-wide capacity attestation.
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 1000;
const MAX_WAITERS = 64;
const trustedBudgetErrors = new WeakSet();

export interface OrdinaryRpcBudgetScheduler {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

interface Waiter {
  readonly start: () => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: () => void;
}

const DEFAULT_SCHEDULER: OrdinaryRpcBudgetScheduler = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export class OrdinaryRpcBudgetError extends Error {
  public constructor(public readonly code: 'RPC_ORDINARY_BUDGET_FULL' | 'RPC_ORDINARY_BUDGET_CLOSED') {
    super(code === 'RPC_ORDINARY_BUDGET_FULL'
      ? 'Ordinary RPC admission queue is full.' : 'Ordinary RPC admission is closed.');
    this.name = 'OrdinaryRpcBudgetError';
    trustedBudgetErrors.add(this);
    Object.freeze(this);
  }
}

export function isOrdinaryRpcBudgetError(value: unknown): value is OrdinaryRpcBudgetError {
  return typeof value === 'object' && value !== null && trustedBudgetErrors.has(value);
}

/** One listener runtime shares this budget across every physical HTTP RPC role. */
export class OrdinaryRpcAttemptBudget {
  private readonly starts: number[] = [];
  private readonly waiters: Waiter[] = [];
  private timer: unknown = undefined;
  private closed = false;

  public constructor(private readonly scheduler: OrdinaryRpcBudgetScheduler = DEFAULT_SCHEDULER) {}

  public run<T>(attempt: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new OrdinaryRpcBudgetError('RPC_ORDINARY_BUDGET_CLOSED'));
    if (signal?.aborted === true) return Promise.reject(abortError(signal));
    this.expire();
    if (this.waiters.length === 0 && this.starts.length < MAX_ATTEMPTS) {
      return this.start(attempt);
    }
    if (this.waiters.length >= MAX_WAITERS) {
      return Promise.reject(new OrdinaryRpcBudgetError('RPC_ORDINARY_BUDGET_FULL'));
    }
    return new Promise<T>((resolve, reject: (error: Error) => void) => {
      const waiter: Waiter = {
        start: () => { resolve(this.start(attempt)); }, reject, signal,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          signal?.removeEventListener('abort', waiter.abort);
          reject(abortError(signal));
          this.pump();
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.pump();
    });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelTimer();
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.reject(new OrdinaryRpcBudgetError('RPC_ORDINARY_BUDGET_CLOSED'));
    }
  }

  private start<T>(attempt: () => Promise<T>): Promise<T> {
    this.starts.push(this.scheduler.now());
    // Never await a permit: fetch and evidence start in the same admission turn.
    try {
      return Promise.resolve(attempt()).catch((error: unknown) => { throw attemptError(error); });
    } catch (error) {
      return Promise.reject(attemptError(error));
    }
  }

  private expire(): void {
    const cutoff = this.scheduler.now() - WINDOW_MS;
    while (this.starts[0] !== undefined && this.starts[0] <= cutoff) this.starts.shift();
  }

  private pump(): void {
    this.cancelTimer();
    if (this.closed) return;
    this.expire();
    while (this.waiters.length > 0 && this.starts.length < MAX_ATTEMPTS) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) break;
      waiter.signal?.removeEventListener('abort', waiter.abort);
      if (waiter.signal?.aborted === true) waiter.reject(abortError(waiter.signal));
      else waiter.start();
    }
    const oldest = this.starts[0];
    if (this.waiters.length === 0 || oldest === undefined) return;
    this.timer = this.scheduler.schedule(() => {
      this.timer = undefined;
      this.pump();
    }, Math.max(1, oldest + WINDOW_MS - this.scheduler.now()));
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.scheduler.cancel(this.timer);
    this.timer = undefined;
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  // web3.js only completes callbacks for Error instances; primitive reasons hang it.
  return signal?.reason instanceof Error
    ? signal.reason : new DOMException('Ordinary RPC admission aborted.', 'AbortError');
}

function attemptError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Ordinary RPC attempt failed.');
}

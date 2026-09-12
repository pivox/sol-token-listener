import type { StrictCatchUpScanResult } from './strict-catch-up-scanner.js';
import { StrictCatchUpAbortedError } from './strict-catch-up-scanner.js';
import { isProxy } from 'node:util/types';
import { assertValidStrictCatchUpRun } from '../domain/strict-catch-up-run.js';
import type { RpcProviderId } from '../domain/rpc-provider.js';
import type { ProcessingCheckpointKey } from '../domain/transaction-ingestion.js';
import type { StrictCatchUpRepository } from '../ports/strict-catch-up-repository.js';

export class StrictCatchUpAffinityReadError extends Error {
  public readonly retryable = true;
  public readonly stage = 'provider-affinity' as const;

  public constructor() {
    super('Strict catch-up provider affinity is unavailable.');
    this.name = 'StrictCatchUpAffinityReadError';
    Object.freeze(this);
  }
}

// eslint-disable-next-line @typescript-eslint/unbound-method
const PROMISE_THEN = Promise.prototype.then;

export interface StrictCatchUpScannerPort {
  scan(signal: AbortSignal): Promise<StrictCatchUpScanResult>;
}

export class StrictCatchUpCoordinator {
  private inFlight: Promise<StrictCatchUpScanResult> | null = null;
  private readonly checkpointKeys: readonly ProcessingCheckpointKey[];

  public constructor(
    private readonly scanner: StrictCatchUpScannerPort,
    private readonly repository: Pick<StrictCatchUpRepository, 'readActiveStrictCatchUpRun'>,
    checkpointKeys: readonly ProcessingCheckpointKey[],
  ) {
    this.checkpointKeys = snapshotCheckpointKeys(checkpointKeys);
  }

  public async readPinnedProviderId(signal?: AbortSignal): Promise<RpcProviderId | null> {
    let pinned: RpcProviderId | null = null;
    for (const key of this.checkpointKeys) {
      assertNotAborted(signal);
      try {
        const result = readActiveRun(this.repository, key);
        if (typeof result !== 'object' || result === null || isProxy(result)
          || !(result instanceof Promise) || Object.getPrototypeOf(result) !== Promise.prototype
          || Object.getOwnPropertyDescriptor(result, 'then') !== undefined) throw new TypeError();
        const run: unknown = await Reflect.apply(PROMISE_THEN, result, [(value: unknown): unknown => value]);
        if (run !== null) {
          assertValidStrictCatchUpRun(run);
          if (run.checkpointKey !== key || run.state !== 'ACTIVE'
            || (pinned !== null && pinned !== run.providerId)) throw new TypeError();
          pinned = run.providerId;
        }
      } catch {
        throw new StrictCatchUpAffinityReadError();
      } finally {
        assertNotAborted(signal);
      }
    }
    return pinned;
  }

  public run(signal: AbortSignal): Promise<StrictCatchUpScanResult> {
    if (this.inFlight !== null) return this.inFlight;

    const deferred = deferredStrictCatchUpScan();
    const run = deferred.promise;
    this.inFlight = run;
    void run.then(
      () => { this.clear(run); },
      () => { this.clear(run); },
    );
    try {
      deferred.resolve(this.scanner.scan(signal));
    } catch (error) {
      deferred.reject(error);
    }
    return run;
  }

  private clear(run: Promise<StrictCatchUpScanResult>): void {
    if (this.inFlight === run) this.inFlight = null;
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new StrictCatchUpAbortedError();
}

function readActiveRun(repository: object, key: ProcessingCheckpointKey): unknown {
  let cursor: object | null = repository;
  while (cursor !== null) {
    if (isProxy(cursor)) throw new TypeError();
    const descriptor = Object.getOwnPropertyDescriptor(cursor, 'readActiveStrictCatchUpRun');
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function'
        || isProxy(descriptor.value)) throw new TypeError();
      return Reflect.apply(descriptor.value as (key: ProcessingCheckpointKey) => unknown, repository, [key]);
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  throw new TypeError();
}

function snapshotCheckpointKeys(value: readonly ProcessingCheckpointKey[]): readonly ProcessingCheckpointKey[] {
  try {
    if (isProxy(value) || !Array.isArray(value)) throw new TypeError();
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown;
    if (length !== 1 && length !== 2) throw new TypeError();
    if (Reflect.ownKeys(value).length !== length + 1) throw new TypeError();
    const keys: ProcessingCheckpointKey[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)
        || (descriptor.value !== 'launchpad' && descriptor.value !== 'market')
        || keys.includes(descriptor.value as ProcessingCheckpointKey)) throw new TypeError();
      keys.push(descriptor.value as ProcessingCheckpointKey);
    }
    return Object.freeze(keys);
  } catch {
    throw new StrictCatchUpAffinityReadError();
  }
}

interface StrictCatchUpScanDeferred {
  readonly promise: Promise<StrictCatchUpScanResult>;
  readonly resolve: (value: StrictCatchUpScanResult | PromiseLike<StrictCatchUpScanResult>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferredStrictCatchUpScan(): StrictCatchUpScanDeferred {
  const unavailable = (): never => { throw new Error('Strict catch-up scan deferred is unavailable.'); };
  let resolve: StrictCatchUpScanDeferred['resolve'] = unavailable;
  let reject: StrictCatchUpScanDeferred['reject'] = unavailable;
  const promise = new Promise<StrictCatchUpScanResult>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return Object.freeze({ promise, resolve, reject });
}

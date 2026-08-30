import { Connection, type Commitment } from '@solana/web3.js';
import { canonicalSolanaGenesisHash } from '../../domain/solana-genesis-hash.js';
import type { RpcProviderId } from '../../domain/rpc-provider.js';
import type { CatchUpSource } from '../../ports/catch-up-source.js';
import {
  SolanaCatchUpSource,
  type SignaturesForAddressRpc,
} from './catch-up-source.js';
import type { RpcProviderCatalog } from './rpc-provider-catalog.js';

export type ProviderPinnedCatchUpSourceErrorReason =
  | 'CONFIG_INVALID'
  | 'GENESIS_UNAVAILABLE'
  | 'GENESIS_MISMATCH';

export interface ProviderPinnedCatchUpSource extends CatchUpSource {
  readonly providerId: RpcProviderId;
  verifyGenesis(signal?: AbortSignal): Promise<void>;
}

interface PinnedCatchUpRpc extends SignaturesForAddressRpc {
  getGenesisHash(signal: AbortSignal): Promise<unknown>;
}

interface GenesisVerificationAttempt {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  waiters: number;
}

export interface ProviderPinnedCatchUpSourceDependencies {
  readonly createRpc?: (httpUrl: string, commitment: Commitment) => unknown;
}

export class ProviderPinnedCatchUpSourceError extends Error {
  public constructor(
    public readonly reason: ProviderPinnedCatchUpSourceErrorReason,
    public readonly providerId: RpcProviderId | null = null,
  ) {
    super('Provider-pinned catch-up source failed.');
    this.name = 'ProviderPinnedCatchUpSourceError';
    Object.defineProperty(this, 'name', { enumerable: false });
    Object.freeze(this);
  }
}

export function createProviderPinnedCatchUpSource(
  catalog: RpcProviderCatalog,
  providerId: RpcProviderId,
  commitment: Commitment,
  expectedGenesisHash: string,
  dependencies?: ProviderPinnedCatchUpSourceDependencies,
): ProviderPinnedCatchUpSource {
  const exposedProviderId = validProviderId(providerId) ? providerId : null;
  if (!validProviderId(providerId)
    || !validCommitment(commitment)
    || !canonicalSolanaGenesisHash(expectedGenesisHash)) {
    throw failure('CONFIG_INVALID', exposedProviderId);
  }

  const createRpc = dependencyFactory(dependencies, exposedProviderId);
  const httpUrl = resolveHttpUrl(catalog, providerId);
  const rpc = createPinnedRpc(createRpc, httpUrl, commitment, providerId);
  const source = new SolanaCatchUpSource(rpc, commitment);
  let genesisValidated = false;
  let genesisInFlight: GenesisVerificationAttempt | undefined;

  const genesisAttempt = (): GenesisVerificationAttempt => {
    if (genesisInFlight !== undefined) return genesisInFlight;
    const controller = new AbortController();
    const attempt = Promise.resolve().then(async (): Promise<void> => {
      let actual: unknown;
      try {
        actual = await rpc.getGenesisHash(controller.signal);
      } catch {
        if (controller.signal.aborted) throw abortError();
        throw failure('GENESIS_UNAVAILABLE', providerId);
      }
      if (controller.signal.aborted) throw abortError();
      if (!canonicalSolanaGenesisHash(actual)) {
        throw failure('GENESIS_UNAVAILABLE', providerId);
      }
      if (actual !== expectedGenesisHash) {
        throw failure('GENESIS_MISMATCH', providerId);
      }
      genesisValidated = true;
    });
    const record: GenesisVerificationAttempt = {
      controller,
      promise: attempt,
      waiters: 0,
    };
    genesisInFlight = record;
    void attempt.then(clearAttempt, clearAttempt);
    return record;

    function clearAttempt(): void {
      if (genesisInFlight === record) genesisInFlight = undefined;
    }
  };

  const verifyGenesis = (signal?: AbortSignal): Promise<void> => {
    if (genesisValidated) return Promise.resolve();
    return waitForGenesis(genesisAttempt(), signal, () => {
      if (genesisInFlight?.waiters === 0) genesisInFlight = undefined;
    });
  };

  return Object.freeze({
    providerId,
    verifyGenesis(signal?: AbortSignal): Promise<void> {
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        return Promise.reject(new TypeError('Abort signal is invalid.'));
      }
      if (signal?.aborted === true) {
        return Promise.reject(abortError());
      }
      return verifyGenesis(signal);
    },
    async list(programId: string, before: string | undefined, limit: number): Promise<unknown> {
      await verifyGenesis();
      return source.list(programId, before, limit);
    },
  });
}

function waitForGenesis(
  attempt: GenesisVerificationAttempt,
  signal: AbortSignal | undefined,
  detachAbortedAttempt: () => void,
): Promise<void> {
  attempt.waiters += 1;
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let released = false;
    let waiterAborted = false;
    const release = (): number => {
      if (!released) {
        released = true;
        attempt.waiters -= 1;
      }
      return attempt.waiters;
    };
    const finish = (operation: () => void): void => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      release();
      operation();
    };
    const abort = (): void => {
      if (finished) return;
      waiterAborted = true;
      signal?.removeEventListener('abort', abort);
      const remaining = release();
      if (remaining > 0) {
        finish(() => { reject(abortError()); });
        return;
      }
      detachAbortedAttempt();
      attempt.controller.abort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    void attempt.promise.then(
      () => {
        finish(() => {
          if (waiterAborted) reject(abortError());
          else resolve();
        });
      },
      (error: unknown) => {
        finish(() => {
          if (waiterAborted) reject(abortError());
          else reject(error instanceof Error ? error : failure('GENESIS_UNAVAILABLE', null));
        });
      },
    );
  });
}

function abortError(): DOMException {
  return new DOMException('Genesis verification aborted.', 'AbortError');
}

function dependencyFactory(
  dependencies: ProviderPinnedCatchUpSourceDependencies | undefined,
  providerId: RpcProviderId | null,
): (httpUrl: string, commitment: Commitment) => unknown {
  if (dependencies === undefined) return createDefaultRpc;
  try {
    if (Array.isArray(dependencies)) {
      throw new TypeError();
    }
    const keys = Reflect.ownKeys(dependencies);
    if (keys.length !== 1 || keys[0] !== 'createRpc') throw new TypeError();
    const descriptor = Object.getOwnPropertyDescriptor(dependencies, 'createRpc');
    if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
      throw new TypeError();
    }
    return descriptor.value as (httpUrl: string, commitment: Commitment) => unknown;
  } catch {
    throw failure('CONFIG_INVALID', providerId);
  }
}

function resolveHttpUrl(catalog: RpcProviderCatalog, providerId: RpcProviderId): string {
  let pair: unknown;
  try {
    const resolve = dataMethod(catalog, 'resolve');
    pair = resolve.call(catalog, providerId);
  } catch {
    throw failure('CONFIG_INVALID', providerId);
  }
  try {
    if (typeof pair !== 'object' || pair === null || Array.isArray(pair)) throw new TypeError();
    const id = dataProperty(pair, 'id');
    const httpUrl = dataProperty(pair, 'httpUrl');
    if (id !== providerId || !validHttpUrl(httpUrl)) throw new TypeError();
    return httpUrl;
  } catch {
    throw failure('CONFIG_INVALID', providerId);
  }
}

function createPinnedRpc(
  createRpc: (httpUrl: string, commitment: Commitment) => unknown,
  httpUrl: string,
  commitment: Commitment,
  providerId: RpcProviderId,
): PinnedCatchUpRpc {
  let instance: unknown;
  try {
    instance = createRpc(httpUrl, commitment);
    if (typeof instance !== 'object' || instance === null || Array.isArray(instance)) {
      throw new TypeError();
    }
    dataMethod(instance, 'getGenesisHash');
    dataMethod(instance, 'getSignaturesForAddress');
    return instance as PinnedCatchUpRpc;
  } catch {
    throw failure('CONFIG_INVALID', providerId);
  }
}

function createDefaultRpc(httpUrl: string, commitment: Commitment): PinnedCatchUpRpc {
  const connection = new Connection(httpUrl, { commitment, disableRetryOnRateLimit: true });
  const listSignatures = dataMethod(connection, 'getSignaturesForAddress');
  return Object.freeze({
    getGenesisHash(signal: AbortSignal): Promise<unknown> {
      return fetchGenesisHash(httpUrl, signal);
    },
    getSignaturesForAddress(
      ...parameters: Parameters<SignaturesForAddressRpc['getSignaturesForAddress']>
    ): Promise<unknown> {
      const [address, options, selectedCommitment] = parameters;
      const normalizedOptions = options.before === undefined
        ? { limit: options.limit }
        : { before: options.before, limit: options.limit };
      return Promise.resolve(Reflect.apply(listSignatures, connection, [
        address,
        normalizedOptions,
        selectedCommitment,
      ]));
    },
  });
}

async function fetchGenesisHash(httpUrl: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(httpUrl, {
    method: 'POST',
    headers: Object.freeze({ 'content-type': 'application/json' }),
    body: JSON.stringify(Object.freeze({
      jsonrpc: '2.0',
      id: 1,
      method: 'getGenesisHash',
      params: Object.freeze([]),
    })),
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new Error('Genesis RPC request failed.');
  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Genesis RPC response failed.');
  }
  return dataProperty(payload, 'result');
}

function validHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function dataMethod(value: object, key: string): (...args: unknown[]) => unknown {
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') throw new TypeError();
      return descriptor.value as (...args: unknown[]) => unknown;
    }
    const prototype: unknown = Object.getPrototypeOf(current);
    current = typeof prototype === 'object' && prototype !== null ? prototype : null;
  }
  throw new TypeError();
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) throw new TypeError();
  return descriptor.value;
}

function validProviderId(value: unknown): value is RpcProviderId {
  return value === 'primary'
    || value === 'fallback-1'
    || value === 'fallback-2'
    || value === 'fallback-3';
}

function validCommitment(value: unknown): value is Commitment {
  return value === 'processed' || value === 'confirmed' || value === 'finalized';
}

function failure(
  reason: ProviderPinnedCatchUpSourceErrorReason,
  providerId: RpcProviderId | null,
): ProviderPinnedCatchUpSourceError {
  return new ProviderPinnedCatchUpSourceError(reason, providerId);
}

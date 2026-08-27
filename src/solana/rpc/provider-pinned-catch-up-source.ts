import { Connection, type Commitment } from '@solana/web3.js';
import bs58 from 'bs58';
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
}

interface PinnedCatchUpRpc extends SignaturesForAddressRpc {
  getGenesisHash(): Promise<unknown>;
}

const BASE58_TEXT = /^[1-9A-HJ-NP-Za-km-z]+$/u;
const MIN_GENESIS_HASH_LENGTH = 32;
const MAX_GENESIS_HASH_LENGTH = 44;

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
    || !canonicalGenesisHash(expectedGenesisHash)) {
    throw failure('CONFIG_INVALID', exposedProviderId);
  }

  const createRpc = dependencyFactory(dependencies, exposedProviderId);
  const httpUrl = resolveHttpUrl(catalog, providerId);
  const rpc = createPinnedRpc(createRpc, httpUrl, commitment, providerId);
  const source = new SolanaCatchUpSource(rpc, commitment);
  let genesisValidated = false;
  let genesisInFlight: Promise<void> | undefined;

  const verifyGenesis = (): Promise<void> => {
    if (genesisValidated) return Promise.resolve();
    if (genesisInFlight !== undefined) return genesisInFlight;
    const attempt = Promise.resolve().then(async (): Promise<void> => {
      let actual: unknown;
      try {
        actual = await rpc.getGenesisHash();
      } catch {
        throw failure('GENESIS_UNAVAILABLE', providerId);
      }
      if (!canonicalGenesisHash(actual)) {
        throw failure('GENESIS_UNAVAILABLE', providerId);
      }
      if (actual !== expectedGenesisHash) {
        throw failure('GENESIS_MISMATCH', providerId);
      }
      genesisValidated = true;
    });
    genesisInFlight = attempt;
    void attempt.then(clearAttempt, clearAttempt);
    return attempt;

    function clearAttempt(): void {
      if (genesisInFlight === attempt) genesisInFlight = undefined;
    }
  };

  return Object.freeze({
    providerId,
    async list(programId: string, before: string | undefined, limit: number): Promise<unknown> {
      await verifyGenesis();
      return source.list(programId, before, limit);
    },
  });
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

function createDefaultRpc(httpUrl: string, commitment: Commitment): Connection {
  return new Connection(httpUrl, { commitment, disableRetryOnRateLimit: true });
}

function canonicalGenesisHash(value: unknown): value is string {
  if (typeof value !== 'string'
    || value.length < MIN_GENESIS_HASH_LENGTH
    || value.length > MAX_GENESIS_HASH_LENGTH
    || !BASE58_TEXT.test(value)) return false;
  try {
    const decoded = bs58.decode(value);
    return decoded.length === 32 && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
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

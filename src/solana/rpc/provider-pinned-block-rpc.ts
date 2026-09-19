import { Connection, type Commitment } from '@solana/web3.js';
import { isPromise } from 'node:util/types';
import type { RpcProviderId } from '../../domain/rpc-provider.js';
import type { LegacyConfirmationStatus } from './types.js';
import type { TransactionBlockRpc } from './transaction-locator.js';
import type { RpcProviderCatalog } from './rpc-provider-catalog.js';

export type ProviderPinnedBlockRpcErrorReason = 'CONFIG_INVALID' | 'BLOCK_UNAVAILABLE';

export interface ProviderPinnedBlockRpc extends TransactionBlockRpc {
  readonly providerId: RpcProviderId;
}

export interface ProviderPinnedBlockRpcDependencies {
  readonly createConnection?: (httpUrl: string, commitment: Commitment) => unknown;
}

export class ProviderPinnedBlockRpcError extends Error {
  public constructor(
    public readonly reason: ProviderPinnedBlockRpcErrorReason,
    public readonly providerId: RpcProviderId | null = null,
  ) {
    super('Provider-pinned block RPC failed.');
    this.name = 'ProviderPinnedBlockRpcError';
    Object.defineProperty(this, 'name', { enumerable: false });
    Object.freeze(this);
  }
}

interface PinnedBlockConnection {
  getBlock(slot: number, options: {
    commitment: 'confirmed' | 'finalized';
    transactionDetails: 'full';
    maxSupportedTransactionVersion: 0;
    rewards: false;
  }): Promise<unknown>;
}

export function createProviderPinnedBlockRpc(
  catalog: RpcProviderCatalog,
  providerId: RpcProviderId,
  commitment: Commitment,
  dependencies?: ProviderPinnedBlockRpcDependencies,
): ProviderPinnedBlockRpc {
  const exposedProviderId = validProviderId(providerId) ? providerId : null;
  if (!validProviderId(providerId) || !validCommitment(commitment)) {
    throw failure('CONFIG_INVALID', exposedProviderId);
  }
  const createConnection = dependencyFactory(dependencies, exposedProviderId);
  const httpUrl = resolveHttpUrl(catalog, providerId);
  const connection = createPinnedConnection(createConnection, httpUrl, commitment, providerId);

  return Object.freeze({
    providerId,
    async getBlockTransactions(
      slot: bigint,
      confirmationStatus: Exclude<LegacyConfirmationStatus, 'ORPHANED'>,
    ): Promise<unknown> {
      let numericSlot: number;
      try {
        numericSlot = numericBlockSlot(slot);
      } catch {
        throw failure('CONFIG_INVALID', providerId);
      }
      const selectedCommitment = confirmationStatus === 'FINALIZED' ? 'finalized' : 'confirmed';
      try {
        return await connection.getBlock(numericSlot, Object.freeze({
          commitment: selectedCommitment,
          transactionDetails: 'full',
          maxSupportedTransactionVersion: 0,
          rewards: false,
        }));
      } catch {
        throw failure('BLOCK_UNAVAILABLE', providerId);
      }
    },
  });
}

function dependencyFactory(
  dependencies: ProviderPinnedBlockRpcDependencies | undefined,
  providerId: RpcProviderId | null,
): (httpUrl: string, commitment: Commitment) => unknown {
  if (dependencies === undefined) return createDefaultConnection;
  try {
    if (Array.isArray(dependencies)) throw new TypeError();
    const keys = Reflect.ownKeys(dependencies);
    if (keys.length !== 1 || keys[0] !== 'createConnection') throw new TypeError();
    const descriptor = Object.getOwnPropertyDescriptor(dependencies, 'createConnection');
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
    pair = Reflect.apply(resolve, catalog, [providerId]);
  } catch {
    throw failure('CONFIG_INVALID', providerId);
  }
  try {
    if (!plainRecord(pair)) throw new TypeError();
    const id = dataProperty(pair, 'id');
    const httpUrl = dataProperty(pair, 'httpUrl');
    if (id !== providerId || !validHttpUrl(httpUrl)) throw new TypeError();
    return httpUrl;
  } catch {
    throw failure('CONFIG_INVALID', providerId);
  }
}

function createPinnedConnection(
  createConnection: (httpUrl: string, commitment: Commitment) => unknown,
  httpUrl: string,
  commitment: Commitment,
  providerId: RpcProviderId,
): PinnedBlockConnection {
  try {
    const connection = createConnection(httpUrl, commitment);
    if (typeof connection !== 'object' || connection === null || Array.isArray(connection)) {
      throw new TypeError();
    }
    if (consumeNativePromise(connection)) throw new TypeError();
    const getBlock = dataMethod(connection, 'getBlock');
    return Object.freeze({
      getBlock(
        slot: number,
        options: {
          commitment: 'confirmed' | 'finalized';
          transactionDetails: 'full';
          maxSupportedTransactionVersion: 0;
          rewards: false;
        },
      ): Promise<unknown> {
        return Promise.resolve(Reflect.apply(getBlock, connection, [slot, options]));
      },
    });
  } catch {
    throw failure('CONFIG_INVALID', providerId);
  }
}

function consumeAsyncFactoryResult(): void {
  // The synchronous factory contract rejects async results; sinking both
  // outcomes prevents invalid dependencies from leaking through Node's
  // unhandled-rejection channel or assimilating hostile fulfilled values.
}

function consumeNativePromise(value: object): boolean {
  if (!isPromise(value)) return false;
  if (!supportedNativePromise(value)) return true;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(Promise.prototype, 'then');
    if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
      throw new TypeError();
    }
    const nativeThen = descriptor.value as (
      this: object,
      onFulfilled: () => void,
      onRejected: () => void,
    ) => unknown;
    const continuation = Reflect.apply(nativeThen, value, [
      consumeAsyncFactoryResult,
      consumeAsyncFactoryResult,
    ]);
    void continuation;
    return true;
  } catch {
    return true;
  }
}

function supportedNativePromise(value: object): boolean {
  try {
    if (Object.getPrototypeOf(value) !== Promise.prototype) return false;
    if (Object.getOwnPropertyDescriptor(value, 'constructor') !== undefined) return false;
    const constructor = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor');
    return constructor !== undefined && 'value' in constructor && constructor.value === Promise;
  } catch {
    return false;
  }
}

function createDefaultConnection(httpUrl: string, commitment: Commitment): Connection {
  return new Connection(httpUrl, { commitment, disableRetryOnRateLimit: true });
}

function numericBlockSlot(value: unknown): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError();
  }
  return Number(value);
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

function validHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function plainRecord(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function failure(
  reason: ProviderPinnedBlockRpcErrorReason,
  providerId: RpcProviderId | null,
): ProviderPinnedBlockRpcError {
  return new ProviderPinnedBlockRpcError(reason, providerId);
}

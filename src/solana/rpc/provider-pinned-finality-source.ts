import { Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import type { RpcProviderId } from '../../domain/rpc-provider.js';
import type { FinalityProviderPass } from '../../ports/finality-provider-pass.js';
import type { RpcProviderCatalog } from './rpc-provider-catalog.js';

export type ProviderPinnedFinalityErrorReason =
  | 'CONFIG_INVALID'
  | 'HISTORY_UNAVAILABLE'
  | 'ROOT_UNAVAILABLE'
  | 'BLOCK_UNAVAILABLE';

export interface ProviderPinnedFinalityDependencies {
  readonly createRpc?: (httpUrl: string) => unknown;
}

export class ProviderPinnedFinalityError extends Error {
  public constructor(
    public readonly reason: ProviderPinnedFinalityErrorReason,
    public readonly providerId: RpcProviderId | null = null,
  ) {
    super('Provider-pinned finality pass failed.');
    this.name = 'ProviderPinnedFinalityError';
    Object.defineProperty(this, 'name', { enumerable: false });
    Object.freeze(this);
  }
}

type HistoryStatus = Readonly<{
  slot: bigint;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized';
}>;

interface PinnedFinalityCalls {
  readonly history: (signatures: string[], options: { searchTransactionHistory: true }) => Promise<unknown>;
  readonly root: (commitment: 'finalized') => Promise<unknown>;
  readonly block: (slot: number, commitment: 'finalized') => Promise<unknown>;
}

const BASE58_TEXT = /^[1-9A-HJ-NP-Za-km-z]+$/u;
const MIN_SIGNATURE_LENGTH = 64;
const MAX_SIGNATURE_LENGTH = 88;
const MAX_HISTORY_SIGNATURES = 256;
const MAX_BLOCK_SIGNATURES = 10_000;

export function createProviderPinnedFinalityPass(
  catalog: RpcProviderCatalog,
  providerId: RpcProviderId,
  dependencies?: ProviderPinnedFinalityDependencies,
): FinalityProviderPass {
  const exposedProviderId = validProviderId(providerId) ? providerId : null;
  if (!validProviderId(providerId)) throw failure('CONFIG_INVALID', exposedProviderId);
  const createRpc = dependencyFactory(dependencies, exposedProviderId);
  const httpUrl = resolveHttpUrl(catalog, providerId);
  const calls = createPinnedCalls(createRpc, httpUrl, providerId);

  return Object.freeze({
    providerId,
    async getHistoryStatuses(signatures: readonly string[]): Promise<unknown> {
      let request: string[];
      try {
        request = snapshotHistoryRequest(signatures);
      } catch {
        throw failure('CONFIG_INVALID', providerId);
      }
      try {
        const response = await calls.history([...request], { searchTransactionHistory: true });
        return snapshotHistoryResponse(response, request.length);
      } catch {
        throw failure('HISTORY_UNAVAILABLE', providerId);
      }
    },
    async getFinalizedSlot(): Promise<unknown> {
      try {
        return snapshotSlot(await calls.root('finalized'));
      } catch {
        throw failure('ROOT_UNAVAILABLE', providerId);
      }
    },
    async getFinalizedBlockSignatures(slot: bigint): Promise<unknown> {
      let numericSlot: number;
      try {
        numericSlot = numericBlockSlot(slot);
      } catch {
        throw failure('CONFIG_INVALID', providerId);
      }
      try {
        return snapshotBlockResponse(await calls.block(numericSlot, 'finalized'));
      } catch {
        throw failure('BLOCK_UNAVAILABLE', providerId);
      }
    },
  });
}

function dependencyFactory(
  dependencies: ProviderPinnedFinalityDependencies | undefined,
  providerId: RpcProviderId | null,
): (httpUrl: string) => unknown {
  if (dependencies === undefined) return createDefaultRpc;
  try {
    if (Array.isArray(dependencies)) throw new TypeError();
    const keys = Reflect.ownKeys(dependencies);
    if (keys.length !== 1 || keys[0] !== 'createRpc') throw new TypeError();
    const descriptor = Object.getOwnPropertyDescriptor(dependencies, 'createRpc');
    if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
      throw new TypeError();
    }
    return descriptor.value as (httpUrl: string) => unknown;
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

function createPinnedCalls(
  createRpc: (httpUrl: string) => unknown,
  httpUrl: string,
  providerId: RpcProviderId,
): PinnedFinalityCalls {
  try {
    const rpc = createRpc(httpUrl);
    if (typeof rpc !== 'object' || rpc === null || Array.isArray(rpc)) throw new TypeError();
    const history = dataMethod(rpc, 'getSignatureStatuses');
    const root = dataMethod(rpc, 'getSlot');
    const block = dataMethod(rpc, 'getBlockSignatures');
    return Object.freeze({
      history: (signatures: string[], options: { searchTransactionHistory: true }) => (
        Promise.resolve(Reflect.apply(history, rpc, [signatures, options]))
      ),
      root: (commitment: 'finalized') => Promise.resolve(Reflect.apply(root, rpc, [commitment])),
      block: (slot: number, commitment: 'finalized') => (
        Promise.resolve(Reflect.apply(block, rpc, [slot, commitment]))
      ),
    });
  } catch {
    throw failure('CONFIG_INVALID', providerId);
  }
}

function createDefaultRpc(httpUrl: string): Connection {
  return new Connection(httpUrl, { disableRetryOnRateLimit: true });
}

function snapshotHistoryRequest(value: readonly string[]): string[] {
  const entries = trustedArray(value, MAX_HISTORY_SIGNATURES, true);
  if (entries.length === 0) throw new TypeError();
  const signatures: string[] = [];
  for (const entry of entries) {
    if (!canonicalSignature(entry)) throw new TypeError();
    signatures.push(entry);
  }
  return signatures;
}

function snapshotHistoryResponse(value: unknown, expectedLength: number): readonly (HistoryStatus | null)[] {
  if (!plainRecord(value)) throw new TypeError();
  const entries = trustedArray(dataProperty(value, 'value'), MAX_HISTORY_SIGNATURES, false);
  if (entries.length !== expectedLength) throw new TypeError();
  const snapshots: (HistoryStatus | null)[] = [];
  for (const entry of entries) {
    if (entry === null) {
      snapshots.push(null);
      continue;
    }
    if (!plainRecord(entry)) throw new TypeError();
    const slot = dataProperty(entry, 'slot');
    const confirmationStatus = dataProperty(entry, 'confirmationStatus');
    if (!validSlot(slot) || !validConfirmationStatus(confirmationStatus)) throw new TypeError();
    snapshots.push(Object.freeze({ slot: BigInt(slot), confirmationStatus }));
  }
  return Object.freeze(snapshots);
}

function snapshotSlot(value: unknown): bigint {
  if (!validSlot(value)) throw new TypeError();
  return BigInt(value);
}

function numericBlockSlot(value: unknown): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError();
  }
  return Number(value);
}

function snapshotBlockResponse(value: unknown): readonly string[] {
  if (!plainRecord(value)) throw new TypeError();
  const entries = trustedArray(dataProperty(value, 'signatures'), MAX_BLOCK_SIGNATURES, false);
  const seen = new Set<string>();
  const snapshots: string[] = [];
  for (const entry of entries) {
    if (!canonicalSignature(entry) || seen.has(entry)) throw new TypeError();
    seen.add(entry);
    snapshots.push(entry);
  }
  return Object.freeze(snapshots);
}

function trustedArray(value: unknown, maximumLength: number, requireFrozen: boolean): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
  if (requireFrozen && !Object.isFrozen(value)) throw new TypeError();
  const length = dataProperty(value, 'length');
  if (typeof length !== 'number'
    || !Number.isSafeInteger(length)
    || length < 0
    || length > maximumLength) throw new TypeError();
  const keys = new Set(Reflect.ownKeys(value));
  if (keys.size !== length + 1 || !keys.has('length')) throw new TypeError();
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.has(key)) throw new TypeError();
    entries.push(dataProperty(value, key));
  }
  return entries;
}

function canonicalSignature(value: unknown): value is string {
  if (typeof value !== 'string'
    || value.length < MIN_SIGNATURE_LENGTH
    || value.length > MAX_SIGNATURE_LENGTH
    || !BASE58_TEXT.test(value)) return false;
  try {
    const decoded = bs58.decode(value);
    return decoded.length === 64 && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
}

function validSlot(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

function validConfirmationStatus(value: unknown): value is HistoryStatus['confirmationStatus'] {
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

function validProviderId(value: unknown): value is RpcProviderId {
  return value === 'primary'
    || value === 'fallback-1'
    || value === 'fallback-2'
    || value === 'fallback-3';
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
  reason: ProviderPinnedFinalityErrorReason,
  providerId: RpcProviderId | null,
): ProviderPinnedFinalityError {
  return new ProviderPinnedFinalityError(reason, providerId);
}

import { isProxy } from 'node:util/types';
import { isRpcProviderId, type RpcProviderId } from '../domain/rpc-provider.js';
import type {
  FinalityProviderPass,
  FinalityProviderPassSource,
} from '../ports/finality-provider-pass.js';

export class PromotedProviderUnavailableError extends Error {
  public constructor() {
    super('Promoted RPC provider is unavailable.');
    this.name = 'PromotedProviderUnavailableError';
    Object.defineProperty(this, 'name', { enumerable: false });
    Object.freeze(this);
  }
}

export class PromotedProviderSelector implements FinalityProviderPassSource {
  readonly #passes: ReadonlyMap<RpcProviderId, FinalityProviderPass>;
  #activeProvider: RpcProviderId | null = null;

  public constructor(passes: readonly FinalityProviderPass[]) {
    const selected = new Map<RpcProviderId, FinalityProviderPass>();
    try {
      for (const pass of snapshotPasses(passes)) {
        const providerId = providerIdOf(pass);
        if (providerId === null || selected.has(providerId)) throw new TypeError();
        selected.set(providerId, pass);
      }
      if (selected.size === 0) throw new TypeError();
    } catch {
      throw new TypeError('Provider-pinned finality passes are invalid.');
    }
    this.#passes = selected;
  }

  public activeProviderId(): RpcProviderId | null {
    return this.#activeProvider;
  }

  public promote(providerId: RpcProviderId): void {
    if (!isRpcProviderId(providerId) || !this.#passes.has(providerId)) {
      throw new TypeError('Promoted RPC provider is invalid.');
    }
    this.#activeProvider = providerId;
  }

  public clear(providerId: RpcProviderId): void {
    if (this.#activeProvider === providerId) this.#activeProvider = null;
  }

  public openPass(): FinalityProviderPass {
    const providerId = this.#activeProvider;
    if (providerId === null) throw new PromotedProviderUnavailableError();
    const pass = this.#passes.get(providerId);
    if (pass === undefined) throw new PromotedProviderUnavailableError();
    return pass;
  }
}

function snapshotPasses(value: unknown): FinalityProviderPass[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length: unknown = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) throw new TypeError();

  const passes: FinalityProviderPass[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (entry === undefined || !('value' in entry)) throw new TypeError();
    passes.push(entry.value as FinalityProviderPass);
  }
  return passes;
}

function providerIdOf(value: unknown): RpcProviderId | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || isProxy(value) || !Object.isFrozen(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'providerId');
  if (descriptor === undefined || !('value' in descriptor) || !isRpcProviderId(descriptor.value)
    || !dataMethod(value, 'getHistoryStatuses')
    || !dataMethod(value, 'getFinalizedSlot')
    || !dataMethod(value, 'getFinalizedBlockSignatures')) return null;
  return descriptor.value;
}

function dataMethod(value: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'function';
}

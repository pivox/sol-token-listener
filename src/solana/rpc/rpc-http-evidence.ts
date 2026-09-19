import type { FetchFn } from '@solana/web3.js';
import {
  createRuntimeRpcHttpEvidence,
  type RuntimeRpcHttpEvidenceV1,
} from '../../domain/rpc-http-evidence.js';
import { isRpcProviderId, RPC_PROVIDER_IDS, type RpcProviderId } from '../../domain/rpc-provider.js';

type FetchInput = Parameters<FetchFn>[0];
type FetchInit = Parameters<FetchFn>[1];

interface Counter {
  attempts: number;
  http429Responses: number;
}

export interface RpcHttpEvidenceRecorder {
  recordAttempt(providerId: RpcProviderId): void;
  recordHttp429(providerId: RpcProviderId): void;
  snapshot(configuredProviderIds: readonly RpcProviderId[]): RuntimeRpcHttpEvidenceV1;
}

export function createRpcHttpEvidenceRecorder(): RpcHttpEvidenceRecorder {
  return new MutableRpcHttpEvidenceRecorder();
}

export function createObservedRpcFetch(
  providerId: RpcProviderId,
  recorder: RpcHttpEvidenceRecorder,
  fetchImplementation: FetchFn = globalThis.fetch,
): FetchFn {
  if (!isRpcProviderId(providerId) || typeof fetchImplementation !== 'function') invalid();

  return async (input, init): Promise<Response> => {
    throwIfAborted(requestSignal(input, init));
    recordSafely(recorder, 'recordAttempt', providerId);
    const response = await fetchImplementation(input, init);
    if (responseStatus(response) === 429) recordSafely(recorder, 'recordHttp429', providerId);
    return response;
  };
}

function responseStatus(response: Response): number | undefined {
  try {
    return response.status;
  } catch {
    return undefined;
  }
}

function requestSignal(input: FetchInput, init: FetchInit): AbortSignal | undefined {
  if (init?.signal !== undefined && init.signal !== null) return init.signal;
  return input instanceof Request ? input.signal : undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException('This operation was aborted.', 'AbortError');
}

class MutableRpcHttpEvidenceRecorder implements RpcHttpEvidenceRecorder {
  private overflowed = false;
  private readonly counters = new Map<RpcProviderId, Counter>(RPC_PROVIDER_IDS.map((providerId) => [
    providerId,
    { attempts: 0, http429Responses: 0 },
  ]));

  public recordAttempt(providerId: RpcProviderId): void {
    const counter = this.counter(providerId);
    counter.attempts = this.increment(counter.attempts);
  }

  public recordHttp429(providerId: RpcProviderId): void {
    const counter = this.counter(providerId);
    if (counter.http429Responses >= counter.attempts) {
      this.overflowed = true;
      return;
    }
    counter.http429Responses = this.increment(counter.http429Responses);
  }

  public snapshot(configuredProviderIds: readonly RpcProviderId[]): RuntimeRpcHttpEvidenceV1 {
    const configured = configuredIds(configuredProviderIds);
    return createRuntimeRpcHttpEvidence({
      version: 1,
      overflowed: this.overflowed,
      providers: RPC_PROVIDER_IDS.map((providerId) => {
        const counter = this.counters.get(providerId);
        if (counter === undefined) throw new TypeError('RPC HTTP evidence recorder is invalid.');
        return {
          providerId,
          configured: configured.has(providerId),
          attempts: counter.attempts,
          http429Responses: counter.http429Responses,
        };
      }),
    });
  }

  private counter(providerId: RpcProviderId): Counter {
    if (!isRpcProviderId(providerId)) invalid();
    const counter = this.counters.get(providerId);
    if (counter === undefined) throw new TypeError('RPC HTTP evidence recorder is invalid.');
    return counter;
  }

  private increment(value: number): number {
    if (value === Number.MAX_SAFE_INTEGER) {
      this.overflowed = true;
      return value;
    }
    return value + 1;
  }
}

function configuredIds(value: readonly RpcProviderId[]): ReadonlySet<RpcProviderId> {
  if (!Array.isArray(value) || new Set(value).size !== value.length
    || value.some((providerId) => !isRpcProviderId(providerId))) invalid();
  return new Set(value);
}

function recordSafely(
  recorder: RpcHttpEvidenceRecorder,
  method: 'recordAttempt' | 'recordHttp429',
  providerId: RpcProviderId,
): void {
  try {
    recorder[method](providerId);
  } catch {
    // Instrumentation never changes the outcome of the physical RPC fetch.
  }
}

function invalid(): never {
  throw new TypeError('RPC HTTP evidence recorder is invalid.');
}

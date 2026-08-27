import type { FetchFn } from '@solana/web3.js';

type FetchInput = Parameters<FetchFn>[0];
type FetchInit = Parameters<FetchFn>[1];

export type RpcHttpFailureReason =
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'BAD_GATEWAY'
  | 'UNAVAILABLE'
  | 'GATEWAY_TIMEOUT';

export type RpcHttpEndpointId = 'primary' | `fallback-${1 | 2 | 3}`;

export type RpcHttpFailoverEvent =
  | Readonly<{
    type: 'rpc.http_endpoint_degraded';
    endpointId: RpcHttpEndpointId;
    reason: RpcHttpFailureReason;
    cooldownMs: number;
  }>
  | Readonly<{
    type: 'rpc.http_failover';
    fromEndpointId: RpcHttpEndpointId;
    toEndpointId: RpcHttpEndpointId;
    reason: RpcHttpFailureReason;
  }>
  | Readonly<{
    type: 'rpc.http_endpoints_exhausted';
    attemptedEndpointIds: readonly RpcHttpEndpointId[];
  }>;

type RpcHttpFailoverFetchOptions = Readonly<{
  endpoints: readonly Readonly<{ id: RpcHttpEndpointId; url: string }>[];
  fetch?: FetchFn;
  now?: () => number;
  onEvent?: (event: RpcHttpFailoverEvent) => void;
}>;

interface EndpointState {
  readonly id: RpcHttpEndpointId;
  readonly url: string;
  cooldownUntil: number;
}

interface LastFailure {
  readonly endpointId: RpcHttpEndpointId;
  readonly reason: RpcHttpFailureReason;
}

const DEFAULT_COOLDOWN_MS = 1000;
const MAX_RETRY_AFTER_MS = 60_000;
const validEndpointIds: ReadonlySet<string> = new Set([
  'primary',
  'fallback-1',
  'fallback-2',
  'fallback-3',
]);
const imfFixdate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
const canonicalDelaySeconds = /^(?:0|[1-9]\d*)$/u;

export class RpcHttpEndpointsExhaustedError extends Error {
  public readonly code = 'RPC_HTTP_ENDPOINTS_EXHAUSTED' as const;

  public constructor() {
    super('All configured HTTP RPC endpoints are unavailable.');
    this.name = 'RpcHttpEndpointsExhaustedError';
    Object.freeze(this);
  }
}

export function createRpcHttpFailoverFetch(options: RpcHttpFailoverFetchOptions): FetchFn {
  const validated = validateOptions(options);
  const states: EndpointState[] = validated.endpoints.map((endpoint) => ({
    id: endpoint.id,
    url: endpoint.url,
    cooldownUntil: 0,
  }));
  const fetch = validated.fetch ?? globalThis.fetch;
  const now = validated.now ?? Date.now;
  const onEvent = validated.onEvent;
  let stickyIndex = 0;

  return async (input, init): Promise<Response> => {
    const startIndex = stickyIndex;
    const attemptedIndices = new Set<number>();
    const attemptedEndpointIds: RpcHttpEndpointId[] = [];
    let lastFailure: LastFailure | undefined;

    for (;;) {
      const endpointIndex = nextEligibleIndex(states, startIndex, attemptedIndices, now());
      if (endpointIndex === undefined) {
        emit(onEvent, Object.freeze({
          type: 'rpc.http_endpoints_exhausted',
          attemptedEndpointIds: Object.freeze([...attemptedEndpointIds]),
        }));
        throw new RpcHttpEndpointsExhaustedError();
      }

      const endpoint = states[endpointIndex];
      if (endpoint === undefined) throw new RpcHttpEndpointsExhaustedError();
      if (lastFailure !== undefined) {
        emit(onEvent, Object.freeze({
          type: 'rpc.http_failover',
          fromEndpointId: lastFailure.endpointId,
          toEndpointId: endpoint.id,
          reason: lastFailure.reason,
        }));
      }

      attemptedIndices.add(endpointIndex);
      attemptedEndpointIds.push(endpoint.id);
      const rewrittenInput = rewriteInput(input, endpoint.url);
      let response: Response;
      try {
        response = await fetch(rewrittenInput, init);
      } catch (error) {
        if (requestSignal(input, init)?.aborted === true) throw error;
        const reason = 'NETWORK';
        degrade(endpoint, reason, DEFAULT_COOLDOWN_MS, now(), onEvent);
        lastFailure = { endpointId: endpoint.id, reason };
        continue;
      }

      const reason = transientReason(response.status);
      if (reason === undefined) {
        stickyIndex = endpointIndex;
        return response;
      }

      const degradedAt = now();
      const cooldownMs = reason === 'RATE_LIMITED'
        ? retryAfterCooldown(response.headers.get('retry-after'), degradedAt)
        : DEFAULT_COOLDOWN_MS;
      degrade(endpoint, reason, cooldownMs, degradedAt, onEvent);
      await cancelResponse(response);
      lastFailure = { endpointId: endpoint.id, reason };
    }
  };
}

function validateOptions(options: RpcHttpFailoverFetchOptions): RpcHttpFailoverFetchOptions {
  const unknownOptions: unknown = options;
  if (typeof unknownOptions !== 'object' || unknownOptions === null || Array.isArray(unknownOptions)) {
    throw new TypeError('HTTP RPC failover options are invalid.');
  }
  const candidate = unknownOptions as Partial<RpcHttpFailoverFetchOptions>;
  if (!Array.isArray(candidate.endpoints)
    || candidate.endpoints.length < 2
    || candidate.endpoints.length > 4) {
    throw new TypeError('HTTP RPC failover requires between 2 and 4 endpoints.');
  }

  const endpoints: { readonly id: RpcHttpEndpointId; readonly url: string }[] = [];
  for (const endpoint of candidate.endpoints as readonly unknown[]) {
    if (typeof endpoint !== 'object' || endpoint === null || Array.isArray(endpoint)) {
      throw new TypeError('HTTP RPC endpoint is invalid.');
    }
    const value = endpoint as { readonly id?: unknown; readonly url?: unknown };
    if (typeof value.id !== 'string' || !validEndpointIds.has(value.id)) {
      throw new TypeError('HTTP RPC endpoint identifier is invalid.');
    }
    if (typeof value.url !== 'string' || !validHttpUrl(value.url)) {
      throw new TypeError('HTTP RPC endpoint URL is invalid.');
    }
    endpoints.push(Object.freeze({ id: value.id as RpcHttpEndpointId, url: value.url }));
  }
  if (new Set(endpoints.map(({ id }) => id)).size !== endpoints.length) {
    throw new TypeError('HTTP RPC endpoint identifiers must be unique.');
  }
  if (new Set(endpoints.map(({ url }) => url)).size !== endpoints.length) {
    throw new TypeError('HTTP RPC endpoint URLs must be unique.');
  }
  if (candidate.fetch !== undefined && typeof candidate.fetch !== 'function') {
    throw new TypeError('HTTP RPC fetch is invalid.');
  }
  if (candidate.now !== undefined && typeof candidate.now !== 'function') {
    throw new TypeError('HTTP RPC clock is invalid.');
  }
  if (candidate.onEvent !== undefined && typeof candidate.onEvent !== 'function') {
    throw new TypeError('HTTP RPC event callback is invalid.');
  }
  return Object.freeze({
    endpoints: Object.freeze(endpoints),
    ...(candidate.fetch === undefined ? {} : { fetch: candidate.fetch }),
    ...(candidate.now === undefined ? {} : { now: candidate.now }),
    ...(candidate.onEvent === undefined ? {} : { onEvent: candidate.onEvent }),
  });
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.href.length > 0;
  } catch {
    return false;
  }
}

function nextEligibleIndex(
  endpoints: readonly EndpointState[],
  startIndex: number,
  attemptedIndices: ReadonlySet<number>,
  currentTime: number,
): number | undefined {
  for (let offset = 0; offset < endpoints.length; offset += 1) {
    const index = (startIndex + offset) % endpoints.length;
    const endpoint = endpoints[index];
    if (endpoint !== undefined
      && !attemptedIndices.has(index)
      && endpoint.cooldownUntil <= currentTime) {
      return index;
    }
  }
  return undefined;
}

function rewriteInput(input: FetchInput, endpointUrl: string): FetchInput {
  if (input instanceof Request) return new Request(endpointUrl, input.clone());
  return endpointUrl;
}

function requestSignal(input: FetchInput, init: FetchInit): AbortSignal | undefined {
  if (init?.signal !== undefined && init.signal !== null) return init.signal;
  return input instanceof Request ? input.signal : undefined;
}

function transientReason(status: number): RpcHttpFailureReason | undefined {
  switch (status) {
    case 429: return 'RATE_LIMITED';
    case 502: return 'BAD_GATEWAY';
    case 503: return 'UNAVAILABLE';
    case 504: return 'GATEWAY_TIMEOUT';
    default: return undefined;
  }
}

function retryAfterCooldown(value: string | null, currentTime: number): number {
  if (value === null) return DEFAULT_COOLDOWN_MS;
  if (canonicalDelaySeconds.test(value)) {
    const seconds = Number(value);
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  if (!imfFixdate.test(value)) return DEFAULT_COOLDOWN_MS;
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt) || new Date(retryAt).toUTCString() !== value) {
    return DEFAULT_COOLDOWN_MS;
  }
  return Math.min(Math.max(retryAt - currentTime, 0), MAX_RETRY_AFTER_MS);
}

function degrade(
  endpoint: EndpointState,
  reason: RpcHttpFailureReason,
  cooldownMs: number,
  degradedAt: number,
  onEvent: ((event: RpcHttpFailoverEvent) => void) | undefined,
): void {
  endpoint.cooldownUntil = degradedAt + cooldownMs;
  emit(onEvent, Object.freeze({
    type: 'rpc.http_endpoint_degraded',
    endpointId: endpoint.id,
    reason,
    cooldownMs,
  }));
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A discarded provider body is never allowed to corrupt failover.
  }
}

function emit(
  onEvent: ((event: RpcHttpFailoverEvent) => void) | undefined,
  event: RpcHttpFailoverEvent,
): void {
  try {
    onEvent?.(event);
  } catch {
    // Diagnostics are isolated from transport behavior.
  }
}

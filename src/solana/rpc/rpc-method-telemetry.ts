import type { ConnectionConfig } from '@solana/web3.js';
import {
  hasJsonRpcError,
  retryAfterMilliseconds,
  type CatchUpRpcMetrics,
} from './catch-up-rpc-telemetry.js';

type RpcFetch = NonNullable<ConnectionConfig['fetch']>;

export type RpcMethodMetrics = CatchUpRpcMetrics;

export interface RpcMethodTelemetryOptions {
  readonly fetch?: RpcFetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxInlineRetries?: number;
  readonly maximumInlineRetryDelayMs?: number;
}

interface MutableMetrics {
  requestCount: number;
  http429Count: number;
  retryCount: number;
  retryBackoffTotalMs: number;
  otherRpcErrors: number;
}

const RETRY_AFTER_FALLBACK_MS = 500;
const DEFAULT_MAX_INLINE_RETRIES = 2;
const MAXIMUM_INLINE_RETRY_DELAY_MS = 5_000;
const UNKNOWN_METHOD = 'unknown';

// Replaces web3.js's silent 429 retry burst on the shared connection: every request and
// refusal is counted per JSON-RPC method, and one cooldown is shared because the provider
// quota is global rather than per method.
export class RpcMethodTelemetry {
  private readonly baseFetch: RpcFetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxInlineRetries: number;
  private readonly maximumInlineRetryDelayMs: number;
  private readonly counters = new Map<string, MutableMetrics>();
  private nextAllowedAtMs = 0;

  public constructor(options: RpcMethodTelemetryOptions = {}) {
    this.baseFetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? delay;
    this.maxInlineRetries = options.maxInlineRetries ?? DEFAULT_MAX_INLINE_RETRIES;
    this.maximumInlineRetryDelayMs = options.maximumInlineRetryDelayMs ?? MAXIMUM_INLINE_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(this.maxInlineRetries) || this.maxInlineRetries < 0
      || !Number.isSafeInteger(this.maximumInlineRetryDelayMs) || this.maximumInlineRetryDelayMs < 0) {
      throw new TypeError('RPC retry policy is invalid.');
    }
  }

  public async fetch(input: Parameters<RpcFetch>[0], init?: Parameters<RpcFetch>[1]): Promise<Response> {
    const counters = this.countersFor(requestMethod(init?.body));
    await this.waitForCooldown(counters);

    let retries = 0;
    for (;;) {
      counters.requestCount += 1;
      let response: Response;
      try {
        response = await this.baseFetch(input, init);
      } catch (error) {
        counters.otherRpcErrors += 1;
        throw error;
      }

      if (response.status === 429) {
        counters.http429Count += 1;
        const retryDelayMs = retryAfterMilliseconds(response.headers.get('retry-after'), this.now())
          ?? RETRY_AFTER_FALLBACK_MS;
        this.nextAllowedAtMs = Math.max(this.nextAllowedAtMs, this.now() + retryDelayMs);
        if (retries < this.maxInlineRetries && retryDelayMs <= this.maximumInlineRetryDelayMs) {
          retries += 1;
          counters.retryCount += 1;
          await this.waitForCooldown(counters);
          continue;
        }
        return response;
      }

      if (!response.ok) {
        counters.otherRpcErrors += 1;
        return response;
      }
      try {
        const body: unknown = await response.clone().json();
        if (hasJsonRpcError(body)) counters.otherRpcErrors += 1;
      } catch {
        // The web3 Connection remains responsible for decoding the original response.
      }
      return response;
    }
  }

  public snapshot(): Readonly<Record<string, RpcMethodMetrics>> {
    const result: Record<string, RpcMethodMetrics> = {};
    for (const [method, metrics] of this.counters) result[method] = Object.freeze({ ...metrics });
    return Object.freeze(result);
  }

  private countersFor(method: string): MutableMetrics {
    let counters = this.counters.get(method);
    if (counters === undefined) {
      counters = { requestCount: 0, http429Count: 0, retryCount: 0, retryBackoffTotalMs: 0, otherRpcErrors: 0 };
      this.counters.set(method, counters);
    }
    return counters;
  }

  private async waitForCooldown(counters: MutableMetrics): Promise<void> {
    const remainingMs = Math.max(0, this.nextAllowedAtMs - this.now());
    if (remainingMs === 0) return;
    counters.retryBackoffTotalMs += remainingMs;
    await this.sleep(remainingMs);
  }
}

// Method names come from a fixed web3.js vocabulary; anything else is folded into one bucket
// so a hostile or malformed body cannot grow the counter map.
function requestMethod(body: unknown): string {
  if (typeof body !== 'string') return UNKNOWN_METHOD;
  try {
    const request: unknown = JSON.parse(body);
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return UNKNOWN_METHOD;
    const method = (request as { readonly method?: unknown }).method;
    return typeof method === 'string' && /^[A-Za-z]{1,64}$/u.test(method) ? method : UNKNOWN_METHOD;
  } catch {
    return UNKNOWN_METHOD;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

import type { ConnectionConfig } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from '../../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../../markets/pumpswap/constants.js';

export type CatchUpRpcProgram = 'launchpad' | 'market';

export interface CatchUpRpcMetrics {
  readonly requestCount: number;
  readonly http429Count: number;
  readonly retryCount: number;
  readonly retryBackoffTotalMs: number;
  readonly otherRpcErrors: number;
}

export interface CatchUpRpcTelemetryOptions {
  readonly fetch?: NonNullable<ConnectionConfig['fetch']>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maximumInlineRetryDelayMs?: number;
}

interface MutableMetrics {
  requestCount: number;
  http429Count: number;
  retryCount: number;
  retryBackoffTotalMs: number;
  otherRpcErrors: number;
  nextAllowedAtMs: number;
}

const RETRY_AFTER_FALLBACK_MS = 500;
const MAXIMUM_INLINE_RETRY_DELAY_MS = 5_000;
const METRIC_PROGRAMS = Object.freeze({
  [PUMP_PROGRAM_ID]: 'launchpad',
  [PUMPSWAP_PROGRAM_ID]: 'market',
} satisfies Readonly<Record<string, CatchUpRpcProgram>>);

export class CatchUpRpcTelemetry {
  private readonly baseFetch: NonNullable<ConnectionConfig['fetch']>;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maximumInlineRetryDelayMs: number;
  private readonly counters: Record<CatchUpRpcProgram, MutableMetrics> = {
    launchpad: emptyMetrics(),
    market: emptyMetrics(),
  };

  public constructor(options: CatchUpRpcTelemetryOptions = {}) {
    this.baseFetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? delay;
    this.maximumInlineRetryDelayMs = options.maximumInlineRetryDelayMs ?? MAXIMUM_INLINE_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(this.maximumInlineRetryDelayMs) || this.maximumInlineRetryDelayMs < 0) {
      throw new TypeError('Catch-up RPC retry delay bound is invalid.');
    }
  }

  public async fetch(input: Parameters<NonNullable<ConnectionConfig['fetch']>>[0],
    init?: Parameters<NonNullable<ConnectionConfig['fetch']>>[1]): Promise<Response> {
    const program = requestProgram(init?.body);
    const counters = program === null ? null : this.counters[program];
    if (counters !== null) await this.waitForCooldown(counters);

    let inlineRetryUsed = false;
    for (;;) {
      if (counters !== null) counters.requestCount += 1;
      let response: Response;
      try {
        response = await this.baseFetch(input, init);
      } catch (error) {
        if (counters !== null) counters.otherRpcErrors += 1;
        throw error;
      }

      if (counters === null) return response;
      if (response.status === 429) {
        counters.http429Count += 1;
        const retryDelayMs = retryAfterMilliseconds(response.headers.get('retry-after'), this.now())
          ?? RETRY_AFTER_FALLBACK_MS;
        counters.nextAllowedAtMs = Math.max(counters.nextAllowedAtMs, this.now() + retryDelayMs);
        if (!inlineRetryUsed && retryDelayMs <= this.maximumInlineRetryDelayMs) {
          inlineRetryUsed = true;
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

  public snapshot(program: CatchUpRpcProgram): CatchUpRpcMetrics {
    const { requestCount, http429Count, retryCount, retryBackoffTotalMs, otherRpcErrors } = this.counters[program];
    return Object.freeze({ requestCount, http429Count, retryCount, retryBackoffTotalMs, otherRpcErrors });
  }

  private async waitForCooldown(counters: MutableMetrics): Promise<void> {
    const remainingMs = Math.max(0, counters.nextAllowedAtMs - this.now());
    if (remainingMs === 0) return;
    counters.retryBackoffTotalMs += remainingMs;
    await this.sleep(remainingMs);
  }
}

function emptyMetrics(): MutableMetrics {
  return {
    requestCount: 0,
    http429Count: 0,
    retryCount: 0,
    retryBackoffTotalMs: 0,
    otherRpcErrors: 0,
    nextAllowedAtMs: 0,
  };
}

function requestProgram(body: unknown): CatchUpRpcProgram | null {
  if (typeof body !== 'string') return null;
  try {
    const request: unknown = JSON.parse(body);
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return null;
    const params = (request as { readonly params?: unknown }).params;
    if (!Array.isArray(params) || typeof params[0] !== 'string') return null;
    return METRIC_PROGRAMS[params[0]] ?? null;
  } catch {
    return null;
  }
}

export function retryAfterMilliseconds(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const milliseconds = Math.ceil(Number(trimmed) * 1_000);
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

export function hasJsonRpcError(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'error' in value && (value as { readonly error?: unknown }).error !== null
    && (value as { readonly error?: unknown }).error !== undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

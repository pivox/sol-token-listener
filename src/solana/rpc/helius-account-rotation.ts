/**
 * Rotation of the listener's Helius accounts behind the `primary` provider
 * (docs/superpowers/specs/2026-10-10-helius-listener-accounts-design.md, 6). Every account is a
 * Helius account: the provider stays `primary`, only the `api-key` of its requests changes. An
 * account whose quota is exhausted (HTTP 429 "max usage reached") or whose key is refused (401,
 * 403) is set aside for the cooldown, and the request is replayed on the next account. A rate
 * limit 429 keeps the current behaviour. Events name an account, never its key.
 */
import type { FetchFn } from '@solana/web3.js';
import { withApiKey, type HeliusAccount } from '../../config/helius-accounts.js';

export type HeliusAccountSetAsideReason = 'QUOTA_EXHAUSTED' | 'KEY_REFUSED';

export type HeliusAccountEvent =
  | Readonly<{ event: 'rpc.helius_account_selected'; account: string; cause: 'STARTUP' | 'SWITCH' }>
  | Readonly<{
    event: 'rpc.helius_account_set_aside';
    account: string;
    reason: HeliusAccountSetAsideReason;
    status: number;
    untilMs: number;
    next: string | null;
    available: number;
  }>
  | Readonly<{ event: 'rpc.helius_accounts_unavailable'; accounts: number; retryAtMs: number }>;

export interface HeliusAccountRotationOptions {
  readonly accounts: readonly HeliusAccount[];
  /** SOLANA_HTTP_RPC_URL: only requests to its origin and path change account. */
  readonly httpUrl: string;
  /** SOLANA_WS_RPC_URL: each new primary WebSocket connection takes the current key. */
  readonly websocketUrl: string;
  readonly cooldownMs: number;
  readonly log: (event: HeliusAccountEvent) => void;
  readonly fetch?: FetchFn;
  readonly now?: () => number;
}

type FetchInput = Parameters<FetchFn>[0];
type FetchInit = Parameters<FetchFn>[1];

const QUOTA_EXHAUSTED = /max usage reached/iu;

export class HeliusAccountRotation {
  /** The base fetch of the listener's HTTP clients: it rewrites and rotates `primary` requests only. */
  readonly fetch: FetchFn;
  readonly #accounts: readonly HeliusAccount[];
  readonly #setAsideUntil: number[];
  readonly #cooldownMs: number;
  readonly #log: (event: HeliusAccountEvent) => void;
  readonly #now: () => number;
  readonly #base: FetchFn;
  readonly #origin: string;
  readonly #pathname: string;
  readonly #websocketUrl: string;
  #index = 0;
  #unavailableUntil = 0;

  public constructor(options: HeliusAccountRotationOptions) {
    if (options.accounts.length === 0) throw new TypeError('Helius account rotation needs one account.');
    if (!Number.isSafeInteger(options.cooldownMs) || options.cooldownMs < 1) {
      throw new TypeError('Helius account cooldown is invalid.');
    }
    const http = new URL(options.httpUrl);
    this.#accounts = options.accounts;
    this.#setAsideUntil = options.accounts.map(() => 0);
    this.#cooldownMs = options.cooldownMs;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#base = options.fetch ?? globalThis.fetch;
    this.#origin = http.origin;
    this.#pathname = http.pathname;
    this.#websocketUrl = new URL(options.websocketUrl).toString();
    this.fetch = (input, init): Promise<Response> => this.#send(input, init);
    this.#log(Object.freeze({
      event: 'rpc.helius_account_selected', account: this.#account(0).name, cause: 'STARTUP',
    }));
  }

  /** The account the next `primary` request uses. */
  get currentAccount(): string {
    return this.#account(this.#select(this.#now())).name;
  }

  /** The primary WebSocket URL with the current account's key, for a new connection. */
  websocketUrl(): string {
    return withApiKey(this.#websocketUrl, this.#account(this.#select(this.#now())).apiKey);
  }

  async #send(input: FetchInput, init: FetchInit): Promise<Response> {
    const target = this.#primaryTarget(input);
    if (target === null) return this.#base(input, init);
    const tried = new Set<number>();
    for (;;) {
      const index = this.#select(this.#now());
      tried.add(index);
      const response = await this.#base(withApiKey(target, this.#account(index).apiKey), init);
      const reason = await setAsideReason(response);
      if (reason === null) return response;
      this.#setAside(index, reason, response.status);
      if (!replayable(init) || tried.has(this.#select(this.#now()))) return response;
      await response.body?.cancel().catch(() => undefined);
    }
  }

  /** The URL of a `primary` request, or null for any other request (a Request object keeps its URL). */
  #primaryTarget(input: FetchInput): string | null {
    let url: URL;
    if (typeof input === 'string') {
      try {
        url = new URL(input);
      } catch {
        return null;
      }
    } else if (input instanceof URL) {
      url = input;
    } else {
      return null;
    }
    return url.origin === this.#origin && url.pathname === this.#pathname ? url.toString() : null;
  }

  /** The current account, moved to the next available one when it is set aside. */
  #select(now: number): number {
    if (this.#until(this.#index) <= now) return this.#index;
    const next = this.#nextAvailable(this.#index, now);
    if (next === null) return this.#index;
    this.#index = next;
    this.#log(Object.freeze({
      event: 'rpc.helius_account_selected', account: this.#account(next).name, cause: 'SWITCH',
    }));
    return next;
  }

  #nextAvailable(from: number, now: number): number | null {
    for (let step = 1; step < this.#accounts.length; step += 1) {
      const index = (from + step) % this.#accounts.length;
      if (this.#until(index) <= now) return index;
    }
    return null;
  }

  #setAside(index: number, reason: HeliusAccountSetAsideReason, status: number): void {
    const now = this.#now();
    // Idempotent within a window: concurrent requests that saw the same answer count once.
    if (this.#until(index) > now) return;
    const untilMs = now + this.#cooldownMs;
    this.#setAsideUntil[index] = untilMs;
    const available = this.#setAsideUntil.filter((until) => until <= now).length;
    const next = this.#nextAvailable(index, now);
    this.#log(Object.freeze({
      event: 'rpc.helius_account_set_aside',
      account: this.#account(index).name,
      reason,
      status,
      untilMs,
      next: next === null ? null : this.#account(next).name,
      available,
    }));
    if (available === 0 && now >= this.#unavailableUntil) {
      this.#unavailableUntil = Math.min(...this.#setAsideUntil);
      this.#log(Object.freeze({
        event: 'rpc.helius_accounts_unavailable',
        accounts: this.#accounts.length,
        retryAtMs: this.#unavailableUntil,
      }));
    }
  }

  #until(index: number): number {
    return this.#setAsideUntil[index] ?? 0;
  }

  #account(index: number): HeliusAccount {
    const account = this.#accounts[index];
    if (account === undefined) throw new TypeError('Helius account index is invalid.');
    return account;
  }
}

async function setAsideReason(response: Response): Promise<HeliusAccountSetAsideReason | null> {
  if (response.status === 401 || response.status === 403) return 'KEY_REFUSED';
  if (response.status !== 429) return null;
  try {
    return QUOTA_EXHAUSTED.test(await response.clone().text()) ? 'QUOTA_EXHAUSTED' : null;
  } catch {
    return null;
  }
}

/** JSON-RPC bodies are strings: a request is replayed only when its body can be sent again. */
function replayable(init: FetchInit): boolean {
  const body = init?.body;
  return body === undefined || body === null || typeof body === 'string';
}

# Helius Listener Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The listener reads an ordered list of Helius accounts from one Vault entry and switches to the next account by itself when the current one is quota-exhausted (HTTP 429 "max usage reached") or refused (401/403).

**Architecture:**
- **Storage:** a multi-field Vault entry `sol/secrets/back/helius-listener-accounts` (account name → API key). `vault-pull` renders it as a compact JSON file, and the distribution gives it to the `listener` user only.
- **Injection:** `sol-run listener` exports:
  - `SOLANA_HTTP_RPC_URL` and `SOLANA_WS_RPC_URL`, built from the first account and from the non-secret addresses `HELIUS_RPC_HTTP_URL` and `HELIUS_RPC_WS_URL`;
  - `LISTENER_HELIUS_ACCOUNTS_PATH`.
- **Rotation in the listener:**
  - A `HeliusAccountRotation` provides the base `fetch` of the RPC provider catalog. It sits under the shared client and under the three pinned sources.
  - It rewrites the `api-key` of `primary` requests only. On exhaustion or refusal it sets the account aside and replays the request on the next account.
  - The catalog resolves the primary WebSocket URL with the current key at each connection attempt.

**Tech Stack:** TypeScript (Node 24, ESM), `@solana/web3.js` 1.99 `Connection` with a custom `fetch`, `node:test` through `tsx --test`, Docker Compose deployment scripts, POSIX sh (`deploy/back/bin/sol`).

**Spec:** `docs/superpowers/specs/2026-10-10-helius-listener-accounts-design.md` (sections cited as « spec N »).

---

## Ground rules for every task

- **Workspace:**
  - Work in `/Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/helius-accounts`, on branch `feat/helius-listener-accounts`.
  - Never touch the main checkout: the live stack of the Mac runs from it.
- **Secrets:** never print or copy a real secret. Tests use obviously fake keys (`key-one`, `listener-key`).
- **Docker:**
  - Do **not** run `npm run deployment:smoke` locally. The Docker Desktop disk of the Mac is 88 % full and is shared with the live stack. The CI job `deployment-contract` runs the smoke.
  - Never start, stop or remove a container you did not create.
- **Tests:**
  - Run a single file with `npx tsx --test tests/<file>.test.ts`. Expected: `# fail 0`.
  - The full backend suite is `npm run test:backend`. Without `TEST_DATABASE_URL`, the PostgreSQL tests skip locally; CI runs them.
- **Lint:** `@typescript-eslint` `strictTypeChecked` is on, so never use the non-null assertion `!`.
- **Commits:** one commit per task, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File structure

| File | Responsibility |
|---|---|
| `src/config/helius-accounts.ts` (new) | Pure rules of the account list. It validates a Vault entry or a pulled file, renders the file, and builds a keyed URL. Shared by deploy and listener. |
| `src/solana/rpc/helius-account-rotation.ts` (new) | Account selector, rotating `fetch` and WebSocket URL. Its events name accounts, never keys. |
| `src/solana/rpc/rpc-provider-catalog.ts` | Optional `fetch` on the catalog, primary WebSocket URL resolved from the rotation, defensive reader `catalogFetch`. |
| `src/solana/rpc/provider-pinned-{catch-up-source,finality-source,block-rpc}.ts` | Base fetch = `catalogFetch(catalog) ?? globalThis.fetch`. |
| `src/config/env.ts` | `LISTENER_HELIUS_ACCOUNTS_PATH` and `LISTENER_HELIUS_ACCOUNT_COOLDOWN_MS`. |
| `src/application/listener-helius-accounts.ts` (new) | Reads the file, builds the rotation, maps events to log levels. |
| `src/application/production-listener-factory.ts` | Creates the rotation, gives it to the catalog and to the shared client. |
| `src/deploy/stack.ts` | `BackSecret` `helius-listener-accounts`, role field `heliusAccounts`, opapi on the executor URL, no `by-mode`, no `wsRpc`. |
| `src/deploy/role-environment.ts` | The listener environment from the account file. |
| `src/deploy/vault-layout.ts` | Renders the accounts entry in `secretValue`. |
| `scripts/deploy/vault-import.ts` | lot5 listener URLs become account `01` plus the two addresses. |
| `scripts/deploy/helius-accounts.ts` (new) | `helius-accounts names <file>`: account names as JSON, never a key. |
| `deploy/back/bin/sol` | `sol helius reload`. |
| `deploy/config/listener.env.example` | `HELIUS_RPC_HTTP_URL`, `HELIUS_RPC_WS_URL`, `LISTENER_HELIUS_ACCOUNT_COOLDOWN_MS`. |
| `scripts/deployment-smoke.mjs` | Import summary, isolation of the accounts file, `HELIUS_RELOAD` phase. |
| `docs/operations/deployment.md` | Section « Comptes Helius du listener », import, example, `sol` table. |
| Tests | `tests/helius-accounts.test.ts`, `tests/helius-account-rotation.test.ts`, `tests/helius-account-wiring.test.ts`, `tests/listener-helius-accounts.test.ts`, `tests/deploy-helius-accounts-cli.test.ts` (new), plus the updated deploy and artifact tests. |

---

### Task 1: Account list rules

**Files:**
- Create: `src/config/helius-accounts.ts`
- Test: `tests/helius-accounts.test.ts`

- [ ] **Step 1: Write the failing test** — create `tests/helius-accounts.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HeliusAccountsError,
  MAX_HELIUS_ACCOUNTS,
  heliusAccountsFromEntry,
  parseHeliusAccountsFile,
  renderHeliusAccounts,
  withApiKey,
} from '../src/config/helius-accounts.js';

const LEAK = 'key-that-must-not-leak';

function refused(action: () => unknown, message: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof HeliusAccountsError);
    assert.equal(error.message, message);
    assert.ok(!error.message.includes(LEAK));
    return true;
  });
}

void test('accounts come sorted by name and frozen, from one field per account', () => {
  const accounts = heliusAccountsFromEntry({ '02-pro': 'key-two', '01-perso': 'key-one' }, 'entry');
  assert.deepEqual(accounts, [
    { name: '01-perso', apiKey: 'key-one' },
    { name: '02-pro', apiKey: 'key-two' },
  ]);
  assert.ok(Object.isFrozen(accounts));
  assert.ok(Object.isFrozen(accounts[0]));
});

void test('a bad name is refused without being shown, since it can hold anything', () => {
  refused(() => heliusAccountsFromEntry({ [LEAK.toUpperCase()]: 'key' }, 'entry'), 'entry: invalid account name');
  refused(() => heliusAccountsFromEntry({ ['a'.repeat(33)]: 'key' }, 'entry'), 'entry: invalid account name');
  refused(() => heliusAccountsFromEntry({ '-first': 'key' }, 'entry'), 'entry: invalid account name');
});

void test('the entry holds 1 to 32 accounts', () => {
  refused(() => heliusAccountsFromEntry({}, 'entry'), `entry: expected 1 to ${String(MAX_HELIUS_ACCOUNTS)} accounts`);
  const entry = (length: number): Record<string, string> => Object.fromEntries(
    Array.from({ length }, (_, index) => [`a${String(index)}`, 'key']),
  );
  refused(() => heliusAccountsFromEntry(entry(33), 'entry'), 'entry: expected 1 to 32 accounts');
  assert.equal(heliusAccountsFromEntry(entry(32), 'entry').length, 32);
});

void test('a key is one printable line without spaces; the message names the account, never the key', () => {
  for (const apiKey of [`${LEAK} x`, `${LEAK}\n`, '', 'x'.repeat(4097), 42, null]) {
    refused(
      () => heliusAccountsFromEntry({ '01-perso': apiKey }, 'entry'),
      'entry: 01-perso must be one printable line without spaces',
    );
  }
});

void test('anything but a plain object is refused', () => {
  for (const data of [null, [], 'text', 7]) {
    refused(() => heliusAccountsFromEntry(data, 'entry'), 'entry: expected one field per account');
  }
});

void test('the pulled file is the compact JSON object of the entry and reads back', () => {
  const accounts = heliusAccountsFromEntry({ b: 'key-b', a: 'key-a' }, 'entry');
  const text = renderHeliusAccounts(accounts);
  assert.equal(text, '{"a":"key-a","b":"key-b"}');
  assert.deepEqual(parseHeliusAccountsFile(text, 'file'), accounts);
});

void test('a file that is not JSON is refused without echoing its text', () => {
  refused(() => parseHeliusAccountsFile(`{${LEAK}`, 'file'), 'file: not a JSON object');
});

void test('withApiKey sets the api-key parameter of a Helius address', () => {
  assert.equal(withApiKey('https://mainnet.helius-rpc.com/', 'k1'), 'https://mainnet.helius-rpc.com/?api-key=k1');
  assert.equal(withApiKey('wss://mainnet.helius-rpc.com/?api-key=old', 'k2'), 'wss://mainnet.helius-rpc.com/?api-key=k2');
});
```

- [ ] **Step 2: Run it.** `npx tsx --test tests/helius-accounts.test.ts`. Expected: FAIL, because the module `src/config/helius-accounts.js` is not found.

- [ ] **Step 3: Implement** — create `src/config/helius-accounts.ts`:

```ts
/**
 * The listener's Helius accounts
 * (docs/superpowers/specs/2026-10-10-helius-listener-accounts-design.md, 5.1): a Vault entry
 * whose fields are account names and whose values are Helius API keys. Pure: no I/O. Messages
 * name an account, never a key.
 */

export const MAX_HELIUS_ACCOUNTS = 32;
const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/u;
/** The rule of every secret file: one printable line without spaces. */
const API_KEY = /^[\x21-\x7e]{1,4096}$/u;

export interface HeliusAccount {
  readonly name: string;
  readonly apiKey: string;
}

export class HeliusAccountsError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'HeliusAccountsError';
  }
}

/** The accounts of a Vault entry or of the pulled file, sorted by name: the failover order. */
export function heliusAccountsFromEntry(data: unknown, label: string): readonly HeliusAccount[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HeliusAccountsError(`${label}: expected one field per account`);
  }
  const record = data as Readonly<Record<string, unknown>>;
  const names = Object.keys(record).sort();
  // Every name is checked first: one that breaks the rule can hold anything, so no message may show it.
  if (!names.every((name) => ACCOUNT_NAME.test(name))) {
    throw new HeliusAccountsError(`${label}: invalid account name`);
  }
  if (names.length === 0 || names.length > MAX_HELIUS_ACCOUNTS) {
    throw new HeliusAccountsError(`${label}: expected 1 to ${String(MAX_HELIUS_ACCOUNTS)} accounts`);
  }
  return Object.freeze(names.map((name): HeliusAccount => {
    const apiKey = record[name];
    if (typeof apiKey !== 'string' || !API_KEY.test(apiKey)) {
      throw new HeliusAccountsError(`${label}: ${name} must be one printable line without spaces`);
    }
    return Object.freeze({ name, apiKey });
  }));
}

/** The pulled file: the compact JSON object of the entry, names sorted. */
export function renderHeliusAccounts(accounts: readonly HeliusAccount[]): string {
  const record: Record<string, string> = {};
  for (const { name, apiKey } of accounts) record[name] = apiKey;
  return JSON.stringify(record);
}

/** The pulled file read back; a parse error never echoes the text. */
export function parseHeliusAccountsFile(text: string, label: string): readonly HeliusAccount[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HeliusAccountsError(`${label}: not a JSON object`);
  }
  return heliusAccountsFromEntry(data, label);
}

/** `baseUrl` with the account's key as its `api-key` parameter: the form of Helius URLs. */
export function withApiKey(baseUrl: string, apiKey: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('api-key', apiKey);
  return url.toString();
}
```

- [ ] **Step 4: Run it.** `npx tsx --test tests/helius-accounts.test.ts`. Expected: PASS (`# fail 0`).

- [ ] **Step 5: Commit**

```bash
git add src/config/helius-accounts.ts tests/helius-accounts.test.ts
git commit -m "feat(listener): Helius account list rules shared by deploy and listener

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Account rotation

**Files:**
- Create: `src/solana/rpc/helius-account-rotation.ts`
- Test: `tests/helius-account-rotation.test.ts`

- [ ] **Step 1: Write the failing test** — create `tests/helius-account-rotation.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FetchFn } from '@solana/web3.js';
import type { HeliusAccount } from '../src/config/helius-accounts.js';
import {
  HeliusAccountRotation,
  type HeliusAccountEvent,
} from '../src/solana/rpc/helius-account-rotation.js';

const HTTP = 'https://rpc.invalid/?api-key=key-one';
const WS = 'wss://rpc.invalid/?api-key=key-one';
const ACCOUNTS: readonly HeliusAccount[] = Object.freeze([
  Object.freeze({ name: '01-one', apiKey: 'key-one' }),
  Object.freeze({ name: '02-two', apiKey: 'key-two' }),
  Object.freeze({ name: '03-three', apiKey: 'key-three' }),
]);
const BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' });
const EXHAUSTED_BODY = '{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"},"id":1}';

const ok = (): Response => new Response('{"jsonrpc":"2.0","id":1,"result":7}', { status: 200 });
const exhausted = (): Response => new Response(EXHAUSTED_BODY, { status: 429 });
const throttled = (): Response => new Response('Too many requests', { status: 429 });

function harness(
  answer: (key: string | null) => Response,
  accounts: readonly HeliusAccount[] = ACCOUNTS,
) {
  let clock = 1_000;
  const events: HeliusAccountEvent[] = [];
  const keys: (string | null)[] = [];
  const urls: string[] = [];
  const fetch: FetchFn = (input) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    keys.push(url.searchParams.get('api-key'));
    return Promise.resolve(answer(url.searchParams.get('api-key')));
  };
  const rotation = new HeliusAccountRotation({
    accounts,
    httpUrl: HTTP,
    websocketUrl: WS,
    cooldownMs: 60_000,
    log: (event) => { events.push(event); },
    fetch,
    now: () => clock,
  });
  return {
    rotation,
    events,
    keys,
    urls,
    advance: (milliseconds: number): void => { clock += milliseconds; },
    request: (url = HTTP): Promise<Response> => rotation.fetch(url, { method: 'POST', body: BODY }),
  };
}

void test('starts on the first account and rewrites the key of primary requests only', async () => {
  const h = harness(() => ok());
  assert.equal(h.rotation.currentAccount, '01-one');
  assert.deepEqual(h.events, [{ event: 'rpc.helius_account_selected', account: '01-one', cause: 'STARTUP' }]);
  await h.request('https://rpc.invalid/?api-key=whatever');
  await h.request('https://fallback.invalid/rpc');
  await h.request('https://rpc.invalid/other-path?api-key=key-one');
  assert.deepEqual(h.urls, [
    'https://rpc.invalid/?api-key=key-one',
    'https://fallback.invalid/rpc',
    'https://rpc.invalid/other-path?api-key=key-one',
  ]);
});

void test('an exhausted account is set aside and the request replays on the next one', async () => {
  const h = harness((key) => (key === 'key-one' ? exhausted() : ok()));
  const response = await h.request();
  assert.equal(response.status, 200);
  assert.deepEqual(h.keys, ['key-one', 'key-two']);
  assert.equal(h.rotation.currentAccount, '02-two');
  assert.deepEqual(h.events.slice(1), [
    {
      event: 'rpc.helius_account_set_aside',
      account: '01-one',
      reason: 'QUOTA_EXHAUSTED',
      status: 429,
      untilMs: 61_000,
      next: '02-two',
      available: 2,
    },
    { event: 'rpc.helius_account_selected', account: '02-two', cause: 'SWITCH' },
  ]);
  await h.request();
  assert.deepEqual(h.keys, ['key-one', 'key-two', 'key-two']);
});

void test('a refused key (401 or 403) is set aside like an exhausted account', async () => {
  for (const status of [401, 403]) {
    const h = harness((key) => (key === 'key-one' ? new Response('', { status }) : ok()));
    assert.equal((await h.request()).status, 200);
    const setAside = h.events.find(({ event }) => event === 'rpc.helius_account_set_aside');
    assert.deepEqual(setAside && 'reason' in setAside ? setAside.reason : null, 'KEY_REFUSED');
    assert.equal(h.rotation.currentAccount, '02-two');
  }
});

void test('a rate-limit 429 is returned as is and keeps the account', async () => {
  const h = harness(() => throttled());
  const response = await h.request();
  assert.equal(response.status, 429);
  assert.equal(await response.text(), 'Too many requests');
  assert.deepEqual(h.keys, ['key-one']);
  assert.equal(h.events.length, 1);
});

void test('when every account is set aside the last answer is returned and logged once per window', async () => {
  const h = harness(() => exhausted());
  const response = await h.request();
  assert.equal(response.status, 429);
  assert.equal(await response.text(), EXHAUSTED_BODY);
  assert.deepEqual(h.keys, ['key-one', 'key-two', 'key-three']);
  const unavailable = (): HeliusAccountEvent[] => h.events.filter(
    ({ event }) => event === 'rpc.helius_accounts_unavailable',
  );
  assert.deepEqual(unavailable(), [{ event: 'rpc.helius_accounts_unavailable', accounts: 3, retryAtMs: 61_000 }]);
  const before = h.events.length;
  await h.request();
  assert.deepEqual(h.keys.slice(3), ['key-three']);
  assert.equal(h.events.length, before);
});

void test('after its cooldown an account is tried again when the current one fails', async () => {
  const exhaustedKeys = new Set(['key-one']);
  const h = harness((key) => (exhaustedKeys.has(String(key)) ? exhausted() : ok()), ACCOUNTS.slice(0, 2));
  await h.request();
  assert.equal(h.rotation.currentAccount, '02-two');
  h.advance(60_000);
  exhaustedKeys.clear();
  exhaustedKeys.add('key-two');
  assert.equal((await h.request()).status, 200);
  assert.deepEqual(h.keys, ['key-one', 'key-two', 'key-two', 'key-one']);
  assert.equal(h.rotation.currentAccount, '01-one');
});

void test('concurrent requests that see the same exhaustion set the account aside once', async () => {
  const h = harness((key) => (key === 'key-one' ? exhausted() : ok()));
  const responses = await Promise.all([h.request(), h.request(), h.request()]);
  assert.deepEqual(responses.map(({ status }) => status), [200, 200, 200]);
  assert.equal(h.events.filter(({ event }) => event === 'rpc.helius_account_set_aside').length, 1);
  assert.equal(h.keys.filter((key) => key === 'key-two').length, 3);
});

void test('a new WebSocket connection takes the key of the current account', async () => {
  const h = harness((key) => (key === 'key-one' ? exhausted() : ok()));
  assert.equal(h.rotation.websocketUrl(), 'wss://rpc.invalid/?api-key=key-one');
  await h.request();
  assert.equal(h.rotation.websocketUrl(), 'wss://rpc.invalid/?api-key=key-two');
});

void test('a request whose body cannot be replayed sets the account aside without a replay', async () => {
  const h = harness((key) => (key === 'key-one' ? exhausted() : ok()));
  const response = await h.rotation.fetch(HTTP, { method: 'POST', body: new Uint8Array([1]) });
  assert.equal(response.status, 429);
  assert.deepEqual(h.keys, ['key-one']);
  assert.equal(h.rotation.currentAccount, '02-two');
});

void test('no event carries a key', async () => {
  const h = harness(() => exhausted());
  await h.request();
  const text = JSON.stringify(h.events);
  for (const { apiKey } of ACCOUNTS) assert.ok(!text.includes(apiKey));
});
```

- [ ] **Step 2: Run it.** `npx tsx --test tests/helius-account-rotation.test.ts`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement** — create `src/solana/rpc/helius-account-rotation.ts`:

```ts
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
    this.fetch = (input, init) => this.#send(input, init);
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
```

- [ ] **Step 4: Run it.** `npx tsx --test tests/helius-account-rotation.test.ts`. Expected: PASS. Then run `npx eslint src/solana/rpc/helius-account-rotation.ts tests/helius-account-rotation.test.ts --max-warnings=0`. Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/solana/rpc/helius-account-rotation.ts tests/helius-account-rotation.test.ts
git commit -m "feat(listener): Helius account rotation behind the primary provider

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Catalog and pinned sources use the rotation

**Files:**
- Modify: `src/solana/rpc/rpc-provider-catalog.ts`
- Modify: `src/solana/rpc/provider-pinned-catch-up-source.ts:69-70, 194-212, 269-276`
- Modify: `src/solana/rpc/provider-pinned-finality-source.ts:61-62, 104-120, 180-183`
- Modify: `src/solana/rpc/provider-pinned-block-rpc.ts:64-71, 234-249`
- Test: `tests/helius-account-wiring.test.ts`

- [ ] **Step 1: Write the failing test** — create `tests/helius-account-wiring.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FetchFn } from '@solana/web3.js';
import { HeliusAccountRotation } from '../src/solana/rpc/helius-account-rotation.js';
import { createProviderPinnedBlockRpc } from '../src/solana/rpc/provider-pinned-block-rpc.js';
import { createProviderPinnedCatchUpSource } from '../src/solana/rpc/provider-pinned-catch-up-source.js';
import { createProviderPinnedFinalityPass } from '../src/solana/rpc/provider-pinned-finality-source.js';
import { SolanaRpcClient } from '../src/solana/rpc/rpc-client.js';
import { createRpcHttpEvidenceRecorder } from '../src/solana/rpc/rpc-http-evidence.js';
import { catalogFetch, createRpcProviderCatalog } from '../src/solana/rpc/rpc-provider-catalog.js';

const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const CONFIG = Object.freeze({
  httpRpcUrl: 'https://rpc.invalid/?api-key=key-one',
  httpRpcFallbackUrls: Object.freeze([]),
  wsRpcUrl: 'wss://rpc.invalid/?api-key=key-one',
  wsRpcFallbackUrls: Object.freeze([]),
});
const GET_SLOT = '{"jsonrpc":"2.0","id":1,"method":"getSlot"}';

/** A Helius stand-in: key-one is exhausted, key-two answers getGenesisHash, getSlot and null otherwise. */
function setup() {
  const keys: string[] = [];
  const fetch: FetchFn = (input, init) => {
    const key = new URL(String(input)).searchParams.get('api-key') ?? '';
    keys.push(key);
    if (key === 'key-one') return Promise.resolve(new Response('max usage reached', { status: 429 }));
    const request = JSON.parse(String(init?.body)) as { readonly id: unknown; readonly method: string };
    const result = request.method === 'getGenesisHash' ? GENESIS : request.method === 'getSlot' ? 42 : null;
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 }));
  };
  const rotation = new HeliusAccountRotation({
    accounts: [{ name: '01-one', apiKey: 'key-one' }, { name: '02-two', apiKey: 'key-two' }],
    httpUrl: CONFIG.httpRpcUrl,
    websocketUrl: CONFIG.wsRpcUrl,
    cooldownMs: 60_000,
    log: () => undefined,
    fetch,
  });
  return { rotation, keys, catalog: createRpcProviderCatalog(CONFIG, rotation) };
}

void test('the catalog carries the rotation fetch and resolves the WebSocket URL with the current key', async () => {
  const { rotation, catalog } = setup();
  assert.equal(catalogFetch(catalog), rotation.fetch);
  assert.equal(catalog.resolve('primary').websocketUrl, 'wss://rpc.invalid/?api-key=key-one');
  await rotation.fetch(CONFIG.httpRpcUrl, { method: 'POST', body: GET_SLOT });
  assert.equal(catalog.resolve('primary').websocketUrl, 'wss://rpc.invalid/?api-key=key-two');
  assert.equal(catalog.resolve('primary').httpUrl, CONFIG.httpRpcUrl);
  assert.ok(Object.isFrozen(catalog.resolve('primary')));
});

void test('a catalog without rotation has no fetch and keeps its URLs', () => {
  const catalog = createRpcProviderCatalog(CONFIG);
  assert.equal(catalogFetch(catalog), undefined);
  assert.equal(catalog.resolve('primary').websocketUrl, CONFIG.wsRpcUrl);
});

void test('catalogFetch refuses a fetch that is not an own data function', () => {
  const resolve = (): unknown => Object.freeze({ id: 'primary', httpUrl: CONFIG.httpRpcUrl, websocketUrl: CONFIG.wsRpcUrl });
  assert.throws(() => catalogFetch({ ids: ['primary'], resolve, fetch: 'x' } as never), TypeError);
  const withGetter = Object.defineProperty({ ids: ['primary'], resolve }, 'fetch', {
    get: () => globalThis.fetch, enumerable: true,
  });
  assert.throws(() => catalogFetch(withGetter as never), TypeError);
});

void test('the pinned catch-up source sends through the catalog fetch, with or without a recorder', async () => {
  for (const recorder of [undefined, createRpcHttpEvidenceRecorder()]) {
    const { catalog, keys } = setup();
    const source = createProviderPinnedCatchUpSource(catalog, 'primary', 'confirmed', GENESIS, undefined, recorder);
    await source.verifyGenesis(new AbortController().signal);
    assert.deepEqual(keys, ['key-one', 'key-two']);
  }
});

void test('the pinned finality pass sends through the catalog fetch, with or without a recorder', async () => {
  for (const recorder of [undefined, createRpcHttpEvidenceRecorder()]) {
    const { catalog, keys } = setup();
    const pass = createProviderPinnedFinalityPass(catalog, 'primary', undefined, recorder);
    await pass.getFinalizedSlot();
    assert.deepEqual(keys, ['key-one', 'key-two']);
  }
});

void test('the pinned block RPC sends through the catalog fetch, with or without a recorder', async () => {
  for (const recorder of [undefined, createRpcHttpEvidenceRecorder()]) {
    const { catalog, keys } = setup();
    const blocks = createProviderPinnedBlockRpc(catalog, 'primary', 'confirmed', undefined, { requestTimeoutMs: 5_000 }, recorder);
    try {
      await blocks.getBlockTransactions(12n, 'CONFIRMED');
    } catch {
      // A null block may be refused; only the key of each request matters here.
    }
    assert.deepEqual(keys.slice(0, 2), ['key-one', 'key-two']);
  }
});

void test('the shared client sends through the rotation fetch', async () => {
  const { rotation, keys } = setup();
  const client = new SolanaRpcClient(
    { ...CONFIG, commitment: 'confirmed', finality: 'finalized' },
    { fetch: rotation.fetch },
  );
  assert.equal(await client.getSlot(), 42n);
  assert.deepEqual(keys, ['key-one', 'key-two']);
});
```

- [ ] **Step 2: Run it.** `npx tsx --test tests/helius-account-wiring.test.ts`. Expected: FAIL. `catalogFetch` is not exported, and `createRpcProviderCatalog` ignores its second argument. The shared-client test may already pass, since `SolanaRpcClient` accepts `dependencies.fetch`.

- [ ] **Step 3: Implement the catalog** — edit `src/solana/rpc/rpc-provider-catalog.ts`.

Add at the top:

```ts
import type { FetchFn } from '@solana/web3.js';
```

Replace the `RpcProviderCatalog` interface with:

```ts
/** What the catalog needs from the Helius account rotation (helius-account-rotation.ts). */
export interface RpcAccountRotation {
  readonly fetch: FetchFn;
  websocketUrl(): string;
}

export interface RpcProviderCatalog {
  readonly ids: readonly RpcProviderId[];
  /** Base fetch of every listener HTTP client: the Helius account rotation, when configured. */
  readonly fetch?: FetchFn;
  resolve(id: RpcProviderId): RpcProviderPair;
}
```

Change the signature to:

```ts
export function createRpcProviderCatalog(
  config: RpcProviderCatalogConfig,
  rotation?: RpcAccountRotation,
): RpcProviderCatalog {
```

Replace the returned object with:

```ts
  return Object.freeze({
    ids,
    ...(rotation === undefined ? {} : { fetch: rotation.fetch }),
    resolve(id: RpcProviderId): RpcProviderPair {
      const value = byId.get(id);
      if (value === undefined) throw invalidCatalog();
      // A new primary WebSocket connection takes the key of the current Helius account.
      if (rotation === undefined || id !== 'primary') return value;
      return pair('primary', value.httpUrl, rotation.websocketUrl());
    },
  });
```

Add after `createRpcProviderCatalog`:

```ts
/** The catalog's base fetch, read as an own data property: no getter, no proxy trap. */
export function catalogFetch(catalog: RpcProviderCatalog): FetchFn | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(catalog, 'fetch');
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor) || typeof descriptor.value !== 'function') throw invalidCatalog();
  return descriptor.value as FetchFn;
}
```

- [ ] **Step 4: Implement the pinned catch-up source** — edit `src/solana/rpc/provider-pinned-catch-up-source.ts`.

Import `catalogFetch` next to `RpcProviderCatalog` from `./rpc-provider-catalog.js`. Make sure `FetchFn` is imported from `@solana/web3.js`; it is already used by `createDefaultRpc`.

In `createProviderPinnedCatchUpSource`, replace:

```ts
  const createRpc = dependencyFactory(dependencies, exposedProviderId, providerId, recorder, roleRecorder,
    attemptBudget, requestTimeoutMs);
```

with:

```ts
  const createRpc = dependencyFactory(dependencies, exposedProviderId, providerId, recorder, roleRecorder,
    attemptBudget, requestTimeoutMs, pinnedBaseFetch(catalog, exposedProviderId));
```

Replace the head of `dependencyFactory`, up to and including the `return (httpUrl: string, commitment: Commitment) …` block, with:

```ts
function dependencyFactory(
  dependencies: ProviderPinnedCatchUpSourceDependencies | undefined,
  providerId: RpcProviderId | null,
  selectedProviderId: RpcProviderId,
  recorder: RpcHttpEvidenceRecorder | undefined,
  roleRecorder: RpcHttpRoleEvidenceRecorder | undefined,
  attemptBudget: OrdinaryRpcAttemptBudget | undefined,
  requestTimeoutMs: number,
  baseFetch: FetchFn | undefined,
): (httpUrl: string, commitment: Commitment) => unknown {
  if (dependencies === undefined) {
    if (recorder === undefined && roleRecorder === undefined && attemptBudget === undefined) {
      return baseFetch === undefined
        ? createDefaultRpc
        : (httpUrl: string, commitment: Commitment): PinnedCatchUpRpc => createDefaultRpc(httpUrl, commitment, baseFetch);
    }
    const observedFetch = createObservedRpcFetch(
      selectedProviderId, recorder, baseFetch ?? globalThis.fetch, roleRecorder, 'SOURCE', attemptBudget,
    );
```

The rest of the function stays as it is. Then add at the end of the file:

```ts
/** The catalog's base fetch (the Helius account rotation) or undefined; a malformed catalog is CONFIG_INVALID. */
function pinnedBaseFetch(catalog: RpcProviderCatalog, providerId: RpcProviderId | null): FetchFn | undefined {
  try {
    return catalogFetch(catalog);
  } catch {
    throw failure('CONFIG_INVALID', providerId);
  }
}
```

- [ ] **Step 5: Implement the pinned finality source** — edit `src/solana/rpc/provider-pinned-finality-source.ts`. Make the same three changes as in Step 4:
  - pass `pinnedBaseFetch(catalog, exposedProviderId)` as the new last argument of `dependencyFactory`;
  - add `baseFetch: FetchFn | undefined` as its last parameter;
  - add the `pinnedBaseFetch` helper.

  The no-observer branch becomes:

```ts
    if (recorder === undefined && roleRecorder === undefined && attemptBudget === undefined) {
      return baseFetch === undefined
        ? createDefaultRpc
        : (httpUrl: string): Connection => createDefaultRpc(httpUrl, baseFetch);
    }
    const observedFetch = createObservedRpcFetch(
      selectedProviderId, recorder, baseFetch ?? globalThis.fetch, roleRecorder, 'FINALITY', attemptBudget,
    );
```

- [ ] **Step 6: Implement the pinned block RPC** — edit `src/solana/rpc/provider-pinned-block-rpc.ts`.
  - Import `catalogFetch`.
  - In `createProviderPinnedBlockRpc`, after `const requestContext = …`, add:

```ts
  let baseFetch: FetchFn;
  try {
    baseFetch = catalogFetch(catalog) ?? globalThis.fetch;
  } catch {
    throw failure('CONFIG_INVALID', exposedProviderId);
  }
```

  - In the `observedFetch` initialiser, replace `globalThis.fetch` with `baseFetch`.
  - Pass `baseFetch` to `createDefaultConnection`: `createDefaultConnection(url, selected, requestContext, observedFetch, baseFetch)`.
  - In `createDefaultConnection`, add the parameter `baseFetch: FetchFn` after `observedFetch`, and replace `return fetch(input, { ...init, signal });` with `return baseFetch(input, { ...init, signal });`.

- [ ] **Step 7: Run the tests.**
  - `npx tsx --test tests/helius-account-wiring.test.ts tests/rpc-provider-catalog.test.ts tests/provider-pinned-catch-up-source.test.ts tests/provider-pinned-finality-source.test.ts tests/provider-pinned-block-rpc.test.ts tests/provider-pinned-block-cancellation.test.ts tests/rpc-client.test.ts`. Expected: PASS.
  - `npx eslint src/solana/rpc tests/helius-account-wiring.test.ts --max-warnings=0`. Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/solana/rpc tests/helius-account-wiring.test.ts
git commit -m "feat(listener): RPC catalog carries the Helius account rotation to every primary client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Listener configuration and factory wiring

**Files:**
- Modify: `src/config/env.ts`. Fields go after `listenerShutdownTimeoutMs` (line 87); parsing goes after `listenerShutdownTimeoutMs: parseInteger(…)` (line 399).
- Create: `src/application/listener-helius-accounts.ts`
- Modify: `src/application/production-listener-factory.ts:283` and `:297-305`
- Test: `tests/listener-helius-accounts.test.ts`

- [ ] **Step 1: Write the failing test** — create `tests/listener-helius-accounts.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import bs58 from 'bs58';
import type { FetchFn } from '@solana/web3.js';
import { parseConfig } from '../src/config/env.js';
import { HeliusAccountsError } from '../src/config/helius-accounts.js';
import {
  createListenerHeliusAccountRotation,
  heliusAccountLogLevel,
} from '../src/application/listener-helius-accounts.js';
import type { HeliusAccountEvent } from '../src/solana/rpc/helius-account-rotation.js';

const base = {
  SOLANA_HTTP_RPC_URL: 'https://rpc.invalid/?api-key=key-one',
  SOLANA_WS_RPC_URL: 'wss://rpc.invalid/?api-key=key-one',
  SOLANA_EXPECTED_GENESIS_HASH: bs58.encode(Uint8Array.from({ length: 32 }, () => 7)),
};

void test('the account file path is optional and the cooldown defaults to one hour', () => {
  const defaults = parseConfig(base);
  assert.equal(defaults.listenerHeliusAccountsPath, null);
  assert.equal(defaults.listenerHeliusAccountCooldownMs, 3_600_000);
  const set = parseConfig({
    ...base,
    LISTENER_HELIUS_ACCOUNTS_PATH: '/run/sol/listener/helius-listener-accounts',
    LISTENER_HELIUS_ACCOUNT_COOLDOWN_MS: '60000',
  });
  assert.equal(set.listenerHeliusAccountsPath, '/run/sol/listener/helius-listener-accounts');
  assert.equal(set.listenerHeliusAccountCooldownMs, 60_000);
});

void test('a relative account path and an out-of-range cooldown are refused', () => {
  assert.throws(() => parseConfig({ ...base, LISTENER_HELIUS_ACCOUNTS_PATH: 'accounts.json' }),
    /LISTENER_HELIUS_ACCOUNTS_PATH must be an absolute path/u);
  assert.throws(() => parseConfig({ ...base, LISTENER_HELIUS_ACCOUNT_COOLDOWN_MS: '59999' }),
    /LISTENER_HELIUS_ACCOUNT_COOLDOWN_MS/u);
  assert.throws(() => parseConfig({ ...base, LISTENER_HELIUS_ACCOUNT_COOLDOWN_MS: '86400001' }),
    /LISTENER_HELIUS_ACCOUNT_COOLDOWN_MS/u);
});

void test('without an account file there is no rotation', () => {
  assert.equal(createListenerHeliusAccountRotation(parseConfig(base)), undefined);
});

void test('the rotation reads the file, starts on the first account and switches on exhaustion', async () => {
  const config = parseConfig({ ...base, LISTENER_HELIUS_ACCOUNTS_PATH: '/run/sol/listener/helius-listener-accounts' });
  const events: HeliusAccountEvent[] = [];
  const keys: (string | null)[] = [];
  const fetch: FetchFn = (input) => {
    const key = new URL(String(input)).searchParams.get('api-key');
    keys.push(key);
    return Promise.resolve(key === 'key-one'
      ? new Response('max usage reached', { status: 429 })
      : new Response('{"jsonrpc":"2.0","id":1,"result":1}', { status: 200 }));
  };
  const rotation = createListenerHeliusAccountRotation(config, {
    readFile: (path) => {
      assert.equal(path, '/run/sol/listener/helius-listener-accounts');
      return '{"02-two":"key-two","01-one":"key-one"}';
    },
    log: (event) => { events.push(event); },
    fetch,
  });
  assert.ok(rotation !== undefined);
  assert.equal(rotation.currentAccount, '01-one');
  await rotation.fetch(config.httpRpcUrl, { method: 'POST', body: '{}' });
  assert.deepEqual(keys, ['key-one', 'key-two']);
  assert.equal(rotation.currentAccount, '02-two');
  assert.deepEqual(events.map(({ event }) => event), [
    'rpc.helius_account_selected', 'rpc.helius_account_set_aside', 'rpc.helius_account_selected',
  ]);
});

void test('an invalid file stops the listener without showing a key', () => {
  const config = parseConfig({ ...base, LISTENER_HELIUS_ACCOUNTS_PATH: '/run/sol/listener/helius-listener-accounts' });
  assert.throws(
    () => createListenerHeliusAccountRotation(config, { readFile: () => '{"01-one":"key with space"}', log: () => undefined }),
    (error: unknown) => error instanceof HeliusAccountsError && !error.message.includes('key with space'),
  );
});

void test('events map to info, warn and error', () => {
  assert.equal(heliusAccountLogLevel({ event: 'rpc.helius_account_selected', account: 'a', cause: 'STARTUP' }), 'info');
  assert.equal(heliusAccountLogLevel({
    event: 'rpc.helius_account_set_aside', account: 'a', reason: 'QUOTA_EXHAUSTED', status: 429, untilMs: 1, next: null, available: 0,
  }), 'warn');
  assert.equal(heliusAccountLogLevel({ event: 'rpc.helius_accounts_unavailable', accounts: 1, retryAtMs: 1 }), 'error');
});
```

- [ ] **Step 2: Run it.** `npx tsx --test tests/listener-helius-accounts.test.ts`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Add the configuration** — edit `src/config/env.ts`.

In `AppConfig`, after `readonly listenerShutdownTimeoutMs: number;`, add:

```ts
  /** The Helius account list the stack's sol-run gives the listener; null outside the stack. */
  readonly listenerHeliusAccountsPath: string | null;
  /** How long an exhausted or refused Helius account is set aside. */
  readonly listenerHeliusAccountCooldownMs: number;
```

In the returned object of `parseConfig`, after the `listenerShutdownTimeoutMs: parseInteger(…),` property, add:

```ts
    listenerHeliusAccountsPath: parseHeliusAccountsPath(environment.LISTENER_HELIUS_ACCOUNTS_PATH),
    listenerHeliusAccountCooldownMs: parseInteger(
      environment.LISTENER_HELIUS_ACCOUNT_COOLDOWN_MS,
      3_600_000,
      'LISTENER_HELIUS_ACCOUNT_COOLDOWN_MS',
      60_000,
      86_400_000,
    ),
```

Add next to `parseOptionalBigInt`:

```ts
function parseHeliusAccountsPath(raw: string | undefined): string | null {
  if (!hasValue(raw)) return null;
  if (!raw.startsWith('/')) throw new Error('LISTENER_HELIUS_ACCOUNTS_PATH must be an absolute path.');
  return raw;
}
```

`hasValue` already exists in this file. Check that it narrows `raw` to `string`; if it does not, write `raw === undefined || raw === ''` instead.

- [ ] **Step 4: Create the loader** — create `src/application/listener-helius-accounts.ts`:

```ts
import { readFileSync } from 'node:fs';
import type { FetchFn } from '@solana/web3.js';
import type { AppConfig } from '../config/env.js';
import { parseHeliusAccountsFile } from '../config/helius-accounts.js';
import {
  HeliusAccountRotation,
  type HeliusAccountEvent,
} from '../solana/rpc/helius-account-rotation.js';
import { logger } from '../utils/logger.js';

type RotationConfig = Pick<
  AppConfig,
  'listenerHeliusAccountsPath' | 'listenerHeliusAccountCooldownMs' | 'httpRpcUrl' | 'wsRpcUrl'
>;

export interface ListenerHeliusAccountDependencies {
  readonly readFile?: (path: string) => string;
  readonly log?: (event: HeliusAccountEvent) => void;
  readonly fetch?: FetchFn;
  readonly now?: () => number;
}

/**
 * The listener's Helius account rotation (docs/superpowers/specs/2026-10-10-helius-listener-accounts-design.md,
 * 6), or undefined outside the stack, where no LISTENER_HELIUS_ACCOUNTS_PATH is set. An invalid
 * file stops the start: the error names an account, never a key.
 */
export function createListenerHeliusAccountRotation(
  config: RotationConfig,
  dependencies: ListenerHeliusAccountDependencies = {},
): HeliusAccountRotation | undefined {
  if (config.listenerHeliusAccountsPath === null) return undefined;
  const readFile = dependencies.readFile ?? ((path: string): string => readFileSync(path, 'utf8'));
  const accounts = parseHeliusAccountsFile(
    readFile(config.listenerHeliusAccountsPath),
    'LISTENER_HELIUS_ACCOUNTS_PATH',
  );
  return new HeliusAccountRotation({
    accounts,
    httpUrl: config.httpRpcUrl,
    websocketUrl: config.wsRpcUrl,
    cooldownMs: config.listenerHeliusAccountCooldownMs,
    log: dependencies.log ?? logHeliusAccountEvent,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}

export function heliusAccountLogLevel(event: HeliusAccountEvent): 'info' | 'warn' | 'error' {
  switch (event.event) {
    case 'rpc.helius_account_selected': return 'info';
    case 'rpc.helius_account_set_aside': return 'warn';
    case 'rpc.helius_accounts_unavailable': return 'error';
  }
}

const MESSAGES: Readonly<Record<HeliusAccountEvent['event'], string>> = Object.freeze({
  'rpc.helius_account_selected': 'Compte Helius du listener sélectionné.',
  'rpc.helius_account_set_aside': 'Compte Helius du listener mis à l’écart.',
  'rpc.helius_accounts_unavailable': 'Tous les comptes Helius du listener sont à l’écart.',
});

export function logHeliusAccountEvent(event: HeliusAccountEvent): void {
  logger[heliusAccountLogLevel(event)](event, MESSAGES[event.event]);
}
```

- [ ] **Step 5: Wire the factory** — edit `src/application/production-listener-factory.ts`.
  - Add the import `import { createListenerHeliusAccountRotation } from './listener-helius-accounts.js';`.
  - Replace `const providers = createRpcProviderCatalog(config);` with:

```ts
  // One rotation per listener process: every primary client and the WebSocket share it.
  const heliusAccounts = createListenerHeliusAccountRotation(config);
  const providers = createRpcProviderCatalog(config, heliusAccounts);
```

  - In `new SolanaRpcClient(config, { … })`, add as the first property:

```ts
    ...(heliusAccounts === undefined ? {} : { fetch: heliusAccounts.fetch }),
```

- [ ] **Step 6: Run the tests.**
  - `npx tsx --test tests/listener-helius-accounts.test.ts tests/config-safety.test.ts tests/production-listener-factory.test.ts`. Expected: PASS.
  - `npm run build:backend`. Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/config/env.ts src/application/listener-helius-accounts.ts src/application/production-listener-factory.ts tests/listener-helius-accounts.test.ts
git commit -m "feat(listener): read the Helius account list and rotate accounts in production

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Stack layout, role environment and pulled file

**Files:**
- Modify: `src/deploy/stack.ts`: `BackSecret`, `RoleDefinition`, `ROLE_TABLE` listener and opapi, `resolveHttpRpc`, `roleSecretFiles`.
- Modify: `src/deploy/secret-distribution.ts`: call `roleSecretFiles(role)`.
- Modify: `src/deploy/role-environment.ts`
- Modify: `src/deploy/vault-layout.ts`: `secretValue`.
- Modify tests: `tests/deploy-stack.test.ts`, `tests/deploy-role-environment.test.ts`, `tests/deploy-secret-distribution.test.ts`, `tests/deploy-vault-layout.test.ts`, `tests/deploy-vault-pull.test.ts`.

- [ ] **Step 1: Write the failing tests.**

In `tests/deploy-role-environment.test.ts`:
- In `SECRETS`, replace the two `/run/sol/listener/helius-listener-*-url` entries with `'/run/sol/listener/helius-listener-accounts': '{"01-main":"listener-key","02-spare":"spare-key"}'`.
- Remove `'/run/sol/opapi/helius-listener-http-url'`.
- Make the existing listener test assert:

```ts
  assert.equal(environment.SOLANA_HTTP_RPC_URL, 'https://mainnet.helius-rpc.com/?api-key=listener-key');
  assert.equal(environment.SOLANA_WS_RPC_URL, 'wss://mainnet.helius-rpc.com/?api-key=listener-key');
  assert.equal(environment.LISTENER_HELIUS_ACCOUNTS_PATH, '/run/sol/listener/helius-listener-accounts');
```

Replace the opapi observe/live test (around line 82) so that both modes give `https://executor.invalid/?api-key=executor-key`. Then add:

```ts
void test('the listener takes its Helius addresses from the configuration, without a key there', () => {
  const environment = build('listener', 'HELIUS_RPC_HTTP_URL=https://rpc.invalid/\nHELIUS_RPC_WS_URL=wss://rpc.invalid/\n');
  assert.equal(environment.SOLANA_HTTP_RPC_URL, 'https://rpc.invalid/?api-key=listener-key');
  assert.equal(environment.SOLANA_WS_RPC_URL, 'wss://rpc.invalid/?api-key=listener-key');
  assert.throws(() => build('listener', 'HELIUS_RPC_WS_URL=https://rpc.invalid/\n'),
    (error: unknown) => error instanceof RoleEnvironmentError && error.message === 'HELIUS_RPC_WS_URL: expected a wss URL');
  assert.throws(() => build('listener', `HELIUS_RPC_HTTP_URL=https://rpc.invalid/?api-key=${LEAK}\n`),
    (error: unknown) => error instanceof RoleEnvironmentError && !error.message.includes(LEAK));
});

void test('the configuration never sets the account file path', () => {
  assert.throws(() => build('listener', 'LISTENER_HELIUS_ACCOUNTS_PATH=/tmp/x\n'),
    (error: unknown) => error instanceof RoleEnvironmentError
      && error.message === 'listener.env: LISTENER_HELIUS_ACCOUNTS_PATH comes from a secret file, not from the configuration');
});

void test('an invalid account file stops the listener without showing a key', () => {
  const environment = (text: string): unknown => buildRoleEnvironment({
    role: 'listener', mode: 'live', databaseName: 'sol_token_listener', configText: '', overrideText: null,
    runDirectory: '/run/sol',
    readSecret: (path) => (path.endsWith('/helius-listener-accounts') ? text : SECRETS[path] ?? ''),
    secretExists: () => true,
  });
  assert.throws(() => environment(`{"01-main":"${LEAK} x"}`), (error: unknown) => error instanceof RoleEnvironmentError
    && error.message === 'helius-listener-accounts: 01-main must be one printable line without spaces');
  assert.throws(() => environment(`{${LEAK}`), (error: unknown) => error instanceof RoleEnvironmentError
    && error.message === 'helius-listener-accounts: not a JSON object');
});
```

In `tests/deploy-stack.test.ts`, replace the test `RPC projects: listener for the listener, by mode for opapi, none for the operations CLI` and the `resolveHttpRpc` import with:

```ts
void test('RPC: the account list for the listener only, the executor project for opapi and the executors', () => {
  assert.equal(ROLES.listener.heliusAccounts, 'helius-listener-accounts');
  assert.equal(ROLES.listener.httpRpc, undefined);
  assert.equal(ROLES.opapi.httpRpc, 'helius-executor-http-url');
  assert.equal(ROLES.h2b.httpRpc, 'helius-executor-http-url');
  assert.equal(ROLES.operations.httpRpc, undefined);
  for (const name of ROLE_NAMES) {
    if (name !== 'listener') assert.equal(ROLES[name].heliusAccounts, undefined, name);
  }
});
```

Import `ROLE_NAMES` if the file does not already. Update every `roleSecretFiles(role, mode)` call in the tests to `roleSecretFiles(role)`.

In `tests/deploy-secret-distribution.test.ts`:
- Every listener grant list goes from `'back/helius-listener-http-url', 'back/helius-listener-ws-url', 'logins/pg-sol_listener-password'` to `'back/helius-listener-accounts', 'logins/pg-sol_listener-password'`.
- The observe grants go from `'listener:helius-listener-http-url', 'listener:helius-listener-ws-url'` to `'listener:helius-listener-accounts'`, and from `'opapi:helius-listener-http-url'` to `'opapi:helius-executor-http-url'`, re-sorted.
- In the fake source tree, replace `/s/back/helius-listener-http-url` and `/s/back/helius-listener-ws-url` with `/s/back/helius-listener-accounts`.
- The copy assertion becomes `'copy /s/back/helius-executor-http-url /r/opapi/helius-executor-http-url'`.
- Add the assertion that no other user receives the accounts file:

```ts
void test('only the listener user receives the Helius account list, in both modes', () => {
  for (const mode of ['observe', 'live'] as const) {
    const holders = secretGrants(mode).filter(({ file }) => file === 'helius-listener-accounts').map(({ user }) => user);
    assert.deepEqual(holders, ['listener']);
  }
});
```

In `tests/deploy-vault-layout.test.ts`:
- In the observe entries, `secrets/back/helius-executor-http-url` becomes required (`true`), because opapi reads it.
- `secrets/back/helius-listener-http-url` and `-ws-url` become one entry, `['secrets/back/helius-listener-accounts', true]`.
- Add:

```ts
void test('the Helius account entry renders as its compact JSON file and refuses a bad entry without a key', () => {
  assert.equal(
    secretValue('secrets/back/helius-listener-accounts', { '02-spare': 'key-spare', '01-main': 'key-main' }),
    '{"01-main":"key-main","02-spare":"key-spare"}',
  );
  assert.throws(() => secretValue('secrets/back/helius-listener-accounts', { value: 'k' }),
    (error: unknown) => error instanceof VaultLayoutError && error.message === 'secrets/back/helius-listener-accounts: invalid account name');
  assert.throws(() => secretValue('secrets/back/helius-listener-accounts', { '01-main': 'leak me' }),
    (error: unknown) => error instanceof VaultLayoutError && !error.message.includes('leak me'));
});
```

In `tests/deploy-vault-pull.test.ts`, `seededVault()` gives the accounts entry a map:

```ts
    vault.kv.set(entry.path, entry.kind === 'config'
      ? { LOG_LEVEL: 'info' }
      : entry.path === 'secrets/back/helius-listener-accounts'
        ? { '01-main': 'value-of-main' }
        : { value: `value-of-${entry.path}` });
```

Then add:

```ts
void test('the listener accounts entry becomes its compact JSON file, names sorted', async () => {
  const vault = seededVault();
  vault.kv.set('secrets/back/helius-listener-accounts', { '02-spare': 'key-spare', '01-main': 'key-main' });
  const run = await pull(vault, ['back', 'live'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.files.get('/root/secrets/back/helius-listener-accounts'), {
    content: '{"01-main":"key-main","02-spare":"key-spare"}', mode: 0o600,
  });
});

void test('an invalid accounts entry stops the pull with 78, writes nothing and shows no key', async () => {
  const vault = seededVault();
  vault.kv.set('secrets/back/helius-listener-accounts', { '01-main': 'key with space' });
  const run = await pull(vault, ['back', 'live'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 78);
  assert.equal(run.stderr, 'vault-pull: secrets/back/helius-listener-accounts: 01-main must be one printable line without spaces\n');
  assert.equal(run.files.size, 0);
});
```

- [ ] **Step 2: Run them.** `npx tsx --test tests/deploy-stack.test.ts tests/deploy-role-environment.test.ts tests/deploy-secret-distribution.test.ts tests/deploy-vault-layout.test.ts tests/deploy-vault-pull.test.ts`. Expected: FAIL, on the new names and on the opapi URL.

- [ ] **Step 3: Implement `src/deploy/stack.ts`.**

Replace the `BackSecret` union with:

```ts
/** Secret files of the back container, besides the login passwords (spec 7.1, Helius accounts spec 5). */
export type BackSecret =
  | 'helius-listener-accounts'
  | 'helius-executor-http-url'
  | 'helius-admin-api-key'
  | 'evidence-private-key'
  | 'wallet-keypair.json'
  | 'operator-api-token';
```

In `RoleDefinition`, replace the `httpRpc` and `wsRpc` fields with:

```ts
  /** `SOLANA_HTTP_RPC_URL`, from a URL secret of the executor project. */
  readonly httpRpc?: BackSecret;
  /**
   * The Helius account list (Helius accounts spec 5.4): `SOLANA_HTTP_RPC_URL` and
   * `SOLANA_WS_RPC_URL` from its first account, and `LISTENER_HELIUS_ACCOUNTS_PATH` its tmpfs path.
   */
  readonly heliusAccounts?: BackSecret;
```

In `ROLE_TABLE`, change the listener and opapi roles:

```ts
  listener: {
    user: 'listener', configFile: 'listener.env', database: loginDatabase('sol_listener'),
    heliusAccounts: 'helius-listener-accounts',
  },
```

```ts
  opapi: {
    user: 'opapi', configFile: 'operator-api.env',
    database: { login: 'sol_reader', variable: 'OPERATOR_API_DATABASE_URL', searchPath: false },
    // The wallet balance comes from the executor project in both modes (Helius accounts spec 5.4).
    httpRpc: EXECUTOR_RPC,
    secretValues: { OPERATOR_API_TOKEN: 'operator-api-token' },
  },
```

Delete `resolveHttpRpc`. Replace `roleSecretFiles` with:

```ts
/** The secret files a role reads, relative to `/root/secrets/<source>/`. */
export function roleSecretFiles(role: RoleDefinition): readonly RoleSecretFile[] {
  const files: RoleSecretFile[] = [];
  if (role.database !== undefined) {
    files.push({ source: 'logins', file: loginPasswordFile(role.database.login) });
  }
  if (role.httpRpc !== undefined) files.push({ source: 'back', file: role.httpRpc });
  if (role.heliusAccounts !== undefined) files.push({ source: 'back', file: role.heliusAccounts });
  for (const file of Object.values(role.secretPaths ?? {})) files.push({ source: 'back', file });
  for (const file of Object.values(role.secretValues ?? {})) files.push({ source: 'back', file });
  return Object.freeze(files);
}
```

In `src/deploy/secret-distribution.ts`, change `roleSecretFiles(role, mode)` to `roleSecretFiles(role)`.

- [ ] **Step 4: Implement `src/deploy/role-environment.ts`.**
  - Remove `resolveHttpRpc` from the import list.
  - Add `import { HeliusAccountsError, parseHeliusAccountsFile, withApiKey } from '../config/helius-accounts.js';`.
  - Add `'LISTENER_HELIUS_ACCOUNTS_PATH'` to `INJECTED_KEYS`.
  - Add after `rpcUrl`:

```ts
export const DEFAULT_HELIUS_RPC_HTTP_URL = 'https://mainnet.helius-rpc.com/';
export const DEFAULT_HELIUS_RPC_WS_URL = 'wss://mainnet.helius-rpc.com/';

/** A Helius address of the configuration (or its default): this protocol, never a key. */
function heliusAddress(
  value: string | undefined,
  fallback: string,
  variable: string,
  protocol: 'https:' | 'wss:',
): string {
  let url: URL;
  try {
    url = new URL(value === undefined || value === '' ? fallback : value);
  } catch {
    throw new RoleEnvironmentError(`${variable}: not a URL`);
  }
  if (url.protocol !== protocol) {
    throw new RoleEnvironmentError(`${variable}: expected a ${protocol.slice(0, -1)} URL`);
  }
  if (url.searchParams.has('api-key') || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new RoleEnvironmentError(`${variable}: must not carry a key`);
  }
  return url.toString();
}
```

  - In `buildRoleEnvironment`, replace the `httpRpc` and `wsRpc` blocks with:

```ts
  if (role.httpRpc !== undefined) {
    environment.SOLANA_HTTP_RPC_URL = rpcUrl(
      input.readSecret(`${directory}/${role.httpRpc}`), role.httpRpc, 'https:',
    );
  }
  if (role.heliusAccounts !== undefined) {
    const path = `${directory}/${role.heliusAccounts}`;
    let first: string | undefined;
    try {
      first = parseHeliusAccountsFile(input.readSecret(path), role.heliusAccounts)[0]?.apiKey;
    } catch (error) {
      if (error instanceof HeliusAccountsError) throw new RoleEnvironmentError(error.message);
      throw error;
    }
    if (first === undefined) throw new RoleEnvironmentError(`${role.heliusAccounts}: no account`);
    environment.SOLANA_HTTP_RPC_URL = withApiKey(heliusAddress(
      environment.HELIUS_RPC_HTTP_URL, DEFAULT_HELIUS_RPC_HTTP_URL, 'HELIUS_RPC_HTTP_URL', 'https:',
    ), first);
    environment.SOLANA_WS_RPC_URL = withApiKey(heliusAddress(
      environment.HELIUS_RPC_WS_URL, DEFAULT_HELIUS_RPC_WS_URL, 'HELIUS_RPC_WS_URL', 'wss:',
    ), first);
    environment.LISTENER_HELIUS_ACCOUNTS_PATH = path;
  }
```

- [ ] **Step 5: Implement `src/deploy/vault-layout.ts`.**
  - Add `import { HeliusAccountsError, heliusAccountsFromEntry, renderHeliusAccounts } from '../config/helius-accounts.js';`.
  - Add `export const HELIUS_LISTENER_ACCOUNTS: BackSecret = 'helius-listener-accounts';` next to `WALLET_KEYPAIR`.
  - Replace `secretValue` with:

```ts
export function secretValue(path: string, data: Readonly<Record<string, unknown>>): string {
  // The listener's Helius accounts: one field per account, rendered as a compact JSON object.
  if (path === backSecretPath(HELIUS_LISTENER_ACCOUNTS)) {
    try {
      return renderHeliusAccounts(heliusAccountsFromEntry(data, path));
    } catch (error) {
      if (error instanceof HeliusAccountsError) throw new VaultLayoutError(error.message);
      throw error;
    }
  }
  const value = data.value;
  if (typeof value !== 'string' || value.length === 0) {
    throw new VaultLayoutError(`${path}: expected a non-empty value field`);
  }
  return value;
}
```

- [ ] **Step 6: Run the tests.**
  - `npx tsx --test tests/deploy-*.test.ts`. Expected: PASS, except `tests/deploy-vault-import.test.ts`, which Task 6 fixes. If another deploy test still names `helius-listener-http-url`, update its expected strings the same way.
  - `npm run build:backend`. Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/deploy tests/deploy-stack.test.ts tests/deploy-role-environment.test.ts tests/deploy-secret-distribution.test.ts tests/deploy-vault-layout.test.ts tests/deploy-vault-pull.test.ts
git commit -m "feat(deploy): one Vault entry for the listener's Helius accounts; opapi on the executor URL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Import converts the lot5 listener URLs

**Files:**
- Modify: `scripts/deploy/vault-import.ts`
- Test: `tests/deploy-vault-import.test.ts`

- [ ] **Step 1: Write the failing test.** In `tests/deploy-vault-import.test.ts`, the fixture `env/listener.env` already holds `SOLANA_HTTP_RPC_URL=https://rpc.invalid/?api-key=listener-key` and `SOLANA_WS_RPC_URL=wss://rpc.invalid/?api-key=listener-key`. Replace the assertions about `secrets/back/helius-listener-http-url` and the summary with:

```ts
    assert.deepEqual(vault.kv.get('secrets/back/helius-listener-accounts'), { '01': 'listener-key' });
    assert.equal(vault.kv.get('secrets/back/helius-listener-http-url'), undefined);
    assert.equal(vault.kv.get('config/listener')?.HELIUS_RPC_HTTP_URL, 'https://rpc.invalid/');
    assert.equal(vault.kv.get('config/listener')?.HELIUS_RPC_WS_URL, 'wss://rpc.invalid/');
```

and `secrets: ['helius-listener-accounts', 'helius-executor-http-url', 'wallet-keypair.json']`. Adapt the accessor to the fake's API (`vault.kv.get`). Then add these refusal cases to the table of invalid sources at line 125:

```ts
    ['env/listener.env', 'SOLANA_HTTP_RPC_URL=https://rpc.invalid/?api-key=a\nSOLANA_WS_RPC_URL=wss://rpc.invalid/?api-key=b\n',
      'vault-import: listener.env: SOLANA_HTTP_RPC_URL and SOLANA_WS_RPC_URL carry different api-key values\n'],
    ['env/listener.env', 'SOLANA_HTTP_RPC_URL=https://rpc.invalid/\nSOLANA_WS_RPC_URL=wss://rpc.invalid/\n',
      'vault-import: listener.env: SOLANA_HTTP_RPC_URL has no api-key parameter\n'],
    ['env/listener.env', 'SOLANA_HTTP_RPC_URL=https://rpc.invalid/?api-key=a\n',
      'vault-import: listener.env: SOLANA_HTTP_RPC_URL and SOLANA_WS_RPC_URL go together\n'],
```

The existing single-URL cases (`http://insecure.invalid`, `https://` for WS, `not-a-url`, the zero-width character) keep their messages. Each present URL is validated first.

- [ ] **Step 2: Run it.** `npx tsx --test tests/deploy-vault-import.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** — edit `scripts/deploy/vault-import.ts`.
  - Remove the two listener rows from `URL_SECRETS`; only the executor row stays.
  - Import `HELIUS_LISTENER_ACCOUNTS` from `vault-layout.js`.
  - Import `heliusAccountsFromEntry` and `HeliusAccountsError` from `../../src/config/helius-accounts.js`.
  - Add:

```ts
/**
 * The lot5 listener URLs become account `01` of the Helius account list, and their addresses
 * without the key become HELIUS_RPC_HTTP_URL and HELIUS_RPC_WS_URL (Helius accounts spec 5.5).
 */
function listenerAccount(parsed: Readonly<Record<string, string>>): Readonly<{
  apiKey: string; httpUrl: string; websocketUrl: string;
}> | null {
  const http = parsed.SOLANA_HTTP_RPC_URL;
  const websocket = parsed.SOLANA_WS_RPC_URL;
  const httpUrl = http === undefined || http === '' ? null : rpcUrl(http, 'listener.env: SOLANA_HTTP_RPC_URL', 'https:');
  const websocketUrl = websocket === undefined || websocket === ''
    ? null : rpcUrl(websocket, 'listener.env: SOLANA_WS_RPC_URL', 'wss:');
  if (httpUrl === null && websocketUrl === null) return null;
  if (httpUrl === null || websocketUrl === null) {
    throw new ImportSourceError('listener.env: SOLANA_HTTP_RPC_URL and SOLANA_WS_RPC_URL go together');
  }
  const httpKey = splitApiKey(httpUrl, 'SOLANA_HTTP_RPC_URL');
  const websocketKey = splitApiKey(websocketUrl, 'SOLANA_WS_RPC_URL');
  if (httpKey.apiKey !== websocketKey.apiKey) {
    throw new ImportSourceError('listener.env: SOLANA_HTTP_RPC_URL and SOLANA_WS_RPC_URL carry different api-key values');
  }
  return Object.freeze({ apiKey: httpKey.apiKey, httpUrl: httpKey.address, websocketUrl: websocketKey.address });
}

function splitApiKey(value: string, variable: string): Readonly<{ apiKey: string; address: string }> {
  const url = new URL(value);
  const apiKey = url.searchParams.get('api-key');
  if (apiKey === null || apiKey === '') throw new ImportSourceError(`listener.env: ${variable} has no api-key parameter`);
  url.searchParams.delete('api-key');
  return Object.freeze({ apiKey, address: url.toString() });
}
```

  - In `planImport`, declare `let listenerKey: string | null = null;` before the configuration loop. Inside the loop, after the `for (const [key, value] of Object.entries(parsed))` block and before `Object.assign(data, STACK_BINDINGS[name] ?? {});`, add:

```ts
    if (name === 'listener' && fromOwn) {
      const account = listenerAccount(parsed);
      if (account !== null) {
        data.HELIUS_RPC_HTTP_URL = account.httpUrl;
        data.HELIUS_RPC_WS_URL = account.websocketUrl;
        listenerKey = account.apiKey;
      }
    }
```

  - After the configuration loop and before `for (const entry of URL_SECRETS)`, add:

```ts
  if (listenerKey !== null) {
    const entry = Object.freeze({ '01': listenerKey });
    try {
      heliusAccountsFromEntry(entry, backSecretPath(HELIUS_LISTENER_ACCOUNTS));
    } catch (error) {
      if (error instanceof HeliusAccountsError) throw new ImportSourceError(error.message);
      throw error;
    }
    writes.push([backSecretPath(HELIUS_LISTENER_ACCOUNTS), entry]);
    secrets.push(HELIUS_LISTENER_ACCOUNTS);
  }
```

- [ ] **Step 4: Run the tests.** `npx tsx --test tests/deploy-vault-import.test.ts tests/deploy-*.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy/vault-import.ts tests/deploy-vault-import.test.ts
git commit -m "feat(deploy): vault-import turns the lot5 listener URLs into Helius account 01

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `sol helius reload`

**Files:**
- Create: `scripts/deploy/helius-accounts.ts`
- Modify: `deploy/back/bin/sol`
- Test: `tests/deploy-helius-accounts-cli.test.ts` (new), `tests/deployment-artifacts.test.ts`

- [ ] **Step 1: Write the failing tests** — create `tests/deploy-helius-accounts-cli.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHeliusAccountsCli } from '../scripts/deploy/helius-accounts.js';

function run(argv: readonly string[], file: string | Error) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runHeliusAccountsCli(argv, {
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
  }, () => {
    if (file instanceof Error) throw file;
    return file;
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

void test('names prints the account names in order, never a key', () => {
  const result = run(['names', '/run/sol/listener/helius-listener-accounts'], '{"02-spare":"key-b","01-main":"key-a"}');
  assert.deepEqual(result, { code: 0, stdout: '["01-main","02-spare"]\n', stderr: '' });
});

void test('an invalid list exits 78 with a message that names no key', () => {
  const result = run(['names', '/f'], '{"01-main":"key with space"}');
  assert.equal(result.code, 78);
  assert.equal(result.stderr, 'helius-accounts: /f: 01-main must be one printable line without spaces\n');
  assert.equal(result.stdout, '');
});

void test('usage errors exit 64 and an unreadable file exits 1', () => {
  assert.equal(run([], '').code, 64);
  assert.equal(run(['list', '/f'], '').code, 64);
  const missing = Object.assign(new Error('nope'), { code: 'ENOENT' });
  assert.deepEqual(run(['names', '/f'], missing), { code: 1, stdout: '', stderr: 'helius-accounts: cannot read /f (ENOENT)\n' });
});
```

In `tests/deployment-artifacts.test.ts`, add:

```ts
void test('sol helius reload pulls, distributes, checks the list, then restarts the listener only', async () => {
  const sol = await readArtifact('deploy/back/bin/sol');
  const steps = [
    'node /app/dist/scripts/deploy/vault-pull.js back "$current"',
    'node /app/dist/scripts/deploy/distribute-secrets.js "$current"',
    'node /app/dist/scripts/deploy/helius-accounts.js names /run/sol/listener/helius-listener-accounts',
    'ctl restart listener',
  ];
  let position = -1;
  for (const step of steps) {
    const next = sol.indexOf(step, position + 1);
    assert.ok(next > position, `missing or out of order: ${step}`);
    position = next;
  }
  assert.ok(!/cat [^|]*helius-listener-accounts/u.test(sol), 'the reload never prints the account file');
  assert.match(sol, /helius\) helius "\$@" ;;/u);
});
```

`readArtifact` is the existing helper of that file.

- [ ] **Step 2: Run them.** `npx tsx --test tests/deploy-helius-accounts-cli.test.ts tests/deployment-artifacts.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the script** — create `scripts/deploy/helius-accounts.ts`:

```ts
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { HeliusAccountsError, parseHeliusAccountsFile } from '../../src/config/helius-accounts.js';
import { errnoCode } from '../../src/deploy/errno-code.js';

export interface HeliusAccountsCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * `helius-accounts names <file>`: the account names of a pulled Helius list as a JSON array, for
 * `sol helius reload`; never a key. Exit codes: 0; 64 usage; 78 invalid list; 1 unreadable file.
 */
export function runHeliusAccountsCli(
  argv: readonly string[],
  io: HeliusAccountsCliIo,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): number {
  const [command, file, ...rest] = argv;
  if (command !== 'names' || file === undefined || rest.length > 0) {
    io.stderr('usage: helius-accounts names <file>\n');
    return 64;
  }
  let text: string;
  try {
    text = readFile(file);
  } catch (error) {
    io.stderr(`helius-accounts: cannot read ${file} (${errnoCode(error)})\n`);
    return 1;
  }
  try {
    io.stdout(`${JSON.stringify(parseHeliusAccountsFile(text, file).map(({ name }) => name))}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof HeliusAccountsError)) throw error;
    io.stderr(`helius-accounts: ${error.message}\n`);
    return 78;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = runHeliusAccountsCli(process.argv.slice(2), {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}
```

Check `src/deploy/errno-code.ts`. If `errnoCode` returns something other than the `code` property of an `Error` (for example `'UNKNOWN'` for a plain error), align the test expectation with what it returns for `{ code: 'ENOENT' }`.

- [ ] **Step 4: Implement the command** — edit `deploy/back/bin/sol`. Add this function after `qualify()`:

```sh
helius() {
  case "${1:-}" in
    reload)
      # The steps of sol-entrypoint for the listener only (Helius accounts spec 7.1). A refused or
      # invalid entry stops here, before any restart: the listener keeps its accounts.
      current="$(mode)"
      node /app/dist/scripts/deploy/vault-pull.js back "$current" > /dev/null \
        || die 'helius reload: Vault refused or an entry is invalid; the listener keeps its accounts' 78
      node /app/dist/scripts/deploy/distribute-secrets.js "$current" > /dev/null \
        || die 'helius reload: the secrets were not distributed; the listener keeps its accounts' 78
      names="$(node /app/dist/scripts/deploy/helius-accounts.js names /run/sol/listener/helius-listener-accounts)" \
        || die 'helius reload: the account list is invalid' 78
      ctl restart listener > /dev/null
      printf '{"event":"helius.reloaded","accounts":%s}\n' "$names" ;;
    *) die 'usage: sol helius reload' 64 ;;
  esac
}
```

In the `case "$command" in` dispatcher, add `helius) helius "$@" ;;` after the `qualify)` line. Replace the usage line with:

```sh
  *) die 'usage: sol ops|readiness|evidence|trading|qualify|helius|ctl|status …' 64 ;;
```

- [ ] **Step 5: Run the tests.**
  - `npx tsx --test tests/deploy-helius-accounts-cli.test.ts tests/deployment-artifacts.test.ts`. Expected: PASS.
  - `sh -n deploy/back/bin/sol`. Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy/helius-accounts.ts deploy/back/bin/sol tests/deploy-helius-accounts-cli.test.ts tests/deployment-artifacts.test.ts
git commit -m "feat(deploy): sol helius reload re-reads the account list and restarts only the listener

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Template and deployment smoke

**Files:**
- Modify: `deploy/config/listener.env.example`
- Modify: `scripts/deployment-smoke.mjs`: constants near line 72, `importSmokeVault` near line 971, `assertSecretIsolation` near line 998, a new phase in `runDeployment` after `OPERATIONS`.
- Modify: `tests/deployment-artifacts.test.ts:1528`

- [ ] **Step 1: Update the template.** In `deploy/config/listener.env.example`, replace the second line with:

```
# sol-run injects DATABASE_URL, SOLANA_HTTP_RPC_URL, SOLANA_WS_RPC_URL and LISTENER_HELIUS_ACCOUNTS_PATH
# from the secret files (the Vault entry sol/secrets/back/helius-listener-accounts):
```

Replace the line `# Fallback RPC URLs carry provider keys: they come with the multi-account work (sub-project 3).` with:

```
# Helius addresses without a key: sol-run adds the key of the first account of the Vault entry
# sol/secrets/back/helius-listener-accounts (docs/operations/deployment.md, « Comptes Helius du listener »).
HELIUS_RPC_HTTP_URL=https://mainnet.helius-rpc.com/
HELIUS_RPC_WS_URL=wss://mainnet.helius-rpc.com/
# An exhausted or refused account is set aside this long (1 h) before it is tried again.
LISTENER_HELIUS_ACCOUNT_COOLDOWN_MS=3600000
# Fallback providers other than Helius, without a key in their URL.
```

- [ ] **Step 2: Update the smoke.**

Next to `const rpcApiKey = …`, add `const spareRpcApiKey = randomBytes(16).toString('hex');`, and add `spareRpcApiKey` to the `smokeSecrets` initial array.

In `importSmokeVault`, the expected summary becomes `'helius-listener-accounts,wallet-keypair.json'`.

In `assertSecretIsolation`:
- `secretPaths` becomes `['/run/sol/listener/pg-sol_listener-password', '/run/sol/listener/helius-listener-accounts', '/run/sol/opapi/operator-api-token']`.
- The expected `stat` output becomes `'listener 400\nlistener 400\nopapi 400\n'`.
- The cross-user read loop iterates `secretPaths.slice(2)`.

Then append:

```js
  // The Helius account list reaches the listener user only (Helius accounts spec 8).
  let opapiReadsAccounts = true;
  try {
    await compose([
      'exec', '-T', 'back', 'setpriv', '--reuid=opapi', '--regid=opapi', '--clear-groups',
      'cat', '/run/sol/listener/helius-listener-accounts',
    ], { reflectFailureOutput: false });
  } catch {
    opapiReadsAccounts = false;
  }
  if (opapiReadsAccounts) throw new Error('The opapi user can read the Helius account list.');
  const { stdout: holders } = await compose(['exec', '-T', 'back', 'find', '/run/sol', '-name', 'helius-listener-accounts']);
  assertEqual(holders, '/run/sol/listener/helius-listener-accounts\n', 'The Helius account list reached another user.');
```

Add the function:

```js
/** The operator adds a second account through stdin, as the runbook does, then reloads it alone. */
async function assertHeliusReload() {
  const { stdout: tokenOutput } = await compose(
    ['exec', '-T', 'vault', 'vault', 'write', '-field=token', 'auth/userpass/login/operator', 'password=-'],
    { input: operatorPassword, reflectFailureOutput: false },
  );
  const operatorToken = tokenOutput.trim();
  smokeSecrets.push(operatorToken);
  const tokenEnvironment = { ...environment, VAULT_TOKEN: operatorToken };
  await compose(
    ['exec', '-T', '-e', 'VAULT_TOKEN', 'vault', 'vault', 'kv', 'patch', 'sol/secrets/back/helius-listener-accounts', '02-smoke=-'],
    { commandEnvironment: tokenEnvironment, input: spareRpcApiKey, reflectFailureOutput: false },
  );
  await compose(
    ['exec', '-T', '-e', 'VAULT_TOKEN', 'vault', 'vault', 'token', 'revoke', '-self'],
    { commandEnvironment: tokenEnvironment, reflectFailureOutput: false },
  );
  const before = await programPids();
  const { stdout, stderr } = await compose(['exec', '-T', 'back', 'sol', 'helius', 'reload'], { reflectFailureOutput: false });
  assertNoSmokeSecret(`${stdout}\n${stderr}`, 'sol helius reload printed a secret.');
  assertEqual(stdout, '{"event":"helius.reloaded","accounts":["01","02-smoke"]}\n', 'sol helius reload did not report both accounts.');
  const after = await programPids();
  if (after.listener === before.listener) throw new Error('sol helius reload did not restart the listener.');
  assertEqual(`${after.opapi} ${after.retention}`, `${before.opapi} ${before.retention}`, 'sol helius reload restarted another program.');
  await waitForPublicHealth();
}

async function programPids() {
  const { stdout } = await compose([
    'exec', '-T', 'back', 'sh', '-c',
    'for program in listener opapi retention; do printf "%s %s\\n" "$program" "$(sol ctl pid "$program")"; done',
  ]);
  return Object.fromEntries(stdout.trim().split('\n').map((line) => line.split(' ')));
}
```

In `runDeployment`, after `await smokePhase('OPERATIONS', assertOperations);`, add:

```js
      await smokePhase('HELIUS_RELOAD', assertHeliusReload);
```

Check `runCommand` (line 663) for how `input` reaches stdin. The operator password must reach `vault write … password=-` without a trailing newline. If `runCommand` appends one, strip it.

- [ ] **Step 3: Update the artifact tests.**
  - In `tests/deployment-artifacts.test.ts`, line 1528 becomes `assert.ok(fill.includes("'helius-listener-accounts,wallet-keypair.json'"));`.
  - Add `assert.match(smoke, /smokePhase\('HELIUS_RELOAD', assertHeliusReload\)/u);` to the test that reads the smoke near line 1295.
  - Lines 1295-1296 stay: the lot5-style source still carries `SOLANA_*_RPC_URL`.

- [ ] **Step 4: Run the checks.**
  - `node --check scripts/deployment-smoke.mjs` and `npx tsx --test tests/deployment-artifacts.test.ts`. Expected: PASS.
  - Do **not** run the smoke itself (see the ground rules). CI's `deployment-contract` job runs it.

- [ ] **Step 5: Commit**

```bash
git add deploy/config/listener.env.example scripts/deployment-smoke.mjs tests/deployment-artifacts.test.ts
git commit -m "test(deploy): smoke checks the Helius account list isolation and sol helius reload

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Runbook

**Files:**
- Modify: `docs/operations/deployment.md`:
  - the import description, lines 228-250;
  - the example at line 281;
  - a new subsection after « Modifier une valeur » (which ends before line 332);
  - the « Commandes sol » table at line 370.
- Modify: `tests/deployment-artifacts.test.ts:1635`

- [ ] **Step 1: Update the import description.** In the list after « L'import : », add:

```markdown
   - convertit `SOLANA_HTTP_RPC_URL` et `SOLANA_WS_RPC_URL` de `listener.env` en un compte `01`
     de `sol/secrets/back/helius-listener-accounts` (les deux URL doivent porter la même clé), et
     leurs adresses sans clé en `HELIUS_RPC_HTTP_URL` et `HELIUS_RPC_WS_URL` de `sol/config/listener` ;
```

- [ ] **Step 2: Change the secret example.** At line 281, `helius-listener-http-url` becomes `helius-executor-http-url`. Make the same change in the expected line of `tests/deployment-artifacts.test.ts:1635`.

- [ ] **Step 3: Add the subsection** after « Modifier une valeur »:

````markdown
### Comptes Helius du listener

Le listener lit une liste de comptes Helius, `sol/secrets/back/helius-listener-accounts` : un
champ par compte, nommé (`01-perso`, `02-pro` : minuscules, chiffres, tirets), dont la valeur est
la clé API. Il démarre sur le premier dans l'ordre alphabétique des noms. Quand un compte répond
« max usage reached » (quota épuisé) ou refuse sa clé (401, 403), il le met à l'écart une heure
(`LISTENER_HELIUS_ACCOUNT_COOLDOWN_MS`) et passe au suivant, sans redémarrer. La clé de l'exécuteur
n'entre jamais dans cette liste.

Les clés passent par l'entrée standard. Dans une session `operator` (« Modifier une valeur ») :

```bash
# Ajouter ou remplacer un compte
printf 'Clé : ' && IFS= read -rs cle && printf '\n'
printf '%s' "$cle" | sol_vault kv patch sol/secrets/back/helius-listener-accounts 02-pro=-
unset cle
# Retirer un compte
sol_vault kv patch -remove-data=02-pro sol/secrets/back/helius-listener-accounts
```

La première création utilise `kv put` au lieu de `kv patch`. Ne jamais lancer `kv get` sur cette
entrée : il affiche les clés. Puis recharger la liste sans toucher au trading :

```bash
sol_compose exec back sol helius reload
```

La commande relit Vault, redistribue les secrets et redémarre (ou démarre) le seul listener. Elle
affiche les noms des comptes, jamais une clé. Si Vault refuse ou si la liste est invalide, elle
s'arrête avant le redémarrage, et le listener garde sa liste. Les autres entrées relues ne prennent
effet qu'au prochain démarrage de leur programme : pour elles, redémarrer `back`.

Suivre les comptes :

```bash
sol_compose logs back | grep helius_account
```

- `rpc.helius_account_set_aside` : un compte mis à l'écart, avec sa raison (`QUOTA_EXHAUSTED`,
  `KEY_REFUSED`), le compte suivant et le nombre de comptes encore disponibles ;
- `rpc.helius_accounts_unavailable` : tous les comptes sont à l'écart, le listener est sourd
  jusqu'au prochain essai. Ajouter un compte, ou attendre le renouvellement d'un quota.

Les anciennes entrées `sol/secrets/back/helius-listener-http-url` et `helius-listener-ws-url` ne
sont plus lues : les supprimer avec `sol_vault kv metadata delete <chemin>`.
````

- [ ] **Step 4: Add a row to the « Commandes sol » table:** `| \`sol helius reload\` | rechargement des comptes Helius du listener |`. Match the table's column layout.

- [ ] **Step 5: Run the checks.**
  - `npx tsx --test tests/deployment-artifacts.test.ts` and `npm run docs:check`. Expected: PASS.
  - If the artifact test pins other runbook lines that moved, update them.

- [ ] **Step 6: Commit**

```bash
git add docs/operations/deployment.md tests/deployment-artifacts.test.ts
git commit -m "docs(deploy): runbook for the listener's Helius account list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Verification and pull request

- [ ] **Step 1: Full local checks.**
  - `npm run build:backend`
  - `npm run lint:backend`
  - `npm run test:backend`
  - `npm run docs:check`

  Expected: all exit 0. PostgreSQL tests skip without `TEST_DATABASE_URL`, and CI runs them.

- [ ] **Step 2: Secret scan of the diff.** `git diff origin/main --stat` then `git diff origin/main | grep -n -i -E 'api-key=[0-9a-f]{8}-|helius-rpc\.com/\?api-key=[^k<]'`. Expected: no output. Only fake keys appear.

- [ ] **Step 3: Push and open the PR.**

```bash
git push -u origin feat/helius-listener-accounts
gh pr create --title "Listener: Helius account list in Vault with automatic failover (sub-project 3)" --body-file <body>
```

The body has these sections:
- **Summary:** what changes for the operator, and the rotation rules.
- **Security:** the executor key stays out of the list, and the list reaches only the listener user.
- **Deviations from the spec:** none, or the list.
- **Test plan:** the unit tests, the smoke in CI, and the Mac validation (spec 7.3) still to do with the user's go and a new Helius key.

The body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 4: Wait for CI** (`gh pr checks --watch`): `quality`, `deployment-contract` and `frontend-e2e`. Fix any failure and push again.

- [ ] **Step 5: Merge** (`gh pr merge --merge`), then fast-forward the main checkout: `git -C /Users/haythem.mabrouk/workspace/perso/sol-token-listener pull --ff-only`.

- [ ] **Step 6: Mac validation (spec 7.3): STOP.** It needs the user's explicit go, a bigger Docker disk and their new Helius key. Report and ask.

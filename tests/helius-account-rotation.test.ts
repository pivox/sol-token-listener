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
    const url = new URL(input instanceof Request ? input.url : input);
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

void test('a malformed address is refused without echoing its key', () => {
  for (const [httpUrl, websocketUrl] of [['not a url?api-key=fake-secret', WS], [HTTP, 'not a url?api-key=fake-secret']] as const) {
    assert.throws(
      () => new HeliusAccountRotation({ accounts: ACCOUNTS, httpUrl, websocketUrl, cooldownMs: 60_000, log: () => undefined }),
      (error: unknown) => error instanceof TypeError
        && error.message === 'Helius account rotation URL is invalid.' && !error.message.includes('fake-secret'),
    );
  }
});

void test('the base fetch is called as a plain function', async () => {
  const seen: string[] = [];
  const fetch = function (this: unknown, input: Parameters<FetchFn>[0]): Promise<Response> {
    if (this !== undefined) throw new Error('fetch called with a receiver');
    seen.push(typeof input === 'string' ? input : 'other');
    return Promise.resolve(ok());
  } as FetchFn;
  const rotation = new HeliusAccountRotation({
    accounts: ACCOUNTS, httpUrl: HTTP, websocketUrl: WS, cooldownMs: 60_000, log: () => undefined, fetch,
  });
  assert.equal((await rotation.fetch(HTTP, { method: 'POST', body: BODY })).status, 200);
  assert.equal((await rotation.fetch('https://elsewhere.invalid/', { method: 'POST', body: BODY })).status, 200);
  assert.equal(seen.length, 2);
});

void test('the exhaustion text is matched case-insensitively', async () => {
  const h = harness((key) => (key === 'key-one' ? new Response('Max Usage Reached', { status: 429 }) : ok()));
  await h.request();
  const aside = h.events.find(({ event }) => event === 'rpc.helius_account_set_aside');
  assert.equal(aside?.event === 'rpc.helius_account_set_aside' ? aside.reason : null, 'QUOTA_EXHAUSTED');
});

void test('unavailability is logged again when every account fails again after the cooldown', async () => {
  const h = harness(() => exhausted(), ACCOUNTS.slice(0, 2));
  await h.request();
  assert.equal(h.events.filter(({ event }) => event === 'rpc.helius_accounts_unavailable').length, 1);
  h.advance(60_000);
  await h.request();
  assert.equal(h.events.filter(({ event }) => event === 'rpc.helius_accounts_unavailable').length, 2);
});

void test('a Request object passes through unrewritten', async () => {
  const h = harness(() => ok());
  const request = new Request(HTTP, { method: 'POST', body: BODY });
  await h.rotation.fetch(request);
  assert.deepEqual(h.urls, [request.url]);
  assert.deepEqual(h.keys, ['key-one']);
  assert.deepEqual(h.events.map(({ event }) => event), ['rpc.helius_account_selected']);
});

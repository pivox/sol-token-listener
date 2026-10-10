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
    const key = new URL(input instanceof Request ? input.url : input.toString()).searchParams.get('api-key');
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

void test('an account file cannot be combined with a fallback on the primary address', () => {
  const config = parseConfig({
    ...base,
    LISTENER_HELIUS_ACCOUNTS_PATH: '/run/sol/listener/helius-listener-accounts',
    SOLANA_HTTP_RPC_FALLBACK_URLS: 'https://rpc.invalid/?api-key=other-secret',
  });
  const message = 'LISTENER_HELIUS_ACCOUNTS_PATH cannot be combined with a SOLANA_HTTP_RPC_FALLBACK_URLS entry on the primary address.';
  assert.throws(
    () => createListenerHeliusAccountRotation(config, { readFile: () => '{"01-one":"key-one"}', log: () => undefined }),
    (error: unknown) => error instanceof Error && error.message === message,
  );
  const elsewhere = parseConfig({
    ...base,
    LISTENER_HELIUS_ACCOUNTS_PATH: '/run/sol/listener/helius-listener-accounts',
    SOLANA_HTTP_RPC_FALLBACK_URLS: 'https://other.invalid/?api-key=other-secret',
  });
  assert.ok(createListenerHeliusAccountRotation(elsewhere, { readFile: () => '{"01-one":"key-one"}', log: () => undefined }));
});

void test('a whitespace-padded account path is refused', () => {
  assert.throws(() => parseConfig({ ...base, LISTENER_HELIUS_ACCOUNTS_PATH: ' /run/sol/accounts' }),
    /LISTENER_HELIUS_ACCOUNTS_PATH must be an absolute path/u);
  assert.throws(() => parseConfig({ ...base, LISTENER_HELIUS_ACCOUNTS_PATH: '/run/sol/accounts ' }),
    /LISTENER_HELIUS_ACCOUNTS_PATH must be an absolute path/u);
});

void test('events map to info, warn and error', () => {
  assert.equal(heliusAccountLogLevel({ event: 'rpc.helius_account_selected', account: 'a', cause: 'STARTUP' }), 'info');
  assert.equal(heliusAccountLogLevel({
    event: 'rpc.helius_account_set_aside', account: 'a', reason: 'QUOTA_EXHAUSTED', status: 429, untilMs: 1, next: null, available: 0,
  }), 'warn');
  assert.equal(heliusAccountLogLevel({ event: 'rpc.helius_accounts_unavailable', accounts: 1, retryAtMs: 1 }), 'error');
});

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

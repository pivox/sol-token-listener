import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoleEnvironmentError } from '../src/deploy/role-environment.js';
import { ROLES, ROLE_NAMES } from '../src/deploy/stack.js';
import {
  CONFIG_NAMES,
  VaultLayoutError,
  WALLET_KEYPAIR,
  backEntries,
  backSecretPath,
  migrateEntries,
  renderConfig,
  secretValue,
} from '../src/deploy/vault-layout.js';

const LEAK = 'value-that-must-not-leak';

/** `renderConfig` refuses `data`; the message may name the entry and a variable, never a value. */
function assertRefused(
  data: Readonly<Record<string, unknown>>,
  expected: new (message: string) => Error,
  message?: string,
): void {
  assert.throws(() => renderConfig('listener', data), (error: unknown) => {
    assert.ok(error instanceof expected, JSON.stringify(data));
    assert.equal((error as Error).message.includes(LEAK), false, JSON.stringify(data));
    if (message !== undefined) assert.equal((error as Error).message, message);
    return true;
  });
}

void test('observe reads every configuration and secret of the mode except the keypair', () => {
  const entries = backEntries('observe');
  assert.deepEqual(entries.map((entry) => [entry.path, entry.required]), [
    ['config/listener', true],
    ['config/live', false],
    ['config/live-recovery', false],
    ['config/operations', false],
    ['config/operator-api', true],
    ['config/readiness', false],
    ['config/worker-sim', false],
    ['config/provider-evidence', false],
    ['config/preflight-bundle', false],
    ['config/retention', true],
    ['secrets/back/evidence-private-key', false],
    ['secrets/back/helius-admin-api-key', false],
    ['secrets/back/helius-executor-http-url', true],
    ['secrets/back/helius-listener-accounts', true],
    ['secrets/back/operator-api-token', true],
    ['secrets/logins/sol_autoarm', false],
    ['secrets/logins/sol_listener', true],
    ['secrets/logins/sol_live', false],
    ['secrets/logins/sol_ops', false],
    ['secrets/logins/sol_reader', true],
    ['secrets/logins/sol_readiness', false],
    ['secrets/logins/sol_recovery', false],
    ['secrets/logins/sol_retention', true],
    ['secrets/logins/sol_worker', false],
  ]);
  const configs = entries.flatMap((entry) => (entry.kind === 'config' ? [entry] : []));
  assert.deepEqual(configs.map((entry) => entry.name), [...CONFIG_NAMES]);
  assert.deepEqual(configs.map((entry) => entry.file), CONFIG_NAMES.map((name) => `${name}.env`));
  assert.deepEqual(entries[0], {
    kind: 'config', name: 'listener', path: 'config/listener', file: 'listener.env', required: true,
  });
  assert.equal(
    entries.some((entry) => entry.path.includes(WALLET_KEYPAIR) || entry.file.includes(WALLET_KEYPAIR)),
    false,
  );
  assert.deepEqual(entries.find((entry) => entry.path === 'secrets/back/helius-executor-http-url'), {
    kind: 'secret', path: 'secrets/back/helius-executor-http-url',
    file: 'back/helius-executor-http-url', required: true,
  });
});

void test('live requires the executor entries, the keypair included', () => {
  const entries = backEntries('live');
  assert.deepEqual(entries.map((entry) => [entry.path, entry.required]), [
    ['config/listener', true],
    ['config/live', true],
    ['config/live-recovery', true],
    ['config/operations', true],
    ['config/operator-api', true],
    ['config/readiness', false],
    ['config/worker-sim', false],
    ['config/provider-evidence', false],
    ['config/preflight-bundle', false],
    ['config/retention', true],
    ['secrets/back/evidence-private-key', false],
    ['secrets/back/helius-admin-api-key', false],
    ['secrets/back/helius-executor-http-url', true],
    ['secrets/back/helius-listener-accounts', true],
    ['secrets/back/operator-api-token', true],
    ['secrets/back/wallet-keypair.json', true],
    ['secrets/logins/sol_autoarm', true],
    ['secrets/logins/sol_listener', true],
    ['secrets/logins/sol_live', true],
    ['secrets/logins/sol_ops', true],
    ['secrets/logins/sol_reader', true],
    ['secrets/logins/sol_readiness', false],
    ['secrets/logins/sol_recovery', true],
    ['secrets/logins/sol_retention', true],
    ['secrets/logins/sol_worker', false],
  ]);
  assert.deepEqual(entries.find((entry) => entry.path === backSecretPath(WALLET_KEYPAIR)), {
    kind: 'secret', path: 'secrets/back/wallet-keypair.json', file: 'back/wallet-keypair.json', required: true,
  });
});

void test('the configuration entries are exactly the role configuration files', () => {
  assert.deepEqual(
    new Set(CONFIG_NAMES.map((name) => `${name}.env`)),
    new Set(ROLE_NAMES.map((role) => ROLES[role].configFile)),
  );
});

void test('migrate requires the nine login passwords at the paths admin-database reads', () => {
  const entries = migrateEntries();
  assert.equal(entries.length, 9);
  assert.ok(entries.every((entry) => entry.kind === 'secret' && entry.required));
  assert.deepEqual(entries[0], {
    kind: 'secret', path: 'secrets/logins/sol_listener', file: 'logins/pg-sol_listener-password', required: true,
  });
});

void test('a configuration renders sorted and must survive the .env round trip', () => {
  assert.equal(
    renderConfig('listener', { API_PORT: '3000', API_HOST: '0.0.0.0', EMPTY: '' }),
    'API_HOST=0.0.0.0\nAPI_PORT=3000\nEMPTY=\n',
  );
  for (const value of [
    `a#${LEAK}`, ` ${LEAK}`, `${LEAK} `, `'${LEAK}'`, `"${LEAK}"`, `two\n${LEAK}`, `two\r\n${LEAK}`,
  ]) {
    assertRefused({ KEY: value }, VaultLayoutError,
      'config/listener: KEY does not survive the .env format (#, quotes, outer spaces or line breaks)');
  }
  assertRefused({ KEY: 3 }, VaultLayoutError, 'config/listener: KEY must be a string');
  assertRefused({ DATABASE_URL: LEAK }, RoleEnvironmentError);
  assertRefused({ API_TOKEN: LEAK }, RoleEnvironmentError);
  assertRefused({ RPC: `https://h.invalid/?api-key=${LEAK}` }, RoleEnvironmentError);
});

void test('a value that reads as further variables is refused naming its own variable, never the fragment', () => {
  const message = 'config/listener: LOG_LEVEL does not survive the .env format (#, quotes, outer spaces or line breaks)';
  // dotenv reads each of these separators as the end of a line, so the planted text becomes a
  // variable of its own. Each fragment below is one the configuration rules refuse by name: a
  // secret-looking name, an injected one and a credential-looking value.
  for (const separator of ['\n', '\r', '\r\n']) {
    for (const fragment of ['SECRET_X=1', 'DATABASE_URL=1', `MARKER_X=https://user:${LEAK}@host/`]) {
      assertRefused({ LOG_LEVEL: `info${separator}${fragment}` }, VaultLayoutError, message);
    }
  }
  // After a closing quote, dotenv also ends the line at U+2028 or U+2029.
  for (const separator of ['\u2028', '\u2029']) {
    assertRefused({ LOG_LEVEL: `'x'${separator}SECRET_X=1` }, VaultLayoutError, message);
  }
  // Another variable stays valid next to the planted one: the message still names the changed one only.
  assertRefused({ API_HOST: '0.0.0.0', LOG_LEVEL: 'info\nSECRET_X=1' }, VaultLayoutError, message);
});

void test('an unquoted value keeps U+2028 or U+2029 and comes back intact', () => {
  for (const separator of ['\u2028', '\u2029']) {
    const value = `info${separator}SECRET_X=1`;
    assert.equal(renderConfig('listener', { LOG_LEVEL: value }), `LOG_LEVEL=${value}\n`);
  }
});

void test('a key that is no variable name is refused first and never printed', () => {
  const message = 'config/listener: invalid variable name';
  for (const key of [
    LEAK, `a${LEAK}`, `A-${LEAK}`, `A.${LEAK}`, `A ${LEAK}`, `A=${LEAK}`, `A\n${LEAK}`, `A=1\n${LEAK}`,
    `https://x/?api-key=${LEAK}`,
  ]) {
    assertRefused({ [key]: 'v' }, VaultLayoutError, message);
    assertRefused({ [key]: 3 }, VaultLayoutError, message);
  }
  assertRefused({ GOOD: '1', [`bad ${LEAK}`]: '2' }, VaultLayoutError, message);
});

void test('a secret entry keeps its value unchanged and names only its path when invalid', () => {
  assert.equal(secretValue('secrets/back/x', { value: '[1,2]\n' }), '[1,2]\n');
  assert.throws(() => secretValue('secrets/back/x', { value: '' }), /^VaultLayoutError: secrets\/back\/x: expected a non-empty value field$/u);
  assert.throws(() => secretValue('secrets/back/x', { other: 'v' }), VaultLayoutError);
});

void test('the Helius account entry renders as its compact JSON file and refuses a bad entry without a key', () => {
  assert.equal(
    secretValue('secrets/back/helius-listener-accounts', { '02-spare': 'key-spare', '01-main': 'key-main' }),
    '{"01-main":"key-main","02-spare":"key-spare"}',
  );
  assert.throws(() => secretValue('secrets/back/helius-listener-accounts', { 'Bad Name': 'k' }),
    (error: unknown) => error instanceof VaultLayoutError && error.message === 'secrets/back/helius-listener-accounts: invalid account name');
  assert.throws(() => secretValue('secrets/back/helius-listener-accounts', { '01-main': 'leak me' }),
    (error: unknown) => error instanceof VaultLayoutError && !error.message.includes('leak me'));
});

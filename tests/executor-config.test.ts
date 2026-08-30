import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutorConfigError,
  parseExecutorConfig,
} from '../src/executor/config.js';

const DATABASE_URL = 'postgresql://executor@127.0.0.1:5432/executor';
const SECRET_KEYS = Object.freeze([
  'EXECUTOR_PRIVATE_KEY',
  'EXECUTOR_SECRET_KEY',
  'EXECUTOR_KEYPAIR',
  'EXECUTOR_KEYPAIR_PATH',
  'SOLANA_PRIVATE_KEY',
  'SOLANA_SECRET_KEY',
  'SOLANA_KEYPAIR',
  'SOLANA_KEYPAIR_PATH',
  'WALLET_PRIVATE_KEY',
  'WALLET_KEYPAIR',
  'WALLET_KEYPAIR_PATH',
  'ANCHOR_WALLET',
] as const);

void test('parses the exact frozen dry-run defaults without importing listener configuration', () => {
  const config = parseExecutorConfig({ DATABASE_URL });

  assert.deepEqual(config, {
    mode: 'dry-run',
    databaseUrl: DATABASE_URL,
    pollMs: 1_000,
    leaseMs: 30_000,
    databaseStatementTimeoutMs: 3_000,
    shutdownGraceMs: 10_000,
  });
  assert.equal(Object.isFrozen(config), true);
  assert.deepEqual(Reflect.ownKeys(config), [
    'mode', 'databaseUrl', 'pollMs', 'leaseMs',
    'databaseStatementTimeoutMs', 'shutdownGraceMs',
  ]);
});

void test('accepts a NodeJS ProcessEnv record with the runtime process.env prototype', () => {
  const environment = Object.assign(Object.create(Object.getPrototypeOf(process.env)) as NodeJS.ProcessEnv, {
    DATABASE_URL,
  });

  assert.equal(parseExecutorConfig(environment).databaseUrl, DATABASE_URL);
});

void test('accepts every inclusive duration boundary and the exact safety relations', () => {
  assert.deepEqual(parseExecutorConfig({
    DATABASE_URL,
    EXECUTOR_POLL_MS: '100',
    EXECUTOR_LEASE_MS: '3000',
    EXECUTOR_DB_STATEMENT_TIMEOUT_MS: '100',
    EXECUTOR_SHUTDOWN_GRACE_MS: '1100',
  }), {
    mode: 'dry-run', databaseUrl: DATABASE_URL, pollMs: 100, leaseMs: 3_000,
    databaseStatementTimeoutMs: 100, shutdownGraceMs: 1_100,
  });
  assert.deepEqual(parseExecutorConfig({
    DATABASE_URL,
    EXECUTOR_POLL_MS: '60000',
    EXECUTOR_LEASE_MS: '300000',
    EXECUTOR_DB_STATEMENT_TIMEOUT_MS: '10000',
    EXECUTOR_SHUTDOWN_GRACE_MS: '60000',
  }), {
    mode: 'dry-run', databaseUrl: DATABASE_URL, pollMs: 60_000, leaseMs: 300_000,
    databaseStatementTimeoutMs: 10_000, shutdownGraceMs: 60_000,
  });
});

void test('rejects non-canonical decimals, exact bound violations and unsafe duration relations', () => {
  const invalid: Readonly<Record<string, string | undefined>>[] = [
    { EXECUTOR_POLL_MS: '99' }, { EXECUTOR_POLL_MS: '60001' },
    { EXECUTOR_LEASE_MS: '2999' }, { EXECUTOR_LEASE_MS: '300001' },
    { EXECUTOR_DB_STATEMENT_TIMEOUT_MS: '99' },
    { EXECUTOR_DB_STATEMENT_TIMEOUT_MS: '10001' },
    { EXECUTOR_SHUTDOWN_GRACE_MS: '999' },
    { EXECUTOR_SHUTDOWN_GRACE_MS: '60001' },
    { EXECUTOR_POLL_MS: '3000', EXECUTOR_LEASE_MS: '3000' },
    { EXECUTOR_LEASE_MS: '3000', EXECUTOR_DB_STATEMENT_TIMEOUT_MS: '1001' },
    { EXECUTOR_DB_STATEMENT_TIMEOUT_MS: '100', EXECUTOR_SHUTDOWN_GRACE_MS: '1099' },
  ];
  const ambiguous = ['', ' ', '+100', '0100', '100.0', '1e3', '-0', '١٠٠'];
  for (const value of ambiguous) invalid.push({ EXECUTOR_POLL_MS: value });

  for (const overrides of invalid) {
    assertConfigFailure({ DATABASE_URL, ...overrides });
  }
});

void test('requires a non-empty database URL and accepts only canonical dry-run safety switches', () => {
  assert.equal(parseExecutorConfig({ DATABASE_URL }).mode, 'dry-run');
  assert.equal(parseExecutorConfig({
    DATABASE_URL, EXECUTOR_MODE: 'dry-run', LIVE_TRADING_ENABLED: 'false',
  }).mode, 'dry-run');

  for (const databaseUrl of [undefined, '', '   ']) {
    assertConfigFailure({ DATABASE_URL: databaseUrl });
  }
  for (const mode of ['', 'DRY-RUN', 'live', 'dry-run ']) {
    assertConfigFailure({ DATABASE_URL, EXECUTOR_MODE: mode });
  }
  for (const live of ['', 'FALSE', '0', 'true', ' false']) {
    assertConfigFailure({ DATABASE_URL, LIVE_TRADING_ENABLED: live });
  }
});

void test('accepts absent, undefined and empty secret variables but rejects all non-empty values', () => {
  assert.equal(SECRET_KEYS.length, 12);
  assert.equal(parseExecutorConfig({ DATABASE_URL }).databaseUrl, DATABASE_URL);
  for (const key of SECRET_KEYS) {
    assert.equal(parseExecutorConfig({ DATABASE_URL, [key]: undefined }).databaseUrl, DATABASE_URL);
    assert.equal(parseExecutorConfig({ DATABASE_URL, [key]: '' }).databaseUrl, DATABASE_URL);
    assertConfigFailure({ DATABASE_URL, [key]: ' ' });
    assertConfigFailure({ DATABASE_URL, [key]: `sensitive-${key}` });
  }
});

void test('returns one typed fixed redacted error and rejects hostile environment records safely', () => {
  const secretUrl = 'postgresql://user:password@secret.invalid/executor';
  assertConfigFailure({ DATABASE_URL: secretUrl, EXECUTOR_POLL_MS: 'leak-me' }, [secretUrl, 'leak-me']);

  let getterCalls = 0;
  const accessor = { DATABASE_URL } as Record<string, string | undefined>;
  Object.defineProperty(accessor, 'EXECUTOR_POLL_MS', {
    enumerable: true,
    get: () => { getterCalls += 1; return '1000'; },
  });
  assertConfigFailure(accessor);
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const proxy = new Proxy({ DATABASE_URL }, {
    getOwnPropertyDescriptor: () => { proxyTraps += 1; throw new Error('proxy-secret'); },
    getPrototypeOf: () => { proxyTraps += 1; throw new Error('proxy-secret'); },
  });
  assertConfigFailure(proxy);
  assert.equal(proxyTraps, 0);
});

function assertConfigFailure(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  forbidden: readonly string[] = [],
): void {
  assert.throws(() => { parseExecutorConfig(environment); }, (error: unknown) => {
    assert.ok(error instanceof ExecutorConfigError);
    assert.equal(error.name, 'ExecutorConfigError');
    assert.equal(error.code, 'INVALID_EXECUTOR_CONFIG');
    assert.equal(error.message, 'Invalid executor configuration.');
    const serialized = JSON.stringify(error);
    assert.equal(serialized.includes('DATABASE_URL'), false);
    for (const value of forbidden) {
      assert.equal(error.message.includes(value), false);
      assert.equal(serialized.includes(value), false);
    }
    return true;
  });
}

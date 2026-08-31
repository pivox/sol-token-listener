import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutorConfigError,
  parseExecutorConfig,
} from '../src/executor/config.js';

const DATABASE_URL = 'postgresql://executor@127.0.0.1:5432/executor';
const EXECUTOR_PUBLIC_KEY = 'gCr8XkSUeFUxTpZE8HrZMGC98XdGGVyakeocBNTDibJ';
const EXPECTED_GENESIS_HASH = '2MPoZYQYPdDkMNKdb7Z3U6ypaiddzuNBAqKNBypSh3pN';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const HTTP_RPC_URL = 'https://operator:credential@rpc.example.test/solana';
const SECRET_KEYS = Object.freeze([
  'EXECUTOR_PRIVATE_KEY',
  'EXECUTOR_SECRET_KEY',
  'EXECUTOR_KEYPAIR',
  'EXECUTOR_KEYPAIR_PATH',
  'SOLANA_PRIVATE_KEY',
  'SOLANA_PRIVATE_KEY_BASE58',
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

void test('parses the exact frozen simulation-only defaults without any signing material', () => {
  const config = parseExecutorConfig(simulationEnvironment());

  assert.deepEqual(config, {
    mode: 'simulation-only',
    databaseUrl: DATABASE_URL,
    pollMs: 1_000,
    leaseMs: 30_000,
    databaseStatementTimeoutMs: 3_000,
    shutdownGraceMs: 10_000,
    executorPublicKey: EXECUTOR_PUBLIC_KEY,
    providerId: 'primary',
    httpRpcUrl: HTTP_RPC_URL,
    expectedGenesisHash: EXPECTED_GENESIS_HASH,
    quoteMaxAgeMs: 3_000,
    slippageBps: 500n,
    snapshotMaxSlotLag: 8,
    maxComputeUnits: 300_000n,
    maxFeeLamports: 100_000n,
    maxFeePayerLamportDebit: 2_500_000n,
    maxPriorityFeeLamports: 0n,
    rpcTimeoutMs: 5_000,
    maxRpcCallsPerAttempt: 8,
    quoteMintAllowlist: [WSOL_MINT],
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.quoteMintAllowlist), true);
  assert.deepEqual(Reflect.ownKeys(config), [
    'mode', 'databaseUrl', 'pollMs', 'leaseMs',
    'databaseStatementTimeoutMs', 'shutdownGraceMs', 'executorPublicKey',
    'providerId', 'httpRpcUrl', 'expectedGenesisHash', 'quoteMaxAgeMs',
    'slippageBps', 'snapshotMaxSlotLag', 'maxComputeUnits', 'maxFeeLamports',
    'maxFeePayerLamportDebit', 'maxPriorityFeeLamports', 'rpcTimeoutMs',
    'maxRpcCallsPerAttempt', 'quoteMintAllowlist',
  ]);
});

void test('ignores every public simulation variable in dry-run without invoking accessors', () => {
  const environment: Record<string, string | undefined> = {
    DATABASE_URL,
    EXECUTOR_PUBLIC_KEY: 'not-a-public-key',
    EXECUTOR_RPC_PROVIDER_ID: '',
    SOLANA_HTTP_RPC_URL: 'not-a-url',
    SOLANA_EXPECTED_GENESIS_HASH: 'not-a-hash',
    EXECUTOR_QUOTE_MAX_AGE_MS: 'invalid',
    EXECUTOR_SLIPPAGE_BPS: 'invalid',
    EXECUTOR_SNAPSHOT_MAX_SLOT_LAG: 'invalid',
    EXECUTOR_MAX_COMPUTE_UNITS: 'invalid',
    EXECUTOR_MAX_FEE_LAMPORTS: 'invalid',
    EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT: 'invalid',
    EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS: 'invalid',
    EXECUTOR_RPC_TIMEOUT_MS: 'invalid',
    EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: 'invalid',
    LIVE_QUOTE_MINT_ALLOWLIST: 'invalid',
  };
  let getterCalls = 0;
  Object.defineProperty(environment, 'EXECUTOR_PUBLIC_KEY', {
    enumerable: true,
    get: () => { getterCalls += 1; return 'getter-secret'; },
  });

  assert.deepEqual(parseExecutorConfig(environment), {
    mode: 'dry-run', databaseUrl: DATABASE_URL, pollMs: 1_000, leaseMs: 30_000,
    databaseStatementTimeoutMs: 3_000, shutdownGraceMs: 10_000,
  });
  assert.equal(getterCalls, 0);
});

void test('requires the three public simulation identities and keeps RPC URL errors redacted', () => {
  for (const key of [
    'EXECUTOR_PUBLIC_KEY', 'SOLANA_HTTP_RPC_URL', 'SOLANA_EXPECTED_GENESIS_HASH',
  ] as const) {
    assertConfigFailure({ ...simulationEnvironment(), [key]: undefined });
    assertConfigFailure({ ...simulationEnvironment(), [key]: '' });
  }
  const secretUrl = 'https://operator:credential@private.invalid/rpc';
  assertConfigFailure({ ...simulationEnvironment(), SOLANA_HTTP_RPC_URL: secretUrl.replace('https:', 'ftp:') }, [
    secretUrl, 'operator', 'credential', 'private.invalid',
  ]);
  assertConfigFailure({ ...simulationEnvironment(), EXECUTOR_PUBLIC_KEY: 'invalid' });
  assertConfigFailure({ ...simulationEnvironment(), SOLANA_EXPECTED_GENESIS_HASH: 'invalid' });
});

void test('accepts canonical simulation overrides at inclusive safety boundaries', () => {
  const config = parseExecutorConfig(simulationEnvironment({
    EXECUTOR_RPC_PROVIDER_ID: 'provider-1',
    EXECUTOR_QUOTE_MAX_AGE_MS: '1',
    EXECUTOR_SLIPPAGE_BPS: '10000',
    EXECUTOR_SNAPSHOT_MAX_SLOT_LAG: '0',
    EXECUTOR_MAX_COMPUTE_UNITS: '1',
    EXECUTOR_MAX_FEE_LAMPORTS: '0',
    EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT: '0',
    EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS: '0',
    EXECUTOR_RPC_TIMEOUT_MS: '1',
    EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '6',
    LIVE_TRADING_ENABLED: 'false',
  }));
  assert.equal(config.mode, 'simulation-only');
  assert.equal(config.quoteMaxAgeMs, 1);
  assert.equal(config.slippageBps, 10_000n);
  assert.equal(config.snapshotMaxSlotLag, 0);
  assert.equal(config.maxComputeUnits, 1n);
  assert.equal(config.maxFeeLamports, 0n);
  assert.equal(config.maxFeePayerLamportDebit, 0n);
  assert.equal(config.maxPriorityFeeLamports, 0n);
  assert.equal(config.rpcTimeoutMs, 1);
  assert.equal(config.maxRpcCallsPerAttempt, 6);
});

void test('rejects noncanonical or unsafe simulation gates and the non-WSOL allowlist', () => {
  const invalid: Readonly<Record<string, string | undefined>>[] = [
    { EXECUTOR_RPC_PROVIDER_ID: '' },
    { EXECUTOR_RPC_PROVIDER_ID: 'provider with spaces' },
    { EXECUTOR_RPC_PROVIDER_ID: 'a'.repeat(65) },
    { EXECUTOR_QUOTE_MAX_AGE_MS: '0' },
    { EXECUTOR_SLIPPAGE_BPS: '10001' },
    { EXECUTOR_SNAPSHOT_MAX_SLOT_LAG: '-1' },
    { EXECUTOR_SNAPSHOT_MAX_SLOT_LAG: '129' },
    { EXECUTOR_MAX_COMPUTE_UNITS: '0' },
    { EXECUTOR_MAX_COMPUTE_UNITS: '1400001' },
    { EXECUTOR_MAX_FEE_LAMPORTS: '-1' },
    { EXECUTOR_MAX_FEE_LAMPORTS: '10000001' },
    { EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT: '-1' },
    { EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT: '10000000001' },
    { EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS: '1' },
    { EXECUTOR_RPC_TIMEOUT_MS: '0' },
    { EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '5' },
    { EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '17' },
    { LIVE_QUOTE_MINT_ALLOWLIST: `${WSOL_MINT},11111111111111111111111111111111` },
    { LIVE_QUOTE_MINT_ALLOWLIST: ` ${WSOL_MINT}` },
    { LIVE_TRADING_ENABLED: 'true' },
    { SOLANA_HTTP_RPC_URL: `${HTTP_RPC_URL}#fragment` },
    { SOLANA_HTTP_RPC_URL: ` ${HTTP_RPC_URL}` },
  ];
  for (const key of [
    'EXECUTOR_QUOTE_MAX_AGE_MS', 'EXECUTOR_SLIPPAGE_BPS',
    'EXECUTOR_SNAPSHOT_MAX_SLOT_LAG', 'EXECUTOR_MAX_COMPUTE_UNITS',
    'EXECUTOR_MAX_FEE_LAMPORTS', 'EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT',
    'EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS', 'EXECUTOR_RPC_TIMEOUT_MS',
    'EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT',
  ]) {
    invalid.push({ [key]: '01' });
  }
  for (const overrides of invalid) {
    assertConfigFailure(simulationEnvironment(overrides));
  }
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
  assert.equal(SECRET_KEYS.length, 13);
  assert.equal(parseExecutorConfig({ DATABASE_URL }).databaseUrl, DATABASE_URL);
  for (const key of SECRET_KEYS) {
    assert.equal(parseExecutorConfig({ DATABASE_URL, [key]: undefined }).databaseUrl, DATABASE_URL);
    assert.equal(parseExecutorConfig({ DATABASE_URL, [key]: '' }).databaseUrl, DATABASE_URL);
    assertConfigFailure({ DATABASE_URL, [key]: ' ' });
    assertConfigFailure({ DATABASE_URL, [key]: `sensitive-${key}` });
    assertConfigFailure(simulationEnvironment({ [key]: `sensitive-${key}` }));
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

function simulationEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL,
    EXECUTOR_MODE: 'simulation-only',
    EXECUTOR_PUBLIC_KEY,
    SOLANA_HTTP_RPC_URL: HTTP_RPC_URL,
    SOLANA_EXPECTED_GENESIS_HASH: EXPECTED_GENESIS_HASH,
    ...overrides,
  };
}

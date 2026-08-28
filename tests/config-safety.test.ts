import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config/env.js';
import { loadQualificationProfile } from '../src/qualification/qualification-profile.js';
import { executionBoundaryViolations } from './helpers/execution-boundary.js';

const base = {
  SOLANA_HTTP_RPC_URL: 'https://rpc.example.invalid',
  SOLANA_WS_RPC_URL: 'wss://rpc.example.invalid',
};

void test('fallback HTTP RPC defaults to a frozen empty list when absent or whitespace-only', () => {
  for (const value of [undefined, '   ']) {
    const config = parseConfig({ ...base, SOLANA_HTTP_RPC_FALLBACK_URLS: value });
    assert.deepEqual(config.httpRpcFallbackUrls, []);
    assert.equal(Object.isFrozen(config.httpRpcFallbackUrls), true);
  }
});

void test('fallback HTTP RPC preserves order and canonicalizes valid endpoints', () => {
  const config = parseConfig({
    ...base,
    SOLANA_HTTP_RPC_FALLBACK_URLS: 'HTTPS://ONE.EXAMPLE.INVALID,https://two.example.invalid/path',
  });
  assert.deepEqual(config.httpRpcFallbackUrls, [
    'https://one.example.invalid/',
    'https://two.example.invalid/path',
  ]);
  assert.equal(Object.isFrozen(config.httpRpcFallbackUrls), true);
  assert.deepEqual(config.wsRpcFallbackUrls, []);
});

void test('fallback HTTP RPC rejects canonical duplicates including the primary endpoint', () => {
  for (const value of [
    'https://rpc.example.invalid/',
    'https://fallback.example.invalid,https://fallback.example.invalid/',
  ]) {
    assert.throws(
      () => parseConfig({ ...base, SOLANA_HTTP_RPC_FALLBACK_URLS: value }),
      /SOLANA_HTTP_RPC_FALLBACK_URLS/u,
    );
  }
});

void test('fallback HTTP RPC rejects empty entries', () => {
  for (const value of [
    ',https://fallback.example.invalid',
    'https://fallback.example.invalid,',
    'https://one.example.invalid,,https://two.example.invalid',
  ]) {
    assert.throws(
      () => parseConfig({ ...base, SOLANA_HTTP_RPC_FALLBACK_URLS: value }),
      /SOLANA_HTTP_RPC_FALLBACK_URLS/u,
    );
  }
});

void test('fallback HTTP RPC rejects invalid URLs and protocols', () => {
  for (const value of ['not a URL', 'ftp://fallback.example.invalid']) {
    assert.throws(
      () => parseConfig({ ...base, SOLANA_HTTP_RPC_FALLBACK_URLS: value }),
      /SOLANA_HTTP_RPC_FALLBACK_URLS/u,
    );
  }
});

void test('fallback HTTP RPC rejects a fallback URL fragment with a fixed redacted error', () => {
  const fallback = 'https://fallback.example.invalid/rpc#fallback-secret';
  assert.throws(
    () => parseConfig({ ...base, SOLANA_HTTP_RPC_FALLBACK_URLS: fallback }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'HTTP RPC endpoint URLs must not contain fragments when fallbacks are configured.');
      assert.doesNotMatch(String(error), /fallback-secret|fallback\.example\.invalid|\/rpc/iu);
      return true;
    },
  );
});

void test('fallback HTTP RPC rejects a primary URL fragment only when fallbacks are configured', () => {
  const primary = 'https://rpc.example.invalid/rpc#primary-secret';
  assert.equal(parseConfig({ ...base, SOLANA_HTTP_RPC_URL: primary }).httpRpcUrl, primary);

  assert.throws(
    () => parseConfig({
      ...base,
      SOLANA_HTTP_RPC_URL: primary,
      SOLANA_HTTP_RPC_FALLBACK_URLS: 'https://fallback.example.invalid/rpc',
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'HTTP RPC endpoint URLs must not contain fragments when fallbacks are configured.');
      assert.doesNotMatch(String(error), /primary-secret|rpc\.example\.invalid|\/rpc/iu);
      return true;
    },
  );
});

void test('fallback HTTP RPC rejects mixed schemes', () => {
  assert.throws(
    () => parseConfig({ ...base, SOLANA_HTTP_RPC_FALLBACK_URLS: 'http://fallback.example.invalid' }),
    /SOLANA_HTTP_RPC_FALLBACK_URLS/u,
  );
});

void test('fallback HTTP RPC rejects more than three fallback endpoints', () => {
  assert.throws(
    () => parseConfig({
      ...base,
      SOLANA_HTTP_RPC_FALLBACK_URLS: [
        'https://one.example.invalid',
        'https://two.example.invalid',
        'https://three.example.invalid',
        'https://four.example.invalid',
      ].join(','),
    }),
    /SOLANA_HTTP_RPC_FALLBACK_URLS/u,
  );
});

void test('fallback HTTP RPC validation errors redact configured endpoint secrets', () => {
  const secretEndpoint = 'ftp://user:super-secret@private.example.invalid/path?apiKey=private-key';
  assert.throws(
    () => parseConfig({ ...base, SOLANA_HTTP_RPC_FALLBACK_URLS: secretEndpoint }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      for (const secret of [
        secretEndpoint,
        'user',
        'super-secret',
        'private.example.invalid',
        '/path',
        'apiKey',
        'private-key',
      ]) assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

void test('fallback WebSocket RPC defaults to a frozen empty list when both fallback lists are absent or whitespace-only', () => {
  for (const value of [undefined, '   ']) {
    const config = parseConfig({
      ...base,
      SOLANA_HTTP_RPC_FALLBACK_URLS: value,
      SOLANA_WS_RPC_FALLBACK_URLS: value,
    });
    assert.deepEqual(config.wsRpcFallbackUrls, []);
    assert.equal(Object.isFrozen(config.wsRpcFallbackUrls), true);
  }
});

void test('paired RPC fallbacks preserve canonical order for HTTP and WebSocket endpoints', () => {
  const config = parseConfig({
    ...base,
    SOLANA_HTTP_RPC_FALLBACK_URLS: 'HTTPS://ONE.EXAMPLE.INVALID,https://two.example.invalid/path',
    SOLANA_WS_RPC_FALLBACK_URLS: 'WSS://ONE.EXAMPLE.INVALID,wss://two.example.invalid/path',
  });
  assert.deepEqual(config.httpRpcFallbackUrls, [
    'https://one.example.invalid/',
    'https://two.example.invalid/path',
  ]);
  assert.deepEqual(config.wsRpcFallbackUrls, [
    'wss://one.example.invalid/',
    'wss://two.example.invalid/path',
  ]);
  assert.equal(Object.isFrozen(config.wsRpcFallbackUrls), true);
});

void test('paired RPC fallbacks require both lists with the same cardinality', () => {
  for (const environment of [
    { SOLANA_WS_RPC_FALLBACK_URLS: 'wss://one.example.invalid' },
    {
      SOLANA_HTTP_RPC_FALLBACK_URLS: 'https://one.example.invalid,https://two.example.invalid',
      SOLANA_WS_RPC_FALLBACK_URLS: 'wss://one.example.invalid',
    },
  ]) {
    assert.throws(() => parseConfig({ ...base, ...environment }), /RPC fallback endpoint lists/u);
  }
});

void test('paired RPC endpoints require https/wss or http/ws at every position', () => {
  for (const environment of [
    {
      SOLANA_WS_RPC_URL: 'ws://rpc.example.invalid',
      SOLANA_HTTP_RPC_FALLBACK_URLS: 'https://one.example.invalid',
      SOLANA_WS_RPC_FALLBACK_URLS: 'ws://one.example.invalid',
    },
    {
      SOLANA_HTTP_RPC_URL: 'http://rpc.example.invalid',
      SOLANA_WS_RPC_URL: 'wss://rpc.example.invalid',
      SOLANA_HTTP_RPC_FALLBACK_URLS: 'http://one.example.invalid',
      SOLANA_WS_RPC_FALLBACK_URLS: 'wss://one.example.invalid',
    },
  ]) {
    assert.throws(() => parseConfig({ ...base, ...environment }), /RPC endpoint protocols/u);
  }
});

void test('fallback WebSocket RPC rejects blanks, fragments, and canonical duplicates without leaking endpoints', () => {
  const secret = 'wss://user:super-secret@private.example.invalid/rpc#fragment-secret';
  for (const environment of [
    {
      SOLANA_HTTP_RPC_FALLBACK_URLS: 'https://one.example.invalid',
      SOLANA_WS_RPC_FALLBACK_URLS: 'wss://one.example.invalid,',
    },
    {
      SOLANA_HTTP_RPC_FALLBACK_URLS: 'https://one.example.invalid',
      SOLANA_WS_RPC_FALLBACK_URLS: 'wss://rpc.example.invalid/',
    },
    {
      SOLANA_HTTP_RPC_FALLBACK_URLS: 'https://one.example.invalid,https://two.example.invalid',
      SOLANA_WS_RPC_FALLBACK_URLS: 'wss://one.example.invalid,wss://one.example.invalid/',
    },
    {
      SOLANA_HTTP_RPC_FALLBACK_URLS: 'https://one.example.invalid',
      SOLANA_WS_RPC_FALLBACK_URLS: secret,
    },
  ]) {
    assert.throws(
      () => parseConfig({ ...base, ...environment }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /super-secret|private\.example\.invalid|fragment-secret|\/rpc/iu);
        return true;
      },
    );
  }
});

void test('fallback WebSocket RPC rejects more than three paired endpoints', () => {
  assert.throws(
    () => parseConfig({
      ...base,
      SOLANA_HTTP_RPC_FALLBACK_URLS: [
        'https://one.example.invalid',
        'https://two.example.invalid',
        'https://three.example.invalid',
      ].join(','),
      SOLANA_WS_RPC_FALLBACK_URLS: [
        'wss://one.example.invalid',
        'wss://two.example.invalid',
        'wss://three.example.invalid',
        'wss://four.example.invalid',
      ].join(','),
    }),
    /SOLANA_WS_RPC_FALLBACK_URLS/u,
  );
});

void test('le mode par défaut est strictement observe', () => {
  const config = parseConfig(base);
  assert.equal(config.executionMode, 'observe');
});

void test('le mode paper est accepté avec SOL dans son allowlist initiale', () => {
  const config = parseConfig({ ...base, EXECUTION_MODE: 'paper' });
  assert.equal(config.executionMode, 'paper');
  assert.deepEqual(config.paperQuoteMintAllowlist, [config.wsolMint]);
});

void test('la stratégie paper end-to-end est strictement désactivée par défaut', () => {
  const config = parseConfig(base);
  assert.deepEqual({
    enabled: config.paperStrategyEnabled,
    id: config.paperStrategyId,
    version: config.paperStrategyVersion,
    entryQuoteAmountRaw: config.paperEntryQuoteAmountRaw,
    externalBuyTarget: config.paperExternalBuyTarget,
    minimumConfirmation: config.paperMinimumConfirmation,
    entryWindowSeconds: config.paperEntryWindowSeconds,
    quoteMaxAgeMs: config.paperQuoteMaxAgeMs,
    quoteMaxSlotLag: config.paperQuoteMaxSlotLag,
    slippageBps: config.paperSlippageBps,
    workerPollMs: config.paperDecisionWorkerPollMs,
    workerLeaseSeconds: config.paperDecisionWorkerLeaseSeconds,
    retryMaxAttempts: config.paperDecisionRetryMaxAttempts,
    retryBaseDelayMs: config.paperDecisionRetryBaseDelayMs,
  }, {
    enabled: false,
    id: 'validated-external-buys',
    version: 1,
    entryQuoteAmountRaw: null,
    externalBuyTarget: 10,
    minimumConfirmation: 'confirmed',
    entryWindowSeconds: 45,
    quoteMaxAgeMs: 5_000,
    quoteMaxSlotLag: 32,
    slippageBps: null,
    workerPollMs: 1_000,
    workerLeaseSeconds: 30,
    retryMaxAttempts: 5,
    retryBaseDelayMs: 500,
  });
});

void test('la stratégie paper exige un mode et des seuils explicitement sûrs', () => {
  const enabled = {
    ...base,
    EXECUTION_MODE: 'paper',
    PAPER_STRATEGY_ENABLED: 'true',
    PAPER_ENTRY_QUOTE_AMOUNT_RAW: '10000000',
    PAPER_SLIPPAGE_BPS: '1500',
    QUALIFICATION_PROFILE_PATH: './config/qualification/pumpfun-v1-unvalidated.json',
    RISK_MAX_ROUNDTRIP_LOSS_BPS: '3000',
  } as const;
  const config = parseConfig(enabled);
  assert.equal(config.paperStrategyEnabled, true);
  assert.equal(config.paperEntryQuoteAmountRaw, 10_000_000n);
  assert.equal(config.paperSlippageBps, 1_500n);

  assert.throws(() => parseConfig({ ...enabled, EXECUTION_MODE: 'observe' }), /PAPER_STRATEGY_ENABLED.*paper/u);
  assert.throws(() => parseConfig({ ...enabled, PAPER_ENTRY_QUOTE_AMOUNT_RAW: '' }), /PAPER_ENTRY_QUOTE_AMOUNT_RAW/u);
  assert.throws(() => parseConfig({ ...enabled, PAPER_ENTRY_QUOTE_AMOUNT_RAW: '0' }), /PAPER_ENTRY_QUOTE_AMOUNT_RAW/u);
  assert.throws(() => parseConfig({ ...enabled, PAPER_SLIPPAGE_BPS: '' }), /PAPER_SLIPPAGE_BPS/u);
  assert.throws(() => parseConfig({ ...enabled, QUALIFICATION_PROFILE_PATH: '' }), /QUALIFICATION_PROFILE_PATH/u);
  assert.throws(() => parseConfig({ ...enabled, RISK_MAX_ROUNDTRIP_LOSS_BPS: undefined }), /RISK_MAX_ROUNDTRIP_LOSS_BPS/u);
});

void test('la stratégie creation-entry-v1 est fermée, explicite et exclusivement paper', () => {
  const enabled = {
    ...base,
    EXECUTION_MODE: 'paper',
    CREATION_STRATEGY_ENABLED: 'true',
    CREATION_ENTRY_MAX_AGE_MS: '45000',
    CREATION_ENTRY_MAX_SLOT_LAG: '32',
    EXTERNAL_UNIQUE_BUYERS_TARGET: '10',
    EXTERNAL_MIN_BUY_AMOUNT_RAW: '1000000',
    CREATION_TAKE_PROFIT_MULTIPLIER_BPS: '20000',
    CREATION_MANUAL_KILL_SWITCH: 'false',
    PAPER_ENTRY_QUOTE_AMOUNT_RAW: '10000000',
    PAPER_SLIPPAGE_BPS: '500',
    QUALIFICATION_PROFILE_PATH: './config/qualification/pumpfun-v1-unvalidated.json',
    RISK_MAX_ROUNDTRIP_LOSS_BPS: '3000',
  } as const;
  const config = parseConfig(enabled);

  assert.deepEqual({
    paperStrategyEnabled: config.paperStrategyEnabled,
    enabled: config.creationStrategyEnabled,
    id: config.paperStrategyId,
    version: config.paperStrategyVersion,
    maximumAgeMs: config.creationEntryMaxAgeMs,
    maximumSlotLag: config.creationEntryMaxSlotLag,
    uniqueBuyerTarget: config.paperExternalBuyTarget,
    minimumBuyAmountRaw: config.externalMinimumBuyAmountRaw,
    takeProfitMultiplierBps: config.creationTakeProfitMultiplierBps,
    manualKillSwitch: config.creationManualKillSwitch,
  }, {
    paperStrategyEnabled: true,
    enabled: true,
    id: 'creation-entry-v1',
    version: 1,
    maximumAgeMs: 45_000,
    maximumSlotLag: 32,
    uniqueBuyerTarget: 10,
    minimumBuyAmountRaw: 1_000_000n,
    takeProfitMultiplierBps: 20_000n,
    manualKillSwitch: false,
  });

  assert.throws(
    () => parseConfig({ ...enabled, EXECUTION_MODE: 'observe' }),
    /CREATION_STRATEGY_ENABLED.*paper/u,
  );
  assert.throws(
    () => parseConfig({ ...enabled, PAPER_STRATEGY_ENABLED: 'true' }),
    /strategy.*simultaneously|simultaneous.*strategy/iu,
  );
  assert.throws(() => parseConfig({ ...enabled, EXTERNAL_MIN_BUY_AMOUNT_RAW: '' }));
  assert.throws(() => parseConfig({ ...enabled, EXTERNAL_MIN_BUY_AMOUNT_RAW: '0' }));
  assert.throws(() => parseConfig({ ...enabled, CREATION_TAKE_PROFIT_MULTIPLIER_BPS: '9999' }));
  assert.throws(() => parseConfig({ ...enabled, CREATION_MANUAL_KILL_SWITCH: '1' }));
});

void test('la configuration paper accepte ses bornes inclusives exactes', () => {
  const minimums = parseConfig({
    ...base,
    PAPER_EXTERNAL_BUY_TARGET: '1', PAPER_ENTRY_WINDOW_SECONDS: '1',
    PAPER_QUOTE_MAX_AGE_MS: '100', PAPER_QUOTE_MAX_SLOT_LAG: '0',
    PAPER_DECISION_WORKER_POLL_MS: '100', PAPER_DECISION_WORKER_LEASE_SECONDS: '5',
    PAPER_DECISION_RETRY_MAX_ATTEMPTS: '1', PAPER_DECISION_RETRY_BASE_DELAY_MS: '100',
  });
  assert.deepEqual([
    minimums.paperExternalBuyTarget, minimums.paperEntryWindowSeconds,
    minimums.paperQuoteMaxAgeMs, minimums.paperQuoteMaxSlotLag,
    minimums.paperDecisionWorkerPollMs, minimums.paperDecisionWorkerLeaseSeconds,
    minimums.paperDecisionRetryMaxAttempts, minimums.paperDecisionRetryBaseDelayMs,
  ], [1, 1, 100, 0, 100, 5, 1, 100]);

  const maximums = parseConfig({
    ...base,
    PAPER_EXTERNAL_BUY_TARGET: '1000', PAPER_ENTRY_WINDOW_SECONDS: '3600',
    PAPER_QUOTE_MAX_AGE_MS: '60000', PAPER_QUOTE_MAX_SLOT_LAG: '10000',
    PAPER_DECISION_WORKER_POLL_MS: '60000', PAPER_DECISION_WORKER_LEASE_SECONDS: '900',
    PAPER_DECISION_RETRY_MAX_ATTEMPTS: '100', PAPER_DECISION_RETRY_BASE_DELAY_MS: '60000',
    PAPER_MINIMUM_CONFIRMATION: 'finalized',
  });
  assert.deepEqual([
    maximums.paperExternalBuyTarget, maximums.paperEntryWindowSeconds,
    maximums.paperQuoteMaxAgeMs, maximums.paperQuoteMaxSlotLag,
    maximums.paperDecisionWorkerPollMs, maximums.paperDecisionWorkerLeaseSeconds,
    maximums.paperDecisionRetryMaxAttempts, maximums.paperDecisionRetryBaseDelayMs,
    maximums.paperMinimumConfirmation,
  ], [1_000, 3_600, 60_000, 10_000, 60_000, 900, 100, 60_000, 'finalized']);
});

void test('la configuration paper rejette les identifiants, enums, nombres ambigus et dépassements', () => {
  const invalid: readonly Record<string, string>[] = [
    { PAPER_STRATEGY_ENABLED: '1' },
    { PAPER_STRATEGY_ID: 'other' },
    { PAPER_STRATEGY_VERSION: '2' },
    { PAPER_MINIMUM_CONFIRMATION: 'processed' },
    { PAPER_EXTERNAL_BUY_TARGET: '01' },
    { PAPER_EXTERNAL_BUY_TARGET: '1001' },
    { PAPER_ENTRY_WINDOW_SECONDS: '3601' },
    { PAPER_QUOTE_MAX_AGE_MS: '60001' },
    { PAPER_QUOTE_MAX_SLOT_LAG: '10001' },
    { PAPER_DECISION_WORKER_POLL_MS: '60001' },
    { PAPER_DECISION_WORKER_LEASE_SECONDS: '901' },
    { PAPER_DECISION_RETRY_MAX_ATTEMPTS: '101' },
    { PAPER_DECISION_RETRY_BASE_DELAY_MS: '60001' },
  ];
  for (const values of invalid) assert.throws(() => parseConfig({ ...base, ...values }));

  const enabled = {
    ...base,
    EXECUTION_MODE: 'paper',
    PAPER_STRATEGY_ENABLED: 'true',
    PAPER_ENTRY_QUOTE_AMOUNT_RAW: '1',
    PAPER_SLIPPAGE_BPS: '0',
    QUALIFICATION_PROFILE_PATH: './config/qualification/pumpfun-v1-unvalidated.json',
    RISK_MAX_ROUNDTRIP_LOSS_BPS: '3000',
  } as const;
  for (const value of ['01', '+1', '-1', ' 1', '1 ', '1e3', '1.0', '18446744073709551616']) {
    assert.throws(() => parseConfig({ ...enabled, PAPER_ENTRY_QUOTE_AMOUNT_RAW: value }));
  }
  for (const value of ['01', '+1', '-1', ' 1', '1 ', '1e3', '1.0', '10001']) {
    assert.throws(() => parseConfig({ ...enabled, PAPER_SLIPPAGE_BPS: value }));
  }
});

void test('le modèle d’environnement publie la stratégie paper inactive et sans montant implicite', async () => {
  const source = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  for (const line of [
    'PAPER_STRATEGY_ENABLED=false', 'PAPER_STRATEGY_ID=validated-external-buys',
    'PAPER_STRATEGY_VERSION=1', 'PAPER_ENTRY_QUOTE_AMOUNT_RAW=',
    'PAPER_EXTERNAL_BUY_TARGET=10', 'PAPER_MINIMUM_CONFIRMATION=confirmed',
    'PAPER_ENTRY_WINDOW_SECONDS=45', 'PAPER_QUOTE_MAX_AGE_MS=5000',
    'PAPER_QUOTE_MAX_SLOT_LAG=32', 'PAPER_SLIPPAGE_BPS=',
    'PAPER_DECISION_WORKER_POLL_MS=1000', 'PAPER_DECISION_WORKER_LEASE_SECONDS=30',
    'PAPER_DECISION_RETRY_MAX_ATTEMPTS=5', 'PAPER_DECISION_RETRY_BASE_DELAY_MS=500',
    'CREATION_STRATEGY_ENABLED=false', 'CREATION_ENTRY_MAX_AGE_MS=45000',
    'CREATION_ENTRY_MAX_SLOT_LAG=32', 'EXTERNAL_UNIQUE_BUYERS_TARGET=10',
    'EXTERNAL_MIN_BUY_AMOUNT_RAW=', 'CREATION_TAKE_PROFIT_MULTIPLIER_BPS=20000',
    'CREATION_MANUAL_KILL_SWITCH=false',
  ]) assert.match(source, new RegExp(`^${line}$`, 'mu'));
});

void test('le live est toujours refusé dans la V1', () => {
  assert.throws(() => parseConfig({
    ...base,
    EXECUTION_MODE: 'live',
  }), /observe.*paper/u);
});

void test('toute configuration de clé privée est refusée', () => {
  assert.throws(() => parseConfig({
    ...base,
    SOLANA_KEYPAIR_PATH: '/tmp/id.json',
  }), /private key/u);
  assert.throws(() => parseConfig({
    ...base,
    SOLANA_PRIVATE_KEY_BASE58: 'secret',
  }), /private key/u);
});

void test('les actions dashboard exigent leur confirmation indépendante', () => {
  assert.throws(() => parseConfig({ ...base, DASHBOARD_ACTIONS_ENABLED: 'true' }), /read-only/u);
});

void test('le seuil de qualification absent reste sans override et un seuil explicite est borné', () => {
  assert.equal(parseConfig(base).qualificationMinimumScore, null);
  assert.equal(parseConfig({ ...base, QUALIFICATION_MIN_SCORE: '61' }).qualificationMinimumScore, 61);
  assert.throws(
    () => parseConfig({ ...base, QUALIFICATION_MIN_SCORE: '101' }),
    /QUALIFICATION_MIN_SCORE/u,
  );
});

void test('selects one local qualification profile and validates its fixed status', () => {
  assert.equal(parseConfig(base).qualificationProfilePath, null);
  assert.equal(
    parseConfig({ ...base, QUALIFICATION_PROFILE_PATH: './profile.json' }).qualificationProfilePath,
    './profile.json',
  );
  for (const profilePath of [' ', 'x'.repeat(4_097), 'profile\u0000.json']) {
    assert.throws(() => parseConfig({ ...base, QUALIFICATION_PROFILE_PATH: profilePath }), /QUALIFICATION_PROFILE_PATH/u);
  }
  assert.throws(() => parseConfig({ ...base, QUALIFICATION_RULE_SET_STATUS: 'VALIDATED' }), /QUALIFICATION_RULE_SET_STATUS/u);
});

void test('the environment example publishes explicit qualification selection defaults', async () => {
  const source = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  for (const line of ['QUALIFICATION_PROFILE_PATH=', 'QUALIFICATION_MIN_SCORE=', 'QUALIFICATION_RULE_SET_STATUS=UNVALIDATED_RULE_SET']) {
    assert.match(source, new RegExp(`^${line}$`, 'mu'));
  }
});

void test('l’API publique est activée localement avec des limites sûres par défaut', () => {
  const config = parseConfig(base);
  assert.equal(config.apiEnabled, true);
  assert.equal(config.apiHost, '127.0.0.1');
  assert.equal(config.apiPort, 3_000);
  assert.equal(config.apiPageLimitDefault, 50);
  assert.equal(config.apiPageLimitMaximum, 200);
  assert.equal(config.apiHolderPositionLimit, 100);
  assert.equal(config.apiHolderSnapshotLimit, 100);
  assert.equal(config.apiWalletClusterLimit, 50);
  assert.equal(config.apiWalletClusterMemberLimit, 50);
  assert.equal(config.apiWalletClusterTotalMemberLimit, 500);
  assert.equal(config.apiSseHeartbeatMs, 15_000);
  assert.equal(config.apiSsePollMs, 1_000);
});

void test('la configuration API refuse les valeurs ambiguës ou hors limites', () => {
  const invalid: readonly Record<string, string>[] = [
    { API_ENABLED: '1' },
    { API_HOST: ' localhost' },
    { API_HOST: 'http://localhost' },
    { API_HOST: '127.0.0.1/path' },
    { API_PORT: '0' },
    { API_PORT: '65536' },
    { API_PAGE_LIMIT_DEFAULT: '201' },
    { API_PAGE_LIMIT_MAX: '201' },
    { API_PAGE_LIMIT_DEFAULT: '51', API_PAGE_LIMIT_MAX: '50' },
    { API_SSE_HEARTBEAT_MS: '999' },
    { API_SSE_POLL_MS: '99' },
    { API_HOLDER_POSITION_LIMIT: '501' },
    { API_HOLDER_SNAPSHOT_LIMIT: '501' },
    { API_WALLET_CLUSTER_LIMIT: '101' },
    { API_WALLET_CLUSTER_MEMBER_LIMIT: '101' },
    { API_WALLET_CLUSTER_TOTAL_MEMBER_LIMIT: '1001' },
  ];
  for (const values of invalid) assert.throws(() => parseConfig({ ...base, ...values }));
});

void test('le modèle d’environnement publie les valeurs API sûres exactes', async () => {
  const source = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  for (const line of [
    'API_ENABLED=true', 'API_HOST=127.0.0.1', 'API_PORT=3000',
    'API_PAGE_LIMIT_DEFAULT=50', 'API_PAGE_LIMIT_MAX=200',
    'API_SSE_HEARTBEAT_MS=15000', 'API_SSE_POLL_MS=1000',
    'API_HOLDER_POSITION_LIMIT=100', 'API_HOLDER_SNAPSHOT_LIMIT=100',
    'API_WALLET_CLUSTER_LIMIT=50', 'API_WALLET_CLUSTER_MEMBER_LIMIT=50',
    'API_WALLET_CLUSTER_TOTAL_MEMBER_LIMIT=500',
  ]) assert.match(source, new RegExp(`^${line}$`, 'mu'));
});

void test('le listener durable est activé avec des bornes sûres par défaut', () => {
  const config = parseConfig(base);
  assert.equal(config.listenerEnabled, true);
  assert.equal(config.listenerCatchUpPolicy, 'live-edge');
  assert.equal(config.listenerWorkerLeaseSeconds, 120);
  assert.equal(config.listenerCatchUpMaxPages, 20);
  assert.equal(config.listenerCatchUpPageSize, 100);
  assert.equal(config.listenerFinalityMissingPolls, 3);
  assert.equal(config.listenerShutdownTimeoutMs, 30_000);
  assert.equal(config.rpcRetryMaxAttempts, 5);
  assert.equal(config.rpcRetryBaseDelayMs, 500);
  assert.equal(config.reconcileSeconds, 15);
});

void test('la politique de rattrapage accepte uniquement live-edge ou strict', () => {
  assert.equal(
    parseConfig({ ...base, LISTENER_CATCH_UP_POLICY: 'strict' }).listenerCatchUpPolicy,
    'strict',
  );
  for (const value of ['latest', 'fail', 'LIVE-EDGE', ' live-edge', 'live-edge ']) {
    assert.throws(
      () => parseConfig({ ...base, LISTENER_CATCH_UP_POLICY: value }),
      /LISTENER_CATCH_UP_POLICY/u,
    );
  }
});

void test('la configuration listener accepte ses bornes exactes', () => {
  const minimums = parseConfig({
    ...base,
    LISTENER_ENABLED: 'false',
    LISTENER_WORKER_LEASE_SECONDS: '30',
    LISTENER_CATCH_UP_MAX_PAGES: '1',
    LISTENER_CATCH_UP_PAGE_SIZE: '1',
    LISTENER_FINALITY_MISSING_POLLS: '2',
    LISTENER_SHUTDOWN_TIMEOUT_MS: '1000',
  });
  assert.equal(minimums.listenerEnabled, false);
  assert.equal(minimums.listenerWorkerLeaseSeconds, 30);
  assert.equal(minimums.listenerCatchUpMaxPages, 1);
  assert.equal(minimums.listenerCatchUpPageSize, 1);
  assert.equal(minimums.listenerFinalityMissingPolls, 2);
  assert.equal(minimums.listenerShutdownTimeoutMs, 1_000);

  const maximums = parseConfig({
    ...base,
    LISTENER_WORKER_LEASE_SECONDS: '900',
    LISTENER_CATCH_UP_MAX_PAGES: '100',
    LISTENER_CATCH_UP_PAGE_SIZE: '1000',
    LISTENER_FINALITY_MISSING_POLLS: '20',
    LISTENER_SHUTDOWN_TIMEOUT_MS: '120000',
    RPC_RETRY_MAX_ATTEMPTS: '100',
    RPC_RETRY_BASE_DELAY_MS: '60000',
  });
  assert.equal(maximums.listenerWorkerLeaseSeconds, 900);
  assert.equal(maximums.listenerCatchUpMaxPages, 100);
  assert.equal(maximums.listenerCatchUpPageSize, 1_000);
  assert.equal(maximums.listenerFinalityMissingPolls, 20);
  assert.equal(maximums.listenerShutdownTimeoutMs, 120_000);
  assert.equal(maximums.rpcRetryMaxAttempts, 100);
  assert.equal(maximums.rpcRetryBaseDelayMs, 60_000);
});

void test('la configuration listener refuse les valeurs ambiguës ou hors limites', () => {
  const invalid: readonly Record<string, string>[] = [
    { LISTENER_ENABLED: '1' },
    { LISTENER_ENABLED: ' TRUE' },
    { LISTENER_WORKER_LEASE_SECONDS: '29' },
    { LISTENER_WORKER_LEASE_SECONDS: '901' },
    { LISTENER_WORKER_LEASE_SECONDS: '30.0' },
    { LISTENER_CATCH_UP_MAX_PAGES: '0' },
    { LISTENER_CATCH_UP_MAX_PAGES: '101' },
    { LISTENER_CATCH_UP_PAGE_SIZE: '0' },
    { LISTENER_CATCH_UP_PAGE_SIZE: '1001' },
    { LISTENER_FINALITY_MISSING_POLLS: '1' },
    { LISTENER_FINALITY_MISSING_POLLS: '21' },
    { LISTENER_SHUTDOWN_TIMEOUT_MS: '999' },
    { LISTENER_SHUTDOWN_TIMEOUT_MS: '120001' },
    { LISTENER_SHUTDOWN_TIMEOUT_MS: '9007199254740992' },
    { RPC_RETRY_MAX_ATTEMPTS: '0' },
    { RPC_RETRY_MAX_ATTEMPTS: '101' },
    { RPC_RETRY_BASE_DELAY_MS: '0' },
    { RPC_RETRY_BASE_DELAY_MS: '60001' },
  ];
  for (const values of invalid) assert.throws(() => parseConfig({ ...base, ...values }));
});

void test('le modèle d’environnement publie les valeurs listener sûres exactes', async () => {
  const source = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  for (const line of [
    'LISTENER_ENABLED=true',
    'LISTENER_CATCH_UP_POLICY=live-edge',
    'LISTENER_WORKER_LEASE_SECONDS=120',
    'LISTENER_CATCH_UP_MAX_PAGES=20',
    'LISTENER_CATCH_UP_PAGE_SIZE=100',
    'LISTENER_FINALITY_MISSING_POLLS=3',
    'LISTENER_SHUTDOWN_TIMEOUT_MS=30000',
  ]) assert.match(source, new RegExp(`^${line}$`, 'mu'));
});

void test('public social enrichment uses strict bounded non-secret defaults', () => {
  const config = parseConfig(base);
  assert.deepEqual({
    timeoutMs: config.socialHttpTimeoutMs,
    maxBytes: config.socialHttpMaxBytes,
    maxRedirects: config.socialHttpMaxRedirects,
    concurrency: config.socialHttpConcurrency,
    pollMs: config.socialWorkerPollMs,
    leaseSeconds: config.socialWorkerLeaseSeconds,
    maxAttempts: config.socialRetryMaxAttempts,
    baseDelayMs: config.socialRetryBaseDelayMs,
  }, {
    timeoutMs: 5_000, maxBytes: 262_144, maxRedirects: 3, concurrency: 2,
    pollMs: 1_000, leaseSeconds: 30, maxAttempts: 3, baseDelayMs: 1_000,
  });
});

void test('public social enrichment accepts only its exact inclusive bounds', () => {
  const minimums = parseConfig({
    ...base, SOCIAL_HTTP_TIMEOUT_MS: '100', SOCIAL_HTTP_MAX_BYTES: '1024',
    SOCIAL_HTTP_MAX_REDIRECTS: '0', SOCIAL_HTTP_CONCURRENCY: '1',
    SOCIAL_WORKER_POLL_MS: '100', SOCIAL_WORKER_LEASE_SECONDS: '5',
    SOCIAL_RETRY_MAX_ATTEMPTS: '1', SOCIAL_RETRY_BASE_DELAY_MS: '100',
  });
  assert.deepEqual([
    minimums.socialHttpTimeoutMs, minimums.socialHttpMaxBytes,
    minimums.socialHttpMaxRedirects, minimums.socialHttpConcurrency,
    minimums.socialWorkerPollMs, minimums.socialWorkerLeaseSeconds,
    minimums.socialRetryMaxAttempts, minimums.socialRetryBaseDelayMs,
  ], [100, 1_024, 0, 1, 100, 5, 1, 100]);

  const maximums = parseConfig({
    ...base, SOCIAL_HTTP_TIMEOUT_MS: '30000', SOCIAL_HTTP_MAX_BYTES: '1048576',
    SOCIAL_HTTP_MAX_REDIRECTS: '10', SOCIAL_HTTP_CONCURRENCY: '8',
    SOCIAL_WORKER_POLL_MS: '60000', SOCIAL_WORKER_LEASE_SECONDS: '300',
    SOCIAL_RETRY_MAX_ATTEMPTS: '10', SOCIAL_RETRY_BASE_DELAY_MS: '60000',
  });
  assert.deepEqual([
    maximums.socialHttpTimeoutMs, maximums.socialHttpMaxBytes,
    maximums.socialHttpMaxRedirects, maximums.socialHttpConcurrency,
    maximums.socialWorkerPollMs, maximums.socialWorkerLeaseSeconds,
    maximums.socialRetryMaxAttempts, maximums.socialRetryBaseDelayMs,
  ], [30_000, 1_048_576, 10, 8, 60_000, 300, 10, 60_000]);
});

void test('public social enrichment rejects ambiguous integers without reflecting configured values', () => {
  const fields = [
    'SOCIAL_HTTP_TIMEOUT_MS', 'SOCIAL_HTTP_MAX_BYTES', 'SOCIAL_HTTP_MAX_REDIRECTS',
    'SOCIAL_HTTP_CONCURRENCY', 'SOCIAL_WORKER_POLL_MS', 'SOCIAL_WORKER_LEASE_SECONDS',
    'SOCIAL_RETRY_MAX_ATTEMPTS', 'SOCIAL_RETRY_BASE_DELAY_MS',
  ] as const;
  for (const field of fields) {
    for (const value of ['01', '+1', '-1', ' 1', '1 ', '1e3', '1.0']) {
      assert.throws(() => parseConfig({ ...base, [field]: value }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(field, 'u'));
        assert.equal(error.message.includes(value), false);
        assert.equal(error.message.includes(base.SOLANA_HTTP_RPC_URL), false);
        return true;
      });
    }
  }
  const aboveMaximum = {
    SOCIAL_HTTP_TIMEOUT_MS: '30001', SOCIAL_HTTP_MAX_BYTES: '1048577',
    SOCIAL_HTTP_MAX_REDIRECTS: '11', SOCIAL_HTTP_CONCURRENCY: '9',
    SOCIAL_WORKER_POLL_MS: '60001', SOCIAL_WORKER_LEASE_SECONDS: '301',
    SOCIAL_RETRY_MAX_ATTEMPTS: '11', SOCIAL_RETRY_BASE_DELAY_MS: '60001',
  } as const;
  for (const [field, value] of Object.entries(aboveMaximum)) {
    assert.throws(() => parseConfig({ ...base, [field]: value }));
  }
});

void test('the environment example contains only safe public-social settings', async () => {
  const source = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  for (const line of [
    'SOCIAL_HTTP_TIMEOUT_MS=5000', 'SOCIAL_HTTP_MAX_BYTES=262144',
    'SOCIAL_HTTP_MAX_REDIRECTS=3', 'SOCIAL_HTTP_CONCURRENCY=2',
    'SOCIAL_WORKER_POLL_MS=1000', 'SOCIAL_WORKER_LEASE_SECONDS=30',
    'SOCIAL_RETRY_MAX_ATTEMPTS=3', 'SOCIAL_RETRY_BASE_DELAY_MS=1000',
  ]) assert.match(source, new RegExp(`^${line}$`, 'mu'));
  assert.doesNotMatch(source, /(?:X|TWITTER|TELEGRAM).*(?:TOKEN|COOKIE|SECRET|PROXY)|PRIVATE_KEY|KEYPAIR_PATH/iu);
});

void test('les réglages listener ne régressent pas la sécurité observe/paper', () => {
  assert.equal(parseConfig({ ...base, LISTENER_ENABLED: 'false' }).executionMode, 'observe');
  assert.throws(() => parseConfig({
    ...base,
    LISTENER_ENABLED: 'true',
    EXECUTION_MODE: 'live',
  }), /observe.*paper/u);
  assert.throws(() => parseConfig({
    ...base,
    LISTENER_ENABLED: 'true',
    SOLANA_PRIVATE_KEY_BASE58: 'secret',
  }), /private key/u);
});

void test('Pump.fun calibration documentation states the initial profile, semantics, and safety limits', async () => {
  const documentPaths = [
    '../README.md',
    '../docs/architecture/pumpfun-v1.md',
    '../docs/api/v1.md',
    '../docs/system-overview.html',
  ] as const;
  const documents = await Promise.all(documentPaths.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  const [readme, architecture, api, systemOverview] = documents as [string, string, string, string];
  const documentation = documents.join('\n');
  for (const statement of [
    'config/qualification/pumpfun-v1-unvalidated.json',
    'QUALIFICATION_PROFILE_PATH',
    'QUALIFICATION_MIN_SCORE',
    'UNVALIDATED_RULE_SET',
    'SHA-256',
    'DISABLED',
    'REPORT_ONLY',
    'ENFORCED',
    '15',
    '25',
    '60',
    '3000 bps',
    'NONVALIDATED',
    'calibration initiale',
    'SHARED_FUNDER_CLUSTER',
    'RELATED_WALLET_CLUSTER_EXCEEDED',
    'UNKNOWN',
    'dépassement strict',
    'métadonnées',
    'social',
    'Raydium',
    '"fingerprint": null',
    '"conditions": []',
    'chaînes décimales',
    'clé privée',
    'sendTransaction',
    'signTransaction',
    'profit',
    'sellabilité',
    'première position',
    'même slot',
    'SocialEvidenceCollected',
    'URL_REACHABLE',
    'CROSS_LINK_CONFIRMED',
    'MINT_PUBLISHED',
    'VERIFICATION_UNKNOWN',
    'collectionStatus',
    'linksTruncated',
    'evidenceTruncated',
    'sans API payante',
    'contenu brut',
  ]) assert.ok(documentation.includes(statement), `missing documentation statement: ${statement}`);

  assert.match(readme, /par défaut.*config\/qualification\/pumpfun-v1-unvalidated\.json/isu);
  assert.match(readme, /fail.closed|fails closed/iu);
  assert.match(readme, /redact|ne journalise ni le\s+chemin/iu);
  assert.match(architecture, /Un blocker actif.*compensé/isu);
  assert.match(architecture, /null.*REPORT_ONLY.*dry-run/isu);
  for (const document of [readme, architecture, systemOverview]) {
    assert.doesNotMatch(document, /(?:SHARED_FUNDER_CLUSTER|RELATED_WALLET_CLUSTER_EXCEEDED)[\s\S]{0,180}désactivés/iu);
    assert.match(document, /REPORT_ONLY[\s\S]{0,220}(?:blocker|verdict|paper)/iu);
  }
  assert.match(architecture, /égalité passe.*dépassement strict/isu);
  assert.match(api, /legacy.*"fingerprint": null.*"conditions": \[\]/isu);
  assert.match(api, /fingerprint.*lowercase/iu);
  assert.match(systemOverview, /diagnostic/iu);
  assert.match(systemOverview, /imageValid.*15.*socialCrossLinkConfirmed.*25.*creatorHasNotSold.*reverseQuoteAvailable.*externalBuyersObserved/isu);
  assert.match(systemOverview, /TRIGGERED.*ENFORCED.*blocker.*décide le rejet/isu);
  assert.match(systemOverview, /MINT_SOCIAL_MISMATCH.*SHARED_FUNDER_CLUSTER.*REPORT_ONLY.*sans décider/isu);
  assert.match(systemOverview, /HOLDER_CONCENTRATION_EXCEEDED.*RELATED_WALLET_CLUSTER_EXCEEDED.*REPORT_ONLY.*null/isu);
  assert.match(systemOverview, /SHARED_FUNDER_CLUSTER.*REPORT_ONLY.*minimumSharedFunders=1/isu);
  assert.match(systemOverview, /BUY_SIMULATION_FAILED.*SELL_QUOTE_UNAVAILABLE.*ENFORCED/isu);
  assert.match(systemOverview, /ROUND_TRIP_LOSS_EXCEEDED.*ENFORCED.*maximumRoundTripLossBps=3000/isu);
  assert.match(systemOverview, /Liquidité.*future non scorée/iu);
  assert.match(api, /projection legacy.*projection calibrée.*Perte aller-retour supérieure au seuil configuré/isu);
  assert.match(api, /NOT_AVAILABLE.*AVAILABLE.*COMPLETE.*PARTIAL.*FAILED/isu);
  assert.match(architecture, /inconnu.*UNKNOWN.*ne.*faux/isu);
  assert.match(readme, /métadonnées.*liens sociaux.*ne prouvent.*sérieux/isu);
  assert.doesNotMatch(systemOverview, /704 tests réussis/iu);
});

void test('durable WebSocket health documentation is versioned and exposes the exact redacted contract', async () => {
  const [readme, api, design, umbrella, plan] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/api/v1.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/superpowers/specs/2026-08-28-durable-websocket-health-design.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/superpowers/specs/2026-08-27-solana-websocket-failover-design.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/superpowers/plans/2026-08-28-durable-websocket-health.md', import.meta.url), 'utf8'),
  ]);

  assert.match(design, /^Version: 1\.0\.3$/mu);
  assert.match(umbrella, /^Version: 1\.3\.3$/mu);
  assert.match(umbrella, /durable-websocket-health-design\.md` version\s+1\.0\.3/isu);
  assert.match(plan, /design v1\.0\.3/iu);

  const sectionStart = api.indexOf('### Santé WebSocket durable');
  const sectionEnd = api.indexOf('\n## SSE', sectionStart);
  assert.notEqual(sectionStart, -1, 'missing durable WebSocket API section');
  assert.notEqual(sectionEnd, -1, 'durable WebSocket API section must be bounded');
  const apiSection = api.slice(sectionStart, sectionEnd);
  const jsonStart = apiSection.indexOf('```json\n');
  const jsonEnd = apiSection.indexOf('\n```', jsonStart + 8);
  assert.notEqual(jsonStart, -1, 'missing durable WebSocket JSON example');
  assert.notEqual(jsonEnd, -1, 'durable WebSocket JSON example must be closed');
  const example = JSON.parse(apiSection.slice(jsonStart + 8, jsonEnd)) as {
    readonly heartbeat?: {
      readonly lastSignature?: unknown;
      readonly websocket?: Readonly<Record<string, unknown>>;
    };
  };
  assert.equal(example.heartbeat?.lastSignature, null);
  const websocket = example.heartbeat?.websocket;
  assert.ok(websocket);
  assert.deepEqual(Object.keys(websocket).sort(), [
    'acknowledgedAt',
    'candidateProviderId',
    'disconnect',
    'heartbeatAt',
    'lastObservation',
    'phase',
    'providerId',
    'recovery',
    'state',
    'supervision',
    'updatedAt',
    'version',
  ]);
  assert.equal(Object.hasOwn(websocket, 'signature'), false);
  assert.deepEqual(websocket.recovery, {
    status: 'NOT_REQUIRED',
    startedAt: null,
    completedAt: null,
    reasonCode: null,
  });

  for (const value of [
    'STOPPED', 'CONNECTING', 'ACKNOWLEDGED', 'RECOVERING', 'DEGRADED',
    'WAITING_FOR_ACKS', 'RUNNING', 'UNRECOVERABLE', 'STOPPING',
    'listener_strict_catch_up_failures', '30 secondes', 'quatre heures',
    'backend requis', 'client optionnel', 'primary', 'fallback-1', 'fallback-2',
    'fallback-3', 'INACTIVE', '#63',
  ]) assert.ok(apiSection.includes(value), `missing WebSocket API documentation: ${value}`);

  assert.match(apiSection, /dernière observation[^.]*diagnostique[^.]*pas[^.]*continuité/isu);
  assert.match(apiSection, /PostgreSQL[^.]*503[^.]*DEGRADED[^.]*200/isu);
  assert.doesNotMatch(apiSection, /(?:https?|wss):\/\//iu);
  assert.doesNotMatch(apiSection, /EXECUTION_MODE=live|sendTransaction\s*\(|signTransaction\s*\(|private[_ -]?key/iu);

  const revisedSemantics = `${readme}\n${design}`;
  assert.match(revisedSemantics, /NUMERIC[^.]*entier mathématique[^.]*BIGINT[^.]*strict/isu);
  assert.match(revisedSemantics, /disconnectReasonCode[^.]*non nul[^.]*nouvel incident/isu);
  assert.match(revisedSemantics, /disconnectReasonCode[^.]*null[^.]*conserve/isu);
  assert.match(revisedSemantics, /cadence[^.]*indépendante[^.]*latence[^.]*coalesc/isu);
  assert.match(revisedSemantics, /snapshot cohérent/iu);
  assert.match(revisedSemantics, /horloge[^.]*après[^.]*lectures/isu);
});

void test('HTTP RPC failover documentation states the bounded production and soak contract', async () => {
  const [readme, operations] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/operations/rpc-qualification.md', import.meta.url), 'utf8'),
  ]);
  const documentation = `${readme}\n${operations}`;

  for (const statement of [
    'SOLANA_HTTP_RPC_FALLBACK_URLS',
    'liste ordonnée',
    'séparée par',
    'des virgules',
    'principal',
    'fallback-1',
    'fallback-2',
    'fallback-3',
    'au plus trois',
    'même schéma HTTP',
    'doublons canoniques',
    "fragments d'URL sont interdits",
    'ne sont pas transmis',
    'réinitialise la préférence vers le principal',
    'rpc.http_endpoint_degraded',
    'rpc.http_failover',
    'rpc.http_endpoints_exhausted',
    'Retry-After',
    '60 secondes',
    'erreur JSON-RPC',
    'résultat archive null',
    'SOLANA_WS_RPC_URL',
    'issue #57',
    'mono-fournisseur',
    'SOLANA_HTTP_RPC_URL + SOLANA_WS_RPC_URL',
    '50 positions Mainnet',
    'non exécutée',
    'non validée',
    'observe/paper only',
  ]) assert.ok(documentation.includes(statement), `missing HTTP RPC failover documentation statement: ${statement}`);

  assert.match(readme, /Sans fallback[\s\S]{0,180}web3\.js[\s\S]{0,100}rate.limit retry/iu);
  assert.match(operations, /rejet réseau[\s\S]{0,180}429[\s\S]{0,180}502[\s\S]{0,180}503[\s\S]{0,180}504/iu);
  assert.match(operations, /chaque endpoint éligible[\s\S]{0,120}au plus une fois[\s\S]{0,120}requête logique/iu);
  assert.match(operations, /refroidissement[\s\S]{0,120}aucune attente interne/iu);
  assert.match(operations, /URL[\s\S]{0,120}hôte[\s\S]{0,120}en-tête[\s\S]{0,120}corps[\s\S]{0,120}erreur fournisseur[\s\S]{0,120}clé API/iu);
  assert.match(operations, /indépendamment[\s\S]{0,180}quota[\s\S]{0,180}cohérence archive/iu);
  assert.match(operations, /basculement de production[\s\S]{0,180}soak/iu);
  assert.match(readme, /wallet[\s\S]{0,80}signature[\s\S]{0,80}soumission/iu);
});

void test('qualification loader, evaluator, profile, and public API boundaries exclude execution primitives', async () => {
  const modulePaths = [
    '../src/qualification/qualification-engine.ts',
    '../src/qualification/qualification-policy-evaluator.ts',
    '../src/qualification/qualification-profile.ts',
    '../src/api/contracts.ts',
    '../src/storage/api-projection.repository.ts',
  ] as const;
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  for (const path of modulePaths) {
    const sourceUrl = new URL(path, import.meta.url);
    const source = await readFile(sourceUrl, 'utf8');
    assert.deepEqual(executionBoundaryViolations(source, fileURLToPath(sourceUrl), repositoryRoot), []);
  }
  const profile = loadQualificationProfile({ profilePath: null, minimumScoreOverride: null });
  assert.equal(profile.id, 'pumpfun-v1-initial');
  const policy = (code: string) => profile.conditionPolicies.find((item) => item.code === code);
  assert.deepEqual(policy('HOLDER_CONCENTRATION_EXCEEDED'), {
    code: 'HOLDER_CONCENTRATION_EXCEEDED', mode: 'REPORT_ONLY', maximumTop1Bps: null, maximumTop5Bps: null,
    maximumTop10Bps: null, maximumClusterBps: null, minimumSharedFunders: null, maximumRoundTripLossBps: null,
  });
  assert.deepEqual(policy('RELATED_WALLET_CLUSTER_EXCEEDED'), {
    code: 'RELATED_WALLET_CLUSTER_EXCEEDED', mode: 'REPORT_ONLY', maximumTop1Bps: null, maximumTop5Bps: null,
    maximumTop10Bps: null, maximumClusterBps: null, minimumSharedFunders: null, maximumRoundTripLossBps: null,
  });
  assert.equal(policy('SHARED_FUNDER_CLUSTER')?.mode, 'REPORT_ONLY');
  assert.equal(policy('SHARED_FUNDER_CLUSTER')?.minimumSharedFunders, 1);
  assert.equal(policy('BUY_SIMULATION_FAILED')?.mode, 'ENFORCED');
  assert.equal(policy('SELL_QUOTE_UNAVAILABLE')?.mode, 'ENFORCED');
  assert.equal(policy('ROUND_TRIP_LOSS_EXCEEDED')?.mode, 'ENFORCED');
  assert.equal(policy('ROUND_TRIP_LOSS_EXCEEDED')?.maximumRoundTripLossBps, 3_000);
});

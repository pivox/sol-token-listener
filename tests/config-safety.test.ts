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

void test('le mode par défaut est strictement observe', () => {
  const config = parseConfig(base);
  assert.equal(config.executionMode, 'observe');
});

void test('le mode paper est accepté avec SOL dans son allowlist initiale', () => {
  const config = parseConfig({ ...base, EXECUTION_MODE: 'paper' });
  assert.equal(config.executionMode, 'paper');
  assert.deepEqual(config.paperQuoteMintAllowlist, [config.wsolMint]);
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
  assert.equal(config.listenerWorkerLeaseSeconds, 120);
  assert.equal(config.listenerCatchUpMaxPages, 20);
  assert.equal(config.listenerCatchUpPageSize, 100);
  assert.equal(config.listenerFinalityMissingPolls, 3);
  assert.equal(config.listenerShutdownTimeoutMs, 30_000);
  assert.equal(config.rpcRetryMaxAttempts, 5);
  assert.equal(config.rpcRetryBaseDelayMs, 500);
  assert.equal(config.reconcileSeconds, 15);
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
  assert.doesNotMatch(systemOverview, /704 tests réussis/iu);
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

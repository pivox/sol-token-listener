import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GLOBAL_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RETENTION_OUTPUT_BYTES = 16 * 1024;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(root, 'deploy/compose.yaml');
const projectName = `sol-listener-smoke-${process.pid}-${randomBytes(4).toString('hex')}`;
const projectLabel = `label=com.docker.compose.project=${projectName}`;
const postgresPassword = randomBytes(24).toString('hex');
const deadlineAt = Date.now() + GLOBAL_TIMEOUT_MS;
const canonicalMigrations = Object.freeze([
  '001_initial.sql',
  '002_pumpfun_foundation.sql',
  '003_pumpfun_observations.sql',
  '004_paper_trading.sql',
  '005_pumpswap_market.sql',
  '006_api_event_stream.sql',
  '007_participant_analytics.sql',
  '008_wallet_graph.sql',
  '009_transaction_ingestion.sql',
  '010_transaction_inbox_timestamps.sql',
  '011_transaction_inbox_retry_recovery.sql',
  '012_public_social_evidence.sql',
  '013_paper_e2e.sql',
]);
const canonicalRetentionCounters = Object.freeze([
  'apiEventStream',
  'bondingCurveSnapshots',
  'creatorProfiles',
  'domainEvents',
  'holderSnapshots',
  'launchTrades',
  'marketPools',
  'marketReserveSnapshots',
  'marketTrades',
  'metadataSnapshots',
  'migrations',
  'observedWalletPositions',
  'paperDecisionJobs',
  'paperExternalBuys',
  'paperPositions',
  'paperSessions',
  'paperTrades',
  'qualificationReports',
  'rawChainEvents',
  'socialCollections',
  'socialEvidence',
  'socialJobs',
  'socialLinks',
  'socialObservations',
  'stateTransitions',
  'tokenLaunches',
  'tradingCandidates',
  'transactionInbox',
  'transactionInboxRecoveries',
  'walletClusterMembers',
  'walletClusters',
  'walletFundingEvidence',
  'walletFundingObservations',
  'walletGraphProfiles',
  'walletGraphSnapshots',
  'walletRelationships',
]);
const projectResourceChecks = Object.freeze([
  Object.freeze({
    kind: 'container',
    args: Object.freeze(['ps', '-a', '--filter', projectLabel, '--format', '{{.ID}}']),
  }),
  Object.freeze({
    kind: 'network',
    args: Object.freeze(['network', 'ls', '--filter', projectLabel, '--format', '{{.ID}}']),
  }),
  Object.freeze({
    kind: 'volume',
    args: Object.freeze(['volume', 'ls', '--filter', projectLabel, '--format', '{{.Name}}']),
  }),
]);

const frontendPort = await reserveLoopbackPort();
const environment = Object.freeze({
  ...process.env,
  COMPOSE_PROJECT_NAME: projectName,
  POSTGRES_DB: 'smoke',
  POSTGRES_USER: 'smoke',
  POSTGRES_PASSWORD: postgresPassword,
  POSTGRES_PASSWORD_URI_ENCODED: encodeURIComponent(postgresPassword),
  SOLANA_HTTP_RPC_URL: 'https://rpc.invalid',
  SOLANA_WS_RPC_URL: 'wss://rpc.invalid',
  LISTENER_ENABLED: 'false',
  FRONTEND_PORT: String(frontendPort),
});
const baseUrl = `http://127.0.0.1:${frontendPort}`;

let primaryFailure;
try {
  await compose(['build']);
  await compose(['up', '--detach', '--wait', '--wait-timeout', '120']);
  await assertNonRoot('app');
  await assertNonRoot('frontend');
  await assertPublicHealth();
  await assertCorsContract();

  const initialMigrations = await readMigrationHistory();
  assertMigrationHistory(initialMigrations);
  await compose(['run', '--rm', 'migrate']);
  const replayedMigrations = await readMigrationHistory();
  assertMigrationHistory(replayedMigrations);
  assertEqual(
    JSON.stringify(replayedMigrations),
    JSON.stringify(initialMigrations),
    'Migration replay changed migration_history.',
  );

  await assertFrontendContract();
  await assertGracefulSseShutdown();
  await compose(['start', 'app']);
  await waitForPublicHealth();
  await assertRetentionOneShot();
  process.stdout.write('Deployment smoke passed.\n');
} catch (error) {
  primaryFailure = error;
} finally {
  const cleanupFailures = [];
  try {
    await runDocker(
      ['compose', '-f', composeFile, 'down', '--volumes', '--remove-orphans'],
      { cleanup: true },
    );
  } catch (error) {
    cleanupFailures.push(error);
  }
  for (const check of projectResourceChecks) {
    try {
      const { stdout, stderr } = await runDocker(check.args, { cleanup: true });
      if (stderr !== '' || stdout.trim() !== '') {
        throw new Error(`Deployment smoke left project ${check.kind} resources behind.`);
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (primaryFailure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError([primaryFailure, ...cleanupFailures], 'Deployment smoke and cleanup failed.');
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    throw new AggregateError(cleanupFailures, 'Deployment smoke cleanup failed.');
  }
}
if (primaryFailure !== undefined) throw primaryFailure;

async function compose(args, options = {}) {
  return runDocker(['compose', '-f', composeFile, ...args], options);
}

async function runDocker(args, options = {}) {
  return runCommand('docker', args, options);
}

async function runCommand(command, args, { cleanup = false, reflectFailureOutput = true } = {}) {
  const timeoutMs = cleanup
    ? CLEANUP_TIMEOUT_MS
    : Math.max(1, deadlineAt - Date.now());
  if (!cleanup && Date.now() >= deadlineAt) throw new Error('Deployment smoke global deadline exceeded.');

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let terminationFailure;
    const timer = setTimeout(() => {
      terminationFailure = new Error(`${commandLabel(args)} exceeded its deadline.`);
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => collect(chunk, stdout));
    child.stderr.on('data', (chunk) => collect(chunk, stderr));
    child.once('error', (error) => finish(new Error(`${commandLabel(args)} could not start: ${safeName(error)}.`)));
    child.once('close', (code, signal) => {
      if (terminationFailure !== undefined) {
        finish(terminationFailure);
        return;
      }
      if (code === 0) {
        finish(undefined, {
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
        return;
      }
      const detail = reflectFailureOutput
        ? redact(Buffer.concat([...stderr, ...stdout]).toString('utf8')).slice(-8_192).trim()
        : '';
      finish(new Error(
        `${commandLabel(args)} failed (${code === null ? signal ?? 'unknown' : `exit ${code}`})${detail === '' ? '.' : `: ${detail}`}`,
      ));
    });

    function collect(chunk, target) {
      if (!Buffer.isBuffer(chunk)) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        terminationFailure = new Error(`${commandLabel(args)} exceeded its output limit.`);
        child.kill('SIGKILL');
        return;
      }
      target.push(chunk);
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolvePromise(result);
      else rejectPromise(error);
    }
  });
}

function commandLabel(args) {
  const action = args.find((value) => value !== 'compose' && value !== '-f' && value !== composeFile);
  return `Docker ${action ?? 'command'}`;
}

function redact(value) {
  return value.replaceAll(postgresPassword, '[REDACTED]')
    .replaceAll(encodeURIComponent(postgresPassword), '[REDACTED]');
}

async function assertNonRoot(service) {
  const { stdout } = await compose(['exec', '-T', service, 'id', '-u']);
  const uid = stdout.trim();
  assertMatch(uid, /^[1-9][0-9]*$/u, `${service} runs as root or returned an invalid UID.`);
}

async function assertPublicHealth() {
  const response = await fetchBounded('/api/v1/health', {
    headers: { accept: 'application/json' },
  });
  assertEqual(response.status, 200, 'Public health did not return HTTP 200.');
  const envelope = parseJson(response.body, 'Public health response is not JSON.');
  assertEqual(envelope?.apiVersion, 'v1', 'Public health API version is not v1.');
  assertEqual(envelope?.data?.status, 'DEGRADED', 'Observe-only health is not DEGRADED.');
  assertEqual(envelope?.data?.postgresql?.status, 'AVAILABLE', 'PostgreSQL is not AVAILABLE.');
  assertEqual(envelope?.data?.http?.status, 'AVAILABLE', 'HTTP is not AVAILABLE.');
  for (const pipeline of ['pumpfun', 'pumpswap', 'paperDecision', 'social']) {
    assertEqual(envelope?.data?.pipeline?.[pipeline], 'STOPPED', `${pipeline} pipeline is not STOPPED.`);
  }
}

async function assertCorsContract() {
  const response = await fetchBounded('/api/v1/events', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://frontend.invalid',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'Last-Event-ID',
    },
  });
  assertEqual(response.status, 204, 'CORS preflight did not return HTTP 204.');
  assertEqual(response.headers.get('access-control-allow-origin'), '*', 'CORS origin contract changed.');
  assertEqual(response.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS', 'CORS methods contract changed.');
  assertEqual(response.headers.get('access-control-allow-headers'), 'Last-Event-ID', 'CORS headers contract changed.');
  assertEqual(response.headers.get('allow'), 'GET, HEAD, OPTIONS', 'HTTP Allow contract changed.');
  assertEqual(response.headers.get('access-control-allow-credentials'), null, 'CORS credentials must remain disabled.');
}

async function readMigrationHistory() {
  const sql = "SELECT version, applied_at::text FROM migration_history ORDER BY version";
  const { stdout } = await runDocker([
    'compose', '-f', composeFile, 'exec', '-T', 'postgres', 'psql',
    '-X', '-A', '-t', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-U', 'smoke', '-d', 'smoke', '-c', sql,
  ]);
  return stdout.trim().split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('|');
    if (separator <= 0 || separator === line.length - 1) throw new Error('Migration history row is malformed.');
    return Object.freeze({ version: line.slice(0, separator), appliedAt: line.slice(separator + 1) });
  });
}

function assertMigrationHistory(rows) {
  assertEqual(rows.length, canonicalMigrations.length, 'Migration history does not contain exactly 13 rows.');
  assertEqual(
    JSON.stringify(rows.map(({ version }) => version)),
    JSON.stringify(canonicalMigrations),
    'Migration history is not the sorted canonical set.',
  );
  for (const { appliedAt } of rows) assertMatch(appliedAt, /^\d{4}-\d{2}-\d{2} /u, 'Migration timestamp is invalid.');
}

async function assertFrontendContract() {
  const config = await fetchBounded('/config.json');
  assertEqual(config.status, 200, 'Frontend config is unavailable.');
  assertEqual(config.headers.get('cache-control'), 'no-store', 'Frontend config caching is unsafe.');
  assertEqual(parseJson(config.body, 'Frontend config is not JSON.')?.apiBaseUrl, '/', 'Frontend config is not same-origin.');

  const index = await fetchBounded('/index.html');
  assertEqual(index.status, 200, 'Frontend index is unavailable.');
  assertEqual(index.headers.get('cache-control'), 'no-store', 'Frontend index caching is unsafe.');
  assertMatch(index.body, /<div id="root"><\/div>/u, 'Frontend index is not the SPA document.');

  for (const route of ['/health', '/launches/So11111111111111111111111111111111111111112']) {
    const response = await fetchBounded(route);
    assertEqual(response.status, 200, `SPA route ${route} is unavailable.`);
    assertEqual(response.body, index.body, `SPA route ${route} did not return index.html.`);
  }

  const assetMatch = index.body.match(/(?:src|href)="([^"?]*\/assets\/[^"?]+)"/u);
  const assetPath = assetMatch?.[1];
  if (assetPath === undefined || !assetPath.startsWith('/assets/')) throw new Error('No frontend asset was discovered.');
  const asset = await fetchBounded(assetPath);
  assertEqual(asset.status, 200, 'Frontend asset is unavailable.');
  assertEqual(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'Frontend asset caching is not immutable.');
  if (asset.body.length === 0) throw new Error('Frontend asset is empty.');
}

async function assertGracefulSseShutdown() {
  const controller = new AbortController();
  const response = await requestWithDeadline(`${baseUrl}/api/v1/events`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assertEqual(response.status, 200, 'SSE did not open.');
  assertEqual(response.headers.get('content-type'), 'text/event-stream; charset=utf-8', 'SSE content type changed.');
  if (response.body === null) throw new Error('SSE response body is missing.');

  let body;
  try {
    const stream = readSseToEof(response.body, controller);
    [, body] = await Promise.all([
      compose(['stop', '--timeout', '40', 'app']),
      stream,
    ]);
  } finally {
    controller.abort();
  }
  const shutdownOffset = body.indexOf('event: server_shutdown\n');
  if (shutdownOffset < 0) throw new Error('SSE ended without server_shutdown.');
  if (!body.slice(shutdownOffset).includes('data: {"apiVersion":"v1"}\n\n')) {
    throw new Error('SSE server_shutdown payload is invalid.');
  }
}

async function readSseToEof(body, controller) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectDeadline(new Error('SSE response exceeded its deadline.'));
  }, Math.min(50_000, remainingGlobalMs()));
  try {
    for (;;) {
      const item = await Promise.race([reader.read(), deadline]);
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('SSE response exceeded its size limit.');
      chunks.push(item.value);
    }
  } finally {
    clearTimeout(timeout);
    try { reader.releaseLock(); } catch { /* response is already terminal */ }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function waitForPublicHealth() {
  let lastFailure;
  while (Date.now() < deadlineAt) {
    try {
      await assertPublicHealth();
      return;
    } catch (error) {
      lastFailure = error;
    }
    await delay(500);
  }
  throw new Error(`Application did not recover before the global deadline: ${safeName(lastFailure)}.`);
}

async function assertRetentionOneShot() {
  const { stdout, stderr } = await compose([
    'exec', '-T', 'retention', 'node', 'dist/scripts/purge-retained-data.js', '--once',
  ], { reflectFailureOutput: false });
  if (stderr !== '') throw new Error('Retention emitted unexpected stderr.');
  if (
    Buffer.byteLength(stdout, 'utf8') > MAX_RETENTION_OUTPUT_BYTES
    || !stdout.endsWith('\n')
    || stdout.includes('\r')
    || stdout.slice(0, -1).includes('\n')
  ) throw new Error('Retention output contract is invalid.');
  const serialized = stdout.slice(0, -1);
  let event;
  try {
    event = JSON.parse(serialized);
  } catch {
    throw new Error('Retention output contract is invalid.');
  }
  if (
    typeof event !== 'object'
    || event === null
    || Array.isArray(event)
    || JSON.stringify(event) !== serialized
  ) throw new Error('Retention output contract is invalid.');
  const eventKeys = Object.keys(event);
  if (
    JSON.stringify(eventKeys) !== JSON.stringify(['level', 'time', 'service', 'event', 'counters'])
    || event.level !== 30
    || !Number.isSafeInteger(event.time)
    || event.time <= 0
    || event.service !== 'sol-token-listener'
    || event.event !== 'retention.purged'
  ) throw new Error('Retention event contract is invalid.');
  const counters = event.counters;
  if (typeof counters !== 'object' || counters === null || Array.isArray(counters)) {
    throw new Error('Retention counters are invalid.');
  }
  const keys = Object.keys(counters);
  if (
    JSON.stringify(keys) !== JSON.stringify(canonicalRetentionCounters)
    || keys.length > 64
    || Object.values(counters).some((value) => !Number.isSafeInteger(value) || value !== 0)
  ) {
    throw new Error('Retention counters are not the expected empty-database aggregate.');
  }
}

async function fetchBounded(path, options = {}) {
  const response = await requestWithDeadline(`${baseUrl}${path}`, options);
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`Response for ${path} exceeded its size limit.`);
  }
  const body = await readBoundedBody(response, path);
  return Object.freeze({ status: response.status, headers: response.headers, body });
}

async function requestWithDeadline(url, options = {}) {
  const controller = new AbortController();
  const outerSignal = options.signal;
  const signal = outerSignal === undefined
    ? controller.signal
    : AbortSignal.any([controller.signal, outerSignal]);
  const timeout = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remainingGlobalMs()));
  try {
    return await fetch(url, { ...options, redirect: 'error', signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedBody(response, label) {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let completed = false;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    rejectDeadline(new Error(`Response for ${label} exceeded its deadline.`));
  }, Math.min(REQUEST_TIMEOUT_MS, remainingGlobalMs()));
  try {
    for (;;) {
      const item = await Promise.race([reader.read(), deadline]);
      if (item.done) {
        completed = true;
        break;
      }
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error(`Response for ${label} exceeded its size limit.`);
      chunks.push(item.value);
    }
  } finally {
    clearTimeout(timeout);
    if (expired || !completed) void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* a pending cancellation owns the reader */ }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
    server.close();
    throw new Error('Could not reserve a loopback port.');
  }
  await new Promise((resolvePromise, rejectPromise) => server.close((error) => {
    if (error === undefined) resolvePromise();
    else rejectPromise(error);
  }));
  return address.port;
}

function remainingGlobalMs() {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('Deployment smoke global deadline exceeded.');
  return remaining;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(milliseconds, remainingGlobalMs())));
}

function parseJson(value, message) {
  try { return JSON.parse(value); } catch { throw new Error(message); }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
}

function assertMatch(actual, pattern, message) {
  if (!pattern.test(actual)) throw new Error(message);
}

function safeName(error) {
  return error instanceof Error && /^[A-Za-z0-9_.-]{1,128}$/u.test(error.name) ? error.name : 'UnknownError';
}

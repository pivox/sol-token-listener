import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GLOBAL_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 65_000;
const SIGNAL_CHILD_TIMEOUT_MS = 5_000;
const SELF_SIGNAL_TIMEOUT_MS = 1_000;
const FAULT_PROBE_TIMEOUT_MS = 260_000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RETENTION_OUTPUT_BYTES = 16 * 1024;
const MAX_FAILURE_SUMMARY_BYTES = 1_024;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(root, 'deploy/compose.yaml');
const smokeComposeFile = resolve(root, 'deploy/compose.smoke.yaml');
const scriptPath = fileURLToPath(import.meta.url);
let invocationMode;
let invocationFailure;
try {
  invocationMode = parseInvocationMode(process.argv.slice(2));
} catch (error) {
  invocationFailure = error;
}
const projectName = invocationMode === 'self-sigterm' || invocationMode === 'self-sigkill'
  ? faultProjectName(process.env.DEPLOYMENT_SMOKE_FAULT_PROJECT_NAME)
  : `sol-listener-smoke-${process.pid}-${randomBytes(4).toString('hex')}`;
const projectLabel = `label=com.docker.compose.project=${projectName}`;
const deploymentImages = deploymentImagesFor(projectName);
const postgresPassword = randomBytes(24).toString('hex');
const deadlineAt = Date.now() + GLOBAL_TIMEOUT_MS;
const signalExitCodes = Object.freeze({ SIGINT: 130, SIGTERM: 143 });
let cleanupDeadlineAt = null;
let activeSignalRuntime = null;
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
  '014_social_persistence_retry.sql',
  '015_paper_active_session_per_mint.sql',
  '016_listener_catch_up_gaps.sql',
  '017_creation_entry_strategy.sql',
  '018_paper_mvp_validation.sql',
  '019_paper_mvp_collection.sql',
  '020_paper_mvp_derived_pnl.sql',
  '021_paper_mvp_runner_hardening.sql',
  '022_paper_mvp_coverage_indexes.sql',
  '023_paper_mvp_exact_strategy.sql',
  '024_paper_mvp_position_coverage.sql',
  '025_paper_mvp_effective_configuration.sql',
  '026_listener_strict_catch_up_failures.sql',
  '027_listener_provider_affine_finality.sql',
  '028_paper_finality_replay_evidence.sql',
  '029_paper_finality_claim_scheduler.sql',
  '030_listener_websocket_health.sql',
  '031_execution_intents.sql',
]);
const canonicalRetentionCounters = Object.freeze([
  'apiEventStream',
  'bondingCurveSnapshots',
  'creatorProfiles',
  'domainEvents',
  'executionAttempts',
  'executionIntents',
  'executionIntentTransitions',
  'holderSnapshots',
  'launchTrades',
  'listenerCatchUpGaps',
  'listenerStrictCatchUpFailures',
  'marketPools',
  'marketReserveSnapshots',
  'marketTrades',
  'metadataSnapshots',
  'migrations',
  'observedWalletPositions',
  'paperDecisionJobs',
  'paperExternalBuys',
  'paperMvpRuns',
  'paperMvpSamples',
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
  'websocketHealthEvidence',
]);
const projectResourceChecks = projectResourceChecksFor(projectLabel);

function projectResourceChecksFor(label) {
  return Object.freeze([
    Object.freeze({
      kind: 'container',
      args: Object.freeze(['ps', '-a', '--filter', label, '--format', '{{.ID}}']),
    }),
    Object.freeze({
      kind: 'network',
      args: Object.freeze(['network', 'ls', '--filter', label, '--format', '{{.ID}}']),
    }),
    Object.freeze({
      kind: 'volume',
      args: Object.freeze(['volume', 'ls', '--filter', label, '--format', '{{.Name}}']),
    }),
    Object.freeze({
      kind: 'image',
      args: Object.freeze(['image', 'ls', '--filter', label, '--format', '{{.ID}}']),
    }),
  ]);
}

function deploymentImagesFor(name) {
  return Object.freeze({
    backend: `sol-token-listener-smoke-backend:${name}`,
    frontend: `sol-token-listener-smoke-frontend:${name}`,
  });
}

const environment = Object.freeze({
  ...process.env,
  COMPOSE_PROJECT_NAME: projectName,
  POSTGRES_DB: 'smoke',
  POSTGRES_USER: 'smoke',
  POSTGRES_PASSWORD: postgresPassword,
  POSTGRES_PASSWORD_URI_ENCODED: encodeURIComponent(postgresPassword),
  BACKEND_IMAGE: deploymentImages.backend,
  FRONTEND_IMAGE: deploymentImages.frontend,
  SOLANA_HTTP_RPC_URL: 'https://rpc.invalid',
  SOLANA_WS_RPC_URL: 'wss://rpc.invalid',
  LISTENER_ENABLED: 'false',
  FRONTEND_PORT: '0',
});
let baseUrl = null;

let exitCode = 1;
try {
  if (invocationFailure !== undefined) throw invocationFailure;
  if (invocationMode === 'signal-fault-probe' || invocationMode === 'signal-fault-probe-kill') {
    await runSignalFaultProbe(invocationMode === 'signal-fault-probe-kill' ? 'SIGKILL' : 'SIGTERM');
    process.stdout.write('Deployment signal fault probe passed.\n');
    exitCode = 0;
  } else {
    const selfSignal = invocationMode === 'self-sigterm'
      ? 'SIGTERM'
      : invocationMode === 'self-sigkill' ? 'SIGKILL' : null;
    exitCode = await runDeployment(selfSignal);
    if (exitCode === 0) process.stdout.write('Deployment smoke passed.\n');
  }
} catch (error) {
  process.stderr.write(deploymentFailureLine(error));
  exitCode = 1;
}
process.exitCode = exitCode;

async function runDeployment(selfSignal) {
  const signals = installSmokeSignalHandlers();
  activeSignalRuntime = signals;
  let primaryFailure;
  const cleanupFailures = [];
  try {
    try {
      await compose(['build', 'app', 'frontend']);
      await compose(['up', '--detach', '--wait', '--wait-timeout', '120']);
      baseUrl = await discoverFrontendBaseUrl();
      if (selfSignal !== null) {
        await runActiveChildSignalProbe(selfSignal);
      }
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
    } catch (error) {
      primaryFailure = error;
    }
  } finally {
    cleanupDeadlineAt = Date.now() + CLEANUP_TIMEOUT_MS;
    try {
      try {
        await runDocker(
          composeCommand(['down', '--volumes', '--remove-orphans', '--rmi', 'local']),
          { cleanup: true, reflectFailureOutput: false },
        );
      } catch (error) {
        cleanupFailures.push(error);
      }
      await cleanupExplicitImages(deploymentImages, environment, cleanupFailures);
      for (const check of projectResourceChecks) {
        try {
          const { stdout, stderr } = await runDocker(check.args, {
            cleanup: true,
            reflectFailureOutput: false,
          });
          if (stderr !== '' || stdout.trim() !== '') {
            throw new Error(`Deployment smoke left project ${check.kind} resources behind.`);
          }
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    } finally {
      signals.restore();
      activeSignalRuntime = null;
      cleanupDeadlineAt = null;
    }
  }

  if (primaryFailure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError([primaryFailure, ...cleanupFailures], 'Deployment smoke and cleanup failed.');
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    throw new AggregateError(cleanupFailures, 'Deployment smoke cleanup failed.');
  }
  const receivedSignal = signals.received();
  if (receivedSignal !== null) return signalExitCodes[receivedSignal];
  if (primaryFailure !== undefined) throw primaryFailure;
  return 0;
}

async function runActiveChildSignalProbe(signal) {
  const timer = setTimeout(() => {
    process.kill(process.pid, signal);
  }, SELF_SIGNAL_TIMEOUT_MS);
  try {
    await compose([
      'exec', '-T', 'app', 'node', '-e', 'setInterval(() => undefined, 1_000)',
    ], { reflectFailureOutput: false });
    throw new Error('Deployment signal fault child exited without interruption.');
  } finally {
    clearTimeout(timer);
  }
}

function parseInvocationMode(args) {
  if (args.length === 0) return 'nominal';
  if (args.length === 1 && args[0] === '--signal-fault-probe') return 'signal-fault-probe';
  if (args.length === 1 && args[0] === '--signal-fault-probe-kill') return 'signal-fault-probe-kill';
  if (args.length === 1 && args[0] === '--self-sigterm') return 'self-sigterm';
  if (args.length === 1 && args[0] === '--self-sigkill') return 'self-sigkill';
  throw new Error('Deployment smoke arguments are invalid.');
}

function faultProjectName(value) {
  if (typeof value !== 'string' || !/^sol-listener-smoke-[0-9]+-[0-9a-f]{8}$/u.test(value)) {
    throw new Error('Deployment signal fault project is invalid.');
  }
  return value;
}

function installSmokeSignalHandlers() {
  let receivedSignal = null;
  let activeChild = null;
  let childDeadline = null;

  const onSigint = () => receive('SIGINT');
  const onSigterm = () => receive('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  function receive(signal) {
    if (receivedSignal !== null) return;
    receivedSignal = signal;
    interruptActiveChild();
  }

  function interruptActiveChild() {
    const child = activeChild;
    if (child === null) return;
    child.kill('SIGTERM');
    childDeadline = setTimeout(() => {
      if (activeChild === child) child.kill('SIGKILL');
    }, SIGNAL_CHILD_TIMEOUT_MS);
  }

  return Object.freeze({
    received: () => receivedSignal,
    track: (child, interruptible) => {
      if (!interruptible) return;
      activeChild = child;
      if (receivedSignal !== null) interruptActiveChild();
    },
    untrack: (child) => {
      if (activeChild !== child) return;
      activeChild = null;
      if (childDeadline !== null) clearTimeout(childDeadline);
      childDeadline = null;
    },
    restore: () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      if (childDeadline !== null) clearTimeout(childDeadline);
      childDeadline = null;
      activeChild = null;
    },
  });
}

async function runSignalFaultProbe(signal) {
  const faultName = `sol-listener-smoke-${process.pid}-${randomBytes(4).toString('hex')}`;
  let primaryFailure;
  const cleanupFailures = [];
  try {
    const result = await runFaultProbeChild(faultName, signal);
    const expected = signal === 'SIGTERM'
      ? result.code === 143 && result.signal === null
      : result.code === null && result.signal === 'SIGKILL';
    if (!expected || result.stdout !== '' || result.stderr !== '') {
      throw new Error('Deployment signal fault probe child returned an invalid result.');
    }
    if (signal === 'SIGKILL') {
      throw new Error('Deployment signal fault probe controlled child failure.');
    }
  } catch (error) {
    primaryFailure = error;
  } finally {
    cleanupDeadlineAt = Date.now() + CLEANUP_TIMEOUT_MS;
    try {
      await cleanupFaultProject(faultName, cleanupFailures);
    } finally {
      cleanupDeadlineAt = null;
    }
  }

  if (primaryFailure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError([primaryFailure, ...cleanupFailures], 'Deployment fault probe and cleanup failed.');
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    throw new AggregateError(cleanupFailures, 'Deployment fault probe cleanup failed.');
  }
  if (primaryFailure !== undefined) throw primaryFailure;
}

async function cleanupFaultProject(faultName, cleanupFailures) {
  const faultEnvironment = faultCleanupEnvironment(faultName);
  try {
    await runDocker(
      composeCommand(['down', '--volumes', '--remove-orphans', '--rmi', 'local'], faultName),
      { cleanup: true, reflectFailureOutput: false, commandEnvironment: faultEnvironment },
    );
  } catch (error) {
    cleanupFailures.push(error);
  }
  await cleanupExplicitImages(deploymentImagesFor(faultName), faultEnvironment, cleanupFailures);
  const faultLabel = `label=com.docker.compose.project=${faultName}`;
  for (const check of projectResourceChecksFor(faultLabel)) {
    try {
      const probe = await runDocker(check.args, {
        cleanup: true,
        reflectFailureOutput: false,
        commandEnvironment: faultEnvironment,
      });
      if (probe.stderr !== '' || probe.stdout.trim() !== '') {
        throw new Error(`Deployment signal fault probe left ${check.kind} resources behind.`);
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
}

async function cleanupExplicitImages(images, commandEnvironment, cleanupFailures) {
  for (const imageReference of Object.values(images)) {
    try {
      let probe = await findExplicitImage(imageReference, commandEnvironment);
      if (probe.stderr !== '') throw new Error('Deployment smoke image lookup emitted unexpected stderr.');
      if (probe.stdout.trim() !== '') {
        await runDocker(['image', 'rm', imageReference], {
          cleanup: true,
          reflectFailureOutput: false,
          commandEnvironment,
        });
      }
      probe = await findExplicitImage(imageReference, commandEnvironment);
      if (probe.stderr !== '' || probe.stdout.trim() !== '') {
        throw new Error('Deployment smoke left an explicit image reference behind.');
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
}

async function findExplicitImage(imageReference, commandEnvironment) {
  return runDocker(
    ['image', 'ls', '--filter', `reference=${imageReference}`, '--format', '{{.ID}}'],
    { cleanup: true, reflectFailureOutput: false, commandEnvironment },
  );
}

function faultCleanupEnvironment(faultName) {
  return Object.freeze({
    ...process.env,
    COMPOSE_PROJECT_NAME: faultName,
    POSTGRES_DB: 'smoke',
    POSTGRES_USER: 'smoke',
    POSTGRES_PASSWORD: 'cleanup-only',
    POSTGRES_PASSWORD_URI_ENCODED: 'cleanup-only',
    BACKEND_IMAGE: deploymentImagesFor(faultName).backend,
    FRONTEND_IMAGE: deploymentImagesFor(faultName).frontend,
    SOLANA_HTTP_RPC_URL: 'https://rpc.invalid',
    SOLANA_WS_RPC_URL: 'wss://rpc.invalid',
    LISTENER_ENABLED: 'false',
    FRONTEND_PORT: '0',
  });
}

async function runFaultProbeChild(faultName, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [scriptPath, signal === 'SIGKILL' ? '--self-sigkill' : '--self-sigterm'],
      {
        cwd: root,
        env: Object.freeze({
          ...process.env,
          COMPOSE_PROJECT_NAME: faultName,
          DEPLOYMENT_SMOKE_FAULT_PROJECT_NAME: faultName,
        }),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, FAULT_PROBE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => collect(chunk, stdout));
    child.stderr.on('data', (chunk) => collect(chunk, stderr));
    child.once('error', () => finish(new Error('Deployment signal fault probe could not start.')));
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish(new Error('Deployment signal fault probe exceeded its deadline.'));
        return;
      }
      finish(undefined, Object.freeze({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }));
    });

    function collect(chunk, target) {
      if (!Buffer.isBuffer(chunk)) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_RETENTION_OUTPUT_BYTES) {
        timedOut = true;
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

async function compose(args, options = {}) {
  return runDocker(composeCommand(args), options);
}

function composeCommand(args, projectNameOverride) {
  const projectArgs = projectNameOverride === undefined
    ? []
    : ['--project-name', projectNameOverride];
  return ['compose', ...projectArgs, '-f', composeFile, '-f', smokeComposeFile, ...args];
}

async function runDocker(args, options = {}) {
  return runCommand('docker', args, options);
}

async function runCommand(
  command,
  args,
  { cleanup = false, reflectFailureOutput = true, commandEnvironment = environment } = {},
) {
  const timeoutMs = cleanup
    ? remainingCleanupMs()
    : Math.max(1, deadlineAt - Date.now());
  if (!cleanup && Date.now() >= deadlineAt) throw new Error('Deployment smoke global deadline exceeded.');
  if (!cleanup && activeSignalRuntime?.received() !== null) {
    throw new Error('Deployment smoke interrupted.');
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env: commandEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeSignalRuntime?.track(child, !cleanup);
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
      if (!cleanup && activeSignalRuntime?.received() !== null) {
        finish(new Error('Deployment smoke interrupted.'));
        return;
      }
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
      activeSignalRuntime?.untrack(child);
      if (error === undefined) resolvePromise(result);
      else rejectPromise(error);
    }
  });
}

function remainingCleanupMs() {
  if (cleanupDeadlineAt === null) throw new Error('Deployment cleanup deadline is unavailable.');
  const remaining = cleanupDeadlineAt - Date.now();
  if (remaining <= 0) throw new Error('Deployment cleanup deadline exceeded.');
  return remaining;
}

function commandLabel(args) {
  const action = args.find((value) =>
    value !== 'compose'
    && value !== '-f'
    && value !== composeFile
    && value !== smokeComposeFile);
  return `Docker ${action ?? 'command'}`;
}

function redact(value) {
  return value.replaceAll(postgresPassword, '[REDACTED]')
    .replaceAll(encodeURIComponent(postgresPassword), '[REDACTED]');
}

function deploymentFailureLine(error) {
  const prefix = 'Deployment smoke failed: ';
  const suffix = '.\n';
  const availableBytes = MAX_FAILURE_SUMMARY_BYTES
    - Buffer.byteLength(prefix, 'utf8')
    - Buffer.byteLength(suffix, 'utf8');
  const summary = summarizeFailure(error);
  return `${prefix}${summary.slice(0, availableBytes)}${suffix}`;
}

function summarizeFailure(error, depth = 0) {
  if (depth >= 4) return 'Error(depth_limit)';
  let summary;
  if (error instanceof AggregateError) {
    const causes = [...error.errors].slice(0, 8).map((cause) => summarizeFailure(cause, depth + 1));
    summary = `AggregateError(${error.errors.length})[${causes.join(',')}]`;
  } else if (error instanceof Error) {
    summary = `${safeName(error)}(${failureCategory(error.message)})`;
  } else {
    summary = 'UnknownError(non_error)';
  }
  return redact(summary).replaceAll(/[\r\n\t]/gu, ' ');
}

function failureCategory(message) {
  if (/arguments are invalid/iu.test(message)) return 'arguments';
  if (/cleanup|left .* resources behind|\bdown\b/iu.test(message)) return 'cleanup';
  if (/deadline|timeout/iu.test(message)) return 'timeout';
  if (/signal|interrupt/iu.test(message)) return 'signal';
  if (/could not start/iu.test(message)) return 'spawn';
  if (/output limit|response/iu.test(message)) return 'bounded_io';
  if (/failed \((?:exit|SIG)/u.test(message)) return 'command';
  if (/fault probe/iu.test(message)) return 'fault_probe';
  return 'validation';
}

async function discoverFrontendBaseUrl() {
  const { stdout, stderr } = await compose(
    ['port', 'frontend', '8080'],
    { reflectFailureOutput: false },
  );
  if (stderr !== '') throw new Error('Frontend port discovery emitted unexpected stderr.');
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})\n$/u.exec(stdout);
  const port = Number(match?.[1]);
  if (match === null || !Number.isSafeInteger(port) || port > 65_535) {
    throw new Error('Frontend loopback port discovery failed.');
  }
  return `http://127.0.0.1:${port}`;
}

function publicBaseUrl() {
  if (baseUrl === null) throw new Error('Frontend loopback port is unavailable.');
  return baseUrl;
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
  const { stdout } = await runDocker(composeCommand([
    'exec', '-T', 'postgres', 'psql',
    '-X', '-A', '-t', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-U', 'smoke', '-d', 'smoke', '-c', sql,
  ]));
  return stdout.trim().split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('|');
    if (separator <= 0 || separator === line.length - 1) throw new Error('Migration history row is malformed.');
    return Object.freeze({ version: line.slice(0, separator), appliedAt: line.slice(separator + 1) });
  });
}

function assertMigrationHistory(rows) {
  assertEqual(rows.length, canonicalMigrations.length, 'Migration history does not contain the canonical rows.');
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
  const response = await requestWithDeadline(`${publicBaseUrl()}/api/v1/events`, {
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
  const response = await requestWithDeadline(`${publicBaseUrl()}${path}`, options);
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

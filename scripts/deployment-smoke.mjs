import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GLOBAL_TIMEOUT_MS = 600_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 65_000;
const SIGNAL_CHILD_TIMEOUT_MS = 5_000;
const SELF_SIGNAL_TIMEOUT_MS = 1_000;
const FAULT_PROBE_TIMEOUT_MS = 260_000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RETENTION_OUTPUT_BYTES = 16 * 1024;
const MAX_RETENTION_COUNTERS = 128;
const MAX_FAILURE_SUMMARY_BYTES = 1_024;
const smokeFailureContext = new WeakMap();
const SMOKE_PHASES = new Set([
  'BUILD', 'HOST_SETUP', 'VAULT_SETUP', 'VAULT_IMPORT', 'START', 'PORT_DISCOVERY', 'SIGNAL_PROBE',
  'PROCESS_USERS', 'NON_ROOT_FRONT', 'SECRET_ISOLATION', 'FRONT_AUTH', 'PUBLIC_HEALTH', 'CORS',
  'MIGRATIONS', 'LOGINS', 'OPERATIONS', 'HELIUS_RELOAD', 'FRONTEND', 'SSE_SHUTDOWN', 'APP_RESTART',
  'HEALTH_RECOVERY', 'RETENTION', 'BACKUP', 'VAULT_RESTART', 'VAULT_FAIL_CLOSED', 'SECRET_LEAKS',
  'CLEANUP',
]);
const SMOKE_OPERATIONS = new Set(['HTTP_HEADERS', 'HTTP_BODY', 'SSE_BODY']);
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED', 'UND_ERR_DESTROYED',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
]);
const FAILURE_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'URIError', 'EvalError', 'AbortError', 'TimeoutError',
]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(root, 'deploy/compose.yaml');
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
const hostDirectory = hostDirectoryFor(projectName);
const SMOKE_USER = 'smoke';
const postgresPassword = randomBytes(24).toString('hex');
const frontPassword = randomBytes(24).toString('hex');
// Same table as src/deploy/stack.ts DATABASE_LOGINS (tests/deployment-artifacts.test.ts checks it).
const loginGroups = Object.freeze({
  sol_listener: 'sol_token_listener_writer',
  sol_live: 'sol_token_executor_live',
  sol_recovery: 'sol_token_executor_live_recovery',
  sol_autoarm: 'sol_token_executor_operations',
  sol_reader: 'sol_token_operator_reader',
  sol_retention: 'sol_token_retention_worker',
  sol_worker: 'sol_token_executor_worker',
  sol_ops: 'sol_token_executor_operations',
  sol_readiness: 'sol_token_executor_readiness',
});
// Throwaway: random bytes, never a funded key; proves that observe mode leaves it in Vault.
const throwawayKeypair = JSON.stringify([...randomBytes(64)]);
// The fake RPC URLs carry a key, as a provider's do: the leak checks look for it too.
const rpcApiKey = randomBytes(16).toString('hex');
const spareRpcApiKey = randomBytes(16).toString('hex');
// The executor's own project key: vault-import refuses a listener key equal to it.
const executorRpcApiKey = randomBytes(16).toString('hex');
// Grows at run time with what Vault generates or the back pulls: every value is redacted.
const smokeSecrets = [postgresPassword, frontPassword, throwawayKeypair, rpcApiKey, spareRpcApiKey, executorRpcApiKey];
let operatorPassword = null;
const basicAuthorization = `Basic ${Buffer.from(`${SMOKE_USER}:${frontPassword}`).toString('base64')}`;
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
  '032_execution_dry_run_assessments.sql',
  '033_execution_simulation_artifacts.sql',
  '034_execution_risk_reconciliation.sql',
  '035_execution_preflight_operations.sql',
  '036_execution_live_canary.sql',
  '037_execution_live_orchestration.sql',
  '038_execution_live_rpc_budget.sql',
  '039_execution_canary_operator_binding.sql',
  '040_execution_worker_live_partition.sql',
  '041_execution_preflight_intent_pairs.sql',
  '042_execution_preflight_intent_preparation.sql',
  '043_execution_intent_causal_lineage.sql',
  '044_transaction_inbox_launch_priority.sql',
  '045_execution_wallet_snapshot_refresh.sql',
  '046_listener_strict_catch_up_runs.sql',
  '047_transaction_inbox_tracked_trade_priority.sql',
  '048_transaction_inbox_catch_up_classification.sql',
  '049_transaction_inbox_catch_up_admission_receipt.sql',
  '050_transaction_inbox_first_processing.sql',
  '051_transaction_inbox_decoder_quarantine_recovery.sql',
  '052_transaction_inbox_urgent_fairness.sql',
  '053_transaction_inbox_worker_admission_foundation.sql',
  '054_paper_entry_boundary.sql',
  '055_creation_entry_single_active_session.sql',
  '056_transaction_inbox_bounded_tracking.sql',
  '057_transaction_inbox_terminal_attribution.sql',
  '058_transaction_inbox_funding_attribution.sql',
  '059_transaction_inbox_qualification_attribution.sql',
  '060_listener_tracked_pool_checkpoints.sql',
  '061_execution_live_position_ledger.sql',
  '062_drop_dossier_and_legacy_tables.sql',
  '063_listener_tracked_curve_checkpoints.sql',
  '064_fast_entry_decisions.sql',
  '065_entry_envelope_auto_arm.sql',
  '066_live_position_reexit.sql',
  '067_fast_entry_probe_unarmable.sql',
  '068_live_build_fingerprint_per_transaction.sql',
]);
const canonicalRetentionCounters = Object.freeze([
  'apiEventStream',
  'bondingCurveSnapshots',
  'domainEvents',
  'entryDecisions',
  'executionActivationArmaments',
  'executionActivationEvents',
  'executionAttempts',
  'executionControlEvents',
  'executionDryRunAssessments',
  'executionExitAuthorizations',
  'executionIntents',
  'executionIntentsExpiredPreSubmission',
  'executionIntentTransitions',
  'executionLivePositions',
  'executionLiveUnsignedSimulationEvidence',
  'executionOperatorAuthorizations',
  'executionPreflightIntentPairMemberships',
  'executionPreflightIntentPairs',
  'executionPreflightPreparationRuns',
  'executionPreSignatureLocks',
  'executionRiskAdmissionReports',
  'executionRiskFaults',
  'executionRiskProviderOperations',
  'executionRiskProviderSnapshots',
  'executionRiskRateLimitEvents',
  'executionRiskReconciliationEvidence',
  'executionRiskReservations',
  'executionRiskTombstones',
  'executionRiskWalletSnapshots',
  'executionSafetyQualifications',
  'executionSignedSimulationEvidence',
  'executionSignedTransactions',
  'executionSimulationArtifacts',
  'executionSubmissionEvents',
  'listenerCatchUpGaps',
  'listenerStrictCatchUpFailures',
  'listenerStrictCatchUpRuns',
  'marketPools',
  'marketReserveSnapshots',
  'marketTrades',
  'metadataSnapshots',
  'migrations',
  'paperDecisionJobs',
  'paperExternalBuys',
  'paperPositions',
  'paperSessions',
  'paperTrades',
  'qualificationReports',
  'rawChainEvents',
  'stateTransitions',
  'tokenLaunches',
  'tradingCandidates',
  'transactionInbox',
  'transactionInboxDecoderRecoveries',
  'transactionInboxIncompleteAttributions',
  'transactionInboxRecoveries',
  'transactionInboxTerminalAttributions',
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

function hostDirectoryFor(name) {
  return join(tmpdir(), `${name}-host`);
}

function deploymentImagesFor(name) {
  return Object.freeze({
    backend: `sol-token-listener-smoke-backend:${name}`,
    frontend: `sol-token-listener-smoke-frontend:${name}`,
    vault: `sol-token-listener-smoke-vault:${name}`,
  });
}

// The compose inputs the smoke sets, also written to compose.env: the host scripts read them there.
const COMPOSE_INPUTS = Object.freeze([
  'COMPOSE_PROJECT_NAME', 'SOL_HOST_DIR', 'SOL_STACK_MODE', 'SOL_HEALTH_REQUIRE_OK',
  'SOL_VAULT_PULL_TIMEOUT_MS', 'POSTGRES_DB', 'BACKEND_IMAGE', 'FRONTEND_IMAGE', 'VAULT_IMAGE',
  'FRONT_PORT', 'VAULT_PORT', 'FRONT_BASIC_AUTH_USER',
]);
const environment = Object.freeze({
  ...process.env,
  COMPOSE_PROJECT_NAME: projectName,
  SOL_HOST_DIR: hostDirectory,
  SOL_STACK_MODE: 'observe',
  SOL_HEALTH_REQUIRE_OK: 'false',
  // Seconds, not a minute: VAULT_FAIL_CLOSED waits for the back to give up on a stopped Vault.
  SOL_VAULT_PULL_TIMEOUT_MS: '5000',
  POSTGRES_DB: 'smoke',
  BACKEND_IMAGE: deploymentImages.backend,
  FRONTEND_IMAGE: deploymentImages.frontend,
  VAULT_IMAGE: deploymentImages.vault,
  FRONT_PORT: '0',
  VAULT_PORT: '0',
  FRONT_BASIC_AUTH_USER: SMOKE_USER,
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
      await smokePhase('BUILD', async () => { await compose(['build', 'back', 'front', 'vault']); });
      await smokePhase('HOST_SETUP', writeSmokeHost);
      await smokePhase('VAULT_SETUP', setupSmokeVault);
      await smokePhase('VAULT_IMPORT', importSmokeVault);
      await smokePhase('START', async () => { await compose(['up', '--detach', '--wait', '--wait-timeout', '180']); });
      baseUrl = await smokePhase('PORT_DISCOVERY', discoverFrontendBaseUrl);
      if (selfSignal !== null) {
        await smokePhase('SIGNAL_PROBE', async () => { await runActiveChildSignalProbe(selfSignal); });
      }
      await smokePhase('PROCESS_USERS', assertProcessUsers);
      await smokePhase('NON_ROOT_FRONT', assertFrontNonRoot);
      await smokePhase('SECRET_ISOLATION', assertSecretIsolation);
      await smokePhase('FRONT_AUTH', assertFrontAuthentication);
      await smokePhase('PUBLIC_HEALTH', assertPublicHealth);
      await smokePhase('CORS', assertCorsContract);

      await smokePhase('MIGRATIONS', async () => {
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
      });

      await smokePhase('LOGINS', assertLogins);
      await smokePhase('OPERATIONS', assertOperations);
      await smokePhase('HELIUS_RELOAD', assertHeliusReload);
      await smokePhase('FRONTEND', assertFrontendContract);
      await smokePhase('SSE_SHUTDOWN', assertGracefulSseShutdown);
      await smokePhase('APP_RESTART', async () => { await compose(['exec', '-T', 'back', 'sol', 'ctl', 'start', 'listener']); });
      await smokePhase('HEALTH_RECOVERY', waitForPublicHealth);
      await smokePhase('RETENTION', assertRetentionOneShot);
      await smokePhase('BACKUP', assertBackup);
      await smokePhase('VAULT_RESTART', assertVaultAutoUnseal);
      await smokePhase('VAULT_FAIL_CLOSED', assertBackFailsClosed);
      // Last: the scan covers the entrypoint's first unseal from the key file (VAULT_RESTART) and the
      // boots refused without Vault.
      await smokePhase('SECRET_LEAKS', assertNoSecretLeak);
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
      try {
        await rm(hostDirectory, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
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

  for (const error of cleanupFailures) annotateSmokeFailure(error, { phase: 'CLEANUP' });
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
      'exec', '-T', 'back', 'node', '-e', 'setInterval(() => undefined, 1_000)',
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
    annotateSmokeFailure(error, { phase: 'SIGNAL_PROBE' });
    primaryFailure = error;
  } finally {
    cleanupDeadlineAt = Date.now() + CLEANUP_TIMEOUT_MS;
    try {
      await cleanupFaultProject(faultName, cleanupFailures);
    } finally {
      cleanupDeadlineAt = null;
    }
  }

  for (const error of cleanupFailures) annotateSmokeFailure(error, { phase: 'CLEANUP' });
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
  try {
    await rm(hostDirectoryFor(faultName), { recursive: true, force: true });
  } catch (error) {
    cleanupFailures.push(error);
  }
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
    SOL_HOST_DIR: hostDirectoryFor(faultName),
    POSTGRES_DB: 'smoke',
    BACKEND_IMAGE: deploymentImagesFor(faultName).backend,
    FRONTEND_IMAGE: deploymentImagesFor(faultName).frontend,
    VAULT_IMAGE: deploymentImagesFor(faultName).vault,
    FRONT_PORT: '0',
    VAULT_PORT: '0',
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
  return ['compose', ...projectArgs, '-f', composeFile, ...args];
}

async function runDocker(args, options = {}) {
  return runCommand('docker', args, options);
}

async function runCommand(
  command,
  args,
  { cleanup = false, reflectFailureOutput = true, commandEnvironment = environment, input } = {},
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
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (input !== undefined) child.stdin.end(input);
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
    && value !== composeFile);
  return `${action?.endsWith('.sh') ? 'Command' : 'Docker'} ${action ?? 'command'}`;
}

function redact(value) {
  let redacted = value;
  for (const secret of smokeSecrets) {
    redacted = redacted.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]');
  }
  return redacted;
}

async function smokePhase(phase, operation) {
  try {
    return await operation();
  } catch (error) {
    annotateSmokeFailure(error, { phase });
    throw error;
  }
}

function annotateSmokeFailure(error, { phase, operation }) {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return;
  const previous = smokeFailureContext.get(error) ?? {};
  smokeFailureContext.set(error, {
    phase: previous.phase ?? (SMOKE_PHASES.has(phase) ? phase : undefined),
    operation: previous.operation ?? (SMOKE_OPERATIONS.has(operation) ? operation : undefined),
  });
}

function failureContextSummary(error) {
  const context = smokeFailureContext.get(error);
  const fields = [];
  if (context?.phase !== undefined) fields.push(`phase=${context.phase}`);
  if (context?.operation !== undefined) fields.push(`operation=${context.operation}`);
  // Never stringify arbitrary codes, causes, names, URLs, or error messages.
  let transport;
  try {
    const ownCode = error.code;
    const code = TRANSPORT_CODES.has(ownCode) ? ownCode : error.cause?.code;
    if (TRANSPORT_CODES.has(code)) transport = code;
  } catch { /* Diagnostic getters cannot change the smoke outcome. */ }
  if (transport !== undefined) fields.push(`transport=${transport}`);
  return fields.length === 0 ? '' : `{${fields.join(',')}}`;
}

function deploymentFailureLine(error) {
  const prefix = 'Deployment smoke failed: ';
  const suffix = '.\n';
  const availableBytes = MAX_FAILURE_SUMMARY_BYTES
    - Buffer.byteLength(prefix, 'utf8')
    - Buffer.byteLength(suffix, 'utf8');
  let summary;
  try {
    summary = summarizeFailure(error);
  } catch {
    summary = 'UnknownError(diagnostic_unavailable)';
  }
  return `${prefix}${summary.slice(0, availableBytes)}${suffix}`;
}

function summarizeFailure(error, depth = 0) {
  if (depth >= 4) return 'Error(depth_limit)';
  let summary;
  if (error instanceof AggregateError) {
    const errors = error.errors;
    if (!Array.isArray(errors)) return 'UnknownError(diagnostic_unavailable)';
    const count = errors.length;
    if (!Number.isSafeInteger(count) || count < 0) return 'UnknownError(diagnostic_unavailable)';
    const causes = [];
    for (let index = 0; index < Math.min(count, 8); index += 1) {
      causes.push(summarizeFailure(errors[index], depth + 1));
    }
    summary = `AggregateError(${count})[${causes.join(',')}]${failureContextSummary(error)}`;
  } else if (error instanceof Error) {
    const errorName = error.name;
    const message = error.message;
    const name = FAILURE_NAMES.has(errorName) ? errorName : 'UnknownError';
    summary = `${name}(${failureCategory(typeof message === 'string' ? message : '')})${failureContextSummary(error)}`;
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
    ['port', 'front', '8080'],
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

async function writeSmokeHost() {
  const { stdout: frontHash } = await runDocker([
    'run', '--rm', '-i', '--entrypoint', 'caddy', deploymentImages.frontend, 'hash-password',
    '--bcrypt-cost', '10',
  ], { input: `${frontPassword}\n`, reflectFailureOutput: false });
  if (!/^\$2a\$10\$[./A-Za-z0-9]{53}\n$/u.test(frontHash)) throw new Error('Caddy did not return a bcrypt hash.');
  // The layout of deploy/host/init-secrets.sh, plus the import source.
  for (const directory of [
    'secrets/db', 'secrets/front', 'secrets/vault/unseal', 'secrets/vault/approle',
    'import/env', 'import/keys', 'backups',
  ]) {
    await mkdir(join(hostDirectory, directory), { recursive: true, mode: 0o700 });
  }
  await chmod(hostDirectory, 0o700);
  await writeFile(join(hostDirectory, 'secrets/db/postgres-admin-password'), `${postgresPassword}\n`, { mode: 0o600 });
  await writeFile(join(hostDirectory, 'secrets/front/front-basic-auth-hash'), frontHash, { mode: 0o600 });
  // Import source in the lot5 layout: role files under env/, and a key file outside it that a
  // *_PATH variable names. The smoke never contacts an RPC: its listener only serves the API.
  const keypairFile = join(hostDirectory, 'import/keys/wallet-keypair.json');
  await writeFile(keypairFile, `${throwawayKeypair}\n`, { mode: 0o600 });
  for (const [name, lines] of [
    ['listener', [
      'LISTENER_ENABLED=false',
      `SOLANA_HTTP_RPC_URL=https://rpc.invalid/?api-key=${rpcApiKey}`,
      `SOLANA_WS_RPC_URL=wss://rpc.invalid/?api-key=${rpcApiKey}`,
    ]],
    ['live', [
      // opapi reads the wallet balance through the executor project in both modes.
      `SOLANA_HTTP_RPC_URL=https://rpc.invalid/?api-key=${executorRpcApiKey}`,
      `EXECUTOR_KEYPAIR_PATH=${keypairFile}`,
    ]],
  ]) {
    const template = await readFile(resolve(root, `deploy/config/${name}.env.example`), 'utf8');
    await writeFile(join(hostDirectory, `import/env/${name}.env`), [template.trimEnd(), ...lines, ''].join('\n'), { mode: 0o600 });
  }
  await writeFile(
    join(hostDirectory, 'compose.env'),
    COMPOSE_INPUTS.map((name) => `${name}=${environment[name]}\n`).join(''),
    { mode: 0o600 },
  );
}

/**
 * A host script runs as on the operator's machine: SOL_HOST_DIR and what Docker needs, while every
 * other compose input comes from compose.env. The project name comes from both, in defence in
 * depth: should Compose stop reading it from --env-file, no script may act on the operator's own
 * sol-token-listener project.
 */
function hostScriptEnvironment(extra = {}) {
  return Object.freeze({
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|HOME|DOCKER_\w+)$/u.test(name))),
    COMPOSE_PROJECT_NAME: projectName,
    SOL_HOST_DIR: hostDirectory,
    ...extra,
  });
}

async function setupSmokeVault() {
  // vault-setup exits 0 only once Vault is unsealed and configured. The script prints the operator
  // password: no failure message may carry its output.
  // Known limitation, as for every host script: a deadline or a signal kills bash, not its docker compose.
  const { stdout, stderr } = await runCommand('bash', [resolve(root, 'deploy/host/vault-init.sh')], {
    commandEnvironment: hostScriptEnvironment(),
    reflectFailureOutput: false,
  });
  const password = /^Vault operator password, shown once \(store it in your password manager\): (\S+)$/mu.exec(stdout)?.[1];
  if (password === undefined) throw new Error('vault-init.sh did not print the operator password.');
  operatorPassword = password;
  smokeSecrets.push(password);
  const unsealKey = (await readFile(join(hostDirectory, 'secrets/vault/unseal/unseal-key'), 'utf8')).trim();
  if (unsealKey === '') throw new Error('vault-setup wrote an empty unseal key.');
  smokeSecrets.push(unsealKey);
  for (const name of ['back', 'migrate', 'backup']) {
    const approle = parseJson(
      await readFile(join(hostDirectory, `secrets/vault/approle/${name}.json`), 'utf8'),
      'vault-setup wrote an unreadable AppRole file.',
    );
    if (typeof approle?.secret_id !== 'string' || approle.secret_id === '') {
      throw new Error('vault-setup wrote an AppRole file without its secret_id.');
    }
    smokeSecrets.push(approle.secret_id);
  }
  // Checked once every secret it created is known: the operator password is all it may show.
  assertNoSmokeSecret(`${stdout}\n${stderr}`, 'vault-init.sh printed a secret.', password);
}

async function importSmokeVault() {
  const { stdout, stderr } = await runCommand('bash', [
    resolve(root, 'deploy/host/vault-import.sh'), join(hostDirectory, 'import/env'),
  ], { commandEnvironment: hostScriptEnvironment(), input: `${operatorPassword}\n`, reflectFailureOutput: false });
  assertNoSmokeSecret(`${stdout}\n${stderr}`, 'vault-import.sh printed a secret.');
  const summary = parseJson(stdout.trim().split('\n').at(-1), 'vault-import did not print its summary.');
  assertEqual(summary.configs.join(','), 'listener,live', 'vault-import did not take the two role files.');
  // Every other configuration comes from its repository template.
  const templates = (await readdir(resolve(root, 'deploy/config')))
    .map((file) => /^(.+)\.env\.example$/u.exec(file)?.[1])
    .filter((name) => name !== undefined && name !== 'listener' && name !== 'live');
  assertEqual(
    [...summary.templates].sort().join(','),
    templates.sort().join(','),
    'vault-import did not fill the other configurations from their templates.',
  );
  assertEqual(
    summary.secrets.join(','),
    'helius-listener-accounts,helius-executor-http-url,wallet-keypair.json',
    'vault-import did not import the expected secrets.',
  );
}

/** A file the back pulled from Vault into its root-only tmpfs; the value joins the redactions. */
async function readBackSecret(file) {
  const { stdout } = await compose(['exec', '-T', 'back', 'cat', `/root/secrets/${file}`], { reflectFailureOutput: false });
  const value = stdout.replace(/\n$/u, '');
  if (value === '') throw new Error('The back pulled an empty secret.');
  smokeSecrets.push(value);
  return value;
}

async function assertProcessUsers() {
  const { stdout } = await compose([
    'exec', '-T', 'back', 'sh', '-c',
    'for program in listener opapi retention; do pid="$(sol ctl pid "$program")"; printf "%s %s\\n" "$program" "$(stat -c %u "/proc/$pid")"; done',
  ]);
  assertEqual(stdout, 'listener 10001\nopapi 10005\nretention 10006\n', 'Back programs do not run as their own users.');
}

async function assertFrontNonRoot() {
  const { stdout } = await compose(['exec', '-T', 'front', 'stat', '-c', '%u', '/proc/1']);
  assertEqual(stdout.trim(), '10100', 'Caddy does not run as the unprivileged caddy user.');
}

async function assertSecretIsolation() {
  const secretPaths = ['/run/sol/listener/pg-sol_listener-password', '/run/sol/listener/helius-listener-accounts', '/run/sol/opapi/operator-api-token'];
  const { stdout } = await compose(['exec', '-T', 'back', 'stat', '-c', '%U %a', ...secretPaths]);
  assertEqual(stdout, 'listener 400\nlistener 400\nopapi 400\n', 'Secrets are not owner-only in the tmpfs.');
  for (const path of secretPaths.slice(2)) {
    let readable = true;
    try {
      await compose([
        'exec', '-T', 'back', 'setpriv', '--reuid=listener', '--regid=listener', '--clear-groups', 'cat', path,
      ], { reflectFailureOutput: false });
    } catch {
      readable = false;
    }
    if (readable) throw new Error('The listener user can read the secret of another user.');
  }
  // Observe mode never pulls the keypair out of Vault (Vault spec 7.1): no such file anywhere in
  // either tmpfs, which the container always mounts.
  const { stdout: pulled } = await compose(['exec', '-T', 'back', 'find', '/root/secrets', '/run/sol', '-name', '*keypair*']);
  if (pulled !== '') throw new Error('The observe stack pulled the keypair out of Vault.');
  // The Helius account list reaches the listener user only (Helius accounts spec 8).
  let opapiReadsAccounts = true;
  try {
    await compose([
      'exec', '-T', 'back', 'setpriv', '--reuid=opapi', '--regid=opapi', '--clear-groups',
      'cat', '/run/sol/listener/helius-listener-accounts',
    ], { reflectFailureOutput: false });
  } catch {
    opapiReadsAccounts = false;
  }
  if (opapiReadsAccounts) throw new Error('The opapi user can read the Helius account list.');
  const { stdout: holders } = await compose(['exec', '-T', 'back', 'find', '/run/sol', '-name', 'helius-listener-accounts']);
  assertEqual(holders, '/run/sol/listener/helius-listener-accounts\n', 'The Helius account list reached another user.');
}

/** The operator adds a second account through stdin, as the runbook does, then reloads it alone. */
async function assertHeliusReload() {
  const { stdout: tokenOutput } = await compose(
    ['exec', '-T', 'vault', 'vault', 'write', '-field=token', 'auth/userpass/login/operator', 'password=-'],
    { input: operatorPassword, reflectFailureOutput: false },
  );
  const operatorToken = tokenOutput.trim();
  smokeSecrets.push(operatorToken);
  const tokenEnvironment = { ...environment, VAULT_TOKEN: operatorToken };
  await compose(
    ['exec', '-T', '-e', 'VAULT_TOKEN', 'vault', 'vault', 'kv', 'patch', 'sol/secrets/back/helius-listener-accounts', '02-smoke=-'],
    { commandEnvironment: tokenEnvironment, input: spareRpcApiKey, reflectFailureOutput: false },
  );
  await compose(
    ['exec', '-T', '-e', 'VAULT_TOKEN', 'vault', 'vault', 'token', 'revoke', '-self'],
    { commandEnvironment: tokenEnvironment, reflectFailureOutput: false },
  );
  const before = await programPids();
  const { stdout, stderr } = await compose(['exec', '-T', 'back', 'sol', 'helius', 'reload'], { reflectFailureOutput: false });
  assertNoSmokeSecret(`${stdout}\n${stderr}`, 'sol helius reload printed a secret.');
  assertEqual(stdout, '{"event":"helius.reloaded","accounts":["01","02-smoke"]}\n', 'sol helius reload did not report both accounts.');
  const after = await programPids();
  if (after.listener === before.listener) throw new Error('sol helius reload did not restart the listener.');
  assertEqual(`${after.opapi} ${after.retention}`, `${before.opapi} ${before.retention}`, 'sol helius reload restarted another program.');
  await waitForPublicHealth();
}

async function programPids() {
  const { stdout } = await compose([
    'exec', '-T', 'back', 'sh', '-c',
    'for program in listener opapi retention; do printf "%s %s\\n" "$program" "$(sol ctl pid "$program")"; done',
  ]);
  return Object.fromEntries(stdout.trim().split('\n').map((line) => line.split(' ')));
}

async function assertFrontAuthentication() {
  const operatorApiToken = await readBackSecret('back/operator-api-token');
  const anonymous = await fetchBounded('/index.html', { authenticated: false });
  assertEqual(anonymous.status, 401, 'The front served the console without credentials.');
  const write = await fetchBounded('/api/v1/health', { method: 'POST' });
  assertEqual(write.status, 405, 'The front relayed a write method.');
  const operator = await fetchBounded('/operator/v1/live/overview', { authenticated: false });
  assertEqual(operator.status, 401, 'The operator API answered without its bearer token.');
  const authorized = await fetchBounded('/operator/v1/live/overview', {
    authenticated: false, headers: { authorization: `Bearer ${operatorApiToken}` },
  });
  assertEqual(authorized.status, 200, 'The operator API refused its bearer token through the front.');
}

async function assertLogins() {
  const sql = [
    "SELECT grantee.rolname || '|' || grantee.rolinherit || '|' || coalesce(string_agg(",
    "granted.rolname || ':' || membership.admin_option || ':' || membership.inherit_option || ':'",
    "|| membership.set_option, ','), '') FROM pg_roles grantee",
    'LEFT JOIN pg_auth_members membership ON membership.member = grantee.oid',
    'LEFT JOIN pg_roles granted ON granted.oid = membership.roleid',
    "WHERE grantee.rolcanlogin AND grantee.rolname <> 'sol_owner'",
    'GROUP BY grantee.rolname, grantee.rolinherit ORDER BY grantee.rolname',
  ].join(' ');
  const { stdout } = await runDocker(composeCommand([
    'exec', '-T', 'postgres', 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'sol_owner', '-d', 'smoke', '-c', sql,
  ]));
  const expected = Object.keys(loginGroups).sort()
    .map((login) => `${login}|false|${loginGroups[login]}:false:false:true`).join('\n');
  assertEqual(stdout.trim(), expected, 'Logins are not NOINHERIT members of exactly their group role.');
  for (const [login, group] of Object.entries(loginGroups)) {
    const password = await readBackSecret(`logins/pg-${login}-password`);
    const { stdout: role } = await runDocker(composeCommand([
      'exec', '-T', '-e', `PGPASSWORD=${password}`, '-e', `PGOPTIONS=-c role=${group}`,
      'postgres', 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', login, '-d', 'smoke',
      '-c', 'SELECT current_user',
    ]), { reflectFailureOutput: false });
    assertEqual(role.trim(), group, `Login ${login} cannot take its group role.`);
  }
}

async function assertOperations() {
  const { stdout } = await compose(['exec', '-T', 'back', 'sh', '-c', 'sol ops status 2>&1; echo "exit=$?"']);
  assertMatch(
    stdout,
    /^\{"service":"sol-token-executor-operations","event":"executor\.operations_failed","errorCode":"EXECUTION_OPERATIONS_FAILED"\}\nexit=[1-9][0-9]*\n$/u,
    'sol ops status did not give its closed answer on a database without wallet generation.',
  );
  const supervised = await compose(['exec', '-T', 'back', 'sh', '-c', 'sol ctl status h2b; echo "exit=$?"']);
  assertMatch(supervised.stdout, /^h2b: ERROR \(no such process\)\nexit=4\n$/u, 'H2b is supervised in observe mode.');
  const { stdout: counts } = await runDocker(composeCommand([
    'exec', '-T', 'postgres', 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'sol_owner', '-d', 'smoke', '-c',
    "SELECT (SELECT count(*) FROM execution_entry_envelopes) || '|' || (SELECT count(*) FROM execution_signed_transactions)",
  ]));
  assertEqual(counts.trim(), '0|0', 'The observe stack created an envelope or a signed transaction.');
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
  for (const pipeline of ['pumpfun', 'pumpswap', 'paperDecision']) {
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
    '-X', '-A', '-t', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-U', 'sol_owner', '-d', 'smoke', '-c', sql,
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
    headers: { accept: 'text/event-stream', authorization: basicAuthorization },
    signal: controller.signal,
  });
  assertEqual(response.status, 200, 'SSE did not open.');
  assertEqual(response.headers.get('content-type'), 'text/event-stream; charset=utf-8', 'SSE content type changed.');
  if (response.body === null) throw new Error('SSE response body is missing.');

  let body;
  try {
    const stream = readSseToEof(response.body, controller);
    [, body] = await Promise.all([
      compose(['exec', '-T', 'back', 'sol', 'ctl', 'stop', 'listener']),
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
  } catch (error) {
    annotateSmokeFailure(error, { operation: 'SSE_BODY' });
    throw error;
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
    'exec', '-T', 'back', 'sol-run', 'retention', 'node', '/app/dist/scripts/purge-retained-data.js', '--once',
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
    || keys.length > MAX_RETENTION_COUNTERS
    || Object.values(counters).some((value) => !Number.isSafeInteger(value) || value !== 0)
  ) {
    throw new Error('Retention counters are not the expected empty-database aggregate.');
  }
}

async function assertBackup() {
  // Vault 2 locks a login out after five failures by default, and vault-setup turns that off: the
  // backup must still pass after six wrong secret_ids for its role.
  await assertWrongBackupLoginsRefused();
  const { stdout } = await runCommand('bash', [resolve(root, 'deploy/host/backup.sh')], {
    commandEnvironment: hostScriptEnvironment({ SOL_REPOSITORY: root }),
  });
  const files = /^backup (\S+\.dump) (\S+\.snap)$/mu.exec(stdout);
  if (files === null) throw new Error('backup.sh did not report its dump and its snapshot.');
  const dump = await readFile(files[1]);
  if (dump.subarray(0, 5).toString('latin1') !== 'PGDMP') throw new Error('The database backup is not a pg_dump archive.');
  const snapshot = await readFile(files[2]);
  if (snapshot[0] !== 0x1f || snapshot[1] !== 0x8b) throw new Error('The Vault backup is not a gzip raft snapshot.');
}

/** Six runs of the snapshot tool with the backup role_id and a random secret_id: each is refused (77). */
async function assertWrongBackupLoginsRefused() {
  const approle = parseJson(
    await readFile(join(hostDirectory, 'secrets/vault/approle/backup.json'), 'utf8'),
    'The backup AppRole file is unreadable.',
  );
  if (typeof approle?.role_id !== 'string' || approle.role_id === '') throw new Error('The backup AppRole file has no role_id.');
  const wrongSecretId = randomUUID();
  smokeSecrets.push(wrongSecretId);
  const input = `${JSON.stringify({ role_id: approle.role_id, secret_id: wrongSecretId })}\n`;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    assertEqual(
      await composeExitCode(['run', '--rm', '--no-deps', '-T', 'vault-snapshot'], { input }),
      77,
      'The snapshot tool did not refuse a wrong backup secret_id.',
    );
  }
}

/** The exit code of a compose command, 0 included; its output is never reflected. */
async function composeExitCode(args, options) {
  try {
    await compose(args, { ...options, reflectFailureOutput: false });
    return 0;
  } catch (error) {
    // runCommand's message for an exit code; a deadline, a signal or an interruption is rethrown.
    const code = /^Docker [a-z-]+ failed \(exit ([0-9]+)\)\.$/u.exec(error instanceof Error ? error.message : '')?.[1];
    if (code === undefined) throw error;
    return Number(code);
  }
}

async function assertNoSecretLeak() {
  const { stdout: ids } = await compose(['ps', '--all', '--quiet']);
  const { stdout: inspect } = await runDocker(['inspect', ...ids.split('\n').filter((id) => id !== '')]);
  assertNoSmokeSecret(inspect, 'A secret value appears in docker inspect.');
  assertNoSmokeSecret(await composeLogs(), 'A secret value appears in the container logs.');
}

async function assertVaultAutoUnseal() {
  await compose(['restart', 'vault']);
  await compose(['up', '--detach', '--wait', '--wait-timeout', '60', 'vault']);
  const { stdout } = await compose(['exec', '-T', 'vault', 'vault', 'status', '-format=json']);
  assertEqual(String(parseJson(stdout, 'vault status did not answer JSON.').sealed), 'false',
    'Vault did not unseal itself after a restart.');
}

async function assertBackFailsClosed() {
  const occurrences = async (pattern) => ((await composeLogs('back')).match(pattern) ?? []).length;
  const distributions = () => occurrences(/"event":"secrets\.distributed"/gu);
  const failedPulls = () => occurrences(/vault-pull: Vault unavailable/gu);
  const before = await distributions();
  // The first start distributed: a changed log line must not turn the guard below into 0 === 0.
  if (before < 1) throw new Error('The back log shows no distribution of its first start.');
  const failedBefore = await failedPulls();
  await compose(['stop', 'vault']);
  await compose(['restart', 'back']);
  // About 14 s with the 5 s pull timeout. A second refused boot proves that the first one exited,
  // with everything it did already logged.
  for (let attempt = 1; ; attempt += 1) {
    if (await failedPulls() >= failedBefore + 2) break;
    if (attempt >= 45) throw new Error('The back did not refuse to start twice without Vault.');
    await delay(1_000);
  }
  assertEqual(String(await distributions()), String(before), 'The back distributed secrets without Vault.');
}

async function fetchBounded(path, { authenticated = true, headers = {}, ...options } = {}) {
  const response = await requestWithDeadline(`${publicBaseUrl()}${path}`, {
    ...options,
    headers: authenticated ? { authorization: basicAuthorization, ...headers } : headers,
  });
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
  } catch (error) {
    annotateSmokeFailure(error, { operation: 'HTTP_HEADERS' });
    throw error;
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
  } catch (error) {
    annotateSmokeFailure(error, { operation: 'HTTP_BODY' });
    throw error;
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

/** Fails without showing it when the text holds a smoke secret other than `allowed`. */
function assertNoSmokeSecret(text, message, allowed) {
  if (smokeSecrets.some((secret) => secret !== allowed && text.includes(secret))) throw new Error(message);
}

/** Both streams of `compose logs`: no line may hide from a check on its stderr. */
async function composeLogs(...services) {
  const { stdout, stderr } = await compose(['logs', '--no-color', ...services]);
  return `${stdout}\n${stderr}`;
}

function safeName(error) {
  return error instanceof Error && /^[A-Za-z0-9_.-]{1,128}$/u.test(error.name) ? error.name : 'UnknownError';
}

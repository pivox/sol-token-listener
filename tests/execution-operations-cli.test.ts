import { generateKeyPairSync, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
} from '../src/domain/execution-safety-qualification.js';
import {
  ExecutionOperationsCliError,
  runExecutionOperationsCommand,
} from '../src/executor-operations/main.js';
import type { ExecutionOperationsService } from '../src/executor-operations/service.js';

void test('status emits one bounded versioned redacted JSON document', async () => {
  const output = await runExecutionOperationsCommand(['status'], environment(), {
    service: serviceStub({
      status: async (generationId) => ({
        payloadVersion: 1, generationId, controlState: 'ENTRY_STOP', controlRevision: 2n,
        latestQualificationId: null, latestQualificationExpiresAtMs: null,
        activeArmamentId: null, activeArmamentPhase: null, activeArmamentExpiresAtMs: null,
      }),
    }),
    terminal: { isTTY: false, write() {}, readLine: async () => '' },
    readTextFile: async () => { throw new Error('not used'); },
    now: () => 1_000,
  });
  assert.deepEqual(JSON.parse(output), {
    payloadVersion: 1,
    command: 'status',
    controlState: 'ENTRY_STOP',
    controlRevision: '2',
    latestQualificationId: null,
    latestQualificationExpiresAtMs: null,
    activeArmamentId: null,
    activeArmamentPhase: null,
    activeArmamentExpiresAtMs: null,
    paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
    liveCapabilityPresent: false,
  });
  assert.equal(output.includes('postgresql://'), false);
});

void test('rejects unknown commands and malformed mutation arguments with a fixed error', async () => {
  const dependencies = {
    service: serviceStub({}),
    terminal: { isTTY: false, write() {}, readLine: async () => '' },
    readTextFile: async () => '',
    now: () => 1_000,
  };
  for (const argv of [
    [], ['unknown'], ['kill-switch'], ['kill-switch', '--mode=invalid'],
    ['arm', '--maximum-lamports=1.5'],
  ]) await assert.rejects(
    runExecutionOperationsCommand(argv, environment(), dependencies),
    (error) => error instanceof ExecutionOperationsCliError
      && error.code === 'INVALID_EXECUTION_OPERATIONS_COMMAND'
      && error.message === 'Execution operations command failed.',
  );
});

void test('preflight accepts only a trusted signed qualification bound to runtime config', async () => {
  const nowMs = 1_788_134_400_000;
  const keyPair = generateKeyPairSync('ed25519');
  const publicKeyBase64 = keyPair.publicKey.export({ format: 'der', type: 'spki' })
    .toString('base64');
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST',
    'SIMULATION_ARTIFACT', 'FAULT_TEST', 'RECONCILIATION_STATE',
    'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST', 'WALLET_SNAPSHOT',
    'MAINNET_SIMULATION_ARTIFACT',
  ] as const;
  const qualificationInput = {
    payloadVersion: 1 as const, evaluatorVersion: 1 as const, phase: 'CANARY' as const,
    buildHash: 'b'.repeat(64), configurationFingerprint: 'c'.repeat(64),
    strategyFingerprint: 'd'.repeat(64),
    generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    walletPublicKey: '11111111111111111111111111111111',
    cluster: 'mainnet-beta' as const, genesisHash: '11111111111111111111111111111111',
    providerId: 'primary', qualifiedAtMs: nowMs, expiresAtMs: nowMs + 300_000,
    gates: EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => ({
      payloadVersion: 1 as const, gateId, status: 'PASSED' as const,
      evidenceType: evidenceTypes[index], evidenceId: `evidence:${index}`,
      evidenceFingerprint: index.toString(16).repeat(64),
      observedAtMs: nowMs - 1_000 + index, expiresAtMs: nowMs + 300_000,
    })),
  };
  const qualification = createSafetyQualification(qualificationInput);
  const payload = Buffer.from(JSON.stringify(qualificationInput), 'utf8');
  const signedEnvelope = JSON.stringify({
    payloadVersion: 1, algorithm: 'Ed25519',
    signedPayloadBase64: payload.toString('base64'),
    signatureBase64: sign(null, payload, keyPair.privateKey).toString('base64'),
  });
  let persisted = false;
  const dependencies = {
    service: serviceStub({
      preflight: async (value) => { persisted = true; assert.deepEqual(value, qualification); return value; },
    }),
    terminal: { isTTY: false, write() {}, readLine: async () => '' },
    readTextFile: async () => signedEnvelope,
    now: () => nowMs + 1,
  };
  const output = await runExecutionOperationsCommand(
    ['preflight'],
    environment({ EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: publicKeyBase64 }),
    dependencies,
  );
  assert.equal(JSON.parse(output).qualificationId, qualification.qualificationId);
  assert.equal(persisted, true);
  await assert.rejects(runExecutionOperationsCommand(
    ['preflight'],
    environment({ EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: publicKeyBase64 }),
    { ...dependencies, readTextFile: async () => JSON.stringify(qualificationInput.gates) },
  ), (error) => error instanceof ExecutionOperationsCliError);
});

function serviceStub(overrides: Partial<ExecutionOperationsService>): ExecutionOperationsService {
  const unavailable = async (): Promise<never> => { throw new Error('unexpected service call'); };
  return {
    preflight: unavailable,
    status: unavailable,
    stop: unavailable,
    arm: unavailable,
    resume: unavailable,
    ...overrides,
  };
}

function environment(overrides: Readonly<Record<string, string>> = {}) {
  return {
    DATABASE_URL: 'postgresql://localhost/solanabot',
    EXECUTOR_WALLET_GENERATION_ID: `execution_wallet_generation_${'a'.repeat(64)}`,
    EXECUTOR_PUBLIC_KEY: '11111111111111111111111111111111',
    SOLANA_EXPECTED_GENESIS_HASH: '11111111111111111111111111111111',
    EXECUTOR_RPC_PROVIDER_ID: 'primary', EXECUTOR_BUILD_HASH: 'b'.repeat(64),
    EXECUTOR_CONFIGURATION_FINGERPRINT: 'c'.repeat(64),
    EXECUTOR_STRATEGY_FINGERPRINT: 'd'.repeat(64), EXECUTOR_ACTIVATION_PHASE: 'CANARY',
    EXECUTOR_OPERATOR_ID: 'operator-primary',
    EXECUTOR_PREFLIGHT_EVIDENCE_PATH: '/tmp/preflight-evidence.json',
    EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: 'MCowBQYDK2VwAyEA7Q2ZB8C8QzL4vVfJdGz4g0yP5wVqgYvZx4h7gM9rGgM=',
    LIVE_TRADING_ENABLED: 'false',
    ...overrides,
  };
}

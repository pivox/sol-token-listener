import { generateKeyPairSync, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
} from '../src/domain/execution-safety-qualification.js';
import { canaryEvidenceInput } from './helpers/execution-canary-fixture.js';
import { canonicalStringifyJson } from '../src/utils/json.js';
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

void test('live:arm requires an exact target command, a signed sidecar, and emits only redacted non-live status', async () => {
  const keyPair = generateKeyPairSync('ed25519');
  const publicKeyBase64 = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const intentId = `execution_intent_${'e'.repeat(64)}`;
  const sidecarInput = canaryEvidenceInput({
    targetIntentId: intentId,
    walletSnapshot: { generationId: `execution_wallet_generation_${'a'.repeat(64)}` },
    qualification: { buildHash: 'b'.repeat(64), configurationFingerprint: 'c'.repeat(64),
      strategyFingerprint: 'd'.repeat(64) },
    policy: { walletSnapshotMaxAgeMs: 300_000 },
  });
  const payload = Buffer.from(canonicalStringifyJson(sidecarInput), 'utf8');
  const envelope = JSON.stringify({ payloadVersion: 1, algorithm: 'Ed25519',
    signedPayloadBase64: payload.toString('base64'),
    signatureBase64: sign(null, payload, keyPair.privateKey).toString('base64') });
  let receivedArm = false;
  const output = await runExecutionOperationsCommand([
    'arm', `--intent-id=${intentId}`, '--maximum-lamports=500000', '--holding-ms=300000',
    '--reason=Mainnet canary manually approved.',
  ], environment({ EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: publicKeyBase64 }), {
    service: serviceStub({
      arm: async (command) => {
        assert.equal(command.payloadVersion, 2);
        if (command.payloadVersion === 2) {
          assert.equal(command.intentId, intentId);
          assert.equal(command.maximumCapitalLamports, 500_000n);
          assert.equal(command.runtimeLeaseMs, 120_000);
        }
        receivedArm = true;
        return Object.freeze({ payloadVersion: 2, armamentId: `execution_activation_armament_${'a'.repeat(64)}`,
          armamentFingerprint: 'a'.repeat(64), state: 'ARMED', armamentExpiresAtMs: 1_788_134_700_000,
          admissionReportId: `execution_risk_admission_${'b'.repeat(64)}`,
          reservationId: `execution_exposure_reservation_${'c'.repeat(64)}` }) as never;
      },
    }),
    terminal: { isTTY: true, write() {}, readLine: async () => 'not used by stub' },
    readTextFile: async () => envelope,
    now: () => 1_788_134_400_001,
  });
  const result = JSON.parse(output) as Record<string, unknown>;
  assert.equal(receivedArm, true);
  assert.equal(result.payloadVersion, 2);
  assert.equal(result.canaryStatus, 'CANARY_NOT_STARTED');
  assert.equal(result.liveCapabilityPresent, false);
  assert.equal(output.includes('postgresql://'), false);

  const paddedEnvelope = `${envelope}${' '.repeat(140_000 - Buffer.byteLength(envelope, 'utf8'))}`;
  let paddedReachedService = false;
  await runExecutionOperationsCommand([
    'arm', `--intent-id=${intentId}`, '--maximum-lamports=500000', '--holding-ms=300000', '--reason=x',
  ], environment({ EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: publicKeyBase64 }), {
    service: serviceStub({ arm: async () => {
      paddedReachedService = true;
      return Object.freeze({ payloadVersion: 2, armamentId: `execution_activation_armament_${'a'.repeat(64)}`,
        armamentFingerprint: 'a'.repeat(64), state: 'ARMED', armamentExpiresAtMs: 1_788_134_700_000,
        admissionReportId: `execution_risk_admission_${'b'.repeat(64)}`,
        reservationId: `execution_exposure_reservation_${'c'.repeat(64)}` }) as never;
    } }),
    terminal: { isTTY: true, write() {}, readLine: async () => '' },
    readTextFile: async () => paddedEnvelope, now: () => 1_788_134_400_001,
  });
  assert.equal(Buffer.byteLength(paddedEnvelope, 'utf8'), 140_000);
  assert.equal(paddedReachedService, true);

  for (const argv of [
    ['arm', `--intent-id=${intentId}`, '--maximum-lamports=500000', '--holding-ms=300000'],
    ['arm', `--intent-id=${intentId}`, '--maximum-lamports=500000', '--holding-ms=300000', '--reason=x', '--yes=true'],
    ['arm', `--intent-id=${intentId}`, '--maximum-lamports=500000', '--reason=x'],
  ]) await assert.rejects(runExecutionOperationsCommand(argv, environment({
    EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: publicKeyBase64,
  }), {
    service: serviceStub({}), terminal: { isTTY: false, write() {}, readLine: async () => '' },
    readTextFile: async () => envelope, now: () => 1_788_134_400_001,
  }), (error) => error instanceof ExecutionOperationsCliError);

  let oversizedReachedService = false;
  await assert.rejects(runExecutionOperationsCommand([
    'arm', `--intent-id=${intentId}`, '--maximum-lamports=500000', '--holding-ms=300000', '--reason=x',
  ], environment({ EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: publicKeyBase64 }), {
    service: serviceStub({ arm: async () => { oversizedReachedService = true; throw new Error('unexpected'); } }),
    terminal: { isTTY: false, write() {}, readLine: async () => '' },
    readTextFile: async () => 'x'.repeat(196_609), now: () => 1_788_134_400_001,
  }), ExecutionOperationsCliError);
  assert.equal(oversizedReachedService, false);

  for (const bad of [
    { argvIntentId: `execution_intent_${'f'.repeat(64)}`, publicKey: publicKeyBase64 },
    { argvIntentId: intentId, publicKey: generateKeyPairSync('ed25519').publicKey
      .export({ format: 'der', type: 'spki' }).toString('base64') },
  ]) await assert.rejects(runExecutionOperationsCommand([
    'arm', `--intent-id=${bad.argvIntentId}`, '--maximum-lamports=500000', '--holding-ms=300000', '--reason=x',
  ], environment({ EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: bad.publicKey }), {
    service: serviceStub({ arm: async () => { throw new Error('must not arm'); } }),
    terminal: { isTTY: false, write() {}, readLine: async () => '' },
    readTextFile: async () => envelope, now: () => 1_788_134_400_001,
  }), ExecutionOperationsCliError);
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
    EXECUTOR_CANARY_EVIDENCE_PATH: '/tmp/canary-evidence.json',
    EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: 'MCowBQYDK2VwAyEA7Q2ZB8C8QzL4vVfJdGz4g0yP5wVqgYvZx4h7gM9rGgM=',
    EXECUTOR_LEASE_MS: '120000', EXECUTOR_QUOTE_MAX_AGE_MS: '3000',
    EXECUTOR_SLIPPAGE_BPS: '500', EXECUTOR_SNAPSHOT_MAX_SLOT_LAG: '8',
    EXECUTOR_MAX_COMPUTE_UNITS: '300000', EXECUTOR_MAX_FEE_LAMPORTS: '100000',
    EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT: '2500000', EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '12',
    LIVE_TRADING_ENABLED: 'false',
    ...overrides,
  };
}

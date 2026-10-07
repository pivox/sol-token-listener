import { generateKeyPairSync, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
} from '../src/domain/execution-safety-qualification.js';
import {
  canaryEvidenceInput,
  envelopeCanaryEvidenceInput,
  NOW_MS,
  WSOL_MINT,
} from './helpers/execution-canary-fixture.js';
import { canonicalStringifyJson, parseJson } from '../src/utils/json.js';
import {
  ExecutionOperationsCliError,
  runExecutionOperationsCommand,
} from '../src/executor-operations/main.js';
import {
  createExecutionOperationsService,
  type ExecutionOperationsService,
} from '../src/executor-operations/service.js';
import type {
  ExecutionEntryEnvelopeRepository,
  ExecutionOperationsRepository,
} from '../src/ports/execution-operations-repository.js';
import { createEntryEnvelope } from '../src/domain/execution-entry-envelope.js';
import { createExecutionRiskPolicy } from '../src/domain/execution-risk-policy.js';
import { preflightDraftInputs } from './helpers/execution-preflight-draft-fixture.js';

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
  const preflightSource = preflightDraftInputs().source;
  const sourceJson = canonicalStringifyJson(preflightSource);
  const intentId = preflightSource.target.intent.id;
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
        assert.equal(command.payloadVersion, 3);
        if (command.payloadVersion === 3) {
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
    readTextFile: async (path) => path.endsWith('preflight-source.json') ? sourceJson : envelope,
    now: () => 1_788_134_400_001,
  });
  const result = JSON.parse(output) as Record<string, unknown>;
  assert.equal(receivedArm, true);
  assert.equal(result.payloadVersion, 3);
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
    readTextFile: async (path) => path.endsWith('preflight-source.json') ? sourceJson : paddedEnvelope,
    now: () => 1_788_134_400_001,
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
    readTextFile: async (path) => path.endsWith('preflight-source.json') ? sourceJson : envelope,
    now: () => 1_788_134_400_001,
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
    readTextFile: async (path) => path.endsWith('preflight-source.json') ? sourceJson : envelope,
    now: () => 1_788_134_400_001,
  }), ExecutionOperationsCliError);
});

const ENVELOPE_ID = `execution_entry_envelope_${'e'.repeat(64)}`;
const ENVELOPE_CREATE_ARGV = Object.freeze([
  'envelope', 'create', '--per-buy-lamports=10000000', '--max-buys=5',
  '--max-exposure-lamports=50000000', '--max-loss-lamports=30000000', '--holding-ms=120000',
]);

function envelopeEnvironment(publicKeyBase64: string, overrides: Readonly<Record<string, string>> = {}) {
  return environment({
    EXECUTOR_WALLET_GENERATION_ID: `execution_wallet_generation_${'d'.repeat(64)}`,
    EXECUTOR_BUILD_HASH: 'a'.repeat(64), EXECUTOR_CONFIGURATION_FINGERPRINT: 'b'.repeat(64),
    EXECUTOR_STRATEGY_FINGERPRINT: 'c'.repeat(64),
    EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH: '/tmp/gate-catalog.json',
    EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: publicKeyBase64,
    ...overrides,
  });
}

function envelopeCatalogJson(policyOverrides: Readonly<Record<string, unknown>> = {}): string {
  const qualification = envelopeCanaryEvidenceInput().qualification;
  const policy = createExecutionRiskPolicy({
    quoteMintAllowlist: [WSOL_MINT], initialCapitalLamports: 230_000_000n,
    maximumCapitalLamports: 230_000_000n, positionSizeBps: 1_000n, maximumOpenPositions: 1,
    maximumTotalExposureBps: 500n, drawdownPauseBps: 2_500n, feeReserveLamports: 20_000_000n,
    walletSnapshotMaxAgeMs: 300_000, providerUsageMaxAgeMs: 300_000, providerEntryCostUnits: 8n,
    providerExitCostUnitsPerPosition: 4n, providerConfirmationCostUnitsPerPosition: 2n,
    providerReconciliationCostUnitsPerPosition: 3n, providerSafetyMarginUnits: 5n,
    maximumConsecutiveTechnicalFailures: 2, ...policyOverrides,
  });
  return canonicalStringifyJson({
    schemaVersion: 'execution-preflight-gate-catalog.v1',
    strategyFingerprint: qualification.strategyFingerprint,
    policy: Object.fromEntries(Object.entries(policy).filter(
      ([key]) => key !== 'payloadVersion' && key !== 'policyFingerprint')),
    gates: [0, 1, 2, 3, 4, 5, 6, 8].map((index) => qualification.gates[index]),
  });
}

function signedQualification(
  qualification: object,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): string {
  const payload = Buffer.from(canonicalStringifyJson(Object.fromEntries(Object.entries(qualification)
    .filter(([key]) => key !== 'qualificationId' && key !== 'qualificationFingerprint'))), 'utf8');
  return JSON.stringify({ payloadVersion: 1, algorithm: 'Ed25519',
    signedPayloadBase64: payload.toString('base64'),
    signatureBase64: sign(null, payload, privateKey).toString('base64') });
}

function envelopeCliHarness(
  terminal: { readonly isTTY: boolean; readonly readLine?: () => Promise<string> },
  options: Readonly<{ catalogJson?: string; qualificationV1?: boolean }> = {},
) {
  const keyPair = generateKeyPairSync('ed25519');
  const publicKeyBase64 = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const fixture = envelopeCanaryEvidenceInput();
  const evidence = signedQualification(options.qualificationV1 === true
    ? canaryEvidenceInput().qualification : fixture.qualification, keyPair.privateKey);
  const calls: string[] = [];
  const writes: string[] = [];
  const databaseNowMs = NOW_MS + 1_000;
  let createdEnvelope: Parameters<ExecutionEntryEnvelopeRepository['createEnvelope']>[0] | null = null;
  const repository = {
    recordAuthorization: async () => { calls.push('authorization'); return 'RECORDED' as const; },
  } as unknown as ExecutionOperationsRepository;
  const envelopeRepository = {
    expireEnvelopes: async () => {
      calls.push('now');
      return Object.freeze({ payloadVersion: 1 as const, expiredCount: 0, databaseNowMs });
    },
    createEnvelope: async (input: Parameters<ExecutionEntryEnvelopeRepository['createEnvelope']>[0]) => {
      calls.push('create'); createdEnvelope = input; return input.envelope;
    },
  } as unknown as ExecutionEntryEnvelopeRepository;
  const service = createExecutionOperationsService({
    repository, envelopeRepository, nonceSource: () => 'abcdef123456',
  });
  const run = (argv: readonly string[] = ENVELOPE_CREATE_ARGV) => runExecutionOperationsCommand(
    argv, envelopeEnvironment(publicKeyBase64), {
      service,
      terminal: { isTTY: terminal.isTTY, write: (value) => { writes.push(value); },
        readLine: terminal.readLine
          ?? (async () => writes.join('').trim().split('\n').at(-1) ?? '') },
      readTextFile: async (path) => path === '/tmp/gate-catalog.json'
        ? options.catalogJson ?? envelopeCatalogJson() : evidence,
      now: () => NOW_MS + 2_000,
    },
  );
  return { run, calls, writes, databaseNowMs, qualification: fixture.qualification,
    created: () => createdEnvelope };
}

void test('envelope create confirms at the TTY and emits the bounded envelope summary', async () => {
  const harness = envelopeCliHarness({ isTTY: true });
  const output = await harness.run();
  const created = harness.created();
  assert.notEqual(created, null);
  const envelope = created?.envelope;
  assert.deepEqual(harness.calls, ['now', 'authorization', 'create']);
  assert.equal(envelope?.validFromMs, harness.databaseNowMs);
  assert.equal(envelope?.perBuyQuoteAmountRaw, 10_000_000n);
  assert.equal(envelope?.maxTotalExposureRaw, 50_000_000n);
  assert.equal(envelope?.maxRealizedLossRaw, 30_000_000n);
  assert.equal(envelope?.maximumHoldingMs, 120_000);
  assert.equal(envelope?.operatorId, 'operator-primary');
  assert.equal(created?.qualification.qualificationId, harness.qualification.qualificationId);
  assert.equal(created?.authorization.action, 'ENVELOPE');
  assert.deepEqual(JSON.parse(output), {
    payloadVersion: 1, command: 'envelope-create', envelopeId: envelope?.envelopeId,
    validUntilMs: harness.qualification.expiresAtMs, perBuyQuoteAmountRaw: '10000000',
    maxBuys: 5, qualificationId: harness.qualification.qualificationId,
    liveCapabilityPresent: false,
  });
  assert.match(harness.writes.join(''), /^ENVELOPE_DETAILS V1 envelopeId=/u);
});

void test('envelope create refuses without a TTY, on a phrase mismatch and with bad options', async () => {
  for (const terminal of [
    { isTTY: false },
    { isTTY: true, readLine: async () => 'CONFIRM ENVELOPE wrong' },
  ]) {
    const harness = envelopeCliHarness(terminal);
    await assert.rejects(harness.run(), ExecutionOperationsCliError);
    assert.deepEqual(harness.calls, ['now']);
  }
  for (const argv of [
    [...ENVELOPE_CREATE_ARGV, '--yes=true'],
    ENVELOPE_CREATE_ARGV.slice(0, -1),
    ENVELOPE_CREATE_ARGV.map((value) => value === '--max-buys=5' ? '--max-buys=05' : value),
    ENVELOPE_CREATE_ARGV.map((value) => value === '--holding-ms=120000' ? '--holding-ms=900001' : value),
    ['envelope'], ['envelope', 'unknown'], ['envelope', 'show', '--x=1'],
  ]) {
    const harness = envelopeCliHarness({ isTTY: true });
    await assert.rejects(harness.run(argv), ExecutionOperationsCliError);
    assert.deepEqual(harness.calls, []);
  }
});

void test('envelope create refuses a v1 qualification file and a foreign catalog strategy', async () => {
  const v1 = envelopeCliHarness({ isTTY: true }, { qualificationV1: true });
  await assert.rejects(v1.run(), ExecutionOperationsCliError);
  assert.deepEqual(v1.calls, []);
  const catalog = parseJson(envelopeCatalogJson()) as Record<string, unknown>;
  const foreign = envelopeCliHarness({ isTTY: true }, {
    catalogJson: canonicalStringifyJson({ ...catalog, strategyFingerprint: 'f'.repeat(64) }),
  });
  await assert.rejects(foreign.run(), ExecutionOperationsCliError);
  assert.deepEqual(foreign.calls, []);
});

void test('envelope create surfaces a policy that cannot carry the envelope (A17)', async () => {
  const harness = envelopeCliHarness({ isTTY: true }, {
    catalogJson: envelopeCatalogJson({
      initialCapitalLamports: 150_000_000n, maximumCapitalLamports: 150_000_000n,
    }),
  });
  await assert.rejects(harness.run(), (error) => error instanceof ExecutionOperationsCliError
    && error.reason === 'ENVELOPE_LIMITS_REJECTED'
    && error.code === 'INVALID_EXECUTION_OPERATIONS_COMMAND');
  assert.deepEqual(harness.calls, ['now']);
  assert.deepEqual(harness.writes, []);
});

void test('envelope prepare prints a canonical ENVELOPE draft anchored on the DB now', async () => {
  const keyPair = generateKeyPairSync('ed25519');
  const publicKeyBase64 = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const generationId = `execution_wallet_generation_${'d'.repeat(64)}`;
  let query: unknown = null;
  const facts = Object.freeze({
    payloadVersion: 1 as const, databaseNowMs: NOW_MS,
    generation: Object.freeze({ generationId, walletPublicKey: '11111111111111111111111111111111',
      genesisHash: '11111111111111111111111111111111' }),
    simulation: Object.freeze({ artifactId: `execution_simulation_artifact_${'e'.repeat(64)}`,
      resultFingerprint: 'f'.repeat(64), recordedAtMs: NOW_MS - 5_000,
      buildFingerprint: 'a'.repeat(64), configurationFingerprint: 'b'.repeat(64) }),
  });
  const dependencies = (result: typeof facts | null) => ({
    service: serviceStub({ prepareEnvelopeFacts: async (id, value) => {
      assert.equal(id, generationId); query = value; return result;
    } }),
    terminal: { isTTY: false, write() {}, readLine: async () => '' },
    readTextFile: async (path: string) => {
      assert.equal(path, '/tmp/gate-catalog.json'); return envelopeCatalogJson();
    },
    now: () => NOW_MS + 9_999_999,
  });
  const output = await runExecutionOperationsCommand(['envelope', 'prepare', '--valid-ms=3600000'],
    envelopeEnvironment(publicKeyBase64), dependencies(facts));
  assert.deepEqual(query, { buildHash: 'a'.repeat(64), configurationFingerprint: 'b'.repeat(64),
    walletPublicKey: '11111111111111111111111111111111', providerId: 'primary',
    genesisHash: '11111111111111111111111111111111' });
  assert.equal(canonicalStringifyJson(parseJson(output)), output);
  const draft = JSON.parse(output) as { schemaVersion: string; qualification: unknown };
  assert.equal(draft.schemaVersion, 'execution-envelope-qualification-draft.v1');
  const qualification = createSafetyQualification(draft.qualification);
  assert.equal(qualification.payloadVersion, 2);
  assert.equal(qualification.qualifiedAtMs, NOW_MS);
  assert.equal(qualification.expiresAtMs, NOW_MS + 3_600_000);
  for (const argv of [
    ['envelope', 'prepare'], ['envelope', 'prepare', '--valid-ms=3599999'],
    ['envelope', 'prepare', '--valid-ms=86400001'], ['envelope', 'prepare', '--valid-ms=3600000', '--x=1'],
  ]) await assert.rejects(runExecutionOperationsCommand(argv, envelopeEnvironment(publicKeyBase64),
    dependencies(facts)), ExecutionOperationsCliError);
  await assert.rejects(runExecutionOperationsCommand(['envelope', 'prepare', '--valid-ms=3600000'],
    envelopeEnvironment(publicKeyBase64), dependencies(null)),
  (error) => error instanceof ExecutionOperationsCliError
    && error.reason === 'ENVELOPE_FACTS_UNAVAILABLE');
});

void test('envelope revoke needs no TTY and envelope show lists the envelopes', async () => {
  let revoked: unknown = null;
  const dependencies = {
    service: serviceStub({
      revokeEnvelope: async (command) => {
        revoked = command;
        return Object.freeze({ payloadVersion: 1 as const, envelopeId: command.envelopeId,
          state: 'REVOKED' as const, replayed: false, armamentRevoked: true,
          databaseNowMs: NOW_MS + 5 });
      },
      readEnvelopes: async () => Object.freeze([Object.freeze({
        envelopeId: ENVELOPE_ID, payloadVersion: 2, fingerprint: 'e'.repeat(64),
        generationId: `execution_wallet_generation_${'a'.repeat(64)}`, operatorId: 'operator-primary',
        perBuyQuoteAmountRaw: 10_000_000n, maxBuys: 5, maxOpenPositions: 1,
        maxTotalExposureRaw: 50_000_000n, maxRealizedLossRaw: 30_000_000n,
        validFromMs: NOW_MS, validUntilMs: NOW_MS + 3_600_000, state: 'ACTIVE' as const,
        buysArmed: 1, realizedLossRaw: 0n, revokedAtMs: null, createdAtMs: NOW_MS,
        updatedAtMs: NOW_MS, authorizationId: null, policyFingerprint: 'f'.repeat(64),
        maximumHoldingMs: 120_000, qualificationId: null,
      })]),
    }),
    terminal: { isTTY: false, write() {}, readLine: async () => '' },
    readTextFile: async () => { throw new Error('not used'); },
    now: () => NOW_MS,
  };
  const revokeOutput = await runExecutionOperationsCommand(
    ['envelope', 'revoke', `--envelope-id=${ENVELOPE_ID}`], environment(), dependencies);
  assert.deepEqual(revoked, { generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    envelopeId: ENVELOPE_ID, operatorId: 'operator-primary', occurredAtMs: NOW_MS });
  assert.deepEqual(JSON.parse(revokeOutput), { payloadVersion: 1, command: 'envelope-revoke',
    envelopeId: ENVELOPE_ID, state: 'REVOKED', replayed: false, armamentRevoked: true,
    databaseNowMs: NOW_MS + 5, liveCapabilityPresent: false });
  for (const argv of [['envelope', 'revoke'], ['envelope', 'revoke', '--envelope-id=bad']]) {
    await assert.rejects(runExecutionOperationsCommand(argv, environment(), dependencies),
      ExecutionOperationsCliError);
  }
  const shown = JSON.parse(await runExecutionOperationsCommand(['envelope', 'show'], environment(),
    dependencies)) as { command: string; envelopes: Record<string, unknown>[] };
  assert.equal(shown.command, 'envelope-show');
  assert.equal(shown.envelopes[0]?.perBuyQuoteAmountRaw, '10000000');
  assert.equal(shown.envelopes[0]?.realizedLossRaw, '0');
  assert.equal(shown.envelopes[0]?.buysArmed, 1);
});

void test('preflight refuses a signed v2 ENVELOPE qualification before the repository', async () => {
  const keyPair = generateKeyPairSync('ed25519');
  const publicKeyBase64 = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  let called = false;
  await assert.rejects(runExecutionOperationsCommand(['preflight'], envelopeEnvironment(publicKeyBase64), {
    service: serviceStub({ preflight: async (value) => { called = true; return value; } }),
    terminal: { isTTY: false, write() {}, readLine: async () => '' },
    readTextFile: async () => signedQualification(envelopeCanaryEvidenceInput().qualification,
      keyPair.privateKey),
    now: () => NOW_MS + 1_000,
  }), ExecutionOperationsCliError);
  assert.equal(called, false);
});

void test('the envelope fixture policy admits the CLI create limits', () => {
  const qualification = envelopeCanaryEvidenceInput().qualification;
  const catalog = parseJson(envelopeCatalogJson()) as { policy: unknown };
  assert.doesNotThrow(() => createEntryEnvelope({ payloadVersion: 2, qualification,
    operatorId: 'operator-primary', perBuyQuoteAmountRaw: 10_000_000n, maxBuys: 5,
    maxTotalExposureRaw: 50_000_000n, maxRealizedLossRaw: 30_000_000n, maximumHoldingMs: 120_000,
    validFromMs: NOW_MS + 1_000, validUntilMs: qualification.expiresAtMs,
    policy: createExecutionRiskPolicy(catalog.policy) }));
});

function serviceStub(overrides: Partial<ExecutionOperationsService>): ExecutionOperationsService {
  const unavailable = async (): Promise<never> => { throw new Error('unexpected service call'); };
  return {
    preflight: unavailable,
    status: unavailable,
    stop: unavailable,
    arm: unavailable,
    resume: unavailable,
    prepareEnvelopeFacts: unavailable,
    createEnvelope: unavailable,
    revokeEnvelope: unavailable,
    readEnvelopes: unavailable,
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
    EXECUTOR_PREFLIGHT_SOURCE_PATH: '/tmp/preflight-source.json',
    EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: 'MCowBQYDK2VwAyEA7Q2ZB8C8QzL4vVfJdGz4g0yP5wVqgYvZx4h7gM9rGgM=',
    EXECUTOR_LEASE_MS: '120000', EXECUTOR_QUOTE_MAX_AGE_MS: '3000',
    EXECUTOR_SLIPPAGE_BPS: '500', EXECUTOR_SNAPSHOT_MAX_SLOT_LAG: '8',
    EXECUTOR_MAX_COMPUTE_UNITS: '300000', EXECUTOR_MAX_FEE_LAMPORTS: '100000',
    EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT: '2500000', EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '12',
    LIVE_TRADING_ENABLED: 'false',
    ...overrides,
  };
}

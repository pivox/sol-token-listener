import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionCanaryEvidence,
} from '../src/domain/execution-canary.js';
import {
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
} from '../src/domain/execution-safety-qualification.js';
import {
  createExecutionOperationsService,
  ExecutionEnvelopeCommandError,
} from '../src/executor-operations/service.js';
import { createExecutionRiskPolicy } from '../src/domain/execution-risk-policy.js';
import type { ExecutionOperatorAuthorizationV1 } from '../src/domain/execution-operations.js';
import type {
  ExecutionEntryEnvelopeRepository,
  ExecutionEnvelopeCreationV1,

  ExecutionCanaryArmamentRepository,
  ExecutionCanaryTargetIntentV1,
  ExecutionOperationsRepository,
} from '../src/ports/execution-operations-repository.js';
import type { ExecutionActivationArmamentV2 } from '../src/domain/execution-operations.js';
import {
  canaryEvidenceInput,
  envelopeCanaryEvidenceInput,
  WSOL_MINT,
} from './helpers/execution-canary-fixture.js';
import { preflightDraftInputs } from './helpers/execution-preflight-draft-fixture.js';
import { createExecutionPreflightDraft } from '../src/domain/execution-preflight-draft.js';
import { createExecutionPreflightBundle } from '../src/domain/execution-preflight-bundle.js';

const NOW_MS = 1_788_134_400_000;

void test('V3 binds a canonical H2h V2 source before the terminal checkpoint and repository',
  async () => {
    const { source, catalog } = preflightDraftInputs();
    const bundle = createExecutionPreflightBundle(createExecutionPreflightDraft(source, catalog));
    const intent = source.target.intent;
    let captured: Parameters<ExecutionCanaryArmamentRepository['armCanary']>[0] | null = null;
    const service = createExecutionOperationsService({
      repository: repositoryStub({ readQualification: async () => bundle.qualification }),
      canaryRepository: {
        readTargetIntent: async () => Object.freeze({
          intentId: intent.id, side: 'BUY', status: 'PENDING', leaseOwner: null,
          leaseExpiresAtMs: null, stateRevision: intent.stateRevision,
          strategyId: intent.strategyId, strategyVersion: intent.strategyVersion,
          decisionFingerprint: intent.decisionFingerprint, mint: intent.mint,
          quoteMint: intent.quoteMint, quoteAmountRaw: intent.quoteAmountRaw ?? 0n,
          expiresAtMs: intent.expiresAtMs,
        }),
        armCanary: async (input) => {
          captured = input;
          return Object.freeze({ ...input.request, payloadVersion: 2,
            armamentId: `execution_activation_armament_${'a'.repeat(64)}`,
            armamentFingerprint: 'a'.repeat(64), state: 'ARMED',
            authorizationId: `execution_operator_authorization_${'b'.repeat(64)}`,
            authorizationFingerprint: 'b'.repeat(64),
            admissionReportId: `execution_risk_admission_${'c'.repeat(64)}`,
            reservationId: `execution_exposure_reservation_${'d'.repeat(64)}`,
          }) as ExecutionActivationArmamentV2;
        },
      },
      nonceSource: () => 'abcdef123456',
    });
    await service.arm({
      payloadVersion: 3, evidence: bundle.canary, preflightSource: source,
      intentId: intent.id, maximumCapitalLamports: intent.quoteAmountRaw ?? 0n,
      maximumHoldingMs: 300_000, runtimeQuoteMaxAgeMs: 3_000,
      runtimeSlippageBps: 500n, runtimeSnapshotMaxSlotLag: 8,
      runtimeMaxComputeUnits: 300_000n, runtimeMaxFeeLamports: 100_000n,
      runtimeMaxFeePayerLamportDebit: 2_500_000n, runtimeMaxRpcCallsPerAttempt: 12,
      runtimeLeaseMs: 3_000, operatorId: 'operator-primary',
      operatorReason: 'Paired Mainnet canary manually approved.', nowMs: source.capturedAtMs + 1,
      terminal: terminalForV2Confirmation(),
    });
    const persisted = captured as unknown as Parameters<
      ExecutionCanaryArmamentRepository['armCanary']
    >[0];
    assert.equal(persisted.request.payloadVersion, 3);
    if (persisted.request.payloadVersion === 3) {
      assert.equal(persisted.request.lineageProof.preparationRunId,
        source.lineage.preparationRunId);
      assert.equal(persisted.request.lineageProof.proofFingerprint, source.proofFingerprint);
    }
  });


void test('arms only an exact fresh CANARY target after V2 terminal authorization', async () => {
  const calls: string[] = [];
  const evidence = createExecutionCanaryEvidence(canaryEvidenceInput({
    policy: { walletSnapshotMaxAgeMs: 300_000 },
  }));
  const qualification = evidence.qualification;
  const target = Object.freeze({
    intentId: evidence.targetIntentId, side: 'BUY' as const, status: 'PENDING' as const,
    leaseOwner: null, leaseExpiresAtMs: null, stateRevision: 0n, strategyId: 'canary-test', strategyVersion: 1,
    decisionFingerprint: 'e'.repeat(64), mint: 'So11111111111111111111111111111111111111112',
    quoteMint: 'So11111111111111111111111111111111111111112', quoteAmountRaw: 500_000n,
    expiresAtMs: NOW_MS + 300_000,
  });
  const capture: { value: Parameters<ExecutionCanaryArmamentRepository['armCanary']>[0] | null } = {
    value: null,
  };
  const repository = repositoryStub({
    readQualification: async () => { calls.push('qualification'); return qualification; },
  });
  const canaryRepository: ExecutionCanaryArmamentRepository = {
    readTargetIntent: async () => { calls.push('target'); return target; },
    armCanary: async (input) => {
      calls.push('arm'); capture.value = input;
      return Object.freeze({ ...input.request, armamentId: `execution_activation_armament_${'a'.repeat(64)}`,
        armamentFingerprint: 'a'.repeat(64), state: 'ARMED', authorizationId: `execution_operator_authorization_${'b'.repeat(64)}`,
        authorizationFingerprint: 'b'.repeat(64), admissionReportId: `execution_risk_admission_${'c'.repeat(64)}`,
        reservationId: `execution_exposure_reservation_${'d'.repeat(64)}` }) as ExecutionActivationArmamentV2;
    },
  };
  const service = createExecutionOperationsService({
    repository,
    canaryRepository,
    nonceSource: () => 'abcdef123456',
  });
  const armament = await service.arm({
    payloadVersion: 2,
    evidence,
    intentId: evidence.targetIntentId,
    maximumCapitalLamports: 500_000n,
    maximumHoldingMs: 300_000,
    runtimeQuoteMaxAgeMs: 3_000,
    runtimeSlippageBps: 500n,
    runtimeSnapshotMaxSlotLag: 8,
    runtimeMaxComputeUnits: 300_000n,
    runtimeMaxFeeLamports: 100_000n,
    runtimeMaxFeePayerLamportDebit: 2_500_000n,
    runtimeMaxRpcCallsPerAttempt: 12,
    runtimeLeaseMs: 120_000,
    operatorId: 'operator-primary',
    operatorReason: 'Mainnet canary manually approved.',
    nowMs: NOW_MS + 1,
    terminal: terminalForV2Confirmation(calls),
  } as never);
  assert.deepEqual(calls, ['qualification', 'target', 'tty.write', 'tty.read', 'arm']);
  assert.equal(armament.payloadVersion, 2);
  assert.equal(armament.maximumBuys, 1);
  assert.equal(armament.maximumExposureBps, 500n);
  assert.equal(armament.maximumOpenPositions, 1);
  assert.equal(capture.value?.authorization.payloadVersion, 2);
  assert.equal(capture.value?.request.armamentExpiresAtMs, NOW_MS + 300_000);
});

void test('uses each real expiry source and enforces the two-lease boundary before TTY', async () => {
  const leaseMs = 120_000;
  const boundary = NOW_MS + 2 * leaseMs;
  const high = NOW_MS + 300_000;
  const cases: readonly Readonly<{ label: string; evidence: Readonly<Record<string, unknown>>; targetExpiresAtMs: number }>[] = [
    { label: 'qualification invariant', evidence: {}, targetExpiresAtMs: high },
    { label: 'intent', evidence: {}, targetExpiresAtMs: boundary },
    { label: 'sidecar', evidence: { expiresAtMs: boundary }, targetExpiresAtMs: high },
    { label: 'provider expiry', evidence: { providerSnapshot: { expiresAtMs: boundary }, expiresAtMs: boundary }, targetExpiresAtMs: high },
    { label: 'provider measured age', evidence: { providerSnapshot: { measuredAtMs: NOW_MS - 60_000 } }, targetExpiresAtMs: high },
    { label: 'wallet observed age', evidence: { walletSnapshot: { observedAtMs: NOW_MS - 60_000 } }, targetExpiresAtMs: high },
  ];
  for (const item of cases) {
    const evidence = createExecutionCanaryEvidence(canaryEvidenceInput({
      ...item.evidence, policy: { walletSnapshotMaxAgeMs: 300_000, providerUsageMaxAgeMs: 300_000 },
    }));
    const result = await armForExpiry(evidence, item.targetExpiresAtMs, leaseMs);
    assert.equal(result.armamentExpiresAtMs, item.label === 'qualification invariant' ? high : boundary, item.label);
  }
  const exactEvidence = createExecutionCanaryEvidence(canaryEvidenceInput({
    policy: { walletSnapshotMaxAgeMs: 300_000, providerUsageMaxAgeMs: 300_000 },
  }));
  const exact = await armForExpiry(exactEvidence, NOW_MS + 2 * leaseMs, leaseMs);
  assert.equal(exact.armamentExpiresAtMs, NOW_MS + 2 * leaseMs);
  const rejectedEvidence = createExecutionCanaryEvidence(canaryEvidenceInput({
    policy: { walletSnapshotMaxAgeMs: 300_000, providerUsageMaxAgeMs: 300_000 },
  }));
  const rejected = await armForExpiry(rejectedEvidence, NOW_MS + 2 * leaseMs - 1, leaseMs, true);
  assert.equal(rejected.armamentExpiresAtMs, null);
  assert.deepEqual(rejected.calls, ['qualification', 'target']);
});

void test('rejects future sidecar evidence sources before TTY or atomic arming', async () => {
  for (const [label, overrides] of [
    ['captured', { capturedAtMs: NOW_MS + 1 }],
    ['provider measured', { providerSnapshot: { measuredAtMs: NOW_MS + 1 } }],
    ['wallet observed', { walletSnapshot: { observedAtMs: NOW_MS + 1 } }],
  ] as const) {
    const calls: string[] = [];
    const evidence = createExecutionCanaryEvidence(canaryEvidenceInput({
      policy: { walletSnapshotMaxAgeMs: 300_000 }, ...overrides,
    }));
    const target = Object.freeze({ intentId: evidence.targetIntentId, side: 'BUY' as const,
      status: 'PENDING' as const, leaseOwner: null, leaseExpiresAtMs: null, stateRevision: 0n,
      strategyId: 'canary-test', strategyVersion: 1, decisionFingerprint: 'e'.repeat(64),
      mint: 'So11111111111111111111111111111111111111112',
      quoteMint: 'So11111111111111111111111111111111111111112', quoteAmountRaw: 500_000n,
      expiresAtMs: NOW_MS + 300_000 });
    const service = createExecutionOperationsService({
      repository: repositoryStub({ readQualification: async () => {
        calls.push('qualification'); return evidence.qualification;
      } }),
      canaryRepository: { readTargetIntent: async () => { calls.push('target'); return target; },
        armCanary: async () => { calls.push('arm'); throw new Error('unexpected arm'); } },
      nonceSource: () => 'abcdef123456',
    });
    await assert.rejects(service.arm(canaryCommand(evidence, {
      isTTY: true, write: () => { calls.push('tty.write'); }, readLine: async () => {
        calls.push('tty.read'); return '';
      },
    }) as never), /CANARY_ARMAMENT_INPUT_INVALID/u, label);
    assert.deepEqual(calls, ['qualification', 'target'], label);
  }
});

void test('does not atomically arm when the V2 TTY phrase is refused', async () => {
  const calls: string[] = [];
  const evidence = createExecutionCanaryEvidence(canaryEvidenceInput({ policy: { walletSnapshotMaxAgeMs: 300_000 } }));
  const target = Object.freeze({ intentId: evidence.targetIntentId, side: 'BUY' as const,
    status: 'PENDING' as const, leaseOwner: null, leaseExpiresAtMs: null, stateRevision: 0n,
    strategyId: 'canary-test', strategyVersion: 1, decisionFingerprint: 'e'.repeat(64),
    mint: 'So11111111111111111111111111111111111111112',
    quoteMint: 'So11111111111111111111111111111111111111112', quoteAmountRaw: 500_000n,
    expiresAtMs: NOW_MS + 300_000 });
  const service = createExecutionOperationsService({
    repository: repositoryStub({ readQualification: async () => { calls.push('qualification'); return evidence.qualification; } }),
    canaryRepository: { readTargetIntent: async () => { calls.push('target'); return target; },
      armCanary: async () => { calls.push('arm'); throw new Error('unexpected arm'); } },
    nonceSource: () => 'abcdef123456',
  });
  await assert.rejects(service.arm(canaryCommand(evidence, {
    isTTY: true, write: () => { calls.push('tty.write'); }, readLine: async () => {
      calls.push('tty.read'); return 'wrong';
    },
  }) as never));
  assert.deepEqual(calls, ['qualification', 'target', 'tty.write', 'tty.read']);
});

void test('rejects every divergent qualification or target state before TTY and arm', async () => {
  const evidence = createExecutionCanaryEvidence(canaryEvidenceInput({ policy: { walletSnapshotMaxAgeMs: 300_000 } }));
  const target: ExecutionCanaryTargetIntentV1 = Object.freeze({ intentId: evidence.targetIntentId,
    side: 'BUY', status: 'PENDING', leaseOwner: null, leaseExpiresAtMs: null, stateRevision: 0n,
    strategyId: 'canary-test', strategyVersion: 1, decisionFingerprint: 'e'.repeat(64),
    mint: 'So11111111111111111111111111111111111111112',
    quoteMint: 'So11111111111111111111111111111111111111112', quoteAmountRaw: 500_000n,
    expiresAtMs: NOW_MS + 300_000 });
  const cases: readonly Readonly<{ label: string; qualification: typeof evidence.qualification; intentId: string; target: ExecutionCanaryTargetIntentV1 }>[] = [
    { label: 'qualification id/fingerprint', qualification: fixtureQualification(), intentId: evidence.targetIntentId, target },
    { label: 'command intent', qualification: evidence.qualification, intentId: `execution_intent_${'f'.repeat(64)}`, target },
    { label: 'target intent', qualification: evidence.qualification, intentId: evidence.targetIntentId, target: { ...target, intentId: `execution_intent_${'f'.repeat(64)}` } },
    { label: 'sell', qualification: evidence.qualification, intentId: evidence.targetIntentId, target: { ...target, side: 'SELL' } },
    { label: 'non-pending', qualification: evidence.qualification, intentId: evidence.targetIntentId, target: { ...target, status: 'PROCESSING' } },
    { label: 'lease owner', qualification: evidence.qualification, intentId: evidence.targetIntentId, target: { ...target, leaseOwner: 'worker' } },
    { label: 'lease expiry', qualification: evidence.qualification, intentId: evidence.targetIntentId, target: { ...target, leaseExpiresAtMs: NOW_MS + 1 } },
    { label: 'expired', qualification: evidence.qualification, intentId: evidence.targetIntentId, target: { ...target, expiresAtMs: NOW_MS } },
  ];
  for (const item of cases) {
    const calls: string[] = [];
    const service = createExecutionOperationsService({
      repository: repositoryStub({ readQualification: async () => { calls.push('qualification'); return item.qualification; } }),
      canaryRepository: { readTargetIntent: async () => { calls.push('target'); return item.target; },
        armCanary: async () => { calls.push('arm'); throw new Error('unexpected arm'); } },
      nonceSource: () => 'abcdef123456',
    });
    await assert.rejects(service.arm(canaryCommand(evidence, {
      isTTY: true, write: () => { calls.push('tty.write'); }, readLine: async () => {
        calls.push('tty.read'); return '';
      },
    }, item.intentId) as never), (error) => error instanceof Error, item.label);
    assert.deepEqual(calls, ['qualification', 'target'], item.label);
  }
});

void test('rejects divergent sidecar wallet and provider identities before TTY and arm', async () => {
  const generationId = `execution_wallet_generation_${'d'.repeat(64)}`;
  for (const [label, input] of [
    ['wallet generation', { walletSnapshot: { generationId: `execution_wallet_generation_${'e'.repeat(64)}` }, qualification: { generationId } }],
    ['wallet provider', { walletSnapshot: { providerId: 'secondary' }, qualification: { generationId, providerId: 'primary' } }],
    ['provider snapshot', { providerSnapshot: { providerId: 'secondary' }, qualification: { generationId, providerId: 'primary' } }],
  ] as const) {
    const calls: string[] = [];
    const evidence = createExecutionCanaryEvidence(canaryEvidenceInput({
      ...input, policy: { walletSnapshotMaxAgeMs: 300_000 },
    }));
    const target: ExecutionCanaryTargetIntentV1 = Object.freeze({ intentId: evidence.targetIntentId,
      side: 'BUY', status: 'PENDING', leaseOwner: null, leaseExpiresAtMs: null, stateRevision: 0n,
      strategyId: 'canary-test', strategyVersion: 1, decisionFingerprint: 'e'.repeat(64),
      mint: 'So11111111111111111111111111111111111111112',
      quoteMint: 'So11111111111111111111111111111111111111112', quoteAmountRaw: 500_000n,
      expiresAtMs: NOW_MS + 300_000 });
    const service = createExecutionOperationsService({
      repository: repositoryStub({ readQualification: async () => { calls.push('qualification'); return evidence.qualification; } }),
      canaryRepository: { readTargetIntent: async () => { calls.push('target'); return target; },
        armCanary: async () => { calls.push('arm'); throw new Error('unexpected arm'); } },
      nonceSource: () => 'abcdef123456',
    });
    await assert.rejects(service.arm(canaryCommand(evidence, {
      isTTY: true, write: () => { calls.push('tty.write'); }, readLine: async () => {
        calls.push('tty.read'); return '';
      },
    }) as never), (error) => error instanceof Error, label);
    assert.deepEqual(calls, ['qualification', 'target'], label);
  }
});

void test('resume requires fresh terminal authorization before repository mutation', async () => {
  const calls: string[] = [];
  const qualification = fixtureQualification();
  const repository = repositoryStub({
    readQualification: async () => qualification,
    recordAuthorization: async () => { calls.push('authorization'); return 'RECORDED'; },
    resume: async () => {
      calls.push('resume');
      return {
        payloadVersion: 1, generationId: qualification.generationId,
        controlState: 'RUNNING', controlRevision: 1n,
        latestQualificationId: qualification.qualificationId,
        latestQualificationExpiresAtMs: qualification.expiresAtMs,
        activeArmamentId: null, activeArmamentPhase: null,
        activeArmamentExpiresAtMs: null,
      };
    },
  });
  const service = createExecutionOperationsService({ repository, nonceSource: () => 'abcdef123456' });
  const status = await service.resume({
    payloadVersion: 1,
    commandId: 'command:resume',
    qualificationId: qualification.qualificationId,
    operatorId: 'operator-primary',
    nowMs: NOW_MS + 1,
    terminal: {
      isTTY: true, write() {},
      readLine: async () => 'CONFIRM RESUME NONE 11111111 abcdef123456',
    },
  });
  assert.equal(status.controlState, 'RUNNING');
  assert.deepEqual(calls, ['authorization', 'resume']);
});

function envelopePolicy(overrides: Readonly<Record<string, unknown>> = {}) {
  return createExecutionRiskPolicy({
    quoteMintAllowlist: [WSOL_MINT], initialCapitalLamports: 230_000_000n,
    maximumCapitalLamports: 230_000_000n, positionSizeBps: 1_000n, maximumOpenPositions: 1,
    maximumTotalExposureBps: 500n, drawdownPauseBps: 2_500n, feeReserveLamports: 20_000_000n,
    walletSnapshotMaxAgeMs: 300_000, providerUsageMaxAgeMs: 300_000, providerEntryCostUnits: 8n,
    providerExitCostUnitsPerPosition: 4n, providerConfirmationCostUnitsPerPosition: 2n,
    providerReconciliationCostUnitsPerPosition: 3n, providerSafetyMarginUnits: 5n,
    maximumConsecutiveTechnicalFailures: 2, ...overrides,
  });
}

function envelopeHarness(terminal: {
  readonly isTTY: boolean;
  readonly write: (value: string) => void;
  readonly readLine: () => Promise<string>;
}, policyOverrides: Readonly<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const qualification = envelopeCanaryEvidenceInput().qualification;
  const databaseNowMs = qualification.qualifiedAtMs + 1_000;
  let recorded: ExecutionOperatorAuthorizationV1 | null = null;
  let created: ExecutionEnvelopeCreationV1 | null = null;
  const envelopeRepository: ExecutionEntryEnvelopeRepository = {
    prepareEnvelopeFacts: async () => { throw new Error('unexpected facts'); },
    expireEnvelopes: async () => {
      calls.push('now');
      return Object.freeze({ payloadVersion: 1, expiredCount: 0, databaseNowMs });
    },
    createEnvelope: async (input) => { calls.push('create'); created = input; return input.envelope; },
    revokeEnvelope: async () => { throw new Error('unexpected revoke'); },
    readEnvelopes: async () => { throw new Error('unexpected read'); },
  };
  const service = createExecutionOperationsService({
    repository: repositoryStub({ recordAuthorization: async (authorization) => {
      calls.push('authorization'); recorded = authorization; return 'RECORDED';
    } }),
    envelopeRepository,
    nonceSource: () => 'abcdef123456',
  });
  const operation = service.createEnvelope({
    payloadVersion: 1, qualification: qualification as never, policy: envelopePolicy(policyOverrides),
    operatorId: 'operator-primary', perBuyQuoteAmountRaw: 10_000_000n, maxBuys: 5,
    maxTotalExposureRaw: 50_000_000n, maxRealizedLossRaw: 30_000_000n, maximumHoldingMs: 120_000,
    terminal,
  });
  return {
    calls, qualification, databaseNowMs, operation,
    recorded: () => recorded, created: () => created,
  };
}

void test('envelope create binds DB now, shows its limits at TTY and records then consumes ENVELOPE',
  async () => {
    const writes: string[] = [];
    let typed = '';
    const harness = envelopeHarness({
      isTTY: true,
      write: (value) => { writes.push(value); },
      readLine: async () => {
        typed = writes.join('').trim().split('\n').at(-1) ?? '';
        return typed;
      },
    });
    const envelope = await harness.operation;
    assert.deepEqual(harness.calls, ['now', 'authorization', 'create']);
    assert.equal(envelope.validFromMs, harness.databaseNowMs);
    assert.equal(envelope.validUntilMs, harness.qualification.expiresAtMs);
    assert.equal(envelope.qualificationId, harness.qualification.qualificationId);
    const [details, phrase] = writes.join('').trim().split('\n');
    assert.equal(details, [
      'ENVELOPE_DETAILS', 'V1', `envelopeId=${envelope.envelopeId}`, 'perBuyLamports=10000000',
      'maxBuys=5', 'maxExposureLamports=50000000', 'maxLossLamports=30000000', 'holdingMs=120000',
      `validFromMs=${harness.databaseNowMs}`, `validUntilMs=${harness.qualification.expiresAtMs}`,
      `policyFingerprint=${envelope.policy.policyFingerprint}`,
      `qualificationId=${harness.qualification.qualificationId}`,
    ].join(' '));
    assert.equal(phrase, [
      'CONFIRM', 'ENVELOPE', harness.qualification.walletPublicKey, '10000000', '5', '50000000',
      '30000000', '120000', String(harness.qualification.expiresAtMs),
      envelope.fingerprint.slice(0, 8), 'abcdef123456',
    ].join(' '));
    assert.equal(typed, phrase);
    const authorization = harness.recorded() as unknown as ExecutionOperatorAuthorizationV1;
    assert.equal(authorization.action, 'ENVELOPE');
    assert.equal(authorization.phase, null);
    assert.equal(authorization.payloadVersion, 1);
    assert.equal(authorization.contextFingerprint, envelope.fingerprint);
    assert.equal(authorization.operatorId, 'operator-primary');
    assert.equal(authorization.issuedAtMs, harness.databaseNowMs);
    assert.equal(authorization.expiresAtMs, harness.databaseNowMs + 60_000);
    const created = harness.created() as unknown as ExecutionEnvelopeCreationV1;
    assert.equal(created.envelope, envelope);
    assert.equal(created.authorization, authorization);
    assert.equal(created.qualification.qualificationId, harness.qualification.qualificationId);
  });

void test('envelope create refuses without a TTY or with a wrong phrase before any write', async () => {
  const noTty = envelopeHarness({ isTTY: false, write() {}, readLine: async () => '' });
  await assert.rejects(noTty.operation);
  assert.deepEqual(noTty.calls, ['now']);
  const wrong = envelopeHarness({ isTTY: true, write() {}, readLine: async () => 'CONFIRM ENVELOPE' });
  await assert.rejects(wrong.operation);
  assert.deepEqual(wrong.calls, ['now']);
});

void test('envelope create surfaces limits the policy cannot carry (A17) before the TTY', async () => {
  let prompted = false;
  const harness = envelopeHarness({ isTTY: true, write: () => { prompted = true; },
    readLine: async () => '' }, {
    initialCapitalLamports: 150_000_000n, maximumCapitalLamports: 150_000_000n,
  });
  await assert.rejects(harness.operation, (error) => error instanceof ExecutionEnvelopeCommandError
    && error.code === 'ENVELOPE_LIMITS_REJECTED');
  assert.equal(prompted, false);
  assert.deepEqual(harness.calls, ['now']);
});

function repositoryStub(
  overrides: Partial<ExecutionOperationsRepository>,
): ExecutionOperationsRepository {
  const unavailable = async (): Promise<never> => { throw new Error('unexpected repository call'); };
  return {
    persistQualification: unavailable,
    readQualification: unavailable,
    recordAuthorization: unavailable,
    setStop: unavailable,
    resume: unavailable,
    arm: unavailable,
    readStatus: unavailable,
    ...overrides,
  };
}

function terminalForV2Confirmation(calls?: string[]) {
  const writes: string[] = [];
  return {
    isTTY: true,
    write: (value: string) => { calls?.push('tty.write'); writes.push(value); },
    readLine: async () => {
      calls?.push('tty.read');
      return writes.at(-1)?.trim().split('\n').at(-1) ?? '';
    },
  };
}

function canaryCommand(
  evidence: ReturnType<typeof createExecutionCanaryEvidence>,
  terminal: { readonly isTTY: boolean; readonly write: (value: string) => void; readonly readLine: () => Promise<string> },
  intentId = evidence.targetIntentId,
) {
  return { payloadVersion: 2 as const, evidence, intentId,
    maximumCapitalLamports: 500_000n, maximumHoldingMs: 300_000, runtimeQuoteMaxAgeMs: 3_000,
    runtimeSlippageBps: 500n, runtimeSnapshotMaxSlotLag: 8, runtimeMaxComputeUnits: 300_000n,
    runtimeMaxFeeLamports: 100_000n, runtimeMaxFeePayerLamportDebit: 2_500_000n,
    runtimeMaxRpcCallsPerAttempt: 12, runtimeLeaseMs: 120_000, operatorId: 'operator-primary',
    operatorReason: 'Mainnet canary manually approved.', nowMs: NOW_MS, terminal };
}

async function armForExpiry(
  evidence: ReturnType<typeof createExecutionCanaryEvidence>,
  targetExpiresAtMs: number,
  leaseMs: number,
  expectRejection = false,
): Promise<{ readonly armamentExpiresAtMs: number | null; readonly calls: readonly string[] }> {
  const calls: string[] = [];
  let armamentExpiresAtMs: number | null = null;
  const target: ExecutionCanaryTargetIntentV1 = Object.freeze({ intentId: evidence.targetIntentId,
    side: 'BUY', status: 'PENDING', leaseOwner: null, leaseExpiresAtMs: null, stateRevision: 0n,
    strategyId: 'canary-test', strategyVersion: 1, decisionFingerprint: 'e'.repeat(64),
    mint: 'So11111111111111111111111111111111111111112',
    quoteMint: 'So11111111111111111111111111111111111111112', quoteAmountRaw: 500_000n,
    expiresAtMs: targetExpiresAtMs });
  const service = createExecutionOperationsService({
    repository: repositoryStub({ readQualification: async () => { calls.push('qualification'); return evidence.qualification; } }),
    canaryRepository: { readTargetIntent: async () => { calls.push('target'); return target; }, armCanary: async (input) => {
      calls.push('arm'); armamentExpiresAtMs = input.request.armamentExpiresAtMs;
      return Object.freeze({ ...input.request, armamentId: `execution_activation_armament_${'a'.repeat(64)}`,
        armamentFingerprint: 'a'.repeat(64), state: 'ARMED', authorizationId: `execution_operator_authorization_${'b'.repeat(64)}`,
        authorizationFingerprint: 'b'.repeat(64), admissionReportId: `execution_risk_admission_${'c'.repeat(64)}`,
        reservationId: `execution_exposure_reservation_${'d'.repeat(64)}` }) as ExecutionActivationArmamentV2;
    } }, nonceSource: () => 'abcdef123456',
  });
  const terminal = expectRejection ? { isTTY: true, write: () => { calls.push('tty.write'); }, readLine: async () => {
    calls.push('tty.read'); return '';
  } } : terminalForV2Confirmation(calls);
  const operation = service.arm({ ...canaryCommand(evidence, terminal), runtimeLeaseMs: leaseMs } as never);
  if (expectRejection) await assert.rejects(operation);
  else await operation;
  return Object.freeze({ armamentExpiresAtMs, calls: Object.freeze(calls) });
}

function fixtureQualification() {
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST',
    'SIMULATION_ARTIFACT', 'FAULT_TEST', 'RECONCILIATION_STATE',
    'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST', 'WALLET_SNAPSHOT',
    'MAINNET_SIMULATION_ARTIFACT',
  ] as const;
  return createSafetyQualification({
    payloadVersion: 1, evaluatorVersion: 1, phase: 'CANARY',
    buildHash: 'a'.repeat(64), configurationFingerprint: 'b'.repeat(64),
    strategyFingerprint: 'c'.repeat(64),
    generationId: `execution_wallet_generation_${'d'.repeat(64)}`,
    walletPublicKey: '11111111111111111111111111111111',
    cluster: 'mainnet-beta', genesisHash: '11111111111111111111111111111111',
    providerId: 'primary', qualifiedAtMs: NOW_MS, expiresAtMs: NOW_MS + 300_000,
    gates: EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => ({
      payloadVersion: 1, gateId, status: 'PASSED', evidenceType: evidenceTypes[index],
      evidenceId: `evidence:${index}`,
      evidenceFingerprint: index.toString(16).repeat(64),
      observedAtMs: NOW_MS - 1_000 + index, expiresAtMs: NOW_MS + 300_000,
    })),
  });
}

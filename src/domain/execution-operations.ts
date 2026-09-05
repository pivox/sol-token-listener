import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { PublicKey } from '@solana/web3.js';
import {
  createSafetyQualification,
  type ExecutionLivePhase,
  type ExecutionSafetyQualificationV1,
} from './execution-safety-qualification.js';
import { createExecutionCanaryEvidence, type ExecutionCanaryEvidenceV1 } from './execution-canary.js';

const U64_MAX = 18_446_744_073_709_551_615n;
const DATE_MAX_MS = 8_640_000_000_000_000;
const ARMAMENT_INPUT_KEYS = Object.freeze([
  'payloadVersion', 'qualification', 'maximumBuys', 'maximumCapitalLamports',
  'maximumExposureBps', 'maximumOpenPositions', 'maximumHoldingMs',
  'armedAtMs', 'expiresAtMs', 'operatorId', 'operatorReason',
  'authorizationId', 'authorizationFingerprint',
] as const);
const QUALIFICATION_KEYS = Object.freeze([
  'qualificationId', 'payloadVersion', 'evaluatorVersion',
  'qualificationFingerprint', 'phase', 'buildHash', 'configurationFingerprint',
  'strategyFingerprint', 'generationId', 'walletPublicKey', 'cluster',
  'genesisHash', 'providerId', 'qualifiedAtMs', 'expiresAtMs', 'gates',
] as const);
const CONTROL_INPUT_KEYS = Object.freeze([
  'currentState', 'action', 'freshQualification', 'unknownRisk',
] as const);
const AUTHORIZATION_INPUT_KEYS = Object.freeze([
  'payloadVersion', 'generationId', 'action', 'phase', 'contextFingerprint',
  'nonceHash', 'operatorId', 'issuedAtMs', 'expiresAtMs',
] as const);
const ARMAMENT_REQUEST_V2_KEYS = Object.freeze([
  'payloadVersion', 'qualification', 'targetIntentId', 'policy', 'walletSnapshot', 'providerSnapshot',
  'allEndpointsUnavailable', 'capturedAtMs', 'expiresAtMs', 'target', 'maximumBuys',
  'maximumCapitalLamports', 'maximumExposureBps', 'maximumOpenPositions', 'maximumHoldingMs',
  'runtimeQuoteMaxAgeMs', 'runtimeSlippageBps', 'runtimeSnapshotMaxSlotLag',
  'runtimeMaxComputeUnits', 'runtimeMaxFeeLamports', 'runtimeMaxFeePayerLamportDebit',
  'runtimeMaxRpcCallsPerAttempt', 'runtimeLeaseMs', 'armedAtMs', 'armamentExpiresAtMs', 'operatorId', 'operatorReason',
] as const);
const ARMAMENT_V2_KEYS = Object.freeze([
  'payloadVersion', 'request', 'authorizationId', 'authorizationFingerprint', 'admissionReportId', 'reservationId',
] as const);
const TARGET_V2_KEYS = Object.freeze([
  'intentId', 'stateRevision', 'strategyId', 'strategyVersion', 'decisionFingerprint', 'mint',
  'quoteMint', 'quoteAmountRaw',
] as const);
const CONTROL_STATES = Object.freeze(['RUNNING', 'ENTRY_STOP', 'HARD_STOP'] as const);
const CONTROL_ACTIONS = Object.freeze(['ENTRY_STOP', 'HARD_STOP', 'RESUME'] as const);

export type ExecutionControlState = (typeof CONTROL_STATES)[number];
export type ExecutionControlAction = (typeof CONTROL_ACTIONS)[number];

export interface ExecutionActivationArmamentV1 {
  readonly armamentId: string;
  readonly payloadVersion: 1;
  readonly armamentFingerprint: string;
  readonly qualificationId: string;
  readonly qualificationFingerprint: string;
  readonly state: 'ARMED';
  readonly phase: ExecutionLivePhase;
  readonly buildHash: string;
  readonly configurationFingerprint: string;
  readonly strategyFingerprint: string;
  readonly generationId: string;
  readonly walletPublicKey: string;
  readonly cluster: 'mainnet-beta';
  readonly genesisHash: string;
  readonly providerId: string;
  readonly maximumBuys: number;
  readonly maximumCapitalLamports: bigint;
  readonly maximumExposureBps: bigint;
  readonly maximumOpenPositions: number;
  readonly maximumHoldingMs: number;
  readonly armedAtMs: number;
  readonly expiresAtMs: number;
  readonly operatorId: string;
  readonly operatorReason: string;
  readonly authorizationId: string;
  readonly authorizationFingerprint: string;
}

export interface ExecutionCanaryTargetV2 {
  readonly intentId: string;
  readonly stateRevision: bigint;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly decisionFingerprint: string;
  readonly mint: string;
  readonly quoteMint: string;
  readonly quoteAmountRaw: bigint;
}

export interface ExecutionArmamentRequestV2 extends Omit<ExecutionCanaryEvidenceV1, 'payloadVersion'> {
  readonly payloadVersion: 2;
  readonly armamentRequestFingerprint: string;
  readonly target: ExecutionCanaryTargetV2;
  readonly maximumBuys: 1;
  readonly maximumCapitalLamports: bigint;
  readonly maximumExposureBps: 500n;
  readonly maximumOpenPositions: 1;
  readonly maximumHoldingMs: number;
  readonly runtimeQuoteMaxAgeMs: number;
  readonly runtimeSlippageBps: bigint;
  readonly runtimeSnapshotMaxSlotLag: number;
  readonly runtimeMaxComputeUnits: bigint;
  readonly runtimeMaxFeeLamports: bigint;
  readonly runtimeMaxFeePayerLamportDebit: bigint;
  readonly runtimeMaxRpcCallsPerAttempt: number;
  readonly runtimeLeaseMs: number;
  readonly armedAtMs: number;
  readonly armamentExpiresAtMs: number;
  readonly operatorId: string;
  readonly operatorReason: string;
}

export interface ExecutionActivationArmamentV2 extends ExecutionArmamentRequestV2 {
  readonly armamentId: string;
  readonly payloadVersion: 2;
  readonly armamentFingerprint: string;
  readonly state: 'ARMED';
  readonly authorizationId: string;
  readonly authorizationFingerprint: string;
  readonly admissionReportId: string;
  readonly reservationId: string;
}

export interface ExecutionControlTransitionDecisionV1 {
  readonly nextState: ExecutionControlState;
  readonly reasonCode: 'OPERATOR_ENTRY_STOP' | 'OPERATOR_HARD_STOP' | null;
}

export interface ExecutionOperatorAuthorizationV1 {
  readonly authorizationId: string;
  readonly payloadVersion: 1;
  readonly authorizationFingerprint: string;
  readonly generationId: string;
  readonly action: 'ARM' | 'RESUME';
  readonly phase: ExecutionLivePhase | null;
  readonly contextFingerprint: string;
  readonly nonceHash: string;
  readonly operatorId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ExecutionOperatorAuthorizationV2 extends Omit<ExecutionOperatorAuthorizationV1, 'payloadVersion'> {
  readonly payloadVersion: 2;
}

export class ExecutionOperationsValidationError extends TypeError {
  public constructor() {
    super('Invalid execution operations input.');
    this.name = 'ExecutionOperationsValidationError';
  }
}

export function createOperatorAuthorization(input: unknown): ExecutionOperatorAuthorizationV1 {
  try {
    const record = exactRecord(input, AUTHORIZATION_INPUT_KEYS);
    if (record.payloadVersion !== 1) throw invalid();
    const generationId = patternedText(
      record.generationId,
      /^execution_wallet_generation_[0-9a-f]{64}$/u,
      96,
    );
    if (record.action !== 'ARM' && record.action !== 'RESUME') throw invalid();
    const action = record.action;
    const phase = action === 'ARM'
      ? enumValue(record.phase, ['CANARY', 'MICRO_LIVE', 'PILOT'] as const)
      : null;
    if (action === 'RESUME' && record.phase !== null) throw invalid();
    const contextFingerprint = fingerprint(record.contextFingerprint);
    const nonceHash = fingerprint(record.nonceHash);
    const operatorId = patternedText(record.operatorId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, 64);
    const issuedAtMs = timestamp(record.issuedAtMs);
    const expiresAtMs = timestamp(record.expiresAtMs);
    if (expiresAtMs <= issuedAtMs || expiresAtMs > issuedAtMs + 300_000) throw invalid();
    const authorizationFingerprint = hash([
      'execution-operator-authorization-v1', generationId, action, phase,
      contextFingerprint, nonceHash, operatorId, issuedAtMs, expiresAtMs,
    ]);
    return Object.freeze({
      authorizationId: `execution_operator_authorization_${authorizationFingerprint}`,
      payloadVersion: 1,
      authorizationFingerprint,
      generationId,
      action,
      phase,
      contextFingerprint,
      nonceHash,
      operatorId,
      issuedAtMs,
      expiresAtMs,
    });
  } catch {
    throw invalid();
  }
}

export function createOperatorAuthorizationV2(input: unknown): ExecutionOperatorAuthorizationV2 {
  try {
    const record = exactRecord(input, AUTHORIZATION_INPUT_KEYS);
    if (record.payloadVersion !== 2) throw invalid();
    const generationId = patternedText(record.generationId, /^execution_wallet_generation_[0-9a-f]{64}$/u, 96);
    if (record.action !== 'ARM' && record.action !== 'RESUME') throw invalid();
    const action = record.action;
    const phase = action === 'ARM' ? enumValue(record.phase, ['CANARY', 'MICRO_LIVE', 'PILOT'] as const) : null;
    if (action === 'RESUME' && record.phase !== null) throw invalid();
    const contextFingerprint = fingerprint(record.contextFingerprint);
    const nonceHash = fingerprint(record.nonceHash);
    const operatorId = patternedText(record.operatorId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, 64);
    const issuedAtMs = timestamp(record.issuedAtMs); const expiresAtMs = timestamp(record.expiresAtMs);
    if (expiresAtMs <= issuedAtMs || expiresAtMs > issuedAtMs + 60_000) throw invalid();
    const authorizationFingerprint = hashLengthPrefixed(['execution-operator-authorization-v2', generationId, action, phase, contextFingerprint, nonceHash, operatorId, issuedAtMs, expiresAtMs]);
    return Object.freeze({ authorizationId: `execution_operator_authorization_${authorizationFingerprint}`,
      payloadVersion: 2, authorizationFingerprint, generationId, action, phase, contextFingerprint, nonceHash,
      operatorId, issuedAtMs, expiresAtMs });
  } catch { throw invalid(); }
}

export function createExecutionArmament(input: unknown): ExecutionActivationArmamentV1 {
  try {
    const record = exactRecord(input, ARMAMENT_INPUT_KEYS);
    if (record.payloadVersion !== 1) throw invalid();
    const qualification = qualificationFrom(record.qualification);
    const maximumBuys = integer(record.maximumBuys, 1, 10);
    const maximumCapitalLamports = positiveU64(record.maximumCapitalLamports);
    const maximumExposureBps = positiveBigint(record.maximumExposureBps, 10_000n);
    const maximumOpenPositions = integer(record.maximumOpenPositions, 1, 2);
    const maximumHoldingMs = integer(record.maximumHoldingMs, 30_000, 900_000);
    validatePhaseLimits(
      qualification.phase,
      maximumBuys,
      maximumExposureBps,
      maximumOpenPositions,
    );
    const armedAtMs = timestamp(record.armedAtMs);
    const expiresAtMs = timestamp(record.expiresAtMs);
    if (armedAtMs < qualification.qualifiedAtMs || armedAtMs >= qualification.expiresAtMs
      || expiresAtMs <= armedAtMs || expiresAtMs > qualification.expiresAtMs) throw invalid();
    const operatorId = patternedText(
      record.operatorId,
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
      64,
    );
    const operatorReason = patternedText(
      record.operatorReason,
      /^[\x20-\x7E]{1,256}$/u,
      256,
    );
    const authorizationId = patternedText(
      record.authorizationId,
      /^execution_operator_authorization_[0-9a-f]{64}$/u,
      97,
    );
    const authorizationFingerprint = fingerprint(record.authorizationFingerprint);
    const armamentFingerprint = hash([
      'execution-activation-armament-v1', qualification.qualificationId,
      qualification.qualificationFingerprint, qualification.phase,
      qualification.buildHash, qualification.configurationFingerprint,
      qualification.strategyFingerprint, qualification.generationId,
      qualification.walletPublicKey, qualification.cluster, qualification.genesisHash,
      qualification.providerId, maximumBuys, maximumCapitalLamports.toString(),
      maximumExposureBps.toString(), maximumOpenPositions, maximumHoldingMs,
      armedAtMs, expiresAtMs, operatorId, operatorReason, authorizationId,
      authorizationFingerprint,
    ]);
    return Object.freeze({
      armamentId: `execution_activation_armament_${armamentFingerprint}`,
      payloadVersion: 1,
      armamentFingerprint,
      qualificationId: qualification.qualificationId,
      qualificationFingerprint: qualification.qualificationFingerprint,
      state: 'ARMED',
      phase: qualification.phase,
      buildHash: qualification.buildHash,
      configurationFingerprint: qualification.configurationFingerprint,
      strategyFingerprint: qualification.strategyFingerprint,
      generationId: qualification.generationId,
      walletPublicKey: qualification.walletPublicKey,
      cluster: qualification.cluster,
      genesisHash: qualification.genesisHash,
      providerId: qualification.providerId,
      maximumBuys,
      maximumCapitalLamports,
      maximumExposureBps,
      maximumOpenPositions,
      maximumHoldingMs,
      armedAtMs,
      expiresAtMs,
      operatorId,
      operatorReason,
      authorizationId,
      authorizationFingerprint,
    });
  } catch {
    throw invalid();
  }
}

export function createExecutionArmamentRequestV2(input: unknown): ExecutionArmamentRequestV2 {
  try {
    const record = exactRecord(input, ARMAMENT_REQUEST_V2_KEYS);
    if (record.payloadVersion !== 2) throw invalid();
    const evidence = createExecutionCanaryEvidence({
      payloadVersion: 1, qualification: record.qualification, targetIntentId: record.targetIntentId,
      policy: record.policy, walletSnapshot: record.walletSnapshot, providerSnapshot: record.providerSnapshot,
      allEndpointsUnavailable: record.allEndpointsUnavailable, capturedAtMs: record.capturedAtMs,
      expiresAtMs: record.expiresAtMs,
    });
    const target = targetFrom(record.target);
    if (target.intentId !== evidence.targetIntentId || target.quoteMint !== evidence.policy.quoteMintAllowlist[0]
      || target.quoteAmountRaw > positiveU64(record.maximumCapitalLamports)) throw invalid();
    const maximumBuys = integer(record.maximumBuys, 1, 1) as 1;
    const maximumCapitalLamports = positiveU64(record.maximumCapitalLamports);
    const maximumExposureBps = positiveBigint(record.maximumExposureBps, 500n);
    if (maximumExposureBps !== 500n || record.maximumOpenPositions !== 1) throw invalid();
    const maximumOpenPositions = 1 as const;
    if (evidence.policy.maximumTotalExposureBps > maximumExposureBps
      || evidence.policy.maximumOpenPositions > maximumOpenPositions) throw invalid();
    const maximumHoldingMs = integer(record.maximumHoldingMs, 30_000, 900_000);
    const runtimeQuoteMaxAgeMs = integer(record.runtimeQuoteMaxAgeMs, 1, 60_000);
    const runtimeSlippageBps = unsignedBigint(record.runtimeSlippageBps, 10_000n);
    const runtimeSnapshotMaxSlotLag = integer(record.runtimeSnapshotMaxSlotLag, 0, 128);
    const runtimeMaxComputeUnits = positiveBigint(record.runtimeMaxComputeUnits, 1_400_000n);
    const runtimeMaxFeeLamports = unsignedBigint(record.runtimeMaxFeeLamports, 10_000_000n);
    const runtimeMaxFeePayerLamportDebit = unsignedBigint(record.runtimeMaxFeePayerLamportDebit, 10_000_000_000n);
    const runtimeMaxRpcCallsPerAttempt = integer(record.runtimeMaxRpcCallsPerAttempt, 12, 16);
    const runtimeLeaseMs = integer(record.runtimeLeaseMs, 3_000, 120_000);
    const armedAtMs = timestamp(record.armedAtMs);
    const armamentExpiresAtMs = timestamp(record.armamentExpiresAtMs);
    if (armedAtMs < evidence.qualification.qualifiedAtMs || armamentExpiresAtMs <= armedAtMs
      || armamentExpiresAtMs > evidence.expiresAtMs || armamentExpiresAtMs - armedAtMs < runtimeLeaseMs * 2) throw invalid();
    const operatorId = patternedText(record.operatorId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, 64);
    const operatorReason = patternedText(record.operatorReason, /^[\x20-\x7E]{1,256}$/u, 256);
    const armamentRequestFingerprint = hashLengthPrefixed([
      'execution-armament-request-v2', evidence.qualification.qualificationId,
      evidence.qualification.qualificationFingerprint, evidence.qualification.phase,
      evidence.qualification.buildHash, evidence.qualification.configurationFingerprint,
      evidence.qualification.strategyFingerprint, evidence.qualification.generationId,
      evidence.qualification.walletPublicKey, evidence.qualification.cluster, evidence.qualification.genesisHash,
      evidence.qualification.providerId, evidence.evidenceId, evidence.evidenceFingerprint, evidence.capturedAtMs,
      evidence.expiresAtMs, target.intentId, target.stateRevision.toString(), target.strategyId,
      target.strategyVersion, target.decisionFingerprint, target.mint, target.quoteMint, target.quoteAmountRaw.toString(),
      maximumBuys, maximumCapitalLamports.toString(), maximumExposureBps.toString(), maximumOpenPositions,
      maximumHoldingMs, evidence.policy.policyFingerprint, evidence.walletSnapshot.snapshotFingerprint,
      evidence.providerSnapshot.snapshotFingerprint, runtimeQuoteMaxAgeMs, runtimeSlippageBps.toString(),
      runtimeSnapshotMaxSlotLag, runtimeMaxComputeUnits.toString(), runtimeMaxFeeLamports.toString(),
      runtimeMaxFeePayerLamportDebit.toString(), runtimeMaxRpcCallsPerAttempt, runtimeLeaseMs, armedAtMs,
      armamentExpiresAtMs, operatorId, operatorReason,
    ]);
    return Object.freeze({ ...evidence, payloadVersion: 2, armamentRequestFingerprint, target, maximumBuys,
      maximumCapitalLamports, maximumExposureBps: 500n as const, maximumOpenPositions, maximumHoldingMs, runtimeQuoteMaxAgeMs,
      runtimeSlippageBps, runtimeSnapshotMaxSlotLag, runtimeMaxComputeUnits, runtimeMaxFeeLamports,
      runtimeMaxFeePayerLamportDebit, runtimeMaxRpcCallsPerAttempt, runtimeLeaseMs, armedAtMs, armamentExpiresAtMs,
      operatorId, operatorReason });
  } catch { throw invalid(); }
}

export function createExecutionArmamentV2(input: unknown): ExecutionActivationArmamentV2 {
  try {
    const record = exactRecord(input, ARMAMENT_V2_KEYS);
    if (record.payloadVersion !== 2) throw invalid();
    const request = requestFrom(record.request);
    const authorizationId = patternedText(record.authorizationId, /^execution_operator_authorization_[0-9a-f]{64}$/u, 97);
    const authorizationFingerprint = fingerprint(record.authorizationFingerprint);
    const admissionReportId = patternedText(record.admissionReportId, /^execution_risk_admission_[0-9a-f]{64}$/u, 128);
    const reservationId = patternedText(record.reservationId, /^execution_exposure_reservation_[0-9a-f]{64}$/u, 128);
    const armamentFingerprint = hashLengthPrefixed(['execution-activation-armament-v2', request.armamentRequestFingerprint, authorizationId, authorizationFingerprint, admissionReportId, reservationId]);
    return Object.freeze({ ...request, armamentId: `execution_activation_armament_${armamentFingerprint}`, payloadVersion: 2,
      armamentFingerprint, state: 'ARMED', authorizationId, authorizationFingerprint, admissionReportId, reservationId });
  } catch { throw invalid(); }
}

export function decideExecutionControlTransition(
  input: unknown,
): ExecutionControlTransitionDecisionV1 {
  try {
    const record = exactRecord(input, CONTROL_INPUT_KEYS);
    const currentState = enumValue(record.currentState, CONTROL_STATES);
    const action = enumValue(record.action, CONTROL_ACTIONS);
    const freshQualification = booleanValue(record.freshQualification);
    const unknownRisk = booleanValue(record.unknownRisk);
    if (action === 'RESUME') {
      if (currentState === 'RUNNING' || !freshQualification || unknownRisk) throw invalid();
      return Object.freeze({ nextState: 'RUNNING', reasonCode: null });
    }
    if (currentState === 'HARD_STOP' && action === 'ENTRY_STOP') throw invalid();
    return Object.freeze({
      nextState: action,
      reasonCode: action === 'ENTRY_STOP' ? 'OPERATOR_ENTRY_STOP' : 'OPERATOR_HARD_STOP',
    });
  } catch {
    throw invalid();
  }
}

function qualificationFrom(value: unknown): ExecutionSafetyQualificationV1 {
  const record = exactRecord(value, QUALIFICATION_KEYS);
  const canonical = createSafetyQualification({
    payloadVersion: record.payloadVersion,
    evaluatorVersion: record.evaluatorVersion,
    phase: record.phase,
    buildHash: record.buildHash,
    configurationFingerprint: record.configurationFingerprint,
    strategyFingerprint: record.strategyFingerprint,
    generationId: record.generationId,
    walletPublicKey: record.walletPublicKey,
    cluster: record.cluster,
    genesisHash: record.genesisHash,
    providerId: record.providerId,
    qualifiedAtMs: record.qualifiedAtMs,
    expiresAtMs: record.expiresAtMs,
    gates: record.gates,
  });
  if (record.qualificationId !== canonical.qualificationId
    || record.qualificationFingerprint !== canonical.qualificationFingerprint) throw invalid();
  return canonical;
}

function targetFrom(value: unknown): ExecutionCanaryTargetV2 {
  const record = exactRecord(value, TARGET_V2_KEYS);
  return Object.freeze({
    intentId: patternedText(record.intentId, /^execution_intent_[0-9a-f]{64}$/u, 81),
    stateRevision: unsignedBigint(record.stateRevision, 9_223_372_036_854_775_807n),
    strategyId: patternedText(record.strategyId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, 128),
    strategyVersion: integer(record.strategyVersion, 1, 2_147_483_647),
    decisionFingerprint: fingerprint(record.decisionFingerprint),
    mint: canonicalPublicKey(record.mint), quoteMint: canonicalPublicKey(record.quoteMint),
    quoteAmountRaw: positiveU64(record.quoteAmountRaw),
  });
}

function requestFrom(value: unknown): ExecutionArmamentRequestV2 {
  if (!isPlainObject(value) || !Object.isFrozen(value)) throw invalid();
  const record = exactRecord(value, [
    'payloadVersion', 'evidenceId', 'evidenceFingerprint', 'qualification', 'targetIntentId', 'policy', 'walletSnapshot',
    'providerSnapshot', 'allEndpointsUnavailable', 'capturedAtMs', 'expiresAtMs', 'armamentRequestFingerprint',
    'target', 'maximumBuys', 'maximumCapitalLamports', 'maximumExposureBps', 'maximumOpenPositions',
    'maximumHoldingMs', 'runtimeQuoteMaxAgeMs', 'runtimeSlippageBps', 'runtimeSnapshotMaxSlotLag',
    'runtimeMaxComputeUnits', 'runtimeMaxFeeLamports', 'runtimeMaxFeePayerLamportDebit',
    'runtimeMaxRpcCallsPerAttempt', 'runtimeLeaseMs', 'armedAtMs', 'armamentExpiresAtMs', 'operatorId', 'operatorReason',
  ] as const);
  const candidate = createExecutionArmamentRequestV2({
    payloadVersion: record.payloadVersion, qualification: record.qualification, targetIntentId: record.targetIntentId,
    policy: record.policy, walletSnapshot: record.walletSnapshot, providerSnapshot: record.providerSnapshot,
    allEndpointsUnavailable: record.allEndpointsUnavailable, capturedAtMs: record.capturedAtMs,
    expiresAtMs: record.expiresAtMs, target: record.target, maximumBuys: record.maximumBuys,
    maximumCapitalLamports: record.maximumCapitalLamports, maximumExposureBps: record.maximumExposureBps,
    maximumOpenPositions: record.maximumOpenPositions, maximumHoldingMs: record.maximumHoldingMs,
    runtimeQuoteMaxAgeMs: record.runtimeQuoteMaxAgeMs, runtimeSlippageBps: record.runtimeSlippageBps,
    runtimeSnapshotMaxSlotLag: record.runtimeSnapshotMaxSlotLag, runtimeMaxComputeUnits: record.runtimeMaxComputeUnits,
    runtimeMaxFeeLamports: record.runtimeMaxFeeLamports, runtimeMaxFeePayerLamportDebit: record.runtimeMaxFeePayerLamportDebit,
    runtimeMaxRpcCallsPerAttempt: record.runtimeMaxRpcCallsPerAttempt, runtimeLeaseMs: record.runtimeLeaseMs,
    armedAtMs: record.armedAtMs, armamentExpiresAtMs: record.armamentExpiresAtMs, operatorId: record.operatorId, operatorReason: record.operatorReason,
  });
  if (record.evidenceId !== candidate.evidenceId || record.evidenceFingerprint !== candidate.evidenceFingerprint
    || record.armamentRequestFingerprint !== candidate.armamentRequestFingerprint) throw invalid();
  return candidate;
}

function validatePhaseLimits(
  phase: ExecutionLivePhase,
  maximumBuys: number,
  maximumExposureBps: bigint,
  maximumOpenPositions: number,
): void {
  if (phase === 'CANARY' && (maximumBuys !== 1
    || maximumExposureBps !== 500n || maximumOpenPositions !== 1)) throw invalid();
  if (phase === 'MICRO_LIVE' && (maximumBuys !== 3
    || maximumExposureBps !== 500n || maximumOpenPositions !== 1)) throw invalid();
  if (phase === 'PILOT' && (maximumExposureBps > 2_000n || maximumOpenPositions !== 2)) {
    throw invalid();
  }
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (!isPlainObject(value)) throw invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string')) throw invalid();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    result[key] = descriptor.value;
  }
  return result as Readonly<Record<Keys[number], unknown>>;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw invalid();
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum
    || (value as number) > maximum) throw invalid();
  return value as number;
}

function positiveU64(value: unknown): bigint {
  return positiveBigint(value, U64_MAX);
}

function positiveBigint(value: unknown, maximum: bigint): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > maximum) throw invalid();
  return value;
}

function timestamp(value: unknown): number {
  return integer(value, 0, DATE_MAX_MS);
}

function fingerprint(value: unknown): string {
  return patternedText(value, /^[0-9a-f]{64}$/u, 64);
}

function patternedText(value: unknown, pattern: RegExp, maximumBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes
    || !pattern.test(value)) throw invalid();
  return value;
}

function canonicalPublicKey(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64) throw invalid();
  const parsed = new PublicKey(value);
  if (parsed.toBase58() !== value) throw invalid();
  return value;
}

function unsignedBigint(value: unknown, maximum: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > maximum) throw invalid();
  return value;
}

function hash(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashLengthPrefixed(value: readonly unknown[]): string {
  const digest = createHash('sha256');
  for (const item of value) {
    const encoded = Buffer.from(typeof item === 'string' ? item : JSON.stringify(item), 'utf8');
    digest.update(String(encoded.length));
    digest.update(':');
    digest.update(encoded);
  }
  return digest.digest('hex');
}

function invalid(): ExecutionOperationsValidationError {
  return new ExecutionOperationsValidationError();
}

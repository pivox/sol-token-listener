import { isProxy } from 'node:util/types';
import {
  assertExecutionIntent,
  type ExecutionIntentV1,
} from './execution-intent.js';
import {
  assertExecutionSimulationArtifact,
  type ExecutionSimulationArtifactV1,
} from './execution-simulation.js';
import type { ProviderUsageSnapshotV1 } from './execution-provider-quota.js';
import { createProviderUsageSnapshot } from './execution-provider-quota.js';
import {
  createExecutionReadinessManifest,
  createExecutionWalletGeneration,
  type ExecutionReadinessManifestV1,
} from './execution-readiness.js';
import { createExecutionRiskPolicy } from './execution-risk-policy.js';
import {
  createMainnetSimulationEvidenceFingerprint,
  createSafetyQualification,
  type ExecutionSafetyGateEvidenceV1,
} from './execution-safety-qualification.js';
import type { ExecutionWalletSnapshotV1 } from './execution-wallet-snapshot.js';
import { createExecutionWalletSnapshot } from './execution-wallet-snapshot.js';
import {
  createExecutionPreflightBundle,
  type ExecutionPreflightBundleDraftV1,
} from './execution-preflight-bundle.js';

const SOURCE_KEYS = Object.freeze([
  'schemaVersion', 'readiness', 'generation', 'walletSnapshot', 'providerSnapshot', 'target',
  'simulation', 'databaseNowMs',
] as const);
const CATALOG_KEYS = Object.freeze([
  'schemaVersion', 'strategyFingerprint', 'policy', 'gates',
] as const);
const READINESS_KEYS = Object.freeze([
  'schemaVersion', 'state', 'generationId', 'walletPublicKey', 'cluster', 'providerId',
  'walletSnapshotId', 'walletSnapshotFingerprint', 'providerSnapshotId',
  'providerSnapshotFingerprint', 'walletLamports', 'tokenBalanceCount', 'observedAtMs',
  'expiresAtMs', 'canaryStatus', 'paperMainnet49Status',
] as const);
const GENERATION_KEYS = Object.freeze([
  'generationId', 'walletPublicKey', 'cluster', 'genesisHash', 'generation',
] as const);
const TARGET_KEYS = Object.freeze([
  'intent', 'leaseOwner', 'leaseToken', 'leaseExpiresAtMs',
] as const);
const GATE_KEYS = Object.freeze([
  'payloadVersion', 'gateId', 'status', 'evidenceType', 'evidenceId',
  'evidenceFingerprint', 'observedAtMs', 'expiresAtMs',
] as const);
const WALLET_SNAPSHOT_KEYS = Object.freeze([
  'snapshotId', 'payloadVersion', 'snapshotFingerprint', 'generationId', 'providerId',
  'stateRevision', 'slot', 'blockTimeMs', 'observedAtMs', 'commitment', 'walletLamports',
  'tokenBalanceCount', 'openPositions', 'realizedNetPnlRaw',
] as const);
const WALLET_INPUT_KEYS = Object.freeze(WALLET_SNAPSHOT_KEYS.slice(3));
const PROVIDER_SNAPSHOT_KEYS = Object.freeze([
  'snapshotId', 'payloadVersion', 'snapshotFingerprint', 'providerId', 'planId',
  'billingPeriodId', 'billingPeriodStartedAtMs', 'billingPeriodEndsAtMs', 'limitUnits',
  'usedUnits', 'measuredAtMs', 'expiresAtMs', 'provenance',
] as const);
const PROVIDER_INPUT_KEYS = Object.freeze(PROVIDER_SNAPSHOT_KEYS.slice(3));
const STATIC_GATES = Object.freeze([
  ['QUALITY_GATES_PASSED', 'CI_RUN'],
  ['MIGRATIONS_VERIFIED', 'MIGRATION_TEST'],
  ['ARCHITECTURE_BOUNDARIES_VERIFIED', 'ARCHITECTURE_TEST'],
  ['DRY_RUN_RECOVERY_VERIFIED', 'DRY_RUN_TEST'],
  ['SIMULATION_MATRIX_VERIFIED', 'SIMULATION_ARTIFACT'],
  ['FAULT_MATRIX_VERIFIED', 'FAULT_TEST'],
  ['RECONCILIATION_CLEAN', 'RECONCILIATION_STATE'],
  ['STOP_CONTROLS_VERIFIED', 'STOP_CONTROL_TEST'],
] as const);
const QUALIFICATION_TTL_MS = 300_000;
const MINIMUM_MARGIN_MS = 5_000;
const MAXIMUM_SIMULATION_AGE_MS = 30_000;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface ExecutionPreflightTargetV1 {
  readonly intent: ExecutionIntentV1;
  readonly leaseOwner: null;
  readonly leaseToken: null;
  readonly leaseExpiresAtMs: null;
}

export interface ExecutionPreflightDraftSourceV1 {
  readonly schemaVersion: 'execution-preflight-draft-source.v1';
  readonly readiness: ExecutionReadinessManifestV1;
  readonly generation: Readonly<{
    generationId: string;
    walletPublicKey: string;
    cluster: 'mainnet-beta';
    genesisHash: string;
    generation: number;
  }>;
  readonly walletSnapshot: ExecutionWalletSnapshotV1;
  readonly providerSnapshot: ProviderUsageSnapshotV1;
  readonly target: ExecutionPreflightTargetV1;
  readonly simulation: ExecutionSimulationArtifactV1;
  readonly databaseNowMs: number;
}

export interface ExecutionPreflightGateCatalogV1 {
  readonly schemaVersion: 'execution-preflight-gate-catalog.v1';
  readonly strategyFingerprint: string;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly gates: readonly ExecutionSafetyGateEvidenceV1[];
}

export class ExecutionPreflightDraftValidationError extends TypeError {
  public readonly code = 'INVALID_EXECUTION_PREFLIGHT_DRAFT' as const;
  public constructor() {
    super('Invalid execution preflight draft.');
    this.name = 'ExecutionPreflightDraftValidationError';
  }
}

export function createExecutionPreflightDraftSource(
  sourceInput: unknown,
): ExecutionPreflightDraftSourceV1 {
  try {
    const source = exactRecord(sourceInput, SOURCE_KEYS);
    if (source.schemaVersion !== 'execution-preflight-draft-source.v1') throw invalid();
    const generation = exactRecord(source.generation, GENERATION_KEYS);
    const targetIntent = targetFrom(source.target);
    const simulation = simulationFrom(source.simulation);
    const walletSnapshot = walletFrom(source.walletSnapshot);
    const providerSnapshot = providerFrom(source.providerSnapshot);
    const databaseNowMs = timestamp(source.databaseNowMs);
    const readiness = readinessFrom(source.readiness);
    const reconstructedGeneration = createExecutionWalletGeneration(Object.freeze({
      walletPublicKey: generation.walletPublicKey,
      cluster: generation.cluster,
      genesisHash: generation.genesisHash,
      generation: generation.generation,
    }));
    if (reconstructedGeneration.generationId !== generation.generationId) throw invalid();
    assertSourceBindings(reconstructedGeneration, targetIntent, simulation, walletSnapshot,
      providerSnapshot, readiness, databaseNowMs);
    return Object.freeze({
      schemaVersion: 'execution-preflight-draft-source.v1', readiness,
      generation: Object.freeze({
        generationId: reconstructedGeneration.generationId,
        walletPublicKey: reconstructedGeneration.walletPublicKey,
        cluster: 'mainnet-beta',
        genesisHash: reconstructedGeneration.genesisHash,
        generation: reconstructedGeneration.generation,
      }),
      walletSnapshot,
      providerSnapshot,
      target: Object.freeze({ intent: targetIntent, leaseOwner: null,
        leaseToken: null, leaseExpiresAtMs: null }),
      simulation,
      databaseNowMs,
    });
  } catch { throw invalid(); }
}

export function createExecutionPreflightDraft(
  sourceInput: unknown,
  catalogInput: unknown,
): ExecutionPreflightBundleDraftV1 {
  try {
    const source = createExecutionPreflightDraftSource(sourceInput);
    const catalog = exactRecord(catalogInput, CATALOG_KEYS);
    if (catalog.schemaVersion !== 'execution-preflight-gate-catalog.v1') throw invalid();
    const generation = source.generation;
    const target = source.target.intent;
    const simulation = simulationFrom(source.simulation);
    const walletSnapshot = source.walletSnapshot;
    const providerSnapshot = source.providerSnapshot;
    const databaseNowMs = source.databaseNowMs;
    const policy = createExecutionRiskPolicy(catalog.policy);
    const strategyFingerprint = fingerprint(catalog.strategyFingerprint);
    const qualificationExpiresAtMs = databaseNowMs + QUALIFICATION_TTL_MS;
    const staticGates = staticGatesFrom(
      catalog.gates,
      databaseNowMs,
      qualificationExpiresAtMs,
    );
    assertPolicyFreshness(walletSnapshot, providerSnapshot, databaseNowMs,
      policy.walletSnapshotMaxAgeMs, policy.providerUsageMaxAgeMs);
    const mainnetSimulationFingerprint = createMainnetSimulationEvidenceFingerprint({
      artifactId: simulation.artifactId,
      resultFingerprint: simulation.resultFingerprint,
      buildHash: simulation.buildFingerprint,
      configurationFingerprint: simulation.configurationFingerprint,
      strategyFingerprint,
      walletPublicKey: generation.walletPublicKey,
      genesisHash: generation.genesisHash,
      providerId: providerSnapshot.providerId,
    });
    const gates = Object.freeze([
      ...staticGates.slice(0, 7),
      dynamicGate('PROVIDER_EXIT_CAPACITY_VERIFIED', 'PROVIDER_SNAPSHOT',
        providerSnapshot.snapshotId, providerSnapshot.snapshotFingerprint,
        providerSnapshot.measuredAtMs, qualificationExpiresAtMs),
      staticGates[7],
      dynamicGate('WALLET_CHAIN_LIMITS_VERIFIED', 'WALLET_SNAPSHOT',
        walletSnapshot.snapshotId, walletSnapshot.snapshotFingerprint,
        walletSnapshot.observedAtMs, qualificationExpiresAtMs),
      dynamicGate('MAINNET_PREFLIGHT_SIMULATED', 'MAINNET_SIMULATION_ARTIFACT',
        simulation.artifactId, mainnetSimulationFingerprint,
        simulation.recordedAtMs, qualificationExpiresAtMs),
    ]);
    const qualification = createSafetyQualification(Object.freeze({
      payloadVersion: 1,
      evaluatorVersion: 1,
      phase: 'CANARY',
      buildHash: simulation.buildFingerprint,
      configurationFingerprint: simulation.configurationFingerprint,
      strategyFingerprint,
      generationId: generation.generationId,
      walletPublicKey: generation.walletPublicKey,
      cluster: 'mainnet-beta',
      genesisHash: generation.genesisHash,
      providerId: providerSnapshot.providerId,
      qualifiedAtMs: databaseNowMs,
      expiresAtMs: qualificationExpiresAtMs,
      gates,
    }));
    const expiresAtMs = Math.min(
      qualification.expiresAtMs,
      providerSnapshot.expiresAtMs,
      providerSnapshot.measuredAtMs + policy.providerUsageMaxAgeMs,
      walletSnapshot.observedAtMs + policy.walletSnapshotMaxAgeMs,
      target.expiresAtMs,
    );
    if (expiresAtMs < databaseNowMs + MINIMUM_MARGIN_MS) throw invalid();
    const draft = Object.freeze({
      schemaVersion: 'execution-preflight-bundle-draft.v1' as const,
      readiness: source.readiness,
      qualification: without(qualification, ['qualificationId', 'qualificationFingerprint']),
      canary: Object.freeze({
        payloadVersion: 1 as const,
        targetIntentId: target.id,
        policy: without(policy, ['payloadVersion', 'policyFingerprint']),
        walletSnapshot: without(walletSnapshot,
          ['snapshotId', 'payloadVersion', 'snapshotFingerprint']),
        providerSnapshot: without(providerSnapshot,
          ['snapshotId', 'payloadVersion', 'snapshotFingerprint']),
        allEndpointsUnavailable: false as const,
        capturedAtMs: databaseNowMs,
        expiresAtMs,
      }),
    });
    createExecutionPreflightBundle(draft);
    return draft;
  } catch {
    throw invalid();
  }
}

function targetFrom(value: unknown): ExecutionIntentV1 {
  const row = exactRecord(value, TARGET_KEYS);
  if (row.leaseOwner !== null || row.leaseToken !== null || row.leaseExpiresAtMs !== null) {
    throw invalid();
  }
  assertExecutionIntent(row.intent);
  const intent = row.intent;
  if (intent.side !== 'BUY' || intent.status !== 'PENDING' || intent.attemptCount !== 0
    || intent.quoteMint !== WSOL_MINT || intent.quoteTokenProgram !== 'SPL_TOKEN'
    || intent.quoteDecimals !== 9 || intent.baseAmountRaw !== null
    || intent.quoteAmountRaw === null || intent.quoteAmountRaw === 0n) throw invalid();
  return intent;
}

function readinessFrom(value: unknown): ExecutionReadinessManifestV1 {
  const row = exactRecord(value, READINESS_KEYS);
  if (row.schemaVersion !== 'execution-readiness-bootstrap.v1'
    || row.state !== 'READINESS_EVIDENCE_COLLECTED'
    || row.canaryStatus !== 'CANARY_NOT_STARTED'
    || row.paperMainnet49Status !== 'NON_EXECUTED_NON_VALIDATED'
    || typeof row.walletLamports !== 'string'
    || !/^(?:0|[1-9][0-9]*)$/u.test(row.walletLamports)) throw invalid();
  return createExecutionReadinessManifest(Object.freeze({
    generationId: row.generationId, walletPublicKey: row.walletPublicKey,
    cluster: row.cluster, providerId: row.providerId,
    walletSnapshotId: row.walletSnapshotId,
    walletSnapshotFingerprint: row.walletSnapshotFingerprint,
    providerSnapshotId: row.providerSnapshotId,
    providerSnapshotFingerprint: row.providerSnapshotFingerprint,
    walletLamports: BigInt(row.walletLamports), tokenBalanceCount: row.tokenBalanceCount,
    observedAtMs: row.observedAtMs, expiresAtMs: row.expiresAtMs,
  }));
}

type SuccessfulExecutionSimulationArtifactV1 = ExecutionSimulationArtifactV1 & Readonly<{
  resultKind: 'SUCCESS';
  observedGenesisHash: string;
  buildFingerprint: string;
}>;

function simulationFrom(value: unknown): SuccessfulExecutionSimulationArtifactV1 {
  assertExecutionSimulationArtifact(value);
  if (value.resultKind !== 'SUCCESS' || value.observedGenesisHash === null
    || value.buildFingerprint === null) throw invalid();
  return value as SuccessfulExecutionSimulationArtifactV1;
}

function staticGatesFrom(
  value: unknown,
  nowMs: number,
  qualificationExpiresAtMs: number,
): readonly ExecutionSafetyGateEvidenceV1[] {
  if (!Array.isArray(value) || isProxy(value) || value.length !== STATIC_GATES.length) {
    throw invalid();
  }
  return Object.freeze(STATIC_GATES.map(([gateId, evidenceType], index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid();
    const row = exactRecord(descriptor.value, GATE_KEYS);
    const observedAtMs = timestamp(row.observedAtMs);
    const expiresAtMs = timestamp(row.expiresAtMs);
    if (row.payloadVersion !== 1 || row.gateId !== gateId || row.status !== 'PASSED'
      || row.evidenceType !== evidenceType || observedAtMs > nowMs
      || expiresAtMs < qualificationExpiresAtMs) throw invalid();
    return Object.freeze({ payloadVersion: 1 as const, gateId, status: 'PASSED' as const,
      evidenceType, evidenceId: text(row.evidenceId, 256),
      evidenceFingerprint: fingerprint(row.evidenceFingerprint), observedAtMs, expiresAtMs });
  }));
}

function assertSourceBindings(
  generation: Readonly<Record<(typeof GENERATION_KEYS)[number], unknown>>,
  target: ExecutionIntentV1,
  simulation: SuccessfulExecutionSimulationArtifactV1,
  wallet: ExecutionWalletSnapshotV1,
  provider: ProviderUsageSnapshotV1,
  readiness: ExecutionReadinessManifestV1,
  nowMs: number,
): void {
  if (generation.cluster !== 'mainnet-beta'
    || createExecutionWalletGeneration(Object.freeze({
      walletPublicKey: generation.walletPublicKey,
      cluster: generation.cluster,
      genesisHash: generation.genesisHash,
      generation: generation.generation,
    })).generationId !== generation.generationId
    || generation.generationId !== wallet.generationId
    || generation.walletPublicKey !== simulation.executorPublicKey
    || generation.genesisHash !== simulation.expectedGenesisHash
    || generation.genesisHash !== simulation.observedGenesisHash
    || provider.providerId !== wallet.providerId
    || provider.providerId !== simulation.providerId
    || readiness.generationId !== generation.generationId
    || readiness.walletPublicKey !== generation.walletPublicKey
    || readiness.providerId !== provider.providerId
    || readiness.walletSnapshotId !== wallet.snapshotId
    || readiness.walletSnapshotFingerprint !== wallet.snapshotFingerprint
    || readiness.providerSnapshotId !== provider.snapshotId
    || readiness.providerSnapshotFingerprint !== provider.snapshotFingerprint
    || readiness.walletLamports !== wallet.walletLamports.toString()
    || readiness.tokenBalanceCount !== wallet.tokenBalanceCount
    || readiness.observedAtMs !== wallet.observedAtMs
    || readiness.expiresAtMs !== provider.expiresAtMs
    || target.requestedAtMs > nowMs || target.expiresAtMs < nowMs + MINIMUM_MARGIN_MS
    || simulation.recordedAtMs > nowMs
    || simulation.recordedAtMs < nowMs - MAXIMUM_SIMULATION_AGE_MS
    || wallet.observedAtMs > nowMs || provider.measuredAtMs > nowMs
    || provider.expiresAtMs < nowMs + MINIMUM_MARGIN_MS) throw invalid();
}

function assertPolicyFreshness(
  wallet: ExecutionWalletSnapshotV1,
  provider: ProviderUsageSnapshotV1,
  nowMs: number,
  walletMaxAgeMs: number,
  providerMaxAgeMs: number,
): void {
  if (wallet.observedAtMs + walletMaxAgeMs < nowMs + MINIMUM_MARGIN_MS
    || provider.measuredAtMs + providerMaxAgeMs < nowMs + MINIMUM_MARGIN_MS) throw invalid();
}

function walletFrom(value: unknown): ExecutionWalletSnapshotV1 {
  const row = exactRecord(value, WALLET_SNAPSHOT_KEYS);
  const snapshot = createExecutionWalletSnapshot(pick(row, WALLET_INPUT_KEYS));
  if (row.payloadVersion !== 1 || row.snapshotId !== snapshot.snapshotId
    || row.snapshotFingerprint !== snapshot.snapshotFingerprint) throw invalid();
  return snapshot;
}

function providerFrom(value: unknown): ProviderUsageSnapshotV1 {
  const row = exactRecord(value, PROVIDER_SNAPSHOT_KEYS);
  const snapshot = createProviderUsageSnapshot(pick(row, PROVIDER_INPUT_KEYS));
  if (row.payloadVersion !== 1 || row.snapshotId !== snapshot.snapshotId
    || row.snapshotFingerprint !== snapshot.snapshotFingerprint) throw invalid();
  return snapshot;
}

function dynamicGate(
  gateId: 'PROVIDER_EXIT_CAPACITY_VERIFIED' | 'WALLET_CHAIN_LIMITS_VERIFIED'
    | 'MAINNET_PREFLIGHT_SIMULATED',
  evidenceType: 'PROVIDER_SNAPSHOT' | 'WALLET_SNAPSHOT' | 'MAINNET_SIMULATION_ARTIFACT',
  evidenceId: string,
  evidenceFingerprint: string,
  observedAtMs: number,
  expiresAtMs: number,
): ExecutionSafetyGateEvidenceV1 {
  return Object.freeze({ payloadVersion: 1, gateId, status: 'PASSED', evidenceType,
    evidenceId, evidenceFingerprint, observedAtMs, expiresAtMs });
}

function exactRecord<const Keys extends readonly string[]>(value: unknown, keys: Keys):
Readonly<Record<Keys[number], unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw invalid();
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length
    || own.some((key) => typeof key !== 'string' || !keys.includes(key))) throw invalid();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid();
    result[key] = descriptor.value;
  }
  return result as Readonly<Record<Keys[number], unknown>>;
}

function without(value: object, keys: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))));
}
function pick<const Keys extends readonly string[]>(
  value: Readonly<Record<string, unknown>>,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) result[key] = value[key];
  return result as Readonly<Record<Keys[number], unknown>>;
}
function patterned(value: unknown, pattern: RegExp, max: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max
    || !pattern.test(value)) throw invalid();
  return value;
}
function text(value: unknown, max: number): string { return patterned(value, /^[\x20-\x7E]{1,}$/u, max); }
function fingerprint(value: unknown): string { return patterned(value, /^[0-9a-f]{64}$/u, 64); }
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid();
  return value as number;
}
function timestamp(value: unknown): number { return integer(value, 0, 8_640_000_000_000_000); }
function invalid(): ExecutionPreflightDraftValidationError { return new ExecutionPreflightDraftValidationError(); }

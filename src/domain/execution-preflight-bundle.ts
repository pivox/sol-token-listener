import { isProxy } from 'node:util/types';
import {
  createExecutionCanaryEvidence,
  type ExecutionCanaryEvidenceV1,
} from './execution-canary.js';
import {
  createProviderUsageSnapshot,
} from './execution-provider-quota.js';
import {
  createExecutionReadinessManifest,
  type ExecutionReadinessManifestV1,
} from './execution-readiness.js';
import { createExecutionRiskPolicy } from './execution-risk-policy.js';
import {
  createSafetyQualification,
  type ExecutionSafetyQualificationV1,
} from './execution-safety-qualification.js';
import { createExecutionWalletSnapshot } from './execution-wallet-snapshot.js';

const DRAFT_KEYS = Object.freeze([
  'schemaVersion', 'readiness', 'qualification', 'canary',
] as const);
const READINESS_KEYS = Object.freeze([
  'schemaVersion', 'state', 'generationId', 'walletPublicKey', 'cluster',
  'providerId', 'walletSnapshotId', 'walletSnapshotFingerprint',
  'providerSnapshotId', 'providerSnapshotFingerprint', 'walletLamports',
  'tokenBalanceCount', 'observedAtMs', 'expiresAtMs', 'canaryStatus',
  'paperMainnet49Status',
] as const);
const CANARY_KEYS = Object.freeze([
  'payloadVersion', 'targetIntentId', 'policy', 'walletSnapshot',
  'providerSnapshot', 'allEndpointsUnavailable', 'capturedAtMs', 'expiresAtMs',
] as const);

export interface ExecutionPreflightCanaryDraftV1 {
  readonly payloadVersion: 1;
  readonly targetIntentId: string;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly walletSnapshot: Readonly<Record<string, unknown>>;
  readonly providerSnapshot: Readonly<Record<string, unknown>>;
  readonly allEndpointsUnavailable: false;
  readonly capturedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ExecutionPreflightBundleDraftV1 {
  readonly schemaVersion: 'execution-preflight-bundle-draft.v1';
  readonly readiness: ExecutionReadinessManifestV1;
  readonly qualification: Readonly<Record<string, unknown>>;
  readonly canary: ExecutionPreflightCanaryDraftV1;
}

export interface ExecutionPreflightBundleV1 {
  readonly qualification: ExecutionSafetyQualificationV1;
  readonly canary: ExecutionCanaryEvidenceV1;
}

export class ExecutionPreflightBundleValidationError extends TypeError {
  public readonly code = 'INVALID_EXECUTION_PREFLIGHT_BUNDLE' as const;
  public constructor() {
    super('Invalid execution preflight bundle.');
    this.name = 'ExecutionPreflightBundleValidationError';
  }
}

export function createExecutionPreflightBundle(input: unknown): ExecutionPreflightBundleV1 {
  try {
    const draft = exactRecord(input, DRAFT_KEYS);
    if (draft.schemaVersion !== 'execution-preflight-bundle-draft.v1') throw invalid();
    const readiness = readinessFrom(draft.readiness);
    const qualification = createSafetyQualification(draft.qualification);
    const canaryDraft = exactRecord(draft.canary, CANARY_KEYS);
    if (canaryDraft.payloadVersion !== 1
      || canaryDraft.allEndpointsUnavailable !== false) throw invalid();
    const policy = createExecutionRiskPolicy(canaryDraft.policy);
    const walletSnapshot = createExecutionWalletSnapshot(canaryDraft.walletSnapshot);
    const providerSnapshot = createProviderUsageSnapshot(canaryDraft.providerSnapshot);
    assertReadinessBinding(readiness, qualification, walletSnapshot, providerSnapshot);
    const canary = createExecutionCanaryEvidence(Object.freeze({
      payloadVersion: 1,
      qualification,
      targetIntentId: canaryDraft.targetIntentId,
      policy,
      walletSnapshot,
      providerSnapshot,
      allEndpointsUnavailable: false,
      capturedAtMs: canaryDraft.capturedAtMs,
      expiresAtMs: canaryDraft.expiresAtMs,
    }));
    return Object.freeze({ qualification, canary });
  } catch {
    throw invalid();
  }
}

function readinessFrom(value: unknown): ExecutionReadinessManifestV1 {
  const row = exactRecord(value, READINESS_KEYS);
  if (row.schemaVersion !== 'execution-readiness-bootstrap.v1'
    || row.state !== 'READINESS_EVIDENCE_COLLECTED'
    || row.canaryStatus !== 'CANARY_NOT_STARTED'
    || row.paperMainnet49Status !== 'NON_EXECUTED_NON_VALIDATED') throw invalid();
  const walletLamports = decimalBigint(row.walletLamports);
  const manifest = createExecutionReadinessManifest(Object.freeze({
    generationId: row.generationId,
    walletPublicKey: row.walletPublicKey,
    cluster: row.cluster,
    providerId: row.providerId,
    walletSnapshotId: row.walletSnapshotId,
    walletSnapshotFingerprint: row.walletSnapshotFingerprint,
    providerSnapshotId: row.providerSnapshotId,
    providerSnapshotFingerprint: row.providerSnapshotFingerprint,
    walletLamports,
    tokenBalanceCount: row.tokenBalanceCount,
    observedAtMs: row.observedAtMs,
    expiresAtMs: row.expiresAtMs,
  }));
  return manifest;
}

function assertReadinessBinding(
  readiness: ExecutionReadinessManifestV1,
  qualification: ExecutionSafetyQualificationV1,
  walletSnapshot: ReturnType<typeof createExecutionWalletSnapshot>,
  providerSnapshot: ReturnType<typeof createProviderUsageSnapshot>,
): void {
  if (readiness.generationId !== qualification.generationId
    || readiness.walletPublicKey !== qualification.walletPublicKey
    || readiness.providerId !== qualification.providerId
    || walletSnapshot.generationId !== readiness.generationId
    || walletSnapshot.providerId !== readiness.providerId
    || walletSnapshot.snapshotId !== readiness.walletSnapshotId
    || walletSnapshot.snapshotFingerprint !== readiness.walletSnapshotFingerprint
    || walletSnapshot.walletLamports.toString() !== readiness.walletLamports
    || walletSnapshot.tokenBalanceCount !== readiness.tokenBalanceCount
    || walletSnapshot.observedAtMs !== readiness.observedAtMs
    || providerSnapshot.providerId !== readiness.providerId
    || providerSnapshot.snapshotId !== readiness.providerSnapshotId
    || providerSnapshot.snapshotFingerprint !== readiness.providerSnapshotFingerprint
    || providerSnapshot.expiresAtMs !== readiness.expiresAtMs) throw invalid();
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || isProxy(value)) throw invalid();
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

function decimalBigint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw invalid();
  return BigInt(value);
}

function invalid(): ExecutionPreflightBundleValidationError {
  return new ExecutionPreflightBundleValidationError();
}

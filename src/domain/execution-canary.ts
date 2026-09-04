import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { createExecutionRiskPolicy, type ExecutionRiskPolicyV1 } from './execution-risk-policy.js';
import { createProviderUsageSnapshot, type ProviderUsageSnapshotV1 } from './execution-provider-quota.js';
import { createSafetyQualification, type ExecutionSafetyQualificationV1 } from './execution-safety-qualification.js';
import { assertExecutionWalletSnapshot, createExecutionWalletSnapshot, type ExecutionWalletSnapshotV1 } from './execution-wallet-snapshot.js';

const INPUT_KEYS = Object.freeze(['payloadVersion', 'qualification', 'targetIntentId', 'policy', 'walletSnapshot', 'providerSnapshot', 'allEndpointsUnavailable', 'capturedAtMs', 'expiresAtMs'] as const);
const DATE_MAX_MS = 8_640_000_000_000_000;

export interface ExecutionCanaryEvidenceV1 {
  readonly evidenceId: string;
  readonly payloadVersion: 1;
  readonly evidenceFingerprint: string;
  readonly qualification: ExecutionSafetyQualificationV1;
  readonly targetIntentId: string;
  readonly policy: ExecutionRiskPolicyV1;
  readonly walletSnapshot: ExecutionWalletSnapshotV1;
  readonly providerSnapshot: ProviderUsageSnapshotV1;
  readonly allEndpointsUnavailable: false;
  readonly capturedAtMs: number;
  readonly expiresAtMs: number;
}
export class ExecutionCanaryValidationError extends TypeError { public constructor() { super('Invalid execution canary evidence.'); this.name = 'ExecutionCanaryValidationError'; } }

export function createExecutionCanaryEvidence(input: unknown): ExecutionCanaryEvidenceV1 {
  try {
    const row = exactRecord(input, INPUT_KEYS);
    if (row.payloadVersion !== 1 || row.allEndpointsUnavailable !== false) throw invalid();
    const qualification = qualificationFrom(row.qualification);
    const policy = policyFrom(row.policy);
    const walletSnapshot = walletFrom(row.walletSnapshot);
    const providerSnapshot = providerFrom(row.providerSnapshot);
    if (qualification.phase !== 'CANARY') throw invalid();
    const targetIntentId = patterned(row.targetIntentId, /^execution_intent_[0-9a-f]{64}$/u, 81);
    const capturedAtMs = timestamp(row.capturedAtMs); const expiresAtMs = timestamp(row.expiresAtMs);
    if (capturedAtMs < qualification.qualifiedAtMs || expiresAtMs <= capturedAtMs || expiresAtMs > qualification.expiresAtMs || expiresAtMs > providerSnapshot.expiresAtMs) throw invalid();
    const walletGate = qualification.gates.find((gate) => gate.gateId === 'WALLET_CHAIN_LIMITS_VERIFIED');
    const providerGate = qualification.gates.find((gate) => gate.gateId === 'PROVIDER_EXIT_CAPACITY_VERIFIED');
    if (walletGate?.evidenceId !== walletSnapshot.snapshotId || walletGate.evidenceFingerprint !== walletSnapshot.snapshotFingerprint || providerGate?.evidenceId !== providerSnapshot.snapshotId || providerGate.evidenceFingerprint !== providerSnapshot.snapshotFingerprint) throw invalid();
    const evidenceFingerprint = hash(['execution-canary-evidence-v1', qualification.qualificationId, qualification.qualificationFingerprint, targetIntentId, policy.policyFingerprint, walletSnapshot.snapshotId, walletSnapshot.snapshotFingerprint, providerSnapshot.snapshotId, providerSnapshot.snapshotFingerprint, false, capturedAtMs, expiresAtMs]);
    return Object.freeze({ evidenceId: `execution_canary_evidence_${evidenceFingerprint}`, payloadVersion: 1, evidenceFingerprint, qualification, targetIntentId, policy, walletSnapshot, providerSnapshot, allEndpointsUnavailable: false, capturedAtMs, expiresAtMs });
  } catch { throw invalid(); }
}
function qualificationFrom(value: unknown): ExecutionSafetyQualificationV1 { if (!Object.isFrozen(value) || typeof value !== 'object' || value === null) throw invalid(); const row = value as Record<string, unknown>; const { qualificationId, qualificationFingerprint, ...input } = row; const q = createSafetyQualification(input); if (qualificationId !== q.qualificationId || qualificationFingerprint !== q.qualificationFingerprint) throw invalid(); return q; }
function policyFrom(value: unknown): ExecutionRiskPolicyV1 { if (!Object.isFrozen(value) || typeof value !== 'object' || value === null) throw invalid(); const row = value as Record<string, unknown>; const { payloadVersion, policyFingerprint, ...input } = row; const p = createExecutionRiskPolicy(input); if (payloadVersion !== 1 || policyFingerprint !== p.policyFingerprint) throw invalid(); return p; }
function walletFrom(value: unknown): ExecutionWalletSnapshotV1 { assertExecutionWalletSnapshot(value); const row = value as unknown as Record<string, unknown>; return createExecutionWalletSnapshot({ generationId: row.generationId, providerId: row.providerId, stateRevision: row.stateRevision, slot: row.slot, blockTimeMs: row.blockTimeMs, observedAtMs: row.observedAtMs, commitment: row.commitment, walletLamports: row.walletLamports, tokenBalanceCount: row.tokenBalanceCount, openPositions: row.openPositions, realizedNetPnlRaw: row.realizedNetPnlRaw }); }
function providerFrom(value: unknown): ProviderUsageSnapshotV1 { if (!Object.isFrozen(value) || typeof value !== 'object' || value === null) throw invalid(); const row = value as Record<string, unknown>; const { snapshotId, payloadVersion, snapshotFingerprint, ...input } = row; const p = createProviderUsageSnapshot(input); if (payloadVersion !== 1 || snapshotId !== p.snapshotId || snapshotFingerprint !== p.snapshotFingerprint) throw invalid(); return p; }
function exactRecord<const Keys extends readonly string[]>(value: unknown, keys: Keys): Readonly<Record<Keys[number], unknown>> { if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) throw invalid(); const own = Reflect.ownKeys(value); if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) throw invalid(); const result = Object.create(null) as Record<string, unknown>; for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid(); result[key] = descriptor.value; } return result as Readonly<Record<Keys[number], unknown>>; }
function patterned(value: unknown, pattern: RegExp, max: number): string { if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max || !pattern.test(value)) throw invalid(); return value; }
function timestamp(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > DATE_MAX_MS) throw invalid(); return value as number; }
function hash(value: readonly unknown[]): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function invalid(): ExecutionCanaryValidationError { return new ExecutionCanaryValidationError(); }

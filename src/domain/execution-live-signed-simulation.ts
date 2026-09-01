import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { SignedTransactionArtifactV1 } from './execution-live.js';

interface SuccessfulUnsignedSimulationEvidenceV1 {
  readonly outcome: 'SUCCESS';
  readonly snapshotFingerprint: string;
  readonly buildFingerprint: string;
  readonly messageHash: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly blockhashContextSlot: bigint;
  readonly feeContextSlot: bigint;
  readonly estimatedFeeLamports: bigint;
  readonly simulationSlot: bigint;
  readonly simulatedFeePayerLamportDebit: bigint;
  readonly unitsConsumed: bigint;
  readonly simulatedBaseDeltaRaw: bigint;
  readonly simulatedQuoteDeltaRaw: bigint;
  readonly logsFingerprint: string;
  readonly logsLineCount: number;
}

export interface ExecutionLiveUnsignedSimulationEvidenceIdentityV1 {
  readonly evidenceId: string;
  readonly evidenceFingerprint: string;
}

export interface ExecutionLiveSignedSimulationEvidenceInputV1 {
  readonly payloadVersion: 1;
  readonly artifactId: string;
  readonly unsignedSimulationEvidenceId: string;
  readonly signedTransactionHash: string;
  readonly providerId: string;
  readonly simulationSlot: bigint;
  readonly unitsConsumed: bigint;
  readonly feePayerLamportDebit: bigint;
  readonly baseDeltaRaw: bigint;
  readonly quoteDeltaRaw: bigint;
  readonly logsFingerprint: string;
  readonly logsLineCount: number;
  readonly observedAtMs: number;
}

export interface ExecutionLiveSignedSimulationEvidenceV1
  extends ExecutionLiveSignedSimulationEvidenceInputV1 {
  readonly evidenceFingerprint: string;
}

const INPUT_KEYS = Object.freeze([
  'payloadVersion', 'artifactId', 'unsignedSimulationEvidenceId',
  'signedTransactionHash', 'providerId', 'simulationSlot', 'unitsConsumed',
  'feePayerLamportDebit', 'baseDeltaRaw', 'quoteDeltaRaw', 'logsFingerprint',
  'logsLineCount', 'observedAtMs',
] as const);
const EVIDENCE_KEYS = Object.freeze([...INPUT_KEYS, 'evidenceFingerprint'] as const);
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export function createExecutionLiveSignedSimulationEvidence(
  value: unknown,
): ExecutionLiveSignedSimulationEvidenceV1 {
  const input = inputFrom(value, INPUT_KEYS);
  const evidenceFingerprint = evidenceFingerprintFor(input);
  return Object.freeze({ ...input, evidenceFingerprint });
}

export function createExecutionLiveUnsignedSimulationEvidenceIdentity(
  artifact: SignedTransactionArtifactV1,
  simulation: SuccessfulUnsignedSimulationEvidenceV1,
): ExecutionLiveUnsignedSimulationEvidenceIdentityV1 {
  const evidenceFingerprint = fingerprint([
    'execution-live-unsigned-simulation-evidence-v1', artifact.artifactId,
    artifact.intentId, String(artifact.attemptNumber), artifact.providerId,
    simulation.outcome, simulation.snapshotFingerprint, simulation.buildFingerprint,
    simulation.messageHash, simulation.blockhash, simulation.lastValidBlockHeight.toString(),
    simulation.blockhashContextSlot.toString(), simulation.feeContextSlot.toString(),
    simulation.estimatedFeeLamports.toString(), simulation.simulationSlot.toString(),
    simulation.simulatedFeePayerLamportDebit.toString(), simulation.unitsConsumed.toString(),
    simulation.simulatedBaseDeltaRaw.toString(), simulation.simulatedQuoteDeltaRaw.toString(),
    simulation.logsFingerprint, String(simulation.logsLineCount),
  ]);
  return Object.freeze({
    evidenceId: `execution_live_unsigned_simulation_evidence_${evidenceFingerprint}`,
    evidenceFingerprint,
  });
}

export function assertExecutionLiveSignedSimulationEvidence(
  value: unknown,
): asserts value is ExecutionLiveSignedSimulationEvidenceV1 {
  const record = exactRecord(value, EVIDENCE_KEYS);
  const input = inputFrom(record, EVIDENCE_KEYS);
  if (record.evidenceFingerprint !== evidenceFingerprintFor(input)) invalid();
}

function inputFrom(
  value: unknown,
  expectedKeys: readonly string[],
): ExecutionLiveSignedSimulationEvidenceInputV1 {
  const record = exactRecord(value, expectedKeys);
  if (record.payloadVersion !== 1
    || typeof record.artifactId !== 'string'
    || !/^execution_signed_transaction_[0-9a-f]{64}$/u.test(record.artifactId)
    || typeof record.unsignedSimulationEvidenceId !== 'string'
    || !/^execution_live_unsigned_simulation_evidence_[0-9a-f]{64}$/u
      .test(record.unsignedSimulationEvidenceId)
    || !hashText(record.signedTransactionHash)
    || typeof record.providerId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(record.providerId)
    || !u64(record.simulationSlot) || !positiveU64(record.unitsConsumed)
    || !u64(record.feePayerLamportDebit)
    || !i64(record.baseDeltaRaw) || !i64(record.quoteDeltaRaw)
    || !hashText(record.logsFingerprint)
    || typeof record.logsLineCount !== 'number'
    || !Number.isSafeInteger(record.logsLineCount)
    || record.logsLineCount < 0 || record.logsLineCount > 256
    || typeof record.observedAtMs !== 'number'
    || !Number.isSafeInteger(record.observedAtMs) || record.observedAtMs < 0) invalid();
  return Object.freeze({
    payloadVersion: 1,
    artifactId: record.artifactId,
    unsignedSimulationEvidenceId: record.unsignedSimulationEvidenceId,
    signedTransactionHash: record.signedTransactionHash,
    providerId: record.providerId,
    simulationSlot: record.simulationSlot,
    unitsConsumed: record.unitsConsumed,
    feePayerLamportDebit: record.feePayerLamportDebit,
    baseDeltaRaw: record.baseDeltaRaw,
    quoteDeltaRaw: record.quoteDeltaRaw,
    logsFingerprint: record.logsFingerprint,
    logsLineCount: record.logsLineCount,
    observedAtMs: record.observedAtMs,
  });
}

function evidenceFingerprintFor(input: ExecutionLiveSignedSimulationEvidenceInputV1): string {
  return fingerprint([
    'execution-live-signed-simulation-evidence-v1', String(input.payloadVersion),
    input.artifactId, input.unsignedSimulationEvidenceId, input.signedTransactionHash,
    input.providerId, input.simulationSlot.toString(), input.unitsConsumed.toString(),
    input.feePayerLamportDebit.toString(), input.baseDeltaRaw.toString(),
    input.quoteDeltaRaw.toString(), input.logsFingerprint, String(input.logsLineCount),
    String(input.observedAtMs),
  ]);
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string') || actual.length !== keys.length
    || keys.some((key) => !actual.includes(key))) invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function fingerprint(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest('hex');
}

function hashText(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}
function u64(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= U64_MAX;
}
function positiveU64(value: unknown): value is bigint { return u64(value) && value > 0n; }
function i64(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= I64_MIN && value <= I64_MAX;
}
function invalid(): never { throw new TypeError('Invalid signed simulation evidence.'); }

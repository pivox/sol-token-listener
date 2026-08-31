import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { PublicKey } from '@solana/web3.js';

const QUALIFICATION_TTL_MS = 300_000;
const DATE_MAX_MS = 8_640_000_000_000_000;
const INPUT_KEYS = Object.freeze([
  'payloadVersion', 'evaluatorVersion', 'phase', 'buildHash',
  'configurationFingerprint', 'strategyFingerprint', 'generationId',
  'walletPublicKey', 'cluster', 'genesisHash', 'providerId', 'qualifiedAtMs',
  'expiresAtMs', 'gates',
] as const);
const EVIDENCE_KEYS = Object.freeze([
  'payloadVersion', 'gateId', 'status', 'evidenceType', 'evidenceId',
  'evidenceFingerprint', 'observedAtMs', 'expiresAtMs',
] as const);
const MAINNET_SIMULATION_BINDING_KEYS = Object.freeze([
  'artifactId', 'resultFingerprint', 'buildHash', 'configurationFingerprint',
  'strategyFingerprint', 'walletPublicKey', 'genesisHash', 'providerId',
] as const);
const PHASES = Object.freeze(['CANARY', 'MICRO_LIVE', 'PILOT'] as const);

export const EXECUTION_SAFETY_GATE_IDS = Object.freeze([
  'QUALITY_GATES_PASSED',
  'MIGRATIONS_VERIFIED',
  'ARCHITECTURE_BOUNDARIES_VERIFIED',
  'DRY_RUN_RECOVERY_VERIFIED',
  'SIMULATION_MATRIX_VERIFIED',
  'FAULT_MATRIX_VERIFIED',
  'RECONCILIATION_CLEAN',
  'PROVIDER_EXIT_CAPACITY_VERIFIED',
  'STOP_CONTROLS_VERIFIED',
  'WALLET_CHAIN_LIMITS_VERIFIED',
  'MAINNET_PREFLIGHT_SIMULATED',
] as const);

const EVIDENCE_TYPES = Object.freeze([
  'CI_RUN',
  'MIGRATION_TEST',
  'ARCHITECTURE_TEST',
  'DRY_RUN_TEST',
  'SIMULATION_ARTIFACT',
  'FAULT_TEST',
  'RECONCILIATION_STATE',
  'PROVIDER_SNAPSHOT',
  'STOP_CONTROL_TEST',
  'WALLET_SNAPSHOT',
  'MAINNET_SIMULATION_ARTIFACT',
] as const);

export type ExecutionSafetyGateId = (typeof EXECUTION_SAFETY_GATE_IDS)[number];
export type ExecutionSafetyEvidenceType = (typeof EVIDENCE_TYPES)[number];
export type ExecutionLivePhase = (typeof PHASES)[number];

export interface ExecutionSafetyGateEvidenceV1 {
  readonly payloadVersion: 1;
  readonly gateId: ExecutionSafetyGateId;
  readonly status: 'PASSED';
  readonly evidenceType: ExecutionSafetyEvidenceType;
  readonly evidenceId: string;
  readonly evidenceFingerprint: string;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ExecutionSafetyQualificationV1 {
  readonly qualificationId: string;
  readonly payloadVersion: 1;
  readonly evaluatorVersion: 1;
  readonly qualificationFingerprint: string;
  readonly phase: ExecutionLivePhase;
  readonly buildHash: string;
  readonly configurationFingerprint: string;
  readonly strategyFingerprint: string;
  readonly generationId: string;
  readonly walletPublicKey: string;
  readonly cluster: 'mainnet-beta';
  readonly genesisHash: string;
  readonly providerId: string;
  readonly qualifiedAtMs: number;
  readonly expiresAtMs: number;
  readonly gates: readonly ExecutionSafetyGateEvidenceV1[];
}

export class ExecutionSafetyQualificationValidationError extends TypeError {
  public constructor() {
    super('Invalid execution safety qualification.');
    this.name = 'ExecutionSafetyQualificationValidationError';
  }
}

export function createMainnetSimulationEvidenceFingerprint(input: unknown): string {
  try {
    const record = exactRecord(input, MAINNET_SIMULATION_BINDING_KEYS);
    return hash([
      'execution-mainnet-simulation-evidence-v1',
      patternedText(
        record.artifactId,
        /^execution_simulation_artifact_[0-9a-f]{64}$/u,
        94,
      ),
      fingerprint(record.resultFingerprint),
      fingerprint(record.buildHash),
      fingerprint(record.configurationFingerprint),
      fingerprint(record.strategyFingerprint),
      publicKey(record.walletPublicKey),
      publicKey(record.genesisHash),
      identifier(record.providerId),
    ]);
  } catch {
    throw invalid();
  }
}

export function createSafetyQualification(input: unknown): ExecutionSafetyQualificationV1 {
  try {
    const record = exactRecord(input, INPUT_KEYS);
    if (record.payloadVersion !== 1 || record.evaluatorVersion !== 1) throw invalid();
    const phase = enumValue(record.phase, PHASES);
    const buildHash = fingerprint(record.buildHash);
    const configurationFingerprint = fingerprint(record.configurationFingerprint);
    const strategyFingerprint = fingerprint(record.strategyFingerprint);
    const generationId = patternedText(
      record.generationId,
      /^execution_wallet_generation_[0-9a-f]{64}$/u,
      96,
    );
    const walletPublicKey = publicKey(record.walletPublicKey);
    if (record.cluster !== 'mainnet-beta') throw invalid();
    const genesisHash = publicKey(record.genesisHash);
    const providerId = identifier(record.providerId);
    const qualifiedAtMs = timestamp(record.qualifiedAtMs);
    const expiresAtMs = timestamp(record.expiresAtMs);
    if (expiresAtMs - qualifiedAtMs !== QUALIFICATION_TTL_MS) throw invalid();
    const gates = evidenceFrom(record.gates, qualifiedAtMs, expiresAtMs);
    const qualificationFingerprint = hash([
      'execution-safety-qualification-v1', 1, phase, buildHash,
      configurationFingerprint, strategyFingerprint, generationId,
      walletPublicKey, 'mainnet-beta', genesisHash, providerId,
      qualifiedAtMs, expiresAtMs,
      gates.map((gate) => [
        gate.gateId, gate.status, gate.evidenceType, gate.evidenceId,
        gate.evidenceFingerprint, gate.observedAtMs, gate.expiresAtMs,
      ]),
    ]);
    return Object.freeze({
      qualificationId: `execution_safety_qualification_${qualificationFingerprint}`,
      payloadVersion: 1,
      evaluatorVersion: 1,
      qualificationFingerprint,
      phase,
      buildHash,
      configurationFingerprint,
      strategyFingerprint,
      generationId,
      walletPublicKey,
      cluster: 'mainnet-beta',
      genesisHash,
      providerId,
      qualifiedAtMs,
      expiresAtMs,
      gates,
    });
  } catch {
    throw invalid();
  }
}

function evidenceFrom(
  value: unknown,
  qualifiedAtMs: number,
  qualificationExpiresAtMs: number,
): readonly ExecutionSafetyGateEvidenceV1[] {
  if (!Array.isArray(value) || isProxy(value)
    || value.length !== EXECUTION_SAFETY_GATE_IDS.length) throw invalid();
  const result: ExecutionSafetyGateEvidenceV1[] = [];
  for (let index = 0; index < EXECUTION_SAFETY_GATE_IDS.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    const record = exactRecord(descriptor.value, EVIDENCE_KEYS);
    const gateId = EXECUTION_SAFETY_GATE_IDS[index];
    const evidenceType = EVIDENCE_TYPES[index];
    if (record.payloadVersion !== 1 || record.gateId !== gateId
      || record.status !== 'PASSED' || record.evidenceType !== evidenceType
      || gateId === undefined || evidenceType === undefined) throw invalid();
    const observedAtMs = timestamp(record.observedAtMs);
    const expiresAtMs = timestamp(record.expiresAtMs);
    if (observedAtMs > qualifiedAtMs || expiresAtMs < qualificationExpiresAtMs) throw invalid();
    result.push(Object.freeze({
      payloadVersion: 1,
      gateId,
      status: 'PASSED',
      evidenceType,
      evidenceId: patternedText(record.evidenceId, /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u, 256),
      evidenceFingerprint: fingerprint(record.evidenceFingerprint),
      observedAtMs,
      expiresAtMs,
    }));
  }
  return Object.freeze(result);
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

function fingerprint(value: unknown): string {
  return patternedText(value, /^[0-9a-f]{64}$/u, 64);
}

function identifier(value: unknown): string {
  return patternedText(value, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, 64);
}

function patternedText(value: unknown, pattern: RegExp, maximumBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes
    || !pattern.test(value)) throw invalid();
  return value;
}

function publicKey(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64) throw invalid();
  const parsed = new PublicKey(value);
  if (parsed.toBase58() !== value) throw invalid();
  return value;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0
    || (value as number) > DATE_MAX_MS) throw invalid();
  return value as number;
}

function hash(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function invalid(): ExecutionSafetyQualificationValidationError {
  return new ExecutionSafetyQualificationValidationError();
}

import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  EXECUTION_INTENT_REASON_CODES,
  type ExecutionIntentReasonCode,
} from './execution-intent.js';

export const EXECUTION_SIMULATION_PAYLOAD_VERSION = 1 as const;
export const EXECUTION_SIMULATION_SPECIFICATION_VERSION = '1.5.0' as const;
export const EXECUTION_SIMULATION_EVALUATOR_VERSION = 1 as const;

export const EXECUTION_SIMULATION_FAILURE_CODES = Object.freeze([
  'QUOTE_REJECTED',
  'BUILD_POLICY_REJECTED',
  'RPC_RATE_LIMITED',
  'RPC_TIMEOUT',
  'RPC_UNAVAILABLE',
  'RPC_RESPONSE_INVALID',
  'SIMULATION_EVIDENCE_INVALID',
  'SIMULATION_PROGRAM_ERROR',
] as const);

export type ExecutionSimulationFailureCode =
  (typeof EXECUTION_SIMULATION_FAILURE_CODES)[number];
export type ExecutionSimulationResultKind =
  | 'PROVIDER_FAILED'
  | 'QUOTE_FAILED'
  | 'BUILD_FAILED'
  | 'BLOCKHASH_FAILED'
  | 'FEE_FAILED'
  | 'SIMULATION_FAILED'
  | 'SUCCESS';
export type ExecutionSimulationStage =
  | 'PROVIDER' | 'QUOTE' | 'BUILD' | 'BLOCKHASH' | 'FEE' | 'SIMULATION';
export type ExecutionSimulationStatus = 'NOT_RUN' | 'SUCCEEDED' | 'FAILED';
export type ExecutionSimulationVenue = 'PUMP_FUN' | 'PUMP_SWAP';

export interface ExecutionSimulationArtifactInputV1 {
  readonly intentId: string;
  readonly attemptNumber: number;
  readonly intentStateRevision: bigint;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly decisionFingerprint: string;
  readonly resultKind: ExecutionSimulationResultKind;
  readonly effectiveVenue: ExecutionSimulationVenue | null;
  readonly providerId: string;
  readonly executorPublicKey: string;
  readonly expectedGenesisHash: string;
  readonly observedGenesisHash: string | null;
  readonly configurationFingerprint: string;
  readonly quoteFingerprint: string | null;
  readonly snapshotFingerprint: string | null;
  readonly buildFingerprint: string | null;
  readonly messageHash: string | null;
  readonly blockhash: string | null;
  readonly lastValidBlockHeight: bigint | null;
  readonly blockhashContextSlot: bigint | null;
  readonly snapshotSlot: bigint | null;
  readonly feeContextSlot: bigint | null;
  readonly simulationSlot: bigint | null;
  readonly amountInRaw: bigint | null;
  readonly expectedAmountOutRaw: bigint | null;
  readonly protectedAmountOutRaw: bigint | null;
  readonly feesRaw: bigint | null;
  readonly estimatedFeeLamports: bigint | null;
  readonly simulatedFeePayerLamportDebit: bigint | null;
  readonly unitsConsumed: bigint | null;
  readonly simulatedBaseDeltaRaw: bigint | null;
  readonly simulatedQuoteDeltaRaw: bigint | null;
  readonly rpcCallsUsed: number;
  readonly rpcCallsLimit: number;
  readonly quoteStatus: ExecutionSimulationStatus;
  readonly buildStatus: ExecutionSimulationStatus;
  readonly simulationStatus: ExecutionSimulationStatus;
  readonly failureStage: ExecutionSimulationStage | null;
  readonly failureCode: ExecutionSimulationFailureCode | null;
  readonly terminalReasonCode: ExecutionIntentReasonCode;
  readonly logsFingerprint: string | null;
  readonly logsLineCount: number | null;
}

export interface ExecutionSimulationArtifactDraftV1
  extends ExecutionSimulationArtifactInputV1 {
  readonly artifactId: string;
  readonly payloadVersion: 1;
  readonly specificationVersion: '1.5.0';
  readonly evaluatorVersion: 1;
  readonly resultFingerprint: string;
}

export interface ExecutionSimulationArtifactV1
  extends ExecutionSimulationArtifactDraftV1 {
  readonly recordedAtMs: number;
}

export class ExecutionSimulationValidationError extends TypeError {
  public constructor() {
    super('Invalid execution simulation artifact.');
    this.name = 'ExecutionSimulationValidationError';
  }
}

const INT32_MAX = 2_147_483_647;
const INT64_MAX = 9_223_372_036_854_775_807n;
const DATE_MAX_MS = 8_640_000_000_000_000;
const U64_MAX = 18_446_744_073_709_551_615n;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const INPUT_KEYS = Object.freeze([
  'intentId', 'attemptNumber', 'intentStateRevision', 'strategyId', 'strategyVersion',
  'decisionFingerprint', 'resultKind', 'effectiveVenue', 'providerId', 'executorPublicKey',
  'expectedGenesisHash', 'observedGenesisHash', 'configurationFingerprint',
  'quoteFingerprint', 'snapshotFingerprint', 'buildFingerprint', 'messageHash', 'blockhash',
  'lastValidBlockHeight', 'blockhashContextSlot', 'snapshotSlot', 'feeContextSlot',
  'simulationSlot', 'amountInRaw', 'expectedAmountOutRaw', 'protectedAmountOutRaw', 'feesRaw',
  'estimatedFeeLamports', 'simulatedFeePayerLamportDebit', 'unitsConsumed',
  'simulatedBaseDeltaRaw', 'simulatedQuoteDeltaRaw', 'rpcCallsUsed', 'rpcCallsLimit',
  'quoteStatus', 'buildStatus', 'simulationStatus', 'failureStage', 'failureCode',
  'terminalReasonCode', 'logsFingerprint', 'logsLineCount',
] as const);

const DRAFT_KEYS = Object.freeze([
  'artifactId', 'payloadVersion', 'specificationVersion', 'evaluatorVersion',
  ...INPUT_KEYS, 'resultFingerprint',
] as const);
const ARTIFACT_KEYS = Object.freeze([...DRAFT_KEYS, 'recordedAtMs'] as const);

const RESULT_KINDS = Object.freeze([
  'PROVIDER_FAILED', 'QUOTE_FAILED', 'BUILD_FAILED', 'BLOCKHASH_FAILED', 'FEE_FAILED',
  'SIMULATION_FAILED', 'SUCCESS',
] as const);
const STATUSES = Object.freeze(['NOT_RUN', 'SUCCEEDED', 'FAILED'] as const);
const STAGES = Object.freeze(['PROVIDER', 'QUOTE', 'BUILD', 'BLOCKHASH', 'FEE', 'SIMULATION'] as const);
const VENUES = Object.freeze(['PUMP_FUN', 'PUMP_SWAP'] as const);

export function createExecutionSimulationArtifactDraft(
  input: unknown,
): ExecutionSimulationArtifactDraftV1 {
  try {
    const fields = inputFrom(input);
    const artifactId = artifactIdFor(fields.intentId, fields.attemptNumber);
    const withoutResult = {
      artifactId,
      payloadVersion: EXECUTION_SIMULATION_PAYLOAD_VERSION,
      specificationVersion: EXECUTION_SIMULATION_SPECIFICATION_VERSION,
      evaluatorVersion: EXECUTION_SIMULATION_EVALUATOR_VERSION,
      ...fields,
    } as const;
    const draft = {
      ...withoutResult,
      resultFingerprint: resultFingerprintFor(withoutResult),
    } as const;
    return Object.freeze(draft);
  } catch {
    throw invalid();
  }
}

export function createExecutionSimulationArtifact(
  draftValue: unknown,
  recordedAtMsValue: unknown,
): ExecutionSimulationArtifactV1 {
  try {
    const draft = draftFrom(draftValue, true);
    const recordedAtMs = timestampFrom(recordedAtMsValue);
    return Object.freeze({ ...draft, recordedAtMs });
  } catch {
    throw invalid();
  }
}

export function assertExecutionSimulationArtifactDraft(
  value: unknown,
): asserts value is ExecutionSimulationArtifactDraftV1 {
  try {
    void draftFrom(value, true);
  } catch {
    throw invalid();
  }
}

export function assertExecutionSimulationArtifact(
  value: unknown,
): asserts value is ExecutionSimulationArtifactV1 {
  try {
    if (!isFrozenObject(value)) throw invalid();
    const record = ownEnumerableDataRecord(value, ARTIFACT_KEYS);
    void draftFrom(Object.freeze(pick(record, DRAFT_KEYS)), true);
    void timestampFrom(record.recordedAtMs);
  } catch {
    throw invalid();
  }
}

function draftFrom(value: unknown, requireFrozen: boolean): ExecutionSimulationArtifactDraftV1 {
  if (requireFrozen && !isFrozenObject(value)) throw invalid();
  const record = ownEnumerableDataRecord(value, DRAFT_KEYS);
  if (record.payloadVersion !== EXECUTION_SIMULATION_PAYLOAD_VERSION
    || record.specificationVersion !== EXECUTION_SIMULATION_SPECIFICATION_VERSION
    || record.evaluatorVersion !== EXECUTION_SIMULATION_EVALUATOR_VERSION) throw invalid();
  const fields = inputFrom(Object.freeze(pick(record, INPUT_KEYS)));
  const artifactId = artifactIdFrom(record.artifactId);
  const resultFingerprint = fingerprintFrom(record.resultFingerprint);
  if (artifactId !== artifactIdFor(fields.intentId, fields.attemptNumber)) throw invalid();
  const withoutResult = {
    artifactId,
    payloadVersion: EXECUTION_SIMULATION_PAYLOAD_VERSION,
    specificationVersion: EXECUTION_SIMULATION_SPECIFICATION_VERSION,
    evaluatorVersion: EXECUTION_SIMULATION_EVALUATOR_VERSION,
    ...fields,
  } as const;
  if (resultFingerprint !== resultFingerprintFor(withoutResult)) throw invalid();
  return Object.freeze({ ...withoutResult, resultFingerprint });
}

function inputFrom(value: unknown): ExecutionSimulationArtifactInputV1 {
  const record = ownEnumerableDataRecord(value, INPUT_KEYS);
  const result: ExecutionSimulationArtifactInputV1 = {
    intentId: intentIdFrom(record.intentId),
    attemptNumber: positiveIntegerFrom(record.attemptNumber),
    intentStateRevision: stateRevisionFrom(record.intentStateRevision),
    strategyId: textFrom(record.strategyId),
    strategyVersion: positiveIntegerFrom(record.strategyVersion),
    decisionFingerprint: fingerprintFrom(record.decisionFingerprint),
    resultKind: enumFrom(record.resultKind, RESULT_KINDS),
    effectiveVenue: nullableEnumFrom(record.effectiveVenue, VENUES),
    providerId: textFrom(record.providerId),
    executorPublicKey: publicKeyFrom(record.executorPublicKey),
    expectedGenesisHash: publicKeyFrom(record.expectedGenesisHash),
    observedGenesisHash: nullablePublicKeyFrom(record.observedGenesisHash),
    configurationFingerprint: fingerprintFrom(record.configurationFingerprint),
    quoteFingerprint: nullableFingerprintFrom(record.quoteFingerprint),
    snapshotFingerprint: nullableFingerprintFrom(record.snapshotFingerprint),
    buildFingerprint: nullableFingerprintFrom(record.buildFingerprint),
    messageHash: nullableFingerprintFrom(record.messageHash),
    blockhash: nullablePublicKeyFrom(record.blockhash),
    lastValidBlockHeight: nullableNonNegativeInt64From(record.lastValidBlockHeight),
    blockhashContextSlot: nullableNonNegativeInt64From(record.blockhashContextSlot),
    snapshotSlot: nullableNonNegativeInt64From(record.snapshotSlot),
    feeContextSlot: nullableNonNegativeInt64From(record.feeContextSlot),
    simulationSlot: nullableNonNegativeInt64From(record.simulationSlot),
    amountInRaw: nullablePositiveU64From(record.amountInRaw),
    expectedAmountOutRaw: nullablePositiveU64From(record.expectedAmountOutRaw),
    protectedAmountOutRaw: nullablePositiveU64From(record.protectedAmountOutRaw),
    feesRaw: nullableU64From(record.feesRaw),
    estimatedFeeLamports: nullableU64From(record.estimatedFeeLamports),
    simulatedFeePayerLamportDebit: nullableU64From(record.simulatedFeePayerLamportDebit),
    unitsConsumed: nullablePositiveU64From(record.unitsConsumed),
    simulatedBaseDeltaRaw: nullableSignedU64From(record.simulatedBaseDeltaRaw),
    simulatedQuoteDeltaRaw: nullableSignedU64From(record.simulatedQuoteDeltaRaw),
    rpcCallsUsed: nonNegativeIntegerFrom(record.rpcCallsUsed),
    rpcCallsLimit: positiveIntegerFrom(record.rpcCallsLimit),
    quoteStatus: enumFrom(record.quoteStatus, STATUSES),
    buildStatus: enumFrom(record.buildStatus, STATUSES),
    simulationStatus: enumFrom(record.simulationStatus, STATUSES),
    failureStage: nullableEnumFrom(record.failureStage, STAGES),
    failureCode: nullableEnumFrom(record.failureCode, EXECUTION_SIMULATION_FAILURE_CODES),
    terminalReasonCode: reasonCodeFrom(record.terminalReasonCode),
    logsFingerprint: nullableFingerprintFrom(record.logsFingerprint),
    logsLineCount: nullablePositiveIntegerFrom(record.logsLineCount),
  };
  validateCausalFields(result);
  validateResultShape(result);
  return Object.freeze(result);
}

function validateCausalFields(value: ExecutionSimulationArtifactInputV1): void {
  if (value.rpcCallsUsed > value.rpcCallsLimit) throw invalid();
  if ((value.logsFingerprint === null) !== (value.logsLineCount === null)) throw invalid();
  if ((value.snapshotFingerprint === null) !== (value.snapshotSlot === null)) throw invalid();
  if (value.protectedAmountOutRaw !== null && value.expectedAmountOutRaw !== null
    && value.protectedAmountOutRaw > value.expectedAmountOutRaw) throw invalid();
  if (value.snapshotSlot !== null && value.blockhashContextSlot !== null
    && value.blockhashContextSlot < value.snapshotSlot) throw invalid();
  if (value.snapshotSlot !== null && value.feeContextSlot !== null
    && value.feeContextSlot < value.snapshotSlot) throw invalid();
  if (value.blockhashContextSlot !== null && value.simulationSlot !== null
    && value.simulationSlot < value.blockhashContextSlot) throw invalid();
  if ((value.simulatedBaseDeltaRaw === null) !== (value.simulatedQuoteDeltaRaw === null)) {
    throw invalid();
  }
}

function validateResultShape(value: ExecutionSimulationArtifactInputV1): void {
  const quoteProof = [value.quoteFingerprint, value.snapshotFingerprint, value.snapshotSlot,
    value.amountInRaw, value.expectedAmountOutRaw, value.protectedAmountOutRaw, value.feesRaw];
  const buildProof = [value.buildFingerprint];
  const blockhashProof = [value.messageHash, value.blockhash, value.lastValidBlockHeight,
    value.blockhashContextSlot];
  const feeProof = [value.feeContextSlot, value.estimatedFeeLamports];
  const simulationProof = [value.simulationSlot, value.simulatedFeePayerLamportDebit,
    value.unitsConsumed, value.simulatedBaseDeltaRaw, value.simulatedQuoteDeltaRaw,
    value.logsFingerprint, value.logsLineCount];

  switch (value.resultKind) {
    case 'PROVIDER_FAILED':
      expectStatuses(value, 'FAILED', 'NOT_RUN', 'NOT_RUN', 'PROVIDER');
      expectAllNull([...quoteProof, ...buildProof, ...blockhashProof, ...feeProof, ...simulationProof]);
      if (value.effectiveVenue !== null || value.observedGenesisHash !== null) throw invalid();
      break;
    case 'QUOTE_FAILED':
      expectStatuses(value, 'FAILED', 'NOT_RUN', 'NOT_RUN', 'QUOTE');
      expectAllNull([value.quoteFingerprint, value.amountInRaw, value.expectedAmountOutRaw,
        value.protectedAmountOutRaw, value.feesRaw, ...buildProof, ...blockhashProof,
        ...feeProof, ...simulationProof]);
      if (value.observedGenesisHash === null) throw invalid();
      break;
    case 'BUILD_FAILED':
      expectStatuses(value, 'SUCCEEDED', 'FAILED', 'NOT_RUN', 'BUILD');
      expectAllPresent(quoteProof);
      expectAllNull([...buildProof, ...blockhashProof, ...feeProof, ...simulationProof]);
      requireVenueAndGenesis(value);
      break;
    case 'BLOCKHASH_FAILED':
      expectStatuses(value, 'SUCCEEDED', 'SUCCEEDED', 'NOT_RUN', 'BLOCKHASH');
      expectAllPresent([...quoteProof, ...buildProof]);
      expectAllNull([...blockhashProof, ...feeProof, ...simulationProof]);
      requireVenueAndGenesis(value);
      break;
    case 'FEE_FAILED':
      expectStatuses(value, 'SUCCEEDED', 'SUCCEEDED', 'NOT_RUN', 'FEE');
      expectAllPresent([...quoteProof, ...buildProof, ...blockhashProof]);
      expectAllNull([...feeProof, ...simulationProof]);
      requireVenueAndGenesis(value);
      break;
    case 'SIMULATION_FAILED':
      expectStatuses(value, 'SUCCEEDED', 'SUCCEEDED', 'FAILED', 'SIMULATION');
      expectAllPresent([...quoteProof, ...buildProof, ...blockhashProof, ...feeProof]);
      requireVenueAndGenesis(value);
      break;
    case 'SUCCESS':
      expectStatuses(value, 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', null);
      expectAllPresent([...quoteProof, ...buildProof, ...blockhashProof, ...feeProof,
        ...simulationProof]);
      requireVenueAndGenesis(value);
      if (value.failureCode !== null || value.terminalReasonCode !== 'INTENT_SUCCEEDED') {
        throw invalid();
      }
      return;
  }
  if (value.failureCode === null) throw invalid();
  validateFailureMapping(value.failureCode, value.failureStage, value.terminalReasonCode);
}

function validateFailureMapping(
  code: ExecutionSimulationFailureCode,
  stage: ExecutionSimulationStage | null,
  reason: ExecutionIntentReasonCode,
): void {
  if (stage === null) throw invalid();
  const providerCodes: readonly ExecutionSimulationFailureCode[] = [
    'RPC_RATE_LIMITED', 'RPC_TIMEOUT', 'RPC_UNAVAILABLE',
  ];
  if (providerCodes.includes(code)) {
    if (reason !== 'EXECUTION_PROVIDER_FAILED') throw invalid();
    return;
  }
  if (code === 'RPC_RESPONSE_INVALID' || code === 'SIMULATION_EVIDENCE_INVALID') {
    if (reason !== 'EXECUTION_EVIDENCE_INVALID') throw invalid();
    return;
  }
  if (code === 'BUILD_POLICY_REJECTED') {
    if (stage !== 'BUILD' || reason !== 'EXECUTION_BUILD_FAILED') throw invalid();
    return;
  }
  if (code === 'SIMULATION_PROGRAM_ERROR') {
    if (stage !== 'SIMULATION'
      || (reason !== 'BUY_SIMULATION_FAILED' && reason !== 'SELL_SIMULATION_FAILED')) throw invalid();
    return;
  }
  const quoteReasons: readonly ExecutionIntentReasonCode[] = [
    'QUOTE_STALE', 'QUOTE_MINT_NOT_ALLOWED', 'VENUE_UNAVAILABLE',
    'SELL_QUOTE_UNAVAILABLE', 'MINIMUM_AMOUNT_OUT_VIOLATED', 'UNSUPPORTED_TOKEN_EXTENSION',
  ];
  if (code !== 'QUOTE_REJECTED' || stage !== 'QUOTE' || !quoteReasons.includes(reason)) {
    throw invalid();
  }
}

function expectStatuses(
  value: ExecutionSimulationArtifactInputV1,
  quote: ExecutionSimulationStatus,
  build: ExecutionSimulationStatus,
  simulation: ExecutionSimulationStatus,
  stage: ExecutionSimulationStage | null,
): void {
  if (value.quoteStatus !== quote || value.buildStatus !== build
    || value.simulationStatus !== simulation || value.failureStage !== stage) throw invalid();
}

function requireVenueAndGenesis(value: ExecutionSimulationArtifactInputV1): void {
  if (value.effectiveVenue === null || value.observedGenesisHash === null) throw invalid();
}

function expectAllNull(values: readonly unknown[]): void {
  if (values.some((value) => value !== null)) throw invalid();
}

function expectAllPresent(values: readonly unknown[]): void {
  if (values.some((value) => value === null)) throw invalid();
}

function artifactIdFor(intentId: string, attemptNumber: number): string {
  return `execution_simulation_artifact_${hash([
    'execution-simulation-artifact-id-v1', intentId, String(attemptNumber),
  ])}`;
}

function resultFingerprintFor(
  value: Omit<ExecutionSimulationArtifactDraftV1, 'resultFingerprint'>,
): string {
  const segments = ['execution-simulation-result-v1'];
  for (const key of DRAFT_KEYS) {
    if (key === 'artifactId' || key === 'resultFingerprint') continue;
    segments.push(scalarSegment(value[key]));
  }
  return hash(segments);
}

function scalarSegment(value: unknown): string {
  if (value === null) return '~';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  throw invalid();
}

function ownEnumerableDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      throw invalid();
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length) throw invalid();
    const result: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      if (!keys.includes(key)) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw invalid();
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw invalid();
  }
}

function pick(record: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) result[key] = record[key];
  return result;
}

function enumFrom<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (!values.includes(value as string)) throw invalid();
  return value as T[number];
}

function nullableEnumFrom<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] | null {
  return value === null ? null : enumFrom(value, values);
}

function textFrom(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 256) {
    throw invalid();
  }
  return value;
}

function intentIdFrom(value: unknown): string {
  const id = textFrom(value);
  if (!/^execution_intent_[0-9a-f]{64}$/u.test(id)) throw invalid();
  return id;
}

function artifactIdFrom(value: unknown): string {
  const id = textFrom(value);
  if (!/^execution_simulation_artifact_[0-9a-f]{64}$/u.test(id)) throw invalid();
  return id;
}

function fingerprintFrom(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalid();
  return value;
}

function nullableFingerprintFrom(value: unknown): string | null {
  return value === null ? null : fingerprintFrom(value);
}

function publicKeyFrom(value: unknown): string {
  const key = textFrom(value);
  if (!isCanonicalBase58PublicKey(key)) throw invalid();
  return key;
}

function nullablePublicKeyFrom(value: unknown): string | null {
  return value === null ? null : publicKeyFrom(value);
}

function positiveIntegerFrom(value: unknown): number {
  return boundedIntegerFrom(value, 1, INT32_MAX);
}

function nonNegativeIntegerFrom(value: unknown): number {
  return boundedIntegerFrom(value, 0, INT32_MAX);
}

function nullablePositiveIntegerFrom(value: unknown): number | null {
  return value === null ? null : positiveIntegerFrom(value);
}

function timestampFrom(value: unknown): number {
  return boundedIntegerFrom(value, 0, DATE_MAX_MS);
}

function boundedIntegerFrom(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum
    || (value as number) > maximum || Object.is(value, -0)) throw invalid();
  return value as number;
}

function stateRevisionFrom(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > INT64_MAX) throw invalid();
  return value;
}

function nullableNonNegativeInt64From(value: unknown): bigint | null {
  if (value === null) return null;
  if (typeof value !== 'bigint' || value < 0n || value > INT64_MAX) throw invalid();
  return value;
}

function nullableU64From(value: unknown): bigint | null {
  if (value === null) return null;
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw invalid();
  return value;
}

function nullablePositiveU64From(value: unknown): bigint | null {
  const parsed = nullableU64From(value);
  if (parsed === 0n) throw invalid();
  return parsed;
}

function nullableSignedU64From(value: unknown): bigint | null {
  if (value === null) return null;
  if (typeof value !== 'bigint' || value < -U64_MAX || value > U64_MAX) throw invalid();
  return value;
}

function reasonCodeFrom(value: unknown): ExecutionIntentReasonCode {
  if (!(EXECUTION_INTENT_REASON_CODES as readonly unknown[]).includes(value)) throw invalid();
  return value as ExecutionIntentReasonCode;
}

function isCanonicalBase58PublicKey(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let encodedByteLength = 0;
  while (decoded > 0n) {
    encodedByteLength += 1;
    decoded >>= 8n;
  }
  let leadingZeroByteLength = 0;
  while (value.charAt(leadingZeroByteLength) === '1') leadingZeroByteLength += 1;
  return encodedByteLength + leadingZeroByteLength === 32;
}

function hash(values: readonly string[]): string {
  return createHash('sha256').update(lengthPrefixedUtf8(values)).digest('hex');
}

function lengthPrefixedUtf8(values: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

function isFrozenObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !isProxy(value) && Object.isFrozen(value);
}

function invalid(): ExecutionSimulationValidationError {
  return new ExecutionSimulationValidationError();
}

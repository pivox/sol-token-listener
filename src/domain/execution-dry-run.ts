import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { assertExecutionIntent, type ExecutionIntentV1 } from './execution-intent.js';

export const EXECUTION_DRY_RUN_PAYLOAD_VERSION = 1 as const;
export const EXECUTION_DRY_RUN_SPECIFICATION_VERSION = '1.4.0' as const;
export const EXECUTION_DRY_RUN_EVALUATOR_VERSION = 1 as const;

export interface ExecutionDryRunAssessmentDraftV1 {
  readonly assessmentId: string;
  readonly payloadVersion: 1;
  readonly specificationVersion: '1.4.0';
  readonly evaluatorVersion: 1;
  readonly intentId: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly decisionFingerprint: string;
  readonly intentStateRevision: bigint;
  readonly intentStatus: 'PENDING' | 'RETRY_READY';
  readonly inputFingerprint: string;
  readonly resultFingerprint: string;
  readonly outcome: 'FOUNDATION_VALIDATED';
  readonly coverage: 'INTENT_AND_LEASE_ONLY';
  readonly quoteStatus: 'NOT_RUN';
  readonly buildStatus: 'NOT_RUN';
  readonly simulationStatus: 'NOT_RUN';
  readonly signatureStatus: 'NOT_RUN';
  readonly submissionStatus: 'NOT_RUN';
}

export interface ExecutionDryRunAssessmentV1 extends ExecutionDryRunAssessmentDraftV1 {
  readonly recordedAtMs: number;
}

export class ExecutionDryRunValidationError extends TypeError {
  public constructor() {
    super('Invalid execution dry-run assessment.');
    this.name = 'ExecutionDryRunValidationError';
  }
}

const INT32_MAX = 2_147_483_647;
const INT64_MAX = 9_223_372_036_854_775_807n;
const DATE_MAX_MS = 8_640_000_000_000_000;
const DRAFT_KEYS = Object.freeze([
  'assessmentId', 'payloadVersion', 'specificationVersion', 'evaluatorVersion', 'intentId',
  'strategyId', 'strategyVersion', 'decisionFingerprint', 'intentStateRevision', 'intentStatus',
  'inputFingerprint', 'resultFingerprint', 'outcome', 'coverage', 'quoteStatus', 'buildStatus',
  'simulationStatus', 'signatureStatus', 'submissionStatus',
] as const);
const ASSESSMENT_KEYS = Object.freeze([...DRAFT_KEYS, 'recordedAtMs'] as const);

export function createExecutionDryRunAssessment(
  intent: ExecutionIntentV1,
): ExecutionDryRunAssessmentDraftV1 {
  try {
    assertExecutionIntent(intent);
    if (intent.status !== 'PENDING' && intent.status !== 'RETRY_READY') throw invalid();
    const inputFingerprint = hash(inputSegments(intent));
    const assessment = {
      assessmentId: `execution_dry_run_assessment_${hash([
        'execution-dry-run-assessment-id-v1', intent.id, '1',
      ])}`,
      payloadVersion: EXECUTION_DRY_RUN_PAYLOAD_VERSION,
      specificationVersion: EXECUTION_DRY_RUN_SPECIFICATION_VERSION,
      evaluatorVersion: EXECUTION_DRY_RUN_EVALUATOR_VERSION,
      intentId: intent.id,
      strategyId: intent.strategyId,
      strategyVersion: intent.strategyVersion,
      decisionFingerprint: intent.decisionFingerprint,
      intentStateRevision: intent.stateRevision,
      intentStatus: intent.status,
      inputFingerprint,
      resultFingerprint: hash([
        'execution-dry-run-result-v1', inputFingerprint,
        EXECUTION_DRY_RUN_SPECIFICATION_VERSION, String(EXECUTION_DRY_RUN_EVALUATOR_VERSION),
        'FOUNDATION_VALIDATED', 'INTENT_AND_LEASE_ONLY', 'NOT_RUN', 'NOT_RUN', 'NOT_RUN',
        'NOT_RUN', 'NOT_RUN',
      ]),
      outcome: 'FOUNDATION_VALIDATED',
      coverage: 'INTENT_AND_LEASE_ONLY',
      quoteStatus: 'NOT_RUN',
      buildStatus: 'NOT_RUN',
      simulationStatus: 'NOT_RUN',
      signatureStatus: 'NOT_RUN',
      submissionStatus: 'NOT_RUN',
    } as const;
    return Object.freeze(assessment);
  } catch {
    throw invalid();
  }
}

export function assertExecutionDryRunAssessmentDraft(
  value: unknown,
): asserts value is ExecutionDryRunAssessmentDraftV1 {
  try {
    void draftFrom(value, true);
  } catch {
    throw invalid();
  }
}

export function assertExecutionDryRunAssessment(
  value: unknown,
): asserts value is ExecutionDryRunAssessmentV1 {
  try {
    if (!isFrozenObject(value)) throw invalid();
    const record = ownEnumerableDataRecord(value, ASSESSMENT_KEYS);
    const draft = draftFrom(Object.freeze(pick(record, DRAFT_KEYS)), true);
    const recordedAtMs = timestampFrom(record.recordedAtMs);
    void Object.freeze({ ...draft, recordedAtMs });
  } catch {
    throw invalid();
  }
}

function draftFrom(value: unknown, requireFrozen: boolean): ExecutionDryRunAssessmentDraftV1 {
  if (requireFrozen && !isFrozenObject(value)) throw invalid();
  const record = ownEnumerableDataRecord(value, DRAFT_KEYS);
  if (record.payloadVersion !== EXECUTION_DRY_RUN_PAYLOAD_VERSION
    || record.specificationVersion !== EXECUTION_DRY_RUN_SPECIFICATION_VERSION
    || record.evaluatorVersion !== EXECUTION_DRY_RUN_EVALUATOR_VERSION
    || record.outcome !== 'FOUNDATION_VALIDATED'
    || record.coverage !== 'INTENT_AND_LEASE_ONLY'
    || record.quoteStatus !== 'NOT_RUN'
    || record.buildStatus !== 'NOT_RUN'
    || record.simulationStatus !== 'NOT_RUN'
    || record.signatureStatus !== 'NOT_RUN'
    || record.submissionStatus !== 'NOT_RUN') throw invalid();
  const intentId = executionIntentIdFrom(record.intentId);
  const strategyId = textFrom(record.strategyId);
  const strategyVersion = positiveIntegerFrom(record.strategyVersion);
  const decisionFingerprint = fingerprintFrom(record.decisionFingerprint);
  const intentStateRevision = stateRevisionFrom(record.intentStateRevision);
  const intentStatus = assessableStatusFrom(record.intentStatus);
  const inputFingerprint = fingerprintFrom(record.inputFingerprint);
  const resultFingerprint = fingerprintFrom(record.resultFingerprint);
  const assessmentId = assessmentIdFrom(record.assessmentId);
  if (assessmentId !== `execution_dry_run_assessment_${hash([
    'execution-dry-run-assessment-id-v1', intentId, '1',
  ])}`) throw invalid();
  if (resultFingerprint !== hash([
    'execution-dry-run-result-v1', inputFingerprint,
    EXECUTION_DRY_RUN_SPECIFICATION_VERSION, String(EXECUTION_DRY_RUN_EVALUATOR_VERSION),
    'FOUNDATION_VALIDATED', 'INTENT_AND_LEASE_ONLY', 'NOT_RUN', 'NOT_RUN', 'NOT_RUN',
    'NOT_RUN', 'NOT_RUN',
  ])) throw invalid();
  return Object.freeze({
    assessmentId, payloadVersion: EXECUTION_DRY_RUN_PAYLOAD_VERSION,
    specificationVersion: EXECUTION_DRY_RUN_SPECIFICATION_VERSION,
    evaluatorVersion: EXECUTION_DRY_RUN_EVALUATOR_VERSION, intentId, strategyId, strategyVersion,
    decisionFingerprint, intentStateRevision, intentStatus, inputFingerprint, resultFingerprint,
    outcome: 'FOUNDATION_VALIDATED', coverage: 'INTENT_AND_LEASE_ONLY', quoteStatus: 'NOT_RUN',
    buildStatus: 'NOT_RUN', simulationStatus: 'NOT_RUN', signatureStatus: 'NOT_RUN',
    submissionStatus: 'NOT_RUN',
  });
}

function inputSegments(intent: ExecutionIntentV1): readonly string[] {
  return [
    'execution-dry-run-input-v1', String(EXECUTION_DRY_RUN_EVALUATOR_VERSION), intent.id,
    String(intent.payloadVersion), intent.logicalOrderKey, intent.strategyId,
    String(intent.strategyVersion), intent.positionId, intent.logicalCommandId, intent.mint,
    intent.side, intent.venuePolicy, intent.quoteMint, intent.quoteTokenProgram,
    String(intent.quoteDecimals), nullableBigintSegment(intent.quoteAmountRaw),
    nullableBigintSegment(intent.baseAmountRaw), intent.minimumAmountOutRaw.toString(),
    intent.decisionEventId, intent.decisionFingerprint, String(intent.requestedAtMs),
    String(intent.expiresAtMs), intent.status, String(intent.attemptCount),
    intent.stateRevision.toString(), intent.lastReasonCode ?? '~',
  ];
}

function nullableBigintSegment(value: bigint | null): string {
  return value === null ? '~' : value.toString();
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

function isFrozenObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !isProxy(value) && Object.isFrozen(value);
}

function textFrom(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 256) {
    throw invalid();
  }
  return value;
}

function executionIntentIdFrom(value: unknown): string {
  const id = textFrom(value);
  if (!/^execution_intent_[0-9a-f]{64}$/u.test(id)) throw invalid();
  return id;
}

function assessmentIdFrom(value: unknown): string {
  const id = textFrom(value);
  if (!/^execution_dry_run_assessment_[0-9a-f]{64}$/u.test(id)) throw invalid();
  return id;
}

function fingerprintFrom(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalid();
  return value;
}

function positiveIntegerFrom(value: unknown): number {
  return boundedIntegerFrom(value, 1, INT32_MAX);
}

function timestampFrom(value: unknown): number {
  return boundedIntegerFrom(value, 0, DATE_MAX_MS);
}

function boundedIntegerFrom(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum || Object.is(value, -0)) {
    throw invalid();
  }
  return value as number;
}

function stateRevisionFrom(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > INT64_MAX) throw invalid();
  return value;
}

function assessableStatusFrom(value: unknown): 'PENDING' | 'RETRY_READY' {
  if (value !== 'PENDING' && value !== 'RETRY_READY') throw invalid();
  return value;
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

function invalid(): ExecutionDryRunValidationError {
  return new ExecutionDryRunValidationError();
}

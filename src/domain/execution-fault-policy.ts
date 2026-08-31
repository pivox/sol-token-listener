import { isProxy } from 'node:util/types';

const INPUT_KEYS = Object.freeze([
  'stage', 'side', 'timing', 'classification', 'consecutiveTechnicalFailures',
  'exactSignedBytesAvailable',
] as const);
const STAGES = Object.freeze([
  'BUILD', 'SIMULATION', 'PROVIDER', 'SUBMISSION', 'CONFIRMATION',
  'RECONCILIATION', 'VALIDATION', 'POLICY',
] as const);
const SIDES = Object.freeze(['BUY', 'SELL'] as const);
const TIMINGS = Object.freeze(['PRE_SIGNATURE', 'AFTER_SIGNATURE'] as const);
const CLASSIFICATIONS = Object.freeze([
  'TRANSIENT', 'DETERMINISTIC', 'AMBIGUOUS', 'PROVED_NO_EFFECT', 'CRITICAL',
] as const);

export type ExecutionFaultStage = (typeof STAGES)[number];
export type ExecutionFaultClassification = (typeof CLASSIFICATIONS)[number];
export type ExecutionRetryDecision =
  | 'DO_NOT_RETRY'
  | 'RETRY_PRE_SIGNATURE'
  | 'RECONCILE_ONLY'
  | 'RETRY_EXACT_BYTES';

export class ExecutionFaultPolicyValidationError extends TypeError {
  public constructor() {
    super('Invalid execution fault policy input.');
    this.name = 'ExecutionFaultPolicyValidationError';
  }
}

export function classifyExecutionFault(input: unknown): ExecutionRetryDecision {
  try {
    const record = exactRecord(input, INPUT_KEYS);
    const stage = enumValue(record.stage, STAGES);
    const side = enumValue(record.side, SIDES);
    const timing = enumValue(record.timing, TIMINGS);
    const classification = enumValue(record.classification, CLASSIFICATIONS);
    const consecutiveTechnicalFailures = nonNegativeInteger(
      record.consecutiveTechnicalFailures,
    );
    const exactSignedBytesAvailable = booleanValue(record.exactSignedBytesAvailable);
    validateCombination(stage, timing, classification, exactSignedBytesAvailable);

    if (classification === 'PROVED_NO_EFFECT') {
      return side === 'SELL' ? 'RETRY_PRE_SIGNATURE' : 'DO_NOT_RETRY';
    }
    if (classification === 'DETERMINISTIC') return 'DO_NOT_RETRY';
    if (classification === 'CRITICAL') {
      return timing === 'AFTER_SIGNATURE' ? 'RECONCILE_ONLY' : 'DO_NOT_RETRY';
    }
    if (timing === 'AFTER_SIGNATURE') {
      if (stage === 'CONFIRMATION' || stage === 'RECONCILIATION') {
        return 'RECONCILE_ONLY';
      }
      if (side === 'SELL' && classification === 'TRANSIENT'
        && exactSignedBytesAvailable) return 'RETRY_EXACT_BYTES';
      return 'RECONCILE_ONLY';
    }
    return consecutiveTechnicalFailures >= 2
      ? 'DO_NOT_RETRY'
      : 'RETRY_PRE_SIGNATURE';
  } catch {
    throw invalid();
  }
}

function validateCombination(
  stage: ExecutionFaultStage,
  timing: (typeof TIMINGS)[number],
  classification: ExecutionFaultClassification,
  exactSignedBytesAvailable: boolean,
): void {
  if (timing === 'PRE_SIGNATURE') {
    if (exactSignedBytesAvailable
      || classification === 'AMBIGUOUS'
      || classification === 'PROVED_NO_EFFECT'
      || stage === 'SUBMISSION'
      || stage === 'CONFIRMATION'
      || stage === 'RECONCILIATION') throw invalid();
    return;
  }
  if (stage === 'BUILD' || stage === 'SIMULATION'
    || stage === 'VALIDATION' || stage === 'POLICY') throw invalid();
  if (classification === 'PROVED_NO_EFFECT' && stage !== 'RECONCILIATION') throw invalid();
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (!isPlainObject(value)) throw invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string'
    || !keys.includes(key))) throw invalid();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw invalid();
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid();
  return value as number;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(): ExecutionFaultPolicyValidationError {
  return new ExecutionFaultPolicyValidationError();
}

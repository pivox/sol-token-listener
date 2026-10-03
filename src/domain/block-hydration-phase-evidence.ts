import { isProxy } from 'node:util/types';

const EVIDENCE_FIELDS = ['version', 'overflowed', 'rpc', 'snapshot'] as const;
const PHASE_FIELDS = [
  'started', 'completed', 'failed', 'inFlight', 'maxInFlight',
  'settledLatencyBuckets', 'maxSettledLatencyMs',
] as const;

export interface PhaseCounters {
  readonly started: number;
  readonly completed: number;
  readonly failed: number;
  readonly inFlight: number;
  readonly maxInFlight: number;
  /** Ten ordered settled-latency buckets: <=50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, Infinity ms. */
  readonly settledLatencyBuckets: readonly number[];
  readonly maxSettledLatencyMs: number;
}

export interface RuntimeBlockHydrationPhaseEvidenceV1 {
  readonly version: 1;
  readonly overflowed: boolean;
  readonly rpc: PhaseCounters;
  readonly snapshot: PhaseCounters;
}

export function assertValidRuntimeBlockHydrationPhaseEvidence(
  input: unknown,
): asserts input is RuntimeBlockHydrationPhaseEvidenceV1 {
  parseEvidence(input);
}

export function createRuntimeBlockHydrationPhaseEvidence(
  input: unknown,
): RuntimeBlockHydrationPhaseEvidenceV1 {
  const parsed = parseEvidence(input);
  const freezePhase = (phase: PhaseCounters): PhaseCounters => Object.freeze({
    ...phase, settledLatencyBuckets: Object.freeze(phase.settledLatencyBuckets),
  });
  return Object.freeze({
    version: 1, overflowed: parsed.overflowed,
    rpc: freezePhase(parsed.rpc), snapshot: freezePhase(parsed.snapshot),
  });
}

function parseEvidence(input: unknown): RuntimeBlockHydrationPhaseEvidenceV1 {
  const fields = exactFields(input, EVIDENCE_FIELDS);
  if (fields.version !== 1 || typeof fields.overflowed !== 'boolean') invalid();
  const overflowed = fields.overflowed;
  return {
    version: 1, overflowed,
    rpc: parsePhase(fields.rpc, overflowed), snapshot: parsePhase(fields.snapshot, overflowed),
  };
}

function parsePhase(input: unknown, overflowed: boolean): PhaseCounters {
  const fields = exactFields(input, PHASE_FIELDS);
  const started = counter(fields.started);
  const completed = counter(fields.completed);
  const failed = counter(fields.failed);
  const inFlight = counter(fields.inFlight);
  const maxInFlight = counter(fields.maxInFlight);
  const settledLatencyBuckets = exactBuckets(fields.settledLatencyBuckets).map(counter);
  const maxSettledLatencyMs = counter(fields.maxSettledLatencyMs);
  if (!overflowed && (BigInt(started) !== BigInt(completed) + BigInt(failed) + BigInt(inFlight)
    || settledLatencyBuckets.reduce((sum, bucket) => sum + BigInt(bucket), 0n)
      !== BigInt(completed) + BigInt(failed)
    || maxInFlight < inFlight)) invalid();
  return { started, completed, failed, inFlight, maxInFlight, settledLatencyBuckets, maxSettledLatencyMs };
}

function exactFields<Field extends string>(value: unknown, expected: readonly Field[]): Record<Field, unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value)
    || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== 'string' || !expected.includes(key as Field))) invalid();
  const result = {} as Record<Field, unknown>;
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) invalid();
    const descriptorValue: unknown = descriptor.value;
    result[key] = descriptorValue;
  }
  return result;
}

function exactBuckets(value: unknown): unknown[] {
  if (!Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 10) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== 11) invalid();
  const buckets: unknown[] = [];
  for (let index = 0; index < 10; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) invalid();
    buckets.push(descriptor.value);
  }
  return buckets;
}

function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) invalid();
  return value;
}

function invalid(): never {
  throw new TypeError('Block hydration phase evidence is invalid.');
}

import { isProxy } from 'node:util/types';
import { RPC_PROVIDER_IDS, type RpcProviderId } from './rpc-provider.js';

export const RPC_HTTP_ROLES = Object.freeze([
  'SOURCE', 'FINALITY', 'BLOCK_HYDRATION', 'SHARED_CLIENT',
] as const);

export type RpcHttpRole = (typeof RPC_HTTP_ROLES)[number];

const EVIDENCE_FIELDS = ['version', 'overflowed', 'entries'] as const;
const ENTRY_FIELDS = [
  'providerId', 'role', 'attempts', 'responses', 'http429Responses', 'failures',
  'inFlight', 'maxInFlight', 'headerLatencyBuckets', 'maxHeaderLatencyMs',
] as const;
const BUCKET_COUNT = 10;
const ENTRY_COUNT = RPC_PROVIDER_IDS.length * RPC_HTTP_ROLES.length;

export interface RuntimeRpcHttpRoleEntryV1 {
  readonly providerId: RpcProviderId;
  readonly role: RpcHttpRole;
  readonly attempts: number;
  readonly responses: number;
  readonly http429Responses: number;
  readonly failures: number;
  readonly inFlight: number;
  readonly maxInFlight: number;
  /** Ten ordered time-to-headers buckets: <=50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, Infinity ms. */
  readonly headerLatencyBuckets: readonly number[];
  readonly maxHeaderLatencyMs: number;
}

export interface RuntimeRpcHttpRoleEvidenceV1 {
  readonly version: 1;
  readonly overflowed: boolean;
  readonly entries: readonly RuntimeRpcHttpRoleEntryV1[];
}

export function assertValidRuntimeRpcHttpRoleEvidence(
  input: unknown,
): asserts input is RuntimeRpcHttpRoleEvidenceV1 {
  parseEvidence(input);
}

export function createRuntimeRpcHttpRoleEvidence(input: unknown): RuntimeRpcHttpRoleEvidenceV1 {
  const parsed = parseEvidence(input);
  return Object.freeze({
    version: 1,
    overflowed: parsed.overflowed,
    entries: Object.freeze(parsed.entries.map((entry) => Object.freeze({
      ...entry,
      headerLatencyBuckets: Object.freeze(entry.headerLatencyBuckets),
    }))),
  });
}

function parseEvidence(input: unknown): { overflowed: boolean; entries: RuntimeRpcHttpRoleEntryV1[] } {
  const evidence = exactFields(input, EVIDENCE_FIELDS);
  if (evidence.version !== 1 || typeof evidence.overflowed !== 'boolean') invalid();
  const rawEntries = exactArray(evidence.entries, ENTRY_COUNT);
  const entries = rawEntries.map((rawEntry, index) => {
    const fields = exactFields(rawEntry, ENTRY_FIELDS);
    const providerId = RPC_PROVIDER_IDS[Math.floor(index / RPC_HTTP_ROLES.length)];
    const role = RPC_HTTP_ROLES[index % RPC_HTTP_ROLES.length];
    if (providerId === undefined || role === undefined
      || fields.providerId !== providerId || fields.role !== role) invalid();
    const attempts = counter(fields.attempts);
    const responses = counter(fields.responses);
    const http429Responses = counter(fields.http429Responses);
    const failures = counter(fields.failures);
    const inFlight = counter(fields.inFlight);
    const maxInFlight = counter(fields.maxInFlight);
    const headerLatencyBuckets = exactArray(fields.headerLatencyBuckets, BUCKET_COUNT).map(counter);
    const maxHeaderLatencyMs = counter(fields.maxHeaderLatencyMs);
    if (!evidence.overflowed) {
      if (responses + failures + inFlight !== attempts
        || headerLatencyBuckets.reduce((sum, bucket) => sum + bucket, 0) !== responses
        || http429Responses > responses || maxInFlight < inFlight) invalid();
    }
    return {
      providerId, role, attempts, responses, http429Responses, failures,
      inFlight, maxInFlight, headerLatencyBuckets, maxHeaderLatencyMs,
    };
  });
  return { overflowed: evidence.overflowed, entries };
}

function exactFields<Field extends string>(
  value: unknown,
  expected: readonly Field[],
): Record<Field, unknown> {
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

function exactArray(value: unknown, length: number): unknown[] {
  if (!Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || !keys.includes('length')) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) invalid();
    result.push(descriptor.value);
  }
  return result;
}

function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) invalid();
  return value;
}

function invalid(): never {
  throw new TypeError('RPC HTTP role evidence is invalid.');
}

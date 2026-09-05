import { createPublicKey, verify } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  createProviderUsageSnapshot,
  type ProviderUsageSnapshotV1,
} from './execution-provider-quota.js';
import { canonicalStringifyJson, parseJson } from '../utils/json.js';

const ENVELOPE_KEYS = Object.freeze([
  'payloadVersion', 'algorithm', 'signedPayloadBase64', 'signatureBase64',
] as const);
const PAYLOAD_KEYS = Object.freeze([
  'providerId', 'planId', 'billingPeriodId', 'billingPeriodStartedAtMs',
  'billingPeriodEndsAtMs', 'limitUnits', 'usedUnits', 'measuredAtMs',
  'expiresAtMs', 'provenance',
] as const);
const MAX_PAYLOAD_BYTES = 16_384;

export class ExecutionProviderAttestationValidationError extends TypeError {
  public readonly code = 'INVALID_EXECUTION_PROVIDER_ATTESTATION' as const;
  public constructor() {
    super('Invalid execution provider evidence attestation.');
    this.name = 'ExecutionProviderAttestationValidationError';
  }
}

export function verifySignedProviderUsageEvidence(
  input: unknown,
  trustedPublicKeyBase64: string,
  expectedProviderId: string,
  nowMs: number,
): ProviderUsageSnapshotV1 {
  try {
    const envelope = exactFrozenRecord(input, ENVELOPE_KEYS);
    if (envelope.payloadVersion !== 1 || envelope.algorithm !== 'Ed25519') throw invalid();
    const signedPayload = canonicalBase64(envelope.signedPayloadBase64, MAX_PAYLOAD_BYTES);
    const signature = canonicalBase64(envelope.signatureBase64, 64);
    if (signedPayload.length === 0 || signature.length !== 64) throw invalid();
    const key = createPublicKey({
      key: canonicalBase64(trustedPublicKeyBase64, 256), format: 'der', type: 'spki',
    });
    if (key.asymmetricKeyType !== 'ed25519'
      || !verify(null, signedPayload, key, signature)) throw invalid();
    const text = signedPayload.toString('utf8');
    const parsed = parseJson(text);
    if (canonicalStringifyJson(parsed) !== text) throw invalid();
    const row = exactRecord(parsed, PAYLOAD_KEYS);
    const snapshot = createProviderUsageSnapshot(Object.freeze({
      providerId: row.providerId,
      planId: row.planId,
      billingPeriodId: row.billingPeriodId,
      billingPeriodStartedAtMs: row.billingPeriodStartedAtMs,
      billingPeriodEndsAtMs: row.billingPeriodEndsAtMs,
      limitUnits: decimalBigint(row.limitUnits),
      usedUnits: decimalBigint(row.usedUnits),
      measuredAtMs: row.measuredAtMs,
      expiresAtMs: row.expiresAtMs,
      provenance: row.provenance,
    }));
    if (snapshot.providerId !== expectedProviderId
      || !Number.isSafeInteger(nowMs) || nowMs < 0
      || snapshot.measuredAtMs > nowMs || snapshot.expiresAtMs < nowMs) throw invalid();
    const maximumTtl = snapshot.provenance === 'OPERATOR_REPORT' ? 300_000 : 900_000;
    if (snapshot.expiresAtMs - snapshot.measuredAtMs > maximumTtl) throw invalid();
    return snapshot;
  } catch {
    throw invalid();
  }
}

function exactFrozenRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (!Object.isFrozen(value) || isProxy(value)) throw invalid();
  return exactRecord(value, keys);
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw invalid();
  }
  const prototype = Reflect.getPrototypeOf(value);
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
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) throw invalid();
  return BigInt(value);
}

function canonicalBase64(value: unknown, maximumBytes: number): Buffer {
  if (typeof value !== 'string' || value.length === 0
    || value.length > Math.ceil(maximumBytes / 3) * 4 + 4
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw invalid();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > maximumBytes || decoded.toString('base64') !== value) throw invalid();
  return decoded;
}

function invalid(): ExecutionProviderAttestationValidationError {
  return new ExecutionProviderAttestationValidationError();
}


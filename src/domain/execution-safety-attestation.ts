import { createPublicKey, verify } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  createSafetyQualification,
  type ExecutionSafetyQualificationV1,
} from './execution-safety-qualification.js';

const ENVELOPE_KEYS = Object.freeze([
  'payloadVersion', 'algorithm', 'signedPayloadBase64', 'signatureBase64',
] as const);
const MAX_SIGNED_PAYLOAD_BYTES = 65_536;

export class ExecutionSafetyAttestationValidationError extends TypeError {
  public constructor() {
    super('Invalid execution safety evidence attestation.');
    this.name = 'ExecutionSafetyAttestationValidationError';
  }
}

export function verifySignedSafetyQualificationEvidence(
  input: unknown,
  trustedPublicKeyBase64: unknown,
): ExecutionSafetyQualificationV1 {
  try {
    const envelope = exactRecord(input, ENVELOPE_KEYS);
    if (envelope.payloadVersion !== 1 || envelope.algorithm !== 'Ed25519') throw invalid();
    const signedPayload = canonicalBase64(
      envelope.signedPayloadBase64,
      MAX_SIGNED_PAYLOAD_BYTES,
    );
    if (signedPayload.length === 0) throw invalid();
    const signature = canonicalBase64(envelope.signatureBase64, 64);
    if (signature.length !== 64) throw invalid();
    const publicKeyDer = canonicalBase64(trustedPublicKeyBase64, 256);
    const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ed25519'
      || !verify(null, signedPayload, publicKey, signature)) throw invalid();
    return createSafetyQualification(JSON.parse(signedPayload.toString('utf8')) as unknown);
  } catch {
    throw invalid();
  }
}

function canonicalBase64(value: unknown, maximumBytes: number): Buffer {
  if (typeof value !== 'string' || value.length === 0
    || value.length > Math.ceil(maximumBytes / 3) * 4 + 4
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw invalid();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > maximumBytes || decoded.toString('base64') !== value) throw invalid();
  return decoded;
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
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string')) {
    throw invalid();
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalid();
    }
    record[key] = descriptor.value;
  }
  return record as Readonly<Record<Keys[number], unknown>>;
}

function invalid(): ExecutionSafetyAttestationValidationError {
  return new ExecutionSafetyAttestationValidationError();
}

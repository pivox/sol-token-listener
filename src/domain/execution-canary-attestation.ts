import { createPublicKey, verify } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { createExecutionCanaryEvidence, type ExecutionCanaryEvidenceV1 } from './execution-canary.js';
import { canonicalStringifyJson, parseJson } from '../utils/json.js';
const KEYS = Object.freeze(['payloadVersion', 'algorithm', 'signedPayloadBase64', 'signatureBase64'] as const);
const MAX_SIGNED_PAYLOAD_BYTES = 131_072;
export class ExecutionCanaryAttestationValidationError extends TypeError { public constructor() { super('Invalid execution canary evidence attestation.'); this.name = 'ExecutionCanaryAttestationValidationError'; } }
export function verifySignedExecutionCanaryEvidence(
  input: unknown,
  trustedPublicKeyBase64: unknown,
): ExecutionCanaryEvidenceV1 {
  try {
    const envelope = exact(input);
    if (envelope.payloadVersion !== 1 || envelope.algorithm !== 'Ed25519') throw invalid();
    const payload = base64(envelope.signedPayloadBase64, MAX_SIGNED_PAYLOAD_BYTES);
    const signature = base64(envelope.signatureBase64, 64);
    if (signature.length !== 64 || payload.length === 0) throw invalid();
    const key = createPublicKey({ key: base64(trustedPublicKeyBase64, 256), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, payload, key, signature)) throw invalid();
    const text = payload.toString('utf8');
    const decoded = parseJson(text);
    if (canonicalStringifyJson(decoded) !== text) throw invalid();
    return createExecutionCanaryEvidence(deepFreeze(decoded));
  } catch { throw invalid(); }
}
function exact(value: unknown): Readonly<Record<(typeof KEYS)[number], unknown>> { if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value) || !Object.isFrozen(value)) throw invalid(); const prototype = Reflect.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) throw invalid(); const own = Reflect.ownKeys(value); if (own.length !== KEYS.length || own.some((key) => typeof key !== 'string' || !KEYS.includes(key as (typeof KEYS)[number]))) throw invalid(); const result = Object.create(null) as Record<string, unknown>; for (const key of KEYS) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid(); result[key] = descriptor.value; } return result as Readonly<Record<(typeof KEYS)[number], unknown>>; }
function base64(value: unknown, maximum: number): Buffer { if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw invalid(); const decoded = Buffer.from(value, 'base64'); if (decoded.length > maximum || decoded.toString('base64') !== value) throw invalid(); return decoded; }
function deepFreeze(value: unknown): unknown { if (typeof value === 'object' && value !== null) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
function invalid(): ExecutionCanaryAttestationValidationError { return new ExecutionCanaryAttestationValidationError(); }

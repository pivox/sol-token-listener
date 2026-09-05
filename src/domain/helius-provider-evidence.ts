import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  createProviderUsageSnapshot,
  type ProviderUsageSnapshotV1,
} from './execution-provider-quota.js';

const INPUT_KEYS = Object.freeze([
  'providerId', 'projectId', 'response', 'measuredAtMs', 'ttlMs',
] as const);
const RESPONSE_KEYS = Object.freeze([
  'creditsRemaining', 'creditsUsed', 'prepaidCreditsRemaining',
  'prepaidCreditsUsed', 'subscriptionDetails', 'usage',
] as const);
const SUBSCRIPTION_KEYS = Object.freeze(['billingCycle', 'creditsLimit', 'plan'] as const);
const BILLING_CYCLE_KEYS = Object.freeze(['start', 'end'] as const);
const USAGE_KEYS = Object.freeze([
  'api', 'archival', 'das', 'grpc', 'grpcGeyser', 'photon', 'rpc', 'stream',
  'webhook', 'websocket',
] as const);
const DATE_MAX_MS = 8_640_000_000_000_000;

export interface HeliusProviderUsageV1 {
  readonly projectFingerprint: string;
  readonly snapshot: ProviderUsageSnapshotV1;
}

export interface HeliusProviderEvidenceManifestV1 {
  readonly schemaVersion: 'helius-provider-evidence.v1';
  readonly state: 'PROVIDER_EVIDENCE_COLLECTED';
  readonly providerId: string;
  readonly projectFingerprint: string;
  readonly providerSnapshotId: string;
  readonly providerSnapshotFingerprint: string;
  readonly measuredAtMs: number;
  readonly expiresAtMs: number;
  readonly evidencePublicKeyBase64: string;
  readonly canaryStatus: 'CANARY_NOT_STARTED';
  readonly paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED';
}

export class HeliusProviderUsageValidationError extends TypeError {
  public readonly code = 'INVALID_HELIUS_PROVIDER_USAGE' as const;
  public constructor() {
    super('Invalid Helius provider usage.');
    this.name = 'HeliusProviderUsageValidationError';
  }
}

export function createHeliusProviderUsage(input: unknown): HeliusProviderUsageV1 {
  try {
    const row = exactRecord(input, INPUT_KEYS);
    const providerId = identifier(row.providerId, 64);
    const projectId = uuid(row.projectId);
    const response = exactRecord(row.response, RESPONSE_KEYS);
    const creditsRemaining = counter(response.creditsRemaining);
    const creditsUsed = counter(response.creditsUsed);
    const prepaidCreditsRemaining = counter(response.prepaidCreditsRemaining);
    const prepaidCreditsUsed = counter(response.prepaidCreditsUsed);
    const subscription = exactRecord(response.subscriptionDetails, SUBSCRIPTION_KEYS);
    const cycle = exactRecord(subscription.billingCycle, BILLING_CYCLE_KEYS);
    const startedAtMs = date(cycle.start);
    const endsAtMs = date(cycle.end);
    const creditsLimit = counter(subscription.creditsLimit);
    const planId = identifier(subscription.plan, 128);
    const usage = exactRecord(response.usage, USAGE_KEYS);
    for (const key of USAGE_KEYS) counter(usage[key]);
    const measuredAtMs = timestamp(row.measuredAtMs);
    const ttlMs = integer(row.ttlMs, 30_000, 300_000);
    if (endsAtMs <= startedAtMs || measuredAtMs < startedAtMs || measuredAtMs >= endsAtMs
      || creditsRemaining > creditsLimit || prepaidCreditsUsed > creditsUsed) throw invalid();
    const expiresAtMs = Math.min(measuredAtMs + ttlMs, endsAtMs);
    if (expiresAtMs - measuredAtMs < 30_000) throw invalid();
    const projectFingerprint = digest(['helius-project-v1', projectId]);
    const snapshot = createProviderUsageSnapshot(Object.freeze({
      providerId,
      planId,
      billingPeriodId: `helius:${projectFingerprint}:${String(cycle.start)}:${String(cycle.end)}`,
      billingPeriodStartedAtMs: startedAtMs,
      billingPeriodEndsAtMs: endsAtMs,
      limitUnits: creditsUsed + creditsRemaining + prepaidCreditsRemaining,
      usedUnits: creditsUsed,
      measuredAtMs,
      expiresAtMs,
      provenance: 'AUTHORITATIVE_PROBE' as const,
    }));
    return Object.freeze({ projectFingerprint, snapshot });
  } catch {
    throw invalid();
  }
}

export function createHeliusProviderEvidenceManifest(
  usage: HeliusProviderUsageV1,
  evidencePublicKeyBase64: string,
): HeliusProviderEvidenceManifestV1 {
  try {
    if (!Object.isFrozen(usage) || !Object.isFrozen(usage.snapshot)) throw invalid();
    const publicKey = canonicalBase64(evidencePublicKeyBase64, 256);
    return Object.freeze({
      schemaVersion: 'helius-provider-evidence.v1',
      state: 'PROVIDER_EVIDENCE_COLLECTED',
      providerId: usage.snapshot.providerId,
      projectFingerprint: fingerprint(usage.projectFingerprint),
      providerSnapshotId: usage.snapshot.snapshotId,
      providerSnapshotFingerprint: usage.snapshot.snapshotFingerprint,
      measuredAtMs: usage.snapshot.measuredAtMs,
      expiresAtMs: usage.snapshot.expiresAtMs,
      evidencePublicKeyBase64: publicKey,
      canaryStatus: 'CANARY_NOT_STARTED',
      paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
    });
  } catch {
    throw invalid();
  }
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

function counter(value: unknown): bigint {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid();
  return BigInt(value as number);
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum
    || (value as number) > maximum) throw invalid();
  return value as number;
}

function timestamp(value: unknown): number {
  return integer(value, 0, DATE_MAX_MS);
}

function date(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw invalid();
  const result = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isSafeInteger(result)
    || new Date(result).toISOString().slice(0, 10) !== value) throw invalid();
  return result;
}

function uuid(value: unknown): string {
  return patterned(value,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    36);
}

function identifier(value: unknown, maximumBytes: number): string {
  return patterned(value, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u, maximumBytes);
}

function fingerprint(value: unknown): string {
  return patterned(value, /^[0-9a-f]{64}$/u, 64);
}

function patterned(value: unknown, pattern: RegExp, maximumBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes
    || !pattern.test(value)) throw invalid();
  return value;
}

function canonicalBase64(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length === 0
    || value.length > Math.ceil(maximumBytes / 3) * 4 + 4
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length > maximumBytes
    || bytes.toString('base64') !== value) throw invalid();
  return value;
}

function digest(values: readonly string[]): string {
  const hash = createHash('sha256');
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    hash.update(String(bytes.length));
    hash.update(':');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function invalid(): HeliusProviderUsageValidationError {
  return new HeliusProviderUsageValidationError();
}

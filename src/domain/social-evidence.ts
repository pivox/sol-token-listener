import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { TokenMetadataSnapshot } from './pumpfun-observation.js';
import { assertValidTimestampMs } from './timestamp.js';
import { canonicalStringifyJson } from '../utils/json.js';

/*
 * Social evidence is no longer collected. What remains here is only the metadata
 * snapshot identity used to verify historical `token_metadata_snapshots` rows.
 */

const MAX_TEXT_BYTES = 2_048;
const BASE58_PUBLIC_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;

export function socialMetadataSnapshotId(input: Readonly<{
  sourceLaunchEventId: string;
  snapshot: TokenMetadataSnapshot;
}>): string {
  const sourceLaunchEventId = boundedText(
    dataField(input, 'sourceLaunchEventId'),
    'Metadata source event',
  );
  const snapshot = snapshotMetadata(dataField(input, 'snapshot'));
  const identityResolution = snapshot.resolution.status === 'RESOLVED'
    ? Object.freeze({ status: snapshot.resolution.status, metadata: snapshot.resolution.metadata })
    : Object.freeze({
      status: snapshot.resolution.status,
      reason: snapshot.resolution.reason,
      retryable: readFailureRetryable(snapshot.resolution),
    });
  return id('pumpfun_metadata', [
    sourceLaunchEventId,
    snapshot.mint,
    snapshot.uri,
    snapshot.payloadVersion,
    canonicalStringifyJson(identityResolution),
  ]);
}

function snapshotMetadata(value: unknown): TokenMetadataSnapshot {
  const fields = exactFrozenRecord(
    value,
    ['mint', 'uri', 'resolution', 'fetchedAtMs', 'payloadVersion'] as const,
    'Social metadata snapshot',
  );
  const mint = mintText(fields.mint, 'Metadata mint');
  const uri = boundedText(fields.uri, 'Metadata URI');
  const fetchedAtMs = timestamp(fields.fetchedAtMs);
  if (fields.payloadVersion !== 1) throw new TypeError('Metadata payload version is invalid.');
  const resolutionFields = recordFields(fields.resolution, 'Metadata resolution');
  if (resolutionFields.status === 'RESOLVED') {
    const exact = exactFields(
      resolutionFields,
      ['status', 'metadata'] as const,
      'Resolved metadata',
    );
    const metadata = snapshotPublicMetadata(exact.metadata);
    return Object.freeze({
      mint,
      uri,
      resolution: Object.freeze({ status: 'RESOLVED' as const, metadata }),
      fetchedAtMs,
      payloadVersion: 1,
    });
  }
  if (resolutionFields.status !== 'FAILED') throw new TypeError('Metadata resolution status is invalid.');
  const allowed = Object.hasOwn(resolutionFields, 'retryable')
    ? ['status', 'reason', 'message', 'retryable'] as const
    : ['status', 'reason', 'message'] as const;
  exactFields(resolutionFields, allowed, 'Failed metadata');
  const reason = boundedText(resolutionFields.reason, 'Metadata failure reason');
  const message = boundedText(resolutionFields.message, 'Metadata failure message');
  const retryable = readFailureRetryable(resolutionFields);
  return Object.freeze({
    mint,
    uri,
    resolution: Object.freeze({ status: 'FAILED' as const, reason, message, retryable }),
    fetchedAtMs,
    payloadVersion: 1,
  }) as TokenMetadataSnapshot;
}

function snapshotPublicMetadata(value: unknown): TokenMetadataSnapshot['resolution'] extends {
  readonly status: 'RESOLVED'; readonly metadata: infer T;
} ? T : never {
  const fields = exactFrozenRecord(value, [
    'name', 'symbol', 'description', 'imageUrl', 'videoUrl', 'websiteUrl',
    'twitterUrl', 'telegramUrl',
  ] as const, 'Public token metadata');
  return Object.freeze({
    name: nullableBoundedText(fields.name, 'Metadata name'),
    symbol: nullableBoundedText(fields.symbol, 'Metadata symbol'),
    description: nullableBoundedText(fields.description, 'Metadata description'),
    imageUrl: nullableBoundedText(fields.imageUrl, 'Metadata image URL'),
    videoUrl: nullableBoundedText(fields.videoUrl, 'Metadata video URL'),
    websiteUrl: nullableBoundedText(fields.websiteUrl, 'Metadata website URL'),
    twitterUrl: nullableBoundedText(fields.twitterUrl, 'Metadata X URL'),
    telegramUrl: nullableBoundedText(fields.telegramUrl, 'Metadata Telegram URL'),
  }) as never;
}

function id(namespace: string, values: readonly unknown[]): string {
  const digest = createHash('sha256')
    .update(namespace)
    .update('\u001f')
    .update(canonicalStringifyJson(values))
    .digest('hex');
  return `${namespace}_${digest}`;
}

function dataField(value: unknown, field: string): unknown {
  const fields = recordFields(value, 'Social identity input');
  if (!Object.hasOwn(fields, field)) throw new TypeError(`Social identity ${field} is missing.`);
  return fields[field];
}

function boundedText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be text.`);
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) throw new RangeError(`${name} exceeds its byte bound.`);
  return value;
}

function readFailureRetryable(value: unknown): boolean {
  const fields = recordFields(value, 'Metadata failure');
  if (!Object.hasOwn(fields, 'retryable')) return false;
  if (typeof fields.retryable !== 'boolean') throw new TypeError('Metadata retryability is invalid.');
  return fields.retryable;
}

function exactFrozenRecord<const TFields extends readonly string[]>(
  value: unknown,
  fields: TFields,
  name: string,
): Record<TFields[number], unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || isProxy(value)
    || !Object.isFrozen(value)
  ) throw new TypeError(`${name} must be a frozen plain object.`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a frozen plain object.`);
  }
  return exactFields(recordFields(value, name), fields, name);
}

function recordFields(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${name} must not contain symbols.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${name} must contain enumerable data fields.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactFields<const TFields extends readonly string[]>(
  values: Record<string, unknown>,
  fields: TFields,
  name: string,
): Record<TFields[number], unknown> {
  const keys = Object.keys(values);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(values, field))) {
    throw new TypeError(`${name} must contain exactly the required fields.`);
  }
  return values;
}

function mintText(value: unknown, name: string): string {
  const text = boundedText(value, name);
  if (!BASE58_PUBLIC_KEY.test(text)) throw new TypeError(`${name} is invalid.`);
  return text;
}

function timestamp(value: unknown): number {
  assertValidTimestampMs('observedAtMs', value);
  return value;
}

function nullableBoundedText(value: unknown, name: string): string | null {
  return value === null ? null : boundedText(value, name);
}

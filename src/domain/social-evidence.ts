import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { TokenMetadataSnapshot } from './pumpfun-observation.js';
import { assertValidTimestampMs } from './timestamp.js';
import { canonicalStringifyJson } from '../utils/json.js';

export const SOCIAL_LINK_KINDS = Object.freeze([
  'WEBSITE',
  'X',
  'TELEGRAM',
] as const);

export const SOCIAL_COLLECTION_STATUSES = Object.freeze([
  'COMPLETE',
  'PARTIAL',
  'FAILED',
] as const);

export const SOCIAL_EVIDENCE_OUTCOMES = Object.freeze([
  'CONFIRMED',
  'REJECTED',
  'UNKNOWN',
] as const);

export const SOCIAL_EVIDENCE_TYPES = Object.freeze([
  'URL_SYNTAX_VALID',
  'URL_SYNTAX_INVALID',
  'URL_REACHABLE',
  'CROSS_LINK_CONFIRMED',
  'MINT_PUBLISHED',
  'ACCOUNT_TOO_RECENT',
  'DOMAIN_MISMATCH',
  'CONTENT_UNAVAILABLE',
  'VERIFICATION_UNKNOWN',
] as const);

export type SocialLinkKind = (typeof SOCIAL_LINK_KINDS)[number];
export type SocialCollectionStatus = (typeof SOCIAL_COLLECTION_STATUSES)[number];
export type SocialEvidenceOutcome = (typeof SOCIAL_EVIDENCE_OUTCOMES)[number];
export type SocialEvidenceType = (typeof SOCIAL_EVIDENCE_TYPES)[number];

export interface SocialLinkV1 {
  readonly id: string;
  readonly mint: string;
  readonly metadataSnapshotId: string;
  readonly kind: SocialLinkKind;
  readonly declaredValueSha256: string;
  readonly syntaxStatus: 'VALID' | 'INVALID';
  readonly canonicalUrl: string | null;
  readonly invalidReason: string | null;
  readonly observedAtMs: number;
}

export interface SocialHttpObservationV1 {
  readonly id: string;
  readonly linkId: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly finalCanonicalUrl: string | null;
  readonly httpStatus: number | null;
  readonly redirectCount: number;
  readonly contentSha256: string | null;
  readonly failureReason: string | null;
  readonly observedAtMs: number;
}

export interface SocialVerificationEvidenceV1 {
  readonly id: string;
  readonly mint: string;
  readonly linkId: string | null;
  readonly observationId: string | null;
  readonly type: SocialEvidenceType;
  readonly outcome: SocialEvidenceOutcome;
  readonly subjectKind: SocialLinkKind | null;
  readonly relatedKind: SocialLinkKind | null;
  readonly reasonCode: string;
  readonly observedAtMs: number;
}

export interface SocialEvidenceCollectionInputV1 {
  readonly mint: string;
  readonly sourceLaunchEventId: string;
  readonly metadataSnapshotId: string;
  readonly status: SocialCollectionStatus;
  readonly links: readonly SocialLinkV1[];
  readonly observations: readonly SocialHttpObservationV1[];
  readonly evidence: readonly SocialVerificationEvidenceV1[];
  readonly observedAtMs: number;
}

export interface SocialEvidenceCollectionV1 extends SocialEvidenceCollectionInputV1 {
  readonly id: string;
  readonly inputFingerprint: string;
  readonly payloadVersion: 1;
}

const INPUT_FIELDS = Object.freeze([
  'mint', 'sourceLaunchEventId', 'metadataSnapshotId', 'status', 'links',
  'observations', 'evidence', 'observedAtMs',
] as const);
const LINK_FIELDS = Object.freeze([
  'id', 'mint', 'metadataSnapshotId', 'kind', 'declaredValueSha256',
  'syntaxStatus', 'canonicalUrl', 'invalidReason', 'observedAtMs',
] as const);
const OBSERVATION_FIELDS = Object.freeze([
  'id', 'linkId', 'outcome', 'finalCanonicalUrl', 'httpStatus',
  'redirectCount', 'contentSha256', 'failureReason', 'observedAtMs',
] as const);
const EVIDENCE_FIELDS = Object.freeze([
  'id', 'mint', 'linkId', 'observationId', 'type', 'outcome', 'subjectKind',
  'relatedKind', 'reasonCode', 'observedAtMs',
] as const);
const MAX_ITEMS = 64;
const MAX_TEXT_BYTES = 2_048;
const MAX_TOTAL_BYTES = 262_144;
const BASE58_PUBLIC_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const LINK_KIND_SET: ReadonlySet<string> = new Set(SOCIAL_LINK_KINDS);
const COLLECTION_STATUS_SET: ReadonlySet<string> = new Set(SOCIAL_COLLECTION_STATUSES);
const EVIDENCE_OUTCOME_SET: ReadonlySet<string> = new Set(SOCIAL_EVIDENCE_OUTCOMES);
const EVIDENCE_TYPE_SET: ReadonlySet<string> = new Set(SOCIAL_EVIDENCE_TYPES);

export function createSocialCollection(
  input: SocialEvidenceCollectionInputV1,
): SocialEvidenceCollectionV1 {
  const snapshot = snapshotCollectionInput(input);
  const inputFingerprint = collectionFingerprint(snapshot);
  const result = Object.freeze({
    id: id('social_collection', [snapshot.sourceLaunchEventId, inputFingerprint]),
    inputFingerprint,
    ...snapshot,
    payloadVersion: 1 as const,
  });
  assertSerializedBound(result);
  return result;
}

export function socialCollectionId(input: SocialEvidenceCollectionInputV1): string {
  const snapshot = snapshotCollectionInput(input);
  return id('social_collection', [snapshot.sourceLaunchEventId, collectionFingerprint(snapshot)]);
}

export function socialLinkId(
  link: Omit<SocialLinkV1, 'id'> | SocialLinkV1,
): string {
  return id('social_link', [
    dataField(link, 'mint'),
    dataField(link, 'metadataSnapshotId'),
    dataField(link, 'kind'),
    dataField(link, 'declaredValueSha256'),
    dataField(link, 'syntaxStatus'),
    dataField(link, 'canonicalUrl'),
    dataField(link, 'invalidReason'),
  ]);
}

export function socialHttpObservationId(
  observation: Omit<SocialHttpObservationV1, 'id'> | SocialHttpObservationV1,
): string {
  return id('social_http', [
    dataField(observation, 'linkId'),
    dataField(observation, 'outcome'),
    dataField(observation, 'finalCanonicalUrl'),
    dataField(observation, 'httpStatus'),
    dataField(observation, 'redirectCount'),
    dataField(observation, 'contentSha256'),
    dataField(observation, 'failureReason'),
  ]);
}

export function socialVerificationEvidenceId(
  evidence: Omit<SocialVerificationEvidenceV1, 'id'> | SocialVerificationEvidenceV1,
): string {
  return id('social_evidence', [
    dataField(evidence, 'mint'),
    dataField(evidence, 'linkId'),
    dataField(evidence, 'observationId'),
    dataField(evidence, 'type'),
    dataField(evidence, 'outcome'),
    dataField(evidence, 'subjectKind'),
    dataField(evidence, 'relatedKind'),
    dataField(evidence, 'reasonCode'),
  ]);
}

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

export function createFailedSocialCollection(input: Readonly<{
  mint: string;
  sourceLaunchEventId: string;
  metadataSnapshot: TokenMetadataSnapshot;
}>): SocialEvidenceCollectionV1 {
  const fields = exactFields(
    recordFields(input, 'Failed social collection input'),
    ['mint', 'sourceLaunchEventId', 'metadataSnapshot'] as const,
    'Failed social collection input',
  );
  const mint = mintText(fields.mint, 'Failed social collection mint');
  const sourceLaunchEventId = boundedText(
    fields.sourceLaunchEventId,
    'Failed social collection source event',
  );
  const metadataSnapshot = snapshotMetadata(fields.metadataSnapshot);
  if (metadataSnapshot.mint !== mint || metadataSnapshot.resolution.status !== 'FAILED') {
    throw new TypeError('Failed social collection metadata context is invalid.');
  }
  const metadataSnapshotId = socialMetadataSnapshotId({
    sourceLaunchEventId,
    snapshot: metadataSnapshot,
  });
  const evidenceBase = Object.freeze({
    mint,
    linkId: null,
    observationId: null,
    type: 'VERIFICATION_UNKNOWN' as const,
    outcome: 'UNKNOWN' as const,
    subjectKind: null,
    relatedKind: null,
    reasonCode: 'METADATA_UNAVAILABLE',
    observedAtMs: metadataSnapshot.fetchedAtMs,
  });
  const evidence = Object.freeze({
    id: socialVerificationEvidenceId(evidenceBase),
    ...evidenceBase,
  });
  return createSocialCollection(Object.freeze({
    mint,
    sourceLaunchEventId,
    metadataSnapshotId,
    status: 'FAILED' as const,
    links: Object.freeze([]),
    observations: Object.freeze([]),
    evidence: Object.freeze([evidence]),
    observedAtMs: metadataSnapshot.fetchedAtMs,
  }));
}

function snapshotCollectionInput(input: SocialEvidenceCollectionInputV1): SocialEvidenceCollectionInputV1 {
  const fields = exactFrozenRecord(input, INPUT_FIELDS, 'Social collection input');
  const mint = mintText(fields.mint, 'Social collection mint');
  const sourceLaunchEventId = boundedText(fields.sourceLaunchEventId, 'Social source event');
  const metadataSnapshotId = prefixedId(fields.metadataSnapshotId, 'pumpfun_metadata');
  const status = enumText(fields.status, COLLECTION_STATUS_SET, 'Social collection status') as SocialCollectionStatus;
  const observedAtMs = timestamp(fields.observedAtMs);
  const links = snapshotArray(fields.links, 'Social links', snapshotLink);
  const observations = snapshotArray(
    fields.observations,
    'Social HTTP observations',
    snapshotObservation,
  );
  const evidence = snapshotArray(fields.evidence, 'Social evidence', snapshotEvidence);
  assertUnique(links.map((item) => item.id), 'Social link IDs');
  assertUnique(links.map((item) => item.kind), 'Social link kinds');
  assertUnique(observations.map((item) => item.id), 'Social observation IDs');
  assertUnique(evidence.map((item) => item.id), 'Social evidence IDs');
  const linkById = new Map(links.map((item) => [item.id, item]));
  const observationById = new Map(observations.map((item) => [item.id, item]));
  for (const link of links) {
    if (link.mint !== mint || link.metadataSnapshotId !== metadataSnapshotId) {
      throw new TypeError('Social link immutable context is foreign.');
    }
  }
  for (const observation of observations) {
    if (!linkById.has(observation.linkId)) {
      throw new TypeError('Social observation references a foreign link.');
    }
  }
  for (const item of evidence) {
    if (item.mint !== mint) throw new TypeError('Social evidence mint is foreign.');
    const linked = item.linkId === null ? null : linkById.get(item.linkId);
    if (item.linkId !== null && linked === undefined) {
      throw new TypeError('Social evidence references a foreign link.');
    }
    if (item.subjectKind !== null && linked !== null && linked?.kind !== item.subjectKind) {
      throw new TypeError('Social evidence subject kind conflicts with its link.');
    }
    if (item.observationId !== null) {
      const observation = observationById.get(item.observationId);
      if (observation === undefined || item.linkId === null || observation.linkId !== item.linkId) {
        throw new TypeError('Social evidence references a foreign observation.');
      }
    }
  }
  if (status === 'FAILED' && (links.length !== 0 || observations.length !== 0)) {
    throw new TypeError('Failed social collection cannot contain links or observations.');
  }
  const snapshot = Object.freeze({
    mint,
    sourceLaunchEventId,
    metadataSnapshotId,
    status,
    links: Object.freeze([...links].sort(compareLinks)),
    observations: Object.freeze([...observations].sort(compareIds)),
    evidence: Object.freeze([...evidence].sort(compareEvidence)),
    observedAtMs,
  });
  assertSerializedBound(snapshot);
  return snapshot;
}

function snapshotLink(value: unknown): SocialLinkV1 {
  const fields = exactFrozenRecord(value, LINK_FIELDS, 'Social link');
  const link = Object.freeze({
    id: prefixedId(fields.id, 'social_link'),
    mint: mintText(fields.mint, 'Social link mint'),
    metadataSnapshotId: prefixedId(fields.metadataSnapshotId, 'pumpfun_metadata'),
    kind: enumText(fields.kind, LINK_KIND_SET, 'Social link kind') as SocialLinkKind,
    declaredValueSha256: hashText(fields.declaredValueSha256, 'Social declared value hash'),
    syntaxStatus: syntaxStatus(fields.syntaxStatus),
    canonicalUrl: nullableBoundedText(fields.canonicalUrl, 'Social canonical URL'),
    invalidReason: nullableBoundedText(fields.invalidReason, 'Social invalid reason'),
    observedAtMs: timestamp(fields.observedAtMs),
  });
  if (link.syntaxStatus === 'VALID') {
    if (link.canonicalUrl === null || link.invalidReason !== null) {
      throw new TypeError('Valid social link shape is inconsistent.');
    }
  } else if (link.canonicalUrl !== null || link.invalidReason === null) {
    throw new TypeError('Invalid social link shape is inconsistent.');
  }
  if (link.id !== socialLinkId(link)) throw new TypeError('Social link identity is invalid.');
  return link;
}

function snapshotObservation(value: unknown): SocialHttpObservationV1 {
  const fields = exactFrozenRecord(value, OBSERVATION_FIELDS, 'Social HTTP observation');
  const outcome = enumText(
    fields.outcome,
    new Set(['SUCCEEDED', 'FAILED']),
    'Social HTTP observation outcome',
  ) as SocialHttpObservationV1['outcome'];
  const observation = Object.freeze({
    id: prefixedId(fields.id, 'social_http'),
    linkId: prefixedId(fields.linkId, 'social_link'),
    outcome,
    finalCanonicalUrl: nullableBoundedText(fields.finalCanonicalUrl, 'Social final URL'),
    httpStatus: nullableHttpStatus(fields.httpStatus),
    redirectCount: boundedCount(fields.redirectCount, 10, 'Social redirect count'),
    contentSha256: nullableHash(fields.contentSha256, 'Social content hash'),
    failureReason: nullableBoundedText(fields.failureReason, 'Social HTTP failure reason'),
    observedAtMs: timestamp(fields.observedAtMs),
  });
  if (observation.outcome === 'SUCCEEDED') {
    if (
      observation.finalCanonicalUrl === null
      || observation.httpStatus === null
      || observation.httpStatus < 200
      || observation.httpStatus > 299
      || observation.contentSha256 === null
      || observation.failureReason !== null
    ) throw new TypeError('Successful social HTTP observation is inconsistent.');
  } else if (observation.contentSha256 !== null || observation.failureReason === null) {
    throw new TypeError('Failed social HTTP observation is inconsistent.');
  }
  if (observation.id !== socialHttpObservationId(observation)) {
    throw new TypeError('Social HTTP observation identity is invalid.');
  }
  return observation;
}

function snapshotEvidence(value: unknown): SocialVerificationEvidenceV1 {
  const fields = exactFrozenRecord(value, EVIDENCE_FIELDS, 'Social verification evidence');
  const item = Object.freeze({
    id: prefixedId(fields.id, 'social_evidence'),
    mint: mintText(fields.mint, 'Social evidence mint'),
    linkId: nullablePrefixedId(fields.linkId, 'social_link'),
    observationId: nullablePrefixedId(fields.observationId, 'social_http'),
    type: enumText(fields.type, EVIDENCE_TYPE_SET, 'Social evidence type') as SocialEvidenceType,
    outcome: enumText(fields.outcome, EVIDENCE_OUTCOME_SET, 'Social evidence outcome') as SocialEvidenceOutcome,
    subjectKind: nullableEnum(fields.subjectKind, LINK_KIND_SET, 'Social subject kind') as SocialLinkKind | null,
    relatedKind: nullableEnum(fields.relatedKind, LINK_KIND_SET, 'Social related kind') as SocialLinkKind | null,
    reasonCode: reasonCode(fields.reasonCode),
    observedAtMs: timestamp(fields.observedAtMs),
  });
  if (item.observationId !== null && item.linkId === null) {
    throw new TypeError('Social evidence observation requires a link.');
  }
  if (item.id !== socialVerificationEvidenceId(item)) {
    throw new TypeError('Social verification evidence identity is invalid.');
  }
  return item;
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

function collectionFingerprint(input: SocialEvidenceCollectionInputV1): string {
  const canonical = canonicalStringifyJson(Object.freeze({
    mint: input.mint,
    sourceLaunchEventId: input.sourceLaunchEventId,
    metadataSnapshotId: input.metadataSnapshotId,
    status: input.status,
    links: input.links.map(withoutObservedAt),
    observations: input.observations.map(withoutObservedAt),
    evidence: input.evidence.map(withoutObservedAt),
  }));
  return createHash('sha256').update(canonical).digest('hex');
}

function withoutObservedAt<T extends { readonly observedAtMs: number }>(value: T): object {
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key !== 'observedAtMs') result[key] = nested;
  }
  return Object.freeze(result);
}

function id(namespace: string, values: readonly unknown[]): string {
  const digest = createHash('sha256')
    .update(namespace)
    .update('\u001f')
    .update(canonicalStringifyJson(values))
    .digest('hex');
  return `${namespace}_${digest}`;
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
  return values as Record<TFields[number], unknown>;
}

function dataField(value: unknown, field: string): unknown {
  const fields = recordFields(value, 'Social identity input');
  if (!Object.hasOwn(fields, field)) throw new TypeError(`Social identity ${field} is missing.`);
  return fields[field];
}

function snapshotArray<T>(
  value: unknown,
  name: string,
  snapshot: (item: unknown) => T,
): readonly T[] {
  if (
    !Array.isArray(value)
    || isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || !Object.isFrozen(value)
  ) throw new TypeError(`${name} must be a frozen array.`);
  if (value.length > MAX_ITEMS) throw new RangeError(`${name} exceeds its item bound.`);
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError(`${name} contains symbols.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
    throw new TypeError(`${name} must be dense.`);
  }
  const result: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${name} must contain data entries.`);
    }
    result.push(snapshot(descriptor.value));
  }
  return Object.freeze(result);
}

function boundedText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be text.`);
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) throw new RangeError(`${name} exceeds its byte bound.`);
  return value;
}

function nullableBoundedText(value: unknown, name: string): string | null {
  return value === null ? null : boundedText(value, name);
}

function mintText(value: unknown, name: string): string {
  const text = boundedText(value, name);
  if (!BASE58_PUBLIC_KEY.test(text)) throw new TypeError(`${name} is invalid.`);
  return text;
}

function hashText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !HEX_64.test(value)) throw new TypeError(`${name} is invalid.`);
  return value;
}

function nullableHash(value: unknown, name: string): string | null {
  return value === null ? null : hashText(value, name);
}

function prefixedId(value: unknown, namespace: string): string {
  if (typeof value !== 'string' || !new RegExp(`^${namespace}_[0-9a-f]{64}$`, 'u').test(value)) {
    throw new TypeError(`${namespace} identity is invalid.`);
  }
  return value;
}

function nullablePrefixedId(value: unknown, namespace: string): string | null {
  return value === null ? null : prefixedId(value, namespace);
}

function enumText(value: unknown, allowed: ReadonlySet<string>, name: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) throw new TypeError(`${name} is invalid.`);
  return value;
}

function nullableEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  name: string,
): string | null {
  return value === null ? null : enumText(value, allowed, name);
}

function syntaxStatus(value: unknown): SocialLinkV1['syntaxStatus'] {
  if (value !== 'VALID' && value !== 'INVALID') throw new TypeError('Social link syntax status is invalid.');
  return value;
}

function reasonCode(value: unknown): string {
  const code = boundedText(value, 'Social evidence reason code');
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(code)) throw new TypeError('Social evidence reason code is invalid.');
  return code;
}

function timestamp(value: unknown): number {
  assertValidTimestampMs('observedAtMs', value);
  return value;
}

function nullableHttpStatus(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 599) {
    throw new TypeError('Social HTTP status is invalid.');
  }
  return value as number;
}

function boundedCount(value: unknown, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new RangeError(`${name} is invalid.`);
  }
  return value as number;
}

function readFailureRetryable(value: unknown): boolean {
  const fields = recordFields(value, 'Metadata failure');
  if (!Object.hasOwn(fields, 'retryable')) return false;
  if (typeof fields.retryable !== 'boolean') throw new TypeError('Metadata retryability is invalid.');
  return fields.retryable;
}

function assertUnique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${name} must be unique.`);
}

function compareLinks(left: SocialLinkV1, right: SocialLinkV1): number {
  const order = SOCIAL_LINK_KINDS.indexOf(left.kind) - SOCIAL_LINK_KINDS.indexOf(right.kind);
  return order === 0 ? compareText(left.id, right.id) : order;
}

function compareIds<T extends { readonly id: string }>(left: T, right: T): number {
  return compareText(left.id, right.id);
}

function compareEvidence(
  left: SocialVerificationEvidenceV1,
  right: SocialVerificationEvidenceV1,
): number {
  const typeOrder = SOCIAL_EVIDENCE_TYPES.indexOf(left.type) - SOCIAL_EVIDENCE_TYPES.indexOf(right.type);
  return typeOrder === 0 ? compareText(left.id, right.id) : typeOrder;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSerializedBound(value: unknown): void {
  const serialized = canonicalStringifyJson(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TOTAL_BYTES) {
    throw new RangeError('Social collection exceeds its serialized bound.');
  }
}

import {
  toApiDomainPayload,
  toApiJson,
  type ApiDomainPayload,
  type ApiSseEvent,
} from '../api/contracts.js';
import { DOMAIN_EVENT_TYPES, type DomainEventType } from '../domain/events.js';
import type { ChainConfirmationStatus } from '../domain/types.js';
import {
  ApiEventStreamCursorExpiredError,
  type ApiEventStreamRepository,
  type ApiStreamRevision,
  type StreamCursorResolution,
} from '../ports/api-event-stream-repository.js';
import {
  BIGINT_JSON_MARKER,
  MAX_SERIALIZED_BIGINT_DIGITS,
  fromJsonValue,
} from '../utils/json.js';
import { getDatabasePool } from './database.js';

export interface Queryable {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

export class ApiEventStreamDataError extends Error {
  public constructor(cause?: unknown) {
    super('Stored API event stream data is invalid.');
    this.name = 'ApiEventStreamDataError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
  }
}

const MAX_SEQUENCE = 9_223_372_036_854_775_807n;
const MAX_INT4 = 2_147_483_647;
const MAX_SLOT_DIGITS = MAX_SERIALIZED_BIGINT_DIGITS;
const MAX_TEXT_LENGTH = 512;
const CONFIRMATION_STATUSES = ['processed', 'confirmed', 'finalized', 'orphaned'] as const;
export const MAX_API_EVENT_JSON_BYTES = 1024 * 1024;
export const MAX_API_PAYLOAD_JSON_BYTES = 1024 * 1024;
const EVENT_KEYS = new Set([
  'eventId',
  'type',
  'mint',
  'source',
  'program',
  'signature',
  'slot',
  'transactionIndex',
  'instructionIndex',
  'innerInstructionIndex',
  'confirmationStatus',
  'blockchainTime',
  'observedAt',
  'payloadVersion',
  'payload',
]);

export class PostgresApiEventStreamRepository implements ApiEventStreamRepository {
  private readonly table: string;
  private readonly stateTable: string;

  public constructor(
    private readonly database: Queryable = getDatabasePool(),
    schema = 'public',
  ) {
    this.table = `${quoteIdentifier(schema)}.${quoteIdentifier('api_event_stream')}`;
    this.stateTable = `${quoteIdentifier(schema)}.${quoteIdentifier('api_event_stream_state')}`;
  }

  public async highWaterMark(): Promise<bigint> {
    try {
      const result = await this.database.query(
        `WITH state_snapshot AS (
           SELECT COUNT(*)::text AS state_count,
                  MIN(last_sequence)::text AS last_sequence,
                  MIN(expired_through_sequence)::text AS expired_through
           FROM ${this.stateTable}
           WHERE id = 1
         ),
         retained_stream AS (
           SELECT COALESCE(MAX(sequence), 0)::text AS high_water_mark
           FROM ${this.table}
           WHERE purge_after > clock_timestamp()
         )
         SELECT state_snapshot.state_count, state_snapshot.last_sequence,
                state_snapshot.expired_through, retained_stream.high_water_mark
         FROM state_snapshot CROSS JOIN retained_stream`,
      );
      if (result.rows.length !== 1) throw invalid();
      const row = result.rows[0];
      if (row === undefined) throw invalid();
      const snapshot = storedState(row);
      const highWater = sequence(row.high_water_mark, true);
      if (highWater > snapshot.last
        || (highWater !== 0n && highWater <= snapshot.expiredThrough)) throw invalid();
      return highWater;
    } catch (error) {
      throw dataError(error);
    }
  }

  public async resolve(sequenceValue: bigint): Promise<StreamCursorResolution> {
    const requested = requestedSequence(sequenceValue, false);
    try {
      const result = await this.database.query(
        `WITH retained_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS retained_at
         ),
         state_snapshot AS (
           SELECT COUNT(*)::text AS state_count,
                  MIN(last_sequence)::text AS last_sequence,
                  MIN(expired_through_sequence)::text AS expired_through
           FROM ${this.stateTable}
           WHERE id = 1
         )
         SELECT state_snapshot.state_count, state_snapshot.last_sequence,
                state_snapshot.expired_through,
                EXISTS (
                  SELECT 1
                  FROM ${this.table} stream, retained_clock
                  WHERE stream.sequence = $1
                    AND stream.purge_after > retained_at
                ) AS cursor_retained
         FROM state_snapshot`,
        [requested.toString()],
      );
      if (result.rows.length !== 1) throw invalid();
      const row = result.rows[0];
      if (row === undefined || typeof row.cursor_retained !== 'boolean') throw invalid();
      const snapshot = storedState(row);
      if (requested <= snapshot.expiredThrough) return freeze({ status: 'EXPIRED' as const });
      if (requested > snapshot.last) return freeze({ status: 'FUTURE' as const });
      if (!row.cursor_retained) return freeze({ status: 'EXPIRED' as const });
      return freeze({ status: 'CURRENT' as const, sequence: requested });
    } catch (error) {
      throw dataError(error);
    }
  }

  public async readAfter(after: bigint, limit: number): Promise<readonly ApiStreamRevision[]> {
    const cursor = requestedSequence(after, true);
    const boundedLimit = pageLimit(limit);
    try {
      const result = await this.database.query(
        `WITH retained_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS retained_at
         ),
         state_snapshot AS (
           SELECT COUNT(*)::text AS state_count,
                  MIN(last_sequence)::text AS last_sequence,
                  MIN(expired_through_sequence)::text AS expired_through
           FROM ${this.stateTable}
           WHERE id = 1
         ),
         cursor_snapshot AS (
           SELECT state_snapshot.*, retained_clock.retained_at,
             CASE
               WHEN state_count <> '1'
                 OR last_sequence IS NULL
                 OR expired_through IS NULL
                 OR expired_through::bigint > last_sequence::bigint
                 THEN 'INVALID_STATE'
               WHEN $1::bigint = 0 THEN 'CURRENT'
               WHEN $1::bigint > last_sequence::bigint THEN 'FUTURE'
               WHEN $1::bigint <= expired_through::bigint THEN 'EXPIRED'
               WHEN EXISTS (
                 SELECT 1 FROM ${this.table} cursor_row
                 WHERE cursor_row.sequence = $1
                   AND cursor_row.purge_after > retained_clock.retained_at
               ) THEN 'CURRENT'
               ELSE 'EXPIRED'
             END AS cursor_status
           FROM state_snapshot CROSS JOIN retained_clock
         ),
         batch AS (
           SELECT stream.sequence::text AS sequence, stream.stream_event_id,
                  stream.domain_event_id, stream.revision::text AS revision,
                  stream.event_type, stream.mint, stream.confirmation_status,
                  stream.payload_version, stream.event
           FROM ${this.table} stream CROSS JOIN cursor_snapshot
           WHERE cursor_snapshot.cursor_status = 'CURRENT'
             AND stream.sequence > $1
             AND stream.purge_after > cursor_snapshot.retained_at
           ORDER BY stream.sequence ASC
           LIMIT $2
         )
         SELECT cursor_snapshot.state_count, cursor_snapshot.last_sequence,
                cursor_snapshot.expired_through, cursor_snapshot.cursor_status,
                batch.sequence, batch.stream_event_id, batch.domain_event_id,
                batch.revision, batch.event_type, batch.mint,
                batch.confirmation_status, batch.payload_version, batch.event
         FROM cursor_snapshot
         LEFT JOIN batch ON TRUE
         ORDER BY batch.sequence ASC NULLS LAST`,
        [cursor.toString(), boundedLimit],
      );
      if (result.rows.length === 0) throw invalid();
      const first = result.rows[0];
      if (first === undefined) throw invalid();
      const snapshot = storedState(first);
      const status = cursorStatus(first.cursor_status);
      validateCursorStatus(cursor, snapshot, status);
      for (const row of result.rows) validateSnapshotMetadata(row, first);
      if (status !== 'CURRENT') {
        if (result.rows.length !== 1 || !isEmptyBatchRow(first)) throw invalid();
        if (status === 'EXPIRED') throw new ApiEventStreamCursorExpiredError();
        throw invalid();
      }
      if (first.sequence === null) {
        if (result.rows.length !== 1 || !isEmptyBatchRow(first)) throw invalid();
        return freeze([] as ApiStreamRevision[]);
      }
      if (result.rows.some((row) => row.sequence === null)) throw invalid();
      return freeze(result.rows.map(toRevision));
    } catch (error) {
      if (error instanceof ApiEventStreamCursorExpiredError) throw error;
      throw dataError(error);
    }
  }
}

interface StoredStreamState {
  readonly last: bigint;
  readonly expiredThrough: bigint;
}

type CursorStatus = 'CURRENT' | 'EXPIRED' | 'FUTURE' | 'INVALID_STATE';

const BATCH_COLUMNS = [
  'sequence',
  'stream_event_id',
  'domain_event_id',
  'revision',
  'event_type',
  'mint',
  'confirmation_status',
  'payload_version',
  'event',
] as const;

function storedState(row: Record<string, unknown>): StoredStreamState {
  if (row.state_count !== '1') throw invalid();
  const last = sequence(row.last_sequence, true);
  const expiredThrough = sequence(row.expired_through, true);
  if (expiredThrough > last) throw invalid();
  return { last, expiredThrough };
}

function cursorStatus(value: unknown): CursorStatus {
  if (
    value !== 'CURRENT'
    && value !== 'EXPIRED'
    && value !== 'FUTURE'
    && value !== 'INVALID_STATE'
  ) throw invalid();
  return value;
}

function validateCursorStatus(
  cursor: bigint,
  state: StoredStreamState,
  status: CursorStatus,
): void {
  if (status === 'INVALID_STATE') throw invalid();
  if (cursor === 0n) {
    if (status !== 'CURRENT') throw invalid();
    return;
  }
  if (cursor > state.last) {
    if (status !== 'FUTURE') throw invalid();
    return;
  }
  if (cursor <= state.expiredThrough && status !== 'EXPIRED') throw invalid();
}

function validateSnapshotMetadata(
  row: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  for (const key of ['state_count', 'last_sequence', 'expired_through', 'cursor_status']) {
    if (row[key] !== expected[key]) throw invalid();
  }
}

function isEmptyBatchRow(row: Record<string, unknown>): boolean {
  return BATCH_COLUMNS.every((column) => row[column] === null);
}

function toRevision(row: Record<string, unknown>): ApiStreamRevision {
  const streamEventId = boundedText(row.stream_event_id);
  const event = toSseEvent(row.event);
  positiveSequence(row.revision);
  if (boundedText(row.domain_event_id) !== event.eventId
    || boundedText(row.event_type) !== event.type
    || boundedText(row.mint) !== event.mint
    || confirmationStatus(row.confirmation_status) !== event.confirmationStatus
    || positiveInt(row.payload_version) !== event.payloadVersion) throw invalid();
  return freeze({ sequence: sequence(row.sequence, false), streamEventId, event });
}

function toSseEvent(value: unknown): ApiSseEvent {
  const object = sanitizedEvent(value);
  requireExactEventKeys(object);
  const payload = sanitizedPayload(object.payload);
  return freeze({
    eventId: boundedText(object.eventId),
    type: domainEventType(object.type),
    mint: boundedText(object.mint),
    source: boundedText(object.source),
    program: boundedText(object.program),
    signature: boundedText(object.signature),
    cursor: freeze({
      slot: slot(object.slot),
      transactionIndex: index(object.transactionIndex).toString(),
      instructionIndex: index(object.instructionIndex).toString(),
      innerInstructionIndex: object.innerInstructionIndex === null ? null : index(object.innerInstructionIndex).toString(),
    }),
    confirmationStatus: confirmationStatus(object.confirmationStatus),
    blockchainTime: object.blockchainTime === null ? null : canonicalDate(object.blockchainTime),
    observedAt: canonicalDate(object.observedAt),
    payloadVersion: positiveInt(object.payloadVersion),
    payload,
  });
}

function sanitizedEvent(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    assertJsonSize(value, MAX_API_EVENT_JSON_BYTES);
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw invalid();
    }
  }
  const sanitized = toApiJson(parsed);
  assertJsonSize(JSON.stringify(sanitized), MAX_API_EVENT_JSON_BYTES);
  return record(sanitized);
}

function requireExactEventKeys(value: Record<string, unknown>): void {
  const keys = Object.keys(value);
  if (keys.length !== EVENT_KEYS.size || keys.some((key) => !EVENT_KEYS.has(key))) throw invalid();
}

function sanitizedPayload(value: unknown): ApiDomainPayload {
  const sanitized = toApiJson(value);
  assertJsonSize(JSON.stringify(sanitized), MAX_API_PAYLOAD_JSON_BYTES);
  validateReservedBigIntMarkers(sanitized);
  return toApiDomainPayload(fromJsonValue(sanitized));
}

function assertJsonSize(value: string | undefined, maximum: number): void {
  if (value === undefined || Buffer.byteLength(value, 'utf8') > maximum) throw invalid();
}

function validateReservedBigIntMarkers(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) validateReservedBigIntMarkers(item);
    return;
  }
  const object = record(value);
  const keys = Object.keys(object);
  if (keys.length === 1 && keys[0] === BIGINT_JSON_MARKER) {
    // This singleton is the existing persistence encoding and therefore cannot
    // be distinguished from business data with the same exact shape.
    const decimal = object[BIGINT_JSON_MARKER];
    if (typeof decimal !== 'string'
      || !/^(?:0|-?[1-9]\d*)$/u.test(decimal)
      || decimal.replace(/^-/, '').length > MAX_SERIALIZED_BIGINT_DIGITS) throw invalid();
    return;
  }
  for (const nested of Object.values(object)) validateReservedBigIntMarkers(nested);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw invalid();
  return value as Record<string, unknown>;
}

function sequence(value: unknown, zeroAllowed: boolean): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) throw invalid();
  const parsed = BigInt(value);
  if ((!zeroAllowed && parsed === 0n) || parsed > MAX_SEQUENCE) throw invalid();
  return parsed;
}

function positiveSequence(value: unknown): bigint {
  return sequence(value, false);
}

function requestedSequence(value: unknown, zeroAllowed: boolean): bigint {
  if (typeof value !== 'bigint'
    || (!zeroAllowed && value < 1n)
    || (zeroAllowed && value < 0n)
    || value > MAX_SEQUENCE) throw new RangeError('Invalid API event stream sequence.');
  return value;
}

function pageLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)
    || value < 1 || value > 200) throw new RangeError('Invalid API event stream page limit.');
  return value;
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH) throw invalid();
  return value;
}

function domainEventType(value: unknown): DomainEventType {
  const candidate = boundedText(value);
  if (!DOMAIN_EVENT_TYPES.includes(candidate as DomainEventType)) throw invalid();
  return candidate as DomainEventType;
}

function confirmationStatus(value: unknown): ChainConfirmationStatus {
  const candidate = boundedText(value);
  if (!CONFIRMATION_STATUSES.includes(candidate as ChainConfirmationStatus)) throw invalid();
  return candidate as ChainConfirmationStatus;
}

function slot(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value) || value.length > MAX_SLOT_DIGITS) throw invalid();
  return value;
}

function index(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)
    || value < 0 || value > MAX_INT4) throw invalid();
  return value;
}

function positiveInt(value: unknown): number {
  const result = index(value);
  if (result < 1) throw invalid();
  return result;
}

function canonicalDate(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw invalid();
  return value;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new RangeError('Invalid PostgreSQL schema.');
  return `"${value}"`;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function invalid(): TypeError {
  return new TypeError('Invalid stored API event stream data.');
}

function dataError(error: unknown): ApiEventStreamDataError {
  return error instanceof ApiEventStreamDataError ? error : new ApiEventStreamDataError(error);
}

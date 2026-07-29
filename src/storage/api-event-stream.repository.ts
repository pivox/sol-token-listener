import {
  toApiDomainPayload,
  toApiJson,
  type ApiSseEvent,
} from '../api/contracts.js';
import { DOMAIN_EVENT_TYPES, type DomainEventType } from '../domain/events.js';
import type { ChainConfirmationStatus } from '../domain/types.js';
import type {
  ApiEventStreamRepository,
  ApiStreamRevision,
  StreamCursorResolution,
} from '../ports/api-event-stream-repository.js';
import { fromJsonValue } from '../utils/json.js';
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
const MAX_SLOT_DIGITS = 78;
const MAX_TEXT_LENGTH = 512;
const CONFIRMATION_STATUSES = ['processed', 'confirmed', 'finalized', 'orphaned'] as const;

export class PostgresApiEventStreamRepository implements ApiEventStreamRepository {
  private readonly table: string;

  public constructor(
    private readonly database: Queryable = getDatabasePool(),
    schema = 'public',
  ) {
    this.table = `${quoteIdentifier(schema)}.${quoteIdentifier('api_event_stream')}`;
  }

  public async highWaterMark(): Promise<bigint> {
    try {
      const result = await this.database.query(
        `SELECT COALESCE(MAX(sequence), 0)::text AS high_water_mark FROM ${this.table}`,
      );
      if (result.rows.length !== 1) throw invalid();
      return sequence(result.rows[0]?.high_water_mark, true);
    } catch (error) {
      throw dataError(error);
    }
  }

  public async resolve(sequenceValue: bigint): Promise<StreamCursorResolution> {
    const requested = requestedSequence(sequenceValue, false);
    const highWater = await this.highWaterMark();
    if (requested > highWater) return freeze({ status: 'FUTURE' as const });
    try {
      const result = await this.database.query(
        `SELECT sequence::text AS sequence
         FROM ${this.table}
         WHERE sequence = $1`,
        [requested.toString()],
      );
      if (result.rows.length > 1) throw invalid();
      const row = result.rows[0];
      if (row === undefined) return freeze({ status: 'EXPIRED' as const });
      if (sequence(row.sequence, false) !== requested) throw invalid();
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
        `SELECT sequence::text AS sequence, stream_event_id, event_type, mint, confirmation_status, event
         FROM ${this.table}
         WHERE sequence > $1
         ORDER BY sequence ASC
         LIMIT $2`,
        [cursor.toString(), boundedLimit],
      );
      return freeze(result.rows.map(toRevision));
    } catch (error) {
      throw dataError(error);
    }
  }
}

function toRevision(row: Record<string, unknown>): ApiStreamRevision {
  const streamEventId = boundedText(row.stream_event_id);
  const event = toSseEvent(row.event);
  if (boundedText(row.event_type) !== event.type
    || boundedText(row.mint) !== event.mint
    || confirmationStatus(row.confirmation_status) !== event.confirmationStatus) throw invalid();
  return freeze({ sequence: sequence(row.sequence, false), streamEventId, event });
}

function toSseEvent(value: unknown): ApiSseEvent {
  const parsed = parseJson(value);
  const json = toApiJson(parsed);
  const object = record(json);
  const payload = toApiDomainPayload(fromJsonValue(toApiDomainPayload(object.payload)));
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

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalid();
  }
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

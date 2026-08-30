import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

export const EXECUTION_INTENT_STATUSES = Object.freeze([
  'PENDING',
  'PROCESSING',
  'SIMULATED',
  'RETRY_READY',
  'SIGNED_NOT_SUBMITTED',
  'SUBMITTED',
  'CONFIRMED',
  'RECONCILING',
  'SUCCEEDED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'UNKNOWN_REQUIRES_RECONCILIATION',
] as const);

export const EXECUTION_INTENT_REASON_CODES = Object.freeze([
  'INTENT_EXPIRED',
  'INTENT_DUPLICATE',
  'INTENT_LEASE_LOST',
  'QUALIFICATION_STALE',
  'DECISION_STALE',
  'QUOTE_STALE',
  'QUOTE_MINT_NOT_ALLOWED',
  'VENUE_UNAVAILABLE',
  'BUY_SIMULATION_FAILED',
  'SELL_SIMULATION_FAILED',
  'SELL_QUOTE_UNAVAILABLE',
  'MINIMUM_AMOUNT_OUT_VIOLATED',
  'UNSUPPORTED_TOKEN_EXTENSION',
  'WALLET_MISMATCH',
  'GENESIS_MISMATCH',
  'CAPITAL_LIMIT_EXCEEDED',
  'EXPOSURE_LIMIT_EXCEEDED',
  'DRAWDOWN_LIMIT_EXCEEDED',
  'PROVIDER_USAGE_UNKNOWN',
  'PROVIDER_ENTRY_LIMIT_REACHED',
  'PROVIDER_EXIT_ONLY',
  'KILL_SWITCH_ACTIVE',
  'HARD_STOP_ACTIVE',
  'ARMING_REQUIRED',
  'ARMING_EXPIRED',
  'SIGNATURE_PERSIST_FAILED',
  'SUBMISSION_AMBIGUOUS',
  'CONFIRMATION_TIMEOUT',
  'RECONCILIATION_REQUIRED',
  'BALANCE_MISMATCH',
  'RESIDUAL_TOKEN_BALANCE',
  'DOUBLE_ORDER_SUSPECTED',
] as const);

export type ExecutionIntentStatus = (typeof EXECUTION_INTENT_STATUSES)[number];
export type ExecutionIntentReasonCode = (typeof EXECUTION_INTENT_REASON_CODES)[number];
export type ExecutionIntentSide = 'BUY' | 'SELL';
export type ExecutionVenuePolicy = 'PUMP_FUN_ONLY' | 'CANONICAL_EXIT';
export type ExecutionQuoteTokenProgram = 'SPL_TOKEN' | 'TOKEN_2022';

export interface ExecutionIntentDraftV1 {
  readonly id: string;
  readonly payloadVersion: 1;
  readonly logicalOrderKey: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly positionId: string;
  readonly logicalCommandId: string;
  readonly mint: string;
  readonly side: ExecutionIntentSide;
  readonly venuePolicy: ExecutionVenuePolicy;
  readonly quoteMint: string;
  readonly quoteTokenProgram: ExecutionQuoteTokenProgram;
  readonly quoteDecimals: number;
  readonly quoteAmountRaw: bigint | null;
  readonly baseAmountRaw: bigint | null;
  readonly minimumAmountOutRaw: bigint;
  readonly decisionEventId: string;
  readonly decisionFingerprint: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ExecutionIntentV1 extends ExecutionIntentDraftV1 {
  readonly status: ExecutionIntentStatus;
  readonly attemptCount: number;
  readonly stateRevision: bigint;
  readonly lastReasonCode: ExecutionIntentReasonCode | null;
  readonly terminalAtMs: number | null;
  readonly reconciliationCompletedAtMs: number | null;
  readonly purgeAfterMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export class ExecutionIntentValidationError extends TypeError {
  public constructor() {
    super('Invalid execution intent.');
    this.name = 'ExecutionIntentValidationError';
  }
}

const EXECUTION_INTENT_PAYLOAD_VERSION = 1 as const;
const INT32_MAX = 2_147_483_647;
const INT64_MAX = 9_223_372_036_854_775_807n;
const DATE_MAX_MS = 8_640_000_000_000_000;
const U64_MAX = 18_446_744_073_709_551_615n;
const RETENTION_MS = 14_400_000;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const DRAFT_INPUT_KEYS = Object.freeze([
  'strategyId',
  'strategyVersion',
  'positionId',
  'logicalCommandId',
  'mint',
  'side',
  'venuePolicy',
  'quoteMint',
  'quoteTokenProgram',
  'quoteDecimals',
  'quoteAmountRaw',
  'baseAmountRaw',
  'minimumAmountOutRaw',
  'decisionEventId',
  'decisionFingerprint',
  'requestedAtMs',
  'expiresAtMs',
] as const);

const DRAFT_KEYS = Object.freeze([
  'id',
  'payloadVersion',
  'logicalOrderKey',
  ...DRAFT_INPUT_KEYS,
] as const);

const INTENT_KEYS = Object.freeze([
  ...DRAFT_KEYS,
  'status',
  'attemptCount',
  'stateRevision',
  'lastReasonCode',
  'terminalAtMs',
  'reconciliationCompletedAtMs',
  'purgeAfterMs',
  'createdAtMs',
  'updatedAtMs',
] as const);

const TERMINAL_STATUSES = new Set<ExecutionIntentStatus>([
  'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED',
]);

const ALLOWED_TRANSITIONS: ReadonlyMap<ExecutionIntentStatus, ReadonlySet<ExecutionIntentStatus>> = new Map([
  ['PENDING', new Set(['PROCESSING', 'EXPIRED', 'CANCELLED'])],
  ['RETRY_READY', new Set(['PROCESSING', 'EXPIRED', 'CANCELLED'])],
  ['PROCESSING', new Set(['SIMULATED', 'FAILED', 'EXPIRED', 'CANCELLED'])],
  ['SIMULATED', new Set(['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'SIGNED_NOT_SUBMITTED'])],
  ['SIGNED_NOT_SUBMITTED', new Set(['SUBMITTED', 'UNKNOWN_REQUIRES_RECONCILIATION'])],
  ['SUBMITTED', new Set(['CONFIRMED', 'UNKNOWN_REQUIRES_RECONCILIATION'])],
  ['CONFIRMED', new Set(['RECONCILING', 'UNKNOWN_REQUIRES_RECONCILIATION', 'SUCCEEDED'])],
  ['RECONCILING', new Set(['UNKNOWN_REQUIRES_RECONCILIATION', 'SUCCEEDED'])],
  ['UNKNOWN_REQUIRES_RECONCILIATION', new Set(['CONFIRMED', 'FAILED', 'RETRY_READY'])],
  ['SUCCEEDED', new Set()],
  ['FAILED', new Set()],
  ['EXPIRED', new Set()],
  ['CANCELLED', new Set()],
]);

export function createExecutionIntentDraft(input: unknown): ExecutionIntentDraftV1 {
  const value = draftInputFrom(input);
  const draft = {
    id: createExecutionIntentId(value),
    payloadVersion: EXECUTION_INTENT_PAYLOAD_VERSION,
    logicalOrderKey: value.logicalCommandId,
    ...value,
  } as const;
  return Object.freeze(draft);
}

export function createExecutionIntentId(value: unknown): string {
  const identity = identityFrom(value);
  return `execution_intent_${createHash('sha256')
    .update(lengthPrefixedUtf8([
      'execution-intent-v1',
      identity.strategyId,
      String(identity.strategyVersion),
      identity.positionId,
      identity.side,
      identity.logicalCommandId,
    ]))
    .digest('hex')}`;
}

export function assertExecutionIntent(value: unknown): asserts value is ExecutionIntentV1 {
  try {
    void intentFrom(value, true);
  } catch {
    throw invalid();
  }
}

export function assertExecutionIntentTransition(
  previous: unknown,
  next: unknown,
): void {
  const prior = statusFrom(previous);
  const successor = statusFrom(next);
  if (!ALLOWED_TRANSITIONS.get(prior)?.has(successor)) throw invalid();
}

function draftInputFrom(value: unknown): Omit<ExecutionIntentDraftV1, 'id' | 'payloadVersion' | 'logicalOrderKey'> {
  const record = ownEnumerableDataRecord(value, DRAFT_INPUT_KEYS);
  return immutableFieldsFrom(record);
}

function draftFrom(value: unknown, requireFrozen: boolean): ExecutionIntentDraftV1 {
  if (requireFrozen && !isFrozenObject(value)) throw invalid();
  const record = ownEnumerableDataRecord(value, DRAFT_KEYS);
  if (record.payloadVersion !== EXECUTION_INTENT_PAYLOAD_VERSION) throw invalid();
  const fields = immutableFieldsFrom(record);
  if (record.logicalOrderKey !== fields.logicalCommandId) throw invalid();
  const id = textFrom(record.id);
  const draft = Object.freeze({
    id,
    payloadVersion: EXECUTION_INTENT_PAYLOAD_VERSION,
    logicalOrderKey: fields.logicalCommandId,
    ...fields,
  });
  if (id !== createExecutionIntentId(draft)) throw invalid();
  return draft;
}

function intentFrom(value: unknown, requireFrozen: boolean): ExecutionIntentV1 {
  if (requireFrozen && !isFrozenObject(value)) throw invalid();
  const record = ownEnumerableDataRecord(value, INTENT_KEYS);
  const draft = draftFrom(Object.freeze(pick(record, DRAFT_KEYS)), requireFrozen);
  const status = statusFrom(record.status);
  const attemptCount = nonNegativeIntegerFrom(record.attemptCount);
  const stateRevision = stateRevisionFrom(record.stateRevision);
  const lastReasonCode = nullableReasonCodeFrom(record.lastReasonCode);
  const terminalAtMs = nullableTimestampFrom(record.terminalAtMs);
  const reconciliationCompletedAtMs = nullableTimestampFrom(record.reconciliationCompletedAtMs);
  const purgeAfterMs = nullableTimestampFrom(record.purgeAfterMs);
  const createdAtMs = timestampFrom(record.createdAtMs);
  const updatedAtMs = timestampFrom(record.updatedAtMs);
  if (updatedAtMs < createdAtMs) throw invalid();
  if (TERMINAL_STATUSES.has(status) !== (terminalAtMs !== null)) throw invalid();
  if (reconciliationCompletedAtMs !== null && terminalAtMs === null) throw invalid();
  if (purgeAfterMs !== null && (
    reconciliationCompletedAtMs === null
    || purgeAfterMs !== reconciliationCompletedAtMs + RETENTION_MS
  )) throw invalid();
  if (status === 'PENDING' && (
    attemptCount !== 0
    || lastReasonCode !== null
    || terminalAtMs !== null
    || reconciliationCompletedAtMs !== null
    || purgeAfterMs !== null
  )) throw invalid();
  return Object.freeze({
    ...draft,
    status,
    attemptCount,
    stateRevision,
    lastReasonCode,
    terminalAtMs,
    reconciliationCompletedAtMs,
    purgeAfterMs,
    createdAtMs,
    updatedAtMs,
  });
}

function immutableFieldsFrom(
  record: Readonly<Record<string, unknown>>,
): Omit<ExecutionIntentDraftV1, 'id' | 'payloadVersion' | 'logicalOrderKey'> {
  const strategyId = textFrom(record.strategyId);
  const strategyVersion = positiveIntegerFrom(record.strategyVersion);
  const positionId = textFrom(record.positionId);
  const logicalCommandId = textFrom(record.logicalCommandId);
  const mint = mintFrom(record.mint);
  const side = sideFrom(record.side);
  const venuePolicy = venuePolicyFrom(record.venuePolicy);
  const quoteMint = mintFrom(record.quoteMint);
  const quoteTokenProgram = quoteTokenProgramFrom(record.quoteTokenProgram);
  const quoteDecimals = boundedIntegerFrom(record.quoteDecimals, 0, 255);
  const quoteAmountRaw = nullableU64From(record.quoteAmountRaw);
  const baseAmountRaw = nullableU64From(record.baseAmountRaw);
  const minimumAmountOutRaw = positiveU64From(record.minimumAmountOutRaw);
  const decisionEventId = textFrom(record.decisionEventId);
  const decisionFingerprint = fingerprintFrom(record.decisionFingerprint);
  const requestedAtMs = timestampFrom(record.requestedAtMs);
  const expiresAtMs = timestampFrom(record.expiresAtMs);
  if (expiresAtMs <= requestedAtMs) throw invalid();
  if ((side === 'BUY' && (quoteAmountRaw === null || baseAmountRaw !== null))
    || (side === 'SELL' && (baseAmountRaw === null || quoteAmountRaw !== null))) throw invalid();
  if ((side === 'BUY' && venuePolicy !== 'PUMP_FUN_ONLY')
    || (side === 'SELL' && venuePolicy !== 'CANONICAL_EXIT')) throw invalid();
  return {
    strategyId,
    strategyVersion,
    positionId,
    logicalCommandId,
    mint,
    side,
    venuePolicy,
    quoteMint,
    quoteTokenProgram,
    quoteDecimals,
    quoteAmountRaw,
    baseAmountRaw,
    minimumAmountOutRaw,
    decisionEventId,
    decisionFingerprint,
    requestedAtMs,
    expiresAtMs,
  };
}

function identityFrom(value: unknown): Readonly<{
  strategyId: string;
  strategyVersion: number;
  positionId: string;
  side: ExecutionIntentSide;
  logicalCommandId: string;
}> {
  const record = ownEnumerableDataRecord(value, undefined);
  return {
    strategyId: textFrom(readOwnDataProperty(record, 'strategyId')),
    strategyVersion: positiveIntegerFrom(readOwnDataProperty(record, 'strategyVersion')),
    positionId: textFrom(readOwnDataProperty(record, 'positionId')),
    side: sideFrom(readOwnDataProperty(record, 'side')),
    logicalCommandId: textFrom(readOwnDataProperty(record, 'logicalCommandId')),
  };
}

function ownEnumerableDataRecord(
  value: unknown,
  expectedKeys: readonly string[] | undefined,
): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      throw invalid();
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const keys = Reflect.ownKeys(value);
    if (expectedKeys !== undefined && keys.length !== expectedKeys.length) throw invalid();
    const result: Record<string, unknown> = {};
    for (const key of expectedKeys ?? keys) {
      if (typeof key !== 'string' || !keys.includes(key)) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw invalid();
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw invalid();
  }
}

function readOwnDataProperty(record: Readonly<Record<string, unknown>>, key: string): unknown {
  if (!Object.hasOwn(record, key)) throw invalid();
  return record[key];
}

function pick(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) result[key] = record[key];
  return result;
}

function isFrozenObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !isProxy(value) && Object.isFrozen(value);
}

function textFrom(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 256) {
    throw invalid();
  }
  return value;
}

function mintFrom(value: unknown): string {
  const mint = textFrom(value);
  if (!isCanonicalBase58PublicKey(mint)) throw invalid();
  return mint;
}

function fingerprintFrom(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalid();
  return value;
}

function sideFrom(value: unknown): ExecutionIntentSide {
  if (value !== 'BUY' && value !== 'SELL') throw invalid();
  return value;
}

function venuePolicyFrom(value: unknown): ExecutionVenuePolicy {
  if (value !== 'PUMP_FUN_ONLY' && value !== 'CANONICAL_EXIT') throw invalid();
  return value;
}

function quoteTokenProgramFrom(value: unknown): ExecutionQuoteTokenProgram {
  if (value !== 'SPL_TOKEN' && value !== 'TOKEN_2022') throw invalid();
  return value;
}

function statusFrom(value: unknown): ExecutionIntentStatus {
  if (!(EXECUTION_INTENT_STATUSES as readonly unknown[]).includes(value)) throw invalid();
  return value as ExecutionIntentStatus;
}

function nullableReasonCodeFrom(value: unknown): ExecutionIntentReasonCode | null {
  if (value === null) return null;
  if (!(EXECUTION_INTENT_REASON_CODES as readonly unknown[]).includes(value)) throw invalid();
  return value as ExecutionIntentReasonCode;
}

function positiveIntegerFrom(value: unknown): number {
  return boundedIntegerFrom(value, 1, INT32_MAX);
}

function nonNegativeIntegerFrom(value: unknown): number {
  return boundedIntegerFrom(value, 0, INT32_MAX);
}

function boundedIntegerFrom(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum || Object.is(value, -0)) {
    throw invalid();
  }
  return value as number;
}

function timestampFrom(value: unknown): number {
  return boundedIntegerFrom(value, 0, DATE_MAX_MS);
}

function nullableTimestampFrom(value: unknown): number | null {
  if (value === null) return null;
  return timestampFrom(value);
}

function nullableU64From(value: unknown): bigint | null {
  if (value === null) return null;
  return positiveU64From(value);
}

function stateRevisionFrom(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > INT64_MAX) throw invalid();
  return value;
}

function positiveU64From(value: unknown): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > U64_MAX) throw invalid();
  return value;
}

function isCanonicalBase58PublicKey(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let encodedByteLength = 0;
  while (decoded > 0n) {
    encodedByteLength += 1;
    decoded >>= 8n;
  }
  let leadingZeroByteLength = 0;
  while (value[leadingZeroByteLength] === '1') leadingZeroByteLength += 1;
  return encodedByteLength + leadingZeroByteLength === 32;
}

function lengthPrefixedUtf8(values: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

function invalid(): ExecutionIntentValidationError {
  return new ExecutionIntentValidationError();
}

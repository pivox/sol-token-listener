import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { ExecutionOpenPositionRiskInputV1 } from './execution-risk-policy.js';

const U64_MAX = 18_446_744_073_709_551_615n;
const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);
const DATE_MAX_MS = 8_640_000_000_000_000;
const INPUT_KEYS = Object.freeze([
  'generationId', 'providerId', 'stateRevision', 'slot', 'blockTimeMs', 'observedAtMs',
  'commitment', 'walletLamports', 'tokenBalanceCount', 'openPositions', 'realizedNetPnlRaw',
] as const);
const SNAPSHOT_KEYS = Object.freeze(['snapshotId', 'payloadVersion', 'snapshotFingerprint', ...INPUT_KEYS] as const);
const POSITION_KEYS = Object.freeze([
  'positionId', 'costBasisLamports', 'conservativeLiquidationLamports', 'reconciliationStatus',
] as const);

export interface ExecutionWalletSnapshotInputV1 {
  readonly generationId: string;
  readonly providerId: string;
  readonly stateRevision: bigint;
  readonly slot: bigint;
  readonly blockTimeMs: number | null;
  readonly observedAtMs: number;
  readonly commitment: 'finalized';
  readonly walletLamports: bigint;
  readonly tokenBalanceCount: number;
  readonly openPositions: readonly ExecutionOpenPositionRiskInputV1[];
  readonly realizedNetPnlRaw: bigint;
}

export interface ExecutionWalletSnapshotV1 extends ExecutionWalletSnapshotInputV1 {
  readonly snapshotId: string;
  readonly payloadVersion: 1;
  readonly snapshotFingerprint: string;
}

export class ExecutionWalletSnapshotValidationError extends TypeError {
  public constructor() { super('Invalid execution wallet snapshot.'); this.name = 'ExecutionWalletSnapshotValidationError'; }
}

export function createExecutionWalletSnapshot(input: unknown): ExecutionWalletSnapshotV1 {
  try {
    const fields = fieldsFrom(input);
    const snapshotFingerprint = fingerprintFor(fields);
    return Object.freeze({
      snapshotId: `execution_wallet_snapshot_${snapshotFingerprint}`, payloadVersion: 1,
      snapshotFingerprint, ...fields,
    });
  } catch { throw invalid(); }
}

export function assertExecutionWalletSnapshot(input: unknown): asserts input is ExecutionWalletSnapshotV1 {
  try {
    if (!Object.isFrozen(input)) throw invalid();
    const row = exactRecord(input, SNAPSHOT_KEYS);
    if (row.payloadVersion !== 1) throw invalid();
    const fields = fieldsFrom(pick(row, INPUT_KEYS));
    const snapshot = createExecutionWalletSnapshot(fields);
    if (row.snapshotId !== snapshot.snapshotId || row.snapshotFingerprint !== snapshot.snapshotFingerprint) throw invalid();
  } catch { throw invalid(); }
}

function fieldsFrom(input: unknown): ExecutionWalletSnapshotInputV1 {
  const row = exactRecord(input, INPUT_KEYS);
  const positions = positionsFrom(row.openPositions);
  return Object.freeze({
    generationId: patterned(row.generationId, /^execution_wallet_generation_[0-9a-f]{64}$/u, 96),
    providerId: text(row.providerId, 256), stateRevision: unsigned(row.stateRevision), slot: unsigned(row.slot),
    blockTimeMs: nullableTimestamp(row.blockTimeMs), observedAtMs: timestamp(row.observedAtMs),
    commitment: exactEnum(row.commitment, 'finalized'), walletLamports: unsigned(row.walletLamports),
    tokenBalanceCount: integer(row.tokenBalanceCount, 0, 2_147_483_647), openPositions: positions,
    realizedNetPnlRaw: signed(row.realizedNetPnlRaw),
  });
}

function positionsFrom(value: unknown): readonly ExecutionOpenPositionRiskInputV1[] {
  if (!Array.isArray(value) || isProxy(value) || value.length > 2) throw invalid();
  const positions: ExecutionOpenPositionRiskInputV1[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid();
    const row = exactRecord(descriptor.value, POSITION_KEYS);
    const positionId = text(row.positionId, 256);
    if (ids.has(positionId)) throw invalid();
    ids.add(positionId);
    const reconciliationStatus = row.reconciliationStatus;
    if (reconciliationStatus !== 'RECONCILED' && reconciliationStatus !== 'UNKNOWN') throw invalid();
    const costBasisLamports = unsigned(row.costBasisLamports);
    if (costBasisLamports === 0n) throw invalid();
    positions.push(Object.freeze({ positionId, costBasisLamports,
      conservativeLiquidationLamports: row.conservativeLiquidationLamports === null ? null : unsigned(row.conservativeLiquidationLamports), reconciliationStatus }));
  }
  return Object.freeze(positions);
}

function fingerprintFor(value: ExecutionWalletSnapshotInputV1): string {
  return hash(['execution-wallet-snapshot-v1', value.generationId, value.providerId,
    value.stateRevision.toString(), value.slot.toString(), value.blockTimeMs, value.observedAtMs,
    value.commitment, value.walletLamports.toString(), value.tokenBalanceCount,
    value.openPositions.map((position) => [position.positionId, position.costBasisLamports.toString(), position.conservativeLiquidationLamports?.toString() ?? null, position.reconciliationStatus]), value.realizedNetPnlRaw.toString()]);
}

function exactRecord<const Keys extends readonly string[]>(value: unknown, keys: Keys): Readonly<Record<Keys[number], unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) throw invalid();
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) throw invalid();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid(); result[key] = descriptor.value; }
  return result as Readonly<Record<Keys[number], unknown>>;
}
function pick<const Keys extends readonly string[]>(row: Readonly<Record<string, unknown>>, keys: Keys): Readonly<Record<Keys[number], unknown>> { const result = Object.create(null) as Record<string, unknown>; for (const key of keys) result[key] = row[key]; return result as Readonly<Record<Keys[number], unknown>>; }
function patterned(value: unknown, pattern: RegExp, max: number): string { if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max || !pattern.test(value)) throw invalid(); return value; }
function text(value: unknown, max: number): string { return patterned(value, /^[\x20-\x7E]{1,}$/u, max); }
function exactEnum(value: unknown, expected: 'finalized'): 'finalized' { if (value !== expected) throw invalid(); return expected; }
function integer(value: unknown, min: number, max: number): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid(); return value as number; }
function timestamp(value: unknown): number { return integer(value, 0, DATE_MAX_MS); }
function nullableTimestamp(value: unknown): number | null { return value === null ? null : timestamp(value); }
function unsigned(value: unknown): bigint { if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw invalid(); return value; }
function signed(value: unknown): bigint { if (typeof value !== 'bigint' || value < I128_MIN || value > I128_MAX) throw invalid(); return value; }
function hash(values: readonly unknown[]): string { const digest = createHash('sha256'); for (const value of values) { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'); digest.update(String(bytes.length)); digest.update(':'); digest.update(bytes); } return digest.digest('hex'); }
function invalid(): ExecutionWalletSnapshotValidationError { return new ExecutionWalletSnapshotValidationError(); }

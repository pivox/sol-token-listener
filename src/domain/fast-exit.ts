import { isProxy } from 'node:util/types';
import { isCanonicalSolanaPublicKey } from './solana-public-key.js';

/** Strategy id of every early (non-deadline) SELL intent. */
export const FAST_EXIT_STRATEGY_ID = 'fast-entry-exit-v1';
/** Early exit reasons, in evaluation order. */
export const FAST_EXIT_REASONS = Object.freeze(
  ['ENVELOPE_REVOKED', 'CREATOR_SOLD', 'TAKE_PROFIT', 'EXTERNAL_BUYERS'] as const,
);
export type FastExitReason = typeof FAST_EXIT_REASONS[number];
export type ExitReason = FastExitReason | 'DEADLINE';

/** A re-exit replaces a dead SELL intent at most this many times per position. */
export const MAXIMUM_RE_EXITS = 3;

export interface FastExitPolicy {
  readonly takeProfitBps: bigint;
  readonly externalBuyersTarget: number;
  readonly externalMinimumBuyRaw: bigint;
}

export interface FastExitTrade {
  readonly eventId: string;
  readonly kind: 'BUY' | 'SELL';
  readonly trader: string | null;
  readonly baseAmountRaw: bigint;
  readonly quoteAmountRaw: bigint;
  readonly slot: bigint;
  readonly transactionIndex: number;
  readonly instructionIndex: number;
  readonly innerInstructionIndex: number | null;
}

export interface FastExitFacts {
  /** ACTIVE | EXHAUSTED | REVOKED | EXPIRED */
  readonly envelopeState: string;
  /** null = unknown or ambiguous. */
  readonly creator: string | null;
  readonly walletPublicKey: string;
  readonly remainingBaseRaw: bigint;
  readonly quoteCostRaw: bigint;
  /** null = unreadable. Already filtered: slot > entry, WSOL, confirmed|finalized. */
  readonly trades: readonly FastExitTrade[] | null;
}

const BPS_DENOMINATOR = 10_000n;
const U64_MAX = 18_446_744_073_709_551_615n;
const MINIMUM_TAKE_PROFIT_BPS = 10_001n;
const MAXIMUM_TAKE_PROFIT_BPS = 100_000n;
const MAXIMUM_BUYERS_TARGET = 1_000;
const MAXIMUM_TRADES = 100_000;
const MAXIMUM_EVENT_ID_BYTES = 256;
const ENVELOPE_STATES = Object.freeze(['ACTIVE', 'EXHAUSTED', 'REVOKED', 'EXPIRED'] as const);
const POSITION_ID = 'execution_live_position_[0-9a-f]{64}';
const POSITION_ID_PATTERN = new RegExp(`^${POSITION_ID}$`, 'u');
const LOGICAL_KEY_PATTERN = new RegExp(
  `^(?<root>(?:maximum-holding|fast-exit:(?<reason>[A-Z_]+)):${POSITION_ID})(?::retry-(?<retry>[1-9][0-9]*))?$`,
  'u',
);

const FACT_KEYS = Object.freeze([
  'envelopeState', 'creator', 'walletPublicKey', 'remainingBaseRaw', 'quoteCostRaw', 'trades',
] as const);
const POLICY_KEYS = Object.freeze(['takeProfitBps', 'externalBuyersTarget', 'externalMinimumBuyRaw'] as const);
const TRADE_KEYS = Object.freeze([
  'eventId', 'kind', 'trader', 'baseAmountRaw', 'quoteAmountRaw', 'slot', 'transactionIndex',
  'instructionIndex', 'innerInstructionIndex',
] as const);

/**
 * Early exit of an envelope position, first true rule wins; null = no early exit. Throws
 * TypeError on a malformed policy, wallet, amount or envelope state: the caller treats that as
 * "no early exit" (the deadline stays). REVOKED never depends on trade data.
 */
export function decideFastExit(facts: FastExitFacts, policy: FastExitPolicy): FastExitReason | null {
  const rules = policyFrom(policy);
  const record = exactFrozenRecord(facts, FACT_KEYS);
  const envelopeState = record.envelopeState;
  if (typeof envelopeState !== 'string' || !(ENVELOPE_STATES as readonly string[]).includes(envelopeState)) {
    throw invalid();
  }
  // A revoked envelope exits whatever the trade data looks like.
  if (envelopeState === 'REVOKED') return 'ENVELOPE_REVOKED';
  const input = factsFrom(record);
  const trades = input.trades;
  if (trades === null) return null;
  if (input.creator !== null
    && trades.some((trade) => trade.kind === 'SELL' && trade.trader === input.creator)) {
    return 'CREATOR_SOLD';
  }
  if (input.quoteCostRaw > 0n) {
    let last: FastExitTrade | null = null;
    for (const trade of trades) {
      if (trade.trader === input.walletPublicKey || trade.baseAmountRaw <= 0n) continue;
      if (last === null || compareCursor(trade, last) > 0) last = trade;
    }
    if (last !== null
      && input.remainingBaseRaw * last.quoteAmountRaw * BPS_DENOMINATOR
        >= input.quoteCostRaw * rules.takeProfitBps * last.baseAmountRaw) {
      return 'TAKE_PROFIT';
    }
  }
  const buyers = new Set<string>();
  for (const trade of trades) {
    if (trade.kind !== 'BUY' || trade.trader === null || trade.trader === input.creator
      || trade.trader === input.walletPublicKey
      || trade.quoteAmountRaw < rules.externalMinimumBuyRaw) continue;
    buyers.add(trade.trader);
  }
  if (buyers.size >= rules.externalBuyersTarget) return 'EXTERNAL_BUYERS';
  return null;
}

/** Validated, frozen copy of a fast exit policy; throws TypeError when it is malformed. */
export function validFastExitPolicy(policy: FastExitPolicy): FastExitPolicy {
  return policyFrom(policy);
}

export function fastExitLogicalCommandId(reason: FastExitReason, positionId: string): string {
  if (typeof reason !== 'string' || !(FAST_EXIT_REASONS as readonly string[]).includes(reason)) {
    throw new TypeError('Invalid fast exit reason.');
  }
  if (typeof positionId !== 'string' || !POSITION_ID_PATTERN.test(positionId)) {
    throw new TypeError('Invalid live position id.');
  }
  return `fast-exit:${reason}:${positionId}`;
}

/** Exit reason of a SELL logical command id / tombstone logical order key; null when unknown. */
export function exitReasonOfLogicalKey(key: string): ExitReason | null {
  return parseLogicalKey(key)?.reason ?? null;
}

/** Logical command id of the next re-exit; null after the cap or for an unknown key. */
export function reExitLogicalCommandId(currentLogicalCommandId: string): string | null {
  const parsed = parseLogicalKey(currentLogicalCommandId);
  if (parsed === null || parsed.retry + 1 > MAXIMUM_RE_EXITS) return null;
  return `${parsed.root}:retry-${parsed.retry + 1}`;
}

function parseLogicalKey(key: unknown): { root: string; reason: ExitReason; retry: number } | null {
  if (typeof key !== 'string' || key.length > 256) return null;
  const groups = LOGICAL_KEY_PATTERN.exec(key)?.groups;
  if (groups?.root === undefined) return null;
  const retry = groups.retry === undefined ? 0 : Number(groups.retry);
  if (retry > MAXIMUM_RE_EXITS) return null;
  let reason: ExitReason;
  if (groups.reason === undefined) {
    reason = 'DEADLINE';
  } else if ((FAST_EXIT_REASONS as readonly string[]).includes(groups.reason)) {
    reason = groups.reason as FastExitReason;
  } else {
    return null;
  }
  return { root: groups.root, reason, retry };
}

function compareCursor(left: FastExitTrade, right: FastExitTrade): number {
  if (left.slot !== right.slot) return left.slot > right.slot ? 1 : -1;
  if (left.transactionIndex !== right.transactionIndex) return left.transactionIndex - right.transactionIndex;
  if (left.instructionIndex !== right.instructionIndex) return left.instructionIndex - right.instructionIndex;
  const leftInner = left.innerInstructionIndex ?? -1;
  const rightInner = right.innerInstructionIndex ?? -1;
  if (leftInner !== rightInner) return leftInner - rightInner;
  // Deterministic last resort only: two trades at the same on-chain position should not exist.
  if (left.eventId === right.eventId) return 0;
  return left.eventId > right.eventId ? 1 : -1;
}

/**
 * Wallet and amounts must be valid (throws). A malformed creator becomes null, and a malformed
 * trade list, or any malformed trade in it, drops the whole list (null): never a single trade.
 */
function factsFrom(record: Readonly<Record<(typeof FACT_KEYS)[number], unknown>>): FastExitFacts {
  const walletPublicKey = publicKey(record.walletPublicKey);
  const remainingBaseRaw = amount(record.remainingBaseRaw);
  const quoteCostRaw = amount(record.quoteCostRaw);
  let creator: string | null = null;
  try {
    creator = record.creator === null ? null : publicKey(record.creator);
  } catch {
    creator = null;
  }
  let trades: readonly FastExitTrade[] | null = null;
  try {
    trades = record.trades === null ? null : tradesFrom(record.trades);
  } catch {
    trades = null;
  }
  return Object.freeze({
    envelopeState: record.envelopeState as string,
    creator,
    walletPublicKey,
    remainingBaseRaw,
    quoteCostRaw,
    trades,
  });
}

function tradesFrom(list: unknown): readonly FastExitTrade[] {
  if (!Array.isArray(list) || isProxy(list) || !Object.isFrozen(list)
    || list.length > MAXIMUM_TRADES) throw invalid();
  return Object.freeze(Array.from(list, tradeFrom));
}

function tradeFrom(value: unknown): FastExitTrade {
  const record = exactFrozenRecord(value, TRADE_KEYS);
  const eventId = record.eventId;
  if (typeof eventId !== 'string' || eventId === ''
    || Buffer.byteLength(eventId, 'utf8') > MAXIMUM_EVENT_ID_BYTES) throw invalid();
  if (record.kind !== 'BUY' && record.kind !== 'SELL') throw invalid();
  return Object.freeze({
    eventId,
    kind: record.kind,
    trader: record.trader === null ? null : publicKey(record.trader),
    baseAmountRaw: amount(record.baseAmountRaw),
    quoteAmountRaw: amount(record.quoteAmountRaw),
    slot: amount(record.slot),
    transactionIndex: index(record.transactionIndex),
    instructionIndex: index(record.instructionIndex),
    innerInstructionIndex: record.innerInstructionIndex === null ? null : index(record.innerInstructionIndex),
  });
}

function policyFrom(value: unknown): FastExitPolicy {
  const record = exactFrozenRecord(value, POLICY_KEYS);
  const takeProfitBps = record.takeProfitBps;
  if (typeof takeProfitBps !== 'bigint' || takeProfitBps < MINIMUM_TAKE_PROFIT_BPS
    || takeProfitBps > MAXIMUM_TAKE_PROFIT_BPS) throw invalid();
  const target = record.externalBuyersTarget;
  if (!Number.isSafeInteger(target) || (target as number) < 1
    || (target as number) > MAXIMUM_BUYERS_TARGET) throw invalid();
  const minimumBuy = amount(record.externalMinimumBuyRaw);
  if (minimumBuy < 1n) throw invalid();
  return Object.freeze({
    takeProfitBps, externalBuyersTarget: target as number, externalMinimumBuyRaw: minimumBuy,
  });
}

function exactFrozenRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)
    || !Object.isFrozen(value)) throw invalid();
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
  return Object.freeze(result);
}

function publicKey(value: unknown): string {
  if (typeof value !== 'string' || !isCanonicalSolanaPublicKey(value)) throw invalid();
  return value;
}

function amount(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw invalid();
  return value;
}

function index(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_147_483_647) throw invalid();
  return value as number;
}

function invalid(): TypeError {
  return new TypeError('Invalid fast exit input.');
}

import { isProxy } from 'node:util/types';
import { PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from './constants.js';
import { PUMP_EVENTS } from './generated/pump-idl.js';

export const PUMPFUN_WEBSOCKET_HINTS = Object.freeze([
  'NONE',
  'PUMPFUN_CREATE',
  'PUMPFUN_TRADE',
] as const);

export type PumpFunWebSocketHint = (typeof PUMPFUN_WEBSOCKET_HINTS)[number];
export type PumpFunWebSocketClassificationMode = 'legacy' | 'strict-admission';

export interface PumpFunWebSocketCreateHint {
  readonly hint: PumpFunWebSocketHint;
  readonly hintMint: string | null;
}

export const MAX_PUMPFUN_WEBSOCKET_LOG_COUNT = 256;
export const MAX_PUMPFUN_WEBSOCKET_LOG_LINE_BYTES = 16_384;
export const MAX_PUMPFUN_WEBSOCKET_LOG_TOTAL_BYTES = 65_536;

const PROGRAM_DATA_PREFIX = 'Program data: ';
const RUNTIME_LOG_TRUNCATED = 'Log truncated';
const RUNTIME_PROGRAM_INVOCATION = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[[1-9][0-9]*\]$/u;
const PASSIVE_PROGRAM_INVOCATION = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[([1-9][0-9]*)\]$/u;
const PASSIVE_PROGRAM_SUCCESS = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) success$/u;
const PASSIVE_PROGRAM_CONSUMPTION = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) consumed (0|[1-9][0-9]*) of (0|[1-9][0-9]*) compute units$/u;
const MAX_VETO_PROGRAM_COUNT = 16;
const CREATE_EVENT_DISCRIMINATOR = Buffer.from(PUMP_EVENTS.CreateEvent.discriminator);
const TRADE_EVENT_DISCRIMINATOR = Buffer.from(PUMP_EVENTS.TradeEvent.discriminator);
const TRADE_EVENT_MINT_OFFSET = TRADE_EVENT_DISCRIMINATOR.length;
const TRADE_EVENT_MINT_LENGTH = 32;
const NONE_HINT: PumpFunWebSocketCreateHint = Object.freeze({ hint: 'NONE', hintMint: null });
const CREATE_HINT: PumpFunWebSocketCreateHint = Object.freeze({
  hint: 'PUMPFUN_CREATE', hintMint: null,
});

/**
 * A narrow proof over intact RPC runtime logs, not an instruction inventory or
 * authentication against a provider removing whole frames. False means unknown.
 * Stable control grammar: anza-xyz/agave program-runtime/src/stable_log.rs.
 * Program text stays opaque; unsupported log forms deliberately fail open.
 * The coordinator supplies additional veto programs (including PumpSwap).
 */
export function isPassivePumpMentionFromLogs(
  logs: unknown,
  vetoProgramIds: unknown = [],
): boolean {
  const snapshot = snapshotLogs(logs);
  const vetoPrograms = snapshotVetoPrograms(vetoProgramIds);
  if (snapshot === null || snapshot.length === 0 || vetoPrograms === null) return false;
  const stack: string[] = [];
  let invoked = false;
  for (const line of snapshot) {
    // Never split or normalize program-controlled text into runtime records.
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line)) return false;
    const invocation = PASSIVE_PROGRAM_INVOCATION.exec(line);
    if (invocation !== null) {
      const program = invocation[1];
      if (program === undefined || invocation[2] !== String(stack.length + 1)
        || program === PUMP_PROGRAM_ID || vetoPrograms.has(program)) return false;
      try {
        if (new PublicKey(program).toBase58() !== program) return false;
      } catch {
        return false;
      }
      stack.push(program);
      invoked = true;
      continue;
    }
    const current = stack.at(-1);
    if (current === undefined) return false;
    const success = PASSIVE_PROGRAM_SUCCESS.exec(line);
    if (success !== null) {
      if (success[1] !== current) return false;
      stack.pop();
      continue;
    }
    if (line.startsWith('Program log: ')) continue;
    const consumption = PASSIVE_PROGRAM_CONSUMPTION.exec(line);
    if (consumption !== null) {
      const consumed = Number(consumption[2]);
      const available = Number(consumption[3]);
      if (consumption[1] !== current || !Number.isSafeInteger(consumed)
        || !Number.isSafeInteger(available) || consumed > available) return false;
      continue;
    }
    // Includes truncation, failures, data/return payloads and unknown grammar.
    return false;
  }
  return invoked && stack.length === 0;
}

export function pumpFunCreateHintFromLogs(logs: unknown): PumpFunWebSocketHint {
  const { hint } = pumpFunWebSocketHintFromLogs(logs);
  return hint === 'PUMPFUN_CREATE' ? hint : 'NONE';
}

export function pumpFunWebSocketHintFromLogs(
  logs: unknown,
  vetoProgramIds: unknown = [],
  mode: PumpFunWebSocketClassificationMode = 'legacy',
): PumpFunWebSocketCreateHint {
  if (!isClassificationMode(mode)) return NONE_HINT;
  const snapshot = snapshotLogs(logs);
  const vetoPrograms = snapshotVetoPrograms(vetoProgramIds);
  if (snapshot === null || vetoPrograms === null) return NONE_HINT;
  let firstTradeMint: string | null = null;
  let hasCreateEvent = false;
  let hasAmbiguousEvent = false;
  for (const line of snapshot) {
    const invokedProgram = RUNTIME_PROGRAM_INVOCATION.exec(line)?.[1];
    if (line === RUNTIME_LOG_TRUNCATED
      || (invokedProgram !== undefined && vetoPrograms.has(invokedProgram))) {
      hasAmbiguousEvent = true;
      continue;
    }
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const encoded = line.slice(PROGRAM_DATA_PREFIX.length);
    if (!canonicalBase64(encoded)) {
      hasAmbiguousEvent = true;
      continue;
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length >= CREATE_EVENT_DISCRIMINATOR.length
      && decoded.subarray(0, CREATE_EVENT_DISCRIMINATOR.length)
        .equals(CREATE_EVENT_DISCRIMINATOR)) {
      hasCreateEvent = true;
      continue;
    }
    if (isPrefixOfEventDiscriminator(decoded)) {
      hasAmbiguousEvent = true;
      continue;
    }
    if (decoded.subarray(0, TRADE_EVENT_DISCRIMINATOR.length)
      .equals(TRADE_EVENT_DISCRIMINATOR)) {
      if (decoded.length < TRADE_EVENT_MINT_OFFSET + TRADE_EVENT_MINT_LENGTH) {
        hasAmbiguousEvent = true;
        continue;
      }
      try {
        const tradeMint = new PublicKey(
          decoded.subarray(TRADE_EVENT_MINT_OFFSET, TRADE_EVENT_MINT_OFFSET + TRADE_EVENT_MINT_LENGTH),
        ).toBase58();
        if (firstTradeMint === null) firstTradeMint = tradeMint;
        else if (firstTradeMint !== tradeMint) hasAmbiguousEvent = true;
      } catch {
        hasAmbiguousEvent = true;
      }
    }
  }
  // OFF preserves the pre-admission CREATE precedence, including ambiguous logs.
  if (hasCreateEvent && (mode === 'legacy' || !hasAmbiguousEvent)) return CREATE_HINT;
  return firstTradeMint === null || hasAmbiguousEvent
    ? NONE_HINT
    : Object.freeze({ hint: 'PUMPFUN_TRADE', hintMint: firstTradeMint });
}

function isClassificationMode(value: unknown): value is PumpFunWebSocketClassificationMode {
  return value === 'legacy' || value === 'strict-admission';
}

function snapshotVetoPrograms(value: unknown): ReadonlySet<string> | null {
  const programs = snapshotLogs(value);
  if (programs === null || programs.length > MAX_VETO_PROGRAM_COUNT) return null;
  try {
    for (const program of programs) {
      if (program.length < 32 || program.length > 44
        || new PublicKey(program).toBase58() !== program) return null;
    }
    return new Set(programs);
  } catch {
    return null;
  }
}

function isPrefixOfEventDiscriminator(decoded: Buffer): boolean {
  return (decoded.length > 0
      && decoded.length < CREATE_EVENT_DISCRIMINATOR.length
      && CREATE_EVENT_DISCRIMINATOR.subarray(0, decoded.length).equals(decoded))
    || (decoded.length > 0
      && decoded.length < TRADE_EVENT_DISCRIMINATOR.length
      && TRADE_EVENT_DISCRIMINATOR.subarray(0, decoded.length).equals(decoded));
}

function snapshotLogs(value: unknown): readonly string[] | null {
  try {
    if (isProxy(value) || !Array.isArray(value)) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length: unknown = lengthDescriptor !== undefined && 'value' in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (!Number.isSafeInteger(length)
      || (length as number) < 0
      || (length as number) > MAX_PUMPFUN_WEBSOCKET_LOG_COUNT) return null;
    const size = length as number;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== size + 1 || !keys.includes('length')) return null;
    const logs: string[] = [];
    let totalBytes = 0;
    for (let index = 0; index < size; index += 1) {
      const key = String(index);
      if (!keys.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const line: unknown = descriptor !== undefined
        && descriptor.enumerable
        && 'value' in descriptor
        ? descriptor.value
        : undefined;
      if (typeof line !== 'string') return null;
      const bytes = Buffer.byteLength(line, 'utf8');
      totalBytes += bytes;
      if (bytes > MAX_PUMPFUN_WEBSOCKET_LOG_LINE_BYTES
        || totalBytes > MAX_PUMPFUN_WEBSOCKET_LOG_TOTAL_BYTES) return null;
      logs.push(line);
    }
    return Object.freeze(logs);
  } catch {
    return null;
  }
}

function canonicalBase64(value: string): boolean {
  return value.length >= 12
    && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value;
}

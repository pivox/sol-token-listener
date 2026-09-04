import { isProxy } from 'node:util/types';
import pino, { type DestinationStream } from 'pino';

export type LiveRecoveryLaneName = 'RECONCILIATION' | 'CONFIRMATION' | 'DEADLINE';

export interface LiveRecoveryLogContext {
  readonly event?: string;
  readonly executionMode?: 'live-recovery';
  readonly lane?: LiveRecoveryLaneName;
  readonly result?: 'DEFERRED' | 'WORKED';
  readonly errorCode?: string;
  readonly providerPosition?: number;
  readonly durationMs?: number;
}

export interface LiveRecoveryLogger {
  readonly info: (context: LiveRecoveryLogContext) => void;
  readonly warn: (context: LiveRecoveryLogContext) => void;
  readonly error: (context: LiveRecoveryLogContext) => void;
}

const CONTEXT_KEYS = Object.freeze([
  'event', 'executionMode', 'lane', 'result', 'errorCode',
  'providerPosition', 'durationMs',
] as const);
const SECRET_KEYS = Object.freeze([
  'EXECUTOR_PRIVATE_KEY', 'EXECUTOR_SECRET_KEY', 'EXECUTOR_KEYPAIR',
  'EXECUTOR_KEYPAIR_PATH', 'SOLANA_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY_BASE58',
  'SOLANA_SECRET_KEY', 'SOLANA_KEYPAIR', 'SOLANA_KEYPAIR_PATH',
  'WALLET_PRIVATE_KEY', 'WALLET_KEYPAIR', 'WALLET_KEYPAIR_PATH', 'ANCHOR_WALLET',
] as const);
const REDACTED_PATHS = Object.freeze([
  'url', 'databaseUrl', 'httpRpcUrl', 'signature', 'mint', 'amount',
  'quoteAmountRaw', 'baseAmountRaw', 'signedTransactionBytes', 'err', 'error',
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((key) => `*.${key}`),
]);

export function createLiveRecoveryLogger(destination?: DestinationStream): LiveRecoveryLogger {
  const internal = destination === undefined
    ? pino(options())
    : pino(options(), destination);
  const write = (
    level: 'info' | 'warn' | 'error',
    context: LiveRecoveryLogContext,
  ): void => {
    const safe = safeContext(context);
    if (safe === null) return;
    switch (level) {
      case 'info': internal.info(safe); break;
      case 'warn': internal.warn(safe); break;
      case 'error': internal.error(safe); break;
    }
  };
  return Object.freeze({
    info: (context: LiveRecoveryLogContext) => { write('info', context); },
    warn: (context: LiveRecoveryLogContext) => { write('warn', context); },
    error: (context: LiveRecoveryLogContext) => { write('error', context); },
  });
}

function options(): pino.LoggerOptions {
  return {
    base: { service: 'sol-token-executor-live-recovery' },
    redact: { paths: REDACTED_PATHS as unknown as string[], censor: '[REDACTED]' },
  };
}

function safeContext(value: unknown): LiveRecoveryLogContext | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const safe: Record<string, string | number> = {};
    for (const key of CONTEXT_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (!descriptor.enumerable || !('value' in descriptor)
        || !safeValue(key, descriptor.value)) return null;
      safe[key] = descriptor.value;
    }
    return Object.keys(safe).length === 0 ? null : Object.freeze(safe);
  } catch {
    return null;
  }
}

function safeValue(
  key: typeof CONTEXT_KEYS[number],
  value: unknown,
): value is string | number {
  switch (key) {
    case 'event':
      return typeof value === 'string'
        && /^executor_live_recovery\.[a-z][a-z0-9_]{0,63}$/u.test(value);
    case 'executionMode': return value === 'live-recovery';
    case 'lane':
      return value === 'RECONCILIATION' || value === 'CONFIRMATION' || value === 'DEADLINE';
    case 'result': return value === 'DEFERRED' || value === 'WORKED';
    case 'errorCode':
      return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value);
    case 'providerPosition':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    case 'durationMs':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }
}

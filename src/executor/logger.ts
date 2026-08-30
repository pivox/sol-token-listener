import { isProxy } from 'node:util/types';
import pino, { type DestinationStream } from 'pino';

export interface ExecutorLogContext {
  readonly event?: string;
  readonly mode?: 'dry-run';
  readonly intentId?: string;
  readonly side?: 'BUY' | 'SELL';
  readonly outcome?: 'FOUNDATION_VALIDATED';
  readonly errorCode?: string;
}

export interface ExecutorLogger {
  readonly info: (context: ExecutorLogContext) => void;
  readonly warn: (context: ExecutorLogContext) => void;
  readonly error: (context: ExecutorLogContext) => void;
}

const CONTEXT_KEYS = Object.freeze([
  'event', 'mode', 'intentId', 'side', 'outcome', 'errorCode',
] as const);
const SECRET_KEYS = Object.freeze([
  'EXECUTOR_PRIVATE_KEY', 'EXECUTOR_SECRET_KEY', 'EXECUTOR_KEYPAIR',
  'EXECUTOR_KEYPAIR_PATH', 'SOLANA_PRIVATE_KEY', 'SOLANA_SECRET_KEY',
  'SOLANA_KEYPAIR', 'SOLANA_KEYPAIR_PATH', 'WALLET_PRIVATE_KEY',
  'WALLET_KEYPAIR', 'WALLET_KEYPAIR_PATH', 'ANCHOR_WALLET',
] as const);
const REDACTED_PATHS = Object.freeze([
  'url', 'databaseUrl', 'mint', 'amount', 'quoteAmountRaw', 'baseAmountRaw',
  'minimumAmountOutRaw', 'err', 'error',
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((key) => `*.${key}`),
]);

export function createExecutorLogger(destination?: DestinationStream): ExecutorLogger {
  const internal = destination === undefined
    ? pino(options())
    : pino(options(), destination);
  const write = (level: 'info' | 'warn' | 'error', context: ExecutorLogContext): void => {
    const safe = safeContext(context);
    if (safe === null) return;
    switch (level) {
      case 'info': internal.info(safe); break;
      case 'warn': internal.warn(safe); break;
      case 'error': internal.error(safe); break;
    }
  };
  return Object.freeze({
    info: (context: ExecutorLogContext) => { write('info', context); },
    warn: (context: ExecutorLogContext) => { write('warn', context); },
    error: (context: ExecutorLogContext) => { write('error', context); },
  });
}

function options(): pino.LoggerOptions {
  return {
    base: { service: 'sol-token-executor' },
    redact: { paths: REDACTED_PATHS as unknown as string[], censor: '[REDACTED]' },
  };
}

function safeContext(value: unknown): ExecutorLogContext | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const safe: Record<string, string> = {};
    for (const key of CONTEXT_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (!descriptor.enumerable || !('value' in descriptor) || !safeValue(key, descriptor.value)) {
        return null;
      }
      safe[key] = descriptor.value;
    }
    return Object.keys(safe).length === 0 ? null : Object.freeze(safe);
  } catch {
    return null;
  }
}

function safeValue(key: typeof CONTEXT_KEYS[number], value: unknown): value is string {
  if (typeof value !== 'string') return false;
  switch (key) {
    case 'event': return /^[a-z][a-z0-9_.-]{0,127}$/u.test(value);
    case 'mode': return value === 'dry-run';
    case 'intentId': return /^execution_intent_[0-9a-f]{64}$/u.test(value);
    case 'side': return value === 'BUY' || value === 'SELL';
    case 'outcome': return value === 'FOUNDATION_VALIDATED';
    case 'errorCode': return /^[A-Z][A-Z0-9_]{0,63}$/u.test(value);
  }
}

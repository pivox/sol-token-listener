import { isProxy } from 'node:util/types';
import pino, { type DestinationStream } from 'pino';

export type LiveExecutorLaneName = 'RECOVER_SELL' | 'SELL' | 'RECOVER_BUY' | 'BUY';

export interface LiveExecutorLogContext {
  readonly event?: string;
  readonly lane?: LiveExecutorLaneName;
  readonly result?: 'IDLE' | 'WORKED' | 'FAILED';
  readonly errorCode?: string;
}

export interface LiveExecutorLogger {
  readonly info: (context: LiveExecutorLogContext) => void;
  readonly warn: (context: LiveExecutorLogContext) => void;
  readonly error: (context: LiveExecutorLogContext) => void;
}

const CONTEXT_KEYS = Object.freeze(['event', 'lane', 'result', 'errorCode'] as const);

export function createLiveExecutorLogger(destination?: DestinationStream): LiveExecutorLogger {
  const internal = destination === undefined
    ? pino({ base: { service: 'sol-token-executor-live' } })
    : pino({ base: { service: 'sol-token-executor-live' } }, destination);
  const write = (level: 'info' | 'warn' | 'error', context: LiveExecutorLogContext): void => {
    const safe = safeContext(context);
    if (safe === null) return;
    internal[level](safe);
  };
  return Object.freeze({
    info: (context: LiveExecutorLogContext) => { write('info', context); },
    warn: (context: LiveExecutorLogContext) => { write('warn', context); },
    error: (context: LiveExecutorLogContext) => { write('error', context); },
  });
}

function safeContext(value: unknown): LiveExecutorLogContext | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      return null;
    }
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
    case 'lane': return value === 'RECOVER_SELL' || value === 'SELL'
      || value === 'RECOVER_BUY' || value === 'BUY';
    case 'result': return value === 'IDLE' || value === 'WORKED' || value === 'FAILED';
    case 'errorCode': return /^[A-Z][A-Z0-9_]{0,63}$/u.test(value);
  }
}

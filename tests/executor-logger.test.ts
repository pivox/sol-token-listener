import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createExecutorLogger } from '../src/executor/logger.js';

const LOGGER_SOURCE = readFileSync(new URL('../src/executor/logger.ts', import.meta.url), 'utf8');

const SECRET_KEYS = Object.freeze([
  'EXECUTOR_PRIVATE_KEY', 'EXECUTOR_SECRET_KEY', 'EXECUTOR_KEYPAIR',
  'EXECUTOR_KEYPAIR_PATH', 'SOLANA_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY_BASE58', 'SOLANA_SECRET_KEY',
  'SOLANA_KEYPAIR', 'SOLANA_KEYPAIR_PATH', 'WALLET_PRIVATE_KEY',
  'WALLET_KEYPAIR', 'WALLET_KEYPAIR_PATH', 'ANCHOR_WALLET',
] as const);

void test('redacts the exact 13 prohibited secret variables including the listener private key', () => {
  assert.equal(SECRET_KEYS.length, 13);
  assert.match(LOGGER_SOURCE, /'SOLANA_PRIVATE_KEY_BASE58'/u);
});

void test('emits the executor service base and only the closed safe context', () => {
  const sink = memorySink();
  const logger = createExecutorLogger(sink.stream);
  logger.info(Object.freeze({
    event: 'executor.pass_completed',
    mode: 'dry-run',
    intentId: `execution_intent_${'a'.repeat(64)}`,
    side: 'BUY',
    outcome: 'FOUNDATION_VALIDATED',
    reasonCode: 'INTENT_SUCCEEDED',
    providerId: 'primary',
    errorCode: 'NONE',
  }));

  const line = sink.single();
  assert.equal(line.service, 'sol-token-executor');
  assert.deepEqual(contextFrom(line), {
    event: 'executor.pass_completed', mode: 'dry-run',
    intentId: `execution_intent_${'a'.repeat(64)}`,
    side: 'BUY', outcome: 'FOUNDATION_VALIDATED', reasonCode: 'INTENT_SUCCEEDED',
    providerId: 'primary', errorCode: 'NONE',
  });
});

void test('drops URLs, mints, amounts, Error objects and every secret field before Pino serialization', () => {
  const sink = memorySink();
  const logger = createExecutorLogger(sink.stream);
  const hostileContext: Record<string, unknown> = {
    event: 'executor.pass_failed', mode: 'dry-run', side: 'SELL', errorCode: 'DATABASE_FAILURE',
    url: 'postgresql://executor:password@db.internal/executor',
    databaseUrl: 'postgresql://executor:password@db.internal/executor',
    mint: 'So11111111111111111111111111111111111111112',
    amount: '18446744073709551615', quoteAmountRaw: 18_446_744_073_709_551_615n,
    error: new Error('contains-password-and-mint'),
  };
  for (const key of SECRET_KEYS) hostileContext[key] = `value-for-${key}`;

  logger.error(hostileContext);

  const serialized = sink.raw();
  const line = sink.single();
  assert.deepEqual(contextFrom(line), {
    event: 'executor.pass_failed', mode: 'dry-run', side: 'SELL', errorCode: 'DATABASE_FAILURE',
  });
  for (const forbidden of [
    'postgresql://', 'password', 'So11111111111111111111111111111111111111112',
    '18446744073709551615', 'contains-password-and-mint', 'quoteAmountRaw',
    ...SECRET_KEYS,
  ]) assert.equal(serialized.includes(forbidden), false);
});

void test('does not invoke accessors or proxy traps from hostile log contexts', () => {
  const sink = memorySink();
  const logger = createExecutorLogger(sink.stream);
  let getterCalls = 0;
  const accessor: Record<string, unknown> = { event: 'executor.safe' };
  Object.defineProperty(accessor, 'error', {
    enumerable: true,
    get: () => { getterCalls += 1; throw new Error('getter-secret'); },
  });
  logger.warn(accessor);
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const proxy = new Proxy({ event: 'executor.proxy' }, {
    getPrototypeOf: () => { proxyTraps += 1; throw new Error('proxy-secret'); },
    ownKeys: () => { proxyTraps += 1; throw new Error('proxy-secret'); },
    getOwnPropertyDescriptor: () => { proxyTraps += 1; throw new Error('proxy-secret'); },
  });
  logger.info(proxy);

  assert.equal(proxyTraps, 0);
  assert.equal(sink.lines.length, 1);
  assert.deepEqual(contextFrom(sink.single()), { event: 'executor.safe' });
  assert.equal(sink.raw().includes('getter-secret'), false);
  assert.equal(sink.raw().includes('proxy-secret'), false);
});

function memorySink(): Readonly<{
  stream: { write(chunk: string): void };
  lines: string[];
  raw(): string;
  single(): Record<string, unknown>;
}> {
  const lines: string[] = [];
  return {
    stream: { write: (chunk: string) => { lines.push(chunk); } },
    lines,
    raw: () => lines.join(''),
    single: () => {
      assert.equal(lines.length, 1);
      const [line] = lines;
      assert.ok(line !== undefined);
      return JSON.parse(line) as Record<string, unknown>;
    },
  };
}

function contextFrom(line: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['event', 'mode', 'intentId', 'side', 'outcome', 'reasonCode', 'providerId', 'errorCode']) {
    if (Object.hasOwn(line, key)) result[key] = line[key];
  }
  const allowedMetadata = new Set([
    'level', 'time', 'service', 'event', 'mode', 'intentId', 'side', 'outcome',
    'reasonCode', 'providerId', 'errorCode',
  ]);
  assert.deepEqual(Object.keys(line).filter((key) => !allowedMetadata.has(key)), []);
  return result;
}

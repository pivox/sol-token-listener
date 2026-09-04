import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveExecutorLogger } from '../src/executor-live/logger.js';

void test('emits only the closed live executor context', () => {
  const sink = memorySink();
  const logger = createLiveExecutorLogger(sink.stream);

  logger.error(Object.freeze({
    event: 'executor_live.pass_failed',
    lane: 'SELL',
    errorCode: 'DATABASE_FAILURE',
  }));

  const line = sink.single();
  assert.equal(line.service, 'sol-token-executor-live');
  assert.equal(line.event, 'executor_live.pass_failed');
  assert.equal(line.lane, 'SELL');
  assert.equal(line.errorCode, 'DATABASE_FAILURE');
});

void test('drops secrets, economic values and hostile error objects before serialization', () => {
  const sink = memorySink();
  const logger = createLiveExecutorLogger(sink.stream);
  logger.error({
    event: 'executor_live.pass_failed',
    lane: 'BUY',
    errorCode: 'LIVE_EXECUTOR_PASS_FAILED',
    url: 'https://user:secret@rpc.example.test',
    databaseUrl: 'postgresql://user:secret@db.example.test/live',
    keypairPath: '/secret/wallet.json',
    signature: 'sensitive-signature',
    mint: 'sensitive-mint',
    amount: 123n,
    error: new Error('sensitive-error'),
  } as never);

  const raw = sink.raw();
  for (const marker of [
    'user:secret', '/secret/wallet.json', 'sensitive-signature', 'sensitive-mint',
    '123', 'sensitive-error', 'databaseUrl', 'keypairPath', 'signature', 'mint', 'amount',
  ]) assert.equal(raw.includes(marker), false);
});

function memorySink(): Readonly<{
  stream: { write(chunk: string): void };
  raw(): string;
  single(): Record<string, unknown>;
}> {
  const lines: string[] = [];
  return Object.freeze({
    stream: { write: (chunk: string) => { lines.push(chunk); } },
    raw: () => lines.join(''),
    single: () => {
      assert.equal(lines.length, 1);
      const line = lines[0];
      assert.ok(line !== undefined);
      return JSON.parse(line) as Record<string, unknown>;
    },
  });
}

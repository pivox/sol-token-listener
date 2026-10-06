import assert from 'node:assert/strict';
import test from 'node:test';
import { guardLiveDecisionConsumer } from '../src/application/production-listener-factory.js';

void test('coverage guard suppresses new live candidate dispatch while scanner or WS is degraded', async () => {
  let dispatches = 0;
  let blocked = 0;
  const guarded = guardLiveDecisionConsumer(async (_signal: string) => { dispatches += 1; },
    () => false, () => { blocked += 1; });
  assert.ok(guarded);
  await guarded('candidate');
  assert.equal(dispatches, 0);
  assert.equal(blocked, 1);
});

void test('coverage guard dispatches candidates when durable catch-up and WS are healthy', async () => {
  let dispatches = 0;
  const guarded = guardLiveDecisionConsumer(async (_signal: string) => { dispatches += 1; }, () => true, () => {});
  await guarded?.('candidate');
  assert.equal(dispatches, 1);
});

void test('coverage guard evaluates coverage per call from the consumer arguments', async () => {
  const dispatched: string[] = [];
  let blocked = 0;
  const guarded = guardLiveDecisionConsumer(
    async (_result: string, snapshot: { mint: string }) => { dispatched.push(snapshot.mint); },
    (_result, snapshot) => snapshot.mint === 'ok',
    () => { blocked += 1; },
  );
  assert.ok(guarded);
  await guarded('r', { mint: 'ok' });
  await guarded('r', { mint: 'ko' });
  assert.deepEqual(dispatched, ['ok']);
  assert.equal(blocked, 1);
});

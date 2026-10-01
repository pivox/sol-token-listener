import assert from 'node:assert/strict';
import test from 'node:test';
import * as factory from '../src/application/production-listener-factory.js';

void test('shutdown diagnostic forwards lifecycle and logs final counters once after close settles', async () => {
  assert.ok('passiveMentionDiagnosticSupervisor' in factory);
  let finish!: () => void;
  let starts = 0;
  let closes = 0;
  let count = 0;
  const events: unknown[] = [];
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  const started = Promise.resolve();
  const wrapped = factory.passiveMentionDiagnosticSupervisor({
    start() { starts += 1; return started; },
    state() { return 'RUNNING' as const; },
    activeProviderId() { return 'primary' as const; },
    close() { closes += 1; return closed; },
    filteredNotificationMetrics() { return { reasonCode: 'PASSIVE_PUMP_ACCOUNT_MENTION' as const,
      byProvider: { primary: count, 'fallback-1': 0, 'fallback-2': 0, 'fallback-3': 0 } }; },
  }, (event) => { events.push(event); });
  assert.equal(wrapped.start(), started);
  assert.equal(starts, 1);
  assert.equal(wrapped.state(), 'RUNNING');
  assert.equal(wrapped.activeProviderId(), 'primary');
  const first = wrapped.close();
  const second = wrapped.close();
  assert.equal(first, second);
  assert.equal(closes, 1);
  assert.equal(events.length, 0);
  count = 7;
  finish();
  await first;
  assert.deepEqual(events, [{ event: 'websocket_passive_mentions_shutdown',
    reasonCode: 'PASSIVE_PUMP_ACCOUNT_MENTION',
    byProvider: { primary: 7, 'fallback-1': 0, 'fallback-2': 0, 'fallback-3': 0 } }]);
});

void test('diagnostic failures never mask close success or original close failure', async () => {
  assert.ok('passiveMentionDiagnosticSupervisor' in factory);
  for (const fails of [false, true]) {
    for (const sync of [false, true]) {
      const original = new Error('original close failure');
      let logs = 0;
      const wrapped = factory.passiveMentionDiagnosticSupervisor({
        async start() {}, state() { return 'STOPPED' as const; }, activeProviderId() { return null; },
        close() {
          if (fails && sync) throw original;
          return fails ? Promise.reject(original) : Promise.resolve();
        },
        filteredNotificationMetrics() { return { reasonCode: 'PASSIVE_PUMP_ACCOUNT_MENTION' as const,
          byProvider: { primary: 0, 'fallback-1': 0, 'fallback-2': 0, 'fallback-3': 0 } }; },
      }, () => { logs += 1; throw new Error('diagnostic sink failed'); });
      if (fails) await assert.rejects(wrapped.close(), (error: unknown) => error === original);
      else await wrapped.close();
      assert.equal(logs, 1);
    }
  }
});

void test('metrics read failures cannot replace a close result', async () => {
  assert.ok('passiveMentionDiagnosticSupervisor' in factory);
  const wrapped = factory.passiveMentionDiagnosticSupervisor({
    async start() {}, state() { return 'STOPPED' as const; }, activeProviderId() { return null; },
    async close() {}, filteredNotificationMetrics() { throw new Error('read failed'); },
  }, () => { assert.fail('no metrics available'); });
  await wrapped.close();
});

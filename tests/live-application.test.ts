import assert from 'node:assert/strict';
import test from 'node:test';
import { startLiveApplication, type LiveApplicationComponents } from '../src/application/live-application.js';

void test('live application restores before listener start and keeps position management after entries stop', async () => {
  const events: string[] = [];
  const application = await startLiveApplication(async () => components(events));

  application.stopEntries();
  assert.deepEqual(events, ['lock', 'restore', 'listener-start', 'stop-entries']);
  assert.equal(application.entriesStopped, true);
  await application.close();
  assert.deepEqual(events, ['lock', 'restore', 'listener-start', 'stop-entries', 'listener-close', 'release', 'pool-close']);
});

void test('live application releases resources when restoration fails before listener start', async () => {
  const events: string[] = [];
  await assert.rejects(startLiveApplication(async () => ({
    ...components(events),
    controller: { restore: async () => { events.push('restore'); throw new Error('unresolved order'); }, stopEntries: () => undefined },
  })), /unresolved order/u);
  assert.deepEqual(events, ['lock', 'restore', 'release', 'pool-close']);
});

function components(events: string[]): LiveApplicationComponents {
  return {
    controller: { restore: async () => { events.push('restore'); }, stopEntries: () => { events.push('stop-entries'); } },
    listener: { start: async () => { events.push('listener-start'); }, close: async () => { events.push('listener-close'); } },
    acquireWalletLock: async () => { events.push('lock'); return { release: async () => { events.push('release'); } }; },
    closePool: async () => { events.push('pool-close'); },
  };
}

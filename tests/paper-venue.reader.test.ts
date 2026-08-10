import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresPaperVenueReader } from '../src/storage/paper-venue.reader.js';
import { toJsonValue } from '../src/utils/json.js';

void test('reads the latest canonical curve, migration and active PumpSwap pool', async () => {
  const calls: string[] = [];
  let released = false;
  const rows = [
    [{ complete: true }],
    [{ present: 1 }],
    [{ payload: toJsonValue({ baseMint: 'MintA', marker: 12n }) }],
  ];
  const reader = new PostgresPaperVenueReader(
    async () => 99n,
    {
      async connect() {
        return {
          async query(text: string) {
            calls.push(text);
            return { rows: rows[calls.length - 1] ?? [] };
          },
          release() { released = true; },
        };
      },
    },
  );

  const state = await reader.read('MintA');

  assert.deepEqual(state, {
    mint: 'MintA',
    bondingCurve: { active: false, complete: true },
    migrationObserved: true,
    pumpSwap: { active: true, pool: { baseMint: 'MintA', marker: 12n } },
    headSlot: 99n,
  });
  assert.equal(calls.length, 3);
  assert.match(calls[1] ?? '', /JOIN domain_events/u);
  assert.ok(Object.isFrozen(state.pumpSwap?.pool));
  assert.equal(released, true);
});

void test('releases the database client when a canonical venue read fails', async () => {
  let released = false;
  const reader = new PostgresPaperVenueReader(
    async () => 1n,
    {
      async connect() {
        return {
          async query() { throw new Error('private database failure'); },
          release() { released = true; },
        };
      },
    },
  );

  await assert.rejects(reader.read('MintA'));
  assert.equal(released, true);
});

void test('rejects an empty mint without acquiring a client', async () => {
  let connected = false;
  const reader = new PostgresPaperVenueReader(
    async () => 1n,
    {
      async connect() {
        connected = true;
        throw new Error('must not connect');
      },
    },
  );

  await assert.rejects(reader.read(''), TypeError);
  assert.equal(connected, false);
});

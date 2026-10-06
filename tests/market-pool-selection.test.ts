import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectTrackedPools,
  type TrackedPoolCandidate,
} from '../src/application/market-pool-selection.js';

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

function candidate(pool: string, ageHours: number, engaged = false): TrackedPoolCandidate {
  return Object.freeze({
    poolAddress: pool,
    baseMint: `mint-${pool}`,
    engaged,
    activatedAtMs: NOW - ageHours * HOUR,
    activationSignature: `sig-${pool}`,
    activationSlot: 1_000n,
  });
}

const options = { nowMs: NOW, windowMs: 6 * HOUR, maxPools: 3 };

void test('tracks pools inside the window and engaged pools outside it', () => {
  const result = selectTrackedPools([
    candidate('fresh', 1),
    candidate('stale', 7),
    candidate('held', 30, true),
  ], options);
  assert.deepEqual(result.tracked.map((pool) => pool.poolAddress).sort(), ['fresh', 'held']);
  assert.deepEqual(result.droppedByCap, []);
});

void test('the cap drops the oldest window-only pools first and never an engaged pool', () => {
  const result = selectTrackedPools([
    candidate('a', 1),
    candidate('b', 2),
    candidate('c', 3),
    candidate('held', 40, true),
  ], options);
  assert.deepEqual(result.tracked.map((pool) => pool.poolAddress), ['held', 'a', 'b']);
  assert.deepEqual(result.droppedByCap.map((pool) => pool.poolAddress), ['c']);
});

void test('engaged pools beyond the cap are all kept', () => {
  const result = selectTrackedPools([
    candidate('h1', 10, true), candidate('h2', 10, true),
    candidate('h3', 10, true), candidate('h4', 10, true),
    candidate('fresh', 1),
  ], options);
  assert.equal(result.tracked.length, 4);
  assert.deepEqual(result.droppedByCap.map((pool) => pool.poolAddress), ['fresh']);
});

void test('rejects invalid options', () => {
  assert.throws(() => selectTrackedPools([], { ...options, maxPools: 0 }), TypeError);
  assert.throws(() => selectTrackedPools([], { ...options, windowMs: -1 }), TypeError);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertValidStrictCatchUpFailure,
  createStrictCatchUpFailure,
  type StrictCatchUpFailure,
} from '../src/domain/strict-catch-up.js';

const detectedAtMs = 1_720_000_000_000;

void test('creates deterministic frozen strict catch-up failure evidence', () => {
  const previous = Object.freeze({
    key: 'launchpad' as const,
    slot: 42n,
    signature: 'previous-signature',
    updatedAtMs: detectedAtMs - 1,
  });
  const first = createStrictCatchUpFailure({
    checkpointKey: 'launchpad', previous, providerId: 'fallback-2', observedHeadSlot: 99n, detectedAtMs,
  });
  const replay = createStrictCatchUpFailure({
    checkpointKey: 'launchpad', previous, providerId: 'fallback-2', observedHeadSlot: 99n, detectedAtMs: detectedAtMs + 1,
  });

  assert.match(first.failureId, /^strict_catchup_failure_[a-f0-9]{64}$/u);
  assert.equal(first.failureId, replay.failureId);
  assert.equal(first.reasonCode, 'CATCH_UP_WINDOW_EXCEEDED');
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.previous));
  assert.notEqual(first.previous, previous);
  assert.doesNotThrow(() => { assertValidStrictCatchUpFailure(first); });
});

void test('accepts nullable boundaries and heads without making them equivalent', () => {
  const absent = createStrictCatchUpFailure({
    checkpointKey: 'market', previous: null, providerId: 'primary', observedHeadSlot: null, detectedAtMs,
  });
  const withHead = createStrictCatchUpFailure({
    checkpointKey: 'market', previous: null, providerId: 'primary', observedHeadSlot: 0n, detectedAtMs,
  });

  assert.equal(absent.previous, null);
  assert.equal(absent.observedHeadSlot, null);
  assert.notEqual(absent.failureId, withHead.failureId);
});

void test('rejects mutable, accessor-backed, non-canonical, and malformed strict failures', () => {
  const canonical = createStrictCatchUpFailure({
    checkpointKey: 'market',
    previous: Object.freeze({ key: 'market' as const, slot: 0n, signature: 'checkpoint-signature', updatedAtMs: detectedAtMs }),
    providerId: 'fallback-3', observedHeadSlot: 1n, detectedAtMs,
  });
  const accessor = Object.freeze(Object.defineProperty({
    checkpointKey: 'market', previous: null, observedHeadSlot: null, detectedAtMs,
  }, 'providerId', { enumerable: true, get: () => 'primary' }));
  const cases: unknown[] = [
    { ...canonical },
    Object.freeze({ ...canonical, failureId: 'strict_catchup_failure_bad' }),
    Object.freeze({ ...canonical, observedHeadSlot: -1n }),
    Object.freeze({ ...canonical, detectedAtMs: Number.NaN }),
  ];
  for (const value of cases) {
    assert.throws(() => { assertValidStrictCatchUpFailure(value); }, /strict catch-up failure/i);
  }
  assert.throws(() => createStrictCatchUpFailure(accessor), /strict catch-up failure/i);
  assert.throws(() => createStrictCatchUpFailure({
    checkpointKey: 'market',
    previous: Object.freeze({ key: 'market' as const, slot: 0n, signature: ` ${'x'.repeat(127)}`, updatedAtMs: detectedAtMs }),
    providerId: 'fallback-4' as never, observedHeadSlot: null, detectedAtMs,
  }), /strict catch-up failure/i);
});

void test('rejects a mismatched previous checkpoint key', () => {
  assert.throws(() => createStrictCatchUpFailure({
    checkpointKey: 'launchpad',
    previous: Object.freeze({ key: 'market' as const, slot: 1n, signature: 'checkpoint-signature', updatedAtMs: detectedAtMs }),
    providerId: 'primary', observedHeadSlot: 2n, detectedAtMs,
  }), /strict catch-up failure/i);
});

const _contract: StrictCatchUpFailure | null = null;
void _contract;

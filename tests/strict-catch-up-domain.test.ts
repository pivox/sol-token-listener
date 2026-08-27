import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_DATE_MS,
  MAX_STRICT_CATCH_UP_SLOT,
  assertValidStrictCatchUpFailure,
  createStrictCatchUpFailure,
  type StrictCatchUpFailure,
} from '../src/domain/strict-catch-up.js';
import type { RpcProviderId as DomainRpcProviderId } from '../src/domain/rpc-provider.js';

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

void test('accepts exact strict catch-up bigint and timestamp bounds', () => {
  assert.equal(MAX_STRICT_CATCH_UP_SLOT, 10n ** 78n - 1n);
  assert.equal(MAX_DATE_MS, 8_640_000_000_000_000);
  const value = createStrictCatchUpFailure({
    checkpointKey: 'market',
    previous: Object.freeze({
      key: 'market' as const,
      slot: MAX_STRICT_CATCH_UP_SLOT,
      signature: 'max-checkpoint',
      updatedAtMs: MAX_DATE_MS,
    }),
    providerId: 'fallback-1',
    observedHeadSlot: MAX_STRICT_CATCH_UP_SLOT,
    detectedAtMs: MAX_DATE_MS,
  });

  assert.equal(value.previous?.slot, MAX_STRICT_CATCH_UP_SLOT);
  assert.equal(value.observedHeadSlot, MAX_STRICT_CATCH_UP_SLOT);
  assert.equal(value.detectedAtMs, MAX_DATE_MS);
});

void test('rejects strict catch-up bigint and timestamp values beyond durable bounds', () => {
  const maximumPlusOne = MAX_STRICT_CATCH_UP_SLOT + 1n;
  const validPrevious = Object.freeze({
    key: 'market' as const,
    slot: 1n,
    signature: 'checkpoint',
    updatedAtMs: detectedAtMs,
  });
  const cases: readonly object[] = [
    {
      checkpointKey: 'market',
      previous: Object.freeze({ ...validPrevious, slot: maximumPlusOne }),
      providerId: 'primary', observedHeadSlot: null, detectedAtMs,
    },
    {
      checkpointKey: 'market', previous: validPrevious, providerId: 'primary',
      observedHeadSlot: maximumPlusOne, detectedAtMs,
    },
    {
      checkpointKey: 'market',
      previous: Object.freeze({ ...validPrevious, updatedAtMs: MAX_DATE_MS + 1 }),
      providerId: 'primary', observedHeadSlot: null, detectedAtMs,
    },
    {
      checkpointKey: 'market', previous: validPrevious, providerId: 'primary',
      observedHeadSlot: null, detectedAtMs: MAX_DATE_MS + 1,
    },
  ];
  for (const value of cases) {
    assert.throws(() => createStrictCatchUpFailure(value), /strict catch-up failure/i);
  }
});

void test('rejects top-level and nested proxies without invoking traps during create or assert', () => {
  const canonical = createStrictCatchUpFailure({
    checkpointKey: 'market',
    previous: Object.freeze({ key: 'market' as const, slot: 1n, signature: 'checkpoint', updatedAtMs: detectedAtMs }),
    providerId: 'primary', observedHeadSlot: 2n, detectedAtMs,
  });
  let traps = 0;
  const trap = (): never => {
    traps += 1;
    throw new Error('proxy trap must not run');
  };
  const topLevelInput = new Proxy({
    checkpointKey: 'market', previous: null, providerId: 'primary', observedHeadSlot: null, detectedAtMs,
  }, { getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  const nestedPrevious = new Proxy({}, {
    getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
  });
  const topLevelFailure = new Proxy(canonical, {
    getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
  });
  const nestedFailure = Object.freeze({ ...canonical, previous: nestedPrevious });

  assert.throws(() => createStrictCatchUpFailure(topLevelInput), /strict catch-up failure/i);
  assert.throws(() => createStrictCatchUpFailure({
    checkpointKey: 'market', previous: nestedPrevious, providerId: 'primary',
    observedHeadSlot: null, detectedAtMs,
  }), /strict catch-up failure/i);
  assert.throws(() => { assertValidStrictCatchUpFailure(topLevelFailure); }, /strict catch-up failure/i);
  assert.throws(() => { assertValidStrictCatchUpFailure(nestedFailure); }, /strict catch-up failure/i);
  assert.equal(traps, 0);
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

const _domainProvider: DomainRpcProviderId = 'fallback-3';
void _domainProvider;

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_STRICT_CATCH_UP_RUN_COUNTER,
  STRICT_CATCH_UP_RUN_ID_VERSION,
  STRICT_CATCH_UP_RUN_RETENTION_MS,
  STRICT_CATCH_UP_RUN_STATES,
  advanceStrictCatchUpRun,
  assertValidStrictCatchUpRun,
  createStrictCatchUpRun,
  terminalizeStrictCatchUpRun,
  type StrictCatchUpRun,
  type StrictCatchUpRunState,
  type StrictCatchUpRunTerminalReason,
} from '../src/domain/strict-catch-up-run.js';
import { MAX_DATE_MS, MAX_STRICT_CATCH_UP_SLOT } from '../src/domain/strict-catch-up.js';

const canonicalInput = () => ({
  checkpointKey: 'launchpad' as const,
  previous: Object.freeze({
    key: 'launchpad' as const,
    slot: 10n,
    signature: 'old',
    updatedAtMs: 1_000,
  }),
  providerId: 'primary' as const,
  observedHead: Object.freeze({ slot: 20n, signature: 'head' }),
  beforeSignature: 'tail',
  lastAcceptedSlot: 11n,
  pagesScanned: 1n,
  signaturesEnqueued: 9n,
  revision: 0n,
  startedAtMs: 2_000,
  updatedAtMs: 2_000,
});

void test('creates a deterministic immutable active strict catch-up run', () => {
  const input = canonicalInput();
  const first = createStrictCatchUpRun(input);
  const replay = createStrictCatchUpRun({ ...canonicalInput(), updatedAtMs: 2_001 });

  assert.equal(STRICT_CATCH_UP_RUN_ID_VERSION, 1);
  assert.deepEqual(STRICT_CATCH_UP_RUN_STATES, [
    'ACTIVE', 'COMPLETED', 'FAILED', 'SUPERSEDED',
  ]);
  assert.match(first.runId, /^strict_catchup_run_[a-f0-9]{64}$/u);
  assert.equal(first.runId, replay.runId);
  assert.equal(first.state, 'ACTIVE');
  assert.equal(first.terminalReason, null);
  assert.equal(first.completedAtMs, null);
  assert.equal(first.purgeAfterMs, null);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.previous));
  assert.ok(Object.isFrozen(first.observedHead));
  assert.notEqual(first.previous, input.previous);
  assert.notEqual(first.observedHead, input.observedHead);
  assert.doesNotThrow(() => { assertValidStrictCatchUpRun(first); });
});

void test('uses only the versioned checkpoint boundary and provider for run identity', () => {
  const canonical = canonicalInput();
  const first = createStrictCatchUpRun(canonical);
  const changedProgress = createStrictCatchUpRun({
    ...canonical,
    observedHead: Object.freeze({ slot: 30n, signature: 'different-head' }),
    beforeSignature: 'different-tail',
    lastAcceptedSlot: 12n,
    pagesScanned: 2n,
    signaturesEnqueued: 10n,
    revision: 5n,
    startedAtMs: 2_500,
    updatedAtMs: 3_000,
  });
  const changedBoundary = createStrictCatchUpRun({
    ...canonical,
    previous: Object.freeze({ ...canonical.previous, signature: 'other-old' }),
  });
  const changedProvider = createStrictCatchUpRun({ ...canonical, providerId: 'fallback-1' });

  assert.equal(first.runId, changedProgress.runId);
  assert.notEqual(first.runId, changedBoundary.runId);
  assert.notEqual(first.runId, changedProvider.runId);
});

void test('accepts exact durable slot, bigint counter, and timestamp bounds', () => {
  const run = createStrictCatchUpRun({
    checkpointKey: 'market',
    previous: Object.freeze({
      key: 'market', slot: MAX_STRICT_CATCH_UP_SLOT - 1n, signature: 'old', updatedAtMs: 0,
    }),
    providerId: 'fallback-3',
    observedHead: Object.freeze({ slot: MAX_STRICT_CATCH_UP_SLOT, signature: 'head' }),
    beforeSignature: 'tail',
    lastAcceptedSlot: MAX_STRICT_CATCH_UP_SLOT,
    pagesScanned: MAX_STRICT_CATCH_UP_RUN_COUNTER,
    signaturesEnqueued: MAX_STRICT_CATCH_UP_RUN_COUNTER,
    revision: MAX_STRICT_CATCH_UP_RUN_COUNTER,
    startedAtMs: MAX_DATE_MS,
    updatedAtMs: MAX_DATE_MS,
  });

  assert.equal(run.observedHead.slot, MAX_STRICT_CATCH_UP_SLOT);
  assert.equal(run.revision, MAX_STRICT_CATCH_UP_RUN_COUNTER);
  assert.equal(run.updatedAtMs, MAX_DATE_MS);
});

void test('rejects malformed creation input and durable bounds', () => {
  const base = canonicalInput();
  const cases: readonly unknown[] = [
    { ...base, extra: true },
    { ...base, checkpointKey: 'unknown' },
    { ...base, providerId: 'fallback-4' },
    { ...base, previous: Object.freeze({ ...base.previous, key: 'market' }) },
    { ...base, previous: Object.freeze({ ...base.previous, slot: -1n }) },
    { ...base, observedHead: Object.freeze({ ...base.observedHead, slot: MAX_STRICT_CATCH_UP_SLOT + 1n }) },
    { ...base, observedHead: Object.freeze({ ...base.observedHead, slot: 9n }) },
    { ...base, beforeSignature: ` ${'x'.repeat(127)}` },
    { ...base, observedHead: Object.freeze({ ...base.observedHead, signature: '' }) },
    { ...base, lastAcceptedSlot: 10n },
    { ...base, lastAcceptedSlot: 21n },
    { ...base, pagesScanned: 0n },
    { ...base, pagesScanned: 1 },
    { ...base, signaturesEnqueued: -1n },
    { ...base, revision: MAX_STRICT_CATCH_UP_RUN_COUNTER + 1n },
    { ...base, startedAtMs: 999 },
    { ...base, updatedAtMs: 1_999 },
    { ...base, updatedAtMs: MAX_DATE_MS + 1 },
  ];

  for (const value of cases) {
    assert.throws(() => createStrictCatchUpRun(value), /strict catch-up run/i);
  }
});

void test('rejects proxies and accessors without invoking traps', () => {
  const canonical = createStrictCatchUpRun(canonicalInput());
  let traps = 0;
  const trap = (): never => {
    traps += 1;
    throw new Error('proxy trap must not run');
  };
  const proxy = new Proxy(canonicalInput(), {
    getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
  });
  const nestedProxy = new Proxy({}, {
    getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
  });
  const runProxy = new Proxy(canonical, {
    getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
  });
  const accessor = Object.defineProperty({
    ...canonicalInput(),
  }, 'providerId', { enumerable: true, get: () => 'primary' });

  assert.throws(() => createStrictCatchUpRun(proxy), /strict catch-up run/i);
  assert.throws(() => createStrictCatchUpRun({
    ...canonicalInput(), observedHead: nestedProxy,
  }), /strict catch-up run/i);
  assert.throws(() => createStrictCatchUpRun(accessor), /strict catch-up run/i);
  assert.throws(() => { assertValidStrictCatchUpRun(runProxy); }, /strict catch-up run/i);
  assert.throws(() => { assertValidStrictCatchUpRun(Object.freeze({
    ...canonical, previous: nestedProxy,
  })); }, /strict catch-up run/i);
  assert.equal(traps, 0);
});

void test('assertion rejects mutable, non-canonical, and malformed runs', () => {
  const canonical = createStrictCatchUpRun(canonicalInput());
  const cases: readonly unknown[] = [
    { ...canonical },
    Object.freeze({ ...canonical, runId: 'strict_catchup_run_bad' }),
    Object.freeze({ ...canonical, previous: { ...canonical.previous } }),
    Object.freeze({ ...canonical, observedHead: { ...canonical.observedHead } }),
    Object.freeze({ ...canonical, terminalReason: 'CATCH_UP_WINDOW_EXCEEDED' }),
    Object.freeze({ ...canonical, completedAtMs: canonical.updatedAtMs }),
    Object.freeze({ ...canonical, purgeAfterMs: canonical.updatedAtMs + 14_400_000 }),
    Object.freeze({ ...canonical, extra: true }),
  ];

  for (const value of cases) {
    assert.throws(() => { assertValidStrictCatchUpRun(value); }, /strict catch-up run/i);
  }
});

void test('advances active progress with one revision and immutable snapshots', () => {
  const current = createStrictCatchUpRun(canonicalInput());
  const advanced = advanceStrictCatchUpRun(current, {
    beforeSignature: 'older-tail',
    lastAcceptedSlot: 11n,
    pagesScanned: 2n,
    signaturesEnqueued: 15n,
    updatedAtMs: 2_500,
  });

  assert.equal(advanced.runId, current.runId);
  assert.equal(advanced.revision, 1n);
  assert.equal(advanced.state, 'ACTIVE');
  assert.equal(advanced.beforeSignature, 'older-tail');
  assert.equal(advanced.pagesScanned, 2n);
  assert.equal(advanced.signaturesEnqueued, 15n);
  assert.ok(Object.isFrozen(advanced));
  assert.notEqual(advanced.previous, current.previous);
  assert.notEqual(advanced.observedHead, current.observedHead);
  assert.doesNotThrow(() => { assertValidStrictCatchUpRun(advanced); });
});

void test('rejects cursor and counter regression, no-op cursors, and revision overflow', () => {
  const current = createStrictCatchUpRun(canonicalInput());
  const valid = {
    beforeSignature: 'older-tail',
    lastAcceptedSlot: 11n,
    pagesScanned: 2n,
    signaturesEnqueued: 9n,
    updatedAtMs: 2_001,
  };
  const cases: readonly unknown[] = [
    { ...valid, beforeSignature: current.beforeSignature },
    { ...valid, lastAcceptedSlot: 12n },
    { ...valid, pagesScanned: 1n },
    { ...valid, signaturesEnqueued: 8n },
    { ...valid, updatedAtMs: 1_999 },
    { ...valid, extra: true },
  ];
  for (const value of cases) {
    assert.throws(() => advanceStrictCatchUpRun(current, value), /strict catch-up run/i);
  }

  const maximumRevision = createStrictCatchUpRun({
    ...canonicalInput(), revision: MAX_STRICT_CATCH_UP_RUN_COUNTER,
  });
  assert.throws(() => advanceStrictCatchUpRun(maximumRevision, valid), /strict catch-up run/i);
});

void test('terminalizes active runs with exact four-hour retention', () => {
  const current = createStrictCatchUpRun(canonicalInput());
  const completed = terminalizeStrictCatchUpRun(current, {
    state: 'COMPLETED', terminalReason: null, completedAtMs: 3_000,
  });
  const failed = terminalizeStrictCatchUpRun(current, {
    state: 'FAILED', terminalReason: 'CATCH_UP_WINDOW_EXCEEDED', completedAtMs: 3_001,
  });
  const superseded = terminalizeStrictCatchUpRun(current, {
    state: 'SUPERSEDED', terminalReason: 'CHECKPOINT_SUPERSEDED', completedAtMs: 3_002,
  });

  for (const terminal of [completed, failed, superseded]) {
    assert.equal(terminal.revision, 1n);
    assert.equal(terminal.updatedAtMs, terminal.completedAtMs);
    assert.equal(terminal.purgeAfterMs, terminal.completedAtMs! + STRICT_CATCH_UP_RUN_RETENTION_MS);
    assert.ok(Object.isFrozen(terminal));
    assert.doesNotThrow(() => { assertValidStrictCatchUpRun(terminal); });
  }
  assert.equal(STRICT_CATCH_UP_RUN_RETENTION_MS, 14_400_000);
  assert.equal(completed.terminalReason, null);
  assert.equal(failed.terminalReason, 'CATCH_UP_WINDOW_EXCEEDED');
  assert.equal(superseded.terminalReason, 'CHECKPOINT_SUPERSEDED');
});

void test('rejects invalid or repeated terminal transitions and retention overflow', () => {
  const current = createStrictCatchUpRun(canonicalInput());
  const completed = terminalizeStrictCatchUpRun(current, {
    state: 'COMPLETED', terminalReason: null, completedAtMs: 3_000,
  });
  const cases: readonly unknown[] = [
    { state: 'ACTIVE', terminalReason: null, completedAtMs: 3_000 },
    { state: 'COMPLETED', terminalReason: 'CATCH_UP_WINDOW_EXCEEDED', completedAtMs: 3_000 },
    { state: 'FAILED', terminalReason: null, completedAtMs: 3_000 },
    { state: 'FAILED', terminalReason: 'CHECKPOINT_SUPERSEDED', completedAtMs: 3_000 },
    { state: 'SUPERSEDED', terminalReason: 'CATCH_UP_WINDOW_EXCEEDED', completedAtMs: 3_000 },
    { state: 'SUPERSEDED', terminalReason: 'CHECKPOINT_SUPERSEDED', completedAtMs: 1_999 },
    { state: 'SUPERSEDED', terminalReason: 'CHECKPOINT_SUPERSEDED', completedAtMs: 3_000, extra: true },
  ];
  for (const value of cases) {
    assert.throws(() => terminalizeStrictCatchUpRun(current, value), /strict catch-up run/i);
  }
  assert.throws(() => terminalizeStrictCatchUpRun(completed, {
    state: 'COMPLETED', terminalReason: null, completedAtMs: 4_000,
  }), /strict catch-up run/i);

  const nearMaximum = createStrictCatchUpRun({
    ...canonicalInput(), startedAtMs: MAX_DATE_MS - 10_000, updatedAtMs: MAX_DATE_MS - 10_000,
  });
  assert.throws(() => terminalizeStrictCatchUpRun(nearMaximum, {
    state: 'COMPLETED', terminalReason: null, completedAtMs: MAX_DATE_MS,
  }), /strict catch-up run/i);
});

const _runContract: StrictCatchUpRun | null = null;
const _stateContract: StrictCatchUpRunState = 'ACTIVE';
const _reasonContract: StrictCatchUpRunTerminalReason = 'CHECKPOINT_SUPERSEDED';
void [_runContract, _stateContract, _reasonContract];

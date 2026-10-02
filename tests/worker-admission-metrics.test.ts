import assert from 'node:assert/strict';
import test from 'node:test';
import {
  snapshotRuntimeWorkerAdmissionClock as snapshotClock,
  snapshotRuntimeWorkerAdmissionMetrics,
  type RuntimeWorkerAdmissionMetricsV1,
} from '../src/domain/worker-admission-metrics.js';

type WorkerAdmissionMetricsInput = {
  -readonly [Key in keyof RuntimeWorkerAdmissionMetricsV1]: RuntimeWorkerAdmissionMetricsV1[Key];
};

const validInput = (overrides: Partial<WorkerAdmissionMetricsInput> = {}):
Readonly<WorkerAdmissionMetricsInput> => Object.freeze({
  version: 1,
  enabled: true,
  trackingWindowSeconds: 45,
  claimableBacklogCount: 8,
  classificationPendingCount: 2,
  oldestClassificationPendingAgeMs: 4_999,
  freshMintCount: 3,
  extendedMintCount: 2,
  demotedCount: 5,
  ...overrides,
});

void test('workerAdmissionClock.v1 returns exact detached frozen plain and null-prototype snapshots', () => {
  for (const input of [
    Object.freeze({ version: 1, sampledAtMs: 1 }),
    Object.freeze(Object.assign(Object.create(null) as object, {
      version: 1, sampledAtMs: 8_640_000_000_000_000,
    })),
  ]) {
    const snapshot = snapshotClock(input);
    assert.deepEqual(Reflect.ownKeys(snapshot), ['version', 'sampledAtMs']);
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.sampledAtMs, Reflect.get(input, 'sampledAtMs'));
    assert.notEqual(snapshot, input);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.getPrototypeOf(snapshot), Object.prototype);
  }
});

void test('workerAdmissionClock.v1 rejects nonexact records and noncanonical or unrepresentable timestamps', () => {
  for (const value of [
    null, undefined, [], 1, { version: 1, sampledAtMs: 1 },
    Object.freeze({ version: 1 }), Object.freeze({ sampledAtMs: 1 }),
    Object.freeze({ version: 2, sampledAtMs: 1 }),
    Object.freeze({ version: '1', sampledAtMs: 1 }),
    Object.freeze({ version: 1, sampledAtMs: 1, secret: 'do-not-leak' }),
    Object.freeze({ version: 1, sampledAtMs: 1, [Symbol('secret')]: 1 }),
    Object.freeze(Object.assign(Object.create({}) as object, { version: 1, sampledAtMs: 1 })),
    Object.freeze(Object.defineProperty({ version: 1 }, 'sampledAtMs', { value: 1 })),
    ...[0, -0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER,
      8_640_000_000_000_001, '1', 1n, null, undefined].map((sampledAtMs) => (
      Object.freeze({ version: 1, sampledAtMs })
    )),
  ]) {
    assert.throws(() => snapshotClock(value), {
      name: 'TypeError', message: 'Runtime worker admission clock is invalid.',
    });
  }
});

void test('workerAdmissionClock.v1 rejects proxies and accessors without executing user code', () => {
  let reads = 0;
  const hostile = (): never => { reads += 1; throw new Error('do-not-leak'); };
  const input = Object.freeze({ version: 1, sampledAtMs: 1 });
  const revoked = Proxy.revocable(input, {});
  revoked.revoke();
  for (const value of [
    new Proxy(input, { get: hostile, getPrototypeOf: hostile,
      getOwnPropertyDescriptor: hostile, ownKeys: hostile, isExtensible: hostile }),
    revoked.proxy,
    Object.freeze({ version: 1, get sampledAtMs() { return hostile(); } }),
    Object.freeze({ get version() { return hostile(); }, sampledAtMs: 1 }),
  ]) {
    assert.throws(() => snapshotClock(value), {
      name: 'TypeError', message: 'Runtime worker admission clock is invalid.',
    });
  }
  assert.equal(reads, 0);
});

void test('workerAdmission.v1 returns a detached frozen exact snapshot', () => {
  const input = validInput();
  const snapshot = snapshotRuntimeWorkerAdmissionMetrics(input);

  assert.deepEqual(snapshot, {
    version: 1,
    enabled: true,
    trackingWindowSeconds: 45,
    claimableBacklogCount: 8,
    classificationPendingCount: 2,
    oldestClassificationPendingAgeMs: 4_999,
    freshMintCount: 3,
    extendedMintCount: 2,
    demotedCount: 5,
  });
  assert.notEqual(snapshot, input);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(Reflect.ownKeys(snapshot), [
    'version',
    'enabled',
    'trackingWindowSeconds',
    'claimableBacklogCount',
    'classificationPendingCount',
    'oldestClassificationPendingAgeMs',
    'freshMintCount',
    'extendedMintCount',
    'demotedCount',
  ]);
});

void test('workerAdmission.v1 rejects non-record, mutable, missing and extra input', () => {
  for (const value of [null, undefined, true, 1, 'metrics', [], { ...validInput() }]) {
    assert.throws(() => snapshotRuntimeWorkerAdmissionMetrics(value), /worker admission metrics/iu);
  }

  const { demotedCount: _missing, ...missing } = validInput();
  assert.throws(
    () => snapshotRuntimeWorkerAdmissionMetrics(Object.freeze(missing)),
    /worker admission metrics/iu,
  );
  assert.throws(
    () => snapshotRuntimeWorkerAdmissionMetrics(Object.freeze({ ...validInput(), extra: 0 })),
    /worker admission metrics/iu,
  );
  assert.throws(
    () => snapshotRuntimeWorkerAdmissionMetrics(Object.freeze({
      ...validInput(),
      [Symbol('extra')]: 0,
    })),
    /worker admission metrics/iu,
  );
});

void test('workerAdmission.v1 rejects proxies without executing hostile traps', () => {
  let trapCalls = 0;
  const trap = (): never => {
    trapCalls += 1;
    throw new Error('secret-from-proxy');
  };
  const proxy = new Proxy(validInput(), {
    get: trap,
    getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap,
    ownKeys: trap,
  });

  assert.throws(
    () => snapshotRuntimeWorkerAdmissionMetrics(proxy),
    /worker admission metrics/iu,
  );
  assert.equal(trapCalls, 0);
});

void test('workerAdmission.v1 rejects accessors without invoking them', () => {
  let getterCalls = 0;
  const descriptors = Object.getOwnPropertyDescriptors(validInput()) as Record<
  string,
  PropertyDescriptor
  >;
  descriptors.demotedCount = {
    configurable: false,
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('secret-from-getter');
    },
  };
  const accessorInput = Object.freeze(Object.defineProperties({}, descriptors));

  assert.throws(
    () => snapshotRuntimeWorkerAdmissionMetrics(accessorInput),
    /worker admission metrics/iu,
  );
  assert.equal(getterCalls, 0);
});

void test('workerAdmission.v1 requires literal version, boolean enabled and canonical window', () => {
  for (const version of [0, 2, '1', 1n, null, undefined]) {
    assert.throws(
      () => snapshotRuntimeWorkerAdmissionMetrics(validInput({ version: version as 1 })),
      /worker admission metrics/iu,
    );
  }
  for (const enabled of [0, 1, 'true', null, undefined]) {
    assert.throws(
      () => snapshotRuntimeWorkerAdmissionMetrics(validInput({
        enabled: enabled as unknown as boolean,
      })),
      /worker admission metrics/iu,
    );
  }
  for (const trackingWindowSeconds of [
    -0, 0, 3_601, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1, '45', null, undefined,
  ]) {
    assert.throws(
      () => snapshotRuntimeWorkerAdmissionMetrics(validInput({
        trackingWindowSeconds: trackingWindowSeconds as number,
      })),
      /worker admission metrics/iu,
    );
  }

  assert.equal(snapshotRuntimeWorkerAdmissionMetrics(validInput({
    trackingWindowSeconds: 1,
  })).trackingWindowSeconds, 1);
  assert.equal(snapshotRuntimeWorkerAdmissionMetrics(validInput({
    trackingWindowSeconds: 3_600,
  })).trackingWindowSeconds, 3_600);
});

void test('workerAdmission.v1 rejects non-canonical counters and ages', () => {
  const numericKeys = [
    'claimableBacklogCount',
    'classificationPendingCount',
    'oldestClassificationPendingAgeMs',
    'freshMintCount',
    'extendedMintCount',
    'demotedCount',
  ] as const;
  const invalidValues = [
    -0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '0',
    0n,
    undefined,
  ];

  for (const key of numericKeys) {
    for (const invalidValue of invalidValues) {
      assert.throws(
        () => snapshotRuntimeWorkerAdmissionMetrics(validInput({
          [key]: invalidValue,
        } as Partial<WorkerAdmissionMetricsInput>)),
        /worker admission metrics/iu,
        `${key} accepted ${String(invalidValue)}`,
      );
    }
  }
});

void test('workerAdmission.v1 couples pending count and oldest pending age', () => {
  assert.throws(
    () => snapshotRuntimeWorkerAdmissionMetrics(validInput({
      classificationPendingCount: 1,
      oldestClassificationPendingAgeMs: null,
    })),
    /worker admission metrics/iu,
  );
  assert.throws(
    () => snapshotRuntimeWorkerAdmissionMetrics(validInput({
      classificationPendingCount: 0,
      oldestClassificationPendingAgeMs: 0,
    })),
    /worker admission metrics/iu,
  );
  assert.equal(snapshotRuntimeWorkerAdmissionMetrics(validInput({
    classificationPendingCount: 0,
    oldestClassificationPendingAgeMs: null,
  })).oldestClassificationPendingAgeMs, null);
  assert.equal(snapshotRuntimeWorkerAdmissionMetrics(validInput({
    classificationPendingCount: 1,
    oldestClassificationPendingAgeMs: 0,
  })).oldestClassificationPendingAgeMs, 0);
});

void test('disabled workerAdmission.v1 keeps legacy backlog but rejects bounded evidence', () => {
  const disabled = validInput({
    enabled: false,
    claimableBacklogCount: 8,
    classificationPendingCount: 0,
    oldestClassificationPendingAgeMs: null,
    freshMintCount: 0,
    extendedMintCount: 0,
    demotedCount: 0,
  });
  assert.deepEqual(snapshotRuntimeWorkerAdmissionMetrics(disabled), disabled);

  for (const key of [
    'classificationPendingCount',
    'freshMintCount',
    'extendedMintCount',
    'demotedCount',
  ] as const) {
    assert.throws(
      () => snapshotRuntimeWorkerAdmissionMetrics(validInput({
        enabled: false,
        classificationPendingCount: key === 'classificationPendingCount' ? 1 : 0,
        oldestClassificationPendingAgeMs: key === 'classificationPendingCount' ? 0 : null,
        freshMintCount: key === 'freshMintCount' ? 1 : 0,
        extendedMintCount: key === 'extendedMintCount' ? 1 : 0,
        demotedCount: key === 'demotedCount' ? 1 : 0,
      })),
      /worker admission metrics/iu,
    );
  }
});

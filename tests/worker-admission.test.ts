import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PUMPFUN_TRACKING_WINDOW_SECONDS,
  MAX_PUMPFUN_TRACKING_WINDOW_SECONDS,
  MIN_PUMPFUN_TRACKING_WINDOW_SECONDS,
  PUMPFUN_WORKER_ADMISSION_POLICY_SCHEMA_VERSION,
  createPumpFunWorkerAdmissionPolicy,
} from '../src/domain/worker-admission.js';

void test('the inactive Pump.fun worker admission policy exposes exact frozen V1 defaults', () => {
  assert.equal(
    PUMPFUN_WORKER_ADMISSION_POLICY_SCHEMA_VERSION,
    'pumpfun-worker-admission-policy.v1',
  );
  assert.equal(MIN_PUMPFUN_TRACKING_WINDOW_SECONDS, 1);
  assert.equal(DEFAULT_PUMPFUN_TRACKING_WINDOW_SECONDS, 45);
  assert.equal(MAX_PUMPFUN_TRACKING_WINDOW_SECONDS, 3_600);

  const policy = createPumpFunWorkerAdmissionPolicy({
    enabled: false,
    trackingWindowSeconds: DEFAULT_PUMPFUN_TRACKING_WINDOW_SECONDS,
  });

  assert.deepEqual(policy, {
    schemaVersion: 'pumpfun-worker-admission-policy.v1',
    enabled: false,
    trackingWindowSeconds: 45,
  });
  assert.equal(Object.isFrozen(policy), true);
});

void test('the inactive policy rejects enabled, non-boolean and non-canonical windows', () => {
  for (const enabled of [true, 'false', 0, null, undefined]) {
    assert.throws(
      () => createPumpFunWorkerAdmissionPolicy({ enabled, trackingWindowSeconds: 45 }),
      /inactive Pump\.fun worker admission policy requires enabled=false/iu,
    );
  }
  for (const trackingWindowSeconds of [0, 3_601, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
    '45', '045', null, undefined]) {
    assert.throws(
      () => createPumpFunWorkerAdmissionPolicy({ enabled: false, trackingWindowSeconds }),
      /tracking window/iu,
    );
  }
});

void test('the inactive policy accepts both exact inclusive tracking-window bounds', () => {
  for (const trackingWindowSeconds of [
    MIN_PUMPFUN_TRACKING_WINDOW_SECONDS,
    MAX_PUMPFUN_TRACKING_WINDOW_SECONDS,
  ]) {
    assert.equal(
      createPumpFunWorkerAdmissionPolicy({ enabled: false, trackingWindowSeconds })
        .trackingWindowSeconds,
      trackingWindowSeconds,
    );
  }
});

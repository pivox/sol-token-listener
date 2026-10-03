import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMainnetScannerAttribution,
  MAINNET_SCANNER_ATTRIBUTION_SAMPLE_NAMES,
} from '../scripts/lib/mainnet-scanner-attribution.js';

const validDiagnostics = Object.freeze({
  version: 1,
  sampledAtMs: 1_790_000_000_000,
  unavailable: false,
  overflow: false,
  buckets: Object.freeze([Object.freeze({
    provider: 'primary', program: 'pumpfun', phase: 'SOURCE_PAGE', count: 2,
    totalDurationMs: 17, maxDurationMs: 12, lastOutcome: 'OK', lastCode: null,
  })]),
  fronts: Object.freeze([
    Object.freeze({
      program: 'pumpfun', progressCount: 2, completedCount: 0,
      lastProgressAgeMs: 5_000, checkpointAdvanced: false,
    }),
    Object.freeze({
      program: 'pumpswap', progressCount: 0, completedCount: 0,
      lastProgressAgeMs: null, checkpointAdvanced: false,
    }),
  ]),
});

void test('builds five sanitized scanner samples without changing canary verdict inputs', () => {
  const result = buildMainnetScannerAttribution({
    T0: validDiagnostics,
    T_PLUS_5: validDiagnostics,
    T_PLUS_15: validDiagnostics,
    FINAL_PRESTOP: validDiagnostics,
    STOPPED: validDiagnostics,
  });

  assert.equal(result.schemaVersion, 'mainnet-scanner-attribution.v1');
  assert.deepEqual(result.samples.map((sample) => sample.name),
    MAINNET_SCANNER_ATTRIBUTION_SAMPLE_NAMES);
  assert.deepEqual(result.samples.map((sample) => sample.status),
    ['VALID', 'VALID', 'VALID', 'VALID', 'VALID']);
  assert.equal(result.samples[0]?.diagnostics?.sampledAtMs, validDiagnostics.sampledAtMs);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.samples), true);
});

void test('classifies missing, malformed, unavailable and overflow evidence explicitly', () => {
  const result = buildMainnetScannerAttribution({
    T0: undefined,
    T_PLUS_5: { ...validDiagnostics, buckets: [{ ...validDiagnostics.buckets[0], count: -1 }] },
    T_PLUS_15: { ...validDiagnostics, unavailable: true },
    FINAL_PRESTOP: { ...validDiagnostics, overflow: true },
    STOPPED: validDiagnostics,
  });

  assert.deepEqual(result.samples.map((sample) => sample.status),
    ['MISSING', 'MALFORMED', 'MISSING', 'OVERFLOW', 'VALID']);
  assert.equal(result.samples[0]?.diagnostics, null);
  assert.equal(result.samples[1]?.diagnostics, null);
  assert.equal(result.samples[2]?.diagnostics, null);
  assert.equal(result.samples[3]?.diagnostics?.overflow, true);
});

void test('never echoes hostile keys or error messages from untrusted input', () => {
  const result = buildMainnetScannerAttribution({
    T0: { ...validDiagnostics, privateKey: 'must-not-leak' },
    T_PLUS_5: { ...validDiagnostics, buckets: [{
      ...validDiagnostics.buckets[0], signature: 'must-not-leak',
    }] },
    T_PLUS_15: validDiagnostics,
    FINAL_PRESTOP: validDiagnostics,
    STOPPED: validDiagnostics,
  });
  assert.equal(result.samples[0]?.status, 'MALFORMED');
  assert.equal(result.samples[1]?.status, 'MALFORMED');
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});

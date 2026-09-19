import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATCH_UP_CLASSIFICATION_DISPOSITIONS,
  CATCH_UP_CLASSIFICATION_REASON_CODES,
  CATCH_UP_CLASSIFICATION_VERSION,
  assertValidCatchUpClassification,
  assertValidCatchUpClassificationReceipt,
  createCatchUpClassification,
  createCatchUpClassificationReceipt,
  type CatchUpClassification,
  type CatchUpClassificationAdmission,
  type CatchUpClassificationDisposition,
  type CatchUpClassificationPersistence,
  type CatchUpClassificationReasonCode,
  type CatchUpClassificationReceipt,
} from '../src/domain/catch-up-classification.js';

const pumpProgram = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const mintA = 'So11111111111111111111111111111111111111112';
const mintB = '11111111111111111111111111111111';

function base() {
  return {
    signature: 'classified-signature',
    slot: 42n,
    programIds: [pumpProgram],
    confirmationStatus: 'confirmed' as const,
    observedAtMs: 1_000,
    ingestionHint: 'PUMPFUN_CREATE' as const,
    ingestionHintMint: null,
    classificationVersion: 1 as const,
    disposition: 'ACTIONABLE' as const,
    reasonCode: 'PUMP_ACTION_SUPPORTED' as const,
    mints: [mintA],
    evidenceFingerprint: 'a'.repeat(64),
    classifiedAtMs: 1_001,
  };
}

void test('creates one exact deeply frozen actionable classification', () => {
  const value = createCatchUpClassification(base());
  assert.deepEqual(value, {
    ...base(),
    programIds: [pumpProgram],
    mints: [mintA],
  });
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.programIds), true);
  assert.equal(Object.isFrozen(value.mints), true);
  assert.doesNotThrow(() => { assertValidCatchUpClassification(value); });
});

void test('publishes the stable V1 disposition and reason registries', () => {
  assert.equal(CATCH_UP_CLASSIFICATION_VERSION, 1);
  assert.deepEqual(CATCH_UP_CLASSIFICATION_DISPOSITIONS,
    ['ACTIONABLE', 'DEFERRED', 'IGNORED', 'QUARANTINED']);
  assert.deepEqual(CATCH_UP_CLASSIFICATION_REASON_CODES, [
    'PUMP_ACTION_SUPPORTED',
    'PUMP_TRADE_UNTRACKED',
    'SOLANA_TRANSACTION_FAILED',
    'NO_SUPPORTED_PUMP_ACTION',
    'PUMP_SCHEMA_UNSUPPORTED',
    'PROVIDER_SIGNATURE_MISSING',
  ]);
});

void test('canonicalizes neither program ids nor multi-mints and rejects non-canonical order', () => {
  const orderedMints = [mintB, mintA].sort();
  const canonical = createCatchUpClassification({
    ...base(),
    ingestionHint: 'PUMPFUN_TRADE',
    ingestionHintMint: orderedMints[0],
    mints: orderedMints,
  });
  assert.deepEqual(canonical.mints, orderedMints);
  for (const mints of [[mintA, mintB], [mintA, mintA], [], ['invalid']]) {
    assert.throws(() => createCatchUpClassification({ ...base(), mints }),
      /catch-up classification/i);
  }
  assert.throws(() => createCatchUpClassification({
    ...base(), programIds: [pumpProgram, pumpProgram],
  }), /catch-up classification/i);
});

void test('enforces the closed disposition, reason, hint and mint matrix', () => {
  const valid = [
    base(),
    { ...base(), ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: mintA },
    { ...base(), disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED',
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: mintA },
    { ...base(), disposition: 'IGNORED', reasonCode: 'SOLANA_TRANSACTION_FAILED',
      ingestionHint: null, ingestionHintMint: null, mints: [] },
    { ...base(), disposition: 'IGNORED', reasonCode: 'NO_SUPPORTED_PUMP_ACTION',
      ingestionHint: null, ingestionHintMint: null, mints: [] },
    { ...base(), disposition: 'QUARANTINED', reasonCode: 'PUMP_SCHEMA_UNSUPPORTED',
      ingestionHint: null, ingestionHintMint: null, mints: [] },
    { ...base(), disposition: 'QUARANTINED', reasonCode: 'PROVIDER_SIGNATURE_MISSING',
      ingestionHint: null, ingestionHintMint: null, mints: [] },
  ];
  for (const value of valid) {
    assert.doesNotThrow(() => createCatchUpClassification(value));
  }

  const invalid = [
    { disposition: 'ACTIONABLE', reasonCode: 'PUMP_TRADE_UNTRACKED' },
    { disposition: 'DEFERRED', reasonCode: 'PUMP_ACTION_SUPPORTED' },
    { disposition: 'IGNORED', reasonCode: 'PUMP_SCHEMA_UNSUPPORTED' },
    { disposition: 'QUARANTINED', reasonCode: 'NO_SUPPORTED_PUMP_ACTION' },
    { ingestionHint: null, ingestionHintMint: null },
    { disposition: 'IGNORED', reasonCode: 'NO_SUPPORTED_PUMP_ACTION',
      ingestionHint: 'PUMPFUN_CREATE', ingestionHintMint: null, mints: [] },
    { disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED',
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: mintB },
  ];
  for (const patch of invalid) {
    assert.throws(() => createCatchUpClassification({ ...base(), ...patch }),
      /catch-up classification/i);
  }
});

void test('rejects non-V1, malformed evidence, incoherent times and non-canonical identities', () => {
  for (const patch of [
    { classificationVersion: 2 },
    { evidenceFingerprint: 'A'.repeat(64) },
    { evidenceFingerprint: 'a'.repeat(63) },
    { classifiedAtMs: 999 },
    { classifiedAtMs: 1.5 },
    { observedAtMs: -0 },
    { slot: 42 },
    { confirmationStatus: 'orphaned' },
    { signature: ' classified-signature' },
  ]) {
    assert.throws(() => createCatchUpClassification({ ...base(), ...patch }),
      /catch-up classification/i);
  }
});

void test('validator rejects mutable, extra-key, accessor and proxy classifications', () => {
  const value = createCatchUpClassification(base());
  assert.throws(() => { assertValidCatchUpClassification({ ...value }); },
    /catch-up classification/i);
  assert.throws(() => { assertValidCatchUpClassification(Object.freeze({ ...value, extra: true })); },
    /catch-up classification/i);
  const accessor = Object.freeze(Object.defineProperty({ ...value }, 'reasonCode', {
    enumerable: true, get: () => 'PUMP_ACTION_SUPPORTED',
  }));
  assert.throws(() => { assertValidCatchUpClassification(accessor); },
    /catch-up classification/i);
  assert.throws(() => { assertValidCatchUpClassification(new Proxy(value, {})); },
    /catch-up classification/i);
});

void test('creates exact immutable catch-up admission receipts', () => {
  const receipt = createCatchUpClassificationReceipt({
    signature: 'classified-signature',
    slot: 42n,
    disposition: 'ACTIONABLE',
    persistence: 'RECORDED',
    admission: 'ENQUEUED',
    ingestionPriority: 'LAUNCH_CANDIDATE',
  });
  assert.deepEqual(receipt, {
    signature: 'classified-signature',
    slot: 42n,
    disposition: 'ACTIONABLE',
    persistence: 'RECORDED',
    admission: 'ENQUEUED',
    ingestionPriority: 'LAUNCH_CANDIDATE',
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.doesNotThrow(() => { assertValidCatchUpClassificationReceipt(receipt); });
});

void test('rejects incoherent, mutable and hostile catch-up admission receipts', () => {
  const baseReceipt = {
    signature: 'classified-signature',
    slot: 42n,
    disposition: 'ACTIONABLE',
    persistence: 'REPLAYED',
    admission: 'NOT_ENQUEUED',
    ingestionPriority: null,
  } as const;
  for (const patch of [
    { admission: 'ENQUEUED', ingestionPriority: null },
    { admission: 'NOT_ENQUEUED', ingestionPriority: 'NORMAL' },
    { disposition: 'IGNORED', admission: 'ENQUEUED', ingestionPriority: 'NORMAL' },
    { persistence: 'ALREADY_ADMITTED', disposition: 'ACTIONABLE' },
    { persistence: 'UNKNOWN' },
    { slot: -1n },
    { signature: ' classified-signature' },
  ]) {
    assert.throws(() => createCatchUpClassificationReceipt({ ...baseReceipt, ...patch }),
      /catch-up classification receipt/i);
  }
  const receipt = createCatchUpClassificationReceipt(baseReceipt);
  assert.throws(() => { assertValidCatchUpClassificationReceipt({ ...receipt }); },
    /catch-up classification receipt/i);
  assert.throws(() => { assertValidCatchUpClassificationReceipt(Object.freeze({ ...receipt, extra: true })); },
    /catch-up classification receipt/i);
});

void test('models a purged already-admitted receipt without a synthetic classification', () => {
  const receipt = createCatchUpClassificationReceipt({
    signature: 'purged-finality-replay',
    slot: 42n,
    disposition: null,
    persistence: 'ALREADY_ADMITTED',
    admission: 'NOT_ENQUEUED',
    ingestionPriority: null,
  });
  assert.equal(receipt.persistence, 'ALREADY_ADMITTED');
  assert.equal(receipt.disposition, null);
  assert.equal(receipt.admission, 'NOT_ENQUEUED');
  assert.equal(receipt.ingestionPriority, null);
});

const _classification: CatchUpClassification | null = null;
const _receipt: CatchUpClassificationReceipt | null = null;
const _admission: CatchUpClassificationAdmission = 'ENQUEUED';
const _disposition: CatchUpClassificationDisposition = 'IGNORED';
const _persistence: CatchUpClassificationPersistence = 'RECORDED';
const _reason: CatchUpClassificationReasonCode = 'NO_SUPPORTED_PUMP_ACTION';
void _classification;
void _receipt;
void _admission;
void _disposition;
void _persistence;
void _reason;

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConfirmationStatusConflictError,
  reconcileConfirmationStatus,
} from '../src/domain/confirmation-status.js';

void test('processed observations advance to confirmed, finalized, or orphaned', () => {
  for (const incoming of ['confirmed', 'finalized', 'orphaned'] as const) {
    assert.equal(reconcileConfirmationStatus('processed', incoming), 'update');
  }
});

void test('confirmed observations advance to finalized or orphaned', () => {
  for (const incoming of ['finalized', 'orphaned'] as const) {
    assert.equal(reconcileConfirmationStatus('confirmed', incoming), 'update');
  }
});

void test('repeated confirmation observations are kept', () => {
  for (const status of ['processed', 'confirmed', 'finalized', 'orphaned'] as const) {
    assert.equal(reconcileConfirmationStatus(status, status), 'keep');
  }
});

void test('late lower confirmation observations are kept', () => {
  assert.equal(reconcileConfirmationStatus('confirmed', 'processed'), 'keep');
  assert.equal(reconcileConfirmationStatus('finalized', 'processed'), 'keep');
  assert.equal(reconcileConfirmationStatus('finalized', 'confirmed'), 'keep');
});

void test('terminal confirmation conflicts expose both statuses', () => {
  for (const [current, incoming] of [
    ['finalized', 'orphaned'],
    ['orphaned', 'processed'],
    ['orphaned', 'confirmed'],
    ['orphaned', 'finalized'],
  ] as const) {
    assert.throws(
      () => reconcileConfirmationStatus(current, incoming),
      (error: unknown) => error instanceof ConfirmationStatusConflictError
        && error.current === current
        && error.incoming === incoming,
    );
  }
});

void test('finalized to orphaned rejects before a retract request can be applied', () => {
  let retractionApplied = false;

  assert.throws(
    () => {
      reconcileConfirmationStatus('finalized', 'orphaned');
      retractionApplied = true;
    },
    (error: unknown) => error instanceof ConfirmationStatusConflictError
      && error.current === 'finalized'
      && error.incoming === 'orphaned',
  );
  assert.equal(retractionApplied, false);
});

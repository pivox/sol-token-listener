import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  assertInitialLaunchTransitionAllowed,
  createInitialDetectedTransition,
  InvalidLaunchTransitionError,
  reconcileTransitionOccurrence,
} from '../src/domain/state-transitions.js';
import type { TokenLaunchDetectedEventV1 } from '../src/domain/launchpad-events.js';

const launchDetected: TokenLaunchDetectedEventV1 = {
  id: 'evt_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  type: 'TokenLaunchDetected',
  mint: 'Mint111111111111111111111111111111111111111',
  source: 'pumpfun',
  program: 'Pump111111111111111111111111111111111111111',
  signature: '5NfSignature',
  cursor: { slot: 123n, transactionIndex: 9, instructionIndex: 2, innerInstructionIndex: null },
  confirmationStatus: 'processed',
  blockchainTimeMs: 1_753_700_000_000,
  observedAtMs: 1_753_700_000_500,
  payloadVersion: 1,
  payload: {
    launch: {
      mint: 'Mint111111111111111111111111111111111111111',
      creator: 'Creator111111111111111111111111111111111111',
      tokenProgram: 'SPL_TOKEN',
      quoteAssets: [],
      launchpad: 'pumpfun',
      createdAt: { slot: 123n, transactionIndex: 9, instructionIndex: 2, innerInstructionIndex: null },
      parameters: {},
    },
  },
};

void test('initial detected transition is deterministic on replay', () => {
  assert.deepEqual(createInitialDetectedTransition(launchDetected), createInitialDetectedTransition(launchDetected));
});

void test('initial detected transition identity uses the event, none, and detected inputs', () => {
  const expectedId = `transition_${createHash('sha256')
    .update([launchDetected.id, 'none', 'DETECTED'].join('\u001f'))
    .digest('hex')}`;

  assert.equal(createInitialDetectedTransition(launchDetected).id, expectedId);
});

void test('initial detected transition records its triggering event and evidence', () => {
  const transition = createInitialDetectedTransition(launchDetected);

  assert.match(transition.id, /^transition_[a-f0-9]{64}$/u);
  assert.equal(transition.payloadVersion, 1);
  assert.equal(transition.mint, launchDetected.mint);
  assert.equal(transition.triggeringEventId, launchDetected.id);
  assert.equal(transition.triggeringEventType, launchDetected.type);
  assert.equal(transition.occurredAtMs, launchDetected.blockchainTimeMs);
  assert.equal(transition.occurredAtSource, 'blockchain');
  assert.equal(transition.previousStatus, null);
  assert.equal(transition.newStatus, 'DETECTED');
  assert.equal(transition.reasonCode, null);
  assert.equal(transition.message, 'Token launch detected');
  assert.deepEqual(transition.evidence, { source: launchDetected.source, program: launchDetected.program });
  assert.ok(Object.isFrozen(transition));
  assert.ok(Object.isFrozen(transition.evidence));
});

void test('only the initial null to detected transition is allowed', () => {
  assert.doesNotThrow(() => {
    assertInitialLaunchTransitionAllowed(null, 'DETECTED');
  });
  for (const [previousStatus, newStatus] of [
    [null, 'OBSERVING'],
    ['DETECTED', 'DETECTED'],
  ] as const) {
    assert.throws(
      () => {
        assertInitialLaunchTransitionAllowed(previousStatus, newStatus);
      },
      (error: unknown) => error instanceof InvalidLaunchTransitionError
        && error.previous === previousStatus
        && error.new === newStatus,
    );
  }
});

void test('initial detected transition falls back to observed time and remains immutable', () => {
  const transition = createInitialDetectedTransition({ ...launchDetected, blockchainTimeMs: null });

  assert.equal(transition.occurredAtMs, launchDetected.observedAtMs);
  assert.equal(transition.occurredAtSource, 'observation');
  assert.throws(() => {
    (transition.evidence as { source: string }).source = 'changed';
  }, TypeError);
  assert.equal(transition.evidence.source, launchDetected.source);
});

void test('enriches occurrence deterministically across fallback and blockchain replays', () => {
  const processedFallback = createInitialDetectedTransition({
    ...launchDetected,
    confirmationStatus: 'processed',
    blockchainTimeMs: null,
    observedAtMs: 1_753_700_000_500,
  });
  const confirmedEarlierFallback = createInitialDetectedTransition({
    ...launchDetected,
    confirmationStatus: 'confirmed',
    blockchainTimeMs: null,
    observedAtMs: 1_753_700_000_400,
  });
  const confirmedBlockchain = createInitialDetectedTransition({
    ...launchDetected,
    confirmationStatus: 'confirmed',
    blockchainTimeMs: 1_753_700_000_450,
    observedAtMs: 1_753_700_000_600,
  });
  const laterFallback = createInitialDetectedTransition({
    ...launchDetected,
    confirmationStatus: 'confirmed',
    blockchainTimeMs: null,
    observedAtMs: 1_753_700_000_300,
  });

  const fallbackOccurrence = reconcileTransitionOccurrence(
    processedFallback,
    confirmedEarlierFallback,
  );
  assert.deepEqual(fallbackOccurrence, {
    occurredAtMs: confirmedEarlierFallback.occurredAtMs,
    occurredAtSource: 'observation',
  });
  assert.deepEqual(
    reconcileTransitionOccurrence(
      confirmedEarlierFallback,
      processedFallback,
    ),
    fallbackOccurrence,
  );

  const blockchainOccurrence = reconcileTransitionOccurrence(
    fallbackOccurrence,
    confirmedBlockchain,
  );
  assert.deepEqual(blockchainOccurrence, {
    occurredAtMs: confirmedBlockchain.occurredAtMs,
    occurredAtSource: 'blockchain',
  });
  assert.deepEqual(
    reconcileTransitionOccurrence(confirmedBlockchain, fallbackOccurrence),
    blockchainOccurrence,
  );
  assert.deepEqual(
    reconcileTransitionOccurrence(blockchainOccurrence, laterFallback),
    blockchainOccurrence,
  );
});

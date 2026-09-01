import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionIntentDraft, type ExecutionIntentV1 } from '../src/domain/execution-intent.js';
import {
  confirmLiveSubmission,
  type LiveConfirmationWorkerDependencies,
} from '../src/executor-live/confirmation-worker.js';
import type { ClaimedExecutionIntent } from '../src/ports/execution-intent-repository.js';
import type { ExecutionLiveConfirmationV1 } from '../src/ports/execution-live-repository.js';

const signature = '3'.repeat(88);
const artifactId = `execution_signed_transaction_${'a'.repeat(64)}`;

void test('records a confirmed provider observation once with the fenced revision', async () => {
  const confirmations: ExecutionLiveConfirmationV1[] = [];
  const dependencies = dependenciesFor(confirmations, 'CONFIRMED');

  const result = await confirmLiveSubmission(dependencies, Object.freeze({
    payloadVersion: 1,
    claim: claimFixture(),
    artifactId,
    expectedRevision: 3n,
    signature,
  }), new AbortController().signal);

  assert.equal(result.kind, 'CONFIRMED');
  assert.deepEqual(confirmations, [Object.freeze({
    payloadVersion: 1,
    artifactId,
    expectedRevision: 3n,
    signature,
    observedSlot: 456n,
    observedAtMs: 1_786_699_100_000,
  })]);
});

void test('keeps not-found and provider failures pending without claiming no effect', async () => {
  for (const status of ['NOT_FOUND', 'FAILED'] as const) {
    const confirmations: ExecutionLiveConfirmationV1[] = [];
    const result = await confirmLiveSubmission(
      dependenciesFor(confirmations, status),
      Object.freeze({
        payloadVersion: 1,
        claim: claimFixture(),
        artifactId,
        expectedRevision: 3n,
        signature,
      }),
      new AbortController().signal,
    );
    assert.equal(result.kind, 'PENDING');
    assert.equal(confirmations.length, 0);
  }
}
);

function dependenciesFor(
  confirmations: ExecutionLiveConfirmationV1[],
  status: 'CONFIRMED' | 'NOT_FOUND' | 'FAILED',
): LiveConfirmationWorkerDependencies {
  return Object.freeze({
    gateway: {
      observeSignature: () => status === 'FAILED'
        ? Promise.reject(new Error('provider unavailable'))
        : Promise.resolve(Object.freeze({
          confirmationStatus: status,
          observedSlot: status === 'CONFIRMED' ? 456n : null,
          observedAtMs: 1_786_699_100_000,
        })),
    },
    repository: {
      recordConfirmation: (
        _claim: ClaimedExecutionIntent,
        confirmation: ExecutionLiveConfirmationV1,
      ) => {
        confirmations.push(confirmation);
        return Promise.resolve(Object.freeze({ artifactId }));
      },
    },
  });
}

function claimFixture(): ClaimedExecutionIntent {
  const nowMs = 1_786_699_000_000;
  const draft = createExecutionIntentDraft({
    strategyId: 'confirmation-test', strategyVersion: 1,
    positionId: 'position:test', logicalCommandId: 'command:test',
    mint: '11111111111111111111111111111111', side: 'BUY',
    venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 100n, baseAmountRaw: null, minimumAmountOutRaw: 90n,
    decisionEventId: 'decision:test', decisionFingerprint: '1'.repeat(64),
    requestedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 60_000,
  });
  const intent: ExecutionIntentV1 = Object.freeze({
    ...draft, status: 'SUBMITTED', attemptCount: 1, stateRevision: 4n,
    lastReasonCode: 'SUBMISSION_ACCEPTED', terminalAtMs: null,
    reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: nowMs - 1_000, updatedAtMs: nowMs - 500,
  });
  return Object.freeze({
    intent,
    leaseOwner: 'confirmation-worker',
    leaseToken: '11111111-1111-4111-8111-111111111111',
    leaseExpiresAtMs: nowMs + 30_000,
  });
}

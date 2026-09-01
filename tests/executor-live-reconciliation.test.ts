import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionIntentDraft, type ExecutionIntentV1 } from '../src/domain/execution-intent.js';
import type { ExecutionReconciliationEvidenceV1 } from '../src/domain/execution-reconciliation.js';
import {
  reconcileLiveSubmission,
  type LiveReconciliationWorkerDependencies,
} from '../src/executor-live/reconciliation-worker.js';
import type { ExecutionReconciliationGateway } from '../src/ports/execution-reconciliation-gateway.js';
import type { ClaimedExecutionIntent } from '../src/ports/execution-intent-repository.js';

const signature = '3'.repeat(88);
const blockhash = '11111111111111111111111111111111';
const hash = 'a'.repeat(64);

void test('evaluates finalized evidence and commits it through the live repository', async () => {
  const committed: ExecutionReconciliationEvidenceV1[] = [];
  const dependencies: LiveReconciliationWorkerDependencies = Object.freeze({
    gateway: matchedGateway(),
    repository: {
      commitReconciliation: (
        _claim: ClaimedExecutionIntent,
        evidence: ExecutionReconciliationEvidenceV1,
      ) => {
        committed.push(evidence);
        return Promise.resolve();
      },
    },
  });

  const result = await reconcileLiveSubmission(dependencies, Object.freeze({
    payloadVersion: 1,
    claim: claimFixture(),
    request: reconciliationRequest(),
  }), new AbortController().signal);

  assert.equal(result.kind, 'MATCHED');
  assert.equal(result.evidenceId, committed[0]?.evidenceId);
  assert.equal(committed[0]?.confirmationStatus, 'FINALIZED');
  assert.equal(committed[0]?.baseDeltaRaw, 500n);
});

function matchedGateway(): ExecutionReconciliationGateway {
  return Object.freeze({
    readFinalizedBlockHeight: () => Promise.resolve(1_001n),
    readSignatureHistory: () => Promise.resolve('PRESENT' as const),
    readNormalizedTransaction: () => Promise.resolve(Object.freeze({
      signature, blockhash, messageHash: hash,
      buildFingerprint: hash, snapshotFingerprint: hash,
    })),
    readFinalizedWalletDeltas: () => Promise.resolve(Object.freeze({
      confirmationStatus: 'FINALIZED' as const,
      observedSlot: 500n,
      feeLamports: 5n,
      walletLamportDelta: -105n,
      baseDeltaRaw: 500n,
      quoteDeltaRaw: -100n,
      unexpectedResidualTokenBalanceRaw: 0n,
      observedAtMs: 1_900,
      finalizedAtMs: 2_000,
    })),
  });
}

function reconciliationRequest() {
  return Object.freeze({
    payloadVersion: 1 as const,
    expected: Object.freeze({
      intentId: `execution_intent_${'b'.repeat(64)}`,
      attemptNumber: 1,
      walletGeneration: 1,
      providerId: 'rpc-primary',
      side: 'BUY' as const,
      signature,
      blockhash,
      lastValidBlockHeight: 1_000n,
      messageHash: hash,
      buildFingerprint: hash,
      snapshotFingerprint: hash,
      maximumFeeLamports: 10n,
      maximumFeePayerLamportDebit: 1_000n,
    }),
    walletDeltaRequest: Object.freeze({
      signature,
      walletPublicKey: blockhash,
      mint: blockhash,
      quoteMint: 'So11111111111111111111111111111111111111112',
      side: 'BUY' as const,
    }),
  });
}

function claimFixture(): ClaimedExecutionIntent {
  const nowMs = 1_786_699_000_000;
  const draft = createExecutionIntentDraft({
    strategyId: 'reconciliation-test', strategyVersion: 1,
    positionId: 'position:test', logicalCommandId: 'command:test',
    mint: blockhash, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 100n, baseAmountRaw: null, minimumAmountOutRaw: 90n,
    decisionEventId: 'decision:test', decisionFingerprint: '1'.repeat(64),
    requestedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 60_000,
  });
  const intent: ExecutionIntentV1 = Object.freeze({
    ...draft,
    id: `execution_intent_${'b'.repeat(64)}`,
    status: 'CONFIRMED', attemptCount: 1, stateRevision: 5n,
    lastReasonCode: 'CONFIRMATION_OBSERVED', terminalAtMs: null,
    reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: nowMs - 1_000, updatedAtMs: nowMs - 500,
  });
  return Object.freeze({
    intent,
    leaseOwner: 'reconciliation-worker',
    leaseToken: '11111111-1111-4111-8111-111111111111',
    leaseExpiresAtMs: nowMs + 30_000,
  });
}

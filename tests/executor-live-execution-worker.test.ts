import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { createSignedTransactionArtifact } from '../src/domain/execution-live.js';
import { createExecutionIntentDraft, type ExecutionIntentV1 } from '../src/domain/execution-intent.js';
import {
  executeLivePreparedTransaction,
  type LiveExecutionWorkerDependencies,
} from '../src/executor-live/execution-worker.js';
import { LiveSubmissionGatewayError } from '../src/executor-live/submission-gateway.js';
import type {
  ExecutionLiveSignedSimulationEvidenceV1,
  ExecutionLiveSubmissionOutcomeV1,
} from '../src/ports/execution-live-repository.js';
import type { ClaimedExecutionIntent } from '../src/ports/execution-intent-repository.js';

void test('orders persistence, signed simulation, submission fence and RPC exactly once', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  const dependencies = dependenciesFor(fixture, calls, false);

  const result = await executeLivePreparedTransaction(
    dependencies, fixture.input, new AbortController().signal,
  );

  assert.equal(result.kind, 'ACCEPTED');
  assert.deepEqual(calls, [
    'persist', 'authenticate', 'signed-simulate', 'record-signed-simulation',
    'begin-submission', 'rpc-submit', 'record-accepted',
  ]);
});

void test('records ambiguity after the durable submission fence and never retries', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  const result = await executeLivePreparedTransaction(
    dependenciesFor(fixture, calls, true), fixture.input,
    new AbortController().signal,
  );
  assert.equal(result.kind, 'AMBIGUOUS');
  assert.deepEqual(calls, [
    'persist', 'authenticate', 'signed-simulate', 'record-signed-simulation',
    'begin-submission', 'rpc-submit', 'record-ambiguous',
  ]);
  assert.equal(calls.filter((call) => call === 'rpc-submit').length, 1);
});

void test('does not rewrite an accepted outcome as ambiguous when its commit is unknown', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  await assert.rejects(executeLivePreparedTransaction(
    dependenciesFor(fixture, calls, false, true), fixture.input,
    new AbortController().signal,
  ), /accepted outcome commit unknown/u);
  assert.deepEqual(calls, [
    'persist', 'authenticate', 'signed-simulate', 'record-signed-simulation',
    'begin-submission', 'rpc-submit', 'record-accepted',
  ]);
});

function dependenciesFor(
  fixture: ReturnType<typeof workerFixture>,
  calls: string[],
  ambiguous: boolean,
  acceptedRecordFailure = false,
): LiveExecutionWorkerDependencies {
  const persisted = Object.freeze({
    payloadVersion: 1 as const, artifact: fixture.artifact,
    state: 'PERSISTED' as const, stateRevision: 0n,
  });
  const signedSimulated = Object.freeze({
    ...persisted, state: 'SIGNED_SIMULATED' as const, stateRevision: 1n,
  });
  const submissionStarted = Object.freeze({
    ...persisted, state: 'SUBMISSION_STARTED' as const, stateRevision: 2n,
  });
  return Object.freeze({
    repository: {
      persistSigned: () => { calls.push('persist'); return Promise.resolve(fixture.artifact); },
      authenticatePersistedSignedTransaction: () => {
        calls.push('authenticate'); return Promise.resolve(persisted);
      },
      recordSignedSimulation: () => {
        calls.push('record-signed-simulation'); return Promise.resolve(signedSimulated);
      },
      beginSubmission: () => {
        calls.push('begin-submission'); return Promise.resolve(submissionStarted);
      },
      recordSubmissionOutcome: (
        _claim: ClaimedExecutionIntent,
        outcome: ExecutionLiveSubmissionOutcomeV1,
      ) => {
        calls.push(`record-${outcome.outcome.toLowerCase()}`);
        if (acceptedRecordFailure && outcome.outcome === 'ACCEPTED') {
          return Promise.reject(new Error('accepted outcome commit unknown'));
        }
        return Promise.resolve(fixture.artifact);
      },
    },
    signedSimulation: {
      simulate: () => { calls.push('signed-simulate'); return Promise.resolve(fixture.signedEvidence); },
    },
    submission: {
      submitPersisted: () => {
        calls.push('rpc-submit');
        if (ambiguous) return Promise.reject(
          new LiveSubmissionGatewayError('SUBMISSION_AMBIGUOUS', true),
        );
        return Promise.resolve(Object.freeze({ signature: fixture.artifact.signature }));
      },
    },
    clock: () => 1_786_699_000_100,
  });
}

function workerFixture() {
  const nowMs = 1_786_699_000_000;
  const draft = createExecutionIntentDraft({
    strategyId: 'worker-test', strategyVersion: 1, positionId: 'position:test',
    logicalCommandId: 'command:test', mint: '11111111111111111111111111111111',
    side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 100n, baseAmountRaw: null, minimumAmountOutRaw: 90n,
    decisionEventId: 'decision:test', decisionFingerprint: '1'.repeat(64),
    requestedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 60_000,
  });
  const intent: ExecutionIntentV1 = Object.freeze({
    ...draft, status: 'PROCESSING', attemptCount: 1, stateRevision: 1n,
    lastReasonCode: 'EXECUTION_STARTED', terminalAtMs: null,
    reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: nowMs - 1_000, updatedAtMs: nowMs - 500,
  });
  const claim = Object.freeze({
    intent, leaseOwner: 'worker-live', leaseToken: '11111111-1111-4111-8111-111111111111',
    leaseExpiresAtMs: nowMs + 30_000,
  });
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1, intentId: intent.id, attemptNumber: 1,
    generationId: `execution_wallet_generation_${'2'.repeat(64)}`,
    armamentId: `execution_activation_armament_${'3'.repeat(64)}`,
    exitAuthorizationId: null, providerId: 'primary', walletPublicKey: intent.mint,
    side: 'BUY', effectiveVenue: 'PUMP_FUN', messageHash: '4'.repeat(64),
    buildFingerprint: '5'.repeat(64), snapshotFingerprint: '6'.repeat(64),
    quoteFingerprint: '7'.repeat(64), blockhash: intent.mint,
    lastValidBlockHeight: 500n, signature: bs58.encode(new Uint8Array(64).fill(8)),
    signedTransactionBytes: Uint8Array.from([1, 2, 3]), signedAtMs: nowMs,
  });
  const unsignedSimulation = Object.freeze({
    outcome: 'SUCCESS' as const, snapshotFingerprint: artifact.snapshotFingerprint,
    buildFingerprint: artifact.buildFingerprint, messageHash: artifact.messageHash,
    blockhash: artifact.blockhash, lastValidBlockHeight: artifact.lastValidBlockHeight,
    blockhashContextSlot: 124n, feeContextSlot: 124n, estimatedFeeLamports: 5n,
    simulationSlot: 125n, simulatedFeePayerLamportDebit: 5n, unitsConsumed: 20n,
    simulatedBaseDeltaRaw: 100n, simulatedQuoteDeltaRaw: -100n,
    logsFingerprint: '8'.repeat(64), logsLineCount: 1,
  });
  const signedEvidence: ExecutionLiveSignedSimulationEvidenceV1 = Object.freeze({
    payloadVersion: 1, artifactId: artifact.artifactId,
    signedTransactionHash: artifact.signedTransactionHash, simulationSlot: 126n,
    unitsConsumed: 21n, feePayerLamportDebit: 5n,
    baseDeltaRaw: 99n, quoteDeltaRaw: -100n,
    evidenceFingerprint: '9'.repeat(64), observedAtMs: nowMs + 50,
  });
  return Object.freeze({
    artifact, signedEvidence,
    input: Object.freeze({
      persist: Object.freeze({
        payloadVersion: 1 as const, claim,
        qualificationId: `execution_safety_qualification_${'a'.repeat(64)}`,
        reservationId: `execution_exposure_reservation_${'b'.repeat(64)}`,
        artifact, unsignedSimulation,
      }),
      signedSimulation: Object.freeze({
        payloadVersion: 1 as const, snapshotSlot: 123n,
        accountAddresses: Object.freeze([intent.mint, intent.mint, intent.mint] as const),
        amountInRaw: 100n, protectedAmountOutRaw: 90n, unsignedSimulation,
      }),
    }),
  });
}

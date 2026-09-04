import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import bs58 from 'bs58';
import {
  createFreshLiveExecution,
  type FreshLiveExecutionDependencies,
} from '../src/executor-live/fresh-execution.js';
import {
  LiveTransactionCandidateAuthority,
  type LivePreparedTransactionMaterialV1,
} from '../src/executor-live/transaction-preparer.js';
import type { ExecutionSimulationArtifactDraftV1 } from
  '../src/domain/execution-simulation.js';
import type { ClaimedExecutionIntent } from '../src/ports/execution-intent-repository.js';
import type { ExecutionLivePreparationBindingV1 } from
  '../src/ports/execution-live-repository.js';

const generationId = `execution_wallet_generation_${'2'.repeat(64)}`;
const wallet = '11111111111111111111111111111111';

void test('binds durable authority at BEFORE_SIGNING and executes one consumed candidate',
  async () => {
    const fixture = freshFixture();
    const execution = createFreshLiveExecution(fixture.dependencies);

    const result = await execution.execute(
      Object.freeze({ claim: fixture.claim, attempt: fixture.attempt }),
      new AbortController().signal,
      fixture.renew,
    );

    assert.equal(result.kind, 'ACCEPTED');
    assert.deepEqual(fixture.calls, [
      'renew',
      'renew',
      'renew',
      'read-preparation-binding',
      'consume-worker',
    ]);
    assert.equal(fixture.authority.consume(fixture.candidate), null);
    assert.equal(fixture.persisted?.persist.artifact.armamentId, fixture.binding.armamentId);
    assert.equal(fixture.persisted?.persist.artifact.reservationId, fixture.binding.reservationId);
    assert.equal(fixture.persisted?.persist.qualificationId, fixture.binding.qualificationId);
  });

void test('persists evaluator failure without consuming or invoking the live worker', async () => {
  const fixture = freshFixture('FAILURE');
  const result = await createFreshLiveExecution(fixture.dependencies).execute(
    Object.freeze({ claim: fixture.claim, attempt: fixture.attempt }),
    new AbortController().signal,
    fixture.renew,
  );

  assert.equal(result.kind, 'FAILED');
  assert.deepEqual(fixture.calls, ['record-failure']);
  assert.equal(fixture.authority.consume(fixture.candidate), fixture.material);
});

function freshFixture(outcome: 'SUCCESS' | 'FAILURE' = 'SUCCESS') {
  const calls: string[] = [];
  const nowMs = 1_800_000_000_000;
  const claim = claimValue(nowMs);
  const attempt = Object.freeze({ intentId: claim.intent.id, attemptNumber: 1, startedAtMs: nowMs });
  const binding: ExecutionLivePreparationBindingV1 = Object.freeze({
    payloadVersion: 1,
    side: 'BUY',
    generationId,
    qualificationId: `execution_safety_qualification_${'3'.repeat(64)}`,
    armamentId: `execution_activation_armament_${'4'.repeat(64)}`,
    reservationId: `execution_exposure_reservation_${'5'.repeat(64)}`,
    exitAuthorizationId: null,
    providerId: 'primary',
    walletPublicKey: wallet,
  });
  const material: LivePreparedTransactionMaterialV1 = Object.freeze({
    payloadVersion: 1,
    walletPublicKey: wallet,
    side: 'BUY',
    effectiveVenue: 'PUMP_FUN',
    snapshotSlot: 10n,
    quoteFingerprint: '6'.repeat(64),
    quoteObservedAtMs: nowMs - 100,
    quoteExpiresAtMs: nowMs + 5_000,
    signedSimulationAccountAddresses: Object.freeze([wallet, wallet, wallet] as const),
    buildFingerprint: '7'.repeat(64),
    snapshotFingerprint: '8'.repeat(64),
    messageHash: '9'.repeat(64),
    blockhash: wallet,
    lastValidBlockHeight: 100n,
    signature: bs58.encode(new Uint8Array(64).fill(1)),
    signedTransactionBytes: Object.freeze([1, 2, 3]),
    signedTransactionHash: createHash('sha256').update(Uint8Array.from([1, 2, 3])).digest('hex'),
    unsignedSimulation: Object.freeze({
      outcome: 'SUCCESS', snapshotFingerprint: '8'.repeat(64),
      buildFingerprint: '7'.repeat(64), messageHash: '9'.repeat(64), blockhash: wallet,
      lastValidBlockHeight: 100n, blockhashContextSlot: 11n, feeContextSlot: 11n,
      estimatedFeeLamports: 5n, simulationSlot: 12n,
      simulatedFeePayerLamportDebit: 5n, unitsConsumed: 10n,
      simulatedBaseDeltaRaw: 95n, simulatedQuoteDeltaRaw: -100n,
      logsFingerprint: 'b'.repeat(64), logsLineCount: 1,
    }),
  });
  const authority = new LiveTransactionCandidateAuthority();
  const candidate = authority.issue(material);
  const simulationArtifact = Object.freeze({
    intentId: claim.intent.id,
    attemptNumber: 1,
    intentStateRevision: claim.intent.stateRevision,
    resultKind: outcome === 'SUCCESS' ? 'SUCCESS' : 'SIMULATION_FAILED',
    effectiveVenue: outcome === 'SUCCESS' ? 'PUMP_FUN' : null,
    providerId: 'primary',
    executorPublicKey: wallet,
    configurationFingerprint: 'c'.repeat(64),
    quoteFingerprint: outcome === 'SUCCESS' ? material.quoteFingerprint : null,
    snapshotFingerprint: outcome === 'SUCCESS' ? material.snapshotFingerprint : null,
    buildFingerprint: outcome === 'SUCCESS' ? material.buildFingerprint : null,
    messageHash: outcome === 'SUCCESS' ? material.messageHash : null,
    blockhash: outcome === 'SUCCESS' ? material.blockhash : null,
    lastValidBlockHeight: outcome === 'SUCCESS' ? material.lastValidBlockHeight : null,
    amountInRaw: outcome === 'SUCCESS' ? 100n : null,
    protectedAmountOutRaw: outcome === 'SUCCESS' ? 90n : null,
    terminalReasonCode: outcome === 'SUCCESS'
      ? 'SIMULATION_SUCCEEDED' : 'BUY_SIMULATION_FAILED',
  }) as unknown as ExecutionSimulationArtifactDraftV1;
  let persisted: Parameters<FreshLiveExecutionDependencies['executePrepared']>[0] | null = null;
  const runtime = Object.freeze({
    payloadVersion: 1 as const,
    phase: 'CANARY' as const,
    buildHash: 'd'.repeat(64),
    configurationFingerprint: 'c'.repeat(64),
    strategyFingerprint: 'e'.repeat(64),
    walletPublicKey: wallet,
    cluster: 'mainnet-beta' as const,
    expectedGenesisHash: wallet,
    observedGenesisHash: wallet,
    providerId: 'primary',
  });
  const dependencies: FreshLiveExecutionDependencies = Object.freeze({
    generationId,
    runtime,
    live: Object.freeze({
      readPreparationBinding: () => {
        calls.push('read-preparation-binding');
        return Promise.resolve(binding);
      },
    }),
    failures: Object.freeze({
      complete: () => {
        calls.push('record-failure');
        return Promise.resolve(simulationArtifact as never);
      },
    }),
    evaluator: Object.freeze({
      evaluate: async (
        _context: Parameters<FreshLiveExecutionDependencies['evaluator']['evaluate']>[0],
        _signal: AbortSignal,
        renew: Parameters<FreshLiveExecutionDependencies['evaluator']['evaluate']>[2],
      ) => {
        if (outcome === 'FAILURE') {
          return Object.freeze({
            payloadVersion: 1 as const,
            outcome: 'FAILURE' as const,
            artifact: simulationArtifact,
            candidate: null,
          });
        }
        await renew('BEFORE_CANONICAL_SNAPSHOT');
        await renew('BEFORE_SIMULATION');
        await renew('BEFORE_SIGNING');
        return Object.freeze({
          payloadVersion: 1 as const,
          outcome: 'SUCCESS' as const,
          artifact: simulationArtifact,
          candidate,
        });
      },
    }),
    candidateAuthority: authority,
    executePrepared: (
      input: Parameters<FreshLiveExecutionDependencies['executePrepared']>[0],
    ) => {
      calls.push('consume-worker');
      persisted = input;
      return Promise.resolve(Object.freeze({
        payloadVersion: 1 as const,
        kind: 'ACCEPTED' as const,
        artifactId: input.persist.artifact.artifactId,
        signature: input.persist.artifact.signature,
        claim,
      }));
    },
    clock: () => nowMs,
  });
  const renew = async (): Promise<ClaimedExecutionIntent> => {
    calls.push('renew');
    return claim;
  };
  return { calls, claim, attempt, binding, material, authority, candidate, dependencies, renew,
    get persisted() { return persisted; } };
}

function claimValue(nowMs: number): ClaimedExecutionIntent {
  return Object.freeze({
    intent: Object.freeze({
      id: `execution_intent_${'1'.repeat(64)}`,
      payloadVersion: 1,
      logicalOrderKey: 'logical',
      strategyId: 'strategy',
      strategyVersion: 1,
      positionId: 'position',
      logicalCommandId: 'command',
      mint: wallet,
      side: 'BUY',
      venuePolicy: 'PUMP_FUN_ONLY',
      quoteMint: 'So11111111111111111111111111111111111111112',
      quoteTokenProgram: 'SPL_TOKEN',
      quoteDecimals: 9,
      quoteAmountRaw: 100n,
      baseAmountRaw: null,
      minimumAmountOutRaw: 90n,
      decisionEventId: 'decision',
      decisionFingerprint: 'f'.repeat(64),
      requestedAtMs: nowMs - 1_000,
      expiresAtMs: nowMs + 60_000,
      status: 'PROCESSING',
      attemptCount: 1,
      stateRevision: 1n,
      lastReasonCode: 'EXECUTION_STARTED',
      terminalAtMs: null,
      reconciliationCompletedAtMs: null,
      purgeAfterMs: null,
      createdAtMs: nowMs - 1_000,
      updatedAtMs: nowMs - 500,
    }),
    leaseOwner: 'live-test',
    leaseToken: '11111111-1111-4111-8111-111111111111',
    leaseExpiresAtMs: nowMs + 30_000,
  });
}

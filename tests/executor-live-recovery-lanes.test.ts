import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionIntentDraft, type ExecutionIntentV1 } from '../src/domain/execution-intent.js';
import {
  createLiveRecoveryLanes,
  LiveRecoveryLaneError,
  type LiveRecoveryLaneDependencies,
} from '../src/executor-live-recovery/lanes.js';
import type { LiveRecoveryConfig } from '../src/executor-live-recovery/config.js';
import type { ExecutionReconciliationEvidenceV1 } from '../src/domain/execution-reconciliation.js';
import type { ClaimedExecutionIntent } from '../src/ports/execution-intent-repository.js';
import type { ExecutionLiveConfirmationV1 } from '../src/ports/execution-live-repository.js';

const signature = '3'.repeat(88);
const key = '11111111111111111111111111111111';
const hash = 'a'.repeat(64);

void test('reconciliation renews around RPC and commits with the latest active claim', async () => {
  const calls: string[] = [];
  let committedClaim: ClaimedExecutionIntent | null = null;
  const fixture = dependencies(calls, 'CONFIRMED');
  fixture.live.readReconciliationWork = () => {
    calls.push('read-reconciliation');
    return Promise.resolve(Object.freeze({
      payloadVersion: 1, providerId: 'primary', request: reconciliationRequest(),
    }));
  };
  fixture.live.commitReconciliation = (claim, evidence) => {
    calls.push(`commit:${evidence.result}`);
    committedClaim = claim;
    return Promise.resolve(Object.freeze({ payloadVersion: 1, result: evidence.result }));
  };
  const lanes = createLiveRecoveryLanes(fixture);

  assert.equal(await lanes.reconciliation(signal()), 'WORKED');
  assert.deepEqual(calls, [
    'claim:RECONCILE', 'read-reconciliation', 'renew:1',
    'rpc:height', 'rpc:history', 'rpc:transaction', 'rpc:deltas',
    'renew:2', 'commit:MATCHED',
  ]);
  assert.equal((committedClaim as ClaimedExecutionIntent | null)?.leaseExpiresAtMs, 3_000);
});

void test('confirmation releases pending work and does not starve the deadline lane', async () => {
  const calls: string[] = [];
  const fixture = dependencies(calls, 'SUBMITTED', 'NOT_FOUND');
  fixture.live.readConfirmationWork = () => {
    calls.push('read-confirmation');
    return Promise.resolve(Object.freeze({
      payloadVersion: 1, artifactId: `execution_signed_transaction_${hash}`,
      expectedRevision: 3n, signature, providerId: 'primary',
    }));
  };
  fixture.live.createNextDeadlineExitIntent = () => {
    calls.push('deadline');
    return Promise.resolve(Object.freeze({ payloadVersion: 1, kind: 'CREATED', intent: null }));
  };
  const lanes = createLiveRecoveryLanes(fixture);

  assert.equal(await lanes.confirmation(signal()), 'DEFERRED');
  assert.equal(await lanes.deadline(signal()), 'WORKED');
  assert.deepEqual(calls, [
    'claim:CONFIRM', 'read-confirmation', 'renew:1', 'rpc:confirmation',
    'release', 'deadline',
  ]);
});

void test('confirmation commits with a post-RPC renewal and never uses the stale claim', async () => {
  const calls: string[] = [];
  let committedClaim: ClaimedExecutionIntent | null = null;
  const fixture = dependencies(calls, 'SUBMITTED', 'FINALIZED');
  fixture.live.readConfirmationWork = () => Promise.resolve(Object.freeze({
    payloadVersion: 1, artifactId: `execution_signed_transaction_${hash}`,
    expectedRevision: 3n, signature, providerId: 'primary',
  }));
  fixture.live.recordConfirmation = (claim, confirmation) => {
    calls.push(`confirm:${confirmation.observedSlot.toString()}`);
    committedClaim = claim;
    return Promise.resolve(Object.freeze({ artifactId: confirmation.artifactId }));
  };
  const lanes = createLiveRecoveryLanes(fixture);

  assert.equal(await lanes.confirmation(signal()), 'WORKED');
  assert.equal((committedClaim as ClaimedExecutionIntent | null)?.leaseExpiresAtMs, 3_000);
  assert.deepEqual(calls, [
    'claim:CONFIRM', 'renew:1', 'rpc:confirmation', 'renew:2', 'confirm:500', 'release',
  ]);
});

void test('provider mismatch releases the claim before any RPC and fails closed', async () => {
  const calls: string[] = [];
  const fixture = dependencies(calls, 'SUBMITTED');
  fixture.live.readConfirmationWork = () => Promise.resolve(Object.freeze({
    payloadVersion: 1, artifactId: `execution_signed_transaction_${hash}`,
    expectedRevision: 3n, signature, providerId: 'secondary',
  }));
  await assert.rejects(
    createLiveRecoveryLanes(fixture).confirmation(signal()),
    (error: unknown) => error instanceof LiveRecoveryLaneError
      && error.code === 'PROVIDER_MISMATCH',
  );
  assert.deepEqual(calls, ['claim:CONFIRM', 'release']);
});

void test('empty claims and non-due deadlines remain idle', async () => {
  const calls: string[] = [];
  const fixture = dependencies(calls, 'NONE');
  const lanes = createLiveRecoveryLanes(fixture);
  assert.equal(await lanes.reconciliation(signal()), 'IDLE');
  assert.equal(await lanes.confirmation(signal()), 'IDLE');
  assert.equal(await lanes.deadline(signal()), 'IDLE');
  assert.deepEqual(calls, ['claim:RECONCILE', 'claim:CONFIRM', 'deadline']);
});

type IntentStatus = 'CONFIRMED' | 'SUBMITTED' | 'NONE';
type ConfirmationStatus = 'FINALIZED' | 'NOT_FOUND';

function dependencies(
  calls: string[],
  intentStatus: IntentStatus,
  confirmationStatus: ConfirmationStatus = 'FINALIZED',
) {
  let renewals = 0;
  const original = intentStatus === 'NONE' ? null : claim(intentStatus);
  type MutableLive = {
    -readonly [Key in keyof LiveRecoveryLaneDependencies['live']]:
      LiveRecoveryLaneDependencies['live'][Key];
  };
  const live: MutableLive = {
    readReconciliationWork: () => Promise.reject(new Error('unexpected reconciliation read')),
    commitReconciliation: (_claim: ClaimedExecutionIntent, _evidence: ExecutionReconciliationEvidenceV1) =>
      Promise.reject(new Error('unexpected reconciliation commit')),
    readConfirmationWork: () => Promise.reject(new Error('unexpected confirmation read')),
    recordConfirmation: (_claim: ClaimedExecutionIntent, _input: ExecutionLiveConfirmationV1) =>
      Promise.reject(new Error('unexpected confirmation commit')),
    createNextDeadlineExitIntent: () => {
      calls.push('deadline');
      return Promise.resolve(null);
    },
  };
  return {
    config: config(),
    intents: {
      claim: (options: Readonly<{ purpose: string }>) => {
        calls.push(`claim:${options.purpose}`);
        if (original === null) return Promise.resolve(null);
        if (options.purpose === 'CONFIRM' && original.intent.status !== 'SUBMITTED') {
          return Promise.resolve(null);
        }
        if (options.purpose === 'RECONCILE' && original.intent.status !== 'CONFIRMED') {
          return Promise.resolve(null);
        }
        return Promise.resolve(original);
      },
      renew: (active: ClaimedExecutionIntent) => {
        renewals += 1;
        calls.push(`renew:${renewals}`);
        return Promise.resolve(Object.freeze({ ...active, leaseExpiresAtMs: 1_000 + renewals * 1_000 }));
      },
      release: () => { calls.push('release'); return Promise.resolve(true); },
    },
    live,
    createGateway: () => ({
      providerId: 'primary',
      readFinalizedBlockHeight: () => { calls.push('rpc:height'); return Promise.resolve(1_001n); },
      readSignatureHistory: () => { calls.push('rpc:history'); return Promise.resolve('PRESENT' as const); },
      readNormalizedTransaction: () => {
        calls.push('rpc:transaction');
        return Promise.resolve(Object.freeze({ signature, blockhash: key, messageHash: hash }));
      },
      readFinalizedWalletDeltas: () => {
        calls.push('rpc:deltas');
        return Promise.resolve(Object.freeze({
          confirmationStatus: 'FINALIZED' as const, observedSlot: 500n,
          feeLamports: 5n, walletLamportDelta: -105n, baseDeltaRaw: 500n,
          quoteDeltaRaw: -100n, unexpectedResidualTokenBalanceRaw: 0n,
          observedAtMs: 1_900, finalizedAtMs: 2_000,
        }));
      },
      observeSignature: () => {
        calls.push('rpc:confirmation');
        return Promise.resolve(Object.freeze({
          confirmationStatus, observedSlot: confirmationStatus === 'FINALIZED' ? 500n : null,
          observedAtMs: 2_000,
        }));
      },
    }),
  };
}

function reconciliationRequest() {
  return Object.freeze({
    payloadVersion: 1 as const,
    expected: Object.freeze({
      intentId: `execution_intent_${'b'.repeat(64)}`, attemptNumber: 1,
      walletGeneration: 1, providerId: 'primary', side: 'BUY' as const,
      signature, blockhash: key, lastValidBlockHeight: 1_000n,
      messageHash: hash, buildFingerprint: hash, snapshotFingerprint: hash,
      maximumFeeLamports: 10n, maximumFeePayerLamportDebit: 1_000n,
    }),
    walletDeltaRequest: Object.freeze({
      signature, walletPublicKey: key, mint: key,
      quoteMint: 'So11111111111111111111111111111111111111112', side: 'BUY' as const,
    }),
  });
}

function claim(status: Exclude<IntentStatus, 'NONE'>): ClaimedExecutionIntent {
  const nowMs = 1_000;
  const draft = createExecutionIntentDraft({
    strategyId: 'recovery-test', strategyVersion: 1,
    positionId: 'position:test', logicalCommandId: 'command:test', mint: key,
    side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 100n, baseAmountRaw: null, minimumAmountOutRaw: 90n,
    decisionEventId: 'decision:test', decisionFingerprint: '1'.repeat(64),
    requestedAtMs: 0, expiresAtMs: 60_000,
  });
  const intent: ExecutionIntentV1 = Object.freeze({
    ...draft, id: `execution_intent_${'b'.repeat(64)}`, status,
    attemptCount: 1, stateRevision: 4n,
    lastReasonCode: status === 'SUBMITTED' ? 'SUBMISSION_ACCEPTED' : 'CONFIRMATION_OBSERVED',
    terminalAtMs: null, reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: 0, updatedAtMs: 0,
  });
  return Object.freeze({
    intent, leaseOwner: 'recovery-a',
    leaseToken: '11111111-1111-4111-8111-111111111111', leaseExpiresAtMs: nowMs + 1_000,
  });
}

function config(): LiveRecoveryConfig {
  return Object.freeze({
    mode: 'live', recoveryEnabled: true, cluster: 'mainnet-beta',
    databaseUrl: 'postgresql://ignored', pollMs: 100, leaseMs: 60_000,
    databaseStatementTimeoutMs: 3_000, shutdownGraceMs: 10_000,
    generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    executorPublicKey: key, providerId: 'primary',
    httpRpcUrl: 'https://rpc.example.test', expectedGenesisHash: key,
    rpcTimeoutMs: 5_000, maxRpcCallsPerPass: 8, ownerId: 'recovery-a',
  });
}

function signal(): AbortSignal { return new AbortController().signal; }

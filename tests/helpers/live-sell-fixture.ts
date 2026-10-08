// SELL fixtures shared by the SELL reconciliation, re-exit and fast-exit safety tests: a live
// position opened by an exact BUY, then a deadline (or early) SELL intent driven through H2b's
// real repository steps.
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import bs58 from 'bs58';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  createOperatorAuthorization,
  createExecutionArmamentRequestV2,
  createOperatorAuthorizationV2,
} from '../../src/domain/execution-operations.js';
import { createExecutionIntentDraft } from '../../src/domain/execution-intent.js';
import { createSignedTransactionArtifact } from '../../src/domain/execution-live.js';
import { createProviderUsageSnapshot } from '../../src/domain/execution-provider-quota.js';
import { evaluateExecutionReconciliation } from '../../src/domain/execution-reconciliation.js';
import { createExecutionRiskPolicy } from '../../src/domain/execution-risk-policy.js';
import {
  createMainnetSimulationEvidenceFingerprint,
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
} from '../../src/domain/execution-safety-qualification.js';
import { createExecutionSimulationArtifactDraft } from '../../src/domain/execution-simulation.js';
import {
  createExecutionLiveSignedSimulationEvidence,
  createExecutionLiveUnsignedSimulationEvidenceIdentity,
} from
  '../../src/domain/execution-live-signed-simulation.js';
import { createExecutionWalletSnapshot } from '../../src/domain/execution-wallet-snapshot.js';
import type { ClaimedExecutionIntent } from '../../src/ports/execution-intent-repository.js';
import type { ExecutionSimulationEvidenceV1 } from
  '../../src/ports/execution-simulation-gateway.js';
import { migrateDatabase } from '../../src/storage/database.js';
import { PostgresExecutionIntentRepository } from '../../src/storage/execution-intent.repository.js';
import { PostgresExecutionLiveRepository } from '../../src/storage/execution-live.repository.js';
import { PostgresExecutionOperationsRepository } from '../../src/storage/execution-operations.repository.js';
import { PostgresExecutionRiskRepository } from '../../src/storage/execution-risk.repository.js';
import { PostgresExecutionSimulationRepository } from '../../src/storage/execution-simulation.repository.js';
import { insertExecutionDecisionEvent } from './execution-decision-event.js';
import { earlyExitPolicy } from './fast-exit-events.js';
import { linkEnvelope } from './live-envelope-link.js';

type Pool = InstanceType<typeof pg.Pool>;

export const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
export const walletPublicKey = '11111111111111111111111111111111';
export const quoteMint = 'So11111111111111111111111111111111111111112';
export const fingerprint = '1'.repeat(64);
export const exactBuyWallet = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 17));
export const exactBuyWalletPublicKey = exactBuyWallet.publicKey.toBase58();
export const rpcBudget = Object.freeze({
  payloadVersion: 1 as const, callsUsed: 5, callsLimit: 12,
});


export function landedFailedSellEvidence(
  fixture: Awaited<ReturnType<typeof createAmbiguousSellFixture>>,
  observedAtMs: number,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return evaluateExecutionReconciliation({
    expected: sellExpected(fixture),
    observed: Object.freeze({
      signatureHistory: 'PRESENT' as const, confirmationStatus: 'FINALIZED' as const,
      finalizedBlockHeight: fixture.artifact.lastValidBlockHeight + 1n, observedSlot: 777n,
      transaction: Object.freeze({
        signature: fixture.artifact.signature, blockhash: fixture.artifact.blockhash,
        messageHash: fixture.artifact.messageHash,
        buildFingerprint: fixture.artifact.buildFingerprint,
        snapshotFingerprint: fixture.artifact.snapshotFingerprint,
      }),
      feeLamports: 5_000n, walletLamportDelta: -5_000n, baseDeltaRaw: 0n, quoteDeltaRaw: 0n,
      unexpectedResidualTokenBalanceRaw: 95n, observedAtMs, finalizedAtMs: observedAtMs + 1,
      transactionFailed: true, baseTokenAccountsUnchanged: true,
      ...overrides,
    }),
  });
}

export function sellExpected(fixture: Awaited<ReturnType<typeof createAmbiguousSellFixture>>) {
  return Object.freeze({
    intentId: fixture.artifact.intentId, attemptNumber: fixture.artifact.attemptNumber,
    walletGeneration: 1, providerId: fixture.artifact.providerId, side: 'SELL' as const,
    signature: fixture.artifact.signature, blockhash: fixture.artifact.blockhash,
    lastValidBlockHeight: fixture.artifact.lastValidBlockHeight,
    messageHash: fixture.artifact.messageHash,
    buildFingerprint: fixture.artifact.buildFingerprint,
    snapshotFingerprint: fixture.artifact.snapshotFingerprint,
    maximumFeeLamports: fixture.unsignedSimulation.estimatedFeeLamports,
    maximumFeePayerLamportDebit: fixture.unsignedSimulation.simulatedFeePayerLamportDebit,
  });
}

export function sellEvidence(
  fixture: Awaited<ReturnType<typeof createAmbiguousSellFixture>>,
  outcome: 'MATCHED' | 'NO_EFFECT' | 'MISMATCH' | 'UNKNOWN',
  observedAtMs: number,
  matchedWalletLamportDelta = 795n,
) {
  const common = {
    feeLamports: 0n, walletLamportDelta: 0n, baseDeltaRaw: 0n, quoteDeltaRaw: 0n,
    unexpectedResidualTokenBalanceRaw: 0n, observedAtMs, finalizedAtMs: null,
  };
  const observed = outcome === 'MATCHED' ? {
    signatureHistory: 'PRESENT' as const, confirmationStatus: 'FINALIZED' as const,
    finalizedBlockHeight: fixture.artifact.lastValidBlockHeight + 1n, observedSlot: 777n,
    transaction: Object.freeze({
      signature: fixture.artifact.signature, blockhash: fixture.artifact.blockhash,
      messageHash: fixture.artifact.messageHash,
      buildFingerprint: fixture.artifact.buildFingerprint,
      snapshotFingerprint: fixture.artifact.snapshotFingerprint,
    }),
    feeLamports: 5_000n, walletLamportDelta: matchedWalletLamportDelta,
    baseDeltaRaw: -95n, quoteDeltaRaw: 800n,
    unexpectedResidualTokenBalanceRaw: 0n, observedAtMs, finalizedAtMs: observedAtMs + 1,
  } : outcome === 'NO_EFFECT' ? {
    ...common, signatureHistory: 'ABSENT' as const, confirmationStatus: 'NOT_FOUND' as const,
    finalizedBlockHeight: fixture.artifact.lastValidBlockHeight + 1n,
    observedSlot: null, transaction: null, finalizedAtMs: observedAtMs + 1,
  } : outcome === 'MISMATCH' ? {
    ...common, signatureHistory: 'UNKNOWN' as const, confirmationStatus: 'NOT_FOUND' as const,
    finalizedBlockHeight: fixture.artifact.lastValidBlockHeight,
    observedSlot: null, transaction: null, unexpectedResidualTokenBalanceRaw: 1n,
  } : {
    ...common, signatureHistory: 'UNKNOWN' as const, confirmationStatus: 'NOT_FOUND' as const,
    finalizedBlockHeight: fixture.artifact.lastValidBlockHeight,
    observedSlot: null, transaction: null,
  };
  return evaluateExecutionReconciliation({
    expected: Object.freeze({
      intentId: fixture.artifact.intentId, attemptNumber: fixture.artifact.attemptNumber,
      walletGeneration: 1, providerId: fixture.artifact.providerId, side: 'SELL' as const,
      signature: fixture.artifact.signature, blockhash: fixture.artifact.blockhash,
      lastValidBlockHeight: fixture.artifact.lastValidBlockHeight,
      messageHash: fixture.artifact.messageHash,
      buildFingerprint: fixture.artifact.buildFingerprint,
      snapshotFingerprint: fixture.artifact.snapshotFingerprint,
      maximumFeeLamports: fixture.unsignedSimulation.estimatedFeeLamports,
      maximumFeePayerLamportDebit: fixture.unsignedSimulation.simulatedFeePayerLamportDebit,
    }),
    observed: Object.freeze(observed),
  });
}

export async function createAmbiguousSellFixture(pool: InstanceType<typeof pg.Pool>) {
  return createSellFixture(pool, 'AMBIGUOUS');
}

/** How the fixture's first SELL intent is created. */
export type SellExitKind = 'DEADLINE' | 'EARLY_REVOKED';

/**
 * A CANARY position OPEN after its exact BUY was reconciled MATCHED (no exit intent).
 * `entryQuoteDeltaRaw` is the BUY's observed quote delta (position.quote_cost_raw = its
 * negation); the BUY reservation stays 1_000, so a value below -1_000 reproduces a realized
 * cost above the reservation (WSOL quote: swap spend plus the token ATA rent).
 */
export async function createOpenPositionFixture(
  pool: InstanceType<typeof pg.Pool>,
  entryQuoteDeltaRaw = -1_000n,
) {
  await migrateDatabase({ pool });
  const buy = await createBuyFixture(pool);
  const live = new PostgresExecutionLiveRepository(pool);
  await live.persistSigned({
    payloadVersion: 1, claim: buy.claim, qualificationId: buy.qualificationId,
    preSignatureLockId: buy.preSignatureLockId,
    reservationId: buy.reservationId, artifact: buy.artifact,
    unsignedSimulation: buy.unsignedSimulation,
    rpcBudget,
  });
  const buySimulated = await live.recordSignedSimulation(buy.claim, signedSimulation(
    buy.artifact, buy.unsignedSimulation, 95n, -1_000n, buy.artifact.signedAtMs + 1,
  ));
  const buyStarted = await live.beginSubmission({
    claim: buy.claim, artifactId: buy.artifact.artifactId,
    expectedRevision: buySimulated.stateRevision, runtime: buy.runtime,
    blockhashValidity: blockhashValidity(buy.artifact, Date.now()),
  });
  const buyOutcomeAtMs = Date.now();
  await live.recordSubmissionOutcome(buy.claim, {
    payloadVersion: 1, artifactId: buy.artifact.artifactId,
    expectedRevision: buyStarted.stateRevision, outcome: 'ACCEPTED',
    returnedSignature: buy.artifact.signature, reasonCode: 'SUBMISSION_ACCEPTED',
    observedAtMs: buyOutcomeAtMs,
  });
  await live.recordConfirmation(buy.claim, {
    payloadVersion: 1, artifactId: buy.artifact.artifactId, expectedRevision: 3n,
    signature: buy.artifact.signature, observedSlot: 126n,
    observedAtMs: Date.now(),
  });
  const buyReconciliationClaim = await new PostgresExecutionIntentRepository(pool).claim({
    ownerId: 'sell-fixture-entry-reconciliation', leaseMs: 60_000, purpose: 'RECONCILE',
  });
  assert.ok(buyReconciliationClaim);
  const buyReconciliation = await live.readReconciliationWork(buyReconciliationClaim);
  const buyReconciliationAtMs = Date.now();
  const buyEvidence = evaluateExecutionReconciliation({
    expected: buyReconciliation.request.expected,
    observed: Object.freeze({
      signatureHistory: 'PRESENT' as const, confirmationStatus: 'FINALIZED' as const,
      finalizedBlockHeight: 1_001n, observedSlot: 127n,
      transaction: Object.freeze({
        signature: buy.artifact.signature, blockhash: buy.artifact.blockhash,
        messageHash: buy.artifact.messageHash,
        buildFingerprint: buy.artifact.buildFingerprint,
        snapshotFingerprint: buy.artifact.snapshotFingerprint,
      }),
      feeLamports: 5_000n, walletLamportDelta: -5_000n,
      baseDeltaRaw: 95n, quoteDeltaRaw: entryQuoteDeltaRaw,
      unexpectedResidualTokenBalanceRaw: 0n, observedAtMs: buyReconciliationAtMs,
      finalizedAtMs: buyReconciliationAtMs,
    }),
  });
  const entry = await live.commitReconciliation(buyReconciliationClaim, buyEvidence);
  assert.ok(entry.position);
  assert.ok(entry.exitAuthorization);
  return Object.freeze({
    live, buy, entry, positionId: entry.position.positionId,
    exitAuthorizationId: entry.exitAuthorization.authorizationId,
    buyReconciliationClaim, buyEvidence,
  });
}

/**
 * A position EXIT_PENDING behind a PENDING SELL intent (no claim, no attempt). DEADLINE: a
 * CANARY position made due, then the targeted deadline exit. EARLY_REVOKED: the position's
 * armament is bound to a REVOKED envelope, then the early exit scan (lot 4b) sells it before
 * its deadline. `exitDeadlineAtMs` is the SELL's observation time in both cases.
 */
export async function createExitPendingFixture(
  pool: InstanceType<typeof pg.Pool>,
  exitKind: SellExitKind = 'DEADLINE',
  entryQuoteDeltaRaw = -1_000n,
) {
  const open = await createOpenPositionFixture(pool, entryQuoteDeltaRaw);
  const { live, positionId } = open;
  if (exitKind === 'EARLY_REVOKED') {
    const envelopeId = await linkEnvelope(pool, generationId, {
      state: 'REVOKED', priorLossRaw: '0', maxLossRaw: '1000000',
    });
    const exit = await live.createNextEarlyExitIntent(earlyExitPolicy);
    assert.ok(exit);
    assert.equal(exit.reason, 'ENVELOPE_REVOKED');
    return Object.freeze({
      ...open, exitIntent: exit.intent, exitDeadlineAtMs: exit.intent.requestedAtMs, envelopeId,
    });
  }
  const exitDeadlineAtMs = await makePositionDue(pool, positionId);
  const exit = await live.createDeadlineExitIntent({ positionId, observedAtMs: exitDeadlineAtMs });
  assert.ok(exit.intent);
  await pool.query('UPDATE execution_intents SET live_reserved=TRUE WHERE id=$1', [exit.intent.id]);
  return Object.freeze({
    ...open, exitIntent: exit.intent, exitDeadlineAtMs, envelopeId: null,
  });
}

/** H2b's SELL claim of the fixture's exit intent: PROCESSING with attempt 1 STARTED. */
export async function beginSellAttempt(
  pool: InstanceType<typeof pg.Pool>,
  exitPending: Awaited<ReturnType<typeof createExitPendingFixture>>,
  leaseMs = 60_000,
) {
  const intents = new PostgresExecutionIntentRepository(pool);
  const exitClaim = await intents.claim({
    ownerId: 'sell-reconciliation-test', leaseMs,
    purpose: 'LIVE_EXECUTE', side: 'SELL',
  });
  assert.ok(exitClaim);
  assert.equal(exitClaim.intent.id, exitPending.exitIntent.id);
  const exitDeadlineAtMs = exitPending.exitDeadlineAtMs;
  const processing = await intents.transition(exitClaim, {
    intentId: exitClaim.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: exitClaim.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Prepare the canary SELL.', activationPhase: 'CANARY',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null,
      observedAtMs: exitDeadlineAtMs,
    }),
  });
  return intents.beginAttempt(Object.freeze({ ...exitClaim, intent: processing }));
}

type SellSubmissionState =
  'PERSISTED' | 'SUBMISSION_STARTED' | 'AMBIGUOUS' | 'ACCEPTED' | 'CONFIRMED';
type BeforePersistSigned = (
  live: PostgresExecutionLiveRepository,
  input: Parameters<PostgresExecutionLiveRepository['persistSigned']>[0],
) => Promise<void>;

export async function createSellFixture(
  pool: InstanceType<typeof pg.Pool>,
  submissionState: SellSubmissionState,
  beforePersistSigned?: BeforePersistSigned,
  exitKind: SellExitKind = 'DEADLINE',
  entryQuoteDeltaRaw = -1_000n,
) {
  return driveSellFixture(
    pool, await createExitPendingFixture(pool, exitKind, entryQuoteDeltaRaw), submissionState,
    beforePersistSigned,
  );
}

/**
 * Drives the exit intent of `exitPending` through H2b's real repository steps: SELL claim,
 * preparation binding (position.exit_intent_id = intent, EXIT_PENDING), signed persistence,
 * signed simulation, submission and its outcome. The RPC results are fixed values.
 */
export async function driveSellFixture(
  pool: InstanceType<typeof pg.Pool>,
  exitPending: Awaited<ReturnType<typeof createExitPendingFixture>>,
  submissionState: SellSubmissionState,
  beforePersistSigned?: BeforePersistSigned,
) {
  const { live, buy, entry, buyReconciliationClaim, buyEvidence } = exitPending;
  assert.ok(entry.exitAuthorization);
  const begun = await beginSellAttempt(pool, exitPending);
  const binding = await live.readPreparationBinding({
    claim: begun.claim, generationId, runtime: buy.runtime,
  });
  assert.equal(binding.side, 'SELL');
  assert.equal(binding.exitAuthorizationId, entry.exitAuthorization.authorizationId);
  const sellTimelineMs = Date.now();
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1, intentId: begun.claim.intent.id,
    attemptNumber: begun.attempt.attemptNumber, generationId, armamentId: null,
    reservationId: null, exitAuthorizationId: binding.exitAuthorizationId,
    providerId: 'primary',
    walletPublicKey: buy.artifact.walletPublicKey,
    side: 'SELL', effectiveVenue: 'PUMP_FUN', messageHash: 'a'.repeat(64),
    buildFingerprint: buy.artifact.buildFingerprint, snapshotFingerprint: 'c'.repeat(64),
    quoteFingerprint: 'e'.repeat(64), quoteObservedAtMs: sellTimelineMs,
    quoteExpiresAtMs: sellTimelineMs + 60_000,
    blockhash: buy.artifact.walletPublicKey,
    lastValidBlockHeight: 2_000n, signature: bs58.encode(new Uint8Array(64).fill(10)),
    signedTransactionBytes: Uint8Array.from([5, 6, 7, 8]), signedAtMs: sellTimelineMs + 1,
  });
  const unsignedSimulation = Object.freeze({
    outcome: 'SUCCESS' as const, snapshotFingerprint: artifact.snapshotFingerprint,
    buildFingerprint: artifact.buildFingerprint, messageHash: artifact.messageHash,
    blockhash: artifact.blockhash, lastValidBlockHeight: artifact.lastValidBlockHeight,
    blockhashContextSlot: 200n, feeContextSlot: 200n, estimatedFeeLamports: 5_000n,
    simulationSlot: 201n, simulatedFeePayerLamportDebit: 5_000n, unitsConsumed: 25_000n,
    simulatedBaseDeltaRaw: -95n, simulatedQuoteDeltaRaw: 800n,
    logsFingerprint: 'f'.repeat(64), logsLineCount: 1,
  });
  const persistInput = Object.freeze({
    payloadVersion: 1, claim: begun.claim, qualificationId: buy.qualificationId,
    preSignatureLockId: null, reservationId: null, artifact, unsignedSimulation, rpcBudget,
  });
  await beforePersistSigned?.(live, persistInput);
  await live.persistSigned(persistInput);
  if (submissionState === 'PERSISTED') {
    return Object.freeze({
      live, claim: begun.claim, artifact, unsignedSimulation,
      buyClaim: buyReconciliationClaim, buyEvidence, observedAtMs: Date.now(),
    });
  }
  const simulated = await live.recordSignedSimulation(
    begun.claim,
    signedSimulation(artifact, unsignedSimulation, -95n, 800n, artifact.signedAtMs + 1),
  );
  const started = await live.beginSubmission({
    claim: begun.claim, artifactId: artifact.artifactId,
    expectedRevision: simulated.stateRevision, runtime: buy.runtime,
    blockhashValidity: blockhashValidity(artifact, Date.now()),
  });
  if (submissionState === 'SUBMISSION_STARTED') {
    return Object.freeze({
      live, claim: begun.claim, artifact, unsignedSimulation,
      buyClaim: buyReconciliationClaim, buyEvidence, observedAtMs: Date.now(),
    });
  }
  const sellOutcomeAtMs = Date.now();
  await live.recordSubmissionOutcome(begun.claim, {
    payloadVersion: 1, artifactId: artifact.artifactId,
    expectedRevision: started.stateRevision,
    outcome: submissionState === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'ACCEPTED',
    returnedSignature: submissionState === 'AMBIGUOUS' ? null : artifact.signature,
    reasonCode: submissionState === 'AMBIGUOUS'
      ? 'SUBMISSION_AMBIGUOUS' : 'SUBMISSION_ACCEPTED',
    observedAtMs: sellOutcomeAtMs,
  });
  if (submissionState === 'CONFIRMED') {
    await live.recordConfirmation(begun.claim, {
      payloadVersion: 1, artifactId: artifact.artifactId,
      expectedRevision: started.stateRevision + 1n, signature: artifact.signature,
      observedSlot: 778n, observedAtMs: sellOutcomeAtMs + 1,
    });
    const reconciliationClaim = await new PostgresExecutionIntentRepository(pool).claim({
      ownerId: 'sell-fixture-confirmed-reconciliation', leaseMs: 60_000, purpose: 'RECONCILE',
    });
    assert.ok(reconciliationClaim);
    return Object.freeze({
      live, claim: reconciliationClaim, artifact, unsignedSimulation,
      buyClaim: buyReconciliationClaim, buyEvidence,
      observedAtMs: Date.now(),
    });
  }
  return Object.freeze({
    live, claim: begun.claim, artifact, unsignedSimulation,
    buyClaim: buyReconciliationClaim, buyEvidence,
    observedAtMs: Date.now(),
  });
}

export async function makePositionDue(
  pool: InstanceType<typeof pg.Pool>,
  positionId: string,
): Promise<number> {
  // Only this test-clock update bypasses the position guard; the trigger stays enabled.
  await pool.query(`ALTER TABLE execution_live_positions
    DISABLE TRIGGER execution_live_positions_guarded_update`);
  let updated: pg.QueryResult<{ deadline_ms: string }>;
  try {
    updated = await pool.query(`UPDATE execution_live_positions SET
      exit_deadline_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 second',
      opened_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 second'
        -(maximum_holding_ms*INTERVAL '1 millisecond')
      WHERE position_id=$1
      RETURNING trunc(EXTRACT(EPOCH FROM exit_deadline_at)*1000)::TEXT AS deadline_ms`, [
      positionId,
    ]);
  } finally {
    await pool.query(`ALTER TABLE execution_live_positions
      ENABLE TRIGGER execution_live_positions_guarded_update`);
  }
  assert.equal(updated.rowCount, 1);
  const deadlineMs = updated.rows[0]?.deadline_ms;
  assert.equal(typeof deadlineMs, 'string');
  return Number(deadlineMs);
}

export function blockhashValidity(
  artifact: ReturnType<typeof createSignedTransactionArtifact>,
  observedAtMs: number,
) {
  return Object.freeze({
    payloadVersion: 1 as const, providerId: artifact.providerId,
    blockhash: artifact.blockhash, valid: true as const,
    observedBlockHeight: artifact.lastValidBlockHeight - 1n,
    contextSlot: 203n, observedAtMs,
  });
}

export function signedSimulation(
  artifact: ReturnType<typeof createSignedTransactionArtifact>,
  unsignedSimulation: ExecutionSimulationEvidenceV1,
  baseDeltaRaw: bigint,
  quoteDeltaRaw: bigint,
  observedAtMs: number,
) {
  return createExecutionLiveSignedSimulationEvidence({
    payloadVersion: 1 as const, artifactId: artifact.artifactId,
    unsignedSimulationEvidenceId: createExecutionLiveUnsignedSimulationEvidenceIdentity(
      artifact, unsignedSimulation,
    ).evidenceId,
    signedTransactionHash: artifact.signedTransactionHash, simulationSlot: 202n,
    providerId: artifact.providerId,
    unitsConsumed: 26_000n, feePayerLamportDebit: 5_000n,
    baseDeltaRaw, quoteDeltaRaw, logsFingerprint: '9'.repeat(64), logsLineCount: 1,
    observedAtMs,
  });
}

export async function createBuyFixture(pool: InstanceType<typeof pg.Pool>) {
  const risk = new PostgresExecutionRiskRepository(pool);
  await risk.registerWalletGeneration({
    generationId, payloadVersion: 1, walletPublicKey: exactBuyWalletPublicKey,
    cluster: 'mainnet-beta', genesisHash: exactBuyWalletPublicKey, generation: 1,
  });
  const snapshotNowMs = Date.now();
  const walletSnapshot = createExecutionWalletSnapshot({
    generationId, providerId: 'primary', stateRevision: 0n, slot: 123n,
    blockTimeMs: snapshotNowMs - 100, observedAtMs: snapshotNowMs - 50,
    commitment: 'finalized', walletLamports: 1_000_000n, tokenBalanceCount: 0,
    openPositions: [], realizedNetPnlRaw: 0n,
  });
  const providerSnapshot = createProviderUsageSnapshot({
    providerId: 'primary', planId: 'canary-v1', billingPeriodId: `period-${snapshotNowMs}`,
    billingPeriodStartedAtMs: snapshotNowMs - 60_000,
    billingPeriodEndsAtMs: snapshotNowMs + 600_000, limitUnits: 1_000n, usedUnits: 1n,
    measuredAtMs: snapshotNowMs - 50, expiresAtMs: snapshotNowMs + 300_000,
    provenance: 'OPERATOR_REPORT',
  });
  const simulation = await seedSuccessfulSimulation(pool, exactBuyWalletPublicKey);
  const nowMs = Date.now();
  const qualification = qualificationWithCanarySnapshots(
    safetyQualification(nowMs, simulation, exactBuyWalletPublicKey), walletSnapshot, providerSnapshot,
  );
  const operations = new PostgresExecutionOperationsRepository(pool);
  await operations.persistQualification(qualification);
  const resume = createOperatorAuthorization({
    payloadVersion: 1, generationId, action: 'RESUME', phase: null,
    contextFingerprint: qualification.qualificationFingerprint,
    nonceHash: '9'.repeat(64), operatorId: 'operator-primary', issuedAtMs: nowMs,
    expiresAtMs: nowMs + 60_000,
  });
  await operations.recordAuthorization(resume);
  await operations.resume({
    payloadVersion: 1, commandId: `command:exact-buy-resume:${randomUUID()}`, generationId,
    qualificationId: qualification.qualificationId, authorization: resume,
    operatorId: 'operator-primary', occurredAtMs: nowMs,
  });
  const intents = new PostgresExecutionIntentRepository(pool);
  const decisionEventId = `decision:exact-buy:${randomUUID()}`;
  await insertExecutionDecisionEvent(pool, decisionEventId, exactBuyWalletPublicKey);
  const target = await intents.create(createExecutionIntentDraft({
    strategyId: 'exact-buy-target', strategyVersion: 1,
    positionId: `position:exact-buy:${randomUUID()}`,
    logicalCommandId: `command:exact-buy:${randomUUID()}`,
    mint: exactBuyWalletPublicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint,
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: 1_000n,
    baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId,
    decisionFingerprint: 'd'.repeat(64), requestedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 120_000,
  }));
  const request = createExecutionArmamentRequestV2({
    payloadVersion: 2, qualification, targetIntentId: target.intent.id,
    policy: exactBuyCanaryPolicy(), walletSnapshot, providerSnapshot,
    allEndpointsUnavailable: false, capturedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
    target: {
      intentId: target.intent.id, stateRevision: target.intent.stateRevision,
      strategyId: target.intent.strategyId, strategyVersion: target.intent.strategyVersion,
      decisionFingerprint: target.intent.decisionFingerprint, mint: target.intent.mint,
      quoteMint: target.intent.quoteMint, quoteAmountRaw: target.intent.quoteAmountRaw,
    },
    maximumBuys: 1, maximumCapitalLamports: 1_000n, maximumExposureBps: 500n,
    maximumOpenPositions: 1, maximumHoldingMs: 30_000, runtimeQuoteMaxAgeMs: 60_000,
    runtimeSlippageBps: 100n, runtimeSnapshotMaxSlotLag: 8,
    runtimeMaxComputeUnits: 200_000n, runtimeMaxFeeLamports: 5_000n,
    runtimeMaxFeePayerLamportDebit: 100_000n, runtimeMaxRpcCallsPerAttempt: 12,
    runtimeLeaseMs: 3_000, armedAtMs: nowMs, armamentExpiresAtMs: nowMs + 120_000,
    operatorId: 'operator-primary', operatorReason: 'Mainnet canary manually approved.',
  });
  const armamentAuthorization = createOperatorAuthorizationV2({
    payloadVersion: 2, generationId, action: 'ARM', phase: 'CANARY',
    contextFingerprint: request.armamentRequestFingerprint, nonceHash: 'e'.repeat(64),
    operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
  });
  await operations.armCanary(Object.freeze({ request, authorization: armamentAuthorization }));
  const claimed = await intents.claim({
    ownerId: 'exact-buy-lock-holder', leaseMs: 30_000,
    purpose: 'LIVE_EXECUTE', side: 'BUY', generationId,
  });
  assert.ok(claimed);
  const processing = await intents.transition(claimed, {
    intentId: claimed.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: claimed.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Exact BUY signing test started.', activationPhase: 'CANARY',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: nowMs,
    }),
  });
  const begun = await intents.beginAttempt(Object.freeze({ ...claimed, intent: processing }));
  const unsigned = new VersionedTransaction(new TransactionMessage({
    payerKey: exactBuyWallet.publicKey, recentBlockhash: exactBuyWalletPublicKey, instructions: [],
  }).compileToV0Message());
  const messageBytes = Object.freeze([...unsigned.message.serialize()]);
  const unsignedTransactionBytes = Object.freeze([...unsigned.serialize()]);
  const quoteObservedAtMs = Date.now();
  const material = Object.freeze({
    payloadVersion: 1 as const, walletPublicKey: exactBuyWalletPublicKey, providerId: 'primary',
    side: 'BUY' as const, effectiveVenue: 'PUMP_FUN' as const, snapshotSlot: 125n,
    quoteFingerprint: '7'.repeat(64), quoteObservedAtMs, quoteExpiresAtMs: quoteObservedAtMs + 60_000,
    buildFingerprint: qualification.buildHash, snapshotFingerprint: '6'.repeat(64),
    messageHash: sha256(messageBytes), messageBytes,
    unsignedTransactionHash: sha256(unsignedTransactionBytes), unsignedTransactionBytes,
    blockhash: exactBuyWalletPublicKey, lastValidBlockHeight: 1_000n,
    unsignedSimulation: Object.freeze({
      outcome: 'SUCCESS' as const, snapshotFingerprint: '6'.repeat(64),
      buildFingerprint: qualification.buildHash, messageHash: sha256(messageBytes),
      blockhash: exactBuyWalletPublicKey, lastValidBlockHeight: 1_000n,
      blockhashContextSlot: 125n, feeContextSlot: 125n, estimatedFeeLamports: 5_000n,
      simulationSlot: 125n, simulatedFeePayerLamportDebit: 5_000n, unitsConsumed: 25_000n,
      simulatedBaseDeltaRaw: 100n, simulatedQuoteDeltaRaw: -1_000n,
      logsFingerprint: '8'.repeat(64), logsLineCount: 1,
    }),
  });
  const runtime = Object.freeze({
    payloadVersion: 1 as const, phase: 'CANARY' as const, buildHash: qualification.buildHash,
    configurationFingerprint: qualification.configurationFingerprint,
    strategyFingerprint: qualification.strategyFingerprint, walletPublicKey: exactBuyWalletPublicKey,
    cluster: 'mainnet-beta' as const, expectedGenesisHash: exactBuyWalletPublicKey,
    observedGenesisHash: exactBuyWalletPublicKey, providerId: 'primary', quoteMaxAgeMs: 60_000,
    slippageBps: 100n, snapshotMaxSlotLag: 8, maxComputeUnits: 200_000n,
    maxFeeLamports: 5_000n, maxFeePayerLamportDebit: 100_000n,
    maxRpcCallsPerAttempt: 12, leaseMs: 3_000,
  });
  const live = new PostgresExecutionLiveRepository(pool);
  const authorization = await live.authorizeExactSigning(Object.freeze({
    claim: begun.claim, attempt: begun.attempt, generationId, runtime, material,
  }));
  assert.ok(authorization.binding.armamentId !== null);
  assert.ok(authorization.binding.reservationId !== null);
  assert.ok(authorization.preSignatureLockId !== null);
  const signed = VersionedTransaction.deserialize(
    Uint8Array.from(authorization.material.unsignedTransactionBytes),
  );
  signed.sign([exactBuyWallet]);
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1, intentId: begun.claim.intent.id,
    attemptNumber: begun.attempt.attemptNumber, generationId,
    armamentId: authorization.binding.armamentId,
    reservationId: authorization.binding.reservationId, exitAuthorizationId: null,
    providerId: authorization.binding.providerId, walletPublicKey: exactBuyWalletPublicKey,
    side: 'BUY', effectiveVenue: authorization.material.effectiveVenue,
    messageHash: authorization.material.messageHash,
    buildFingerprint: authorization.material.buildFingerprint,
    snapshotFingerprint: authorization.material.snapshotFingerprint,
    quoteFingerprint: authorization.material.quoteFingerprint,
    quoteObservedAtMs: authorization.material.quoteObservedAtMs,
    quoteExpiresAtMs: authorization.material.quoteExpiresAtMs,
    blockhash: authorization.material.blockhash,
    lastValidBlockHeight: authorization.material.lastValidBlockHeight,
    signature: bs58.encode(signed.signatures[0] ?? new Uint8Array(64)),
    signedTransactionBytes: signed.serialize(), signedAtMs: Date.now(),
  });
  return {
    claim: begun.claim, artifact, unsignedSimulation: authorization.material.unsignedSimulation, runtime,
    qualificationId: authorization.binding.qualificationId,
    reservationId: authorization.binding.reservationId,
    preSignatureLockId: authorization.preSignatureLockId,
  };
}

export function exactBuyCanaryPolicy() {
  return createExecutionRiskPolicy({
    quoteMintAllowlist: [quoteMint], initialCapitalLamports: 1_000_000n,
    maximumCapitalLamports: 1_000_000n, positionSizeBps: 1_000n,
    maximumOpenPositions: 1, maximumTotalExposureBps: 500n, drawdownPauseBps: 2_500n,
    feeReserveLamports: 100_000n, walletSnapshotMaxAgeMs: 60_000,
    providerUsageMaxAgeMs: 300_000, providerEntryCostUnits: 8n,
    providerExitCostUnitsPerPosition: 4n, providerConfirmationCostUnitsPerPosition: 2n,
    providerReconciliationCostUnitsPerPosition: 3n, providerSafetyMarginUnits: 5n,
    maximumConsecutiveTechnicalFailures: 2,
  });
}

export function sha256(bytes: readonly number[]): string {
  return createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
}

export function safetyQualification(
  nowMs: number,
  simulation: Awaited<ReturnType<typeof seedSuccessfulSimulation>>,
  qualificationWalletPublicKey = walletPublicKey,
) {
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST',
    'SIMULATION_ARTIFACT', 'FAULT_TEST', 'RECONCILIATION_STATE',
    'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST', 'WALLET_SNAPSHOT',
    'MAINNET_SIMULATION_ARTIFACT',
  ] as const;
  return createSafetyQualification({
    payloadVersion: 1, evaluatorVersion: 1, phase: 'CANARY', buildHash: fingerprint,
    configurationFingerprint: simulation.configurationFingerprint,
    strategyFingerprint: '3'.repeat(64), generationId,
    walletPublicKey: qualificationWalletPublicKey,
    cluster: 'mainnet-beta', genesisHash: qualificationWalletPublicKey, providerId: 'primary',
    qualifiedAtMs: nowMs, expiresAtMs: nowMs + 300_000,
    gates: EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => ({
      payloadVersion: 1, gateId, status: 'PASSED', evidenceType: evidenceTypes[index],
      evidenceId: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
        ? simulation.artifactId : `evidence:${index}`,
      evidenceFingerprint: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
        ? createMainnetSimulationEvidenceFingerprint({
          artifactId: simulation.artifactId, resultFingerprint: simulation.resultFingerprint,
          buildHash: fingerprint, configurationFingerprint: simulation.configurationFingerprint,
          strategyFingerprint: '3'.repeat(64), walletPublicKey: qualificationWalletPublicKey,
          genesisHash: qualificationWalletPublicKey, providerId: 'primary',
        }) : index.toString(16).repeat(64),
      observedAtMs: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
        ? simulation.recordedAtMs : nowMs - 1_000 + index,
      expiresAtMs: nowMs + 300_000,
    })),
  });
}

export function qualificationWithCanarySnapshots(
  template: ReturnType<typeof safetyQualification>,
  walletSnapshot: ReturnType<typeof createExecutionWalletSnapshot>,
  providerSnapshot: ReturnType<typeof createProviderUsageSnapshot>,
) {
  return createSafetyQualification({
    payloadVersion: template.payloadVersion, evaluatorVersion: template.evaluatorVersion,
    phase: template.phase, buildHash: template.buildHash,
    configurationFingerprint: template.configurationFingerprint,
    strategyFingerprint: template.strategyFingerprint, generationId: template.generationId,
    walletPublicKey: template.walletPublicKey, cluster: template.cluster,
    genesisHash: template.genesisHash, providerId: template.providerId,
    qualifiedAtMs: template.qualifiedAtMs, expiresAtMs: template.expiresAtMs,
    gates: template.gates.map((gate) => gate.gateId === 'WALLET_CHAIN_LIMITS_VERIFIED'
      ? {
        ...gate, evidenceId: walletSnapshot.snapshotId,
        evidenceFingerprint: walletSnapshot.snapshotFingerprint,
      }
      : gate.gateId === 'PROVIDER_EXIT_CAPACITY_VERIFIED'
        ? {
          ...gate, evidenceId: providerSnapshot.snapshotId,
          evidenceFingerprint: providerSnapshot.snapshotFingerprint,
        }
        : gate),
  });
}

export async function seedSuccessfulSimulation(
  pool: InstanceType<typeof pg.Pool>,
  simulationWalletPublicKey = walletPublicKey,
) {
  const nowMs = Date.now();
  const intents = new PostgresExecutionIntentRepository(pool);
  const decisionEventId = `event-${randomUUID()}`;
  await insertExecutionDecisionEvent(pool, decisionEventId, simulationWalletPublicKey);
  const created = await intents.create(createExecutionIntentDraft({
    strategyId: 'simulation-strategy', strategyVersion: 1,
    positionId: `position-${randomUUID()}`, logicalCommandId: `command-${randomUUID()}`,
    mint: simulationWalletPublicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint,
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: 1_000n,
    baseAmountRaw: null, minimumAmountOutRaw: 850n,
    decisionEventId, decisionFingerprint: fingerprint,
    requestedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
  }));
  const claimed = await intents.claim({
    ownerId: 'preflight-sell-test', leaseMs: 30_000, purpose: 'EXECUTE',
  });
  assert.ok(claimed);
  const processing = await intents.transition(claimed, {
    intentId: created.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: claimed.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Execution simulation started.', activationPhase: 'NONE',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: nowMs,
    }),
  });
  const begun = await intents.beginAttempt(Object.freeze({ ...claimed, intent: processing }));
  const draft = createExecutionSimulationArtifactDraft({
    intentId: begun.claim.intent.id, attemptNumber: begun.attempt.attemptNumber,
    intentStateRevision: begun.claim.intent.stateRevision,
    strategyId: begun.claim.intent.strategyId, strategyVersion: begun.claim.intent.strategyVersion,
    decisionFingerprint: begun.claim.intent.decisionFingerprint,
    resultKind: 'SUCCESS', effectiveVenue: 'PUMP_FUN', providerId: 'primary',
    executorPublicKey: simulationWalletPublicKey,
    expectedGenesisHash: simulationWalletPublicKey,
    observedGenesisHash: simulationWalletPublicKey, configurationFingerprint: fingerprint,
    quoteFingerprint: fingerprint, snapshotFingerprint: fingerprint,
    buildFingerprint: fingerprint, messageHash: fingerprint, blockhash: walletPublicKey,
    lastValidBlockHeight: 1_000n, blockhashContextSlot: 900n, snapshotSlot: 899n,
    feeContextSlot: 900n, simulationSlot: 901n, amountInRaw: 1_000n,
    expectedAmountOutRaw: 900n, protectedAmountOutRaw: 850n, feesRaw: 10n,
    estimatedFeeLamports: 5_000n, simulatedFeePayerLamportDebit: 6_000n,
    unitsConsumed: 200_000n, simulatedBaseDeltaRaw: 900n,
    simulatedQuoteDeltaRaw: -1_000n, rpcCallsUsed: 5, rpcCallsLimit: 8,
    quoteStatus: 'SUCCEEDED', buildStatus: 'SUCCEEDED', simulationStatus: 'SUCCEEDED',
    failureStage: null, failureCode: null, terminalReasonCode: 'INTENT_SUCCEEDED',
    logsFingerprint: fingerprint, logsLineCount: 1,
  });
  return new PostgresExecutionSimulationRepository(pool)
    .complete(begun.claim, draft, new AbortController().signal);
}

export function requiredDatabaseUrl(context: TestContext): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: SELL reconciliation integration skipped');
    return null;
  }
  return databaseUrl;
}

export async function claimSellReconciliation(
  pool: InstanceType<typeof pg.Pool>,
  ownerId: string,
) {
  const claim = await new PostgresExecutionIntentRepository(pool).claim({
    ownerId,
    leaseMs: 60_000,
    purpose: 'RECONCILE',
  });
  assert.ok(claim);
  return claim;
}

export async function waitForDatabaseQuery(
  pool: InstanceType<typeof pg.Pool>,
  pattern: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query(`SELECT 1 FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND state='active' AND wait_event IS NOT NULL
        AND query ILIKE $1 LIMIT 1`, [pattern]);
    if (result.rowCount === 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for blocked PostgreSQL query matching ${pattern}.`);
}

export async function withTemporarySchema(
  databaseUrl: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `execution_live_sell_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl, max: 4,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    created = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    try { await pool.end(); } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally { await admin.end(); }
    }
  }
}

export function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}

export function providerFailureDraft(claim: ClaimedExecutionIntent, attemptNumber: number) {
  return createExecutionSimulationArtifactDraft({
    intentId: claim.intent.id, attemptNumber, intentStateRevision: claim.intent.stateRevision,
    strategyId: claim.intent.strategyId, strategyVersion: claim.intent.strategyVersion,
    decisionFingerprint: claim.intent.decisionFingerprint,
    resultKind: 'PROVIDER_FAILED', effectiveVenue: null, providerId: 'primary',
    executorPublicKey: exactBuyWalletPublicKey, expectedGenesisHash: exactBuyWalletPublicKey,
    observedGenesisHash: null, configurationFingerprint: fingerprint,
    quoteFingerprint: null, snapshotFingerprint: null, buildFingerprint: null,
    messageHash: null, blockhash: null, lastValidBlockHeight: null,
    blockhashContextSlot: null, snapshotSlot: null, feeContextSlot: null,
    simulationSlot: null, amountInRaw: null, expectedAmountOutRaw: null,
    protectedAmountOutRaw: null, feesRaw: null, estimatedFeeLamports: null,
    simulatedFeePayerLamportDebit: null, unitsConsumed: null,
    simulatedBaseDeltaRaw: null, simulatedQuoteDeltaRaw: null,
    rpcCallsUsed: 1, rpcCallsLimit: 8, quoteStatus: 'FAILED', buildStatus: 'NOT_RUN',
    simulationStatus: 'NOT_RUN', failureStage: 'PROVIDER', failureCode: 'RPC_UNAVAILABLE',
    terminalReasonCode: 'EXECUTION_PROVIDER_FAILED', logsFingerprint: null, logsLineCount: null,
  });
}

export async function withReplica(
  pool: Pool,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role=replica');
    await operation(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Moves an intent's timeline back (test clock): its terminal time ages past the spacing. */
export async function ageIntent(pool: Pool, intentId: string, ageMs: number): Promise<void> {
  await withReplica(pool, async (client) => {
    const updated = await client.query(`UPDATE execution_intents SET
      requested_at=requested_at-($2::BIGINT*INTERVAL '1 millisecond'),
      expires_at=expires_at-($2::BIGINT*INTERVAL '1 millisecond'),
      terminal_at=terminal_at-($2::BIGINT*INTERVAL '1 millisecond'),
      reconciliation_completed_at=reconciliation_completed_at
        -($2::BIGINT*INTERVAL '1 millisecond'),
      purge_after=purge_after-($2::BIGINT*INTERVAL '1 millisecond')
      WHERE id=$1`, [intentId, ageMs]);
    assert.equal(updated.rowCount, 1);
  });
}


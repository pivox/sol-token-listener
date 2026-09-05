import {
  createExecutionReadinessManifest,
  createExecutionWalletGeneration,
} from '../../src/domain/execution-readiness.js';
import { createExecutionIntentDraft } from '../../src/domain/execution-intent.js';
import type {
  ExecutionPreflightDraftSourceV1,
  ExecutionPreflightGateCatalogV1,
} from '../../src/domain/execution-preflight-draft.js';
import { canaryEvidenceInput, NOW_MS, WSOL_MINT } from './execution-canary-fixture.js';

const STATIC_INDEXES = [0, 1, 2, 3, 4, 5, 6, 8] as const;

export function preflightDraftInputs(): Readonly<{
  source: ExecutionPreflightDraftSourceV1;
  catalog: ExecutionPreflightGateCatalogV1;
}> {
  const generation = createExecutionWalletGeneration(Object.freeze({
    walletPublicKey: '11111111111111111111111111111111',
    cluster: 'mainnet-beta', genesisHash: '11111111111111111111111111111111', generation: 1,
  }));
  const base = canaryEvidenceInput(Object.freeze({
    walletSnapshot: Object.freeze({ generationId: generation.generationId }),
    qualification: Object.freeze({ generationId: generation.generationId }),
  }));
  if (typeof base.targetIntentId !== 'string') throw new TypeError();
  const q = base.qualification;
  const wallet = base.walletSnapshot;
  const provider = base.providerSnapshot;
  const readiness = createExecutionReadinessManifest(Object.freeze({
    generationId: q.generationId, walletPublicKey: q.walletPublicKey, cluster: q.cluster,
    providerId: q.providerId, walletSnapshotId: wallet.snapshotId,
    walletSnapshotFingerprint: wallet.snapshotFingerprint,
    providerSnapshotId: provider.snapshotId,
    providerSnapshotFingerprint: provider.snapshotFingerprint,
    walletLamports: wallet.walletLamports, tokenBalanceCount: wallet.tokenBalanceCount,
    observedAtMs: wallet.observedAtMs, expiresAtMs: provider.expiresAtMs,
  }));
  const intentDraft = createExecutionIntentDraft(Object.freeze({
    strategyId: 'creation-entry-v1', strategyVersion: 1,
    positionId: 'paper-position-1', logicalCommandId: 'first-canary-entry',
    mint: '11111111111111111111111111111111', side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: WSOL_MINT, quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 10_000n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: 'qualification-event-1', decisionFingerprint: 'd'.repeat(64),
    requestedAtMs: NOW_MS - 2_000, expiresAtMs: NOW_MS + 300_000,
  }));
  const intent = Object.freeze({ ...intentDraft, status: 'PENDING' as const,
    attemptCount: 0, stateRevision: 0n, lastReasonCode: null, terminalAtMs: null,
    reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: NOW_MS - 2_000, updatedAtMs: NOW_MS - 2_000 });
  return Object.freeze({
    source: Object.freeze({
      schemaVersion: 'execution-preflight-draft-source.v1', readiness,
      generation: Object.freeze({ generationId: generation.generationId,
        walletPublicKey: generation.walletPublicKey, cluster: 'mainnet-beta',
        genesisHash: generation.genesisHash, generation: 1 }),
      walletSnapshot: wallet, providerSnapshot: provider,
      target: Object.freeze({ intent, leaseOwner: null, leaseToken: null, leaseExpiresAtMs: null }),
      simulation: Object.freeze({
        artifactId: `execution_simulation_artifact_${'f'.repeat(64)}`,
        resultFingerprint: 'e'.repeat(64), resultKind: 'SUCCESS', intentId: base.targetIntentId,
        intentStateRevision: 2n, strategyId: 'mainnet-preflight-v1', strategyVersion: 1,
        decisionFingerprint: 'e'.repeat(64), providerId: q.providerId,
        executorPublicKey: q.walletPublicKey, expectedGenesisHash: q.genesisHash,
        observedGenesisHash: q.genesisHash, buildFingerprint: q.buildHash,
        configurationFingerprint: q.configurationFingerprint, recordedAtMs: NOW_MS - 1_000,
      }),
      databaseNowMs: NOW_MS,
    }),
    catalog: Object.freeze({
      schemaVersion: 'execution-preflight-gate-catalog.v1',
      strategyFingerprint: q.strategyFingerprint,
      policy: Object.freeze(Object.fromEntries(Object.entries(base.policy).filter(
        ([key]) => key !== 'payloadVersion' && key !== 'policyFingerprint',
      ))),
      gates: Object.freeze(STATIC_INDEXES.map((index) => {
        const gate = q.gates[index];
        if (gate === undefined) throw new TypeError();
        return gate;
      })),
    }),
  });
}

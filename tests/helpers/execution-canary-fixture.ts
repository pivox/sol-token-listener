import { createExecutionRiskPolicy } from '../../src/domain/execution-risk-policy.js';
import { createProviderUsageSnapshot } from '../../src/domain/execution-provider-quota.js';
import { createSafetyQualification, EXECUTION_SAFETY_GATE_IDS } from '../../src/domain/execution-safety-qualification.js';
import { createExecutionWalletSnapshot } from '../../src/domain/execution-wallet-snapshot.js';

export const NOW_MS = 1_788_134_400_000;
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export function canaryEvidenceInput(overrides: Readonly<Record<string, unknown>> = {}) {
  const walletSnapshot = createExecutionWalletSnapshot({
    generationId: `execution_wallet_generation_${'d'.repeat(64)}`, providerId: 'primary',
    stateRevision: 0n, slot: 123n, blockTimeMs: NOW_MS - 1_000, observedAtMs: NOW_MS,
    commitment: 'finalized', walletLamports: 1_000_000n, tokenBalanceCount: 0,
    openPositions: [], realizedNetPnlRaw: 0n, ...(overrides.walletSnapshot as Record<string, unknown> ?? {}),
  });
  const providerSnapshot = createProviderUsageSnapshot({
    providerId: 'primary', planId: 'canary-v1', billingPeriodId: 'period-1',
    billingPeriodStartedAtMs: NOW_MS - 60_000, billingPeriodEndsAtMs: NOW_MS + 600_000,
    limitUnits: 1_000n, usedUnits: 1n, measuredAtMs: NOW_MS, expiresAtMs: NOW_MS + 300_000,
    provenance: 'OPERATOR_REPORT', ...(overrides.providerSnapshot as Record<string, unknown> ?? {}),
  });
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST', 'SIMULATION_ARTIFACT',
    'FAULT_TEST', 'RECONCILIATION_STATE', 'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST',
    'WALLET_SNAPSHOT', 'MAINNET_SIMULATION_ARTIFACT',
  ] as const;
  const qualification = createSafetyQualification({
    payloadVersion: 1, evaluatorVersion: 1, phase: 'CANARY', buildHash: 'a'.repeat(64),
    configurationFingerprint: 'b'.repeat(64), strategyFingerprint: 'c'.repeat(64),
    generationId: walletSnapshot.generationId, walletPublicKey: '11111111111111111111111111111111',
    cluster: 'mainnet-beta', genesisHash: '11111111111111111111111111111111', providerId: 'primary',
    qualifiedAtMs: NOW_MS, expiresAtMs: NOW_MS + 300_000, ...(overrides.qualification as Record<string, unknown> ?? {}),
    gates: EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => ({
      payloadVersion: 1, gateId, status: 'PASSED', evidenceType: evidenceTypes[index],
      evidenceId: gateId === 'PROVIDER_EXIT_CAPACITY_VERIFIED' ? providerSnapshot.snapshotId
        : gateId === 'WALLET_CHAIN_LIMITS_VERIFIED' ? walletSnapshot.snapshotId : `evidence:${index}`,
      evidenceFingerprint: gateId === 'PROVIDER_EXIT_CAPACITY_VERIFIED' ? providerSnapshot.snapshotFingerprint
        : gateId === 'WALLET_CHAIN_LIMITS_VERIFIED' ? walletSnapshot.snapshotFingerprint : index.toString(16).repeat(64),
      observedAtMs: NOW_MS - 1_000 + index, expiresAtMs: NOW_MS + 300_000,
    })),
  });
  return {
    payloadVersion: 1 as const, qualification, targetIntentId: overrides.targetIntentId ?? `execution_intent_${'e'.repeat(64)}`,
    policy: createExecutionRiskPolicy({
      quoteMintAllowlist: [WSOL_MINT], initialCapitalLamports: 1_000_000n,
      maximumCapitalLamports: 1_000_000n, positionSizeBps: 1_000n, maximumOpenPositions: 1,
      maximumTotalExposureBps: 500n, drawdownPauseBps: 2_500n, feeReserveLamports: 100_000n,
      walletSnapshotMaxAgeMs: 60_000, providerUsageMaxAgeMs: 300_000, providerEntryCostUnits: 8n,
      providerExitCostUnitsPerPosition: 4n, providerConfirmationCostUnitsPerPosition: 2n,
      providerReconciliationCostUnitsPerPosition: 3n, providerSafetyMarginUnits: 5n,
      maximumConsecutiveTechnicalFailures: 2, ...(overrides.policy as Record<string, unknown> ?? {}),
    }), walletSnapshot, providerSnapshot, allEndpointsUnavailable: false,
    capturedAtMs: overrides.capturedAtMs ?? NOW_MS, expiresAtMs: overrides.expiresAtMs ?? NOW_MS + 300_000,
  };
}

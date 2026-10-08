import {
  createEnvelopeArmAuthorization,
  createEnvelopeProviderSnapshot,
  ENVELOPE_ARMAMENT_MAXIMUM_TTL_MS,
  evaluateEnvelopeArming,
  type EnvelopeIdleReason,
} from '../domain/execution-entry-envelope.js';
import {
  createExecutionArmamentRequestV2,
  type ExecutionArmamentRequestV2,
  type ExecutionOperatorAuthorizationV2,
} from '../domain/execution-operations.js';
import type { ExecutionSafetyQualificationV2 } from '../domain/execution-safety-qualification.js';
import type { ProviderUsageSnapshotV1 } from '../domain/execution-provider-quota.js';
import { createExecutionWalletSnapshot } from '../domain/execution-wallet-snapshot.js';
import type {
  ExecutionAutoArmContextV1,
  ExecutionEntryEnvelopeRepository,
  ExecutionEnvelopeArmamentRepository,
} from '../ports/execution-operations-repository.js';
import {
  ExecutionOperationsRepositoryError,
  type ExecutionOperationsRepositoryErrorCode,
} from '../storage/execution-operations.repository.js';
import type { ReadinessWalletObservationV1 } from '../executor-readiness/rpc-gateway.js';
import type { ExecutionAutoArmConfig } from './config.js';

export const AUTO_ARM_SERVICE = 'sol-token-executor-auto-arm';
export const AUTO_ARM_TICK_EVENT = 'executor.auto_arm_tick';
/** `observeWallet` refuses a larger slot lag; a smaller one is only stricter. */
const OBSERVATION_MAXIMUM_SLOT_LAG = 8;

/**
 * A18: only an intent-specific or admission refusal (CONFLICT) or bad data excludes the intent
 * until it expires. Every other refusal (ARMAMENT_CONTENDED, PROVIDER_CARRY_FORWARD_STALE,
 * ENVELOPE_NOT_ARMABLE, CONTROL_STOPPED, DATABASE_FAILURE, PREFLIGHT_EXPIRED, unexpected
 * failures) is transient: the intent is retried next tick.
 */
const EXCLUDING_ARM_CODES: ReadonlySet<ExecutionOperationsRepositoryErrorCode> = new Set([
  'CONFLICT', 'INVALID_DATA',
]);

export type AutoArmRepository = Pick<ExecutionEntryEnvelopeRepository, 'expireEnvelopes'>
  & ExecutionEnvelopeArmamentRepository;

export interface AutoArmWalletGateway {
  observeWallet(
    walletPublicKey: string,
    maximumSlotLag: number,
    signal: AbortSignal,
    now: () => number,
  ): Promise<ReadinessWalletObservationV1>;
}

export type AutoArmConfig = Pick<ExecutionAutoArmConfig,
  | 'generationId' | 'walletPublicKey' | 'providerId' | 'minimumRemainingMs'
  | 'runtimeQuoteMaxAgeMs' | 'runtimeSlippageBps' | 'runtimeSnapshotMaxSlotLag'
  | 'runtimeMaxComputeUnits' | 'runtimeMaxFeeLamports' | 'runtimeMaxFeePayerLamportDebit'
  | 'runtimeMaxRpcCallsPerAttempt' | 'runtimeLeaseMs'>
  & Partial<Pick<ExecutionAutoArmConfig,
    'genesisHash' | 'buildHash' | 'configurationFingerprint' | 'strategyFingerprint'>>;

/** Daemon memory: refused intents (id -> expiresAtMs) only. */
export interface AutoArmState {
  readonly excluded: Map<string, number>;
}

export interface AutoArmDependencies {
  readonly config: AutoArmConfig;
  readonly repository: AutoArmRepository;
  readonly rpc: AutoArmWalletGateway;
  readonly state: AutoArmState;
}

export type AutoArmTickResult =
  | Readonly<{ kind: 'IDLE'; reason: EnvelopeIdleReason | 'INSUFFICIENT_WALLET' }>
  | Readonly<{ kind: 'REFRESHED'; reason: 'PROVIDER_CARRIED_FORWARD' | 'NOT_DUE' }>
  | Readonly<{ kind: 'DEFERRED'; reason: string; intentId?: string }>
  | Readonly<{ kind: 'ARMED'; reason: 'ARMED'; intentId: string; armamentId: string }>
  | Readonly<{ kind: 'REJECTED'; reason: string; intentId: string }>
  | Readonly<{ kind: 'ERROR'; reason: string }>;

export function createAutoArmState(): AutoArmState {
  return { excluded: new Map() };
}

/**
 * One tick: expire the envelope and an unclaimed armament past their deadlines, read one
 * context, carry the provider snapshot forward when the envelope position needs it, otherwise
 * arm the oldest eligible fast-entry intent (K=1).
 * Nothing here signs or sends: H2b executes the armed intent.
 */
export async function runAutoArmTick(
  dependencies: AutoArmDependencies,
  signal: AbortSignal,
): Promise<AutoArmTickResult> {
  const { config, repository, rpc, state } = dependencies;
  let context: ExecutionAutoArmContextV1;
  try {
    const expiry = await repository.expireEnvelopes(config.generationId);
    pruneExcluded(state.excluded, expiry.databaseNowMs);
    context = await repository.readAutoArmContext(Object.freeze({
      generationId: config.generationId,
      minimumRemainingMs: config.minimumRemainingMs,
      excludedIntentIds: Object.freeze([...state.excluded.keys()]),
    }));
  } catch (error) {
    return Object.freeze({ kind: 'ERROR', reason: errorCode(error) });
  }
  if (context.providerRefreshDue) {
    return refreshProvider(dependencies, context.refreshProviderUsageMaxAgeMs);
  }

  if (context.envelope !== null && context.qualification !== null
    && !configMatchesQualification(config, context.qualification)) {
    return Object.freeze({ kind: 'DEFERRED', reason: 'CONFIG_BINDING_MISMATCH' });
  }

  let decision: ReturnType<typeof evaluateEnvelopeArming>;
  try {
    // A23: the exact 10-key facts object.
    decision = evaluateEnvelopeArming(Object.freeze({
      envelope: context.envelope,
      buysArmed: context.buysArmed,
      realizedLossRaw: context.realizedLossRaw,
      controlState: context.controlState,
      unknownBlock: context.unknownBlock,
      activeArmament: context.activeArmament !== null,
      openPosition: context.openPositions > 0,
      intentAvailable: context.candidateIntent !== null,
      runtimeLeaseMs: config.runtimeLeaseMs,
      nowMs: context.databaseNowMs,
    }));
  } catch {
    return Object.freeze({ kind: 'ERROR', reason: 'INVALID_CONTEXT' });
  }
  if (decision.kind === 'IDLE') return Object.freeze({ kind: 'IDLE', reason: decision.reason });
  const { envelope, qualification, candidateIntent: intent, provider } = context;
  if (envelope === null || qualification === null || intent === null) {
    return Object.freeze({ kind: 'ERROR', reason: 'INVALID_CONTEXT' });
  }
  if (provider === null) {
    return Object.freeze({ kind: 'DEFERRED', reason: 'PROVIDER_SNAPSHOT_UNAVAILABLE' });
  }
  const nowMs = context.databaseNowMs;
  const policy = envelope.policy;

  let observation: ReadinessWalletObservationV1;
  try {
    observation = await rpc.observeWallet(config.walletPublicKey,
      Math.min(config.runtimeSnapshotMaxSlotLag, OBSERVATION_MAXIMUM_SLOT_LAG), signal, () => nowMs);
  } catch {
    return Object.freeze({ kind: 'DEFERRED', reason: 'WALLET_RPC_FAILED' });
  }
  if (observation.walletLamports < envelope.perBuyQuoteAmountRaw + policy.feeReserveLamports) {
    return Object.freeze({ kind: 'IDLE', reason: 'INSUFFICIENT_WALLET' });
  }

  let providerSnapshot: ProviderUsageSnapshotV1;
  try {
    providerSnapshot = createEnvelopeProviderSnapshot(Object.freeze({
      latest: provider.snapshot, localUsedUnits: provider.localUsedUnits,
      measuredAtMs: nowMs, maximumAgeMs: policy.providerUsageMaxAgeMs,
    }));
  } catch {
    return Object.freeze({ kind: 'DEFERRED', reason: 'PROVIDER_CARRY_FORWARD_REJECTED' });
  }

  let request: ExecutionArmamentRequestV2;
  let authorization: ExecutionOperatorAuthorizationV2;
  try {
    const walletSnapshot = createExecutionWalletSnapshot(Object.freeze({
      generationId: config.generationId, providerId: config.providerId,
      stateRevision: context.riskStateRevision, slot: observation.slot,
      blockTimeMs: observation.blockTimeMs, observedAtMs: nowMs, commitment: 'finalized',
      walletLamports: observation.walletLamports, tokenBalanceCount: observation.tokenBalanceCount,
      openPositions: Object.freeze([]), realizedNetPnlRaw: -context.realizedLossRaw,
    }));
    const evidenceExpiresAtMs = Math.min(qualification.expiresAtMs, providerSnapshot.expiresAtMs,
      nowMs + policy.providerUsageMaxAgeMs, nowMs + policy.walletSnapshotMaxAgeMs);
    request = createExecutionArmamentRequestV2(Object.freeze({
      payloadVersion: 2, qualification, targetIntentId: intent.intentId, policy,
      walletSnapshot, providerSnapshot, allEndpointsUnavailable: false,
      capturedAtMs: nowMs, expiresAtMs: evidenceExpiresAtMs,
      target: Object.freeze({
        intentId: intent.intentId, stateRevision: intent.stateRevision,
        strategyId: intent.strategyId, strategyVersion: intent.strategyVersion,
        decisionFingerprint: intent.decisionFingerprint, mint: intent.mint,
        quoteMint: intent.quoteMint, quoteAmountRaw: intent.quoteAmountRaw,
      }),
      maximumBuys: 1, maximumCapitalLamports: envelope.perBuyQuoteAmountRaw,
      maximumExposureBps: 500n, maximumOpenPositions: 1,
      maximumHoldingMs: envelope.maximumHoldingMs,
      runtimeQuoteMaxAgeMs: config.runtimeQuoteMaxAgeMs,
      runtimeSlippageBps: config.runtimeSlippageBps,
      runtimeSnapshotMaxSlotLag: config.runtimeSnapshotMaxSlotLag,
      runtimeMaxComputeUnits: config.runtimeMaxComputeUnits,
      runtimeMaxFeeLamports: config.runtimeMaxFeeLamports,
      runtimeMaxFeePayerLamportDebit: config.runtimeMaxFeePayerLamportDebit,
      runtimeMaxRpcCallsPerAttempt: config.runtimeMaxRpcCallsPerAttempt,
      runtimeLeaseMs: config.runtimeLeaseMs,
      armedAtMs: nowMs,
      armamentExpiresAtMs: Math.min(evidenceExpiresAtMs, intent.expiresAtMs,
        nowMs + ENVELOPE_ARMAMENT_MAXIMUM_TTL_MS),
      operatorId: envelope.operatorId,
      operatorReason: `envelope:${envelope.envelopeId}`,
    }));
    authorization = createEnvelopeArmAuthorization(Object.freeze({
      generationId: config.generationId, operatorId: envelope.operatorId,
      envelopeId: envelope.envelopeId, intentId: intent.intentId,
      contextFingerprint: request.armamentRequestFingerprint, nowMs,
    }));
  } catch {
    return Object.freeze({ kind: 'DEFERRED', reason: 'ARMAMENT_REQUEST_INVALID', intentId: intent.intentId });
  }

  try {
    const armament = await repository.armEnvelope(Object.freeze({
      request, authorization, envelopeId: envelope.envelopeId,
    }));
    return Object.freeze({
      kind: 'ARMED', reason: 'ARMED', intentId: intent.intentId, armamentId: armament.armamentId,
    });
  } catch (error) {
    const code = errorCode(error);
    if (error instanceof ExecutionOperationsRepositoryError && EXCLUDING_ARM_CODES.has(error.code)) {
      state.excluded.set(intent.intentId, intent.expiresAtMs);
      return Object.freeze({ kind: 'REJECTED', reason: code, intentId: intent.intentId });
    }
    return Object.freeze({ kind: 'DEFERRED', reason: code, intentId: intent.intentId });
  }
}

/** One JSON line per tick. Never the RPC URL, a key or the wallet balance. */
/** Fields absent from the config (undefined) are not compared. */
function configMatchesQualification(
  config: AutoArmConfig,
  qualification: ExecutionSafetyQualificationV2,
): boolean {
  const pairs: readonly (readonly [string | undefined, string])[] = [
    [config.walletPublicKey, qualification.walletPublicKey],
    [config.providerId, qualification.providerId],
    [config.genesisHash, qualification.genesisHash],
    [config.buildHash, qualification.buildHash],
    [config.configurationFingerprint, qualification.configurationFingerprint],
    [config.strategyFingerprint, qualification.strategyFingerprint],
  ];
  return pairs.every(([configured, qualified]) => configured === undefined || configured === qualified);
}

export function formatAutoArmTickLog(result: AutoArmTickResult): string {
  return JSON.stringify({
    service: AUTO_ARM_SERVICE,
    event: AUTO_ARM_TICK_EVENT,
    result: result.kind,
    reason: result.reason,
    ...('intentId' in result ? { intentId: result.intentId } : {}),
    ...('armamentId' in result ? { armamentId: result.armamentId } : {}),
  });
}

/** The max age and the A12 threshold come from the DB refresh policy, never from memory. */
async function refreshProvider(
  dependencies: AutoArmDependencies,
  maximumAgeMs: number | null,
): Promise<AutoArmTickResult> {
  if (maximumAgeMs === null) {
    return Object.freeze({ kind: 'DEFERRED', reason: 'PROVIDER_REFRESH_POLICY_UNKNOWN' });
  }
  try {
    const refresh = await dependencies.repository.refreshEnvelopeProviderSnapshot(Object.freeze({
      generationId: dependencies.config.generationId,
      maximumAgeMs,
      providerRefreshThresholdMs: Math.floor(maximumAgeMs / 2),
    }));
    return Object.freeze({
      kind: 'REFRESHED', reason: refresh.refreshed ? 'PROVIDER_CARRIED_FORWARD' : 'NOT_DUE',
    });
  } catch (error) {
    return Object.freeze({ kind: 'DEFERRED', reason: errorCode(error) });
  }
}

function pruneExcluded(excluded: Map<string, number>, nowMs: number): void {
  for (const [intentId, expiresAtMs] of excluded) {
    if (expiresAtMs <= nowMs) excluded.delete(intentId);
  }
}

function errorCode(error: unknown): string {
  return error instanceof ExecutionOperationsRepositoryError ? error.code : 'UNEXPECTED_FAILURE';
}

import { createSignedTransactionArtifact } from '../domain/execution-live.js';
import type { ExecutionSimulationRepository } from
  '../ports/execution-simulation-repository.js';
import type {
  ExecutionLivePreparationBindingV1,
  ExecutionLiveRepository,
  ExecutionLiveRuntimeBindingV1,
  ExecutionExactSigningAuthorizationV1,
  ExecutionUnsignedSigningMaterialV1,
} from '../ports/execution-live-repository.js';
import type { ClaimedExecutionIntent } from '../ports/execution-intent-repository.js';
import type {
  ExecutionLiveAttemptRenewBoundary,
  LiveExecutionAttemptEvaluator,
} from '../executor-simulation/attempt-evaluator.js';
import type {
  LiveExecutionWorkerInputV1,
  LiveExecutionWorkerResultV1,
} from './execution-worker.js';
import {
  LiveTransactionCandidateAuthority,
  type LivePreparedTransactionMaterialV1,
} from './transaction-preparer.js';
import type { LiveFreshExecutionContextV1 } from './lanes.js';

type FreshLiveRepository = Pick<ExecutionLiveRepository, 'readPreparationBinding'> & Readonly<{
  readonly authorizeExactSigning?: (input: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly attempt: LiveFreshExecutionContextV1['attempt'];
    readonly generationId: string;
    readonly runtime: ExecutionLiveRuntimeBindingV1;
    readonly material: ExecutionUnsignedSigningMaterialV1;
  }>) => Promise<ExecutionExactSigningAuthorizationV1>;
}>;

export interface FreshLiveExecutionDependencies {
  readonly generationId: string;
  readonly runtime: ExecutionLiveRuntimeBindingV1;
  readonly live: FreshLiveRepository;
  readonly failures: Pick<ExecutionSimulationRepository, 'complete'>;
  readonly evaluator: LiveExecutionAttemptEvaluator;
  readonly candidateAuthority: LiveTransactionCandidateAuthority;
  readonly executePrepared: (
    input: LiveExecutionWorkerInputV1,
    signal: AbortSignal,
  ) => Promise<LiveExecutionWorkerResultV1>;
  readonly clock?: () => number;
}

export type FreshLiveExecutionResultV1 = LiveExecutionWorkerResultV1 | Readonly<{
  readonly payloadVersion: 1;
  readonly kind: 'FAILED';
  readonly intentId: string;
  readonly reasonCode: string;
  readonly claim: null;
}>;

export interface FreshLiveExecution {
  readonly execute: (
    context: LiveFreshExecutionContextV1,
    signal: AbortSignal,
    renew: () => Promise<ClaimedExecutionIntent>,
  ) => Promise<FreshLiveExecutionResultV1>;
}

export function createFreshLiveExecution(
  dependencies: FreshLiveExecutionDependencies,
): FreshLiveExecution {
  validateDependencies(dependencies);
  return Object.freeze({
    execute: (
      context: LiveFreshExecutionContextV1,
      signal: AbortSignal,
      renew: () => Promise<ClaimedExecutionIntent>,
    ) => executeFresh(dependencies, context, signal, renew),
  });
}

async function executeFresh(
  dependencies: FreshLiveExecutionDependencies,
  context: LiveFreshExecutionContextV1,
  signal: AbortSignal,
  renew: () => Promise<ClaimedExecutionIntent>,
): Promise<FreshLiveExecutionResultV1> {
  requireActive(signal);
  let activeClaim = context.claim;
  const renewForEvaluation = async (
    boundary: ExecutionLiveAttemptRenewBoundary,
    material?: ExecutionUnsignedSigningMaterialV1,
  ): Promise<ExecutionExactSigningAuthorizationV1 | undefined> => {
    requireActive(signal);
    activeClaim = await renew();
    requireActive(signal);
    if (boundary === 'BEFORE_SIGNING') {
      if (material === undefined) return undefined;
      if (activeClaim.intent.side === 'BUY') {
        if (dependencies.live.authorizeExactSigning === undefined) {
          throw new TypeError('BUY exact signing authorization is unavailable.');
        }
        const authorization = await dependencies.live.authorizeExactSigning(Object.freeze({
          claim: activeClaim, attempt: context.attempt, generationId: dependencies.generationId,
          runtime: dependencies.runtime, material,
        }));
        requireActive(signal);
        return authorization;
      }
      const binding = await dependencies.live.readPreparationBinding({
        claim: activeClaim, generationId: dependencies.generationId, runtime: dependencies.runtime,
      });
      requireActive(signal);
      return Object.freeze({
          payloadVersion: 1,
          binding,
          preSignatureLockId: null,
          material,
      });
    }
    return undefined;
  };
  const result = await dependencies.evaluator.evaluate(
    Object.freeze({ claim: activeClaim, attempt: context.attempt }),
    signal,
    renewForEvaluation,
  );
  if (result.outcome === 'FAILURE') {
    await dependencies.failures.complete(activeClaim, result.artifact, signal);
    return Object.freeze({
      payloadVersion: 1,
      kind: 'FAILED',
      intentId: activeClaim.intent.id,
      reasonCode: result.artifact.terminalReasonCode,
      claim: null,
    });
  }
  const material = dependencies.candidateAuthority.consume(result.candidate);
  if (material === null) throw new TypeError('Invalid live transaction candidate.');
  const binding = material.binding;
  validateSuccess(activeClaim, context, result.artifact, material, binding, dependencies);
  const signedAtMs = now(dependencies.clock);
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1,
    specificationVersion: 1,
    intentId: activeClaim.intent.id,
    attemptNumber: context.attempt.attemptNumber,
    generationId: binding.generationId,
    armamentId: binding.armamentId,
    reservationId: binding.reservationId,
    exitAuthorizationId: binding.exitAuthorizationId,
    providerId: binding.providerId,
    walletPublicKey: binding.walletPublicKey,
    side: material.side,
    effectiveVenue: material.effectiveVenue,
    messageHash: material.messageHash,
    buildFingerprint: material.buildFingerprint,
    snapshotFingerprint: material.snapshotFingerprint,
    quoteFingerprint: material.quoteFingerprint,
    quoteObservedAtMs: material.quoteObservedAtMs,
    quoteExpiresAtMs: material.quoteExpiresAtMs,
    blockhash: material.blockhash,
    lastValidBlockHeight: material.lastValidBlockHeight,
    signature: material.signature,
    signedTransactionBytes: Uint8Array.from(material.signedTransactionBytes),
    signedAtMs,
  });
  if (artifact.signedTransactionHash !== material.signedTransactionHash) {
    throw new TypeError('Invalid signed transaction material hash.');
  }
  const amountInRaw = result.artifact.amountInRaw;
  const protectedAmountOutRaw = result.artifact.protectedAmountOutRaw;
  if (typeof amountInRaw !== 'bigint' || amountInRaw <= 0n
    || typeof protectedAmountOutRaw !== 'bigint' || protectedAmountOutRaw <= 0n) {
    throw new TypeError('Invalid live simulation amounts.');
  }
  return dependencies.executePrepared(Object.freeze({
    persist: Object.freeze({
      payloadVersion: 1,
      claim: activeClaim,
      preSignatureLockId: material.preSignatureLockId,
      qualificationId: binding.qualificationId,
      reservationId: binding.reservationId,
      artifact,
      unsignedSimulation: material.unsignedSimulation,
      rpcBudget: Object.freeze({
        payloadVersion: 1,
        callsUsed: result.artifact.rpcCallsUsed,
        callsLimit: result.artifact.rpcCallsLimit + 6,
      }),
    }),
    signedSimulation: Object.freeze({
      payloadVersion: 1,
      snapshotSlot: material.snapshotSlot,
      accountAddresses: material.signedSimulationAccountAddresses,
      amountInRaw,
      protectedAmountOutRaw,
      unsignedSimulation: material.unsignedSimulation,
    }),
    runtime: dependencies.runtime,
  }), signal);
}

function validateSuccess(
  claim: ClaimedExecutionIntent,
  context: LiveFreshExecutionContextV1,
  artifact: Awaited<ReturnType<LiveExecutionAttemptEvaluator['evaluate']>>['artifact'],
  material: LivePreparedTransactionMaterialV1,
  binding: ExecutionLivePreparationBindingV1,
  dependencies: FreshLiveExecutionDependencies,
): void {
  if (context.attempt.intentId !== claim.intent.id
    || context.attempt.attemptNumber !== claim.intent.attemptCount
    || artifact.intentId !== claim.intent.id
    || artifact.attemptNumber !== context.attempt.attemptNumber
    || artifact.intentStateRevision !== claim.intent.stateRevision
    || artifact.resultKind !== 'SUCCESS'
    || artifact.providerId !== binding.providerId
    || artifact.executorPublicKey !== binding.walletPublicKey
    || artifact.configurationFingerprint !== dependencies.runtime.configurationFingerprint
    || artifact.effectiveVenue !== material.effectiveVenue
    || artifact.quoteFingerprint !== material.quoteFingerprint
    || artifact.snapshotFingerprint !== material.snapshotFingerprint
    || artifact.buildFingerprint !== material.buildFingerprint
    || artifact.messageHash !== material.messageHash
    || artifact.blockhash !== material.blockhash
    || artifact.lastValidBlockHeight !== material.lastValidBlockHeight
    || material.walletPublicKey !== binding.walletPublicKey
    || material.side !== claim.intent.side
    || binding.side !== claim.intent.side
    || binding.generationId !== dependencies.generationId
    || binding.providerId !== dependencies.runtime.providerId
    || binding.walletPublicKey !== dependencies.runtime.walletPublicKey) {
    throw new TypeError('Invalid live execution identity.');
  }
}

function validateDependencies(value: FreshLiveExecutionDependencies): void {
  if (!/^execution_wallet_generation_[0-9a-f]{64}$/u.test(value.generationId)
    || typeof value.live.readPreparationBinding !== 'function'
    || typeof value.failures.complete !== 'function'
    || typeof value.evaluator.evaluate !== 'function'
    || !(value.candidateAuthority instanceof LiveTransactionCandidateAuthority)
    || typeof value.executePrepared !== 'function'
    || (value.clock !== undefined && typeof value.clock !== 'function')) {
    throw new TypeError('Invalid fresh live execution dependencies.');
  }
}

function requireActive(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw new TypeError('Fresh live execution aborted.');
  }
}

function now(clock: (() => number) | undefined): number {
  const value = (clock ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid live execution time.');
  return value;
}

import {
  ExecutionReconciliationService,
  ExecutionReconciliationServiceError,
} from '../executor-risk/reconciliation-service.js';
import type { LiveConfirmationGateway } from '../ports/execution-confirmation-gateway.js';
import type {
  ClaimedExecutionIntent,
} from '../ports/execution-intent-repository.js';
import type {
  ExecutionLiveRecoveryIntentRepository,
  ExecutionLiveRecoveryRepository,
} from '../ports/execution-live-recovery-repository.js';
import type { ExecutionReconciliationGateway } from
  '../ports/execution-reconciliation-gateway.js';
import type { ExecutionReconciliationCommitResultV1 } from
  '../ports/execution-risk-repository.js';
import type { LiveRecoveryConfig } from './config.js';

export type LiveRecoveryRetryableRpcErrorCode =
  | 'RPC_RATE_LIMITED'
  | 'RPC_TIMEOUT'
  | 'RPC_UNAVAILABLE'
  | 'RPC_RESPONSE_TOO_LARGE'
  | 'RPC_RESPONSE_INVALID'
  | 'CALL_BUDGET_EXCEEDED'
  | 'SESSION_FAILED';

export interface LiveRecoveryDeferredResult {
  readonly result: 'DEFERRED';
  readonly errorCode: LiveRecoveryRetryableRpcErrorCode | null;
}

export type LiveRecoveryLaneResult = 'IDLE' | LiveRecoveryDeferredResult | 'WORKED';

export type LiveRecoveryLaneErrorCode =
  | 'OPERATION_ABORTED'
  | 'CLAIM_FAILED'
  | 'READ_MODEL_FAILED'
  | 'PROVIDER_MISMATCH'
  | 'GATEWAY_FAILED'
  | 'LEASE_LOST'
  | 'INVALID_EVIDENCE'
  | 'COMMIT_FAILED'
  | 'RELEASE_FAILED'
  | 'DEADLINE_FAILED';

export class LiveRecoveryLaneError extends Error {
  public constructor(public readonly code: LiveRecoveryLaneErrorCode) {
    super('Live recovery lane operation failed.');
    this.name = 'LiveRecoveryLaneError';
  }
}

type RecoveryGateway = ExecutionReconciliationGateway & LiveConfirmationGateway & Readonly<{
  providerId: string;
}>;

export interface LiveRecoveryLaneDependencies {
  readonly config: LiveRecoveryConfig;
  readonly intents: ExecutionLiveRecoveryIntentRepository;
  readonly live: ExecutionLiveRecoveryRepository;
  readonly gateway: RecoveryGateway;
}

export interface LiveRecoveryLanes {
  reconciliation(signal: AbortSignal): Promise<LiveRecoveryLaneResult>;
  confirmation(signal: AbortSignal): Promise<LiveRecoveryLaneResult>;
  deadline(signal: AbortSignal): Promise<LiveRecoveryLaneResult>;
}

export function createLiveRecoveryLanes(
  dependencies: LiveRecoveryLaneDependencies,
): LiveRecoveryLanes {
  const lanes: LiveRecoveryLanes = {
    reconciliation: (signal: AbortSignal) => reconciliationLane(dependencies, signal),
    confirmation: (signal: AbortSignal) => confirmationLane(dependencies, signal),
    deadline: (signal: AbortSignal) => deadlineLane(dependencies, signal),
  };
  return Object.freeze(lanes);
}

async function reconciliationLane(
  dependencies: LiveRecoveryLaneDependencies,
  signal: AbortSignal,
): Promise<LiveRecoveryLaneResult> {
  assertActive(signal);
  const claimed = await claim(dependencies, 'RECONCILE', signal);
  if (claimed === null) return 'IDLE';
  let activeClaim: ClaimedExecutionIntent = claimed;
  let stage: 'READ' | 'GATEWAY' | 'RPC' | 'COMMIT' = 'READ';
  try {
    const work = await dependencies.live.readReconciliationWork(activeClaim);
    stage = 'GATEWAY';
    const gateway = providerGateway(dependencies, work.providerId);
    activeClaim = await renew(dependencies, activeClaim, signal);
    stage = 'RPC';
    const service = new ExecutionReconciliationService(gateway, {
      reconcile: async ({ evidence }): Promise<ExecutionReconciliationCommitResultV1> => {
        activeClaim = await renew(dependencies, activeClaim, signal);
        stage = 'COMMIT';
        await dependencies.live.commitReconciliation(activeClaim, evidence);
        return Object.freeze({
          payloadVersion: 1,
          result: evidence.result,
          evidenceId: evidence.evidenceId,
        });
      },
    });
    await service.reconcile(work.request, signal);
    return 'WORKED';
  } catch (error) {
    const deferredCode = error instanceof ExecutionReconciliationServiceError
      && error.code === 'READ_FAILED'
      ? retryableRpcErrorCode(error.sourceCode)
      : null;
    await release(dependencies, activeClaim);
    if (signal.aborted) throw laneFailure('OPERATION_ABORTED');
    if (deferredCode !== null) return deferredResult(deferredCode);
    if (error instanceof LiveRecoveryLaneError) throw error;
    if (error instanceof ExecutionReconciliationServiceError) {
      if (error.code === 'READ_FAILED') throw laneFailure('GATEWAY_FAILED');
      throw laneFailure('INVALID_EVIDENCE');
    }
    if (stage === 'READ') throw laneFailure('READ_MODEL_FAILED');
    if (stage === 'GATEWAY') throw laneFailure('GATEWAY_FAILED');
    throw laneFailure('COMMIT_FAILED');
  }
}

async function confirmationLane(
  dependencies: LiveRecoveryLaneDependencies,
  signal: AbortSignal,
): Promise<LiveRecoveryLaneResult> {
  assertActive(signal);
  const claimed = await claim(dependencies, 'CONFIRM', signal);
  if (claimed === null) return 'IDLE';
  let activeClaim: ClaimedExecutionIntent = claimed;
  let stage: 'READ' | 'GATEWAY' | 'COMMIT' = 'READ';
  try {
    const work = await dependencies.live.readConfirmationWork(activeClaim);
    stage = 'GATEWAY';
    const gateway = providerGateway(dependencies, work.providerId);
    activeClaim = await renew(dependencies, activeClaim, signal);
    let observation;
    try {
      observation = await gateway.observeSignature(work.signature, signal);
    } catch (error) {
      await release(dependencies, activeClaim);
      if (signal.aborted) {
        throw new ClaimReleaseHandledError(laneFailure('OPERATION_ABORTED'));
      }
      const deferredCode = retryableRpcErrorCode(ownStringDataProperty(error, 'code'));
      if (deferredCode !== null) return deferredResult(deferredCode);
      throw new ClaimReleaseHandledError(laneFailure('GATEWAY_FAILED'));
    }
    const confirmationStatus: unknown = observation.confirmationStatus;
    const observedSlot: unknown = observation.observedSlot;
    if (confirmationStatus === 'NOT_FOUND') {
      if (observedSlot !== null) throw laneFailure('GATEWAY_FAILED');
      await release(dependencies, activeClaim);
      return deferredResult(null);
    }
    if ((confirmationStatus !== 'CONFIRMED' && confirmationStatus !== 'FINALIZED')
      || typeof observedSlot !== 'bigint' || observedSlot < 0n) {
      throw laneFailure('GATEWAY_FAILED');
    }
    const confirmedObservedSlot = observedSlot;
    activeClaim = await renew(dependencies, activeClaim, signal);
    stage = 'COMMIT';
    await dependencies.live.recordConfirmation(activeClaim, Object.freeze({
      payloadVersion: 1,
      artifactId: work.artifactId,
      expectedRevision: work.expectedRevision,
      signature: work.signature,
      observedSlot: confirmedObservedSlot,
      observedAtMs: observation.observedAtMs,
    }));
    return 'WORKED';
  } catch (error) {
    if (error instanceof ClaimReleaseHandledError) throw error.cause;
    await release(dependencies, activeClaim);
    if (signal.aborted) throw laneFailure('OPERATION_ABORTED');
    if (error instanceof LiveRecoveryLaneError) throw error;
    if (stage === 'READ') throw laneFailure('READ_MODEL_FAILED');
    if (stage === 'GATEWAY') throw laneFailure('GATEWAY_FAILED');
    throw laneFailure('COMMIT_FAILED');
  }
}

async function deadlineLane(
  dependencies: LiveRecoveryLaneDependencies,
  signal: AbortSignal,
): Promise<LiveRecoveryLaneResult> {
  assertActive(signal);
  try {
    const result = await dependencies.live.createNextDeadlineExitIntent();
    assertActive(signal);
    return result === null || result.kind === 'NOT_DUE' ? 'IDLE' : 'WORKED';
  } catch (error) {
    if (error instanceof LiveRecoveryLaneError) throw error;
    throw laneFailure('DEADLINE_FAILED');
  }
}

async function claim(
  dependencies: LiveRecoveryLaneDependencies,
  purpose: 'CONFIRM' | 'RECONCILE',
  signal: AbortSignal,
): Promise<ClaimedExecutionIntent | null> {
  try {
    const claimForPurpose = purpose === 'CONFIRM'
      ? dependencies.intents.claimConfirmation
      : dependencies.intents.claimReconciliation;
    return await claimForPurpose(
      dependencies.config.ownerId,
      dependencies.config.leaseMs,
      signal,
    );
  } catch {
    if (signal.aborted) throw laneFailure('OPERATION_ABORTED');
    throw laneFailure('CLAIM_FAILED');
  }
}

async function renew(
  dependencies: LiveRecoveryLaneDependencies,
  activeClaim: ClaimedExecutionIntent,
  signal: AbortSignal,
): Promise<ClaimedExecutionIntent> {
  assertActive(signal);
  try {
    return await dependencies.intents.renew(activeClaim, dependencies.config.leaseMs);
  } catch {
    if (signal.aborted) throw laneFailure('OPERATION_ABORTED');
    throw laneFailure('LEASE_LOST');
  }
}

function providerGateway(
  dependencies: LiveRecoveryLaneDependencies,
  durableProviderId: string,
): RecoveryGateway {
  const gateway = dependencies.gateway;
  if (durableProviderId !== dependencies.config.providerId
    || gateway.providerId !== dependencies.config.providerId) {
    throw laneFailure('PROVIDER_MISMATCH');
  }
  return gateway;
}

async function release(
  dependencies: LiveRecoveryLaneDependencies,
  activeClaim: ClaimedExecutionIntent,
): Promise<void> {
  try {
    if (!await dependencies.intents.release(activeClaim)) throw new Error();
  } catch {
    throw laneFailure('RELEASE_FAILED');
  }
}

class ClaimReleaseHandledError extends Error {
  public constructor(public override readonly cause: LiveRecoveryLaneError) {
    super('Live recovery claim release was already handled.', { cause });
    this.name = 'ClaimReleaseHandledError';
  }
}

function assertActive(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw laneFailure('OPERATION_ABORTED');
  }
}

function laneFailure(code: LiveRecoveryLaneErrorCode): LiveRecoveryLaneError {
  return new LiveRecoveryLaneError(code);
}

function deferredResult(errorCode: LiveRecoveryRetryableRpcErrorCode | null): LiveRecoveryDeferredResult {
  return Object.freeze({ result: 'DEFERRED', errorCode });
}

function retryableRpcErrorCode(value: string | null): LiveRecoveryRetryableRpcErrorCode | null {
  switch (value) {
    case 'RPC_RATE_LIMITED':
    case 'RPC_TIMEOUT':
    case 'RPC_UNAVAILABLE':
    case 'RPC_RESPONSE_TOO_LARGE':
    case 'RPC_RESPONSE_INVALID':
    case 'CALL_BUDGET_EXCEEDED':
    case 'SESSION_FAILED':
      return value;
    default:
      return null;
  }
}

function ownStringDataProperty(value: unknown, key: string): string | null {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

import type {
  ClaimedExecutionIntent,
  ExecutionAttemptIdentity,
  ExecutionIntentRepository,
} from '../ports/execution-intent-repository.js';
import type { LiveExecutorLanes, LiveExecutorLaneResult } from './runtime.js';

type LiveLaneIntentRepository = Pick<ExecutionIntentRepository,
  'claim' | 'transition' | 'beginAttempt' | 'renew' | 'release'>;

export interface LiveFreshExecutionContextV1 {
  readonly claim: ClaimedExecutionIntent;
  readonly attempt: ExecutionAttemptIdentity;
}

export interface LiveSignableLaneDependencies {
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly phase: 'CANARY' | 'MICRO_LIVE' | 'PILOT';
  readonly intents: LiveLaneIntentRepository;
  readonly executeFresh: (
    context: LiveFreshExecutionContextV1,
    signal: AbortSignal,
    renew: () => Promise<ClaimedExecutionIntent>,
  ) => Promise<void>;
  readonly recoverPersisted: (
    claim: ClaimedExecutionIntent,
    signal: AbortSignal,
    renew: () => Promise<ClaimedExecutionIntent>,
  ) => Promise<void>;
  readonly clock?: () => number;
}

export function createLiveSignableLanes(
  dependencies: LiveSignableLaneDependencies,
): LiveExecutorLanes {
  validateDependencies(dependencies);
  return Object.freeze({
    recoverSell: (signal: AbortSignal) => recoverOnce(dependencies, 'SELL', signal),
    sell: (signal: AbortSignal) => executeOnce(dependencies, 'SELL', signal),
    recoverBuy: (signal: AbortSignal) => recoverOnce(dependencies, 'BUY', signal),
    buy: (signal: AbortSignal) => executeOnce(dependencies, 'BUY', signal),
  });
}

async function recoverOnce(
  dependencies: LiveSignableLaneDependencies,
  side: 'BUY' | 'SELL',
  signal: AbortSignal,
): Promise<LiveExecutorLaneResult> {
  if (!activeSignal(signal)) return 'IDLE';
  const claimed = await dependencies.intents.claim(Object.freeze({
    ownerId: dependencies.ownerId,
    leaseMs: dependencies.leaseMs,
    purpose: 'LIVE_RECOVER',
    side,
  }), signal);
  if (claimed === null) return 'IDLE';
  let activeClaim = claimed;
  const renew = async (): Promise<ClaimedExecutionIntent> => {
    requireActive(signal);
    activeClaim = await dependencies.intents.renew(activeClaim, dependencies.leaseMs);
    requireActive(signal);
    return activeClaim;
  };
  return withRelease(dependencies.intents, () => activeClaim, async () => {
    requireActive(signal);
    await dependencies.recoverPersisted(activeClaim, signal, renew);
    return 'WORKED';
  });
}

async function executeOnce(
  dependencies: LiveSignableLaneDependencies,
  side: 'BUY' | 'SELL',
  signal: AbortSignal,
): Promise<LiveExecutorLaneResult> {
  if (!activeSignal(signal)) return 'IDLE';
  const claimed = await dependencies.intents.claim(Object.freeze({
    ownerId: dependencies.ownerId,
    leaseMs: dependencies.leaseMs,
    purpose: 'LIVE_EXECUTE',
    side,
  }), signal);
  if (claimed === null) return 'IDLE';
  let activeClaim = claimed;
  const renew = async (): Promise<ClaimedExecutionIntent> => {
    requireActive(signal);
    activeClaim = await dependencies.intents.renew(activeClaim, dependencies.leaseMs);
    requireActive(signal);
    return activeClaim;
  };
  return withRelease(dependencies.intents, () => activeClaim, async () => {
    requireActive(signal);
    if (activeClaim.intent.status === 'PENDING'
      || activeClaim.intent.status === 'RETRY_READY') {
      const previousStatus = activeClaim.intent.status;
      const transitioned = await dependencies.intents.transition(activeClaim, Object.freeze({
        intentId: activeClaim.intent.id,
        expectedStatus: previousStatus,
        nextStatus: 'PROCESSING',
        leaseToken: activeClaim.leaseToken,
        reasonCode: 'EXECUTION_STARTED',
        humanMessage: 'Signable live execution intent claimed for processing.',
        activationPhase: dependencies.phase,
        evidence: Object.freeze({
          payloadVersion: 1,
          attemptNumber: null,
          sourceEventId: null,
          observedAtMs: now(dependencies.clock),
        }),
      }));
      activeClaim = Object.freeze({ ...activeClaim, intent: transitioned });
    }
    if (activeClaim.intent.status !== 'PROCESSING') {
      throw new TypeError('Invalid signable live execution claim.');
    }
    requireActive(signal);
    const begun = await dependencies.intents.beginAttempt(activeClaim);
    activeClaim = begun.claim;
    requireActive(signal);
    await dependencies.executeFresh(Object.freeze({
      claim: activeClaim,
      attempt: begun.attempt,
    }), signal, renew);
    return 'WORKED';
  });
}

async function withRelease(
  repository: Pick<ExecutionIntentRepository, 'release'>,
  claim: () => ClaimedExecutionIntent,
  operation: () => Promise<LiveExecutorLaneResult>,
): Promise<LiveExecutorLaneResult> {
  let failure: unknown;
  try {
    return await operation();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await repository.release(claim());
    } catch (releaseError) {
      if (failure === undefined) throw releaseError;
    }
  }
}

function activeSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal && !value.aborted;
}

function requireActive(signal: AbortSignal): void {
  if (!activeSignal(signal)) throw new TypeError('Signable live execution aborted.');
}

function validateDependencies(value: LiveSignableLaneDependencies): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.ownerId)
    || !Number.isSafeInteger(value.leaseMs) || value.leaseMs < 1
    || !['CANARY', 'MICRO_LIVE', 'PILOT'].includes(value.phase)
    || (value.clock !== undefined && typeof value.clock !== 'function')) {
    throw new TypeError('Invalid signable live lane dependencies.');
  }
}

function now(clock: (() => number) | undefined): number {
  const value = (clock ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Invalid signable live lane time.');
  }
  return value;
}

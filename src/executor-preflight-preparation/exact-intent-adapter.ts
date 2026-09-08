import { isProxy } from 'node:util/types';
import type { ClaimedExecutionPreflightPreparation } from '../domain/execution-preflight-preparation.js';
import type {
  ExecutionClaimOptions,
  ExecutionIntentRepository,
} from '../ports/execution-intent-repository.js';

type ExactClaimRepository = Pick<ExecutionIntentRepository, 'claimExactPreflightIntent'>;
type SimulationIntentRepository = Pick<
  ExecutionIntentRepository,
  'claimExactPreflightIntent' | 'transition' | 'beginAttempt' | 'renew'
>;

export interface ExactPreflightTargetIntentAdapterDependencies {
  readonly intents: ExactClaimRepository;
  readonly preparationClaim: ClaimedExecutionPreflightPreparation;
  readonly pairId: string;
  readonly intentId: string;
  readonly ownerId: string;
  readonly leaseMs: number;
}

export interface ExactPreflightSimulationIntentAdapterDependencies {
  readonly intents: SimulationIntentRepository;
  readonly preparationClaim: ClaimedExecutionPreflightPreparation;
  readonly renewPreparation: (
    claim: ClaimedExecutionPreflightPreparation,
    leaseMs: number,
  ) => Promise<ClaimedExecutionPreflightPreparation>;
  readonly preparationLeaseMs: number;
  readonly pairId: string;
  readonly intentId: string;
  readonly ownerId: string;
  readonly leaseMs: number;
}

export type ExactPreflightTargetIntentAdapter = Pick<ExecutionIntentRepository, 'claim'>;

export type ExactPreflightSimulationIntentAdapter = Pick<
  ExecutionIntentRepository,
  'claim' | 'transition' | 'beginAttempt' | 'renew'
> & Readonly<{
  currentPreparationClaim: () => ClaimedExecutionPreflightPreparation;
}>;

const TARGET_DEPENDENCY_KEYS = Object.freeze([
  'intents', 'preparationClaim', 'pairId', 'intentId', 'ownerId', 'leaseMs',
] as const);
const SIMULATION_DEPENDENCY_KEYS = Object.freeze([
  'intents', 'preparationClaim', 'renewPreparation', 'preparationLeaseMs',
  'pairId', 'intentId', 'ownerId', 'leaseMs',
] as const);
const WORKER_OPTION_KEYS = Object.freeze(['ownerId', 'leaseMs', 'purpose'] as const);
const PREPARATION_CLAIM_KEYS = Object.freeze([
  'preparation', 'leaseOwner', 'leaseToken', 'leaseExpiresAtMs',
] as const);
const PREPARATION_KEYS = Object.freeze([
  'payloadVersion', 'runId', 'runFingerprint', 'state', 'stateRevision',
  'watermarkAtMs', 'deadlineAtMs', 'pairId', 'assessmentId', 'assessmentFingerprint',
  'artifactId', 'artifactFingerprint', 'manifestFingerprint', 'failureCode',
  'createdAtMs', 'updatedAtMs',
  'selectedAtMs', 'completedAtMs', 'purgeAfterMs',
] as const);
const PAIR_ID = /^execution_preflight_intent_pair_[0-9a-f]{64}$/u;
const INTENT_ID = /^execution_intent_[0-9a-f]{64}$/u;
const RUN_ID = /^execution_preflight_preparation_[0-9a-f]{64}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DATE_MAX_MS = 8_640_000_000_000_000;

export function createExactPreflightTargetIntentAdapter(
  dependenciesValue: ExactPreflightTargetIntentAdapterDependencies,
): ExactPreflightTargetIntentAdapter {
  const dependencies = targetDependencies(dependenciesValue);
  return Object.freeze({
    claim: exactClaim(dependencies, 'TARGET', 'DRY_RUN'),
  });
}

export function createExactPreflightSimulationIntentAdapter(
  dependenciesValue: ExactPreflightSimulationIntentAdapterDependencies,
): ExactPreflightSimulationIntentAdapter {
  const dependencies = simulationDependencies(dependenciesValue);
  let preparationClaim = dependencies.preparationClaim;
  const claim = exactClaim(Object.freeze({ ...dependencies,
    preparationClaim: () => preparationClaim,
  }), 'SIMULATION', 'EXECUTE');
  const transition = dependencies.intents.transition.bind(dependencies.intents);
  const beginAttempt = dependencies.intents.beginAttempt.bind(dependencies.intents);
  const renewIntent = dependencies.intents.renew.bind(dependencies.intents);
  return Object.freeze({
    claim,
    transition,
    beginAttempt,
    renew: async (intentClaim, leaseMs) => {
      if (leaseMs !== dependencies.leaseMs) throw invalid();
      const renewedPreparation = preparationClaimInput(await dependencies.renewPreparation(
        preparationClaim,
        dependencies.preparationLeaseMs,
      ));
      assertRenewedPreparation(preparationClaim, renewedPreparation);
      preparationClaim = renewedPreparation;
      return renewIntent(intentClaim, leaseMs);
    },
    currentPreparationClaim: () => preparationClaim,
  });
}

type ExactClaimDependencies = Readonly<{
  intents: ExactClaimRepository;
  preparationClaim:
    | ClaimedExecutionPreflightPreparation
    | (() => ClaimedExecutionPreflightPreparation);
  pairId: string;
  intentId: string;
  ownerId: string;
  leaseMs: number;
}>;

function exactClaim(
  dependencies: ExactClaimDependencies,
  lane: 'TARGET' | 'SIMULATION',
  purpose: 'DRY_RUN' | 'EXECUTE',
): ExecutionIntentRepository['claim'] {
  return async (workerOptionsValue: ExecutionClaimOptions, signal?: AbortSignal) => {
    workerOptions(workerOptionsValue, dependencies.ownerId, dependencies.leaseMs, purpose);
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalid();
    const preparationClaim = preparationClaimInput(
      typeof dependencies.preparationClaim === 'function'
        ? dependencies.preparationClaim()
        : dependencies.preparationClaim,
    );
    return dependencies.intents.claimExactPreflightIntent(Object.freeze({
      runId: preparationClaim.preparation.runId,
      preparationLeaseOwner: preparationClaim.leaseOwner,
      preparationLeaseToken: preparationClaim.leaseToken,
      pairId: dependencies.pairId,
      intentId: dependencies.intentId,
      lane,
      purpose,
      ownerId: dependencies.ownerId,
      leaseMs: dependencies.leaseMs,
    }) as Parameters<ExecutionIntentRepository['claimExactPreflightIntent']>[0], signal);
  };
}

function targetDependencies(
  value: unknown,
): ExactClaimDependencies {
  const row = exactFrozenRecord(value, TARGET_DEPENDENCY_KEYS);
  const intents = exactClaimRepository(row.intents);
  const preparationClaim = preparationClaimInput(row.preparationClaim);
  const pairId = patterned(row.pairId, PAIR_ID);
  if (preparationClaim.preparation.pairId !== pairId) throw invalid();
  return Object.freeze({
    intents,
    preparationClaim,
    pairId,
    intentId: patterned(row.intentId, INTENT_ID),
    ownerId: patterned(row.ownerId, OWNER_ID),
    leaseMs: duration(row.leaseMs),
  });
}

function simulationDependencies(
  value: unknown,
): ExactPreflightSimulationIntentAdapterDependencies {
  const row = exactFrozenRecord(value, SIMULATION_DEPENDENCY_KEYS);
  const intents = simulationRepository(row.intents);
  const preparationClaim = preparationClaimInput(row.preparationClaim);
  const pairId = patterned(row.pairId, PAIR_ID);
  const leaseMs = duration(row.leaseMs);
  const preparationLeaseMs = duration(row.preparationLeaseMs);
  if (preparationClaim.preparation.pairId !== pairId
    || preparationLeaseMs < leaseMs
    || typeof row.renewPreparation !== 'function') throw invalid();
  return Object.freeze({
    intents,
    preparationClaim,
    renewPreparation: row.renewPreparation as ExactPreflightSimulationIntentAdapterDependencies[
      'renewPreparation'
    ],
    preparationLeaseMs,
    pairId,
    intentId: patterned(row.intentId, INTENT_ID),
    ownerId: patterned(row.ownerId, OWNER_ID),
    leaseMs,
  });
}

function exactClaimRepository(value: unknown): ExactClaimRepository {
  if (typeof value !== 'object' || value === null || isProxy(value)
    || typeof Reflect.get(value, 'claimExactPreflightIntent') !== 'function') throw invalid();
  return value as ExactClaimRepository;
}

function simulationRepository(value: unknown): SimulationIntentRepository {
  const repository = exactClaimRepository(value) as Partial<SimulationIntentRepository>;
  if (typeof repository.transition !== 'function'
    || typeof repository.beginAttempt !== 'function'
    || typeof repository.renew !== 'function') throw invalid();
  return repository as SimulationIntentRepository;
}

function preparationClaimInput(value: unknown): ClaimedExecutionPreflightPreparation {
  const claim = exactFrozenRecord(value, PREPARATION_CLAIM_KEYS);
  const preparation = exactFrozenRecord(claim.preparation, PREPARATION_KEYS);
  if (preparation.payloadVersion !== 1
    || patterned(preparation.runId, RUN_ID).length === 0
    || patterned(preparation.runFingerprint, FINGERPRINT).length === 0
    || preparation.state !== 'PREPARING'
    || typeof preparation.stateRevision !== 'bigint'
    || preparation.stateRevision < 0n
    || typeof preparation.pairId !== 'string'
    || !PAIR_ID.test(preparation.pairId)
    || !OWNER_ID.test(patterned(claim.leaseOwner, OWNER_ID))
    || !UUID_V4.test(patterned(claim.leaseToken, UUID_V4))
    || !timestamp(claim.leaseExpiresAtMs)) throw invalid();
  return value as ClaimedExecutionPreflightPreparation;
}

function assertRenewedPreparation(
  previous: ClaimedExecutionPreflightPreparation,
  renewed: ClaimedExecutionPreflightPreparation,
): void {
  if (renewed.preparation.runId !== previous.preparation.runId
    || renewed.preparation.runFingerprint !== previous.preparation.runFingerprint
    || renewed.preparation.pairId !== previous.preparation.pairId
    || renewed.preparation.stateRevision !== previous.preparation.stateRevision + 1n
    || renewed.leaseOwner !== previous.leaseOwner
    || renewed.leaseToken !== previous.leaseToken) throw invalid();
}

function workerOptions(
  value: unknown,
  ownerId: string,
  leaseMs: number,
  purpose: 'DRY_RUN' | 'EXECUTE',
): void {
  const row = exactFrozenRecord(value, WORKER_OPTION_KEYS);
  if (row.ownerId !== ownerId || row.leaseMs !== leaseMs || row.purpose !== purpose) {
    throw invalid();
  }
}

function exactFrozenRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (typeof value !== 'object' || value === null || isProxy(value) || !Object.isFrozen(value)) {
    throw invalid();
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  const ownKeys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable
    || !('value' in descriptor))) throw invalid();
  return value as Readonly<Record<Keys[number], unknown>>;
}

function patterned(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid();
  return value;
}

function duration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 300_000) {
    throw invalid();
  }
  return value as number;
}

function timestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= DATE_MAX_MS;
}

function invalid(): TypeError {
  return new TypeError('Invalid exact preflight intent adapter input.');
}

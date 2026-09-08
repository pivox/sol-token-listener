import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type {
  ClaimedExecutionPreflightPreparation,
  ExecutionPreflightPreparationErrorCode,
  ExecutionPreflightPreparationV1,
} from '../domain/execution-preflight-preparation.js';
import type { DryRunWorker } from '../executor/dry-run-worker.js';
import type {
  SimulationOnlyPassResult,
  SimulationOnlyWorker,
} from '../executor/simulation-worker.js';
import type {
  ExecutionPreflightPairSelectionV1,
  ExecutionPreflightPreparationRepository,
} from '../ports/execution-preflight-preparation-repository.js';
import { canonicalStringifyJson } from '../utils/json.js';
import type { ExecutionPreflightPreparationConfigV1 } from './config.js';
import {
  createExecutionPreflightIntentPreparationManifest,
  type ExecutionPreflightIntentPreparationManifestWriter,
} from './manifest.js';

const PREPARATION_OWNER_ID = 'executor-preflight-preparation';
const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;

type ServiceConfig = Pick<
  ExecutionPreflightPreparationConfigV1,
  'payloadVersion' | 'enabled' | 'selectionWindowMs' | 'preparationLeaseMs' | 'outputPath'
> & Readonly<{ readonly executor: Readonly<{ readonly pollMs: number }> }>;

export interface ExecutionPreflightTargetWorkerFactoryInput {
  readonly preparationClaim: ClaimedExecutionPreflightPreparation;
  readonly pair: ExecutionPreflightPairSelectionV1;
}

export interface ExecutionPreflightSimulationWorker extends SimulationOnlyWorker {
  readonly currentPreparationClaim: () => ClaimedExecutionPreflightPreparation;
}

export interface ExecutionPreflightPreparationServiceDependencies {
  readonly config: ServiceConfig;
  readonly preparations: ExecutionPreflightPreparationRepository;
  readonly createTargetWorker: (
    input: ExecutionPreflightTargetWorkerFactoryInput,
  ) => DryRunWorker;
  readonly createSimulationWorker: (
    input: ExecutionPreflightTargetWorkerFactoryInput,
  ) => ExecutionPreflightSimulationWorker;
  readonly manifestWriter: ExecutionPreflightIntentPreparationManifestWriter;
  readonly delay: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface ExecutionPreflightPreparationService {
  readonly run: (signal: AbortSignal) => Promise<ExecutionPreflightPreparationV1>;
}

export class ExecutionPreflightPreparationServiceError extends Error {
  public readonly code = 'EXECUTION_PREFLIGHT_PREPARATION_FAILED' as const;
  public readonly recoverable = true as const;

  public constructor() {
    super('Execution preflight preparation failed.');
    this.name = 'ExecutionPreflightPreparationServiceError';
  }
}

export function createExecutionPreflightPreparationService(
  dependencies: ExecutionPreflightPreparationServiceDependencies,
): ExecutionPreflightPreparationService {
  validateDependencies(dependencies);
  let execution: Promise<ExecutionPreflightPreparationV1> | null = null;
  const run = (signal: AbortSignal): Promise<ExecutionPreflightPreparationV1> => {
    if (execution !== null) return execution;
    execution = Promise.resolve().then(async () => {
      try {
        requireActiveSignal(signal);
        return await runOnce(dependencies, signal);
      } catch (error: unknown) {
        if (error instanceof ExecutionPreflightPreparationServiceError) throw error;
        throw serviceError();
      }
    });
    return execution;
  };
  return Object.freeze({ run });
}

async function runOnce(
  dependencies: ExecutionPreflightPreparationServiceDependencies,
  signal: AbortSignal,
): Promise<ExecutionPreflightPreparationV1> {
  let preparationClaim = await dependencies.preparations.startOrResume(Object.freeze({
    ownerId: PREPARATION_OWNER_ID,
    selectionWindowMs: dependencies.config.selectionWindowMs,
    leaseMs: dependencies.config.preparationLeaseMs,
  }), signal);
  const selected = await pollFirstPair(dependencies, preparationClaim, signal);
  if ('state' in selected) return selected;
  const pair = selected;
  assertPairForClaim(pair, preparationClaim);
  preparationClaim = await dependencies.preparations.renew(
    pair.preparation,
    dependencies.config.preparationLeaseMs,
    signal,
  );
  assertClaimForPair(preparationClaim, pair);

  if (!hasAssessment(preparationClaim)) {
    const target = dependencies.createTargetWorker(Object.freeze({
      preparationClaim,
      pair,
    }));
    const targetResult = await target.runOnce(signal);
    requireActiveSignal(signal);
    if (targetResult === 'IDLE') {
      return failTerminal(
        dependencies,
        preparationClaim,
        'PREFLIGHT_TARGET_FENCE_LOST',
        signal,
      );
    }
    preparationClaim = await bindOrFail(
      dependencies,
      preparationClaim,
      'ASSESSMENT',
      signal,
    );
  }

  if (!hasArtifact(preparationClaim)) {
    const simulation = dependencies.createSimulationWorker(Object.freeze({
      preparationClaim,
      pair,
    }));
    let simulationResult: SimulationOnlyPassResult;
    try {
      simulationResult = await simulation.runOnce(signal);
    } catch {
      requireActiveSignal(signal);
      throw serviceError();
    }
    requireActiveSignal(signal);
    const simulationClaim = simulation.currentPreparationClaim();
    assertClaimForPair(simulationClaim, pair);
    if (simulationResult === 'IDLE'
      || simulationResult.outcome !== 'SIMULATION_SUCCEEDED'
      || simulationResult.intentId !== pair.simulationIntentId) {
      return failTerminal(
        dependencies,
        simulationClaim,
        'PREFLIGHT_SIMULATION_FAILED',
        signal,
      );
    }
    preparationClaim = await bindOrFail(
      dependencies,
      simulationClaim,
      'SIMULATION',
      signal,
    );
  }

  assertCompleteEvidence(preparationClaim);
  const manifestInput = Object.freeze({
    runId: preparationClaim.preparation.runId,
    runFingerprint: preparationClaim.preparation.runFingerprint,
    pairId: pair.pairId,
    pairFingerprint: pair.pairFingerprint,
    targetIntentId: pair.targetIntentId,
    simulationIntentId: pair.simulationIntentId,
    assessmentId: preparationClaim.preparation.assessmentId,
    assessmentFingerprint: preparationClaim.preparation.assessmentFingerprint,
    artifactId: preparationClaim.preparation.artifactId,
    artifactFingerprint: preparationClaim.preparation.artifactFingerprint,
    createdAtMs: preparationClaim.preparation.createdAtMs,
    preparedAtMs: preparationClaim.preparation.updatedAtMs,
    expiresAtMs: Math.min(
      preparationClaim.preparation.deadlineAtMs,
      pair.pairExpiresAtMs,
    ),
    purgeAfterMs: preparationClaim.preparation.updatedAtMs + FOUR_HOURS_MS,
  });
  const expectedManifest = createExecutionPreflightIntentPreparationManifest(manifestInput);
  const encodedManifest = canonicalStringifyJson(expectedManifest);
  const manifestFingerprint = createHash('sha256').update(encodedManifest, 'utf8').digest('hex');
  try {
    const written = await dependencies.manifestWriter.write(
      dependencies.config.outputPath,
      manifestInput,
    );
    if (canonicalStringifyJson(written) !== encodedManifest) throw serviceError();
  } catch {
    return failTerminal(
      dependencies,
      preparationClaim,
      'PREFLIGHT_PREPARATION_EXPORT_FAILED',
      signal,
    );
  }
  try {
    return await dependencies.preparations.markPrepared(
      preparationClaim,
      Object.freeze({ manifestFingerprint }),
      signal,
    );
  } catch {
    const stored = await dependencies.preparations.read(
      preparationClaim.preparation.runId,
      new AbortController().signal,
    );
    if (stored !== null && preparedMatches(stored, preparationClaim, manifestFingerprint)) {
      return stored;
    }
    throw serviceError();
  }
}

async function pollFirstPair(
  dependencies: ExecutionPreflightPreparationServiceDependencies,
  initialClaim: ClaimedExecutionPreflightPreparation,
  signal: AbortSignal,
): Promise<ExecutionPreflightPairSelectionV1 | ExecutionPreflightPreparationV1> {
  let claim = initialClaim;
  for (;;) {
    requireActiveSignal(signal);
    const pair = await dependencies.preparations.selectFirstPair(claim, signal);
    if (pair !== null) return pair;
    const expired = await dependencies.preparations.expireWaitingWithoutPair(claim, signal);
    if (expired !== null) return expired;
    await dependencies.delay(dependencies.config.executor.pollMs, signal);
    requireActiveSignal(signal);
    const expiredAfterDelay = await dependencies.preparations.expireWaitingWithoutPair(
      claim,
      signal,
    );
    if (expiredAfterDelay !== null) return expiredAfterDelay;
    claim = await dependencies.preparations.renew(
      claim,
      dependencies.config.preparationLeaseMs,
      signal,
    );
  }
}

async function bindOrFail(
  dependencies: ExecutionPreflightPreparationServiceDependencies,
  claim: ClaimedExecutionPreflightPreparation,
  phase: 'ASSESSMENT' | 'SIMULATION',
  signal: AbortSignal,
): Promise<ClaimedExecutionPreflightPreparation> {
  try {
    return phase === 'ASSESSMENT'
      ? await dependencies.preparations.bindTargetAssessment(claim, signal)
      : await dependencies.preparations.bindSimulationArtifact(claim, signal);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (phase === 'ASSESSMENT' && code === 'PREFLIGHT_ASSESSMENT_INVALID') {
      await failTerminal(dependencies, claim, 'PREFLIGHT_ASSESSMENT_INVALID', signal);
    }
    if (phase === 'SIMULATION' && code === 'PREFLIGHT_SIMULATION_FAILED') {
      await failTerminal(dependencies, claim, 'PREFLIGHT_SIMULATION_FAILED', signal);
    }
    throw serviceError();
  }
}

async function failTerminal(
  dependencies: ExecutionPreflightPreparationServiceDependencies,
  claim: ClaimedExecutionPreflightPreparation,
  code: ExecutionPreflightPreparationErrorCode,
  signal: AbortSignal,
): Promise<ExecutionPreflightPreparationV1> {
  requireActiveSignal(signal);
  try {
    return await dependencies.preparations.fail(claim, code, signal);
  } catch {
    throw serviceError();
  }
}

function hasAssessment(claim: ClaimedExecutionPreflightPreparation): boolean {
  return claim.preparation.assessmentId !== null
    && claim.preparation.assessmentFingerprint !== null;
}

function hasArtifact(claim: ClaimedExecutionPreflightPreparation): boolean {
  return claim.preparation.artifactId !== null
    && claim.preparation.artifactFingerprint !== null;
}

function assertCompleteEvidence(
  claim: ClaimedExecutionPreflightPreparation,
): asserts claim is ClaimedExecutionPreflightPreparation & Readonly<{
  preparation: ExecutionPreflightPreparationV1 & Readonly<{
    assessmentId: string;
    assessmentFingerprint: string;
    artifactId: string;
    artifactFingerprint: string;
  }>;
}> {
  if (!hasAssessment(claim) || !hasArtifact(claim)) throw serviceError();
}

function assertPairForClaim(
  pair: ExecutionPreflightPairSelectionV1,
  previous: ClaimedExecutionPreflightPreparation,
): void {
  if (pair.preparation.preparation.runId !== previous.preparation.runId
    || pair.preparation.preparation.pairId !== pair.pairId
    || previous.preparation.pairId !== null
      && previous.preparation.pairId !== pair.pairId) throw serviceError();
}

function assertClaimForPair(
  claim: ClaimedExecutionPreflightPreparation,
  pair: ExecutionPreflightPairSelectionV1,
): void {
  if (claim.preparation.runId !== pair.preparation.preparation.runId
    || claim.preparation.pairId !== pair.pairId
    || claim.preparation.state !== 'PREPARING') throw serviceError();
}

function preparedMatches(
  stored: ExecutionPreflightPreparationV1,
  claim: ClaimedExecutionPreflightPreparation,
  manifestFingerprint: string,
): boolean {
  return stored.state === 'PREPARED'
    && stored.runId === claim.preparation.runId
    && stored.runFingerprint === claim.preparation.runFingerprint
    && stored.pairId === claim.preparation.pairId
    && stored.assessmentId === claim.preparation.assessmentId
    && stored.assessmentFingerprint === claim.preparation.assessmentFingerprint
    && stored.artifactId === claim.preparation.artifactId
    && stored.artifactFingerprint === claim.preparation.artifactFingerprint
    && stored.manifestFingerprint === manifestFingerprint;
}

function requireActiveSignal(signal: unknown): asserts signal is AbortSignal {
  if (!(signal instanceof AbortSignal) || signal.aborted) throw serviceError();
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}

function validateDependencies(value: unknown): void {
  try {
    if (typeof value !== 'object' || value === null || isProxy(value) || !Object.isFrozen(value)) {
      throw serviceError();
    }
    const dependencies = value as Readonly<Record<string, unknown>>;
    const configValue = dependencies.config;
    if (typeof configValue !== 'object' || configValue === null || isProxy(configValue)
      || !Object.isFrozen(configValue)) throw serviceError();
    const config = configValue as Readonly<Record<string, unknown>>;
    const selectionWindowMs = config.selectionWindowMs;
    const preparationLeaseMs = config.preparationLeaseMs;
    const executorValue = config.executor;
    if (config.payloadVersion !== 1 || config.enabled !== true
      || !Number.isSafeInteger(selectionWindowMs) || (selectionWindowMs as number) <= 10_000
      || !Number.isSafeInteger(preparationLeaseMs) || (preparationLeaseMs as number) <= 0
      || (preparationLeaseMs as number) > (selectionWindowMs as number) - 5_000
      || typeof config.outputPath !== 'string' || config.outputPath.length === 0
      || typeof executorValue !== 'object' || executorValue === null
      || isProxy(executorValue) || !Object.isFrozen(executorValue)) throw serviceError();
    const executor = executorValue as Readonly<Record<string, unknown>>;
    const pollMs = executor.pollMs;
    if (!Number.isSafeInteger(pollMs) || (pollMs as number) <= 0
      || (pollMs as number) >= (preparationLeaseMs as number)) throw serviceError();
    const preparations = dependencies.preparations;
    if (typeof preparations !== 'object' || preparations === null || isProxy(preparations)) {
      throw serviceError();
    }
    for (const method of [
      'startOrResume', 'selectFirstPair', 'expireWaitingWithoutPair', 'bindTargetAssessment',
      'bindSimulationArtifact', 'markPrepared', 'renew', 'fail', 'read',
    ] as const) {
      if (typeof Reflect.get(preparations, method) !== 'function') throw serviceError();
    }
    const manifestWriter = dependencies.manifestWriter;
    if (typeof dependencies.createTargetWorker !== 'function'
      || typeof dependencies.createSimulationWorker !== 'function'
      || typeof dependencies.delay !== 'function'
      || typeof manifestWriter !== 'object' || manifestWriter === null
      || isProxy(manifestWriter)
      || typeof Reflect.get(manifestWriter, 'write') !== 'function') throw serviceError();
  } catch {
    throw serviceError();
  }
}

function serviceError(): ExecutionPreflightPreparationServiceError {
  return new ExecutionPreflightPreparationServiceError();
}

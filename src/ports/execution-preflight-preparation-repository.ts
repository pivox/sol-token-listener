import type {
  ClaimedExecutionPreflightPreparation,
  ExecutionPreflightPreparationErrorCode,
  ExecutionPreflightPreparationV1,
} from '../domain/execution-preflight-preparation.js';

export interface ExecutionPreflightPreparationStartOptions {
  readonly ownerId: string;
  readonly selectionWindowMs: number;
  readonly leaseMs: number;
}

export interface ExecutionPreflightPairSelectionV1 {
  readonly preparation: ClaimedExecutionPreflightPreparation;
  readonly pairId: string;
  readonly pairFingerprint: string;
  readonly targetIntentId: string;
  readonly simulationIntentId: string;
  readonly decisionEventId: string;
  readonly decisionFingerprint: string;
  readonly pairCreatedAtMs: number;
  readonly pairExpiresAtMs: number;
}

export interface ExecutionPreflightMarkPreparedOptions {
  readonly manifestFingerprint: string;
}

export interface ExecutionPreflightPreparationRepository {
  startOrResume(
    options: ExecutionPreflightPreparationStartOptions,
    signal?: AbortSignal,
  ): Promise<ClaimedExecutionPreflightPreparation>;
  selectFirstPair(
    claim: ClaimedExecutionPreflightPreparation,
    signal?: AbortSignal,
  ): Promise<ExecutionPreflightPairSelectionV1 | null>;
  expireWaitingWithoutPair(
    claim: ClaimedExecutionPreflightPreparation,
    signal?: AbortSignal,
  ): Promise<ExecutionPreflightPreparationV1 | null>;
  bindTargetAssessment(
    claim: ClaimedExecutionPreflightPreparation,
    signal?: AbortSignal,
  ): Promise<ClaimedExecutionPreflightPreparation>;
  bindSimulationArtifact(
    claim: ClaimedExecutionPreflightPreparation,
    signal?: AbortSignal,
  ): Promise<ClaimedExecutionPreflightPreparation>;
  markPrepared(
    claim: ClaimedExecutionPreflightPreparation,
    options: ExecutionPreflightMarkPreparedOptions,
    signal?: AbortSignal,
  ): Promise<ExecutionPreflightPreparationV1>;
  renew(
    claim: ClaimedExecutionPreflightPreparation,
    leaseMs: number,
    signal?: AbortSignal,
  ): Promise<ClaimedExecutionPreflightPreparation>;
  fail(
    claim: ClaimedExecutionPreflightPreparation,
    code: ExecutionPreflightPreparationErrorCode,
    signal?: AbortSignal,
  ): Promise<ExecutionPreflightPreparationV1>;
  read(runId: string, signal?: AbortSignal): Promise<ExecutionPreflightPreparationV1 | null>;
}

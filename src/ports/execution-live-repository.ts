import type {
  ExecutionExitAuthorizationV1,
  ExecutionLivePositionV1,
  SignedTransactionArtifactV1,
  SignedTransactionState,
} from '../domain/execution-live.js';
import type { ExecutionIntentV1 } from '../domain/execution-intent.js';
import type { ExecutionReconciliationEvidenceV1 } from '../domain/execution-reconciliation.js';
import type { ClaimedExecutionIntent } from './execution-intent-repository.js';
import type { ExecutionSimulationEvidenceV1 } from './execution-simulation-gateway.js';

export interface ExecutionLiveSignedSimulationEvidenceV1 {
  readonly payloadVersion: 1;
  readonly artifactId: string;
  readonly signedTransactionHash: string;
  readonly simulationSlot: bigint;
  readonly unitsConsumed: bigint;
  readonly feePayerLamportDebit: bigint;
  readonly baseDeltaRaw: bigint;
  readonly quoteDeltaRaw: bigint;
  readonly evidenceFingerprint: string;
  readonly observedAtMs: number;
}

export interface ExecutionLivePersistSignedInputV1 {
  readonly payloadVersion: 1;
  readonly claim: ClaimedExecutionIntent;
  readonly qualificationId: string;
  readonly reservationId: string | null;
  readonly artifact: SignedTransactionArtifactV1;
  readonly unsignedSimulation: ExecutionSimulationEvidenceV1;
}

/** Capability returned only after PostgreSQL re-authenticates exact persisted bytes. */
export interface AuthenticatedPersistedSignedTransactionV1 {
  readonly payloadVersion: 1;
  readonly artifact: SignedTransactionArtifactV1;
  readonly state: Extract<SignedTransactionState, 'PERSISTED' | 'SIGNED_SIMULATED' | 'SUBMISSION_STARTED'>;
  readonly stateRevision: bigint;
}

export interface ExecutionLiveSubmissionOutcomeV1 {
  readonly payloadVersion: 1;
  readonly artifactId: string;
  readonly expectedRevision: bigint;
  readonly outcome: 'ACCEPTED' | 'AMBIGUOUS';
  readonly returnedSignature: string | null;
  readonly reasonCode: 'SUBMISSION_ACCEPTED' | 'SUBMISSION_AMBIGUOUS'
    | 'SUBMISSION_SIGNATURE_MISMATCH';
  readonly observedAtMs: number;
}

export interface ExecutionLiveConfirmationV1 {
  readonly payloadVersion: 1;
  readonly artifactId: string;
  readonly expectedRevision: bigint;
  readonly signature: string;
  readonly observedSlot: bigint;
  readonly observedAtMs: number;
}

export interface ExecutionLiveReconciliationResultV1 {
  readonly payloadVersion: 1;
  readonly result: 'MATCHED' | 'NO_EFFECT' | 'MISMATCH' | 'UNKNOWN';
  readonly artifact: SignedTransactionArtifactV1;
  readonly position: ExecutionLivePositionV1 | null;
  readonly exitAuthorization: ExecutionExitAuthorizationV1 | null;
}

export interface ExecutionDeadlineExitResultV1 {
  readonly payloadVersion: 1;
  readonly kind: 'CREATED' | 'REPLAYED' | 'NOT_DUE';
  readonly intent: ExecutionIntentV1 | null;
}

export interface ExecutionLiveRepository {
  persistSigned(input: ExecutionLivePersistSignedInputV1): Promise<SignedTransactionArtifactV1>;
  authenticatePersistedSignedTransaction(input: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly artifactId: string;
  }>): Promise<AuthenticatedPersistedSignedTransactionV1>;
  recordSignedSimulation(
    claim: ClaimedExecutionIntent,
    evidence: ExecutionLiveSignedSimulationEvidenceV1,
  ): Promise<AuthenticatedPersistedSignedTransactionV1>;
  beginSubmission(input: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly artifactId: string;
    readonly expectedRevision: bigint;
    readonly observedAtMs: number;
  }>): Promise<AuthenticatedPersistedSignedTransactionV1>;
  recordSubmissionOutcome(
    claim: ClaimedExecutionIntent,
    outcome: ExecutionLiveSubmissionOutcomeV1,
  ): Promise<SignedTransactionArtifactV1>;
  recordConfirmation(
    claim: ClaimedExecutionIntent,
    confirmation: ExecutionLiveConfirmationV1,
  ): Promise<SignedTransactionArtifactV1>;
  commitReconciliation(
    claim: ClaimedExecutionIntent,
    evidence: ExecutionReconciliationEvidenceV1,
  ): Promise<ExecutionLiveReconciliationResultV1>;
  createDeadlineExitIntent(input: Readonly<{
    readonly positionId: string;
    readonly observedAtMs: number;
  }>): Promise<ExecutionDeadlineExitResultV1>;
}

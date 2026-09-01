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
import type { ExecutionLiveSignedSimulationEvidenceV1 } from
  '../domain/execution-live-signed-simulation.js';
export type { ExecutionLiveSignedSimulationEvidenceV1 } from
  '../domain/execution-live-signed-simulation.js';

export type ExecutionPreSubmissionRevocationCauseV1 =
  | 'SIGNED_SIMULATION_FAILED'
  | 'PRE_SUBMISSION_GATES_FAILED';

export interface ExecutionPreSubmissionRevocationInputV1 {
  readonly payloadVersion: 1;
  readonly claim: ClaimedExecutionIntent;
  readonly artifactId: string;
  readonly expectedState: 'PERSISTED' | 'SIGNED_SIMULATED';
  readonly expectedRevision: bigint;
  readonly causeReasonCode: ExecutionPreSubmissionRevocationCauseV1;
  readonly evidenceFingerprint: string;
  readonly observedAtMs: number;
}

export interface ExecutionPreSubmissionRevocationResultV1 {
  readonly payloadVersion: 1;
  readonly kind: 'REVOKED' | 'REPLAYED';
  readonly artifactState: 'REVOKED_NO_SEND';
}

export interface ExecutionLivePersistSignedInputV1 {
  readonly payloadVersion: 1;
  readonly claim: ClaimedExecutionIntent;
  readonly qualificationId: string;
  readonly reservationId: string | null;
  readonly artifact: SignedTransactionArtifactV1;
  readonly unsignedSimulation: ExecutionSimulationEvidenceV1;
}

/** Runtime identity re-read immediately before the final no-send/send boundary. */
export interface ExecutionLiveRuntimeBindingV1 {
  readonly payloadVersion: 1;
  readonly phase: 'CANARY' | 'MICRO_LIVE' | 'PILOT';
  readonly buildHash: string;
  readonly configurationFingerprint: string;
  readonly strategyFingerprint: string;
  readonly walletPublicKey: string;
  readonly cluster: 'mainnet-beta';
  readonly expectedGenesisHash: string;
  readonly observedGenesisHash: string;
  readonly providerId: string;
}

/** Fresh provider evidence from isBlockhashValid/getBlockHeight. */
export interface ExecutionBlockhashValidityEvidenceV1 {
  readonly payloadVersion: 1;
  readonly providerId: string;
  readonly blockhash: string;
  readonly valid: true;
  readonly observedBlockHeight: bigint;
  readonly contextSlot: bigint;
  readonly observedAtMs: number;
}

/** Capability returned only after PostgreSQL re-authenticates exact persisted bytes. */
export interface AuthenticatedPersistedSignedTransactionV1 {
  readonly payloadVersion: 1;
  readonly artifact: SignedTransactionArtifactV1;
  readonly state: Extract<SignedTransactionState, 'PERSISTED' | 'SIGNED_SIMULATED'>;
  readonly stateRevision: bigint;
}

/** The only capability accepted by the live submission gateway. */
export interface AuthenticatedSubmissionStartedTransactionV1 {
  readonly payloadVersion: 1;
  readonly artifact: SignedTransactionArtifactV1;
  readonly state: 'SUBMISSION_STARTED';
  readonly stateRevision: bigint;
}

/**
 * Exact durable state associated with a claimed intent. Raw signed bytes are exposed only for
 * pre-submission states; durable outcomes intentionally carry identity only.
 */
export type ExecutionLiveSignedTransactionInspectionV1 =
  | Readonly<{
    readonly payloadVersion: 1;
    readonly artifact: SignedTransactionArtifactV1;
    readonly unsignedSimulation: ExecutionSimulationEvidenceV1;
    readonly state: 'PERSISTED' | 'SIGNED_SIMULATED';
    readonly stateRevision: bigint;
  }>
  | Readonly<{
    readonly payloadVersion: 1;
    readonly artifactId: string;
    readonly signature: string;
    readonly signedTransactionHash: string;
    readonly state: 'SUBMISSION_STARTED' | 'ACCEPTED' | 'AMBIGUOUS' | 'REVOKED_NO_SEND';
    readonly stateRevision: bigint;
  }>;

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
  inspectSignedTransaction(input: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly artifactId?: string;
  }>): Promise<ExecutionLiveSignedTransactionInspectionV1 | null>;
  authenticatePersistedSignedTransaction(input: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly artifactId: string;
  }>): Promise<AuthenticatedPersistedSignedTransactionV1>;
  recordSignedSimulation(
    claim: ClaimedExecutionIntent,
    evidence: ExecutionLiveSignedSimulationEvidenceV1,
  ): Promise<AuthenticatedPersistedSignedTransactionV1>;
  revokeBeforeSubmission(
    input: ExecutionPreSubmissionRevocationInputV1,
  ): Promise<ExecutionPreSubmissionRevocationResultV1>;
  beginSubmission(input: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly artifactId: string;
    readonly expectedRevision: bigint;
    readonly runtime: ExecutionLiveRuntimeBindingV1;
    readonly blockhashValidity: ExecutionBlockhashValidityEvidenceV1;
  }>): Promise<AuthenticatedSubmissionStartedTransactionV1>;
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

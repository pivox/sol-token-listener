import type {
  ExecutionExitAuthorizationV1,
  ExecutionLivePositionV1,
  SignedTransactionArtifactV1,
  SignedTransactionState,
} from '../domain/execution-live.js';
import type { ExecutionIntentV1 } from '../domain/execution-intent.js';
import type { ExecutionReconciliationEvidenceV1 } from '../domain/execution-reconciliation.js';
import type { ExecutionReconciliationRequestV1 } from
  '../executor-risk/reconciliation-service.js';
import type { ClaimedExecutionIntent } from './execution-intent-repository.js';
import type { ExecutionAttemptIdentity } from './execution-intent-repository.js';
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
  /** Exact pre-signature authorization; null for a SELL exit. */
  readonly preSignatureLockId: string | null;
  readonly qualificationId: string;
  readonly reservationId: string | null;
  readonly artifact: SignedTransactionArtifactV1;
  readonly unsignedSimulation: ExecutionSimulationEvidenceV1;
  readonly rpcBudget: Readonly<{
    readonly payloadVersion: 1;
    /** Calls already consumed by the unsigned, provider-affine phase. */
    readonly callsUsed: number;
    /** Durable upper bound for every RPC call in this execution attempt. */
    readonly callsLimit: number;
  }>;
}

export interface ExecutionLiveRpcCallReservationInputV1 {
  readonly payloadVersion: 1;
  readonly claim: ClaimedExecutionIntent;
  readonly artifactId: string;
}

export interface ExecutionLiveRpcCallReservationV1 {
  readonly payloadVersion: 1;
  readonly artifactId: string;
  readonly providerId: string;
  readonly callsReserved: number;
  readonly callsLimit: number;
}

/** Artifact and still-held claim committed by the same persistence transaction. */
export interface ExecutionLivePersistSignedResultV1 {
  readonly payloadVersion: 1;
  readonly artifact: SignedTransactionArtifactV1;
  readonly claim: ClaimedExecutionIntent;
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
  readonly quoteMaxAgeMs: number;
  readonly slippageBps: bigint;
  readonly snapshotMaxSlotLag: number;
  readonly maxComputeUnits: bigint;
  readonly maxFeeLamports: bigint;
  readonly maxFeePayerLamportDebit: bigint;
  readonly maxRpcCallsPerAttempt: number;
  readonly leaseMs: number;
}

/**
 * Claim-bound durable authority resolved immediately before transaction construction/signing.
 * It contains identifiers only: the final persistence transaction must revalidate and consume it.
 */
export interface ExecutionLivePreparationBindingV1 {
  readonly payloadVersion: 1;
  readonly side: 'BUY' | 'SELL';
  readonly generationId: string;
  readonly qualificationId: string;
  readonly armamentId: string | null;
  readonly reservationId: string | null;
  readonly exitAuthorizationId: string | null;
  readonly providerId: string;
  readonly walletPublicKey: string;
}

/** Exact unsigned V0 material which may cross the durable before-signing boundary. */
export interface ExecutionUnsignedSigningMaterialV1 {
  readonly payloadVersion: 1;
  readonly walletPublicKey: string;
  readonly providerId: string;
  readonly side: 'BUY' | 'SELL';
  readonly effectiveVenue: 'PUMP_FUN' | 'PUMP_SWAP';
  readonly snapshotSlot: bigint;
  readonly quoteFingerprint: string;
  readonly quoteObservedAtMs: number;
  readonly quoteExpiresAtMs: number;
  readonly buildFingerprint: string;
  readonly snapshotFingerprint: string;
  readonly messageHash: string;
  readonly messageBytes: readonly number[];
  readonly unsignedTransactionHash: string;
  readonly unsignedTransactionBytes: readonly number[];
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly unsignedSimulation: ExecutionSimulationEvidenceV1;
}

/** Durable authorization, returned only after the exact unsigned material is re-read. */
export interface ExecutionExactSigningAuthorizationV1 {
  readonly payloadVersion: 1;
  readonly binding: ExecutionLivePreparationBindingV1;
  readonly preSignatureLockId: string | null;
  readonly material: ExecutionUnsignedSigningMaterialV1;
}

export interface ExecutionExactSigningInputV1 {
  readonly claim: ClaimedExecutionIntent;
  readonly attempt: ExecutionAttemptIdentity;
  readonly generationId: string;
  readonly runtime: ExecutionLiveRuntimeBindingV1;
  readonly material: ExecutionUnsignedSigningMaterialV1;
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
 * pre-submission states; durable outcomes intentionally carry identity only. Every state whose
 * lease remains open carries the authoritative claim read with that state; revocation carries null.
 */
export type ExecutionLiveSignedTransactionInspectionV1 =
  | Readonly<{
    readonly payloadVersion: 1;
    readonly artifact: SignedTransactionArtifactV1;
    readonly unsignedSimulation: ExecutionSimulationEvidenceV1;
    readonly state: 'PERSISTED' | 'SIGNED_SIMULATED';
    readonly stateRevision: bigint;
    readonly claim: ClaimedExecutionIntent;
  }>
  | Readonly<{
    readonly payloadVersion: 1;
    readonly artifactId: string;
    readonly signature: string;
    readonly signedTransactionHash: string;
    readonly state: 'SUBMISSION_STARTED' | 'ACCEPTED' | 'AMBIGUOUS';
    readonly stateRevision: bigint;
    readonly claim: ClaimedExecutionIntent;
  }>
  | Readonly<{
    readonly payloadVersion: 1;
    readonly artifactId: string;
    readonly signature: string;
    readonly signedTransactionHash: string;
    readonly state: 'REVOKED_NO_SEND';
    readonly stateRevision: bigint;
    readonly claim: null;
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

/** Durable submission outcome paired with its post-transition claim. */
export interface ExecutionLiveSubmissionOutcomeResultV1 {
  readonly payloadVersion: 1;
  readonly artifact: SignedTransactionArtifactV1;
  readonly claim: ClaimedExecutionIntent;
}

export interface ExecutionLiveConfirmationV1 {
  readonly payloadVersion: 1;
  readonly artifactId: string;
  readonly expectedRevision: bigint;
  readonly signature: string;
  readonly observedSlot: bigint;
  readonly observedAtMs: number;
}

export interface ExecutionLiveConfirmationWorkV1 {
  readonly payloadVersion: 1;
  readonly artifactId: string;
  readonly expectedRevision: bigint;
  readonly signature: string;
  readonly providerId: string;
}

export interface ExecutionLiveReconciliationWorkV1 {
  readonly payloadVersion: 1;
  readonly providerId: string;
  readonly request: ExecutionReconciliationRequestV1;
}

/** Canonical signed artifact metadata safe for finality workers; raw bytes stay excluded. */
export type ExecutionLiveArtifactReferenceV1 = Omit<
  SignedTransactionArtifactV1,
  'signedTransactionBytes'
>;

export interface ExecutionLiveReconciliationResultV1 {
  readonly payloadVersion: 1;
  readonly result: 'MATCHED' | 'NO_EFFECT' | 'MISMATCH' | 'UNKNOWN';
  readonly artifact: ExecutionLiveArtifactReferenceV1;
  readonly position: ExecutionLivePositionV1 | null;
  readonly exitAuthorization: ExecutionExitAuthorizationV1 | null;
}

export interface ExecutionDeadlineExitResultV1 {
  readonly payloadVersion: 1;
  readonly kind: 'CREATED' | 'REPLAYED' | 'NOT_DUE';
  readonly intent: ExecutionIntentV1 | null;
}

export interface ExecutionPreSignatureRecoveryResultV1 {
  readonly payloadVersion: 1;
  readonly kind: 'IDLE' | 'REVOKED';
}

export interface ExecutionLiveRunnableWorkBindingV1 {
  readonly payloadVersion: 1;
  readonly generationId: string;
  readonly phase: 'CANARY' | 'MICRO_LIVE' | 'PILOT';
  readonly buildHash: string;
  readonly configurationFingerprint: string;
  readonly strategyFingerprint: string;
  readonly walletPublicKey: string;
  readonly cluster: 'mainnet-beta';
  readonly genesisHash: string;
  readonly providerId: string;
  readonly maxRpcCallsPerAttempt: number;
}

export interface ExecutionLiveRepository {
  recoverStrandedPreSignatureLock(
    generationId: string,
  ): Promise<ExecutionPreSignatureRecoveryResultV1>;
  assertRunnableWork(binding: ExecutionLiveRunnableWorkBindingV1): Promise<void>;
  readPreparationBinding(input: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly generationId: string;
    readonly runtime: ExecutionLiveRuntimeBindingV1;
  }>): Promise<ExecutionLivePreparationBindingV1>;
  authorizeExactSigning(
    input: ExecutionExactSigningInputV1,
  ): Promise<ExecutionExactSigningAuthorizationV1>;
  persistSigned(
    input: ExecutionLivePersistSignedInputV1,
  ): Promise<ExecutionLivePersistSignedResultV1>;
  reserveRpcCall(
    input: ExecutionLiveRpcCallReservationInputV1,
  ): Promise<ExecutionLiveRpcCallReservationV1>;
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
  ): Promise<ExecutionLiveSubmissionOutcomeResultV1>;
  recordConfirmation(
    claim: ClaimedExecutionIntent,
    confirmation: ExecutionLiveConfirmationV1,
  ): Promise<ExecutionLiveArtifactReferenceV1>;
  readConfirmationWork(
    claim: ClaimedExecutionIntent,
  ): Promise<ExecutionLiveConfirmationWorkV1>;
  readReconciliationWork(
    claim: ClaimedExecutionIntent,
  ): Promise<ExecutionLiveReconciliationWorkV1>;
  commitReconciliation(
    claim: ClaimedExecutionIntent,
    evidence: ExecutionReconciliationEvidenceV1,
  ): Promise<ExecutionLiveReconciliationResultV1>;
  createDeadlineExitIntent(input: Readonly<{
    readonly positionId: string;
    readonly observedAtMs: number;
  }>): Promise<ExecutionDeadlineExitResultV1>;
  createNextDeadlineExitIntent(): Promise<ExecutionDeadlineExitResultV1 | null>;
}

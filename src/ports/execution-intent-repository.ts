import type {
  ExecutionIntentDraftV1,
  ExecutionIntentReasonCode,
  ExecutionIntentStatus,
  ExecutionIntentV1,
} from '../domain/execution-intent.js';

export type ExecutionClaimPurpose = 'EXECUTE' | 'CONFIRM' | 'RECONCILE' | 'DRY_RUN';

export interface ClaimedExecutionIntent {
  readonly intent: ExecutionIntentV1;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
}

export interface ExecutionAttemptIdentity {
  readonly intentId: string;
  readonly attemptNumber: number;
  readonly startedAtMs: number;
}

/** A freshly fenced parent claim paired atomically with its STARTED attempt. */
export interface ExecutionBeginAttemptResult {
  readonly claim: ClaimedExecutionIntent;
  readonly attempt: ExecutionAttemptIdentity;
}

export interface ExecutionIntentTransitionEvidenceV1 {
  readonly payloadVersion: 1;
  readonly attemptNumber: number | null;
  readonly sourceEventId: string | null;
  readonly observedAtMs: number;
}

export interface ExecutionIntentTransitionInput {
  readonly intentId: string;
  readonly expectedStatus: ExecutionIntentStatus;
  readonly nextStatus: ExecutionIntentStatus;
  readonly leaseToken: string;
  readonly reasonCode: ExecutionIntentReasonCode;
  readonly humanMessage: string;
  readonly activationPhase: 'NONE' | 'CANARY' | 'MICRO_LIVE' | 'PILOT';
  readonly evidence: ExecutionIntentTransitionEvidenceV1;
}

export interface ExecutionIntentRepository {
  create(draft: ExecutionIntentDraftV1): Promise<Readonly<{
    readonly kind: 'CREATED' | 'REPLAYED';
    readonly intent: ExecutionIntentV1;
  }>>;
  claim(options: Readonly<{
    readonly ownerId: string;
    readonly leaseMs: number;
    readonly purpose: ExecutionClaimPurpose;
  }>, signal?: AbortSignal): Promise<ClaimedExecutionIntent | null>;
  beginAttempt(claim: ClaimedExecutionIntent): Promise<ExecutionBeginAttemptResult>;
  finishAttempt(claim: ClaimedExecutionIntent, input: Readonly<{
    readonly attemptNumber: number;
    readonly status: 'COMPLETED' | 'ABANDONED';
    readonly effectiveVenue: 'PUMP_FUN' | 'PUMP_SWAP' | null;
    readonly providerId: string | null;
    readonly reasonCode: ExecutionIntentReasonCode;
  }>): Promise<boolean>;
  renew(claim: ClaimedExecutionIntent, leaseMs: number): Promise<ClaimedExecutionIntent>;
  release(claim: ClaimedExecutionIntent): Promise<boolean>;
  transition(
    claim: ClaimedExecutionIntent,
    input: ExecutionIntentTransitionInput,
  ): Promise<ExecutionIntentV1>;
  expirePreSubmission(limit: number): Promise<number>;
  read(intentId: string): Promise<ExecutionIntentV1 | null>;
}

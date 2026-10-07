import type {
  ExecutionActivationArmamentV1,
  ExecutionActivationArmamentV2,
  ExecutionArmamentRequestV2,
  ExecutionArmamentRequestV3,
  ExecutionControlState,
  ExecutionOperatorAuthorizationV1,
  ExecutionOperatorAuthorizationV2,
} from '../domain/execution-operations.js';
import type {
  ExecutionSafetyQualification,
  ExecutionSafetyQualificationV2,
} from '../domain/execution-safety-qualification.js';
import type { EntryEnvelopeV2 } from '../domain/execution-entry-envelope.js';
import type { ProviderUsageSnapshotV1 } from '../domain/execution-provider-quota.js';
import type { ExecutionIntentSide, ExecutionIntentStatus } from '../domain/execution-intent.js';
import type { ExecutionPreflightDraftSourceV2 } from '../domain/execution-preflight-draft.js';

export interface ExecutionControlCommandV1 {
  readonly payloadVersion: 1;
  readonly commandId: string;
  readonly generationId: string;
  readonly operatorId: string;
  readonly occurredAtMs: number;
}

export interface ExecutionResumeCommandV1 extends ExecutionControlCommandV1 {
  readonly qualificationId: string;
  readonly authorization: ExecutionOperatorAuthorizationV1;
}

export interface ExecutionOperationsStatusV1 {
  readonly payloadVersion: 1;
  readonly generationId: string;
  readonly controlState: ExecutionControlState;
  readonly controlRevision: bigint;
  readonly latestQualificationId: string | null;
  readonly latestQualificationExpiresAtMs: number | null;
  readonly activeArmamentId: string | null;
  readonly activeArmamentPhase: 'CANARY' | 'MICRO_LIVE' | 'PILOT' | null;
  readonly activeArmamentExpiresAtMs: number | null;
}

export interface ExecutionOperationsRepository {
  persistQualification(
    qualification: ExecutionSafetyQualification,
  ): Promise<ExecutionSafetyQualification>;
  readQualification(qualificationId: string): Promise<ExecutionSafetyQualification>;
  recordAuthorization(
    authorization: ExecutionOperatorAuthorizationV1,
  ): Promise<'RECORDED' | 'REPLAYED'>;
  setStop(
    command: ExecutionControlCommandV1,
    mode: 'ENTRY_STOP' | 'HARD_STOP',
  ): Promise<ExecutionOperationsStatusV1>;
  resume(command: ExecutionResumeCommandV1): Promise<ExecutionOperationsStatusV1>;
  arm(armament: ExecutionActivationArmamentV1): Promise<ExecutionActivationArmamentV1>;
  readStatus(generationId: string): Promise<ExecutionOperationsStatusV1>;
}

export type ExecutionEntryEnvelopeState = 'ACTIVE' | 'EXHAUSTED' | 'REVOKED' | 'EXPIRED';

/** The artifact identity an ENVELOPE qualification draft must bind (gate 10). */
export interface ExecutionEnvelopeFactsQueryV1 {
  readonly buildHash: string;
  readonly configurationFingerprint: string;
  readonly walletPublicKey: string;
  readonly providerId: string;
  readonly genesisHash: string;
}

/** Shaped for `createEnvelopeQualificationDraft`: `generation` and `simulation` pass through as-is. */
export interface ExecutionEnvelopeFactsV1 {
  readonly payloadVersion: 1;
  readonly databaseNowMs: number;
  readonly generation: Readonly<{
    generationId: string;
    walletPublicKey: string;
    genesisHash: string;
  }>;
  readonly simulation: Readonly<{
    artifactId: string;
    resultFingerprint: string;
    recordedAtMs: number;
    buildFingerprint: string;
    configurationFingerprint: string;
  }>;
}

export interface ExecutionEnvelopeCreationV1 {
  readonly envelope: EntryEnvelopeV2;
  readonly qualification: ExecutionSafetyQualificationV2;
  /** The TTY-confirmed v1 `ENVELOPE` authorization, already recorded and not yet consumed. */
  readonly authorization: ExecutionOperatorAuthorizationV1;
}

export interface ExecutionEnvelopeRevokeCommandV1 {
  readonly generationId: string;
  readonly envelopeId: string;
  readonly operatorId: string;
  readonly occurredAtMs: number;
}

export interface ExecutionEnvelopeRevocationV1 {
  readonly payloadVersion: 1;
  readonly envelopeId: string;
  readonly state: ExecutionEntryEnvelopeState;
  /** The envelope was already REVOKED before this command. */
  readonly replayed: boolean;
  /** An ARMED armament bound to this envelope was revoked and its reservation released. */
  readonly armamentRevoked: boolean;
  readonly databaseNowMs: number;
}

export interface ExecutionEnvelopeExpiryV1 {
  readonly payloadVersion: 1;
  readonly expiredCount: number;
  readonly databaseNowMs: number;
}

/** An envelope row without its risk policy JSON. v2-only fields are null on lot-3 rows. */
export interface ExecutionEntryEnvelopeSummaryV1 {
  readonly envelopeId: string;
  readonly payloadVersion: number;
  readonly fingerprint: string;
  readonly generationId: string;
  readonly operatorId: string;
  readonly perBuyQuoteAmountRaw: bigint;
  readonly maxBuys: number;
  readonly maxOpenPositions: number;
  readonly maxTotalExposureRaw: bigint;
  readonly maxRealizedLossRaw: bigint;
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly state: ExecutionEntryEnvelopeState;
  readonly buysArmed: number;
  readonly realizedLossRaw: bigint;
  readonly revokedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly authorizationId: string | null;
  readonly policyFingerprint: string | null;
  readonly maximumHoldingMs: number | null;
  readonly qualificationId: string | null;
}

export interface ExecutionEntryEnvelopeRepository {
  prepareEnvelopeFacts(
    generationId: string,
    query: ExecutionEnvelopeFactsQueryV1,
  ): Promise<ExecutionEnvelopeFactsV1 | null>;
  createEnvelope(input: ExecutionEnvelopeCreationV1): Promise<EntryEnvelopeV2>;
  revokeEnvelope(command: ExecutionEnvelopeRevokeCommandV1): Promise<ExecutionEnvelopeRevocationV1>;
  expireEnvelopes(generationId: string): Promise<ExecutionEnvelopeExpiryV1>;
  readEnvelopes(generationId: string): Promise<readonly ExecutionEntryEnvelopeSummaryV1[]>;
}

/** What `readAutoArmContext` reads; every margin is the daemon's (A12, A13). */
export interface ExecutionAutoArmContextQueryV1 {
  readonly generationId: string;
  /** A candidate intent must expire at least this long after the DB now (A13). */
  readonly minimumRemainingMs: number;
  /** The provider snapshot is due for refresh when it expires within this (A12). */
  readonly providerRefreshThresholdMs: number;
  /** Intents the daemon already refused for a non-transient reason. */
  readonly excludedIntentIds: readonly string[];
}

/** One REPEATABLE READ READ ONLY view of everything the auto-arm daemon decides on. */
export interface ExecutionAutoArmContextV1 {
  readonly payloadVersion: 1;
  readonly databaseNowMs: number;
  /** The ACTIVE v2 envelope, rebuilt and verified (policy via createExecutionRiskPolicy). */
  readonly envelope: EntryEnvelopeV2 | null;
  readonly qualification: ExecutionSafetyQualificationV2 | null;
  /** The envelope row counters; 0 without an envelope. */
  readonly buysArmed: number;
  readonly realizedLossRaw: bigint;
  readonly controlState: ExecutionControlState;
  readonly riskStateRevision: bigint;
  readonly openPositions: number;
  readonly unknownBlock: boolean;
  /** An ARMED armament not yet expired, or a LOCKED one (whatever its expiry). */
  readonly activeArmament: 'ARMED' | 'LOCKED' | null;
  /** The current snapshot of the envelope (or locked armament) provider and the local
   * counter units recorded in its billing period since its measurement. */
  readonly provider: Readonly<{
    snapshot: ProviderUsageSnapshotV1;
    localUsedUnits: bigint;
  }> | null;
  /** The oldest eligible fast-entry BUY intent of the envelope, if any. */
  readonly candidateIntent: ExecutionCanaryTargetIntentV1 | null;
  /** No ARMED armament, a LOCKED envelope armament whose BUY SUCCEEDED, and the current
   * provider snapshot expires within the threshold. */
  readonly providerRefreshDue: boolean;
}

export interface ExecutionEnvelopeProviderRefreshCommandV1 {
  readonly generationId: string;
  /** The carried-forward snapshot expires this long after the DB now (bounded by the period). */
  readonly maximumAgeMs: number;
  readonly providerRefreshThresholdMs: number;
}

export interface ExecutionEnvelopeProviderRefreshV1 {
  readonly payloadVersion: 1;
  /** False when the refresh was not due any more inside the transaction. */
  readonly refreshed: boolean;
  readonly snapshot: ProviderUsageSnapshotV1 | null;
  readonly databaseNowMs: number;
}

export interface ExecutionEnvelopeArmamentRepository {
  armEnvelope(input: Readonly<{
    request: ExecutionArmamentRequestV2;
    authorization: ExecutionOperatorAuthorizationV2;
    envelopeId: string;
  }>): Promise<ExecutionActivationArmamentV2>;
  readAutoArmContext(query: ExecutionAutoArmContextQueryV1): Promise<ExecutionAutoArmContextV1>;
  refreshEnvelopeProviderSnapshot(
    command: ExecutionEnvelopeProviderRefreshCommandV1,
  ): Promise<ExecutionEnvelopeProviderRefreshV1>;
}

export interface ExecutionCanaryTargetIntentV1 {
  readonly intentId: string;
  readonly side: ExecutionIntentSide;
  readonly status: ExecutionIntentStatus;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAtMs: number | null;
  readonly stateRevision: bigint;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly decisionFingerprint: string;
  readonly mint: string;
  readonly quoteMint: string;
  readonly quoteAmountRaw: bigint;
  readonly expiresAtMs: number;
}

export interface ExecutionCanaryArmamentRepository {
  readTargetIntent(intentId: string): Promise<ExecutionCanaryTargetIntentV1>;
  armCanary(input: Readonly<{
    request: ExecutionArmamentRequestV2;
    authorization: ExecutionOperatorAuthorizationV2;
    preflightSource?: never;
  }> | Readonly<{
    request: ExecutionArmamentRequestV3;
    authorization: ExecutionOperatorAuthorizationV2;
    preflightSource: ExecutionPreflightDraftSourceV2;
  }>): Promise<ExecutionActivationArmamentV2>;
}

export function unavailableExecutionCanaryArmamentRepository(): ExecutionCanaryArmamentRepository {
  const unavailable = (): Promise<never> => Promise.reject(
    new Error('CANARY_ARMAMENT_REPOSITORY_UNAVAILABLE'),
  );
  return Object.freeze({ readTargetIntent: unavailable, armCanary: unavailable });
}

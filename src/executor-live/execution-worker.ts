import { createHash } from 'node:crypto';
import type {
  ExecutionBlockhashValidityEvidenceV1,
  ExecutionLivePersistSignedInputV1,
  ExecutionLiveRepository,
  ExecutionLiveRuntimeBindingV1,
  ExecutionLiveSignedTransactionInspectionV1,
} from '../ports/execution-live-repository.js';
import type { SignedTransactionArtifactV1 } from '../domain/execution-live.js';
import type { ClaimedExecutionIntent } from '../ports/execution-intent-repository.js';
import type {
  SignedSimulationGateway,
  SignedSimulationGatewayInputV1,
} from './signed-simulation-gateway.js';
import { SignedSimulationGatewayError } from './signed-simulation-gateway.js';
import {
  LiveSubmissionGatewayError,
  type LiveSubmissionGateway,
} from './submission-gateway.js';
import { ExecutionLiveRepositoryError } from '../storage/execution-live.repository.js';
import {
  createSignedSimulationRecoveryContext,
  type SignedSimulationRecoveryContextV1,
} from './signed-simulation-context.js';
import {
  isLiveRpcCallBudgetExhaustedError,
  type LiveRpcError,
} from './rpc-gateway.js';

type LiveWorkerRepository = Pick<ExecutionLiveRepository,
  | 'persistSigned'
  | 'inspectSignedTransaction'
  | 'recordSignedSimulation'
  | 'revokeBeforeSubmission'
  | 'beginSubmission'
  | 'recordSubmissionOutcome'>;

export interface LiveExecutionWorkerDependencies {
  readonly repository: LiveWorkerRepository;
  readonly activateRpcBudget: (
    claim: ClaimedExecutionIntent,
    artifactId: string,
  ) => void;
  readonly signedSimulation: Pick<SignedSimulationGateway, 'simulate'>;
  readonly submission: Pick<LiveSubmissionGateway, 'submitPersisted'>;
  readonly renewBeforeSubmission: (
    claim: ClaimedExecutionIntent,
  ) => Promise<ClaimedExecutionIntent>;
  readonly readBlockhashValidity: (
    artifact: SignedTransactionArtifactV1,
    minimumContextSlot: bigint,
    signal: AbortSignal,
  ) => Promise<ExecutionBlockhashValidityEvidenceV1>;
  readonly clock?: () => number;
}

export interface LiveExecutionWorkerInputV1 {
  readonly persist: ExecutionLivePersistSignedInputV1;
  /**
   * `snapshotSlot` is not trusted as the signed-simulation snapshot. The worker
   * replaces it with the persisted unsigned blockhash context, which is the RPC
   * minContextSlot/causal floor.
   */
  readonly signedSimulation: Omit<SignedSimulationGatewayInputV1, 'persisted'>;
  readonly runtime: ExecutionLiveRuntimeBindingV1;
}

export interface LiveExecutionResumeInputV1 {
  readonly payloadVersion: 1;
  readonly claim: ClaimedExecutionIntent;
  readonly runtime: ExecutionLiveRuntimeBindingV1;
}

export type LiveExecutionWorkerResultV1 =
  | Readonly<{
    readonly payloadVersion: 1;
    readonly kind: 'ACCEPTED' | 'AMBIGUOUS';
    readonly artifactId: string;
    readonly signature: string;
    readonly claim: ClaimedExecutionIntent;
  }>
  | Readonly<{
    readonly payloadVersion: 1;
    readonly kind: 'REVOKED_NO_SEND';
    readonly artifactId: string;
    readonly signature: string;
    readonly claim: null;
  }>;

export async function executeLivePreparedTransaction(
  dependencies: LiveExecutionWorkerDependencies,
  input: LiveExecutionWorkerInputV1,
  signal: AbortSignal,
): Promise<LiveExecutionWorkerResultV1> {
  const expectedArtifact = input.persist.artifact;
  let inspected = await dependencies.repository.inspectSignedTransaction({
    claim: input.persist.claim,
    artifactId: expectedArtifact.artifactId,
  });
  if (inspected === null) {
    const persisted = await dependencies.repository.persistSigned(input.persist);
    inspected = await dependencies.repository.inspectSignedTransaction({
      claim: persisted.claim,
      artifactId: expectedArtifact.artifactId,
    });
    if (inspected === null) throw new TypeError('Persisted signed transaction is missing.');
  }
  assertInspectionIdentity(inspected, expectedArtifact);
  return continueLivePersistedTransaction(dependencies, Object.freeze({
    inspected,
    expectedArtifact,
    signedSimulation: input.signedSimulation,
    runtime: input.runtime,
  }), signal);
}

export async function resumeLivePersistedTransaction(
  dependencies: LiveExecutionWorkerDependencies,
  input: LiveExecutionResumeInputV1,
  signal: AbortSignal,
): Promise<LiveExecutionWorkerResultV1> {
  const inspected = await dependencies.repository.inspectSignedTransaction({ claim: input.claim });
  if (inspected === null) throw new TypeError('Persisted signed transaction is missing.');
  const signedSimulation = inspected.state === 'PERSISTED'
    ? createSignedSimulationRecoveryContext(Object.freeze({
        payloadVersion: 1,
        claim: inspected.claim,
        artifact: inspected.artifact,
        unsignedSimulation: inspected.unsignedSimulation,
      }))
    : null;
  return continueLivePersistedTransaction(dependencies, Object.freeze({
    inspected,
    expectedArtifact: null,
    signedSimulation,
    runtime: input.runtime,
  }), signal);
}

interface LiveContinuationInputV1 {
  readonly inspected: ExecutionLiveSignedTransactionInspectionV1;
  readonly expectedArtifact: SignedTransactionArtifactV1 | null;
  readonly signedSimulation: SignedSimulationRecoveryContextV1 | null;
  readonly runtime: ExecutionLiveRuntimeBindingV1;
}

async function continueLivePersistedTransaction(
  dependencies: LiveExecutionWorkerDependencies,
  input: LiveContinuationInputV1,
  signal: AbortSignal,
): Promise<LiveExecutionWorkerResultV1> {
  const inspected = input.inspected;
  const identity = inspectionIdentity(inspected);
  if (input.expectedArtifact !== null) assertInspectionIdentity(inspected, input.expectedArtifact);
  if (inspected.state === 'REVOKED_NO_SEND') {
    return revokedWorkerResult(identity);
  }
  let activeClaim = inspected.claim;
  if (inspected.state === 'ACCEPTED') return workerResult('ACCEPTED', identity, activeClaim);
  if (inspected.state === 'AMBIGUOUS') return workerResult('AMBIGUOUS', identity, activeClaim);
  if (inspected.state === 'SUBMISSION_STARTED') {
    const recorded = await dependencies.repository.recordSubmissionOutcome(activeClaim, Object.freeze({
      payloadVersion: 1,
      artifactId: identity.artifactId,
      expectedRevision: inspected.stateRevision,
      outcome: 'AMBIGUOUS',
      returnedSignature: null,
      reasonCode: 'SUBMISSION_AMBIGUOUS',
      observedAtMs: now(dependencies.clock),
    }));
    return workerResult('AMBIGUOUS', identity, recorded.claim);
  }
  if (!('artifact' in inspected)) throw new TypeError('Invalid persisted transaction state.');
  const artifact = inspected.artifact;
  dependencies.activateRpcBudget(activeClaim, artifact.artifactId);
  let simulatedRevision = inspected.stateRevision;
  if (inspected.state === 'PERSISTED') {
    if (input.signedSimulation === null) {
      throw new TypeError('Signed simulation recovery context is missing.');
    }
    let signedEvidence: Awaited<ReturnType<SignedSimulationGateway['simulate']>>;
    try {
      signedEvidence = await dependencies.signedSimulation.simulate(Object.freeze({
        ...input.signedSimulation,
        persisted: inspected,
        unsignedSimulation: inspected.unsignedSimulation,
        snapshotSlot: inspected.unsignedSimulation.blockhashContextSlot,
      }), signal);
    } catch (error) {
      if (!signal.aborted && isDeterministicSignedSimulationFailure(error)) {
        const observedAtMs = now(dependencies.clock);
        await dependencies.repository.revokeBeforeSubmission(Object.freeze({
          payloadVersion: 1,
          claim: activeClaim,
          artifactId: artifact.artifactId,
          expectedState: 'PERSISTED',
          expectedRevision: inspected.stateRevision,
          causeReasonCode: 'SIGNED_SIMULATION_FAILED',
          evidenceFingerprint: signedSimulationFailureFingerprint(
            artifact.artifactId, artifact.signedTransactionHash,
            error.code, observedAtMs,
          ),
          observedAtMs,
        }));
      }
      throw error;
    }
    if (signedEvidence.artifactId !== artifact.artifactId
      || signedEvidence.signedTransactionHash !== artifact.signedTransactionHash) {
      throw new TypeError('Invalid signed simulation identity.');
    }
    const recordedSimulation = await dependencies.repository.recordSignedSimulation(
      activeClaim,
      signedEvidence,
    );
    if (recordedSimulation.state !== 'SIGNED_SIMULATED') {
      throw new TypeError('Invalid signed simulation state.');
    }
    simulatedRevision = recordedSimulation.stateRevision;
  }
  activeClaim = await dependencies.renewBeforeSubmission(activeClaim);
  let blockhashValidity: ExecutionBlockhashValidityEvidenceV1;
  try {
    blockhashValidity = await dependencies.readBlockhashValidity(
      artifact,
      inspected.unsignedSimulation.blockhashContextSlot,
      signal,
    );
  } catch (error) {
    if (!signal.aborted && isLiveRpcCallBudgetExhaustedError(error)) {
      const observedAtMs = now(dependencies.clock);
      await dependencies.repository.revokeBeforeSubmission(Object.freeze({
        payloadVersion: 1,
        claim: activeClaim,
        artifactId: artifact.artifactId,
        expectedState: 'SIGNED_SIMULATED',
        expectedRevision: simulatedRevision,
        causeReasonCode: 'PRE_SUBMISSION_GATES_FAILED',
        evidenceFingerprint: preSubmissionGateFailureFingerprint(
          artifact.artifactId, artifact.signedTransactionHash,
          error.code, observedAtMs,
        ),
        observedAtMs,
      }));
    }
    throw error;
  }
  activeClaim = await dependencies.renewBeforeSubmission(activeClaim);
  let started: Awaited<ReturnType<ExecutionLiveRepository['beginSubmission']>>;
  try {
    started = await dependencies.repository.beginSubmission({
      claim: activeClaim,
      artifactId: artifact.artifactId,
      expectedRevision: simulatedRevision,
      runtime: input.runtime,
      blockhashValidity,
    });
  } catch (error) {
    if (!signal.aborted && isDeterministicPreSubmissionGateFailure(error)) {
      const observedAtMs = now(dependencies.clock);
      await dependencies.repository.revokeBeforeSubmission(Object.freeze({
        payloadVersion: 1,
        claim: activeClaim,
        artifactId: artifact.artifactId,
        expectedState: 'SIGNED_SIMULATED',
        expectedRevision: simulatedRevision,
        causeReasonCode: 'PRE_SUBMISSION_GATES_FAILED',
        evidenceFingerprint: preSubmissionGateFailureFingerprint(
          artifact.artifactId, artifact.signedTransactionHash,
          error.code, observedAtMs,
        ),
        observedAtMs,
      }));
    }
    throw error;
  }
  const startedState: unknown = started.state;
  if (startedState !== 'SUBMISSION_STARTED') {
    throw new TypeError('Invalid submission state.');
  }
  let submitted: Readonly<{ readonly signature: string }>;
  try {
    submitted = await dependencies.submission.submitPersisted(started, signal);
  } catch (error) {
    const reasonCode = error instanceof LiveSubmissionGatewayError
      && error.code === 'SUBMISSION_SIGNATURE_MISMATCH'
      ? 'SUBMISSION_SIGNATURE_MISMATCH' as const
      : 'SUBMISSION_AMBIGUOUS' as const;
    const recorded = await dependencies.repository.recordSubmissionOutcome(activeClaim, Object.freeze({
      payloadVersion: 1,
      artifactId: artifact.artifactId,
      expectedRevision: started.stateRevision,
      outcome: 'AMBIGUOUS',
      returnedSignature: null,
      reasonCode,
      observedAtMs: now(dependencies.clock),
    }));
    return workerResult('AMBIGUOUS', artifact, recorded.claim);
  }
  if (submitted.signature !== artifact.signature) {
    const recorded = await dependencies.repository.recordSubmissionOutcome(activeClaim, Object.freeze({
      payloadVersion: 1,
      artifactId: artifact.artifactId,
      expectedRevision: started.stateRevision,
      outcome: 'AMBIGUOUS',
      returnedSignature: null,
      reasonCode: 'SUBMISSION_SIGNATURE_MISMATCH',
      observedAtMs: now(dependencies.clock),
    }));
    return workerResult('AMBIGUOUS', artifact, recorded.claim);
  }
  const recorded = await dependencies.repository.recordSubmissionOutcome(activeClaim, Object.freeze({
    payloadVersion: 1,
    artifactId: artifact.artifactId,
    expectedRevision: started.stateRevision,
    outcome: 'ACCEPTED',
    returnedSignature: submitted.signature,
    reasonCode: 'SUBMISSION_ACCEPTED',
    observedAtMs: now(dependencies.clock),
  }));
  return workerResult('ACCEPTED', artifact, recorded.claim);
}

function assertInspectionIdentity(
  inspected: NonNullable<Awaited<
    ReturnType<ExecutionLiveRepository['inspectSignedTransaction']>
  >>,
  expected: ExecutionLivePersistSignedInputV1['artifact'],
): void {
  const identity = 'artifact' in inspected ? inspected.artifact : inspected;
  if (identity.artifactId !== expected.artifactId
    || identity.signature !== expected.signature
    || identity.signedTransactionHash !== expected.signedTransactionHash) {
    throw new TypeError('Invalid persisted signed transaction inspection identity.');
  }
}

type SignedArtifactIdentityV1 = Readonly<{
  readonly artifactId: string;
  readonly signature: string;
  readonly signedTransactionHash: string;
}>;

function inspectionIdentity(
  inspected: ExecutionLiveSignedTransactionInspectionV1,
): SignedArtifactIdentityV1 {
  return 'artifact' in inspected ? inspected.artifact : inspected;
}

function workerResult(
  kind: 'ACCEPTED' | 'AMBIGUOUS',
  artifact: SignedArtifactIdentityV1,
  claim: ClaimedExecutionIntent,
): LiveExecutionWorkerResultV1 {
  return Object.freeze({
    payloadVersion: 1, kind, artifactId: artifact.artifactId, signature: artifact.signature, claim,
  });
}

function revokedWorkerResult(
  artifact: SignedArtifactIdentityV1,
): LiveExecutionWorkerResultV1 {
  return Object.freeze({
    payloadVersion: 1, kind: 'REVOKED_NO_SEND', artifactId: artifact.artifactId,
    signature: artifact.signature, claim: null,
  });
}

function now(clock: (() => number) | undefined): number {
  const value = (clock ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid live worker time.');
  return value;
}

function isDeterministicSignedSimulationFailure(
  error: unknown,
): error is (SignedSimulationGatewayError & Readonly<{
  readonly code: 'SIGNED_TRANSACTION_INVALID' | 'SIGNED_SIMULATION_INCONSISTENT';
}>) | (LiveRpcError & Readonly<{ readonly code: 'RPC_CALL_BUDGET_EXHAUSTED' }>) {
  return isLiveRpcCallBudgetExhaustedError(error)
    || (error instanceof SignedSimulationGatewayError
      && (error.code === 'SIGNED_TRANSACTION_INVALID'
        || error.code === 'SIGNED_SIMULATION_INCONSISTENT'));
}

function signedSimulationFailureFingerprint(
  artifactId: string,
  signedTransactionHash: string,
  code: 'SIGNED_TRANSACTION_INVALID' | 'SIGNED_SIMULATION_INCONSISTENT'
    | 'RPC_CALL_BUDGET_EXHAUSTED',
  observedAtMs: number,
): string {
  return createHash('sha256').update([
    'execution-live-signed-simulation-failure-v1', artifactId,
    signedTransactionHash, code, String(observedAtMs),
  ].map((part) => `${Buffer.byteLength(part)}:${part}`).join('|')).digest('hex');
}

function isDeterministicPreSubmissionGateFailure(
  error: unknown,
): error is ExecutionLiveRepositoryError & Readonly<{
  readonly code: 'PREFLIGHT_EXPIRED' | 'CONTROL_STOPPED';
}> {
  return error instanceof ExecutionLiveRepositoryError
    && (error.code === 'PREFLIGHT_EXPIRED' || error.code === 'CONTROL_STOPPED');
}

function preSubmissionGateFailureFingerprint(
  artifactId: string,
  signedTransactionHash: string,
  code: 'PREFLIGHT_EXPIRED' | 'CONTROL_STOPPED' | 'RPC_CALL_BUDGET_EXHAUSTED',
  observedAtMs: number,
): string {
  return createHash('sha256').update([
    'execution-live-pre-submission-gate-failure-v1', artifactId,
    signedTransactionHash, code, String(observedAtMs),
  ].map((part) => `${Buffer.byteLength(part)}:${part}`).join('|')).digest('hex');
}

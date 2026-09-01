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

type LiveWorkerRepository = Pick<ExecutionLiveRepository,
  | 'persistSigned'
  | 'inspectSignedTransaction'
  | 'recordSignedSimulation'
  | 'revokeBeforeSubmission'
  | 'beginSubmission'
  | 'recordSubmissionOutcome'>;

export interface LiveExecutionWorkerDependencies {
  readonly repository: LiveWorkerRepository;
  readonly signedSimulation: Pick<SignedSimulationGateway, 'simulate'>;
  readonly submission: Pick<LiveSubmissionGateway, 'submitPersisted'>;
  readonly clock?: () => number;
}

export interface LiveExecutionWorkerInputV1 {
  readonly persist: ExecutionLivePersistSignedInputV1;
  readonly signedSimulation: Omit<SignedSimulationGatewayInputV1, 'persisted'>;
  readonly runtime: ExecutionLiveRuntimeBindingV1;
  readonly blockhashValidity: ExecutionBlockhashValidityEvidenceV1;
}

type SignedSimulationRecoveryInputV1 = Omit<
  SignedSimulationGatewayInputV1,
  'persisted' | 'unsignedSimulation'
>;

export interface LiveExecutionResumeInputV1 {
  readonly payloadVersion: 1;
  readonly claim: ClaimedExecutionIntent;
  readonly signedSimulation: SignedSimulationRecoveryInputV1;
  readonly runtime: ExecutionLiveRuntimeBindingV1;
  readonly blockhashValidity: ExecutionBlockhashValidityEvidenceV1;
}

export type LiveExecutionWorkerResultV1 = Readonly<{
  readonly payloadVersion: 1;
  readonly kind: 'ACCEPTED' | 'AMBIGUOUS' | 'REVOKED_NO_SEND';
  readonly artifactId: string;
  readonly signature: string;
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
    await dependencies.repository.persistSigned(input.persist);
    inspected = await dependencies.repository.inspectSignedTransaction({
      claim: input.persist.claim,
      artifactId: expectedArtifact.artifactId,
    });
    if (inspected === null) throw new TypeError('Persisted signed transaction is missing.');
  }
  assertInspectionIdentity(inspected, expectedArtifact);
  return continueLivePersistedTransaction(dependencies, Object.freeze({
    claim: input.persist.claim,
    inspected,
    expectedArtifact,
    signedSimulation: input.signedSimulation,
    runtime: input.runtime,
    blockhashValidity: input.blockhashValidity,
  }), signal);
}

export async function resumeLivePersistedTransaction(
  dependencies: LiveExecutionWorkerDependencies,
  input: LiveExecutionResumeInputV1,
  signal: AbortSignal,
): Promise<LiveExecutionWorkerResultV1> {
  const inspected = await dependencies.repository.inspectSignedTransaction({ claim: input.claim });
  if (inspected === null) throw new TypeError('Persisted signed transaction is missing.');
  return continueLivePersistedTransaction(dependencies, Object.freeze({
    claim: input.claim,
    inspected,
    expectedArtifact: null,
    signedSimulation: input.signedSimulation,
    runtime: input.runtime,
    blockhashValidity: input.blockhashValidity,
  }), signal);
}

interface LiveContinuationInputV1 {
  readonly claim: ClaimedExecutionIntent;
  readonly inspected: ExecutionLiveSignedTransactionInspectionV1;
  readonly expectedArtifact: SignedTransactionArtifactV1 | null;
  readonly signedSimulation: SignedSimulationRecoveryInputV1;
  readonly runtime: ExecutionLiveRuntimeBindingV1;
  readonly blockhashValidity: ExecutionBlockhashValidityEvidenceV1;
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
    return workerResult('REVOKED_NO_SEND', identity);
  }
  if (inspected.state === 'ACCEPTED') return workerResult('ACCEPTED', identity);
  if (inspected.state === 'AMBIGUOUS') return workerResult('AMBIGUOUS', identity);
  if (inspected.state === 'SUBMISSION_STARTED') {
    await dependencies.repository.recordSubmissionOutcome(input.claim, Object.freeze({
      payloadVersion: 1,
      artifactId: identity.artifactId,
      expectedRevision: inspected.stateRevision,
      outcome: 'AMBIGUOUS',
      returnedSignature: null,
      reasonCode: 'SUBMISSION_AMBIGUOUS',
      observedAtMs: now(dependencies.clock),
    }));
    return workerResult('AMBIGUOUS', identity);
  }
  if (!('artifact' in inspected)) throw new TypeError('Invalid persisted transaction state.');
  const artifact = inspected.artifact;
  let simulatedRevision = inspected.stateRevision;
  if (inspected.state === 'PERSISTED') {
    let signedEvidence: Awaited<ReturnType<SignedSimulationGateway['simulate']>>;
    try {
      signedEvidence = await dependencies.signedSimulation.simulate(Object.freeze({
        ...input.signedSimulation,
        persisted: inspected,
        unsignedSimulation: inspected.unsignedSimulation,
      }), signal);
    } catch (error) {
      if (!signal.aborted && isDeterministicSignedSimulationFailure(error)) {
        const observedAtMs = now(dependencies.clock);
        await dependencies.repository.revokeBeforeSubmission(Object.freeze({
          payloadVersion: 1,
          claim: input.claim,
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
      input.claim,
      signedEvidence,
    );
    if (recordedSimulation.state !== 'SIGNED_SIMULATED') {
      throw new TypeError('Invalid signed simulation state.');
    }
    simulatedRevision = recordedSimulation.stateRevision;
  }
  let started: Awaited<ReturnType<ExecutionLiveRepository['beginSubmission']>>;
  try {
    started = await dependencies.repository.beginSubmission({
      claim: input.claim,
      artifactId: artifact.artifactId,
      expectedRevision: simulatedRevision,
      runtime: input.runtime,
      blockhashValidity: input.blockhashValidity,
    });
  } catch (error) {
    if (!signal.aborted && isDeterministicPreSubmissionGateFailure(error)) {
      const observedAtMs = now(dependencies.clock);
      await dependencies.repository.revokeBeforeSubmission(Object.freeze({
        payloadVersion: 1,
        claim: input.claim,
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
    await dependencies.repository.recordSubmissionOutcome(input.claim, Object.freeze({
      payloadVersion: 1,
      artifactId: artifact.artifactId,
      expectedRevision: started.stateRevision,
      outcome: 'AMBIGUOUS',
      returnedSignature: null,
      reasonCode,
      observedAtMs: now(dependencies.clock),
    }));
    return Object.freeze({
      payloadVersion: 1,
      kind: 'AMBIGUOUS',
      artifactId: artifact.artifactId,
      signature: artifact.signature,
    });
  }
  if (submitted.signature !== artifact.signature) {
    await dependencies.repository.recordSubmissionOutcome(input.claim, Object.freeze({
      payloadVersion: 1,
      artifactId: artifact.artifactId,
      expectedRevision: started.stateRevision,
      outcome: 'AMBIGUOUS',
      returnedSignature: null,
      reasonCode: 'SUBMISSION_SIGNATURE_MISMATCH',
      observedAtMs: now(dependencies.clock),
    }));
    return Object.freeze({
      payloadVersion: 1,
      kind: 'AMBIGUOUS',
      artifactId: artifact.artifactId,
      signature: artifact.signature,
    });
  }
  await dependencies.repository.recordSubmissionOutcome(input.claim, Object.freeze({
    payloadVersion: 1,
    artifactId: artifact.artifactId,
    expectedRevision: started.stateRevision,
    outcome: 'ACCEPTED',
    returnedSignature: submitted.signature,
    reasonCode: 'SUBMISSION_ACCEPTED',
    observedAtMs: now(dependencies.clock),
  }));
  return Object.freeze({
    payloadVersion: 1,
    kind: 'ACCEPTED',
    artifactId: artifact.artifactId,
    signature: artifact.signature,
  });
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
  kind: LiveExecutionWorkerResultV1['kind'],
  artifact: SignedArtifactIdentityV1,
): LiveExecutionWorkerResultV1 {
  return Object.freeze({
    payloadVersion: 1, kind, artifactId: artifact.artifactId, signature: artifact.signature,
  });
}

function now(clock: (() => number) | undefined): number {
  const value = (clock ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid live worker time.');
  return value;
}

function isDeterministicSignedSimulationFailure(
  error: unknown,
): error is SignedSimulationGatewayError & Readonly<{
  readonly code: 'SIGNED_TRANSACTION_INVALID' | 'SIGNED_SIMULATION_INCONSISTENT';
}> {
  return error instanceof SignedSimulationGatewayError
    && (error.code === 'SIGNED_TRANSACTION_INVALID'
      || error.code === 'SIGNED_SIMULATION_INCONSISTENT');
}

function signedSimulationFailureFingerprint(
  artifactId: string,
  signedTransactionHash: string,
  code: 'SIGNED_TRANSACTION_INVALID' | 'SIGNED_SIMULATION_INCONSISTENT',
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
  code: 'PREFLIGHT_EXPIRED' | 'CONTROL_STOPPED',
  observedAtMs: number,
): string {
  return createHash('sha256').update([
    'execution-live-pre-submission-gate-failure-v1', artifactId,
    signedTransactionHash, code, String(observedAtMs),
  ].map((part) => `${Buffer.byteLength(part)}:${part}`).join('|')).digest('hex');
}

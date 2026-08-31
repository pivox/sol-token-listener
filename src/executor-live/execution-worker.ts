import type {
  ExecutionLivePersistSignedInputV1,
  ExecutionLiveRepository,
} from '../ports/execution-live-repository.js';
import type {
  SignedSimulationGateway,
  SignedSimulationGatewayInputV1,
} from './signed-simulation-gateway.js';
import {
  LiveSubmissionGatewayError,
  type LiveSubmissionGateway,
} from './submission-gateway.js';

type LiveWorkerRepository = Pick<ExecutionLiveRepository,
  | 'persistSigned'
  | 'authenticatePersistedSignedTransaction'
  | 'recordSignedSimulation'
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
}

export type LiveExecutionWorkerResultV1 = Readonly<{
  readonly payloadVersion: 1;
  readonly kind: 'ACCEPTED' | 'AMBIGUOUS';
  readonly artifactId: string;
  readonly signature: string;
}>;

export async function executeLivePreparedTransaction(
  dependencies: LiveExecutionWorkerDependencies,
  input: LiveExecutionWorkerInputV1,
  signal: AbortSignal,
): Promise<LiveExecutionWorkerResultV1> {
  const artifact = await dependencies.repository.persistSigned(input.persist);
  const persisted = await dependencies.repository.authenticatePersistedSignedTransaction({
    claim: input.persist.claim,
    artifactId: artifact.artifactId,
  });
  const signedEvidence = await dependencies.signedSimulation.simulate(Object.freeze({
    ...input.signedSimulation,
    persisted,
  }), signal);
  if (signedEvidence.artifactId !== artifact.artifactId
    || signedEvidence.signedTransactionHash !== artifact.signedTransactionHash) {
    throw new TypeError('Invalid signed simulation identity.');
  }
  const simulated = await dependencies.repository.recordSignedSimulation(
    input.persist.claim,
    signedEvidence,
  );
  if (simulated.state !== 'SIGNED_SIMULATED') {
    throw new TypeError('Invalid signed simulation state.');
  }
  const observedAtMs = now(dependencies.clock);
  const started = await dependencies.repository.beginSubmission({
    claim: input.persist.claim,
    artifactId: artifact.artifactId,
    expectedRevision: simulated.stateRevision,
    observedAtMs,
  });
  if (started.state !== 'SUBMISSION_STARTED') {
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
    await dependencies.repository.recordSubmissionOutcome(input.persist.claim, Object.freeze({
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
    await dependencies.repository.recordSubmissionOutcome(input.persist.claim, Object.freeze({
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
  await dependencies.repository.recordSubmissionOutcome(input.persist.claim, Object.freeze({
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

function now(clock: (() => number) | undefined): number {
  const value = (clock ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid live worker time.');
  return value;
}

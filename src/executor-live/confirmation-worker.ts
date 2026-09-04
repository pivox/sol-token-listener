import type { ClaimedExecutionIntent } from '../ports/execution-intent-repository.js';
import type {
  ExecutionLiveConfirmationV1,
} from '../ports/execution-live-repository.js';
import type {
  LiveConfirmationGateway,
  LiveSignatureObservationV1,
} from '../ports/execution-confirmation-gateway.js';
export type {
  LiveConfirmationGateway,
  LiveSignatureObservationV1,
} from '../ports/execution-confirmation-gateway.js';

export interface LiveConfirmationWorkerDependencies {
  readonly gateway: LiveConfirmationGateway;
  readonly repository: Readonly<{
    recordConfirmation(
      claim: ClaimedExecutionIntent,
      confirmation: ExecutionLiveConfirmationV1,
    ): Promise<unknown>;
  }>;
}

export interface LiveConfirmationWorkerInputV1 {
  readonly payloadVersion: 1;
  readonly claim: ClaimedExecutionIntent;
  readonly artifactId: string;
  readonly expectedRevision: bigint;
  readonly signature: string;
}

export type LiveConfirmationWorkerResultV1 = Readonly<{
  readonly payloadVersion: 1;
  readonly kind: 'CONFIRMED' | 'PENDING';
}>;

export async function confirmLiveSubmission(
  dependencies: LiveConfirmationWorkerDependencies,
  input: LiveConfirmationWorkerInputV1,
  signal: AbortSignal,
): Promise<LiveConfirmationWorkerResultV1> {
  let observation: LiveSignatureObservationV1;
  try {
    observation = await dependencies.gateway.observeSignature(input.signature, signal);
  } catch {
    return Object.freeze({ payloadVersion: 1, kind: 'PENDING' });
  }
  if (observation.confirmationStatus === 'NOT_FOUND') {
    return Object.freeze({ payloadVersion: 1, kind: 'PENDING' });
  }
  if (observation.observedSlot === null) {
    return Object.freeze({ payloadVersion: 1, kind: 'PENDING' });
  }
  const confirmation: ExecutionLiveConfirmationV1 = Object.freeze({
    payloadVersion: 1,
    artifactId: input.artifactId,
    expectedRevision: input.expectedRevision,
    signature: input.signature,
    observedSlot: observation.observedSlot,
    observedAtMs: observation.observedAtMs,
  });
  await dependencies.repository.recordConfirmation(input.claim, confirmation);
  return Object.freeze({ payloadVersion: 1, kind: 'CONFIRMED' });
}

import { createHash } from 'node:crypto';
import type { DomainEventType } from './events.js';
import type { LaunchStatus } from './launch-status.js';
import type { TokenLaunchDetectedEventV1 } from './launchpad-events.js';
import type { QualificationReasonCode } from './qualification-reasons.js';

export interface TransitionEvidence {
  readonly source: string;
  readonly program: string;
}

export interface StateTransition {
  readonly id: string;
  readonly payloadVersion: 1;
  readonly mint: string;
  readonly triggeringEventId: string;
  readonly triggeringEventType: DomainEventType;
  readonly occurredAtMs: number;
  readonly previousStatus: LaunchStatus | null;
  readonly newStatus: LaunchStatus;
  readonly reasonCode: QualificationReasonCode | null;
  readonly message: string;
  readonly evidence: TransitionEvidence;
}

export class InvalidLaunchTransitionError extends Error {
  public readonly previous: LaunchStatus | null;
  public readonly new: LaunchStatus;

  public constructor(
    previous: LaunchStatus | null,
    next: LaunchStatus,
  ) {
    super(`Invalid launch transition from ${previous ?? 'none'} to ${next}`);
    this.name = 'InvalidLaunchTransitionError';
    this.previous = previous;
    this.new = next;
  }
}

export function assertInitialLaunchTransitionAllowed(
  previousStatus: LaunchStatus | null,
  newStatus: LaunchStatus,
): void {
  if (previousStatus !== null || newStatus !== 'DETECTED') {
    throw new InvalidLaunchTransitionError(previousStatus, newStatus);
  }
}

export function createInitialDetectedTransition(
  event: TokenLaunchDetectedEventV1,
): StateTransition {
  const previousStatus = null;
  const newStatus = 'DETECTED';
  assertInitialLaunchTransitionAllowed(previousStatus, newStatus);
  const evidence = Object.freeze({ source: event.source, program: event.program });
  return Object.freeze({
    id: createDeterministicTransitionId(event.id, previousStatus, newStatus),
    payloadVersion: 1,
    mint: event.mint,
    triggeringEventId: event.id,
    triggeringEventType: event.type,
    occurredAtMs: event.blockchainTimeMs ?? event.observedAtMs,
    previousStatus,
    newStatus,
    reasonCode: null,
    message: 'Token launch detected',
    evidence,
  });
}

function createDeterministicTransitionId(
  eventId: string,
  previousStatus: LaunchStatus | null,
  newStatus: LaunchStatus,
): string {
  const canonical = [eventId, previousStatus ?? 'none', newStatus].join('\u001f');
  return `transition_${createHash('sha256').update(canonical).digest('hex')}`;
}

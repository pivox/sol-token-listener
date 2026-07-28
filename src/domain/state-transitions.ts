import { createHash } from 'node:crypto';
import type { DomainEventType } from './events.js';
import type { LaunchStatus } from './launch-status.js';
import type { TokenLaunchDetectedEventV1 } from './launchpad-events.js';
import type { QualificationReasonCode } from './qualification-reasons.js';
import type {
  MigrationObservedEventV1,
  PumpSwapPoolActivatedEventV1,
} from './migration-events.js';
import {
  assertValidNullableTimestampMs,
  assertValidTimestampMs,
} from './timestamp.js';

export interface TransitionEvidence {
  readonly source: string;
  readonly program: string;
}

export type TransitionOccurrenceSource = 'blockchain' | 'observation';

export interface TransitionOccurrence {
  readonly occurredAtMs: number;
  readonly occurredAtSource: TransitionOccurrenceSource;
}

export interface StateTransition extends TransitionOccurrence {
  readonly id: string;
  readonly payloadVersion: 1;
  readonly mint: string;
  readonly triggeringEventId: string;
  readonly triggeringEventType: DomainEventType;
  readonly previousStatus: LaunchStatus | null;
  readonly newStatus: LaunchStatus;
  readonly reasonCode: QualificationReasonCode | null;
  readonly message: string;
  readonly evidence: TransitionEvidence;
}

export const INITIAL_DETECTED_TRANSITION_MESSAGE = 'Token launch detected';
export const MIGRATION_PENDING_TRANSITION_MESSAGE = 'Pump.fun migration observed';
export const PUMPSWAP_ACTIVE_TRANSITION_MESSAGE = 'Canonical PumpSwap pool activated';

export interface InitialDetectedStateTransition extends StateTransition {
  readonly payloadVersion: 1;
  readonly triggeringEventType: 'TokenLaunchDetected';
  readonly previousStatus: null;
  readonly newStatus: 'DETECTED';
  readonly reasonCode: null;
  readonly message: typeof INITIAL_DETECTED_TRANSITION_MESSAGE;
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

export class InvalidTransitionOccurrenceSourceError extends Error {
  public constructor(public readonly source: unknown) {
    super(`Invalid transition occurrence source: ${String(source)}`);
    this.name = 'InvalidTransitionOccurrenceSourceError';
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
): InitialDetectedStateTransition {
  assertValidTimestampMs('observedAtMs', event.observedAtMs);
  assertValidNullableTimestampMs(
    'blockchainTimeMs',
    event.blockchainTimeMs,
  );
  const previousStatus = null;
  const newStatus = 'DETECTED';
  assertInitialLaunchTransitionAllowed(previousStatus, newStatus);
  const evidence = Object.freeze({ source: event.source, program: event.program });
  const occurredAtSource = event.blockchainTimeMs === null
    ? 'observation'
    : 'blockchain';
  const occurredAtMs = event.blockchainTimeMs ?? event.observedAtMs;
  assertValidTimestampMs('occurredAtMs', occurredAtMs);
  return Object.freeze({
    id: createDeterministicTransitionId(event.id, previousStatus, newStatus),
    payloadVersion: 1,
    mint: event.mint,
    triggeringEventId: event.id,
    triggeringEventType: event.type,
    occurredAtMs,
    occurredAtSource,
    previousStatus,
    newStatus,
    reasonCode: null,
    message: INITIAL_DETECTED_TRANSITION_MESSAGE,
    evidence,
  });
}

export function createMigrationPendingTransition(
  current: 'BONDING_CURVE_COMPLETE' | 'OBSERVING',
  event: MigrationObservedEventV1,
): StateTransition {
  return createEventTransition(
    current,
    'MIGRATION_PENDING',
    MIGRATION_PENDING_TRANSITION_MESSAGE,
    event,
  );
}

export function createPumpSwapActiveTransition(
  event: PumpSwapPoolActivatedEventV1,
): StateTransition {
  return createEventTransition(
    'MIGRATION_PENDING',
    'PUMPSWAP_ACTIVE',
    PUMPSWAP_ACTIVE_TRANSITION_MESSAGE,
    event,
  );
}

function createEventTransition(
  previousStatus: LaunchStatus,
  newStatus: LaunchStatus,
  message: string,
  event: MigrationObservedEventV1 | PumpSwapPoolActivatedEventV1,
): StateTransition {
  assertValidTimestampMs('observedAtMs', event.observedAtMs);
  assertValidNullableTimestampMs('blockchainTimeMs', event.blockchainTimeMs);
  const occurredAtSource = event.blockchainTimeMs === null
    ? 'observation'
    : 'blockchain';
  return Object.freeze({
    id: createDeterministicTransitionId(event.id, previousStatus, newStatus),
    payloadVersion: 1,
    mint: event.mint,
    triggeringEventId: event.id,
    triggeringEventType: event.type,
    occurredAtMs: event.blockchainTimeMs ?? event.observedAtMs,
    occurredAtSource,
    previousStatus,
    newStatus,
    reasonCode: null,
    message,
    evidence: Object.freeze({ source: event.source, program: event.program }),
  });
}

export function reconcileTransitionOccurrence(
  current: TransitionOccurrence,
  incoming: TransitionOccurrence,
): TransitionOccurrence {
  assertValidTransitionOccurrence(current);
  assertValidTransitionOccurrence(incoming);
  const winner = current.occurredAtSource === incoming.occurredAtSource
    ? (current.occurredAtMs <= incoming.occurredAtMs ? current : incoming)
    : (current.occurredAtSource === 'blockchain' ? current : incoming);
  return Object.freeze({
    occurredAtMs: winner.occurredAtMs,
    occurredAtSource: winner.occurredAtSource,
  });
}

export function assertValidTransitionOccurrence(
  occurrence: TransitionOccurrence,
): void {
  const candidate: unknown = occurrence;
  if (
    typeof candidate !== 'object'
    || candidate === null
    || !('occurredAtSource' in candidate)
    || (
      candidate.occurredAtSource !== 'blockchain'
      && candidate.occurredAtSource !== 'observation'
    )
  ) {
    const source = typeof candidate === 'object'
      && candidate !== null
      && 'occurredAtSource' in candidate
      ? candidate.occurredAtSource
      : undefined;
    throw new InvalidTransitionOccurrenceSourceError(source);
  }
  const occurredAtMs = 'occurredAtMs' in candidate
    ? candidate.occurredAtMs
    : undefined;
  assertValidTimestampMs('occurredAtMs', occurredAtMs);
}

export function createDeterministicTransitionId(
  eventId: string,
  previousStatus: LaunchStatus | null,
  newStatus: LaunchStatus,
): string {
  const canonical = [eventId, previousStatus ?? 'none', newStatus].join('\u001f');
  return `transition_${createHash('sha256').update(canonical).digest('hex')}`;
}

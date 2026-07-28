import type { LaunchpadObservationEventV1 } from '../domain/launchpad-events.js';
import type { StateTransition } from '../domain/state-transitions.js';
import type { ChainConfirmationStatus } from '../domain/types.js';

export type EventRecordOutcome = 'created' | 'duplicate' | 'confirmation_updated';

export interface EventRecordResult {
  readonly eventId: string;
  readonly outcome: EventRecordOutcome;
}

export interface LaunchpadEventBatch {
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly events: readonly LaunchpadObservationEventV1[];
  readonly transitions: readonly StateTransition[];
}

export interface LaunchpadEventBatchResult {
  readonly events: readonly EventRecordResult[];
}

export interface LaunchpadEventSink {
  /**
   * Writes events and transitions atomically: either the whole batch commits durably or none does.
   * Resolves only after that durable commit. Deterministic IDs make replay idempotent; an existing
   * event's confirmation may reconcile only monotonically under domain rules. Returns exactly one
   * result per input event in input order. Rejection leaves no partial batch writes.
   */
  readonly record: (batch: LaunchpadEventBatch) => Promise<LaunchpadEventBatchResult>;
}

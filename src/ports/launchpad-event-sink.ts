import type { LaunchpadObservationEventV1 } from '../domain/launchpad-events.js';
import type { StateTransition } from '../domain/state-transitions.js';
import type { ChainConfirmationStatus } from '../domain/types.js';

export type EventRecordOutcome = 'created' | 'duplicate' | 'confirmation_updated';
export type StateTransitionBatchAction = 'apply' | 'retract';

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
  /**
   * `apply` atomically applies or upserts the supplied transitions linked by
   * `triggeringEventId`. `retract` is valid only for an orphaned batch, requires
   * an empty `transitions` array, and atomically invalidates or removes from the
   * active launch projection every transition triggered by an input event ID.
   * Retraction must preserve auditable raw/domain events and invalidation
   * history; it must not silently delete history. Thus, a first-seen orphaned
   * event creates no active launch state.
   */
  readonly stateTransitionAction: StateTransitionBatchAction;
  readonly transitions: readonly StateTransition[];
}

export interface LaunchpadEventBatchResult {
  readonly events: readonly EventRecordResult[];
}

export interface LaunchpadEventSink {
  /**
   * Reconciles event confirmation and the requested transition action in one
   * durable all-or-nothing transaction, returning exactly one result per input
   * event in input order. For processed/confirmed/finalized replay, deterministic
   * transition IDs are stable. If event reconciliation keeps or duplicates the
   * stored event, the sink keeps its stored transition snapshot. If reconciliation
   * returns `confirmation_updated` to confirmed or finalized, the sink updates
   * non-identity transition data from the incoming canonical snapshot, including
   * `occurredAtMs` when blockchain time replaces the observation fallback. An
   * orphaned batch retracts regardless of any previous apply. Resolves only after
   * the durable commit; rejection leaves no partial event, transition, projection,
   * or invalidation-history writes.
   */
  readonly record: (batch: LaunchpadEventBatch) => Promise<LaunchpadEventBatchResult>;
}

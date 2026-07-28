import type { LaunchpadObservationEventV1 } from '../domain/launchpad-events.js';
import type { StateTransition } from '../domain/state-transitions.js';
import type { ChainConfirmationStatus } from '../domain/types.js';

export type EventRecordOutcome = 'created' | 'duplicate' | 'confirmation_updated';
export type StateTransitionBatchAction = 'apply' | 'retract';
type ActiveConfirmationStatus = Exclude<ChainConfirmationStatus, 'orphaned'>;

export interface EventRecordResult {
  readonly eventId: string;
  readonly outcome: EventRecordOutcome;
}

interface LaunchpadEventBatchBase {
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly events: readonly LaunchpadObservationEventV1[];
}

export interface ApplyLaunchpadEventBatch extends LaunchpadEventBatchBase {
  readonly confirmationStatus: ActiveConfirmationStatus;
  readonly stateTransitionAction: 'apply';
  readonly transitions: readonly StateTransition[];
}

export interface RetractLaunchpadEventBatch extends LaunchpadEventBatchBase {
  readonly confirmationStatus: 'orphaned';
  readonly stateTransitionAction: 'retract';
  readonly transitions: readonly [];
}

export type LaunchpadEventBatch =
  | ApplyLaunchpadEventBatch
  | RetractLaunchpadEventBatch;

export interface LaunchpadEventBatchResult {
  readonly events: readonly EventRecordResult[];
}

export class InvalidLaunchpadEventBatchError extends Error {
  public constructor(public readonly reason: string) {
    super(`Invalid launchpad event batch: ${reason}`);
    this.name = 'InvalidLaunchpadEventBatchError';
  }
}

export function assertValidLaunchpadEventBatch(
  batch: LaunchpadEventBatch,
): void {
  const candidate: unknown = batch;
  if (!isRecord(candidate)) {
    throw new InvalidLaunchpadEventBatchError('batch must be an object');
  }
  const {
    source,
    program,
    signature,
    confirmationStatus,
    stateTransitionAction,
    events,
    transitions,
  } = candidate;
  if (
    typeof source !== 'string'
    || typeof program !== 'string'
    || typeof signature !== 'string'
    || !Array.isArray(events)
    || !Array.isArray(transitions)
  ) {
    throw new InvalidLaunchpadEventBatchError(
      'batch metadata, events, and transitions must have valid shapes',
    );
  }
  if (
    stateTransitionAction === 'apply'
    && (
      confirmationStatus !== 'processed'
      && confirmationStatus !== 'confirmed'
      && confirmationStatus !== 'finalized'
    )
  ) {
    throw new InvalidLaunchpadEventBatchError(
      'apply requires processed, confirmed, or finalized confirmation',
    );
  }
  if (
    stateTransitionAction === 'retract'
    && (confirmationStatus !== 'orphaned' || transitions.length !== 0)
  ) {
    throw new InvalidLaunchpadEventBatchError(
      'retract requires orphaned confirmation and no transitions',
    );
  }
  if (stateTransitionAction !== 'apply' && stateTransitionAction !== 'retract') {
    throw new InvalidLaunchpadEventBatchError(
      'stateTransitionAction must be apply or retract',
    );
  }

  const launchEvents: {
    readonly id: string;
    readonly mint: string;
    readonly type: 'TokenLaunchDetected';
  }[] = [];
  for (const event of events) {
    if (
      !isRecord(event)
      || event.source !== source
      || event.program !== program
      || event.signature !== signature
      || event.confirmationStatus !== confirmationStatus
    ) {
      throw new InvalidLaunchpadEventBatchError(
        'every event must match batch source, program, signature, and confirmation',
      );
    }
    if (event.type === 'TokenLaunchDetected') {
      if (typeof event.id !== 'string' || typeof event.mint !== 'string') {
        throw new InvalidLaunchpadEventBatchError(
          'launch events must have string IDs and mints',
        );
      }
      launchEvents.push({
        id: event.id,
        mint: event.mint,
        type: event.type,
      });
    }
  }

  if (stateTransitionAction === 'retract') return;
  if (transitions.length !== launchEvents.length) {
    throw new InvalidLaunchpadEventBatchError(
      'apply requires exactly one transition per launch event',
    );
  }
  const transitionCountByEventId = new Map<string, number>();
  for (const transition of transitions) {
    if (!isRecord(transition)) {
      throw new InvalidLaunchpadEventBatchError('transitions must be objects');
    }
    const launchEvent = launchEvents.find(
      (event) => event.id === transition.triggeringEventId,
    );
    if (launchEvent === undefined) {
      throw new InvalidLaunchpadEventBatchError(
        'every transition must reference a launch event in the batch',
      );
    }
    if (
      transition.mint !== launchEvent.mint
      || transition.triggeringEventType !== launchEvent.type
    ) {
      throw new InvalidLaunchpadEventBatchError(
        'transition mint and type must match its launch event',
      );
    }
    transitionCountByEventId.set(
      launchEvent.id,
      (transitionCountByEventId.get(launchEvent.id) ?? 0) + 1,
    );
  }
  if (
    launchEvents.some(
      (event) => transitionCountByEventId.get(event.id) !== 1,
    )
  ) {
    throw new InvalidLaunchpadEventBatchError(
      'each launch event must have exactly one transition',
    );
  }
}

export interface LaunchpadEventSink {
  /**
   * Reconciles event confirmation and the requested transition action in one
   * durable all-or-nothing transaction, returning exactly one result per input
   * event in input order. `apply` atomically upserts transitions linked by
   * `triggeringEventId`. A first-seen orphaned event is retained for audit but
   * creates no active transition. For an existing event, retraction occurs only
   * after successful processed/confirmed-to-orphaned reconciliation and
   * atomically invalidates or removes that event's transitions from the active
   * projection while retaining auditable event and invalidation history.
   * Finalized-to-orphaned and every transition out of orphaned reject the whole
   * transaction without retraction.
   *
   * Deterministic transition IDs remain stable on replay. Independently of
   * `EventRecordOutcome`, the sink enriches transition occurrence with
   * `reconcileTransitionOccurrence`: blockchain time outranks observation time,
   * and the earlier time wins within one source. Thus a same-status replay can
   * add blockchain time, while an observation fallback can never replace it.
   * Resolves only after the durable commit; rejection leaves no partial event,
   * transition, projection, or invalidation-history writes.
   */
  readonly record: (batch: LaunchpadEventBatch) => Promise<LaunchpadEventBatchResult>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

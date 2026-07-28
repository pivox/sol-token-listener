import { compareCursors } from '../domain/cursor.js';
import {
  createBondingCurveTradeObservedEvent,
  createTokenLaunchDetectedEvent,
  type LaunchpadObservationEventV1,
} from '../domain/launchpad-events.js';
import { createInitialDetectedTransition } from '../domain/state-transitions.js';
import type { ObservedChainTransaction } from '../domain/types.js';
import type { LaunchpadAdapter } from '../ports/launchpad-adapter.js';
import type {
  EventRecordResult,
  LaunchpadEventBatch,
  LaunchpadEventBatchResult,
  LaunchpadEventSink,
} from '../ports/launchpad-event-sink.js';
import {
  LaunchpadObservationError,
  type LaunchpadObservationStage,
} from './launchpad-observation-errors.js';

const EMPTY_EVENT_RESULTS: readonly EventRecordResult[] = Object.freeze([]);
const EMPTY_BATCH_RESULT: LaunchpadEventBatchResult = Object.freeze({
  events: EMPTY_EVENT_RESULTS,
});

export class LaunchpadObservationService<
  TTransaction extends ObservedChainTransaction,
> {
  public constructor(
    private readonly adapter: LaunchpadAdapter<TTransaction>,
    private readonly sink: LaunchpadEventSink,
  ) {}

  public async observe(
    transaction: TTransaction,
    alreadyTrackedMints: ReadonlySet<string>,
  ): Promise<LaunchpadEventBatchResult> {
    const trackedMints = new Set(alreadyTrackedMints);
    const launches = await this.runStage(
      'detect_launches',
      transaction,
      () => this.adapter.detectLaunches(transaction),
    );
    for (const launch of launches) trackedMints.add(launch.mint);
    const trades = await this.runStage(
      'decode_trades',
      transaction,
      () => this.adapter.decodeTrades(transaction, trackedMints),
    );

    const launchEvents = launches.map((launch) =>
      createTokenLaunchDetectedEvent({
        source: this.adapter.source,
        program: this.adapter.programId,
        transaction,
        launch,
      }));
    const events = Object.freeze([
      ...launchEvents,
      ...trades.map((trade) =>
        createBondingCurveTradeObservedEvent({
          source: this.adapter.source,
          program: this.adapter.programId,
          transaction,
          trade,
        })),
    ].sort(compareObservationEvents));
    if (events.length === 0) return EMPTY_BATCH_RESULT;

    const transitions = Object.freeze(
      events
        .filter((event) => event.type === 'TokenLaunchDetected')
        .map(createInitialDetectedTransition),
    );
    const batch: LaunchpadEventBatch = Object.freeze({
      source: this.adapter.source,
      program: this.adapter.programId,
      signature: transaction.signature,
      confirmationStatus: transaction.confirmationStatus,
      events,
      transitions,
    });
    return this.runStage(
      'record_batch',
      transaction,
      () => this.sink.record(batch),
    );
  }

  private async runStage<TResult>(
    stage: LaunchpadObservationStage,
    transaction: TTransaction,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await operation();
    } catch (cause) {
      throw new LaunchpadObservationError(
        stage,
        this.adapter.source,
        this.adapter.programId,
        transaction.signature,
        cause,
      );
    }
  }
}

function compareObservationEvents(
  left: LaunchpadObservationEventV1,
  right: LaunchpadObservationEventV1,
): number {
  const cursorOrder = compareCursors(left.cursor, right.cursor);
  if (cursorOrder !== 0) return cursorOrder;
  if (left.type !== right.type) {
    return left.type === 'TokenLaunchDetected' ? -1 : 1;
  }
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

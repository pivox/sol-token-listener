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
  TTransaction extends ObservedChainTransaction = ObservedChainTransaction,
> {
  public constructor(
    private readonly adapter: LaunchpadAdapter<TTransaction>,
    private readonly sink: LaunchpadEventSink,
  ) {}

  public async observe(
    transaction: TTransaction,
    alreadyTrackedMints: ReadonlySet<string>,
  ): Promise<LaunchpadEventBatchResult> {
    const envelope = createObservationEnvelope(
      this.adapter.source,
      this.adapter.programId,
      transaction,
    );
    const authoritativeTrackedMints = new Set(alreadyTrackedMints);
    const detectedLaunches = await this.runStage(
      'detect_launches',
      envelope,
      () => this.adapter.detectLaunches(transaction),
    );
    const launchEvents = detectedLaunches.map((launch) =>
      createTokenLaunchDetectedEvent({
        source: envelope.source,
        program: envelope.program,
        transaction: envelope.transaction,
        launch,
      }));
    for (const event of launchEvents) {
      authoritativeTrackedMints.add(event.payload.launch.mint);
    }
    const trades = await this.runStage(
      'decode_trades',
      envelope,
      () => this.adapter.decodeTrades(
        transaction,
        new Set(authoritativeTrackedMints),
      ),
    );

    const events = Object.freeze([
      ...launchEvents,
      ...trades.map((trade) =>
        createBondingCurveTradeObservedEvent({
          source: envelope.source,
          program: envelope.program,
          transaction: envelope.transaction,
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
      source: envelope.source,
      program: envelope.program,
      signature: envelope.transaction.signature,
      confirmationStatus: envelope.transaction.confirmationStatus,
      events,
      transitions,
    });
    return this.runStage(
      'record_batch',
      envelope,
      () => this.sink.record(batch),
    );
  }

  private async runStage<TResult>(
    stage: LaunchpadObservationStage,
    envelope: ObservationEnvelope,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await operation();
    } catch (cause) {
      throw new LaunchpadObservationError(
        stage,
        envelope.source,
        envelope.program,
        envelope.transaction.signature,
        cause,
      );
    }
  }
}

interface ObservationEnvelope {
  readonly source: string;
  readonly program: string;
  readonly transaction: ObservedChainTransaction;
}

function createObservationEnvelope(
  source: string,
  program: string,
  transaction: ObservedChainTransaction,
): ObservationEnvelope {
  const transactionSnapshot: ObservedChainTransaction = Object.freeze({
    signature: transaction.signature,
    confirmationStatus: transaction.confirmationStatus,
    blockTimeMs: transaction.blockTimeMs,
    observedAtMs: transaction.observedAtMs,
    cursor: Object.freeze({
      slot: transaction.cursor.slot,
      transactionIndex: transaction.cursor.transactionIndex,
    }),
    raw: null,
  });
  return Object.freeze({
    source,
    program,
    transaction: transactionSnapshot,
  });
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

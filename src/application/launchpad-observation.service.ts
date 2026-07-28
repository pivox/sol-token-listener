import { isDeepStrictEqual } from 'node:util';
import { compareCursors } from '../domain/cursor.js';
import {
  createBondingCurveTradeObservedEvent,
  createTokenLaunchDetectedEvent,
  type BondingCurveTradeObservedEventV1,
  type LaunchpadObservationEventV1,
  type TokenLaunchDetectedEventV1,
} from '../domain/launchpad-events.js';
import { createInitialDetectedTransition } from '../domain/state-transitions.js';
import type {
  ChainCursor,
  LaunchpadTrade,
  ObservedChainTransaction,
  TokenLaunch,
} from '../domain/types.js';
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
    const launchEvents = await this.runStage(
      'validate_batch',
      envelope,
      () => createNormalizedLaunchEvents(detectedLaunches, envelope),
    );
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

    const batch = await this.runStage(
      'validate_batch',
      envelope,
      () => createValidatedBatch(
        launchEvents,
        trades,
        authoritativeTrackedMints,
        envelope,
      ),
    );
    if (batch === null) return EMPTY_BATCH_RESULT;

    return this.runStage(
      'record_batch',
      envelope,
      () => this.sink.record(batch),
    );
  }

  private async runStage<TResult>(
    stage: LaunchpadObservationStage,
    envelope: ObservationEnvelope,
    operation: () => TResult | Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await operation();
    } catch (cause) {
      if (
        cause instanceof LaunchpadObservationError
        && cause.stage === stage
        && cause.source === envelope.source
        && cause.program === envelope.program
        && cause.signature === envelope.transaction.signature
      ) {
        throw cause;
      }
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

function createNormalizedLaunchEvents(
  launches: readonly TokenLaunch[],
  envelope: ObservationEnvelope,
): readonly TokenLaunchDetectedEventV1[] {
  const eventsByMint = new Map<string, TokenLaunchDetectedEventV1>();
  for (const launch of launches) {
    const event = createTokenLaunchDetectedEvent({
      source: envelope.source,
      program: envelope.program,
      transaction: envelope.transaction,
      launch,
    });
    assertCursorBelongsToTransaction('Launch', event.cursor, envelope.transaction);
    if (event.payload.launch.quoteAssets.length === 0) {
      throw new Error(
        `Token launch ${event.mint} must define at least one quote asset`,
      );
    }

    const existing = eventsByMint.get(event.mint);
    if (existing === undefined) {
      eventsByMint.set(event.mint, event);
      continue;
    }
    if (!isDeepStrictEqual(existing.payload.launch, event.payload.launch)) {
      throw new Error(`Conflicting launch definitions for mint ${event.mint}`);
    }
  }
  return Object.freeze([...eventsByMint.values()]);
}

function createValidatedBatch(
  launchEvents: readonly TokenLaunchDetectedEventV1[],
  trades: readonly LaunchpadTrade[],
  authoritativeTrackedMints: ReadonlySet<string>,
  envelope: ObservationEnvelope,
): LaunchpadEventBatch | null {
  const tradeEvents = createValidatedTradeEvents(
    trades,
    authoritativeTrackedMints,
    envelope,
  );
  const events = [...launchEvents, ...tradeEvents];
  const eventIds = new Set<string>();
  for (const event of events) {
    if (eventIds.has(event.id)) {
      throw new Error(`Duplicate deterministic event ID ${event.id}`);
    }
    eventIds.add(event.id);
  }
  events.sort(compareObservationEvents);
  const frozenEvents: readonly LaunchpadObservationEventV1[] = Object.freeze(events);
  if (frozenEvents.length === 0) return null;

  const transitions = Object.freeze(
    frozenEvents
      .filter((event) => event.type === 'TokenLaunchDetected')
      .map(createInitialDetectedTransition),
  );
  return Object.freeze({
    source: envelope.source,
    program: envelope.program,
    signature: envelope.transaction.signature,
    confirmationStatus: envelope.transaction.confirmationStatus,
    events: frozenEvents,
    transitions,
  });
}

function createValidatedTradeEvents(
  trades: readonly LaunchpadTrade[],
  authoritativeTrackedMints: ReadonlySet<string>,
  envelope: ObservationEnvelope,
): readonly BondingCurveTradeObservedEventV1[] {
  const events: BondingCurveTradeObservedEventV1[] = [];
  for (const trade of trades) {
    const event = createBondingCurveTradeObservedEvent({
      source: envelope.source,
      program: envelope.program,
      transaction: envelope.transaction,
      trade,
    });
    assertCursorBelongsToTransaction('Trade', event.cursor, envelope.transaction);
    if (!authoritativeTrackedMints.has(event.payload.trade.launchMint)) {
      throw new Error(
        `Trade ${event.payload.trade.id} references untracked launch mint ${event.payload.trade.launchMint}`,
      );
    }
    events.push(event);
  }
  return Object.freeze(events);
}

function assertCursorBelongsToTransaction(
  observationType: 'Launch' | 'Trade',
  cursor: ChainCursor,
  transaction: ObservedChainTransaction,
): void {
  if (cursor.slot !== transaction.cursor.slot) {
    throw new Error(
      `${observationType} cursor slot ${cursor.slot} does not match transaction slot ${transaction.cursor.slot}`,
    );
  }
  if (cursor.transactionIndex !== transaction.cursor.transactionIndex) {
    throw new Error(
      `${observationType} cursor transaction index ${cursor.transactionIndex} does not match transaction index ${transaction.cursor.transactionIndex}`,
    );
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

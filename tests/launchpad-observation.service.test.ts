import assert from 'node:assert/strict';
import test from 'node:test';
import { LaunchpadObservationError } from '../src/application/launchpad-observation-errors.js';
import { LaunchpadObservationService } from '../src/application/launchpad-observation.service.js';
import { createBondingCurveTradeObservedEvent } from '../src/domain/launchpad-events.js';
import type {
  BondingCurveState,
  ChainConfirmationStatus,
  ChainCursor,
  LaunchpadTrade,
  ObservedChainTransaction,
  QuoteAsset,
  TokenLaunch,
} from '../src/domain/types.js';
import type { LaunchpadAdapter } from '../src/ports/launchpad-adapter.js';
import type {
  LaunchpadEventBatch,
  LaunchpadEventBatchResult,
  LaunchpadEventSink,
} from '../src/ports/launchpad-event-sink.js';

const SOURCE = 'strict-launchpad';
const PROGRAM = 'StrictProgram1111111111111111111111111111111';
const EXISTING_MINT = 'ExistingMint11111111111111111111111111111111';
const SOL: QuoteAsset = Object.freeze({
  mint: 'So11111111111111111111111111111111111111112',
  decimals: 9,
  tokenProgram: 'SPL_TOKEN',
});
const USDC: QuoteAsset = Object.freeze({
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
  tokenProgram: 'SPL_TOKEN',
});

interface StrictTransaction extends ObservedChainTransaction {
  readonly raw: {
    readonly fixture: 'strict-launchpad-transaction';
  };
}

interface MutableStrictTransaction {
  signature: string;
  confirmationStatus: ChainConfirmationStatus;
  blockTimeMs: number | null;
  observedAtMs: number;
  cursor: {
    slot: bigint;
    transactionIndex: number;
  };
  raw: {
    fixture: 'strict-launchpad-transaction';
  };
}

const assertDefaultServiceType = (
  _service: LaunchpadObservationService,
): void => undefined;
void assertDefaultServiceType;

function transactionFixture(
  input: {
    readonly signature?: string;
    readonly confirmationStatus?: ChainConfirmationStatus;
  } = {},
): StrictTransaction {
  return {
    signature: input.signature ?? 'StrictSignature1111111111111111111111111111111',
    confirmationStatus: input.confirmationStatus ?? 'confirmed',
    blockTimeMs: 1_753_700_000_000,
    observedAtMs: 1_753_700_000_500,
    cursor: { slot: 500n, transactionIndex: 2 },
    raw: { fixture: 'strict-launchpad-transaction' },
  };
}

function cursorFixture(
  instructionIndex: number,
  innerInstructionIndex: number | null,
  input: {
    readonly slot?: bigint;
    readonly transactionIndex?: number;
  } = {},
): ChainCursor {
  return {
    slot: input.slot ?? 500n,
    transactionIndex: input.transactionIndex ?? 2,
    instructionIndex,
    innerInstructionIndex,
  };
}

function launchFixture(input: {
  readonly mint: string;
  readonly cursor: ChainCursor;
  readonly quoteAssets?: readonly QuoteAsset[];
}): TokenLaunch {
  return {
    mint: input.mint,
    creator: `Creator-${input.mint}`,
    tokenProgram: 'SPL_TOKEN',
    quoteAssets: input.quoteAssets ?? [SOL],
    launchpad: SOURCE,
    createdAt: input.cursor,
    parameters: { strictFixture: true },
  };
}

function tradeFixture(input: {
  readonly id: string;
  readonly launchMint: string;
  readonly cursor: ChainCursor;
  readonly kind?: 'BUY' | 'SELL';
}): LaunchpadTrade {
  return {
    id: input.id,
    launchMint: input.launchMint,
    kind: input.kind ?? 'BUY',
    trader: `Trader-${input.id}`,
    baseAmountRaw: 1_000_000n,
    quoteAmountRaw: 250_000_000n,
    quoteAsset: SOL,
    cursor: input.cursor,
  };
}

class FakeAdapter implements LaunchpadAdapter<StrictTransaction> {
  public source: string = SOURCE;
  public programId: string = PROGRAM;
  public readonly detectCalls: StrictTransaction[] = [];
  public readonly decodeCalls: {
    readonly transaction: StrictTransaction;
    readonly trackedMints: ReadonlySet<string>;
  }[] = [];
  public detectError: Error | undefined;
  public decodeError: Error | undefined;
  public beforeDecode: (() => void) | undefined;

  public constructor(
    private readonly launches: readonly TokenLaunch[],
    private readonly trades: readonly LaunchpadTrade[],
  ) {}

  public readonly detectLaunches: LaunchpadAdapter<StrictTransaction>['detectLaunches'] =
    async (transaction) => {
      this.detectCalls.push(transaction);
      if (this.detectError !== undefined) throw this.detectError;
      return this.launches;
    };

  public readonly decodeTrades: LaunchpadAdapter<StrictTransaction>['decodeTrades'] =
    async (transaction, trackedMints) => {
      this.beforeDecode?.();
      this.decodeCalls.push({
        transaction,
        trackedMints: new Set(trackedMints),
      });
      if (this.decodeError !== undefined) throw this.decodeError;
      return this.trades;
    };

  public readonly readBondingCurveState: LaunchpadAdapter<StrictTransaction>['readBondingCurveState'] =
    async (_launch): Promise<BondingCurveState> => {
      throw new Error('Not used by the observation service');
    };
}

class RecordingSink implements LaunchpadEventSink {
  public readonly batches: LaunchpadEventBatch[] = [];
  public recordError: Error | undefined;

  public readonly record: LaunchpadEventSink['record'] =
    async (batch): Promise<LaunchpadEventBatchResult> => {
      this.batches.push(batch);
      if (this.recordError !== undefined) throw this.recordError;
      return {
        events: batch.events.map((event) => ({
          eventId: event.id,
          outcome: 'created' as const,
        })),
      };
    };
}

void test('records out-of-order launches once in full-cursor order with their initial transitions', async () => {
  const transaction = transactionFixture();
  const first = launchFixture({
    mint: 'FirstMint111111111111111111111111111111111',
    cursor: cursorFixture(1, null),
    quoteAssets: [SOL, USDC],
  });
  const second = launchFixture({
    mint: 'SecondMint11111111111111111111111111111111',
    cursor: cursorFixture(8, null),
  });
  const adapter = new FakeAdapter([second, first], []);
  const sink = new RecordingSink();
  const service = new LaunchpadObservationService(adapter, sink);
  const alreadyTrackedMints = new Set([EXISTING_MINT]);

  const observation = service.observe(transaction, alreadyTrackedMints);
  alreadyTrackedMints.add('AddedAfterObserve1111111111111111111111111111');
  const result = await observation;

  assert.equal(adapter.detectCalls.length, 1);
  assert.equal(adapter.detectCalls[0], transaction);
  assert.equal(adapter.decodeCalls.length, 1);
  assert.equal(adapter.decodeCalls[0]?.transaction, transaction);
  assert.deepEqual(
    adapter.decodeCalls[0]?.trackedMints,
    new Set([EXISTING_MINT, first.mint, second.mint]),
  );
  assert.equal(sink.batches.length, 1);
  const batch = sink.batches[0];
  assert.ok(batch);
  assert.deepEqual(
    batch.events.map((event) => event.mint),
    [first.mint, second.mint],
  );
  const firstEvent = batch.events[0];
  assert.equal(firstEvent?.type, 'TokenLaunchDetected');
  if (firstEvent?.type !== 'TokenLaunchDetected') {
    assert.fail('Expected the first event to describe a launch');
  }
  assert.deepEqual(firstEvent.payload.launch.quoteAssets, [SOL, USDC]);
  assert.equal(batch.transitions.length, 2);
  assert.deepEqual(
    batch.transitions.map((transition) => transition.triggeringEventId),
    batch.events.map((event) => event.id),
  );
  assert.ok(Object.isFrozen(batch));
  assert.ok(Object.isFrozen(batch.events));
  assert.ok(Object.isFrozen(batch.transitions));
  assert.deepEqual(
    result.events,
    batch.events.map((event) => ({ eventId: event.id, outcome: 'created' })),
  );
});

void test('snapshots launches and observation metadata before a mutating decoder runs', async () => {
  const mutableTransaction: MutableStrictTransaction = {
    signature: 'EntrySignature111111111111111111111111111111',
    confirmationStatus: 'confirmed',
    blockTimeMs: 1_753_710_000_000,
    observedAtMs: 1_753_710_000_500,
    cursor: { slot: 500n, transactionIndex: 2 },
    raw: { fixture: 'strict-launchpad-transaction' },
  };
  const originalLaunchMint = 'StableMint111111111111111111111111111111111';
  const originalCreator = 'StableCreator1111111111111111111111111111111';
  const mutableLaunch = {
    mint: originalLaunchMint,
    creator: originalCreator,
    tokenProgram: 'SPL_TOKEN' as const,
    quoteAssets: [{ ...SOL }],
    launchpad: SOURCE,
    createdAt: {
      slot: 500n,
      transactionIndex: 2,
      instructionIndex: 2,
      innerInstructionIndex: null,
    },
    parameters: { strictFixture: true },
  };
  const adapter = new FakeAdapter([mutableLaunch], []);
  const sink = new RecordingSink();
  const recordFailure = new Error('record failed after mutation');
  sink.recordError = recordFailure;
  adapter.beforeDecode = () => {
    mutableLaunch.mint = 'MutatedMint11111111111111111111111111111111';
    mutableLaunch.creator = 'MutatedCreator1111111111111111111111111111';
    const mutableQuoteAsset = mutableLaunch.quoteAssets[0];
    assert.ok(mutableQuoteAsset);
    mutableQuoteAsset.mint = 'MutatedQuote111111111111111111111111111111111';
    mutableLaunch.createdAt.instructionIndex = 99;
    adapter.source = 'mutated-source';
    adapter.programId = 'MutatedProgram111111111111111111111111111111';
    mutableTransaction.signature = 'MutatedSignature1111111111111111111111111111';
    mutableTransaction.confirmationStatus = 'orphaned';
    mutableTransaction.blockTimeMs = null;
    mutableTransaction.observedAtMs = 9_999_999_999_999;
    mutableTransaction.cursor.slot = 999n;
    mutableTransaction.cursor.transactionIndex = 99;
  };

  await assert.rejects(
    new LaunchpadObservationService(adapter, sink).observe(
      mutableTransaction,
      new Set([EXISTING_MINT]),
    ),
    (error: unknown) => {
      assert.ok(error instanceof LaunchpadObservationError);
      assert.equal(error.stage, 'record_batch');
      assert.equal(error.source, SOURCE);
      assert.equal(error.program, PROGRAM);
      assert.equal(error.signature, 'EntrySignature111111111111111111111111111111');
      assert.equal(error.cause, recordFailure);
      return true;
    },
  );

  assert.deepEqual(
    adapter.decodeCalls[0]?.trackedMints,
    new Set([EXISTING_MINT, originalLaunchMint]),
  );
  const batch = sink.batches[0];
  assert.ok(batch);
  assert.equal(batch.source, SOURCE);
  assert.equal(batch.program, PROGRAM);
  assert.equal(batch.signature, 'EntrySignature111111111111111111111111111111');
  assert.equal(batch.confirmationStatus, 'confirmed');
  const event = batch.events[0];
  assert.equal(event?.type, 'TokenLaunchDetected');
  if (event?.type !== 'TokenLaunchDetected') {
    assert.fail('Expected a launch event');
  }
  assert.equal(event.source, SOURCE);
  assert.equal(event.program, PROGRAM);
  assert.equal(event.signature, 'EntrySignature111111111111111111111111111111');
  assert.equal(event.confirmationStatus, 'confirmed');
  assert.equal(event.blockchainTimeMs, 1_753_710_000_000);
  assert.equal(event.observedAtMs, 1_753_710_000_500);
  assert.equal(event.payload.launch.mint, originalLaunchMint);
  assert.equal(event.payload.launch.creator, originalCreator);
  assert.equal(event.payload.launch.quoteAssets[0]?.mint, SOL.mint);
  assert.equal(event.payload.launch.createdAt.instructionIndex, 2);
});

void test('orders a launch before its initial buy at an identical cursor', async () => {
  const transaction = transactionFixture();
  const cursor = cursorFixture(3, null);
  const launch = launchFixture({
    mint: 'LaunchAndBuyMint11111111111111111111111111111',
    cursor,
  });
  const trade = tradeFixture({
    id: 'initial-buy',
    launchMint: launch.mint,
    cursor,
  });
  const adapter = new FakeAdapter([launch], [trade]);
  const sink = new RecordingSink();

  await new LaunchpadObservationService(adapter, sink).observe(transaction, new Set());

  assert.deepEqual(
    sink.batches[0]?.events.map((event) => event.type),
    ['TokenLaunchDetected', 'BondingCurveTradeObserved'],
  );
});

void test('sorts outer and inner trades by the complete cursor', async () => {
  const transaction = transactionFixture();
  const mint = 'TrackedTradeMint111111111111111111111111111111';
  const instructionFourInner = tradeFixture({
    id: 'instruction-four-inner',
    launchMint: mint,
    cursor: cursorFixture(4, 7),
  });
  const instructionFiveOuter = tradeFixture({
    id: 'instruction-five-outer',
    launchMint: mint,
    cursor: cursorFixture(5, null),
  });
  const instructionFiveInnerZero = tradeFixture({
    id: 'instruction-five-inner-zero',
    launchMint: mint,
    cursor: cursorFixture(5, 0),
  });
  const instructionFiveInnerOne = tradeFixture({
    id: 'instruction-five-inner-one',
    launchMint: mint,
    cursor: cursorFixture(5, 1),
  });
  const tiedTradeA = tradeFixture({
    id: 'tied-trade-a',
    launchMint: 'TiedMintA11111111111111111111111111111111111',
    cursor: cursorFixture(6, null),
  });
  const tiedTradeB = tradeFixture({
    id: 'tied-trade-b',
    launchMint: 'TiedMintB11111111111111111111111111111111111',
    cursor: cursorFixture(6, null),
  });
  const tiedTradesByEventId = [tiedTradeA, tiedTradeB]
    .map((trade) => ({
      trade,
      event: createBondingCurveTradeObservedEvent({
        source: SOURCE,
        program: PROGRAM,
        transaction,
        trade,
      }),
    }))
    .sort((left, right) => {
      if (left.event.id < right.event.id) return -1;
      if (left.event.id > right.event.id) return 1;
      return 0;
    });
  const nextInstruction = tradeFixture({
    id: 'next-instruction',
    launchMint: mint,
    cursor: cursorFixture(7, null),
  });
  const adapter = new FakeAdapter([], [
    nextInstruction,
    ...[...tiedTradesByEventId].reverse().map(({ trade }) => trade),
    instructionFiveInnerOne,
    instructionFiveInnerZero,
    instructionFiveOuter,
    instructionFourInner,
  ]);
  const sink = new RecordingSink();

  await new LaunchpadObservationService(adapter, sink).observe(
    transaction,
    new Set([mint, tiedTradeA.launchMint, tiedTradeB.launchMint]),
  );

  assert.deepEqual(
    sink.batches[0]?.events.map((event) =>
      event.type === 'BondingCurveTradeObserved' ? event.payload.trade.id : event.type),
    [
      instructionFourInner.id,
      instructionFiveOuter.id,
      instructionFiveInnerZero.id,
      instructionFiveInnerOne.id,
      ...tiedTradesByEventId.map(({ trade }) => trade.id),
      nextInstruction.id,
    ],
  );
});

void test('returns a frozen empty result without recording while still running both adapter passes', async () => {
  const transaction = transactionFixture();
  const adapter = new FakeAdapter([], []);
  const sink = new RecordingSink();
  const service = new LaunchpadObservationService(adapter, sink);

  const result = await service.observe(transaction, new Set([EXISTING_MINT]));

  assert.equal(adapter.detectCalls.length, 1);
  assert.equal(adapter.decodeCalls.length, 1);
  assert.deepEqual(adapter.decodeCalls[0]?.trackedMints, new Set([EXISTING_MINT]));
  assert.equal(sink.batches.length, 0);
  assert.deepEqual(result, { events: [] });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.events));
});

void test('records adapter and transaction metadata on the complete batch', async () => {
  const transaction = transactionFixture({
    signature: 'MetadataSignature11111111111111111111111111111',
    confirmationStatus: 'finalized',
  });
  const mint = 'MetadataMint111111111111111111111111111111111';
  const trade = tradeFixture({
    id: 'metadata-trade',
    launchMint: mint,
    cursor: cursorFixture(6, 0),
  });
  const adapter = new FakeAdapter([], [trade]);
  const sink = new RecordingSink();

  await new LaunchpadObservationService(adapter, sink).observe(
    transaction,
    new Set([mint]),
  );

  const batch = sink.batches[0];
  assert.ok(batch);
  assert.equal(batch.source, adapter.source);
  assert.equal(batch.program, adapter.programId);
  assert.equal(batch.signature, transaction.signature);
  assert.equal(batch.confirmationStatus, transaction.confirmationStatus);
  assert.equal(batch.events.length, 1);
  assert.equal(batch.transitions.length, 0);
});

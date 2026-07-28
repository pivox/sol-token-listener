import assert from 'node:assert/strict';
import test from 'node:test';
import { LaunchpadObservationError } from '../src/application/launchpad-observation-errors.js';
import { LaunchpadObservationService } from '../src/application/launchpad-observation.service.js';
import { InvalidChainCursorError } from '../src/domain/cursor.js';
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
  public beforeDecode: ((trackedMints: ReadonlySet<string>) => void) | undefined;

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
      this.beforeDecode?.(trackedMints);
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

void test('replays deterministic IDs across finality changes', async () => {
  const signature = 'ReplaySignature111111111111111111111111111111';
  const processedTransaction: StrictTransaction = {
    ...transactionFixture({ signature, confirmationStatus: 'processed' }),
    blockTimeMs: null,
    observedAtMs: 1_753_720_000_000,
  };
  const finalizedTransaction: StrictTransaction = {
    ...transactionFixture({ signature, confirmationStatus: 'finalized' }),
    blockTimeMs: 1_753_719_999_000,
    observedAtMs: 1_753_720_999_000,
  };
  const mint = 'ReplayMint1111111111111111111111111111111111';
  const launch = launchFixture({
    mint,
    cursor: cursorFixture(1, null),
  });
  const trade = tradeFixture({
    id: 'replayed-trade',
    launchMint: mint,
    cursor: cursorFixture(2, 0),
  });
  const processedSink = new RecordingSink();
  const finalizedSink = new RecordingSink();

  await new LaunchpadObservationService(
    new FakeAdapter([launch], [trade]),
    processedSink,
  ).observe(processedTransaction, new Set());
  await new LaunchpadObservationService(
    new FakeAdapter([launch], [trade]),
    finalizedSink,
  ).observe(finalizedTransaction, new Set());

  const processedBatch = processedSink.batches[0];
  const finalizedBatch = finalizedSink.batches[0];
  assert.ok(processedBatch);
  assert.ok(finalizedBatch);
  assert.deepEqual(
    processedBatch.events.map((event) => event.id),
    finalizedBatch.events.map((event) => event.id),
  );
  assert.deepEqual(
    processedBatch.transitions.map((transition) => transition.id),
    finalizedBatch.transitions.map((transition) => transition.id),
  );
  assert.equal(processedBatch.confirmationStatus, 'processed');
  assert.equal(finalizedBatch.confirmationStatus, 'finalized');
  for (const event of processedBatch.events) {
    assert.equal(event.confirmationStatus, 'processed');
    assert.equal(event.blockchainTimeMs, null);
    assert.equal(event.observedAtMs, 1_753_720_000_000);
  }
  for (const event of finalizedBatch.events) {
    assert.equal(event.confirmationStatus, 'finalized');
    assert.equal(event.blockchainTimeMs, 1_753_719_999_000);
    assert.equal(event.observedAtMs, 1_753_720_999_000);
  }
  assert.equal(processedBatch.events.length, 2);
  assert.equal(processedBatch.transitions.length, 1);
  assert.equal(processedSink.batches.length, 1);
  assert.equal(finalizedSink.batches.length, 1);
});

void test('collapses identical launch definitions while preserving every quote asset exactly', async () => {
  const launch = launchFixture({
    mint: 'MultiQuoteMint1111111111111111111111111111111',
    cursor: cursorFixture(1, null),
    quoteAssets: [SOL, USDC],
  });
  const duplicate = {
    ...launch,
    quoteAssets: launch.quoteAssets.map((quoteAsset) => ({ ...quoteAsset })),
    createdAt: { ...launch.createdAt },
    parameters: { ...launch.parameters },
  };
  const adapter = new FakeAdapter([launch, duplicate], []);
  const sink = new RecordingSink();

  await new LaunchpadObservationService(adapter, sink).observe(
    transactionFixture(),
    new Set(),
  );

  assert.equal(adapter.detectCalls.length, 1);
  assert.equal(adapter.decodeCalls.length, 1);
  assert.equal(sink.batches.length, 1);
  const batch = sink.batches[0];
  assert.ok(batch);
  assert.equal(batch.events.length, 1);
  assert.equal(batch.transitions.length, 1);
  const event = batch.events[0];
  assert.equal(event?.type, 'TokenLaunchDetected');
  if (event?.type !== 'TokenLaunchDetected') {
    assert.fail('Expected one normalized launch event');
  }
  assert.deepEqual(event.payload.launch.quoteAssets, [SOL, USDC]);
});

void test('collapses launch definitions whose parameters differ only by 0 and -0', async () => {
  const launch = {
    ...launchFixture({
      mint: 'CanonicalZeroMint11111111111111111111111111111',
      cursor: cursorFixture(1, null),
    }),
    parameters: { initialVirtualReserve: 0 },
  };
  const duplicate = {
    ...launch,
    createdAt: { ...launch.createdAt },
    parameters: { initialVirtualReserve: -0 },
  };
  const adapter = new FakeAdapter([launch, duplicate], []);
  const sink = new RecordingSink();

  await new LaunchpadObservationService(adapter, sink).observe(
    transactionFixture(),
    new Set(),
  );

  const batch = sink.batches[0];
  assert.ok(batch);
  assert.equal(batch.events.length, 1);
  const event = batch.events[0];
  assert.equal(event?.type, 'TokenLaunchDetected');
  if (event?.type !== 'TokenLaunchDetected') {
    assert.fail('Expected one normalized launch event');
  }
  assert.equal(event.payload.launch.parameters.initialVirtualReserve, 0);
  assert.equal(
    Object.is(event.payload.launch.parameters.initialVirtualReserve, -0),
    false,
  );
});

void test('rejette les curseurs non canoniques à la bonne étape sans appel ultérieur', async (t) => {
  await t.test('transaction before detection', async () => {
    const adapter = new FakeAdapter([], []);
    const sink = new RecordingSink();
    const transaction: StrictTransaction = {
      ...transactionFixture(),
      cursor: { slot: 500n, transactionIndex: -0 },
    };

    await assert.rejects(
      new LaunchpadObservationService(adapter, sink).observe(
        transaction,
        new Set(),
      ),
      (error: unknown) => {
        assert.ok(error instanceof LaunchpadObservationError);
        assert.equal(error.stage, 'validate_batch');
        assert.ok(error.cause instanceof InvalidChainCursorError);
        assert.equal(error.cause.field, 'transactionIndex');
        assert.equal(Object.is(error.cause.value, -0), true);
        return true;
      },
    );

    assert.equal(adapter.detectCalls.length, 0);
    assert.equal(adapter.decodeCalls.length, 0);
    assert.equal(sink.batches.length, 0);
  });

  await t.test('launch before trade decoding', async () => {
    const invalidLaunch = launchFixture({
      mint: 'InvalidCursorLaunch111111111111111111111111111',
      cursor: cursorFixture(-0, null),
    });
    const adapter = new FakeAdapter([invalidLaunch], []);
    const sink = new RecordingSink();

    await assert.rejects(
      new LaunchpadObservationService(adapter, sink).observe(
        transactionFixture(),
        new Set(),
      ),
      (error: unknown) => {
        assert.ok(error instanceof LaunchpadObservationError);
        assert.equal(error.stage, 'validate_batch');
        assert.ok(error.cause instanceof InvalidChainCursorError);
        assert.equal(error.cause.field, 'instructionIndex');
        return true;
      },
    );

    assert.equal(adapter.detectCalls.length, 1);
    assert.equal(adapter.decodeCalls.length, 0);
    assert.equal(sink.batches.length, 0);
  });

  await t.test('trade before recording', async () => {
    const trackedMint = 'InvalidCursorTradeMint111111111111111111111111';
    const invalidTrade = tradeFixture({
      id: 'invalid-cursor-trade',
      launchMint: trackedMint,
      cursor: cursorFixture(2, Number.NaN),
    });
    const adapter = new FakeAdapter([], [invalidTrade]);
    const sink = new RecordingSink();

    await assert.rejects(
      new LaunchpadObservationService(adapter, sink).observe(
        transactionFixture(),
        new Set([trackedMint]),
      ),
      (error: unknown) => {
        assert.ok(error instanceof LaunchpadObservationError);
        assert.equal(error.stage, 'validate_batch');
        assert.ok(error.cause instanceof InvalidChainCursorError);
        assert.equal(error.cause.field, 'innerInstructionIndex');
        return true;
      },
    );

    assert.equal(adapter.detectCalls.length, 1);
    assert.equal(adapter.decodeCalls.length, 1);
    assert.equal(sink.batches.length, 0);
  });
});

void test('rejects invalid launch definitions before trade decoding or recording', async (t) => {
  const invalidCases: readonly {
    readonly name: string;
    readonly launches: readonly TokenLaunch[];
    readonly causePattern: RegExp;
  }[] = [
    {
      name: 'launch cursor from another slot',
      launches: [
        launchFixture({
          mint: 'WrongSlotMint111111111111111111111111111111',
          cursor: cursorFixture(1, null, { slot: 501n }),
        }),
      ],
      causePattern: /slot/i,
    },
    {
      name: 'launch without a quote asset',
      launches: [
        launchFixture({
          mint: 'NoQuoteMint1111111111111111111111111111111',
          cursor: cursorFixture(1, null),
          quoteAssets: [],
        }),
      ],
      causePattern: /quote asset/i,
    },
    {
      name: 'conflicting definitions for one mint',
      launches: [
        launchFixture({
          mint: 'ConflictingMint11111111111111111111111111111',
          cursor: cursorFixture(1, null),
        }),
        {
          ...launchFixture({
            mint: 'ConflictingMint11111111111111111111111111111',
            cursor: cursorFixture(1, null),
          }),
          creator: 'DifferentCreator1111111111111111111111111111',
        },
      ],
      causePattern: /conflicting.*mint/i,
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, async () => {
      const adapter = new FakeAdapter(invalidCase.launches, []);
      const sink = new RecordingSink();

      await assert.rejects(
        new LaunchpadObservationService(adapter, sink).observe(
          transactionFixture(),
          new Set(),
        ),
        (error: unknown) => {
          assert.ok(error instanceof LaunchpadObservationError);
          assert.equal(error.stage, 'validate_batch');
          assert.ok(error.cause instanceof Error);
          assert.match(error.cause.message, invalidCase.causePattern);
          return true;
        },
      );

      assert.equal(adapter.detectCalls.length, 1);
      assert.equal(adapter.decodeCalls.length, 0);
      assert.equal(sink.batches.length, 0);
    });
  }
});

void test('rejects invalid or duplicate trades before recording', async (t) => {
  const trackedMint = 'TrackedValidationMint11111111111111111111111111';
  const invalidCases: readonly {
    readonly name: string;
    readonly trackedMints: ReadonlySet<string>;
    readonly trades: readonly LaunchpadTrade[];
    readonly causePattern: RegExp;
  }[] = [
    {
      name: 'trade cursor from another transaction index',
      trackedMints: new Set([trackedMint]),
      trades: [
        tradeFixture({
          id: 'wrong-transaction-index',
          launchMint: trackedMint,
          cursor: cursorFixture(2, null, { transactionIndex: 3 }),
        }),
      ],
      causePattern: /transaction index/i,
    },
    {
      name: 'trade for an untracked mint',
      trackedMints: new Set(),
      trades: [
        tradeFixture({
          id: 'untracked-trade',
          launchMint: 'UntrackedMint111111111111111111111111111111',
          cursor: cursorFixture(2, null),
        }),
      ],
      causePattern: /untracked.*mint/i,
    },
    {
      name: 'two logical trades with one deterministic event ID',
      trackedMints: new Set([trackedMint]),
      trades: [
        tradeFixture({
          id: 'adapter-trade-a',
          launchMint: trackedMint,
          cursor: cursorFixture(2, null),
        }),
        tradeFixture({
          id: 'adapter-trade-b',
          launchMint: trackedMint,
          cursor: cursorFixture(2, null),
        }),
      ],
      causePattern: /duplicate.*event id/i,
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, async () => {
      const adapter = new FakeAdapter([], invalidCase.trades);
      const sink = new RecordingSink();

      await assert.rejects(
        new LaunchpadObservationService(adapter, sink).observe(
          transactionFixture(),
          invalidCase.trackedMints,
        ),
        (error: unknown) => {
          assert.ok(error instanceof LaunchpadObservationError);
          assert.equal(error.stage, 'validate_batch');
          assert.ok(error.cause instanceof Error);
          assert.match(error.cause.message, invalidCase.causePattern);
          return true;
        },
      );

      assert.equal(adapter.detectCalls.length, 1);
      assert.equal(adapter.decodeCalls.length, 1);
      assert.equal(sink.batches.length, 0);
    });
  }
});

void test('keeps the authoritative tracked mints isolated from a malicious decoder', async () => {
  const injectedMint = 'InjectedMint1111111111111111111111111111111';
  const adapter = new FakeAdapter([], [
    tradeFixture({
      id: 'injected-trade',
      launchMint: injectedMint,
      cursor: cursorFixture(2, null),
    }),
  ]);
  adapter.beforeDecode = (trackedMints) => {
    (trackedMints as Set<string>).add(injectedMint);
  };
  const sink = new RecordingSink();

  await assert.rejects(
    new LaunchpadObservationService(adapter, sink).observe(
      transactionFixture(),
      new Set([EXISTING_MINT]),
    ),
    (error: unknown) => {
      assert.ok(error instanceof LaunchpadObservationError);
      assert.equal(error.stage, 'validate_batch');
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /untracked.*mint/i);
      return true;
    },
  );

  assert.equal(adapter.decodeCalls.length, 1);
  assert.ok(adapter.decodeCalls[0]?.trackedMints.has(injectedMint));
  assert.equal(sink.batches.length, 0);
});

void test('preserves stage causes and makes no later calls after a failed stage', async (t) => {
  await t.test('detect failure', async () => {
    const adapter = new FakeAdapter([], []);
    const cause = new Error('detect failed');
    adapter.detectError = cause;
    const sink = new RecordingSink();

    await assert.rejects(
      new LaunchpadObservationService(adapter, sink).observe(
        transactionFixture(),
        new Set(),
      ),
      (error: unknown) => {
        assert.ok(error instanceof LaunchpadObservationError);
        assert.equal(error.stage, 'detect_launches');
        assert.equal(error.cause, cause);
        return true;
      },
    );

    assert.equal(adapter.detectCalls.length, 1);
    assert.equal(adapter.decodeCalls.length, 0);
    assert.equal(sink.batches.length, 0);
  });

  await t.test('decode failure', async () => {
    const adapter = new FakeAdapter([], []);
    const cause = new Error('decode failed');
    adapter.decodeError = cause;
    const sink = new RecordingSink();

    await assert.rejects(
      new LaunchpadObservationService(adapter, sink).observe(
        transactionFixture(),
        new Set(),
      ),
      (error: unknown) => {
        assert.ok(error instanceof LaunchpadObservationError);
        assert.equal(error.stage, 'decode_trades');
        assert.equal(error.cause, cause);
        return true;
      },
    );

    assert.equal(adapter.detectCalls.length, 1);
    assert.equal(adapter.decodeCalls.length, 1);
    assert.equal(sink.batches.length, 0);
  });

  await t.test('validation failure', async () => {
    const adapter = new FakeAdapter([], [
      tradeFixture({
        id: 'untracked',
        launchMint: 'UntrackedStageMint111111111111111111111111111',
        cursor: cursorFixture(2, null),
      }),
    ]);
    const sink = new RecordingSink();

    await assert.rejects(
      new LaunchpadObservationService(adapter, sink).observe(
        transactionFixture(),
        new Set(),
      ),
      (error: unknown) => {
        assert.ok(error instanceof LaunchpadObservationError);
        assert.equal(error.stage, 'validate_batch');
        return true;
      },
    );

    assert.equal(sink.batches.length, 0);
  });

  await t.test('sink failure', async () => {
    const mint = 'SinkFailureMint111111111111111111111111111111';
    const adapter = new FakeAdapter([
      launchFixture({ mint, cursor: cursorFixture(1, null) }),
    ], []);
    const cause = new Error('record failed');
    const sink = new RecordingSink();
    sink.recordError = cause;

    await assert.rejects(
      new LaunchpadObservationService(adapter, sink).observe(
        transactionFixture(),
        new Set(),
      ),
      (error: unknown) => {
        assert.ok(error instanceof LaunchpadObservationError);
        assert.equal(error.stage, 'record_batch');
        assert.equal(error.cause, cause);
        return true;
      },
    );

    assert.equal(sink.batches.length, 1);
  });
});

void test('preserves a matching observation error at each external boundary', async (t) => {
  const transaction = transactionFixture();

  await t.test('detection', async () => {
    const rootCause = new Error('typed detect root cause');
    const boundaryError = new LaunchpadObservationError(
      'detect_launches',
      SOURCE,
      PROGRAM,
      transaction.signature,
      rootCause,
    );
    const adapter = new FakeAdapter([], []);
    adapter.detectError = boundaryError;

    await assert.rejects(
      new LaunchpadObservationService(adapter, new RecordingSink()).observe(
        transaction,
        new Set(),
      ),
      (error: unknown) => {
        assert.equal(error, boundaryError);
        assert.equal(boundaryError.stage, 'detect_launches');
        assert.equal(boundaryError.cause, rootCause);
        return true;
      },
    );
  });

  await t.test('decoding', async () => {
    const rootCause = new Error('typed decode root cause');
    const boundaryError = new LaunchpadObservationError(
      'decode_trades',
      SOURCE,
      PROGRAM,
      transaction.signature,
      rootCause,
    );
    const adapter = new FakeAdapter([], []);
    adapter.decodeError = boundaryError;

    await assert.rejects(
      new LaunchpadObservationService(adapter, new RecordingSink()).observe(
        transaction,
        new Set(),
      ),
      (error: unknown) => {
        assert.equal(error, boundaryError);
        assert.equal(boundaryError.stage, 'decode_trades');
        assert.equal(boundaryError.cause, rootCause);
        return true;
      },
    );
  });

  await t.test('recording', async () => {
    const rootCause = new Error('typed record root cause');
    const boundaryError = new LaunchpadObservationError(
      'record_batch',
      SOURCE,
      PROGRAM,
      transaction.signature,
      rootCause,
    );
    const mint = 'TypedRecordFailureMint11111111111111111111111111';
    const adapter = new FakeAdapter([
      launchFixture({ mint, cursor: cursorFixture(1, null) }),
    ], []);
    const sink = new RecordingSink();
    sink.recordError = boundaryError;

    await assert.rejects(
      new LaunchpadObservationService(adapter, sink).observe(
        transaction,
        new Set(),
      ),
      (error: unknown) => {
        assert.equal(error, boundaryError);
        assert.equal(boundaryError.stage, 'record_batch');
        assert.equal(boundaryError.cause, rootCause);
        return true;
      },
    );
  });
});

void test('wraps a mismatched typed error with trustworthy current boundary context', async () => {
  const transaction = transactionFixture();
  const foreignError = new LaunchpadObservationError(
    'record_batch',
    SOURCE,
    PROGRAM,
    'SpoofedSignature11111111111111111111111111111',
    new Error('foreign root cause'),
  );
  const adapter = new FakeAdapter([], []);
  adapter.detectError = foreignError;

  await assert.rejects(
    new LaunchpadObservationService(adapter, new RecordingSink()).observe(
      transaction,
      new Set(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof LaunchpadObservationError);
      assert.notEqual(error, foreignError);
      assert.equal(error.stage, 'detect_launches');
      assert.equal(error.source, SOURCE);
      assert.equal(error.program, PROGRAM);
      assert.equal(error.signature, transaction.signature);
      assert.equal(error.cause, foreignError);
      return true;
    },
  );
});

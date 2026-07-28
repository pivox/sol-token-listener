import assert from 'node:assert/strict';
import test from 'node:test';
import { createTokenLaunchDetectedEvent } from '../src/domain/launchpad-events.js';
import { createInitialDetectedTransition } from '../src/domain/state-transitions.js';
import type {
  LaunchpadEventBatch,
  LaunchpadEventSink,
} from '../src/ports/launchpad-event-sink.js';
import type { LaunchpadAdapter } from '../src/ports/launchpad-adapter.js';
import type {
  BondingCurveState,
  ObservedChainTransaction,
  TokenLaunch,
} from '../src/domain/types.js';

interface DecodedTransaction extends ObservedChainTransaction {
  readonly decodedProgram: 'pumpfun';
}

const launch: TokenLaunch = {
  mint: 'Mint111111111111111111111111111111111111111',
  creator: 'Creator111111111111111111111111111111111111',
  tokenProgram: 'SPL_TOKEN',
  quoteAssets: [],
  launchpad: 'pumpfun',
  createdAt: {
    slot: 1n,
    transactionIndex: 0,
    instructionIndex: 0,
    innerInstructionIndex: null,
  },
  parameters: {},
};

const bondingCurveState: BondingCurveState = {
  launchMint: launch.mint,
  quoteAsset: {
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    tokenProgram: 'SPL_TOKEN',
  },
  realBaseReservesRaw: 0n,
  realQuoteReservesRaw: 0n,
  virtualBaseReservesRaw: 0n,
  virtualQuoteReservesRaw: 0n,
  progressBps: 0n,
  complete: false,
  observedSlot: 1n,
};

const adapter: LaunchpadAdapter<DecodedTransaction> = {
  source: 'pumpfun',
  programId: 'Pump111111111111111111111111111111111111111',
  async detectLaunches(transaction) {
    assert.equal(transaction.decodedProgram, 'pumpfun');
    return [launch];
  },
  async decodeTrades(transaction) {
    assert.equal(transaction.decodedProgram, 'pumpfun');
    return [];
  },
  async readBondingCurveState(input) {
    assert.equal(input, launch);
    return bondingCurveState;
  },
};

// @ts-expect-error A decoded-only adapter cannot consume every observed transaction.
const broadlyTypedAdapter: LaunchpadAdapter = adapter;
void broadlyTypedAdapter;

class Sink implements LaunchpadEventSink {
  public readonly record = async (batch: Parameters<LaunchpadEventSink['record']>[0]) => {
    return { events: batch.events.map((event) => ({ eventId: event.id, outcome: 'created' as const })) };
  };
}

type FinalizedBatch = LaunchpadEventBatch & { readonly confirmationStatus: 'finalized' };

const finalizedOnlySink = {
  async record(batch: FinalizedBatch) {
    return { events: batch.events.map((event) => ({ eventId: event.id, outcome: 'created' as const })) };
  },
};

// @ts-expect-error A sink must accept every valid confirmation status.
const universallyUsableSink: LaunchpadEventSink = finalizedOnlySink;
void universallyUsableSink;

void test('accepts specialized adapter transactions and retains its complete contract', async () => {
  const transaction: DecodedTransaction = {
    signature: 'signature',
    confirmationStatus: 'processed',
    blockTimeMs: null,
    observedAtMs: 1,
    cursor: { slot: 1n, transactionIndex: 0 },
    raw: null,
    decodedProgram: 'pumpfun',
  };

  assert.equal(adapter.source, 'pumpfun');
  assert.equal(adapter.programId, 'Pump111111111111111111111111111111111111111');
  assert.deepEqual(await adapter.detectLaunches(transaction), [launch]);
  assert.deepEqual(await adapter.decodeTrades(transaction, new Set()), []);
  assert.equal(await adapter.readBondingCurveState(launch), bondingCurveState);
});

void test('accepts an empty processed event-batch contract', async () => {
  const batch: LaunchpadEventBatch = {
    source: 'pumpfun',
    program: 'Pump111111111111111111111111111111111111111',
    signature: 'signature',
    confirmationStatus: 'processed',
    events: [],
    transitions: [],
  };

  const result = await new Sink().record(batch);

  assert.deepEqual(result, { events: [] });
});

void test('preserves input event identity and order in the event-batch result shape', async () => {
  const transaction: DecodedTransaction = {
    signature: 'non-empty-signature',
    confirmationStatus: 'processed',
    blockTimeMs: null,
    observedAtMs: 2,
    cursor: { slot: 2n, transactionIndex: 0 },
    raw: null,
    decodedProgram: 'pumpfun',
  };
  const event = createTokenLaunchDetectedEvent({
    source: adapter.source,
    program: adapter.programId,
    transaction,
    launch,
  });
  const result = await new Sink().record({
    source: adapter.source,
    program: adapter.programId,
    signature: transaction.signature,
    confirmationStatus: transaction.confirmationStatus,
    events: [event],
    transitions: [createInitialDetectedTransition(event)],
  });

  assert.deepEqual(result.events, [{ eventId: event.id, outcome: 'created' }]);
});

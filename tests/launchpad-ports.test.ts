import assert from 'node:assert/strict';
import test from 'node:test';
import { createTokenLaunchDetectedEvent } from '../src/domain/launchpad-events.js';
import { createInitialDetectedTransition } from '../src/domain/state-transitions.js';
import {
  assertValidLaunchpadEventBatch,
  InvalidLaunchpadEventBatchError,
} from '../src/ports/launchpad-event-sink.js';
import type {
  LaunchpadEventBatch,
  LaunchpadEventSink,
  StateTransitionBatchAction,
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

const applyAction: StateTransitionBatchAction = 'apply';
const retractAction: StateTransitionBatchAction = 'retract';
// @ts-expect-error State-transition batches accept only apply or retract.
const invalidAction: StateTransitionBatchAction = 'replace';
void invalidAction;

// @ts-expect-error A finalized batch cannot request transition retraction.
const finalizedRetractBatch: LaunchpadEventBatch = {
  source: 'pumpfun',
  program: 'Pump111111111111111111111111111111111111111',
  signature: 'signature',
  confirmationStatus: 'finalized',
  events: [],
  stateTransitionAction: 'retract',
  transitions: [],
};
void finalizedRetractBatch;

// @ts-expect-error An orphaned batch cannot request transition application.
const orphanedApplyBatch: LaunchpadEventBatch = {
  source: 'pumpfun',
  program: 'Pump111111111111111111111111111111111111111',
  signature: 'signature',
  confirmationStatus: 'orphaned',
  events: [],
  stateTransitionAction: 'apply',
  transitions: [],
};
void orphanedApplyBatch;

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
    stateTransitionAction: applyAction,
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
    confirmationStatus: 'processed',
    events: [event],
    stateTransitionAction: applyAction,
    transitions: [createInitialDetectedTransition(event)],
  });

  assert.equal(retractAction, 'retract');
  assert.deepEqual(result.events, [{ eventId: event.id, outcome: 'created' }]);
});

void test('makes retract batches empty at compile time', () => {
  const transaction: DecodedTransaction = {
    signature: 'orphaned-signature',
    confirmationStatus: 'orphaned',
    blockTimeMs: null,
    observedAtMs: 3,
    cursor: { slot: 3n, transactionIndex: 0 },
    raw: null,
    decodedProgram: 'pumpfun',
  };
  const event = createTokenLaunchDetectedEvent({
    source: adapter.source,
    program: adapter.programId,
    transaction,
    launch: {
      ...launch,
      createdAt: {
        ...launch.createdAt,
        slot: transaction.cursor.slot,
        transactionIndex: transaction.cursor.transactionIndex,
      },
    },
  });
  const transition = createInitialDetectedTransition(event);

  // @ts-expect-error A retract batch carries an exactly empty transition tuple.
  const invalidRetractBatch: LaunchpadEventBatch = {
    source: adapter.source,
    program: adapter.programId,
    signature: transaction.signature,
    confirmationStatus: 'orphaned',
    events: [event],
    stateTransitionAction: 'retract',
    transitions: [transition],
  };
  void invalidRetractBatch;
});

void test('runtime validation rejects contradictory action and status combinations', () => {
  const shared = {
    source: adapter.source,
    program: adapter.programId,
    signature: 'invalid-shape-signature',
    events: [],
    transitions: [],
  };
  for (const invalid of [
    {
      ...shared,
      confirmationStatus: 'finalized',
      stateTransitionAction: 'retract',
    },
    {
      ...shared,
      confirmationStatus: 'orphaned',
      stateTransitionAction: 'apply',
    },
    {
      ...shared,
      confirmationStatus: 'orphaned',
      stateTransitionAction: 'retract',
      transitions: [{}],
    },
    {
      ...shared,
      confirmationStatus: 'processed',
      stateTransitionAction: 'replace',
    },
  ]) {
    assert.throws(
      () => {
        assertValidLaunchpadEventBatch(
          invalid as unknown as LaunchpadEventBatch,
        );
      },
      InvalidLaunchpadEventBatchError,
    );
  }
});

void test('runtime validation rejects event metadata that differs from its batch', () => {
  const transaction: DecodedTransaction = {
    signature: 'metadata-signature',
    confirmationStatus: 'processed',
    blockTimeMs: null,
    observedAtMs: 4,
    cursor: { slot: 4n, transactionIndex: 0 },
    raw: null,
    decodedProgram: 'pumpfun',
  };
  const event = createTokenLaunchDetectedEvent({
    source: adapter.source,
    program: adapter.programId,
    transaction,
    launch: {
      ...launch,
      createdAt: {
        ...launch.createdAt,
        slot: transaction.cursor.slot,
        transactionIndex: transaction.cursor.transactionIndex,
      },
    },
  });
  const transition = createInitialDetectedTransition(event);
  const validBatch = {
    source: event.source,
    program: event.program,
    signature: event.signature,
    confirmationStatus: event.confirmationStatus,
    events: [event],
    stateTransitionAction: 'apply',
    transitions: [transition],
  } as const;

  for (const mismatchedEvent of [
    { ...event, source: 'other-source' },
    { ...event, program: 'OtherProgram11111111111111111111111111111111' },
    { ...event, signature: 'other-signature' },
    { ...event, confirmationStatus: 'confirmed' as const },
  ]) {
    assert.throws(
      () => {
        assertValidLaunchpadEventBatch({
          ...validBatch,
          events: [mismatchedEvent],
        } as unknown as LaunchpadEventBatch);
      },
      InvalidLaunchpadEventBatchError,
    );
  }
});

void test('runtime validation rejects missing, outside, mismatched, or duplicate launch transitions', () => {
  const transaction: DecodedTransaction = {
    signature: 'transition-signature',
    confirmationStatus: 'confirmed',
    blockTimeMs: 5,
    observedAtMs: 6,
    cursor: { slot: 5n, transactionIndex: 0 },
    raw: null,
    decodedProgram: 'pumpfun',
  };
  const event = createTokenLaunchDetectedEvent({
    source: adapter.source,
    program: adapter.programId,
    transaction,
    launch: {
      ...launch,
      createdAt: {
        ...launch.createdAt,
        slot: transaction.cursor.slot,
        transactionIndex: transaction.cursor.transactionIndex,
      },
    },
  });
  const transition = createInitialDetectedTransition(event);
  const validBatch = {
    source: event.source,
    program: event.program,
    signature: event.signature,
    confirmationStatus: event.confirmationStatus,
    events: [event],
    stateTransitionAction: 'apply',
  } as const;

  for (const transitions of [
    [],
    [{ ...transition, triggeringEventId: 'event-outside-this-batch' }],
    [{ ...transition, mint: 'OtherMint1111111111111111111111111111111111' }],
    [{ ...transition, triggeringEventType: 'BondingCurveTradeObserved' as const }],
    [transition, transition],
  ]) {
    assert.throws(
      () => {
        assertValidLaunchpadEventBatch({
          ...validBatch,
          transitions,
        } as unknown as LaunchpadEventBatch);
      },
      InvalidLaunchpadEventBatchError,
    );
  }
});

void test('runtime validation accepts valid apply and retract batches', () => {
  const transaction: DecodedTransaction = {
    signature: 'valid-batch-signature',
    confirmationStatus: 'processed',
    blockTimeMs: null,
    observedAtMs: 7,
    cursor: { slot: 7n, transactionIndex: 0 },
    raw: null,
    decodedProgram: 'pumpfun',
  };
  const event = createTokenLaunchDetectedEvent({
    source: adapter.source,
    program: adapter.programId,
    transaction,
    launch: {
      ...launch,
      createdAt: {
        ...launch.createdAt,
        slot: transaction.cursor.slot,
        transactionIndex: transaction.cursor.transactionIndex,
      },
    },
  });
  const transition = createInitialDetectedTransition(event);
  const applyBatch: LaunchpadEventBatch = {
    source: event.source,
    program: event.program,
    signature: event.signature,
    confirmationStatus: 'processed',
    events: [event],
    stateTransitionAction: 'apply',
    transitions: [transition],
  };
  const orphanedEvent = {
    ...event,
    confirmationStatus: 'orphaned' as const,
  };
  const retractBatch: LaunchpadEventBatch = {
    source: orphanedEvent.source,
    program: orphanedEvent.program,
    signature: orphanedEvent.signature,
    confirmationStatus: 'orphaned',
    events: [orphanedEvent],
    stateTransitionAction: 'retract',
    transitions: [],
  };

  assert.doesNotThrow(() => {
    assertValidLaunchpadEventBatch(applyBatch);
  });
  assert.doesNotThrow(() => {
    assertValidLaunchpadEventBatch(retractBatch);
  });
});

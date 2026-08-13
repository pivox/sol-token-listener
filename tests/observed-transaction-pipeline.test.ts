import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_OBSERVED_PIPELINE_ITEMS,
  ObservedPipelineError,
  ObservedTransactionPipeline,
  type ObservedPipelineStage,
} from '../src/application/observed-transaction-pipeline.js';
import {
  createBondingCurveTradeObservedEvent,
  createTokenLaunchDetectedEvent,
} from '../src/domain/launchpad-events.js';
import type { LaunchpadObservationEventV1 } from '../src/domain/launchpad-events.js';
import type { LaunchpadProjectionReader } from '../src/ports/launchpad-projection-reader.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';
import type { LaunchParameterObject } from '../src/domain/types.js';
import {
  MAX_CANONICAL_JSON_STRING_BYTES,
  MAX_CANONICAL_JSON_TEXT_BYTES,
  stringifyJson,
} from '../src/utils/json.js';

const SIGNATURE = 'pipeline-signature';
const EVENT_INDEXES = new Map<string, number>();

function transaction(
  confirmationStatus: NormalizedTransaction['confirmationStatus'] = 'CONFIRMED',
): NormalizedTransaction {
  return {
    signature: SIGNATURE,
    slot: 42n,
    transactionIndex: 3,
    confirmationStatus,
    version: 'legacy',
    blockTimeMs: 1_700_000_000_000,
    accountKeys: [],
    signerKeys: [],
    instructions: [],
    preTokenBalances: [],
    postTokenBalances: [],
    preBalancesLamports: [],
    postBalancesLamports: [],
    feeLamports: 0n,
    computeUnits: null,
    logs: [],
    error: null,
  };
}

function event(
  id: string,
  mint: string,
  type: LaunchpadObservationEventV1['type'] = 'BondingCurveTradeObserved',
  parameters: LaunchParameterObject = {},
): LaunchpadObservationEventV1 {
  let instructionIndex = EVENT_INDEXES.get(id);
  if (instructionIndex === undefined) {
    instructionIndex = EVENT_INDEXES.size;
    EVENT_INDEXES.set(id, instructionIndex);
  }
  const raw = transaction();
  const observed = {
    signature: raw.signature,
    confirmationStatus: 'confirmed' as const,
    blockTimeMs: raw.blockTimeMs,
    observedAtMs: 1_700_000_000_500,
    cursor: { slot: raw.slot, transactionIndex: 3 },
    raw,
  };
  const cursor = {
    slot: raw.slot,
    transactionIndex: 3,
    instructionIndex,
    innerInstructionIndex: null,
  };
  if (type === 'TokenLaunchDetected') {
    return createTokenLaunchDetectedEvent({
      source: 'pumpfun',
      program: 'PumpProgram',
      transaction: observed,
      launch: {
        mint,
        creator: `Creator_${mint}`,
        tokenProgram: 'SPL_TOKEN',
        quoteAssets: [{ mint: 'QuoteMint', decimals: 9, tokenProgram: 'SPL_TOKEN' }],
        launchpad: 'pumpfun',
        createdAt: cursor,
        parameters,
      },
    });
  }
  return createBondingCurveTradeObservedEvent({
    source: 'pumpfun',
    program: 'PumpProgram',
    transaction: observed,
    trade: {
      id,
      launchMint: mint,
      kind: 'BUY',
      trader: `Trader_${id}`,
      baseAmountRaw: 1n,
      quoteAmountRaw: 2n,
      quoteAsset: { mint: 'QuoteMint', decimals: 9, tokenProgram: 'SPL_TOKEN' },
      cursor,
    },
  });
}

const MAX_SNAPSHOT_NODES = MAX_OBSERVED_PIPELINE_ITEMS * 24;

function numericChunks(length: number, value = 0): readonly (readonly number[])[] {
  const chunks: number[][] = [];
  for (let offset = 0; offset < length; offset += MAX_OBSERVED_PIPELINE_ITEMS) {
    chunks.push(Array.from(
      { length: Math.min(MAX_OBSERVED_PIPELINE_ITEMS, length - offset) },
      () => value,
    ));
  }
  return chunks;
}

function launchWithNumericLeaves(
  id: string,
  leaves: number,
  value = 0,
  padding = '',
): LaunchpadObservationEventV1 {
  return event(id, 'BoundedMint', 'TokenLaunchDetected', {
    chunks: numericChunks(leaves, value),
    padding,
  });
}

function visitedSnapshotValues(value: unknown, ancestors = new WeakSet()): number {
  if (typeof value !== 'object' || value === null) return 1;
  if (ancestors.has(value)) throw new TypeError('cyclic test fixture');
  ancestors.add(value);
  let count = 1;
  if (Array.isArray(value)) {
    for (const nested of value as readonly unknown[]) {
      count += visitedSnapshotValues(nested, ancestors);
    }
    ancestors.delete(value);
    return count;
  }
  for (const nested of Object.values(value as Readonly<Record<string, unknown>>)) {
    count += visitedSnapshotValues(nested, ancestors);
  }
  ancestors.delete(value);
  return count;
}

function launchAtSnapshotNodeLimit(): {
  readonly exact: LaunchpadObservationEventV1;
  readonly leaves: number;
} {
  let leaves = MAX_SNAPSHOT_NODES - 100;
  for (;;) {
    const exact = launchWithNumericLeaves('node-bound', leaves);
    const count = visitedSnapshotValues([exact]);
    if (count === MAX_SNAPSHOT_NODES) return { exact, leaves };
    leaves += MAX_SNAPSHOT_NODES - count;
  }
}

function launchAtSerializedByteLimit(): {
  readonly exact: LaunchpadObservationEventV1;
  readonly leaves: number;
  readonly paddingBytes: number;
} {
  let leaves = 60_000;
  for (;;) {
    const unpadded = launchWithNumericLeaves(
      'serialized-bound',
      leaves,
      Number.MAX_SAFE_INTEGER,
    );
    const bytes = Buffer.byteLength(stringifyJson([unpadded]), 'utf8');
    const paddingBytes = MAX_CANONICAL_JSON_TEXT_BYTES - bytes;
    if (paddingBytes >= 0 && paddingBytes < MAX_CANONICAL_JSON_STRING_BYTES) {
      const exact = launchWithNumericLeaves(
        'serialized-bound',
        leaves,
        Number.MAX_SAFE_INTEGER,
        'x'.repeat(paddingBytes),
      );
      assert.equal(
        Buffer.byteLength(stringifyJson([exact]), 'utf8'),
        MAX_CANONICAL_JSON_TEXT_BYTES,
      );
      return { exact, leaves, paddingBytes };
    }
    leaves += Math.max(1, Math.floor((paddingBytes - 8_192) / 17));
  }
}

interface HarnessOptions {
  readonly tracked?: readonly string[];
  readonly activeEvents?: readonly LaunchpadObservationEventV1[];
  readonly fail?: ObservedPipelineStage;
  readonly failMint?: string;
  readonly launchpadEventCount?: number;
  readonly launchpadAffectedMints?: readonly string[];
  readonly launchpadAffectedValue?: unknown;
  readonly fundingAssessmentCount?: number;
  readonly fundingEvidenceCount?: number;
  readonly marketMigrationCount?: number;
  readonly marketActivationCount?: number;
  readonly marketAffectedMints?: readonly string[];
  readonly paperDecisions?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const rebuildPolicies: string[] = [];
  const observed: unknown[] = [];
  let clockCalls = 0;
  const fail = (stage: ObservedPipelineStage, mint?: string): void => {
    if (
      options.fail === stage
      && (options.failMint === undefined || options.failMint === mint)
    ) throw new Error(`secret at https://private/${stage}`);
  };
  const reader: LaunchpadProjectionReader = {
    listTrackedMints: async () => {
      order.push('tracked');
      fail('load_tracked_mints');
      return new Set(options.tracked ?? []);
    },
    listActiveEventsBySignature: async () => {
      order.push('reload');
      fail('reload_active_events');
      return options.activeEvents ?? Object.freeze([]);
    },
  };
  const launchpad = {
    observe: async (input: unknown) => {
      order.push('launchpad');
      observed.push(input);
      fail('launchpad_observation');
      return Object.freeze({
        events: Object.freeze(Array.from(
          { length: options.launchpadEventCount ?? 0 },
          (_, index) => Object.freeze({ eventId: `event-${index}`, outcome: 'created' as const }),
        )),
        affectedMints: (options.launchpadAffectedValue
          ?? Object.freeze([...(options.launchpadAffectedMints ?? [])])) as readonly string[],
      });
    },
  };
  const funding = {
    observe: async (input: unknown, events: readonly LaunchpadObservationEventV1[]) => {
      order.push(`funding:${events.map((item) =>
        item.type === 'BondingCurveTradeObserved'
          ? item.payload.trade.id
          : item.type).join(',')}`);
      observed.push(input);
      fail('funding_observation');
      return Object.freeze({
        assessments: Object.freeze(Array.from(
          { length: options.fundingAssessmentCount ?? 0 },
          () => Object.freeze({}),
        )),
        evidence: Object.freeze(Array.from(
          { length: options.fundingEvidenceCount ?? 0 },
          () => Object.freeze({}),
        )),
      });
    },
  };
  const participants = {
    rebuild: async (mint: string, policy: string) => {
      order.push(`i1:${mint}`);
      rebuildPolicies.push(`i1:${mint}:${policy}`);
      fail('participant_analytics', mint);
      return Object.freeze({});
    },
  };
  const graph = {
    rebuild: async (mint: string, policy: string) => {
      order.push(`i2:${mint}`);
      rebuildPolicies.push(`i2:${mint}:${policy}`);
      fail('wallet_graph', mint);
      return Object.freeze({});
    },
  };
  const qualification = {
    rebuild: async (mint: string, policy: string) => {
      order.push(`qualification:${mint}`);
      rebuildPolicies.push(`qualification:${mint}:${policy}`);
      fail('qualification', mint);
      return Object.freeze({});
    },
  };
  const observeMarket = async (input: unknown) => {
      order.push('pumpswap');
      observed.push(input);
      fail('pumpswap_observation');
      return Object.freeze({
        migrations: Object.freeze(Array.from(
          { length: options.marketMigrationCount ?? 0 },
          () => Object.freeze({}),
        )),
        activations: Object.freeze(Array.from(
          { length: options.marketActivationCount ?? 0 },
          () => Object.freeze({}),
        )),
        affectedMints: Object.freeze([...(options.marketAffectedMints ?? [])]),
      });
  };
  const market = {
    observe: observeMarket,
    processObserved: observeMarket,
  };
  const tx = transaction();
  const paperDecisions = options.paperDecisions === true ? {
    enqueueLatest: async (
      mint: string,
      signature: string,
      confirmationStatus: string,
    ) => {
      order.push(`paper:${mint}:${signature}:${confirmationStatus}`);
      fail('paper_decision_enqueue', mint);
    },
  } : null;
  const pipeline = new ObservedTransactionPipeline(
    reader,
    launchpad,
    funding,
    participants,
    graph,
    market,
    () => {
      clockCalls += 1;
      fail('create_observation');
      return 1_700_000_000_500;
    },
    paperDecisions,
    qualification,
  );
  return {
    pipeline,
    tx,
    order,
    rebuildPolicies,
    observed,
    clockCalls: () => clockCalls,
    dependencies: { reader, launchpad, funding, participants, graph, market, qualification },
  };
}

void test('runs strict stages once, collapses duplicates, and rebuilds mints lexically', async () => {
  const duplicate = event('trade-b', 'MintB');
  const h = harness({
    tracked: ['MintTracked'],
    activeEvents: Object.freeze([
      event('trade-b', 'MintB'),
      event('launch-a', 'MintA', 'TokenLaunchDetected'),
      duplicate,
      duplicate,
      event('trade-a', 'MintA'),
    ]),
    launchpadEventCount: 3,
    fundingAssessmentCount: 2,
    fundingEvidenceCount: 1,
  });

  const result = await h.pipeline.process(h.tx);

  assert.deepEqual(h.order, [
    'tracked',
    'launchpad',
    'reload',
    'funding:trade-b,trade-a',
    'i1:MintA',
    'i1:MintB',
    'i2:MintA',
    'i2:MintB',
    'pumpswap',
    'qualification:MintA',
    'qualification:MintB',
  ]);
  assert.equal(h.observed.length, 3);
  assert.equal(h.observed[0], h.observed[1]);
  assert.equal(h.observed[1], h.observed[2]);
  assert.ok(Object.isFrozen(h.observed[0]));
  assert.equal(h.clockCalls(), 1);
  assert.deepEqual(result, {
    launchpadEventCount: 3,
    activeEventCount: 3,
    fundingAssessmentCount: 2,
    fundingEvidenceCount: 1,
    affectedMintCount: 2,
    participantAnalyticsCount: 2,
    walletGraphCount: 2,
    marketMigrationCount: 0,
    marketActivationCount: 0,
    qualificationRebuildCount: 2,
    paperDecisionEnqueueCount: 0,
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.values(result).every(Number.isSafeInteger));
});

void test('keeps an irrelevant active transaction write-minimal while PumpSwap still gets a chance', async () => {
  const h = harness({ tracked: ['ExistingMint'] });
  const result = await h.pipeline.process(h.tx);
  assert.deepEqual(h.order, ['tracked', 'launchpad', 'reload', 'funding:', 'pumpswap']);
  assert.equal(result.affectedMintCount, 0);
  assert.equal(result.qualificationRebuildCount, 0);
});

void test('enqueues one durable paper decision per affected mint after every projection', async () => {
  const h = harness({
    activeEvents: [event('trade-b', 'MintB')],
    launchpadAffectedMints: ['MintA'],
    marketAffectedMints: ['MintC', 'MintA'],
    paperDecisions: true,
  });

  const result = await h.pipeline.process(h.tx);

  assert.deepEqual(h.order.slice(-7), [
    'pumpswap',
    'qualification:MintA',
    'qualification:MintB',
    'qualification:MintC',
    `paper:MintA:${SIGNATURE}:confirmed`,
    `paper:MintB:${SIGNATURE}:confirmed`,
    `paper:MintC:${SIGNATURE}:confirmed`,
  ]);
  assert.equal(result.qualificationRebuildCount, 3);
  assert.equal(result.paperDecisionEnqueueCount, 3);
});

void test('rebuilds the sorted affected and market union before paper decisions', async () => {
  const h = harness({
    activeEvents: [event('trade-b', 'MintB')],
    launchpadAffectedMints: ['MintA'],
    marketAffectedMints: ['MintC', 'MintA'],
    paperDecisions: true,
  });

  const result = await h.pipeline.process(h.tx);

  assert.deepEqual(h.order.slice(4), [
    'i1:MintA', 'i1:MintB',
    'i2:MintA', 'i2:MintB',
    'pumpswap',
    'qualification:MintA', 'qualification:MintB', 'qualification:MintC',
    `paper:MintA:${SIGNATURE}:confirmed`,
    `paper:MintB:${SIGNATURE}:confirmed`,
    `paper:MintC:${SIGNATURE}:confirmed`,
  ]);
  assert.equal(result.qualificationRebuildCount, 3);
});

void test('attributes a qualification failure to its mint and stops before paper decisions', async () => {
  const h = harness({
    launchpadAffectedMints: ['MintA', 'MintB'],
    marketAffectedMints: ['MintC'],
    paperDecisions: true,
    fail: 'qualification',
    failMint: 'MintB',
  });

  await assert.rejects(h.pipeline.process(h.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'qualification');
    assert.equal(error.mint, 'MintB');
    return true;
  });
  assert.deepEqual(h.order.slice(-2), ['qualification:MintA', 'qualification:MintB']);
  assert.equal(h.order.some((call) => call.startsWith('paper:')), false);
});

void test('attributes a paper enqueue failure to its mint and stops deterministically', async () => {
  const h = harness({
    launchpadAffectedMints: ['MintA', 'MintB'],
    paperDecisions: true,
    fail: 'paper_decision_enqueue',
    failMint: 'MintA',
  });

  await assert.rejects(h.pipeline.process(transaction('ORPHANED')), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'paper_decision_enqueue');
    assert.equal(error.mint, 'MintA');
    return true;
  });
  assert.equal(h.order.at(-1), `paper:MintA:${SIGNATURE}:orphaned`);
});

void test('pairs creation and initial buy for one mint only once', async () => {
  const h = harness({
    activeEvents: [event('create', 'NewMint', 'TokenLaunchDetected'), event('buy', 'NewMint')],
  });
  const result = await h.pipeline.process(h.tx);
  assert.deepEqual(h.order.slice(4, 6), ['i1:NewMint', 'i2:NewMint']);
  assert.equal(result.affectedMintCount, 1);
});

void test('uses persisted launchpad impact to dissolve orphaned projections after active rows vanish', async () => {
  const h = harness({
    tracked: ['MintZ'],
    activeEvents: [],
    launchpadAffectedMints: ['MintA', 'MintZ', 'MintA'],
  });
  h.tx.confirmationStatus = 'ORPHANED';
  const result = await h.pipeline.process(h.tx);
  assert.deepEqual(h.order, [
    'tracked', 'launchpad', 'reload', 'funding:',
    'i1:MintA', 'i1:MintZ', 'i2:MintA', 'i2:MintZ', 'pumpswap',
    'qualification:MintA', 'qualification:MintZ',
  ]);
  assert.equal(result.affectedMintCount, 2);
  assert.deepEqual(h.rebuildPolicies, [
    'i1:MintA:DISSOLVE_CURRENT',
    'i1:MintZ:DISSOLVE_CURRENT',
    'i2:MintA:DISSOLVE_CURRENT',
    'i2:MintZ:DISSOLVE_CURRENT',
    'qualification:MintA:DISSOLVE_CURRENT',
    'qualification:MintZ:DISSOLVE_CURRENT',
  ]);
});

void test('uses error policy for every active confirmation status', async () => {
  for (const status of ['PROCESSED', 'CONFIRMED', 'FINALIZED'] as const) {
    const h = harness({ launchpadAffectedMints: ['MintA'] });
    h.tx.confirmationStatus = status;
    await h.pipeline.process(h.tx);
    assert.deepEqual(h.rebuildPolicies, [
      'i1:MintA:ERROR',
      'i2:MintA:ERROR',
      'qualification:MintA:ERROR',
    ]);
  }
});

void test('stops before every I2 rebuild when I1 fails on a later lexical mint', async () => {
  const h = harness({
    activeEvents: [event('event-b', 'MintB'), event('event-a', 'MintA')],
    fail: 'participant_analytics',
    failMint: 'MintB',
  });
  await assert.rejects(h.pipeline.process(h.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'participant_analytics');
    assert.equal(error.mint, 'MintB');
    return true;
  });
  assert.deepEqual(h.order, [
    'tracked', 'launchpad', 'reload', 'funding:event-b,event-a',
    'i1:MintA', 'i1:MintB',
  ]);
});

void test('keeps orphan impact on replay after tracked and active rows have already disappeared', async () => {
  const h = harness({
    tracked: [],
    activeEvents: [],
    launchpadAffectedMints: ['RetractedMint'],
  });
  h.tx.confirmationStatus = 'ORPHANED';
  await h.pipeline.process(h.tx);
  assert.deepEqual(h.order.slice(4, 7), [
    'i1:RetractedMint', 'i2:RetractedMint', 'pumpswap',
  ]);
  assert.equal(h.order.at(-1), 'qualification:RetractedMint');
});

void test('runs migration activation through PumpSwap then qualification and paper enqueue', async () => {
  const h = harness({
    marketMigrationCount: 1,
    marketActivationCount: 1,
    marketAffectedMints: ['MigratedMint'],
    paperDecisions: true,
  });
  const result = await h.pipeline.process(h.tx);
  assert.deepEqual(h.order.slice(-3), [
    'pumpswap',
    'qualification:MigratedMint',
    `paper:MigratedMint:${SIGNATURE}:confirmed`,
  ]);
  assert.equal(result.marketMigrationCount, 1);
  assert.equal(result.marketActivationCount, 1);
  assert.equal(result.qualificationRebuildCount, 1);
  assert.equal(result.paperDecisionEnqueueCount, 1);
});

void test('cuts off after each failed stage and identifies the exact stable stage and mint', async () => {
  const cases: readonly [ObservedPipelineStage, readonly string[], string | null][] = [
    ['create_observation', [], null],
    ['load_tracked_mints', ['tracked'], null],
    ['launchpad_observation', ['tracked', 'launchpad'], null],
    ['reload_active_events', ['tracked', 'launchpad', 'reload'], null],
    ['funding_observation', ['tracked', 'launchpad', 'reload', 'funding:event-a'], null],
    ['participant_analytics', ['tracked', 'launchpad', 'reload', 'funding:event-a', 'i1:MintA'], 'MintA'],
    ['wallet_graph', ['tracked', 'launchpad', 'reload', 'funding:event-a', 'i1:MintA', 'i2:MintA'], 'MintA'],
    ['pumpswap_observation', ['tracked', 'launchpad', 'reload', 'funding:event-a', 'i1:MintA', 'i2:MintA', 'pumpswap'], null],
    ['qualification', ['tracked', 'launchpad', 'reload', 'funding:event-a', 'i1:MintA', 'i2:MintA', 'pumpswap', 'qualification:MintA'], 'MintA'],
  ];
  for (const [stage, expectedOrder, mint] of cases) {
    const h = harness({ activeEvents: [event('event-a', 'MintA')], fail: stage });
    await assert.rejects(h.pipeline.process(h.tx), (error: unknown) => {
      assert.ok(error instanceof ObservedPipelineError);
      assert.equal(error.code, 'PIPELINE_STAGE_FAILED');
      assert.equal(error.stage, stage);
      assert.equal(error.mint, mint);
      assert.equal(error.message, `Observed transaction pipeline failed during ${stage}.`);
      assert.equal('cause' in error, false);
      return true;
    });
    assert.deepEqual(h.order, expectedOrder);
  }
});

void test('redacts hostile transaction accessors at the observation boundary', async () => {
  const secret = 'https://rpc.internal/token';
  const h = harness();
  const hostile = new Proxy(h.tx, {
    get(_target, property, receiver) {
      if (property === 'transactionIndex') throw new Error(secret);
      // The Proxy handler API is intentionally dynamically typed.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return Reflect.get(_target, property, receiver);
    },
  });
  await assert.rejects(h.pipeline.process(hostile), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'create_observation');
    assert.equal(error.message.includes(secret), false);
    assert.equal('cause' in error, false);
    return true;
  });
  assert.deepEqual(h.order, []);
});

void test('full replay safely reruns the same idempotent stage sequence', async () => {
  const h = harness({ activeEvents: [event('event-a', 'MintA')] });
  assert.deepEqual(await h.pipeline.process(h.tx), await h.pipeline.process(h.tx));
  const replayLength = h.order.length / 2;
  assert.deepEqual(h.order.slice(0, replayLength), h.order.slice(replayLength));
});

void test('redacts hostile dependency errors without consulting their properties', async () => {
  const secret = 'postgres://user:password@private/db';
  const hostile = new Proxy(Object.create(null) as object, {
    get() { throw new Error(secret); },
    ownKeys() { throw new Error(secret); },
    getOwnPropertyDescriptor() { throw new Error(secret); },
  });
  const h = harness();
  const pipeline = new ObservedTransactionPipeline(
    { ...h.dependencies.reader, listTrackedMints: async () => {
      // Exercise non-Error dependency throws without weakening production types.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw hostile;
    } },
    h.dependencies.launchpad,
    h.dependencies.funding,
    h.dependencies.participants,
    h.dependencies.graph,
    h.dependencies.market,
    () => 1_700_000_000_500,
  );
  await assert.rejects(pipeline.process(h.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

void test('rejects unsafe dependency-provided mint labels before they reach stage errors', async () => {
  const secret = 'https://private.example/token';
  const h = harness({
    launchpadAffectedMints: [secret],
    fail: 'participant_analytics',
  });
  await assert.rejects(h.pipeline.process(h.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'launchpad_observation');
    assert.equal(error.mint, null);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
  assert.deepEqual(h.order, ['tracked', 'launchpad']);
});

void test('rejects oversized dependency collections before iterating them unboundedly', async () => {
  const h = harness({ tracked: Array.from({ length: MAX_OBSERVED_PIPELINE_ITEMS + 1 }, (_, i) => `Mint${i}`) });
  await assert.rejects(h.pipeline.process(h.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'load_tracked_mints');
    return true;
  });
  assert.deepEqual(h.order, ['tracked']);
});

void test('snapshots active events without invoking a stateful type getter', async () => {
  const secret = 'https://private/type';
  let getterCalls = 0;
  const hostile = { ...event('getter-event', 'MintA') } as Record<string, unknown>;
  Object.defineProperty(hostile, 'type', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(secret);
    },
  });
  const h = harness({ activeEvents: [hostile as unknown as LaunchpadObservationEventV1] });
  await assert.rejects(h.pipeline.process(h.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'reload_active_events');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(getterCalls, 0);
});

void test('captures active event array length once from a stateful proxy', async () => {
  let lengthReads = 0;
  const repeated = event('proxy-event', 'MintA');
  const target = new Array<LaunchpadObservationEventV1>(
    MAX_OBSERVED_PIPELINE_ITEMS,
  ).fill(repeated);
  const events = new Proxy(target, {
    getOwnPropertyDescriptor(value, property) {
      if (property === 'length') {
        lengthReads += 1;
        if (lengthReads > 1) {
          return {
            ...Reflect.getOwnPropertyDescriptor(value, property),
            value: MAX_OBSERVED_PIPELINE_ITEMS + 1,
          };
        }
      }
      return Reflect.getOwnPropertyDescriptor(value, property);
    },
  });
  const h = harness({ activeEvents: events });
  await assert.rejects(h.pipeline.process(h.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'reload_active_events');
    return true;
  });
  assert.equal(lengthReads, 1);
});

void test('rejects sparse, accessor, and prototype-tricked active arrays without getters', async () => {
  let getterCalls = 0;
  const sparse = new Array<LaunchpadObservationEventV1>(1);
  const accessor: LaunchpadObservationEventV1[] = [];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return event('accessor-event', 'MintA');
    },
  });
  Object.defineProperty(accessor, 'length', { value: 1 });
  const wrongPrototype = [event('prototype-event', 'MintA')];
  Object.setPrototypeOf(wrongPrototype, Object.create(Array.prototype));
  for (const activeEvents of [sparse, accessor, wrongPrototype]) {
    const h = harness({ activeEvents });
    await assert.rejects(h.pipeline.process(h.tx), (error: unknown) => {
      assert.ok(error instanceof ObservedPipelineError);
      assert.equal(error.stage, 'reload_active_events');
      return true;
    });
  }
  assert.equal(getterCalls, 0);
});

void test('rejects one event ID carrying conflicting durable payloads', async () => {
  const original = event('conflict-event', 'MintA');
  const conflicting = Object.freeze({
    ...original,
    observedAtMs: original.observedAtMs + 1,
  }) as LaunchpadObservationEventV1;
  const h = harness({ activeEvents: [original, conflicting] });
  await assert.rejects(h.pipeline.process(h.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'reload_active_events');
    return true;
  });
  assert.deepEqual(h.order, ['tracked', 'launchpad', 'reload']);
});

void test('bounds tracked and launchpad affected iterators at max plus one and redacts failures', async () => {
  const iterable = (count: number): Iterable<string> => ({
    *[Symbol.iterator]() {
      for (let index = 0; index < count; index += 1) yield `Mint_${index}`;
    },
  });
  const h = harness();
  const exactTracked = harness({
    tracked: Array.from(
      { length: MAX_OBSERVED_PIPELINE_ITEMS },
      (_, index) => `Mint_${index}`,
    ),
  });
  await assert.doesNotReject(exactTracked.pipeline.process(exactTracked.tx));
  const trackedPipeline = new ObservedTransactionPipeline(
    {
      ...h.dependencies.reader,
      listTrackedMints: async () => iterable(MAX_OBSERVED_PIPELINE_ITEMS + 1) as ReadonlySet<string>,
    },
    h.dependencies.launchpad,
    h.dependencies.funding,
    h.dependencies.participants,
    h.dependencies.graph,
    h.dependencies.market,
    () => 1_700_000_000_500,
  );
  await assert.rejects(trackedPipeline.process(h.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'load_tracked_mints');
    return true;
  });

  const exactAffected = harness({
    launchpadAffectedValue: iterable(MAX_OBSERVED_PIPELINE_ITEMS),
  });
  const exactAffectedResult = await exactAffected.pipeline.process(exactAffected.tx);
  assert.equal(exactAffectedResult.affectedMintCount, MAX_OBSERVED_PIPELINE_ITEMS);
  const affected = harness({
    launchpadAffectedValue: iterable(MAX_OBSERVED_PIPELINE_ITEMS + 1),
  });
  await assert.rejects(affected.pipeline.process(affected.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'launchpad_observation');
    assert.equal('cause' in error, false);
    return true;
  });

  const secret = 'postgres://private/iterator';
  const throwing: Iterable<string> = {
    [Symbol.iterator]() {
      return {
        next(): IteratorResult<string> {
          throw new Error(secret);
        },
      };
    },
  };
  for (const pipeline of [
    new ObservedTransactionPipeline(
      {
        ...h.dependencies.reader,
        listTrackedMints: async () => throwing as ReadonlySet<string>,
      },
      h.dependencies.launchpad,
      h.dependencies.funding,
      h.dependencies.participants,
      h.dependencies.graph,
      h.dependencies.market,
      () => 1_700_000_000_500,
    ),
    harness({ launchpadAffectedValue: throwing }).pipeline,
  ]) {
    await assert.rejects(pipeline.process(h.tx), (error: unknown) => {
      assert.ok(error instanceof ObservedPipelineError);
      assert.equal(error.message.includes(secret), false);
      assert.equal('cause' in error, false);
      return true;
    });
  }
});

void test('applies the serialized bound within the active-event item bound and rejects one additional item', async () => {
  const repeated = event('bounded-event', 'MintA');
  const exact = harness({
    activeEvents: Object.freeze(
      new Array<LaunchpadObservationEventV1>(MAX_OBSERVED_PIPELINE_ITEMS).fill(repeated),
    ),
  });
  await assert.rejects(exact.pipeline.process(exact.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'reload_active_events');
    return true;
  });
  const oversized = harness({
    activeEvents: Object.freeze(
      new Array<LaunchpadObservationEventV1>(MAX_OBSERVED_PIPELINE_ITEMS + 1).fill(repeated),
    ),
  });
  await assert.rejects(oversized.pipeline.process(oversized.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'reload_active_events');
    return true;
  });
});

void test('counts every visited leaf at the snapshot node limit and rejects one more before funding', async () => {
  const { exact, leaves } = launchAtSnapshotNodeLimit();
  assert.equal(visitedSnapshotValues([exact]), MAX_SNAPSHOT_NODES);
  const accepted = harness({ activeEvents: [exact] });
  await assert.doesNotReject(accepted.pipeline.process(accepted.tx));

  const oversized = launchWithNumericLeaves('node-bound', leaves + 1);
  assert.equal(visitedSnapshotValues([oversized]), MAX_SNAPSHOT_NODES + 1);
  const rejected = harness({ activeEvents: [oversized] });
  await assert.rejects(rejected.pipeline.process(rejected.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'reload_active_events');
    assert.equal('cause' in error, false);
    return true;
  });
  assert.deepEqual(rejected.order, ['tracked', 'launchpad', 'reload']);
});

void test('enforces exact aggregate serialized bytes including numeric leaves and JSON syntax', async () => {
  const { exact, leaves, paddingBytes } = launchAtSerializedByteLimit();
  const accepted = harness({ activeEvents: [exact] });
  await assert.doesNotReject(accepted.pipeline.process(accepted.tx));

  const oversized = launchWithNumericLeaves(
    'serialized-bound',
    leaves,
    Number.MAX_SAFE_INTEGER,
    'x'.repeat(paddingBytes + 1),
  );
  assert.equal(
    Buffer.byteLength(stringifyJson([oversized]), 'utf8'),
    MAX_CANONICAL_JSON_TEXT_BYTES + 1,
  );
  const rejected = harness({ activeEvents: [oversized] });
  await assert.rejects(rejected.pipeline.process(rejected.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'reload_active_events');
    assert.equal(error.message.includes('serialized'), false);
    assert.equal('cause' in error, false);
    return true;
  });
  assert.deepEqual(rejected.order, ['tracked', 'launchpad', 'reload']);
});

void test('charges a shared event subtree for every logical occurrence', async () => {
  const shared = launchWithNumericLeaves('shared-node-bound', 50_000);
  assert.ok(visitedSnapshotValues([shared]) < MAX_SNAPSHOT_NODES);
  const h = harness({ activeEvents: [shared, shared] });
  await assert.rejects(h.pipeline.process(h.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'reload_active_events');
    assert.equal('cause' in error, false);
    return true;
  });
  assert.deepEqual(h.order, ['tracked', 'launchpad', 'reload']);
});

void test('rejects 4096 shared padded events before funding without expanding them for final serialization', async () => {
  const shared = launchWithNumericLeaves(
    'shared-serialized-bound',
    0,
    0,
    'x'.repeat(MAX_CANONICAL_JSON_STRING_BYTES),
  );
  const h = harness({
    activeEvents: new Array<LaunchpadObservationEventV1>(
      MAX_OBSERVED_PIPELINE_ITEMS,
    ).fill(shared),
  });
  await assert.rejects(h.pipeline.process(h.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'reload_active_events');
    assert.equal('cause' in error, false);
    return true;
  });
  assert.deepEqual(h.order, ['tracked', 'launchpad', 'reload']);
});

void test('clones shared events below the limits, collapses their IDs, and still rejects cycles', async () => {
  const shared = launchWithNumericLeaves('shared-small', 4, 7, 'padding');
  const accepted = harness({ activeEvents: [shared, shared] });
  const result = await accepted.pipeline.process(accepted.tx);
  assert.equal(result.activeEventCount, 1);

  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  const rejected = harness({
    activeEvents: cyclic as readonly LaunchpadObservationEventV1[],
  });
  await assert.rejects(rejected.pipeline.process(rejected.tx), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.stage, 'reload_active_events');
    return true;
  });
  assert.deepEqual(rejected.order, ['tracked', 'launchpad', 'reload']);
});

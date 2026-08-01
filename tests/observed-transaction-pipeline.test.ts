import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_OBSERVED_PIPELINE_ITEMS,
  ObservedPipelineError,
  ObservedTransactionPipeline,
  type ObservedPipelineStage,
} from '../src/application/observed-transaction-pipeline.js';
import type { LaunchpadObservationEventV1 } from '../src/domain/launchpad-events.js';
import type { LaunchpadProjectionReader } from '../src/ports/launchpad-projection-reader.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';

const SIGNATURE = 'pipeline-signature';

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
): LaunchpadObservationEventV1 {
  return Object.freeze({ id, mint, type }) as LaunchpadObservationEventV1;
}

interface HarnessOptions {
  readonly tracked?: readonly string[];
  readonly activeEvents?: readonly LaunchpadObservationEventV1[];
  readonly fail?: ObservedPipelineStage;
  readonly launchpadEventCount?: number;
  readonly launchpadAffectedMints?: readonly string[];
  readonly fundingAssessmentCount?: number;
  readonly fundingEvidenceCount?: number;
  readonly marketMigrationCount?: number;
  readonly marketActivationCount?: number;
}

function harness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const observed: unknown[] = [];
  let clockCalls = 0;
  const fail = (stage: ObservedPipelineStage): void => {
    if (options.fail === stage) throw new Error(`secret at https://private/${stage}`);
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
      return Object.freeze([...(options.activeEvents ?? [])]);
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
        affectedMints: Object.freeze([...(options.launchpadAffectedMints ?? [])]),
      });
    },
  };
  const funding = {
    observe: async (input: unknown, events: readonly LaunchpadObservationEventV1[]) => {
      order.push(`funding:${events.map((item) => item.id).join(',')}`);
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
    rebuild: async (mint: string) => {
      order.push(`i1:${mint}`);
      fail('participant_analytics');
      return Object.freeze({});
    },
  };
  const graph = {
    rebuild: async (mint: string) => {
      order.push(`i2:${mint}`);
      fail('wallet_graph');
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
      });
  };
  const market = {
    observe: observeMarket,
    processObserved: observeMarket,
  };
  const tx = transaction();
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
  );
  return {
    pipeline,
    tx,
    order,
    observed,
    clockCalls: () => clockCalls,
    dependencies: { reader, launchpad, funding, participants, graph, market },
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
    'i2:MintA',
    'i1:MintB',
    'i2:MintB',
    'pumpswap',
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
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.values(result).every(Number.isSafeInteger));
});

void test('keeps an irrelevant active transaction write-minimal while PumpSwap still gets a chance', async () => {
  const h = harness({ tracked: ['ExistingMint'] });
  const result = await h.pipeline.process(h.tx);
  assert.deepEqual(h.order, ['tracked', 'launchpad', 'reload', 'funding:', 'pumpswap']);
  assert.equal(result.affectedMintCount, 0);
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
    'i1:MintA', 'i2:MintA', 'i1:MintZ', 'i2:MintZ', 'pumpswap',
  ]);
  assert.equal(result.affectedMintCount, 2);
});

void test('keeps orphan impact on replay after tracked and active rows have already disappeared', async () => {
  const h = harness({
    tracked: [],
    activeEvents: [],
    launchpadAffectedMints: ['RetractedMint'],
  });
  h.tx.confirmationStatus = 'ORPHANED';
  await h.pipeline.process(h.tx);
  assert.deepEqual(h.order.slice(4, 6), ['i1:RetractedMint', 'i2:RetractedMint']);
});

void test('reports migration and pool activation while running PumpSwap last', async () => {
  const h = harness({ marketMigrationCount: 1, marketActivationCount: 1 });
  const result = await h.pipeline.process(h.tx);
  assert.equal(h.order.at(-1), 'pumpswap');
  assert.equal(result.marketMigrationCount, 1);
  assert.equal(result.marketActivationCount, 1);
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
  assert.deepEqual(h.order.slice(0, 7), h.order.slice(7));
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

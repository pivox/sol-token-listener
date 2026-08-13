import assert from 'node:assert/strict';
import test from 'node:test';
import { QualificationRebuildService } from '../src/application/qualification-rebuild.service.js';
import type { PaperExecutionQuote } from '../src/domain/paper-trading.js';
import type { CreatorProfile, HolderDistribution } from '../src/domain/participant-analytics.js';
import type {
  CanonicalQualificationProjection,
  QualificationEvidenceSnapshot,
} from '../src/ports/qualification-projection-repository.js';
import {
  createDefaultQualificationRuleSet,
  QualificationEngine,
} from '../src/qualification/qualification-engine.js';
import {
  fromJsonValue,
  MAX_SERIALIZED_BIGINT_DIGITS,
  toJsonValue,
} from '../src/utils/json.js';

void test('rebuilds from qualification evidence independently of paper state', () => {
  const service = new QualificationRebuildService(engine());
  const rebuilt = service.rebuild({ snapshot: snapshot(), buyQuote: undefined, reverseSellQuote: undefined });

  assert.match(rebuilt.reportId, /^qreport_[a-f0-9]{64}$/u);
  assert.equal(rebuilt.event.type, 'QualificationUpdated');
  assert.equal(rebuilt.event.source, 'qualification');
  assert.equal(rebuilt.event.id, rebuilt.reportEventId);
  assert.equal(rebuilt.event.payload.reportId, rebuilt.reportId);
  assert.deepEqual(rebuilt.event.payload.evaluation, rebuilt.evaluation);
  assert.equal(rebuilt.report.evidence.every((item) => item.status === 'UNKNOWN'), true);
  assert.equal(condition(rebuilt, 'BUY_SIMULATION_FAILED').status, 'UNKNOWN');
  assert.equal(condition(rebuilt, 'SELL_QUOTE_UNAVAILABLE').status, 'UNKNOWN');
  assert.deepEqual(condition(rebuilt, 'HOLDER_CONCENTRATION_EXCEEDED').observed, {
    top1HolderBps: null, top5HoldersBps: null, top10HoldersBps: null,
  });
});

void test('maps explicit creator, holder and quote evidence and computes integer round trip loss', () => {
  const service = new QualificationRebuildService(engine());
  const rebuilt = service.rebuild({
    snapshot: snapshot({
      metadata: {
        mint: 'MINT', uri: 'https://metadata.example/token.json', fetchedAtMs: 900,
        payloadVersion: 1, resolution: {
          status: 'RESOLVED', metadata: {
            name: 'Token', symbol: 'TOK', description: 'Description',
            imageUrl: 'https://cdn.example/image.png', videoUrl: null,
            websiteUrl: null, twitterUrl: null, telegramUrl: null,
          },
        },
      },
      creatorProfile: creatorProfile(false),
      holderSnapshot: holderDistribution(),
    }),
    buyQuote: quote('buy', 'SOL', 'MINT', 1_000n, 900n, 900n),
    reverseSellQuote: quote('sell', 'MINT', 'SOL', 900n, 820n, 800n),
  });

  assert.equal(evidence(rebuilt, 'imageValid').status, 'SATISFIED');
  assert.equal(rebuilt.evaluation.signals.descriptionAvailable, true);
  assert.equal(evidence(rebuilt, 'creatorHasNotSold').status, 'SATISFIED');
  assert.equal(evidence(rebuilt, 'externalBuyersObserved').status, 'SATISFIED');
  assert.deepEqual(condition(rebuilt, 'ROUND_TRIP_LOSS_EXCEEDED').observed, {
    roundTripLossBps: 2_000n,
  });
});

void test('keeps an enforced creator sell separate from the score', () => {
  const service = new QualificationRebuildService(engine());
  const rebuilt = service.rebuild({
    snapshot: snapshot({ creatorProfile: creatorProfile(true) }),
    buyQuote: null,
    reverseSellQuote: null,
  });

  assert.equal(condition(rebuilt, 'CREATOR_EARLY_SELL').status, 'TRIGGERED');
  assert.deepEqual(rebuilt.report.blockers.map((item) => item.code), ['CREATOR_EARLY_SELL', 'BUY_SIMULATION_FAILED', 'SELL_QUOTE_UNAVAILABLE']);
  assert.equal(rebuilt.report.verdict, 'REJECTED');
});

void test('revises qualification identity when source confirmation advances', () => {
  const service = new QualificationRebuildService(engine());
  const confirmedSnapshot = snapshot();
  const finalizedSnapshot = snapshot({
    asOfEvent: Object.freeze({
      ...confirmedSnapshot.asOfEvent,
      confirmationStatus: 'finalized' as const,
    }),
  });

  const confirmed = service.rebuild({
    snapshot: confirmedSnapshot, buyQuote: undefined, reverseSellQuote: undefined,
  });
  const finalized = service.rebuild({
    snapshot: finalizedSnapshot, buyQuote: undefined, reverseSellQuote: undefined,
  });

  assert.notEqual(finalized.reportId, confirmed.reportId);
  assert.notEqual(finalized.reportEventId, confirmed.reportEventId);
});

void test('reauthorizes a JSON-style deserialized canonical projection', () => {
  const service = serviceWithEngine();
  const projection = deserializeProjection(canonicalProjection(service));

  const rebuilt = service.reauthorize(projection);

  assert.deepEqual(rebuilt.evaluation, projection.evaluation);
  assert.deepEqual(rebuilt.report, projection.report);
  assert.deepEqual(rebuilt.event, projection.qualificationEvent);
  assert.notEqual(rebuilt.report, projection.report);
  assert.equal(engineFor(service).isAuthorized(rebuilt.report, {
    mint: rebuilt.event.mint,
    triggerEventId: rebuilt.event.id,
  }), true);
});

const projectionMutations: readonly Readonly<{
  name: string;
  mutate: (projection: CanonicalQualificationProjection) => CanonicalQualificationProjection;
}>[] = [
  {
    name: 'evaluation',
    mutate: (projection) => ({
      ...projection,
      evaluation: { ...projection.evaluation, evaluatedAtMs: projection.evaluation.evaluatedAtMs + 1 },
    }),
  },
  {
    name: 'report',
    mutate: (projection) => ({
      ...projection,
      report: {
        ...projection.report,
        verdict: projection.report.verdict === 'REJECTED' ? 'WATCHLISTED' : 'REJECTED',
      },
    }),
  },
  {
    name: 'profile/report identity',
    mutate: (projection) => ({
      ...projection,
      report: {
        ...projection.report,
        ruleSet: { ...projection.report.ruleSet, fingerprint: 'f'.repeat(64) },
      },
    }),
  },
  {
    name: 'report id',
    mutate: (projection) => ({ ...projection, reportId: `qreport_${'f'.repeat(64)}` }),
  },
  {
    name: 'source event id',
    mutate: (projection) => ({ ...projection, sourceEventId: 'evt_changed' }),
  },
  {
    name: 'source raw event id',
    mutate: (projection) => ({ ...projection, sourceRawEventId: '' }),
  },
  {
    name: 'evidence fingerprint',
    mutate: (projection) => ({ ...projection, evidenceFingerprint: 'f'.repeat(64) }),
  },
  {
    name: 'qualification event identity',
    mutate: (projection) => ({
      ...projection,
      qualificationEvent: { ...projection.qualificationEvent, source: 'paper-decision' },
    }),
  },
  {
    name: 'qualification event payload',
    mutate: (projection) => ({
      ...projection,
      qualificationEvent: {
        ...projection.qualificationEvent,
        payload: { ...projection.qualificationEvent.payload, reportId: `qreport_${'e'.repeat(64)}` },
      },
    }),
  },
];

for (const mutation of projectionMutations) {
  void test(`rejects altered persisted ${mutation.name}`, () => {
    const service = new QualificationRebuildService(engine());
    const projection = deserializeProjection(canonicalProjection(service));

    assert.throws(() => service.reauthorize(mutation.mutate(projection)), TypeError);
  });
}

void test('rejects nested proxies without invoking their traps', () => {
  const service = new QualificationRebuildService(engine());
  const projection = deserializeProjection(canonicalProjection(service));
  let trapCalls = 0;
  const hostileRuleSet = new Proxy({ ...projection.report.ruleSet }, {
    ownKeys: () => {
      trapCalls += 1;
      throw new Error('secret from proxy trap');
    },
  });

  assert.throws(() => service.reauthorize({
    ...projection,
    report: { ...projection.report, ruleSet: hostileRuleSet },
  }), TypeError);
  assert.equal(trapCalls, 0);
});

void test('rejects nested accessors without reading them', () => {
  const service = new QualificationRebuildService(engine());
  const projection = deserializeProjection(canonicalProjection(service));
  let accessorReads = 0;
  const hostileRuleSet = { ...projection.report.ruleSet };
  Object.defineProperty(hostileRuleSet, 'fingerprint', {
    enumerable: true,
    get: () => {
      accessorReads += 1;
      throw new Error('secret from accessor');
    },
  });

  assert.throws(() => service.reauthorize({
    ...projection,
    report: { ...projection.report, ruleSet: hostileRuleSet },
  }), TypeError);
  assert.equal(accessorReads, 0);
});

void test('rejects custom prototypes, symbols and sparse arrays in nested data', () => {
  const service = new QualificationRebuildService(engine());
  const projection = deserializeProjection(canonicalProjection(service));
  const customRuleSet = Object.assign(
    Object.create({ inherited: true }) as Record<string, unknown>,
    projection.report.ruleSet,
  ) as CanonicalQualificationProjection['report']['ruleSet'];
  const symbolSignals = { ...projection.evaluation.signals };
  Object.defineProperty(symbolSignals, Symbol('secret'), { value:true,enumerable:true });
  const sparseEvidence = new Array(projection.report.evidence.length + 1);
  for (let index = 0; index < projection.report.evidence.length; index += 1) {
    sparseEvidence[index] = projection.report.evidence[index];
  }

  assert.throws(() => service.reauthorize({
    ...projection,
    report: { ...projection.report, ruleSet: customRuleSet },
  }), TypeError);
  assert.throws(() => service.reauthorize({
    ...projection,
    evaluation: { ...projection.evaluation, signals: symbolSignals },
  }), TypeError);
  assert.throws(() => service.reauthorize({
    ...projection,
    report: { ...projection.report, evidence: sparseEvidence },
  }), TypeError);
});

void test('enforces structural depth, node and nested string byte limits', () => {
  const service = new QualificationRebuildService(engine());
  const projection = deserializeProjection(canonicalProjection(service));

  for (const hostileValue of [
    deeplyNestedValue(65),
    Array.from({ length:10_001 }, () => null),
    'é'.repeat(8_193),
  ]) {
    assert.throws(() => service.reauthorize(withPayloadValue(projection, hostileValue)), TypeError);
  }
});

void test('requires source raw event ids to be exact bounded text', () => {
  const service = new QualificationRebuildService(engine());
  const projection = deserializeProjection(canonicalProjection(service));

  for (const sourceRawEventId of [' raw_source', 'raw_source ', '\traw_source', 'raw_source\n']) {
    assert.throws(() => service.reauthorize({ ...projection,sourceRawEventId }), TypeError);
  }
  assert.doesNotThrow(() => service.reauthorize({
    ...projection,
    sourceRawEventId:'r'.repeat(16_384),
  }));
  assert.throws(() => service.reauthorize({
    ...projection,
    sourceRawEventId:'r'.repeat(16_385),
  }), TypeError);
  assert.doesNotThrow(() => service.reauthorize({
    ...projection,
    sourceRawEventId:'é'.repeat(8_192),
  }));
  assert.throws(() => service.reauthorize({
    ...projection,
    sourceRawEventId:'é'.repeat(8_193),
  }), TypeError);
});

void test('bounds persisted bigint magnitudes before canonical serialization', () => {
  const service = new QualificationRebuildService(engine());
  const projection = deserializeProjection(canonicalProjection(service));
  const maximumMagnitude = 10n ** BigInt(MAX_SERIALIZED_BIGINT_DIGITS) - 1n;
  const overMaximum = maximumMagnitude + 1n;
  const ordinarySource = snapshot();
  const maximumSlotProjection = deserializeProjection(canonicalProjection(
    service,
    snapshot({
      asOfEvent: {
        ...ordinarySource.asOfEvent,
        cursor: { ...ordinarySource.asOfEvent.cursor,slot:maximumMagnitude },
      },
    }),
  ));

  assert.doesNotThrow(() => service.reauthorize(maximumSlotProjection));
  assert.throws(
    () => service.reauthorize(withPayloadValue(projection, -maximumMagnitude)),
    /Persisted qualification projection is not canonical\./u,
  );
  for (const hostileMagnitude of [overMaximum, -overMaximum]) {
    assert.throws(
      () => service.reauthorize(withPayloadValue(projection, hostileMagnitude)),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.equal(
          error.message,
          'Persisted qualification projection contains unsafe data.',
        );
        return true;
      },
    );
  }
});

const engines = new WeakMap<QualificationRebuildService, QualificationEngine>();

function engine(): QualificationEngine {
  return new QualificationEngine(createDefaultQualificationRuleSet(60));
}

function serviceWithEngine(): QualificationRebuildService {
  const qualificationEngine = engine();
  const service = new QualificationRebuildService(qualificationEngine);
  engines.set(service, qualificationEngine);
  return service;
}

function engineFor(service: QualificationRebuildService): QualificationEngine {
  const qualificationEngine = engines.get(service);
  assert.ok(qualificationEngine);
  return qualificationEngine;
}

function canonicalProjection(
  service = serviceWithEngine(),
  source = snapshot(),
): CanonicalQualificationProjection {
  const rebuilt = service.rebuild({
    snapshot: source,
    buyQuote: undefined,
    reverseSellQuote: undefined,
  });
  return Object.freeze({
    reportId: rebuilt.reportId,
    sourceEventId: source.asOfEvent.id,
    sourceRawEventId: 'raw_source',
    evidenceFingerprint: rebuilt.evidenceFingerprint,
    evaluation: rebuilt.evaluation,
    report: rebuilt.report,
    qualificationEvent: rebuilt.event,
  });
}

function deserializeProjection(
  projection: CanonicalQualificationProjection,
): CanonicalQualificationProjection {
  return fromJsonValue(toJsonValue(projection)) as CanonicalQualificationProjection;
}

function withPayloadValue(
  projection: CanonicalQualificationProjection,
  hostileValue: unknown,
): CanonicalQualificationProjection {
  return {
    ...projection,
    qualificationEvent: {
      ...projection.qualificationEvent,
      payload: { ...projection.qualificationEvent.payload,hostileValue },
    },
  };
}

function deeplyNestedValue(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = { nested:value };
  return value;
}

function snapshot(
  overrides: Partial<QualificationEvidenceSnapshot> = {},
): QualificationEvidenceSnapshot {
  const asOfEvent = {
    id: 'evt_source', type: 'TokenLaunchDetected' as const, mint: 'MINT', source: 'pumpfun',
    program: 'pump', signature: 'signature',
    cursor: { slot: 10n, transactionIndex: 0, instructionIndex: 1, innerInstructionIndex: null },
    confirmationStatus: 'confirmed' as const, blockchainTimeMs: 800, observedAtMs: 1_000,
    payloadVersion: 1, payload: {},
  };
  return Object.freeze({
    mint: 'MINT', asOfEvent,
    launch: Object.freeze({
      mint: 'MINT', creator: 'creator', tokenProgram: 'SPL_TOKEN' as const,
      quoteAssets: Object.freeze([Object.freeze({ mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' as const })]),
      launchpad: 'pumpfun', createdAt: Object.freeze({ ...asOfEvent.cursor }), parameters: Object.freeze({}),
    }),
    metadata: null, social: null, creatorProfile: null, holderSnapshot: null,
    walletGraph: null,
    ...overrides,
  });
}

function creatorProfile(hasSold: boolean): CreatorProfile {
  return Object.freeze({
    mint: 'MINT', creator: 'creator', payloadVersion: 1, inputFingerprint: 'a'.repeat(64),
    buyCount: 0, sellCount: hasSold ? 1 : 0, totalBoughtBaseRaw: 0n,
    totalSoldBaseRaw: hasSold ? 1n : 0n, observedNetBaseRaw: hasSold ? -1n : 0n,
    hasSold, firstSell: null, initialBuys: Object.freeze([]), quoteFlows: Object.freeze([]),
    uniqueExternalBuyers: 2, unknownTraderTradeCount: 0,
  });
}

function holderDistribution(): HolderDistribution {
  return Object.freeze({
    mint: 'MINT', creator: 'creator', payloadVersion: 1, inputFingerprint: 'b'.repeat(64),
    positions: Object.freeze([]), totalPositiveNetBaseRaw: 1_000n, top1Bps: 1_000n,
    top5Bps: 2_000n, top10Bps: 3_000n, creatorBps: 0n, uniqueKnownBuyers: 2,
    uniqueExternalBuyers: 2, positivePositionCount: 2, unknownTraderTradeCount: 0,
  });
}

function quote(
  id: string,
  inputMint: string,
  outputMint: string,
  amountInRaw: bigint,
  amountOutRaw: bigint,
  minimumAmountOutRaw: bigint,
): PaperExecutionQuote {
  return Object.freeze({
    id,inputMint,outputMint,amountInRaw,amountOutRaw,minimumAmountOutRaw,
    feesRaw:1n,slippageBps:100n,priceImpactBps:10n,observedAtMs:1_000,observedSlot:10n,
  });
}

function evidence(
  rebuilt: ReturnType<QualificationRebuildService['rebuild']>,
  signal: string,
) {
  const item = rebuilt.report.evidence.find((candidate) => candidate.signal === signal);
  assert.ok(item);
  return item;
}

function condition(
  rebuilt: ReturnType<QualificationRebuildService['rebuild']>,
  code: string,
) {
  const item = rebuilt.report.conditions.find((candidate) => candidate.code === code);
  assert.ok(item);
  return item;
}

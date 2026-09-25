import assert from 'node:assert/strict';
import { isProxy } from 'node:util/types';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  PumpFunCatchUpBlockClassifier,
  PumpFunCatchUpBlockClassifierAbortedError,
  createPumpFunCatchUpClassificationFromDecoded,
} from '../src/application/pumpfun-catch-up-block-classifier.js';
import type { MergedCatchUpDiscovery } from '../src/application/catch-up-discovery.js';
import {
  createCatchUpClassificationReceipt,
  type CatchUpClassification,
  type CatchUpClassificationReceipt,
} from '../src/domain/catch-up-classification.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { decodePumpTransaction } from '../src/launchpads/pumpfun/transaction-decoder.js';
import type {
  DecodedPumpTrade,
  DecodedPumpTransaction,
} from '../src/launchpads/pumpfun/types.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import type { CatchUpClassificationRepository } from '../src/ports/catch-up-classification-repository.js';
import type {
  CatchUpAdmissionCoverageCandidate,
  CatchUpAdmissionCoverageRepository,
} from '../src/ports/catch-up-admission-coverage-repository.js';
import { CachedSolanaBlockTransactionLocator } from '../src/solana/rpc/block-transaction-cache.js';
import {
  internalLocatorError,
  RpcTransientError,
  TransactionIndexNotFoundError,
  TransactionNormalizationError,
  trustedTransactionLocatorFailure,
  type TransactionLocationTarget,
} from '../src/solana/rpc/transaction-locator.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';
import { loadMainnetFixture, loadPumpFixture } from './helpers/pumpfun-fixture.js';

type LocatorHandler = (
  target: TransactionLocationTarget,
  signal: AbortSignal | undefined,
) => Promise<NormalizedTransaction>;
const NEVER_ABORTED = new AbortController().signal;

class RecordingLocator {
  public readonly targets: TransactionLocationTarget[] = [];
  public readonly signals: (AbortSignal | undefined)[] = [];

  public constructor(private readonly handler: LocatorHandler) {}

  public async locate(
    target: TransactionLocationTarget,
    signal?: AbortSignal,
  ): Promise<NormalizedTransaction> {
    this.targets.push(Object.freeze({ ...target }));
    this.signals.push(signal);
    return this.handler(target, signal);
  }
}

class RecordingRepository implements CatchUpClassificationRepository {
  public readonly values: CatchUpClassification[] = [];
  public readonly signals: (AbortSignal | undefined)[] = [];

  public constructor(
    private readonly beforeRecord: (
      value: CatchUpClassification,
      signal: AbortSignal | undefined,
    ) => Promise<void> = async () => {},
    private readonly receiptFor: (value: CatchUpClassification) => CatchUpClassificationReceipt = defaultReceiptFor,
  ) {}

  public async recordCatchUpClassification(
    value: CatchUpClassification,
    signal?: AbortSignal,
  ): Promise<CatchUpClassificationReceipt> {
    this.signals.push(signal);
    await this.beforeRecord(value, signal);
    this.values.push(value);
    return this.receiptFor(value);
  }
}

class RecordingCoverageRepository implements CatchUpAdmissionCoverageRepository {
  public readonly batches: readonly CatchUpAdmissionCoverageCandidate[][] = [];

  public constructor(
    private readonly handler: (
      candidates: readonly CatchUpAdmissionCoverageCandidate[],
      signal: AbortSignal,
    ) => Promise<readonly CatchUpClassificationReceipt[]>,
  ) {}

  public async readExistingCatchUpCoverage(
    candidates: readonly CatchUpAdmissionCoverageCandidate[],
    signal: AbortSignal,
  ): Promise<readonly CatchUpClassificationReceipt[]> {
    (this.batches as CatchUpAdmissionCoverageCandidate[][]).push([...candidates]);
    return this.handler(candidates, signal);
  }
}

void test('keeps the coverage fast path inactive unless explicitly enabled', async () => {
  const transaction = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const locator = returning(new Map([[transaction.signature, transaction]]));
  const repository = new RecordingRepository();
  const coverage = new RecordingCoverageRepository(async () => {
    throw new Error('coverage must stay inactive');
  });

  await new PumpFunCatchUpBlockClassifier(locator, repository, () => 9_000, {
    coverageFastPathEnabled: false, coverageRepository: coverage,
  }).classify(Object.freeze([discovery(transaction)]), NEVER_ABORTED);

  assert.equal(locator.targets.length, 1);
  assert.equal(repository.values.length, 1);
  assert.deepEqual(coverage.batches, []);
});

void test('records failed discoveries directly, covers durable successes and hydrates only missing work', async () => {
  const template = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const failed = cloneTransaction(template, { signature: 'a-fast-failed', slot: 79n,
    error: Object.freeze({ InstructionError: Object.freeze([0, 'Custom']) }) });
  const covered = cloneTransaction(template, { signature: 'b-fast-covered', slot: 79n });
  const uncovered = cloneTransaction(template, { signature: 'c-fast-uncovered', slot: 79n });
  const repository = new RecordingRepository();
  const coverage = new RecordingCoverageRepository(async (candidates) => Object.freeze([
    createCatchUpClassificationReceipt({
      signature: candidates[0]?.signature, slot: candidates[0]?.slot, disposition: null,
      persistence: 'ALREADY_ADMITTED', admission: 'NOT_ENQUEUED', ingestionPriority: null,
    }),
  ]));
  const locator = returning(new Map([[uncovered.signature, uncovered]]));

  const receipts = await new PumpFunCatchUpBlockClassifier(locator, repository, () => 9_500, {
    coverageFastPathEnabled: true, coverageRepository: coverage,
  }).classify(Object.freeze([discovery(uncovered), discovery(failed), discovery(covered)]), NEVER_ABORTED);

  assert.deepEqual(coverage.batches.map((batch) => batch.map(({ signature }) => signature)), [[
    covered.signature, uncovered.signature,
  ]]);
  assert.deepEqual(locator.targets.map(({ signature }) => signature), [uncovered.signature]);
  assert.deepEqual(repository.values.map(({ signature, reasonCode }) => [signature, reasonCode]), [
    [failed.signature, 'SOLANA_TRANSACTION_FAILED'],
    [uncovered.signature, 'PUMP_TRADE_UNTRACKED'],
  ]);
  assert.deepEqual(receipts.map(({ signature }) => signature), [
    failed.signature, covered.signature, uncovered.signature,
  ]);
});

void test('rejects a source-success discovery when hydrated block evidence reports failure', async () => {
  const template = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const transaction = cloneTransaction(template, {
    signature: 'source-success-block-failure',
    error: Object.freeze({ InstructionError: Object.freeze([0, 'Custom']) }),
  });
  const repository = new RecordingRepository();
  const coverage = new RecordingCoverageRepository(async () => Object.freeze([]));
  const sourceSuccess = Object.freeze({ ...discovery(transaction), transactionFailed: false });

  await assert.rejects(new PumpFunCatchUpBlockClassifier(
    returning(new Map([[transaction.signature, transaction]])), repository, () => 9_625, {
      coverageFastPathEnabled: true, coverageRepository: coverage,
    },
  ).classify(Object.freeze([sourceSuccess]), NEVER_ABORTED), (error: unknown) => {
    assert.equal(Reflect.get(error as object, 'code'), 'TRANSACTION_OUTCOME_MISMATCH');
    return true;
  });
  assert.deepEqual(repository.values, []);
});

void test('fails closed on hostile or contradictory coverage receipts before hydration', async () => {
  const transaction = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const locator = returning(new Map([[transaction.signature, transaction]]));
  const repository = new RecordingRepository();
  const coverage = new RecordingCoverageRepository(async () => Object.freeze([
    createCatchUpClassificationReceipt({
      signature: 'unexpected-covered-signature', slot: transaction.slot, disposition: null,
      persistence: 'ALREADY_ADMITTED', admission: 'NOT_ENQUEUED', ingestionPriority: null,
    }),
  ]));

  await assert.rejects(new PumpFunCatchUpBlockClassifier(locator, repository, () => 9_750, {
    coverageFastPathEnabled: true, coverageRepository: coverage,
  }).classify(Object.freeze([discovery(transaction)]), NEVER_ABORTED), (error: unknown) => {
    assert.equal(Reflect.get(error as object, 'code'), 'INVALID_RECEIPT');
    return true;
  });
  assert.deepEqual(locator.targets, []);
  assert.deepEqual(repository.values, []);
});

void test('classifies a creation and its initial buy as one actionable launch', async () => {
  const transaction = await fixtureTransaction('create-v2-current-initial-buy-mainnet.json');
  const locator = returning(new Map([[transaction.signature, transaction]]));
  const repository = new RecordingRepository();
  const classifier = new PumpFunCatchUpBlockClassifier(locator, repository, () => 10_000);

  await classifier.classify(Object.freeze([discovery(transaction)]), NEVER_ABORTED);

  const value = repository.values[0];
  assert.ok(value);
  assert.equal(value.disposition, 'ACTIONABLE');
  assert.equal(value.reasonCode, 'PUMP_ACTION_SUPPORTED');
  assert.equal(value.ingestionHint, 'PUMPFUN_CREATE');
  assert.equal(value.ingestionHintMint, null);
  assert.equal(value.mints.length, 1);
  assert.equal(value.observedAtMs, 10_000);
  assert.equal(value.classifiedAtMs, 10_000);
  assert.match(value.evidenceFingerprint, /^[0-9a-f]{64}$/u);
  assert.deepEqual(locator.targets, [{
    signature: transaction.signature,
    slot: transaction.slot,
    confirmationStatus: 'FINALIZED',
  }]);
});

void test('returns receipt-validated classifications in deterministic persistence order', async () => {
  const template = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const confirmed = cloneTransaction(template, { signature: 'z-confirmed-receipt', slot: 81n });
  const finalized = cloneTransaction(template, { signature: 'a-finalized-receipt', slot: 81n });
  const controller = new AbortController();
  const repository = new RecordingRepository();
  const locator = returning(new Map([[confirmed.signature, confirmed], [finalized.signature, finalized]]));

  const receipts = await new PumpFunCatchUpBlockClassifier(
    locator,
    repository,
    () => 15_000,
  ).classify(Object.freeze([
    discovery(finalized, 'finalized'), discovery(confirmed, 'processed'),
  ]), controller.signal);

  assert.deepEqual(receipts.map(({ signature, slot, disposition, persistence, admission }) =>
    [signature, slot, disposition, persistence, admission]), [
    ['z-confirmed-receipt', 81n, 'DEFERRED', 'RECORDED', 'NOT_ENQUEUED'],
    ['a-finalized-receipt', 81n, 'DEFERRED', 'RECORDED', 'NOT_ENQUEUED'],
  ]);
  assert.deepEqual(locator.signals, [controller.signal, controller.signal]);
  assert.deepEqual(repository.signals, [controller.signal, controller.signal]);
  assert.ok(receipts.every(Object.isFrozen));
});

void test('rejects a durable receipt that does not bind to the classification identity', async () => {
  const transaction = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const repository = new RecordingRepository(async () => {}, (value) =>
    createCatchUpClassificationReceipt({
      ...defaultReceiptFor(value),
      signature: 'wrong-receipt-signature',
    }));

  await assert.rejects(new PumpFunCatchUpBlockClassifier(
    returning(new Map([[transaction.signature, transaction]])), repository, () => 15_500,
  ).classify(Object.freeze([discovery(transaction)]), NEVER_ABORTED), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'PumpFunCatchUpBlockClassifierError');
    assert.equal(Reflect.get(error, 'code'), 'INVALID_RECEIPT');
    return true;
  });
  assert.deepEqual(repository.values.map(({ signature }) => signature), [transaction.signature]);
});

void test('aborts before hydration without locator or repository effects', async () => {
  const transaction = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const controller = new AbortController();
  controller.abort();
  const locator = returning(new Map([[transaction.signature, transaction]]));
  const repository = new RecordingRepository();

  await assert.rejects(new PumpFunCatchUpBlockClassifier(locator, repository, () => 16_000)
    .classify(Object.freeze([discovery(transaction)]), controller.signal),
  PumpFunCatchUpBlockClassifierAbortedError);
  assert.deepEqual(locator.targets, []);
  assert.deepEqual(repository.values, []);
});

void test('aborts after hydration settles before the first receipt write', async () => {
  const transaction = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const flight = deferred<NormalizedTransaction>();
  const locator = new RecordingLocator(async () => flight.promise);
  const repository = new RecordingRepository();
  const controller = new AbortController();
  const operation = new PumpFunCatchUpBlockClassifier(locator, repository, () => 17_000)
    .classify(Object.freeze([discovery(transaction)]), controller.signal);

  await flush();
  assert.equal(locator.targets.length, 1);
  controller.abort();
  flight.resolve(transaction);
  await assert.rejects(operation, PumpFunCatchUpBlockClassifierAbortedError);
  assert.deepEqual(repository.values, []);
});

void test('aborts after a receipt write settles without starting the next write', async () => {
  const template = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const first = cloneTransaction(template, { signature: 'abort-write-first', slot: 82n });
  const second = cloneTransaction(template, { signature: 'abort-write-second', slot: 82n });
  const write = deferred<undefined>();
  const repository = new RecordingRepository(async () => write.promise);
  const controller = new AbortController();
  const operation = new PumpFunCatchUpBlockClassifier(
    returning(new Map([[first.signature, first], [second.signature, second]])),
    repository,
    () => 18_000,
  ).classify(Object.freeze([discovery(second), discovery(first)]), controller.signal);

  await flush();
  assert.equal(repository.signals.length, 1);
  controller.abort();
  write.resolve(undefined);
  await assert.rejects(operation, PumpFunCatchUpBlockClassifierAbortedError);
  assert.deepEqual(repository.values.map(({ signature }) => signature), ['abort-write-first']);
  assert.equal(repository.signals.length, 1);
});

void test('classifies mono-mint trades, failed transactions and unsupported transactions', async () => {
  const trade = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const failed = cloneTransaction(trade, {
    signature: 'failed-transaction',
    error: Object.freeze({ InstructionError: Object.freeze([0, 'Custom']) }),
  });
  const unsupported = cloneTransaction(trade, {
    signature: 'unsupported-transaction',
    instructions: Object.freeze([]),
  });
  const locator = returning(new Map([
    [trade.signature, trade], [failed.signature, failed], [unsupported.signature, unsupported],
  ]));
  const repository = new RecordingRepository();
  const classifier = new PumpFunCatchUpBlockClassifier(locator, repository, () => 20_000);

  await classifier.classify(Object.freeze([
    discovery(unsupported), discovery(trade), discovery(failed),
  ]), NEVER_ABORTED);

  const bySignature = new Map(repository.values.map((value) => [value.signature, value]));
  const tradeValue = bySignature.get(trade.signature);
  assert.equal(tradeValue?.disposition, 'DEFERRED');
  assert.equal(tradeValue?.reasonCode, 'PUMP_TRADE_UNTRACKED');
  assert.equal(tradeValue?.ingestionHint, 'PUMPFUN_TRADE');
  assert.equal(tradeValue?.ingestionHintMint, tradeValue?.mints[0]);
  assert.equal(bySignature.get(failed.signature)?.disposition, 'IGNORED');
  assert.equal(bySignature.get(failed.signature)?.reasonCode, 'SOLANA_TRANSACTION_FAILED');
  assert.deepEqual(bySignature.get(failed.signature)?.mints, []);
  assert.equal(bySignature.get(unsupported.signature)?.disposition, 'IGNORED');
  assert.equal(bySignature.get(unsupported.signature)?.reasonCode, 'NO_SUPPORTED_PUMP_ACTION');
});

void test('classifies bounded historical BUY layouts as supported untracked trades', async () => {
  for (const name of [
    'buy-exact-quote-v2-track-volume-mainnet.json',
    'buy-exact-sol-in-option-mainnet.json',
  ]) {
    const transaction = await fixtureTransaction(name);
    const repository = new RecordingRepository();

    await new PumpFunCatchUpBlockClassifier(
      returning(new Map([[transaction.signature, transaction]])),
      repository,
      () => 25_000,
    ).classify(Object.freeze([discovery(transaction)]), NEVER_ABORTED);

    assert.equal(repository.values[0]?.disposition, 'DEFERRED');
    assert.equal(repository.values[0]?.reasonCode, 'PUMP_TRADE_UNTRACKED');
    assert.equal(repository.values[0]?.ingestionHint, 'PUMPFUN_TRADE');
    assert.equal(repository.values[0]?.mints.length, 1);
  }
});

void test('quarantines trade-only multi-mint evidence and bounds overflow at sixteen mints', async () => {
  const transaction = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const decoded = decodePumpTransaction(transaction);
  const two = decodedWithTrades(decoded, 2);
  const seventeen = decodedWithTrades(decoded, 17);
  const eighteen = decodedWithTrades(decoded, 18);

  const multi = createPumpFunCatchUpClassificationFromDecoded(
    discovery(transaction), two, 30_000,
  );
  const overflow = createPumpFunCatchUpClassificationFromDecoded(
    discovery(transaction), seventeen, 30_000,
  );
  const largerOverflow = createPumpFunCatchUpClassificationFromDecoded(
    discovery(transaction), eighteen, 30_000,
  );

  assert.equal(multi.disposition, 'QUARANTINED');
  assert.equal(multi.reasonCode, 'PUMP_SCHEMA_UNSUPPORTED');
  assert.equal(multi.mints.length, 2);
  assert.deepEqual(multi.mints, [...multi.mints].sort());
  assert.equal(overflow.disposition, 'QUARANTINED');
  assert.equal(overflow.reasonCode, 'PUMP_SCHEMA_UNSUPPORTED');
  assert.deepEqual(overflow.mints, []);
  assert.notEqual(overflow.evidenceFingerprint, largerOverflow.evidenceFingerprint);
});

void test('uses the real decoder for composite multi-mint trades', async () => {
  const buy = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const sell = await fixtureTransaction('sell-cpi-mainnet.json');
  const composite = combineBuySell(buy, sell);
  const decoded = decodePumpTransaction(composite);
  assert.equal(new Set(decoded.trades.map(({ event }) => event.mint)).size, 2);
  const repository = new RecordingRepository();

  await new PumpFunCatchUpBlockClassifier(
    returning(new Map([[composite.signature, composite]])), repository, () => 35_000,
  ).classify(Object.freeze([discovery(composite)]), NEVER_ABORTED);

  assert.equal(repository.values[0]?.disposition, 'QUARANTINED');
  assert.equal(repository.values[0]?.reasonCode, 'PUMP_SCHEMA_UNSUPPORTED');
  assert.equal(repository.values[0]?.mints.length, 2);
});

void test('keeps a real migrate_v2 cursor in fingerprint evidence without making it actionable', async () => {
  const transaction = (await loadMainnetFixture(
    'pumpswap', 'migrate-v2-create-pool-mainnet.json',
  )).transaction;
  const decoded = decodePumpTransaction(transaction);
  assert.equal(decoded.migrations.length, 1);
  const empty = Object.freeze({ ...decoded, migrations: Object.freeze([]) });
  const repository = new RecordingRepository();

  await new PumpFunCatchUpBlockClassifier(
    returning(new Map([[transaction.signature, transaction]])), repository, () => 40_000,
  ).classify(Object.freeze([discovery(transaction)]), NEVER_ABORTED);
  const withoutMigration = createPumpFunCatchUpClassificationFromDecoded(
    discovery(transaction), empty, 40_000,
  );

  assert.equal(repository.values[0]?.disposition, 'IGNORED');
  assert.equal(repository.values[0]?.reasonCode, 'NO_SUPPORTED_PUMP_ACTION');
  assert.notEqual(repository.values[0]?.evidenceFingerprint, withoutMigration.evidenceFingerprint);
});

void test('maps exact trusted locator failures once and rejects retryable or untrusted failures', async () => {
  const transaction = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const cases = [
    [internalLocatorError(new TransactionIndexNotFoundError()), 'PROVIDER_SIGNATURE_MISSING'],
    [internalLocatorError(new TransactionNormalizationError()), 'PUMP_SCHEMA_UNSUPPORTED'],
  ] as const;
  for (const [failure, reason] of cases) {
    const locator = new RecordingLocator(async () => { throw failure; });
    const repository = new RecordingRepository();
    await new PumpFunCatchUpBlockClassifier(locator, repository, () => 50_000)
      .classify(Object.freeze([discovery(transaction)]), NEVER_ABORTED);
    assert.equal(repository.values[0]?.disposition, 'QUARANTINED');
    assert.equal(repository.values[0]?.reasonCode, reason);
    assert.equal(trustedTransactionLocatorFailure(failure), null);
  }

  const replayRepository = new RecordingRepository();
  const replayClassifier = new PumpFunCatchUpBlockClassifier(
    new RecordingLocator(async () => {
      throw internalLocatorError(new TransactionNormalizationError());
    }),
    replayRepository,
    () => 50_000,
  );
  await replayClassifier.classify(Object.freeze([discovery(transaction)]), NEVER_ABORTED);
  await replayClassifier.classify(Object.freeze([discovery(transaction)]), NEVER_ABORTED);
  assert.equal(replayRepository.values.length, 2);
  assert.equal(
    replayRepository.values[0]?.evidenceFingerprint,
    replayRepository.values[1]?.evidenceFingerprint,
  );

  for (const failure of [internalLocatorError(new RpcTransientError()), new Error('untrusted')]) {
    const repository = new RecordingRepository();
    await assert.rejects(new PumpFunCatchUpBlockClassifier(
      new RecordingLocator(async () => { throw failure; }), repository, () => 50_000,
    ).classify(Object.freeze([discovery(transaction)]), NEVER_ABORTED));
    assert.equal(repository.values.length, 0);
  }
});

void test('quarantines trusted decoder origins with distinct semantic fingerprints', async () => {
  const transaction = await fixtureTransaction('create-v2-current-initial-buy-mainnet.json');
  const missingIndex = cloneTransaction(transaction, { transactionIndex: null });
  const missingStack = cloneTransaction(transaction, {
    instructions: Object.freeze(transaction.instructions.map((instruction) => Object.freeze({
      ...instruction,
      stackHeight: null,
    }))),
  });
  const firstRepository = new RecordingRepository();
  const secondRepository = new RecordingRepository();

  await new PumpFunCatchUpBlockClassifier(
    returning(new Map([[transaction.signature, missingIndex]])), firstRepository, () => 60_000,
  ).classify(Object.freeze([discovery(transaction)]), NEVER_ABORTED);
  await new PumpFunCatchUpBlockClassifier(
    returning(new Map([[transaction.signature, missingStack]])), secondRepository, () => 60_000,
  ).classify(Object.freeze([discovery(transaction)]), NEVER_ABORTED);

  assert.equal(firstRepository.values[0]?.reasonCode, 'PUMP_SCHEMA_UNSUPPORTED');
  assert.equal(secondRepository.values[0]?.reasonCode, 'PUMP_SCHEMA_UNSUPPORTED');
  assert.notEqual(
    firstRepository.values[0]?.evidenceFingerprint,
    secondRepository.values[0]?.evidenceFingerprint,
  );
});

void test('validates and snapshots the complete input before clock, locator or repository effects', async () => {
  const transaction = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const valid = discovery(transaction);
  let getterReads = 0;
  const accessor = Object.freeze(Object.defineProperty({ ...valid }, 'signature', {
    enumerable: true,
    get() { getterReads += 1; return valid.signature; },
  })) as MergedCatchUpDiscovery;
  const proxy = new Proxy(valid, {});
  assert.equal(isProxy(proxy), true);
  const { programIds: _missingProgramIds, ...missingField } = valid;
  void _missingProgramIds;
  const invalidValues: readonly unknown[] = [
    accessor,
    proxy,
    Object.freeze({ ...valid, extra: true }),
    Object.freeze(missingField),
    Object.freeze({ ...valid, slot: -1n }),
    Object.freeze({ ...valid, confirmationStatus: 'orphaned' }),
    Object.freeze({ ...valid, blockTimeMs: -1 }),
    Object.freeze({ ...valid, programIds: Object.freeze([PUMPSWAP_PROGRAM_ID, PUMP_PROGRAM_ID]) }),
    Object.freeze({ ...valid, programIds: Object.freeze([PUMP_PROGRAM_ID, PUMP_PROGRAM_ID]) }),
    Object.freeze({ ...valid, programIds: Object.freeze([PUMPSWAP_PROGRAM_ID]) }),
  ];

  for (const invalid of invalidValues) {
    let clockReads = 0;
    const locator = returning(new Map([[transaction.signature, transaction]]));
    const repository = new RecordingRepository();
    await assert.rejects(new PumpFunCatchUpBlockClassifier(
      locator,
      repository,
      () => { clockReads += 1; return 70_000; },
    ).classify(Object.freeze([invalid]) as readonly MergedCatchUpDiscovery[], NEVER_ABORTED));
    assert.equal(clockReads, 0);
    assert.equal(locator.targets.length, 0);
    assert.equal(repository.values.length, 0);
  }
  assert.equal(getterReads, 0);

  const locator = returning(new Map([[transaction.signature, transaction]]));
  const repository = new RecordingRepository();
  await assert.rejects(new PumpFunCatchUpBlockClassifier(locator, repository, () => 70_000)
    .classify(Object.freeze([valid, valid]), NEVER_ABORTED));
  assert.equal(locator.targets.length, 0);
  assert.equal(repository.values.length, 0);

  const sparse = new Array<MergedCatchUpDiscovery>(1);
  const arrayAccessor: MergedCatchUpDiscovery[] = [];
  Object.defineProperty(arrayAccessor, '0', { enumerable: true, get: () => valid });
  Object.defineProperty(arrayAccessor, 'length', { value: 1 });
  const arrayWithExtra = [valid] as MergedCatchUpDiscovery[] & { extra?: boolean };
  arrayWithExtra.extra = true;
  const topLevelCases: readonly unknown[] = [
    new Proxy([valid], {}),
    sparse,
    arrayAccessor,
    arrayWithExtra,
    Array.from({ length: 100_001 }, () => valid),
  ];
  for (const input of topLevelCases) {
    let clockReads = 0;
    const topLocator = returning(new Map([[transaction.signature, transaction]]));
    const topRepository = new RecordingRepository();
    await assert.rejects(new PumpFunCatchUpBlockClassifier(
      topLocator,
      topRepository,
      () => { clockReads += 1; return 70_000; },
    ).classify(input as readonly MergedCatchUpDiscovery[], NEVER_ABORTED));
    assert.equal(clockReads, 0);
    assert.equal(topLocator.targets.length, 0);
    assert.equal(topRepository.values.length, 0);
  }
});

void test('hydrates and decodes every commitment bucket in a slot before its first write', async () => {
  const template = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const confirmed = cloneTransaction(template, { signature: 'z-confirmed', slot: 90n });
  const finalized = cloneTransaction(template, { signature: 'a-finalized', slot: 90n });
  const flights = new Map<string, ReturnType<typeof deferred<NormalizedTransaction>>>();
  const locator = new RecordingLocator(async (target) => {
    const flight = deferred<NormalizedTransaction>();
    flights.set(target.signature, flight);
    return flight.promise;
  });
  const repository = new RecordingRepository();
  const classifier = new PumpFunCatchUpBlockClassifier(locator, repository, () => 80_000);
  const operation = classifier.classify(Object.freeze([
    discovery(finalized, 'finalized'),
    discovery(confirmed, 'processed'),
  ]), NEVER_ABORTED);

  await flush();
  const targetsBeforeSettlement = locator.targets.map((target) => [
    target.signature, target.confirmationStatus,
  ]);
  flights.get('z-confirmed')?.resolve(confirmed);
  await flush();
  assert.equal(repository.values.length, 0);
  flights.get('a-finalized')?.resolve(finalized);
  await operation;

  assert.deepEqual(targetsBeforeSettlement, [
    ['z-confirmed', 'CONFIRMED'],
    ['a-finalized', 'FINALIZED'],
  ]);
  assert.deepEqual(repository.values.map(({ signature, confirmationStatus }) =>
    [signature, confirmationStatus]), [
    ['z-confirmed', 'processed'],
    ['a-finalized', 'finalized'],
  ]);
});

void test('shares one cached block fetch for missing signatures in one commitment bucket', async () => {
  const template = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const first = cloneTransaction(template, { signature: 'missing-first', slot: 92n });
  const second = cloneTransaction(template, { signature: 'missing-second', slot: 92n });
  const blockFlight = deferred<unknown>();
  let rpcFetches = 0;
  const locator = new CachedSolanaBlockTransactionLocator({
    httpTransportEpoch: 0,
    async getBlockTransactions() {
      rpcFetches += 1;
      return blockFlight.promise;
    },
  }, { fetchIntervalMs: 1, sleep: async () => {} });
  const repository = new RecordingRepository();
  const operation = new PumpFunCatchUpBlockClassifier(locator, repository, () => 85_000)
    .classify(Object.freeze([discovery(first, 'confirmed'), discovery(second, 'confirmed')]), NEVER_ABORTED);

  await flush();
  const locatesBeforeSettlement = locator.metrics.locates;
  assert.equal(repository.values.length, 0);
  blockFlight.resolve(missingSignatureBlock(92n));
  await operation;

  assert.equal(locatesBeforeSettlement, 2);
  assert.equal(rpcFetches, 1);
  assert.equal(locator.metrics.fetches, 1);
  assert.equal(locator.metrics.inFlightJoins, 1);
  assert.deepEqual(repository.values.map(({ signature, reasonCode }) => [signature, reasonCode]), [
    ['missing-first', 'PROVIDER_SIGNATURE_MISSING'],
    ['missing-second', 'PROVIDER_SIGNATURE_MISSING'],
  ]);
});

void test('rejects a whole slot before writes on late hydration or transaction identity failure', async () => {
  const template = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const first = cloneTransaction(template, { signature: 'first', slot: 91n });
  const second = cloneTransaction(template, { signature: 'second', slot: 91n });
  const retryable = internalLocatorError(new RpcTransientError());
  const retryRepository = new RecordingRepository();
  await assert.rejects(new PumpFunCatchUpBlockClassifier(
    new RecordingLocator(async (target) => {
      if (target.signature === first.signature) return first;
      throw retryable;
    }),
    retryRepository,
    () => 90_000,
  ).classify(Object.freeze([discovery(first), discovery(second)]), NEVER_ABORTED));
  assert.equal(retryRepository.values.length, 0);

  for (const mismatch of [
    cloneTransaction(first, { signature: 'wrong' }),
    cloneTransaction(first, { slot: 92n }),
  ]) {
    const repository = new RecordingRepository();
    await assert.rejects(new PumpFunCatchUpBlockClassifier(
      returning(new Map([[first.signature, mismatch]])), repository, () => 90_000,
    ).classify(Object.freeze([discovery(first)]), NEVER_ABORTED));
    assert.equal(repository.values.length, 0);
  }
});

void test('fingerprint ignores time, finality and program provenance but covers action cursors', async () => {
  const transaction = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const decoded = decodePumpTransaction(transaction);
  const first = createPumpFunCatchUpClassificationFromDecoded(
    discovery(transaction, 'confirmed'), decoded, 100_000,
  );
  const second = createPumpFunCatchUpClassificationFromDecoded(
    Object.freeze({
      ...discovery(transaction, 'finalized'),
      programIds: Object.freeze([PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort()),
    }),
    decoded,
    200_000,
  );
  const moved = createPumpFunCatchUpClassificationFromDecoded(
    discovery(transaction, 'confirmed'), moveFirstTrade(decoded), 100_000,
  );

  assert.equal(first.evidenceFingerprint, second.evidenceFingerprint);
  assert.notEqual(first.classifiedAtMs, second.classifiedAtMs);
  assert.notEqual(first.confirmationStatus, second.confirmationStatus);
  assert.notEqual(first.evidenceFingerprint, moved.evidenceFingerprint);
});

void test('replays a partially persisted slot with identical semantic fingerprints and order', async () => {
  const template = await fixtureTransaction('buy-exact-quote-v2-cpi-mainnet.json');
  const first = cloneTransaction(template, { signature: 'a-first', slot: 101n });
  const second = cloneTransaction(template, { signature: 'b-second', slot: 101n });
  let attempt = 0;
  const repository = new RecordingRepository(async () => {
    attempt += 1;
    if (attempt === 2) throw new Error('persistence failed');
  });
  const locator = returning(new Map([[first.signature, first], [second.signature, second]]));
  let now = 110_000;
  const classifier = new PumpFunCatchUpBlockClassifier(locator, repository, () => now);

  await assert.rejects(classifier.classify(Object.freeze([discovery(second), discovery(first)]), NEVER_ABORTED));
  assert.deepEqual(repository.values.map(({ signature }) => signature), ['a-first']);
  const firstFingerprint = repository.values[0]?.evidenceFingerprint;
  now = 120_000;
  await classifier.classify(Object.freeze([discovery(second), discovery(first)]), NEVER_ABORTED);

  assert.deepEqual(repository.values.map(({ signature }) => signature), [
    'a-first', 'a-first', 'b-second',
  ]);
  assert.equal(repository.values[1]?.evidenceFingerprint, firstFingerprint);
  assert.equal(repository.values[1]?.classifiedAtMs, 120_000);
});

function defaultReceiptFor(value: CatchUpClassification): CatchUpClassificationReceipt {
  return createCatchUpClassificationReceipt({
    signature: value.signature,
    slot: value.slot,
    disposition: value.disposition,
    persistence: 'RECORDED',
    admission: 'NOT_ENQUEUED',
    ingestionPriority: null,
  });
}

async function fixtureTransaction(name: string): Promise<NormalizedTransaction> {
  return (await loadPumpFixture(name)).transaction;
}

function returning(values: ReadonlyMap<string, NormalizedTransaction>): RecordingLocator {
  return new RecordingLocator(async (target) => {
    const value = values.get(target.signature);
    assert.ok(value);
    return value;
  });
}

function discovery(
  transaction: NormalizedTransaction,
  confirmationStatus: MergedCatchUpDiscovery['confirmationStatus'] = 'finalized',
): MergedCatchUpDiscovery {
  return Object.freeze({
    signature: transaction.signature,
    slot: transaction.slot,
    confirmationStatus,
    blockTimeMs: transaction.blockTimeMs,
    transactionFailed: transaction.error !== null,
    programIds: Object.freeze([PUMP_PROGRAM_ID]),
  });
}

function cloneTransaction(
  transaction: NormalizedTransaction,
  overrides: Partial<NormalizedTransaction>,
): NormalizedTransaction {
  return { ...transaction, ...overrides };
}

function decodedWithTrades(
  decoded: DecodedPumpTransaction,
  count: number,
): DecodedPumpTransaction {
  const template = decoded.trades[0];
  assert.ok(template);
  const trades = Array.from({ length: count }, (_unused, index) => {
    const mint = address(index + 1);
    const instruction = Object.freeze({
      ...template.action.instruction,
      instructionIndex: index,
      innerInstructionIndex: null,
    });
    return Object.freeze({
      ...template,
      action: Object.freeze({ ...template.action, instruction }),
      event: Object.freeze({ ...template.event, mint }),
    }) as DecodedPumpTrade;
  });
  return Object.freeze({
    ...decoded,
    creations: Object.freeze([]),
    trades: Object.freeze(trades),
    migrations: Object.freeze([]),
  });
}

function moveFirstTrade(decoded: DecodedPumpTransaction): DecodedPumpTransaction {
  const first = decoded.trades[0];
  assert.ok(first);
  return Object.freeze({
    ...decoded,
    trades: Object.freeze([
      Object.freeze({
        ...first,
        action: Object.freeze({
          ...first.action,
          instruction: Object.freeze({
            ...first.action.instruction,
            instructionIndex: first.action.instruction.instructionIndex + 1,
          }),
        }),
      }),
    ]),
  });
}

function combineBuySell(
  buy: NormalizedTransaction,
  sell: NormalizedTransaction,
): NormalizedTransaction {
  const offset = 8;
  const sellInstructions = sell.instructions.map((instruction) => Object.freeze({
    ...instruction,
    instructionIndex: instruction.instructionIndex + offset,
    parentInstructionIndex: instruction.parentInstructionIndex === null
      ? null
      : instruction.parentInstructionIndex + offset,
  }));
  return cloneTransaction(buy, {
    signature: 'composite-buy-sell',
    instructions: Object.freeze([...buy.instructions, ...sellInstructions]),
    preTokenBalances: Object.freeze([...buy.preTokenBalances, ...sell.preTokenBalances]),
    postTokenBalances: Object.freeze([...buy.postTokenBalances, ...sell.postTokenBalances]),
  });
}

function address(value: number): string {
  const bytes = new Uint8Array(32);
  bytes[0] = value;
  bytes[31] = 255 - value;
  return new PublicKey(bytes).toBase58();
}

function missingSignatureBlock(slot: bigint): unknown {
  const key = new PublicKey('11111111111111111111111111111111');
  return {
    blockhash: key.toBase58(),
    previousBlockhash: key.toBase58(),
    parentSlot: Number(slot - 1n),
    blockTime: null,
    transactions: [{
      version: 'legacy',
      transaction: {
        signatures: ['unrelated-signature'],
        message: {
          header: {
            numRequiredSignatures: 1,
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 0,
          },
          accountKeys: [key],
          compiledInstructions: [{
            programIdIndex: 0,
            accountKeyIndexes: [0],
            data: new Uint8Array([1, 2]),
          }],
        },
      },
      meta: {
        fee: 5_000,
        err: null,
        preBalances: [10_000],
        postBalances: [5_000],
        loadedAddresses: { writable: [], readonly: [] },
      },
    }],
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

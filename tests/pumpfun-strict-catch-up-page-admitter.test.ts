import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCatchUpClassificationReceipt,
  type CatchUpClassificationReceipt,
} from '../src/domain/catch-up-classification.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import {
  PumpFunStrictCatchUpPageAdmitter,
  PumpFunStrictCatchUpPageAdmitterError,
  type PumpFunCatchUpPageClassifier,
} from '../src/application/pumpfun-strict-catch-up-page-admitter.js';
import type { MergedCatchUpDiscovery } from '../src/application/catch-up-discovery.js';
import type { CatchUpSignature } from '../src/solana/rpc/catch-up-source.js';

const launchpad = Object.freeze({ key: 'launchpad', family: 'pumpfun', id: PUMP_PROGRAM_ID } as const);
const market = Object.freeze({ key: 'market', family: 'pumpswap', id: PUMPSWAP_PROGRAM_ID } as const);
const NEVER_ABORTED = new AbortController().signal;

class FakeClassifier implements PumpFunCatchUpPageClassifier {
  readonly calls: (readonly MergedCatchUpDiscovery[])[] = [];
  next: Promise<readonly CatchUpClassificationReceipt[]> | null = null;

  public constructor(private readonly receipts: readonly CatchUpClassificationReceipt[]) {}

  public async classify(
    discoveries: readonly MergedCatchUpDiscovery[],
    _signal: AbortSignal,
  ): Promise<readonly CatchUpClassificationReceipt[]> {
    this.calls.push(discoveries);
    return this.next ?? this.receipts;
  }
}

void test('admits exactly one canonical Pump.fun page and aggregates durable receipts', async () => {
  const rows = Object.freeze([row('newest', 12), row('middle', 11), row('oldest', 10)]);
  const classifier = new FakeClassifier(Object.freeze([
    receipt('oldest', 10, 'ACTIONABLE', 'RECORDED', 'ENQUEUED', 'LAUNCH_CANDIDATE'),
    receipt('middle', 11, 'DEFERRED', 'REPLAYED', 'NOT_ENQUEUED', null),
    createCatchUpClassificationReceipt({
      signature: 'newest', slot: 12n, disposition: null,
      persistence: 'ALREADY_ADMITTED', admission: 'NOT_ENQUEUED', ingestionPriority: null,
    }),
  ]));

  const result = await new PumpFunStrictCatchUpPageAdmitter(classifier)
    .admitPage(launchpad, rows, NEVER_ABORTED);

  assert.equal(result.signaturesClassified, 2n);
  assert.equal(result.signaturesEnqueued, 1n);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.receipts), true);
  assert.deepEqual(classifier.calls[0]?.map(({ signature, programIds }) => [signature, programIds]), [
    ['oldest', [PUMP_PROGRAM_ID]], ['middle', [PUMP_PROGRAM_ID]], ['newest', [PUMP_PROGRAM_ID]],
  ]);
});

void test('rejects PumpSwap before classifier access', async () => {
  const classifier = new FakeClassifier(Object.freeze([]));
  await assert.rejects(
    new PumpFunStrictCatchUpPageAdmitter(classifier)
      .admitPage(market, Object.freeze([row('market-row', 1)]), NEVER_ABORTED),
    (error: unknown) => pageError(error, 'INVALID_PROGRAM'),
  );
  assert.equal(classifier.calls.length, 0);
});

void test('fails closed on missing, duplicate, mismatched or mutable receipts', async () => {
  const rows = Object.freeze([row('first', 2), row('second', 1)]);
  const first = receipt('first', 2, 'ACTIONABLE', 'RECORDED', 'ENQUEUED', 'LAUNCH_CANDIDATE');
  const second = receipt('second', 1, 'IGNORED', 'RECORDED', 'NOT_ENQUEUED', null);
  for (const receipts of [
    Object.freeze([first]),
    Object.freeze([first, first]),
    Object.freeze([first, receipt('second', 3, 'IGNORED', 'RECORDED', 'NOT_ENQUEUED', null)]),
    [first, second],
  ]) {
    await assert.rejects(
      new PumpFunStrictCatchUpPageAdmitter(new FakeClassifier(receipts))
        .admitPage(launchpad, rows, NEVER_ABORTED),
      (error: unknown) => pageError(error, 'INVALID_RECEIPTS'),
    );
  }
});

void test('fails closed on non-canonical frozen receipt arrays without invoking accessors', async () => {
  const rows = Object.freeze([row('first', 2), row('second', 1)]);
  const first = receipt('first', 2, 'ACTIONABLE', 'RECORDED', 'ENQUEUED', 'LAUNCH_CANDIDATE');
  const second = receipt('second', 1, 'IGNORED', 'RECORDED', 'NOT_ENQUEUED', null);
  const extra = [first, second];
  Object.defineProperty(extra, 'extra', { value: true });
  const symbol = [first, second];
  Object.defineProperty(symbol, Symbol('receipt'), { value: true });
  const foreignPrototype = [first, second];
  Object.setPrototypeOf(foreignPrototype, null);
  let getterCalls = 0;
  const accessor = [first, second];
  Object.defineProperty(accessor, '0', {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('receipt accessor must not run');
    },
  });

  for (const receipts of [extra, symbol, foreignPrototype, accessor]) {
    await assert.rejects(
      new PumpFunStrictCatchUpPageAdmitter(new FakeClassifier(Object.freeze(receipts) as readonly CatchUpClassificationReceipt[]))
        .admitPage(launchpad, rows, NEVER_ABORTED),
      (error: unknown) => pageError(error, 'INVALID_RECEIPTS'),
    );
  }
  assert.equal(getterCalls, 0);
});

void test('observes cancellation before and after classifier settlement', async () => {
  const controller = new AbortController();
  controller.abort();
  const neverCalled = new FakeClassifier(Object.freeze([]));
  await assert.rejects(
    new PumpFunStrictCatchUpPageAdmitter(neverCalled)
      .admitPage(launchpad, Object.freeze([row('first', 1)]), controller.signal),
    (error: unknown) => pageError(error, 'ABORTED'),
  );
  assert.equal(neverCalled.calls.length, 0);

  const pending = deferred<readonly CatchUpClassificationReceipt[]>();
  const classifier = new FakeClassifier(Object.freeze([]));
  classifier.next = pending.promise;
  const active = new AbortController();
  const operation = new PumpFunStrictCatchUpPageAdmitter(classifier)
    .admitPage(launchpad, Object.freeze([row('second', 2)]), active.signal);
  active.abort();
  pending.resolve(Object.freeze([
    receipt('second', 2, 'ACTIONABLE', 'RECORDED', 'ENQUEUED', 'LAUNCH_CANDIDATE'),
  ]));
  await assert.rejects(operation, (error: unknown) => pageError(error, 'ABORTED'));
});

function row(signature: string, slot: number): CatchUpSignature {
  return Object.freeze({
    signature, slot: BigInt(slot), confirmationStatus: 'confirmed', blockTimeMs: 1_000,
    transactionFailed: false,
  });
}

function receipt(
  signature: string,
  slot: number,
  disposition: 'ACTIONABLE' | 'DEFERRED' | 'IGNORED',
  persistence: 'RECORDED' | 'REPLAYED',
  admission: 'ENQUEUED' | 'NOT_ENQUEUED',
  ingestionPriority: 'LAUNCH_CANDIDATE' | null,
): CatchUpClassificationReceipt {
  return createCatchUpClassificationReceipt({
    signature, slot: BigInt(slot), disposition, persistence, admission, ingestionPriority,
  });
}

function pageError(
  error: unknown,
  code: PumpFunStrictCatchUpPageAdmitterError['code'],
): boolean {
  assert.ok(error instanceof PumpFunStrictCatchUpPageAdmitterError);
  assert.equal(error.code, code);
  assert.doesNotMatch(String(error), /first|second|market-row/u);
  return true;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

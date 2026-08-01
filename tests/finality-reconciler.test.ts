import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FinalityReconciler,
  FinalityReconcilerError,
  type FinalityHistoryStatus,
  type FinalityReconcilerRepository,
  type FinalityReconcilerSource,
} from '../src/application/finality-reconciler.js';
import type {
  FinalityCandidate,
  FinalityPollObservation,
  FinalityRevision,
} from '../src/domain/transaction-ingestion.js';

void test('reads statuses in one batch and exactly one finalized root before finalizing rows', async () => {
  const calls: string[] = [];
  const repository = memoryRepository([
    candidate('a', 10n, 'processed'), candidate('b', 11n, 'confirmed'),
  ], calls);
  let statusReads = 0;
  let rootReads = 0;
  const source: FinalityReconcilerSource = {
    async getHistoryStatuses(signatures) {
      statusReads += 1;
      calls.push(`statuses:${signatures.join(',')}`);
      return Object.freeze([
        history(10n, 'finalized'), history(11n, 'finalized'),
      ]);
    },
    async getFinalizedSlot() { rootReads += 1; calls.push('root'); return 12n; },
  };
  const reconciler = new FinalityReconciler(source, repository, { limit: 20, now: () => 1_000 });

  const result = await reconciler.runOnce();

  assert.deepEqual(calls, ['list:20', 'statuses:a,b', 'root', 'revision:a:finalized', 'revision:b:finalized']);
  assert.equal(statusReads, 1);
  assert.equal(rootReads, 1);
  assert.deepEqual(repository.revisions, [
    Object.freeze({ signature: 'a', confirmationStatus: 'finalized', observedAtMs: 1_000 }),
    Object.freeze({ signature: 'b', confirmationStatus: 'finalized', observedAtMs: 1_000 }),
  ]);
  assert.deepEqual(result, { candidateCount: 2, pollCount: 0, revisionCount: 2 });
  assert.ok(Object.isFrozen(result));
});

void test('requires three consecutive missing polls and a strictly higher finalized root', async () => {
  const repository = memoryRepository([candidate('missing', 20n)]);
  let finalizedRoot = 20n;
  const source = sequenceSource(() => null, () => finalizedRoot);
  const reconciler = new FinalityReconciler(source, repository, { limit: 1, now: () => 2_000 });

  await reconciler.runOnce();
  await reconciler.runOnce();
  await reconciler.runOnce();
  assert.equal(repository.revisions.length, 0);
  assert.equal(repository.candidates[0]?.missingFinalityPolls, 3);

  finalizedRoot = 21n;
  await reconciler.runOnce();
  assert.deepEqual(repository.revisions, [
    Object.freeze({ signature: 'missing', confirmationStatus: 'orphaned', observedAtMs: 2_000 }),
  ]);
});

void test('supports threshold two and resets the counter on confirmation or regression', async () => {
  const repository = memoryRepository([
    candidate('reset', 30n, 'confirmed'),
    candidate('regression', 31n, 'confirmed', 2),
  ]);
  let statuses: readonly (FinalityHistoryStatus | null)[] = Object.freeze([
    null, history(31n, 'processed'),
  ]);
  const source: FinalityReconcilerSource = {
    async getHistoryStatuses() { return statuses; },
    async getFinalizedSlot() { return 40n; },
  };
  const reconciler = new FinalityReconciler(source, repository, {
    limit: 2, missingPollThreshold: 2, now: () => 3_000,
  });

  await reconciler.runOnce();
  assert.deepEqual(repository.candidates.map((value) => [
    value.signature, value.confirmationStatus, value.missingFinalityPolls,
  ]), [
    ['reset', 'confirmed', 1], ['regression', 'confirmed', 0],
  ]);

  statuses = Object.freeze([history(30n, 'confirmed'), history(31n, 'confirmed')]);
  await reconciler.runOnce();
  assert.deepEqual(repository.candidates.map((value) => value.missingFinalityPolls), [0, 0]);
  statuses = Object.freeze([null, null]);
  await reconciler.runOnce();
  assert.equal(repository.revisions.length, 0);
  await reconciler.runOnce();
  assert.deepEqual(repository.revisions.map((value) => value.confirmationStatus), [
    'orphaned', 'orphaned',
  ]);
});

void test('throws a fixed contradiction without retracting impossible finalized history', async () => {
  for (const status of [history(39n, 'finalized'), history(40n, 'finalized')] as const) {
    const repository = memoryRepository([candidate('contradiction', 40n, 'confirmed')]);
    const source: FinalityReconcilerSource = {
      async getHistoryStatuses() { return Object.freeze([status]); },
      async getFinalizedSlot() { return status.slot === 40n ? 39n : 50n; },
    };
    const reconciler = new FinalityReconciler(source, repository, { limit: 1 });
    await assert.rejects(reconciler.runOnce(), (error: unknown) => {
      assert.ok(error instanceof FinalityReconcilerError);
      assert.equal(error.stage, 'finality-contradiction');
      assert.equal(error.message, 'Transaction finality reconciliation failed.');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.ok(Object.isFrozen(error));
      return true;
    });
    assert.equal(repository.revisions.length, 0);
    assert.equal(repository.polls.length, 0);
  }
});

void test('does no RPC work for an empty page and rejects unsafe integer options', async () => {
  let reads = 0;
  const source: FinalityReconcilerSource = {
    async getHistoryStatuses() { reads += 1; return Object.freeze([]); },
    async getFinalizedSlot() { reads += 1; return 0n; },
  };
  const empty = new FinalityReconciler(source, memoryRepository([]), { limit: 1 });
  assert.deepEqual(await empty.runOnce(), { candidateCount: 0, pollCount: 0, revisionCount: 0 });
  assert.equal(reads, 0);

  for (const options of [
    { limit: 0 }, { limit: 1.5 }, { limit: 1, missingPollThreshold: 1 },
    { limit: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => new FinalityReconciler(source, memoryRepository([]), options), TypeError);
  }
});

void test('snapshots repository candidates without invoking stateful reads or getters', async () => {
  let reads = 0;
  const stable = candidate('stable', 50n);
  const proxied = new Proxy(stable, {
    get(target, key, receiver) {
      reads += 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const repository = memoryRepository([]);
  repository.listForFinality = async () => Object.freeze([proxied]);
  const source: FinalityReconcilerSource = {
    async getHistoryStatuses(signatures) {
      assert.deepEqual(signatures, Object.freeze(['stable']));
      return Object.freeze([history(50n, 'finalized')]);
    },
    async getFinalizedSlot() { return 51n; },
  };
  await new FinalityReconciler(source, repository, { limit: 1 }).runOnce();
  assert.equal(reads, 0);
  assert.equal(repository.revisions[0]?.signature, 'stable');

  let getterReads = 0;
  const getterCandidate = Object.freeze(Object.defineProperties({}, {
    signature: { enumerable: true, get() { getterReads += 1; return 'https://secret.invalid/getter'; } },
    slot: { enumerable: true, value: 51n },
    confirmationStatus: { enumerable: true, value: 'processed' },
    missingFinalityPolls: { enumerable: true, value: 0 },
    processedAtMs: { enumerable: true, value: 100 },
  })) as FinalityCandidate;
  const rejected = new FinalityReconciler(source, {
    ...memoryRepository([]), async listForFinality() { return Object.freeze([getterCandidate]); },
  }, { limit: 1 });
  await assert.rejects(rejected.runOnce(), (error: unknown) => {
    assert.ok(error instanceof FinalityReconcilerError);
    assert.equal(error.stage, 'list');
    assert.doesNotMatch(String(error), /secret|getter|invalid/u);
    return true;
  });
  assert.equal(getterReads, 0);
});

void test('snapshots poll results and rejects forged missing jumps before orphaning', async () => {
  let reads = 0;
  const original = candidate('poll-proxy', 60n);
  const correct = freezeCandidate({ ...original, missingFinalityPolls: 1 });
  const proxied = new Proxy(correct, {
    get(target, key, receiver) {
      if (key !== 'then') reads += 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const repository = memoryRepository([original]);
  repository.recordFinalityPoll = async () => proxied;
  const reconciler = new FinalityReconciler(
    sequenceSource(() => null, () => 61n), repository,
    { limit: 1, missingPollThreshold: 2 },
  );
  assert.deepEqual(await reconciler.runOnce(), {
    candidateCount: 1, pollCount: 1, revisionCount: 0,
  });
  assert.equal(reads, 0);
  assert.equal(repository.revisions.length, 0);

  let getterReads = 0;
  const getterPoll = Object.freeze(Object.defineProperties({}, {
    signature: { enumerable: true, get() { getterReads += 1; return 'https://secret.invalid/poll'; } },
    slot: { enumerable: true, value: 60n },
    confirmationStatus: { enumerable: true, value: 'processed' },
    missingFinalityPolls: { enumerable: true, value: 1 },
    processedAtMs: { enumerable: true, value: 100 },
  })) as FinalityCandidate;
  const getterRepository = memoryRepository([original]);
  getterRepository.recordFinalityPoll = async () => getterPoll;
  const getterReconciler = new FinalityReconciler(
    sequenceSource(() => null, () => 61n), getterRepository, { limit: 1 },
  );
  await assert.rejects(getterReconciler.runOnce(), (error: unknown) => {
    assert.ok(error instanceof FinalityReconcilerError);
    assert.equal(error.stage, 'poll');
    assert.doesNotMatch(String(error), /secret|poll.invalid/u);
    return true;
  });
  assert.equal(getterReads, 0);
  assert.equal(getterRepository.revisions.length, 0);

  const forgedRepository = memoryRepository([candidate('jump', 62n)]);
  forgedRepository.recordFinalityPoll = async () => candidate('jump', 62n, 'processed', 3);
  const forged = new FinalityReconciler(
    sequenceSource(() => null, () => 63n), forgedRepository,
    { limit: 1, missingPollThreshold: 2 },
  );
  await assert.rejects(forged.runOnce(), (error: unknown) => {
    assert.ok(error instanceof FinalityReconcilerError);
    assert.equal(error.stage, 'poll');
    assert.equal(error.message, 'Transaction finality reconciliation failed.');
    return true;
  });
  assert.equal(forgedRepository.revisions.length, 0);
});

void test('rejects forged non-null reset and downgrade poll results', async () => {
  for (const scenario of [
    {
      current: candidate('bad-reset', 70n, 'processed', 1),
      observed: history(70n, 'confirmed'),
      returned: candidate('bad-reset', 70n, 'confirmed', 1),
    },
    {
      current: candidate('bad-downgrade', 71n, 'confirmed', 1),
      observed: history(71n, 'processed'),
      returned: candidate('bad-downgrade', 71n, 'processed', 0),
    },
  ]) {
    const repository = memoryRepository([scenario.current]);
    repository.recordFinalityPoll = async () => scenario.returned;
    const reconciler = new FinalityReconciler(
      sequenceSource(() => scenario.observed, () => 80n), repository, { limit: 1 },
    );
    await assert.rejects(reconciler.runOnce(), (error: unknown) =>
      error instanceof FinalityReconcilerError && error.stage === 'poll');
    assert.equal(repository.revisions.length, 0);
  }
});

void test('rejects hostile candidate arrays without calling dependency methods or leaking', async () => {
  let methodReads = 0;
  let descriptorReads = 0;
  const target = Object.freeze([candidate('safe', 90n)]);
  const hostile = new Proxy(target, {
    get(array, key, receiver) {
      if (key === 'map' || key === Symbol.iterator) {
        methodReads += 1;
        return () => [candidate('https://secret.invalid/forged', 90n)];
      }
      return Reflect.get(array, key, receiver) as unknown;
    },
    getOwnPropertyDescriptor(array, key) {
      if (key === '0') {
        descriptorReads += 1;
        throw new Error('https://secret.invalid/descriptor');
      }
      return Reflect.getOwnPropertyDescriptor(array, key);
    },
  });
  const repository = memoryRepository([]);
  repository.listForFinality = async () => hostile;
  let sourceReads = 0;
  const reconciler = new FinalityReconciler({
    async getHistoryStatuses() { sourceReads += 1; return Object.freeze([]); },
    async getFinalizedSlot() { sourceReads += 1; return 100n; },
  }, repository, { limit: 1 });

  await assert.rejects(reconciler.runOnce(), (error: unknown) => {
    assert.ok(error instanceof FinalityReconcilerError);
    assert.equal(error.stage, 'list');
    assert.equal(error.message, 'Transaction finality reconciliation failed.');
    assert.doesNotMatch(String(error), /secret|descriptor|forged/u);
    return true;
  });
  assert.equal(methodReads, 0);
  assert.equal(descriptorReads, 1);
  assert.equal(sourceReads, 0);
  assert.equal(repository.revisions.length, 0);
});

interface MemoryRepository extends FinalityReconcilerRepository {
  readonly candidates: FinalityCandidate[];
  readonly polls: FinalityPollObservation[];
  readonly revisions: FinalityRevision[];
}

function memoryRepository(initial: readonly FinalityCandidate[], calls: string[] = []): MemoryRepository {
  const candidates = initial.map((value) => ({ ...value }));
  const polls: FinalityPollObservation[] = [];
  const revisions: FinalityRevision[] = [];
  return {
    candidates,
    polls,
    revisions,
    async listForFinality(limit) { calls.push(`list:${limit}`); return Object.freeze(candidates.slice(0, limit).map(freezeCandidate)); },
    async recordFinalityPoll(value) {
      polls.push(value);
      calls.push(`poll:${value.signature}:${value.confirmationStatus ?? 'missing'}`);
      const index = candidates.findIndex((candidateValue) => candidateValue.signature === value.signature);
      const current = candidates[index];
      assert.ok(current);
      assert.equal(current.missingFinalityPolls, value.expectedMissingFinalityPolls);
      const confirmationStatus = value.confirmationStatus === 'confirmed'
        || (value.confirmationStatus === 'processed' && current.confirmationStatus === 'processed')
        ? value.confirmationStatus
        : current.confirmationStatus;
      const updated = freezeCandidate({
        ...current,
        confirmationStatus,
        missingFinalityPolls: value.confirmationStatus === null
          ? current.missingFinalityPolls + 1
          : 0,
      });
      candidates[index] = updated;
      return updated;
    },
    async enqueueRevision(value) { revisions.push(value); calls.push(`revision:${value.signature}:${value.confirmationStatus}`); },
  };
}

function candidate(
  signature: string,
  slot: bigint,
  confirmationStatus: FinalityCandidate['confirmationStatus'] = 'processed',
  missingFinalityPolls = 0,
): FinalityCandidate {
  return freezeCandidate({ signature, slot, confirmationStatus, missingFinalityPolls, processedAtMs: 100 });
}

function freezeCandidate(value: FinalityCandidate): FinalityCandidate {
  return Object.freeze({ ...value });
}

function history(slot: bigint, confirmationStatus: NonNullable<FinalityHistoryStatus>['confirmationStatus']): FinalityHistoryStatus {
  return Object.freeze({ slot, confirmationStatus });
}

function sequenceSource(
  status: () => FinalityHistoryStatus | null,
  root: () => bigint,
): FinalityReconcilerSource {
  return {
    async getHistoryStatuses(signatures) { return Object.freeze(signatures.map(() => status())); },
    async getFinalizedSlot() { return root(); },
  };
}

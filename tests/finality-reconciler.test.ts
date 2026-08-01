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

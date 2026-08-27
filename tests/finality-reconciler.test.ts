import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  FinalityReconciler,
  FinalityReconcilerError,
} from '../src/application/finality-reconciler.js';
import {
  MAX_FINALITY_EVIDENCE_VERSION,
  type FinalityCandidate,
  type FinalityPollObservation,
  type FinalityRevision,
} from '../src/domain/transaction-ingestion.js';
import type { RpcProviderId } from '../src/domain/rpc-provider.js';
import type {
  FinalityProviderPass,
  FinalityProviderPassSource,
} from '../src/ports/finality-provider-pass.js';

const NOW = 1_000;
const PRIMARY: RpcProviderId = 'primary';
const FALLBACK: RpcProviderId = 'fallback-1';
const LIMIT = 256;

void test('opens no pass for an empty page and binds every pass operation to one provider receiver', async () => {
  const empty = passHarness();
  const emptyRepository = memoryRepository([]);
  const emptyResult = await reconciler(empty.source, emptyRepository, { limit: 1 }).runOnce();
  assert.deepEqual(emptyResult, { candidateCount: 0, pollCount: 0, revisionCount: 0 });
  assert.ok(Object.isFrozen(emptyResult));
  assert.equal(empty.opened, 0);
  assert.deepEqual(empty.calls, []);

  const value = candidate(1, 7n, { missingFinalityPolls: 1, lastMissingFinalityProviderId: PRIMARY, finalityEvidenceVersion: 4n });
  const repository = memoryRepository([value]);
  const source = passHarness({
    history: [null], root: 8n, blocks: new Map([[7n, []]]),
  });
  const result = await reconciler(source.source, repository, { limit: 1, missingPollThreshold: 2, now: () => NOW }).runOnce();

  assert.deepEqual(result, { candidateCount: 1, pollCount: 1, revisionCount: 1 });
  assert.deepEqual(source.calls, ['open:primary', 'history:primary', 'root:primary', 'block:primary:7']);
  assert.deepEqual(repository.polls, [Object.freeze({
    signature: value.signature, confirmationStatus: null, providerId: PRIMARY,
    expectedMissingFinalityPolls: 1, expectedLastMissingFinalityProviderId: PRIMARY,
    expectedFinalityEvidenceVersion: 4n, observedAtMs: NOW,
  })]);
  assert.deepEqual(repository.revisions, [Object.freeze({
    signature: value.signature, confirmationStatus: 'orphaned', expectedConfirmationStatus: 'processed',
    expectedMissingFinalityPolls: 2, expectedLastMissingFinalityProviderId: PRIMARY,
    expectedFinalityEvidenceVersion: 5n, observedAtMs: NOW,
  })]);
});

void test('fails malformed pass capabilities without reading accessors or shadowed call properties', async () => {
  let getterReads = 0;
  const accessorSource = Object.freeze(Object.defineProperty({}, 'openPass', {
    enumerable: true, get() { getterReads += 1; return () => undefined; },
  })) as FinalityProviderPassSource;
  await fails(reconciler(accessorSource, memoryRepository([candidate(2, 2n)]), { limit: 1 }).runOnce(), 'pass');
  assert.equal(getterReads, 0);

  const pass = passHarness();
  Object.defineProperty(pass.source.openPass, 'call', {
    configurable: true, get() { getterReads += 1; throw new Error('https://secret.invalid/open-pass-call'); },
  });
  const getHistoryStatuses = pass.pass.getHistoryStatuses;
  Object.defineProperty(getHistoryStatuses, 'call', {
    configurable: true, get() { getterReads += 1; throw new Error('https://secret.invalid/call'); },
  });
  Object.defineProperty(pass.pass, 'getFinalizedSlot', {
    configurable: true, enumerable: true, get() { getterReads += 1; return async () => 3n; },
  });
  await fails(reconciler(pass.source, memoryRepository([candidate(3, 2n)]), { limit: 1 }).runOnce(), 'pass');
  assert.equal(getterReads, 0);
});

void test('accepts the 256 maximum and rejects every invalid or oversized limit', () => {
  const source = passHarness().source;
  assert.doesNotThrow(() => reconciler(source, memoryRepository([]), { limit: LIMIT }));
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 257, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => reconciler(source, memoryRepository([]), { limit }));
  }
});

void test('enqueues already finalized candidates without a poll or block proof', async () => {
  const value = candidate(4, 9n, { confirmationStatus: 'confirmed' });
  const repository = memoryRepository([value]);
  const source = passHarness({ history: [history(9n, 'finalized')], root: 9n });
  const result = await reconciler(source.source, repository, { limit: 1, now: () => NOW }).runOnce();
  assert.deepEqual(result, { candidateCount: 1, pollCount: 0, revisionCount: 1 });
  assert.deepEqual(repository.revisions, [Object.freeze({
    signature: value.signature, confirmationStatus: 'finalized', observedAtMs: NOW,
  })]);
  assert.deepEqual(source.calls, ['open:primary', 'history:primary', 'root:primary']);
});

void test('validates every history slot and finalized root before the first repository mutation', async () => {
  const scenarios = [
    { name: 'mismatched status slot', status: history(14n, 'confirmed'), root: 16n },
    { name: 'finalized above root', status: history(15n, 'finalized'), root: 14n },
  ] as const;
  for (const { name, status, root } of scenarios) {
    const alreadyFinalized = candidate(54, 13n, { confirmationStatus: 'confirmed' });
    const contradictory = candidate(55, 15n);
    const repository = memoryRepository([alreadyFinalized, contradictory]);
    const source = passHarness({
      history: [history(13n, 'finalized'), status], root,
    });

    await fails(
      reconciler(source.source, repository, { limit: 2 }).runOnce(),
      'finality-contradiction',
    );

    assert.deepEqual(source.calls, [
      'open:primary', 'history:primary', 'root:primary',
    ], name);
    assert.equal(repository.polls.length, 0, name);
    assert.equal(repository.revisions.length, 0, name);
    assert.equal(source.calls.some((call) => call.startsWith('block:')), false, name);
  }
});

void test('proves an absent signature before enqueuing an orphan with its exact evidence revision', async () => {
  const value = candidate(5, 10n, {
    confirmationStatus: 'confirmed', missingFinalityPolls: 1,
    lastMissingFinalityProviderId: PRIMARY, finalityEvidenceVersion: 11n,
  });
  const repository = memoryRepository([value]);
  const source = passHarness({ history: [null], root: 11n, blocks: new Map([[10n, []]]) });
  await reconciler(source.source, repository, { limit: 1, missingPollThreshold: 2, now: () => NOW }).runOnce();
  assert.deepEqual(repository.revisions, [Object.freeze({
    signature: value.signature, confirmationStatus: 'orphaned', expectedConfirmationStatus: 'confirmed',
    expectedMissingFinalityPolls: 2, expectedLastMissingFinalityProviderId: PRIMARY,
    expectedFinalityEvidenceVersion: 12n, observedAtMs: NOW,
  })]);
});

void test('uses provider-scoped missing evidence, resets it on a present status, and requires a strictly higher root', async () => {
  const fallback = candidate(6, 20n, { missingFinalityPolls: 2, lastMissingFinalityProviderId: PRIMARY, finalityEvidenceVersion: 3n });
  const fallbackRepository = memoryRepository([fallback]);
  const fallbackSource = passHarness({ providerId: FALLBACK, history: [null], root: 21n });
  await reconciler(fallbackSource.source, fallbackRepository, {
    limit: 1, missingPollThreshold: 2,
  }).runOnce();
  assert.deepEqual(finalityState(fallbackRepository.candidates[0]), [1, FALLBACK, 4n]);
  assert.equal(fallbackRepository.revisions.length, 0);
  assert.equal(fallbackSource.calls.some((value) => value.startsWith('block:')), false);

  const present = candidate(7, 20n, { missingFinalityPolls: 2, lastMissingFinalityProviderId: PRIMARY, finalityEvidenceVersion: 3n });
  const presentRepository = memoryRepository([present]);
  const presentSource = passHarness({ history: [history(20n, 'confirmed')], root: 21n });
  await reconciler(presentSource.source, presentRepository, { limit: 1 }).runOnce();
  assert.deepEqual(finalityState(presentRepository.candidates[0]), [0, null, 4n]);
  assert.equal(presentSource.calls.some((value) => value.startsWith('block:')), false);

  const equalRoot = candidate(8, 20n, { missingFinalityPolls: 1, lastMissingFinalityProviderId: PRIMARY });
  const equalSource = passHarness({ history: [null], root: 20n });
  await reconciler(equalSource.source, memoryRepository([equalRoot]), { limit: 1, missingPollThreshold: 2 }).runOnce();
  assert.equal(equalSource.calls.some((value) => value.startsWith('block:')), false);
});

void test('rejects a present eligible signature as a finality contradiction before orphaning', async () => {
  const value = candidate(9, 30n, { missingFinalityPolls: 1, lastMissingFinalityProviderId: PRIMARY });
  const repository = memoryRepository([value]);
  const source = passHarness({ history: [null], root: 31n, blocks: new Map([[30n, [value.signature]]]) });
  await fails(reconciler(source.source, repository, { limit: 1, missingPollThreshold: 2 }).runOnce(), 'finality-contradiction');
  assert.equal(repository.revisions.length, 0);
});

void test('fails closed on null, rejected, malformed, sparse, duplicate, oversized, or noncanonical blocks', async () => {
  let accessorReads = 0;
  const accessorBlock: string[] = [];
  Object.defineProperty(accessorBlock, '0', {
    configurable: true,
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error('https://secret.invalid/block-accessor');
    },
  });
  Object.freeze(accessorBlock);
  const customPrototypeBlock = [signature(60)];
  Object.setPrototypeOf(customPrototypeBlock, Object.create(Array.prototype));
  Object.freeze(customPrototypeBlock);
  const sixtyThreeByteSignature = bs58.encode(Buffer.alloc(63, 1));
  const sixtyFiveByteSignature = bs58.encode(Buffer.alloc(65, 1));
  assert.equal(bs58.decode(sixtyThreeByteSignature).length, 63);
  assert.equal(bs58.decode(sixtyFiveByteSignature).length, 65);
  const values: readonly [string, unknown][] = [
    ['null', null], ['rejected', new Error('https://secret.invalid/block')], ['object', Object.freeze({})],
    ['sparse', Object.assign(new Array<string>(1), {})], ['duplicate', Object.freeze([signature(11), signature(11)])],
    ['oversized', Object.freeze(Array.from({ length: 10_001 }, (_, index) => signature(index + 12)))],
    ['noncanonical', Object.freeze(['noncanonical'])], ['accessor', accessorBlock],
    ['custom prototype', customPrototypeBlock],
    ['63-byte signature', Object.freeze([sixtyThreeByteSignature])],
    ['65-byte signature', Object.freeze([sixtyFiveByteSignature])],
  ];
  for (const [name, block] of values) {
    const value = candidate(10, 40n, { missingFinalityPolls: 1, lastMissingFinalityProviderId: PRIMARY });
    const repository = memoryRepository([value]);
    const source = passHarness({ history: [null], root: 41n, blocks: new Map([[40n, block]]) });
    await fails(reconciler(source.source, repository, { limit: 1, missingPollThreshold: 2 }).runOnce(), 'block');
    assert.equal(repository.revisions.length, 0, name);
  }
  assert.equal(accessorReads, 0);
});

void test('detaches proxy block evidence without consulting its poisoned iterator', async () => {
  const value = candidate(61, 45n, {
    missingFinalityPolls: 1,
    lastMissingFinalityProviderId: PRIMARY,
  });
  const repository = memoryRepository([value]);
  const unrelatedSignature = signature(62);
  const callerOwnedBlock = [unrelatedSignature];
  let iteratorReads = 0;
  const hostileBlock = new Proxy(callerOwnedBlock, {
    get(target, key, receiver) {
      if (key === Symbol.iterator) {
        iteratorReads += 1;
        target.push(value.signature);
        throw new Error('https://secret.invalid/block-iterator');
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  assert.equal(Array.isArray(hostileBlock), true);
  assert.equal(Object.getPrototypeOf(hostileBlock), Array.prototype);
  const source = passHarness({
    history: [null], root: 46n, blocks: new Map([[45n, hostileBlock]]),
  });

  const runResult = await reconciler(source.source, repository, {
    limit: 1, missingPollThreshold: 2, now: () => NOW,
  }).runOnce();

  assert.equal(iteratorReads, 0);
  assert.deepEqual(callerOwnedBlock, [unrelatedSignature]);
  assert.equal(Object.isFrozen(callerOwnedBlock), false);
  assert.equal(Object.isFrozen(hostileBlock), false);
  assert.deepEqual(runResult, { candidateCount: 1, pollCount: 1, revisionCount: 1 });
  const expectedRevision = Object.freeze({
    signature: value.signature, confirmationStatus: 'orphaned',
    expectedConfirmationStatus: 'processed', expectedMissingFinalityPolls: 2,
    expectedLastMissingFinalityProviderId: PRIMARY, expectedFinalityEvidenceVersion: 1n,
    observedAtMs: NOW,
  });
  assert.deepEqual(repository.revisions, [expectedRevision]);

  hostileBlock.push(value.signature);
  assert.equal(iteratorReads, 0);
  assert.deepEqual(callerOwnedBlock, [unrelatedSignature, value.signature]);
  assert.deepEqual(runResult, { candidateCount: 1, pollCount: 1, revisionCount: 1 });
  assert.deepEqual(repository.revisions, [expectedRevision]);
});

void test('shares one block read by slot and validates that block before enqueuing any orphan', async () => {
  const first = candidate(12, 50n, { missingFinalityPolls: 1, lastMissingFinalityProviderId: PRIMARY });
  const second = candidate(13, 50n, { missingFinalityPolls: 1, lastMissingFinalityProviderId: PRIMARY });
  const repository = memoryRepository([first, second]);
  const source = passHarness({ history: [null, null], root: 51n, blocks: new Map([[50n, []]]) });
  await reconciler(source.source, repository, { limit: 2, missingPollThreshold: 2 }).runOnce();
  assert.deepEqual(source.calls.filter((value) => value.startsWith('block:')), ['block:primary:50']);
  assert.equal(repository.revisions.length, 2);

  const malformedRepository = memoryRepository([first, second]);
  const malformed = passHarness({ history: [null, null], root: 51n, blocks: new Map([[50n, Object.freeze([signature(14), signature(14)])]]) });
  await fails(reconciler(malformed.source, malformedRepository, { limit: 2, missingPollThreshold: 2 }).runOnce(), 'block');
  assert.equal(malformedRepository.revisions.length, 0);
});

void test('caps absent-slot block proof work at sixteen unique slots in candidate order', async () => {
  const values = Array.from({ length: 17 }, (_, index) => candidate(index + 20, BigInt(100 + index), {
    missingFinalityPolls: 1, lastMissingFinalityProviderId: PRIMARY,
  }));
  const blocks = new Map<bigint, unknown>(values.map((value) => [value.slot, Object.freeze([])]));
  const repository = memoryRepository(values);
  const source = passHarness({ history: values.map(() => null), root: 200n, blocks });
  const result = await reconciler(source.source, repository, { limit: 17, missingPollThreshold: 2 }).runOnce();
  assert.deepEqual(result, { candidateCount: 17, pollCount: 17, revisionCount: 16 });
  assert.deepEqual(source.calls.filter((value) => value.startsWith('block:')), values.slice(0, 16).map((value) => `block:primary:${value.slot}`));
  assert.deepEqual(repository.revisions.map((value) => value.signature), values.slice(0, 16).map((value) => value.signature));
});

void test('reads eligible blocks sequentially without starting the next slot early', async () => {
  const first = candidate(63, 110n, {
    missingFinalityPolls: 1, lastMissingFinalityProviderId: PRIMARY,
  });
  const second = candidate(64, 111n, {
    missingFinalityPolls: 1, lastMissingFinalityProviderId: PRIMARY,
  });
  const firstBlock = deferred<unknown>();
  const secondBlock = deferred<unknown>();
  const source = passHarness({
    history: [null, null],
    root: 112n,
    blocks: new Map([[110n, firstBlock.promise], [111n, secondBlock.promise]]),
  });
  const repository = memoryRepository([first, second]);

  const operation = reconciler(source.source, repository, {
    limit: 2, missingPollThreshold: 2,
  }).runOnce();
  await waitUntil(() => blockCalls(source.calls).length === 1);
  assert.deepEqual(blockCalls(source.calls), ['block:primary:110']);

  firstBlock.resolve(Object.freeze([]));
  await waitUntil(() => blockCalls(source.calls).length === 2);
  assert.deepEqual(blockCalls(source.calls), ['block:primary:110', 'block:primary:111']);

  secondBlock.resolve(Object.freeze([]));
  assert.deepEqual(await operation, { candidateCount: 2, pollCount: 2, revisionCount: 2 });
});

void test('turns a stale provider/count/version race at orphan enqueue into a redacted revision failure', async () => {
  const value = candidate(40, 70n, { missingFinalityPolls: 1, lastMissingFinalityProviderId: PRIMARY, finalityEvidenceVersion: 3n });
  const repository = memoryRepository([value]);
  repository.beforeEnqueue = () => {
    repository.replace(value.signature, {
      missingFinalityPolls: 1, lastMissingFinalityProviderId: FALLBACK, finalityEvidenceVersion: 5n,
    });
  };
  await fails(reconciler(passHarness({ history: [null], root: 71n, blocks: new Map([[70n, []]]) }).source, repository, {
    limit: 1, missingPollThreshold: 2,
  }).runOnce(), 'revision');
  assert.equal(repository.revisions.length, 0);
});

void test('rejects forged poll evidence versions and provider/count/status transitions before block work', async () => {
  const initial = candidate(41, 80n, { missingFinalityPolls: 1, lastMissingFinalityProviderId: PRIMARY, finalityEvidenceVersion: 5n });
  const forged = [
    { finalityEvidenceVersion: 5n }, { finalityEvidenceVersion: 4n }, { finalityEvidenceVersion: 7n },
    { finalityEvidenceVersion: MAX_FINALITY_EVIDENCE_VERSION }, { finalityEvidenceVersion: MAX_FINALITY_EVIDENCE_VERSION + 1n },
    { missingFinalityPolls: 3 }, { lastMissingFinalityProviderId: FALLBACK }, { confirmationStatus: 'confirmed' as const },
  ];
  for (const patch of forged) {
    const repository = memoryRepository([initial]);
    repository.recordFinalityPoll = async () => freezeCandidate({
      ...initial, missingFinalityPolls: 2, lastMissingFinalityProviderId: PRIMARY,
      finalityEvidenceVersion: 6n, ...patch,
    });
    const source = passHarness({ history: [null], root: 81n, blocks: new Map([[80n, []]]) });
    await fails(reconciler(source.source, repository, { limit: 1, missingPollThreshold: 2 }).runOnce(), 'poll');
    assert.equal(source.calls.some((value) => value.startsWith('block:')), false);
  }
});

void test('rejects every hostile returned-candidate identity change before block work', async () => {
  const initial = candidate(65, 82n, {
    missingFinalityPolls: 1,
    lastMissingFinalityProviderId: PRIMARY,
    finalityEvidenceVersion: 5n,
  });
  const identityPatches: readonly Partial<FinalityCandidate>[] = [
    { signature: signature(66) },
    { slot: 83n },
    { processedAtMs: initial.processedAtMs + 1 },
  ];
  for (const patch of identityPatches) {
    const repository = memoryRepository([initial]);
    repository.recordFinalityPoll = async () => freezeCandidate({
      ...initial,
      missingFinalityPolls: 2,
      lastMissingFinalityProviderId: PRIMARY,
      finalityEvidenceVersion: 6n,
      ...patch,
    });
    const source = passHarness({
      history: [null], root: 84n, blocks: new Map([[82n, Object.freeze([])]]),
    });

    await fails(reconciler(source.source, repository, {
      limit: 1, missingPollThreshold: 2,
    }).runOnce(), 'poll');

    assert.equal(source.calls.some((call) => call.startsWith('block:')), false);
    assert.equal(repository.revisions.length, 0);
  }
});

void test('rejects an exhausted initial evidence version without invoking the poll repository or block', async () => {
  const initial = candidate(67, 85n, {
    finalityEvidenceVersion: MAX_FINALITY_EVIDENCE_VERSION,
  });
  const repository = memoryRepository([initial]);
  let pollCalls = 0;
  repository.recordFinalityPoll = async () => {
    pollCalls += 1;
    throw new Error('https://secret.invalid/exhausted-poll');
  };
  const source = passHarness({ history: [null], root: 86n });

  await fails(reconciler(source.source, repository, { limit: 1 }).runOnce(), 'poll');

  assert.equal(pollCalls, 0);
  assert.equal(source.calls.some((call) => call.startsWith('block:')), false);
  assert.equal(repository.revisions.length, 0);
});

void test('captures prototype pass capabilities without call access and keeps the original provider evidence', async () => {
  let callGetterReads = 0;
  const calls: string[] = [];
  const value = candidate(68, 87n, {
    missingFinalityPolls: 1,
    lastMissingFinalityProviderId: PRIMARY,
    finalityEvidenceVersion: 2n,
  });
  interface MutablePass {
    providerId: RpcProviderId;
  }
  const historyMethod = async function getHistoryStatuses(this: MutablePass): Promise<unknown> {
    assert.equal(this, rawPass);
    calls.push(`history:${this.providerId}`);
    this.providerId = FALLBACK;
    return Object.freeze([null]);
  };
  const rootMethod = async function getFinalizedSlot(this: MutablePass): Promise<unknown> {
    assert.equal(this, rawPass);
    calls.push(`root:${this.providerId}`);
    return 88n;
  };
  const blockMethod = async function getFinalizedBlockSignatures(
    this: MutablePass,
    slot: bigint,
  ): Promise<unknown> {
    assert.equal(this, rawPass);
    calls.push(`block:${this.providerId}:${slot}`);
    return Object.freeze([]);
  };
  const openMethod = function openPass(this: FinalityProviderPassSource): unknown {
    assert.equal(this, source);
    calls.push('open:primary');
    return rawPass;
  };
  for (const method of [openMethod, historyMethod, rootMethod, blockMethod]) {
    Object.defineProperty(method, 'call', {
      configurable: true,
      get() {
        callGetterReads += 1;
        throw new Error('https://secret.invalid/prototype-call');
      },
    });
  }
  const passPrototype = Object.freeze({
    getHistoryStatuses: historyMethod,
    getFinalizedSlot: rootMethod,
    getFinalizedBlockSignatures: blockMethod,
  });
  const rawPass = Object.assign(Object.create(passPrototype), { providerId: PRIMARY }) as MutablePass;
  const source = Object.create(Object.freeze({ openPass: openMethod })) as FinalityProviderPassSource;
  const repository = memoryRepository([value]);

  const runResult = await reconciler(source, repository, {
    limit: 1, missingPollThreshold: 2, now: () => NOW,
  }).runOnce();

  assert.deepEqual(runResult, { candidateCount: 1, pollCount: 1, revisionCount: 1 });
  assert.deepEqual(calls, [
    'open:primary', 'history:primary', 'root:fallback-1', 'block:fallback-1:87',
  ]);
  assert.equal(rawPass.providerId, FALLBACK);
  assert.equal(callGetterReads, 0);
  assert.equal(repository.polls[0]?.providerId, PRIMARY);
  assert.equal(repository.revisions[0]?.confirmationStatus, 'orphaned');
  assert.equal(
    repository.revisions[0]?.confirmationStatus === 'orphaned'
      ? repository.revisions[0].expectedLastMissingFinalityProviderId
      : null,
    PRIMARY,
  );
});

void test('rejects hostile candidate and history arrays, invalid clocks, and keeps fixed errors redacted', async () => {
  let candidateGetterReads = 0;
  const hostileCandidates = new Proxy(Object.freeze([candidate(50, 90n)]), {
    get(target, key, receiver) {
      if (key === Symbol.iterator || key === 'map') candidateGetterReads += 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
    getOwnPropertyDescriptor(target, key) {
      if (key === '0') throw new Error('https://secret.invalid/candidates');
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const hostileRepository = memoryRepository([]);
  hostileRepository.listForFinality = async () => hostileCandidates as unknown as readonly FinalityCandidate[];
  await fails(reconciler(passHarness().source, hostileRepository, { limit: 1 }).runOnce(), 'list');
  assert.equal(candidateGetterReads, 0);

  const historyRepository = memoryRepository([candidate(51, 91n)]);
  const hostileHistory = new Proxy(Object.freeze([null]), {
    getOwnPropertyDescriptor(target, key) {
      if (key === '0') throw new Error('https://secret.invalid/history');
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  await fails(reconciler(passHarness({ history: hostileHistory }).source, historyRepository, { limit: 1 }).runOnce(), 'history');

  for (const now of [() => -1, () => 1.5, () => { throw new Error('https://secret.invalid/clock'); }]) {
    await fails(reconciler(passHarness({ history: [history(91n, 'finalized')], root: 91n }).source, memoryRepository([candidate(52, 91n)]), {
      limit: 1, now,
    }).runOnce(), 'clock');
  }
});

interface MemoryRepository {
  readonly candidates: FinalityCandidate[];
  readonly polls: FinalityPollObservation[];
  readonly revisions: FinalityRevision[];
  beforeEnqueue: (() => void) | undefined;
  listForFinality(limit: number): Promise<readonly FinalityCandidate[]>;
  recordFinalityPoll(value: FinalityPollObservation): Promise<FinalityCandidate>;
  enqueueRevision(value: FinalityRevision): Promise<void>;
  replace(signature: string, patch: Partial<FinalityCandidate>): void;
}

function memoryRepository(initial: readonly FinalityCandidate[]): MemoryRepository {
  const candidates = initial.map(freezeCandidate);
  const polls: FinalityPollObservation[] = [];
  const revisions: FinalityRevision[] = [];
  const repository: MemoryRepository = {
    candidates, polls, revisions, beforeEnqueue: undefined,
    async listForFinality(limit) { return Object.freeze(candidates.slice(0, limit)); },
    async recordFinalityPoll(value) {
      polls.push(value);
      const index = candidates.findIndex((candidateValue) => candidateValue.signature === value.signature);
      const current = candidates[index];
      assert.ok(current);
      assert.equal(value.expectedMissingFinalityPolls, current.missingFinalityPolls);
      assert.equal(value.expectedLastMissingFinalityProviderId, current.lastMissingFinalityProviderId);
      assert.equal(value.expectedFinalityEvidenceVersion, current.finalityEvidenceVersion);
      assert.equal(value.providerId === PRIMARY || value.providerId === FALLBACK, true);
      if (current.finalityEvidenceVersion >= MAX_FINALITY_EVIDENCE_VERSION) throw new Error('version');
      const missing = value.confirmationStatus === null
        ? current.lastMissingFinalityProviderId === value.providerId ? current.missingFinalityPolls + 1 : 1
        : 0;
      const updated = freezeCandidate({
        ...current,
        confirmationStatus: value.confirmationStatus === null
          ? current.confirmationStatus
          : current.confirmationStatus === 'confirmed' || value.confirmationStatus === 'confirmed' ? 'confirmed' : 'processed',
        missingFinalityPolls: missing,
        lastMissingFinalityProviderId: value.confirmationStatus === null ? value.providerId : null,
        finalityEvidenceVersion: current.finalityEvidenceVersion + 1n,
      });
      candidates[index] = updated;
      return updated;
    },
    async enqueueRevision(value) {
      repository.beforeEnqueue?.();
      const current = candidates.find((candidateValue) => candidateValue.signature === value.signature);
      assert.ok(current);
      if (value.confirmationStatus === 'orphaned') {
        assert.equal(value.expectedConfirmationStatus, current.confirmationStatus);
        assert.equal(value.expectedMissingFinalityPolls, current.missingFinalityPolls);
        assert.equal(value.expectedLastMissingFinalityProviderId, current.lastMissingFinalityProviderId);
        assert.equal(value.expectedFinalityEvidenceVersion, current.finalityEvidenceVersion);
      }
      revisions.push(value);
    },
    replace(signature, patch) {
      const index = candidates.findIndex((candidateValue) => candidateValue.signature === signature);
      assert.notEqual(index, -1);
      const current = candidates[index];
      assert.ok(current);
      candidates[index] = freezeCandidate({ ...current, ...patch });
    },
  };
  return repository;
}

interface PassHarnessOptions {
  readonly providerId?: RpcProviderId;
  readonly history?: unknown;
  readonly root?: unknown;
  readonly blocks?: ReadonlyMap<bigint, unknown>;
}

function passHarness(options: PassHarnessOptions = {}) {
  const providerId = options.providerId ?? PRIMARY;
  const calls: string[] = [];
  let opened = 0;
  const pass: FinalityProviderPass = {
    providerId,
    async getHistoryStatuses() { assert.equal(this, pass); calls.push(`history:${this.providerId}`); return options.history ?? Object.freeze([]); },
    async getFinalizedSlot() { assert.equal(this, pass); calls.push(`root:${this.providerId}`); return options.root ?? 0n; },
    async getFinalizedBlockSignatures(slot) {
      assert.equal(this, pass); calls.push(`block:${this.providerId}:${slot}`);
      const value = options.blocks?.has(slot) === true
        ? options.blocks.get(slot)
        : Object.freeze([]);
      if (value instanceof Error) throw value;
      return value;
    },
  };
  const openPass = function openPass(this: FinalityProviderPassSource): FinalityProviderPass {
    assert.equal(this, source); opened += 1; calls.push(`open:${providerId}`); return pass;
  };
  const source: FinalityProviderPassSource = { openPass };
  return { source, pass, calls, get opened() { return opened; } };
}

function reconciler(source: FinalityProviderPassSource, repository: MemoryRepository, options: { readonly limit: number; readonly missingPollThreshold?: number; readonly now?: () => number }) {
  return new FinalityReconciler(source as never, repository as never, options);
}

function candidate(byte: number, slot: bigint, patch: Partial<FinalityCandidate> = {}): FinalityCandidate {
  return freezeCandidate({
    signature: signature(byte), slot, confirmationStatus: 'processed', missingFinalityPolls: 0,
    lastMissingFinalityProviderId: null, finalityEvidenceVersion: 0n, processedAtMs: 100, ...patch,
  });
}

function freezeCandidate(value: FinalityCandidate): FinalityCandidate { return Object.freeze({ ...value }); }

function history(slot: bigint, confirmationStatus: 'processed' | 'confirmed' | 'finalized') {
  return Object.freeze({ slot, confirmationStatus });
}

function signature(byte: number): string { return bs58.encode(Buffer.alloc(64, byte)); }

function finalityState(value: FinalityCandidate | undefined) {
  assert.ok(value);
  return [value.missingFinalityPolls, value.lastMissingFinalityProviderId, value.finalityEvidenceVersion];
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  assert.ok(resolvePromise);
  return Object.freeze({ promise, resolve: resolvePromise });
}

async function waitUntil(condition: () => boolean, maximumTurns = 100): Promise<void> {
  for (let turn = 0; turn < maximumTurns; turn += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  assert.fail('Condition was not reached within the bounded event-loop turns.');
}

function blockCalls(calls: readonly string[]): readonly string[] {
  return calls.filter((call) => call.startsWith('block:'));
}

async function fails(operation: Promise<unknown>, stage: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof FinalityReconcilerError);
    assert.equal((error as { stage: unknown }).stage, stage);
    assert.equal(error.message, 'Transaction finality reconciliation failed.');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.ok(Object.isFrozen(error));
    assert.doesNotMatch(String(error), /secret|invalid|candidates|history|clock|block/u);
    return true;
  });
}

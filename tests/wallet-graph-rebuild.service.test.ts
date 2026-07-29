import assert from 'node:assert/strict';
import test from 'node:test';
import { WalletGraphAnalyzer } from '../src/analytics/wallet-graph-analyzer.js';
import {
  WalletGraphLaunchNotFoundError,
  WalletGraphRebuildService,
} from '../src/application/wallet-graph-rebuild.service.js';
import type { WalletClusterDetectedEventV1 } from '../src/domain/wallet-graph-events.js';
import type {
  WalletGraphAnalysis,
  WalletGraphInput,
  WalletGraphProjection,
} from '../src/domain/wallet-graph.js';
import type {
  WalletGraphRepository,
  WalletGraphTransaction,
} from '../src/ports/wallet-graph-repository.js';
import {
  assessment,
  buy,
  graphInput,
} from './helpers/wallet-graph-fixture.js';

void test('rebuilds atomically with deterministic as-of and minimum finality', async () => {
  const earlier = buy('earlier', 'buyer-a', 2, {
    confirmationStatus: 'finalized',
  });
  const later = buy('later', 'buyer-b', 4, {
    confirmationStatus: 'processed',
  });
  const input = graphInput({
    launch: Object.freeze({
      ...graphInput().launch,
      confirmationStatus: 'confirmed',
    }),
    positions: Object.freeze([]),
    buys: Object.freeze([later, earlier]),
    assessments: Object.freeze([
      assessment(later, 'NO_EVIDENCE', []),
      assessment(earlier, 'NO_EVIDENCE', []),
    ]),
    evidence: Object.freeze([]),
  });
  const repository = new FakeRepository(input);
  const projection = await new WalletGraphRebuildService(repository).rebuild('mint');

  assert.equal(projection.asOf.eventId, later.eventId);
  assert.equal(projection.asOf.signature, later.signature);
  assert.equal(projection.confirmationStatus, 'processed');
  assert.deepEqual(projection.confirmationCounts, {
    processed: 1,
    confirmed: 1,
    finalized: 1,
  });
  assert.equal(repository.replacements.length, 1);
  assert.equal(repository.replacements[0]?.event.type, 'WalletClusterDetected');
  assert.equal(Object.isFrozen(projection), true);
});

void test('persists a successful available projection with zero clusters', async () => {
  const input = graphInput({
    positions: Object.freeze([]),
    buys: Object.freeze([]),
    assessments: Object.freeze([]),
    evidence: Object.freeze([]),
  });
  const repository = new FakeRepository(input);
  const projection = await new WalletGraphRebuildService(repository).rebuild('mint');

  assert.deepEqual(projection.clusters, []);
  assert.equal(projection.asOf.eventId, input.launch.eventId);
  assert.equal(repository.replacements.length, 1);
});

void test('rejects absent or invalid canonical input before analysis and writing', async () => {
  const absent = new FakeRepository(null);
  await assert.rejects(
    () => new WalletGraphRebuildService(absent).rebuild('mint'),
    WalletGraphLaunchNotFoundError,
  );

  const canonical = graphInput();
  const invalid = Object.freeze({
    ...canonical,
    inputFingerprint: '',
  });
  const invalidRepository = new FakeRepository(invalid);
  let analyzed = false;
  const analyzer = {
    analyze(): WalletGraphAnalysis {
      analyzed = true;
      return new WalletGraphAnalyzer().analyze(canonical);
    },
  };
  await assert.rejects(
    () => new WalletGraphRebuildService(invalidRepository, analyzer).rebuild('mint'),
    /inputFingerprint/u,
  );
  assert.equal(analyzed, false);
  assert.equal(invalidRepository.replacements.length, 0);
});

void test('propagates analyzer and repository failures without an extra write', async () => {
  const analysisFailure = new Error('analysis failed');
  const first = new FakeRepository(graphInput());
  const analyzer = {
    analyze(): never {
      throw analysisFailure;
    },
  };
  await assert.rejects(
    () => new WalletGraphRebuildService(first, analyzer).rebuild('mint'),
    analysisFailure,
  );
  assert.equal(first.replacements.length, 0);

  const repositoryFailure = new Error('repository failed');
  const second = new FakeRepository(graphInput(), repositoryFailure);
  await assert.rejects(
    () => new WalletGraphRebuildService(second).rebuild('mint'),
    repositoryFailure,
  );
});

class FakeRepository implements WalletGraphRepository {
  public readonly replacements: {
    readonly projection: WalletGraphProjection;
    readonly event: WalletClusterDetectedEventV1;
  }[] = [];

  public constructor(
    private readonly input: WalletGraphInput | null,
    private readonly replacementFailure?: Error,
  ) {}

  public async transact<TResult>(
    _mint: string,
    operation: (transaction: WalletGraphTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return operation({
      loadCanonicalInput: async () => this.input,
      replaceProjection: async (projection, event) => {
        if (this.replacementFailure !== undefined) throw this.replacementFailure;
        this.replacements.push({ projection, event });
      },
    });
  }
}

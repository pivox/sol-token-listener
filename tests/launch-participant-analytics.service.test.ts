import assert from 'node:assert/strict';
import test from 'node:test';
import { ObservedHolderAnalyzer } from '../src/analytics/observed-holder-analyzer.js';
import {
  LaunchParticipantAnalyticsService,
  ParticipantAnalyticsLaunchNotFoundError,
} from '../src/application/launch-participant-analytics.service.js';
import type {
  ParticipantAnalyticsInput,
  ParticipantAnalyticsProjection,
  ParticipantAnalyticsTrade,
} from '../src/domain/participant-analytics.js';
import type { ParticipantAnalyticsDerivedEventV1 } from '../src/domain/participant-analytics-events.js';
import type {
  ParticipantAnalyticsRepository,
  ParticipantAnalyticsTransaction,
} from '../src/ports/participant-analytics-repository.js';

void test('reconstruit les deux projections avec le dernier curseur et la finalité active minimale', async () => {
  const later = trade('later', 4, 'processed');
  const earlier = trade('earlier', 2, 'confirmed');
  const repository = new FakeRepository(makeInput([later, earlier], 'finalized'));
  const service = new LaunchParticipantAnalyticsService(repository);

  const projection = await service.rebuild('mint');

  assert.equal(projection.asOf.eventId, 'later-event');
  assert.equal(projection.confirmationStatus, 'processed');
  assert.deepEqual(projection.confirmationCounts, {
    processed: 1,
    confirmed: 1,
    finalized: 1,
  });
  assert.equal(repository.replacements.length, 1);
  assert.deepEqual(repository.replacements[0]?.events.map((event) => event.type), [
    'CreatorProfileUpdated',
    'HolderDistributionUpdated',
  ]);
  assert.equal(Object.isFrozen(projection), true);
});

void test('utilise le lancement comme curseur lorsqu’aucun trade actif n’existe', async () => {
  const repository = new FakeRepository(makeInput([], 'confirmed'));

  const projection = await new LaunchParticipantAnalyticsService(repository).rebuild('mint');

  assert.equal(projection.asOf.eventId, 'launch-event');
  assert.equal(projection.asOf.signature, 'create-signature');
  assert.equal(projection.confirmationStatus, 'confirmed');
  assert.deepEqual(projection.confirmationCounts, {
    processed: 0,
    confirmed: 1,
    finalized: 0,
  });
});

void test('refuse un lancement absent sans écrire de projection', async () => {
  const repository = new FakeRepository(null);

  await assert.rejects(
    () => new LaunchParticipantAnalyticsService(repository).rebuild('mint'),
    ParticipantAnalyticsLaunchNotFoundError,
  );
  assert.equal(repository.replacements.length, 0);
});

void test('ne remplace rien lorsqu’un analyseur échoue', async () => {
  const repository = new FakeRepository(makeInput([], 'confirmed'));
  const cause = new Error('analysis failed');
  const profiler = {
    profile(): never {
      throw cause;
    },
  };
  const service = new LaunchParticipantAnalyticsService(
    repository,
    profiler,
    new ObservedHolderAnalyzer(),
  );

  await assert.rejects(() => service.rebuild('mint'), cause);
  assert.equal(repository.replacements.length, 0);
});

class FakeRepository implements ParticipantAnalyticsRepository {
  public readonly replacements: {
    readonly projection: ParticipantAnalyticsProjection;
    readonly events: readonly ParticipantAnalyticsDerivedEventV1[];
  }[] = [];

  public constructor(private readonly input: ParticipantAnalyticsInput | null) {}

  public async transact<TResult>(
    _mint: string,
    operation: (transaction: ParticipantAnalyticsTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return operation({
      loadCanonicalInput: async () => this.input,
      replaceProjection: async (projection, events) => {
        this.replacements.push({ projection, events });
      },
    });
  }
}

function makeInput(
  trades: readonly ParticipantAnalyticsTrade[],
  confirmationStatus: 'processed' | 'confirmed' | 'finalized',
): ParticipantAnalyticsInput {
  return Object.freeze({
    launch: Object.freeze({
      eventId: 'launch-event',
      mint: 'mint',
      creator: 'creator',
      source: 'pumpfun',
      program: 'pump-program',
      signature: 'create-signature',
      cursor: Object.freeze({
        slot: 10n,
        transactionIndex: 0,
        instructionIndex: 1,
        innerInstructionIndex: null,
      }),
      confirmationStatus,
      observedAtMs: 1_720_000_000_000,
    }),
    trades: Object.freeze([...trades]),
    inputFingerprint: 'fingerprint',
  });
}

function trade(
  tradeId: string,
  instructionIndex: number,
  confirmationStatus: 'processed' | 'confirmed' | 'finalized',
): ParticipantAnalyticsTrade {
  return Object.freeze({
    eventId: `${tradeId}-event`,
    tradeId,
    launchMint: 'mint',
    signature: `${tradeId}-signature`,
    cursor: Object.freeze({
      slot: 10n,
      transactionIndex: 0,
      instructionIndex,
      innerInstructionIndex: null,
    }),
    confirmationStatus,
    observedAtMs: 1_720_000_000_000 + instructionIndex,
    kind: 'BUY',
    trader: 'buyer',
    baseAmountRaw: 10n,
    quoteAmountRaw: 2n,
    quoteAsset: Object.freeze({
      mint: 'sol',
      decimals: 9,
      tokenProgram: 'SPL_TOKEN',
    }),
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QualificationProjectionLaunchNotFoundError,
  QualificationProjectionService,
} from '../src/application/qualification-projection.service.js';
import { QualificationRebuildService } from '../src/application/qualification-rebuild.service.js';
import type { DomainEvent } from '../src/domain/events.js';
import type { QuoteAsset } from '../src/domain/types.js';
import type {
  CanonicalQualificationProjection,
  QualificationCanonicalSnapshot,
  QualificationProjectionRepository,
  QualificationProjectionTransaction,
} from '../src/ports/qualification-projection-repository.js';
import {
  createDefaultQualificationRuleSet,
  QualificationEngine,
} from '../src/qualification/qualification-engine.js';

void test('rebuilds and persists the canonical qualification projection', async () => {
  const source = snapshot();
  const repository = new FakeRepository(source, ['UPDATED']);
  const result = await service(repository, ['SOL']).rebuild('MINT');

  assert.equal(result.kind, 'UPDATED');
  assert.ok(result.projection);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.projection), true);
  assert.equal(result.projection.sourceEventId, source.asOfEvent.id);
  assert.equal(result.projection.sourceRawEventId, source.asOfRawEventId);
  assert.equal(result.projection.qualificationEvent.mint, 'MINT');
  assert.equal(condition(result.projection, 'UNSUPPORTED_QUOTE_MINT').status, 'PASSED');
  assert.deepEqual(repository.transactedMints, ['MINT']);
  assert.equal(repository.replacements.length, 1);
});

void test('keeps the canonical projection exactly replayable when the repository is unchanged', async () => {
  const repository = new FakeRepository(snapshot(), ['UPDATED', 'UNCHANGED']);
  const projectionService = service(repository, ['SOL']);

  const first = await projectionService.rebuild('MINT');
  const second = await projectionService.rebuild('MINT');

  assert.equal(first.kind, 'UPDATED');
  assert.equal(second.kind, 'UNCHANGED');
  assert.deepEqual(second.projection, first.projection);
  assert.deepEqual(repository.replacements[1], repository.replacements[0]);
});

void test('rejects a missing active launch with a typed error without changing current state', async () => {
  const repository = new FakeRepository(null, []);

  await assert.rejects(
    () => service(repository, ['SOL']).rebuild('MINT'),
    (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionLaunchNotFoundError);
      assert.equal(error.mint, 'MINT');
      assert.equal(error.message, 'Qualification projection launch not found for mint MINT.');
      return true;
    },
  );
  assert.deepEqual(repository.dissolutions, []);
  assert.deepEqual(repository.replacements, []);
});

void test('raises the typed missing-launch error after a wrapping transaction completes', async () => {
  const delegate = new FakeRepository(null, []);
  const repository = new CallbackErrorWrappingRepository(delegate);

  await assert.rejects(
    () => service(repository, ['SOL']).rebuild('MINT'),
    QualificationProjectionLaunchNotFoundError,
  );
  assert.equal(repository.callbackErrorsWrapped, 0);
  assert.deepEqual(delegate.dissolutions, []);
  assert.deepEqual(delegate.replacements, []);
});

void test('dissolves only the current projection when an orphan replay has no canonical launch', async () => {
  const repository = new FakeRepository(null, []);

  const result = await service(repository, ['SOL']).rebuild('MINT', 'DISSOLVE_CURRENT');

  assert.deepEqual(result, { kind:'DISSOLVED', projection:null });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(repository.dissolutions, ['MINT']);
  assert.deepEqual(repository.replacements, []);
});

void test('rejects non-canonical mints before opening a transaction', async () => {
  for (const mint of ['', ' ', ' MINT', 'MINT ', 'MINT/OTHER', 'MINT\n']) {
    const repository = new FakeRepository(snapshot(), ['UPDATED']);
    await assert.rejects(
      () => service(repository, ['SOL']).rebuild(mint),
      (error: unknown) => error instanceof TypeError
        && error.message === 'Qualification projection mint is invalid.',
    );
    assert.deepEqual(repository.transactedMints, []);
  }
});

void test('rejects an invalid missing-launch policy before opening a transaction', async () => {
  const repository = new FakeRepository(snapshot(), ['UPDATED']);

  await assert.rejects(
    () => service(repository, ['SOL']).rebuild('MINT', 'UNKNOWN' as never),
    (error: unknown) => error instanceof TypeError
      && error.message === 'Qualification projection missing launch policy is invalid.',
  );
  assert.deepEqual(repository.transactedMints, []);
});

void test('propagates repository failures unchanged', async () => {
  const failure = new Error('repository failed');
  const repository = new FakeRepository(snapshot(), ['UPDATED'], failure);

  await assert.rejects(() => service(repository, ['SOL']).rebuild('MINT'), failure);
  assert.deepEqual(repository.replacements, []);
});

void test('marks unsupported quote mint only when no launch quote asset is allowed', async () => {
  const supported = new FakeRepository(snapshot({
    launch: launch([quoteAsset('UNSUPPORTED'), quoteAsset('USDC')]),
  }), ['UPDATED']);
  const supportedResult = await service(supported, ['USDC']).rebuild('MINT');
  assert.ok(supportedResult.projection);
  assert.equal(condition(supportedResult.projection, 'UNSUPPORTED_QUOTE_MINT').status, 'PASSED');

  const unsupported = new FakeRepository(snapshot({
    launch: launch([quoteAsset('UNSUPPORTED'), quoteAsset('OTHER')]),
  }), ['UPDATED']);
  const unsupportedResult = await service(unsupported, ['USDC']).rebuild('MINT');
  assert.ok(unsupportedResult.projection);
  assert.equal(condition(unsupportedResult.projection, 'UNSUPPORTED_QUOTE_MINT').status, 'TRIGGERED');
});

void test('snapshots a valid quote allowlist and rejects unsafe allowlist inputs', async () => {
  const allowlist = ['SOL'];
  const repository = new FakeRepository(snapshot(), ['UPDATED']);
  const projectionService = service(repository, allowlist);
  allowlist[0] = 'OTHER';

  const result = await projectionService.rebuild('MINT');
  assert.ok(result.projection);
  assert.equal(condition(result.projection, 'UNSUPPORTED_QUOTE_MINT').status, 'PASSED');

  for (const invalid of [[], ['SOL', 'SOL'], [' SOL']] as const) {
    assert.throws(
      () => service(new FakeRepository(snapshot(), ['UPDATED']), invalid),
      (error: unknown) => error instanceof TypeError
        && error.message === 'Qualification projection quote mint allowlist is invalid.',
    );
  }

  let trapCalls = 0;
  const hostileAllowlist = new Proxy(['SOL'], {
    get: () => {
      trapCalls += 1;
      throw new Error('proxy trap');
    },
  });
  assert.throws(
    () => service(new FakeRepository(snapshot(), ['UPDATED']), hostileAllowlist),
    (error: unknown) => error instanceof TypeError
      && error.message === 'Qualification projection quote mint allowlist is invalid.',
  );
  assert.equal(trapCalls, 0);
});

class FakeRepository implements QualificationProjectionRepository {
  public readonly dissolutions: string[] = [];
  public readonly replacements: CanonicalQualificationProjection[] = [];
  public readonly transactedMints: string[] = [];
  private replacementIndex = 0;

  public constructor(
    private readonly input: QualificationCanonicalSnapshot | null,
    private readonly replacementResults: readonly ('UPDATED' | 'UNCHANGED')[],
    private readonly transactionFailure?: Error,
  ) {}

  public async transact<TResult>(
    mint: string,
    operation: (transaction: QualificationProjectionTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    this.transactedMints.push(mint);
    if (this.transactionFailure !== undefined) throw this.transactionFailure;
    return operation({
      loadCanonicalInput: async () => this.input,
      dissolveCurrent: async (currentMint) => {
        this.dissolutions.push(currentMint);
      },
      replaceProjection: async (projection) => {
        this.replacements.push(projection);
        const result = this.replacementResults[this.replacementIndex];
        this.replacementIndex += 1;
        if (result === undefined) throw new Error('Unexpected projection replacement.');
        return result;
      },
    });
  }
}

class CallbackErrorWrappingRepository implements QualificationProjectionRepository {
  public callbackErrorsWrapped = 0;

  public constructor(private readonly delegate: QualificationProjectionRepository) {}

  public async transact<TResult>(
    mint: string,
    operation: (transaction: QualificationProjectionTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return this.delegate.transact(mint, async (transaction) => {
      try {
        return await operation(transaction);
      } catch (cause: unknown) {
        this.callbackErrorsWrapped += 1;
        throw new Error('Transaction callback failed.', { cause });
      }
    });
  }
}

function service(
  repository: QualificationProjectionRepository,
  quoteMintAllowlist: readonly string[],
): QualificationProjectionService {
  return new QualificationProjectionService(
    repository,
    new QualificationRebuildService(
      new QualificationEngine(createDefaultQualificationRuleSet(60)),
    ),
    quoteMintAllowlist,
  );
}

function snapshot(
  overrides: Partial<QualificationCanonicalSnapshot> = {},
): QualificationCanonicalSnapshot {
  const asOfEvent: DomainEvent = Object.freeze({
    id: 'evt_source', type: 'TokenLaunchDetected', mint: 'MINT', source: 'pumpfun',
    program: 'pump', signature: 'signature',
    cursor: Object.freeze({
      slot: 10n, transactionIndex: 0, instructionIndex: 1, innerInstructionIndex: null,
    }),
    confirmationStatus: 'confirmed', blockchainTimeMs: 800, observedAtMs: 1_000,
    payloadVersion: 1, payload: Object.freeze({}),
  });
  return Object.freeze({
    mint: 'MINT', asOfEvent, asOfRawEventId: 'raw_source', launch: launch([quoteAsset('SOL')]),
    metadata: null, social: null, creatorProfile: null, holderSnapshot: null, walletGraph: null,
    ...overrides,
  });
}

function launch(quoteAssets: readonly QuoteAsset[]): QualificationCanonicalSnapshot['launch'] {
  return Object.freeze({
    mint: 'MINT', creator: 'creator', tokenProgram: 'SPL_TOKEN' as const,
    quoteAssets: Object.freeze([...quoteAssets]), launchpad: 'pumpfun',
    createdAt: Object.freeze({
      slot: 10n, transactionIndex: 0, instructionIndex: 1, innerInstructionIndex: null,
    }),
    parameters: Object.freeze({}),
  });
}

function quoteAsset(mint: string): QuoteAsset {
  return Object.freeze({ mint, decimals: 9, tokenProgram: 'SPL_TOKEN' });
}

function condition(projection: CanonicalQualificationProjection, code: string) {
  const item = projection.report.conditions.find((candidate) => candidate.code === code);
  assert.ok(item);
  return item;
}

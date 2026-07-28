import {
  createDeterministicChainEventId,
  type TypedDomainEvent,
} from './events.js';
import {
  assertValidNullableTimestampMs,
  assertValidTimestampMs,
} from './timestamp.js';
import type {
  CanonicalMarketPool,
  MigrationObservation,
} from './market.js';
import type {
  ChainCursor,
  ObservedChainTransaction,
  QuoteAsset,
} from './types.js';

export type MigrationObservedEventV1 = TypedDomainEvent<
  'MigrationObserved',
  Readonly<{ readonly migration: MigrationObservation }>,
  1
>;

export type PumpSwapPoolActivatedEventV1 = TypedDomainEvent<
  'PumpSwapPoolActivated',
  Readonly<{
    readonly migrationEventId: string;
    readonly pool: CanonicalMarketPool;
  }>,
  1
>;

interface EventContext {
  readonly source: string;
  readonly program: string;
  readonly transaction: ObservedChainTransaction;
}

export function createMigrationObservedEvent(
  input: EventContext & { readonly migration: MigrationObservation },
): MigrationObservedEventV1 {
  const migration = snapshotMigration(input.migration);
  return event(input, 'MigrationObserved', migration.mint, migration.cursor, {
    migration,
  });
}

export function createPumpSwapPoolActivatedEvent(
  input: EventContext & {
    readonly migrationEventId: string;
    readonly pool: CanonicalMarketPool;
  },
): PumpSwapPoolActivatedEventV1 {
  const pool = snapshotPool(input.pool);
  return event(input, 'PumpSwapPoolActivated', pool.baseMint, pool.activatedAt, {
    migrationEventId: input.migrationEventId,
    pool,
  });
}

function event<TType extends 'MigrationObserved' | 'PumpSwapPoolActivated',
  TPayload extends object>(
  input: EventContext,
  type: TType,
  mint: string,
  cursor: ChainCursor,
  payload: TPayload,
): TypedDomainEvent<TType, TPayload, 1> {
  assertValidTimestampMs('observedAtMs', input.transaction.observedAtMs);
  assertValidNullableTimestampMs(
    'blockchainTimeMs',
    input.transaction.blockTimeMs,
  );
  return Object.freeze({
    id: createDeterministicChainEventId({
      type,
      mint,
      source: input.source,
      program: input.program,
      signature: input.transaction.signature,
      cursor,
    }),
    type,
    mint,
    source: input.source,
    program: input.program,
    signature: input.transaction.signature,
    cursor,
    confirmationStatus: input.transaction.confirmationStatus,
    blockchainTimeMs: input.transaction.blockTimeMs,
    observedAtMs: input.transaction.observedAtMs,
    payloadVersion: 1,
    payload: Object.freeze(payload),
  });
}

function snapshotMigration(value: MigrationObservation): MigrationObservation {
  return Object.freeze({
    instruction: value.instruction,
    mint: value.mint,
    bondingCurve: value.bondingCurve,
    announcedPool: value.announcedPool,
    baseTokenProgram: value.baseTokenProgram,
    quoteAsset: snapshotQuote(value.quoteAsset),
    cursor: snapshotCursor(value.cursor),
  });
}

function snapshotPool(value: CanonicalMarketPool): CanonicalMarketPool {
  return Object.freeze({
    address: value.address,
    market: value.market,
    programId: value.programId,
    baseMint: value.baseMint,
    quoteAsset: snapshotQuote(value.quoteAsset),
    index: value.index,
    creator: value.creator,
    baseVault: value.baseVault,
    quoteVault: value.quoteVault,
    lpMint: value.lpMint,
    baseTokenProgram: value.baseTokenProgram,
    activatedAt: snapshotCursor(value.activatedAt),
    confirmationStatus: value.confirmationStatus,
  });
}

function snapshotQuote(value: QuoteAsset): QuoteAsset {
  return Object.freeze({
    mint: value.mint,
    decimals: value.decimals,
    tokenProgram: value.tokenProgram,
  });
}

function snapshotCursor(value: ChainCursor): ChainCursor {
  return Object.freeze({
    slot: value.slot,
    transactionIndex: value.transactionIndex,
    instructionIndex: value.instructionIndex,
    innerInstructionIndex: value.innerInstructionIndex,
  });
}

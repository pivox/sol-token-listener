import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMigrationObservedEvent,
  createPumpSwapPoolActivatedEvent,
} from '../src/domain/migration-events.js';
import type {
  CanonicalMarketPool,
  MigrationObservation,
} from '../src/domain/market.js';
import type { ObservedChainTransaction } from '../src/domain/types.js';

const transaction: ObservedChainTransaction = Object.freeze({
  signature: 'signature',
  confirmationStatus: 'confirmed',
  blockTimeMs: 1_000,
  observedAtMs: 2_000,
  cursor: Object.freeze({ slot: 10n, transactionIndex: 3 }),
  raw: null,
});
const migration: MigrationObservation = Object.freeze({
  instruction: 'MIGRATE_V2',
  mint: 'base',
  bondingCurve: 'curve',
  announcedPool: 'pool',
  baseTokenProgram: 'TOKEN_2022',
  quoteAsset: Object.freeze({
    mint: 'quote',
    decimals: 6,
    tokenProgram: 'SPL_TOKEN',
  }),
  cursor: Object.freeze({
    slot: 10n,
    transactionIndex: 3,
    instructionIndex: 2,
    innerInstructionIndex: 4,
  }),
});

void test('crée des preuves de migration immuables et déterministes', () => {
  const event = createMigrationObservedEvent({
    source: 'pumpfun',
    program: 'pump',
    transaction,
    migration,
  });
  const replay = createMigrationObservedEvent({
    source: 'pumpfun',
    program: 'pump',
    transaction,
    migration,
  });

  assert.equal(event.id, replay.id);
  assert.equal(event.type, 'MigrationObserved');
  assert.equal(event.payload.migration.quoteAsset.mint, 'quote');
  assert(Object.isFrozen(event));
  assert(Object.isFrozen(event.payload));
  assert(Object.isFrozen(event.payload.migration));
  assert(Object.isFrozen(event.payload.migration.quoteAsset));
});

void test('l’activation utilise son propre curseur PumpSwap', () => {
  const migrationEvent = createMigrationObservedEvent({
    source: 'pumpfun',
    program: 'pump',
    transaction,
    migration,
  });
  const pool: CanonicalMarketPool = Object.freeze({
    address: 'pool',
    market: 'pumpswap',
    programId: 'pumpswap-program',
    baseMint: 'base',
    quoteAsset: migration.quoteAsset,
    index: 0,
    creator: 'creator',
    baseVault: 'base-vault',
    quoteVault: 'quote-vault',
    lpMint: 'lp',
    baseTokenProgram: 'TOKEN_2022',
    activatedAt: Object.freeze({
      slot: 10n,
      transactionIndex: 3,
      instructionIndex: 2,
      innerInstructionIndex: 5,
    }),
    confirmationStatus: 'confirmed',
  });

  const event = createPumpSwapPoolActivatedEvent({
    source: 'pumpswap',
    program: pool.programId,
    transaction,
    migrationEventId: migrationEvent.id,
    pool,
  });

  assert.equal(event.type, 'PumpSwapPoolActivated');
  assert.equal(event.cursor.innerInstructionIndex, 5);
  assert.notEqual(event.id, migrationEvent.id);
  assert.equal(event.payload.migrationEventId, migrationEvent.id);
  assert(Object.isFrozen(event.payload.pool));
});

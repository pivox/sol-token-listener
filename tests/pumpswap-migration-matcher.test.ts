import assert from 'node:assert/strict';
import test from 'node:test';
import { matchPumpSwapMigrations } from '../src/application/pumpswap-migration-matcher.js';
import type { CanonicalMarketPool, MigrationObservation } from '../src/domain/market.js';
import type { DecodedPumpSwapTransaction } from '../src/markets/pumpswap/types.js';
import { createSolanaObservedTransaction } from '../src/solana/rpc/observed-transaction.js';
import type { NormalizedInstruction, NormalizedTransaction } from '../src/solana/rpc/types.js';

const migrationIx = instruction(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  2,
  null,
  1,
);
const createIx = instruction('pumpswap', 2, 0, 2);
const eventIx = instruction('pumpswap', 2, 1, 3);
const migration: MigrationObservation = {
  instruction: 'MIGRATE_V2',
  mint: 'base',
  bondingCurve: 'curve',
  announcedPool: 'pool',
  baseTokenProgram: 'TOKEN_2022',
  quoteAsset: { mint: 'quote', decimals: 6, tokenProgram: 'SPL_TOKEN' },
  cursor: { slot: 1n, transactionIndex: 0, instructionIndex: 2, innerInstructionIndex: null },
};
const pool: CanonicalMarketPool = {
  address: 'pool', market: 'pumpswap', programId: 'pumpswap', baseMint: 'base',
  quoteAsset: migration.quoteAsset, index: 0, creator: 'creator',
  baseVault: 'base-vault', quoteVault: 'quote-vault', lpMint: 'lp',
  baseTokenProgram: 'TOKEN_2022',
  activatedAt: { slot: 1n, transactionIndex: 0, instructionIndex: 2, innerInstructionIndex: 0 },
  confirmationStatus: 'confirmed',
};

void test('rapproche une migration et son create_pool dans la même portée CPI', () => {
  const observed = createSolanaObservedTransaction(transaction(), 2_000);
  const [match] = matchPumpSwapMigrations(
    observed,
    [migration],
    evidence(),
    new Map([['pool', pool]]),
  );
  assert.equal(match?.migrationEvent.type, 'MigrationObserved');
  assert.equal(match?.activationEvent?.type, 'PumpSwapPoolActivated');
  assert.equal(match?.activationEvent?.payload.migrationEventId, match?.migrationEvent.id);
});

void test('conserve MIGRATION_PENDING si le pool canonique n’est pas prouvé', () => {
  const [match] = matchPumpSwapMigrations(
    createSolanaObservedTransaction(transaction(), 2_000),
    [migration],
    { poolCreations: [], trades: [] },
    new Map(),
  );
  assert.equal(match?.activationEvent, null);
});

function evidence(): DecodedPumpSwapTransaction {
  return {
    poolCreations: [{
      action: {
        name: 'create_pool', family: 'CREATE_POOL', instruction: createIx,
        accounts: {}, args: {},
      },
      event: {
        kind: 'CREATE_POOL', instruction: eventIx, fields: {}, trailingDataHex: '',
      },
      pool: 'pool', index: 0n, creator: 'creator', baseMint: 'base', quoteMint: 'quote',
    }],
    trades: [],
  };
}

function transaction(): NormalizedTransaction {
  return {
    signature: 'signature', slot: 1n, transactionIndex: 0,
    confirmationStatus: 'CONFIRMED', version: 0, blockTimeMs: 1_000,
    accountKeys: [], signerKeys: [], instructions: [migrationIx, createIx, eventIx],
    preTokenBalances: [], postTokenBalances: [], preBalancesLamports: [],
    postBalancesLamports: [], feeLamports: 0n, computeUnits: null, logs: [],
    error: null,
  };
}

function instruction(
  programId: string,
  instructionIndex: number,
  innerInstructionIndex: number | null,
  stackHeight: number,
): NormalizedInstruction {
  return {
    programId, accounts: [], data: new Uint8Array(), instructionIndex,
    innerInstructionIndex,
    parentInstructionIndex: innerInstructionIndex === null ? null : instructionIndex,
    stackHeight,
  };
}

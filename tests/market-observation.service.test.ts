import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InvalidMarketObservationError,
  MarketObservationService,
} from '../src/application/market-observation.service.js';
import type { MatchedMigration } from '../src/application/pumpswap-migration-matcher.js';
import type {
  MarketObservationBatch,
  MarketObservationRepository,
  MarketObservationResult,
} from '../src/ports/market-observation-repository.js';
import type { SolanaObservedTransaction } from '../src/solana/rpc/observed-transaction.js';

const transaction: SolanaObservedTransaction = {
  signature: 'signature',
  confirmationStatus: 'confirmed',
  blockTimeMs: 1_000,
  observedAtMs: 2_000,
  cursor: { slot: 10n, transactionIndex: 3 },
  raw: {
    signature: 'signature',
    slot: 10n,
    transactionIndex: 3,
    confirmationStatus: 'CONFIRMED',
    version: 0,
    blockTimeMs: 1_000,
    accountKeys: [],
    signerKeys: [],
    instructions: [],
    preTokenBalances: [],
    postTokenBalances: [],
    preBalancesLamports: [],
    postBalancesLamports: [],
    feeLamports: 0n,
    computeUnits: null,
    logs: [],
    error: null,
  },
};

function match(innerInstructionIndex: number | null): MatchedMigration {
  const cursor = {
    ...transaction.cursor,
    instructionIndex: 2,
    innerInstructionIndex,
  };
  return {
    migrationEvent: {
      id: `migration-${String(innerInstructionIndex)}`,
      type: 'MigrationObserved',
      mint: 'mint',
      source: 'pumpfun',
      program: 'pump',
      signature: transaction.signature,
      cursor,
      confirmationStatus: 'confirmed',
      blockchainTimeMs: 1_000,
      observedAtMs: 2_000,
      payloadVersion: 1,
      payload: {
        migration: {
          instruction: 'MIGRATE',
          mint: 'mint',
          bondingCurve: 'curve',
          announcedPool: 'pool',
          baseTokenProgram: 'SPL_TOKEN',
          quoteAsset: {
            mint: 'So11111111111111111111111111111111111111112',
            decimals: 9,
            tokenProgram: 'SPL_TOKEN',
          },
          cursor,
        },
      },
    },
    activationEvent: null,
  };
}

void test('market observation service validates, sorts and derives raw events', async () => {
  let received: MarketObservationBatch | undefined;
  const repository: MarketObservationRepository = {
    record(batch) {
      received = batch;
      return Promise.resolve({ migrations: [], activations: [] });
    },
    loadActivePools: () => Promise.resolve([]),
  };
  const service = new MarketObservationService(repository);
  await service.record(transaction, {
    matches: [match(4), match(1)],
    reserveSnapshots: [],
    trades: [],
  });

  assert.deepEqual(
    received?.matches.map((value) => value.migrationEvent.cursor.innerInstructionIndex),
    [1, 4],
  );
  assert.equal(received?.rawEvents.length, 2);
  assert.match(received?.rawEvents[0]?.id ?? '', /^raw_[a-f0-9]{64}$/u);
});

void test('market observation service rejects duplicate identities and foreign cursors', async () => {
  const result: MarketObservationResult = { migrations: [], activations: [] };
  const repository: MarketObservationRepository = {
    record: () => Promise.resolve(result),
    loadActivePools: () => Promise.resolve([]),
  };
  const service = new MarketObservationService(repository);
  const duplicate = match(1);
  assert.throws(
    () => service.record(transaction, {
      matches: [duplicate, duplicate],
      reserveSnapshots: [],
      trades: [],
    }),
    InvalidMarketObservationError,
  );
  assert.throws(
    () => service.record(transaction, {
      matches: [{
        ...duplicate,
        migrationEvent: {
          ...duplicate.migrationEvent,
          cursor: { ...duplicate.migrationEvent.cursor, slot: 11n },
        },
      }],
      reserveSnapshots: [],
      trades: [],
    }),
    InvalidMarketObservationError,
  );
});

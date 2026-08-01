import assert from 'node:assert/strict';
import test from 'node:test';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { MarketObservationService } from '../src/application/market-observation.service.js';
import { PumpSwapObservationPipeline } from '../src/application/pumpswap-observation-pipeline.js';
import type { CanonicalMarketPool } from '../src/domain/market.js';
import type {
  MarketObservationBatch,
  MarketObservationRepository,
} from '../src/ports/market-observation-repository.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PumpFunLaunchpadAdapter } from '../src/launchpads/pumpfun/pumpfun-launchpad.adapter.js';
import type { DecodedPumpTransaction } from '../src/launchpads/pumpfun/types.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { PumpSwapMarketAdapter } from '../src/markets/pumpswap/pumpswap-market.adapter.js';
import type { DecodedPumpSwapTransaction } from '../src/markets/pumpswap/types.js';
import { createSolanaObservedTransaction } from '../src/solana/rpc/observed-transaction.js';
import type { NormalizedInstruction, NormalizedTransaction } from '../src/solana/rpc/types.js';

void test('PumpSwap observation pipeline persists migration and canonical activation', async () => {
  const repository = new MemoryRepository();
  const pool = canonicalPool();
  const pump = new PumpFunLaunchpadAdapter(
    { read: () => Promise.reject(new Error('unused')) },
    (transaction) => pumpEvidence(transaction),
  );
  const market = new PumpSwapMarketAdapter(
    () => marketEvidence(),
    { validate: () => Promise.resolve(pool) },
    {
      read: () => Promise.resolve({
        pool: pool.address,
        baseReservesRaw: 10_000n,
        quoteVaultAmountRaw: 20_000n,
        virtualQuoteReservesRaw: 5_000n,
        effectiveQuoteReservesRaw: 25_000n,
        observedSlot: 12n,
        observedAtMs: 2_100,
      }),
    },
    { quote: () => Promise.reject(new Error('unused')) },
    () => undefined,
  );
  const pipeline = new PumpSwapObservationPipeline(
    pump,
    market,
    new MarketObservationService(repository),
    () => 2_000,
  );
  const result = await pipeline.observe(transaction());
  assert.equal(result.migrations.length, 1);
  assert.equal(result.activations.length, 1);
  assert.equal(result.activations[0]?.payload.pool.index, 0);
  assert.equal(repository.recordedBatches.length, 1);
  assert.equal(
    repository.recordedBatches[0]?.reserveSnapshots[0]?.reserves.observedSlot,
    12n,
  );
});

void test('processes a provided observed envelope without creating a second clock observation', async () => {
  const repository = new MemoryRepository();
  const pool = canonicalPool();
  let clockCalls = 0;
  const pipeline = new PumpSwapObservationPipeline(
    new PumpFunLaunchpadAdapter(
      { read: () => Promise.reject(new Error('unused')) },
      (value) => pumpEvidence(value),
    ),
    new PumpSwapMarketAdapter(
      () => marketEvidence(),
      { validate: () => Promise.resolve(pool) },
      {
        read: () => Promise.resolve({
          pool: pool.address,
          baseReservesRaw: 10_000n,
          quoteVaultAmountRaw: 20_000n,
          virtualQuoteReservesRaw: 5_000n,
          effectiveQuoteReservesRaw: 25_000n,
          observedSlot: 12n,
          observedAtMs: 2_100,
        }),
      },
      { quote: () => Promise.reject(new Error('unused')) },
      () => undefined,
    ),
    new MarketObservationService(repository),
    () => {
      clockCalls += 1;
      return 2_000;
    },
  );
  const observed = createSolanaObservedTransaction(transaction(), 2_000);

  const result = await pipeline.processObserved(observed);

  assert.equal(clockCalls, 0);
  assert.equal(result.migrations.length, 1);
  assert.equal(result.activations.length, 1);
  const standaloneResult = await pipeline.observe(observed.raw);
  assert.equal(clockCalls, 1);
  assert.deepEqual(standaloneResult, result);
});

void test('PumpSwap observation pipeline ignores unrelated transactions without writes', async () => {
  const repository = new MemoryRepository();
  const unused = () => {
    throw new Error('dependency should not be called');
  };
  const pipeline = new PumpSwapObservationPipeline(
    new PumpFunLaunchpadAdapter(
      { read: () => Promise.reject(new Error('unused')) },
      unused,
    ),
    new PumpSwapMarketAdapter(
      unused,
      { validate: () => Promise.reject(new Error('unused')) },
      { read: () => Promise.reject(new Error('unused')) },
      { quote: () => Promise.reject(new Error('unused')) },
      () => undefined,
    ),
    new MarketObservationService(repository),
    () => 2_000,
  );
  const unrelated = {
    ...transaction(),
    instructions: [instruction('11111111111111111111111111111111', 0, null, 1)],
  };
  const result = await pipeline.observe(unrelated);
  assert.deepEqual(result, { migrations: [], activations: [] });
  assert.equal(repository.recordedBatches.length, 0);
});

void test('first orphaned activation records no reserve snapshot', async () => {
  const repository = new MemoryRepository();
  let reserveReads = 0;
  const orphanedPool = {
    ...canonicalPool(),
    confirmationStatus: 'orphaned' as const,
  };
  const pipeline = new PumpSwapObservationPipeline(
    new PumpFunLaunchpadAdapter(
      { read: () => Promise.reject(new Error('unused')) },
      (value) => pumpEvidence(value),
    ),
    new PumpSwapMarketAdapter(
      () => marketEvidence(),
      { validate: () => Promise.resolve(orphanedPool) },
      {
        read: () => {
          reserveReads += 1;
          return Promise.reject(new Error('must not read orphan reserves'));
        },
      },
      { quote: () => Promise.reject(new Error('unused')) },
      () => undefined,
    ),
    new MarketObservationService(repository),
    () => 2_000,
  );
  await pipeline.observe(transaction('ORPHANED'));
  assert.equal(reserveReads, 0);
  assert.equal(repository.recordedBatches[0]?.reserveSnapshots.length, 0);
});

void test('pipeline accepts processed to confirmed pool enrichment', async () => {
  const repository = new MemoryRepository();
  const validator = {
    validate: (
      _creation: unknown,
      observed: { readonly confirmationStatus: CanonicalMarketPool['confirmationStatus'] },
    ) => Promise.resolve({
      ...canonicalPool(),
      confirmationStatus: observed.confirmationStatus,
    }),
  };
  const pipeline = new PumpSwapObservationPipeline(
    new PumpFunLaunchpadAdapter(
      { read: () => Promise.reject(new Error('unused')) },
      (value) => pumpEvidence(value),
    ),
    new PumpSwapMarketAdapter(
      () => marketEvidence(),
      validator,
      {
        read: () => Promise.resolve({
          pool: 'pool',
          baseReservesRaw: 10n,
          quoteVaultAmountRaw: 20n,
          virtualQuoteReservesRaw: 5n,
          effectiveQuoteReservesRaw: 25n,
          observedSlot: 12n,
          observedAtMs: 2_100,
        }),
      },
      { quote: () => Promise.reject(new Error('unused')) },
      () => undefined,
    ),
    new MarketObservationService(repository),
    () => 2_000,
  );
  await pipeline.observe(transaction('PROCESSED'));
  await assert.doesNotReject(pipeline.observe(transaction('CONFIRMED')));
});

class MemoryRepository implements MarketObservationRepository {
  public readonly recordedBatches: MarketObservationBatch[] = [];
  private readonly activePools = new Map<string, CanonicalMarketPool>();
  public record(batch: MarketObservationBatch) {
    this.recordedBatches.push(batch);
    for (const match of batch.matches) {
      if (match.activationEvent !== null) {
        this.activePools.set(
          match.activationEvent.payload.pool.address,
          match.activationEvent.payload.pool,
        );
      }
    }
    return Promise.resolve({
      migrations: batch.matches.map((match) => match.migrationEvent),
      activations: batch.matches.flatMap((match) =>
        match.activationEvent === null ? [] : [match.activationEvent]),
    });
  }
  public loadActivePools(): Promise<readonly CanonicalMarketPool[]> {
    return Promise.resolve([...this.activePools.values()]);
  }
}

function pumpEvidence(
  transactionValue: NormalizedTransaction,
): DecodedPumpTransaction {
  return {
    transaction: transactionValue,
    creations: [],
    trades: [],
    migrations: [{
      action: {
        name: 'migrate_v2',
        family: 'MIGRATE',
        instruction: transactionValue.instructions[0] ?? missing(),
        accounts: {},
        args: {},
      },
      instruction: 'MIGRATE_V2',
      mint: 'base',
      bondingCurve: 'curve',
      announcedPool: 'pool',
      baseTokenProgram: 'SPL_TOKEN',
      quoteAsset: { mint: 'quote', decimals: 6, tokenProgram: 'SPL_TOKEN' },
    }],
  };
}

function marketEvidence(): DecodedPumpSwapTransaction {
  const create = instruction(PUMPSWAP_PROGRAM_ID, 0, 0, 2);
  return {
    poolCreations: [{
      action: {
        name: 'create_pool',
        family: 'CREATE_POOL',
        instruction: create,
        accounts: {
          pool_base_token_account: 'base-vault',
          pool_quote_token_account: 'quote-vault',
          lp_mint: 'lp',
          base_token_program: TOKEN_PROGRAM_ID.toBase58(),
          quote_token_program: TOKEN_PROGRAM_ID.toBase58(),
        },
        args: {},
      },
      event: {
        kind: 'CREATE_POOL',
        fields: {},
        instruction: instruction(PUMPSWAP_PROGRAM_ID, 0, 1, 3),
        trailingDataHex: '',
      },
      pool: 'pool',
      index: 0n,
      creator: 'creator',
      baseMint: 'base',
      quoteMint: 'quote',
    }],
    trades: [],
    issues: [],
  };
}

function canonicalPool(): CanonicalMarketPool {
  return {
    address: 'pool',
    market: 'pumpswap',
    programId: PUMPSWAP_PROGRAM_ID,
    baseMint: 'base',
    quoteAsset: { mint: 'quote', decimals: 6, tokenProgram: 'SPL_TOKEN' },
    index: 0,
    creator: 'creator',
    baseVault: 'base-vault',
    quoteVault: 'quote-vault',
    lpMint: 'lp',
    baseTokenProgram: 'SPL_TOKEN',
    activatedAt: {
      slot: 10n,
      transactionIndex: 0,
      instructionIndex: 0,
      innerInstructionIndex: 0,
    },
    confirmationStatus: 'confirmed',
  };
}

function transaction(
  confirmationStatus: NormalizedTransaction['confirmationStatus'] = 'CONFIRMED',
): NormalizedTransaction {
  return {
    signature: 'signature',
    slot: 10n,
    transactionIndex: 0,
    confirmationStatus,
    version: 0,
    blockTimeMs: 1_000,
    accountKeys: [],
    signerKeys: [],
    instructions: [
      instruction(PUMP_PROGRAM_ID, 0, null, 1),
      instruction(PUMPSWAP_PROGRAM_ID, 0, 0, 2),
    ],
    preTokenBalances: [],
    postTokenBalances: [],
    preBalancesLamports: [],
    postBalancesLamports: [],
    feeLamports: 0n,
    computeUnits: null,
    logs: [],
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
    programId,
    accounts: [],
    data: new Uint8Array(),
    instructionIndex,
    innerInstructionIndex,
    parentInstructionIndex:
      innerInstructionIndex === null ? null : instructionIndex,
    stackHeight,
  };
}

function missing(): never {
  throw new Error('Fixture instruction absente.');
}

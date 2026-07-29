import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CanonicalMarketPool,
  MarketQuote,
  MarketReserves,
} from '../src/domain/market.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { PumpSwapDecodingError } from '../src/markets/pumpswap/errors.js';
import { PumpSwapMarketAdapter } from '../src/markets/pumpswap/pumpswap-market.adapter.js';
import type {
  DecodedPumpSwapInstruction,
  DecodedPumpSwapTransaction,
} from '../src/markets/pumpswap/types.js';
import { createSolanaObservedTransaction } from '../src/solana/rpc/observed-transaction.js';
import type { NormalizedInstruction, NormalizedTransaction } from '../src/solana/rpc/types.js';

void test('PumpSwap market adapter shares decoding and projects tracked trades', async () => {
  let decodeCount = 0;
  const observed = createSolanaObservedTransaction(transaction(), 2_000);
  const pool = canonicalPool();
  const adapter = new PumpSwapMarketAdapter(
    () => {
      decodeCount += 1;
      return evidence();
    },
    { validate: () => Promise.resolve(pool) },
    { read: () => Promise.resolve(reserves()) },
    { quote: () => Promise.resolve(marketQuote()) },
    () => undefined,
  );
  const decoded = await adapter.decodeEvidence(observed);
  const pools = await adapter.detectPools(observed);
  const trades = await adapter.decodeTrades(
    observed,
    new Map([[pool.address, pool]]),
  );
  assert.equal(decoded.poolCreations.length, 1);
  assert.equal(pools.length, 1);
  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.kind, 'BUY');
  assert.equal(trades[0]?.quoteAsset.mint, pool.quoteAsset.mint);
  assert.equal(trades[0]?.cursor.innerInstructionIndex, null);
  assert.equal(decodeCount, 1);
  assert.equal(adapter.source, 'pumpswap');
  assert.equal(adapter.programId, PUMPSWAP_PROGRAM_ID);
});

void test('PumpSwap market adapter ignores untracked trades and delegates quote', async () => {
  let reserveReads = 0;
  let quotedReserves: MarketReserves | undefined;
  const adapter = new PumpSwapMarketAdapter(
    () => evidence(),
    { validate: () => Promise.resolve(null) },
    {
      read: () => {
        reserveReads += 1;
        return Promise.resolve(reserves());
      },
    },
    {
      quote(request) {
        quotedReserves = request.reserves;
        return Promise.resolve(marketQuote());
      },
    },
    () => undefined,
  );
  const observed = createSolanaObservedTransaction(transaction(), 2_000);
  assert.deepEqual(await adapter.decodeTrades(observed, new Map()), []);
  const result = await adapter.quote({
    pool: canonicalPool(),
    inputMint: canonicalPool().quoteAsset.mint,
    amountInRaw: 100n,
    slippageBps: 50n,
  });
  assert.equal(result.id, 'quote');
  assert.equal(reserveReads, 1);
  assert.equal(quotedReserves?.effectiveQuoteReservesRaw, 25_000n);
});

void test('PumpSwap market adapter reports each local decoding issue once', async () => {
  const reported: PumpSwapDecodingError[] = [];
  const issue = new PumpSwapDecodingError(
    'PUMPSWAP_EVENT_MISSING',
    'missing',
    'signature',
  );
  const adapter = new PumpSwapMarketAdapter(
    () => ({ ...evidence(), issues: [issue] }),
    { validate: () => Promise.resolve(null) },
    { read: () => Promise.resolve(reserves()) },
    { quote: () => Promise.resolve(marketQuote()) },
    (value) => reported.push(value),
  );
  const observed = createSolanaObservedTransaction(transaction(), 2_000);
  await adapter.decodeEvidence(observed);
  await adapter.decodeEvidence(observed);
  assert.deepEqual(reported, [issue]);
});

function evidence(): DecodedPumpSwapTransaction {
  const create = action('create_pool', 'CREATE_POOL', 0);
  const buy = action('buy', 'BUY', 1);
  return {
    poolCreations: [{
      action: create as DecodedPumpSwapInstruction & { family: 'CREATE_POOL' },
      event: {
        kind: 'CREATE_POOL',
        fields: {},
        instruction: instruction(0, 1, 2),
        trailingDataHex: '',
      },
      pool: 'pool',
      index: 0n,
      creator: 'creator',
      baseMint: 'base',
      quoteMint: 'quote',
    }],
    trades: [{
      action: buy as DecodedPumpSwapInstruction & { family: 'BUY' },
      event: {
        kind: 'BUY',
        fields: {},
        instruction: instruction(1, 2, 3),
        trailingDataHex: '',
      },
      kind: 'BUY',
      pool: 'pool',
      trader: 'trader',
      baseMint: 'base',
      quoteMint: 'quote',
      baseAmountRaw: 10n,
      quoteAmountRaw: 20n,
    }],
    issues: [],
  };
}

function action(
  name: 'buy' | 'create_pool',
  family: 'BUY' | 'CREATE_POOL',
  instructionIndex: number,
): DecodedPumpSwapInstruction {
  return {
    name,
    family,
    instruction: instruction(instructionIndex, null, 1),
    accounts: {},
    args: {},
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
      innerInstructionIndex: 1,
    },
    confirmationStatus: 'confirmed',
  };
}

function reserves(): MarketReserves {
  return {
    pool: 'pool',
    baseReservesRaw: 10_000n,
    quoteVaultAmountRaw: 20_000n,
    virtualQuoteReservesRaw: 5_000n,
    effectiveQuoteReservesRaw: 25_000n,
    observedSlot: 10n,
    observedAtMs: 2_000,
  };
}

function marketQuote(): MarketQuote {
  return {
    id: 'quote',
    pool: 'pool',
    inputMint: 'quote',
    outputMint: 'base',
    amountInRaw: 100n,
    amountOutRaw: 50n,
    minimumAmountOutRaw: 49n,
    feesRaw: 1n,
    slippageBps: 50n,
    priceImpactBps: 10n,
    observedAtMs: 2_000,
    observedSlot: 10n,
  };
}

function transaction(): NormalizedTransaction {
  return {
    signature: 'signature',
    slot: 10n,
    transactionIndex: 0,
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
  };
}

function instruction(
  instructionIndex: number,
  innerInstructionIndex: number | null,
  stackHeight: number,
): NormalizedInstruction {
  return {
    programId: PUMPSWAP_PROGRAM_ID,
    accounts: [],
    data: new Uint8Array(),
    instructionIndex,
    innerInstructionIndex,
    parentInstructionIndex:
      innerInstructionIndex === null ? null : instructionIndex,
    stackHeight,
  };
}

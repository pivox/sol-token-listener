import assert from 'node:assert/strict';
import test from 'node:test';
import BN from 'bn.js';
import { buyQuoteInput, sellBaseInput } from '@pump-fun/pump-swap-sdk';
import type { GlobalConfig } from '@pump-fun/pump-swap-sdk';
import type { RawMint } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import type {
  CanonicalMarketPool,
  MarketReserves,
} from '../src/domain/market.js';
import type { PumpSwapFeeState } from '../src/markets/pumpswap/pumpswap-fee-state.js';
import {
  createPumpSwapQuote,
  InvalidPumpSwapQuoteError,
  SellQuoteUnavailableError,
} from '../src/markets/pumpswap/pumpswap-quote.provider.js';

const BASE = key(1);
const QUOTE = key(2);
const CREATOR = key(3);
const COIN_CREATOR = key(4);

void test('PumpSwap quote BUY matches official SDK with integer slippage', () => {
  const amountInRaw = 1_000_000n;
  const quote = createPumpSwapQuote({
    pool: pool(),
    reserves: reserves(),
    inputMint: QUOTE.toBase58(),
    amountInRaw,
    slippageBps: 125n,
  }, state(), 2_000);
  const official = buyQuoteInput({
    quote: bn(amountInRaw),
    slippage: 0,
    baseReserve: bn(reserves().baseReservesRaw),
    quoteReserve: bn(reserves().quoteVaultAmountRaw),
    virtualQuoteReserves: bn(reserves().virtualQuoteReservesRaw),
    globalConfig: globalConfig(),
    baseMintAccount: mint(),
    baseMint: BASE,
    coinCreator: COIN_CREATOR,
    creator: CREATOR,
    feeConfig: null,
  });
  assert.equal(quote.amountOutRaw, BigInt(official.base.toString()));
  assert.equal(
    quote.minimumAmountOutRaw,
    quote.amountOutRaw * 9_875n / 10_000n,
  );
  assert.equal(typeof quote.amountOutRaw, 'bigint');
  assert.equal(typeof quote.feesRaw, 'bigint');
  assert.equal(typeof quote.priceImpactBps, 'bigint');
});

void test('PumpSwap quote SELL matches official SDK and real liquidity rule', () => {
  const amountInRaw = 400_000n;
  const request = {
    pool: pool(),
    reserves: reserves(),
    inputMint: BASE.toBase58(),
    amountInRaw,
    slippageBps: 0n,
  };
  const quote = createPumpSwapQuote(request, state(), 2_000);
  const official = sellBaseInput({
    base: bn(amountInRaw),
    slippage: 0,
    baseReserve: bn(reserves().baseReservesRaw),
    quoteReserve: bn(reserves().quoteVaultAmountRaw),
    virtualQuoteReserves: bn(reserves().virtualQuoteReservesRaw),
    globalConfig: globalConfig(),
    baseMintAccount: mint(),
    baseMint: BASE,
    coinCreator: COIN_CREATOR,
    creator: CREATOR,
    feeConfig: null,
  });
  assert.equal(quote.amountOutRaw, BigInt(official.uiQuote.toString()));
  assert.throws(
    () => createPumpSwapQuote({
      ...request,
      reserves: { ...reserves(), quoteVaultAmountRaw: 1n },
    }, state(), 2_000),
    SellQuoteUnavailableError,
  );
});

void test('PumpSwap quote selects dynamic tier and disables null creator fee', () => {
  const dynamic: PumpSwapFeeState = {
    ...state(),
    creatorFeeEnabled: false,
    tiers: [
      {
        marketCapThresholdRaw: 0n,
        lpFeeBps: 100n,
        protocolFeeBps: 50n,
        creatorFeeBps: 9_000n,
      },
      {
        marketCapThresholdRaw: 20_000_000n,
        lpFeeBps: 200n,
        protocolFeeBps: 100n,
        creatorFeeBps: 9_000n,
      },
    ],
  };
  const first = createPumpSwapQuote({
    pool: pool(),
    reserves: reserves(),
    inputMint: QUOTE.toBase58(),
    amountInRaw: 1_000_000n,
    slippageBps: 0n,
  }, dynamic, 2_000);
  const replay = createPumpSwapQuote({
    pool: pool(),
    reserves: reserves(),
    inputMint: QUOTE.toBase58(),
    amountInRaw: 1_000_000n,
    slippageBps: 0n,
  }, dynamic, 3_000);
  assert.equal(first.id, replay.id);
  assert.equal(first.amountOutRaw, replay.amountOutRaw);
  assert.ok(first.feesRaw < 100_000n);
});

void test('PumpSwap quote rejects unknown mint, bad bounds and zero output', () => {
  const base = {
    pool: pool(),
    reserves: reserves(),
    inputMint: 'unknown',
    amountInRaw: 1n,
    slippageBps: 0n,
  };
  assert.throws(
    () => createPumpSwapQuote(base, state(), 2_000),
    InvalidPumpSwapQuoteError,
  );
  assert.throws(
    () => createPumpSwapQuote({
      ...base,
      inputMint: QUOTE.toBase58(),
      slippageBps: 10_001n,
    }, state(), 2_000),
    InvalidPumpSwapQuoteError,
  );
  assert.throws(
    () => createPumpSwapQuote({
      ...base,
      inputMint: QUOTE.toBase58(),
    }, state(), 2_000),
    InvalidPumpSwapQuoteError,
  );
});

function pool(): CanonicalMarketPool {
  return {
    address: key(5).toBase58(),
    market: 'pumpswap',
    programId: key(6).toBase58(),
    baseMint: BASE.toBase58(),
    quoteAsset: {
      mint: QUOTE.toBase58(),
      decimals: 6,
      tokenProgram: 'SPL_TOKEN',
    },
    index: 0,
    creator: CREATOR.toBase58(),
    baseVault: key(7).toBase58(),
    quoteVault: key(8).toBase58(),
    lpMint: key(9).toBase58(),
    baseTokenProgram: 'SPL_TOKEN',
    activatedAt: {
      slot: 1n,
      transactionIndex: 0,
      instructionIndex: 0,
      innerInstructionIndex: null,
    },
    confirmationStatus: 'confirmed',
  };
}

function reserves(): MarketReserves {
  return {
    pool: pool().address,
    baseReservesRaw: 10_000_000n,
    quoteVaultAmountRaw: 20_000_000n,
    virtualQuoteReservesRaw: 5_000_000n,
    effectiveQuoteReservesRaw: 25_000_000n,
    observedSlot: 100n,
    observedAtMs: 1_000,
  };
}

function state(): PumpSwapFeeState {
  return {
    lpFeeBps: 100n,
    protocolFeeBps: 50n,
    creatorFeeBps: 25n,
    creatorFeeEnabled: true,
    baseMintSupplyRaw: 10_000_000n,
    tiers: [],
    observedSlot: 100n,
  };
}

function globalConfig(): GlobalConfig {
  return {
    admin: key(10),
    lpFeeBasisPoints: new BN(100),
    protocolFeeBasisPoints: new BN(50),
    disableFlags: 0,
    protocolFeeRecipients: [],
    coinCreatorFeeBasisPoints: new BN(25),
    adminSetCoinCreatorAuthority: key(11),
    whitelistPda: key(12),
    reservedFeeRecipient: key(13),
    mayhemModeEnabled: false,
    reservedFeeRecipients: [],
    buybackFeeRecipients: [],
    buybackBasisPoints: new BN(0),
    boostAuthority: key(14),
    boostEnabled: false,
  };
}

function mint(): RawMint {
  return {
    mintAuthorityOption: 0,
    mintAuthority: PublicKey.default,
    supply: 10_000_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default,
  };
}

function bn(value: bigint): BN {
  return new BN(value.toString());
}

function key(seed: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, index) =>
    (seed + index) % 256));
}

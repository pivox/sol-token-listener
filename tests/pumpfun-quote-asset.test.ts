import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PUBLIC_KEY,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ADDRESS,
  WSOL_MINT,
} from '../src/launchpads/pumpfun/constants.js';
import {
  normalizePumpQuoteMint,
  resolvePumpQuoteAsset,
} from '../src/launchpads/pumpfun/quote-asset.js';
import { PumpDecodingError } from '../src/launchpads/pumpfun/errors.js';
import type { NormalizedTokenBalance, NormalizedTransaction } from '../src/solana/rpc/types.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const UNKNOWN_MINT = 'UnknownMint111111111111111111111111111111111111';

void test('normalise le quote mint par défaut Pump en WSOL', () => {
  assert.equal(normalizePumpQuoteMint(DEFAULT_PUBLIC_KEY), WSOL_MINT);
  assert.equal(normalizePumpQuoteMint(USDC), USDC);
});

void test('résout WSOL sans dépendre des token balances', () => {
  assert.deepEqual(resolvePumpQuoteAsset(WSOL_MINT, transaction()), {
    mint: WSOL_MINT,
    decimals: 9,
    tokenProgram: 'SPL_TOKEN',
  });
});

void test('résout un quote SPL depuis les balances de transaction', () => {
  assert.deepEqual(resolvePumpQuoteAsset(USDC, transaction([
    balance(USDC, 6, SPL_TOKEN_PROGRAM_ID),
  ])), {
    mint: USDC,
    decimals: 6,
    tokenProgram: 'SPL_TOKEN',
  });
});

void test('résout un quote Token-2022 depuis les balances de transaction', () => {
  assert.deepEqual(resolvePumpQuoteAsset(USDC, transaction([
    balance(USDC, 8, TOKEN_2022_PROGRAM_ADDRESS),
  ])), {
    mint: USDC,
    decimals: 8,
    tokenProgram: 'TOKEN_2022',
  });
});

void test('échoue lorsque les métadonnées quote sont conflictuelles', () => {
  assert.throws(
    () => resolvePumpQuoteAsset(USDC, transaction([
      balance(USDC, 6, SPL_TOKEN_PROGRAM_ID),
      balance(USDC, 8, TOKEN_2022_PROGRAM_ADDRESS),
    ])),
    (error: unknown) => error instanceof PumpDecodingError
      && error.code === 'PUMP_QUOTE_ASSET_CONFLICT'
      && error.retryable,
  );
});

void test('échoue de façon rejouable sans balance quote', () => {
  assert.throws(
    () => resolvePumpQuoteAsset(USDC, transaction()),
    (error: unknown) => error instanceof PumpDecodingError
      && error.code === 'PUMP_QUOTE_ASSET_UNRESOLVED'
      && error.retryable,
  );
});

void test('refuse un programme token inconnu', () => {
  assert.throws(
    () => resolvePumpQuoteAsset(UNKNOWN_MINT, transaction([
      balance(UNKNOWN_MINT, 6, 'UnknownTokenProgram111111111111111111111111111'),
    ])),
    (error: unknown) => error instanceof PumpDecodingError
      && error.code === 'PUMP_TOKEN_PROGRAM_UNSUPPORTED'
      && !error.retryable,
  );
});

function transaction(
  postTokenBalances: readonly NormalizedTokenBalance[] = [],
): NormalizedTransaction {
  return {
    signature: 'test-signature',
    slot: 1n,
    transactionIndex: 0,
    confirmationStatus: 'CONFIRMED',
    version: 'legacy',
    blockTimeMs: null,
    accountKeys: [],
    signerKeys: [],
    instructions: [],
    preTokenBalances: [],
    postTokenBalances,
    preBalancesLamports: [],
    postBalancesLamports: [],
    feeLamports: 0n,
    computeUnits: null,
    logs: [],
    error: null,
  };
}

function balance(
  mint: string,
  decimals: number,
  tokenProgram: string,
): NormalizedTokenBalance {
  return {
    accountIndex: 1,
    account: 'account',
    mint,
    owner: null,
    tokenProgram,
    amountRaw: 1n,
    decimals,
  };
}

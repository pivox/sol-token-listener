import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ADDRESS,
  WSOL_MINT,
} from '../src/launchpads/pumpfun/constants.js';
import { PUMP_INSTRUCTIONS } from '../src/launchpads/pumpfun/generated/pump-idl.js';
import { decodePumpTransaction } from '../src/launchpads/pumpfun/transaction-decoder.js';
import { PumpFunLaunchpadAdapter } from '../src/launchpads/pumpfun/pumpfun-launchpad.adapter.js';
import type { PumpInstructionName } from '../src/launchpads/pumpfun/types.js';
import type {
  NormalizedInstruction,
  NormalizedTokenBalance,
  NormalizedTransaction,
} from '../src/solana/rpc/types.js';
import { createSolanaObservedTransaction } from '../src/solana/rpc/observed-transaction.js';

const BASE_MINT = address(1);
const QUOTE_MINT = address(2);
const POOL = address(3);
const CURVE = address(4);

void test('décode migrate historique avec WSOL', () => {
  const decoded = decodePumpTransaction(transaction([
    action('migrate', 2, null),
  ]));

  assert.equal(decoded.migrations.length, 1);
  assert.equal(decoded.migrations[0]?.instruction, 'MIGRATE');
  assert.equal(decoded.migrations[0]?.mint, BASE_MINT);
  assert.equal(decoded.migrations[0]?.bondingCurve, CURVE);
  assert.equal(decoded.migrations[0]?.announcedPool, POOL);
  assert.equal(decoded.migrations[0]?.quoteAsset.mint, WSOL_MINT);
  assert.equal(decoded.migrations[0]?.quoteAsset.decimals, 9);
});

void test('décode migrate_v2 multi-quote et Token-2022', () => {
  const decoded = decodePumpTransaction(transaction([
    action('migrate_v2', 3, null),
  ], [quoteBalance()]));

  assert.equal(decoded.migrations[0]?.instruction, 'MIGRATE_V2');
  assert.equal(decoded.migrations[0]?.mint, BASE_MINT);
  assert.equal(decoded.migrations[0]?.quoteAsset.mint, QUOTE_MINT);
  assert.equal(decoded.migrations[0]?.quoteAsset.decimals, 6);
  assert.equal(decoded.migrations[0]?.baseTokenProgram, 'TOKEN_2022');
  assert.equal(decoded.migrations[0]?.quoteAsset.tokenProgram, 'SPL_TOKEN');
});

void test('préserve plusieurs migrations externes et internes sans événement Pump', () => {
  const decoded = decodePumpTransaction(transaction([
    action('migrate', 2, null),
    action('migrate_v2', 3, 4, 2),
  ], [quoteBalance()]));

  assert.equal(decoded.migrations.length, 2);
  assert.equal(
    decoded.migrations[0]?.action.instruction.innerInstructionIndex,
    null,
  );
  assert.equal(
    decoded.migrations[1]?.action.instruction.innerInstructionIndex,
    4,
  );
});

void test('projette les migrations via l’enveloppe Solana partagée', async () => {
  const raw = transaction([action('migrate', 2, null)]);
  const observed = createSolanaObservedTransaction(raw, 2_000);
  const adapter = new PumpFunLaunchpadAdapter({
    read: async () => {
      throw new Error('unused');
    },
  });

  const [migration] = await adapter.decodeMigrations(observed);

  assert.equal(migration?.mint, BASE_MINT);
  assert.equal(migration?.cursor.slot, 99n);
  assert.equal(migration?.cursor.instructionIndex, 2);
  assert.equal(observed.raw, raw);
});

function action(
  name: Extract<PumpInstructionName, 'migrate' | 'migrate_v2'>,
  instructionIndex: number,
  innerInstructionIndex: number | null,
  stackHeight = 1,
): NormalizedInstruction {
  const definition = PUMP_INSTRUCTIONS[name];
  return {
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    accounts: definition.accounts.map((account) => accountValue(account.name)),
    data: Uint8Array.from(definition.discriminator),
    instructionIndex,
    innerInstructionIndex,
    parentInstructionIndex:
      innerInstructionIndex === null ? null : instructionIndex,
    stackHeight,
  };
}

function accountValue(name: string): string {
  switch (name) {
    case 'mint':
    case 'base_mint':
      return BASE_MINT;
    case 'quote_mint':
      return QUOTE_MINT;
    case 'bonding_curve':
      return CURVE;
    case 'pool':
      return POOL;
    case 'wsol_mint':
      return WSOL_MINT;
    case 'token_program':
    case 'quote_token_program':
      return SPL_TOKEN_PROGRAM_ID;
    case 'base_token_program':
      return TOKEN_2022_PROGRAM_ADDRESS;
    default:
      return address(20 + name.length);
  }
}

function quoteBalance(): NormalizedTokenBalance {
  return {
    accountIndex: 0,
    account: address(80),
    mint: QUOTE_MINT,
    owner: address(81),
    tokenProgram: SPL_TOKEN_PROGRAM_ID,
    amountRaw: 1n,
    decimals: 6,
  };
}

function transaction(
  instructions: readonly NormalizedInstruction[],
  balances: readonly NormalizedTokenBalance[] = [],
): NormalizedTransaction {
  return {
    signature: 'signature',
    slot: 99n,
    transactionIndex: 7,
    confirmationStatus: 'CONFIRMED',
    version: 0,
    blockTimeMs: 1_000,
    accountKeys: [],
    signerKeys: [],
    instructions,
    preTokenBalances: balances,
    postTokenBalances: balances,
    preBalancesLamports: [],
    postBalancesLamports: [],
    feeLamports: 0n,
    computeUnits: 1n,
    logs: [],
    error: null,
  };
}

function address(seed: number): string {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, index) =>
    (seed + index) % 256)).toBase58();
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { poolPda } from '@pump-fun/pump-swap-sdk';
import { PUMPSWAP_ACCOUNTS, PUMPSWAP_TYPES } from '../src/markets/pumpswap/generated/pumpswap-idl.js';
import { decodePumpSwapPoolAccount } from '../src/markets/pumpswap/pool-account-decoder.js';
import { validateCanonicalPumpSwapPool } from '../src/markets/pumpswap/pool-validator.js';
import type { ReadonlyAccountSnapshot } from '../src/ports/market-rpc-reader.js';

const CREATOR = key(1);
const BASE = key(2);
const QUOTE = key(3);
const ADDRESS = poolPda(0, CREATOR, BASE, QUOTE).toBase58();

void test('décode et valide le pool PumpSwap canonique index zéro', () => {
  const account = poolAccount();
  const decoded = decodePumpSwapPoolAccount(account);
  const pool = validateCanonicalPumpSwapPool({
    account,
    decoded,
    quoteAsset: { mint: QUOTE.toBase58(), decimals: 6, tokenProgram: 'SPL_TOKEN' },
    baseTokenProgram: 'TOKEN_2022',
    activatedAt: {
      slot: 10n, transactionIndex: 1, instructionIndex: 2,
      innerInstructionIndex: 3,
    },
    confirmationStatus: 'confirmed',
  });
  assert.equal(pool.address, ADDRESS);
  assert.equal(pool.index, 0);
  assert.equal(decoded.virtualQuoteReservesRaw, 5_000n);
});

void test('refuse un index ou une PDA non canonique', () => {
  const nonCanonical = poolAccount({ index: 1n });
  assert.throws(
    () => validateCanonicalPumpSwapPool({
      account: nonCanonical,
      decoded: decodePumpSwapPoolAccount(nonCanonical),
      quoteAsset: { mint: QUOTE.toBase58(), decimals: 6, tokenProgram: 'SPL_TOKEN' },
      baseTokenProgram: 'TOKEN_2022',
      activatedAt: { slot: 10n, transactionIndex: 1, instructionIndex: 2, innerInstructionIndex: 3 },
      confirmationStatus: 'confirmed',
    }),
    /canonique/u,
  );
});

function poolAccount(overrides: { readonly index?: bigint } = {}): ReadonlyAccountSnapshot {
  const values: Record<string, string | bigint | boolean> = {
    pool_bump: 1n,
    index: overrides.index ?? 0n,
    creator: CREATOR.toBase58(),
    base_mint: BASE.toBase58(),
    quote_mint: QUOTE.toBase58(),
    lp_mint: key(4).toBase58(),
    pool_base_token_account: key(5).toBase58(),
    pool_quote_token_account: key(6).toBase58(),
    lp_supply: 100n,
    coin_creator: key(7).toBase58(),
    is_mayhem_mode: false,
    is_cashback_coin: false,
    virtual_quote_reserves: 5_000n,
  };
  return {
    address: ADDRESS,
    owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    data: Uint8Array.from([
      ...PUMPSWAP_ACCOUNTS.Pool.discriminator,
      ...PUMPSWAP_TYPES.Pool.type.fields.flatMap((field) =>
        encode(field.type, values[field.name])),
      9, 9,
    ]),
    lamports: 1n,
    slot: 10n,
  };
}

function encode(type: unknown, input: string | bigint | boolean | undefined): number[] {
  if (input === undefined) throw new Error('Fixture pool incomplète.');
  if (type === 'u8' || type === 'bool') return [input === true ? 1 : Number(input)];
  if (type === 'u16') return little(2, BigInt(input));
  if (type === 'u64') return little(8, BigInt(input));
  if (type === 'i128') return little(16, BigInt(input));
  if (type === 'pubkey') return [...new PublicKey(String(input)).toBytes()];
  throw new Error(`Type pool inconnu: ${JSON.stringify(type)}`);
}

function little(width: number, input: bigint): number[] {
  let value = input < 0n ? (1n << BigInt(width * 8)) + input : input;
  return Array.from({ length: width }, () => {
    const byte = Number(value & 255n);
    value >>= 8n;
    return byte;
  });
}

function key(seed: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, index) =>
    (seed + index) % 256));
}

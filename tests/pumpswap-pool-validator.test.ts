import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { poolPda } from '../src/markets/pumpswap/official-sdk.js';
import {
  AccountType,
  ExtensionType,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PUMPSWAP_ACCOUNTS, PUMPSWAP_TYPES } from '../src/markets/pumpswap/generated/pumpswap-idl.js';
import { decodePumpSwapPoolAccount } from '../src/markets/pumpswap/pool-account-decoder.js';
import { validateCanonicalPumpSwapPool } from '../src/markets/pumpswap/pool-validator.js';
import type { ReadonlyAccountSnapshot } from '../src/ports/market-rpc-reader.js';

const CREATOR = key(1);
const BASE = key(2);
const QUOTE = key(3);
const ADDRESS = poolPda(0, CREATOR, BASE, QUOTE).toBase58();
const LP_MINT = key(4);
const BASE_VAULT = key(5);
const QUOTE_VAULT = key(6);

void test('décode et valide le pool PumpSwap canonique index zéro', () => {
  const account = poolAccount();
  const decoded = decodePumpSwapPoolAccount(account);
  const pool = validateCanonicalPumpSwapPool(validationInput(account, decoded));
  assert.equal(pool.address, ADDRESS);
  assert.equal(pool.index, 0);
  assert.equal(decoded.virtualQuoteReservesRaw, 5_000n);
});

void test('refuse un index ou une PDA non canonique', () => {
  const nonCanonical = poolAccount({ index: 1n });
  assert.throws(
    () => validateCanonicalPumpSwapPool(
      validationInput(nonCanonical, decodePumpSwapPoolAccount(nonCanonical)),
    ),
    /canonique/u,
  );
});

void test('refuse les contradictions de vault, programme et extension Token-2022', () => {
  const account = poolAccount();
  const decoded = decodePumpSwapPoolAccount(account);
  const valid = validationInput(account, decoded);
  assert.throws(
    () => validateCanonicalPumpSwapPool({
      ...valid,
      creation: creation({ baseVault: key(30).toBase58() }),
    }),
    /contradictoire/u,
  );
  assert.throws(
    () => validateCanonicalPumpSwapPool({
      ...valid,
      creation: creation({ baseTokenProgram: TOKEN_PROGRAM_ID.toBase58() }),
    }),
    /contradictoire/u,
  );
  assert.throws(
    () => validateCanonicalPumpSwapPool({
      ...valid,
      baseMintAccount: mintAccount(
        BASE,
        TOKEN_2022_PROGRAM_ID,
        6,
        ExtensionType.TransferFeeConfig,
      ),
    }),
    (error: unknown) => error instanceof Error
      && error.message.includes('TransferFeeConfig'),
  );
});

function poolAccount(overrides: { readonly index?: bigint } = {}): ReadonlyAccountSnapshot {
  const values: Record<string, string | bigint | boolean> = {
    pool_bump: 1n,
    index: overrides.index ?? 0n,
    creator: CREATOR.toBase58(),
    base_mint: BASE.toBase58(),
    quote_mint: QUOTE.toBase58(),
    lp_mint: LP_MINT.toBase58(),
    pool_base_token_account: BASE_VAULT.toBase58(),
    pool_quote_token_account: QUOTE_VAULT.toBase58(),
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

function validationInput(
  account: ReadonlyAccountSnapshot,
  decoded: ReturnType<typeof decodePumpSwapPoolAccount>,
) {
  return {
    account,
    decoded,
    baseMintAccount: mintAccount(BASE, TOKEN_2022_PROGRAM_ID, 6),
    quoteMintAccount: mintAccount(QUOTE, TOKEN_PROGRAM_ID, 6),
    creation: creation(),
    quoteAsset: {
      mint: QUOTE.toBase58(),
      decimals: 6,
      tokenProgram: 'SPL_TOKEN' as const,
    },
    baseTokenProgram: 'TOKEN_2022' as const,
    activatedAt: {
      slot: 10n,
      transactionIndex: 1,
      instructionIndex: 2,
      innerInstructionIndex: 3,
    },
    confirmationStatus: 'confirmed' as const,
  };
}

function creation(overrides: {
  readonly baseVault?: string;
  readonly baseTokenProgram?: string;
} = {}) {
  const instruction = {
    programId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    accounts: [],
    data: new Uint8Array(),
    instructionIndex: 2,
    innerInstructionIndex: 3,
    parentInstructionIndex: 2,
    stackHeight: 2,
  };
  return {
    action: {
      name: 'create_pool' as const,
      family: 'CREATE_POOL' as const,
      instruction,
      accounts: {
        pool: ADDRESS,
        creator: CREATOR.toBase58(),
        base_mint: BASE.toBase58(),
        quote_mint: QUOTE.toBase58(),
        lp_mint: LP_MINT.toBase58(),
        pool_base_token_account:
          overrides.baseVault ?? BASE_VAULT.toBase58(),
        pool_quote_token_account: QUOTE_VAULT.toBase58(),
        base_token_program:
          overrides.baseTokenProgram ?? TOKEN_2022_PROGRAM_ID.toBase58(),
        quote_token_program: TOKEN_PROGRAM_ID.toBase58(),
      },
      args: { index: 0n },
    },
    event: {
      kind: 'CREATE_POOL' as const,
      instruction,
      fields: {
        pool: ADDRESS,
        creator: CREATOR.toBase58(),
        base_mint: BASE.toBase58(),
        quote_mint: QUOTE.toBase58(),
        lp_mint: LP_MINT.toBase58(),
        coin_creator: key(7).toBase58(),
        pool_bump: 1n,
        base_mint_decimals: 6n,
        quote_mint_decimals: 6n,
      },
      trailingDataHex: '',
    },
    pool: ADDRESS,
    index: 0n,
    creator: CREATOR.toBase58(),
    baseMint: BASE.toBase58(),
    quoteMint: QUOTE.toBase58(),
  };
}

function mintAccount(
  address: PublicKey,
  owner: PublicKey,
  decimals: number,
  extension: ExtensionType | null = null,
): ReadonlyAccountSnapshot {
  const data = Buffer.alloc(extension === null ? MintLayout.span : 170);
  MintLayout.encode({
    mintAuthorityOption: 0,
    mintAuthority: PublicKey.default,
    supply: 1_000n,
    decimals,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default,
  }, data);
  if (extension !== null) {
    data[165] = AccountType.Mint;
    data.writeUInt16LE(extension, 166);
    data.writeUInt16LE(0, 168);
  }
  return {
    address: address.toBase58(),
    owner: owner.toBase58(),
    data,
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

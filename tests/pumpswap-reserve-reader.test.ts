import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import type { CanonicalMarketPool } from '../src/domain/market.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { PUMPSWAP_ACCOUNTS, PUMPSWAP_TYPES } from '../src/markets/pumpswap/generated/pumpswap-idl.js';
import {
  InvalidEffectiveQuoteReserveError,
  InvalidPumpSwapReserveError,
  PumpSwapReserveReader,
} from '../src/markets/pumpswap/pumpswap-reserve-reader.js';
import type { ReadonlyAccountSnapshot } from '../src/ports/market-rpc-reader.js';
import { SolanaMarketRpcReader } from '../src/solana/rpc/market-rpc-reader.js';

const POOL = key(1);
const CREATOR = key(2);
const BASE = key(3);
const QUOTE = key(4);
const BASE_VAULT = key(5);
const QUOTE_VAULT = key(6);

void test('PumpSwap reserves include signed virtual quote reserves', async () => {
  const accounts = fixtures();
  const reader = new PumpSwapReserveReader({
    readAccountsAtSameSlot: () => Promise.resolve(accounts),
  }, () => 2_000);
  const snapshot = await reader.read(canonicalPool());
  assert.equal(snapshot.baseReservesRaw, 10_000_000n);
  assert.equal(snapshot.quoteVaultAmountRaw, 20_000_000n);
  assert.equal(snapshot.virtualQuoteReservesRaw, 5_000_000n);
  assert.equal(snapshot.effectiveQuoteReservesRaw, 25_000_000n);
  assert.equal(snapshot.observedSlot, 123n);
});

void test('PumpSwap reserves reject inconsistent slot, owner and mint', async () => {
  const valid = fixtures();
  for (const accounts of [
    [valid[0], { ...valid[1], slot: 124n }, valid[2]],
    [valid[0], { ...valid[1], owner: TOKEN_PROGRAM_ID.toBase58() }, valid[2]],
    [valid[0], tokenAccount(BASE_VAULT, QUOTE, 10_000_000n, TOKEN_2022_PROGRAM_ID), valid[2]],
  ] as const) {
    const reader = new PumpSwapReserveReader({
      readAccountsAtSameSlot: () => Promise.resolve(accounts),
    });
    await assert.rejects(reader.read(canonicalPool()), InvalidPumpSwapReserveError);
  }
});

void test('PumpSwap reserves reject non-positive effective quote liquidity', async () => {
  const accounts = fixtures(-20_000_000n);
  const reader = new PumpSwapReserveReader({
    readAccountsAtSameSlot: () => Promise.resolve(accounts),
  });
  await assert.rejects(
    reader.read(canonicalPool()),
    (error: unknown) => error instanceof InvalidEffectiveQuoteReserveError
      && error.amountRaw === 0n,
  );
});

void test('Solana market RPC reader snapshots one immutable context without writes', async () => {
  const address = key(20);
  const reader = new SolanaMarketRpcReader({
    getMultipleAccountsInfoAndContext(publicKeys, config) {
      assert.deepEqual(publicKeys, [address]);
      assert.equal(config.commitment, 'finalized');
      return Promise.resolve({
        context: { slot: 123 },
        value: [{
          data: Buffer.from([1, 2]),
          executable: false,
          lamports: 42,
          owner: TOKEN_PROGRAM_ID,
          rentEpoch: 0,
        }],
      });
    },
  }, 'finalized');
  const [snapshot] = await reader.readAccountsAtSameSlot([address.toBase58()]);
  assert.equal(snapshot?.slot, 123n);
  assert.equal(snapshot?.lamports, 42n);
  assert.deepEqual(snapshot?.data, Uint8Array.from([1, 2]));
});

function canonicalPool(): CanonicalMarketPool {
  return {
    address: POOL.toBase58(),
    market: 'pumpswap',
    programId: PUMPSWAP_PROGRAM_ID,
    baseMint: BASE.toBase58(),
    quoteAsset: {
      mint: QUOTE.toBase58(),
      decimals: 6,
      tokenProgram: 'SPL_TOKEN',
    },
    index: 0,
    creator: CREATOR.toBase58(),
    baseVault: BASE_VAULT.toBase58(),
    quoteVault: QUOTE_VAULT.toBase58(),
    lpMint: key(7).toBase58(),
    baseTokenProgram: 'TOKEN_2022',
    activatedAt: {
      slot: 100n,
      transactionIndex: 0,
      instructionIndex: 1,
      innerInstructionIndex: 1,
    },
    confirmationStatus: 'confirmed',
  };
}

function fixtures(
  virtualQuoteReservesRaw = 5_000_000n,
): readonly [ReadonlyAccountSnapshot, ReadonlyAccountSnapshot, ReadonlyAccountSnapshot] {
  return [
    poolAccount(virtualQuoteReservesRaw),
    tokenAccount(BASE_VAULT, BASE, 10_000_000n, TOKEN_2022_PROGRAM_ID),
    tokenAccount(QUOTE_VAULT, QUOTE, 20_000_000n, TOKEN_PROGRAM_ID),
  ];
}

function poolAccount(virtualQuoteReservesRaw: bigint): ReadonlyAccountSnapshot {
  const values: Record<string, string | bigint | boolean> = {
    pool_bump: 1n,
    index: 0n,
    creator: CREATOR.toBase58(),
    base_mint: BASE.toBase58(),
    quote_mint: QUOTE.toBase58(),
    lp_mint: key(7).toBase58(),
    pool_base_token_account: BASE_VAULT.toBase58(),
    pool_quote_token_account: QUOTE_VAULT.toBase58(),
    lp_supply: 100n,
    coin_creator: key(8).toBase58(),
    is_mayhem_mode: false,
    is_cashback_coin: false,
    virtual_quote_reserves: virtualQuoteReservesRaw,
  };
  return {
    address: POOL.toBase58(),
    owner: PUMPSWAP_PROGRAM_ID,
    data: Uint8Array.from([
      ...PUMPSWAP_ACCOUNTS.Pool.discriminator,
      ...PUMPSWAP_TYPES.Pool.type.fields.flatMap((field) =>
        encode(field.type, values[field.name])),
    ]),
    lamports: 1n,
    slot: 123n,
  };
}

function tokenAccount(
  address: PublicKey,
  mint: PublicKey,
  amountRaw: bigint,
  program: PublicKey,
): ReadonlyAccountSnapshot {
  const data = new Uint8Array(165);
  data.set(mint.toBytes(), 0);
  data.set(little(8, amountRaw), 64);
  return {
    address: address.toBase58(),
    owner: program.toBase58(),
    data,
    lamports: 1n,
    slot: 123n,
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

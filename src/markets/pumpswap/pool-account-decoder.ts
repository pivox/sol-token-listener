import type { ReadonlyAccountSnapshot } from '../../ports/market-rpc-reader.js';
import { PumpSwapBorshReader } from './borsh-reader.js';
import { PUMPSWAP_PROGRAM_ID } from './constants.js';
import { PumpSwapDecodingError } from './errors.js';
import { PUMPSWAP_ACCOUNTS } from './generated/pumpswap-idl.js';
import type { DecodedPumpSwapPoolAccount } from './types.js';

export function decodePumpSwapPoolAccount(
  account: ReadonlyAccountSnapshot,
): DecodedPumpSwapPoolAccount {
  if (account.owner !== PUMPSWAP_PROGRAM_ID) {
    throw invalid('Propriétaire du compte pool PumpSwap invalide.');
  }
  const discriminator = Uint8Array.from(PUMPSWAP_ACCOUNTS.Pool.discriminator);
  if (
    account.data.length < discriminator.length
    || !discriminator.every((value, index) => account.data[index] === value)
  ) throw invalid('Discriminator du pool PumpSwap invalide.');
  const reader = new PumpSwapBorshReader(account.data.subarray(8));
  const poolBump = number(reader.readU8(), 'pool_bump', 255);
  const index = number(reader.readU16(), 'index', 65_535);
  const creator = reader.readPubkey();
  const baseMint = reader.readPubkey();
  const quoteMint = reader.readPubkey();
  const lpMint = reader.readPubkey();
  const baseVault = reader.readPubkey();
  const quoteVault = reader.readPubkey();
  const lpSupplyRaw = reader.readU64();
  const coinCreator = reader.readPubkey();
  const isMayhemMode = reader.readBool();
  const isCashbackCoin = reader.readBool();
  const virtualQuoteReservesRaw = reader.readI128();
  return Object.freeze({
    poolBump,
    index,
    creator,
    baseMint,
    quoteMint,
    lpMint,
    baseVault,
    quoteVault,
    lpSupplyRaw,
    coinCreator,
    isMayhemMode,
    isCashbackCoin,
    virtualQuoteReservesRaw,
    trailingDataHex: Buffer.from(
      account.data.subarray(8 + reader.offset),
    ).toString('hex'),
  });
}

function number(value: bigint, field: string, maximum: number): number {
  if (value < 0n || value > BigInt(maximum)) throw invalid(`Champ ${field} invalide.`);
  return Number(value);
}

function invalid(message: string): PumpSwapDecodingError {
  return new PumpSwapDecodingError('PUMPSWAP_SCHEMA_UNSUPPORTED', message);
}

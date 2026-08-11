import {
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_SDK,
  PUMP_FEE_PROGRAM_ID,
} from './official-sdk.js';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import type { CanonicalMarketPool } from '../../domain/market.js';
import type {
  MarketRpcReader,
  ReadonlyAccountSnapshot,
} from '../../ports/market-rpc-reader.js';
import { PumpSwapBorshReader } from './borsh-reader.js';
import { PUMPSWAP_PROGRAM_ID } from './constants.js';
import { PUMPSWAP_ACCOUNTS } from './generated/pumpswap-idl.js';
import { decodePumpSwapPoolAccount } from './pool-account-decoder.js';

export interface PumpSwapFeeTier {
  readonly marketCapThresholdRaw: bigint;
  readonly lpFeeBps: bigint;
  readonly protocolFeeBps: bigint;
  readonly creatorFeeBps: bigint;
}

export interface PumpSwapFeeState {
  readonly lpFeeBps: bigint;
  readonly protocolFeeBps: bigint;
  readonly creatorFeeBps: bigint;
  readonly creatorFeeEnabled: boolean;
  readonly baseMintSupplyRaw: bigint;
  readonly tiers: readonly PumpSwapFeeTier[];
  readonly observedSlot: bigint;
}

export class InvalidPumpSwapFeeStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidPumpSwapFeeStateError';
  }
}

export class PumpSwapFeeStateReader {
  public constructor(private readonly rpc: MarketRpcReader) {}

  public async read(pool: CanonicalMarketPool): Promise<PumpSwapFeeState> {
    return decodePumpSwapFeeState(
      await this.rpc.readAccountsAtSameSlot([
        GLOBAL_CONFIG_PDA.toBase58(),
        PUMP_AMM_FEE_CONFIG_PDA.toBase58(),
        pool.baseMint,
        pool.address,
      ]),
      pool,
    );
  }
}

export function decodePumpSwapFeeState(
  accounts: readonly (ReadonlyAccountSnapshot | null)[],
  pool: CanonicalMarketPool,
): PumpSwapFeeState {
  const globalAccount = required(accounts[0], GLOBAL_CONFIG_PDA.toBase58());
  const feeAccount = accounts[1];
  const mintAccount = required(accounts[2], pool.baseMint);
  const poolAccount = required(accounts[3], pool.address);
  const present = [globalAccount, mintAccount, poolAccount, feeAccount]
    .filter((account): account is ReadonlyAccountSnapshot => account != null);
  if (present.some((account) => account.slot !== globalAccount.slot)) {
    throw new InvalidPumpSwapFeeStateError(
      'Les comptes de frais ne partagent pas le même slot.',
    );
  }
  owner(globalAccount, PUMPSWAP_PROGRAM_ID);
  owner(poolAccount, PUMPSWAP_PROGRAM_ID);
  owner(mintAccount, tokenProgram(pool.baseTokenProgram).toBase58());
  if (mintAccount.data.length < MintLayout.span) {
    throw new InvalidPumpSwapFeeStateError('Compte mint tronqué.');
  }
  const mint = MintLayout.decode(mintAccount.data);
  const global = PUMP_AMM_SDK.decodeGlobalConfig(accountInfo(globalAccount));
  const decodedPool = decodePumpSwapPoolAccount(poolAccount);
  const defaults = {
    lpFeeBps: decimal(global.lpFeeBasisPoints.toString(), 'lpFeeBps'),
    protocolFeeBps: decimal(
      global.protocolFeeBasisPoints.toString(),
      'protocolFeeBps',
    ),
    creatorFeeBps: decimal(
      global.coinCreatorFeeBasisPoints.toString(),
      'creatorFeeBps',
    ),
  };
  const tiers = feeAccount == null
    ? []
    : decodeFeeTiers(required(feeAccount, PUMP_AMM_FEE_CONFIG_PDA.toBase58()));
  validateFees(defaults);
  validateTiers(tiers);
  return Object.freeze({
    ...defaults,
    creatorFeeEnabled:
      decodedPool.coinCreator !== PublicKey.default.toBase58(),
    baseMintSupplyRaw: mint.supply,
    tiers: Object.freeze(tiers),
    observedSlot: globalAccount.slot,
  });
}

function decodeFeeTiers(account: ReadonlyAccountSnapshot): PumpSwapFeeTier[] {
  owner(account, PUMP_FEE_PROGRAM_ID.toBase58());
  const discriminator = Uint8Array.from(PUMPSWAP_ACCOUNTS.FeeConfig.discriminator);
  if (!discriminator.every((value, index) => account.data[index] === value)) {
    throw new InvalidPumpSwapFeeStateError(
      'Discriminator FeeConfig invalide.',
    );
  }
  const reader = new PumpSwapBorshReader(account.data.subarray(8));
  reader.readU8();
  reader.readPubkey();
  readFees(reader);
  const length = boundedLength(reader.readU32());
  return Array.from({ length }, () => {
    const marketCapThresholdRaw = reader.readU128();
    return Object.freeze({ marketCapThresholdRaw, ...readFees(reader) });
  });
}

function readFees(
  reader: PumpSwapBorshReader,
): Omit<PumpSwapFeeTier, 'marketCapThresholdRaw'> {
  return {
    lpFeeBps: reader.readU64(),
    protocolFeeBps: reader.readU64(),
    creatorFeeBps: reader.readU64(),
  };
}

function boundedLength(value: bigint): number {
  if (value > 256n) {
    throw new InvalidPumpSwapFeeStateError('Trop de paliers de frais.');
  }
  return Number(value);
}

function validateTiers(tiers: readonly PumpSwapFeeTier[]): void {
  let previous: bigint | null = null;
  for (const tier of tiers) {
    validateFees(tier);
    if (previous !== null && tier.marketCapThresholdRaw <= previous) {
      throw new InvalidPumpSwapFeeStateError(
        'Seuils de frais non strictement croissants.',
      );
    }
    previous = tier.marketCapThresholdRaw;
  }
}

function validateFees(fees: {
  readonly lpFeeBps: bigint;
  readonly protocolFeeBps: bigint;
  readonly creatorFeeBps: bigint;
}): void {
  for (const value of [
    fees.lpFeeBps,
    fees.protocolFeeBps,
    fees.creatorFeeBps,
  ]) {
    if (value < 0n || value > 10_000n) {
      throw new InvalidPumpSwapFeeStateError(
        `Basis points invalides: ${value.toString()}.`,
      );
    }
  }
}

function required(
  account: ReadonlyAccountSnapshot | null | undefined,
  address: string,
): ReadonlyAccountSnapshot {
  if (account?.address !== address) {
    throw new InvalidPumpSwapFeeStateError(`Compte requis absent: ${address}.`);
  }
  return account;
}

function owner(account: ReadonlyAccountSnapshot, expected: string): void {
  if (account.owner !== expected) {
    throw new InvalidPumpSwapFeeStateError(
      `Owner invalide pour ${account.address}.`,
    );
  }
}

function tokenProgram(kind: CanonicalMarketPool['baseTokenProgram']): PublicKey {
  return kind === 'TOKEN_2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

function decimal(value: string, field: string): bigint {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidPumpSwapFeeStateError(`${field} non décimal.`);
  }
  return BigInt(value);
}

function accountInfo(snapshot: ReadonlyAccountSnapshot): AccountInfo<Buffer> {
  if (snapshot.lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidPumpSwapFeeStateError('Lamports hors plage SDK.');
  }
  return {
    data: Buffer.from(snapshot.data),
    executable: false,
    lamports: Number(snapshot.lamports),
    owner: new PublicKey(snapshot.owner),
    rentEpoch: 0,
  };
}

import {
  AccountType,
  ExtensionType,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  bondingCurvePda,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_SDK,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from '../../src/launchpads/pumpfun/official-sdk.js';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { PUMP_PROGRAM_ID, WSOL_MINT } from '../../src/launchpads/pumpfun/constants.js';
import type { MarketRpcReader, ReadonlyAccountSnapshot } from '../../src/ports/market-rpc-reader.js';

export const MINT = new PublicKey(new Uint8Array(32).fill(7));
const CREATOR = new PublicKey(new Uint8Array(32).fill(9));
export const SLOT = 123n;
export const NOW = 1_700_000_000_000;
export const quoteAsset = Object.freeze({ mint: WSOL_MINT, decimals: 9, tokenProgram: 'SPL_TOKEN' as const });

export class FakeReader implements MarketRpcReader {
  public addresses: readonly string[] = [];
  public constructor(private readonly snapshots: readonly (ReadonlyAccountSnapshot | null)[]) {}
  public async readAccountsAtSameSlot(addresses: readonly string[]): Promise<readonly (ReadonlyAccountSnapshot | null)[]> {
    this.addresses = addresses;
    return this.snapshots;
  }
}

export async function accounts(options: {
  readonly mintOwner?: PublicKey;
  readonly complete?: boolean;
  readonly realQuoteReserves?: bigint;
  readonly isCashbackCoin?: boolean;
  readonly token2022Extension?: ExtensionType;
} = {}): Promise<{
  readonly snapshots: readonly [ReadonlyAccountSnapshot, ReadonlyAccountSnapshot, ReadonlyAccountSnapshot, ReadonlyAccountSnapshot];
  readonly global: Global; readonly feeConfig: FeeConfig; readonly curve: BondingCurve; readonly mintSupply: BN;
}> {
  const zero = PublicKey.default;
  const repeated = (length: number): PublicKey[] => Array.from({ length }, () => zero);
  const global: Global = {
    initialized: true, authority: zero, feeRecipient: zero,
    initialVirtualTokenReserves: new BN('1000000000'), initialVirtualSolReserves: new BN('100000000'),
    initialRealTokenReserves: new BN('800000000'), tokenTotalSupply: new BN('1000000000'), feeBasisPoints: new BN(100),
    withdrawAuthority: zero, enableMigrate: true, poolMigrationFee: new BN(0), creatorFeeBasisPoints: new BN(50),
    feeRecipients: repeated(7), setCreatorAuthority: zero, adminSetCreatorAuthority: zero, createV2Enabled: true,
    whitelistPda: zero, reservedFeeRecipient: zero, mayhemModeEnabled: false, reservedFeeRecipients: repeated(7),
    isCashbackEnabled: false, buybackFeeRecipients: repeated(8), buybackBasisPoints: new BN(0),
    initialVirtualQuoteReserves: new BN('100000000'), whitelistedQuoteMints: [new PublicKey(WSOL_MINT)],
  };
  const feeConfig = {
    bump: 1, admin: zero,
    flatFees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(100), creatorFeeBps: new BN(50) },
    feeTiers: [{ marketCapLamportsThreshold: new BN(0), fees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(100), creatorFeeBps: new BN(50) } }],
    stableFeeTiers: [],
  } as FeeConfig & { readonly bump: number; readonly stableFeeTiers: readonly unknown[] };
  const curve: BondingCurve = {
    virtualTokenReserves: new BN('1000000000'), virtualQuoteReserves: new BN('100000000'),
    realTokenReserves: new BN('800000000'), realQuoteReserves: new BN((options.realQuoteReserves ?? 50_000_000n).toString()),
    tokenTotalSupply: new BN('1000000000'), complete: options.complete ?? false, creator: CREATOR,
    isMayhemMode: false, isCashbackCoin: options.isCashbackCoin ?? false, quoteMint: new PublicKey(WSOL_MINT),
  };
  const mintSupply = new BN('1000000000');
  const token2022 = (options.mintOwner ?? TOKEN_PROGRAM_ID).equals(TOKEN_2022_PROGRAM_ID);
  const tokenExtension=options.token2022Extension??ExtensionType.MetadataPointer;
  const extensionLength=tokenExtension===ExtensionType.TransferFeeConfig?108:64;
  const mintData = Buffer.alloc(token2022 ? 170+extensionLength : MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: zero, supply: BigInt(mintSupply.toString(10)), decimals: 6,
    isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: zero }, mintData);
  if (token2022) {
    mintData[165] = AccountType.Mint;
    mintData.writeUInt16LE(tokenExtension,166);
    mintData.writeUInt16LE(extensionLength,168);
    if(tokenExtension===ExtensionType.MetadataPointer)MINT.toBuffer().copy(mintData,202);
  }
  return { global, feeConfig, curve, mintSupply, snapshots: [
    snapshot(GLOBAL_PDA.toBase58(), PUMP_PROGRAM_ID, encodeAccount('global', global)),
    snapshot(PUMP_FEE_CONFIG_PDA.toBase58(), PUMP_FEE_PROGRAM_ID.toBase58(), encodeAccount('feeConfig', feeConfig)),
    snapshot(bondingCurvePda(MINT).toBase58(), PUMP_PROGRAM_ID, encodeAccount('bondingCurve', curve)),
    snapshot(MINT.toBase58(), (options.mintOwner ?? TOKEN_PROGRAM_ID).toBase58(), mintData),
  ] };
}

function snapshot(address: string, owner: string, data: Uint8Array): ReadonlyAccountSnapshot {
  return { address, owner, data, lamports: 1n, slot: SLOT };
}

interface AccountLayoutEntry { readonly discriminator: readonly number[]; readonly layout: { encode(value: unknown, destination: Buffer): number } }
function encodeAccount(name: string, value: unknown): Buffer {
  const sdk = PUMP_SDK as unknown as { readonly offlinePumpProgram: { readonly coder: { readonly accounts: { readonly accountLayouts: ReadonlyMap<string, AccountLayoutEntry> } } } };
  const entry = sdk.offlinePumpProgram.coder.accounts.accountLayouts.get(name);
  if (entry === undefined) throw new Error(`Unknown official SDK account fixture: ${name}.`);
  const destination = Buffer.alloc(4_096); const length = entry.layout.encode(value, destination);
  return Buffer.concat([Buffer.from(entry.discriminator), destination.subarray(0, length)]);
}

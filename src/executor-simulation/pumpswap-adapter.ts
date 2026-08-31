import { isProxy } from 'node:util/types';
import {
  AccountLayout,
  AccountState,
  AccountType,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getTypeLen,
  MintLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type RawMint,
  unpackMint,
} from '@solana/spl-token';
import { pack as packTokenMetadata, unpack as unpackTokenMetadata } from '@solana/spl-token-metadata';
import {
  PublicKey,
  SystemProgram,
  type AccountMeta,
  type AccountInfo,
  type TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import {
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
  GLOBAL_CONFIG_PDA,
  lpMintPda,
  POOL_ACCOUNT_NEW_SIZE,
  poolPda,
  poolV2Pda,
  pumpAmmJson,
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SDK,
  PUMP_FEE_PROGRAM_ID,
  pumpPoolAuthorityPda,
  userVolumeAccumulatorPda,
  type FeeConfig,
  type GlobalConfig,
  type Pool,
  type SwapSolanaState,
} from '../markets/pumpswap/official-sdk.js';
import type { ExecutionVenuePool } from '../ports/execution-venue-repository.js';
import {
  ExecutionBuildPolicyError,
  type BuildRecipientSelectionV1,
  type NormalizedInstructionV1,
  type UnsignedBuildPlanV1,
  type UnsignedBuildTokenProgram,
} from './build-plan.js';

const REQUEST_KEYS = Object.freeze(['quote', 'user', 'poolProof', 'snapshot'] as const);
const QUOTE_KEYS = Object.freeze([
  'payloadVersion', 'venue', 'side', 'mint', 'quoteMint', 'baseTokenProgram',
  'quoteTokenProgram', 'quoteDecimals', 'amountInRaw', 'expectedAmountOutRaw',
  'protectedAmountOutRaw', 'snapshotSlot', 'quoteFingerprint', 'snapshotFingerprint',
] as const);
const POOL_PROOF_KEYS = Object.freeze([
  'migrationId', 'migrationInstruction', 'migrationConfirmationStatus',
  'poolAddress', 'market', 'programId', 'poolIndex', 'creator', 'baseMint',
  'quoteMint', 'quoteDecimals', 'baseTokenProgram', 'quoteTokenProgram',
  'baseVault', 'quoteVault', 'lpMint', 'poolConfirmationStatus', 'activatedSlot',
  'transactionIndex', 'instructionIndex', 'innerInstructionIndex',
] as const);
const SNAPSHOT_KEYS = Object.freeze([
  'slot', 'globalConfig', 'feeConfig', 'pool', 'baseMint', 'quoteMint',
  'baseVault', 'quoteVault', 'userBaseTokenAccount', 'userQuoteTokenAccount',
  'userVolumeAccumulator', 'userVolumeQuoteTokenAccount', 'poolV2',
] as const);
const POOL_SNAPSHOT_KEYS = Object.freeze(['address', 'ownerProgramId', 'dataBase64'] as const);
const GLOBAL_SNAPSHOT_KEYS = Object.freeze(['address', 'ownerProgramId', 'dataBase64'] as const);
const FEE_SNAPSHOT_KEYS = Object.freeze(['address', 'ownerProgramId', 'dataBase64'] as const);
const MINT_SNAPSHOT_KEYS = Object.freeze([
  'address', 'ownerProgramId', 'dataBase64', 'decoded',
] as const);
const RAW_MINT_KEYS = Object.freeze([
  'mintAuthorityOption', 'mintAuthority', 'supplyRaw', 'decimals',
  'isInitialized', 'freezeAuthorityOption', 'freezeAuthority',
] as const);
const TOKEN_ACCOUNT_KEYS = Object.freeze(['address', 'exists', 'ownerProgramId', 'dataBase64'] as const);
const OPTIONAL_ACCOUNT_KEYS = TOKEN_ACCOUNT_KEYS;
const U64_MAX = (1n << 64n) - 1n;
const MAX_ACCOUNT_BYTES = 16_384;
const MAX_TIERS = 64;
const TOKEN_METADATA_EXTENSION_TYPE: number = ExtensionType.TokenMetadata;
const ALLOWED_TOKEN_2022_MINT_EXTENSIONS = new Set<number>([
  ExtensionType.MintCloseAuthority,
  ExtensionType.MetadataPointer,
  TOKEN_METADATA_EXTENSION_TYPE,
  ExtensionType.GroupPointer,
  ExtensionType.TokenGroup,
  ExtensionType.GroupMemberPointer,
  ExtensionType.TokenGroupMember,
]);
const FIXED_TOKEN_2022_MINT_EXTENSION_LENGTHS = new Map<number, number>([
  [ExtensionType.MintCloseAuthority, getTypeLen(ExtensionType.MintCloseAuthority)],
  [ExtensionType.MetadataPointer, getTypeLen(ExtensionType.MetadataPointer)],
  [ExtensionType.GroupPointer, getTypeLen(ExtensionType.GroupPointer)],
  [ExtensionType.TokenGroup, getTypeLen(ExtensionType.TokenGroup)],
  [ExtensionType.GroupMemberPointer, getTypeLen(ExtensionType.GroupMemberPointer)],
  [ExtensionType.TokenGroupMember, getTypeLen(ExtensionType.TokenGroupMember)],
]);

export interface PumpSwapBuildQuoteV1 {
  readonly payloadVersion: 1;
  readonly venue: 'PUMP_SWAP';
  readonly side: 'SELL';
  readonly mint: string;
  readonly quoteMint: string;
  readonly baseTokenProgram: UnsignedBuildTokenProgram;
  readonly quoteTokenProgram: 'SPL_TOKEN';
  readonly quoteDecimals: 9;
  readonly amountInRaw: bigint;
  readonly expectedAmountOutRaw: bigint;
  readonly protectedAmountOutRaw: bigint;
  readonly snapshotSlot: bigint;
  readonly quoteFingerprint: string;
  readonly snapshotFingerprint: string;
}

export interface PumpSwapGlobalConfigDecodedV1 {
  readonly admin: string;
  readonly lpFeeBasisPoints: bigint;
  readonly protocolFeeBasisPoints: bigint;
  readonly disableFlags: number;
  readonly protocolFeeRecipients: readonly string[];
  readonly coinCreatorFeeBasisPoints: bigint;
  readonly adminSetCoinCreatorAuthority: string;
  readonly whitelistPda: string;
  readonly reservedFeeRecipient: string;
  readonly mayhemModeEnabled: boolean;
  readonly reservedFeeRecipients: readonly string[];
  readonly buybackFeeRecipients: readonly string[];
  readonly buybackBasisPoints: bigint;
  readonly boostAuthority: string;
  readonly boostEnabled: boolean;
}

export interface PumpSwapFeesDecodedV1 {
  readonly lpFeeBps: bigint;
  readonly protocolFeeBps: bigint;
  readonly creatorFeeBps: bigint;
}

export interface PumpSwapFeeTierDecodedV1 {
  readonly marketCapLamportsThreshold: bigint;
  readonly fees: PumpSwapFeesDecodedV1;
}

export interface PumpSwapFeeConfigDecodedV1 {
  readonly admin: string;
  readonly flatFees: PumpSwapFeesDecodedV1;
  readonly feeTiers: readonly PumpSwapFeeTierDecodedV1[];
}

export interface PumpSwapPoolDecodedV1 {
  readonly poolBump: number;
  readonly index: number;
  readonly creator: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly lpMint: string;
  readonly poolBaseTokenAccount: string;
  readonly poolQuoteTokenAccount: string;
  readonly lpSupplyRaw: bigint;
  readonly coinCreator: string;
  readonly isMayhemMode: boolean;
  readonly isCashbackCoin: boolean;
  readonly virtualQuoteReservesRaw: bigint;
}

export interface PumpSwapRawMintDecodedV1 {
  readonly mintAuthorityOption: 0 | 1;
  readonly mintAuthority: string;
  readonly supplyRaw: bigint;
  readonly decimals: number;
  readonly isInitialized: boolean;
  readonly freezeAuthorityOption: 0 | 1;
  readonly freezeAuthority: string;
}

export interface PumpSwapTokenAccountSnapshotV1 {
  readonly address: string;
  readonly exists: boolean;
  readonly ownerProgramId: string | null;
  readonly dataBase64: string | null;
}

export type PumpSwapAccountSnapshotV1 = PumpSwapTokenAccountSnapshotV1;

export interface PumpSwapExactSlotSnapshotV1 {
  readonly slot: bigint;
  readonly globalConfig: Readonly<{
    readonly address: string;
    readonly ownerProgramId: string;
    readonly dataBase64: string;
  }>;
  readonly feeConfig: Readonly<{
    readonly address: string;
    readonly ownerProgramId: string;
    readonly dataBase64: string;
  }>;
  readonly pool: Readonly<{
    readonly address: string;
    readonly ownerProgramId: string;
    readonly dataBase64: string;
  }>;
  readonly baseMint: Readonly<{
    readonly address: string;
    readonly ownerProgramId: string;
    readonly dataBase64: string;
    readonly decoded: PumpSwapRawMintDecodedV1;
  }>;
  readonly quoteMint: Readonly<{
    readonly address: string;
    readonly ownerProgramId: string;
    readonly dataBase64: string;
    readonly decoded: PumpSwapRawMintDecodedV1;
  }>;
  readonly baseVault: PumpSwapTokenAccountSnapshotV1;
  readonly quoteVault: PumpSwapTokenAccountSnapshotV1;
  readonly userBaseTokenAccount: PumpSwapTokenAccountSnapshotV1;
  readonly userQuoteTokenAccount: PumpSwapTokenAccountSnapshotV1;
  readonly userVolumeAccumulator: PumpSwapAccountSnapshotV1;
  readonly userVolumeQuoteTokenAccount: PumpSwapTokenAccountSnapshotV1;
  readonly poolV2: PumpSwapAccountSnapshotV1;
}

export interface PumpSwapBuildRequestV1 {
  readonly quote: PumpSwapBuildQuoteV1;
  readonly user: string;
  readonly poolProof: ExecutionVenuePool;
  readonly snapshot: PumpSwapExactSlotSnapshotV1;
}

interface TokenAccountValue {
  readonly address: PublicKey;
  readonly accountInfo: AccountInfo<Buffer> | null;
  readonly mint: PublicKey | null;
  readonly tokenOwner: PublicKey | null;
  readonly amountRaw: bigint;
  readonly isNative: boolean | null;
}

interface OptionalAccountValue {
  readonly address: PublicKey;
  readonly accountInfo: AccountInfo<Buffer> | null;
}

interface ValidatedPumpSwapBuildRequest {
  readonly quote: PumpSwapBuildQuoteV1;
  readonly user: PublicKey;
  readonly poolProof: ExecutionVenuePool;
  readonly poolKey: PublicKey;
  readonly baseMint: PublicKey;
  readonly quoteMint: PublicKey;
  readonly baseTokenProgram: PublicKey;
  readonly quoteTokenProgram: PublicKey;
  readonly globalConfig: GlobalConfig;
  readonly feeConfig: FeeConfig;
  readonly pool: Pool;
  readonly poolAccountInfo: AccountInfo<Buffer>;
  readonly baseMintAccount: RawMint;
  readonly baseVaultAmount: bigint;
  readonly quoteVaultAmount: bigint;
  readonly userBase: TokenAccountValue;
  readonly userQuote: TokenAccountValue;
  readonly userVolume: OptionalAccountValue;
  readonly userVolumeQuote: OptionalAccountValue;
  readonly poolV2: OptionalAccountValue;
}

export { ExecutionBuildPolicyError as PumpSwapBuildPolicyError };

export async function buildPumpSwapPlan(
  inputValue: PumpSwapBuildRequestV1,
): Promise<UnsignedBuildPlanV1> {
  try {
    const input = validateRequest(inputValue);
    const state: SwapSolanaState = {
      globalConfig: input.globalConfig,
      feeConfig: input.feeConfig,
      poolKey: input.poolKey,
      poolAccountInfo: input.poolAccountInfo,
      pool: input.pool,
      poolBaseAmount: decimalBn(input.baseVaultAmount),
      poolQuoteAmount: decimalBn(input.quoteVaultAmount),
      baseTokenProgram: input.baseTokenProgram,
      quoteTokenProgram: input.quoteTokenProgram,
      baseMint: input.baseMint,
      baseMintAccount: input.baseMintAccount,
      user: input.user,
      userBaseTokenAccount: input.userBase.address,
      userQuoteTokenAccount: input.userQuote.address,
      userBaseAccountInfo: input.userBase.accountInfo,
      userQuoteAccountInfo: input.userQuote.accountInfo,
    };
    const actual = await PUMP_AMM_SDK.sellInstructions(
      state,
      decimalBn(input.quote.amountInRaw),
      decimalBn(input.quote.protectedAmountOutRaw),
    );
    const selections = validateInstructions(actual, input);
    const instructions = Object.freeze(actual.map(normalizeInstruction));
    return Object.freeze({
      payloadVersion: 1,
      venue: 'PUMP_SWAP',
      side: 'SELL',
      feePayer: input.user.toBase58(),
      identity: Object.freeze({
        mint: input.quote.mint,
        quoteMint: input.quote.quoteMint,
        baseTokenProgram: input.quote.baseTokenProgram,
        quoteTokenProgram: input.quote.quoteTokenProgram,
        quoteDecimals: input.quote.quoteDecimals,
        snapshotSlot: input.quote.snapshotSlot,
        quoteFingerprint: input.quote.quoteFingerprint,
        snapshotFingerprint: input.quote.snapshotFingerprint,
      }),
      amounts: Object.freeze({
        amountInRaw: input.quote.amountInRaw,
        expectedAmountOutRaw: input.quote.expectedAmountOutRaw,
        protectedAmountOutRaw: input.quote.protectedAmountOutRaw,
      }),
      expectedAccounts: Object.freeze([
        Object.freeze({ role: 'POOL', address: input.poolKey.toBase58() }),
        Object.freeze({ role: 'POOL_BASE_VAULT', address: input.pool.poolBaseTokenAccount.toBase58() }),
        Object.freeze({ role: 'POOL_QUOTE_VAULT', address: input.pool.poolQuoteTokenAccount.toBase58() }),
        Object.freeze({ role: 'USER_BASE_ATA', address: input.userBase.address.toBase58() }),
        Object.freeze({ role: 'USER_QUOTE_ATA', address: input.userQuote.address.toBase58() }),
        Object.freeze({ role: 'POOL_COIN_CREATOR', address: input.pool.coinCreator.toBase58() }),
        ...(input.pool.isCashbackCoin ? [
          Object.freeze({ role: 'USER_VOLUME_ACCUMULATOR', address: input.userVolume.address.toBase58() }),
          Object.freeze({ role: 'USER_VOLUME_QUOTE_ATA', address: input.userVolumeQuote.address.toBase58() }),
        ] : []),
        ...(!input.pool.coinCreator.equals(PublicKey.default) ? [
          Object.freeze({ role: 'POOL_V2', address: input.poolV2.address.toBase58() }),
        ] : []),
      ]),
      policyEvidence: Object.freeze({
        payloadVersion: 1, venue: 'PUMP_SWAP', snapshotSlot: input.quote.snapshotSlot,
        snapshotFingerprint: input.quote.snapshotFingerprint,
        isMayhemMode: input.pool.isMayhemMode, isCashbackCoin: input.pool.isCashbackCoin,
        poolAddress: input.poolKey.toBase58(),
        coinCreator: input.pool.coinCreator.toBase58(),
        requiresExtend: input.poolAccountInfo.data.length < POOL_ACCOUNT_NEW_SIZE,
        userQuoteAtaExisted: input.userQuote.accountInfo !== null,
        feeSelection: requiredSelection(selections, 0), buybackSelection: requiredSelection(selections, 1),
      }),
      instructions,
    });
  } catch {
    throw policyError();
  }
}

function validateRequest(inputValue: unknown): ValidatedPumpSwapBuildRequest {
  const request = requiredRecord(inputValue, REQUEST_KEYS);
  const quoteRecord = requiredRecord(request.quote, QUOTE_KEYS);
  const proofRecord = requiredRecord(request.poolProof, POOL_PROOF_KEYS);
  const snapshot = requiredRecord(request.snapshot, SNAPSHOT_KEYS);
  if (typeof request.user !== 'string') reject();
  const quote = quoteFrom(quoteRecord);
  const user = publicKey(request.user, false);
  const baseMint = publicKey(quote.mint, false);
  const quoteMint = publicKey(quote.quoteMint, false);
  const baseTokenProgram = tokenProgram(quote.baseTokenProgram);
  const quoteTokenProgram = TOKEN_PROGRAM_ID;
  const poolProof = poolProofFrom(proofRecord, quote, baseMint, quoteMint);
  if (snapshot.slot !== quote.snapshotSlot) reject();

  const globalConfig = globalConfigFrom(snapshot.globalConfig);
  const feeConfig = feeConfigFrom(snapshot.feeConfig);
  const poolValue = poolFrom(snapshot.pool);
  const pool = poolValue.pool;
  const poolKey = poolValue.address;
  const baseMintAccount = mintFrom(snapshot.baseMint, baseMint, baseTokenProgram, null);
  void mintFrom(snapshot.quoteMint, quoteMint, quoteTokenProgram, 9);
  const baseVault = tokenAccountFrom(snapshot.baseVault, baseTokenProgram, true);
  const quoteVault = tokenAccountFrom(snapshot.quoteVault, quoteTokenProgram, true);
  const userBase = tokenAccountFrom(snapshot.userBaseTokenAccount, baseTokenProgram, true);
  const userQuote = tokenAccountFrom(snapshot.userQuoteTokenAccount, quoteTokenProgram, false);
  const userVolume = optionalAccountFrom(snapshot.userVolumeAccumulator);
  const userVolumeQuote = optionalAccountFrom(snapshot.userVolumeQuoteTokenAccount);
  const poolV2 = optionalAccountFrom(snapshot.poolV2);

  validatePoolIdentities({
    quote,
    user,
    poolProof,
    poolKey,
    pool,
    baseMint,
    quoteMint,
    baseTokenProgram,
    quoteTokenProgram,
    baseVault,
    quoteVault,
    userBase,
    userQuote,
    userVolume,
    userVolumeQuote,
    poolV2,
    globalConfig,
  });
  if (userBase.amountRaw < quote.amountInRaw) reject();
  return Object.freeze({
    quote,
    user,
    poolProof,
    poolKey,
    baseMint,
    quoteMint,
    baseTokenProgram,
    quoteTokenProgram,
    globalConfig,
    feeConfig,
    pool,
    poolAccountInfo: poolValue.accountInfo,
    baseMintAccount,
    baseVaultAmount: baseVault.amountRaw,
    quoteVaultAmount: quoteVault.amountRaw,
    userBase,
    userQuote,
    userVolume,
    userVolumeQuote,
    poolV2,
  });
}

function quoteFrom(record: Readonly<Record<string, unknown>>): PumpSwapBuildQuoteV1 {
  if (record.payloadVersion !== 1
    || record.venue !== 'PUMP_SWAP'
    || record.side !== 'SELL'
    || typeof record.mint !== 'string'
    || record.quoteMint !== NATIVE_MINT.toBase58()
    || (record.baseTokenProgram !== 'SPL_TOKEN' && record.baseTokenProgram !== 'TOKEN_2022')
    || record.quoteTokenProgram !== 'SPL_TOKEN'
    || record.quoteDecimals !== 9
    || !positiveU64(record.amountInRaw)
    || !positiveU64(record.expectedAmountOutRaw)
    || !positiveU64(record.protectedAmountOutRaw)
    || record.protectedAmountOutRaw > record.expectedAmountOutRaw
    || !nonNegativeU64(record.snapshotSlot)
    || typeof record.quoteFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/u.test(record.quoteFingerprint)
    || typeof record.snapshotFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/u.test(record.snapshotFingerprint)) reject();
  return Object.freeze({
    payloadVersion: 1,
    venue: 'PUMP_SWAP',
    side: 'SELL',
    mint: record.mint,
    quoteMint: record.quoteMint,
    baseTokenProgram: record.baseTokenProgram,
    quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9,
    amountInRaw: record.amountInRaw,
    expectedAmountOutRaw: record.expectedAmountOutRaw,
    protectedAmountOutRaw: record.protectedAmountOutRaw,
    snapshotSlot: record.snapshotSlot,
    quoteFingerprint: record.quoteFingerprint,
    snapshotFingerprint: record.snapshotFingerprint,
  });
}

function poolProofFrom(
  record: Readonly<Record<string, unknown>>,
  quote: PumpSwapBuildQuoteV1,
  baseMint: PublicKey,
  quoteMint: PublicKey,
): ExecutionVenuePool {
  if (typeof record.migrationId !== 'string'
    || record.migrationId.length > 256
    || Buffer.byteLength(record.migrationId, 'utf8') < 1
    || Buffer.byteLength(record.migrationId, 'utf8') > 256
    || (record.migrationInstruction !== 'MIGRATE' && record.migrationInstruction !== 'MIGRATE_V2')
    || record.migrationConfirmationStatus !== 'finalized'
    || record.poolConfirmationStatus !== 'finalized'
    || record.market !== 'pumpswap'
    || record.programId !== PUMPSWAP_PROGRAM_ID
    || record.poolIndex !== 0
    || record.baseMint !== quote.mint
    || record.quoteMint !== quote.quoteMint
    || record.quoteDecimals !== 9
    || record.baseTokenProgram !== quote.baseTokenProgram
    || record.quoteTokenProgram !== 'SPL_TOKEN'
    || typeof record.creator !== 'string'
    || typeof record.poolAddress !== 'string'
    || typeof record.baseVault !== 'string'
    || typeof record.quoteVault !== 'string'
    || typeof record.lpMint !== 'string'
    || !nonNegativeU64(record.activatedSlot)
    || record.activatedSlot > quote.snapshotSlot
    || !nonNegativeSafeInteger(record.transactionIndex)
    || !nonNegativeSafeInteger(record.instructionIndex)
    || (record.innerInstructionIndex !== null
      && !nonNegativeSafeInteger(record.innerInstructionIndex))) reject();
  const creator = publicKey(record.creator, false);
  if (!creator.equals(pumpPoolAuthorityPda(baseMint))) reject();
  const address = publicKey(record.poolAddress, false);
  if (!address.equals(poolPda(0, creator, baseMint, quoteMint))) reject();
  const result: ExecutionVenuePool = {
    migrationId: record.migrationId,
    migrationInstruction: record.migrationInstruction,
    migrationConfirmationStatus: 'finalized',
    poolAddress: address.toBase58(),
    market: 'pumpswap',
    programId: PUMPSWAP_PROGRAM_ID,
    poolIndex: 0,
    creator: creator.toBase58(),
    baseMint: quote.mint,
    quoteMint: quote.quoteMint,
    quoteDecimals: 9,
    baseTokenProgram: quote.baseTokenProgram,
    quoteTokenProgram: 'SPL_TOKEN',
    baseVault: publicKey(record.baseVault, false).toBase58(),
    quoteVault: publicKey(record.quoteVault, false).toBase58(),
    lpMint: publicKey(record.lpMint, false).toBase58(),
    poolConfirmationStatus: 'finalized',
    activatedSlot: record.activatedSlot,
    transactionIndex: record.transactionIndex,
    instructionIndex: record.instructionIndex,
    innerInstructionIndex: record.innerInstructionIndex,
  };
  return Object.freeze(result);
}

function globalConfigFrom(value: unknown): GlobalConfig {
  const snapshot = requiredRecord(value, GLOBAL_SNAPSHOT_KEYS);
  if (snapshot.address !== GLOBAL_CONFIG_PDA.toBase58()
    || snapshot.ownerProgramId !== PUMPSWAP_PROGRAM_ID
    || typeof snapshot.dataBase64 !== 'string') reject();
  const account = accountInfo(
    new PublicKey(PUMPSWAP_PROGRAM_ID),
    base64Bytes(snapshot.dataBase64, 8, MAX_ACCOUNT_BYTES),
  );
  let decoded: GlobalConfig;
  try {
    decoded = PUMP_AMM_SDK.decodeGlobalConfig(account);
  } catch {
    reject();
  }
  if (!u8(decoded.disableFlags)
    || (decoded.disableFlags & (1 << 4)) !== 0
    || typeof decoded.mayhemModeEnabled !== 'boolean'
    || typeof decoded.boostEnabled !== 'boolean'
    || decoded.protocolFeeRecipients.length !== 8
    || decoded.reservedFeeRecipients.length !== 7
    || decoded.buybackFeeRecipients.length !== 8) reject();
  const all = [
    ...decoded.protocolFeeRecipients,
    decoded.reservedFeeRecipient,
    ...decoded.reservedFeeRecipients,
    ...decoded.buybackFeeRecipients,
  ].map((keyValue) => keyValue.toBase58());
  if (new Set(all).size !== all.length) reject();
  return decoded;
}

function feeConfigFrom(value: unknown): FeeConfig {
  const snapshot = requiredRecord(value, FEE_SNAPSHOT_KEYS);
  if (snapshot.address !== PUMP_AMM_FEE_CONFIG_PDA.toBase58()
    || snapshot.ownerProgramId !== PUMP_FEE_PROGRAM_ID.toBase58()
    || typeof snapshot.dataBase64 !== 'string') reject();
  try {
    const decoded = PUMP_AMM_SDK.decodeFeeConfig(accountInfo(
      PUMP_FEE_PROGRAM_ID,
      base64Bytes(snapshot.dataBase64, 8, MAX_ACCOUNT_BYTES),
    ));
    if (decoded.feeTiers.length === 0 || decoded.feeTiers.length > MAX_TIERS) reject();
    return decoded;
  } catch {
    reject();
  }
}

function poolFrom(value: unknown): Readonly<{
  readonly address: PublicKey;
  readonly pool: Pool;
  readonly accountInfo: AccountInfo<Buffer>;
}> {
  const snapshot = requiredRecord(value, POOL_SNAPSHOT_KEYS);
  if (snapshot.ownerProgramId !== PUMPSWAP_PROGRAM_ID
    || typeof snapshot.dataBase64 !== 'string') reject();
  const address = publicKey(snapshot.address, false);
  const accountInfoValue = accountInfo(
    new PublicKey(PUMPSWAP_PROGRAM_ID),
    base64Bytes(snapshot.dataBase64, 8, MAX_ACCOUNT_BYTES),
  );
  let pool: Pool;
  try {
    pool = PUMP_AMM_SDK.decodePool(accountInfoValue);
  } catch {
    reject();
  }
  if (!u8(pool.poolBump)
    || !u16(pool.index)
    || typeof pool.isMayhemMode !== 'boolean'
    || typeof pool.isCashbackCoin !== 'boolean') reject();
  return Object.freeze({
    address,
    pool,
    accountInfo: accountInfoValue,
  });
}

function mintFrom(
  value: unknown,
  expectedAddress: PublicKey,
  expectedProgram: PublicKey,
  expectedDecimals: number | null,
): RawMint {
  const snapshot = requiredRecord(value, MINT_SNAPSHOT_KEYS);
  const decoded = requiredRecord(snapshot.decoded, RAW_MINT_KEYS);
  if (snapshot.address !== expectedAddress.toBase58()
    || snapshot.ownerProgramId !== expectedProgram.toBase58()
    || (decoded.mintAuthorityOption !== 0 && decoded.mintAuthorityOption !== 1)
    || (decoded.freezeAuthorityOption !== 0 && decoded.freezeAuthorityOption !== 1)
    || !nonNegativeU64(decoded.supplyRaw)
    || !u8(decoded.decimals)
    || (expectedDecimals !== null && decoded.decimals !== expectedDecimals)
    || decoded.isInitialized !== true
    || typeof snapshot.dataBase64 !== 'string') reject();
  const data = base64Bytes(snapshot.dataBase64, MintLayout.span, MAX_ACCOUNT_BYTES);
  let mint: ReturnType<typeof unpackMint>;
  try {
    mint = unpackMint(expectedAddress, accountInfo(expectedProgram, data), expectedProgram);
  } catch {
    reject();
  }
  validateCanonicalMintData(data, expectedProgram, mint, expectedAddress);
  const raw = MintLayout.decode(data.subarray(0, MintLayout.span));
  const mintAuthority = publicKey(decoded.mintAuthority, true);
  const freezeAuthority = publicKey(decoded.freezeAuthority, true);
  const unpackedMintAuthority = mint.mintAuthority ?? PublicKey.default;
  const unpackedFreezeAuthority = mint.freezeAuthority ?? PublicKey.default;
  if (raw.mintAuthorityOption !== decoded.mintAuthorityOption
    || !raw.mintAuthority.equals(mintAuthority)
    || raw.supply !== decoded.supplyRaw
    || raw.decimals !== decoded.decimals
    || raw.isInitialized !== decoded.isInitialized
    || raw.freezeAuthorityOption !== decoded.freezeAuthorityOption
    || !raw.freezeAuthority.equals(freezeAuthority)
    || raw.mintAuthorityOption !== (mint.mintAuthority === null ? 0 : 1)
    || !raw.mintAuthority.equals(unpackedMintAuthority)
    || raw.freezeAuthorityOption !== (mint.freezeAuthority === null ? 0 : 1)
    || !raw.freezeAuthority.equals(unpackedFreezeAuthority)) reject();
  return raw;
}

function validateCanonicalMintData(
  data: Buffer,
  expectedProgram: PublicKey,
  mint: ReturnType<typeof unpackMint>,
  expectedAddress: PublicKey,
): void {
  if (expectedProgram.equals(TOKEN_PROGRAM_ID)) {
    if (data.length !== MintLayout.span) reject();
    return;
  }
  if (data.length === MintLayout.span) return;
  if (data.length <= AccountLayout.span || data[AccountLayout.span] !== AccountType.Mint) reject();
  if (!data.subarray(MintLayout.span, AccountLayout.span).every((byte) => byte === 0)) reject();
  const tlvData = mint.tlvData;
  if (tlvData.length === 0) reject();
  validateCanonicalToken2022Tlv(tlvData, expectedAddress);
  let extensionTypes: readonly number[];
  try {
    extensionTypes = getExtensionTypes(tlvData);
  } catch {
    reject();
  }
  if (extensionTypes.length === 0
    || new Set(extensionTypes).size !== extensionTypes.length
    || extensionTypes.some((extension) => !ALLOWED_TOKEN_2022_MINT_EXTENSIONS.has(extension))) reject();
}

function validateCanonicalToken2022Tlv(tlvData: Buffer, expectedMint: PublicKey): void {
  let offset = 0;
  while (offset < tlvData.length) {
    if (tlvData.length - offset < 4) reject();
    const extension = tlvData.readUInt16LE(offset);
    const extensionLength = tlvData.readUInt16LE(offset + 2);
    const end = offset + 4 + extensionLength;
    if (end > tlvData.length || !ALLOWED_TOKEN_2022_MINT_EXTENSIONS.has(extension)) reject();
    const expectedLength = FIXED_TOKEN_2022_MINT_EXTENSION_LENGTHS.get(extension);
    if (extension !== TOKEN_METADATA_EXTENSION_TYPE
      && extensionLength !== expectedLength) reject();
    if (extension === TOKEN_METADATA_EXTENSION_TYPE) {
      let metadata: ReturnType<typeof unpackTokenMetadata>;
      try {
        metadata = unpackTokenMetadata(tlvData.subarray(offset + 4, end));
      } catch {
        reject();
      }
      if (!metadata.mint.equals(expectedMint)
        || !Buffer.from(packTokenMetadata(metadata)).equals(tlvData.subarray(offset + 4, end))) reject();
    }
    offset = end;
  }
}

function tokenAccountFrom(
  value: unknown,
  expectedProgram: PublicKey,
  mustExist: boolean,
): TokenAccountValue {
  const snapshot = requiredRecord(value, TOKEN_ACCOUNT_KEYS);
  const address = publicKey(snapshot.address, false);
  if (typeof snapshot.exists !== 'boolean') reject();
  if (!snapshot.exists) {
    if (mustExist || snapshot.ownerProgramId !== null || snapshot.dataBase64 !== null) reject();
    return Object.freeze({
      address,
      accountInfo: null,
      mint: null,
      tokenOwner: null,
      amountRaw: 0n,
      isNative: null,
    });
  }
  if (snapshot.ownerProgramId !== expectedProgram.toBase58()
    || typeof snapshot.dataBase64 !== 'string') reject();
  const data = base64Bytes(snapshot.dataBase64, AccountLayout.span, MAX_ACCOUNT_BYTES);
  const raw = AccountLayout.decode(data.subarray(0, AccountLayout.span));
  const nativeOption: unknown = raw.isNativeOption;
  if (raw.state !== AccountState.Initialized
    || raw.delegateOption !== 0
    || raw.closeAuthorityOption !== 0
    || !binaryOption(nativeOption)
    || (nativeOption === 0 && raw.isNative !== 0n)
    || (nativeOption === 1 && raw.isNative === 0n)) reject();
  return Object.freeze({
    address,
    accountInfo: accountInfo(expectedProgram, data),
    mint: raw.mint,
    tokenOwner: raw.owner,
    amountRaw: raw.amount,
    isNative: nativeOption === 1,
  });
}

function optionalAccountFrom(value: unknown): OptionalAccountValue {
  const snapshot = requiredRecord(value, OPTIONAL_ACCOUNT_KEYS);
  const address = publicKey(snapshot.address, false);
  if (typeof snapshot.exists !== 'boolean') reject();
  if (!snapshot.exists) {
    if (snapshot.ownerProgramId !== null || snapshot.dataBase64 !== null) reject();
    return Object.freeze({ address, accountInfo: null });
  }
  const owner = publicKey(snapshot.ownerProgramId, false);
  if (typeof snapshot.dataBase64 !== 'string') reject();
  const data = base64Bytes(snapshot.dataBase64, 1, MAX_ACCOUNT_BYTES);
  return Object.freeze({ address, accountInfo: accountInfo(owner, data) });
}

function validatePoolIdentities(input: Readonly<{
  readonly quote: PumpSwapBuildQuoteV1;
  readonly user: PublicKey;
  readonly poolProof: ExecutionVenuePool;
  readonly poolKey: PublicKey;
  readonly pool: Pool;
  readonly baseMint: PublicKey;
  readonly quoteMint: PublicKey;
  readonly baseTokenProgram: PublicKey;
  readonly quoteTokenProgram: PublicKey;
  readonly baseVault: TokenAccountValue;
  readonly quoteVault: TokenAccountValue;
  readonly userBase: TokenAccountValue;
  readonly userQuote: TokenAccountValue;
  readonly userVolume: OptionalAccountValue;
  readonly userVolumeQuote: OptionalAccountValue;
  readonly poolV2: OptionalAccountValue;
  readonly globalConfig: GlobalConfig;
}>): void {
  const {
    quote, user, poolProof, poolKey, pool, baseMint, quoteMint, baseTokenProgram,
    quoteTokenProgram, baseVault, quoteVault, userBase, userQuote, userVolume,
    userVolumeQuote, poolV2, globalConfig,
  } = input;
  const creator = pumpPoolAuthorityPda(baseMint);
  const expectedPool = poolPda(0, creator, baseMint, quoteMint);
  const expectedPoolBump = PublicKey.findProgramAddressSync([
    Buffer.from('pool'),
    Buffer.from([0, 0]),
    creator.toBuffer(),
    baseMint.toBuffer(),
    quoteMint.toBuffer(),
  ], PUMP_AMM_PROGRAM_ID)[1];
  const expectedBaseVault = getAssociatedTokenAddressSync(
    baseMint, expectedPool, true, baseTokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const expectedQuoteVault = getAssociatedTokenAddressSync(
    quoteMint, expectedPool, true, quoteTokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  if (!poolKey.equals(expectedPool)
    || poolProof.poolAddress !== expectedPool.toBase58()
    || pool.index !== 0
    || pool.poolBump !== expectedPoolBump
    || !pool.creator.equals(creator)
    || !pool.baseMint.equals(baseMint)
    || !pool.quoteMint.equals(quoteMint)
    || !pool.lpMint.equals(lpMintPda(poolKey))
    || poolProof.lpMint !== pool.lpMint.toBase58()
    || !pool.poolBaseTokenAccount.equals(expectedBaseVault)
    || !pool.poolQuoteTokenAccount.equals(expectedQuoteVault)
    || poolProof.baseVault !== expectedBaseVault.toBase58()
    || poolProof.quoteVault !== expectedQuoteVault.toBase58()
    || !baseVault.address.equals(expectedBaseVault)
    || !quoteVault.address.equals(expectedQuoteVault)
    || !baseVault.mint?.equals(baseMint)
    || !quoteVault.mint?.equals(quoteMint)
    || !baseVault.tokenOwner?.equals(poolKey)
    || !quoteVault.tokenOwner?.equals(poolKey)
    || baseVault.isNative !== false
    || quoteVault.isNative !== true
    || !userBase.address.equals(getAssociatedTokenAddressSync(
      baseMint, user, true, baseTokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    || !userBase.mint?.equals(baseMint)
    || !userBase.tokenOwner?.equals(user)
    || userBase.isNative !== false
    || !userQuote.address.equals(getAssociatedTokenAddressSync(
      quoteMint, user, true, quoteTokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))) reject();
  if (userQuote.accountInfo !== null
    && (!userQuote.mint?.equals(quoteMint)
      || !userQuote.tokenOwner?.equals(user)
      || userQuote.isNative !== true)) reject();
  const expectedUserVolume = userVolumeAccumulatorPda(user);
  const expectedUserVolumeQuote = getAssociatedTokenAddressSync(
    quoteMint, expectedUserVolume, true, quoteTokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const expectedPoolV2 = poolV2Pda(baseMint);
  if (!userVolume.address.equals(expectedUserVolume)
    || !userVolumeQuote.address.equals(expectedUserVolumeQuote)
    || !poolV2.address.equals(expectedPoolV2)) reject();
  if (pool.isCashbackCoin) {
    if (!userVolume.accountInfo?.owner.equals(PUMP_AMM_PROGRAM_ID)
      || !userVolumeQuote.accountInfo?.owner.equals(quoteTokenProgram)) reject();
    validateUserVolumeAccumulator(userVolume.accountInfo, user);
    const raw = AccountLayout.decode(userVolumeQuote.accountInfo.data.subarray(0, AccountLayout.span));
    if (!raw.mint.equals(quoteMint)
      || !raw.owner.equals(expectedUserVolume)
      || raw.state !== AccountState.Initialized
      || raw.delegateOption !== 0
      || raw.closeAuthorityOption !== 0
      || raw.isNativeOption !== 1
      || raw.isNative === 0n) reject();
  }
  if (!pool.coinCreator.equals(PublicKey.default)
    && !poolV2.accountInfo?.owner.equals(PUMP_AMM_PROGRAM_ID)) reject();
  if (pool.isMayhemMode && !globalConfig.mayhemModeEnabled) reject();
  if (quote.baseTokenProgram === 'TOKEN_2022'
    && !baseTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) reject();
}

function validateUserVolumeAccumulator(
  accountInfoValue: AccountInfo<Buffer>,
  user: PublicKey,
): void {
  const data = accountInfoValue.data;
  if (data.length !== 90
    || !data.subarray(0, 8).equals(officialAccountDiscriminator('UserVolumeAccumulator'))
    || !data.subarray(8, 40).equals(user.toBuffer())
    || (data[40] !== 0 && data[40] !== 1)
    || (data[73] !== 0 && data[73] !== 1)) reject();
}

function validateInstructions(
  instructions: readonly TransactionInstruction[],
  input: ValidatedPumpSwapBuildRequest,
): readonly BuildRecipientSelectionV1[] {
  const extendExpected = input.poolAccountInfo.data.length < POOL_ACCOUNT_NEW_SIZE;
  const createQuoteExpected = input.userQuote.accountInfo === null;
  const expectedLength = Number(extendExpected) + Number(createQuoteExpected) + 2;
  if (instructions.length !== expectedLength) reject();
  let index = 0;
  if (extendExpected) validateExtend(requiredInstruction(instructions[index++]), input);
  if (createQuoteExpected) validateAta(requiredInstruction(instructions[index++]), input);
  const main = requiredInstruction(instructions[index++]);
  const close = requiredInstruction(instructions[index++]);
  if (index !== instructions.length) reject();
  const selections = validateSell(main, input);
  validateClose(close, input);
  for (const instruction of instructions) {
    for (const meta of instruction.keys) {
      if (meta.isSigner && !meta.pubkey.equals(input.user)) reject();
    }
  }
  return selections;
}

function validateExtend(
  instruction: TransactionInstruction,
  input: ValidatedPumpSwapBuildRequest,
): void {
  if (!instruction.programId.equals(PUMP_AMM_PROGRAM_ID)
    || !instruction.data.equals(officialDiscriminator('extend_account'))
    || !metasEqual(instruction.keys, [
      [input.poolKey, false, true],
      [input.user, true, false],
      [SystemProgram.programId, false, false],
      [PUMP_AMM_EVENT_AUTHORITY_PDA, false, false],
      [PUMP_AMM_PROGRAM_ID, false, false],
    ])) reject();
}

function validateAta(
  instruction: TransactionInstruction,
  input: ValidatedPumpSwapBuildRequest,
): void {
  const expected = createAssociatedTokenAccountIdempotentInstruction(
    input.user,
    input.userQuote.address,
    input.user,
    input.quoteMint,
    input.quoteTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  if (!instructionEqual(instruction, expected)) reject();
}

function validateClose(
  instruction: TransactionInstruction,
  input: ValidatedPumpSwapBuildRequest,
): void {
  const expected = createCloseAccountInstruction(
    input.userQuote.address,
    input.user,
    input.user,
    [],
    TOKEN_PROGRAM_ID,
  );
  if (!instructionEqual(instruction, expected)) reject();
}

function validateSell(
  instruction: TransactionInstruction,
  input: ValidatedPumpSwapBuildRequest,
): readonly BuildRecipientSelectionV1[] {
  const remaining = Number(input.pool.isCashbackCoin) * 2
    + Number(!input.pool.coinCreator.equals(PublicKey.default)) + 2;
  if (!instruction.programId.equals(PUMP_AMM_PROGRAM_ID)
    || instruction.data.length !== 24
    || !instruction.data.subarray(0, 8).equals(officialDiscriminator('sell'))
    || instruction.data.readBigUInt64LE(8) !== input.quote.amountInRaw
    || instruction.data.readBigUInt64LE(16) !== input.quote.protectedAmountOutRaw
    || instruction.keys.length !== 21 + remaining) reject();
  const feeAddress = requiredMeta(instruction, 9).pubkey;
  const buybackAddress = requiredMeta(instruction, instruction.keys.length - 2).pubkey;
  const feeCandidates = input.pool.isMayhemMode
    ? [input.globalConfig.reservedFeeRecipient, ...input.globalConfig.reservedFeeRecipients]
    : input.globalConfig.protocolFeeRecipients;
  const buybackCandidates = input.globalConfig.buybackFeeRecipients;
  const feeIndex = feeCandidates.findIndex((candidate) => candidate.equals(feeAddress));
  const buybackIndex = buybackCandidates.findIndex((candidate) => candidate.equals(buybackAddress));
  if (feeIndex < 0 || buybackIndex < 0) reject();
  const coinCreatorAuthority = coinCreatorVaultAuthorityPda(input.pool.coinCreator);
  const fixed: readonly MetaExpectation[] = [
    [input.poolKey, false, true],
    [input.user, true, true],
    [GLOBAL_CONFIG_PDA, false, false],
    [input.baseMint, false, false],
    [input.quoteMint, false, false],
    [input.userBase.address, false, true],
    [input.userQuote.address, false, true],
    [input.pool.poolBaseTokenAccount, false, true],
    [input.pool.poolQuoteTokenAccount, false, true],
    [feeAddress, false, false],
    [getAssociatedTokenAddressSync(input.quoteMint, feeAddress, true, input.quoteTokenProgram), false, true],
    [input.baseTokenProgram, false, false],
    [input.quoteTokenProgram, false, false],
    [SystemProgram.programId, false, false],
    [ASSOCIATED_TOKEN_PROGRAM_ID, false, false],
    [PUMP_AMM_EVENT_AUTHORITY_PDA, false, false],
    [PUMP_AMM_PROGRAM_ID, false, false],
    [coinCreatorVaultAtaPda(coinCreatorAuthority, input.quoteMint, input.quoteTokenProgram), false, true],
    [coinCreatorAuthority, false, false],
    [PUMP_AMM_FEE_CONFIG_PDA, false, false],
    [PUMP_FEE_PROGRAM_ID, false, false],
  ];
  if (!metasEqual(instruction.keys.slice(0, 21), fixed)) reject();
  const expectedRemaining: MetaExpectation[] = [];
  if (input.pool.isCashbackCoin) {
    expectedRemaining.push(
      [input.userVolumeQuote.address, false, true],
      [input.userVolume.address, false, true],
    );
  }
  if (!input.pool.coinCreator.equals(PublicKey.default)) {
    expectedRemaining.push([input.poolV2.address, false, false]);
  }
  expectedRemaining.push(
    [buybackAddress, false, false],
    [getAssociatedTokenAddressSync(input.quoteMint, buybackAddress, true, input.quoteTokenProgram), false, true],
  );
  if (!metasEqual(instruction.keys.slice(21), expectedRemaining)) reject();
  return Object.freeze([
    sdkSelection(
      'FEE',
      input.pool.isMayhemMode ? 'RESERVED' : 'NORMAL',
      feeCandidates,
      feeIndex,
    ),
    sdkSelection('BUYBACK_FEE', 'BUYBACK', buybackCandidates, buybackIndex),
  ]);
}

function sdkSelection(
  role: 'FEE' | 'BUYBACK_FEE',
  listKind: 'NORMAL' | 'RESERVED' | 'BUYBACK',
  candidateKeys: readonly PublicKey[],
  selectedIndex: number,
): BuildRecipientSelectionV1 {
  const candidates = Object.freeze(candidateKeys.map((candidate) => candidate.toBase58()));
  const selectedAddress = candidates[selectedIndex];
  if (selectedAddress === undefined) reject();
  return Object.freeze({
    role,
    selectionMethod: 'SDK_RANDOM',
    listKind,
    candidates,
    selectedIndex,
    selectedAddress,
  });
}

type MetaExpectation = readonly [PublicKey, boolean, boolean];

function metasEqual(
  actual: readonly TransactionInstruction['keys'][number][],
  expected: readonly MetaExpectation[],
): boolean {
  return actual.length === expected.length && actual.every((meta, index) => {
    const expectedMeta = expected[index];
    return expectedMeta !== undefined
      && meta.pubkey.equals(expectedMeta[0])
      && meta.isSigner === expectedMeta[1]
      && meta.isWritable === expectedMeta[2];
  });
}

function instructionEqual(actual: TransactionInstruction, expected: TransactionInstruction): boolean {
  return actual.programId.equals(expected.programId)
    && actual.data.equals(expected.data)
    && metasEqual(actual.keys, expected.keys.map((meta) => [
      meta.pubkey, meta.isSigner, meta.isWritable,
    ] as const));
}

function officialDiscriminator(name: string): Buffer {
  const instructions = pumpAmmJson.instructions as readonly Readonly<{
    readonly name: string;
    readonly discriminator: readonly number[];
  }>[];
  const definition = instructions.find((instruction) => instruction.name === name);
  if (definition?.discriminator.length !== 8) reject();
  return Buffer.from(definition.discriminator);
}

function officialAccountDiscriminator(name: string): Buffer {
  const accounts = pumpAmmJson.accounts as readonly Readonly<{
    readonly name: string;
    readonly discriminator: readonly number[];
  }>[];
  const definition = accounts.find((account) => account.name === name);
  if (definition?.discriminator.length !== 8) reject();
  return Buffer.from(definition.discriminator);
}

function requiredInstruction(value: TransactionInstruction | undefined): TransactionInstruction {
  if (value === undefined) reject();
  return value;
}

function requiredSelection(
  values: readonly BuildRecipientSelectionV1[],
  index: number,
): BuildRecipientSelectionV1 {
  const value = values.at(index);
  if (value === undefined) reject();
  return value;
}

function requiredMeta(instruction: TransactionInstruction, index: number): AccountMeta {
  const value = instruction.keys[index];
  if (value === undefined) reject();
  return value;
}

function normalizeInstruction(instruction: TransactionInstruction): NormalizedInstructionV1 {
  return Object.freeze({
    programId: instruction.programId.toBase58(),
    accounts: Object.freeze(instruction.keys.map((account) => Object.freeze({
      address: account.pubkey.toBase58(),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    }))),
    dataBase64: instruction.data.toString('base64'),
  });
}

function accountInfo(owner: PublicKey, data: Buffer): AccountInfo<Buffer> {
  return { executable: false, owner, lamports: 0, data, rentEpoch: 0 };
}

function base64Bytes(value: string, minimumBytes: number, maximumBytes: number): Buffer {
  if (value.length > Math.ceil(maximumBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) reject();
  const data = Buffer.from(value, 'base64');
  if (data.length < minimumBytes || data.length > maximumBytes
    || data.toString('base64') !== value) reject();
  return data;
}

function requiredRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)
    || !Object.isFrozen(value)) reject();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) reject();
  const actual = (keys as string[]).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) reject();
  const result: Record<string, unknown> = {};
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) reject();
    result[key] = descriptor.value;
  }
  return result;
}

function publicKey(value: unknown, allowDefault: boolean): PublicKey {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44
    || Buffer.byteLength(value, 'utf8') < 32 || Buffer.byteLength(value, 'utf8') > 44
    || !/^[1-9A-HJ-NP-Za-km-z]+$/u.test(value)) reject();
  const keyValue = new PublicKey(value);
  if (keyValue.toBase58() !== value || (!allowDefault && keyValue.equals(PublicKey.default))) reject();
  return keyValue;
}

function tokenProgram(value: UnsignedBuildTokenProgram): PublicKey {
  return value === 'SPL_TOKEN' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
}

function positiveU64(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n && value <= U64_MAX;
}

function nonNegativeU64(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= U64_MAX;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function u8(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value <= 255;
}

function u16(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value <= 65_535;
}

function binaryOption(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function decimalBn(value: bigint): BN {
  return new BN(value.toString(10), 10);
}

function reject(): never {
  throw policyError();
}

function policyError(): ExecutionBuildPolicyError {
  return new ExecutionBuildPolicyError('PUMP_SWAP');
}

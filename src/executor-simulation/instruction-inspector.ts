import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { PUMP_INSTRUCTIONS } from '../launchpads/pumpfun/generated/pump-idl.js';
import {
  bondingCurvePda,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID as PUMP_FUN_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
} from '../launchpads/pumpfun/official-sdk.js';
import { PUMPSWAP_INSTRUCTIONS } from '../markets/pumpswap/generated/pumpswap-idl.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import {
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  GLOBAL_CONFIG_PDA,
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
  pumpAmmJson,
  poolV2Pda,
  poolPda,
  pumpPoolAuthorityPda,
  userVolumeAccumulatorPda,
} from '../markets/pumpswap/official-sdk.js';
import type {
  BuildRecipientSelectionV1,
  ExpectedBuildAccountV1,
  NormalizedInstructionAccountV1,
  NormalizedInstructionV1,
  UnsignedBuildAmountsV1,
  UnsignedBuildIdentityV1,
  UnsignedBuildPlanV1,
} from './build-plan.js';

const PLAN_KEYS = Object.freeze([
  'payloadVersion', 'venue', 'side', 'feePayer', 'identity', 'amounts',
  'expectedAccounts', 'policyEvidence', 'instructions',
] as const);
const IDENTITY_KEYS = Object.freeze([
  'mint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram', 'quoteDecimals',
  'snapshotSlot', 'quoteFingerprint', 'snapshotFingerprint',
] as const);
const AMOUNTS_KEYS = Object.freeze([
  'amountInRaw', 'expectedAmountOutRaw', 'protectedAmountOutRaw',
] as const);
const EXPECTED_ACCOUNT_KEYS = Object.freeze(['role', 'address'] as const);
const INSTRUCTION_KEYS = Object.freeze(['programId', 'accounts', 'dataBase64'] as const);
const META_KEYS = Object.freeze(['address', 'isSigner', 'isWritable'] as const);
const DETERMINISTIC_SELECTION_KEYS = Object.freeze([
  'role', 'domain', 'listKind', 'candidates', 'selectionHash', 'selectedIndex', 'selectedAddress',
] as const);
const SDK_RANDOM_SELECTION_KEYS = Object.freeze([
  'role', 'selectionMethod', 'listKind', 'candidates', 'selectedIndex', 'selectedAddress',
] as const);
const U64_MAX = (1n << 64n) - 1n;
const MAX_DATA_BYTES = 128;
const FEE_DOMAIN = 'execution-pumpfun-fee-recipient-v1';
const BUYBACK_DOMAIN = 'execution-pumpfun-buyback-recipient-v1';

export class InstructionInspectionError extends Error {
  public readonly code = 'INSTRUCTION_INSPECTION_REJECTED' as const;

  public constructor() {
    super('Unsigned instruction plan rejected.');
    this.name = 'InstructionInspectionError';
  }
}

export interface InspectedBuildPlanV1 {
  readonly venue: 'PUMP_FUN' | 'PUMP_SWAP';
  readonly side: 'BUY' | 'SELL';
  readonly feePayer: string;
  readonly expectedAccounts: readonly ExpectedBuildAccountV1[];
  readonly allowsMissingUserBaseAta: boolean;
  readonly allowsMissingUserQuoteAta: boolean;
  readonly requiresPumpSwapCashback: boolean;
  readonly requiresPumpSwapPoolV2: boolean;
  readonly instructions: readonly NormalizedInstructionV1[];
  readonly identity: UnsignedBuildIdentityV1;
  readonly amounts: UnsignedBuildAmountsV1;
}

type ValidatedPumpFunPolicyEvidenceV1 = Readonly<{
  readonly venue: 'PUMP_FUN';
  readonly snapshotSlot: bigint;
  readonly snapshotFingerprint: string;
  readonly isMayhemMode: boolean;
  readonly curveAddress: string;
  readonly creator: string;
  readonly userBaseAtaExisted: boolean;
  readonly feeSelection: BuildRecipientSelectionV1;
  readonly buybackSelection: BuildRecipientSelectionV1;
}>;

type ValidatedPumpSwapPolicyEvidenceV1 = Readonly<{
  readonly venue: 'PUMP_SWAP';
  readonly snapshotSlot: bigint;
  readonly snapshotFingerprint: string;
  readonly isMayhemMode: boolean;
  readonly poolAddress: string;
  readonly isCashbackCoin: boolean;
  readonly coinCreator: string;
  readonly requiresExtend: boolean;
  readonly userQuoteAtaExisted: boolean;
  readonly feeSelection: BuildRecipientSelectionV1;
  readonly buybackSelection: BuildRecipientSelectionV1;
}>;

type ValidatedPolicyEvidenceV1 =
  | ValidatedPumpFunPolicyEvidenceV1
  | ValidatedPumpSwapPolicyEvidenceV1;

/**
 * Converts a fully validated, frozen build-plan envelope into fresh instruction objects.
 * This boundary intentionally accepts no transaction, signing, RPC, or persistence inputs.
 */
export function inspectUnsignedBuildPlan(inputValue: UnsignedBuildPlanV1): InspectedBuildPlanV1 {
  try {
    const plan = record(inputValue, PLAN_KEYS);
    if (plan.payloadVersion !== 1
      || (plan.venue !== 'PUMP_FUN' && plan.venue !== 'PUMP_SWAP')
      || (plan.side !== 'BUY' && plan.side !== 'SELL')) reject();
    const feePayer = publicKey(plan.feePayer, false);
    const identity = identityFrom(plan.identity);
    const amounts = amountsFrom(plan.amounts);
    const expectedAccounts = expectedAccountsFrom(plan.expectedAccounts);
    const evidence = policyEvidenceFrom(plan.policyEvidence, plan.venue, identity);
    const instructions = normalizedInstructionsFrom(plan.instructions);
    const inspected = evidence.venue === 'PUMP_FUN'
      ? inspectPumpFun(plan.side, feePayer, identity, amounts, expectedAccounts, evidence, instructions)
      : inspectPumpSwap(plan.side, feePayer, identity, amounts, expectedAccounts, evidence, instructions);
    return Object.freeze({
      venue: plan.venue,
      side: plan.side,
      feePayer: feePayer.toBase58(),
      expectedAccounts,
      allowsMissingUserBaseAta: evidence.venue === 'PUMP_FUN' && !evidence.userBaseAtaExisted,
      allowsMissingUserQuoteAta: evidence.venue === 'PUMP_FUN'
        ? true : !evidence.userQuoteAtaExisted,
      requiresPumpSwapCashback: evidence.venue === 'PUMP_SWAP' && evidence.isCashbackCoin,
      requiresPumpSwapPoolV2: evidence.venue === 'PUMP_SWAP' && !new PublicKey(evidence.coinCreator).equals(PublicKey.default),
      instructions: Object.freeze(inspected),
      identity,
      amounts,
    });
  } catch {
    throw new InstructionInspectionError();
  }
}

function inspectPumpFun(
  side: unknown,
  feePayer: PublicKey,
  identity: UnsignedBuildIdentityV1,
  amounts: UnsignedBuildAmountsV1,
  expectedAccounts: readonly ExpectedBuildAccountV1[],
  evidence: ValidatedPumpFunPolicyEvidenceV1,
  instructions: readonly NormalizedInstructionV1[],
): readonly NormalizedInstructionV1[] {
  if ((side !== 'BUY' && side !== 'SELL') || identity.quoteMint !== NATIVE_MINT.toBase58()
    || expectedAccounts.length !== 4
    || expectedAccounts[0]?.role !== 'BONDING_CURVE'
    || expectedAccounts[1]?.role !== 'USER_BASE_ATA'
    || expectedAccounts[2]?.role !== 'CREATOR'
    || expectedAccounts[3]?.role !== 'USER_QUOTE_ATA') reject();
  const mint = publicKey(identity.mint, false);
  const baseProgram = tokenProgram(identity.baseTokenProgram);
  const curve = publicKey(requiredExpectedAccount(expectedAccounts, 0).address, false);
  const userBaseAta = publicKey(requiredExpectedAccount(expectedAccounts, 1).address, false);
  const creator = publicKey(requiredExpectedAccount(expectedAccounts, 2).address, false);
  const userQuoteAta = publicKey(requiredExpectedAccount(expectedAccounts, 3).address, false);
  if (!curve.equals(bondingCurvePda(mint))
    || evidence.curveAddress !== curve.toBase58()
    || evidence.creator !== creator.toBase58()
    || !userBaseAta.equals(associatedTokenAddress(mint, feePayer, baseProgram))
    || !userQuoteAta.equals(associatedTokenAddress(NATIVE_MINT, feePayer, TOKEN_PROGRAM_ID))) reject();
  validatePumpFunSelections(evidence, feePayer);

  if (side === 'SELL' && !evidence.userBaseAtaExisted) reject();
  const requiresAtaSetup = side === 'BUY' && !evidence.userBaseAtaExisted;
  const mainIndex = requiresAtaSetup ? 1 : 0;
  if (instructions.length !== mainIndex + 1) reject();
  if (mainIndex === 1) validateAtaSetup(instructions[0], feePayer, userBaseAta, mint, baseProgram);
  const main = requiredInstruction(instructions[mainIndex]);
  const instructionDefinition = side === 'BUY' ? PUMP_INSTRUCTIONS.buy_v2 : PUMP_INSTRUCTIONS.sell_v2;
  const data = dataFrom(main);
  const expectedAmount = side === 'BUY' ? amounts.protectedAmountOutRaw : amounts.amountInRaw;
  const expectedLimit = side === 'BUY' ? amounts.amountInRaw : amounts.protectedAmountOutRaw;
  if (main.programId !== PUMP_PROGRAM_ID.toBase58()
    || !data.subarray(0, 8).equals(Buffer.from(instructionDefinition.discriminator))
    || data.length !== 24
    || data.readBigUInt64LE(8) !== expectedAmount
    || data.readBigUInt64LE(16) !== expectedLimit
    || main.accounts.length !== instructionDefinition.accounts.length) reject();
  validateIdlRoles(main.accounts, instructionDefinition.accounts);
  const accounts = main.accounts;
  const fee = publicKey(evidence.feeSelection.selectedAddress, false);
  const buyback = publicKey(evidence.buybackSelection.selectedAddress, false);
  if (!sameAddress(accounts[1], mint)
    || !sameAddress(accounts[2], NATIVE_MINT)
    || !sameAddress(accounts[3], baseProgram)
    || !sameAddress(accounts[4], TOKEN_PROGRAM_ID)
    || !sameAddress(accounts[5], ASSOCIATED_TOKEN_PROGRAM_ID)
    || !sameAddress(accounts[6], fee)
    || !sameAddress(accounts[7], associatedTokenAddress(NATIVE_MINT, fee, TOKEN_PROGRAM_ID))
    || !sameAddress(accounts[8], buyback)
    || !sameAddress(accounts[9], associatedTokenAddress(NATIVE_MINT, buyback, TOKEN_PROGRAM_ID))
    || !sameAddress(accounts[10], curve)
    || !sameAddress(accounts[11], associatedTokenAddress(mint, curve, baseProgram))
    || !sameAddress(accounts[12], associatedTokenAddress(NATIVE_MINT, curve, TOKEN_PROGRAM_ID))
    || !sameAddress(accounts[0], GLOBAL_PDA)
    || !sameAddress(accounts[13], feePayer)
    || !sameAddress(accounts[14], userBaseAta)
    || !sameAddress(accounts[15], userQuoteAta)
    || !sameAddress(accounts[16], programPda('creator-vault', creator))
    || !sameAddress(accounts[17], associatedTokenAddress(NATIVE_MINT, programPda('creator-vault', creator), TOKEN_PROGRAM_ID))
    || !sameAddress(accounts[18], programPda('sharing-config', mint, PUMP_FUN_FEE_PROGRAM_ID))
    || (side === 'BUY' && !sameAddress(accounts[19], programPda('global_volume_accumulator')))
    || !sameAddress(accounts[side === 'BUY' ? 20 : 19], programPda('user_volume_accumulator', feePayer))
    || !sameAddress(accounts[side === 'BUY' ? 21 : 20], associatedTokenAddress(NATIVE_MINT, programPda('user_volume_accumulator', feePayer), TOKEN_PROGRAM_ID))
    || !sameAddress(accounts[side === 'BUY' ? 22 : 21], PUMP_FEE_CONFIG_PDA)
    || !sameAddress(accounts[side === 'BUY' ? 23 : 22], PUMP_FUN_FEE_PROGRAM_ID)
    || !sameAddress(accounts[side === 'BUY' ? 24 : 23], SystemProgram.programId)
    || !sameAddress(accounts[side === 'BUY' ? 25 : 24], programPda('__event_authority'))
    || !sameAddress(accounts[side === 'BUY' ? 26 : 25], PUMP_PROGRAM_ID)) reject();
  validateRecipientRoleIsolation(accounts, [6, 7, 8, 9]);
  validateUniqueFeePayerSigner(instructions, feePayer);
  return instructions;
}

function inspectPumpSwap(
  side: unknown,
  feePayer: PublicKey,
  identity: UnsignedBuildIdentityV1,
  amounts: UnsignedBuildAmountsV1,
  expectedAccounts: readonly ExpectedBuildAccountV1[],
  evidence: ValidatedPumpSwapPolicyEvidenceV1,
  instructions: readonly NormalizedInstructionV1[],
): readonly NormalizedInstructionV1[] {
  if (side !== 'SELL' || identity.quoteMint !== NATIVE_MINT.toBase58()
    || expectedAccounts.length < 6 || expectedAccounts.length > 9) reject();
  const expectedRoles = ['POOL', 'POOL_BASE_VAULT', 'POOL_QUOTE_VAULT', 'USER_BASE_ATA', 'USER_QUOTE_ATA', 'POOL_COIN_CREATOR'];
  if (expectedAccounts.slice(0, expectedRoles.length)
    .some((account, index) => account.role !== expectedRoles[index])) reject();
  const mint = publicKey(identity.mint, false);
  const baseProgram = tokenProgram(identity.baseTokenProgram);
  const pool = publicKey(requiredExpectedAccount(expectedAccounts, 0).address, false);
  const baseVault = publicKey(requiredExpectedAccount(expectedAccounts, 1).address, false);
  const quoteVault = publicKey(requiredExpectedAccount(expectedAccounts, 2).address, false);
  const userBaseAta = publicKey(requiredExpectedAccount(expectedAccounts, 3).address, false);
  const userQuoteAta = publicKey(requiredExpectedAccount(expectedAccounts, 4).address, false);
  const coinCreator = publicKey(requiredExpectedAccount(expectedAccounts, 5).address, true);
  if (evidence.poolAddress !== pool.toBase58()
    || evidence.coinCreator !== coinCreator.toBase58()) reject();
  let conditionalIndex = 6;
  const cashbackExpected = expectedAccounts[conditionalIndex]?.role === 'USER_VOLUME_ACCUMULATOR';
  if (cashbackExpected !== evidence.isCashbackCoin) reject();
  const userVolume = userVolumeAccumulatorPda(feePayer);
  const userVolumeQuote = associatedTokenAddress(NATIVE_MINT, userVolume, TOKEN_PROGRAM_ID);
  if (cashbackExpected) {
    const expectedVolume = requiredExpectedAccount(expectedAccounts, conditionalIndex++);
    const expectedQuote = requiredExpectedAccount(expectedAccounts, conditionalIndex++);
    if (expectedQuote.role !== 'USER_VOLUME_QUOTE_ATA'
      || !publicKey(expectedVolume.address, false).equals(userVolume)
      || !publicKey(expectedQuote.address, false).equals(userVolumeQuote)) reject();
  }
  const poolV2Expected = expectedAccounts[conditionalIndex]?.role === 'POOL_V2';
  if (poolV2Expected && !publicKey(
    requiredExpectedAccount(expectedAccounts, conditionalIndex++).address, false,
  ).equals(poolV2Pda(mint))) reject();
  if (conditionalIndex !== expectedAccounts.length
    || poolV2Expected !== !coinCreator.equals(PublicKey.default)) reject();
  if (!userBaseAta.equals(associatedTokenAddress(mint, feePayer, baseProgram))
    || !userQuoteAta.equals(associatedTokenAddress(NATIVE_MINT, feePayer, TOKEN_PROGRAM_ID))
    || !pool.equals(poolPda(0, pumpPoolAuthorityPda(mint), mint, NATIVE_MINT))
    || !baseVault.equals(associatedTokenAddress(mint, pool, baseProgram))
    || !quoteVault.equals(associatedTokenAddress(NATIVE_MINT, pool, TOKEN_PROGRAM_ID))) reject();
  validatePumpSwapSelections(evidence, feePayer);

  const mainIndex = instructions.findIndex((instruction) => instruction.programId === PUMPSWAP_PROGRAM_ID
    && dataHasDiscriminator(instruction, PUMPSWAP_INSTRUCTIONS.sell.discriminator));
  const expectedMainIndex = Number(evidence.requiresExtend) + Number(!evidence.userQuoteAtaExisted);
  if (mainIndex !== expectedMainIndex || instructions.length !== mainIndex + 2) reject();
  let setupIndex = 0;
  if (evidence.requiresExtend) validateExtend(requiredInstruction(instructions[setupIndex++]), feePayer, pool);
  if (!evidence.userQuoteAtaExisted) validateAtaSetup(
    instructions[setupIndex++], feePayer, userQuoteAta, NATIVE_MINT, TOKEN_PROGRAM_ID,
  );
  const main = requiredInstruction(instructions[mainIndex]);
  const close = requiredInstruction(instructions[mainIndex + 1]);
  const data = dataFrom(main);
  if (!data.subarray(0, 8).equals(Buffer.from(PUMPSWAP_INSTRUCTIONS.sell.discriminator))
    || data.length !== 24
    || data.readBigUInt64LE(8) !== amounts.amountInRaw
    || data.readBigUInt64LE(16) !== amounts.protectedAmountOutRaw
    || main.accounts.length < 23 || main.accounts.length > 26) reject();
  validateIdlRoles(main.accounts.slice(0, 21), PUMPSWAP_INSTRUCTIONS.sell.accounts);
  const accounts = main.accounts;
  const fee = publicKey(evidence.feeSelection.selectedAddress, false);
  const buyback = publicKey(evidence.buybackSelection.selectedAddress, false);
  if (!sameAddress(accounts[0], pool)
    || !sameAddress(accounts[1], feePayer)
    || !sameAddress(accounts[2], GLOBAL_CONFIG_PDA)
    || !sameAddress(accounts[3], mint)
    || !sameAddress(accounts[4], NATIVE_MINT)
    || !sameAddress(accounts[5], userBaseAta)
    || !sameAddress(accounts[6], userQuoteAta)
    || !sameAddress(accounts[7], baseVault)
    || !sameAddress(accounts[8], quoteVault)
    || !sameAddress(accounts[9], fee)
    || !sameAddress(accounts[10], associatedTokenAddress(NATIVE_MINT, fee, TOKEN_PROGRAM_ID))
    || !sameAddress(accounts[11], baseProgram)
    || !sameAddress(accounts[12], TOKEN_PROGRAM_ID)
    || !sameAddress(accounts[13], SystemProgram.programId)
    || !sameAddress(accounts[14], ASSOCIATED_TOKEN_PROGRAM_ID)
    || !sameAddress(accounts[15], PUMP_AMM_EVENT_AUTHORITY_PDA)
    || !sameAddress(accounts[16], PUMP_AMM_PROGRAM_ID)
    || !sameAddress(accounts[17], coinCreatorVaultAtaPda(
      coinCreatorVaultAuthorityPda(coinCreator), NATIVE_MINT, TOKEN_PROGRAM_ID,
    ))
    || !sameAddress(accounts[18], coinCreatorVaultAuthorityPda(coinCreator))
    || !sameAddress(accounts[19], PUMP_AMM_FEE_CONFIG_PDA)
    || !sameAddress(accounts[20], PUMP_FEE_PROGRAM_ID)
    || !sameAddress(accounts.at(-2), buyback)
    || !sameAddress(accounts.at(-1), associatedTokenAddress(NATIVE_MINT, buyback, TOKEN_PROGRAM_ID))) reject();
  validateRecipientRoleIsolation(accounts, [9, 10, accounts.length - 2, accounts.length - 1]);
  validatePumpSwapRemainingRoles(
    accounts.slice(21, -2), feePayer, mint, coinCreator, cashbackExpected, poolV2Expected,
  );
  validateClose(close, feePayer, userQuoteAta);
  validateUniqueFeePayerSigner(instructions, feePayer);
  return instructions;
}

function identityFrom(value: unknown): UnsignedBuildIdentityV1 {
  const input = record(value, IDENTITY_KEYS);
  if (typeof input.mint !== 'string' || input.quoteMint !== NATIVE_MINT.toBase58()
    || (input.baseTokenProgram !== 'SPL_TOKEN' && input.baseTokenProgram !== 'TOKEN_2022')
    || input.quoteTokenProgram !== 'SPL_TOKEN' || input.quoteDecimals !== 9
    || !u64(input.snapshotSlot) || typeof input.quoteFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/u.test(input.quoteFingerprint)
    || typeof input.snapshotFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/u.test(input.snapshotFingerprint)) reject();
  const mint = publicKey(input.mint, false);
  return Object.freeze({
    mint: mint.toBase58(), quoteMint: NATIVE_MINT.toBase58(),
    baseTokenProgram: input.baseTokenProgram, quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    snapshotSlot: input.snapshotSlot, quoteFingerprint: input.quoteFingerprint,
    snapshotFingerprint: input.snapshotFingerprint,
  });
}

function amountsFrom(value: unknown): UnsignedBuildAmountsV1 {
  const input = record(value, AMOUNTS_KEYS);
  if (!positiveU64(input.amountInRaw) || !positiveU64(input.expectedAmountOutRaw)
    || !positiveU64(input.protectedAmountOutRaw)
    || input.protectedAmountOutRaw > input.expectedAmountOutRaw) reject();
  return Object.freeze({
    amountInRaw: input.amountInRaw,
    expectedAmountOutRaw: input.expectedAmountOutRaw,
    protectedAmountOutRaw: input.protectedAmountOutRaw,
  });
}

function expectedAccountsFrom(value: unknown): readonly ExpectedBuildAccountV1[] {
  return frozenArray(value, 2, 9).map((candidate) => {
    const account = record(candidate, EXPECTED_ACCOUNT_KEYS);
    if (typeof account.role !== 'string' || typeof account.address !== 'string') reject();
    return Object.freeze({
      role: account.role,
      address: publicKey(account.address, account.role === 'POOL_COIN_CREATOR').toBase58(),
    });
  });
}

function policyEvidenceFrom(
  value: unknown,
  venue: unknown,
  identity: UnsignedBuildIdentityV1,
): ValidatedPolicyEvidenceV1 {
  const shared = ['venue', 'snapshotSlot', 'snapshotFingerprint', 'isMayhemMode',
    'payloadVersion', 'feeSelection', 'buybackSelection'];
  const input = record(value, venue === 'PUMP_FUN'
    ? [...shared, 'curveAddress', 'creator', 'userBaseAtaExisted']
    : [...shared, 'poolAddress', 'isCashbackCoin', 'coinCreator', 'requiresExtend', 'userQuoteAtaExisted']);
  if (input.payloadVersion !== 1 || input.venue !== venue || input.snapshotSlot !== identity.snapshotSlot
    || input.snapshotFingerprint !== identity.snapshotFingerprint
    || typeof input.isMayhemMode !== 'boolean') reject();
  const selections = recipientSelectionsFrom(
    Object.freeze([input.feeSelection, input.buybackSelection]), venue, identity.quoteFingerprint,
  );
  if (selections[0]?.role !== 'FEE' || selections[1]?.role !== 'BUYBACK_FEE') reject();
  const feeSelection = requiredSelection(selections, 'FEE');
  const buybackSelection = requiredSelection(selections, 'BUYBACK_FEE');
  if (venue === 'PUMP_FUN') {
    if (typeof input.userBaseAtaExisted !== 'boolean' || typeof input.curveAddress !== 'string'
      || typeof input.creator !== 'string') reject();
    return Object.freeze({
      venue: 'PUMP_FUN', snapshotSlot: input.snapshotSlot,
      snapshotFingerprint: input.snapshotFingerprint,
      isMayhemMode: input.isMayhemMode,
      curveAddress: publicKey(input.curveAddress, false).toBase58(),
      creator: publicKey(input.creator, false).toBase58(),
      userBaseAtaExisted: input.userBaseAtaExisted,
      feeSelection, buybackSelection,
    });
  }
  if (venue !== 'PUMP_SWAP' || typeof input.isCashbackCoin !== 'boolean'
    || typeof input.coinCreator !== 'string' || typeof input.poolAddress !== 'string'
    || typeof input.requiresExtend !== 'boolean' || typeof input.userQuoteAtaExisted !== 'boolean') reject();
  return Object.freeze({
    venue: 'PUMP_SWAP', snapshotSlot: input.snapshotSlot,
    snapshotFingerprint: input.snapshotFingerprint,
    isMayhemMode: input.isMayhemMode,
    poolAddress: publicKey(input.poolAddress, false).toBase58(),
    isCashbackCoin: input.isCashbackCoin,
    coinCreator: publicKey(input.coinCreator, true).toBase58(),
    requiresExtend: input.requiresExtend,
    userQuoteAtaExisted: input.userQuoteAtaExisted,
    feeSelection, buybackSelection,
  });
}

function requiredExpectedAccount(
  accounts: readonly ExpectedBuildAccountV1[],
  index: number,
): ExpectedBuildAccountV1 {
  const account = accounts[index];
  if (account === undefined) reject();
  return account;
}

function recipientSelectionsFrom(
  value: unknown,
  venue: unknown,
  fingerprint: string,
): readonly BuildRecipientSelectionV1[] {
  const values = frozenArray(value, 2, 2);
  const seen = new Set<string>();
  return Object.freeze(values.map((candidate): BuildRecipientSelectionV1 => {
    const candidateObject = objectDescriptor(candidate);
    if (candidateObject === null) reject();
    const selection = record(candidate, Object.hasOwn(candidateObject, 'selectionMethod')
      ? SDK_RANDOM_SELECTION_KEYS : DETERMINISTIC_SELECTION_KEYS);
    const role = selection.role;
    if ((role !== 'FEE' && role !== 'BUYBACK_FEE') || seen.has(role)
      || (selection.listKind !== 'NORMAL' && selection.listKind !== 'RESERVED' && selection.listKind !== 'BUYBACK')) reject();
    seen.add(role);
    if (typeof selection.selectedIndex !== 'number' || !Number.isSafeInteger(selection.selectedIndex)) reject();
    const selectedIndex = selection.selectedIndex;
    const candidates = frozenArray(selection.candidates, 8, 8).map((address) => publicKey(address, false).toBase58());
    if (new Set(candidates).size !== candidates.length
      || selectedIndex < 0 || selectedIndex >= candidates.length
      || typeof selection.selectedAddress !== 'string'
      || candidates[selectedIndex] !== publicKey(selection.selectedAddress, false).toBase58()) reject();
    const selectedAddress = candidates[selectedIndex];
    if ('selectionMethod' in selection) {
      if (venue !== 'PUMP_SWAP' || selection.selectionMethod !== 'SDK_RANDOM') reject();
      return Object.freeze({ role, selectionMethod: 'SDK_RANDOM' as const, listKind: selection.listKind, candidates: Object.freeze(candidates), selectedIndex, selectedAddress });
    }
    if (venue !== 'PUMP_FUN' || typeof selection.domain !== 'string'
      || typeof selection.selectionHash !== 'string' || !/^[0-9a-f]{64}$/u.test(selection.selectionHash)) reject();
    const expectedHash = createHash('sha256')
      .update(lengthPrefixedUtf8([selection.domain, fingerprint]))
      .digest('hex');
    if (selection.selectionHash !== expectedHash
      || selectedIndex !== Number(BigInt(`0x${expectedHash}`) % BigInt(candidates.length))) reject();
    return Object.freeze({ role, domain: selection.domain, listKind: selection.listKind, candidates: Object.freeze(candidates), selectionHash: selection.selectionHash, selectedIndex, selectedAddress });
  }));
}

function normalizedInstructionsFrom(value: unknown): readonly NormalizedInstructionV1[] {
  return frozenArray(value, 1, 4).map((candidate) => {
    const instruction = record(candidate, INSTRUCTION_KEYS);
    if (typeof instruction.programId !== 'string' || typeof instruction.dataBase64 !== 'string') reject();
    const accounts = frozenArray(instruction.accounts, 1, 32).map((meta) => {
      const item = record(meta, META_KEYS);
      if (typeof item.address !== 'string' || typeof item.isSigner !== 'boolean' || typeof item.isWritable !== 'boolean') reject();
      return Object.freeze({ address: publicKey(item.address, true).toBase58(), isSigner: item.isSigner, isWritable: item.isWritable });
    });
    const programId = publicKey(instruction.programId, false).toBase58();
    const data = base64Bytes(instruction.dataBase64);
    return Object.freeze({ programId, accounts: Object.freeze(accounts), dataBase64: data.toString('base64') });
  });
}

function validatePumpFunSelections(
  evidence: ValidatedPumpFunPolicyEvidenceV1,
  feePayer: PublicKey,
): void {
  const fee = evidence.feeSelection;
  const buyback = evidence.buybackSelection;
  if (!('domain' in fee) || !('domain' in buyback)
    || fee.listKind !== (evidence.isMayhemMode ? 'RESERVED' : 'NORMAL')
    || buyback.listKind !== 'BUYBACK'
    || fee.domain !== FEE_DOMAIN || buyback.domain !== BUYBACK_DOMAIN) reject();
  validateRecipientCandidateIsolation(fee, buyback, feePayer);
}

function validatePumpSwapSelections(
  evidence: ValidatedPumpSwapPolicyEvidenceV1,
  feePayer: PublicKey,
): void {
  const fee = evidence.feeSelection;
  const buyback = evidence.buybackSelection;
  if (!('selectionMethod' in fee) || !('selectionMethod' in buyback)
    || fee.listKind !== (evidence.isMayhemMode ? 'RESERVED' : 'NORMAL')
    || buyback.listKind !== 'BUYBACK') reject();
  validateRecipientCandidateIsolation(fee, buyback, feePayer);
}

function validateRecipientCandidateIsolation(
  fee: BuildRecipientSelectionV1,
  buyback: BuildRecipientSelectionV1,
  feePayer: PublicKey,
): void {
  const candidates = [...fee.candidates, ...buyback.candidates];
  if (new Set(candidates).size !== candidates.length
    || candidates.includes(feePayer.toBase58())) reject();
}

function validateRecipientRoleIsolation(
  accounts: readonly NormalizedInstructionAccountV1[],
  roleIndices: readonly number[],
): void {
  const indices = new Set(roleIndices);
  const roleAddresses = roleIndices.map((index) => {
    const account = accounts[index];
    if (account === undefined) reject();
    return account.address;
  });
  const addresses = new Set(roleAddresses);
  if (addresses.size !== roleAddresses.length
    || accounts.some((account, index) => !indices.has(index) && addresses.has(account.address))) reject();
}

function requiredSelection(selections: readonly BuildRecipientSelectionV1[], role: 'FEE' | 'BUYBACK_FEE'): BuildRecipientSelectionV1 {
  const selection = selections.find((candidate) => candidate.role === role);
  if (selection === undefined) reject();
  return selection;
}

function validateAtaSetup(instruction: NormalizedInstructionV1 | undefined, payer: PublicKey, ata: PublicKey, mint: PublicKey, program: PublicKey): void {
  if (instruction?.programId !== ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
    || !dataFrom(instruction).equals(Buffer.from([1])) || instruction.accounts.length !== 6) reject();
  const expected: readonly [PublicKey, boolean, boolean][] = [
    [payer, true, true], [ata, false, true], [payer, false, false], [mint, false, false],
    [SystemProgram.programId, false, false], [program, false, false],
  ];
  validateMetas(instruction.accounts, expected);
}

function validateExtend(instruction: NormalizedInstructionV1, payer: PublicKey, pool: PublicKey): void {
  if (instruction.programId !== PUMPSWAP_PROGRAM_ID
    || !dataFrom(instruction).equals(officialPumpSwapDiscriminator('extend_account'))) reject();
  validateMetas(instruction.accounts, [
    [pool, false, true], [payer, true, false], [SystemProgram.programId, false, false],
    [PUMP_AMM_EVENT_AUTHORITY_PDA, false, false], [PUMP_AMM_PROGRAM_ID, false, false],
  ]);
}

function validateClose(instruction: NormalizedInstructionV1, payer: PublicKey, wsolAta: PublicKey): void {
  if (instruction.programId !== TOKEN_PROGRAM_ID.toBase58() || !dataFrom(instruction).equals(Buffer.from([9]))) reject();
  validateMetas(instruction.accounts, [[wsolAta, false, true], [payer, false, true], [payer, true, false]]);
}

function validatePumpSwapRemainingRoles(
  metas: readonly NormalizedInstructionAccountV1[],
  feePayer: PublicKey,
  mint: PublicKey,
  coinCreator: PublicKey,
  cashbackExpected: boolean,
  poolV2Expected: boolean,
): void {
  const userVolume = userVolumeAccumulatorPda(feePayer);
  const userVolumeQuote = associatedTokenAddress(NATIVE_MINT, userVolume, TOKEN_PROGRAM_ID);
  const poolV2 = poolV2Pda(mint);
  const hasCashback = metas.length >= 2 && sameAddress(metas[0], userVolumeQuote)
    && sameAddress(metas[1], userVolume);
  const hasPoolV2 = metas.at(-1) !== undefined && sameAddress(metas.at(-1), poolV2);
  const expectedLength = Number(cashbackExpected) * 2 + Number(poolV2Expected);
  if (hasCashback !== cashbackExpected || hasPoolV2 !== poolV2Expected
    || metas.length !== expectedLength || (hasCashback && (metas[0]?.isSigner || !metas[0]?.isWritable
    || metas[1]?.isSigner || !metas[1]?.isWritable))
    || (hasPoolV2 && (metas.at(-1)?.isSigner || metas.at(-1)?.isWritable))
    || (!coinCreator.equals(PublicKey.default) && !hasPoolV2)) reject();
}

function validateUniqueFeePayerSigner(instructions: readonly NormalizedInstructionV1[], feePayer: PublicKey): void {
  const signers = instructions.flatMap((instruction) => instruction.accounts.filter((meta) => meta.isSigner));
  if (signers.length === 0 || signers.some((meta) => meta.address !== feePayer.toBase58())) reject();
}

function validateIdlRoles(
  actual: readonly NormalizedInstructionAccountV1[],
  definitions: readonly object[],
): void {
  if (actual.length !== definitions.length || actual.some((meta, index) => {
    const definition = definitions[index];
    if (definition === undefined) return true;
    return meta.isSigner !== (Object.hasOwn(definition, 'signer') && (definition as { readonly signer?: unknown }).signer === true)
      || meta.isWritable !== (Object.hasOwn(definition, 'writable') && (definition as { readonly writable?: unknown }).writable === true);
  })) reject();
}

function validateMetas(actual: readonly NormalizedInstructionAccountV1[], expected: readonly [PublicKey, boolean, boolean][]): void {
  if (actual.length !== expected.length || actual.some((meta, index) => {
    const item = expected.at(index);
    if (item === undefined) return true;
    return meta.address !== item[0].toBase58() || meta.isSigner !== item[1] || meta.isWritable !== item[2];
  })) reject();
}

function dataHasDiscriminator(instruction: NormalizedInstructionV1, discriminator: readonly number[]): boolean {
  try { return dataFrom(instruction).subarray(0, 8).equals(Buffer.from(discriminator)); } catch { return false; }
}

function officialPumpSwapDiscriminator(name: string): Buffer {
  const instructions = pumpAmmJson.instructions as readonly Readonly<{
    readonly name: string;
    readonly discriminator: readonly number[];
  }>[];
  const definition = instructions.find((instruction) => instruction.name === name);
  if (definition?.discriminator.length !== 8) reject();
  return Buffer.from(definition.discriminator);
}

function dataFrom(instruction: NormalizedInstructionV1): Buffer {
  return base64Bytes(instruction.dataBase64);
}

function associatedTokenAddress(mint: PublicKey, owner: PublicKey, program: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, program, ASSOCIATED_TOKEN_PROGRAM_ID);
}

function programPda(seed: string, key?: PublicKey, program: PublicKey = PUMP_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    key === undefined ? [Buffer.from(seed, 'utf8')] : [Buffer.from(seed, 'utf8'), key.toBuffer()],
    program,
  )[0];
}

function tokenProgram(value: UnsignedBuildIdentityV1['baseTokenProgram']): PublicKey {
  return value === 'SPL_TOKEN' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
}

function sameAddress(meta: NormalizedInstructionAccountV1 | undefined, key: PublicKey): boolean {
  return meta?.address === key.toBase58();
}

function record(value: unknown, expectedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  const descriptor = objectDescriptor(value);
  if (descriptor === null || !Object.isFrozen(descriptor)) reject();
  const keys = Reflect.ownKeys(descriptor);
  if (keys.some((key) => typeof key !== 'string')) reject();
  const actual = (keys as string[]).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) reject();
  const result: Record<string, unknown> = {};
  for (const key of actual) {
    const property = Object.getOwnPropertyDescriptor(descriptor, key);
    if (property === undefined || !property.enumerable || !('value' in property)) reject();
    result[key] = property.value;
  }
  return result;
}

function objectDescriptor(value: unknown): object | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : null;
}

function frozenArray(value: unknown, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || isProxy(value) || !Object.isFrozen(value)
    || Object.getPrototypeOf(value) !== Array.prototype) reject();
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < minimum || length > maximum) reject();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys.some((key) => typeof key === 'symbol')) reject();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) reject();
    result.push(descriptor.value);
  }
  return result;
}

function publicKey(value: unknown, allowDefault: boolean): PublicKey {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44
    || Buffer.byteLength(value, 'utf8') < 32 || Buffer.byteLength(value, 'utf8') > 44
    || !/^[1-9A-HJ-NP-Za-km-z]+$/u.test(value)) reject();
  const key = new PublicKey(value);
  if (key.toBase58() !== value || (!allowDefault && key.equals(PublicKey.default))) reject();
  return key;
}

function base64Bytes(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_DATA_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) reject();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_DATA_BYTES || bytes.toString('base64') !== value) reject();
  return bytes;
}

function u64(value: unknown): value is bigint { return typeof value === 'bigint' && value >= 0n && value <= U64_MAX; }
function positiveU64(value: unknown): value is bigint { return u64(value) && value > 0n; }
function requiredInstruction(value: NormalizedInstructionV1 | undefined): NormalizedInstructionV1 { if (value === undefined) reject(); return value; }
function lengthPrefixedUtf8(values: readonly string[]): Buffer { return Buffer.concat(values.flatMap((value) => { const bytes = Buffer.from(value, 'utf8'); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return [length, bytes]; })); }
function reject(): never { throw new InstructionInspectionError(); }

import { createHash, createPublicKey, verify } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createSignedTransactionArtifact,
  type SignedTransactionArtifactV1,
} from '../domain/execution-live.js';
import { assertExecutionIntent } from '../domain/execution-intent.js';
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
  coinCreatorVaultAuthorityPda,
  GLOBAL_CONFIG_PDA,
  poolPda,
  poolV2Pda,
  pumpPoolAuthorityPda,
  pumpAmmJson,
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  userVolumeAccumulatorPda,
} from '../markets/pumpswap/official-sdk.js';
import type { ClaimedExecutionIntent } from '../ports/execution-intent-repository.js';
import type { ExecutionSimulationEvidenceV1 } from
  '../ports/execution-simulation-gateway.js';
import type { SignedSimulationGatewayInputV1 } from './signed-simulation-gateway.js';

export type SignedSimulationRecoveryContextV1 = Omit<
  SignedSimulationGatewayInputV1,
  'persisted' | 'snapshotSlot'
> & Readonly<{
  /** Persisted causal floor passed to RPC as minContextSlot; not the economic snapshot slot. */
  readonly snapshotSlot: bigint;
}>;

export interface SignedSimulationRecoveryContextInputV1 {
  readonly payloadVersion: 1;
  readonly claim: ClaimedExecutionIntent;
  readonly artifact: SignedTransactionArtifactV1;
  readonly unsignedSimulation: ExecutionSimulationEvidenceV1;
}

export class SignedSimulationContextError extends Error {
  public readonly code = 'SIGNED_SIMULATION_CONTEXT_INVALID' as const;

  public constructor() {
    super('Signed simulation recovery context is invalid.');
    this.name = 'SignedSimulationContextError';
  }
}

const INPUT_KEYS = Object.freeze([
  'payloadVersion', 'claim', 'artifact', 'unsignedSimulation',
] as const);
const SPKI_ED25519_PUBLIC_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const UNSIGNED_SIMULATION_KEYS = Object.freeze([
  'outcome', 'snapshotFingerprint', 'buildFingerprint', 'messageHash', 'blockhash',
  'lastValidBlockHeight', 'blockhashContextSlot', 'feeContextSlot',
  'estimatedFeeLamports', 'simulationSlot', 'simulatedFeePayerLamportDebit',
  'unitsConsumed', 'simulatedBaseDeltaRaw', 'simulatedQuoteDeltaRaw',
  'logsFingerprint', 'logsLineCount',
] as const);

/**
 * Recovers only the signed-simulation inputs that are already committed to the
 * durable intent, artifact and exact signed message. The blockhash context slot
 * is the persisted lower bound chosen for the recovery RPC minContextSlot.
 * Fresh preparation already validates dynamic recipient selection and creator
 * policy before wallet signature. Recovery intentionally does not re-allowlist
 * those dynamic addresses: it verifies the signature, every derivable account
 * relation and effective message privilege, then supplies the persisted proof
 * needed to re-simulate these exact signed bytes at that causal floor. It does
 * not reconstruct the original quote or policy snapshot.
 */
export function createSignedSimulationRecoveryContext(
  inputValue: SignedSimulationRecoveryContextInputV1,
): SignedSimulationRecoveryContextV1 {
  try {
    const input = recoveryInput(inputValue);
    const transaction = signedTransaction(input.artifact);
    const intent = input.claim.intent;
    const amountInRaw = intent.side === 'BUY'
      ? requiredPositive(intent.quoteAmountRaw) : requiredPositive(intent.baseAmountRaw);
    const protectedAmountOutRaw = requiredPositive(intent.minimumAmountOutRaw);
    const accountAddresses = tradeAccounts(
      transaction,
      input.artifact,
      intent.mint,
      intent.quoteMint,
      amountInRaw,
      protectedAmountOutRaw,
    );
    validateUnsignedSimulation(
      input.unsignedSimulation,
      input.artifact,
      amountInRaw,
      protectedAmountOutRaw,
    );
    return Object.freeze({
      payloadVersion: 1,
      snapshotSlot: input.unsignedSimulation.blockhashContextSlot,
      accountAddresses,
      amountInRaw,
      protectedAmountOutRaw,
      unsignedSimulation: input.unsignedSimulation,
    });
  } catch (error) {
    if (error instanceof SignedSimulationContextError) throw error;
    throw new SignedSimulationContextError();
  }
}

function recoveryInput(
  value: unknown,
): SignedSimulationRecoveryContextInputV1 {
  const record = exactFrozenRecord(value, INPUT_KEYS);
  if (record.payloadVersion !== 1
    || !frozenPlainObject(record.claim)
    || !frozenPlainObject(record.artifact)
    || !frozenPlainObject(record.unsignedSimulation)) invalid();
  const input = value as SignedSimulationRecoveryContextInputV1;
  assertExecutionIntent(input.claim.intent);
  if (input.claim.intent.status !== 'SIGNED_NOT_SUBMITTED'
    || typeof input.claim.leaseOwner !== 'string' || input.claim.leaseOwner.length < 1
    || typeof input.claim.leaseToken !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(input.claim.leaseToken)
    || !Number.isSafeInteger(input.claim.leaseExpiresAtMs)
    || input.claim.leaseExpiresAtMs < 0) invalid();
  const artifact = recreateArtifact(input.artifact);
  if (artifact.artifactId !== input.artifact.artifactId
    || artifact.signedTransactionHash !== input.artifact.signedTransactionHash
    || artifact.intentId !== input.claim.intent.id
    || artifact.attemptNumber !== input.claim.intent.attemptCount
    || artifact.side !== input.claim.intent.side
    || artifact.snapshotFingerprint !== input.unsignedSimulation.snapshotFingerprint
    || artifact.providerId.length < 1
    || input.claim.intent.quoteMint !== NATIVE_MINT.toBase58()
    || input.claim.intent.quoteTokenProgram !== 'SPL_TOKEN'
    || input.claim.intent.quoteDecimals !== 9) invalid();
  return Object.freeze({ ...input, artifact });
}

function signedTransaction(artifact: SignedTransactionArtifactV1): VersionedTransaction {
  const bytes = Uint8Array.from(artifact.signedTransactionBytes);
  if (bytes.length < 1 || bytes.length > 1_232
    || sha256(bytes) !== artifact.signedTransactionHash) invalid();
  const transaction = VersionedTransaction.deserialize(bytes);
  const messageBytes = transaction.message.serialize();
  const signature = transaction.signatures[0];
  if (!Buffer.from(transaction.serialize()).equals(bytes)
    || transaction.version !== 0
    || transaction.signatures.length !== 1
    || transaction.message.header.numRequiredSignatures !== 1
    || transaction.message.addressTableLookups.length !== 0
    || transaction.message.staticAccountKeys[0]?.toBase58() !== artifact.walletPublicKey
    || transaction.message.recentBlockhash !== artifact.blockhash
    || sha256(messageBytes) !== artifact.messageHash
    || signature?.length !== 64
    || bs58.encode(signature) !== artifact.signature) invalid();
  const wallet = canonicalPublicKey(artifact.walletPublicKey);
  const verificationKey = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PUBLIC_PREFIX, wallet.toBytes()]),
    format: 'der', type: 'spki',
  });
  if (!verify(null, messageBytes, verificationKey, signature)) invalid();
  return transaction;
}

function tradeAccounts(
  transaction: VersionedTransaction,
  artifact: SignedTransactionArtifactV1,
  mintValue: string,
  quoteMintValue: string,
  amountInRaw: bigint,
  protectedAmountOutRaw: bigint,
): readonly [string, string, string] {
  const keys = transaction.message.staticAccountKeys.map((key) => key.toBase58());
  const instructions = transaction.message.compiledInstructions.map((instruction) => {
    const program = effectiveAccountMeta(transaction, instruction.programIdIndex, keys);
    if (program.isSigner || program.isWritable) invalid();
    const accounts = [...instruction.accountKeyIndexes].map((index) => {
      return effectiveAccountMeta(transaction, index, keys);
    });
    return Object.freeze({
      programId: program.address,
      data: Buffer.from(instruction.data),
      accounts: Object.freeze(accounts),
    });
  });
  const candidate = envelopeTrade(instructions, artifact);
  const definition = candidate.kind === 'PUMP_FUN'
    ? artifact.side === 'BUY' ? PUMP_INSTRUCTIONS.buy_v2 : PUMP_INSTRUCTIONS.sell_v2
    : PUMPSWAP_INSTRUCTIONS.sell;
  if (candidate.instruction.programId !== (candidate.kind === 'PUMP_FUN'
    ? PUMP_PROGRAM_ID.toBase58() : PUMPSWAP_PROGRAM_ID)
    || !startsWithDiscriminator(candidate.instruction.data, definition.discriminator)
    || candidate.instruction.data.length !== 24) invalid();
  const accounts = candidate.instruction.accounts;
  for (const account of accounts) {
    canonicalPublicKey(account.address);
  }
  const layout = candidate.kind === 'PUMP_FUN'
    ? Object.freeze({
      mint: 1, quoteMint: 2, baseProgram: 3, quoteProgram: 4,
      wallet: 13, baseAta: 14, quoteAta: 15,
      minimumAccounts: artifact.side === 'BUY' ? 27 : 26,
      maximumAccounts: artifact.side === 'BUY' ? 27 : 26,
    })
    : Object.freeze({
      mint: 3, quoteMint: 4, baseProgram: 11, quoteProgram: 12,
      wallet: 1, baseAta: 5, quoteAta: 6,
      minimumAccounts: 23, maximumAccounts: 26,
    });
  if (accounts.length < layout.minimumAccounts || accounts.length > layout.maximumAccounts
    || candidate.instruction.data.readBigUInt64LE(8) !== (artifact.side === 'BUY'
      ? protectedAmountOutRaw : amountInRaw)
    || candidate.instruction.data.readBigUInt64LE(16) !== (artifact.side === 'BUY'
      ? amountInRaw : protectedAmountOutRaw)
    || accounts[layout.mint]?.address !== mintValue
    || accounts[layout.quoteMint]?.address !== quoteMintValue
    || accounts[layout.wallet]?.address !== artifact.walletPublicKey
    || accounts[layout.quoteMint]?.address !== NATIVE_MINT.toBase58()
    || accounts[layout.quoteProgram]?.address !== TOKEN_PROGRAM_ID.toBase58()) invalid();
  const baseProgramAddress = accounts[layout.baseProgram]?.address;
  const baseProgram = baseProgramAddress === TOKEN_PROGRAM_ID.toBase58()
    ? TOKEN_PROGRAM_ID
    : baseProgramAddress === TOKEN_2022_PROGRAM_ID.toBase58()
      ? TOKEN_2022_PROGRAM_ID : null;
  if (baseProgram === null) invalid();
  const wallet = canonicalPublicKey(artifact.walletPublicKey);
  const mint = canonicalPublicKey(mintValue);
  const expectedBase = getAssociatedTokenAddressSync(
    mint, wallet, false, baseProgram,
  ).toBase58();
  const expectedQuote = getAssociatedTokenAddressSync(
    NATIVE_MINT, wallet, false, TOKEN_PROGRAM_ID,
  ).toBase58();
  if (accounts[layout.baseAta]?.address !== expectedBase
    || accounts[layout.quoteAta]?.address !== expectedQuote) invalid();
  validateTradeAccounts(candidate, wallet, mint, baseProgram);
  const tradeExpectation = tradeInstructionExpectation(candidate, definition.accounts);
  const expectedEnvelope = validateEnvelope(
    instructions,
    candidate,
    tradeExpectation,
    wallet,
    mint,
    baseProgram,
    canonicalPublicKey(expectedBase),
    canonicalPublicKey(expectedQuote),
  );
  validateEffectivePrivileges(instructions, expectedEnvelope);
  return Object.freeze([artifact.walletPublicKey, expectedBase, expectedQuote]);
}

interface SignedAccountMetaV1 {
  readonly address: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

interface SignedInstructionV1 {
  readonly programId: string;
  readonly data: Buffer;
  readonly accounts: readonly SignedAccountMetaV1[];
}

interface ExpectedInstructionPrivilegesV1 {
  readonly accounts: readonly SignedAccountMetaV1[];
}

interface EnvelopeTradeV1 {
  readonly kind: 'PUMP_FUN' | 'PUMP_SWAP';
  readonly index: number;
  readonly instruction: SignedInstructionV1;
}

function envelopeTrade(
  instructions: readonly SignedInstructionV1[],
  artifact: SignedTransactionArtifactV1,
): EnvelopeTradeV1 {
  let index: number;
  if (artifact.effectiveVenue === 'PUMP_FUN' && artifact.side === 'BUY'
    && (instructions.length === 1 || instructions.length === 2)) {
    index = instructions.length - 1;
  } else if (artifact.effectiveVenue === 'PUMP_FUN' && artifact.side === 'SELL'
    && instructions.length === 1) {
    index = 0;
  } else if (artifact.effectiveVenue === 'PUMP_SWAP' && artifact.side === 'SELL'
    && instructions.length >= 2 && instructions.length <= 4) {
    index = instructions.length - 2;
  } else {
    invalid();
  }
  const instruction = instructions[index];
  if (instruction === undefined) invalid();
  return Object.freeze({
    kind: artifact.effectiveVenue,
    index,
    instruction,
  });
}

function effectiveAccountMeta(
  transaction: VersionedTransaction,
  index: number,
  keys: readonly string[],
): SignedAccountMetaV1 {
  const address = keys[index];
  if (address === undefined) invalid();
  const header = transaction.message.header;
  const signerCount = header.numRequiredSignatures;
  const writableSignerCount = signerCount - header.numReadonlySignedAccounts;
  const writableUnsignedLimit = keys.length - header.numReadonlyUnsignedAccounts;
  if (signerCount < 1 || writableSignerCount < 1 || writableUnsignedLimit < signerCount) invalid();
  const isSigner = index < signerCount;
  const isWritable = isSigner ? index < writableSignerCount : index < writableUnsignedLimit;
  return Object.freeze({ address, isSigner, isWritable });
}

function idlInstructionExpectation(
  actual: SignedInstructionV1,
  definitions: readonly object[],
): ExpectedInstructionPrivilegesV1 {
  if (actual.accounts.length !== definitions.length) invalid();
  return Object.freeze({
    accounts: Object.freeze(actual.accounts.map((meta, index) => {
      const definition = definitions[index];
      if (definition === undefined) invalid();
      return Object.freeze({
        address: meta.address,
        isSigner: Object.hasOwn(definition, 'signer')
          && (definition as { readonly signer?: unknown }).signer === true,
        isWritable: Object.hasOwn(definition, 'writable')
          && (definition as { readonly writable?: unknown }).writable === true,
      });
    })),
  });
}

function tradeInstructionExpectation(
  trade: EnvelopeTradeV1,
  definitions: readonly object[],
): ExpectedInstructionPrivilegesV1 {
  if (trade.kind === 'PUMP_FUN') {
    return idlInstructionExpectation(trade.instruction, definitions);
  }
  const accounts = trade.instruction.accounts;
  const fixed = idlInstructionExpectation(Object.freeze({
    ...trade.instruction,
    accounts: Object.freeze(accounts.slice(0, definitions.length)),
  }), definitions);
  const buybackIndex = accounts.length - 2;
  const remainingCount = buybackIndex - definitions.length;
  const remaining = remainingCount === 3
    ? [expectedMeta(accounts[21]?.address ?? '', false, true),
      expectedMeta(accounts[22]?.address ?? '', false, true),
      expectedMeta(accounts[23]?.address ?? '', false, false)]
    : remainingCount === 2
      ? [expectedMeta(accounts[21]?.address ?? '', false, true),
        expectedMeta(accounts[22]?.address ?? '', false, true)]
      : remainingCount === 1
        ? [expectedMeta(accounts[21]?.address ?? '', false, false)]
        : remainingCount === 0 ? [] : invalid();
  const buyback = accounts[buybackIndex];
  const buybackAta = accounts[buybackIndex + 1];
  if (buyback === undefined || buybackAta === undefined) invalid();
  return Object.freeze({
    accounts: Object.freeze([
      ...fixed.accounts,
      ...remaining,
      expectedMeta(buyback.address, false, false),
      expectedMeta(buybackAta.address, false, true),
    ]),
  });
}

function validateTradeAccounts(
  trade: EnvelopeTradeV1,
  wallet: PublicKey,
  mint: PublicKey,
  baseProgram: PublicKey,
): void {
  if (trade.kind === 'PUMP_FUN') {
    validatePumpFunTradeAccounts(trade, wallet, mint, baseProgram);
  } else {
    validatePumpSwapTradeAccounts(trade, wallet, mint, baseProgram);
  }
}

function validatePumpFunTradeAccounts(
  trade: EnvelopeTradeV1,
  wallet: PublicKey,
  mint: PublicKey,
  baseProgram: PublicKey,
): void {
  const accounts = trade.instruction.accounts;
  const fee = accountKey(accounts, 6, false);
  const buyback = accountKey(accounts, 8, false);
  const curve = bondingCurvePda(mint);
  const creatorVault = accountKey(accounts, 16, false);
  const volumeIndex = trade.instruction.accounts.length === 27 ? 20 : 19;
  if (!sameAddress(accounts[0], GLOBAL_PDA)
    || !sameAddress(accounts[5], ASSOCIATED_TOKEN_PROGRAM_ID)
    || !sameAddress(accounts[7], associatedTokenAddress(NATIVE_MINT, fee, TOKEN_PROGRAM_ID))
    || !sameAddress(accounts[9], associatedTokenAddress(NATIVE_MINT, buyback, TOKEN_PROGRAM_ID))
    || !sameAddress(accounts[10], curve)
    || !sameAddress(accounts[11], associatedTokenAddress(mint, curve, baseProgram))
    || !sameAddress(accounts[12], associatedTokenAddress(NATIVE_MINT, curve, TOKEN_PROGRAM_ID))
    // The creator seed is not persisted; recovery can still bind its opaque vault to its WSOL ATA.
    || !sameAddress(accounts[17], associatedTokenAddress(
      NATIVE_MINT, creatorVault, TOKEN_PROGRAM_ID,
    ))
    || !sameAddress(accounts[18], programPda(
      'sharing-config', mint, PUMP_FUN_FEE_PROGRAM_ID,
    ))
    || (accounts.length === 27 && !sameAddress(accounts[19], programPda(
      'global_volume_accumulator', undefined, PUMP_PROGRAM_ID,
    )))
    || !sameAddress(accounts[volumeIndex], programPda(
      'user_volume_accumulator', wallet, PUMP_PROGRAM_ID,
    ))
    || !sameAddress(accounts[volumeIndex + 1], associatedTokenAddress(
      NATIVE_MINT,
      programPda('user_volume_accumulator', wallet, PUMP_PROGRAM_ID),
      TOKEN_PROGRAM_ID,
    ))
    || !sameAddress(accounts[volumeIndex + 2], PUMP_FEE_CONFIG_PDA)
    || !sameAddress(accounts[volumeIndex + 3], PUMP_FUN_FEE_PROGRAM_ID)
    || !sameAddress(accounts[volumeIndex + 4], SystemProgram.programId)
    || !sameAddress(accounts[volumeIndex + 5], programPda(
      '__event_authority', undefined, PUMP_PROGRAM_ID,
    ))
    || !sameAddress(accounts[volumeIndex + 6], PUMP_PROGRAM_ID)) invalid();
  validateRecipientRoleIsolation(accounts, [6, 7, 8, 9]);
}

function validatePumpSwapTradeAccounts(
  trade: EnvelopeTradeV1,
  wallet: PublicKey,
  mint: PublicKey,
  baseProgram: PublicKey,
): void {
  const accounts = trade.instruction.accounts;
  const pool = poolPda(0, pumpPoolAuthorityPda(mint), mint, NATIVE_MINT);
  const fee = accountKey(accounts, 9, false);
  const creatorVaultAuthority = accountKey(accounts, 18, false);
  const buybackIndex = accounts.length - 2;
  const buyback = accountKey(accounts, buybackIndex, false);
  if (!sameAddress(accounts[0], pool)
    || !sameAddress(accounts[2], GLOBAL_CONFIG_PDA)
    || !sameAddress(accounts[7], associatedTokenAddress(mint, pool, baseProgram))
    || !sameAddress(accounts[8], associatedTokenAddress(NATIVE_MINT, pool, TOKEN_PROGRAM_ID))
    || !sameAddress(accounts[10], associatedTokenAddress(NATIVE_MINT, fee, TOKEN_PROGRAM_ID))
    || !sameAddress(accounts[13], SystemProgram.programId)
    || !sameAddress(accounts[14], ASSOCIATED_TOKEN_PROGRAM_ID)
    || !sameAddress(accounts[15], PUMP_AMM_EVENT_AUTHORITY_PDA)
    || !sameAddress(accounts[16], PUMP_AMM_PROGRAM_ID)
    // The creator seed is not persisted; bind the opaque authority to its WSOL vault ATA.
    || !sameAddress(accounts[17], associatedTokenAddress(
      NATIVE_MINT, creatorVaultAuthority, TOKEN_PROGRAM_ID,
    ))
    || !sameAddress(accounts[19], PUMP_AMM_FEE_CONFIG_PDA)
    || !sameAddress(accounts[20], PUMP_FEE_PROGRAM_ID)
    || !sameAddress(accounts[buybackIndex + 1], associatedTokenAddress(
      NATIVE_MINT, buyback, TOKEN_PROGRAM_ID,
    ))) invalid();
  validateRecipientRoleIsolation(accounts, [9, 10, buybackIndex, buybackIndex + 1]);
  validatePumpSwapRemainingRoles(
    accounts.slice(21, buybackIndex), wallet, mint, creatorVaultAuthority,
  );
}

function validatePumpSwapRemainingRoles(
  accounts: readonly SignedAccountMetaV1[],
  wallet: PublicKey,
  mint: PublicKey,
  creatorVaultAuthority: PublicKey,
): void {
  let index = 0;
  const userVolume = userVolumeAccumulatorPda(wallet);
  const userVolumeQuote = associatedTokenAddress(NATIVE_MINT, userVolume, TOKEN_PROGRAM_ID);
  const hasCashback = sameAddress(accounts[0], userVolumeQuote)
    && sameAddress(accounts[1], userVolume);
  if (hasCashback) index += 2;
  const requiresPoolV2 = !creatorVaultAuthority.equals(
    coinCreatorVaultAuthorityPda(PublicKey.default),
  );
  if (requiresPoolV2) {
    if (!sameAddress(accounts[index], poolV2Pda(mint))) invalid();
    index += 1;
  }
  if (index !== accounts.length) invalid();
}

function accountKey(
  accounts: readonly SignedAccountMetaV1[],
  index: number,
  allowDefault: boolean,
): PublicKey {
  const account = accounts[index];
  if (account === undefined) invalid();
  const key = canonicalPublicKey(account.address);
  if (!allowDefault && key.equals(PublicKey.default)) invalid();
  return key;
}

function sameAddress(account: SignedAccountMetaV1 | undefined, key: PublicKey): boolean {
  return account?.address === key.toBase58();
}

function associatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  program: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(
    mint, owner, true, program, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

function programPda(seed: string, key: PublicKey | undefined, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    key === undefined
      ? [Buffer.from(seed, 'utf8')]
      : [Buffer.from(seed, 'utf8'), key.toBuffer()],
    program,
  )[0];
}

function validateEnvelope(
  instructions: readonly SignedInstructionV1[],
  trade: EnvelopeTradeV1,
  tradeExpectation: ExpectedInstructionPrivilegesV1,
  wallet: PublicKey,
  mint: PublicKey,
  baseProgram: PublicKey,
  baseAta: PublicKey,
  quoteAta: PublicKey,
): readonly ExpectedInstructionPrivilegesV1[] {
  if (trade.kind === 'PUMP_FUN') {
    if (trade.index === 1) {
      const setup = validateOfficialInstruction(instructions[0],
        createAssociatedTokenAccountIdempotentInstruction(
          wallet, baseAta, wallet, mint, baseProgram,
        ));
      return Object.freeze([setup, tradeExpectation]);
    }
    return Object.freeze([tradeExpectation]);
  }
  const close = instructions[trade.index + 1];
  const closeExpectation = validateOfficialInstruction(close, createCloseAccountInstruction(
    quoteAta, wallet, wallet, [], TOKEN_PROGRAM_ID,
  ));
  const setup = instructions.slice(0, trade.index);
  const expectations: ExpectedInstructionPrivilegesV1[] = [];
  if (setup.length === 2) {
    expectations.push(validatePumpSwapExtend(setup[0], trade, wallet));
    expectations.push(validateOfficialInstruction(
      setup[1], createAssociatedTokenAccountIdempotentInstruction(
      wallet, quoteAta, wallet, NATIVE_MINT, TOKEN_PROGRAM_ID,
      ),
    ));
  } else if (setup.length === 1) {
    if (matchesPumpSwapExtend(setup[0], trade, wallet)) {
      expectations.push(pumpSwapExtendExpectation(trade, wallet));
    } else {
      expectations.push(validateOfficialInstruction(
        setup[0], createAssociatedTokenAccountIdempotentInstruction(
          wallet, quoteAta, wallet, NATIVE_MINT, TOKEN_PROGRAM_ID,
        ),
      ));
    }
  }
  expectations.push(tradeExpectation, closeExpectation);
  return Object.freeze(expectations);
}

function validateOfficialInstruction(
  actual: SignedInstructionV1 | undefined,
  expected: TransactionInstruction,
): ExpectedInstructionPrivilegesV1 {
  if (actual?.programId !== expected.programId.toBase58()
    || !actual.data.equals(expected.data)
    || actual.accounts.length !== expected.keys.length
    || actual.accounts.some((account, index) =>
      account.address !== expected.keys[index]?.pubkey.toBase58())) {
    invalid();
  }
  return Object.freeze({
    accounts: Object.freeze(expected.keys.map((meta) => Object.freeze({
      address: meta.pubkey.toBase58(),
      isSigner: meta.isSigner,
      isWritable: meta.isWritable,
    }))),
  });
}

function validatePumpSwapExtend(
  actual: SignedInstructionV1 | undefined,
  trade: EnvelopeTradeV1,
  wallet: PublicKey,
): ExpectedInstructionPrivilegesV1 {
  if (!matchesPumpSwapExtend(actual, trade, wallet)) invalid();
  return pumpSwapExtendExpectation(trade, wallet);
}

function matchesPumpSwapExtend(
  actual: SignedInstructionV1 | undefined,
  trade: EnvelopeTradeV1,
  wallet: PublicKey,
): boolean {
  const pool = trade.instruction.accounts[0]?.address;
  return actual !== undefined && pool !== undefined
    && actual.programId === PUMPSWAP_PROGRAM_ID
    && actual.data.equals(officialPumpSwapDiscriminator('extend_account'))
    && arraysEqual(actual.accounts.map((account) => account.address), [
      pool,
      wallet.toBase58(),
      SystemProgram.programId.toBase58(),
      PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58(),
      PUMP_AMM_PROGRAM_ID.toBase58(),
    ]);
}

function pumpSwapExtendExpectation(
  trade: EnvelopeTradeV1,
  wallet: PublicKey,
): ExpectedInstructionPrivilegesV1 {
  const pool = trade.instruction.accounts[0]?.address;
  if (pool === undefined) invalid();
  return Object.freeze({
    accounts: Object.freeze([
      expectedMeta(pool, false, true),
      expectedMeta(wallet.toBase58(), true, false),
      expectedMeta(SystemProgram.programId.toBase58(), false, false),
      expectedMeta(PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58(), false, false),
      expectedMeta(PUMP_AMM_PROGRAM_ID.toBase58(), false, false),
    ]),
  });
}

function expectedMeta(
  address: string,
  isSigner: boolean,
  isWritable: boolean,
): SignedAccountMetaV1 {
  return Object.freeze({ address, isSigner, isWritable });
}

function validateEffectivePrivileges(
  actual: readonly SignedInstructionV1[],
  expected: readonly ExpectedInstructionPrivilegesV1[],
): void {
  if (actual.length !== expected.length) invalid();
  const union = new Map<string, Readonly<{ isSigner: boolean; isWritable: boolean }>>();
  for (const instruction of expected) {
    for (const account of instruction.accounts) {
      const previous = union.get(account.address);
      union.set(account.address, Object.freeze({
        isSigner: account.isSigner || previous?.isSigner === true,
        isWritable: account.isWritable || previous?.isWritable === true,
      }));
    }
  }
  for (const instruction of actual) {
    for (const account of instruction.accounts) {
      const privilege = union.get(account.address);
      if (account.isSigner !== privilege?.isSigner
        || account.isWritable !== privilege.isWritable) invalid();
    }
  }
}

function validateRecipientRoleIsolation(
  accounts: readonly SignedAccountMetaV1[],
  roleIndices: readonly number[],
): void {
  const indices = new Set(roleIndices);
  const roleAddresses = roleIndices.map((index) => {
    const account = accounts[index];
    if (account === undefined) invalid();
    return account.address;
  });
  const addresses = new Set(roleAddresses);
  if (addresses.size !== roleAddresses.length
    || accounts.some((account, index) =>
      !indices.has(index) && addresses.has(account.address))) invalid();
}

function arraysEqual(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function officialPumpSwapDiscriminator(name: 'extend_account'): Buffer {
  const instructions = pumpAmmJson.instructions as readonly Readonly<{
    readonly name: string;
    readonly discriminator: readonly number[];
  }>[];
  const definition = instructions.find((instruction) => instruction.name === name);
  if (definition?.discriminator.length !== 8) invalid();
  return Buffer.from(definition.discriminator);
}

function validateUnsignedSimulation(
  evidence: ExecutionSimulationEvidenceV1,
  artifact: SignedTransactionArtifactV1,
  amountInRaw: bigint,
  protectedAmountOutRaw: bigint,
): void {
  const record = exactFrozenRecord(evidence, UNSIGNED_SIMULATION_KEYS);
  if (record.outcome !== 'SUCCESS'
    || evidence.snapshotFingerprint !== artifact.snapshotFingerprint
    || evidence.buildFingerprint !== artifact.buildFingerprint
    || evidence.messageHash !== artifact.messageHash
    || evidence.blockhash !== artifact.blockhash
    || evidence.lastValidBlockHeight !== artifact.lastValidBlockHeight
    || !u64(evidence.blockhashContextSlot)
    || !u64(evidence.feeContextSlot)
    || !u64(evidence.estimatedFeeLamports)
    || !u64(evidence.simulationSlot)
    || evidence.simulationSlot < evidence.blockhashContextSlot
    || !positiveU64(evidence.unitsConsumed)
    || !u64(evidence.simulatedFeePayerLamportDebit)
    || !i64(evidence.simulatedBaseDeltaRaw)
    || !i64(evidence.simulatedQuoteDeltaRaw)
    || typeof evidence.logsFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/u.test(evidence.logsFingerprint)
    || typeof evidence.logsLineCount !== 'number'
    || !Number.isSafeInteger(evidence.logsLineCount)
    || evidence.logsLineCount < 0
    || evidence.logsLineCount > 256) invalid();
  if (artifact.side === 'BUY') {
    if (evidence.simulatedBaseDeltaRaw < protectedAmountOutRaw
      || evidence.simulatedQuoteDeltaRaw >= 0n
      || evidence.simulatedQuoteDeltaRaw < -amountInRaw) invalid();
  } else if (evidence.simulatedBaseDeltaRaw !== -amountInRaw
    || evidence.simulatedQuoteDeltaRaw < protectedAmountOutRaw) invalid();
}

function recreateArtifact(value: SignedTransactionArtifactV1): SignedTransactionArtifactV1 {
  return createSignedTransactionArtifact({
    payloadVersion: value.payloadVersion,
    specificationVersion: value.specificationVersion,
    intentId: value.intentId,
    attemptNumber: value.attemptNumber,
    generationId: value.generationId,
    armamentId: value.armamentId,
    reservationId: value.reservationId,
    exitAuthorizationId: value.exitAuthorizationId,
    providerId: value.providerId,
    walletPublicKey: value.walletPublicKey,
    side: value.side,
    effectiveVenue: value.effectiveVenue,
    messageHash: value.messageHash,
    buildFingerprint: value.buildFingerprint,
    snapshotFingerprint: value.snapshotFingerprint,
    quoteFingerprint: value.quoteFingerprint,
    quoteObservedAtMs: value.quoteObservedAtMs,
    quoteExpiresAtMs: value.quoteExpiresAtMs,
    blockhash: value.blockhash,
    lastValidBlockHeight: value.lastValidBlockHeight,
    signature: value.signature,
    signedTransactionBytes: Uint8Array.from(value.signedTransactionBytes),
    signedAtMs: value.signedAtMs,
  });
}

function exactFrozenRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!frozenPlainObject(value)) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string')
    || keys.some((key) => !actual.includes(key))) invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) invalid();
  }
  return value;
}

function frozenPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && !isProxy(value) && Object.isFrozen(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function startsWithDiscriminator(
  data: Buffer,
  discriminator: readonly number[],
): boolean {
  return data.length >= discriminator.length
    && data.subarray(0, discriminator.length).equals(Buffer.from(discriminator));
}

function canonicalPublicKey(value: string): PublicKey {
  const key = new PublicKey(value);
  if (key.toBase58() !== value) invalid();
  return key;
}

function requiredPositive(value: bigint | null): bigint {
  if (!positiveU64(value)) invalid();
  return value;
}

function u64(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= U64_MAX;
}

function positiveU64(value: unknown): value is bigint {
  return u64(value) && value > 0n;
}

function i64(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= I64_MIN && value <= I64_MAX;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalid(): never {
  throw new SignedSimulationContextError();
}

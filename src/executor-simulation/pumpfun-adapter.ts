import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import {
  DEFAULT_PUBLIC_KEY,
  PUMP_PROGRAM_ID,
} from '../launchpads/pumpfun/constants.js';
import {
  bondingCurvePda,
  PUMP_SDK,
} from '../launchpads/pumpfun/official-sdk.js';
import {
  ExecutionBuildPolicyError,
  type BuildRecipientSelectionV1,
  type NormalizedInstructionV1,
  type UnsignedBuildPlanV1,
  type UnsignedBuildTokenProgram,
} from './build-plan.js';

const REQUEST_KEYS = Object.freeze([
  'quote', 'user', 'curve', 'userBaseTokenAccount', 'recipients',
] as const);
const QUOTE_KEYS = Object.freeze([
  'payloadVersion', 'venue', 'side', 'mint', 'quoteMint', 'baseTokenProgram',
  'quoteTokenProgram', 'quoteDecimals', 'amountInRaw', 'expectedAmountOutRaw',
  'protectedAmountOutRaw', 'snapshotSlot', 'quoteFingerprint',
] as const);
const CURVE_KEYS = Object.freeze([
  'mint', 'address', 'ownerProgramId', 'exists', 'complete', 'creator',
  'isMayhemMode',
] as const);
const USER_ATA_KEYS = Object.freeze(['address', 'exists'] as const);
const RECIPIENT_KEYS = Object.freeze([
  'feeRecipient', 'feeRecipients', 'reservedFeeRecipient',
  'reservedFeeRecipients', 'buybackFeeRecipients',
] as const);
const FEE_DOMAIN = 'execution-pumpfun-fee-recipient-v1';
const BUYBACK_DOMAIN = 'execution-pumpfun-buyback-recipient-v1';
const BUY_DISCRIMINATOR = 'b817ee6167c5d33d';
const SELL_DISCRIMINATOR = '5df6823ce7e940b2';
const U64_MAX = (1n << 64n) - 1n;

export interface PumpFunBuildQuoteV1 {
  readonly payloadVersion: 1;
  readonly venue: 'PUMP_FUN';
  readonly side: 'BUY' | 'SELL';
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
}

export interface PumpFunCurveBuildEvidenceV1 {
  readonly mint: string;
  readonly address: string;
  readonly ownerProgramId: string;
  readonly exists: true;
  readonly complete: false;
  readonly creator: string;
  readonly isMayhemMode: boolean;
}

export interface PumpFunUserBaseTokenAccountEvidenceV1 {
  readonly address: string;
  readonly exists: boolean;
}

export interface PumpFunRecipientEvidenceV1 {
  readonly feeRecipient: string;
  readonly feeRecipients: readonly string[];
  readonly reservedFeeRecipient: string;
  readonly reservedFeeRecipients: readonly string[];
  readonly buybackFeeRecipients: readonly string[];
}

export interface PumpFunBuildRequestV1 {
  readonly quote: PumpFunBuildQuoteV1;
  readonly user: string;
  readonly curve: PumpFunCurveBuildEvidenceV1;
  readonly userBaseTokenAccount: PumpFunUserBaseTokenAccountEvidenceV1;
  readonly recipients: PumpFunRecipientEvidenceV1;
}

interface ValidatedPumpFunBuildRequest {
  readonly quote: PumpFunBuildQuoteV1;
  readonly user: PublicKey;
  readonly mint: PublicKey;
  readonly creator: PublicKey;
  readonly curve: PublicKey;
  readonly userBaseAta: PublicKey;
  readonly userBaseAtaExists: boolean;
  readonly baseTokenProgram: PublicKey;
  readonly feeSelection: BuildRecipientSelectionV1;
  readonly buybackSelection: BuildRecipientSelectionV1;
}

export { ExecutionBuildPolicyError as PumpFunBuildPolicyError };

export async function buildPumpFunPlan(
  inputValue: PumpFunBuildRequestV1,
): Promise<UnsignedBuildPlanV1> {
  try {
    const input = validateRequest(inputValue);
    const quote = input.quote;
    const instruction = quote.side === 'BUY'
      ? await PUMP_SDK.getBuyV2InstructionRaw({
        user: input.user,
        mint: input.mint,
        creator: input.creator,
        amount: decimalBn(quote.protectedAmountOutRaw),
        quoteAmount: decimalBn(quote.amountInRaw),
        feeRecipient: new PublicKey(input.feeSelection.selectedAddress),
        buybackFeeRecipient: new PublicKey(input.buybackSelection.selectedAddress),
        tokenProgram: input.baseTokenProgram,
        quoteMint: NATIVE_MINT,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      })
      : await PUMP_SDK.getSellV2InstructionRaw({
        user: input.user,
        mint: input.mint,
        creator: input.creator,
        amount: decimalBn(quote.amountInRaw),
        quoteAmount: decimalBn(quote.protectedAmountOutRaw),
        feeRecipient: new PublicKey(input.feeSelection.selectedAddress),
        buybackFeeRecipient: new PublicKey(input.buybackSelection.selectedAddress),
        tokenProgram: input.baseTokenProgram,
        quoteMint: NATIVE_MINT,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      });
    validateRawInstruction(instruction, input);
    const instructions: NormalizedInstructionV1[] = [];
    if (quote.side === 'BUY' && !input.userBaseAtaExists) {
      instructions.push(normalizeInstruction(
        createAssociatedTokenAccountIdempotentInstruction(
          input.user,
          input.userBaseAta,
          input.user,
          input.mint,
          input.baseTokenProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      ));
    }
    instructions.push(normalizeInstruction(instruction));
    return Object.freeze({
      payloadVersion: 1,
      venue: 'PUMP_FUN',
      side: quote.side,
      feePayer: input.user.toBase58(),
      identity: Object.freeze({
        mint: quote.mint,
        quoteMint: quote.quoteMint,
        baseTokenProgram: quote.baseTokenProgram,
        quoteTokenProgram: quote.quoteTokenProgram,
        quoteDecimals: quote.quoteDecimals,
        snapshotSlot: quote.snapshotSlot,
        quoteFingerprint: quote.quoteFingerprint,
      }),
      amounts: Object.freeze({
        amountInRaw: quote.amountInRaw,
        expectedAmountOutRaw: quote.expectedAmountOutRaw,
        protectedAmountOutRaw: quote.protectedAmountOutRaw,
      }),
      expectedAccounts: Object.freeze([
        Object.freeze({ role: 'BONDING_CURVE', address: input.curve.toBase58() }),
        Object.freeze({ role: 'USER_BASE_ATA', address: input.userBaseAta.toBase58() }),
      ]),
      recipientSelections: Object.freeze([
        input.feeSelection,
        input.buybackSelection,
      ]),
      instructions: Object.freeze(instructions),
    });
  } catch {
    throw policyError();
  }
}

function validateRequest(inputValue: unknown): ValidatedPumpFunBuildRequest {
  const input = closedFrozenRecord(inputValue, REQUEST_KEYS);
  if (input === null) throw policyError();
  const quoteRecord = closedFrozenRecord(input.quote, QUOTE_KEYS);
  const curveRecord = closedFrozenRecord(input.curve, CURVE_KEYS);
  const ataRecord = closedFrozenRecord(input.userBaseTokenAccount, USER_ATA_KEYS);
  const recipientRecord = closedFrozenRecord(input.recipients, RECIPIENT_KEYS);
  if (quoteRecord === null || curveRecord === null || ataRecord === null
    || recipientRecord === null || typeof input.user !== 'string') throw policyError();
  const quote = quoteFrom(quoteRecord);
  if (curveRecord.mint !== quote.mint
    || curveRecord.ownerProgramId !== PUMP_PROGRAM_ID
    || curveRecord.exists !== true
    || curveRecord.complete !== false
    || typeof curveRecord.isMayhemMode !== 'boolean'
    || typeof curveRecord.address !== 'string'
    || typeof curveRecord.creator !== 'string'
    || typeof ataRecord.address !== 'string'
    || typeof ataRecord.exists !== 'boolean') throw policyError();

  const user = publicKey(input.user, false);
  const mint = publicKey(quote.mint, false);
  const creator = publicKey(curveRecord.creator, false);
  const curve = publicKey(curveRecord.address, false);
  if (!curve.equals(bondingCurvePda(mint))) throw policyError();
  const baseTokenProgram = quote.baseTokenProgram === 'SPL_TOKEN'
    ? TOKEN_PROGRAM_ID
    : TOKEN_2022_PROGRAM_ID;
  const userBaseAta = publicKey(ataRecord.address, false);
  const expectedAta = getAssociatedTokenAddressSync(
    mint,
    user,
    true,
    baseTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  if (!userBaseAta.equals(expectedAta)
    || (quote.side === 'SELL' && !ataRecord.exists)) throw policyError();

  const normalCandidates = recipientList(
    recipientRecord.feeRecipient,
    recipientRecord.feeRecipients,
    7,
  );
  const reservedCandidates = recipientList(
    recipientRecord.reservedFeeRecipient,
    recipientRecord.reservedFeeRecipients,
    7,
  );
  const buybackCandidates = stringArray(recipientRecord.buybackFeeRecipients, 8)
    .map((value) => publicKey(value, false).toBase58());
  const allRecipients = [
    ...normalCandidates,
    ...reservedCandidates,
    ...buybackCandidates,
  ];
  if (new Set(allRecipients).size !== allRecipients.length) throw policyError();
  const feeCandidates = curveRecord.isMayhemMode
    ? reservedCandidates
    : normalCandidates;
  const feeSelection = selectRecipient(
    'FEE',
    FEE_DOMAIN,
    curveRecord.isMayhemMode ? 'RESERVED' : 'NORMAL',
    quote.quoteFingerprint,
    feeCandidates,
  );
  const buybackSelection = selectRecipient(
    'BUYBACK_FEE',
    BUYBACK_DOMAIN,
    'BUYBACK',
    quote.quoteFingerprint,
    buybackCandidates,
  );
  return Object.freeze({
    quote,
    user,
    mint,
    creator,
    curve,
    userBaseAta,
    userBaseAtaExists: ataRecord.exists,
    baseTokenProgram,
    feeSelection,
    buybackSelection,
  });
}

function quoteFrom(record: Readonly<Record<string, unknown>>): PumpFunBuildQuoteV1 {
  if (record.payloadVersion !== 1
    || record.venue !== 'PUMP_FUN'
    || (record.side !== 'BUY' && record.side !== 'SELL')
    || typeof record.mint !== 'string'
    || record.quoteMint !== NATIVE_MINT.toBase58()
    || (record.baseTokenProgram !== 'SPL_TOKEN'
      && record.baseTokenProgram !== 'TOKEN_2022')
    || record.quoteTokenProgram !== 'SPL_TOKEN'
    || record.quoteDecimals !== 9
    || !positiveU64(record.amountInRaw)
    || !positiveU64(record.expectedAmountOutRaw)
    || !positiveU64(record.protectedAmountOutRaw)
    || record.protectedAmountOutRaw > record.expectedAmountOutRaw
    || !nonNegativeU64(record.snapshotSlot)
    || typeof record.quoteFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/u.test(record.quoteFingerprint)) throw policyError();
  return Object.freeze({
    payloadVersion: 1,
    venue: 'PUMP_FUN',
    side: record.side,
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
  });
}

function recipientList(
  primaryValue: unknown,
  restValue: unknown,
  tailLength: number,
): string[] {
  if (typeof primaryValue !== 'string') throw policyError();
  const primary = publicKey(primaryValue, false).toBase58();
  const rest = stringArray(restValue, tailLength)
    .map((value) => publicKey(value, false).toBase58());
  const result = [primary, ...rest];
  if (new Set(result).size !== result.length) throw policyError();
  return result;
}

function selectRecipient(
  role: BuildRecipientSelectionV1['role'],
  domain: string,
  listKind: BuildRecipientSelectionV1['listKind'],
  fingerprint: string,
  candidatesValue: readonly string[],
): BuildRecipientSelectionV1 {
  if (candidatesValue.length === 0) throw policyError();
  const candidates = Object.freeze([...candidatesValue]);
  const selectionHash = createHash('sha256')
    .update(lengthPrefixedUtf8([domain, fingerprint]))
    .digest('hex');
  const selectedIndex = Number(BigInt(`0x${selectionHash}`) % BigInt(candidates.length));
  const selectedAddress = candidates[selectedIndex];
  if (selectedAddress === undefined || !candidates.includes(selectedAddress)) throw policyError();
  return Object.freeze({
    role,
    domain,
    listKind,
    candidates,
    selectionHash,
    selectedIndex,
    selectedAddress,
  });
}

function validateRawInstruction(
  instruction: TransactionInstruction,
  input: ValidatedPumpFunBuildRequest,
): void {
  const expectedCount = input.quote.side === 'BUY' ? 27 : 26;
  const expectedDiscriminator = input.quote.side === 'BUY'
    ? BUY_DISCRIMINATOR
    : SELL_DISCRIMINATOR;
  const expectedAmount = input.quote.side === 'BUY'
    ? input.quote.protectedAmountOutRaw
    : input.quote.amountInRaw;
  if (!instruction.programId.equals(new PublicKey(PUMP_PROGRAM_ID))
    || instruction.keys.length !== expectedCount
    || instruction.data.length !== 24
    || instruction.data.toString('hex', 0, 8) !== expectedDiscriminator
    || instruction.data.readBigUInt64LE(8) !== expectedAmount
    || instruction.data.readBigUInt64LE(16) !== (input.quote.side === 'BUY'
      ? input.quote.amountInRaw
      : input.quote.protectedAmountOutRaw)
    || !instruction.keys[1]?.pubkey.equals(input.mint)
    || !instruction.keys[2]?.pubkey.equals(NATIVE_MINT)
    || !instruction.keys[3]?.pubkey.equals(input.baseTokenProgram)
    || !instruction.keys[4]?.pubkey.equals(TOKEN_PROGRAM_ID)
    || !instruction.keys[6]?.pubkey.equals(
      new PublicKey(input.feeSelection.selectedAddress),
    )
    || !instruction.keys[8]?.pubkey.equals(
      new PublicKey(input.buybackSelection.selectedAddress),
    )
    || !instruction.keys[10]?.pubkey.equals(input.curve)
    || !instruction.keys[13]?.pubkey.equals(input.user)
    || !instruction.keys[14]?.pubkey.equals(input.userBaseAta)) throw policyError();
}

function normalizeInstruction(
  instruction: TransactionInstruction,
): NormalizedInstructionV1 {
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

function closedFrozenRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)
    || !Object.isFrozen(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return null;
  const actual = (keys as string[]).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) return null;
  const result: Record<string, unknown> = {};
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function stringArray(value: unknown, expectedLength: number): string[] {
  if (typeof value !== 'object' || value === null || isProxy(value)
    || !Array.isArray(value) || !Object.isFrozen(value)
    || Object.getPrototypeOf(value) !== Array.prototype) throw policyError();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
    || typeof lengthDescriptor.value !== 'number') throw policyError();
  const length = lengthDescriptor.value;
  if (length !== expectedLength) throw policyError();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')
    || keys.length !== length + 1) throw policyError();
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)
      || typeof descriptor.value !== 'string') throw policyError();
    result.push(descriptor.value);
  }
  return result;
}

function publicKey(value: unknown, allowDefault: boolean): PublicKey {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44
    || Buffer.byteLength(value, 'utf8') < 32 || Buffer.byteLength(value, 'utf8') > 44
    || !/^[1-9A-HJ-NP-Za-km-z]+$/u.test(value)) throw policyError();
  const decoded = new PublicKey(value);
  if (decoded.toBase58() !== value || (!allowDefault && value === DEFAULT_PUBLIC_KEY)) {
    throw policyError();
  }
  return decoded;
}

function positiveU64(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n && value <= U64_MAX;
}

function nonNegativeU64(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= U64_MAX;
}

function decimalBn(value: bigint): BN {
  return new BN(value.toString(10), 10);
}

function lengthPrefixedUtf8(values: readonly string[]): Buffer {
  return Buffer.concat(values.flatMap((value) => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return [length, bytes];
  }));
}

function policyError(): ExecutionBuildPolicyError {
  return new ExecutionBuildPolicyError('PUMP_FUN');
}

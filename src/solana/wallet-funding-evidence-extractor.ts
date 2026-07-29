import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenInstruction,
  decodeTransferCheckedInstruction,
  decodeTransferInstruction,
} from '@solana/spl-token';
import {
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  assertValidWalletFundingExtractionResult,
  createWalletFundingAssessmentId,
  createWalletFundingEvidenceId,
  WALLET_FUNDING_DIAGNOSTIC_CODES,
  WALLET_FUNDING_PAYLOAD_VERSION,
  type DirectQuoteTransferEvidence,
  type FeePayerEvidence,
  type WalletFundingAssessment,
  type WalletFundingBuy,
  type WalletFundingDiagnosticCode,
  type WalletFundingEvidence,
  type WalletFundingExtractionResult,
} from '../domain/wallet-funding.js';
import { compareCursors } from '../domain/cursor.js';
import type {
  ChainConfirmationStatus,
  ChainCursor,
  QuoteAsset,
  TokenProgramKind,
} from '../domain/types.js';
import {
  PUMP_PROGRAM_ID,
  WSOL_MINT,
} from '../launchpads/pumpfun/constants.js';
import {
  decodePumpInstruction,
} from '../launchpads/pumpfun/instruction-decoder.js';
import type {
  WalletFundingEvidenceExtractor,
} from '../ports/wallet-funding-evidence-extractor.js';
import type {
  NormalizedInstruction,
  NormalizedTokenBalance,
  NormalizedTransaction,
} from './rpc/types.js';

interface BuyContext {
  readonly buy: WalletFundingBuy;
  readonly technicalAccounts: ReadonlySet<string>;
  readonly actionAvailable: boolean;
}

interface DecodedTransfer {
  readonly cursor: ChainCursor;
  readonly amountRaw: bigint;
  readonly sourceWallet: string | null;
  readonly destinationWallet: string | null;
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  readonly quoteAsset: QuoteAsset | null;
  readonly unavailableCode: WalletFundingDiagnosticCode | null;
}

interface MutableAssessment {
  inspectedTransferCount: number;
  acceptedEvidenceCount: number;
  ignoredTransferCount: number;
  readonly diagnosticCodes: Set<WalletFundingDiagnosticCode>;
  readonly evidence: WalletFundingEvidence[];
}

interface TokenAccountResolution {
  readonly status: 'KNOWN' | 'UNAVAILABLE' | 'AMBIGUOUS';
  readonly account: string;
  readonly mint: string | null;
  readonly owner: string | null;
  readonly tokenProgram: string | null;
  readonly decimals: number | null;
}

const CONFIRMATION_STATUS: Readonly<
  Record<NormalizedTransaction['confirmationStatus'], ChainConfirmationStatus>
> = Object.freeze({
  PROCESSED: 'processed',
  CONFIRMED: 'confirmed',
  FINALIZED: 'finalized',
  ORPHANED: 'orphaned',
});

export class SolanaWalletFundingEvidenceExtractor
implements WalletFundingEvidenceExtractor<NormalizedTransaction> {
  public extract(
    transaction: NormalizedTransaction,
    buys: readonly WalletFundingBuy[],
  ): WalletFundingExtractionResult {
    if (transaction.error !== null) {
      throw new TypeError('Cannot extract wallet funding from a failed transaction.');
    }
    if (transaction.transactionIndex === null) {
      throw new TypeError('Wallet funding extraction requires a transaction index.');
    }

    const orderedBuys = [...buys].sort((left, right) => {
      const cursorOrder = compareCursors(left.cursor, right.cursor);
      return cursorOrder === 0
        ? left.tradeId.localeCompare(right.tradeId)
        : cursorOrder;
    });
    const contexts = orderedBuys.map((buy) =>
      this.createBuyContext(transaction, buy));
    const stateByTrade = new Map<string, MutableAssessment>(
      orderedBuys.map((buy) => [buy.tradeId, {
        inspectedTransferCount: 0,
        acceptedEvidenceCount: 0,
        ignoredTransferCount: 0,
        diagnosticCodes: new Set<WalletFundingDiagnosticCode>(),
        evidence: [],
      }]),
    );
    const balances = resolveTokenAccounts(transaction);
    const transfers = this.decodeTransfers(transaction, balances);
    const consumed = new Set<DecodedTransfer>();

    for (const transfer of transfers) {
      const target = contexts.find((context) =>
        !consumed.has(transfer)
        && isBefore(transfer.cursor, context.buy.cursor)
        && transferMatchesBuy(transfer, context));
      if (target === undefined) continue;
      consumed.add(transfer);
      const state = requiredState(stateByTrade, target.buy.tradeId);
      state.inspectedTransferCount += 1;

      if (
        !target.actionAvailable
        || transfer.unavailableCode !== null
        || transfer.sourceWallet === null
      ) {
        state.ignoredTransferCount += 1;
        state.diagnosticCodes.add(
          transfer.unavailableCode ?? 'TOKEN_BALANCE_UNAVAILABLE',
        );
        continue;
      }
      if (
        transfer.sourceWallet === target.buy.buyer
      ) {
        state.ignoredTransferCount += 1;
        state.diagnosticCodes.add('SELF_TRANSFER_IGNORED');
        continue;
      }
      if (
        target.technicalAccounts.has(transfer.sourceWallet)
        || target.technicalAccounts.has(transfer.sourceAccount)
      ) {
        state.ignoredTransferCount += 1;
        continue;
      }
      const evidence = directEvidence(target.buy, transfer);
      state.evidence.push(evidence);
      state.acceptedEvidenceCount += 1;
    }

    const payer = transaction.signerKeys[0] ?? null;
    for (const context of contexts) {
      const state = requiredState(stateByTrade, context.buy.tradeId);
      if (!context.actionAvailable) {
        state.diagnosticCodes.add('KNOWN_TRANSFER_INVALID');
      }
      if (
        payer !== null
        && payer !== context.buy.buyer
        && !context.technicalAccounts.has(payer)
      ) {
        const evidence = feePayerEvidence(context.buy, payer);
        state.evidence.push(evidence);
        state.acceptedEvidenceCount += 1;
      }
    }

    const assessments = Object.freeze(contexts.map((context) => {
      const state = requiredState(stateByTrade, context.buy.tradeId);
      const diagnostics = Object.freeze(
        WALLET_FUNDING_DIAGNOSTIC_CODES.filter((code) =>
          state.diagnosticCodes.has(code)),
      );
      const strongCount = state.evidence.filter((item) =>
        item.confidence === 'STRONG').length;
      const mediumCount = state.evidence.filter((item) =>
        item.confidence === 'MEDIUM').length;
      const unavailable = diagnostics.some((code) =>
        code !== 'SELF_TRANSFER_IGNORED');
      const assessmentWithoutId = Object.freeze({
        id: '',
        buy: context.buy,
        status: strongCount > 0
          ? 'STRONG' as const
          : mediumCount > 0
            ? 'MEDIUM_ONLY' as const
            : unavailable
              ? 'UNAVAILABLE' as const
              : 'NO_EVIDENCE' as const,
        inspectedTransferCount: state.inspectedTransferCount,
        acceptedEvidenceCount: state.acceptedEvidenceCount,
        ignoredTransferCount: state.ignoredTransferCount,
        diagnosticCodes: diagnostics,
        payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
      });
      return Object.freeze({
        ...assessmentWithoutId,
        id: createWalletFundingAssessmentId(context.buy),
      }) satisfies WalletFundingAssessment;
    }));
    const evidence = Object.freeze(contexts.flatMap((context) =>
      requiredState(stateByTrade, context.buy.tradeId).evidence));
    const result = Object.freeze({ assessments, evidence });
    assertValidWalletFundingExtractionResult(result);
    return result;
  }

  private createBuyContext(
    transaction: NormalizedTransaction,
    buy: WalletFundingBuy,
  ): BuyContext {
    assertBuyMatchesTransaction(transaction, buy);
    const actionInstruction = transaction.instructions.find((instruction) =>
      instruction.instructionIndex === buy.cursor.instructionIndex
      && instruction.innerInstructionIndex === buy.cursor.innerInstructionIndex);
    if (actionInstruction === undefined) {
      return Object.freeze({
        buy,
        technicalAccounts: new Set<string>(),
        actionAvailable: false,
      });
    }
    try {
      const decoded = decodePumpInstruction(actionInstruction);
      if (
        decoded?.family !== 'BUY'
        || decoded.accounts.user !== buy.buyer
      ) {
        return Object.freeze({
          buy,
          technicalAccounts: new Set<string>(),
          actionAvailable: false,
        });
      }
      return Object.freeze({
        buy,
        technicalAccounts: new Set(
          Object.entries(decoded.accounts)
            .filter(([role]) => role !== 'user')
            .map(([, account]) => account),
        ),
        actionAvailable: true,
      });
    } catch {
      return Object.freeze({
        buy,
        technicalAccounts: new Set<string>(),
        actionAvailable: false,
      });
    }
  }

  private decodeTransfers(
    transaction: NormalizedTransaction,
    balances: ReadonlyMap<string, TokenAccountResolution>,
  ): readonly DecodedTransfer[] {
    const result: DecodedTransfer[] = [];
    for (const instruction of transaction.instructions) {
      const cursor = instructionCursor(transaction, instruction);
      if (instruction.programId === SystemProgram.programId.toBase58()) {
        const decoded = decodeSystemTransfer(instruction, cursor);
        if (decoded !== null) result.push(decoded);
        continue;
      }
      const tokenProgram = tokenProgramKind(instruction.programId);
      if (tokenProgram === null) continue;
      const decoded = decodeTokenTransfer(
        instruction,
        cursor,
        tokenProgram,
        balances,
      );
      if (decoded !== null) result.push(decoded);
    }
    return Object.freeze(result.sort((left, right) =>
      compareCursors(left.cursor, right.cursor)));
  }
}

function decodeSystemTransfer(
  normalized: NormalizedInstruction,
  cursor: ChainCursor,
): DecodedTransfer | null {
  const instruction = toTransactionInstruction(normalized);
  let type: string;
  try {
    type = SystemInstruction.decodeInstructionType(instruction);
  } catch {
    return null;
  }
  if (type !== 'Transfer') return null;
  try {
    const decoded = SystemInstruction.decodeTransfer(instruction);
    const amountRaw = typeof decoded.lamports === 'bigint'
      ? decoded.lamports
      : BigInt(decoded.lamports);
    if (amountRaw <= 0n) return null;
    return Object.freeze({
      cursor,
      amountRaw,
      sourceWallet: decoded.fromPubkey.toBase58(),
      destinationWallet: decoded.toPubkey.toBase58(),
      sourceAccount: decoded.fromPubkey.toBase58(),
      destinationAccount: decoded.toPubkey.toBase58(),
      quoteAsset: Object.freeze({
        mint: WSOL_MINT,
        decimals: 9,
        tokenProgram: 'SPL_TOKEN',
      }),
      unavailableCode: null,
    });
  } catch {
    const sourceAccount = normalized.accounts[0] ?? '';
    const destinationAccount = normalized.accounts[1] ?? '';
    return Object.freeze({
      cursor,
      amountRaw: 0n,
      sourceWallet: sourceAccount.length === 0 ? null : sourceAccount,
      destinationWallet:
        destinationAccount.length === 0 ? null : destinationAccount,
      sourceAccount,
      destinationAccount,
      quoteAsset: Object.freeze({
        mint: WSOL_MINT,
        decimals: 9,
        tokenProgram: 'SPL_TOKEN',
      }),
      unavailableCode: 'KNOWN_TRANSFER_INVALID',
    });
  }
}

function decodeTokenTransfer(
  normalized: NormalizedInstruction,
  cursor: ChainCursor,
  tokenProgram: TokenProgramKind,
  balances: ReadonlyMap<string, TokenAccountResolution>,
): DecodedTransfer | null {
  const instruction = toTransactionInstruction(normalized);
  const programId = tokenProgram === 'SPL_TOKEN'
    ? TOKEN_PROGRAM_ID
    : TOKEN_2022_PROGRAM_ID;
  const instructionType = normalized.data[0];
  try {
    if (instructionType === TokenInstruction.TransferChecked) {
      const decoded = decodeTransferCheckedInstruction(instruction, programId);
      return tokenTransfer({
        cursor,
        amountRaw: decoded.data.amount,
        checkedMint: decoded.keys.mint.pubkey.toBase58(),
        checkedDecimals: decoded.data.decimals,
        sourceAccount: decoded.keys.source.pubkey.toBase58(),
        destinationAccount: decoded.keys.destination.pubkey.toBase58(),
        tokenProgram,
        balances,
      });
    }
    if (instructionType === TokenInstruction.Transfer) {
      const decoded = decodeTransferInstruction(instruction, programId);
      return tokenTransfer({
        cursor,
        amountRaw: decoded.data.amount,
        checkedMint: null,
        checkedDecimals: null,
        sourceAccount: decoded.keys.source.pubkey.toBase58(),
        destinationAccount: decoded.keys.destination.pubkey.toBase58(),
        tokenProgram,
        balances,
      });
    }
    return null;
  } catch {
    const sourceAccount = normalized.accounts[0] ?? '';
    const destinationIndex = instructionType === TokenInstruction.TransferChecked
      ? 2
      : 1;
    const destinationAccount = normalized.accounts[destinationIndex] ?? '';
    const source = balances.get(sourceAccount)
      ?? unavailableAccount(sourceAccount);
    const destination = balances.get(destinationAccount)
      ?? unavailableAccount(destinationAccount);
    const mint = consistentText(source.mint, destination.mint);
    const decimals = consistentNumber(source.decimals, destination.decimals);
    return Object.freeze({
      cursor,
      amountRaw: 0n,
      sourceWallet: source.owner,
      destinationWallet: destination.owner,
      sourceAccount,
      destinationAccount,
      quoteAsset: mint === null || decimals === null
        ? null
        : Object.freeze({ mint, decimals, tokenProgram }),
      unavailableCode: 'KNOWN_TRANSFER_INVALID',
    });
  }
}

function tokenTransfer(input: {
  readonly cursor: ChainCursor;
  readonly amountRaw: bigint;
  readonly checkedMint: string | null;
  readonly checkedDecimals: number | null;
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  readonly tokenProgram: TokenProgramKind;
  readonly balances: ReadonlyMap<string, TokenAccountResolution>;
}): DecodedTransfer | null {
  if (input.amountRaw <= 0n) return null;
  const source = input.balances.get(input.sourceAccount)
    ?? unavailableAccount(input.sourceAccount);
  const destination = input.balances.get(input.destinationAccount)
    ?? unavailableAccount(input.destinationAccount);
  const unavailableCode = resolutionDiagnostic(source, destination);
  const mint = input.checkedMint ?? consistentText(source.mint, destination.mint);
  const decimals = input.checkedDecimals
    ?? consistentNumber(source.decimals, destination.decimals);
  const expectedProgram = input.tokenProgram === 'SPL_TOKEN'
    ? TOKEN_PROGRAM_ID.toBase58()
    : TOKEN_2022_PROGRAM_ID.toBase58();
  const programsMatch = [source.tokenProgram, destination.tokenProgram]
    .every((program) => program === null || program === expectedProgram);
  if (
    mint === null
    || decimals === null
    || !programsMatch
    || (source.mint !== null && source.mint !== mint)
    || (destination.mint !== null && destination.mint !== mint)
    || (source.decimals !== null && source.decimals !== decimals)
    || (destination.decimals !== null && destination.decimals !== decimals)
  ) {
    return Object.freeze({
      cursor: input.cursor,
      amountRaw: input.amountRaw,
      sourceWallet: source.owner,
      destinationWallet: destination.owner,
      sourceAccount: input.sourceAccount,
      destinationAccount: input.destinationAccount,
      quoteAsset: null,
      unavailableCode: 'OWNER_AMBIGUOUS',
    });
  }
  return Object.freeze({
    cursor: input.cursor,
    amountRaw: input.amountRaw,
    sourceWallet: source.owner,
    destinationWallet: destination.owner,
    sourceAccount: input.sourceAccount,
    destinationAccount: input.destinationAccount,
    quoteAsset: Object.freeze({
      mint,
      decimals,
      tokenProgram: input.tokenProgram,
    }),
    unavailableCode,
  });
}

function transferMatchesBuy(
  transfer: DecodedTransfer,
  context: BuyContext,
): boolean {
  const { buy } = context;
  if (
    transfer.quoteAsset === null
    || !quoteAssetsEqual(transfer.quoteAsset, buy.quoteAsset)
  ) {
    return false;
  }
  return transfer.destinationWallet === buy.buyer
    || (
      transfer.destinationWallet === null
      && context.technicalAccounts.has(transfer.destinationAccount)
    );
}

function directEvidence(
  buy: WalletFundingBuy,
  transfer: DecodedTransfer,
): DirectQuoteTransferEvidence {
  if (transfer.sourceWallet === null) {
    throw new TypeError('Direct wallet funding source is unavailable.');
  }
  const withoutId: DirectQuoteTransferEvidence = Object.freeze({
    id: '',
    type: 'DIRECT_QUOTE_TRANSFER',
    confidence: 'STRONG',
    mint: buy.mint,
    buyer: buy.buyer,
    funder: transfer.sourceWallet,
    quoteAsset: buy.quoteAsset,
    amountRaw: transfer.amountRaw,
    source: buy.source,
    program: buy.program,
    signature: buy.signature,
    transferCursor: transfer.cursor,
    buyEventId: buy.eventId,
    buyTradeId: buy.tradeId,
    buyCursor: buy.cursor,
    confirmationStatus: buy.confirmationStatus,
    blockchainTimeMs: buy.blockchainTimeMs,
    observedAtMs: buy.observedAtMs,
    payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
  });
  return Object.freeze({
    ...withoutId,
    id: createWalletFundingEvidenceId(withoutId),
  });
}

function feePayerEvidence(
  buy: WalletFundingBuy,
  payer: string,
): FeePayerEvidence {
  const withoutId: FeePayerEvidence = Object.freeze({
    id: '',
    type: 'FEE_PAYER_FOR_BUYER',
    confidence: 'MEDIUM',
    mint: buy.mint,
    buyer: buy.buyer,
    funder: payer,
    quoteAsset: buy.quoteAsset,
    amountRaw: null,
    source: buy.source,
    program: buy.program,
    signature: buy.signature,
    transferCursor: null,
    buyEventId: buy.eventId,
    buyTradeId: buy.tradeId,
    buyCursor: buy.cursor,
    confirmationStatus: buy.confirmationStatus,
    blockchainTimeMs: buy.blockchainTimeMs,
    observedAtMs: buy.observedAtMs,
    payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
  });
  return Object.freeze({
    ...withoutId,
    id: createWalletFundingEvidenceId(withoutId),
  });
}

function assertBuyMatchesTransaction(
  transaction: NormalizedTransaction,
  buy: WalletFundingBuy,
): void {
  if (
    buy.source !== 'pumpfun'
    || buy.program !== PUMP_PROGRAM_ID
    || buy.signature !== transaction.signature
    || buy.cursor.slot !== transaction.slot
    || buy.cursor.transactionIndex !== transaction.transactionIndex
    || buy.confirmationStatus !== CONFIRMATION_STATUS[transaction.confirmationStatus]
    || buy.blockchainTimeMs !== transaction.blockTimeMs
  ) {
    throw new TypeError('Wallet funding buy does not match its transaction.');
  }
}

function resolveTokenAccounts(
  transaction: NormalizedTransaction,
): ReadonlyMap<string, TokenAccountResolution> {
  const candidates = new Map<string, NormalizedTokenBalance[]>();
  for (const balance of [
    ...transaction.preTokenBalances,
    ...transaction.postTokenBalances,
  ]) {
    const values = candidates.get(balance.account) ?? [];
    values.push(balance);
    candidates.set(balance.account, values);
  }
  return new Map([...candidates.entries()].map(([account, values]) => {
    const first = values[0];
    if (first === undefined) return [account, unavailableAccount(account)];
    const conflicting = values.some((value) =>
      value.mint !== first.mint
      || value.owner !== first.owner
      || value.tokenProgram !== first.tokenProgram
      || value.decimals !== first.decimals);
    if (conflicting) {
      return [account, Object.freeze({
        status: 'AMBIGUOUS',
        account,
        mint: null,
        owner: null,
        tokenProgram: null,
        decimals: null,
      })];
    }
    return [account, Object.freeze({
      status: first.owner === null ? 'UNAVAILABLE' : 'KNOWN',
      account,
      mint: first.mint,
      owner: first.owner,
      tokenProgram: first.tokenProgram,
      decimals: first.decimals,
    })];
  }));
}

function unavailableAccount(account: string): TokenAccountResolution {
  return Object.freeze({
    status: 'UNAVAILABLE',
    account,
    mint: null,
    owner: null,
    tokenProgram: null,
    decimals: null,
  });
}

function resolutionDiagnostic(
  source: TokenAccountResolution,
  destination: TokenAccountResolution,
): WalletFundingDiagnosticCode | null {
  if (source.status === 'AMBIGUOUS' || destination.status === 'AMBIGUOUS') {
    return 'OWNER_AMBIGUOUS';
  }
  if (source.status === 'UNAVAILABLE' || destination.status === 'UNAVAILABLE') {
    return 'TOKEN_BALANCE_UNAVAILABLE';
  }
  return null;
}

function toTransactionInstruction(
  instruction: NormalizedInstruction,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(account),
      isSigner: false,
      isWritable: false,
    })),
    data: Buffer.from(instruction.data),
  });
}

function instructionCursor(
  transaction: NormalizedTransaction,
  instruction: NormalizedInstruction,
): ChainCursor {
  if (transaction.transactionIndex === null) {
    throw new TypeError('Wallet funding extraction requires a transaction index.');
  }
  return Object.freeze({
    slot: transaction.slot,
    transactionIndex: transaction.transactionIndex,
    instructionIndex: instruction.instructionIndex,
    innerInstructionIndex: instruction.innerInstructionIndex,
  });
}

function tokenProgramKind(program: string): TokenProgramKind | null {
  if (program === TOKEN_PROGRAM_ID.toBase58()) return 'SPL_TOKEN';
  if (program === TOKEN_2022_PROGRAM_ID.toBase58()) return 'TOKEN_2022';
  return null;
}

function consistentText(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) return right;
  if (right === null || right === left) return left;
  return null;
}

function consistentNumber(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) return right;
  if (right === null || right === left) return left;
  return null;
}

function quoteAssetsEqual(left: QuoteAsset, right: QuoteAsset): boolean {
  return left.mint === right.mint
    && left.decimals === right.decimals
    && left.tokenProgram === right.tokenProgram;
}

function isBefore(left: ChainCursor, right: ChainCursor): boolean {
  return compareCursors(left, right) < 0;
}

function requiredState(
  states: ReadonlyMap<string, MutableAssessment>,
  tradeId: string,
): MutableAssessment {
  const state = states.get(tradeId);
  if (state === undefined) {
    throw new TypeError(`Missing wallet funding assessment state for ${tradeId}.`);
  }
  return state;
}

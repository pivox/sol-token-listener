import bs58 from 'bs58';
import type {
  CompiledInstruction,
  MessageCompiledInstruction,
  TokenBalance,
  VersionedTransactionResponse,
} from '@solana/web3.js';
import { assertValidTransactionCursor } from '../../domain/cursor.js';
import type { SolanaRpcClient } from './rpc-client.js';
import type {
  LegacyConfirmationStatus,
  NormalizedInstruction,
  NormalizedTokenBalance,
  NormalizedTransaction,
} from './types.js';

export class TransactionFetcher {
  constructor(private readonly rpc: SolanaRpcClient) {}

  async fetch(
    signature: string,
    confirmationStatus: LegacyConfirmationStatus = 'CONFIRMED',
    transactionIndex: number | null = null,
  ): Promise<NormalizedTransaction | null> {
    if (confirmationStatus === 'ORPHANED') return null;
    const response = await this.rpc.http.getTransaction(signature, {
      commitment: confirmationStatus === 'PROCESSED'
        ? 'confirmed'
        : confirmationStatus.toLowerCase() as 'confirmed' | 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (response === null) return null;
    return normalizeTransaction(response, confirmationStatus, transactionIndex);
  }
}

export function normalizeTransaction(
  response: VersionedTransactionResponse,
  confirmationStatus: LegacyConfirmationStatus,
  transactionIndex: number | null,
): NormalizedTransaction {
  const slot = BigInt(response.slot);
  if (transactionIndex !== null) {
    assertValidTransactionCursor({ slot, transactionIndex });
  }
  const message = response.transaction.message;
  const loadedAddresses = response.meta?.loadedAddresses;
  const keys = loadedAddresses === undefined
    ? message.getAccountKeys()
    : message.getAccountKeys({ accountKeysFromLookups: loadedAddresses });
  const accountKeys = Array.from({ length: keys.length }, (_unused, index) => {
    const key = keys.get(index);
    if (key === undefined) throw new Error(`Clé de compte Solana absente à l’index ${index}.`);
    return key.toBase58();
  });
  const instructions = normalizeInstructions(
    message.compiledInstructions,
    response.meta?.innerInstructions ?? [],
    accountKeys,
  );
  const meta = response.meta;
  return {
    signature: requiredSignature(response.transaction.signatures[0]),
    slot,
    transactionIndex,
    confirmationStatus,
    version: response.version ?? 'legacy',
    blockTimeMs: response.blockTime == null ? null : response.blockTime * 1_000,
    accountKeys,
    signerKeys: accountKeys.slice(0, message.header.numRequiredSignatures),
    instructions,
    preTokenBalances: normalizeTokenBalances(meta?.preTokenBalances ?? [], accountKeys),
    postTokenBalances: normalizeTokenBalances(meta?.postTokenBalances ?? [], accountKeys),
    preBalancesLamports: (meta?.preBalances ?? []).map((amount) => BigInt(amount)),
    postBalancesLamports: (meta?.postBalances ?? []).map((amount) => BigInt(amount)),
    feeLamports: BigInt(meta?.fee ?? 0),
    computeUnits: meta?.computeUnitsConsumed === undefined ? null : BigInt(meta.computeUnitsConsumed),
    logs: meta?.logMessages ?? [],
    error: meta?.err ?? null,
  };
}

function normalizeInstructions(
  outer: readonly MessageCompiledInstruction[],
  innerGroups: readonly {
    readonly index: number;
    readonly instructions: readonly CompiledInstruction[];
  }[],
  accountKeys: readonly string[],
): NormalizedInstruction[] {
  const innerByParent = new Map(innerGroups.map((group) => [group.index, group.instructions]));
  const normalized: NormalizedInstruction[] = [];
  outer.forEach((instruction, instructionIndex) => {
    normalized.push(normalizeOuterInstruction(instruction, instructionIndex, accountKeys));
    const inner = innerByParent.get(instructionIndex) ?? [];
    inner.forEach((nested, innerInstructionIndex) => {
      normalized.push(normalizeInnerInstruction(
        nested,
        instructionIndex,
        innerInstructionIndex,
        accountKeys,
      ));
    });
  });
  return normalized;
}

function normalizeOuterInstruction(
  instruction: MessageCompiledInstruction,
  instructionIndex: number,
  accountKeys: readonly string[],
): NormalizedInstruction {
  return {
    programId: requiredAccountKey(accountKeys, instruction.programIdIndex),
    accounts: instruction.accountKeyIndexes.map((index) => requiredAccountKey(accountKeys, index)),
    data: Uint8Array.from(instruction.data),
    instructionIndex,
    innerInstructionIndex: null,
    parentInstructionIndex: null,
    stackHeight: 1,
  };
}

function normalizeInnerInstruction(
  instruction: CompiledInstruction,
  instructionIndex: number,
  innerInstructionIndex: number,
  accountKeys: readonly string[],
): NormalizedInstruction {
  return {
    programId: requiredAccountKey(accountKeys, instruction.programIdIndex),
    accounts: instruction.accounts.map((index) => requiredAccountKey(accountKeys, index)),
    data: Uint8Array.from(bs58.decode(instruction.data)),
    instructionIndex,
    innerInstructionIndex,
    parentInstructionIndex: instructionIndex,
    stackHeight: 2,
  };
}

function normalizeTokenBalances(
  balances: readonly TokenBalance[],
  accountKeys: readonly string[],
): NormalizedTokenBalance[] {
  return balances.map((balance) => ({
    accountIndex: balance.accountIndex,
    account: requiredAccountKey(accountKeys, balance.accountIndex),
    mint: balance.mint,
    owner: balance.owner ?? null,
    tokenProgram: balance.programId ?? '',
    amountRaw: BigInt(balance.uiTokenAmount.amount),
    decimals: balance.uiTokenAmount.decimals,
  }));
}

function requiredAccountKey(accountKeys: readonly string[], index: number): string {
  const key = accountKeys[index];
  if (key === undefined) throw new Error(`Index de compte Solana invalide: ${index}.`);
  return key;
}

function requiredSignature(signature: string | undefined): string {
  if (signature === undefined) throw new Error('Transaction Solana sans signature.');
  return signature;
}

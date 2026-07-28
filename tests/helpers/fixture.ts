import { readFile } from 'node:fs/promises';
import type { PoolInfo } from '../../src/domain/types.js';
import type {
  LegacyConfirmationStatus,
  NormalizedInstruction,
  NormalizedTokenBalance,
  NormalizedTransaction,
} from '../../src/solana/rpc/types.js';

export async function loadSwapFixture(name: string): Promise<{
  pool: PoolInfo;
  transaction: NormalizedTransaction;
}> {
  const path = new URL(`../fixtures/raydium-cpmm/${name}`, import.meta.url);
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const root = record(parsed, 'fixture');
  return {
    pool: parsePool(record(root.pool, 'pool')),
    transaction: parseTransaction(record(root.transaction, 'transaction')),
  };
}

function parsePool(value: Record<string, unknown>): PoolInfo {
  const dex = string(value.dex, 'pool.dex');
  if (dex !== 'RAYDIUM_CPMM') throw new Error(`pool.dex inattendu: ${dex}.`);
  return {
    dex,
    programId: string(value.programId, 'pool.programId'),
    pool: string(value.pool, 'pool.pool'),
    tokenMint: string(value.tokenMint, 'pool.tokenMint'),
    wsolMint: string(value.wsolMint, 'pool.wsolMint'),
    tokenVault: string(value.tokenVault, 'pool.tokenVault'),
    wsolVault: string(value.wsolVault, 'pool.wsolVault'),
    lpMint: string(value.lpMint, 'pool.lpMint'),
    tokenProgram: string(value.tokenProgram, 'pool.tokenProgram'),
    wsolTokenProgram: string(value.wsolTokenProgram, 'pool.wsolTokenProgram'),
    creator: nullableString(value.creator, 'pool.creator'),
    openTimeUnix: integer(value.openTimeUnix, 'pool.openTimeUnix'),
    createdSlot: integer(value.createdSlot, 'pool.createdSlot'),
    createdSignature: string(value.createdSignature, 'pool.createdSignature'),
    createdInstructionIndex: number(value.createdInstructionIndex, 'pool.createdInstructionIndex'),
    discoveredAtMs: number(value.discoveredAtMs, 'pool.discoveredAtMs'),
  };
}

function parseTransaction(value: Record<string, unknown>): NormalizedTransaction {
  const status = string(value.confirmationStatus, 'transaction.confirmationStatus');
  if (!isConfirmationStatus(status)) throw new Error(`Statut de confirmation invalide: ${status}.`);
  const version = value.version === 'legacy' ? 'legacy' : number(value.version, 'transaction.version');
  return {
    signature: string(value.signature, 'transaction.signature'),
    slot: integer(value.slot, 'transaction.slot'),
    transactionIndex: number(value.transactionIndex, 'transaction.transactionIndex'),
    confirmationStatus: status,
    version,
    blockTimeMs: nullableNumber(value.blockTimeMs, 'transaction.blockTimeMs'),
    accountKeys: stringArray(value.accountKeys, 'transaction.accountKeys'),
    signerKeys: stringArray(value.signerKeys, 'transaction.signerKeys'),
    instructions: array(value.instructions, 'transaction.instructions').map((item, index) =>
      parseInstruction(record(item, `transaction.instructions[${index}]`))),
    preTokenBalances: array(value.preTokenBalances, 'transaction.preTokenBalances').map((item, index) =>
      parseTokenBalance(record(item, `transaction.preTokenBalances[${index}]`))),
    postTokenBalances: array(value.postTokenBalances, 'transaction.postTokenBalances').map((item, index) =>
      parseTokenBalance(record(item, `transaction.postTokenBalances[${index}]`))),
    preBalancesLamports: array(value.preBalancesLamports, 'transaction.preBalancesLamports')
      .map((item, index) => integer(item, `transaction.preBalancesLamports[${index}]`)),
    postBalancesLamports: array(value.postBalancesLamports, 'transaction.postBalancesLamports')
      .map((item, index) => integer(item, `transaction.postBalancesLamports[${index}]`)),
    feeLamports: integer(value.feeLamports, 'transaction.feeLamports'),
    computeUnits: nullableInteger(value.computeUnits, 'transaction.computeUnits'),
    logs: stringArray(value.logs, 'transaction.logs'),
    error: value.error ?? null,
  };
}

function parseInstruction(value: Record<string, unknown>): NormalizedInstruction {
  const dataHex = string(value.dataHex, 'instruction.dataHex');
  if (!/^(?:[a-fA-F0-9]{2})*$/u.test(dataHex)) throw new Error('instruction.dataHex doit être hexadécimal.');
  return {
    programId: string(value.programId, 'instruction.programId'),
    accounts: stringArray(value.accounts, 'instruction.accounts'),
    data: Uint8Array.from(Buffer.from(dataHex, 'hex')),
    instructionIndex: number(value.instructionIndex, 'instruction.instructionIndex'),
    innerInstructionIndex: nullableNumber(value.innerInstructionIndex, 'instruction.innerInstructionIndex'),
    parentInstructionIndex: nullableNumber(value.parentInstructionIndex, 'instruction.parentInstructionIndex'),
    stackHeight: nullableNumber(value.stackHeight, 'instruction.stackHeight'),
  };
}

function parseTokenBalance(value: Record<string, unknown>): NormalizedTokenBalance {
  return {
    accountIndex: number(value.accountIndex, 'balance.accountIndex'),
    account: string(value.account, 'balance.account'),
    mint: string(value.mint, 'balance.mint'),
    owner: nullableString(value.owner, 'balance.owner'),
    tokenProgram: string(value.tokenProgram, 'balance.tokenProgram'),
    amountRaw: integer(value.amountRaw, 'balance.amountRaw'),
    decimals: number(value.decimals, 'balance.decimals'),
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} doit être un objet.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} doit être un tableau.`);
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} doit être une chaîne.`);
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : string(value, name);
}

function stringArray(value: unknown, name: string): readonly string[] {
  return array(value, name).map((item, index) => string(item, `${name}[${index}]`));
}

function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${name} doit être un entier sûr.`);
  return value;
}

function nullableNumber(value: unknown, name: string): number | null {
  return value === null ? null : number(value, name);
}

function integer(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) throw new Error(`${name} doit être un entier décimal sérialisé.`);
  return BigInt(value);
}

function nullableInteger(value: unknown, name: string): bigint | null {
  return value === null ? null : integer(value, name);
}

function isConfirmationStatus(value: string): value is LegacyConfirmationStatus {
  return ['PROCESSED', 'CONFIRMED', 'FINALIZED', 'ORPHANED'].includes(value);
}

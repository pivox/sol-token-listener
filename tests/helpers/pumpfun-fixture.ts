import { readFile } from 'node:fs/promises';
import type {
  LegacyConfirmationStatus,
  NormalizedInstruction,
  NormalizedTokenBalance,
  NormalizedTransaction,
} from '../../src/solana/rpc/types.js';

export interface PumpFixture {
  readonly provenance: {
    readonly source: 'solana-mainnet';
    readonly signature: string;
    readonly slot: bigint;
    readonly transactionIndex: number;
    readonly capturedAt: string;
  };
  readonly transaction: NormalizedTransaction;
}

export async function loadPumpFixture(name: string): Promise<PumpFixture> {
  if (!/^[a-z0-9][a-z0-9-]*\.json$/u.test(name)) {
    throw new Error(`Nom de fixture Pump invalide: ${name}.`);
  }
  const path = new URL(`../fixtures/pumpfun/${name}`, import.meta.url);
  const root = object(JSON.parse(await readFile(path, 'utf8')), 'fixture');
  const provenance = object(root.provenance, 'provenance');
  const transaction = object(root.transaction, 'transaction');
  return Object.freeze({
    provenance: Object.freeze({
      source: fixed(provenance.source, 'solana-mainnet', 'provenance.source'),
      signature: string(provenance.signature, 'provenance.signature'),
      slot: bigint(provenance.slot, 'provenance.slot'),
      transactionIndex: index(provenance.transactionIndex, 'provenance.transactionIndex'),
      capturedAt: isoTimestamp(provenance.capturedAt, 'provenance.capturedAt'),
    }),
    transaction: parseTransaction(transaction),
  });
}

function parseTransaction(value: Record<string, unknown>): NormalizedTransaction {
  const confirmationStatus = fixedStatus(value.confirmationStatus);
  const version = value.version === 'legacy' ? 'legacy' : index(value.version, 'transaction.version');
  return Object.freeze({
    signature: string(value.signature, 'transaction.signature'),
    slot: bigint(value.slot, 'transaction.slot'),
    transactionIndex: index(value.transactionIndex, 'transaction.transactionIndex'),
    confirmationStatus,
    version,
    blockTimeMs: nullableIndex(value.blockTimeMs, 'transaction.blockTimeMs'),
    accountKeys: Object.freeze([]),
    signerKeys: Object.freeze([]),
    instructions: frozenArray(value.instructions, 'transaction.instructions').map((item, indexValue) =>
      parseInstruction(object(item, `transaction.instructions[${indexValue}]`))),
    preTokenBalances: frozenArray(value.preTokenBalances, 'transaction.preTokenBalances').map((item, indexValue) =>
      parseTokenBalance(object(item, `transaction.preTokenBalances[${indexValue}]`))),
    postTokenBalances: frozenArray(value.postTokenBalances, 'transaction.postTokenBalances').map((item, indexValue) =>
      parseTokenBalance(object(item, `transaction.postTokenBalances[${indexValue}]`))),
    preBalancesLamports: Object.freeze([]),
    postBalancesLamports: Object.freeze([]),
    feeLamports: bigint(value.feeLamports, 'transaction.feeLamports'),
    computeUnits: nullableBigint(value.computeUnits, 'transaction.computeUnits'),
    logs: Object.freeze([]),
    error: value.error ?? null,
  });
}

function parseInstruction(value: Record<string, unknown>): NormalizedInstruction {
  const dataHex = string(value.dataHex, 'instruction.dataHex');
  if (!/^(?:[a-fA-F0-9]{2})*$/u.test(dataHex)) {
    throw new Error('instruction.dataHex doit être hexadécimal.');
  }
  return Object.freeze({
    programId: string(value.programId, 'instruction.programId'),
    accounts: frozenArray(value.accounts, 'instruction.accounts').map((item, indexValue) =>
      string(item, `instruction.accounts[${indexValue}]`)),
    data: Uint8Array.from(Buffer.from(dataHex, 'hex')),
    instructionIndex: index(value.instructionIndex, 'instruction.instructionIndex'),
    innerInstructionIndex: nullableIndex(value.innerInstructionIndex, 'instruction.innerInstructionIndex'),
    parentInstructionIndex: nullableIndex(value.parentInstructionIndex, 'instruction.parentInstructionIndex'),
    stackHeight: nullableIndex(value.stackHeight, 'instruction.stackHeight'),
  });
}

function parseTokenBalance(value: Record<string, unknown>): NormalizedTokenBalance {
  return Object.freeze({
    accountIndex: index(value.accountIndex, 'balance.accountIndex'),
    account: string(value.account, 'balance.account'),
    mint: string(value.mint, 'balance.mint'),
    owner: nullableString(value.owner, 'balance.owner'),
    tokenProgram: string(value.tokenProgram, 'balance.tokenProgram'),
    amountRaw: bigint(value.amountRaw, 'balance.amountRaw'),
    decimals: index(value.decimals, 'balance.decimals'),
  });
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} doit être un objet.`);
  }
  return value as Record<string, unknown>;
}

function frozenArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} doit être un tableau.`);
  return Object.freeze(value);
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} doit être une chaîne non vide.`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function index(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} doit être un entier sûr positif ou nul.`);
  }
  return value as number;
}

function nullableIndex(value: unknown, path: string): number | null {
  return value === null ? null : index(value, path);
}

function bigint(value: unknown, path: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) {
    throw new Error(`${path} doit être un entier décimal sérialisé.`);
  }
  return BigInt(value);
}

function nullableBigint(value: unknown, path: string): bigint | null {
  return value === null ? null : bigint(value, path);
}

function fixed<T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new Error(`${path} inattendu.`);
  return expected;
}

function fixedStatus(value: unknown): LegacyConfirmationStatus {
  if (value === 'PROCESSED' || value === 'CONFIRMED' || value === 'FINALIZED' || value === 'ORPHANED') {
    return value;
  }
  throw new Error('transaction.confirmationStatus invalide.');
}

function isoTimestamp(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (Number.isNaN(Date.parse(parsed))) throw new Error(`${path} doit être ISO-8601.`);
  return parsed;
}

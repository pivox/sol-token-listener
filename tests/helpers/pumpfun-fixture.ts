import { readFile } from 'node:fs/promises';
import type {
  NormalizedInstruction,
  NormalizedTokenBalance,
  NormalizedTransaction,
} from '../../src/solana/rpc/types.js';

export type MainnetFixtureFamily = 'pumpfun' | 'pumpswap';

export interface MainnetFixture<Family extends MainnetFixtureFamily> {
  readonly schemaVersion: 'solana-mainnet-fixture.v1';
  readonly family: Family;
  readonly sanitization: {
    readonly contract: 'normalized-public-chain.v1';
    readonly anonymized: false;
  };
  readonly provenance: {
    readonly source: 'solana-mainnet';
    readonly signature: string;
    readonly slot: bigint;
    readonly transactionIndex: number;
    readonly capturedAt: string;
  };
  readonly transaction: NormalizedTransaction;
}

export type PumpFixture = MainnetFixture<'pumpfun'>;

export async function loadPumpFixture(name: string): Promise<PumpFixture> {
  return loadMainnetFixture('pumpfun', name);
}

export async function loadMainnetFixture<Family extends MainnetFixtureFamily>(
  family: Family,
  name: string,
): Promise<MainnetFixture<Family>> {
  if (!/^[a-z0-9][a-z0-9-]*\.json$/u.test(name)) {
    throw new Error(`Nom de fixture Pump invalide: ${name}.`);
  }
  const path = new URL(`../fixtures/${family}/${name}`, import.meta.url);
  return parseMainnetFixture(JSON.parse(await readFile(path, 'utf8')), family);
}

export function parsePumpFixture(parsed: unknown): PumpFixture {
  return parseMainnetFixture(parsed, 'pumpfun');
}

export function parseMainnetFixture<Family extends MainnetFixtureFamily>(
  parsed: unknown,
  expectedFamily: Family,
): MainnetFixture<Family> {
  const root = object(parsed, 'fixture');
  exactKeys(root, ['schemaVersion', 'family', 'sanitization', 'provenance', 'transaction'], 'fixture');
  const sanitization = object(root.sanitization, 'sanitization');
  exactKeys(sanitization, ['contract', 'anonymized'], 'sanitization');
  const provenance = object(root.provenance, 'provenance');
  exactKeys(provenance, ['source', 'signature', 'slot', 'transactionIndex', 'capturedAt'], 'provenance');
  const transaction = object(root.transaction, 'transaction');
  const parsedTransaction = parseTransaction(transaction);
  const parsedProvenance = Object.freeze({
    source: fixed(provenance.source, 'solana-mainnet', 'provenance.source'),
    signature: string(provenance.signature, 'provenance.signature'),
    slot: bigint(provenance.slot, 'provenance.slot'),
    transactionIndex: index(provenance.transactionIndex, 'provenance.transactionIndex'),
    capturedAt: isoTimestamp(provenance.capturedAt, 'provenance.capturedAt'),
  });
  if (
    parsedProvenance.signature !== parsedTransaction.signature
    || parsedProvenance.slot !== parsedTransaction.slot
    || parsedProvenance.transactionIndex !== parsedTransaction.transactionIndex
  ) {
    throw new Error('provenance.signature, slot ou transactionIndex ne correspond pas à la transaction.');
  }
  return Object.freeze({
    schemaVersion: fixed(root.schemaVersion, 'solana-mainnet-fixture.v1', 'fixture.schemaVersion'),
    family: fixed(root.family, expectedFamily, 'fixture.family'),
    sanitization: Object.freeze({
      contract: fixed(
        sanitization.contract,
        'normalized-public-chain.v1',
        'sanitization.contract',
      ),
      anonymized: fixedBoolean(sanitization.anonymized, false, 'sanitization.anonymized'),
    }),
    provenance: parsedProvenance,
    transaction: parsedTransaction,
  });
}

function parseTransaction(value: Record<string, unknown>): NormalizedTransaction {
  exactKeys(value, [
    'signature', 'slot', 'transactionIndex', 'confirmationStatus', 'version', 'blockTimeMs',
    'instructions', 'preTokenBalances', 'postTokenBalances', 'feeLamports', 'computeUnits', 'error',
  ], 'transaction');
  if (value.confirmationStatus !== 'FINALIZED') {
    throw new Error('transaction.confirmationStatus doit être FINALIZED.');
  }
  const confirmationStatus = value.confirmationStatus;
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
    instructions: Object.freeze(frozenArray(value.instructions, 'transaction.instructions').map((item, indexValue) =>
      parseInstruction(object(item, `transaction.instructions[${indexValue}]`)))),
    preTokenBalances: Object.freeze(frozenArray(value.preTokenBalances, 'transaction.preTokenBalances').map((item, indexValue) =>
      parseTokenBalance(object(item, `transaction.preTokenBalances[${indexValue}]`)))),
    postTokenBalances: Object.freeze(frozenArray(value.postTokenBalances, 'transaction.postTokenBalances').map((item, indexValue) =>
      parseTokenBalance(object(item, `transaction.postTokenBalances[${indexValue}]`)))),
    preBalancesLamports: Object.freeze([]),
    postBalancesLamports: Object.freeze([]),
    feeLamports: bigint(value.feeLamports, 'transaction.feeLamports'),
    computeUnits: nullableBigint(value.computeUnits, 'transaction.computeUnits'),
    logs: Object.freeze([]),
    error: fixed(value.error, null, 'transaction.error'),
  });
}

function parseInstruction(value: Record<string, unknown>): NormalizedInstruction {
  exactKeys(value, [
    'programId', 'accounts', 'dataHex', 'instructionIndex', 'innerInstructionIndex',
    'parentInstructionIndex', 'stackHeight',
  ], 'instruction');
  const dataHex = string(value.dataHex, 'instruction.dataHex');
  if (!/^(?:[a-fA-F0-9]{2})*$/u.test(dataHex)) {
    throw new Error('instruction.dataHex doit être hexadécimal.');
  }
  return Object.freeze({
    programId: string(value.programId, 'instruction.programId'),
    accounts: Object.freeze(frozenArray(value.accounts, 'instruction.accounts').map((item, indexValue) =>
      string(item, `instruction.accounts[${indexValue}]`))),
    data: Uint8Array.from(Buffer.from(dataHex, 'hex')),
    instructionIndex: index(value.instructionIndex, 'instruction.instructionIndex'),
    innerInstructionIndex: nullableIndex(value.innerInstructionIndex, 'instruction.innerInstructionIndex'),
    parentInstructionIndex: nullableIndex(value.parentInstructionIndex, 'instruction.parentInstructionIndex'),
    stackHeight: nullableIndex(value.stackHeight, 'instruction.stackHeight'),
  });
}

function parseTokenBalance(value: Record<string, unknown>): NormalizedTokenBalance {
  exactKeys(value, [
    'accountIndex', 'account', 'mint', 'owner', 'tokenProgram', 'amountRaw', 'decimals',
  ], 'balance');
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
  if (typeof value !== 'string' || !/^(?:0|-?[1-9]\d*)$/u.test(value)) {
    throw new Error(`${path} doit être un entier décimal sérialisé.`);
  }
  return BigInt(value);
}

function nullableBigint(value: unknown, path: string): bigint | null {
  return value === null ? null : bigint(value, path);
}

function fixed<T extends string | null>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new Error(`${path} inattendu.`);
  return expected;
}

function fixedBoolean<T extends boolean>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new Error(`${path} inattendu.`);
  return expected;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, indexValue) => key !== canonical[indexValue])) {
    throw new Error(`${path}: clés hors contrat.`);
  }
}

function isoTimestamp(value: unknown, path: string): string {
  const parsed = string(value, path);
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== parsed) {
    throw new Error(`${path} doit être ISO-8601 canonique.`);
  }
  return parsed;
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  BuildRecipientSelectionV1,
  UnsignedBuildPlanV1,
} from '../../src/executor-simulation/build-plan.js';

const FIXTURE = new URL('../fixtures/executor-simulation/pumpswap-sell-plan.json', import.meta.url);
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export async function loadPumpSwapSellGoldenPlan(): Promise<UnsignedBuildPlanV1> {
  return (await loadPumpSwapSellGoldenFixture()).plan;
}

export async function loadPumpSwapSellGoldenFixture(): Promise<Readonly<{
  readonly plan: UnsignedBuildPlanV1;
  readonly buildFingerprint: string;
}>> {
  const fixture = record(
    JSON.parse(await readFile(FIXTURE, 'utf8')) as unknown,
    ['schemaVersion', 'caseId', 'plan', 'expected'],
  );
  assert.equal(fixture.schemaVersion, 'execution-build-plan-golden.v1');
  assert.equal(fixture.caseId, 'pumpswap-sell-complex');
  return Object.freeze({
    plan: loadPlan(fixture.plan),
    buildFingerprint: validateExpected(fixture.expected),
  });
}

export function executionBuildFingerprint(plan: UnsignedBuildPlanV1): string {
  const segments = ['execution-build-v1', plan.feePayer];
  for (const instruction of plan.instructions) {
    segments.push(instruction.programId);
    for (const account of instruction.accounts) {
      segments.push(
        account.address,
        account.isSigner ? 'SIGNER' : 'NOT_SIGNER',
        account.isWritable ? 'WRITABLE' : 'READONLY',
      );
    }
    segments.push(createHash('sha256')
      .update(Buffer.from(instruction.dataBase64, 'base64')).digest('hex'));
  }
  const hash = createHash('sha256');
  for (const segment of segments) {
    const bytes = Buffer.from(segment, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest('hex');
}

function loadPlan(value: unknown): UnsignedBuildPlanV1 {
  const plan = record(value, [
    'payloadVersion', 'venue', 'side', 'feePayer', 'identity', 'amounts',
    'expectedAccounts', 'policyEvidence', 'instructions',
  ]);
  assert.equal(plan.payloadVersion, 1);
  assert.equal(plan.venue, 'PUMP_SWAP');
  assert.equal(plan.side, 'SELL');
  const identity = record(plan.identity, [
    'mint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram', 'quoteDecimals',
    'snapshotSlot', 'quoteFingerprint', 'snapshotFingerprint',
  ]);
  const quoteFingerprint = sha256(identity.quoteFingerprint);
  const snapshotFingerprint = sha256(identity.snapshotFingerprint);
  const amounts = record(plan.amounts, [
    'amountInRaw', 'expectedAmountOutRaw', 'protectedAmountOutRaw',
  ]);
  const evidence = record(plan.policyEvidence, [
    'payloadVersion', 'venue', 'snapshotSlot', 'snapshotFingerprint', 'isMayhemMode',
    'poolAddress', 'isCashbackCoin', 'coinCreator', 'requiresExtend',
    'userQuoteAtaExisted', 'feeSelection', 'buybackSelection',
  ]);
  assert.equal(evidence.payloadVersion, 1);
  assert.equal(evidence.venue, 'PUMP_SWAP');
  assert.equal(decimalBigInt(evidence.snapshotSlot), decimalBigInt(identity.snapshotSlot));
  assert.equal(sha256(evidence.snapshotFingerprint), snapshotFingerprint);
  const loaded: UnsignedBuildPlanV1 = {
    payloadVersion: 1,
    venue: 'PUMP_SWAP',
    side: 'SELL',
    feePayer: string(plan.feePayer),
    identity: {
      mint: string(identity.mint),
      quoteMint: string(identity.quoteMint),
      baseTokenProgram: tokenProgram(identity.baseTokenProgram),
      quoteTokenProgram: tokenProgram(identity.quoteTokenProgram),
      quoteDecimals: integer(identity.quoteDecimals),
      snapshotSlot: decimalBigInt(identity.snapshotSlot),
      quoteFingerprint,
      snapshotFingerprint,
    },
    amounts: {
      amountInRaw: decimalBigInt(amounts.amountInRaw),
      expectedAmountOutRaw: decimalBigInt(amounts.expectedAmountOutRaw),
      protectedAmountOutRaw: decimalBigInt(amounts.protectedAmountOutRaw),
    },
    expectedAccounts: array(plan.expectedAccounts).map((candidate) => {
      const account = record(candidate, ['role', 'address']);
      return { role: string(account.role), address: string(account.address) };
    }),
    policyEvidence: {
      payloadVersion: 1,
      venue: 'PUMP_SWAP',
      snapshotSlot: decimalBigInt(evidence.snapshotSlot),
      snapshotFingerprint: sha256(evidence.snapshotFingerprint),
      isMayhemMode: boolean(evidence.isMayhemMode),
      poolAddress: string(evidence.poolAddress),
      isCashbackCoin: boolean(evidence.isCashbackCoin),
      coinCreator: string(evidence.coinCreator),
      requiresExtend: boolean(evidence.requiresExtend),
      userQuoteAtaExisted: boolean(evidence.userQuoteAtaExisted),
      feeSelection: selection(evidence.feeSelection),
      buybackSelection: selection(evidence.buybackSelection),
    },
    instructions: array(plan.instructions).map((candidate) => {
      const instruction = record(candidate, ['programId', 'accounts', 'dataBase64']);
      return {
        programId: string(instruction.programId),
        accounts: array(instruction.accounts).map((accountValue) => {
          const account = record(accountValue, ['address', 'isSigner', 'isWritable']);
          return {
            address: string(account.address),
            isSigner: boolean(account.isSigner),
            isWritable: boolean(account.isWritable),
          };
        }),
        dataBase64: base64(instruction.dataBase64),
      };
    }),
  };
  return deepFreeze(loaded);
}

function selection(value: unknown): BuildRecipientSelectionV1 {
  const candidate = record(value, [
    'role', 'selectionMethod', 'listKind', 'candidates', 'selectedIndex', 'selectedAddress',
  ]);
  assert.equal(candidate.selectionMethod, 'SDK_RANDOM');
  const role = literal(candidate.role, ['FEE', 'BUYBACK_FEE'] as const);
  return {
    role,
    selectionMethod: 'SDK_RANDOM',
    listKind: literal(candidate.listKind, ['NORMAL', 'RESERVED', 'BUYBACK'] as const),
    candidates: array(candidate.candidates).map(string),
    selectedIndex: integer(candidate.selectedIndex),
    selectedAddress: string(candidate.selectedAddress),
  };
}

function validateExpected(value: unknown): string {
  const expected = record(value, [
    'buildFingerprint', 'instructionKinds', 'instructionAccountCounts',
  ]);
  const buildFingerprint = sha256(expected.buildFingerprint);
  array(expected.instructionKinds).forEach((candidate) => { string(candidate); });
  array(expected.instructionAccountCounts).forEach((candidate) => { integer(candidate); });
  return buildFingerprint;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function string(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value as string;
}

function boolean(value: unknown): boolean {
  assert.equal(typeof value, 'boolean');
  return value as boolean;
}

function integer(value: unknown): number {
  assert.equal(typeof value, 'number');
  assert.ok(Number.isSafeInteger(value));
  return value as number;
}

function decimalBigInt(value: unknown): bigint {
  const encoded = string(value);
  assert.match(encoded, DECIMAL);
  return BigInt(encoded);
}

function sha256(value: unknown): string {
  const encoded = string(value);
  assert.match(encoded, SHA256);
  return encoded;
}

function base64(value: unknown): string {
  const encoded = string(value);
  assert.equal(Buffer.from(encoded, 'base64').toString('base64'), encoded);
  return encoded;
}

function tokenProgram(value: unknown): 'SPL_TOKEN' | 'TOKEN_2022' {
  return literal(value, ['SPL_TOKEN', 'TOKEN_2022'] as const);
}

function literal<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  const encoded = string(value);
  assert.ok(values.includes(encoded));
  return encoded as T[number];
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

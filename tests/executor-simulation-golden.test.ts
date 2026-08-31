import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PUMP_IDL_REVISION, PUMP_IDL_SHA256, PUMP_INSTRUCTIONS } from '../src/launchpads/pumpfun/generated/pump-idl.js';
import { PUMPSWAP_IDL_REVISION, PUMPSWAP_IDL_SHA256, PUMPSWAP_INSTRUCTIONS } from '../src/markets/pumpswap/generated/pumpswap-idl.js';
import { pumpAmmJson } from '../src/markets/pumpswap/official-sdk.js';
import type {
  BuildRecipientSelectionV1,
  NormalizedInstructionV1,
  UnsignedBuildPlanV1,
} from '../src/executor-simulation/build-plan.js';
import { inspectUnsignedBuildPlan } from '../src/executor-simulation/instruction-inspector.js';

const FIXTURE_ROOT = new URL('./fixtures/executor-simulation/', import.meta.url);
const CASE_FILES = Object.freeze([
  'pumpfun-buy-v2-plan.json',
  'pumpfun-sell-v2-plan.json',
  'pumpswap-sell-plan.json',
] as const);
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

void test('loads the closed golden manifest pinned to local SDK and official IDL versions', async () => {
  const manifest = record(await json('manifest.json'), [
    'schemaVersion', 'specificationVersion', 'parentSpecificationVersion',
    'sdkVersions', 'idl', 'sanitization', 'cases',
  ]);
  assert.equal(manifest.schemaVersion, 'execution-build-plan-golden-manifest.v1');
  assert.equal(manifest.specificationVersion, '1.0.4');
  assert.equal(manifest.parentSpecificationVersion, '1.5.0');

  const rootPackage = record(await json('../../../package.json'), [
    'name', 'version', 'private', 'description', 'type', 'workspaces', 'scripts',
    'dependencies', 'devDependencies', 'engines',
  ]);
  const dependencies = record(rootPackage.dependencies);
  const sdkVersions = record(manifest.sdkVersions, [
    '@pump-fun/pump-sdk', '@pump-fun/pump-swap-sdk', '@solana/web3.js', '@solana/spl-token',
  ]);
  assert.deepEqual(sdkVersions, {
    '@pump-fun/pump-sdk': dependencies['@pump-fun/pump-sdk'],
    '@pump-fun/pump-swap-sdk': dependencies['@pump-fun/pump-swap-sdk'],
    '@solana/web3.js': dependencies['@solana/web3.js'],
    '@solana/spl-token': dependencies['@solana/spl-token'],
  });

  const idl = record(manifest.idl, ['revision', 'pumpSha256', 'pumpSwapSha256']);
  assert.equal(idl.revision, PUMP_IDL_REVISION);
  assert.equal(idl.revision, PUMPSWAP_IDL_REVISION);
  assert.equal(idl.pumpSha256, PUMP_IDL_SHA256);
  assert.equal(idl.pumpSwapSha256, PUMPSWAP_IDL_SHA256);

  const sanitization = record(manifest.sanitization, [
    'publicAccountsOnly', 'instructionBytesOnly', 'containsSecret',
    'containsProviderUrl', 'syntheticPublicKeys',
  ]);
  assert.deepEqual(sanitization, {
    publicAccountsOnly: true,
    instructionBytesOnly: true,
    containsSecret: false,
    containsProviderUrl: false,
    syntheticPublicKeys: true,
  });

  const cases = array(manifest.cases).map((value) => record(value, ['caseId', 'file']));
  assert.deepEqual(cases.map(({ file }) => file), CASE_FILES);
  assert.deepEqual(cases.map(({ caseId }) => caseId), [
    'pumpfun-buy-v2-base-ata-absent',
    'pumpfun-sell-v2-mayhem',
    'pumpswap-sell-complex',
  ]);
});

for (const filename of CASE_FILES) {
  void test(`inspects the exact immutable golden plan: ${filename}`, async () => {
    const fixture = record(await json(filename), ['schemaVersion', 'caseId', 'plan', 'expected']);
    assert.equal(fixture.schemaVersion, 'execution-build-plan-golden.v1');
    assertNoSensitiveMaterial(fixture);
    const plan = loadPlan(fixture.plan);
    assert.ok(Object.isFrozen(plan));
    assert.ok(Object.isFrozen(plan.instructions));
    assert.ok(Object.isFrozen(plan.instructions[0]?.accounts));

    const expected = record(fixture.expected, [
      'buildFingerprint', 'instructionKinds', 'instructionAccountCounts',
    ]);
    const instructionKinds = array(expected.instructionKinds).map(string);
    const instructionAccountCounts = array(expected.instructionAccountCounts).map(integer);
    assert.equal(buildFingerprint(plan), string(expected.buildFingerprint));
    assert.deepEqual(plan.instructions.map(({ accounts }) => accounts.length), instructionAccountCounts);
    assert.deepEqual(classifyInstructions(plan.instructions), instructionKinds);

    const inspected = inspectUnsignedBuildPlan(plan);
    assert.deepEqual(inspected.instructions, plan.instructions);
    assert.deepEqual(inspected.amounts, plan.amounts);
    assert.deepEqual(inspected.identity, plan.identity);
    assertUniqueFeePayerSigner(plan);
    assertExactTradeData(plan);
  });
}

function loadPlan(value: unknown): UnsignedBuildPlanV1 {
  const plan = record(value, [
    'payloadVersion', 'venue', 'side', 'feePayer', 'identity', 'amounts',
    'expectedAccounts', 'policyEvidence', 'instructions',
  ]);
  const identity = record(plan.identity, [
    'mint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram', 'quoteDecimals',
    'snapshotSlot', 'quoteFingerprint', 'snapshotFingerprint',
  ]);
  const amounts = record(plan.amounts, [
    'amountInRaw', 'expectedAmountOutRaw', 'protectedAmountOutRaw',
  ]);
  const expectedAccounts = array(plan.expectedAccounts).map((account) => {
    const item = record(account, ['role', 'address']);
    return { role: string(item.role), address: string(item.address) };
  });
  const evidence = record(plan.policyEvidence);
  const venue = literal(plan.venue, ['PUMP_FUN', 'PUMP_SWAP'] as const);
  const commonEvidence = {
    payloadVersion: one(evidence.payloadVersion),
    venue,
    snapshotSlot: decimalBigInt(evidence.snapshotSlot),
    snapshotFingerprint: string(evidence.snapshotFingerprint),
    isMayhemMode: boolean(evidence.isMayhemMode),
  };
  const policyEvidence = venue === 'PUMP_FUN'
    ? (() => {
      exactKeys(evidence, [
        'payloadVersion', 'venue', 'snapshotSlot', 'snapshotFingerprint', 'isMayhemMode',
        'curveAddress', 'creator', 'userBaseAtaExisted', 'feeSelection', 'buybackSelection',
      ]);
      return {
        ...commonEvidence,
        venue,
        curveAddress: string(evidence.curveAddress),
        creator: string(evidence.creator),
        userBaseAtaExisted: boolean(evidence.userBaseAtaExisted),
        feeSelection: selection(evidence.feeSelection),
        buybackSelection: selection(evidence.buybackSelection),
      };
    })()
    : (() => {
      exactKeys(evidence, [
        'payloadVersion', 'venue', 'snapshotSlot', 'snapshotFingerprint', 'isMayhemMode',
        'poolAddress', 'isCashbackCoin', 'coinCreator', 'requiresExtend',
        'userQuoteAtaExisted', 'feeSelection', 'buybackSelection',
      ]);
      return {
        ...commonEvidence,
        venue,
        poolAddress: string(evidence.poolAddress),
        isCashbackCoin: boolean(evidence.isCashbackCoin),
        coinCreator: string(evidence.coinCreator),
        requiresExtend: boolean(evidence.requiresExtend),
        userQuoteAtaExisted: boolean(evidence.userQuoteAtaExisted),
        feeSelection: selection(evidence.feeSelection),
        buybackSelection: selection(evidence.buybackSelection),
      };
    })();
  const loaded: UnsignedBuildPlanV1 = {
    payloadVersion: one(plan.payloadVersion),
    venue,
    side: literal(plan.side, ['BUY', 'SELL'] as const),
    feePayer: string(plan.feePayer),
    identity: {
      mint: string(identity.mint),
      quoteMint: string(identity.quoteMint),
      baseTokenProgram: literal(identity.baseTokenProgram, ['SPL_TOKEN', 'TOKEN_2022'] as const),
      quoteTokenProgram: literal(identity.quoteTokenProgram, ['SPL_TOKEN', 'TOKEN_2022'] as const),
      quoteDecimals: integer(identity.quoteDecimals),
      snapshotSlot: decimalBigInt(identity.snapshotSlot),
      quoteFingerprint: string(identity.quoteFingerprint),
      snapshotFingerprint: string(identity.snapshotFingerprint),
    },
    amounts: {
      amountInRaw: decimalBigInt(amounts.amountInRaw),
      expectedAmountOutRaw: decimalBigInt(amounts.expectedAmountOutRaw),
      protectedAmountOutRaw: decimalBigInt(amounts.protectedAmountOutRaw),
    },
    expectedAccounts,
    policyEvidence,
    instructions: array(plan.instructions).map((instruction) => {
      const item = record(instruction, ['programId', 'accounts', 'dataBase64']);
      return {
        programId: string(item.programId),
        accounts: array(item.accounts).map((account) => {
          const meta = record(account, ['address', 'isSigner', 'isWritable']);
          return {
            address: string(meta.address),
            isSigner: boolean(meta.isSigner),
            isWritable: boolean(meta.isWritable),
          };
        }),
        dataBase64: string(item.dataBase64),
      };
    }),
  };
  return deepFreeze(loaded);
}

function selection(value: unknown): BuildRecipientSelectionV1 {
  const item = record(value);
  const role = literal(item.role, ['FEE', 'BUYBACK_FEE'] as const);
  const listKind = literal(item.listKind, ['NORMAL', 'RESERVED', 'BUYBACK'] as const);
  const common = {
    role,
    listKind,
    candidates: array(item.candidates).map(string),
    selectedIndex: integer(item.selectedIndex),
    selectedAddress: string(item.selectedAddress),
  };
  if (item.selectionMethod === 'SDK_RANDOM') {
    exactKeys(item, [
      'role', 'selectionMethod', 'listKind', 'candidates', 'selectedIndex', 'selectedAddress',
    ]);
    return { ...common, selectionMethod: 'SDK_RANDOM' };
  }
  exactKeys(item, [
    'role', 'domain', 'listKind', 'candidates', 'selectionHash',
    'selectedIndex', 'selectedAddress',
  ]);
  return {
    ...common,
    domain: string(item.domain),
    selectionHash: string(item.selectionHash),
  };
}

function assertExactTradeData(plan: UnsignedBuildPlanV1): void {
  const main = plan.instructions.find(({ programId, dataBase64 }) => (
    plan.venue === 'PUMP_FUN'
      ? programId === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
      : programId === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
        && Buffer.from(dataBase64, 'base64').length === 24
  ));
  assert.ok(main);
  const data = Buffer.from(main.dataBase64, 'base64');
  const definition = plan.venue === 'PUMP_FUN'
    ? PUMP_INSTRUCTIONS[plan.side === 'BUY' ? 'buy_v2' : 'sell_v2']
    : PUMPSWAP_INSTRUCTIONS.sell;
  assert.deepEqual(data.subarray(0, 8), Buffer.from(definition.discriminator));
  assert.equal(data.length, 24);
  assert.equal(
    data.readBigUInt64LE(8),
    plan.side === 'BUY' ? plan.amounts.protectedAmountOutRaw : plan.amounts.amountInRaw,
  );
  assert.equal(
    data.readBigUInt64LE(16),
    plan.side === 'BUY' ? plan.amounts.amountInRaw : plan.amounts.protectedAmountOutRaw,
  );
  assert.equal(main.accounts.length, definition.accounts.length
    + (plan.venue === 'PUMP_SWAP' && plan.policyEvidence.venue === 'PUMP_SWAP'
      ? 2 + Number(plan.policyEvidence.isCashbackCoin) * 2
        + Number(plan.policyEvidence.coinCreator !== '11111111111111111111111111111111')
      : 0));
}

function classifyInstructions(instructions: readonly NormalizedInstructionV1[]): readonly string[] {
  const extend = officialPumpSwapDiscriminator('extend_account');
  return instructions.map((instruction) => {
    const data = Buffer.from(instruction.dataBase64, 'base64');
    if (instruction.programId === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
      && data.equals(Buffer.from([1]))) return 'ATA_IDEMPOTENT';
    if (instruction.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
      && data.equals(Buffer.from([9]))) return 'CloseAccount';
    if (data.equals(extend)) return 'extend_account';
    if (data.subarray(0, 8).equals(Buffer.from(PUMP_INSTRUCTIONS.buy_v2.discriminator))) return 'buy_v2';
    if (data.subarray(0, 8).equals(Buffer.from(PUMP_INSTRUCTIONS.sell_v2.discriminator))) return 'sell_v2';
    if (data.subarray(0, 8).equals(Buffer.from(PUMPSWAP_INSTRUCTIONS.sell.discriminator))) return 'sell';
    throw new Error('Unknown golden instruction.');
  });
}

function buildFingerprint(plan: UnsignedBuildPlanV1): string {
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
    segments.push(createHash('sha256').update(Buffer.from(instruction.dataBase64, 'base64')).digest('hex'));
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

function assertUniqueFeePayerSigner(plan: UnsignedBuildPlanV1): void {
  const signers = plan.instructions.flatMap(({ accounts }) => accounts.filter(({ isSigner }) => isSigner));
  assert.ok(signers.length > 0);
  assert.deepEqual([...new Set(signers.map(({ address }) => address))], [plan.feePayer]);
}

function assertNoSensitiveMaterial(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    assert.doesNotMatch(value, /(?:https?:\/\/|-----BEGIN|\$\{[^}]+\})/u, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertNoSensitiveMaterial(child, `${path}[${index}]`);
    });
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, /^(?:secret|privateKey|keypair|rpcUrl|httpRpcUrl|headers|signature|transactionBase64|messageBase64|logs)$/iu, `${path}.${key}`);
    assertNoSensitiveMaterial(child, `${path}.${key}`);
  }
}

function officialPumpSwapDiscriminator(name: string): Buffer {
  const instruction = (pumpAmmJson.instructions as readonly {
    readonly name: string;
    readonly discriminator: readonly number[];
  }[]).find(({ name: candidate }) => candidate === name);
  assert.ok(instruction);
  return Buffer.from(instruction.discriminator);
}

async function json(filename: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(filename, FIXTURE_ROOT), 'utf8')) as unknown;
}

function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  assert.ok(isPlainRecord(value));
  if (keys !== undefined) exactKeys(value, keys);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
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

function one(value: unknown): 1 {
  assert.equal(value, 1);
  return 1;
}

function decimalBigInt(value: unknown): bigint {
  const encoded = string(value);
  assert.match(encoded, DECIMAL);
  return BigInt(encoded);
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

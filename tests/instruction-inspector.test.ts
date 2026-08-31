import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { buildPumpFunPlan, type PumpFunBuildRequestV1 } from '../src/executor-simulation/pumpfun-adapter.js';
import {
  InstructionInspectionError,
  inspectUnsignedBuildPlan,
} from '../src/executor-simulation/instruction-inspector.js';
import { bondingCurvePda, PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/official-sdk.js';
import { PUMPSWAP_INSTRUCTIONS } from '../src/markets/pumpswap/generated/pumpswap-idl.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import {
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  GLOBAL_CONFIG_PDA,
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
  poolV2Pda,
  poolPda,
  pumpAmmJson,
  pumpPoolAuthorityPda,
  userVolumeAccumulatorPda,
} from '../src/markets/pumpswap/official-sdk.js';

void test('inspects a real canonical Pump.fun SELL plan into fresh gateway inputs', async () => {
  const input = request();
  const plan = await buildPumpFunPlan(input);

  const inspected = inspectUnsignedBuildPlan(plan);

  assert.equal(inspected.feePayer, input.user);
  assert.equal(inspected.instructions.length, 1);
  assert.deepEqual(inspected.instructions, plan.instructions);
  assert.deepEqual(inspected.identity, plan.identity);
  assert.deepEqual(inspected.amounts, plan.amounts);
  assert.throws(() => { Object.defineProperty(inspected.instructions[0] as object, 'accounts', { value: [] }); }, TypeError);
  assert.throws(() => { (inspected.identity as { mint: string }).mint = key(250); }, TypeError);
});

void test('retains the exact idempotent base-ATA setup for a Pump.fun BUY', async () => {
  const base = request();
  const input = deepFreeze({
    ...base,
    quote: { ...base.quote, side: 'BUY' as const },
    userBaseTokenAccount: { ...base.userBaseTokenAccount, exists: false },
  }) as PumpFunBuildRequestV1;
  const plan = await buildPumpFunPlan(input);
  const inspected = inspectUnsignedBuildPlan(plan);
  assert.equal(plan.instructions.length, 2);
  assert.equal(inspected.instructions.length, 2);
  assert.equal(inspected.instructions[0]?.programId, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
});

void test('binds Pump.fun policy flags, snapshot and addresses to the exact instruction branch', async () => {
  const base = request();
  const mayhemInput = deepFreeze({
    ...base,
    quote: { ...base.quote, side: 'BUY' as const },
    curve: { ...base.curve, isMayhemMode: true },
    userBaseTokenAccount: { ...base.userBaseTokenAccount, exists: false },
  }) as PumpFunBuildRequestV1;
  const plan = await buildPumpFunPlan(mayhemInput);
  assert.equal(inspectUnsignedBuildPlan(plan).instructions.length, 2);
  assert.equal(plan.policyEvidence.feeSelection.listKind, 'RESERVED');
  const selectedFeeIndex = plan.policyEvidence.feeSelection.selectedIndex;
  const main = plan.instructions[1];
  const userQuoteAta = getAssociatedTokenAddressSync(
    NATIVE_MINT, new PublicKey(plan.feePayer), true, TOKEN_PROGRAM_ID,
  ).toBase58();
  assert.ok(main);

  const cases: unknown[] = [
    deepFreeze({ ...plan, policyEvidence: { ...plan.policyEvidence, curveAddress: key(231) } }),
    deepFreeze({ ...plan, policyEvidence: { ...plan.policyEvidence, creator: key(232) } }),
    deepFreeze({ ...plan, policyEvidence: { ...plan.policyEvidence, isMayhemMode: false } }),
    deepFreeze({ ...plan, policyEvidence: { ...plan.policyEvidence, snapshotFingerprint: 'c'.repeat(64) } }),
    deepFreeze({ ...plan, policyEvidence: { ...plan.policyEvidence, userBaseAtaExisted: true } }),
    deepFreeze({ ...plan, instructions: plan.instructions.slice(1) }),
    deepFreeze({
      ...plan,
      policyEvidence: {
        ...plan.policyEvidence,
        feeSelection: {
          ...plan.policyEvidence.feeSelection,
          candidates: plan.policyEvidence.feeSelection.candidates.map((candidate, index) => (
            index === selectedFeeIndex ? plan.feePayer : candidate
          )),
          selectedAddress: plan.feePayer,
        },
      },
      instructions: [plan.instructions[0], {
        ...main,
        accounts: main.accounts.map((account, index) => (
          index === 6 ? { ...account, address: plan.feePayer }
            : index === 7 ? { ...account, address: userQuoteAta }
              : account
        )),
      }],
    }),
    deepFreeze({
      ...plan,
      policyEvidence: {
        ...plan.policyEvidence,
        feeSelection: { ...plan.policyEvidence.feeSelection, selectedAddress: key(233) },
      },
    }),
    deepFreeze({
      ...plan,
      policyEvidence: {
        ...plan.policyEvidence,
        feeSelection: {
          ...plan.policyEvidence.feeSelection,
          candidates: plan.policyEvidence.feeSelection.candidates.map((candidate, index) => (
            index === plan.policyEvidence.feeSelection.selectedIndex ? key(234) : candidate
          )),
        },
      },
    }),
  ];
  for (const candidate of cases) rejects(candidate);

  const sell = await buildPumpFunPlan(base);
  rejects(deepFreeze({
    ...sell,
    policyEvidence: { ...sell.policyEvidence, userBaseAtaExisted: false },
  }));
});

void test('rejects forbidden instruction mutations and unsigned-plan privilege escalation', async () => {
  const plan = await buildPumpFunPlan(request());
  const swap = plan.instructions[0];
  assert.ok(swap);
  const alteredData = Buffer.from(swap.dataBase64, 'base64');
  alteredData[8] = (alteredData[8] ?? 0) + 1;
  const cases: unknown[] = [
    deepFreeze({ ...plan, instructions: [{ ...swap, dataBase64: alteredData.toString('base64') }] }),
    deepFreeze({ ...plan, instructions: [{ ...swap, accounts: swap.accounts.map((account, index) => index === 0
      ? { ...account, isSigner: true } : account) }] }),
    deepFreeze({ ...plan, policyEvidence: {
      ...plan.policyEvidence,
      feeSelection: { ...plan.policyEvidence.feeSelection, selectionHash: 'f'.repeat(64) },
    } }),
    deepFreeze({ ...plan, instructions: [...plan.instructions, swap] }),
  ];
  for (const candidate of cases) rejects(candidate);
});

void test('rejects proxy and accessor payloads without invoking hostile getters', async () => {
  const plan = await buildPumpFunPlan(request());
  let getterCalls = 0;
  const accessor = Object.freeze(Object.defineProperty({ ...plan }, 'feePayer', {
    enumerable: true,
    get(): string { getterCalls += 1; return plan.feePayer; },
  }));
  rejects(new Proxy(plan, {}));
  rejects(accessor);
  assert.equal(getterCalls, 0);
});

void test('inspects a sanitized canonical PumpSwap SELL and rejects vault-authority and remaining-meta mutations', () => {
  const plan = pumpSwapPlan();
  const inspected = inspectUnsignedBuildPlan(plan);
  assert.equal(inspected.instructions.length, 2);
  assert.equal(inspected.feePayer, plan.feePayer);
  const sell = plan.instructions[0];
  assert.ok(sell);
  const cases: unknown[] = [
    deepFreeze({ ...plan, instructions: [{ ...sell, accounts: sell.accounts.map((account, index) => index === 0
      ? { ...account, address: key(240) } : account) }, plan.instructions[1]] }),
    deepFreeze({ ...plan, instructions: [{ ...sell, accounts: sell.accounts.map((account, index) => index === 2
      ? { ...account, address: key(241) } : account) }, plan.instructions[1]] }),
    deepFreeze({ ...plan, instructions: [{ ...sell, accounts: sell.accounts.map((account, index) => index === 7
      ? { ...account, address: key(242) } : account) }, plan.instructions[1]] }),
    deepFreeze({ ...plan, instructions: [{ ...sell, accounts: sell.accounts.map((account, index) => index === 17
      ? { ...account, address: key(250) } : account) }, plan.instructions[1]] }),
    deepFreeze({ ...plan, instructions: [{ ...sell, accounts: sell.accounts.map((account, index) => index === 18
      ? { ...account, address: key(251) } : account) }, plan.instructions[1]] }),
    deepFreeze({ ...plan, instructions: [{ ...sell, accounts: [...sell.accounts.slice(0, -2), {
      address: key(252), isSigner: false, isWritable: true,
    }, ...sell.accounts.slice(-2)] }, plan.instructions[1]] }),
  ];
  for (const candidate of cases) rejects(candidate);
});

void test('accepts and binds the combined PumpSwap cashback, creator, extension and ATA branches', () => {
  const plan = pumpSwapPlan({ cashback: true, coinCreator: true, extend: true, quoteAtaExisted: false, mayhem: true });
  const inspected = inspectUnsignedBuildPlan(plan);
  assert.equal(inspected.instructions.length, 4);
  assert.deepEqual(plan.expectedAccounts.map(({ role }) => role), [
    'POOL', 'POOL_BASE_VAULT', 'POOL_QUOTE_VAULT', 'USER_BASE_ATA', 'USER_QUOTE_ATA',
    'POOL_COIN_CREATOR', 'USER_VOLUME_ACCUMULATOR', 'USER_VOLUME_QUOTE_ATA', 'POOL_V2',
  ]);

  const cases: unknown[] = [
    deepFreeze({ ...plan, policyEvidence: { ...plan.policyEvidence, poolAddress: key(220) } }),
    deepFreeze({ ...plan, policyEvidence: { ...plan.policyEvidence, coinCreator: key(221) } }),
    deepFreeze({ ...plan, policyEvidence: { ...plan.policyEvidence, isCashbackCoin: false } }),
    deepFreeze({ ...plan, policyEvidence: { ...plan.policyEvidence, requiresExtend: false } }),
    deepFreeze({ ...plan, policyEvidence: { ...plan.policyEvidence, userQuoteAtaExisted: true } }),
    deepFreeze({ ...plan, policyEvidence: { ...plan.policyEvidence, isMayhemMode: false } }),
    deepFreeze({ ...plan, policyEvidence: { ...plan.policyEvidence, snapshotFingerprint: 'd'.repeat(64) } }),
    deepFreeze({ ...plan, expectedAccounts: plan.expectedAccounts.map((account, index) => index === 5
      ? { ...account, address: key(222) } : account) }),
    deepFreeze({ ...plan, instructions: plan.instructions.map((instruction, index) => index === 0
      ? { ...instruction, programId: key(225) } : instruction) }),
    deepFreeze({ ...plan, instructions: plan.instructions.slice(1) }),
    deepFreeze({
      ...plan,
      policyEvidence: {
        ...plan.policyEvidence,
        buybackSelection: { ...plan.policyEvidence.buybackSelection, selectedAddress: key(223) },
      },
    }),
    deepFreeze({
      ...plan,
      policyEvidence: {
        ...plan.policyEvidence,
        buybackSelection: {
          ...plan.policyEvidence.buybackSelection,
          candidates: plan.policyEvidence.buybackSelection.candidates.map((candidate, index) => (
            index === plan.policyEvidence.buybackSelection.selectedIndex ? key(224) : candidate
          )),
        },
      },
    }),
  ];
  for (const candidate of cases) rejects(candidate);
});

function request(): PumpFunBuildRequestV1 {
  const mint = key(20);
  const user = key(10);
  return Object.freeze({
    quote: Object.freeze({
      payloadVersion: 1,
      venue: 'PUMP_FUN',
      side: 'SELL',
      mint,
      quoteMint: NATIVE_MINT.toBase58(),
      baseTokenProgram: 'SPL_TOKEN',
      quoteTokenProgram: 'SPL_TOKEN',
      quoteDecimals: 9,
      amountInRaw: 1_000_000n,
      expectedAmountOutRaw: 900_000n,
      protectedAmountOutRaw: 850_000n,
      snapshotSlot: 123n,
      quoteFingerprint: '0'.repeat(64),
      snapshotFingerprint: '1'.repeat(64),
    }),
    user,
    curve: Object.freeze({
      mint,
      address: bondingCurvePda(new PublicKey(mint)).toBase58(),
      ownerProgramId: PUMP_PROGRAM_ID.toBase58(),
      exists: true,
      complete: false,
      creator: key(30),
      isMayhemMode: false,
    }),
    userBaseTokenAccount: Object.freeze({
      address: getAssociatedTokenAddressSync(
        new PublicKey(mint), new PublicKey(user), true, TOKEN_PROGRAM_ID,
      ).toBase58(),
      exists: true,
    }),
    recipients: Object.freeze({
      feeRecipient: key(100), feeRecipients: frozenKeys(101, 7),
      reservedFeeRecipient: key(110), reservedFeeRecipients: frozenKeys(111, 7),
      buybackFeeRecipients: frozenKeys(120, 8),
    }),
  });
}

function key(seed: number): string {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256)).toBase58();
}

function frozenKeys(seed: number, length: number): readonly string[] {
  return Object.freeze(Array.from({ length }, (_, index) => key(seed + index)));
}

function pumpSwapPlan(options: Readonly<{
  cashback?: boolean;
  coinCreator?: boolean;
  extend?: boolean;
  quoteAtaExisted?: boolean;
  mayhem?: boolean;
}> = {}) {
  const payer = new PublicKey(key(40));
  const mint = new PublicKey(key(41));
  const pool = poolPda(0, pumpPoolAuthorityPda(mint), mint, NATIVE_MINT).toBase58();
  const baseVault = getAssociatedTokenAddressSync(mint, new PublicKey(pool), true, TOKEN_PROGRAM_ID).toBase58();
  const quoteVault = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(pool), true, TOKEN_PROGRAM_ID).toBase58();
  const baseAta = getAssociatedTokenAddressSync(mint, payer, true, TOKEN_PROGRAM_ID).toBase58();
  const quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, payer, true, TOKEN_PROGRAM_ID).toBase58();
  const feeCandidates = frozenKeys(50, 8);
  const buybackCandidates = frozenKeys(60, 8);
  const fee = new PublicKey(requiredString(feeCandidates, 0));
  const buyback = new PublicKey(requiredString(buybackCandidates, 0));
  const coinCreator = options.coinCreator === true ? new PublicKey(key(70)) : PublicKey.default;
  const userVolume = userVolumeAccumulatorPda(payer);
  const userVolumeQuote = getAssociatedTokenAddressSync(
    NATIVE_MINT, userVolume, true, TOKEN_PROGRAM_ID,
  );
  const poolV2 = poolV2Pda(mint);
  const addresses = [
    pool, payer.toBase58(), GLOBAL_CONFIG_PDA.toBase58(), mint.toBase58(), NATIVE_MINT.toBase58(),
    baseAta, quoteAta, baseVault, quoteVault, fee.toBase58(),
    getAssociatedTokenAddressSync(NATIVE_MINT, fee, true, TOKEN_PROGRAM_ID).toBase58(),
    TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), '11111111111111111111111111111111',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58(),
    PUMP_AMM_PROGRAM_ID.toBase58(),
    coinCreatorVaultAtaPda(coinCreatorVaultAuthorityPda(coinCreator), NATIVE_MINT, TOKEN_PROGRAM_ID).toBase58(),
    coinCreatorVaultAuthorityPda(coinCreator).toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), PUMP_FEE_PROGRAM_ID.toBase58(),
    buyback.toBase58(), getAssociatedTokenAddressSync(NATIVE_MINT, buyback, true, TOKEN_PROGRAM_ID).toBase58(),
  ];
  const data = Buffer.alloc(24);
  data.set(PUMPSWAP_INSTRUCTIONS.sell.discriminator, 0);
  data.writeBigUInt64LE(100n, 8);
  data.writeBigUInt64LE(90n, 16);
  const remaining = [
    ...(options.cashback === true ? [
      Object.freeze({ address: userVolumeQuote.toBase58(), isSigner: false, isWritable: true }),
      Object.freeze({ address: userVolume.toBase58(), isSigner: false, isWritable: true }),
    ] : []),
    ...(options.coinCreator === true ? [
      Object.freeze({ address: poolV2.toBase58(), isSigner: false, isWritable: false }),
    ] : []),
  ];
  const accounts = Object.freeze([
    ...addresses.slice(0, 21).map((address, index) => {
      const definition = PUMPSWAP_INSTRUCTIONS.sell.accounts.at(index);
      if (definition === undefined) throw new Error('PumpSwap IDL account missing.');
      return Object.freeze({
        address,
        isSigner: 'signer' in definition && definition.signer,
        isWritable: 'writable' in definition && definition.writable,
      });
    }),
    ...remaining,
    Object.freeze({ address: requiredString(addresses, 21), isSigner: false, isWritable: false }),
    Object.freeze({ address: requiredString(addresses, 22), isSigner: false, isWritable: true }),
  ]);
  return deepFreeze({
    payloadVersion: 1 as const, venue: 'PUMP_SWAP' as const, side: 'SELL' as const, feePayer: payer.toBase58(),
    identity: {
      mint: mint.toBase58(), quoteMint: NATIVE_MINT.toBase58(), baseTokenProgram: 'SPL_TOKEN' as const,
      quoteTokenProgram: 'SPL_TOKEN' as const, quoteDecimals: 9, snapshotSlot: 1n, quoteFingerprint: 'a'.repeat(64), snapshotFingerprint: 'b'.repeat(64),
    },
    amounts: { amountInRaw: 100n, expectedAmountOutRaw: 100n, protectedAmountOutRaw: 90n },
    expectedAccounts: [
      { role: 'POOL', address: pool }, { role: 'POOL_BASE_VAULT', address: baseVault },
      { role: 'POOL_QUOTE_VAULT', address: quoteVault }, { role: 'USER_BASE_ATA', address: baseAta },
      { role: 'USER_QUOTE_ATA', address: quoteAta }, { role: 'POOL_COIN_CREATOR', address: coinCreator.toBase58() },
      ...(options.cashback === true ? [
        { role: 'USER_VOLUME_ACCUMULATOR', address: userVolume.toBase58() },
        { role: 'USER_VOLUME_QUOTE_ATA', address: userVolumeQuote.toBase58() },
      ] : []),
      ...(options.coinCreator === true ? [{ role: 'POOL_V2', address: poolV2.toBase58() }] : []),
    ],
    policyEvidence: {
      payloadVersion: 1 as const, venue: 'PUMP_SWAP' as const, snapshotSlot: 1n, snapshotFingerprint: 'b'.repeat(64),
      isMayhemMode: options.mayhem === true, isCashbackCoin: options.cashback === true, coinCreator: coinCreator.toBase58(),
      poolAddress: pool,
      requiresExtend: options.extend === true, userQuoteAtaExisted: options.quoteAtaExisted !== false,
      feeSelection:
      { role: 'FEE' as const, selectionMethod: 'SDK_RANDOM' as const, listKind: options.mayhem === true ? 'RESERVED' as const : 'NORMAL' as const, candidates: feeCandidates, selectedIndex: 0, selectedAddress: fee.toBase58() },
      buybackSelection: { role: 'BUYBACK_FEE' as const, selectionMethod: 'SDK_RANDOM' as const, listKind: 'BUYBACK' as const, candidates: buybackCandidates, selectedIndex: 0, selectedAddress: buyback.toBase58() },
    },
    instructions: [
      ...(options.extend === true ? [{
        programId: PUMPSWAP_PROGRAM_ID,
        accounts: [
          { address: pool, isSigner: false, isWritable: true },
          { address: payer.toBase58(), isSigner: true, isWritable: false },
          { address: '11111111111111111111111111111111', isSigner: false, isWritable: false },
          { address: PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58(), isSigner: false, isWritable: false },
          { address: PUMP_AMM_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
        ],
        dataBase64: officialPumpSwapDiscriminator('extend_account').toString('base64'),
      }] : []),
      ...(options.quoteAtaExisted === false ? [{
        programId: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
        accounts: [
          { address: payer.toBase58(), isSigner: true, isWritable: true },
          { address: quoteAta, isSigner: false, isWritable: true },
          { address: payer.toBase58(), isSigner: false, isWritable: false },
          { address: NATIVE_MINT.toBase58(), isSigner: false, isWritable: false },
          { address: '11111111111111111111111111111111', isSigner: false, isWritable: false },
          { address: TOKEN_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
        ], dataBase64: Buffer.from([1]).toString('base64'),
      }] : []),
      { programId: PUMPSWAP_PROGRAM_ID, accounts, dataBase64: data.toString('base64') },
      { programId: TOKEN_PROGRAM_ID.toBase58(), accounts: [
        { address: quoteAta, isSigner: false, isWritable: true },
        { address: payer.toBase58(), isSigner: false, isWritable: true },
        { address: payer.toBase58(), isSigner: true, isWritable: false },
      ], dataBase64: Buffer.from([9]).toString('base64') },
    ],
  });
}

function officialPumpSwapDiscriminator(name: string): Buffer {
  const definition = (pumpAmmJson.instructions as readonly Readonly<{
    readonly name: string;
    readonly discriminator: readonly number[];
  }>[]).find((instruction) => instruction.name === name);
  if (definition === undefined) throw new Error('PumpSwap instruction fixture missing.');
  return Buffer.from(definition.discriminator);
}

function rejects(value: unknown): void {
  assert.throws(
    () => inspectUnsignedBuildPlan(value as never),
    (error: unknown) => error instanceof InstructionInspectionError
      && error.code === 'INSTRUCTION_INSPECTION_REJECTED',
  );
}

function requiredString(values: readonly string[], index: number): string {
  const value = values.at(index);
  if (value === undefined) throw new Error('Test fixture value missing.');
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

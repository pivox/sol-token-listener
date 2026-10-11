import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, StakeInstruction, StakeProgram, SystemInstruction, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import type { AccountInfo, TransactionInstruction } from '@solana/web3.js';
import {
  buildClaimPlan, buildDeactivatePlan, buildDelayedWithdrawPlan,
  decodeJitoStakePool, decodeStakeAccount, decodeValidatorList,
  deriveStakeDestination, deriveValidatorStakeAddress, JITO_POOL_ADDRESS,
  JITO_MINT_ADDRESS, STAKE_POOL_PROGRAM_ID, quoteStakeWithdrawal, readJitoStakePool,
} from '../src/jitosol/stake-pool.js';
import type { StakePoolReadRpc } from '../src/jitosol/stake-pool.js';

const archived = JSON.parse(readFileSync(new URL('./fixtures/jitosol/stake-pool-public.json', import.meta.url), 'utf8')) as {
  epoch: number; account: { owner: string; data: [string, string]; lamports: number };
};
const MAX_U64 = (1n << 64n) - 1n;
const WALLET = key(8);
const TOKEN_ACCOUNT = key(9);
const VOTE = key(10);
const RENT = 2_282_880n;
const EPOCH = BigInt(archived.epoch);

void test('decodes archived Jito pool bytes exactly without floating point conversion', () => {
  const pool = decodeJitoStakePool(poolAccount(), EPOCH);
  assert.equal(pool.poolMint.toBase58(), JITO_MINT_ADDRESS.toBase58());
  assert.equal(pool.lastUpdateEpoch, 1054n);
  assert.equal(pool.totalLamports, 10_451_067_197_081_554n);
  assert.equal(pool.poolTokenSupply, 8_004_084_892_090_038n);
  assert.deepEqual(pool.stakeWithdrawalFee, { denominator: 1_000n, numerator: 1n });
  assert.equal(pool.withdrawAuthority.toBase58(), PublicKey.findProgramAddressSync([
    JITO_POOL_ADDRESS.toBuffer(), Buffer.from('withdraw'),
  ], STAKE_POOL_PROGRAM_ID)[0].toBase58());
});

void test('pool rejects wrong owner, account type, mint, stale epoch and truncated option data', () => {
  assert.throws(() => decodeJitoStakePool({ ...poolAccount(), owner: key(7) }, EPOCH), /owner/);
  const wrongType = poolAccount(); wrongType.data[0] = 2;
  assert.throws(() => decodeJitoStakePool(wrongType, EPOCH), /type/);
  const wrongMint = poolAccount(); key(7).toBuffer().copy(wrongMint.data, 162);
  assert.throws(() => decodeJitoStakePool(wrongMint, EPOCH), /mint/);
  assert.throws(() => decodeJitoStakePool(poolAccount(), EPOCH + 1n), /epoch/);
  assert.throws(() => decodeJitoStakePool({ ...poolAccount(), data: Buffer.alloc(300) }, EPOCH), /type|truncated/);
});

void test('pool parser follows variable-length pending fee and preferred-validator Borsh options', () => {
  const account = poolAccountWithPreferred(VOTE);
  const pendingFee = Buffer.alloc(17); pendingFee[0] = 2;
  pendingFee.writeBigUInt64LE(50n, 1); pendingFee.writeBigUInt64LE(1n, 9);
  account.data = Buffer.concat([account.data.subarray(0, 346), pendingFee, account.data.subarray(347)]);
  const pool = decodeJitoStakePool(account, EPOCH);
  assert.equal(pool.preferredWithdrawValidatorVoteAddress?.toBase58(), VOTE.toBase58());
  assert.deepEqual(pool.stakeWithdrawalFee, { denominator: 1_000n, numerator: 1n });
  account.data[346] = 3;
  assert.throws(() => decodeJitoStakePool(account, EPOCH), /future fee/);
});

void test('withdrawal quote rounds token fees up and redemption down including u64 values above safe number', () => {
  const pool = { ...decodeJitoStakePool(poolAccount(), EPOCH), totalLamports: 13n, poolTokenSupply: 10n };
  assert.deepEqual(quoteStakeWithdrawal(pool, 9n), { feePoolTokens: 1n, burnPoolTokens: 8n, withdrawLamports: 10n });
  const large = { ...pool, totalLamports: MAX_U64, poolTokenSupply: MAX_U64 };
  const quote = quoteStakeWithdrawal(large, 10_000_000_000_000_001n);
  assert.equal(quote.feePoolTokens, 10_000_000_000_001n);
  assert.equal(quote.withdrawLamports, 9_990_000_000_000_000n);
  assert.throws(() => quoteStakeWithdrawal(pool, -1n), /positive|range/);
  assert.throws(() => quoteStakeWithdrawal(pool, MAX_U64 + 1n), /range/);
});

void test('validator list decodes suffixes, rejects invalid length/status and stale entries', () => {
  const account = validatorAccount();
  const [entry] = decodeValidatorList(account, EPOCH);
  assert.equal(entry?.activeStakeLamports, 20_000_000_000n);
  assert.equal(entry?.validatorSeedSuffix, 0);
  assert.equal(entry?.voteAccountAddress.toBase58(), VOTE.toBase58());
  const stale = validatorAccount(); stale.data.writeBigUInt64LE(EPOCH - 1n, 25);
  assert.throws(() => decodeValidatorList(stale, EPOCH), /epoch/);
  const badStatus = validatorAccount(); badStatus.data[49] = 9;
  assert.throws(() => decodeValidatorList(badStatus, EPOCH), /status/);
  const badLength = validatorAccount(); badLength.data.writeUInt32LE(2, 5);
  assert.throws(() => decodeValidatorList(badLength, EPOCH), /length/);
});

void test('deterministic destination uses a 32-byte public seed, separates positions and wallets', async () => {
  const a = await deriveStakeDestination(WALLET, 'position-1');
  const b = await deriveStakeDestination(WALLET, 'position-1');
  assert.equal(Buffer.byteLength(a.stakeSeed), 32);
  assert.equal(a.stakeAccount.toBase58(), b.stakeAccount.toBase58());
  assert.notEqual(a.stakeAccount.toBase58(), (await deriveStakeDestination(WALLET, 'position-2')).stakeAccount.toBase58());
  assert.notEqual(a.stakeAccount.toBase58(), (await deriveStakeDestination(key(7), 'position-1')).stakeAccount.toBase58());
  await assert.rejects(deriveStakeDestination(WALLET, ''), /position/);
});

void test('delayed plan matches official 13-account ABI, exact integer quote and separately funded rent', async () => {
  const plan = await buildDelayedWithdrawPlan({ rpc: rpc(), wallet: WALLET, tokenAccount: TOKEN_ACCOUNT,
    tokenOwner: WALLET, poolTokens: 2_000_000_000n, positionId: 'position-1' });
  assert.equal(plan.instructions.length, 2);
  const create = SystemInstruction.decodeCreateWithSeed(instruction(plan.instructions, 0));
  assert.equal(create.lamports, Number(RENT));
  assert.equal(create.basePubkey.toBase58(), WALLET.toBase58());
  assert.equal(create.programId.toBase58(), StakeProgram.programId.toBase58());
  const withdraw = instruction(plan.instructions, 1);
  assert.equal(withdraw.data.length, 17);
  assert.equal(withdraw.data.subarray(0, 9).toString('hex'), '180094357700000000');
  assert.equal(withdraw.data.readBigUInt64LE(9), 2_608_821_937n);
  const pool = decodeJitoStakePool(poolAccount(), EPOCH);
  assert.deepEqual(withdraw.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
    [JITO_POOL_ADDRESS, false, true], [pool.validatorList, false, true],
    [pool.withdrawAuthority, false, false], [plan.sourceStakeAccount, false, true],
    [plan.stakeAccount, false, true], [WALLET, false, false], [WALLET, true, false],
    [TOKEN_ACCOUNT, false, true], [pool.managerFeeAccount, false, true],
    [JITO_MINT_ADDRESS, false, true], [SYSVAR_CLOCK_PUBKEY, false, false],
    [TOKEN_PROGRAM_ID, false, false], [StakeProgram.programId, false, false],
  ].map(([pubkey, signer, writable]) => [(pubkey as PublicKey).toBase58(), signer, writable]));
  assert.equal(plan.expectedMinimumRedemptionLamports, quoteStakeWithdrawal(pool, 2_000_000_000n).withdrawLamports);
  assert.equal(plan.rentLamports, RENT);
});

void test('guarded withdrawal preserves all eight minimum-output bytes above u32 range', async () => {
  const plan = await buildDelayedWithdrawPlan({ rpc: rpc(), wallet: WALLET, tokenAccount: TOKEN_ACCOUNT,
    tokenOwner: WALLET, poolTokens: 5_000_000_000n, positionId: 'guarded-u64-output' });
  const withdraw = instruction(plan.instructions, 1);
  const expected = quoteStakeWithdrawal(decodeJitoStakePool(poolAccount(), EPOCH), 5_000_000_000n).withdrawLamports;
  assert.ok(expected > 0xffff_ffffn);
  assert.equal(withdraw.data[0], 24);
  assert.equal(withdraw.data.length, 17);
  assert.equal(withdraw.data.readBigUInt64LE(1), 5_000_000_000n);
  assert.equal(withdraw.data.readBigUInt64LE(9), expected);
  assert.equal(plan.expectedMinimumRedemptionLamports, expected);
  assert.ok(withdraw.data.readUInt32LE(13) > 0);
});

void test('archived mainnet simulation recognizes guarded ABI and rejects an excessive minimum before token burn', async () => {
  const evidence = JSON.parse(readFileSync(new URL('./fixtures/jitosol/guarded-withdraw-mainnet.json', import.meta.url), 'utf8')) as {
    probes: { name: string; instructionDataHex: string; err: unknown; logs: string[] }[];
  };
  const guarded = evidence.probes.find((probe) => probe.name === 'guarded-impossible-minimum-before-burn');
  assert.ok(guarded);
  const archivedData = Buffer.from(guarded.instructionDataHex, 'hex');
  const plan = await buildDelayedWithdrawPlan({ rpc: rpc(), wallet: WALLET, tokenAccount: TOKEN_ACCOUNT,
    tokenOwner: WALLET, poolTokens: 2_000_000_000n, positionId: 'archived-guarded-abi' });
  const data = instruction(plan.instructions, 1).data;
  assert.equal(data.length, archivedData.length);
  assert.deepEqual(data.subarray(0, 9), archivedData.subarray(0, 9));
  assert.equal(archivedData.readBigUInt64LE(9), MAX_U64);
  assert.deepEqual(guarded.err, { InstructionError: [0, { Custom: 39 }] });
  assert.ok(guarded.logs.includes('Program log: Instruction: WithdrawStakeWithSlippage'));
  assert.ok(guarded.logs.includes('Program log: Error: Instruction exceeds desired slippage limit'));
  assert.ok(!guarded.logs.some((line) => line.includes(`Program ${TOKEN_PROGRAM_ID.toBase58()} invoke`)));
});

void test('delayed withdrawal refuses insufficient split amount, wrong user owner and existing destination', async () => {
  const input = { rpc: rpc(), wallet: WALLET, tokenAccount: TOKEN_ACCOUNT, tokenOwner: WALLET,
    poolTokens: 2_000_000_000n, positionId: 'position-1' };
  await assert.rejects(buildDelayedWithdrawPlan({ ...input, poolTokens: 100_000n }), /minimum delegation/);
  await assert.rejects(buildDelayedWithdrawPlan({ ...input, tokenOwner: key(7) }), /token owner/);
  const dest = await deriveStakeDestination(WALLET, input.positionId);
  await assert.rejects(buildDelayedWithdrawPlan({ ...input, rpc: rpc(new Map([
    [dest.stakeAccount.toBase58(), stakeAccount(WALLET, WALLET)],
  ])) }), /destination.*exists/);
});

void test('invalid manager fee account causes fee waiver exactly as the on-chain withdraw processor', async () => {
  const pool = decodeJitoStakePool(poolAccount(), EPOCH);
  const plan = await buildDelayedWithdrawPlan({ rpc: rpc(new Map([[pool.managerFeeAccount.toBase58(), poolAccount()]])),
    wallet: WALLET, tokenAccount: TOKEN_ACCOUNT, tokenOwner: WALLET, poolTokens: 2_000_000_000n, positionId: 'fee-waiver' });
  assert.equal(plan.feePoolTokens, 0n);
  assert.equal(plan.expectedMinimumRedemptionLamports, 2_000_000_000n * pool.totalLamports / pool.poolTokenSupply);
});

void test('source selection leaves source minimum, validates stake authority, and honors mandatory preferred source', async () => {
  const source = deriveValidatorStakeAddress(VOTE, 0);
  const pool = decodeJitoStakePool(poolAccount(), EPOCH);
  const input = { wallet: WALLET, tokenAccount: TOKEN_ACCOUNT, tokenOwner: WALLET,
    poolTokens: 2_000_000_000n, positionId: 'position-1' };
  await assert.rejects(buildDelayedWithdrawPlan({ ...input, rpc: rpc(new Map([
    [source.toBase58(), stakeAccount(pool.withdrawAuthority, pool.withdrawAuthority, { lamports: 3_000_000_000n })],
  ])) }), /source/);
  await assert.rejects(buildDelayedWithdrawPlan({ ...input, rpc: rpc(new Map([
    [source.toBase58(), stakeAccount(WALLET, WALLET)],
  ])) }), /source/);
  const preferredPool = poolAccountWithPreferred(VOTE);
  await assert.rejects(buildDelayedWithdrawPlan({ ...input, rpc: rpc(new Map([
    [JITO_POOL_ADDRESS.toBase58(), preferredPool],
    [source.toBase58(), stakeAccount(pool.withdrawAuthority, pool.withdrawAuthority, { lamports: 3_000_000_000n })],
  ])) }), /source/);
});

void test('mandatory preferred validator cannot be bypassed by another funded validator', async () => {
  const pool = decodeJitoStakePool(poolAccount(), EPOCH);
  const secondVote = key(11);
  const validators = validatorAccount();
  const second = Buffer.from(validators.data.subarray(9)); secondVote.toBuffer().copy(second, 41);
  validators.data = Buffer.concat([validators.data, second]);
  validators.data.writeUInt32LE(2, 1); validators.data.writeUInt32LE(2, 5);
  const secondStake = stakeAccount(pool.withdrawAuthority, pool.withdrawAuthority);
  secondVote.toBuffer().copy(secondStake.data, 124);
  const overrides = new Map([
    [JITO_POOL_ADDRESS.toBase58(), poolAccountWithPreferred(VOTE)],
    [pool.validatorList.toBase58(), validators],
    [deriveValidatorStakeAddress(VOTE, 0).toBase58(), stakeAccount(pool.withdrawAuthority, pool.withdrawAuthority, { lamports: 3_000_000_000n })],
    [deriveValidatorStakeAddress(secondVote, 0).toBase58(), secondStake],
  ]);
  const input = { wallet: WALLET, tokenAccount: TOKEN_ACCOUNT, tokenOwner: WALLET, poolTokens: 2_000_000_000n, positionId: 'preferred' };
  await assert.rejects(buildDelayedWithdrawPlan({ ...input, rpc: rpc(overrides) }), /preferred source/);
  validators.data.writeBigUInt64LE(1_500_000_000n, 9);
  const plan = await buildDelayedWithdrawPlan({ ...input, rpc: rpc(overrides) });
  assert.equal(plan.sourceStakeAccount.toBase58(), deriveValidatorStakeAddress(secondVote, 0).toBase58());
});

void test('validator stake PDA includes nonzero u32 suffix and rejects an epoch boundary during planning', async () => {
  const suffix = Buffer.alloc(4); suffix.writeUInt32LE(19);
  assert.equal(deriveValidatorStakeAddress(VOTE, 19).toBase58(), PublicKey.findProgramAddressSync([
    VOTE.toBuffer(), JITO_POOL_ADDRESS.toBuffer(), suffix,
  ], STAKE_POOL_PROGRAM_ID)[0].toBase58());
  const reader = rpc(); let epochReads = 0;
  reader.getEpochInfo = async () => ({ epoch: Number(EPOCH) + (epochReads++ > 0 ? 1 : 0) });
  await assert.rejects(buildDelayedWithdrawPlan({ rpc: reader, wallet: WALLET, tokenAccount: TOKEN_ACCOUNT,
    tokenOwner: WALLET, poolTokens: 2_000_000_000n, positionId: 'epoch-boundary' }), /epoch changed/);
});

void test('builder refuses reserve/transient-only pools instead of constructing an invalid active-source instruction', async () => {
  const pool = decodeJitoStakePool(poolAccount(), EPOCH);
  const validators = validatorAccount(); validators.data.writeBigUInt64LE(1_002_282_880n, 9);
  validators.data.writeBigUInt64LE(20_000_000_000n, 17);
  await assert.rejects(buildDelayedWithdrawPlan({ rpc: rpc(new Map([[pool.validatorList.toBase58(), validators]])),
    wallet: WALLET, tokenAccount: TOKEN_ACCOUNT, tokenOwner: WALLET, poolTokens: 2_000_000_000n,
    positionId: 'transient-only' }), /no withdrawable active source/);
});

void test('deactivation validates both authorities and refuses already deactivating or locked stakes', async () => {
  const address = key(20);
  const plan = await buildDeactivatePlan({ rpc: rpc(new Map([[address.toBase58(), stakeAccount(WALLET, WALLET)]])), wallet: WALLET, stakeAccount: address });
  assert.equal(StakeInstruction.decodeDeactivate(instruction(plan.instructions, 0)).authorizedPubkey.toBase58(), WALLET.toBase58());
  for (const account of [stakeAccount(key(7), WALLET), stakeAccount(WALLET, key(7)), stakeAccount(WALLET, WALLET, { lockupEpoch: EPOCH + 1n })]) {
    await assert.rejects(buildDeactivatePlan({ rpc: rpc(new Map([[address.toBase58(), account]])), wallet: WALLET, stakeAccount: address }), /authority|lockup/);
  }
  await assert.rejects(buildDeactivatePlan({ rpc: rpc(new Map([[address.toBase58(), stakeAccount(WALLET, WALLET, { deactivationEpoch: EPOCH })]])), wallet: WALLET, stakeAccount: address }), /deactivat/);
});

void test('claim requires actual successful full-withdraw simulation even many epochs after deactivation', async () => {
  const address = key(20);
  const account = stakeAccount(WALLET, WALLET, { deactivationEpoch: EPOCH - 10n });
  const input = { rpc: rpc(new Map([[address.toBase58(), account]])), wallet: WALLET, stakeAccount: address };
  await assert.rejects(buildClaimPlan({ ...input, simulateUnsigned: async () => ({ err: { InstructionError: [0, 'InsufficientFunds'] } }) }), /simulation/);
  let simulatedAmount = 0;
  const plan = await buildClaimPlan({ ...input, simulateUnsigned: async (instructions) => {
    simulatedAmount = StakeInstruction.decodeWithdraw(instruction(instructions, 0)).lamports;
    return { err: null };
  } });
  assert.equal(plan.expectedMinimumRedemptionLamports, BigInt(account.lamports));
  assert.equal(simulatedAmount, account.lamports);
  assert.equal(StakeInstruction.decodeWithdraw(instruction(plan.instructions, 0)).toPubkey.toBase58(), WALLET.toBase58());
});

void test('claim refuses active, same-epoch deactivating, locked and incorrectly authorized stakes before simulation', async () => {
  const address = key(20);
  for (const account of [stakeAccount(WALLET, WALLET), stakeAccount(WALLET, WALLET, { deactivationEpoch: EPOCH }),
    stakeAccount(WALLET, key(7), { deactivationEpoch: EPOCH - 1n }),
    stakeAccount(WALLET, WALLET, { deactivationEpoch: EPOCH - 1n, lockupEpoch: EPOCH + 1n })]) {
    await assert.rejects(buildClaimPlan({ rpc: rpc(new Map([[address.toBase58(), account]])), wallet: WALLET, stakeAccount: address,
      simulateUnsigned: async () => { throw new Error('must not simulate'); } }), /active|deactivat|authority|lockup/);
  }
});

void test('claim can close an initialized stake only after full-balance simulation', async () => {
  const address = key(20);
  const account = stakeAccount(WALLET, WALLET); account.data.writeUInt32LE(1);
  const plan = await buildClaimPlan({ rpc: rpc(new Map([[address.toBase58(), account]])), wallet: WALLET,
    stakeAccount: address, simulateUnsigned: async () => ({ err: null }) });
  assert.equal(plan.expectedMinimumRedemptionLamports, BigInt(account.lamports));
  await assert.rejects(buildClaimPlan({ rpc: rpc(new Map([[address.toBase58(), account]])), wallet: WALLET,
    stakeAccount: address, simulateUnsigned: async () => ({ err: undefined }) }), /simulation/);
});

void test('stake decoder and RPC refuse unsafe JS numeric lamports and invalid stake state', async () => {
  assert.throws(() => decodeStakeAccount({ ...stakeAccount(WALLET, WALLET), lamports: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/);
  const invalid = stakeAccount(WALLET, WALLET); invalid.data.writeUInt32LE(3);
  assert.throws(() => decodeStakeAccount(invalid), /state/);
  await assert.rejects(readJitoStakePool({ ...rpc(), getEpochInfo: async () => ({ epoch: Number.MAX_SAFE_INTEGER + 1 }) }), /safe integer/);
});

function instruction(instructions: TransactionInstruction[], index: number): TransactionInstruction {
  const item = instructions[index]; assert.ok(item); return item;
}
function key(value: number): PublicKey { return new PublicKey(Buffer.alloc(32, value)); }
function poolAccount(): AccountInfo<Buffer> {
  return { owner: new PublicKey(archived.account.owner), data: Buffer.from(archived.account.data[0], 'base64'),
    lamports: archived.account.lamports, executable: false, rentEpoch: 0 };
}
function poolAccountWithPreferred(vote: PublicKey): AccountInfo<Buffer> {
  const original = poolAccount();
  // Fixture's FutureEpoch fee and preferred-deposit options are None; preferred-withdraw tag is byte 348.
  const offset = 348;
  original.data = Buffer.concat([original.data.subarray(0, offset), Buffer.from([1]), vote.toBuffer(), original.data.subarray(offset + 1)]);
  return original;
}
function validatorAccount(): AccountInfo<Buffer> {
  const data = Buffer.alloc(82); data[0] = 2; data.writeUInt32LE(1, 1); data.writeUInt32LE(1, 5);
  data.writeBigUInt64LE(20_000_000_000n, 9); data.writeBigUInt64LE(EPOCH, 25); VOTE.toBuffer().copy(data, 50);
  return { data, owner: STAKE_POOL_PROGRAM_ID, lamports: 1_000_000, executable: false, rentEpoch: 0 };
}
function stakeAccount(staker: PublicKey, withdrawer: PublicKey, options: {
  lamports?: bigint; deactivationEpoch?: bigint; lockupEpoch?: bigint;
} = {}): AccountInfo<Buffer> {
  const data = Buffer.alloc(200); data.writeUInt32LE(2); data.writeBigUInt64LE(RENT, 4);
  staker.toBuffer().copy(data, 12); withdrawer.toBuffer().copy(data, 44);
  data.writeBigUInt64LE(options.lockupEpoch ?? 0n, 84); VOTE.toBuffer().copy(data, 124);
  data.writeBigUInt64LE((options.lamports ?? 20_000_000_000n) - RENT, 156);
  data.writeBigUInt64LE(EPOCH - 20n, 164); data.writeBigUInt64LE(options.deactivationEpoch ?? MAX_U64, 172);
  return { data, owner: StakeProgram.programId, lamports: Number(options.lamports ?? 20_000_000_000n), executable: false, rentEpoch: 0 };
}
function rpc(overrides = new Map<string, AccountInfo<Buffer>>()): StakePoolReadRpc {
  const pool = decodeJitoStakePool(poolAccount(), EPOCH);
  const feeData = Buffer.alloc(165); JITO_MINT_ADDRESS.toBuffer().copy(feeData); feeData[108] = 1;
  const accounts = new Map<string, AccountInfo<Buffer>>([
    [JITO_POOL_ADDRESS.toBase58(), poolAccount()], [pool.validatorList.toBase58(), validatorAccount()],
    [pool.managerFeeAccount.toBase58(), { data: feeData, owner: TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0, lamports: 2_039_280 }],
    [deriveValidatorStakeAddress(VOTE, 0).toBase58(), stakeAccount(pool.withdrawAuthority, pool.withdrawAuthority)], ...overrides,
  ]);
  return { getAccountInfo: async (address) => accounts.get(address.toBase58()) ?? null,
    getEpochInfo: async () => ({ epoch: Number(EPOCH) }),
    getMinimumBalanceForRentExemption: async () => Number(RENT),
    getStakeMinimumDelegation: async () => ({ context: { slot: 1 }, value: 1_000_000_000 }) };
}

import { createHash } from 'node:crypto';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  PublicKey, StakeProgram, SystemProgram, SYSVAR_CLOCK_PUBKEY, TransactionInstruction,
} from '@solana/web3.js';
import type { AccountInfo, AccountMeta, Commitment } from '@solana/web3.js';

export const JITO_POOL_ADDRESS = new PublicKey('Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb');
export const JITO_MINT_ADDRESS = new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn');
export const STAKE_POOL_PROGRAM_ID = new PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy');
const MAX_U64 = (1n << 64n) - 1n;
const MINIMUM_POOL_DELEGATION = 1_000_000n;
const COMMITMENT = 'confirmed';

/** A Connection satisfies this interface. No signing or submission methods are accepted. */
export interface StakePoolReadRpc {
  getAccountInfo(address: PublicKey, commitment?: Commitment): Promise<AccountInfo<Buffer> | null>;
  getEpochInfo(commitment?: Commitment): Promise<{ epoch: number }>;
  getMinimumBalanceForRentExemption(size: number, commitment?: Commitment): Promise<number>;
  getStakeMinimumDelegation(config?: { commitment?: Commitment }): Promise<{ value: number }>;
}

export interface StakePoolFee { numerator: bigint; denominator: bigint }

export interface JitoStakePoolSnapshot {
  poolAddress: PublicKey;
  withdrawAuthority: PublicKey;
  validatorList: PublicKey;
  reserveStake: PublicKey;
  poolMint: PublicKey;
  managerFeeAccount: PublicKey;
  tokenProgramId: PublicKey;
  totalLamports: bigint;
  poolTokenSupply: bigint;
  lastUpdateEpoch: bigint;
  currentEpoch: bigint;
  stakeWithdrawalFee: StakePoolFee;
  preferredWithdrawValidatorVoteAddress: PublicKey | null;
}

export interface ValidatorStakeSnapshot {
  activeStakeLamports: bigint;
  transientStakeLamports: bigint;
  lastUpdateEpoch: bigint;
  transientSeedSuffix: bigint;
  validatorSeedSuffix: number;
  status: number;
  voteAccountAddress: PublicKey;
}

export interface StakeAccountSnapshot {
  state: 'initialized' | 'delegated';
  lamports: bigint;
  rentExemptReserve: bigint;
  staker: PublicKey;
  withdrawer: PublicKey;
  lockupUnixTimestamp: bigint;
  lockupEpoch: bigint;
  lockupCustodian: PublicKey;
  voter: PublicKey | null;
  delegatedLamports: bigint;
  activationEpoch: bigint | null;
  deactivationEpoch: bigint | null;
}

export interface StakeInstructionPlan {
  instructions: TransactionInstruction[];
  stakeAccount: PublicKey;
  expectedMinimumRedemptionLamports: bigint;
  rentLamports: bigint;
}

export interface DelayedWithdrawPlan extends StakeInstructionPlan {
  stakeSeed: string;
  sourceStakeAccount: PublicKey;
  poolTokens: bigint;
  feePoolTokens: bigint;
  currentEpoch: bigint;
}

// Layout/ABI authority: solana-program/stake-pool program/src/{state,instruction,processor}.rs
// at 8abfd17428728bc4c1ce181c238a3357bab82ad5, and Jito's useManualUnstake.ts
// at jito-foundation/jito-stake-unstake-reference commit b553e90d39e1ff583011dab344a11b5d9bfd284c.
// Borsh options and FutureEpoch are variable-length; never use fixed fee offsets.
export function decodeJitoStakePool(account: AccountInfo<Buffer>, currentEpoch: bigint): JitoStakePoolSnapshot {
  requireOwner(account, STAKE_POOL_PROGRAM_ID, 'pool');
  u64(currentEpoch, 'current epoch');
  const reader = new Reader(account.data);
  invariant(reader.u8() === 1, 'invalid pool account type');
  reader.skip(32 * 3); // manager, staker, deposit authority
  const bump = reader.u8();
  const validatorList = reader.key();
  const reserveStake = reader.key();
  const poolMint = reader.key();
  const managerFeeAccount = reader.key();
  const tokenProgramId = reader.key();
  invariant(poolMint.equals(JITO_MINT_ADDRESS), 'unexpected Jito pool mint');
  invariant(tokenProgramId.equals(TOKEN_PROGRAM_ID), 'unsupported pool token program');
  const totalLamports = reader.u64();
  const poolTokenSupply = reader.u64();
  const lastUpdateEpoch = reader.u64();
  invariant(totalLamports > 0n && poolTokenSupply > 0n, 'empty pool supply or lamports');
  invariant(lastUpdateEpoch === currentEpoch, 'pool epoch is stale or inconsistent');
  const lockupTimestamp = reader.i64();
  const lockupEpoch = reader.u64();
  const custodian = reader.key();
  invariant(lockupTimestamp === 0n && lockupEpoch === 0n && custodian.equals(PublicKey.default), 'unsupported pool lockup');
  reader.fee(); // epoch fee
  reader.futureFee();
  reader.optionalKey(); // preferred deposit validator
  const preferredWithdrawValidatorVoteAddress = reader.optionalKey();
  reader.fee(); // stake deposit fee
  const stakeWithdrawalFee = reader.fee();
  reader.futureFee();
  reader.u8(); // stake referral fee
  reader.optionalKey(); // SOL deposit authority
  reader.fee();
  reader.u8(); // SOL referral fee
  reader.optionalKey(); // SOL withdrawal authority
  reader.fee();
  reader.futureFee();
  reader.u64(); reader.u64(); // previous epoch supply and lamports
  const [withdrawAuthority, derivedBump] = PublicKey.findProgramAddressSync([
    JITO_POOL_ADDRESS.toBuffer(), Buffer.from('withdraw'),
  ], STAKE_POOL_PROGRAM_ID);
  invariant(derivedBump === bump, 'invalid pool withdrawal authority bump');
  return { poolAddress: JITO_POOL_ADDRESS, withdrawAuthority, validatorList, reserveStake, poolMint,
    managerFeeAccount, tokenProgramId, totalLamports, poolTokenSupply, lastUpdateEpoch,
    currentEpoch, stakeWithdrawalFee, preferredWithdrawValidatorVoteAddress };
}

export async function readJitoStakePool(rpc: StakePoolReadRpc): Promise<JitoStakePoolSnapshot> {
  const [account, epoch] = await Promise.all([
    rpc.getAccountInfo(JITO_POOL_ADDRESS, COMMITMENT), rpc.getEpochInfo(COMMITMENT),
  ]);
  invariant(account !== null, 'Jito pool account missing');
  return decodeJitoStakePool(account, rpcInteger(epoch.epoch, 'epoch'));
}

export function decodeValidatorList(account: AccountInfo<Buffer>, currentEpoch: bigint): ValidatorStakeSnapshot[] {
  requireOwner(account, STAKE_POOL_PROGRAM_ID, 'validator list');
  const reader = new Reader(account.data);
  invariant(reader.u8() === 2, 'invalid validator list account type');
  const maximum = reader.u32();
  const length = reader.u32();
  invariant(length <= maximum && account.data.length >= 9 + length * 73, 'invalid validator list length');
  const validators: ValidatorStakeSnapshot[] = [];
  const votes = new Set<string>();
  for (let i = 0; i < length; i++) {
    const activeStakeLamports = reader.u64();
    const transientStakeLamports = reader.u64();
    const lastUpdateEpoch = reader.u64();
    const transientSeedSuffix = reader.u64();
    reader.u32(); // unused, formerly transient seed suffix end
    const validatorSeedSuffix = reader.u32();
    const status = reader.u8();
    const voteAccountAddress = reader.key();
    invariant(status <= 4, 'invalid validator status');
    invariant(lastUpdateEpoch === currentEpoch, 'validator list epoch is stale or inconsistent');
    invariant(!votes.has(voteAccountAddress.toBase58()), 'duplicate validator vote address');
    votes.add(voteAccountAddress.toBase58());
    validators.push({ activeStakeLamports, transientStakeLamports, lastUpdateEpoch,
      transientSeedSuffix, validatorSeedSuffix, status, voteAccountAddress });
  }
  return validators;
}

export function quoteStakeWithdrawal(
  pool: Pick<JitoStakePoolSnapshot, 'totalLamports' | 'poolTokenSupply' | 'stakeWithdrawalFee'>,
  poolTokens: bigint,
  feeExempt = false,
): { feePoolTokens: bigint; burnPoolTokens: bigint; withdrawLamports: bigint } {
  u64(poolTokens, 'pool tokens');
  invariant(poolTokens > 0n, 'pool tokens must be positive');
  invariant(pool.poolTokenSupply > 0n && pool.totalLamports > 0n, 'invalid pool supply');
  const { numerator, denominator } = pool.stakeWithdrawalFee;
  invariant(numerator >= 0n && denominator >= 0n && (denominator === 0n || numerator <= denominator), 'invalid withdrawal fee');
  const feePoolTokens = feeExempt || denominator === 0n ? 0n : ceilDiv(poolTokens * numerator, denominator);
  const burnPoolTokens = poolTokens - feePoolTokens;
  const withdrawLamports = burnPoolTokens * pool.totalLamports / pool.poolTokenSupply;
  u64(withdrawLamports, 'withdrawal lamports');
  invariant(withdrawLamports > 0n, 'withdrawal amount is too small');
  return { feePoolTokens, burnPoolTokens, withdrawLamports };
}

/** No extra signing key is created or persisted. positionId must be stable across restarts. */
export async function deriveStakeDestination(wallet: PublicKey, positionId: string): Promise<{ stakeSeed: string; stakeAccount: PublicKey }> {
  invariant(positionId.length > 0 && positionId.length <= 512, 'invalid position id');
  const stakeSeed = createHash('sha256').update('jitosol-discount-stake-v1\0')
    .update(wallet.toBuffer()).update(positionId).digest('hex').slice(0, 32);
  const stakeAccount = await PublicKey.createWithSeed(wallet, stakeSeed, StakeProgram.programId);
  return { stakeSeed, stakeAccount };
}

export function deriveValidatorStakeAddress(vote: PublicKey, validatorSeedSuffix: number): PublicKey {
  invariant(Number.isSafeInteger(validatorSeedSuffix) && validatorSeedSuffix >= 0 && validatorSeedSuffix <= 0xffff_ffff, 'invalid validator seed');
  const suffix = Buffer.alloc(validatorSeedSuffix === 0 ? 0 : 4);
  if (suffix.length) suffix.writeUInt32LE(validatorSeedSuffix);
  return PublicKey.findProgramAddressSync([vote.toBuffer(), JITO_POOL_ADDRESS.toBuffer(), suffix], STAKE_POOL_PROGRAM_ID)[0];
}

/**
 * Plans an active validator split. Smaller/transient/reserve/full-validator withdrawals
 * are deliberately rejected: the lifecycle here requires one live delegated source.
 * ATA mint/owner/balance validation belongs to the gateway. Planning before a buy is supported.
 * expectedMinimumRedemptionLamports excludes the independently funded rent deposit.
 * WithdrawStakeWithSlippage enforces this exact minimum on chain, before burning tokens.
 * Simulate and revalidate the plan before submission as source liquidity can change.
 */
export async function buildDelayedWithdrawPlan(input: {
  rpc: StakePoolReadRpc; wallet: PublicKey; tokenAccount: PublicKey; tokenOwner: PublicKey;
  poolTokens: bigint; positionId: string;
}): Promise<DelayedWithdrawPlan> {
  const { rpc, wallet, tokenAccount, tokenOwner, poolTokens } = input;
  invariant(tokenOwner.equals(wallet), 'token owner must be wallet');
  const pool = await readJitoStakePool(rpc);
  const destination = await deriveStakeDestination(wallet, input.positionId);
  const [validatorsAccount, destinationAccount, rentNumber, minimumResponse, feeAccount] = await Promise.all([
    rpc.getAccountInfo(pool.validatorList, COMMITMENT), rpc.getAccountInfo(destination.stakeAccount, COMMITMENT),
    rpc.getMinimumBalanceForRentExemption(StakeProgram.space, COMMITMENT),
    rpc.getStakeMinimumDelegation({ commitment: COMMITMENT }),
    rpc.getAccountInfo(pool.managerFeeAccount, COMMITMENT),
  ]);
  invariant(destinationAccount === null, 'stake destination already exists; reconcile persisted position');
  invariant(validatorsAccount !== null, 'validator list missing');
  const validators = decodeValidatorList(validatorsAccount, pool.currentEpoch);
  const rentLamports = rpcInteger(rentNumber, 'stake rent');
  const minimumDelegation = rpcInteger(minimumResponse.value, 'minimum delegation');
  invariant(rentLamports > 0n && minimumDelegation > 0n, 'invalid stake rent or minimum delegation');
  const poolMinimum = minimumDelegation > MINIMUM_POOL_DELEGATION ? minimumDelegation : MINIMUM_POOL_DELEGATION;
  const feeExempt = tokenAccount.equals(pool.managerFeeAccount) || !validManagerFeeAccount(feeAccount, pool.poolMint);
  const quote = quoteStakeWithdrawal(pool, poolTokens, feeExempt);
  invariant(quote.withdrawLamports >= minimumDelegation, 'withdrawal below current minimum delegation for a split');
  invariant(poolTokens <= pool.poolTokenSupply, 'pool tokens exceed total supply');
  const requiredSourceLamports = rentLamports + poolMinimum;
  const tolerance = ceilDiv(pool.totalLamports, pool.poolTokenSupply);
  const hasActiveStakeThreshold = requiredSourceLamports + minimumDelegation + tolerance;
  invariant(validators.some((v) => v.status === 0 && v.activeStakeLamports > hasActiveStakeThreshold), 'no withdrawable active source; transient/reserve withdrawals require a different lifecycle');
  const preferred = validators.find((v) => pool.preferredWithdrawValidatorVoteAddress?.equals(v.voteAccountAddress));
  const preferredRequired = preferred !== undefined && preferred.activeStakeLamports >= hasActiveStakeThreshold;
  const candidates = (preferredRequired ? [preferred] : validators).filter((v) =>
    v.status === 0 && v.activeStakeLamports >= requiredSourceLamports + quote.withdrawLamports);
  candidates.sort((a, b) => a.activeStakeLamports === b.activeStakeLamports
    ? a.voteAccountAddress.toBase58().localeCompare(b.voteAccountAddress.toBase58())
    : a.activeStakeLamports > b.activeStakeLamports ? -1 : 1);
  let sourceStakeAccount: PublicKey | undefined;
  for (const candidate of candidates) {
    const address = deriveValidatorStakeAddress(candidate.voteAccountAddress, candidate.validatorSeedSuffix);
    const account = await rpc.getAccountInfo(address, COMMITMENT);
    if (account === null) continue;
    const stake = decodeStakeAccount(account);
    if (stake.state !== 'delegated' || !stake.voter?.equals(candidate.voteAccountAddress)
      || !stake.staker.equals(pool.withdrawAuthority) || !stake.withdrawer.equals(pool.withdrawAuthority)
      || stake.deactivationEpoch !== MAX_U64 || stake.activationEpoch === null || stake.activationEpoch >= pool.currentEpoch
      || !unlocked(stake) || stake.lamports < requiredSourceLamports + quote.withdrawLamports
      || stake.delegatedLamports < poolMinimum + quote.withdrawLamports) continue;
    sourceStakeAccount = address;
    break;
  }
  invariant(sourceStakeAccount !== undefined, preferredRequired ? 'preferred source cannot safely satisfy withdrawal' : 'no valid source can safely satisfy withdrawal');
  invariant(rpcInteger((await rpc.getEpochInfo(COMMITMENT)).epoch, 'epoch') === pool.currentEpoch, 'epoch changed while building withdrawal');
  invariant(quote.withdrawLamports > 0n, 'guarded withdrawal minimum must be positive');
  const data = Buffer.alloc(17);
  data[0] = 24; // Borsh StakePoolInstruction::WithdrawStakeWithSlippage
  data.writeBigUInt64LE(poolTokens, 1);
  data.writeBigUInt64LE(quote.withdrawLamports, 9);
  const keys = [
    meta(JITO_POOL_ADDRESS, true), meta(pool.validatorList, true), meta(pool.withdrawAuthority),
    meta(sourceStakeAccount, true), meta(destination.stakeAccount, true), meta(wallet), meta(wallet, false, true),
    meta(tokenAccount, true), meta(pool.managerFeeAccount, true), meta(pool.poolMint, true),
    meta(SYSVAR_CLOCK_PUBKEY), meta(pool.tokenProgramId), meta(StakeProgram.programId),
  ];
  return { ...destination, sourceStakeAccount, poolTokens, feePoolTokens: quote.feePoolTokens,
    expectedMinimumRedemptionLamports: quote.withdrawLamports, rentLamports, currentEpoch: pool.currentEpoch,
    instructions: [SystemProgram.createAccountWithSeed({ fromPubkey: wallet, basePubkey: wallet,
      newAccountPubkey: destination.stakeAccount, seed: destination.stakeSeed,
      lamports: safeNumber(rentLamports, 'stake rent'), space: StakeProgram.space, programId: StakeProgram.programId }),
    new TransactionInstruction({ programId: STAKE_POOL_PROGRAM_ID, keys, data })] };
}

/** StakeStateV2 uses bincode: u32 discriminant, Meta, then optional Stake delegation. */
export function decodeStakeAccount(account: AccountInfo<Buffer>): StakeAccountSnapshot {
  requireOwner(account, StakeProgram.programId, 'stake');
  invariant(account.data.length === StakeProgram.space, 'invalid stake account size');
  const lamports = rpcInteger(account.lamports, 'stake account lamports');
  const reader = new Reader(account.data);
  const state = reader.u32();
  invariant(state === 1 || state === 2, 'unsupported stake state');
  const rentExemptReserve = reader.u64();
  const staker = reader.key();
  const withdrawer = reader.key();
  const lockupUnixTimestamp = reader.i64();
  const lockupEpoch = reader.u64();
  const lockupCustodian = reader.key();
  invariant(lamports >= rentExemptReserve, 'stake account is below rent reserve');
  const voter = state === 2 ? reader.key() : null;
  const delegatedLamports = state === 2 ? reader.u64() : 0n;
  const activationEpoch = state === 2 ? reader.u64() : null;
  const deactivationEpoch = state === 2 ? reader.u64() : null;
  invariant(delegatedLamports <= lamports - rentExemptReserve, 'stake delegation exceeds account balance');
  return { state: state === 1 ? 'initialized' : 'delegated', lamports, rentExemptReserve, staker, withdrawer,
    lockupUnixTimestamp, lockupEpoch, lockupCustodian, voter, delegatedLamports, activationEpoch, deactivationEpoch };
}

export async function buildDeactivatePlan(input: {
  rpc: StakePoolReadRpc; wallet: PublicKey; stakeAccount: PublicKey;
}): Promise<StakeInstructionPlan> {
  const { stake, currentEpoch } = await readOwnedStake(input);
  invariant(stake.state === 'delegated' && stake.deactivationEpoch === MAX_U64, 'stake is already deactivated or deactivating');
  invariant(stake.activationEpoch !== null && stake.activationEpoch < currentEpoch, 'stake is still activating');
  return { stakeAccount: input.stakeAccount, rentLamports: stake.rentExemptReserve,
    expectedMinimumRedemptionLamports: stake.lamports - stake.rentExemptReserve,
    instructions: StakeProgram.deactivate({ stakePubkey: input.stakeAccount, authorizedPubkey: input.wallet }).instructions };
}

/**
 * simulateUnsigned MUST simulate these exact instructions against current mainnet state,
 * with wallet as fee payer, sigVerify:false and a fresh blockhash. It must return the RPC
 * simulation's value.err unchanged (never infer success from elapsed epochs). A successful
 * full-balance withdraw proves the runtime permits claim, even where getStakeActivation is absent.
 * The gateway must simulate again before send; this result is not an enduring authorization.
 */
export async function buildClaimPlan(input: {
  rpc: StakePoolReadRpc; wallet: PublicKey; stakeAccount: PublicKey;
  simulateUnsigned: (instructions: TransactionInstruction[]) => Promise<{ err: unknown }>;
}): Promise<StakeInstructionPlan> {
  const { stake, currentEpoch } = await readOwnedStake(input);
  if (stake.state === 'delegated') {
    invariant(stake.deactivationEpoch !== MAX_U64, 'stake is active; deactivate before claim');
    invariant(stake.deactivationEpoch !== null && stake.deactivationEpoch < currentEpoch, 'stake is still deactivating in the current epoch');
  }
  const instructions = StakeProgram.withdraw({ stakePubkey: input.stakeAccount,
    authorizedPubkey: input.wallet, toPubkey: input.wallet, lamports: safeNumber(stake.lamports, 'claim lamports') }).instructions;
  const simulation = await input.simulateUnsigned(instructions);
  invariant(simulation.err === null, 'claim simulation failed; stake may still be cooling down');
  return { instructions, stakeAccount: input.stakeAccount, expectedMinimumRedemptionLamports: stake.lamports,
    rentLamports: stake.rentExemptReserve };
}

async function readOwnedStake(input: { rpc: StakePoolReadRpc; wallet: PublicKey; stakeAccount: PublicKey }): Promise<{
  stake: StakeAccountSnapshot; currentEpoch: bigint;
}> {
  const [account, epoch] = await Promise.all([
    input.rpc.getAccountInfo(input.stakeAccount, COMMITMENT), input.rpc.getEpochInfo(COMMITMENT),
  ]);
  invariant(account !== null, 'stake account missing');
  const stake = decodeStakeAccount(account);
  invariant(stake.staker.equals(input.wallet) && stake.withdrawer.equals(input.wallet), 'stake authority does not match wallet');
  invariant(unlocked(stake), 'stake lockup is unsupported');
  return { stake, currentEpoch: rpcInteger(epoch.epoch, 'epoch') };
}

function validManagerFeeAccount(account: AccountInfo<Buffer> | null, mint: PublicKey): boolean {
  return account !== null && account.owner.equals(TOKEN_PROGRAM_ID) && !account.executable
    && account.data.length === 165 && account.data[108] === 1 && new PublicKey(account.data.subarray(0, 32)).equals(mint);
}
function unlocked(stake: StakeAccountSnapshot): boolean {
  return stake.lockupEpoch === 0n && stake.lockupUnixTimestamp === 0n && stake.lockupCustodian.equals(PublicKey.default);
}
function meta(pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta { return { pubkey, isWritable, isSigner }; }
function ceilDiv(numerator: bigint, denominator: bigint): bigint { return (numerator + denominator - 1n) / denominator; }
function u64(value: bigint, label: string): void { invariant(value >= 0n && value <= MAX_U64, `${label} outside u64 range`); }
function rpcInteger(value: number, label: string): bigint {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative safe integer`);
  return BigInt(value);
}
function safeNumber(value: bigint, label: string): number {
  invariant(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), `${label} must be a nonnegative safe integer`);
  return Number(value);
}
function requireOwner(account: AccountInfo<Buffer>, owner: PublicKey, label: string): void {
  invariant(account.owner.equals(owner) && !account.executable, `invalid ${label} owner or executable account`);
}
function invariant(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

class Reader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}
  private take(size: number): Buffer {
    invariant(this.offset + size <= this.data.length, 'truncated account data');
    const result = this.data.subarray(this.offset, this.offset + size); this.offset += size; return result;
  }
  skip(size: number): void { this.take(size); }
  u8(): number { return this.take(1).readUInt8(); }
  u32(): number { return this.take(4).readUInt32LE(); }
  u64(): bigint { return this.take(8).readBigUInt64LE(); }
  i64(): bigint { return this.take(8).readBigInt64LE(); }
  key(): PublicKey { return new PublicKey(this.take(32)); }
  optionalKey(): PublicKey | null {
    const tag = this.u8(); invariant(tag <= 1, 'invalid account option'); return tag === 0 ? null : this.key();
  }
  fee(): StakePoolFee {
    const denominator = this.u64(); const numerator = this.u64();
    invariant(denominator === 0n || numerator <= denominator, 'invalid pool fee'); return { denominator, numerator };
  }
  futureFee(): void {
    const tag = this.u8(); invariant(tag <= 2, 'invalid future fee option'); if (tag !== 0) this.fee();
  }
}

import { createHash, createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { ACCOUNT_SIZE, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import {
  ComputeBudgetProgram, PublicKey, StakeProgram, SystemProgram, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import type {
  AccountInfo, AddressLookupTableAccount, Connection, SimulatedTransactionAccountInfo,
  TransactionInstruction, SimulateTransactionConfig, VersionedTransactionResponse,
} from '@solana/web3.js';
import type { ExecutionTransactionSigner } from '../ports/execution-transaction-signer.js';
import { amount, evaluateObservation, requiredRedemptionLamports } from './config.js';
import { JITOSOL_MINT, SOL_MINT } from './jupiter.js';
import type { JupiterClient, JupiterQuote } from './jupiter.js';
import {
  buildClaimPlan, buildDeactivatePlan, buildDelayedWithdrawPlan, decodeJitoStakePool,
  decodeStakeAccount, deriveStakeDestination, JITO_POOL_ADDRESS,
} from './stake-pool.js';
import type { StakeInstructionPlan, StakePoolReadRpc } from './stake-pool.js';
import type {
  JitoBotConfig, JitoGateway, Observation, PendingTransaction, Position, SignatureResult, TransactionEffects,
} from './types.js';

// solana-labs/solana sdk/src/genesis_config.rs, ClusterType::MainnetBeta.
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const MAX_PACKET_BYTES = 1232;
const MAX_U64 = (1n << 64n) - 1n;
const COMMITMENT = 'confirmed';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type JitoGatewayRpc = Pick<Connection,
  'getAccountInfo' | 'getAccountInfoAndContext' | 'getMultipleAccountsInfoAndContext' |
  'getEpochInfo' | 'getMinimumBalanceForRentExemption' | 'getStakeMinimumDelegation' |
  'getGenesisHash' | 'getAddressLookupTable' | 'getLatestBlockhash' | 'getFeeForMessage' |
  'simulateTransaction' | 'sendRawTransaction' | 'getSignatureStatuses' | 'getBlockHeight' | 'getTransaction'>;

export interface SolanaJitoGatewayOptions {
  connection: JitoGatewayRpc;
  jupiter: Pick<JupiterClient, 'getQuote' | 'buildSwapInstructions'>;
  walletAddress: string;
  signer?: ExecutionTransactionSigner;
  liveEnabled?: boolean;
  now?: () => number;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: bigint;
  maxTransactionFeeLamports?: bigint;
}

export interface JitoQuotePayload { kind: 'jitosol-jupiter-v1'; quote: JupiterQuote }
interface WalletAccounts {
  wallet: AccountInfo<Buffer> | null;
  jito: AccountInfo<Buffer> | null;
  sol: AccountInfo<Buffer> | null;
  stake: AccountInfo<Buffer> | null;
  slot: number;
}

/** All errors crossing the gateway boundary are fixed codes; RPC URLs/logs/wire never escape. */
class GatewayError extends Error {}
class RetryablePollError extends Error {}
function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) throw new GatewayError(code);
}
function rpcInteger(value: number): bigint {
  requireValue(Number.isSafeInteger(value) && value >= 0, 'invalid_rpc_integer');
  return BigInt(value);
}
function safeSlot(value: number): number { rpcInteger(value); return value; }
function hash(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex'); }
function required<T>(value: T | undefined | null, code: string): T { requireValue(value !== undefined && value !== null, code); return value; }
function positive(value: string | undefined): bigint {
  const parsed = amount(required(value, 'invalid_amount')); requireValue(parsed > 0n, 'invalid_amount'); return parsed;
}

export class SolanaJitoGateway implements JitoGateway {
  private readonly rpc: JitoGatewayRpc;
  private readonly jupiter: SolanaJitoGatewayOptions['jupiter'];
  private readonly wallet: PublicKey;
  private readonly jitoAta: PublicKey;
  private readonly solAta: PublicKey;
  private readonly signer: ExecutionTransactionSigner | undefined;
  private readonly liveEnabled: boolean;
  private readonly now: () => number;
  private readonly computeUnitLimit: number;
  private readonly computeUnitPrice: bigint;
  private readonly feeCap: bigint;
  private mainnetChecked = false;

  constructor(options: SolanaJitoGatewayOptions) {
    this.rpc = options.connection; this.jupiter = options.jupiter;
    try { this.wallet = new PublicKey(options.walletAddress); }
    catch { throw new GatewayError('invalid_wallet_address'); }
    requireValue(this.wallet.toBase58() === options.walletAddress && PublicKey.isOnCurve(this.wallet.toBytes()), 'invalid_wallet_address');
    this.jitoAta = getAssociatedTokenAddressSync(JITOSOL_MINT, this.wallet);
    this.solAta = getAssociatedTokenAddressSync(SOL_MINT, this.wallet);
    this.signer = options.signer; this.liveEnabled = options.liveEnabled ?? false;
    this.now = options.now ?? Date.now;
    this.computeUnitLimit = options.computeUnitLimit ?? 400_000;
    this.computeUnitPrice = options.computeUnitPriceMicroLamports ?? 0n;
    this.feeCap = options.maxTransactionFeeLamports ?? 1_000_000n;
    requireValue(Number.isSafeInteger(this.computeUnitLimit) && this.computeUnitLimit >= 1 && this.computeUnitLimit <= 1_400_000, 'invalid_compute_limit');
    requireValue(typeof this.computeUnitPrice === 'bigint' && this.computeUnitPrice >= 0n && this.computeUnitPrice <= 1_000_000n, 'invalid_compute_price');
    requireValue(typeof this.feeCap === 'bigint' && this.feeCap > 0n && this.feeCap <= 1_000_000n, 'invalid_transaction_fee_cap');
  }

  async observe(config: JitoBotConfig): Promise<Observation> {
    return this.sanitized('observation_failed', async () => {
      this.assertConfig(config);
      await this.ensureMainnet();
      const quote = await this.jupiter.getQuote();
      const epoch = await this.rpc.getEpochInfo(COMMITMENT);
      const initial = await this.rpc.getAccountInfoAndContext(JITO_POOL_ADDRESS, {
        commitment: COMMITMENT, minContextSlot: safeSlot(quote.contextSlot),
      });
      requireValue(initial.value !== null, 'pool_missing');
      const initialSlot = safeSlot(initial.context.slot);
      requireValue(initialSlot >= quote.contextSlot, 'pool_context_behind_quote');
      const pool = decodeJitoStakePool(initial.value, rpcInteger(epoch.epoch));
      const [minimumResponse, stakeRent, tokenRent, wallet] = await Promise.all([
        this.rpc.getStakeMinimumDelegation({ commitment: COMMITMENT }),
        this.rpc.getMinimumBalanceForRentExemption(StakeProgram.space, COMMITMENT),
        this.rpc.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, COMMITMENT),
        this.readWallet(initialSlot),
      ]);
      const minimum = rpcInteger(minimumResponse.value);
      const rent = rpcInteger(stakeRent); const ataRent = rpcInteger(tokenRent);
      requireValue(minimum > 0n && rent > 0n && ataRent > 0n, 'invalid_rent_or_delegation');
      let available = false; let sourceStakeAddress: string | undefined; let highestSlot = Math.max(initialSlot, wallet.slot);
      const rpc: StakePoolReadRpc = {
        getAccountInfo: async (address) => {
          if (address.equals(JITO_POOL_ADDRESS)) return initial.value;
          const response = await this.rpc.getAccountInfoAndContext(address, { commitment: COMMITMENT, minContextSlot: initialSlot });
          requireValue(safeSlot(response.context.slot) >= initialSlot, 'stale_withdrawal_account');
          highestSlot = Math.max(highestSlot, response.context.slot); return response.value;
        },
        getEpochInfo: () => this.rpc.getEpochInfo(COMMITMENT),
        getMinimumBalanceForRentExemption: (size) => this.rpc.getMinimumBalanceForRentExemption(size, COMMITMENT),
        getStakeMinimumDelegation: () => this.rpc.getStakeMinimumDelegation({ commitment: COMMITMENT }),
      };
      try {
        const plan = await buildDelayedWithdrawPlan({ rpc, wallet: this.wallet, tokenAccount: this.jitoAta,
          tokenOwner: this.wallet, poolTokens: quote.minimumOutputAtomic, positionId: 'observation-capacity-preflight-v1' });
        available = plan.currentEpoch === pool.currentEpoch && plan.rentLamports === rent;
        if (available) sourceStakeAddress = plan.sourceStakeAccount.toBase58();
      } catch { /* Unavailable capacity is a rejected entry, never guessed from total TVL. */ }
      const [latest, finalEpoch, finalMinimum] = await Promise.all([
        this.rpc.getAccountInfoAndContext(JITO_POOL_ADDRESS, { commitment: COMMITMENT, minContextSlot: highestSlot }),
        this.rpc.getEpochInfo(COMMITMENT), this.rpc.getStakeMinimumDelegation({ commitment: COMMITMENT }),
      ]);
      requireValue(latest.value !== null && safeSlot(latest.context.slot) >= highestSlot, 'stale_pool_context');
      const finalPool = decodeJitoStakePool(latest.value, rpcInteger(finalEpoch.epoch));
      requireValue(hash(latest.value.data) === hash(initial.value.data) && finalPool.currentEpoch === pool.currentEpoch
        && rpcInteger(finalMinimum.value) === minimum, 'pool_changed_during_observation');
      const now = safeSlot(this.now());
      const routeSlots = quote.routePlan.map((route) => route.updateContextSlot);
      const oldestRouteSlot = routeSlots.length > 0 && routeSlots.every((slot) => slot !== null && Number.isSafeInteger(slot) && slot >= 0)
        ? Math.min(...routeSlots as number[]) : -1;
      const quotePayload: JitoQuotePayload = { kind: 'jitosol-jupiter-v1', quote };
      return {
        observedAtMs: now,
        quote: { id: hash(Buffer.from(`${JSON.stringify(quote.raw)}:${quote.receivedAtMs.toString()}`)), receivedAtMs: quote.receivedAtMs,
          contextSlot: quote.contextSlot, routeSlot: oldestRouteSlot, inputMint: SOL_MINT.toBase58(), outputMint: JITOSOL_MINT.toBase58(),
          inputLamports: quote.inputLamports.toString(), minJitoOutUnits: quote.minimumOutputAtomic.toString(), raw: quotePayload },
        pool: { address: JITO_POOL_ADDRESS.toBase58(), mint: JITOSOL_MINT.toBase58(), contextSlot: latest.context.slot,
          currentEpoch: finalEpoch.epoch, lastUpdateEpoch: Number(pool.lastUpdateEpoch), totalLamports: pool.totalLamports.toString(),
          tokenSupply: pool.poolTokenSupply.toString(), withdrawalFeeNumerator: pool.stakeWithdrawalFee.numerator.toString(),
          withdrawalFeeDenominator: pool.stakeWithdrawalFee.denominator.toString() },
        withdrawal: { available, checkedAtMs: now, minimumDelegationLamports: minimum.toString(), stakeRentLamports: rent.toString(),
          tokenAccountRentLamports: ataRent.toString(), ...(sourceStakeAddress ? { sourceStakeAddress } : { reason: 'withdrawal_capacity_unavailable' }) },
        wallet: { address: this.wallet.toBase58(), solLamports: this.walletLamports(wallet.wallet).toString(),
          jitoUnits: this.tokenUnits(wallet.jito, this.jitoAta, JITOSOL_MINT).toString() },
      };
    });
  }

  async prepare(request: Parameters<JitoGateway['prepare']>[0]): Promise<PendingTransaction> {
    this.assertLive(); // Deliberately before RPC, clock, config parsing or signer invocation.
    return this.sanitized('prepare_failed', async () => {
      const { kind, config, position, observation } = request;
      requireValue(config.enabled, 'configuration_disabled'); this.assertConfig(config);
      await this.ensureMainnet();
      let instructions: TransactionInstruction[]; let lookupAddresses: PublicKey[] = [];
      let plan: StakeInstructionPlan | undefined; let stakeAddress: PublicKey | undefined;
      const expected: PendingTransaction['expected'] = {};
      let contextSlot = 0;
      if (kind === 'buy') {
        requireValue(observation !== undefined && evaluateObservation(observation, config, this.now()).eligible, 'entry_observation_ineligible');
        const payload = observation.quote.raw as Partial<JitoQuotePayload> | null;
        requireValue(payload !== null && payload.kind === 'jitosol-jupiter-v1' && payload.quote !== undefined, 'invalid_quote_payload');
        const quote = payload.quote;
        requireValue(quote.inputLamports.toString() === config.inputLamports && quote.minimumOutputAtomic.toString() === observation.quote.minJitoOutUnits
          && quote.contextSlot === observation.quote.contextSlot && quote.receivedAtMs === observation.quote.receivedAtMs, 'quote_observation_mismatch');
        const swap = await this.jupiter.buildSwapInstructions(quote, this.wallet);
        requireValue(swap.destinationTokenAccount.equals(this.jitoAta) && swap.sourceTokenAccount.equals(this.solAta), 'swap_accounts_mismatch');
        instructions = swap.instructions; lookupAddresses = swap.addressLookupTableAddresses;
        contextSlot = Math.max(observation.pool.contextSlot, observation.quote.contextSlot);
        await this.rejectUnrelatedOwnedAccounts(instructions, contextSlot);
        expected.minJitoReceivedUnits = observation.quote.minJitoOutUnits;
      } else if (kind === 'withdraw') {
        plan = await buildDelayedWithdrawPlan({ rpc: this.rpc, wallet: this.wallet, tokenAccount: this.jitoAta,
          tokenOwner: this.wallet, poolTokens: positive(position.actualJitoReceivedUnits), positionId: position.id });
        requireValue(plan.expectedMinimumRedemptionLamports >= requiredRedemptionLamports(config), 'withdrawal_economic_floor');
        instructions = plan.instructions; stakeAddress = plan.stakeAccount;
        expected.stakeAddress = stakeAddress.toBase58(); expected.jitoSpentUnits = position.actualJitoReceivedUnits;
        expected.minimumRedemptionLamports = plan.expectedMinimumRedemptionLamports.toString();
        expected.refundableRentLamports = plan.rentLamports.toString();
      } else {
        stakeAddress = await this.positionStake(position);
        plan = kind === 'deactivate'
          ? await buildDeactivatePlan({ rpc: this.rpc, wallet: this.wallet, stakeAccount: stakeAddress })
          : await buildClaimPlan({ rpc: this.rpc, wallet: this.wallet, stakeAccount: stakeAddress,
            simulateUnsigned: (ix) => this.simulateClaim(ix) });
        instructions = plan.instructions; expected.stakeAddress = stakeAddress.toBase58();
        if (kind === 'claim') {
          requireValue(plan.rentLamports === amount(position.stakeRentLamports), 'stake_rent_mismatch');
          expected.refundableRentLamports = position.stakeRentLamports;
        }
      }
      const before = await this.readWallet(contextSlot, stakeAddress);
      this.walletLamports(before.wallet);
      const beforeJito = this.tokenUnits(before.jito, this.jitoAta, JITOSOL_MINT);
      const beforeSol = this.tokenUnits(before.sol, this.solAta, SOL_MINT);
      if (kind === 'buy') requireValue(beforeSol === 0n, 'existing_wsol_balance');
      if (kind === 'withdraw') requireValue(beforeJito >= positive(position.actualJitoReceivedUnits), 'insufficient_jito_balance');
      const built = await this.buildUnsigned(instructions, lookupAddresses, Math.max(contextSlot, before.slot));
      const estimate = await this.rpc.getFeeForMessage(built.transaction.message, COMMITMENT);
      requireValue(estimate.value !== null, 'fee_estimate_unavailable');
      const fee = rpcInteger(estimate.value);
      requireValue(fee > 0n && fee <= this.feeCap && fee <= amount(config.networkBudgetLamports), 'transaction_fee_cap');
      const simulation = await this.rpc.simulateTransaction(built.transaction, this.simulationConfig(before.slot, stakeAddress));
      requireValue(simulation.value.err === null, 'simulation_failed');
      requireValue(safeSlot(simulation.context.slot) >= before.slot, 'stale_simulation');
      const accounts = simulation.value.accounts;
      requireValue(accounts?.length === (stakeAddress ? 4 : 3), 'simulation_accounts_missing');
      const after: WalletAccounts = { wallet: this.simulatedAccount(accounts[0]), jito: this.simulatedAccount(accounts[1]),
        sol: this.simulatedAccount(accounts[2]), stake: stakeAddress ? this.simulatedAccount(accounts[3]) : null, slot: simulation.context.slot };
      const walletDebit = this.walletLamports(before.wallet) - this.walletLamports(after.wallet);
      if (kind !== 'buy') {
        requireValue(this.tokenUnits(after.sol, this.solAta, SOL_MINT) === beforeSol
          && this.accountLamports(after.sol) === this.accountLamports(before.sol)
          && this.accountLamports(after.jito) === this.accountLamports(before.jito), 'simulation_unrelated_token_change');
        if (kind !== 'withdraw') requireValue(this.tokenUnits(after.jito, this.jitoAta, JITOSOL_MINT) === beforeJito, 'simulation_unrelated_token_change');
      }
      if (kind === 'buy') {
        const actualDelta = this.tokenUnits(after.jito, this.jitoAta, JITOSOL_MINT) - beforeJito;
        requireValue(actualDelta >= positive(expected.minJitoReceivedUnits), 'simulation_jito_below_minimum');
        requireValue(after.sol === null, 'simulation_wsol_not_closed');
        const rent = rpcInteger(await this.rpc.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, COMMITMENT));
        const jitoRentDelta = this.accountLamports(after.jito) - this.accountLamports(before.jito);
        const solRentDelta = this.accountLamports(after.sol) - this.accountLamports(before.sol);
        requireValue(jitoRentDelta >= 0n && jitoRentDelta <= (before.jito ? 0n : rent)
          && solRentDelta <= (before.sol ? 0n : rent), 'simulation_rent_exceeds_bound');
        const economicDebit = walletDebit - fee - jitoRentDelta - solRentDelta;
        requireValue(economicDebit === amount(config.inputLamports), 'simulation_wallet_debit_mismatch');
        requireValue(this.walletLamports(after.wallet) >= amount(config.reserveLamports), 'simulation_reserve_insufficient');
      } else if (kind === 'withdraw') {
        requireValue(plan !== undefined && after.stake !== null && before.stake === null, 'simulation_stake_missing');
        requireValue(beforeJito - this.tokenUnits(after.jito, this.jitoAta, JITOSOL_MINT) === positive(position.actualJitoReceivedUnits), 'simulation_jito_burn_mismatch');
        const actualStake = decodeStakeAccount(after.stake); this.assertStakeAuthority(actualStake);
        requireValue(actualStake.state === 'delegated' && actualStake.deactivationEpoch === MAX_U64
          && actualStake.rentExemptReserve === plan.rentLamports
          && actualStake.lamports - plan.rentLamports >= plan.expectedMinimumRedemptionLamports
          && actualStake.delegatedLamports >= plan.expectedMinimumRedemptionLamports, 'simulation_stake_principal_mismatch');
        requireValue(walletDebit === fee + plan.rentLamports, 'simulation_withdraw_debit_mismatch');
      } else if (kind === 'deactivate') {
        requireValue(before.stake !== null && after.stake !== null, 'simulation_stake_missing');
        const actualStake = decodeStakeAccount(after.stake); this.assertStakeAuthority(actualStake);
        requireValue(actualStake.state === 'delegated' && actualStake.deactivationEpoch !== MAX_U64
          && actualStake.lamports === this.accountLamports(before.stake) && walletDebit === fee, 'simulation_deactivation_mismatch');
      } else {
        requireValue(before.stake !== null && after.stake === null && plan !== undefined, 'simulation_claim_not_closed');
        requireValue(-walletDebit + fee === this.accountLamports(before.stake), 'simulation_claim_credit_mismatch');
      }
      if (kind === 'buy') requireValue(observation !== undefined && evaluateObservation(observation, config, this.now()).eligible, 'entry_observation_expired');
      this.assertLive();
      const message = built.transaction.message.serialize();
      const signed = await required(this.signer, 'signer_missing').signMessage(message);
      requireValue(signed.signature.length === 64 && this.validSignature(message, signed.signature), 'signer_invalid_signature');
      built.transaction.signatures[0] = new Uint8Array(signed.signature);
      const wire = built.transaction.serialize(); requireValue(wire.length <= MAX_PACKET_BYTES, 'wire_size_exceeded');
      return { kind, signature: bs58.encode(signed.signature), wireTransactionBase64: Buffer.from(wire).toString('base64'),
        lastValidBlockHeight: built.lastValidBlockHeight, preparedAtMs: safeSlot(this.now()), estimatedFeeLamports: fee.toString(), expected };
    });
  }

  async broadcast(transaction: PendingTransaction): Promise<void> {
    this.assertLive();
    return this.sanitized('broadcast_failed', async () => {
      this.decodeWire(transaction);
      await this.ensureMainnet();
      const sent = await this.rpc.sendRawTransaction(Buffer.from(transaction.wireTransactionBase64, 'base64'),
        { skipPreflight: false, maxRetries: 0, preflightCommitment: COMMITMENT });
      requireValue(sent === transaction.signature, 'broadcast_signature_mismatch');
    });
  }

  async poll(transaction: PendingTransaction): Promise<SignatureResult> {
    try {
      const wire = this.decodeWire(transaction);
      await this.pollRpc(() => this.ensureMainnet());
      const response = await this.pollRpc(() => this.rpc.getSignatureStatuses([transaction.signature], { searchTransactionHistory: true }));
      requireValue(response.value.length === 1, 'invalid_signature_status');
      const status = response.value[0];
      if (status === null) {
        const height = await this.pollRpc(() => this.rpc.getBlockHeight('finalized'));
        return rpcInteger(height) > rpcInteger(transaction.lastValidBlockHeight)
          ? { status: 'expired', reason: 'signature_absent_after_expiry' } : { status: 'pending' };
      }
      requireValue(status !== undefined, 'invalid_signature_status');
      if (status.confirmationStatus === 'processed' || status.confirmationStatus === 'confirmed') return { status: 'pending' };
      requireValue(status.confirmationStatus === 'finalized', 'unknown_confirmation_status');
      const receipt = await this.pollRpc(() => this.rpc.getTransaction(transaction.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }));
      if (receipt === null) return { status: 'pending' };
      requireValue(receipt.meta !== null && receipt.slot === status.slot
        && receipt.transaction.signatures.length === 1 && receipt.transaction.signatures[0] === transaction.signature
        && Buffer.from(receipt.transaction.message.serialize()).equals(Buffer.from(wire.message.serialize())), 'receipt_identity_mismatch');
      const fee = rpcInteger(receipt.meta.fee);
      requireValue(fee > 0n && (receipt.meta.err === null) === (status.err === null), 'receipt_status_mismatch');
      if (receipt.meta.err !== null) return { status: 'failed', effects: { feeLamports: fee.toString() }, error: 'transaction_failed' };
      return { status: 'finalized', effects: this.receiptEffects(transaction, receipt, fee) };
    } catch (error) {
      if (error instanceof RetryablePollError) throw new GatewayError('poll_rpc_unavailable');
      return { status: 'unknown', reason: 'receipt_unavailable_or_inconsistent' };
    }
  }

  async canClaim(position: Position): Promise<{ inactive: boolean; observedAtMs: number; claimableLamports: string }> {
    return this.sanitized('claim_readiness_failed', async () => {
      await this.ensureMainnet();
      const stakeAccount = await this.positionStake(position);
      const account = await this.rpc.getAccountInfo(stakeAccount, COMMITMENT);
      requireValue(account !== null, 'stake_missing');
      const stake = decodeStakeAccount(account); this.assertStakeAuthority(stake);
      const epoch = rpcInteger((await this.rpc.getEpochInfo(COMMITMENT)).epoch);
      if (stake.state === 'delegated' && (stake.deactivationEpoch === MAX_U64 || stake.deactivationEpoch === null || stake.deactivationEpoch >= epoch)) {
        return { inactive: false, observedAtMs: safeSlot(this.now()), claimableLamports: '0' };
      }
      const state = { cooldownFailure: false };
      try {
        const plan = await buildClaimPlan({ rpc: this.rpc, wallet: this.wallet, stakeAccount,
          simulateUnsigned: async (instructions) => {
            const result = await this.simulateClaim(instructions);
            state.cooldownFailure = isCooldownError(result.err); return result;
          } });
        return { inactive: true, observedAtMs: safeSlot(this.now()), claimableLamports: plan.expectedMinimumRedemptionLamports.toString() };
      } catch (error) {
        if (state.cooldownFailure) return { inactive: false, observedAtMs: safeSlot(this.now()), claimableLamports: '0' };
        throw error;
      }
    });
  }

  private assertConfig(config: JitoBotConfig): void {
    requireValue(config.walletAddress === this.wallet.toBase58() && config.jitoMintAddress === JITOSOL_MINT.toBase58()
      && config.stakePoolAddress === JITO_POOL_ADDRESS.toBase58(), 'configuration_identity_mismatch');
  }
  private assertLive(): void {
    requireValue(this.liveEnabled, 'gateway_disabled');
    requireValue(this.signer?.publicKey === this.wallet.toBase58(), 'signer_identity_mismatch');
  }
  private async ensureMainnet(): Promise<void> {
    if (!this.mainnetChecked) {
      requireValue(await this.rpc.getGenesisHash() === MAINNET_GENESIS_HASH, 'cluster_mismatch'); this.mainnetChecked = true;
    }
  }
  private async sanitized<T>(fallback: string, operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) { throw error instanceof GatewayError ? error : new GatewayError(fallback); }
  }
  private async pollRpc<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new RetryablePollError('poll_rpc_unavailable');
    }
  }
  private accountLamports(account: AccountInfo<Buffer> | null): bigint { return account ? rpcInteger(account.lamports) : 0n; }
  private walletLamports(account: AccountInfo<Buffer> | null): bigint {
    requireValue(account === null || (account.owner.equals(SystemProgram.programId) && !account.executable && account.data.length === 0), 'invalid_wallet_account');
    return this.accountLamports(account);
  }
  private tokenUnits(account: AccountInfo<Buffer> | null, address: PublicKey, mint: PublicKey): bigint {
    if (account === null) return 0n;
    requireValue(!account.executable && account.owner.equals(TOKEN_PROGRAM_ID) && account.data.length === ACCOUNT_SIZE, 'invalid_token_account');
    const token = unpackAccount(address, account, TOKEN_PROGRAM_ID);
    requireValue(token.owner.equals(this.wallet) && token.mint.equals(mint) && token.isInitialized && !token.isFrozen
      && token.delegate === null && token.delegatedAmount === 0n
      && (token.closeAuthority === null || token.closeAuthority.equals(this.wallet))
      && token.isNative === mint.equals(SOL_MINT), 'invalid_token_authority_or_mint');
    this.accountLamports(account); return token.amount;
  }
  private async readWallet(minContextSlot: number, stake?: PublicKey): Promise<WalletAccounts> {
    const response = await this.rpc.getMultipleAccountsInfoAndContext([this.wallet, this.jitoAta, this.solAta, ...(stake ? [stake] : [])],
      { commitment: COMMITMENT, minContextSlot });
    requireValue(safeSlot(response.context.slot) >= minContextSlot && response.value.length === (stake ? 4 : 3), 'invalid_wallet_context');
    return { wallet: response.value[0] ?? null, jito: response.value[1] ?? null, sol: response.value[2] ?? null,
      stake: response.value[3] ?? null, slot: response.context.slot };
  }
  private assertStakeAuthority(stake: ReturnType<typeof decodeStakeAccount>): void {
    requireValue(stake.staker.equals(this.wallet) && stake.withdrawer.equals(this.wallet) && stake.lockupEpoch === 0n
      && stake.lockupUnixTimestamp === 0n && stake.lockupCustodian.equals(PublicKey.default), 'invalid_stake_authority');
  }
  private async positionStake(position: Position): Promise<PublicKey> {
    requireValue(position.stakeAddress !== undefined, 'position_stake_missing');
    const derived = await deriveStakeDestination(this.wallet, position.id);
    requireValue(derived.stakeAccount.toBase58() === position.stakeAddress, 'position_stake_mismatch');
    return derived.stakeAccount;
  }
  private async rejectUnrelatedOwnedAccounts(instructions: TransactionInstruction[], minContextSlot: number): Promise<void> {
    const unique = new Map<string, PublicKey>();
    for (const instruction of instructions) for (const key of instruction.keys) {
      requireValue(!key.isSigner || key.pubkey.equals(this.wallet), 'unexpected_required_signer');
      if (key.isWritable && !key.pubkey.equals(this.wallet) && !key.pubkey.equals(this.jitoAta) && !key.pubkey.equals(this.solAta)) unique.set(key.pubkey.toBase58(), key.pubkey);
    }
    const keys = [...unique.values()]; requireValue(keys.length <= 256, 'too_many_writable_accounts');
    for (let index = 0; index < keys.length; index += 100) {
      const batch = keys.slice(index, index + 100);
      const response = await this.rpc.getMultipleAccountsInfoAndContext(batch, { commitment: COMMITMENT, minContextSlot });
      requireValue(safeSlot(response.context.slot) >= minContextSlot && response.value.length === batch.length, 'invalid_route_account_context');
      for (const account of response.value) {
        if (account === null) continue;
        if (account.owner.equals(TOKEN_PROGRAM_ID) || account.owner.equals(TOKEN_2022_PROGRAM_ID)) {
          requireValue(account.data.length < 64 || !new PublicKey(account.data.subarray(32, 64)).equals(this.wallet), 'unrelated_wallet_token_account');
        } else if (account.owner.equals(StakeProgram.programId)) {
          const stake = decodeStakeAccount(account);
          requireValue(!stake.staker.equals(this.wallet) && !stake.withdrawer.equals(this.wallet), 'unrelated_wallet_stake_account');
        }
      }
    }
  }
  private async buildUnsigned(instructions: TransactionInstruction[], lookupAddresses: PublicKey[], minContextSlot: number): Promise<{ transaction: VersionedTransaction; lastValidBlockHeight: number }> {
    requireValue(instructions.length > 0 && instructions.length <= 32 && lookupAddresses.length <= 32, 'invalid_instruction_count');
    for (const instruction of instructions) {
      requireValue(!instruction.programId.equals(ComputeBudgetProgram.programId), 'remote_compute_budget_forbidden');
      for (const key of instruction.keys) requireValue(!key.isSigner || key.pubkey.equals(this.wallet), 'unexpected_required_signer');
    }
    const lookups: AddressLookupTableAccount[] = [];
    for (const address of lookupAddresses) {
      const response = await this.rpc.getAddressLookupTable(address, { commitment: COMMITMENT, minContextSlot });
      requireValue(response.value !== null && response.value.key.equals(address) && response.value.isActive()
        && safeSlot(response.context.slot) >= minContextSlot, 'lookup_table_unavailable'); lookups.push(response.value);
    }
    const recent = await this.rpc.getLatestBlockhash({ commitment: COMMITMENT, minContextSlot });
    safeSlot(recent.lastValidBlockHeight);
    const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: this.wallet, recentBlockhash: recent.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.computeUnitPrice }), ...instructions],
    }).compileToV0Message(lookups));
    requireValue(transaction.message.header.numRequiredSignatures === 1 && transaction.message.staticAccountKeys[0]?.equals(this.wallet), 'unexpected_required_signer');
    requireValue(transaction.serialize().length <= MAX_PACKET_BYTES, 'wire_size_exceeded');
    return { transaction, lastValidBlockHeight: recent.lastValidBlockHeight };
  }
  private simulationConfig(minContextSlot: number, stake?: PublicKey): SimulateTransactionConfig {
    return { commitment: COMMITMENT, sigVerify: false, replaceRecentBlockhash: false, minContextSlot,
      accounts: { encoding: 'base64', addresses: [this.wallet, this.jitoAta, this.solAta, ...(stake ? [stake] : [])].map((address) => address.toBase58()) } };
  }
  private simulatedAccount(value: SimulatedTransactionAccountInfo | null | undefined): AccountInfo<Buffer> | null {
    if (value === null) return null;
    requireValue(value?.data.length === 2 && value.data[1] === 'base64'
      && typeof value.data[0] === 'string' && value.data[0].length <= 8192, 'invalid_simulation_account');
    const data = Buffer.from(value.data[0], 'base64');
    requireValue(data.toString('base64') === value.data[0], 'invalid_simulation_encoding'); rpcInteger(value.lamports);
    // Agave returns an overwritten account with zero lamports for a close operation,
    // even though that tombstone is removed when the transaction is committed.
    if (value.lamports === 0) return null;
    return { data, owner: new PublicKey(value.owner), lamports: value.lamports, executable: value.executable,
      ...(value.rentEpoch === undefined ? {} : { rentEpoch: value.rentEpoch }) };
  }
  private async simulateClaim(instructions: TransactionInstruction[]): Promise<{ err: unknown }> {
    const built = await this.buildUnsigned(instructions, [], 0);
    const simulation = await this.rpc.simulateTransaction(built.transaction, { commitment: COMMITMENT, sigVerify: false, replaceRecentBlockhash: false });
    return { err: simulation.value.err };
  }
  private validSignature(message: Uint8Array, signature: Uint8Array): boolean {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, this.wallet.toBuffer()]), format: 'der', type: 'spki' });
    return verify(null, message, key, signature);
  }
  private decodeWire(transaction: PendingTransaction): VersionedTransaction {
    requireValue(typeof transaction.wireTransactionBase64 === 'string' && transaction.wireTransactionBase64.length <= 1644, 'invalid_wire_size');
    const bytes = Buffer.from(transaction.wireTransactionBase64, 'base64');
    requireValue(bytes.length > 0 && bytes.length <= MAX_PACKET_BYTES && bytes.toString('base64') === transaction.wireTransactionBase64, 'invalid_wire_encoding');
    let wire: VersionedTransaction;
    try { wire = VersionedTransaction.deserialize(bytes); } catch { throw new GatewayError('invalid_wire'); }
    requireValue(wire.message.version === 0 && wire.message.header.numRequiredSignatures === 1
      && wire.message.staticAccountKeys[0]?.equals(this.wallet) && wire.signatures.length === 1, 'wire_signer_mismatch');
    const signature = wire.signatures[0];
    requireValue(signature !== undefined && bs58.encode(signature) === transaction.signature
      && this.validSignature(wire.message.serialize(), signature), 'wire_signature_invalid');
    requireValue(Buffer.from(wire.serialize()).equals(bytes), 'wire_noncanonical');
    safeSlot(transaction.lastValidBlockHeight); return wire;
  }

  private receiptEffects(transaction: PendingTransaction, receipt: VersionedTransactionResponse, fee: bigint): TransactionEffects {
    const meta = required(receipt.meta, 'receipt_meta_missing');
    const keys = receipt.transaction.message.getAccountKeys(meta.loadedAddresses ? { accountKeysFromLookups: meta.loadedAddresses } : undefined);
    requireValue(meta.preBalances.length === keys.length && meta.postBalances.length === keys.length, 'receipt_balances_missing');
    const pre = meta.preBalances.map(rpcInteger); const post = meta.postBalances.map(rpcInteger);
    const index = (address: PublicKey): number => {
      for (let i = 0; i < keys.length; i++) if (keys.get(i)?.equals(address)) return i;
      return -1;
    };
    const delta = (address: PublicKey): bigint => {
      const i = index(address); return i < 0 ? 0n : required(post[i], 'receipt_balance_missing') - required(pre[i], 'receipt_balance_missing');
    };
    requireValue(index(this.wallet) === 0, 'receipt_payer_mismatch');
    const effects: TransactionEffects = { feeLamports: fee.toString() };
    const tokenBalance = (side: 'pre' | 'post', address: PublicKey, mint: PublicKey): bigint => {
      const i = index(address); const records = side === 'pre' ? meta.preTokenBalances : meta.postTokenBalances;
      requireValue(records !== undefined && records !== null, 'receipt_token_balances_missing');
      const matches = records.filter((record) => record.accountIndex === i);
      requireValue(matches.length <= 1, 'receipt_duplicate_token_balance');
      const record = matches[0];
      if (!record) { requireValue(i < 0 || (side === 'pre' ? pre[i] : post[i]) === 0n, 'receipt_token_balance_missing'); return 0n; }
      requireValue(i >= 0 && record.mint === mint.toBase58() && record.owner === this.wallet.toBase58()
        && record.programId === TOKEN_PROGRAM_ID.toBase58() && record.uiTokenAmount.decimals === 9, 'receipt_token_identity_mismatch');
      return amount(record.uiTokenAmount.amount);
    };
    if (transaction.kind === 'buy') {
      requireValue(index(this.jitoAta) >= 0, 'receipt_jito_account_missing');
      const received = tokenBalance('post', this.jitoAta, JITOSOL_MINT) - tokenBalance('pre', this.jitoAta, JITOSOL_MINT);
      const wsolBefore = tokenBalance('pre', this.solAta, SOL_MINT); const wsolAfter = tokenBalance('post', this.solAta, SOL_MINT);
      requireValue(wsolBefore === 0n && wsolAfter === 0n && received >= positive(transaction.expected.minJitoReceivedUnits), 'receipt_swap_output_mismatch');
      const jitoRent = delta(this.jitoAta); const solRent = delta(this.solAta);
      const spent = -delta(this.wallet) - fee - jitoRent - solRent;
      requireValue(spent > 0n && jitoRent >= 0n, 'receipt_swap_debit_mismatch');
      effects.actualInputLamports = spent.toString(); effects.actualJitoReceivedUnits = received.toString();
      effects.refundableRentLamports = jitoRent.toString();
    } else {
      requireValue(transaction.expected.stakeAddress !== undefined, 'receipt_expected_stake_missing');
      const stake = new PublicKey(transaction.expected.stakeAddress); const i = index(stake);
      requireValue(i >= 0, 'receipt_stake_missing'); effects.stakeAddress = stake.toBase58();
      if (transaction.kind === 'withdraw') {
        const spent = tokenBalance('pre', this.jitoAta, JITOSOL_MINT) - tokenBalance('post', this.jitoAta, JITOSOL_MINT);
        const fundedRent = -delta(this.wallet) - fee;
        requireValue(pre[i] === 0n && required(post[i], 'receipt_balance_missing') > fundedRent && fundedRent > 0n
          && fundedRent === positive(transaction.expected.refundableRentLamports) && spent === positive(transaction.expected.jitoSpentUnits), 'receipt_withdrawal_mismatch');
        requireValue(required(post[i], 'receipt_balance_missing') - fundedRent >= positive(transaction.expected.minimumRedemptionLamports), 'receipt_withdrawal_below_minimum');
        effects.actualJitoSpentUnits = spent.toString(); effects.refundableRentLamports = fundedRent.toString();
      } else if (transaction.kind === 'claim') {
        const claimed = delta(this.wallet) + fee; const rent = amount(required(transaction.expected.refundableRentLamports, 'receipt_expected_rent_missing'));
        requireValue(post[i] === 0n && claimed === pre[i] && claimed > rent, 'receipt_claim_mismatch');
        effects.actualClaimedLamports = claimed.toString(); effects.refundableRentLamports = rent.toString();
      } else {
        requireValue(required(pre[i], 'receipt_balance_missing') > 0n && post[i] === pre[i] && delta(this.wallet) === -fee, 'receipt_deactivation_mismatch');
      }
    }
    return effects;
  }
}

function isCooldownError(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('InstructionError' in error)) return false;
  const instructionError = error.InstructionError;
  if (!Array.isArray(instructionError) || instructionError.length !== 2) return false;
  // Stake withdraw reports InsufficientFunds while active/cooling stake cannot be fully withdrawn.
  return instructionError[0] === 2 && instructionError[1] === 'InsufficientFunds';
}

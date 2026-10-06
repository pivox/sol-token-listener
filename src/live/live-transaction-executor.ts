import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, ACCOUNT_SIZE, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Message, type MessageV0, type TransactionInstruction } from '@solana/web3.js';
import { PUMP_PROGRAM_ID, PUMP_SDK, userVolumeAccumulatorPda as pumpUserVolumeAccumulatorPda } from '../launchpads/pumpfun/official-sdk.js';
import { PUMP_FEE_PROGRAM_ADDRESS } from '../launchpads/pumpfun/constants.js';
import type { LiveOrderIntent, UnresolvedLiveOrder } from './postgres-live-order-journal.js';
import { verifySerializedLiveTransaction, type KeypairLiveSigner } from './keypair-live-signer.js';
import { reconcileLiveTokenBalance, type LiveTokenBalanceReconciliation } from './live-token-reconciliation.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import { PUMPSWAP_INSTRUCTIONS } from '../markets/pumpswap/generated/pumpswap-idl.js';
import { coinCreatorVaultAtaPda, coinCreatorVaultAuthorityPda, GLOBAL_CONFIG_PDA,
  PUMP_AMM_EVENT_AUTHORITY_PDA, PUMP_AMM_FEE_CONFIG_PDA, PUMP_FEE_PROGRAM_ID, poolV2Pda,
  userVolumeAccumulatorPda as pumpSwapUserVolumeAccumulatorPda } from '../markets/pumpswap/official-sdk.js';
import { createHash } from 'node:crypto';

export interface LiveBlockhash {
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

export interface LiveSignatureStatus {
  readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
  readonly err: unknown;
}

export interface LiveTransactionMeta {
  readonly slot: number;
  readonly meta: {
    readonly err: unknown;
    readonly fee: number;
    readonly preBalances?: readonly number[];
    readonly postBalances?: readonly number[];
    readonly preTokenBalances?: readonly unknown[];
    readonly postTokenBalances?: readonly unknown[];
  } | null;
}

export interface LiveTransactionRpc {
  getLatestBlockhash(): Promise<LiveBlockhash>;
  getWalletBalance(wallet: string): Promise<LiveWalletBalance | null>;
  getMessageFee(message: Message | MessageV0): Promise<LiveMessageFee | null>;
  getTokenAccountRentExemption(): Promise<bigint | null>;
  sendRawTransaction(bytes: Uint8Array): Promise<string>;
  getSignatureStatus(signature: string): Promise<LiveSignatureStatus | null>;
  getBlockHeight(): Promise<number>;
  getTransaction(signature: string): Promise<LiveTransactionMeta | null>;
}

export interface LiveWalletBalance {
  readonly lamports: bigint;
  readonly contextSlot: bigint;
  readonly observedAtMs: number;
}

/** RPC getFeeForMessage value includes the base and requested prioritization fee once. */
export interface LiveMessageFee {
  readonly lamports: bigint;
  readonly contextSlot: bigint;
  readonly observedAtMs: number;
}

export interface LiveExecutionJournal {
  prepare(input: LiveOrderIntent): Promise<void>;
  persistSigned(orderId: string, signature: string, signedTransaction: Uint8Array): Promise<void>;
  markSubmitted(orderId: string): Promise<void>;
  markUnknown(orderId: string, diagnostic: Readonly<Record<string, unknown>>): Promise<void>;
  resolve(orderId: string, status: 'CONFIRMED' | 'FAILED' | 'EXPIRED', metadata: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface LiveExecutionResult {
  readonly orderId: string;
  readonly signature: string;
  readonly status: 'CONFIRMED' | 'FAILED' | 'UNKNOWN';
  readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
  readonly transaction: LiveTransactionMeta | null;
  /** Exact wallet/mint delta when transaction metadata is sufficient. */
  readonly tokenBalance: LiveTokenBalanceReconciliation | null;
}

export interface LiveTransactionExecutorOptions {
  readonly commitment: 'confirmed' | 'finalized';
  readonly confirmationPolls: number;
  readonly delayMs: number;
  /** Maximum requested priority fee for one transaction, in lamports. */
  readonly maxPriorityFeeLamports: bigint;
  /** Native SOL kept untouched by a new BUY; SELLs may spend it. */
  readonly exitReserveLamports: bigint;
  readonly maximumBalanceAgeMs?: number;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

const U64_MAX = 18_446_744_073_709_551_615n;
const MAX_COMPUTE_UNITS_PER_TRANSACTION = 1_400_000;
const MAX_DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION = 200_000;
const MAX_LOADED_ACCOUNT_DATA_SIZE_BYTES = 64 * 1024 * 1024;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;
const PUMP_ID = PUMP_PROGRAM_ID.toBase58();
const ALLOWED_PROGRAMS = new Set([
  PUMP_ID,
  PUMPSWAP_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
  ComputeBudgetProgram.programId.toBase58(),
]);

export class LiveTransactionExecutor {
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  public constructor(
    private readonly rpc: LiveTransactionRpc,
    private readonly journal: LiveExecutionJournal,
    private readonly signer: KeypairLiveSigner,
    private readonly options: LiveTransactionExecutorOptions,
  ) {
    if (!Number.isSafeInteger(options.confirmationPolls) || options.confirmationPolls < 1 || options.confirmationPolls > 20
      || !Number.isSafeInteger(options.delayMs) || options.delayMs < 0 || options.delayMs > 10_000
      || typeof options.maxPriorityFeeLamports !== 'bigint' || options.maxPriorityFeeLamports < 0n
      || typeof options.exitReserveLamports !== 'bigint' || options.exitReserveLamports <= 0n
      || (options.maximumBalanceAgeMs !== undefined && (!Number.isSafeInteger(options.maximumBalanceAgeMs) || options.maximumBalanceAgeMs < 1 || options.maximumBalanceAgeMs > 60_000))) {
      throw new TypeError('Live transaction confirmation bounds or priority fee ceiling are invalid.');
    }
    this.delay = options.delay ?? ((milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  public async execute(input: {
    readonly order: Omit<LiveOrderIntent, 'validity'> & { readonly validity: Readonly<Record<string, unknown>> };
    readonly instructions: readonly TransactionInstruction[];
    readonly allowedAccounts: ReadonlySet<string>;
    readonly maxSpendRaw: bigint;
    readonly maxTokenAmountRaw: bigint;
    readonly positionRemainingRaw: bigint;
  }): Promise<LiveExecutionResult> {
    if (input.order.wallet !== this.signer.publicKey) throw new Error('Executor wallet does not match signer.');
    validateInstructions(input);
    const latest = await this.rpc.getLatestBlockhash();
    validateBlockhash(latest);
    const message = new TransactionMessage({
      payerKey: new PublicKey(input.order.wallet),
      recentBlockhash: latest.blockhash,
      instructions: [...input.instructions],
    }).compileToV0Message();
    assertPriorityFeeWithinLimit(message, this.options.maxPriorityFeeLamports);
    if (input.order.side === 'BUY') await this.assertBuyPreservesExitReserve(message, input);
    const intent: LiveOrderIntent = Object.freeze({
      ...input.order,
      validity: Object.freeze({
        ...input.order.validity,
        blockhash: latest.blockhash,
        lastValidBlockHeight: String(latest.lastValidBlockHeight),
      }),
    });
    await this.journal.prepare(intent);

    const transaction = new VersionedTransaction(message);
    const signed = this.signer.sign(transaction);
    await this.journal.persistSigned(input.order.orderId, signed.signature, signed.bytes);
    await this.journal.markSubmitted(input.order.orderId);

    try {
      const returnedSignature = await this.rpc.sendRawTransaction(signed.bytes);
      if (returnedSignature !== signed.signature) {
        return await this.unknown(intent.orderId, signed.signature, 'RPC returned a different signature.');
      }
    } catch {
      return await this.unknown(intent.orderId, signed.signature, 'RPC submission response is unavailable.');
    }

    for (let attempt = 0; attempt < this.options.confirmationPolls; attempt += 1) {
      if (attempt > 0) await this.delay(this.options.delayMs);
      try {
        const status = await this.rpc.getSignatureStatus(signed.signature);
        if (status !== null && status.err !== null) {
          await this.journal.resolve(intent.orderId, 'FAILED', { signature: signed.signature, err: status.err });
          return Object.freeze({ orderId: intent.orderId, signature: signed.signature, status: 'FAILED', confirmationStatus: status.confirmationStatus, transaction: null, tokenBalance: null });
        }
        if (status === null || !meetsCommitment(status.confirmationStatus, this.options.commitment)) continue;
        const chainTransaction = await this.rpc.getTransaction(signed.signature);
        if (chainTransaction === null) return await this.unknown(intent.orderId, signed.signature, 'Confirmed signature has no transaction metadata.');
        if (chainTransaction.meta === null) return await this.unknown(intent.orderId, signed.signature, 'Confirmed signature has no transaction metadata.');
        if (chainTransaction.meta.err !== null) {
          await this.journal.resolve(intent.orderId, 'FAILED', { signature: signed.signature, slot: String(chainTransaction.slot), err: chainTransaction.meta.err });
          return Object.freeze({ orderId: intent.orderId, signature: signed.signature, status: 'FAILED', confirmationStatus: status.confirmationStatus, transaction: chainTransaction, tokenBalance: null });
        }
        const mint = typeof input.order.intent.mint === 'string' ? input.order.intent.mint : '';
        const tokenBalance = reconcileLiveTokenBalance({ transaction: chainTransaction, owner: input.order.wallet, mint });
        await this.journal.resolve(intent.orderId, 'CONFIRMED', {
          signature: signed.signature, slot: String(chainTransaction.slot), commitment: status.confirmationStatus,
          tokenBalance: serializeTokenBalance(tokenBalance),
        });
        return Object.freeze({ orderId: intent.orderId, signature: signed.signature, status: 'CONFIRMED', confirmationStatus: status.confirmationStatus, transaction: chainTransaction, tokenBalance });
      } catch {
        return await this.unknown(intent.orderId, signed.signature, 'RPC confirmation or transaction metadata is unavailable.');
      }
    }
    return await this.unknown(intent.orderId, signed.signature, 'Confirmation poll bound was reached.');
  }

  private async assertBuyPreservesExitReserve(
    message: MessageV0,
    input: { readonly order: LiveOrderIntent; readonly instructions: readonly TransactionInstruction[]; readonly maxSpendRaw: bigint },
  ): Promise<void> {
    const reserve = this.options.exitReserveLamports;
    const fee = await this.rpc.getMessageFee(message);
    if (fee === null || fee.lamports < 0n || fee.contextSlot <= 0n || !Number.isFinite(fee.observedAtMs)) {
      throw new Error('BUY refused: complete transaction fee estimate is unavailable.');
    }
    const tokenAccountCreations = input.instructions.filter((instruction) => instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
    if (tokenAccountCreations.length > 1) throw new Error('BUY refused: more than one payer-funded associated token account creation is unsupported.');
    let rent = 0n;
    if (tokenAccountCreations.length === 1) {
      const creation = tokenAccountCreations[0];
      if (creation === undefined) throw new Error('BUY refused: associated token account instruction is missing.');
      validateBuyAssociatedTokenCreation(creation, input.order);
      const estimate = await this.rpc.getTokenAccountRentExemption();
      if (estimate === null || estimate < 0n) throw new Error('BUY refused: associated token account rent estimate is unavailable.');
      rent = estimate;
    }
    const balance = await this.rpc.getWalletBalance(input.order.wallet);
    const now = this.now();
    const maxAgeMs = this.options.maximumBalanceAgeMs ?? 5_000;
    if (balance === null || balance.lamports < 0n || balance.contextSlot <= 0n
      || balance.contextSlot < fee.contextSlot
      || !Number.isFinite(balance.observedAtMs) || balance.observedAtMs > now
      || now - balance.observedAtMs > maxAgeMs) {
      throw new Error('BUY refused: wallet balance is missing, stale, or older than the transaction fee context.');
    }
    // getFeeForMessage already includes base + prioritization fee. Do not add
    // maxPriorityFeeLamports again. ATA rent is separate from quote spend.
    const required = input.maxSpendRaw + fee.lamports + rent + reserve;
    if (balance.lamports < required) {
      throw new Error(`BUY refused: wallet balance would fall below the configured exit reserve (need ${required} lamports, observed ${balance.lamports}).`);
    }
  }

  /** Reconciles an existing signature and, only while valid, may resend its exact persisted bytes. */
  public async resume(order: UnresolvedLiveOrder): Promise<LiveExecutionResult> {
    if (order.signature === null || order.signedTransaction === null) {
      return this.unknown(order.orderId, order.signature ?? '', 'Prepared order has no persisted signature; no new transaction was created.');
    }
    let signedTransaction: VersionedTransaction;
    try {
      const signature = verifySerializedLiveTransaction(order.signedTransaction, order.wallet);
      if (signature !== order.signature) return await this.unknown(order.orderId, order.signature, 'Persisted signature does not match signed bytes.');
      signedTransaction = VersionedTransaction.deserialize(order.signedTransaction);
      const blockhash = order.validity.blockhash;
      const lastValidBlockHeight = Number(order.validity.lastValidBlockHeight);
      if (signedTransaction.message.recentBlockhash !== blockhash || !Number.isSafeInteger(lastValidBlockHeight)) {
        return await this.unknown(order.orderId, order.signature, 'Persisted validity does not match signed message.');
      }

      let status = await this.rpc.getSignatureStatus(order.signature);
      if (status !== null && status.err !== null) return await this.failed(order, status.err);
      if (status !== null && meetsCommitment(status.confirmationStatus, this.options.commitment)) {
        return await this.fetchConfirmed(order.orderId, order.signature, status.confirmationStatus, order.wallet, order.intent.mint);
      }
      assertPriorityFeeWithinLimit(signedTransaction.message, this.options.maxPriorityFeeLamports);
      const currentHeight = await this.rpc.getBlockHeight();
      if (currentHeight > lastValidBlockHeight) {
        return await this.unknown(order.orderId, order.signature, 'Blockhash expired but transaction status is not conclusive; new order remains blocked.');
      }
      if (order.status === 'SIGNED') await this.journal.markSubmitted(order.orderId);
      const returnedSignature = await this.rpc.sendRawTransaction(order.signedTransaction);
      if (returnedSignature !== order.signature) return await this.unknown(order.orderId, order.signature, 'RPC returned a different signature for persisted bytes.');
      for (let attempt = 0; attempt < this.options.confirmationPolls; attempt += 1) {
        if (attempt > 0) await this.delay(this.options.delayMs);
        status = await this.rpc.getSignatureStatus(order.signature);
        if (status !== null && status.err !== null) return await this.failed(order, status.err);
        if (status !== null && meetsCommitment(status.confirmationStatus, this.options.commitment)) {
          return await this.fetchConfirmed(order.orderId, order.signature, status.confirmationStatus, order.wallet, order.intent.mint);
        }
      }
      return await this.unknown(order.orderId, order.signature, 'Persisted transaction remains unresolved after bounded replay.');
    } catch {
      return await this.unknown(order.orderId, order.signature, 'Could not safely reconcile or replay persisted transaction bytes.');
    }
  }

  private async unknown(orderId: string, signature: string, reason: string): Promise<LiveExecutionResult> {
    await this.journal.markUnknown(orderId, { signature, reason });
    return Object.freeze({ orderId, signature, status: 'UNKNOWN', confirmationStatus: null, transaction: null, tokenBalance: null });
  }

  private async failed(order: UnresolvedLiveOrder, error: unknown): Promise<LiveExecutionResult> {
    const signature = order.signature;
    if (signature === null) throw new Error('Cannot record a failed live order without its signature.');
    await this.journal.resolve(order.orderId, 'FAILED', { signature, err: error });
    return Object.freeze({ orderId: order.orderId, signature, status: 'FAILED', confirmationStatus: null, transaction: null, tokenBalance: null });
  }

  private async fetchConfirmed(
    orderId: string,
    signature: string,
    confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null,
    wallet: string,
    mintValue: unknown,
  ): Promise<LiveExecutionResult> {
    const transaction = await this.rpc.getTransaction(signature);
    if (transaction === null) return await this.unknown(orderId, signature, 'Confirmed signature has no transaction metadata.');
    if (transaction.meta === null) return await this.unknown(orderId, signature, 'Confirmed signature has no transaction metadata.');
    if (transaction.meta.err !== null) {
      await this.journal.resolve(orderId, 'FAILED', { signature, slot: String(transaction.slot), err: transaction.meta.err });
      return Object.freeze({ orderId, signature, status: 'FAILED', confirmationStatus, transaction, tokenBalance: null });
    }
    const tokenBalance = reconcileLiveTokenBalance({
      transaction, owner: wallet, mint: typeof mintValue === 'string' ? mintValue : '',
    });
    await this.journal.resolve(orderId, 'CONFIRMED', {
      signature, slot: String(transaction.slot), commitment: confirmationStatus,
      tokenBalance: serializeTokenBalance(tokenBalance),
    });
    return Object.freeze({ orderId, signature, status: 'CONFIRMED', confirmationStatus, transaction, tokenBalance });
  }
}

/** Validates the compiled message so builder-added Compute Budget instructions cannot bypass the cap. */
export function assertPriorityFeeWithinLimit(message: Message | MessageV0, maximumLamports: bigint): bigint {
  if (typeof maximumLamports !== 'bigint' || maximumLamports < 0n) {
    throw new TypeError('Priority fee ceiling must be a non-negative integer.');
  }
  const instructions = TransactionMessage.decompile(message).instructions;
  let requestedComputeUnits: number | null = null;
  let microLamportsPerComputeUnit: bigint | null = null;
  let requestedHeapFrame: number | null = null;
  let requestedLoadedAccountDataSize: number | null = null;
  for (const instruction of instructions) {
    if (!instruction.programId.equals(ComputeBudgetProgram.programId)) continue;
    const data = instruction.data;
    const discriminator = data[0];
    if (discriminator === 1) {
      if (data.length !== 5 || requestedHeapFrame !== null) throw new Error('Malformed or duplicate Compute Budget heap-frame instruction.');
      requestedHeapFrame = data.readUInt32LE(1);
      if (requestedHeapFrame < 32_768 || requestedHeapFrame > 262_144 || requestedHeapFrame % 1_024 !== 0) {
        throw new Error('Compute Budget heap-frame request is outside the supported range.');
      }
    } else if (discriminator === 2) {
      if (data.length !== 5 || requestedComputeUnits !== null) {
        throw new Error('Malformed or duplicate Compute Budget instruction.');
      }
      requestedComputeUnits = data.readUInt32LE(1);
      if (requestedComputeUnits < 1 || requestedComputeUnits > MAX_COMPUTE_UNITS_PER_TRANSACTION) {
        throw new Error('Compute Budget unit limit is outside the supported transaction range.');
      }
    } else if (discriminator === 3) {
      if (data.length !== 9 || microLamportsPerComputeUnit !== null) {
        throw new Error('Malformed or duplicate Compute Budget instruction.');
      }
      microLamportsPerComputeUnit = data.readBigUInt64LE(1);
    } else if (discriminator === 4) {
      if (data.length !== 5 || requestedLoadedAccountDataSize !== null) {
        throw new Error('Malformed or duplicate Compute Budget loaded-account-data instruction.');
      }
      requestedLoadedAccountDataSize = data.readUInt32LE(1);
      if (requestedLoadedAccountDataSize < 1 || requestedLoadedAccountDataSize > MAX_LOADED_ACCOUNT_DATA_SIZE_BYTES) {
        throw new Error('Compute Budget loaded-account-data request is outside the supported range.');
      }
    } else {
      throw new Error('Unsupported Compute Budget instruction in live transaction.');
    }
  }

  if (microLamportsPerComputeUnit === null || microLamportsPerComputeUnit === 0n) return 0n;
  // Runtime defaults vary by instruction class/features; 200k per non-budget instruction
  // is a conservative upper bound, clamped to the transaction maximum.
  const defaultUnitBound = Math.min(
    instructions.filter((instruction) => !instruction.programId.equals(ComputeBudgetProgram.programId)).length
      * MAX_DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION,
    MAX_COMPUTE_UNITS_PER_TRANSACTION,
  );
  const effectiveUnitBound = BigInt(requestedComputeUnits ?? defaultUnitBound);
  const numerator = microLamportsPerComputeUnit * effectiveUnitBound;
  const priorityFeeLamports = (numerator + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT;
  if (priorityFeeLamports > maximumLamports) {
    throw new Error(`Requested priority fee ${priorityFeeLamports} lamports exceeds configured per-transaction cap ${maximumLamports} lamports.`);
  }
  return priorityFeeLamports;
}

function serializeTokenBalance(balance: LiveTokenBalanceReconciliation): Readonly<Record<string, string>> {
  if (balance.status === 'UNKNOWN') return Object.freeze({ status: balance.status, reason: balance.reason });
  return Object.freeze({
    status: balance.status,mint: balance.mint,owner: balance.owner,
    preAmountRaw: balance.preAmountRaw.toString(),postAmountRaw: balance.postAmountRaw.toString(),
    deltaRaw: balance.deltaRaw.toString(),
  });
}

function validateInstructions(input: {
  readonly order: LiveOrderIntent;
  readonly instructions: readonly TransactionInstruction[];
  readonly allowedAccounts: ReadonlySet<string>;
  readonly maxSpendRaw: bigint;
  readonly maxTokenAmountRaw: bigint;
  readonly positionRemainingRaw: bigint;
}): void {
  if (input.instructions.length === 0 || input.allowedAccounts.size === 0) throw new Error('Live transaction instructions or account allowlist are empty.');
  if (input.maxSpendRaw < 0n || input.maxTokenAmountRaw <= 0n || input.positionRemainingRaw < 0n) throw new Error('Live transaction quantity limits are invalid.');
  let pumpInstructions = 0;
  let pumpSwapInstructions = 0;
  for (const instruction of input.instructions) {
    if (instruction.programId.equals(SystemProgram.programId)) {
      throw new Error('Top-level System Program transfers and tips are not authorized by the live executor.');
    }
    if (!ALLOWED_PROGRAMS.has(instruction.programId.toBase58())) throw new Error('Live transaction contains a disallowed program.');
    if (!input.allowedAccounts.has(instruction.programId.toBase58())) throw new Error('Live transaction program is outside the account allowlist.');
    for (const key of instruction.keys) {
      if (!input.allowedAccounts.has(key.pubkey.toBase58())) throw new Error('Live transaction account is outside the allowlist.');
    }
    if (instruction.programId.toBase58() === PUMPSWAP_PROGRAM_ID) {
      if (input.order.side !== 'SELL' || input.order.intent.market !== 'pumpswap') {
        throw new Error('PumpSwap is authorized only for a migrated-position SELL.');
      }
      if (instruction.data.length !== 24
        || !PUMPSWAP_INSTRUCTIONS.sell.discriminator.every((byte,index)=>instruction.data[index]===byte)) {
        validatePumpSwapAuxiliary(instruction,input.order);
        continue;
      }
      pumpSwapInstructions += 1;
      const baseAmount = instruction.data.readBigUInt64LE(8);
      const minimumQuoteOut = instruction.data.readBigUInt64LE(16);
      const poolAddress = input.order.intent.poolAddress;
      const quoteMint = input.order.intent.quoteMint;
      const coinCreator = input.order.intent.poolCoinCreator;
      const baseVault = input.order.intent.poolBaseVault;
      const quoteVault = input.order.intent.poolQuoteVault;
      const buybackRecipient = input.order.intent.buybackFeeRecipient;
      const buybackRecipientAta = input.order.intent.buybackFeeRecipientTokenAccount;
      const expectedCoinCreator=typeof coinCreator==='string'?new PublicKey(coinCreator):null;
      const creatorAuthority=expectedCoinCreator===null?null:coinCreatorVaultAuthorityPda(expectedCoinCreator);
      const expectedCoinCreatorAta=creatorAuthority===null||typeof quoteMint!=='string'?null:
        coinCreatorVaultAtaPda(creatorAuthority,new PublicKey(quoteMint),TOKEN_PROGRAM_ID);
      const creatorIsDefault=expectedCoinCreator?.equals(PublicKey.default)===true;
      const mismatches: string[] = [];
      const keyMatches = (index: number, expected: string, label: string): void => {
        if (instruction.keys[index]?.pubkey.toBase58() !== expected) mismatches.push(label);
      };
      if (typeof poolAddress !== 'string') mismatches.push('pool-intent');
      else keyMatches(0, poolAddress, 'pool-account');
      keyMatches(1, input.order.wallet, 'wallet');
      keyMatches(2, GLOBAL_CONFIG_PDA.toBase58(), 'global-config');
      const baseMint = input.order.intent.mint;
      const baseTokenProgram = input.order.intent.tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID
        : input.order.intent.tokenProgram === TOKEN_PROGRAM_ID.toBase58() ? TOKEN_PROGRAM_ID : null;
      if (baseTokenProgram === null) mismatches.push('unsupported-base-token-program');
      if (typeof baseMint !== 'string') mismatches.push('base-mint-intent');
      else {
        keyMatches(3, baseMint, 'base-mint');
        if (baseTokenProgram !== null) keyMatches(5, getAssociatedTokenAddressSync(new PublicKey(baseMint), new PublicKey(input.order.wallet), false, baseTokenProgram).toBase58(), 'user-base-ata');
      }
      if (typeof quoteMint !== 'string') mismatches.push('quote-mint-intent');
      else {
        keyMatches(4, quoteMint, 'quote-mint');
        keyMatches(6, getAssociatedTokenAddressSync(new PublicKey(quoteMint), new PublicKey(input.order.wallet)).toBase58(), 'user-quote-ata');
      }
      if (typeof baseVault !== 'string') mismatches.push('base-vault-intent');
      else keyMatches(7, baseVault, 'base-vault');
      if (typeof quoteVault !== 'string') mismatches.push('quote-vault-intent');
      else keyMatches(8, quoteVault, 'quote-vault');
      if (baseTokenProgram !== null) keyMatches(11, baseTokenProgram.toBase58(), 'base-token-program');
      keyMatches(12, TOKEN_PROGRAM_ID.toBase58(), 'quote-token-program');
      keyMatches(13, SystemProgram.programId.toBase58(), 'system-program');
      keyMatches(14, ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), 'associated-token-program');
      keyMatches(15, PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58(), 'event-authority');
      keyMatches(16, PUMPSWAP_PROGRAM_ID, 'pump-swap-program');
      if (expectedCoinCreatorAta === null) mismatches.push('coin-creator-vault-ata');
      else keyMatches(17, expectedCoinCreatorAta.toBase58(), 'coin-creator-vault-ata');
      if (creatorAuthority === null) mismatches.push('coin-creator-vault-authority');
      else keyMatches(18, creatorAuthority.toBase58(), 'coin-creator-vault-authority');
      keyMatches(19, PUMP_AMM_FEE_CONFIG_PDA.toBase58(), 'fee-config');
      keyMatches(20, PUMP_FEE_PROGRAM_ID.toBase58(), 'fee-program');
      const cashback=input.order.intent.cashback===true;
      const poolV2Index=21+(cashback?2:0);
      if(cashback){
        const accumulator=pumpSwapUserVolumeAccumulatorPda(new PublicKey(input.order.wallet));
        const accumulatorAta=getAssociatedTokenAddressSync(new PublicKey(quoteMint as string),accumulator,true,TOKEN_PROGRAM_ID);
        const ataMeta=instruction.keys[21];const accumulatorMeta=instruction.keys[22];
        if(ataMeta?.pubkey.toBase58()!==accumulatorAta.toBase58()||!ataMeta.isWritable||ataMeta.isSigner
          ||accumulatorMeta?.pubkey.toBase58()!==accumulator.toBase58()||!accumulatorMeta.isWritable||accumulatorMeta.isSigner){
          mismatches.push('cashback-remaining-account-order-or-derivation');
        }
      }
      const buybackIndex = poolV2Index + (creatorIsDefault ? 0 : 1);
      const expectedAccountCount = buybackIndex + 2;
      if (instruction.keys.length !== expectedAccountCount) mismatches.push(`account-count-${instruction.keys.length}-expected-${expectedAccountCount}`);
      if (!creatorIsDefault && typeof input.order.intent.mint === 'string') {
        keyMatches(poolV2Index, poolV2Pda(new PublicKey(input.order.intent.mint)).toBase58(), 'pool-v2');
      }
      if (typeof buybackRecipient !== 'string' || typeof buybackRecipientAta !== 'string' || typeof quoteMint !== 'string') {
        mismatches.push('buyback-intent');
      } else {
        keyMatches(buybackIndex, buybackRecipient, 'buyback-recipient');
        keyMatches(buybackIndex + 1, buybackRecipientAta, 'buyback-recipient-ata');
        if (getAssociatedTokenAddressSync(new PublicKey(quoteMint), new PublicKey(buybackRecipient), true, TOKEN_PROGRAM_ID).toBase58() !== buybackRecipientAta) {
          mismatches.push('buyback-recipient-ata-derivation');
        }
      }
      if (baseAmount <= 0n || minimumQuoteOut <= 0n) mismatches.push('non-positive-amount');
      if (baseAmount > input.positionRemainingRaw || baseAmount > input.maxTokenAmountRaw) mismatches.push('sell-exceeds-position');
      if (mismatches.length > 0) {
        throw new Error(`PumpSwap SELL validation failed: ${mismatches.join(',')}.`);
      }
      continue;
    }
    if (instruction.programId.toBase58() !== PUMP_ID) continue;
    pumpInstructions += 1;
    if (instruction.data.length !== 24) throw new Error('Pump.fun V2 instruction has an unexpected data length.');
    const decoded = pumpDecoder().decode(instruction.data);
    const expectedName = input.order.side === 'BUY' ? 'buyV2' : 'sellV2';
    if (decoded?.name !== expectedName) throw new Error('Pump.fun instruction side does not match the order.');
    const firstAmount = instruction.data.readBigUInt64LE(8);
    const secondAmount = instruction.data.readBigUInt64LE(16);
    if (firstAmount <= 0n || secondAmount <= 0n || firstAmount > U64_MAX || secondAmount > U64_MAX) {
      throw new Error('Pump.fun instruction contains an invalid amount.');
    }
    if (input.order.side === 'BUY' && (firstAmount > input.maxTokenAmountRaw || secondAmount > input.maxSpendRaw)) {
      throw new Error('Pump.fun BUY exceeds its token or quote budget.');
    }
    if (input.order.side === 'SELL' && (firstAmount > input.positionRemainingRaw || input.positionRemainingRaw === 0n)) {
      throw new Error('Pump.fun SELL exceeds the recorded position quantity.');
    }
    if(input.order.side==='SELL'){
      const quoteMint=input.order.intent.quoteMint;
      if(typeof quoteMint!=='string')throw new Error('Pump.fun SELL quote mint is missing from the durable intent.');
      const accumulator=pumpUserVolumeAccumulatorPda(new PublicKey(input.order.wallet));
      const accumulatorAta=getAssociatedTokenAddressSync(new PublicKey(quoteMint),accumulator,true,TOKEN_PROGRAM_ID).toBase58();
      if(!instruction.keys.some((key)=>key.pubkey.toBase58()===accumulatorAta&&key.isWritable&&!key.isSigner)){
        throw new Error('Pump.fun V2 SELL is missing its SDK-defined associated user volume accumulator account.');
      }
    }
  }
  if (input.order.intent.market === 'pumpswap') {
    if (pumpInstructions !== 0 || pumpSwapInstructions !== 1) {
      throw new Error('Migrated live order must contain exactly one PumpSwap SELL and no Pump.fun instruction.');
    }
  } else if (pumpInstructions !== 1 || pumpSwapInstructions !== 0) {
    throw new Error('Bonding-curve live order must contain exactly one Pump.fun V2 instruction.');
  }
}

function validatePumpSwapAuxiliary(
  instruction: TransactionInstruction,
  order: LiveOrderIntent,
): void {
  const program = instruction.programId.toBase58();
  const wallet = order.wallet;
  const pool = order.intent.poolAddress;
  const quoteMint = order.intent.quoteMint;
  if (program === PUMPSWAP_PROGRAM_ID) {
    const extendDiscriminator = createHash('sha256').update('global:extend_account').digest().subarray(0,8);
    if (typeof pool !== 'string' || instruction.data.length !== 8
      || !extendDiscriminator.equals(instruction.data.subarray(0,8))
      || instruction.keys[0]?.pubkey.toBase58() !== pool
      || instruction.keys[1]?.pubkey.toBase58() !== wallet
      || instruction.keys[2]?.pubkey.toBase58()!==SystemProgram.programId.toBase58()
      || instruction.keys[3]?.pubkey.toBase58()!==PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58()
      || instruction.keys[4]?.pubkey.toBase58()!==PUMPSWAP_PROGRAM_ID
      || instruction.keys.length !== 5) {
      throw new Error('PumpSwap auxiliary instruction is not the scoped pool extension.');
    }
    return;
  }
  if (program === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) {
    const quoteProgramIndex=instruction.keys[5]?.pubkey.toBase58();
    if (typeof quoteMint !== 'string' || instruction.data.length !== 1 || instruction.data[0] !== 1
      || instruction.keys[0]?.pubkey.toBase58() !== wallet
      || instruction.keys[2]?.pubkey.toBase58() !== wallet
      || instruction.keys[3]?.pubkey.toBase58() !== quoteMint
      || instruction.keys[4]?.pubkey.toBase58()!==SystemProgram.programId.toBase58()
      || quoteProgramIndex!==TOKEN_PROGRAM_ID.toBase58()||instruction.keys.length!==6
      || instruction.keys[1]?.pubkey.toBase58() !== getAssociatedTokenAddressSync(new PublicKey(quoteMint),new PublicKey(wallet)).toBase58()) {
      throw new Error('PumpSwap auxiliary ATA instruction is not the expected idempotent quote ATA creation.');
    }
    return;
  }
  throw new Error('PumpSwap SELL contains an unsupported auxiliary instruction.');
}

function pumpDecoder(): { decode(data: Buffer): { name: string } | null } {
  const sdk = PUMP_SDK as unknown as {
    offlinePumpProgram: { coder: { instruction: { decode(data: Buffer): { name: string } | null } } };
  };
  return sdk.offlinePumpProgram.coder.instruction;
}

function validateBlockhash(value: LiveBlockhash): void {
  try {
    if (new PublicKey(value.blockhash).toBase58() !== value.blockhash) throw new Error();
  } catch {
    throw new TypeError('RPC returned an invalid blockhash.');
  }
  if (!Number.isSafeInteger(value.lastValidBlockHeight) || value.lastValidBlockHeight <= 0) throw new TypeError('RPC returned an invalid lastValidBlockHeight.');
}

function validateBuyAssociatedTokenCreation(instruction: TransactionInstruction, order: LiveOrderIntent): void {
  const keys = instruction.keys;
  const payer = keys[0];
  const associatedAccount = keys[1];
  const owner = keys[2];
  const mintAccount = keys[3];
  const systemProgram = keys[4];
  const tokenProgramAccount = keys[5];
  const mint = typeof order.intent.mint === 'string' ? order.intent.mint : null;
  const tokenProgram = order.intent.tokenProgram === TOKEN_PROGRAM_ID.toBase58() ? TOKEN_PROGRAM_ID
    : order.intent.tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : null;
  if (mint === null || tokenProgram === null || instruction.data.length !== 1 || instruction.data[0] !== 1
    || keys.length !== 6 || payer === undefined || associatedAccount === undefined || owner === undefined
    || mintAccount === undefined || systemProgram === undefined || tokenProgramAccount === undefined
    || payer.pubkey.toBase58() !== order.wallet || !payer.isSigner
    || owner.pubkey.toBase58() !== order.wallet || mintAccount.pubkey.toBase58() !== mint
    || systemProgram.pubkey.toBase58() !== SystemProgram.programId.toBase58()
    || tokenProgramAccount.pubkey.toBase58() !== tokenProgram.toBase58()
    || associatedAccount.pubkey.toBase58() !== getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(order.wallet), false, tokenProgram).toBase58()) {
    throw new Error('BUY refused: associated token account creation is not the expected wallet/mint/token-program ATA.');
  }
  // The initial live eligibility profile rejects Token-2022 extensions that
  // require token-account extensions; MetadataPointer/TokenMetadata are mint-only.
  if (ACCOUNT_SIZE !== 165) throw new Error('BUY refused: token-account rent sizing is unsupported by the locked SPL Token library.');
}

function meetsCommitment(status: LiveSignatureStatus['confirmationStatus'], commitment: 'confirmed' | 'finalized'): boolean {
  return commitment === 'confirmed' ? status === 'confirmed' || status === 'finalized' : status === 'finalized';
}

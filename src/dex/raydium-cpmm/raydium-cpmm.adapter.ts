import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID as TOKEN_2022_PUBLIC_KEY,
  TOKEN_PROGRAM_ID as TOKEN_PUBLIC_KEY,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import type { AppConfig } from '../../config/env.js';
import type { DexAdapter } from '../dex-adapter.js';
import type { BuiltTransaction, PoolInfo, PoolRuntimeState, QuoteResult, SwapEvent } from '../../domain/types.js';
import type { NormalizedTransaction } from '../../solana/rpc/types.js';
import type { SolanaRpcClient } from '../../solana/rpc/rpc-client.js';
import { decodeInitializeInstruction } from './instruction-decoder.js';
import { readPoolState, swapsEnabled } from './pool-decoder.js';
import { classifyTransactionSwaps } from './swap-classifier.js';
import { RaydiumCpmmQuoteService } from './quote-service.js';
import { RaydiumCpmmTransactionBuilder } from './transaction-builder.js';
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './constants.js';

export class RaydiumCpmmAdapter implements DexAdapter {
  readonly dex = 'RAYDIUM_CPMM' as const;
  readonly programId: string;
  private readonly quoteService: RaydiumCpmmQuoteService;
  private readonly transactionBuilder: RaydiumCpmmTransactionBuilder;

  constructor(
    private readonly rpc: SolanaRpcClient,
    private readonly config: Pick<AppConfig,
      'raydiumCpmmProgramId' | 'wsolMint' | 'slippageBps' | 'computeUnitLimit' | 'maxPriorityFeeLamports'>,
  ) {
    this.programId = config.raydiumCpmmProgramId;
    this.quoteService = new RaydiumCpmmQuoteService(rpc.http, config.slippageBps);
    this.transactionBuilder = new RaydiumCpmmTransactionBuilder(
      rpc.http,
      this.quoteService,
      config.slippageBps,
      config.computeUnitLimit,
      config.maxPriorityFeeLamports,
    );
  }

  async discoverPools(transaction: NormalizedTransaction): Promise<PoolInfo[]> {
    if (transaction.error !== null) return [];
    const result: PoolInfo[] = [];
    for (const instruction of transaction.instructions) {
      if (instruction.programId !== this.programId) continue;
      const decoded = decodeInitializeInstruction(instruction);
      if (!decoded) continue;
      const { state } = await readPoolState(this.rpc.http, decoded.pool, this.programId);
      verifyInitializedPool(decoded, state);
      const aIsWsol = state.mintA === this.config.wsolMint;
      const bIsWsol = state.mintB === this.config.wsolMint;
      if (aIsWsol === bIsWsol) continue;
      const tokenIsA = bIsWsol;
      result.push({
        dex: 'RAYDIUM_CPMM',
        programId: this.programId,
        pool: decoded.pool,
        tokenMint: tokenIsA ? state.mintA : state.mintB,
        wsolMint: this.config.wsolMint,
        tokenVault: tokenIsA ? state.vaultA : state.vaultB,
        wsolVault: tokenIsA ? state.vaultB : state.vaultA,
        lpMint: state.lpMint,
        tokenProgram: tokenIsA ? state.tokenProgramA : state.tokenProgramB,
        wsolTokenProgram: tokenIsA ? state.tokenProgramB : state.tokenProgramA,
        creator: state.creator || decoded.creator || null,
        openTimeUnix: state.openTimeUnix,
        createdSlot: transaction.slot,
        createdSignature: transaction.signature,
        createdInstructionIndex: instruction.instructionIndex,
        discoveredAtMs: Date.now(),
      });
    }
    return result;
  }

  decodeSwaps(transaction: NormalizedTransaction, activePools: readonly PoolInfo[]): Promise<SwapEvent[]> {
    return Promise.resolve(classifyTransactionSwaps(transaction, this.programId, activePools));
  }

  async quoteBuy(pool: PoolInfo, amountInLamports: bigint): Promise<QuoteResult> {
    return this.quoteService.quote(pool, pool.wsolMint, amountInLamports);
  }

  async quoteSell(pool: PoolInfo, amountInTokenRaw: bigint): Promise<QuoteResult> {
    return this.quoteService.quote(pool, pool.tokenMint, amountInTokenRaw);
  }

  async buildBuy(pool: PoolInfo, quote: QuoteResult, wallet: string): Promise<BuiltTransaction> {
    if (quote.inputMint !== pool.wsolMint) throw new Error('Cotation d’achat invalide: WSOL doit être le mint d’entrée.');
    return this.transactionBuilder.build(pool, quote, wallet);
  }

  async buildSell(pool: PoolInfo, quote: QuoteResult, wallet: string): Promise<BuiltTransaction> {
    if (quote.inputMint !== pool.tokenMint) throw new Error('Cotation de vente invalide: le token doit être le mint d’entrée.');
    return this.transactionBuilder.build(pool, quote, wallet);
  }

  async readTokenBalance(tokenMint: string, tokenProgram: string, wallet: string): Promise<bigint> {
    const program = tokenProgram === TOKEN_2022_PROGRAM_ID ? TOKEN_2022_PUBLIC_KEY : TOKEN_PUBLIC_KEY;
    if (tokenProgram !== TOKEN_2022_PROGRAM_ID && tokenProgram !== SPL_TOKEN_PROGRAM_ID) {
      throw new Error(`Programme Token non pris en charge: ${tokenProgram}.`);
    }
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(tokenMint),
      new PublicKey(wallet),
      false,
      program,
    );
    try {
      const account = await getAccount(this.rpc.http, ata, this.rpc.commitment, program);
      return account.amount;
    } catch (error) {
      if (/could not find account|Failed to find account|TokenAccountNotFound/iu.test(String(error))) return 0n;
      throw error;
    }
  }

  async readPoolRuntimeState(pool: PoolInfo): Promise<PoolRuntimeState> {
    const { state, slot } = await readPoolState(this.rpc.http, pool.pool, this.programId);
    const [tokenBalance, wsolBalance] = await Promise.all([
      this.rpc.http.getTokenAccountBalance(new PublicKey(pool.tokenVault), this.rpc.commitment),
      this.rpc.http.getTokenAccountBalance(new PublicKey(pool.wsolVault), this.rpc.commitment),
    ]);
    return {
      pool: pool.pool,
      statusBits: state.status,
      swapsEnabled: swapsEnabled(state.status),
      openTimeUnix: state.openTimeUnix,
      tokenVaultBalanceRaw: BigInt(tokenBalance.value.amount),
      wsolVaultBalanceRaw: BigInt(wsolBalance.value.amount),
      observedSlot: slot,
    };
  }
}

function verifyInitializedPool(
  instruction: NonNullable<ReturnType<typeof decodeInitializeInstruction>>,
  state: Awaited<ReturnType<typeof readPoolState>>['state'],
): void {
  const expected = [
    ['config', instruction.config, state.config],
    ['creator', instruction.creator, state.creator],
    ['vaultA', instruction.vaultA, state.vaultA],
    ['vaultB', instruction.vaultB, state.vaultB],
    ['lpMint', instruction.lpMint, state.lpMint],
    ['mintA', instruction.mintA, state.mintA],
    ['mintB', instruction.mintB, state.mintB],
    ['tokenProgramA', instruction.tokenProgramA, state.tokenProgramA],
    ['tokenProgramB', instruction.tokenProgramB, state.tokenProgramB],
    ['observation', instruction.observation, state.observation],
  ] as const;
  for (const [label, fromInstruction, fromState] of expected) {
    if (fromInstruction !== fromState) {
      throw new Error(`PoolState incohérent pour ${label}: instruction=${fromInstruction}, compte=${fromState}.`);
    }
  }
}

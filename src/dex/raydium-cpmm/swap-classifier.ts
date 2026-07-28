import type { PoolInfo, SwapEvent, SwapKind } from '../../domain/types.js';
import type { NormalizedTokenBalance, NormalizedTransaction } from '../../solana/rpc/types.js';
import { decodeSwapInstruction } from './instruction-decoder.js';

export function classifyTransactionSwaps(
  transaction: NormalizedTransaction,
  programId: string,
  activePools: readonly PoolInfo[],
): SwapEvent[] {
  if (transaction.error !== null) return [];
  const pools = new Map(activePools.map((pool) => [pool.pool, pool]));
  const pre = indexBalances(transaction.preTokenBalances);
  const post = indexBalances(transaction.postTokenBalances);
  const result: SwapEvent[] = [];
  for (const instruction of transaction.instructions) {
    if (instruction.programId !== programId) continue;
    const decoded = decodeSwapInstruction(instruction);
    if (!decoded) continue;
    const pool = pools.get(decoded.pool);
    if (!pool || !instructionMatchesPool(decoded, pool)) continue;
    const tokenDelta = balanceDelta(pool.tokenVault, pre, post);
    const wsolDelta = balanceDelta(pool.wsolVault, pre, post);
    const kind = classifyDeltas(wsolDelta, tokenDelta);
    if (kind === 'OTHER') continue;
    result.push({
      id: createSwapEventId(pool.pool, transaction.signature, instruction.instructionIndex, instruction.innerInstructionIndex),
      dex: 'RAYDIUM_CPMM',
      pool: pool.pool,
      signature: transaction.signature,
      kind,
      payer: decoded.payer || null,
      authority: decoded.authority || null,
      amountWsolRaw: absolute(wsolDelta),
      amountTokenRaw: absolute(tokenDelta),
      cursor: {
        slot: transaction.slot,
        transactionIndex: transaction.transactionIndex,
        instructionIndex: instruction.instructionIndex,
        innerInstructionIndex: instruction.innerInstructionIndex,
      },
      confirmationStatus: transaction.confirmationStatus,
      observedAtMs: Date.now(),
    });
  }
  return result;
}

export function classifyDeltas(wsolVaultDelta: bigint, tokenVaultDelta: bigint): SwapKind {
  if (wsolVaultDelta > 0n && tokenVaultDelta < 0n) return 'BUY';
  if (wsolVaultDelta < 0n && tokenVaultDelta > 0n) return 'SELL';
  return 'OTHER';
}

export function createSwapEventId(pool: string, signature: string, instructionIndex: number, innerInstructionIndex: number | null): string {
  return `raydium-cpmm:${pool}:${signature}:${instructionIndex}:${innerInstructionIndex ?? 'outer'}`;
}

function instructionMatchesPool(decoded: NonNullable<ReturnType<typeof decodeSwapInstruction>>, pool: PoolInfo): boolean {
  const vaults = new Set([decoded.inputVault, decoded.outputVault]);
  const mints = new Set([decoded.inputMint, decoded.outputMint]);
  const programs = new Set([decoded.inputTokenProgram, decoded.outputTokenProgram]);
  return vaults.has(pool.tokenVault) && vaults.has(pool.wsolVault)
    && mints.has(pool.tokenMint) && mints.has(pool.wsolMint)
    && programs.has(pool.tokenProgram) && programs.has(pool.wsolTokenProgram);
}

function indexBalances(balances: readonly NormalizedTokenBalance[]): Map<string, bigint> {
  return new Map(balances.map((balance) => [balance.account, balance.amountRaw]));
}

function balanceDelta(account: string, pre: ReadonlyMap<string, bigint>, post: ReadonlyMap<string, bigint>): bigint {
  if (!pre.has(account) && !post.has(account)) throw new Error(`Balances pré/post absentes pour le vault ${account}.`);
  return (post.get(account) ?? 0n) - (pre.get(account) ?? 0n);
}

function absolute(value: bigint): bigint { return value < 0n ? -value : value; }

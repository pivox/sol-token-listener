import {
  assertValidTransactionCursor,
  InvalidChainCursorError,
} from '../../domain/cursor.js';
import type { PoolInfo, SwapEvent, SwapKind } from '../../domain/types.js';
import type { NormalizedTokenBalance, NormalizedTransaction } from '../../solana/rpc/types.js';
import { decodeSwapInstruction } from './instruction-decoder.js';

interface PoolSwapAggregate {
  pool: PoolInfo;
  payer: string | null;
  authority: string | null;
  instructionIndex: number;
  innerInstructionIndex: number | null;
}

type SwapClassification = SwapKind | 'OTHER';

export function classifyTransactionSwaps(
  transaction: NormalizedTransaction,
  programId: string,
  activePools: readonly PoolInfo[],
): SwapEvent[] {
  if (transaction.error !== null) return [];
  const { transactionIndex } = transaction;
  if (transactionIndex === null) {
    throw new InvalidChainCursorError('transactionIndex', transactionIndex);
  }
  assertValidTransactionCursor({
    slot: transaction.slot,
    transactionIndex,
  });
  const pools = new Map(activePools.map((pool) => [pool.pool, pool]));
  const matches = new Map<string, PoolSwapAggregate>();

  for (const instruction of transaction.instructions) {
    if (instruction.programId !== programId) continue;
    const decoded = decodeSwapInstruction(instruction);
    if (!decoded) continue;
    const pool = pools.get(decoded.pool);
    if (!pool || !instructionMatchesPool(decoded, pool)) continue;

    const existing = matches.get(pool.pool);
    if (!existing) {
      matches.set(pool.pool, {
        pool,
        payer: decoded.payer || null,
        authority: decoded.authority || null,
        instructionIndex: instruction.instructionIndex,
        innerInstructionIndex: instruction.innerInstructionIndex,
      });
      continue;
    }

    existing.payer = sameIdentity(existing.payer, decoded.payer);
    existing.authority = sameIdentity(existing.authority, decoded.authority);
    existing.instructionIndex = instruction.instructionIndex;
    existing.innerInstructionIndex = instruction.innerInstructionIndex;
  }

  const pre = indexBalances(transaction.preTokenBalances);
  const post = indexBalances(transaction.postTokenBalances);
  const result: SwapEvent[] = [];

  for (const aggregate of matches.values()) {
    const tokenDelta = balanceDelta(aggregate.pool.tokenVault, pre, post);
    const wsolDelta = balanceDelta(aggregate.pool.wsolVault, pre, post);
    const kind = classifyDeltas(wsolDelta, tokenDelta);
    if (kind === 'OTHER') continue;
    result.push({
      id: createSwapEventId(
        aggregate.pool.pool,
        transaction.signature,
        aggregate.instructionIndex,
        aggregate.innerInstructionIndex,
      ),
      dex: 'RAYDIUM_CPMM',
      pool: aggregate.pool.pool,
      signature: transaction.signature,
      kind,
      payer: aggregate.payer,
      authority: aggregate.authority,
      amountWsolRaw: absolute(wsolDelta),
      amountTokenRaw: absolute(tokenDelta),
      cursor: {
        slot: transaction.slot,
        transactionIndex,
        instructionIndex: aggregate.instructionIndex,
        innerInstructionIndex: aggregate.innerInstructionIndex,
      },
      confirmationStatus: transaction.confirmationStatus,
      observedAtMs: Date.now(),
    });
  }

  return result;
}

export function classifyDeltas(wsolVaultDelta: bigint, tokenVaultDelta: bigint): SwapClassification {
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

function sameIdentity(current: string | null, candidate: string): string | null {
  if (!current || !candidate || current !== candidate) return null;
  return current;
}

function indexBalances(balances: readonly NormalizedTokenBalance[]): Map<string, bigint> {
  return new Map(balances.map((balance) => [balance.account, balance.amountRaw]));
}

function balanceDelta(account: string, pre: ReadonlyMap<string, bigint>, post: ReadonlyMap<string, bigint>): bigint {
  if (!pre.has(account) && !post.has(account)) throw new Error(`Balances pré/post absentes pour le vault ${account}.`);
  return (post.get(account) ?? 0n) - (pre.get(account) ?? 0n);
}

function absolute(value: bigint): bigint { return value < 0n ? -value : value; }

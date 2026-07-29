import { createHash } from 'node:crypto';
import {
  marketPoolDefinition,
  type CanonicalMarketPool,
  type MarketTrade,
} from '../domain/market.js';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import type { PumpFunLaunchpadAdapter } from '../launchpads/pumpfun/pumpfun-launchpad.adapter.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import type { PumpSwapMarketAdapter } from '../markets/pumpswap/pumpswap-market.adapter.js';
import type {
  MarketObservationResult,
  MarketReserveObservation,
} from '../ports/market-observation-repository.js';
import { createSolanaObservedTransaction } from '../solana/rpc/observed-transaction.js';
import type { NormalizedTransaction } from '../solana/rpc/types.js';
import { stringifyJson } from '../utils/json.js';
import type { MarketObservationService } from './market-observation.service.js';
import {
  matchPumpSwapMigrations,
  type MatchedMigration,
} from './pumpswap-migration-matcher.js';

export const EMPTY_MARKET_OBSERVATION_RESULT: MarketObservationResult =
  Object.freeze({
    migrations: Object.freeze([]),
    activations: Object.freeze([]),
  });

export class ConflictingMarketPoolError extends Error {
  public constructor(public readonly address: string) {
    super(`Définitions contradictoires du pool ${address}.`);
    this.name = 'ConflictingMarketPoolError';
  }
}

export class PumpSwapObservationPipeline {
  public constructor(
    private readonly pump: PumpFunLaunchpadAdapter,
    private readonly market: PumpSwapMarketAdapter,
    private readonly service: MarketObservationService,
    private readonly clock: () => number = Date.now,
  ) {}

  public async observe(
    transaction: NormalizedTransaction,
  ): Promise<MarketObservationResult> {
    if (!invokesPumpOrPumpSwap(transaction)) {
      return EMPTY_MARKET_OBSERVATION_RESULT;
    }
    const observed = createSolanaObservedTransaction(
      transaction,
      this.clock(),
    );
    const [activePools, migrations, evidence, detectedPools] =
      await Promise.all([
        this.service.loadActivePools(),
        this.pump.decodeMigrations(observed),
        this.market.decodeEvidence(observed),
        this.market.detectPools(observed),
      ]);
    const matches = matchPumpSwapMigrations(
      observed,
      migrations,
      evidence,
      indexPools(detectedPools),
    );
    const trackedPools = mergeTrackedPools(
      activePools,
      matches.flatMap((match) =>
        match.activationEvent === null
          ? []
          : [match.activationEvent.payload.pool]),
    );
    const trades = await this.market.decodeTrades(observed, trackedPools);
    if (matches.length === 0 && trades.length === 0) {
      return EMPTY_MARKET_OBSERVATION_RESULT;
    }
    const reserveSnapshots = await Promise.all(
      poolsChangedBy(matches, trades, trackedPools).map(async (changed) => {
        const reserves = await this.market.readReserves(changed.pool);
        return Object.freeze({
          id: reserveId(
            changed.pool.address,
            reserves.observedSlot,
            changed.triggerCursor,
          ),
          reserves,
          triggerCursor: changed.triggerCursor,
          confirmationStatus: observed.confirmationStatus,
        }) satisfies MarketReserveObservation;
      }),
    );
    return this.service.record(observed, {
      matches,
      reserveSnapshots,
      trades,
    });
  }
}

function invokesPumpOrPumpSwap(transaction: NormalizedTransaction): boolean {
  return transaction.instructions.some((instruction) =>
    instruction.programId === PUMP_PROGRAM_ID
    || instruction.programId === PUMPSWAP_PROGRAM_ID);
}

function indexPools(
  pools: readonly CanonicalMarketPool[],
): ReadonlyMap<string, CanonicalMarketPool> {
  return mergeTrackedPools([], pools);
}

function mergeTrackedPools(
  existing: readonly CanonicalMarketPool[],
  incoming: readonly CanonicalMarketPool[],
): ReadonlyMap<string, CanonicalMarketPool> {
  const pools = new Map<string, CanonicalMarketPool>();
  for (const pool of [...existing, ...incoming]) {
    const previous = pools.get(pool.address);
    if (
      previous !== undefined
      && stringifyJson(marketPoolDefinition(previous))
        !== stringifyJson(marketPoolDefinition(pool))
    ) throw new ConflictingMarketPoolError(pool.address);
    pools.set(pool.address, pool);
  }
  return pools;
}

function poolsChangedBy(
  matches: readonly MatchedMigration[],
  trades: readonly MarketTrade[],
  tracked: ReadonlyMap<string, CanonicalMarketPool>,
): readonly {
  readonly pool: CanonicalMarketPool;
  readonly triggerCursor: MarketTrade['cursor'];
}[] {
  const changed = new Map<string, {
    readonly pool: CanonicalMarketPool;
    readonly triggerCursor: MarketTrade['cursor'];
  }>();
  for (const match of matches) {
    const event = match.activationEvent;
    if (event !== null && event.confirmationStatus !== 'orphaned') {
      changed.set(event.payload.pool.address, {
        pool: event.payload.pool,
        triggerCursor: event.cursor,
      });
    }
  }
  for (const trade of trades) {
    if (trade.confirmationStatus === 'orphaned') continue;
    const pool = tracked.get(trade.pool);
    if (pool === undefined) throw new ConflictingMarketPoolError(trade.pool);
    if (!changed.has(pool.address)) {
      changed.set(pool.address, { pool, triggerCursor: trade.cursor });
    }
  }
  return Object.freeze([...changed.values()]);
}

function reserveId(
  pool: string,
  slot: bigint,
  cursor: MarketTrade['cursor'],
): string {
  const identity = JSON.stringify([
    pool,
    slot.toString(),
    cursor.slot.toString(),
    cursor.transactionIndex,
    cursor.instructionIndex,
    cursor.innerInstructionIndex,
  ]);
  return `reserve_${createHash('sha256').update(identity).digest('hex')}`;
}

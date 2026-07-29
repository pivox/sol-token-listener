import { createHash } from 'node:crypto';
import type { MatchedMigration } from './pumpswap-migration-matcher.js';
import {
  marketPoolDefinition,
  type CanonicalMarketPool,
  type MarketTrade,
  type RawMarketObservation,
} from '../domain/market.js';
import { compareCursors } from '../domain/cursor.js';
import type {
  MarketObservationRepository,
  MarketObservationResult,
  MarketReserveObservation,
} from '../ports/market-observation-repository.js';
import type { SolanaObservedTransaction } from '../solana/rpc/observed-transaction.js';
import { toJsonValue } from '../utils/json.js';

export interface MarketObservation {
  readonly matches: readonly MatchedMigration[];
  readonly reserveSnapshots: readonly MarketReserveObservation[];
  readonly trades: readonly MarketTrade[];
}

export class InvalidMarketObservationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidMarketObservationError';
  }
}

export class MarketObservationService {
  public constructor(
    private readonly repository: MarketObservationRepository,
  ) {}

  public loadActivePools(): Promise<readonly CanonicalMarketPool[]> {
    return this.repository.loadActivePools();
  }

  public record(
    transaction: SolanaObservedTransaction,
    observation: MarketObservation,
  ): Promise<MarketObservationResult> {
    const items = [
      ...observation.matches.flatMap((match) => [
        match.migrationEvent,
        ...(match.activationEvent === null ? [] : [match.activationEvent]),
      ]),
      ...observation.trades,
    ];
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.id)) {
        throw new InvalidMarketObservationError(`Identifiant dupliqué: ${item.id}`);
      }
      ids.add(item.id);
      if (
        item.signature !== transaction.signature
        || item.confirmationStatus !== transaction.confirmationStatus
        || item.cursor.slot !== transaction.cursor.slot
        || item.cursor.transactionIndex !== transaction.cursor.transactionIndex
      ) {
        throw new InvalidMarketObservationError(
          `Curseur hors transaction: ${item.id}`,
        );
      }
    }
    for (const reserves of observation.reserveSnapshots) {
      if (
        reserves.triggerCursor.slot !== transaction.cursor.slot
        || reserves.triggerCursor.transactionIndex !== transaction.cursor.transactionIndex
        || reserves.confirmationStatus !== transaction.confirmationStatus
        || reserves.confirmationStatus === 'orphaned'
      ) {
        throw new InvalidMarketObservationError(
          `Snapshot hors transaction: ${reserves.id}`,
        );
      }
    }
    const matches = [...observation.matches].sort((left, right) =>
      compareCursors(left.migrationEvent.cursor, right.migrationEvent.cursor));
    const trades = [...observation.trades].sort((left, right) =>
      compareCursors(left.cursor, right.cursor));
    const rawEvents = items
      .map((item): RawMarketObservation => Object.freeze({
        id: rawId(item.id),
        source: item.source,
        program: item.program,
        mint: item.mint,
        signature: item.signature,
        cursor: item.cursor,
        confirmationStatus: item.confirmationStatus,
        blockchainTimeMs: item.blockchainTimeMs,
        observedAtMs: item.observedAtMs,
        payloadVersion: 1,
        payload: Object.freeze({
          kind: 'type' in item ? item.type : 'MarketTrade',
          value: stableRawValue(item),
        }),
      }))
      .sort((left, right) => compareCursors(left.cursor, right.cursor));
    return this.repository.record({
      rawEvents,
      matches,
      reserveSnapshots: [...observation.reserveSnapshots].sort((left, right) =>
        compareCursors(left.triggerCursor, right.triggerCursor)),
      trades,
    });
  }
}

function rawId(id: string): string {
  return `raw_${createHash('sha256').update(id).digest('hex')}`;
}

function stableRawValue(
  item: MatchedMigration['migrationEvent']
  | NonNullable<MatchedMigration['activationEvent']>
  | MarketTrade,
): Readonly<Record<string, unknown>> {
  if ('type' in item) {
    const payload = item.type === 'PumpSwapPoolActivated'
      ? {
          ...item.payload,
          pool: marketPoolDefinition(item.payload.pool),
        }
      : item.payload;
    return Object.freeze({
      id: item.id,
      type: item.type,
      payloadVersion: item.payloadVersion,
      payload: toJsonValue(payload),
    });
  }
  return Object.freeze({
    id: item.id,
    pool: item.pool,
    mint: item.mint,
    quoteAsset: toJsonValue(item.quoteAsset),
    kind: item.kind,
    trader: item.trader,
    baseAmountRaw: toJsonValue(item.baseAmountRaw),
    quoteAmountRaw: toJsonValue(item.quoteAmountRaw),
    source: item.source,
    program: item.program,
    signature: item.signature,
    cursor: toJsonValue(item.cursor),
  });
}

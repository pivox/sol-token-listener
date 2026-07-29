import type {
  CanonicalMarketPool,
  MarketReserves,
  MarketTrade,
  RawMarketObservation,
} from '../domain/market.js';
import type {
  MigrationObservedEventV1,
  PumpSwapPoolActivatedEventV1,
} from '../domain/migration-events.js';
import type { MatchedMigration } from '../application/pumpswap-migration-matcher.js';
import type { ChainConfirmationStatus, ChainCursor } from '../domain/types.js';

export interface MarketReserveObservation {
  readonly id: string;
  readonly reserves: MarketReserves;
  readonly triggerCursor: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
}

export interface MarketObservationBatch {
  readonly rawEvents: readonly RawMarketObservation[];
  readonly matches: readonly MatchedMigration[];
  readonly reserveSnapshots: readonly MarketReserveObservation[];
  readonly trades: readonly MarketTrade[];
}

export interface MarketObservationResult {
  readonly migrations: readonly MigrationObservedEventV1[];
  readonly activations: readonly PumpSwapPoolActivatedEventV1[];
}

export interface MarketObservationRepository {
  record(batch: MarketObservationBatch): Promise<MarketObservationResult>;
  loadActivePools(): Promise<readonly CanonicalMarketPool[]>;
}

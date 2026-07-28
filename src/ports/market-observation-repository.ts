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

export interface MarketObservationBatch {
  readonly rawEvents: readonly RawMarketObservation[];
  readonly migrationEvents: readonly MigrationObservedEventV1[];
  readonly activationEvents: readonly PumpSwapPoolActivatedEventV1[];
  readonly reserveSnapshots: readonly MarketReserves[];
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

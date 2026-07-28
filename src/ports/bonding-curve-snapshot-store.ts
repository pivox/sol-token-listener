import type {
  BondingCurveSnapshot,
  PersistedLaunchTrade,
  TokenMetadataSnapshot,
} from '../domain/pumpfun-observation.js';

export interface BondingCurveSnapshotStore {
  readonly upsertMetadataSnapshot: (snapshot: TokenMetadataSnapshot) => Promise<void>;
  readonly upsertBondingCurveSnapshot: (snapshot: BondingCurveSnapshot) => Promise<void>;
  readonly upsertTrade: (trade: PersistedLaunchTrade) => Promise<void>;
}

import type {
  WalletClusterDetectedEventV1,
} from '../domain/wallet-graph-events.js';
import type {
  WalletGraphInput,
  WalletGraphProjection,
} from '../domain/wallet-graph.js';

export interface WalletGraphTransaction {
  loadCanonicalInput(mint: string): Promise<WalletGraphInput | null>;
  dissolveCurrent(mint: string): Promise<void>;
  replaceProjection(
    projection: WalletGraphProjection,
    event: WalletClusterDetectedEventV1,
  ): Promise<void>;
}

export interface WalletGraphRepository {
  /**
   * Runs one atomic wallet-graph unit. The callback may be replayed up to two
   * times after a complete rollback of an authenticated database transaction
   * conflict, so it must contain only replay-safe transactional work.
   */
  transact<TResult>(
    mint: string,
    operation: (transaction: WalletGraphTransaction) => Promise<TResult>,
  ): Promise<TResult>;
}

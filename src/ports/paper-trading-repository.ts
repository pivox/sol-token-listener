import type {
  PaperPosition,
  PaperPositionClosedEventV1,
  PaperPositionOpenedEventV1,
  PaperStrategyIdentity,
  PaperTrade,
} from '../domain/paper-trading.js';

export interface PaperTradingTransaction {
  findPosition(id: string): Promise<PaperPosition | null>;
  findActivePosition(
    mint: string,
    strategy: PaperStrategyIdentity,
  ): Promise<PaperPosition | null>;
  insertOpened(
    position: PaperPosition,
    trade: PaperTrade,
    event: PaperPositionOpenedEventV1,
  ): Promise<void>;
  updateClosed(
    position: PaperPosition,
    trade: PaperTrade,
    event: PaperPositionClosedEventV1,
  ): Promise<void>;
}

export interface PaperTradingRepository {
  transact<T>(
    operation: (transaction: PaperTradingTransaction) => Promise<T>,
  ): Promise<T>;
}

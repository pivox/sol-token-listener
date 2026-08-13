import type {
  PaperPosition,
  PaperPositionClosedEventV1,
  PaperPositionOpenedEventV1,
  PaperCurrentQualificationIdentity,
  PaperStrategyIdentity,
  PaperTrade,
} from '../domain/paper-trading.js';
import type { DomainEvent } from '../domain/events.js';

export type PaperConfirmationObservation = Pick<
  DomainEvent,
  'confirmationStatus' | 'blockchainTimeMs' | 'observedAtMs'
>;

export interface PaperTradingTransaction {
  requireCurrentQualification(identity:PaperCurrentQualificationIdentity):Promise<void>;
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
  reconcileEventConfirmation(
    eventId: string,
    trigger: PaperConfirmationObservation,
  ): Promise<void>;
  retractPosition(position: PaperPosition): Promise<void>;
}

export interface PaperTradingRepository {
  transact<T>(
    operation: (transaction: PaperTradingTransaction) => Promise<T>,
  ): Promise<T>;
}

import type { QualificationReport } from './qualification.js';
import type { DomainEvent, TypedDomainEvent } from './events.js';
import type { QuoteAsset } from './types.js';

export const PAPER_SIMULATION_ACTOR_KIND = 'PAPER_SIMULATION' as const;
export type PaperSimulationActorKind = typeof PAPER_SIMULATION_ACTOR_KIND;

export interface PaperExecutionQuote {
  readonly id: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly amountInRaw: bigint;
  readonly amountOutRaw: bigint;
  readonly minimumAmountOutRaw: bigint;
  readonly feesRaw: bigint;
  readonly slippageBps: bigint;
  readonly priceImpactBps: bigint;
  readonly observedAtMs: number;
  readonly observedSlot: bigint;
}

export interface PaperRoundTrip {
  readonly quoteCostRaw: bigint;
  readonly baseFilledRaw: bigint;
  readonly returnRaw: bigint;
  readonly lossRaw: bigint;
  readonly lossBps: bigint;
}

export type PaperPositionStatus =
  | 'PAPER_HOLDING'
  | 'PAPER_CLOSED'
  | 'PAPER_RETRACTED';
export type PaperTradeSide = 'BUY' | 'SELL';

export interface PaperStrategyIdentity {
  readonly id: string;
  readonly version: number;
}

export interface PaperPosition {
  readonly id: string;
  readonly mint: string;
  readonly quoteAsset: QuoteAsset;
  readonly strategy: PaperStrategyIdentity;
  readonly status: PaperPositionStatus;
  readonly baseFilledRaw: bigint;
  readonly remainingBaseRaw: bigint;
  readonly quoteCostRaw: bigint;
  readonly quoteProceedsRaw: bigint | null;
  readonly grossPnlQuoteRaw: bigint | null;
  readonly netPnlQuoteRaw: bigint | null;
  readonly roundTripLossBps: bigint;
  readonly entryTradeId: string;
  readonly exitTradeId: string | null;
  readonly openCommandHash: string;
  readonly closeCommandHash: string | null;
  readonly triggerEventId: string;
  readonly openedAtMs: number;
  readonly closedAtMs: number | null;
  readonly purgeAfterMs: number | null;
  readonly payloadVersion: 1;
}

export interface PaperTrade {
  readonly id: string;
  readonly positionId: string;
  readonly side: PaperTradeSide;
  readonly quote: PaperExecutionQuote;
  readonly fillAmountOutRaw: bigint;
  readonly reason: string;
  readonly createdAtMs: number;
  readonly payloadVersion: 1;
}

export interface OpenPaperPositionCommand {
  readonly mint: string;
  readonly quoteAsset: QuoteAsset;
  readonly strategy: PaperStrategyIdentity;
  readonly trigger: DomainEvent;
  readonly qualification: QualificationReport;
  readonly buyQuote: PaperExecutionQuote;
  readonly reverseSellQuote: PaperExecutionQuote;
  readonly maximumRoundTripLossBps: bigint;
}

export interface ClosePaperPositionCommand {
  readonly positionId: string;
  readonly trigger: DomainEvent;
  readonly sellQuote: PaperExecutionQuote;
  readonly reason: string;
}

export interface PaperPositionOpenedPayloadV1 {
  readonly position: PaperPosition;
  readonly trade: PaperTrade;
}

export interface PaperPositionClosedPayloadV1 {
  readonly position: PaperPosition;
  readonly trade: PaperTrade;
}

export type PaperPositionOpenedEventV1 = TypedDomainEvent<
  'PaperPositionOpened',
  PaperPositionOpenedPayloadV1,
  1
>;

export type PaperPositionClosedEventV1 = TypedDomainEvent<
  'PaperPositionClosed',
  PaperPositionClosedPayloadV1,
  1
>;

export type PaperTradingErrorCode =
  | 'PAPER_MODE_DISABLED'
  | 'QUALIFICATION_INVALID'
  | 'QUALIFICATION_NOT_ACCEPTED'
  | 'QUALIFICATION_BLOCKED'
  | 'QUOTE_MINT_NOT_ALLOWED'
  | 'QUOTE_INVALID'
  | 'ROUND_TRIP_LOSS_EXCEEDED'
  | 'TRIGGER_ORPHANED'
  | 'POSITION_NOT_FOUND'
  | 'POSITION_NOT_OPEN'
  | 'POSITION_CONFLICT';

export class PaperTradingError extends Error {
  public constructor(
    public readonly code: PaperTradingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PaperTradingError';
  }
}

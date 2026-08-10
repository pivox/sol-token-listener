import { createHash } from 'node:crypto';
import { compareCursors } from '../domain/cursor.js';
import { createDeterministicDerivedEventId, type DomainEvent } from '../domain/events.js';
import type { BondingCurveTradeObservedEventV1 } from '../domain/launchpad-events.js';
import type { MarketTrade } from '../domain/market.js';
import {
  countExternalBuy,
  createPaperStrategySession,
  type PaperExternalBuyEvidence,
  type PaperMinimumConfirmation,
  type PaperStrategySessionV1,
} from '../domain/paper-strategy.js';
import type {
  ClosePaperPositionCommand,
  OpenPaperPositionCommand,
  PaperPosition,
} from '../domain/paper-trading.js';
import type { QualificationReport } from '../domain/qualification.js';
import type { TradingCandidateV1 } from '../domain/trading-candidate.js';
import type { ChainConfirmationStatus, ChainCursor } from '../domain/types.js';
import { PaperQuoteError, type PaperQuoteRouter } from '../ports/paper-quote-router.js';
import { canonicalStringifyJson } from '../utils/json.js';

export interface PaperTradingActions {
  open(command: OpenPaperPositionCommand): Promise<PaperPosition>;
  close(command: ClosePaperPositionCommand): Promise<PaperPosition>;
}

export interface ExternalBuysStrategyResult {
  readonly session: PaperStrategySessionV1;
  readonly sessionEvent: DomainEvent;
  readonly countedExternalBuys: readonly PaperExternalBuyEvidence[];
  readonly requestedAction: 'NONE' | 'OPEN' | 'CLOSE';
  readonly position: PaperPosition | null;
}

export class ValidatedExternalBuysStrategy {
  public constructor(
    private readonly ledger: PaperTradingActions,
    private readonly quotes: PaperQuoteRouter,
    private readonly options: Readonly<{ retentionMs: number }>,
  ) {
    if (options.retentionMs !== 14_400_000) {
      throw new RangeError('Validated external buys retention must be four hours.');
    }
  }

  public prepare(
    candidate: TradingCandidateV1,
    input: Readonly<{
      externalBuyTarget: number;
      minimumConfirmation: PaperMinimumConfirmation;
      nowMs: number;
    }>,
  ): PaperStrategySessionV1 | null {
    if (candidate.state !== 'ELIGIBLE') return null;
    return createPaperStrategySession({
      candidate,state:'BUY_PENDING',reasonCode:'QUALIFIED_ENTRY',positionId:null,
      entryCursor:candidate.asOf.cursor,externalBuyTarget:input.externalBuyTarget,
      externalBuyCount:0,countedTradeIds:[],lastCountedCursor:null,
      minimumConfirmation:input.minimumConfirmation,lastQuote:candidate.buyQuote,
      lastError:null,createdAtMs:input.nowMs,updatedAtMs:input.nowMs,
      purgeAfterMs:input.nowMs + this.options.retentionMs,
    });
  }

  public async open(input: Readonly<{
    candidate: TradingCandidateV1;
    session: PaperStrategySessionV1;
    qualification: QualificationReport;
    qualificationEvent: DomainEvent;
    maximumRoundTripLossBps: bigint;
  }>): Promise<ExternalBuysStrategyResult> {
    const { candidate,session } = input;
    if (
      session.state !== 'BUY_PENDING'
      || session.candidateId !== candidate.id
      || candidate.buyQuote === null
      || candidate.reverseSellQuote === null
    ) throw new TypeError('Paper strategy entry is inconsistent.');
    const position = await this.ledger.open({
      mint:candidate.mint,quoteAsset:candidate.quoteAsset,strategy:candidate.strategy,
      trigger:input.qualificationEvent,qualification:input.qualification,
      buyQuote:candidate.buyQuote,reverseSellQuote:candidate.reverseSellQuote,
      maximumRoundTripLossBps:input.maximumRoundTripLossBps,
      strategySessionId:session.id,qualificationReportId:candidate.qualificationReportId,
      candidateId:candidate.id,
    });
    const updated = createPaperStrategySession({
      candidate,state:'WAITING_EXTERNAL_BUYS',reasonCode:'QUALIFIED_ENTRY',
      positionId:position.id,entryCursor:session.entryCursor,
      externalBuyTarget:session.externalBuyTarget,externalBuyCount:0,
      countedTradeIds:[],lastCountedCursor:null,
      minimumConfirmation:session.minimumConfirmation,lastQuote:candidate.buyQuote,
      lastError:null,createdAtMs:session.createdAtMs,updatedAtMs:position.openedAtMs,
      purgeAfterMs:position.openedAtMs + this.options.retentionMs,
    });
    return result(updated, [], 'OPEN', position, input.qualificationEvent);
  }

  public async reconcile(input: Readonly<{
    candidate: TradingCandidateV1;
    session: PaperStrategySessionV1;
    position: PaperPosition;
    creator: string;
    launchTrades: readonly BondingCurveTradeObservedEventV1[];
    marketTrades: readonly MarketTrade[];
    nowMs: number;
  }>): Promise<ExternalBuysStrategyResult> {
    assertReconcileInput(input);
    let session = input.session;
    const counted: PaperExternalBuyEvidence[] = [];
    let closeTrigger: DomainEvent | null = null;
    for (const trade of canonicalBuys(input)) {
      const countedResult = countExternalBuy(session, {
        tradeId:trade.id,mint:input.candidate.mint,quoteMint:input.candidate.quoteAsset.mint,
        trader:trade.trader,cursor:trade.cursor,
        confirmationStatus:trade.confirmationStatus,observedAtMs:trade.observedAtMs,
      });
      session = countedResult.session;
      if (countedResult.evidence !== null) {
        counted.push(countedResult.evidence);
        closeTrigger = trade.trigger;
      }
      if (countedResult.targetReached) break;
    }
    if (session.externalBuyCount < session.externalBuyTarget) {
      return result(session, counted, 'NONE', input.position, closeTrigger ?? candidateTrigger(input.candidate));
    }

    const trigger = closeTrigger ?? candidateTrigger(input.candidate);
    let sellQuote;
    try {
      sellQuote = await this.quotes.quote({
        mint:input.candidate.mint,quoteAsset:input.candidate.quoteAsset,side:'SELL',
        amountInRaw:input.position.remainingBaseRaw,
        slippageBps:input.candidate.buyQuote?.slippageBps ?? 0n,
      });
    } catch (error: unknown) {
      const known = error instanceof PaperQuoteError ? error : null;
      const retryable = known?.retryable ?? false;
      const failed = Object.freeze({
        ...session,
        state:retryable ? 'EXIT_PENDING_QUOTE' as const : 'MANUAL_REVIEW' as const,
        reasonCode:retryable ? 'EXIT_QUOTE_UNAVAILABLE' as const : 'RECONCILIATION_REQUIRED' as const,
        lastError:Object.freeze({
          code:known?.code ?? 'QUOTE_FAILURE',
          message:known?.message ?? 'Paper sell quote failed.',retryable,
        }),
        updatedAtMs:input.nowMs,
      });
      return result(failed, counted, 'NONE', input.position, trigger);
    }
    const position = await this.ledger.close({
      positionId:input.position.id,trigger,sellQuote,
      reason:'EXTERNAL_BUY_TARGET_REACHED',
    });
    const closed = Object.freeze({
      ...session,state:'PAPER_CLOSED' as const,reasonCode:'EXTERNAL_BUY_TARGET_REACHED' as const,
      lastQuote:sellQuote,lastError:null,updatedAtMs:position.closedAtMs ?? input.nowMs,
      purgeAfterMs:position.purgeAfterMs ?? input.nowMs + this.options.retentionMs,
    });
    return result(closed, counted, 'CLOSE', position, trigger);
  }
}

interface CanonicalBuy {
  readonly id: string;
  readonly trader: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: PaperMinimumConfirmation;
  readonly observedAtMs: number;
  readonly trigger: DomainEvent;
}

function canonicalBuys(input: Parameters<ValidatedExternalBuysStrategy['reconcile']>[0]): readonly CanonicalBuy[] {
  const buys: CanonicalBuy[] = [];
  for (const event of input.launchTrades) {
    const trade = event.payload.trade;
    if (
      trade.kind !== 'BUY' || trade.trader === null || trade.trader === input.creator
      || trade.launchMint !== input.candidate.mint
      || trade.quoteAsset.mint !== input.candidate.quoteAsset.mint
      || !confirmationReached(event.confirmationStatus, input.session.minimumConfirmation)
      || compareCursors(trade.cursor, input.session.entryCursor) <= 0
    ) continue;
    buys.push({
      id:trade.id,trader:trade.trader,cursor:trade.cursor,
      confirmationStatus:event.confirmationStatus as PaperMinimumConfirmation,
      observedAtMs:event.observedAtMs,trigger:event as unknown as DomainEvent,
    });
  }
  for (const trade of input.marketTrades) {
    if (
      trade.kind !== 'BUY' || trade.trader === null || trade.trader === input.creator
      || trade.mint !== input.candidate.mint
      || trade.quoteAsset.mint !== input.candidate.quoteAsset.mint
      || !confirmationReached(trade.confirmationStatus, input.session.minimumConfirmation)
      || compareCursors(trade.cursor, input.session.entryCursor) <= 0
    ) continue;
    buys.push({
      id:trade.id,trader:trade.trader,cursor:trade.cursor,
      confirmationStatus:trade.confirmationStatus as PaperMinimumConfirmation,
      observedAtMs:trade.observedAtMs,trigger:marketTrigger(trade),
    });
  }
  return Object.freeze(buys.sort((left,right) => {
    const order = compareCursors(left.cursor, right.cursor);
    return order === 0 ? left.id.localeCompare(right.id) : order;
  }));
}

function confirmationReached(
  actual: ChainConfirmationStatus,
  minimum: PaperMinimumConfirmation,
): boolean {
  return actual === 'finalized' || (minimum === 'confirmed' && actual === 'confirmed');
}

function marketTrigger(trade: MarketTrade): DomainEvent {
  return Object.freeze({
    id:createDeterministicDerivedEventId({
      type:'PaperExternalBuyCounted',mint:trade.mint,source:'paper-decision',
      program:trade.program,signature:trade.signature,cursor:trade.cursor,qualifier:trade.id,
    }),
    type:'PaperExternalBuyCounted',mint:trade.mint,source:'paper-decision',
    program:trade.program,signature:trade.signature,cursor:trade.cursor,
    confirmationStatus:trade.confirmationStatus,blockchainTimeMs:trade.blockchainTimeMs,
    observedAtMs:trade.observedAtMs,payloadVersion:1,payload:Object.freeze({ tradeId:trade.id }),
  });
}

function candidateTrigger(candidate: TradingCandidateV1): DomainEvent {
  return Object.freeze({
    id:candidate.asOf.eventId,type:'TradingCandidateUpdated',mint:candidate.mint,
    source:'paper-decision',program:'paper-decision',signature:'paper-decision',
    cursor:candidate.asOf.cursor,confirmationStatus:candidate.asOf.confirmationStatus,
    blockchainTimeMs:null,observedAtMs:candidate.asOf.observedAtMs,payloadVersion:1,
    payload:Object.freeze({ candidateId:candidate.id }),
  });
}

function result(
  session: PaperStrategySessionV1,
  countedExternalBuys: readonly PaperExternalBuyEvidence[],
  requestedAction: ExternalBuysStrategyResult['requestedAction'],
  position: PaperPosition | null,
  trigger: DomainEvent,
): ExternalBuysStrategyResult {
  const eventId = createDeterministicDerivedEventId({
    type:'PaperStrategySessionUpdated',mint:session.mint,source:'paper-decision',
    program:trigger.program,signature:trigger.signature,cursor:trigger.cursor,
    qualifier:`${session.id}:${hash(canonicalStringifyJson(session))}`,
  });
  const sessionEvent: DomainEvent = Object.freeze({
    id:eventId,type:'PaperStrategySessionUpdated',mint:session.mint,source:'paper-decision',
    program:trigger.program,signature:trigger.signature,cursor:trigger.cursor,
    confirmationStatus:trigger.confirmationStatus,blockchainTimeMs:trigger.blockchainTimeMs,
    observedAtMs:session.updatedAtMs,payloadVersion:1,payload:Object.freeze({ session }),
  });
  return Object.freeze({
    session,sessionEvent,countedExternalBuys:Object.freeze([...countedExternalBuys]),
    requestedAction,position,
  });
}

function assertReconcileInput(input: Parameters<ValidatedExternalBuysStrategy['reconcile']>[0]): void {
  if (
    input.session.candidateId !== input.candidate.id
    || input.session.positionId !== input.position.id
    || input.position.mint !== input.candidate.mint
    || input.creator.length === 0
    || !Number.isSafeInteger(input.nowMs)
    || input.nowMs < input.session.updatedAtMs
  ) throw new TypeError('Paper strategy reconciliation is inconsistent.');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

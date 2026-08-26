import { createHash } from 'node:crypto';
import { compareCursors } from '../domain/cursor.js';
import { createDeterministicDerivedEventId, type DomainEvent } from '../domain/events.js';
import type { BondingCurveTradeObservedEventV1 } from '../domain/launchpad-events.js';
import type { MarketTrade } from '../domain/market.js';
import {
  countUniqueExternalBuy,
  createCreationEntrySession,
  type PaperExternalBuyEvidenceV2,
  type PaperMinimumConfirmation,
  type PaperStrategySessionV2,
} from '../domain/paper-strategy.js';
import type { PaperPosition } from '../domain/paper-trading.js';
import type { TradingCandidateV1 } from '../domain/trading-candidate.js';
import type { ChainConfirmationStatus, ChainCursor } from '../domain/types.js';
import type { PaperQuoteRouter } from '../ports/paper-quote-router.js';
import { canonicalStringifyJson } from '../utils/json.js';
import type { PaperTradingActions } from './validated-external-buys.strategy.js';

export interface CreationEntryStrategyResult {
  readonly session: PaperStrategySessionV2;
  readonly sessionEvent: DomainEvent;
  readonly countedExternalBuys: readonly PaperExternalBuyEvidenceV2[];
  readonly requestedAction: 'NONE' | 'OPEN' | 'CLOSE';
  readonly position: PaperPosition | null;
}

interface CreationEntryOptions {
  readonly retentionMs: number;
  readonly externalMinimumBuyAmountRaw: bigint;
}

interface CanonicalBuy {
  readonly id: string;
  readonly trader: string;
  readonly quoteAmountRaw: bigint;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: PaperMinimumConfirmation;
  readonly observedAtMs: number;
  readonly trigger: DomainEvent;
}

export class CreationEntryV1Strategy {
  private readonly options: CreationEntryOptions;

  public constructor(
    ledger: PaperTradingActions,
    quotes: PaperQuoteRouter,
    options: CreationEntryOptions,
  ) {
    void ledger;
    void quotes;
    if (options.retentionMs !== 14_400_000 || options.externalMinimumBuyAmountRaw <= 0n) {
      throw new RangeError('Creation entry strategy options are invalid.');
    }
    this.options = Object.freeze({ ...options });
  }

  public prepare(
    candidate: TradingCandidateV1,
    input: Readonly<{
      externalBuyTarget: number;
      minimumConfirmation: PaperMinimumConfirmation;
      nowMs: number;
    }>,
  ): PaperStrategySessionV2 | null {
    if (candidate.state !== 'ELIGIBLE') return null;
    return createCreationEntrySession({
      candidate,
      state: 'BUY_PENDING',
      reasonCode: 'QUALIFIED_ENTRY',
      positionId: null,
      entryCursor: candidate.asOf.cursor,
      externalBuyTarget: input.externalBuyTarget,
      externalBuyCount: 0,
      countedTradeIds: [],
      countedBuyerWallets: [],
      lastCountedCursor: null,
      minimumConfirmation: input.minimumConfirmation,
      lastQuote: candidate.buyQuote,
      lastError: null,
      pendingExitReason: null,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
      purgeAfterMs: input.nowMs + this.options.retentionMs,
    });
  }

  public reconcile(input: Readonly<{
    candidate: TradingCandidateV1;
    session: PaperStrategySessionV2;
    position: PaperPosition;
    creator: string;
    launchTrades: readonly BondingCurveTradeObservedEventV1[];
    marketTrades: readonly MarketTrade[];
    nowMs: number;
  }>): Promise<CreationEntryStrategyResult> {
    if (
      input.candidate.strategy.id !== 'creation-entry-v1'
      || input.session.candidateId !== input.candidate.id
      || input.position.id !== input.session.positionId
      || input.position.status !== 'PAPER_HOLDING'
    ) throw new TypeError('Creation entry reconciliation is inconsistent.');

    let session = input.session;
    const counted: PaperExternalBuyEvidenceV2[] = [];
    let trigger: DomainEvent = candidateTrigger(input.candidate);
    for (const buy of canonicalBuys(input, this.options.externalMinimumBuyAmountRaw)) {
      const result = countUniqueExternalBuy(session, {
        tradeId: buy.id,
        mint: input.candidate.mint,
        quoteMint: input.candidate.quoteAsset.mint,
        trader: buy.trader,
        quoteAmountRaw: buy.quoteAmountRaw,
        cursor: buy.cursor,
        confirmationStatus: buy.confirmationStatus,
        observedAtMs: buy.observedAtMs,
      });
      session = result.session;
      if (result.evidence !== null) {
        counted.push(result.evidence);
        trigger = buy.trigger;
      }
      if (result.targetReached) break;
    }
    return Promise.resolve(strategyResult(session, counted, input.position, trigger));
  }
}

function canonicalBuys(
  input: Parameters<CreationEntryV1Strategy['reconcile']>[0],
  minimumAmountRaw: bigint,
): readonly CanonicalBuy[] {
  const buys: CanonicalBuy[] = [];
  for (const event of input.launchTrades) {
    const trade = event.payload.trade;
    if (
      trade.kind !== 'BUY'
      || trade.trader === null
      || trade.trader === input.creator
      || trade.launchMint !== input.candidate.mint
      || trade.quoteAsset.mint !== input.candidate.quoteAsset.mint
      || trade.quoteAmountRaw < minimumAmountRaw
      || !confirmationReached(event.confirmationStatus, input.session.minimumConfirmation)
      || compareCursors(trade.cursor, input.session.entryCursor) <= 0
    ) continue;
    buys.push(Object.freeze({
      id: trade.id,
      trader: trade.trader,
      quoteAmountRaw: trade.quoteAmountRaw,
      cursor: trade.cursor,
      confirmationStatus: event.confirmationStatus as PaperMinimumConfirmation,
      observedAtMs: event.observedAtMs,
      trigger: event as unknown as DomainEvent,
    }));
  }
  for (const trade of input.marketTrades) {
    if (
      trade.kind !== 'BUY'
      || trade.trader === null
      || trade.trader === input.creator
      || trade.mint !== input.candidate.mint
      || trade.quoteAsset.mint !== input.candidate.quoteAsset.mint
      || trade.quoteAmountRaw < minimumAmountRaw
      || !confirmationReached(trade.confirmationStatus, input.session.minimumConfirmation)
      || compareCursors(trade.cursor, input.session.entryCursor) <= 0
    ) continue;
    buys.push(Object.freeze({
      id: trade.id,
      trader: trade.trader,
      quoteAmountRaw: trade.quoteAmountRaw,
      cursor: trade.cursor,
      confirmationStatus: trade.confirmationStatus as PaperMinimumConfirmation,
      observedAtMs: trade.observedAtMs,
      trigger: marketTrigger(trade),
    }));
  }
  buys.sort((left, right) => {
    const order = compareCursors(left.cursor, right.cursor);
    return order === 0 ? left.id.localeCompare(right.id) : order;
  });
  const wallets = new Set<string>();
  return Object.freeze(buys.filter((buy) => {
    if (wallets.has(buy.trader)) return false;
    wallets.add(buy.trader);
    return true;
  }));
}

function confirmationReached(
  actual: ChainConfirmationStatus,
  minimum: PaperMinimumConfirmation,
): boolean {
  return actual === 'finalized' || (minimum === 'confirmed' && actual === 'confirmed');
}

function strategyResult(
  session: PaperStrategySessionV2,
  countedExternalBuys: readonly PaperExternalBuyEvidenceV2[],
  position: PaperPosition,
  trigger: DomainEvent,
): CreationEntryStrategyResult {
  const sessionEvent = createSessionEvent(session, trigger);
  return Object.freeze({
    session,
    sessionEvent,
    countedExternalBuys: Object.freeze([...countedExternalBuys]),
    requestedAction: 'NONE',
    position,
  });
}

function createSessionEvent(session: PaperStrategySessionV2, trigger: DomainEvent): DomainEvent {
  const id = createDeterministicDerivedEventId({
    type: 'PaperStrategySessionUpdated',
    mint: session.mint,
    source: 'paper-decision',
    program: trigger.program,
    signature: trigger.signature,
    cursor: trigger.cursor,
    qualifier: `${session.id}:${hash(canonicalStringifyJson(session))}`,
  });
  return Object.freeze({
    id,
    type: 'PaperStrategySessionUpdated',
    mint: session.mint,
    source: 'paper-decision',
    program: trigger.program,
    signature: trigger.signature,
    cursor: trigger.cursor,
    confirmationStatus: trigger.confirmationStatus,
    blockchainTimeMs: trigger.blockchainTimeMs,
    observedAtMs: session.updatedAtMs,
    payloadVersion: 1,
    payload: Object.freeze({ session }),
  });
}

function marketTrigger(trade: MarketTrade): DomainEvent {
  return Object.freeze({
    id: createDeterministicDerivedEventId({
      type: 'PaperExternalBuyCounted',
      mint: trade.mint,
      source: 'paper-decision',
      program: trade.program,
      signature: trade.signature,
      cursor: trade.cursor,
      qualifier: trade.id,
    }),
    type: 'PaperExternalBuyCounted',
    mint: trade.mint,
    source: 'paper-decision',
    program: trade.program,
    signature: trade.signature,
    cursor: trade.cursor,
    confirmationStatus: trade.confirmationStatus,
    blockchainTimeMs: trade.blockchainTimeMs,
    observedAtMs: trade.observedAtMs,
    payloadVersion: 1,
    payload: Object.freeze({ tradeId: trade.id }),
  });
}

function candidateTrigger(candidate: TradingCandidateV1): DomainEvent {
  return Object.freeze({
    id: candidate.asOf.eventId,
    type: 'TradingCandidateUpdated',
    mint: candidate.mint,
    source: 'paper-decision',
    program: 'paper-decision',
    signature: 'paper-decision',
    cursor: candidate.asOf.cursor,
    confirmationStatus: candidate.asOf.confirmationStatus,
    blockchainTimeMs: null,
    observedAtMs: candidate.asOf.observedAtMs,
    payloadVersion: 1,
    payload: Object.freeze({ candidateId: candidate.id }),
  });
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

import { createHash } from 'node:crypto';
import { compareCursors } from '../domain/cursor.js';
import { createDeterministicDerivedEventId, type DomainEvent } from '../domain/events.js';
import type { BondingCurveTradeObservedEventV1 } from '../domain/launchpad-events.js';
import type { MarketTrade } from '../domain/market.js';
import {
  countUniqueExternalBuy,
  createDeterministicCreationExitCommandId,
  createCreationEntrySession,
  type CreationExitReason,
  type PaperExternalBuyEvidenceV2,
  type PaperMinimumConfirmation,
  type PaperStrategySessionV2,
} from '../domain/paper-strategy.js';
import type { PaperPosition } from '../domain/paper-trading.js';
import type { QualificationReport } from '../domain/qualification.js';
import type { TradingCandidateV1 } from '../domain/trading-candidate.js';
import type { ChainConfirmationStatus, ChainCursor } from '../domain/types.js';
import { PaperQuoteError, type PaperQuoteRouter } from '../ports/paper-quote-router.js';
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
  readonly takeProfitMultiplierBps?: bigint;
  readonly manualKillSwitch?: boolean;
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
  private readonly options: Readonly<{
    retentionMs: number;
    externalMinimumBuyAmountRaw: bigint;
    takeProfitMultiplierBps: bigint;
    manualKillSwitch: boolean;
  }>;

  public constructor(
    private readonly ledger: PaperTradingActions,
    private readonly quotes: PaperQuoteRouter,
    options: CreationEntryOptions,
  ) {
    const takeProfitMultiplierBps = options.takeProfitMultiplierBps ?? 20_000n;
    if (
      options.retentionMs !== 14_400_000
      || options.externalMinimumBuyAmountRaw <= 0n
      || takeProfitMultiplierBps < 10_000n
      || takeProfitMultiplierBps > 1_000_000n
    ) {
      throw new RangeError('Creation entry strategy options are invalid.');
    }
    this.options = Object.freeze({
      retentionMs: options.retentionMs,
      externalMinimumBuyAmountRaw: options.externalMinimumBuyAmountRaw,
      takeProfitMultiplierBps,
      manualKillSwitch: options.manualKillSwitch ?? false,
    });
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
      externalMinimumBuyAmountRaw: this.options.externalMinimumBuyAmountRaw,
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

  public async open(input: Readonly<{
    candidate: TradingCandidateV1;
    session: PaperStrategySessionV2;
    qualification: QualificationReport;
    qualificationEvent: DomainEvent;
    maximumRoundTripLossBps: bigint;
  }>): Promise<CreationEntryStrategyResult> {
    return this.openOrRecover(input, false);
  }

  public async recoverOpen(input: Readonly<{
    candidate: TradingCandidateV1;
    session: PaperStrategySessionV2;
    qualification: QualificationReport;
    qualificationEvent: DomainEvent;
    maximumRoundTripLossBps: bigint;
  }>): Promise<CreationEntryStrategyResult> {
    return this.openOrRecover(input, true);
  }

  private async openOrRecover(input: Readonly<{
    candidate: TradingCandidateV1;
    session: PaperStrategySessionV2;
    qualification: QualificationReport;
    qualificationEvent: DomainEvent;
    maximumRoundTripLossBps: bigint;
  }>, recovery: boolean): Promise<CreationEntryStrategyResult> {
    const { candidate, session } = input;
    if (
      session.state !== 'BUY_PENDING'
      || session.candidateId !== candidate.id
      || candidate.buyQuote === null
      || candidate.reverseSellQuote === null
    ) throw new TypeError('Creation paper entry is inconsistent.');
    const command = {
      mint: candidate.mint,
      quoteAsset: candidate.quoteAsset,
      strategy: candidate.strategy,
      trigger: input.qualificationEvent,
      qualification: input.qualification,
      buyQuote: candidate.buyQuote,
      reverseSellQuote: candidate.reverseSellQuote,
      maximumRoundTripLossBps: input.maximumRoundTripLossBps,
      strategySessionId: session.id,
      qualificationReportId: candidate.qualificationReportId,
      candidateId: candidate.id,
      expectedCurrentQualification: Object.freeze({
        mint: candidate.mint,
        reportId: candidate.qualificationReportId,
        qualificationEventId: input.qualificationEvent.id,
      }),
    } as const;
    const position = recovery
      ? await this.ledger.reconcileOpen(command)
      : await this.ledger.open(command);
    if (recovery && position.status !== 'PAPER_HOLDING') {
      throw new TypeError('Creation paper entry recovery did not find a holding position.');
    }
    const updated = updateSession(candidate, session, {
      state: 'WAITING_EXTERNAL_BUYS',
      reasonCode: 'QUALIFIED_ENTRY',
      positionId: position.id,
      lastQuote: candidate.buyQuote,
      lastError: null,
      updatedAtMs: position.openedAtMs,
      purgeAfterMs: position.openedAtMs + this.options.retentionMs,
    });
    return strategyResult(
      updated,
      [],
      position,
      input.qualificationEvent,
      recovery ? 'NONE' : 'OPEN',
    );
  }

  public async reconcileSource(input: Readonly<{
    candidate: TradingCandidateV1;
    session: PaperStrategySessionV2;
    qualification: QualificationReport;
    qualificationEvent: DomainEvent;
    maximumRoundTripLossBps: bigint;
  }>): Promise<CreationEntryStrategyResult> {
    const { candidate, session } = input;
    if (
      session.candidateId !== candidate.id
      || candidate.buyQuote === null
      || candidate.reverseSellQuote === null
      || input.qualificationEvent.confirmationStatus !== 'orphaned'
    ) throw new TypeError('Creation paper source reconciliation is inconsistent.');
    const position = await this.ledger.reconcileOpen({
      mint: candidate.mint,
      quoteAsset: candidate.quoteAsset,
      strategy: candidate.strategy,
      trigger: input.qualificationEvent,
      qualification: input.qualification,
      buyQuote: candidate.buyQuote,
      reverseSellQuote: candidate.reverseSellQuote,
      maximumRoundTripLossBps: input.maximumRoundTripLossBps,
      strategySessionId: session.id,
      qualificationReportId: candidate.qualificationReportId,
      candidateId: candidate.id,
    });
    if (
      position.status !== 'PAPER_RETRACTED'
      || position.closedAtMs === null
      || position.purgeAfterMs === null
    ) throw new TypeError('Creation paper source reconciliation did not retract the position.');
    const updated = updateSession(candidate, session, {
      state: 'PAPER_RETRACTED',
      reasonCode: 'SOURCE_ORPHANED',
      positionId: position.id,
      lastError: null,
      updatedAtMs: Math.max(session.updatedAtMs, position.closedAtMs),
      purgeAfterMs: position.purgeAfterMs,
    });
    return strategyResult(updated, [], position, input.qualificationEvent);
  }

  public async reconcileEvidence(input: Readonly<{
    candidate: TradingCandidateV1;
    session: PaperStrategySessionV2;
    position: PaperPosition;
    creator: string;
    launchTrades: readonly BondingCurveTradeObservedEventV1[];
    marketTrades: readonly MarketTrade[];
    orphanedEvent: DomainEvent;
    nowMs: number;
  }>): Promise<CreationEntryStrategyResult> {
    if (input.orphanedEvent.confirmationStatus !== 'orphaned') {
      throw new TypeError('Creation evidence reconciliation requires an orphaned event.');
    }
    const baseline = updateSession(input.candidate, input.session, {
      state: 'WAITING_EXTERNAL_BUYS',
      reasonCode: 'QUALIFIED_ENTRY',
      externalBuyCount: 0,
      countedTradeIds: Object.freeze([]),
      countedBuyerWallets: Object.freeze([]),
      lastCountedCursor: null,
      pendingExitReason: null,
      lastQuote: input.candidate.buyQuote,
      lastError: null,
      updatedAtMs: Math.max(input.session.createdAtMs, input.position.openedAtMs),
    });
    if (input.position.status === 'PAPER_HOLDING') {
      return this.reconcile({ ...input, session: baseline });
    }

    let rebuilt = baseline;
    const counted: PaperExternalBuyEvidenceV2[] = [];
    for (const buy of canonicalBuys({ ...input, session: baseline })) {
      const result = countUniqueExternalBuy(rebuilt, {
        tradeId: buy.id,
        mint: input.candidate.mint,
        quoteMint: input.candidate.quoteAsset.mint,
        trader: buy.trader,
        quoteAmountRaw: buy.quoteAmountRaw,
        cursor: buy.cursor,
        confirmationStatus: buy.confirmationStatus,
        observedAtMs: buy.observedAtMs,
      });
      rebuilt = result.session;
      if (result.evidence !== null) counted.push(result.evidence);
    }
    const creatorSell = earliestCreatorSell({ ...input, session: rebuilt });
    const priorQuote = input.session.lastQuote;
    const profitStillSupported = priorQuote !== null
      && priorQuote.inputMint === input.candidate.mint
      && priorQuote.outputMint === input.candidate.quoteAsset.mint
      && priorQuote.amountInRaw === input.position.baseFilledRaw
      && priorQuote.minimumAmountOutRaw * 10_000n
        >= input.position.quoteCostRaw * this.options.takeProfitMultiplierBps;
    const reason: CreationExitReason | null = this.options.manualKillSwitch
      ? 'MANUAL_KILL_SWITCH'
      : creatorSell !== null
        ? 'CREATOR_EARLY_SELL'
        : profitStillSupported
          ? 'TAKE_PROFIT_2X_EXECUTABLE'
          : rebuilt.externalBuyCount >= rebuilt.externalBuyTarget
            ? 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED'
            : null;
    if (reason !== null && input.position.status === 'PAPER_CLOSED') {
      if (input.position.closedAtMs === null || input.position.purgeAfterMs === null) {
        throw new TypeError('Closed creation position is missing terminal timestamps.');
      }
      const closed = updateSession(input.candidate, rebuilt, {
        state: 'PAPER_CLOSED',
        reasonCode: reason,
        pendingExitReason: reason,
        updatedAtMs: input.position.closedAtMs,
        purgeAfterMs: input.position.purgeAfterMs,
      });
      return strategyResult(closed, counted, input.position, creatorSell ?? input.orphanedEvent);
    }
    const position = await this.ledger.retract(input.position.id, input.orphanedEvent);
    if (position.status !== 'PAPER_RETRACTED' || position.purgeAfterMs === null) {
      throw new TypeError('Creation evidence reconciliation did not retract the position.');
    }
    const retracted = updateSession(input.candidate, rebuilt, {
      state: 'PAPER_RETRACTED',
      reasonCode: 'SOURCE_ORPHANED',
      pendingExitReason: null,
      updatedAtMs: Math.max(rebuilt.updatedAtMs, input.orphanedEvent.observedAtMs),
      purgeAfterMs: position.purgeAfterMs,
    });
    return strategyResult(retracted, counted, position, input.orphanedEvent);
  }

  public async reconcile(input: Readonly<{
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
      || !['PAPER_HOLDING', 'PAPER_CLOSED'].includes(input.position.status)
    ) throw new TypeError('Creation entry reconciliation is inconsistent.');

    let session = input.session;
    const counted: PaperExternalBuyEvidenceV2[] = [];
    let trigger: DomainEvent = candidateTrigger(input.candidate);
    for (const buy of canonicalBuys(input)) {
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
    const creatorSell = earliestCreatorSell(input);
    const mandatoryReason = this.options.manualKillSwitch
      ? 'MANUAL_KILL_SWITCH'
      : creatorSell === null
        ? session.pendingExitReason
        : 'CREATOR_EARLY_SELL';
    if (this.options.manualKillSwitch) trigger = candidateTrigger(input.candidate);
    else if (creatorSell !== null) trigger = creatorSell;

    if (input.position.status === 'PAPER_CLOSED') {
      if (
        input.position.closedAtMs === null
        || input.position.purgeAfterMs === null
        || input.position.quoteProceedsRaw === null
      ) throw new TypeError('Closed creation position is missing terminal evidence.');
      const recoveredProfit = input.position.quoteProceedsRaw * 10_000n
        >= input.position.quoteCostRaw * this.options.takeProfitMultiplierBps;
      const recoveredReason: CreationExitReason | null = this.options.manualKillSwitch
        ? 'MANUAL_KILL_SWITCH'
        : creatorSell !== null
          ? 'CREATOR_EARLY_SELL'
          : recoveredProfit
            ? 'TAKE_PROFIT_2X_EXECUTABLE'
            : session.externalBuyCount >= session.externalBuyTarget
              ? 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED'
              : session.pendingExitReason;
      if (recoveredReason === null) {
        throw new TypeError('Closed creation position has no recoverable exit reason.');
      }
      const recovered = updateSession(input.candidate, session, {
        state: 'PAPER_CLOSED',
        reasonCode: recoveredReason,
        pendingExitReason: recoveredReason,
        lastError: null,
        updatedAtMs: input.position.closedAtMs,
        purgeAfterMs: input.position.purgeAfterMs,
      });
      return strategyResult(recovered, counted, input.position, trigger);
    }

    let sellQuote;
    try {
      sellQuote = await this.quotes.quote({
        mint: input.candidate.mint,
        quoteAsset: input.candidate.quoteAsset,
        side: 'SELL',
        amountInRaw: input.position.remainingBaseRaw,
        slippageBps: input.candidate.buyQuote?.slippageBps ?? 0n,
      });
      if (
        sellQuote.inputMint !== input.candidate.mint
        || sellQuote.outputMint !== input.candidate.quoteAsset.mint
        || sellQuote.amountInRaw !== input.position.remainingBaseRaw
      ) {
        throw new PaperQuoteError('QUOTE_STATE_INCONSISTENT', 'Full-position sell quote is inconsistent.');
      }
    } catch (error: unknown) {
      if (mandatoryReason === null) return strategyResult(session, counted, input.position, trigger);
      const known = error instanceof PaperQuoteError ? error : null;
      const pending = updateSession(input.candidate, session, {
        state: 'EXIT_PENDING_QUOTE',
        reasonCode: 'SELL_QUOTE_UNAVAILABLE_OR_STALE',
        pendingExitReason: mandatoryReason,
        lastError: Object.freeze({
          code: known?.code ?? 'QUOTE_FAILURE',
          message: known?.message ?? 'Full-position sell quote failed.',
          retryable: known?.retryable ?? false,
        }),
        updatedAtMs: input.nowMs,
      });
      return strategyResult(pending, counted, input.position, trigger);
    }

    const takeProfitReached = sellQuote.minimumAmountOutRaw * 10_000n
      >= input.position.quoteCostRaw * this.options.takeProfitMultiplierBps;
    const exitReason: CreationExitReason | null = mandatoryReason
      ?? (takeProfitReached ? 'TAKE_PROFIT_2X_EXECUTABLE' : null)
      ?? (session.externalBuyCount >= session.externalBuyTarget
        ? 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED'
        : null);
    if (exitReason === null) {
      const monitoring = updateSession(input.candidate, session, {
        state: 'WAITING_EXTERNAL_BUYS',
        lastQuote: sellQuote,
        lastError: null,
        updatedAtMs: input.nowMs,
      });
      return strategyResult(monitoring, counted, input.position, trigger);
    }

    const position = await this.ledger.close({
      positionId: input.position.id,
      trigger,
      sellQuote,
      reason: exitReason,
    });
    const closedAtMs = position.closedAtMs ?? input.nowMs;
    const closed = updateSession(input.candidate, session, {
      state: 'PAPER_CLOSED',
      reasonCode: exitReason,
      pendingExitReason: exitReason,
      closeCommandId: createDeterministicCreationExitCommandId(
        input.position.id,
        session.strategy,
        exitReason,
      ),
      lastQuote: sellQuote,
      lastError: null,
      updatedAtMs: closedAtMs,
      purgeAfterMs: position.purgeAfterMs ?? closedAtMs + this.options.retentionMs,
    });
    return strategyResult(closed, counted, position, trigger, 'CLOSE');
  }
}

function updateSession(
  candidate: TradingCandidateV1,
  session: PaperStrategySessionV2,
  update: Partial<PaperStrategySessionV2>,
): PaperStrategySessionV2 {
  const next = { ...session, ...update };
  return createCreationEntrySession({
    candidate,
    state: next.state,
    reasonCode: next.reasonCode,
    positionId: next.positionId,
    entryCursor: next.entryCursor,
    externalBuyTarget: next.externalBuyTarget,
    externalBuyCount: next.externalBuyCount,
    externalMinimumBuyAmountRaw: next.externalMinimumBuyAmountRaw,
    countedTradeIds: next.countedTradeIds,
    countedBuyerWallets: next.countedBuyerWallets,
    lastCountedCursor: next.lastCountedCursor,
    minimumConfirmation: next.minimumConfirmation,
    lastQuote: next.lastQuote,
    lastError: next.lastError,
    pendingExitReason: next.pendingExitReason,
    createdAtMs: next.createdAtMs,
    updatedAtMs: next.updatedAtMs,
    purgeAfterMs: next.purgeAfterMs,
  });
}

function earliestCreatorSell(
  input: Parameters<CreationEntryV1Strategy['reconcile']>[0],
): DomainEvent | null {
  const sells: DomainEvent[] = [];
  for (const event of input.launchTrades) {
    const trade = event.payload.trade;
    if (
      trade.kind === 'SELL'
      && trade.trader === input.creator
      && trade.launchMint === input.candidate.mint
      && trade.quoteAsset.mint === input.candidate.quoteAsset.mint
      && confirmationReached(event.confirmationStatus, input.session.minimumConfirmation)
      && compareCursors(trade.cursor, input.session.entryCursor) > 0
    ) sells.push(event as unknown as DomainEvent);
  }
  for (const trade of input.marketTrades) {
    if (
      trade.kind === 'SELL'
      && trade.trader === input.creator
      && trade.mint === input.candidate.mint
      && trade.quoteAsset.mint === input.candidate.quoteAsset.mint
      && confirmationReached(trade.confirmationStatus, input.session.minimumConfirmation)
      && compareCursors(trade.cursor, input.session.entryCursor) > 0
    ) sells.push(marketTrigger(trade));
  }
  sells.sort((left, right) => {
    const order = compareCursors(left.cursor, right.cursor);
    return order === 0 ? left.id.localeCompare(right.id) : order;
  });
  return sells[0] ?? null;
}

function canonicalBuys(
  input: Parameters<CreationEntryV1Strategy['reconcile']>[0],
): readonly CanonicalBuy[] {
  const minimumAmountRaw = input.session.externalMinimumBuyAmountRaw;
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
  requestedAction: CreationEntryStrategyResult['requestedAction'] = 'NONE',
): CreationEntryStrategyResult {
  const sessionEvent = createSessionEvent(session, trigger);
  return Object.freeze({
    session,
    sessionEvent,
    countedExternalBuys: Object.freeze([...countedExternalBuys]),
    requestedAction,
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

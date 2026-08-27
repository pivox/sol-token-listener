import { createPaperMvpPositionSample } from '../domain/paper-mvp.js';
import type {
  PaperMvpRepository,
  PaperMvpUnknownPosition,
  PaperMvpUnknownReason,
} from '../ports/paper-mvp-repository.js';
import type { PaperMvpSource, PaperMvpSourcePosition } from '../ports/paper-mvp-source.js';
import type { ProviderUsageProbe } from '../ports/provider-usage-probe.js';

export interface PaperMvpCollectorResult {
  readonly scanned: number;
  readonly inserted: number;
  readonly valid: number;
  readonly unknown: number;
  readonly duplicateLogicalBuys: number;
  readonly duplicateLogicalSells: number;
}

export class PaperMvpCollector {
  public constructor(
    private readonly repository: PaperMvpRepository,
    private readonly source: PaperMvpSource,
    private readonly clock: () => number = Date.now,
    private readonly providerUsageProbe?: ProviderUsageProbe,
  ) {}

  public async collect(input: Readonly<{
    runId: string;
    runnerOwnerId: string;
    limit: number;
    signal?: AbortSignal;
  }>): Promise<PaperMvpCollectorResult> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new RangeError('Paper MVP collector limit must be between 1 and 1000.');
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.collectAttempt(input);
      } catch (error: unknown) {
        if (!isStaleProgress(error) || attempt === 2) throw error;
      }
    }
    throw new Error('Unreachable paper MVP collector retry state.');
  }

  private async collectAttempt(
    input: Readonly<{ runId: string; runnerOwnerId: string; limit: number; signal?: AbortSignal }>,
  ): Promise<PaperMvpCollectorResult> {
    input.signal?.throwIfAborted();
    const before = await this.repository.load(input.runId);
    input.signal?.throwIfAborted();
    if (before?.run.state !== 'RUNNING') {
      throw new PaperMvpCollectorError('RUN_NOT_ACTIVE');
    }
    if (before.run.configuration.strategyId !== 'creation-entry-v1') {
      throw new PaperMvpCollectorError('STRATEGY_UNSUPPORTED');
    }
    const remaining = before.run.configuration.targetClosedPositions
      - before.run.closedPositions;
    if (remaining <= 0) {
      return Object.freeze({
        scanned: 0,
        inserted: 0,
        valid: 0,
        unknown: 0,
        duplicateLogicalBuys: before.run.counters.duplicateLogicalBuys,
        duplicateLogicalSells: before.run.counters.duplicateLogicalSells,
      });
    }
    const effectiveLimit = Math.min(input.limit,remaining);
    const observedAtMs = Math.max(this.clock(), before.run.updatedAtMs + 1);
    const batch = await this.source.collectBatch({
      runId: before.run.runId,
      startedAtMs: before.run.startedAtMs,
      deadlineAtMs: before.run.deadlineAtMs,
      observedAtMs,
      strategyId: before.run.configuration.strategyId,
      strategyVersion: before.run.configuration.strategyVersion,
      limit: effectiveLimit,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    input.signal?.throwIfAborted();
    const samples = [];
    const unknownPositions: PaperMvpUnknownPosition[] = [];
    const readyPositions = batch.positions.filter((facts) => (
      facts.status === 'PAPER_RETRACTED'
      || facts.closeEventConfirmationStatus === 'finalized'
      || facts.closeEventConfirmationStatus === 'orphaned'
    ));
    for (const facts of readyPositions) {
      const classified = classify(facts, before.run.configuration.networkFeeRawPerTransaction);
      if ('reason' in classified) unknownPositions.push(classified);
      else samples.push(classified);
    }
    const providerUsage = this.providerUsageProbe === undefined
      ? before.run.providerUsage
      : await this.providerUsageProbe.snapshot(input.signal);
    input.signal?.throwIfAborted();
    const after = await this.repository.recordProgress({
      runId: before.run.runId,
      runnerOwnerId: input.runnerOwnerId,
      expectedUpdatedAtMs: before.run.updatedAtMs,
      observedAtMs,
      counters: Object.freeze({
        creationsObserved: batch.creationsObserved,
        entriesRejected: batch.entriesRejected,
        duplicateLogicalBuys: before.run.counters.duplicateLogicalBuys
          + batch.duplicateLogicalBuys,
        duplicateLogicalSells: before.run.counters.duplicateLogicalSells
          + batch.duplicateLogicalSells,
        openedPositions: batch.openedPositions ?? before.run.counters.openedPositions ?? 0,
        openPositions: batch.openPositions ?? before.run.counters.openPositions ?? 0,
      }),
      providerUsage,
      samples: Object.freeze(samples),
      unknownPositions: Object.freeze(unknownPositions),
    });
    const beforeCount = before.run.closedPositions + before.run.counters.unknownTerminalPositions;
    const afterCount = after.closedPositions + after.counters.unknownTerminalPositions;
    return Object.freeze({
      scanned: readyPositions.length,
      inserted: afterCount - beforeCount,
      valid: after.closedPositions - before.run.closedPositions,
      unknown: after.counters.unknownTerminalPositions
        - before.run.counters.unknownTerminalPositions,
      duplicateLogicalBuys: after.counters.duplicateLogicalBuys,
      duplicateLogicalSells: after.counters.duplicateLogicalSells,
    });
  }
}

function isStaleProgress(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === 'PROGRESS_SNAPSHOT_STALE';
}

export type PaperMvpCollectorErrorCode = 'RUN_NOT_ACTIVE' | 'STRATEGY_UNSUPPORTED';

export class PaperMvpCollectorError extends Error {
  public constructor(public readonly code: PaperMvpCollectorErrorCode) {
    super('Paper MVP collector cannot collect the requested run.');
    this.name = 'PaperMvpCollectorError';
  }
}

function classify(
  facts: PaperMvpSourcePosition,
  networkFeeRawPerTransaction: bigint,
): ReturnType<typeof createPaperMvpPositionSample> | PaperMvpUnknownPosition {
  const positionId = requiredText(facts.positionId);
  if (facts.status === 'PAPER_RETRACTED'
    || facts.closeEventConfirmationStatus === 'orphaned') {
    return unknown(positionId, 'POSITION_RETRACTED');
  }
  const missing = missingReason(facts);
  if (missing !== null) return unknown(positionId, missing);
  if (!sourceMatches(facts)) return unknown(positionId, 'SOURCE_CONTRADICTION');
  if (!isExitReason(facts.sellReason)) return unknown(positionId, 'UNSUPPORTED_EXIT_REASON');
  try {
    return createPaperMvpPositionSample({
      positionId,
      mint: requiredText(facts.mint),
      quoteMint: requiredText(facts.quoteMint),
      exitReason: facts.sellReason,
      creationDetectedAtMs: requiredTimestamp(facts.creationDetectedAtMs),
      entryDecisionAtMs: requiredTimestamp(facts.entryDecisionAtMs),
      entryQuoteAtMs: requiredTimestamp(facts.entryQuoteAtMs),
      paperBuyAtMs: requiredTimestamp(facts.paperBuyAtMs),
      exitTriggerAtMs: requiredTimestamp(facts.exitTriggerAtMs),
      exitQuoteAtMs: requiredTimestamp(facts.exitQuoteAtMs),
      paperSellAtMs: requiredTimestamp(facts.paperSellAtMs),
      buyAmountInRaw: unsignedBigint(facts.buyAmountInRaw),
      buyAmountOutRaw: unsignedBigint(facts.buyAmountOutRaw),
      buyMinimumAmountOutRaw: unsignedBigint(facts.buyMinimumAmountOutRaw),
      buyFeesRaw: unsignedBigint(facts.buyFeesRaw),
      buySlippageBps: unsignedBigint(facts.buySlippageBps),
      buyPriceImpactBps: unsignedBigint(facts.buyPriceImpactBps),
      sellAmountInRaw: unsignedBigint(facts.sellAmountInRaw),
      sellAmountOutRaw: unsignedBigint(facts.sellAmountOutRaw),
      sellMinimumAmountOutRaw: unsignedBigint(facts.sellMinimumAmountOutRaw),
      sellFeesRaw: unsignedBigint(facts.sellFeesRaw),
      sellSlippageBps: unsignedBigint(facts.sellSlippageBps),
      sellPriceImpactBps: unsignedBigint(facts.sellPriceImpactBps),
      networkFeeRawPerTransaction,
    });
  } catch {
    return unknown(positionId, timestampsAreCanonical(facts) && !timestampsInOrder(facts)
      ? 'INVALID_TIMESTAMP_ORDER'
      : 'SOURCE_CONTRADICTION');
  }
}

function missingReason(facts: PaperMvpSourcePosition): PaperMvpUnknownReason | null {
  if (facts.creationDetectedAtMs === null) return 'MISSING_CREATION_DETECTED_AT';
  if (facts.entryDecisionAtMs === null) return 'MISSING_ENTRY_DECISION_AT';
  if (facts.buyTradeId === null) return 'MISSING_BUY_TRADE';
  if (facts.entryQuoteAtMs === null) return 'MISSING_ENTRY_QUOTE_AT';
  if (facts.paperBuyAtMs === null) return 'MISSING_PAPER_BUY_AT';
  if (facts.exitTriggerAtMs === null) return 'MISSING_EXIT_TRIGGER_AT';
  if (facts.sellTradeId === null) return 'MISSING_SELL_TRADE';
  if (facts.exitQuoteAtMs === null) return 'MISSING_EXIT_QUOTE_AT';
  if (facts.paperSellAtMs === null) return 'MISSING_PAPER_SELL_AT';
  return null;
}

function sourceMatches(facts: PaperMvpSourcePosition): boolean {
  return facts.status === 'PAPER_CLOSED'
    && facts.entryDecisionJobCount === 1
    && facts.entryDecisionJobAtMs === facts.entryDecisionAtMs
    && facts.entryTradeId === facts.buyTradeId
    && facts.buySide === 'BUY'
    && facts.buyInputMint === facts.quoteMint
    && facts.buyOutputMint === facts.mint
    && facts.buyFillAmountOutRaw === facts.buyMinimumAmountOutRaw
    && facts.exitTradeId === facts.sellTradeId
    && facts.sellSide === 'SELL'
    && facts.sellInputMint === facts.mint
    && facts.sellOutputMint === facts.quoteMint
    && facts.sellFillAmountOutRaw === facts.sellMinimumAmountOutRaw
    && typeof facts.closeEventId === 'string'
    && facts.closeEventType === 'PaperPositionClosed'
    && facts.closeEventSource === 'paper-trading'
    && facts.closeEventConfirmationStatus === 'finalized'
    && facts.closeEventObservedAtMs === facts.exitTriggerAtMs;
}

function timestampsInOrder(facts: PaperMvpSourcePosition): boolean {
  const values = [facts.creationDetectedAtMs, facts.entryDecisionAtMs, facts.entryQuoteAtMs,
    facts.paperBuyAtMs, facts.exitTriggerAtMs, facts.exitQuoteAtMs, facts.paperSellAtMs];
  return timestampsAreCanonical(facts)
    && values.every((value, index) => index === 0 || (values[index - 1] as number) <= (value as number));
}

function timestampsAreCanonical(facts: PaperMvpSourcePosition): boolean {
  return [facts.creationDetectedAtMs, facts.entryDecisionAtMs, facts.entryQuoteAtMs,
    facts.paperBuyAtMs, facts.exitTriggerAtMs, facts.exitQuoteAtMs, facts.paperSellAtMs]
    .every((value) => typeof value === 'number' && Number.isSafeInteger(value)
      && value >= 0 && !Object.is(value, -0));
}

function isExitReason(value: unknown): value is Parameters<typeof createPaperMvpPositionSample>[0]['exitReason'] {
  return value === 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED'
    || value === 'TAKE_PROFIT_2X_EXECUTABLE'
    || value === 'CREATOR_EARLY_SELL'
    || value === 'MANUAL_KILL_SWITCH';
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Invalid source text.');
  return value;
}
function requiredTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('Invalid source time.');
  return value;
}
function unsignedBigint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,78}$/u.test(value)) throw new TypeError('Invalid source bigint.');
  return BigInt(value);
}
function unknown(positionId: string, reason: PaperMvpUnknownReason): PaperMvpUnknownPosition {
  return Object.freeze({ positionId, reason });
}

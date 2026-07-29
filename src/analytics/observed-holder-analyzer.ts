import {
  assertValidHolderDistribution,
  assertValidParticipantAnalyticsInput,
  compareParticipantTrades,
  HOLDER_CONCENTRATION_SCALE_BPS,
  PARTICIPANT_ANALYTICS_PAYLOAD_VERSION,
  type HolderDistribution,
  type ObservedWalletPosition,
  type ParticipantAnalyticsInput,
  type ParticipantQuoteFlow,
} from '../domain/participant-analytics.js';
import type { ChainCursor, QuoteAsset } from '../domain/types.js';

interface MutableQuoteFlow {
  readonly quoteAsset: QuoteAsset;
  boughtQuoteRaw: bigint;
  soldQuoteRaw: bigint;
}

interface MutableWalletPosition {
  readonly wallet: string;
  readonly isCreator: boolean;
  buyCount: number;
  sellCount: number;
  boughtBaseRaw: bigint;
  soldBaseRaw: bigint;
  readonly quoteFlows: Map<string, MutableQuoteFlow>;
  readonly firstObservedCursor: ChainCursor;
  lastObservedCursor: ChainCursor;
}

export class ObservedHolderAnalyzer {
  public analyze(input: ParticipantAnalyticsInput): HolderDistribution {
    assertValidParticipantAnalyticsInput(input);
    const positions = new Map<string, MutableWalletPosition>();
    const knownBuyers = new Set<string>();
    const externalBuyers = new Set<string>();
    let unknownTraderTradeCount = 0;

    for (const trade of [...input.trades].sort(compareParticipantTrades)) {
      if (trade.trader === null) {
        unknownTraderTradeCount += 1;
        continue;
      }
      if (trade.kind === 'BUY') {
        knownBuyers.add(trade.trader);
        if (trade.trader !== input.launch.creator) externalBuyers.add(trade.trader);
      }
      const position = positionFor(
        positions,
        trade.trader,
        trade.cursor,
        input.launch.creator,
      );
      const flow = quoteFlowFor(position.quoteFlows, trade.quoteAsset);
      if (trade.kind === 'BUY') {
        position.buyCount += 1;
        position.boughtBaseRaw += trade.baseAmountRaw;
        flow.boughtQuoteRaw += trade.quoteAmountRaw;
      } else {
        position.sellCount += 1;
        position.soldBaseRaw += trade.baseAmountRaw;
        flow.soldQuoteRaw += trade.quoteAmountRaw;
      }
      position.lastObservedCursor = snapshotCursor(trade.cursor);
    }

    const snapshots = [...positions.values()]
      .map(snapshotPosition)
      .sort(comparePositions);
    const positive = snapshots.filter((position) => position.observedNetBaseRaw > 0n);
    const totalPositiveNetBaseRaw = positive.reduce(
      (total, position) => total + position.observedNetBaseRaw,
      0n,
    );
    const creator = snapshots.find((position) => position.isCreator);
    const distribution: HolderDistribution = Object.freeze({
      mint: input.launch.mint,
      creator: input.launch.creator,
      payloadVersion: PARTICIPANT_ANALYTICS_PAYLOAD_VERSION,
      inputFingerprint: input.inputFingerprint,
      positions: Object.freeze(snapshots),
      totalPositiveNetBaseRaw,
      top1Bps: topBps(positive, 1, totalPositiveNetBaseRaw),
      top5Bps: topBps(positive, 5, totalPositiveNetBaseRaw),
      top10Bps: topBps(positive, 10, totalPositiveNetBaseRaw),
      creatorBps: shareBps(
        creator?.observedNetBaseRaw ?? 0n,
        totalPositiveNetBaseRaw,
      ),
      uniqueKnownBuyers: knownBuyers.size,
      uniqueExternalBuyers: externalBuyers.size,
      positivePositionCount: positive.length,
      unknownTraderTradeCount,
    });
    assertValidHolderDistribution(distribution);
    return distribution;
  }
}

function positionFor(
  positions: Map<string, MutableWalletPosition>,
  wallet: string,
  cursor: ChainCursor,
  creator: string,
): MutableWalletPosition {
  const existing = positions.get(wallet);
  if (existing !== undefined) return existing;
  const created: MutableWalletPosition = {
    wallet,
    isCreator: wallet === creator,
    buyCount: 0,
    sellCount: 0,
    boughtBaseRaw: 0n,
    soldBaseRaw: 0n,
    quoteFlows: new Map(),
    firstObservedCursor: snapshotCursor(cursor),
    lastObservedCursor: snapshotCursor(cursor),
  };
  positions.set(wallet, created);
  return created;
}

function quoteFlowFor(
  flows: Map<string, MutableQuoteFlow>,
  quoteAsset: QuoteAsset,
): MutableQuoteFlow {
  const key = `${quoteAsset.mint}\u001f${quoteAsset.decimals}\u001f${quoteAsset.tokenProgram}`;
  const existing = flows.get(key);
  if (existing !== undefined) return existing;
  const created: MutableQuoteFlow = {
    quoteAsset: snapshotQuoteAsset(quoteAsset),
    boughtQuoteRaw: 0n,
    soldQuoteRaw: 0n,
  };
  flows.set(key, created);
  return created;
}

function snapshotPosition(position: MutableWalletPosition): ObservedWalletPosition {
  return Object.freeze({
    wallet: position.wallet,
    isCreator: position.isCreator,
    buyCount: position.buyCount,
    sellCount: position.sellCount,
    boughtBaseRaw: position.boughtBaseRaw,
    soldBaseRaw: position.soldBaseRaw,
    observedNetBaseRaw: position.boughtBaseRaw - position.soldBaseRaw,
    quoteFlows: snapshotQuoteFlows(position.quoteFlows),
    firstObservedCursor: position.firstObservedCursor,
    lastObservedCursor: position.lastObservedCursor,
  });
}

function snapshotQuoteFlows(
  flows: ReadonlyMap<string, MutableQuoteFlow>,
): readonly ParticipantQuoteFlow[] {
  return Object.freeze(
    [...flows.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, flow]) => Object.freeze({
        quoteAsset: flow.quoteAsset,
        boughtQuoteRaw: flow.boughtQuoteRaw,
        soldQuoteRaw: flow.soldQuoteRaw,
      })),
  );
}

function comparePositions(
  left: ObservedWalletPosition,
  right: ObservedWalletPosition,
): number {
  if (left.observedNetBaseRaw > right.observedNetBaseRaw) return -1;
  if (left.observedNetBaseRaw < right.observedNetBaseRaw) return 1;
  return left.wallet.localeCompare(right.wallet);
}

function topBps(
  positions: readonly ObservedWalletPosition[],
  count: number,
  total: bigint,
): bigint {
  const amount = positions
    .slice(0, count)
    .reduce((sum, position) => sum + position.observedNetBaseRaw, 0n);
  return shareBps(amount, total);
}

function shareBps(amount: bigint, total: bigint): bigint {
  if (amount <= 0n || total === 0n) return 0n;
  return (amount * HOLDER_CONCENTRATION_SCALE_BPS) / total;
}

function snapshotCursor(cursor: ChainCursor): ChainCursor {
  return Object.freeze({
    slot: cursor.slot,
    transactionIndex: cursor.transactionIndex,
    instructionIndex: cursor.instructionIndex,
    innerInstructionIndex: cursor.innerInstructionIndex,
  });
}

function snapshotQuoteAsset(asset: QuoteAsset): QuoteAsset {
  return Object.freeze({
    mint: asset.mint,
    decimals: asset.decimals,
    tokenProgram: asset.tokenProgram,
  });
}

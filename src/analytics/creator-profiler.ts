import {
  assertValidCreatorProfile,
  assertValidParticipantAnalyticsInput,
  compareParticipantTrades,
  PARTICIPANT_ANALYTICS_PAYLOAD_VERSION,
  type CreatorFirstSell,
  type CreatorInitialBuy,
  type CreatorProfile,
  type ParticipantAnalyticsInput,
  type ParticipantAnalyticsTrade,
  type ParticipantQuoteFlow,
} from '../domain/participant-analytics.js';
import type { QuoteAsset } from '../domain/types.js';

interface MutableQuoteFlow {
  readonly quoteAsset: QuoteAsset;
  boughtQuoteRaw: bigint;
  soldQuoteRaw: bigint;
}

export class CreatorProfiler {
  public profile(input: ParticipantAnalyticsInput): CreatorProfile {
    assertValidParticipantAnalyticsInput(input);
    const trades = [...input.trades].sort(compareParticipantTrades);
    const quoteFlows = new Map<string, MutableQuoteFlow>();
    const externalBuyers = new Set<string>();
    const initialBuys: CreatorInitialBuy[] = [];
    let buyCount = 0;
    let sellCount = 0;
    let totalBoughtBaseRaw = 0n;
    let totalSoldBaseRaw = 0n;
    let firstSell: CreatorFirstSell | null = null;
    let unknownTraderTradeCount = 0;

    for (const trade of trades) {
      if (trade.trader === null) {
        unknownTraderTradeCount += 1;
      } else if (trade.kind === 'BUY' && trade.trader !== input.launch.creator) {
        externalBuyers.add(trade.trader);
      }
      if (trade.trader !== input.launch.creator) continue;

      const flow = quoteFlowFor(quoteFlows, trade.quoteAsset);
      if (trade.kind === 'BUY') {
        buyCount += 1;
        totalBoughtBaseRaw += trade.baseAmountRaw;
        flow.boughtQuoteRaw += trade.quoteAmountRaw;
        if (trade.signature === input.launch.signature) {
          initialBuys.push(snapshotTradeEvidence(trade));
        }
      } else {
        sellCount += 1;
        totalSoldBaseRaw += trade.baseAmountRaw;
        flow.soldQuoteRaw += trade.quoteAmountRaw;
        firstSell ??= snapshotTradeEvidence(trade);
      }
    }

    const profile: CreatorProfile = Object.freeze({
      mint: input.launch.mint,
      creator: input.launch.creator,
      payloadVersion: PARTICIPANT_ANALYTICS_PAYLOAD_VERSION,
      inputFingerprint: input.inputFingerprint,
      buyCount,
      sellCount,
      totalBoughtBaseRaw,
      totalSoldBaseRaw,
      observedNetBaseRaw: totalBoughtBaseRaw - totalSoldBaseRaw,
      hasSold: sellCount > 0,
      firstSell,
      initialBuys: Object.freeze(initialBuys),
      quoteFlows: snapshotQuoteFlows(quoteFlows),
      uniqueExternalBuyers: externalBuyers.size,
      unknownTraderTradeCount,
    });
    assertValidCreatorProfile(profile);
    return profile;
  }
}

function quoteFlowFor(
  flows: Map<string, MutableQuoteFlow>,
  quoteAsset: QuoteAsset,
): MutableQuoteFlow {
  const key = quoteAssetKey(quoteAsset);
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

function snapshotTradeEvidence(
  trade: ParticipantAnalyticsTrade,
): CreatorInitialBuy {
  return Object.freeze({
    eventId: trade.eventId,
    tradeId: trade.tradeId,
    signature: trade.signature,
    cursor: snapshotCursor(trade),
    baseAmountRaw: trade.baseAmountRaw,
    quoteAmountRaw: trade.quoteAmountRaw,
    quoteAsset: snapshotQuoteAsset(trade.quoteAsset),
  });
}

function snapshotCursor(
  trade: ParticipantAnalyticsTrade,
): ParticipantAnalyticsTrade['cursor'] {
  return Object.freeze({
    slot: trade.cursor.slot,
    transactionIndex: trade.cursor.transactionIndex,
    instructionIndex: trade.cursor.instructionIndex,
    innerInstructionIndex: trade.cursor.innerInstructionIndex,
  });
}

function snapshotQuoteAsset(asset: QuoteAsset): QuoteAsset {
  return Object.freeze({
    mint: asset.mint,
    decimals: asset.decimals,
    tokenProgram: asset.tokenProgram,
  });
}

function quoteAssetKey(asset: QuoteAsset): string {
  return `${asset.mint}\u001f${asset.decimals}\u001f${asset.tokenProgram}`;
}

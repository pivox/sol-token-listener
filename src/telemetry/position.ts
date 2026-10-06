import { evaluateQuoteAtDecision } from './causal-quote.js';

/** Measurement only. No execution ports, timers, network clients or strategy dependencies. */
export const SNAPSHOT_SECONDS = [5, 10, 20, 30, 60, 120, 300] as const;
export interface PositionEvidence {
  runId: string; positionId: string; mint: string; buySignature: string;
  wallet: string; quoteMint: string; entryAtMs: number; entrySlot: string | null;
  amountInRaw: string | null; buyNetworkFeeRaw: string | null;
  economicCostRaw: string | null; tokenAmountRaw: string | null; costAvailableAtMs?: number | null;
  sellNetworkFeeEstimateRaw: string | null; solUsdt: string | null;
  exit: { atMs: number; signature: string | null; reason: string; realizedNetPnlRaw: string | null } | null;
}
export interface TradeEvidence {
  id: string; signature: string; wallet: string | null; side: 'BUY' | 'SELL';
  quoteAmountRaw: string; quoteMint: string; slot: string; observedAtMs: number;
  confirmation: 'processed' | 'confirmed' | 'finalized' | 'orphaned';
}
export interface AvailableQuote {
  status: 'AVAILABLE'; venue: string; observedAtMs: number; observedSlot: string | null;
  stateReceivedAtMs: number | null; stateSlot: string | null; quoteCalculatedAtMs: number | null;
  validity: 'VALID' | 'INVALID' | 'UNKNOWN'; freshnessMs: number | null; freshnessLimitMs: number | null;
  invalidReason: string | null; feeTreatment: 'INCLUDED_IN_MIN_OUT' | 'SEPARATE' | 'UNKNOWN'; netPnlEstimateRaw: string | null;
  amountInRaw: string; amountOutRaw: string; minimumAmountOutRaw: string;
  feesRaw: string | null; slippageBps: string | null; priceImpactBps: string | null;
  metadataUnavailable: string[];
}
export interface UnavailableQuote { status: 'UNAVAILABLE'; reason: string }
export type QuoteEvidence = AvailableQuote | UnavailableQuote;
export interface Observation {
  id: string; atMs: number; kind: 'market' | 'quote';
  creator: string | null; coverage: 'OBSERVED' | 'UNAVAILABLE';
  trades: TradeEvidence[];
  clusters: { id: string; wallets: string[]; sharedFunder: boolean }[];
  relationships: { left: string; right: string; confidence: string }[];
  graphAvailable: boolean; graphCoverage: Record<string, unknown> | null;
  quote: QuoteEvidence | null;
}
export interface Activity {
  buyCount: number; sellCount: number; uniqueBuyers: number; unknownTraderCount: number;
  buyVolumeQuoteRaw: string; sellVolumeQuoteRaw: string; netQuoteFlowRaw: string;
  buySellRatioBps: string; averageBuyPerBuyerRaw: string | null;
  buyerWallets: string[]; ambiguousSameSlotTrades: number;
}
export interface Snapshot {
  schema: 'position_telemetry.v1'; kind: 'snapshot'; runId: string; positionId: string;
  mint: string; buySignature: string; snapshotId: string; atMs: number; elapsedMs: number;
  observedSlot: string | null; quote: QuoteEvidence;
  activity: Activity | null; activityStatus: string; activityObservedAtMs: number | null;
  clusters: { buyersInClusters: number; clusterCount: number; largestBuyerCluster: number;
    sharedFunderCluster: boolean; strongRelationsPresent: boolean;
    strongRelationshipCount: number; evidence: Observation['clusters'];
    relationships: Observation['relationships']; coverage: Observation['graphCoverage'] } | null;
  creator: { creatorBuyCount: number; creatorSellCount: number; creatorBuyVolumeRaw: string;
    creatorSellVolumeRaw: string; creatorNetFlowRaw: string;
    firstCreatorSellAtMs: number | null; timeToFirstCreatorSellMs: number | null } | null;
  momentum: { buyVolumeDeltaRaw: string; sellVolumeDeltaRaw: string; netFlowDeltaRaw: string;
    uniqueBuyersDelta: number; newBuyersSincePrevious: number } | null;
  grossPnlRaw: string | null; netExecutablePnlRaw: string | null;
  observedMfeRaw: string | null; observedMaeRaw: string | null;
  mfeObservedAtMs: number | null; maeObservedAtMs: number | null;
  timeToMfeMs: number | null; timeToMaeMs: number | null;
  quotePopulation: number;
}

const unavailable = (reason: string): UnavailableQuote => ({ status: 'UNAVAILABLE', reason });
function net(entry: PositionEvidence, quote: AvailableQuote): bigint | null {
  return quote.validity !== 'VALID' || quote.stateReceivedAtMs === null || quote.stateSlot === null || quote.quoteCalculatedAtMs === null
    || quote.freshnessMs === null || quote.freshnessLimitMs === null || quote.freshnessMs > quote.freshnessLimitMs
    || quote.feeTreatment === 'UNKNOWN' || entry.sellNetworkFeeEstimateRaw === null
    || !/^\d+$/.test(entry.sellNetworkFeeEstimateRaw)
    || (quote.feeTreatment === 'SEPARATE' && (quote.feesRaw === null || !/^\d+$/.test(quote.feesRaw)))
    || entry.economicCostRaw === null || entry.costAvailableAtMs === null || (entry.costAvailableAtMs !== undefined && quote.quoteCalculatedAtMs < entry.costAvailableAtMs) ? null
    : BigInt(quote.minimumAmountOutRaw) - BigInt(entry.economicCostRaw) - BigInt(entry.sellNetworkFeeEstimateRaw)
      - (quote.feeTreatment === 'SEPARATE' ? BigInt(quote.feesRaw as string) : 0n);
}

function extrema(entry: PositionEvidence, rows: readonly Observation[], atMs: number): Pick<Snapshot,
'observedMfeRaw' | 'observedMaeRaw' | 'mfeObservedAtMs' | 'maeObservedAtMs' | 'timeToMfeMs' | 'timeToMaeMs' | 'quotePopulation'> {
  let best: bigint | null = null; let worst: bigint | null = null;
  let bestAt: number | null = null; let worstAt: number | null = null; let count = 0;
  for (const row of rows) {
    if (row.atMs > atMs || row.atMs < entry.entryAtMs || (entry.exit !== null && row.atMs > entry.exit.atMs)) continue;
    const q = row.quote;
    if (q?.status !== 'AVAILABLE' || q.observedAtMs > row.atMs || q.observedAtMs < entry.entryAtMs
      || !evaluateQuoteAtDecision({ decisionAtMs: row.atMs, stateReceivedAtMs: q.stateReceivedAtMs, stateSlot: q.stateSlot,
        quoteCalculatedAtMs: q.quoteCalculatedAtMs, maxAgeMs: q.freshnessLimitMs ?? 0, validity: q.validity }).evaluable) continue;
    const value = net(entry, q);
    if (value === null) continue;
    count++;
    if (best === null || value > best) { best = value; bestAt = q.observedAtMs; }
    if (worst === null || value < worst) { worst = value; worstAt = q.observedAtMs; }
  }
  return { observedMfeRaw: best?.toString() ?? null, observedMaeRaw: worst?.toString() ?? null,
    mfeObservedAtMs: bestAt, maeObservedAtMs: worstAt,
    timeToMfeMs: bestAt === null ? null : bestAt - entry.entryAtMs,
    timeToMaeMs: worstAt === null ? null : worstAt - entry.entryAtMs, quotePopulation: count };
}

export function snapshotPosition(entry: PositionEvidence, observations: readonly Observation[], atMs: number, previous?: Snapshot): Snapshot {
  const rows = [...new Map(observations.filter(x => x.atMs <= atMs).map(x => [x.id, x])).values()]
    .sort((a,b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
  const closed = entry.exit !== null && entry.exit.atMs < atMs;
  const activityRows = rows.filter(x => x.kind === 'market' && x.atMs >= entry.entryAtMs && (!entry.exit || x.atMs <= entry.exit.atMs));
  const last = activityRows.at(-1);
  const revisions = new Map<string, TradeEvidence>();
  for (const row of activityRows) for (const trade of row.trades) revisions.set(trade.id, trade);
  const eligible = [...revisions.values()].filter(t => t.confirmation === 'finalized' && t.signature !== entry.buySignature
    && t.wallet !== entry.wallet && t.quoteMint === entry.quoteMint && t.observedAtMs <= atMs && t.observedAtMs >= entry.entryAtMs);
  const trades = eligible.filter(t => BigInt(t.slot) > BigInt(entry.entrySlot ?? '0'));
  let activity: Activity | null = null;
  let creator: Snapshot['creator'] = null;
  let clusters: Snapshot['clusters'] = null;
  // Zero means observed zero, never absence of a source.
  if (last?.coverage === 'OBSERVED' && entry.entrySlot !== null) {
    const buys = trades.filter(t => t.side === 'BUY'); const sells = trades.filter(t => t.side === 'SELL');
    const buyers = [...new Set(buys.flatMap(t => t.wallet === null ? [] : [t.wallet]))].sort();
    const volume = (items: TradeEvidence[]): bigint => items.reduce((sum,t) => sum + BigInt(t.quoteAmountRaw), 0n);
    const buy = volume(buys); const sell = volume(sells);
    activity = { buyCount: buys.length, sellCount: sells.length, uniqueBuyers: buyers.length,
      unknownTraderCount: trades.filter(t => t.wallet === null).length,
      buyVolumeQuoteRaw: String(buy), sellVolumeQuoteRaw: String(sell), netQuoteFlowRaw: String(buy-sell),
      buySellRatioBps: sells.length === 0 ? 'NO_SELL' : String(BigInt(buys.length)*10000n/BigInt(sells.length)),
      averageBuyPerBuyerRaw: buyers.length === 0 || buys.some(t => t.wallet === null) ? null : String(buy/BigInt(buyers.length)),
      buyerWallets: buyers, ambiguousSameSlotTrades: eligible.filter(t => t.slot === entry.entrySlot).length };
    if (last.creator !== null) {
      const cb = buys.filter(t => t.wallet === last.creator); const cs = sells.filter(t => t.wallet === last.creator);
      const first = cs.length === 0 ? null : Math.min(...cs.map(t => t.observedAtMs));
      creator = { creatorBuyCount: cb.length, creatorSellCount: cs.length, creatorBuyVolumeRaw: String(volume(cb)),
        creatorSellVolumeRaw: String(volume(cs)), creatorNetFlowRaw: String(volume(cb)-volume(cs)),
        firstCreatorSellAtMs: first, timeToFirstCreatorSellMs: first === null ? null : first-entry.entryAtMs };
    }
    if (last.graphAvailable) {
      const involved = last.clusters.filter(c => c.wallets.some(w => buyers.includes(w)));
      const linked = new Set(involved.flatMap(c => c.wallets.filter(w => buyers.includes(w))));
      const strong = last.relationships.filter(r => r.confidence === 'STRONG' && buyers.includes(r.left) && buyers.includes(r.right));
      clusters = { buyersInClusters: linked.size, clusterCount: involved.length,
        largestBuyerCluster: involved.reduce((n,c) => Math.max(n,c.wallets.filter(w => buyers.includes(w)).length),0),
        sharedFunderCluster: involved.some(c => c.sharedFunder), strongRelationsPresent: strong.length > 0,
        strongRelationshipCount: strong.length, evidence: involved, relationships: last.relationships.filter(r => buyers.includes(r.left) && buyers.includes(r.right)), coverage: last.graphCoverage };
    }
  }
  const qrow = rows.filter(x => x.quote !== null && x.atMs >= entry.entryAtMs).at(-1);
  const futureQuoteExists = observations.some(x => x.atMs > atMs && x.quote !== null);
  let quote: QuoteEvidence = qrow?.quote ?? unavailable(futureQuoteExists ? 'FUTURE_OBSERVATION' : 'NO_CAUSAL_QUOTE');
  if (closed) quote = unavailable('POSITION_CLOSED');
  else if (quote.status === 'AVAILABLE') {
    if (quote.validity !== 'VALID') quote = unavailable(quote.invalidReason ?? 'INVALID_QUOTE');
    else if (quote.observedAtMs > atMs || quote.observedAtMs < entry.entryAtMs) quote = unavailable('NON_CAUSAL_QUOTE');
    else {
      const timing = evaluateQuoteAtDecision({ decisionAtMs: atMs, stateReceivedAtMs: quote.stateReceivedAtMs, stateSlot: quote.stateSlot,
        quoteCalculatedAtMs: quote.quoteCalculatedAtMs, maxAgeMs: quote.freshnessLimitMs ?? 0, validity: quote.validity });
      if (!timing.evaluable) quote = unavailable(timing.reason);
      else if (quote.freshnessMs === null || quote.freshnessLimitMs === null || quote.freshnessMs > quote.freshnessLimitMs) quote = unavailable('STALE_STATE');
    }
  }
  const old = previous?.activity;
  const momentum = activity !== null && old != null ? {
    buyVolumeDeltaRaw: String(BigInt(activity.buyVolumeQuoteRaw)-BigInt(old.buyVolumeQuoteRaw)),
    sellVolumeDeltaRaw: String(BigInt(activity.sellVolumeQuoteRaw)-BigInt(old.sellVolumeQuoteRaw)),
    netFlowDeltaRaw: String(BigInt(activity.netQuoteFlowRaw)-BigInt(old.netQuoteFlowRaw)),
    uniqueBuyersDelta: activity.uniqueBuyers-old.uniqueBuyers,
    newBuyersSincePrevious: activity.buyerWallets.filter(w => !old.buyerWallets.includes(w)).length } : null;
  return { schema: 'position_telemetry.v1', kind: 'snapshot', runId: entry.runId, positionId: entry.positionId,
    mint: entry.mint, buySignature: entry.buySignature, snapshotId: `${entry.positionId}:${String(atMs-entry.entryAtMs)}`,
    atMs, elapsedMs: atMs-entry.entryAtMs, observedSlot: quote.status === 'AVAILABLE' ? quote.observedSlot : null,
    quote, activity: closed ? null : activity, activityStatus: closed ? 'POSITION_CLOSED' : last?.coverage ?? 'UNAVAILABLE',
    activityObservedAtMs: last?.atMs ?? null, creator: closed ? null : creator, clusters: closed ? null : clusters,
    momentum: closed ? null : momentum,
    grossPnlRaw: quote.status === 'AVAILABLE' && entry.amountInRaw !== null && entry.costAvailableAtMs !== null && (entry.costAvailableAtMs === undefined || entry.costAvailableAtMs <= atMs) ? String(BigInt(quote.amountOutRaw)-BigInt(entry.amountInRaw)) : null,
    netExecutablePnlRaw: quote.status === 'AVAILABLE' ? net(entry,quote)?.toString() ?? null : null,
    ...extrema(entry,rows,atMs) };
}

export function summarizePosition(entry: PositionEvidence, observations: readonly Observation[]): {
  schema: 'position_telemetry.v1'; kind: 'terminal'; entry: PositionEvidence; exit: PositionEvidence['exit'];
  exitReason: string | null; realizedNetPnlRaw: string | null; durationMs: number | null;
  final: Snapshot; observedMfeRaw: string | null; observedMaeRaw: string | null;
} {
  const final = snapshotPosition(entry, observations, entry.exit?.atMs ?? entry.entryAtMs);
  return { schema: 'position_telemetry.v1', kind: 'terminal', entry, exit: entry.exit,
    exitReason: entry.exit?.reason ?? null, realizedNetPnlRaw: entry.exit?.realizedNetPnlRaw ?? null,
    durationMs: entry.exit === null ? null : entry.exit.atMs-entry.entryAtMs, final,
    observedMfeRaw: final.observedMfeRaw, observedMaeRaw: final.observedMaeRaw };
}

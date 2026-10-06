import { identity } from './journal.js';
import type { Observation, PositionEvidence, QuoteEvidence } from './position.js';
export type RunnerRow = Record<string, unknown>;
export interface NormalizedPosition { entry: PositionEvidence; observations: Observation[] }
const raw = (v: unknown): string | null => typeof v === 'string' && /^\d+$/.test(v) ? v
  : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
const text = (v: unknown): string | null => typeof v === 'string' ? v : null;
const time = (r: RunnerRow): number => Date.parse(text(r.at) ?? '');
const SOL = 'So11111111111111111111111111111111111111112';

/** Whitelist fields: raw runner errors, URLs, stack traces and credentials never enter telemetry. */
export function normalizeRunner(runId: string, rows: readonly RunnerRow[]): NormalizedPosition[] {
  const result: NormalizedPosition[] = [];
  let preflight: RunnerRow | undefined; let current: NormalizedPosition | undefined;
  let buy: RunnerRow | undefined; let reason = 'UNKNOWN'; let rent: string | null = null;
  let sell: RunnerRow | undefined;
  for (const row of rows) {
    if (!Number.isSafeInteger(time(row))) continue;
    if (row.event === 'preflight') { preflight = row; current = undefined; buy = undefined; sell = undefined; rent = null; reason = 'UNKNOWN'; }
    if (row.event === 'buy_confirmed' && preflight) {
      buy = row;
      const signature=text(buy.signature); const mint=text(preflight.mint); const wallet=text(preflight.wallet);
      if (signature && mint && wallet) {
        current={entry:{runId,positionId:identity([runId,mint,signature]),mint,buySignature:signature,wallet,quoteMint:SOL,
          entryAtMs:time(buy),entrySlot:raw(buy.slot),tokenAmountRaw:null,amountInRaw:null,
          buyNetworkFeeRaw:raw(buy.feeLamports),economicCostRaw:null,costAvailableAtMs:null,
          sellNetworkFeeEstimateRaw:raw(preflight.sellNetworkFeeReserveLamports) ?? '50000',
          solUsdt:typeof preflight.krakenSolUsdt==='number'&&Number.isFinite(preflight.krakenSolUsdt)?String(preflight.krakenSolUsdt):null,exit:null},observations:[]};
        result.push(current);
      }
    }
    if (row.event === 'sell_started') reason = text(row.reason) ?? 'UNKNOWN';
    if (row.event === 'sell_confirmed') sell = row;
    if (row.event === 'position_open' && buy && current) {
      const cost=raw(row.buyEconomicCostLamports); const fee=raw(buy.feeLamports);
      current.entry.tokenAmountRaw=raw(row.tokenRaw);
      current.entry.entrySlot=raw(row.slot) ?? current.entry.entrySlot;
      current.entry.economicCostRaw=cost; current.entry.costAvailableAtMs=time(row);
      current.entry.amountInRaw=cost!==null&&fee!==null&&BigInt(cost)>=BigInt(fee)?String(BigInt(cost)-BigInt(fee)):null;
      rent=raw(row.tokenAccountRentLamports);
    }
    if (!current) continue;
    if (row.event === 'price_progress' || row.event === 'sell_quote') {
      const expected = raw(row.expectedSellQuoteLamports ?? row.expectedLamports);
      const required = raw(row.requiredSellQuoteLamports);
      const minimum = raw(row.minimumLamports) ?? (expected === null ? null
        : required !== null && BigInt(expected) >= BigInt(required) ? required : String(BigInt(expected)*90n/100n));
      const tokenAmount=raw(row.tokenRaw) ?? current.entry.tokenAmountRaw;
      const quote: QuoteEvidence = expected !== null && minimum !== null && tokenAmount !== null ? {
        status: 'AVAILABLE', venue: 'PUMP_FUN_BONDING_CURVE', observedAtMs: time(row), observedSlot: null,
        stateReceivedAtMs: null, stateSlot: null, quoteCalculatedAtMs: null, validity: 'UNKNOWN', freshnessMs: null,
        freshnessLimitMs: 10000, invalidReason: 'HISTORICAL_TIMING_NOT_CAPTURED', feeTreatment: 'UNKNOWN',
        netPnlEstimateRaw: raw(row.expectedNetProfitLamports),
        amountInRaw: tokenAmount,
        amountOutRaw: expected, minimumAmountOutRaw: minimum, feesRaw: null,
        slippageBps: row.event === 'price_progress' && (required === null || BigInt(expected) < BigInt(required)) ? '1000' : null,
        priceImpactBps: null, metadataUnavailable: ['OBSERVED_SLOT_NOT_PERSISTED','FEE_BREAKDOWN_NOT_PERSISTED','PRICE_IMPACT_NOT_PERSISTED', ...(row.event === 'sell_quote' || (required !== null && BigInt(expected) >= BigInt(required)) ? ['ABSOLUTE_MINIMUM_NOT_BPS'] : [])],
      } : { status: 'UNAVAILABLE', reason: 'RUNNER_QUOTE_INCOMPLETE' };
      current.observations.push({ id: identity([current.entry.positionId,row.event,time(row),quote]), atMs:time(row), kind:'quote',
        creator:null,coverage:'UNAVAILABLE',trades:[],clusters:[],relationships:[],graphAvailable:false,graphCoverage:null,quote });
    }
    if (row.event === 'sell_result' && row.remainingTokenRaw === '0' && sell) {
      current.entry.exit = { atMs: time(sell), signature: text(sell.signature), reason, realizedNetPnlRaw: null };
    }
    if ((row.event === 'complete' || row.event === 'recovery_complete') && current.entry.exit && preflight) {
      const final = raw(row.finalWalletLamports ?? row.walletLamports); const initial = raw(preflight.initialWalletLamports);
      current.entry.exit.realizedNetPnlRaw = final !== null && initial !== null && rent !== null ? String(BigInt(final)-BigInt(initial)+BigInt(rent)) : null;
    }
  }
  return [...new Map(result.map(x => [x.entry.positionId,x])).values()];
}

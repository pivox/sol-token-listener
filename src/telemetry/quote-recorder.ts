import type { AvailableQuote, PositionEvidence, QuoteEvidence } from './position.js';
import { evaluateQuoteAtDecision } from './causal-quote.js';

export interface QuoteCaptureInput {
  position: PositionEvidence; stateReceivedAtMs: number | null; stateSlot: string | null;
  quoteCalculatedAtMs: number | null; observedAtMs: number;
  amountOutRaw: string; minimumAmountOutRaw: string; feesRaw: string | null;
  feeTreatment: AvailableQuote['feeTreatment']; maxAgeMs: number;
  amountInRaw?: string | null; validity?: AvailableQuote['validity']; invalidReason?: string | null;
  slippageBps?: string | null; priceImpactBps?: string | null; venue?: string;
}

const unsigned = (value: string): boolean => /^\d+$/.test(value);
function netEstimate(input: QuoteCaptureInput, amountInRaw: string | null, validity: AvailableQuote['validity']): string | null {
  if (validity !== 'VALID' || input.position.economicCostRaw === null
    || input.position.sellNetworkFeeEstimateRaw === null
    || !unsigned(input.position.economicCostRaw) || !unsigned(input.position.sellNetworkFeeEstimateRaw)
    || input.feeTreatment === 'UNKNOWN') return null;
  if (input.feeTreatment === 'SEPARATE' && (input.feesRaw === null || !unsigned(input.feesRaw))) return null;
  if (!unsigned(input.minimumAmountOutRaw) || amountInRaw === null || !unsigned(amountInRaw)) return null;
  const separateFees = input.feeTreatment === 'SEPARATE' ? BigInt(input.feesRaw ?? '0') : 0n;
  return String(BigInt(input.minimumAmountOutRaw) - BigInt(input.position.economicCostRaw)
    - BigInt(input.position.sellNetworkFeeEstimateRaw) - separateFees);
}
export function captureQuoteEvidence(input: QuoteCaptureInput): AvailableQuote {
  const amountInRaw = input.amountInRaw ?? input.position.tokenAmountRaw;
  let validity: AvailableQuote['validity'] = input.validity ?? 'VALID';
  let invalidReason = input.invalidReason ?? null;
  if (input.stateReceivedAtMs === null || input.stateSlot === null || input.quoteCalculatedAtMs === null) {
    validity = 'UNKNOWN'; invalidReason ??= 'MISSING_STATE_TIMING_OR_SLOT';
  } else if (input.quoteCalculatedAtMs < input.stateReceivedAtMs || input.observedAtMs < input.quoteCalculatedAtMs) {
    validity = 'INVALID'; invalidReason ??= 'CLOCK_ORDER_INVALID';
  } else if (input.observedAtMs - input.stateReceivedAtMs > input.maxAgeMs) {
    validity = 'INVALID'; invalidReason ??= 'STALE_STATE';
  }
  if (!unsigned(input.amountOutRaw) || !unsigned(input.minimumAmountOutRaw) || amountInRaw === null || !unsigned(amountInRaw)) {
    validity = 'INVALID'; invalidReason ??= 'INVALID_AMOUNT';
  }
  const netPnlEstimateRaw = netEstimate(input, amountInRaw, validity);
  const metadataUnavailable: string[] = [];
  if (input.feeTreatment === 'UNKNOWN') metadataUnavailable.push('FEE_TREATMENT_UNKNOWN');
  if (input.feeTreatment === 'SEPARATE' && (input.feesRaw === null || !unsigned(input.feesRaw))) metadataUnavailable.push('SEPARATE_FEE_AMOUNT_MISSING_OR_INVALID');
  return { status: 'AVAILABLE', venue: input.venue ?? 'UNKNOWN', observedAtMs: input.observedAtMs, observedSlot: input.stateSlot,
    stateReceivedAtMs: input.stateReceivedAtMs, stateSlot: input.stateSlot, quoteCalculatedAtMs: input.quoteCalculatedAtMs,
    validity, freshnessMs: input.stateReceivedAtMs === null ? null : input.observedAtMs - input.stateReceivedAtMs,
    freshnessLimitMs: input.maxAgeMs, invalidReason, feeTreatment: input.feeTreatment, netPnlEstimateRaw,
    amountInRaw: amountInRaw ?? '', amountOutRaw: input.amountOutRaw, minimumAmountOutRaw: input.minimumAmountOutRaw,
    feesRaw: input.feesRaw, slippageBps: input.slippageBps ?? null, priceImpactBps: input.priceImpactBps ?? null,
    metadataUnavailable };
}

export interface QuoteObservationRow extends Record<string, unknown> { id: string; schema: 'quote_observation.v1' }
export interface QuoteRecorderOptions {
  enabled?: boolean;
  maxPending?: number;
  append(row: QuoteObservationRow): Promise<unknown>;
  onDiagnostic?: (event: 'WRITE_ERROR' | 'DROPPED', health: { enabled: boolean; pending: number; writeErrors: number; dropped: number }) => void;
}

export function buildQuoteObservationRow(id: string, position: PositionEvidence, quote: AvailableQuote): QuoteObservationRow {
  return { id, schema: 'quote_observation.v1', sessionId: position.runId, positionId: position.positionId,
    mint: position.mint, buySignature: position.buySignature, tokenAmountRaw: quote.amountInRaw,
    receivedAtMs: quote.observedAtMs, stateReceivedAtMs: quote.stateReceivedAtMs, stateSlot: quote.stateSlot,
    quoteCalculatedAtMs: quote.quoteCalculatedAtMs, liquidationAmountOutRaw: quote.amountOutRaw,
    minimumAmountOutRaw: quote.minimumAmountOutRaw, feesRaw: quote.feesRaw, feeTreatment: quote.feeTreatment,
    netPnlEstimateRaw: quote.netPnlEstimateRaw, validity: quote.validity, freshnessMs: quote.freshnessMs,
    freshnessLimitMs: quote.freshnessLimitMs, invalidReason: quote.invalidReason, quote };
}

export interface RuntimeQuoteObservationContext {
  readonly sessionId: string;
  readonly positionId: string;
  readonly buyTradeId: string;
  readonly signalAtMs: number;
  readonly economicCostRaw: string | null;
  readonly sellNetworkFeeEstimateRaw: string | null;
}

export function buildRuntimeQuoteObservationRow(input: {
  readonly id: string;
  readonly mint: string;
  readonly quoteMint: string;
  readonly context: RuntimeQuoteObservationContext;
  readonly amountInRaw: string;
  readonly amountOutRaw: string;
  readonly minimumAmountOutRaw: string;
  readonly feesRaw: string;
  readonly slippageBps: string;
  readonly priceImpactBps: string;
  readonly stateReceivedAtMs: number | null;
  readonly stateSlot: string | null;
  readonly quoteCalculatedAtMs: number;
  readonly availableAtMs: number;
  readonly maxAgeMs: number;
}): QuoteObservationRow {
  const position: PositionEvidence = {
    runId: input.context.sessionId,
    positionId: input.context.positionId,
    mint: input.mint,
    buySignature: input.context.buyTradeId,
    wallet: 'PAPER_SIMULATION',
    quoteMint: input.quoteMint,
    entryAtMs: input.context.signalAtMs,
    entrySlot: null,
    amountInRaw: null,
    buyNetworkFeeRaw: null,
    economicCostRaw: input.context.economicCostRaw,
    tokenAmountRaw: input.amountInRaw,
    sellNetworkFeeEstimateRaw: input.context.sellNetworkFeeEstimateRaw,
    solUsdt: null,
    exit: null,
  };
  const quote = captureQuoteEvidence({
    position,
    stateReceivedAtMs: input.stateReceivedAtMs,
    stateSlot: input.stateSlot,
    quoteCalculatedAtMs: input.quoteCalculatedAtMs,
    observedAtMs: input.availableAtMs,
    amountInRaw: input.amountInRaw,
    amountOutRaw: input.amountOutRaw,
    minimumAmountOutRaw: input.minimumAmountOutRaw,
    feesRaw: input.feesRaw,
    feeTreatment: 'INCLUDED_IN_MIN_OUT',
    maxAgeMs: input.maxAgeMs,
    slippageBps: input.slippageBps,
    priceImpactBps: input.priceImpactBps,
    venue: 'CANONICAL_RUNTIME_SELL',
  });
  const netPnlUnknownReasons: string[] = [];
  if (input.context.economicCostRaw === null) netPnlUnknownReasons.push('ECONOMIC_COST_UNKNOWN');
  if (input.context.sellNetworkFeeEstimateRaw === null) netPnlUnknownReasons.push('SELL_NETWORK_FEE_UNKNOWN');
  if (quote.netPnlEstimateRaw === null && input.context.economicCostRaw !== null
    && input.context.sellNetworkFeeEstimateRaw !== null) netPnlUnknownReasons.push(...quote.metadataUnavailable);
  return {
    ...buildQuoteObservationRow(input.id, position, quote),
    buyTradeId: input.context.buyTradeId,
    kind: 'quote',
    signalAtMs: input.context.signalAtMs,
    availableAtMs: input.availableAtMs,
    economicCostRaw: input.context.economicCostRaw,
    sellNetworkFeeEstimateRaw: input.context.sellNetworkFeeEstimateRaw,
    netPnlUnknownReasons,
    causalStatus: 'AWAITING_DECISION_EVENT',
    amountOutRaw: input.amountOutRaw,
  };
}

export function buildRuntimeDecisionObservationRow(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly positionId: string;
  readonly buyTradeId: string;
  readonly quoteId: string;
  readonly signalAtMs: number;
  readonly availableAtMs: number;
  readonly decisionAtMs: number;
  readonly stateReceivedAtMs: number | null;
  readonly stateSlot: string | null;
  readonly quoteCalculatedAtMs: number | null;
  readonly maxAgeMs: number;
  readonly validity: AvailableQuote['validity'];
}): QuoteObservationRow {
  const timing = evaluateQuoteAtDecision({
    decisionAtMs: input.decisionAtMs,
    stateReceivedAtMs: input.stateReceivedAtMs,
    stateSlot: input.stateSlot,
    quoteCalculatedAtMs: input.quoteCalculatedAtMs,
    maxAgeMs: input.maxAgeMs,
    validity: input.validity,
  });
  const availableAtDecision = timing.evaluable && input.availableAtMs <= input.decisionAtMs;
  const causalStatus = input.availableAtMs > input.decisionAtMs
    ? 'QUOTE_AVAILABLE_AFTER_DECISION'
    : availableAtDecision ? 'AVAILABLE_BEFORE_DECISION' : timing.reason;
  return {
    id: input.id,
    schema: 'quote_observation.v1',
    kind: 'decision',
    sessionId: input.sessionId,
    positionId: input.positionId,
    buyTradeId: input.buyTradeId,
    quoteId: input.quoteId,
    signalAtMs: input.signalAtMs,
    availableAtMs: input.availableAtMs,
    decisionAtMs: input.decisionAtMs,
    availableAtDecision,
    causalStatus,
  };
}

/** Separate-sidecar sink: record() never awaits storage and storage errors never enter the trading path. */
export class QuoteObservationRecorder {
  private readonly enabled: boolean;
  private readonly maxPending: number;
  private pending = 0;
  private writeErrors = 0;
  private dropped = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly options: QuoteRecorderOptions) {
    this.enabled = options.enabled === true;
    const maxPending = options.maxPending ?? 0;
    this.maxPending = Number.isSafeInteger(maxPending) && maxPending > 0 ? maxPending : 100;
  }
  public record(row: QuoteObservationRow): void {
    if (!this.enabled) return;
    if (this.pending >= this.maxPending) {
      this.dropped++;
      this.diagnose('DROPPED');
      return;
    }
    this.pending++;
    this.chain = this.chain.then(async () => { await this.options.append(row); })
      .catch(() => { this.writeErrors++; this.diagnose('WRITE_ERROR'); }).finally(() => { this.pending--; });
  }
  public async flush(): Promise<void> { await this.chain; }
  public health(): { enabled: boolean; pending: number; writeErrors: number; dropped: number } {
    return { enabled: this.enabled, pending: this.pending, writeErrors: this.writeErrors, dropped: this.dropped };
  }
  private diagnose(event: 'WRITE_ERROR' | 'DROPPED'): void {
    try { this.options.onDiagnostic?.(event, this.health()); } catch { /* diagnostics cannot affect quoting */ }
  }
}

export function quoteEvidenceOrUnavailable(quote: QuoteEvidence, atMs: number): QuoteEvidence {
  if (quote.status !== 'AVAILABLE') return quote;
  if (quote.observedAtMs > atMs) return { status: 'UNAVAILABLE', reason: 'FUTURE_OBSERVATION' };
  if (quote.validity !== 'VALID') return { status: 'UNAVAILABLE', reason: quote.invalidReason ?? 'INVALID_QUOTE' };
  return quote;
}

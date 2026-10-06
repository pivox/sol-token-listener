export interface CausalQuoteTiming {
  decisionAtMs: number;
  stateReceivedAtMs: number | null;
  stateSlot: string | null;
  quoteCalculatedAtMs: number | null;
  maxAgeMs: number;
  validity: 'VALID' | 'INVALID' | 'UNKNOWN';
}

export type CausalQuoteResult = { evaluable: true; reason: 'AVAILABLE_AT_DECISION' }
  | { evaluable: false; reason: 'MISSING_TIMING' | 'MISSING_SLOT' | 'INVALID_QUOTE' | 'FUTURE_STATE' | 'FUTURE_QUOTE' | 'CLOCK_ORDER_INVALID' | 'STALE_STATE' };

/** A quote is decision-usable only when its state and calculation were both available by T. */
export function evaluateQuoteAtDecision(value: CausalQuoteTiming): CausalQuoteResult {
  if (!Number.isFinite(value.decisionAtMs) || value.stateReceivedAtMs === null || value.quoteCalculatedAtMs === null) return { evaluable: false, reason: 'MISSING_TIMING' };
  if (value.stateSlot === null || !/^\d+$/.test(value.stateSlot)) return { evaluable: false, reason: 'MISSING_SLOT' };
  if (value.validity !== 'VALID') return { evaluable: false, reason: 'INVALID_QUOTE' };
  if (value.stateReceivedAtMs > value.decisionAtMs) return { evaluable: false, reason: 'FUTURE_STATE' };
  if (value.quoteCalculatedAtMs > value.decisionAtMs) return { evaluable: false, reason: 'FUTURE_QUOTE' };
  if (value.quoteCalculatedAtMs < value.stateReceivedAtMs) return { evaluable: false, reason: 'CLOCK_ORDER_INVALID' };
  if (value.decisionAtMs - value.stateReceivedAtMs > value.maxAgeMs) return { evaluable: false, reason: 'STALE_STATE' };
  return { evaluable: true, reason: 'AVAILABLE_AT_DECISION' };
}

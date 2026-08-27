export interface PaperMvpSourcePosition {
  readonly positionId: unknown;
  readonly status: unknown;
  readonly mint: unknown;
  readonly quoteMint: unknown;
  readonly creationDetectedAtMs: unknown;
  readonly entryDecisionAtMs: unknown;
  readonly entryDecisionJobCount: unknown;
  readonly entryDecisionJobAtMs: unknown;
  readonly entryQuoteAtMs: unknown;
  readonly paperBuyAtMs: unknown;
  readonly exitTriggerAtMs: unknown;
  readonly closeEventId: unknown;
  readonly closeEventType: unknown;
  readonly closeEventSource: unknown;
  readonly closeEventConfirmationStatus: unknown;
  readonly closeEventObservedAtMs: unknown;
  readonly exitQuoteAtMs: unknown;
  readonly paperSellAtMs: unknown;
  readonly entryTradeId: unknown;
  readonly buyTradeId: unknown;
  readonly buySide: unknown;
  readonly buyInputMint: unknown;
  readonly buyOutputMint: unknown;
  readonly buyAmountInRaw: unknown;
  readonly buyAmountOutRaw: unknown;
  readonly buyMinimumAmountOutRaw: unknown;
  readonly buyFillAmountOutRaw: unknown;
  readonly buyFeesRaw: unknown;
  readonly buySlippageBps: unknown;
  readonly buyPriceImpactBps: unknown;
  readonly exitTradeId: unknown;
  readonly sellTradeId: unknown;
  readonly sellSide: unknown;
  readonly sellInputMint: unknown;
  readonly sellOutputMint: unknown;
  readonly sellReason: unknown;
  readonly sellAmountInRaw: unknown;
  readonly sellAmountOutRaw: unknown;
  readonly sellMinimumAmountOutRaw: unknown;
  readonly sellFillAmountOutRaw: unknown;
  readonly sellFeesRaw: unknown;
  readonly sellSlippageBps: unknown;
  readonly sellPriceImpactBps: unknown;
}

export interface PaperMvpSourceBatch {
  readonly positions: readonly PaperMvpSourcePosition[];
  readonly creationsObserved: number;
  readonly entriesRejected: number;
  readonly duplicateLogicalBuys: number;
  readonly duplicateLogicalSells: number;
}

export interface PaperMvpSource {
  collectBatch(input: Readonly<{
    runId: string;
    startedAtMs: number;
    deadlineAtMs: number;
    strategyId: string;
    strategyVersion: number;
    limit: number;
    signal?: AbortSignal;
  }>): Promise<PaperMvpSourceBatch>;
}

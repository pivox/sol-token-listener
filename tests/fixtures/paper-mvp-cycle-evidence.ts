export function paperMvpCycleEvidence(input: Readonly<{
  positionId?: string; mint?: string; quoteMint?: string; fingerprint?: string;
  target?: number; buyAtMs?: number; sellAtMs?: number;
  entryQuoteAtMs?: number; exitTriggerAtMs?: number;
}> = {}) {
  const target = input.target ?? 3;
  const buyAtMs = input.buyAtMs ?? 130;
  const sellAtMs = input.sellAtMs ?? 220;
  const quoteAtMs = input.entryQuoteAtMs ?? buyAtMs - 10;
  const cursor = (slot: number) => ({
    slot: String(slot), transactionIndex: 0, instructionIndex: 0, innerInstructionIndex: null,
  });
  return {
    schemaVersion: 'paper-mvp-causal-evidence.v1' as const,
    positionId: input.positionId ?? 'position-1', mint: input.mint ?? 'mint-1',
    quoteMint: input.quoteMint ?? 'SOL', creator: 'creator', sessionId: 'session-1',
    qualification: {
      reportId: 'report-1', profileId: 'pumpfun-mvp-technical-v1', profileVersion: 1,
      profileFingerprint: input.fingerprint ?? 'a'.repeat(64), verdict: 'QUALIFIED',
      blockers: [], reasonCodes: ['BUY_SIMULATION_FAILED'], candidateReasonCodes: ['QUALIFIED_ENTRY'],
    },
    buy: {
      tradeId: 'buy-1', quoteId: 'buy-quote', observedSlot: '10',
      quoteObservedAtMs: quoteAtMs, createdAtMs: buyAtMs,
      decisionCursor: cursor(9),
      boundary: { kind: 'PAPER_BUY_QUOTE_SLOT', slot: '10', quoteId: 'buy-quote',
        observedAtMs: quoteAtMs },
    },
    externalUniqueBuyers: {
      target, count: target, minimumQuoteAmountRaw: '1', minimumConfirmation: 'confirmed',
      countedTradeIds: Array.from({ length: target }, (_, i) => `external-${i}`),
      countedWallets: Array.from({ length: target }, (_, i) => `wallet-${i}`),
      progression: Array.from({ length: target }, (_, i) => ({
        count: i + 1, tradeId: `external-${i}`, wallet: `wallet-${i}`,
        sourceEventId: `counted-${i}`, cursor: cursor(11 + i),
        confirmationStatus: 'confirmed', quoteAmountRaw: '2',
        observedAtMs: buyAtMs + i + 1,
      })),
    },
    sell: {
      tradeId: 'sell-1', quoteId: 'sell-quote', createdAtMs: sellAtMs,
      closeEvent: { id: 'close-1', type: 'PaperPositionClosed',
        cursor: cursor(11 + target), confirmationStatus: 'finalized',
        observedAtMs: input.exitTriggerAtMs ?? sellAtMs - 20 },
    },
    recovery: { sessionState: 'PAPER_CLOSED', pendingExitReason: null,
      lastErrorCode: null, quoteWaitHistory: 'UNAVAILABLE' as const },
  };
}

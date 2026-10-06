export const MINT = '11111111111111111111111111111111';
export const QUOTE_MINT = 'So11111111111111111111111111111111111111112';
export const NOW = '2026-08-11T00:00:00.000Z';

export const scores = {
  preparation: { score: 12, maximum: 15 },
  socialAuthenticity: { score: 17, maximum: 25 },
  onchainHealth: { score: 43, maximum: 60 },
  total: { score: 72, maximum: 100 },
} as const;

export const candidate = {
  id: `candidate_${'a'.repeat(64)}`,
  state: 'ELIGIBLE',
  strategyId: 'validated-external-buys',
  strategyVersion: 1,
  qualificationReportId: `qreport_${'b'.repeat(64)}`,
  quoteMint: QUOTE_MINT,
  quoteDecimals: 9,
  reasonCodes: ['QUALIFIED_ENTRY'],
  eligibleUntil: NOW,
  createdAt: NOW,
} as const;

export const paperStrategy = {
  id: `paper_session_${'c'.repeat(64)}`,
  state: 'WAITING_EXTERNAL_BUYS',
  reasonCode: 'EXTERNAL_BUY_OBSERVED',
  pendingExitReason: null,
  strategyId: 'validated-external-buys',
  strategyVersion: 1,
  positionId: 'paper-position-a',
  quoteMint: QUOTE_MINT,
  externalBuyTarget: 10,
  externalBuyCount: 3,
  minimumConfirmation: 'confirmed',
  updatedAt: NOW,
  lastErrorCode: null,
  lastErrorRetryable: null,
} as const;

export const launchSummary = {
  mint: MINT,
  detectedAt: NOW,
  detectedSlot: '900719925474099312345',
  status: 'WATCHLISTED',
  name: 'Synthetic token',
  symbol: 'SYN',
  quoteMint: QUOTE_MINT,
  quoteDecimals: 9,
  marketCapQuote: null,
  liquidityQuote: '12345678901234567890',
  qualificationSummary: {
    verdict: 'WATCHLISTED',
    scores,
    blockerCodes: ['SHARED_FUNDER_CLUSTER'],
    evaluatedAt: NOW,
  },
  candidate,
  paperStrategy,
} as const;

export const launchDetail = {
  ...launchSummary,
  creator: MINT,
  tokenProgram: 'SPL_TOKEN',
  launchpad: 'PUMP_FUN',
  initialTokenAmount: '1000000',
  initialQuoteAmount: '100000000',
  reserveBase: '2000000',
  reserveQuote: '200000000',
  feeBps: '100',
} as const;

export const qualification = {
  ruleSet: {
    id: 'pumpfun-v1-initial', version: 1, status: 'UNVALIDATED_RULE_SET',
    minimumTotalScore: 60, fingerprint: 'a'.repeat(64),
  },
  scores,
  evidence: [{ signal: 'imageValid', status: 'SATISFIED', message: 'Image valide.' }],
  conditions: [{
    code: 'SHARED_FUNDER_CLUSTER', mode: 'ENFORCED', status: 'TRIGGERED',
    observed: { maximumSharedFunderCount: 2 },
    thresholds: { minimumSharedFunders: 2 },
    message: 'Cluster de financement partagé.',
  }],
  blockers: [{ code: 'SHARED_FUNDER_CLUSTER', message: 'Condition éliminatoire active.' }],
  verdict: 'REJECTED',
  evaluatedAt: NOW,
} as const;

export const timelineEntry = {
  id: 'event-a',
  type: 'QualificationUpdated',
  occurredAt: NOW,
  slot: '100',
  confirmationStatus: 'confirmed',
  payloadVersion: 1,
  payload: { verdict: 'REJECTED' },
} as const;

export const paperPosition = {
  id: 'position-a',
  mint: MINT,
  status: 'PAPER_CLOSED',
  openedAt: NOW,
  closedAt: NOW,
  quoteMint: QUOTE_MINT,
  quantity: '1000000',
  entryQuoteAmount: '100000000',
  exitQuoteAmount: '120000000',
  realizedPnlQuote: '19000000',
  estimatedFeesQuote: '1000000',
  strategyId: 'validated-external-buys',
  strategyVersion: 1,
  strategySessionId: paperStrategy.id,
  qualificationReportId: candidate.qualificationReportId,
  candidateId: candidate.id,
  externalBuyCount: 10,
  externalBuyTarget: 10,
  entryVenue: 'PUMP_FUN_BONDING_CURVE',
  reasonCodes: ['EXTERNAL_BUY_TARGET_REACHED'],
} as const;

export const firstProcessingCanary = {
  version: 1,
  thresholdMs: 45_000,
  cohortCapacity: 50_000,
  cohortStartedAtMs: 1_000_000,
  cohortEndsAtMs: 1_900_000,
  sampledAtMs: 1_945_000,
  overflowed: false,
  eligibleCount: 3,
  completedCount: 3,
  underThresholdCount: 3,
  atOrAboveThresholdCount: 0,
  pendingCount: 0,
  rightCensoredCount: 0,
  tailCensoredCount: 0,
  terminalCount: 0,
  unavailableCount: 0,
  invalidDurationCount: 0,
  p95Ms: 44_999,
  verdict: 'PASS',
} as const;

export const health = {
  status: 'DEGRADED',
  observedAt: NOW,
  postgresql: { status: 'AVAILABLE' },
  http: { status: 'AVAILABLE' },
  pipeline: {
    pumpfun: 'RUNNING', pumpswap: 'RUNNING', paperDecision: 'DEGRADED', qualification: 'RUNNING',
  },
  qualification: { currentCount: 2, lastSuccessAt: null },
  paperDecisionJobs: {
    pendingCount: 1, leasedCount: 0, retryableFailedCount: 1, exhaustedCount: 0,
    lastSuccessAt: NOW, lastErrorCode: 'QUOTE_UNAVAILABLE',
  },
  checkpoints: { launchpad: '100', market: '99' },
  heartbeat: {
    runtimeState: 'RUNNING', subscriberState: 'RUNNING', scannerState: 'RUNNING',
    workerState: 'RUNNING', reconcilerState: 'RUNNING', backlogCount: 1,
    leasedCount: 0, exhaustedCount: 0, startedAt: NOW, updatedAt: NOW,
    lastHttpSlot: '100', lastWebsocketSlot: '100', lastFinalizedSlot: '99',
    lastSignature: null, pendingTransactions: 1, activeSessions: 1,
    firstProcessingCanary,
    decoderQuarantine: { version: 1, unresolvedCount: 2 },
    workerAdmission: {
      version: 1, enabled: true, trackingWindowSeconds: 45,
      claimableBacklogCount: 8, classificationPendingCount: 2,
      oldestClassificationPendingAgeMs: 4_999, freshMintCount: 3,
      extendedMintCount: 2, demotedCount: 5,
    },
    blockHydration: {
      version: 1, enabled: true, callerConcurrency: 1,
      locates: 10, hits: 6, misses: 4, inFlightJoins: 0, fetches: 4,
      forcedRefreshes: 1, evictions: 2, oversizeBypasses: 0, fetchFailures: 0,
      epochInvalidations: 0, retainedEntries: 2, retainedBytes: 4096,
      inFlightFetches: 0, queuedFetches: 1,
      queueDelayMs: { last: 250, maximum: 500 },
    },
    websocket: {
      version: 1,
      supervision: 'ACTIVE',
      state: 'DEGRADED',
      phase: 'RECOVERING',
      providerId: 'primary',
      candidateProviderId: 'fallback-1',
      updatedAt: '2026-08-11T00:00:01.000Z',
      heartbeatAt: '2026-08-11T00:00:02.000Z',
      acknowledgedAt: '2026-08-11T00:00:03.000Z',
      lastObservation: {
        observedAt: '2026-08-11T00:00:04.000Z', slot: '900719925474099312345',
      },
      disconnect: {
        occurredAt: '2026-08-11T00:00:05.000Z', reasonCode: 'REMOTE_CLOSE',
      },
      recovery: {
        status: 'IN_PROGRESS', startedAt: '2026-08-11T00:00:06.000Z',
        completedAt: null, reasonCode: 'SESSION_FAILURE',
      },
    },
  },
  lagSlots: '1',
} as const;

export const sseEvent = {
  eventId: `evt_${'1'.repeat(64)}`,
  type: 'QualificationUpdated',
  mint: MINT,
  source: 'qualification',
  program: 'pumpfun',
  signature: 'synthetic-signature',
  cursor: { slot: '100', transactionIndex: '0', instructionIndex: '1', innerInstructionIndex: null },
  confirmationStatus: 'confirmed',
  blockchainTime: NOW,
  observedAt: NOW,
  payloadVersion: 1,
  payload: { verdict: 'REJECTED' },
} as const;

export function success<T>(data: T, nextCursor: string | null = null): {
  apiVersion: 'v1';
  meta: { generatedAt: string; nextCursor: string | null };
  data: T;
} {
  return { apiVersion: 'v1', meta: { generatedAt: NOW, nextCursor }, data };
}

export const SIGNATURE = '5'.repeat(88);

export const liveOverview = {
  availability: 'AVAILABLE',
  wallet: MINT,
  balance: { lamports: '2500000000', observedAt: NOW },
  open: [{
    positionId: 'execution_live_position_open',
    mint: QUOTE_MINT,
    state: 'OPEN',
    openedAt: '2026-08-10T23:55:00.000Z',
    exitDeadlineAt: '2026-08-11T00:10:00.000Z',
    remainingRaw: '35000000000',
    costLamports: '1005000',
    spotValueLamports: '1200000',
    unrealizedLamports: '195000',
  }],
  history: [{
    positionId: 'execution_live_position_closed',
    mint: QUOTE_MINT,
    openedAt: '2026-08-10T22:00:00.000Z',
    closedAt: '2026-08-10T22:05:00.000Z',
    entrySignature: SIGNATURE,
    exitSignature: SIGNATURE,
    realizedLamports: '-4205',
  }],
  totals: {
    realizedLamports: '-4205', unrealizedLamports: '195000', openCount: 1, positionsWithoutPnl: 0,
  },
} as const;

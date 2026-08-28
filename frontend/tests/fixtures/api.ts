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

export const socialUnavailable = {
  status: 'NOT_AVAILABLE',
  links: [],
  evidence: [],
} as const;

export const socialAvailable = {
  status: 'AVAILABLE',
  collectionStatus: 'PARTIAL',
  collectionId: 'social_collection_a',
  metadataSnapshotId: 'pumpfun_metadata_a',
  observedAt: NOW,
  linkCount: 1,
  linksTruncated: false,
  links: [{
    id: 'social_link_a',
    kind: 'WEBSITE',
    declaredValueSha256: 'd'.repeat(64),
    syntaxStatus: 'VALID',
    canonicalUrl: 'https://project.example/',
    invalidReason: null,
    observedAt: NOW,
  }],
  evidenceCount: 1,
  evidenceTruncated: false,
  evidence: [{
    id: 'social_evidence_a',
    type: 'URL_REACHABLE',
    outcome: 'CONFIRMED',
    subjectKind: 'WEBSITE',
    relatedKind: null,
    subjectUrl: 'https://project.example/',
    finalUrl: 'https://project.example/',
    httpStatus: 200,
    redirectCount: 0,
    contentSha256: 'e'.repeat(64),
    reasonCode: 'HTTP_2XX',
    observedAt: NOW,
  }],
  coverage: {
    declaredLinkCount: 1,
    inspectedLinkCount: 1,
    confirmedEvidenceCount: 1,
    rejectedEvidenceCount: 0,
    unknownEvidenceCount: 0,
  },
} as const;

export const holdersUnavailable = {
  status: 'NOT_AVAILABLE',
  snapshots: [],
  positions: [],
  clusters: [],
  clusterAnalysisStatus: 'NOT_AVAILABLE',
} as const;

export const holdersAvailable = {
  status: 'AVAILABLE',
  methodology: 'OBSERVED_BONDING_CURVE_TRADES',
  creatorProfile: {
    mint: MINT,
    creator: MINT,
    buyCount: 1,
    sellCount: 0,
    totalBoughtBaseRaw: '1000000',
    totalSoldBaseRaw: '0',
    observedNetBaseRaw: '1000000',
    hasSold: false,
    firstSell: null,
    initialBuys: [],
    quoteFlows: [{
      quoteAsset: { mint: QUOTE_MINT, decimals: 9, tokenProgram: 'SPL_TOKEN' },
      boughtQuoteRaw: '100000000',
      soldQuoteRaw: '0',
    }],
    uniqueExternalBuyers: 8,
    unknownTraderTradeCount: 0,
  },
  latestSnapshot: {
    id: 'holder-snapshot-a',
    inputFingerprint: 'f'.repeat(64),
    observedAt: NOW,
    confirmationStatus: 'confirmed',
    cursor: {
      slot: '100', transactionIndex: '0', instructionIndex: '1', innerInstructionIndex: null,
    },
    totalPositiveNetBaseRaw: '2000000',
    top1Bps: '1200',
    top5Bps: '4200',
    top10Bps: '6500',
    creatorBps: '500',
    uniqueKnownBuyers: 9,
    uniqueExternalBuyers: 8,
    positivePositionCount: 9,
    unknownTraderTradeCount: 0,
  },
  snapshots: [],
  positions: [],
  clusterAnalysisStatus: 'AVAILABLE',
  clusterMethodology: 'OBSERVED_PUMPFUN_TRANSACTIONS',
  clusterCoverage: {
    knownBuyCount: 8, knownBuyerCount: 8,
    strongEvidenceBuyCount: 2, strongEvidenceBuyerCount: 2,
    mediumOnlyBuyCount: 1, mediumOnlyBuyerCount: 1,
    noEvidenceBuyCount: 5, noEvidenceBuyerCount: 5,
    unavailableBuyCount: 0, unavailableBuyerCount: 0,
    notProcessedBuyCount: 0, notProcessedBuyerCount: 0,
    analyzedTransactionCount: 8, evidenceCount: 3,
  },
  clusterCount: 0,
  clustersTruncated: false,
  clusters: [],
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
  social: socialAvailable,
  holders: holdersAvailable,
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

export const health = {
  status: 'DEGRADED',
  observedAt: NOW,
  postgresql: { status: 'AVAILABLE' },
  http: { status: 'AVAILABLE' },
  pipeline: {
    pumpfun: 'RUNNING', pumpswap: 'RUNNING', paperDecision: 'DEGRADED', qualification: 'RUNNING', social: 'RUNNING',
  },
  qualification: { currentCount: 2, lastSuccessAt: null },
  socialJobs: { pendingCount: 0, leasedCount: 0, retryableFailedCount: 0, exhaustedCount: 0 },
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

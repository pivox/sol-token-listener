import { z } from 'zod';

const decimalIntegerSchema = z.string().regex(/^-?\d+$/u);
const unsignedIntegerSchema = z.string().regex(/^\d+$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const safeIntegerSchema = z.number().int();
const countSchema = safeIntegerSchema.nonnegative();
const versionSchema = countSchema;
const mintSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u);
const emptyArraySchema = z.array(z.never()).length(0);

const jsonValueSchema: z.ZodType = z.lazy(() => z.union([
  z.string(),
  z.number().int(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const domainEventTypeSchema = z.enum([
  'TokenLaunchDetected',
  'TokenMetadataResolved',
  'TokenMetadataFailed',
  'SocialEvidenceCollected',
  'CreatorProfileUpdated',
  'HolderDistributionUpdated',
  'WalletClusterDetected',
  'BondingCurveTradeObserved',
  'BondingCurveStateUpdated',
  'BondingCurveCompleted',
  'QualificationUpdated',
  'TradingCandidateUpdated',
  'PaperStrategySessionUpdated',
  'PaperExternalBuyCounted',
  'PaperPositionOpened',
  'PaperPositionUpdated',
  'PaperPositionClosed',
  'MigrationObserved',
  'PumpSwapPoolActivated',
]);

const confirmationStatusSchema = z.enum(['processed', 'confirmed', 'finalized', 'orphaned']);
const finalConfirmationStatusSchema = z.enum(['processed', 'confirmed', 'finalized']);
const launchStatusSchema = z.enum([
  'DETECTED', 'METADATA_PENDING', 'METADATA_RESOLVED', 'OBSERVING',
  'SOCIAL_CHECKING', 'ONCHAIN_CHECKING', 'QUALIFIED', 'WATCHLISTED',
  'SUSPECT', 'REJECTED', 'PAPER_BUY_PENDING', 'PAPER_HOLDING',
  'PAPER_SELL_PENDING', 'PAPER_CLOSED', 'BONDING_CURVE_COMPLETE',
  'MIGRATION_PENDING', 'PUMPSWAP_ACTIVE', 'EXPIRED', 'MANUAL_REVIEW',
]);
const qualificationReasonCodeSchema = z.enum([
  'CREATOR_EARLY_SELL', 'CREATOR_REPEAT_DUMPER', 'MINT_SOCIAL_MISMATCH',
  'IMPERSONATION_SUSPECTED', 'HOLDER_CONCENTRATION_EXCEEDED',
  'RELATED_WALLET_CLUSTER_EXCEEDED', 'SHARED_FUNDER_CLUSTER',
  'BUY_SIMULATION_FAILED', 'SELL_QUOTE_UNAVAILABLE', 'ROUND_TRIP_LOSS_EXCEEDED',
  'STALE_DATA', 'UNSUPPORTED_TOKEN_EXTENSION', 'METADATA_FETCH_FAILED',
  'UNSUPPORTED_QUOTE_MINT',
]);
const paperReasonCodeSchema = z.enum([
  'QUALIFICATION_NOT_ELIGIBLE', 'ENTRY_WINDOW_EXPIRED', 'EVIDENCE_REVOKED',
  'QUALIFIED_ENTRY', 'EXTERNAL_BUY_OBSERVED', 'EXTERNAL_BUY_TARGET_REACHED',
  'EXIT_QUOTE_UNAVAILABLE', 'SOURCE_ORPHANED', 'RECONCILIATION_REQUIRED',
  'CREATION_ENTRY_EXPIRED', 'CREATION_ENTRY_REJECTED',
  'EXTERNAL_UNIQUE_BUY_OBSERVED', 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED',
  'TAKE_PROFIT_2X_EXECUTABLE', 'CREATOR_EARLY_SELL', 'MANUAL_KILL_SWITCH',
  'SELL_QUOTE_UNAVAILABLE_OR_STALE',
]);
const creationExitReasonSchema = z.enum([
  'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED', 'TAKE_PROFIT_2X_EXECUTABLE',
  'CREATOR_EARLY_SELL', 'MANUAL_KILL_SWITCH',
]);

const scoreSchema = z.object({
  score: countSchema,
  maximum: countSchema,
}).loose();
const scoresSchema = z.object({
  preparation: scoreSchema,
  socialAuthenticity: scoreSchema,
  onchainHealth: scoreSchema,
  total: scoreSchema,
}).loose();

const qualificationSummarySchema = z.object({
  verdict: z.enum(['QUALIFIED', 'WATCHLISTED', 'REJECTED']),
  scores: scoresSchema,
  blockerCodes: z.array(qualificationReasonCodeSchema),
  evaluatedAt: timestampSchema,
}).loose();

const tradingCandidateSchema = z.object({
  id: z.string().min(1),
  state: z.enum(['NOT_ELIGIBLE', 'ELIGIBLE', 'EXPIRED', 'REVOKED']),
  strategyId: z.string().min(1),
  strategyVersion: versionSchema,
  qualificationReportId: z.string().min(1),
  quoteMint: mintSchema,
  quoteDecimals: countSchema,
  reasonCodes: z.array(paperReasonCodeSchema),
  eligibleUntil: timestampSchema.nullable(),
  createdAt: timestampSchema,
}).loose();

const paperStrategySchema = z.object({
  id: z.string().min(1),
  state: z.enum([
    'BUY_PENDING', 'PAPER_HOLDING', 'WAITING_EXTERNAL_BUYS', 'EXIT_PENDING_QUOTE',
    'SELL_PENDING', 'PAPER_CLOSED', 'PAPER_RETRACTED', 'MANUAL_REVIEW',
  ]),
  reasonCode: paperReasonCodeSchema,
  pendingExitReason: creationExitReasonSchema.nullable(),
  strategyId: z.string().min(1),
  strategyVersion: versionSchema,
  positionId: z.string().min(1).nullable(),
  quoteMint: mintSchema,
  externalBuyTarget: countSchema,
  externalBuyCount: countSchema,
  minimumConfirmation: z.enum(['processed', 'confirmed', 'finalized']),
  updatedAt: timestampSchema,
  lastErrorCode: z.string().min(1).nullable(),
  lastErrorRetryable: z.boolean().nullable(),
}).loose();

const launchSummarySchema = z.object({
  mint: mintSchema,
  detectedAt: timestampSchema,
  detectedSlot: unsignedIntegerSchema,
  status: launchStatusSchema,
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  quoteMint: mintSchema.nullable(),
  quoteDecimals: countSchema.nullable(),
  marketCapQuote: decimalIntegerSchema.nullable(),
  liquidityQuote: decimalIntegerSchema.nullable(),
  qualificationSummary: qualificationSummarySchema.nullable(),
  candidate: tradingCandidateSchema.nullable(),
  paperStrategy: paperStrategySchema.nullable(),
}).loose();

const socialLinkKindSchema = z.enum(['WEBSITE', 'X', 'TELEGRAM']);
const socialLinkSchema = z.object({
  id: z.string().min(1),
  kind: socialLinkKindSchema,
  declaredValueSha256: z.string().regex(/^[a-f\d]{64}$/u),
  syntaxStatus: z.enum(['VALID', 'INVALID']),
  canonicalUrl: z.url().nullable(),
  invalidReason: z.string().nullable(),
  observedAt: timestampSchema,
}).loose();
const socialEvidenceSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'URL_SYNTAX_VALID', 'URL_SYNTAX_INVALID', 'URL_REACHABLE',
    'CROSS_LINK_CONFIRMED', 'MINT_PUBLISHED', 'ACCOUNT_TOO_RECENT',
    'DOMAIN_MISMATCH', 'CONTENT_UNAVAILABLE', 'VERIFICATION_UNKNOWN',
  ]),
  outcome: z.enum(['CONFIRMED', 'REJECTED', 'UNKNOWN']),
  subjectKind: socialLinkKindSchema.nullable(),
  relatedKind: socialLinkKindSchema.nullable(),
  subjectUrl: z.url().nullable(),
  finalUrl: z.url().nullable(),
  httpStatus: countSchema.max(999).nullable(),
  redirectCount: countSchema,
  contentSha256: z.string().regex(/^[a-f\d]{64}$/u).nullable(),
  reasonCode: z.string().min(1),
  observedAt: timestampSchema,
}).loose();
const socialUnavailableSchema = z.object({
  status: z.literal('NOT_AVAILABLE'),
  links: emptyArraySchema,
  evidence: emptyArraySchema,
}).loose();
const socialAvailableSchema = z.object({
  status: z.literal('AVAILABLE'),
  collectionStatus: z.enum(['COMPLETE', 'PARTIAL', 'FAILED']),
  collectionId: z.string().min(1),
  metadataSnapshotId: z.string().min(1),
  observedAt: timestampSchema,
  linkCount: countSchema,
  linksTruncated: z.boolean(),
  links: z.array(socialLinkSchema),
  evidenceCount: countSchema,
  evidenceTruncated: z.boolean(),
  evidence: z.array(socialEvidenceSchema),
  coverage: z.object({
    declaredLinkCount: countSchema,
    inspectedLinkCount: countSchema,
    confirmedEvidenceCount: countSchema,
    rejectedEvidenceCount: countSchema,
    unknownEvidenceCount: countSchema,
  }).loose(),
}).loose();
const socialSchema = z.discriminatedUnion('status', [socialUnavailableSchema, socialAvailableSchema]);

const quoteAssetSchema = z.object({
  mint: mintSchema,
  decimals: countSchema,
  tokenProgram: z.enum(['SPL_TOKEN', 'TOKEN_2022']),
}).loose();
const cursorSchema = z.object({
  slot: unsignedIntegerSchema,
  transactionIndex: unsignedIntegerSchema,
  instructionIndex: unsignedIntegerSchema,
  innerInstructionIndex: unsignedIntegerSchema.nullable(),
}).loose();
const quoteFlowSchema = z.object({
  quoteAsset: quoteAssetSchema,
  boughtQuoteRaw: decimalIntegerSchema,
  soldQuoteRaw: decimalIntegerSchema,
}).loose();
const creatorTradeEvidenceSchema = z.object({
  eventId: z.string().min(1),
  tradeId: z.string().min(1),
  signature: z.string().min(1),
  cursor: cursorSchema,
  baseAmountRaw: decimalIntegerSchema,
  quoteAmountRaw: decimalIntegerSchema,
  quoteAsset: quoteAssetSchema,
}).loose();
const creatorProfileSchema = z.object({
  mint: mintSchema,
  creator: mintSchema,
  buyCount: countSchema,
  sellCount: countSchema,
  totalBoughtBaseRaw: decimalIntegerSchema,
  totalSoldBaseRaw: decimalIntegerSchema,
  observedNetBaseRaw: decimalIntegerSchema,
  hasSold: z.boolean(),
  firstSell: creatorTradeEvidenceSchema.nullable(),
  initialBuys: z.array(creatorTradeEvidenceSchema),
  quoteFlows: z.array(quoteFlowSchema),
  uniqueExternalBuyers: countSchema,
  unknownTraderTradeCount: countSchema,
}).loose();
const holderSnapshotSchema = z.object({
  id: z.string().min(1),
  inputFingerprint: z.string().regex(/^[a-f\d]{64}$/u),
  observedAt: timestampSchema,
  confirmationStatus: finalConfirmationStatusSchema,
  cursor: cursorSchema,
  totalPositiveNetBaseRaw: decimalIntegerSchema,
  top1Bps: decimalIntegerSchema,
  top5Bps: decimalIntegerSchema,
  top10Bps: decimalIntegerSchema,
  creatorBps: decimalIntegerSchema,
  uniqueKnownBuyers: countSchema,
  uniqueExternalBuyers: countSchema,
  positivePositionCount: countSchema,
  unknownTraderTradeCount: countSchema,
}).loose();
const walletPositionSchema = z.object({
  wallet: mintSchema,
  isCreator: z.boolean(),
  buyCount: countSchema,
  sellCount: countSchema,
  boughtBaseRaw: decimalIntegerSchema,
  soldBaseRaw: decimalIntegerSchema,
  observedNetBaseRaw: decimalIntegerSchema,
  quoteFlows: z.array(quoteFlowSchema),
  firstObservedCursor: cursorSchema,
  lastObservedCursor: cursorSchema,
}).loose();
const clusterMemberSchema = z.object({
  wallet: mintSchema,
  role: z.enum(['PARTICIPANT', 'AUXILIARY_FUNDER']),
  isCreator: z.boolean(),
  observedNetBaseRaw: decimalIntegerSchema,
}).loose();
const walletClusterSchema = z.object({
  id: z.string().min(1),
  quoteAssetCount: countSchema,
  quoteAssetsTruncated: z.boolean(),
  quoteAssets: z.array(quoteAssetSchema),
  participantWalletCount: countSchema,
  auxiliaryWalletCount: countSchema,
  positiveHolderCount: countSchema,
  observedPositiveBaseRaw: decimalIntegerSchema,
  concentrationBps: decimalIntegerSchema,
  containsCreator: z.boolean(),
  sharedFunderCount: countSchema,
  strongRelationshipCount: countSchema,
  strongEvidenceCount: countSchema,
  memberCount: countSchema,
  membersTruncated: z.boolean(),
  members: z.array(clusterMemberSchema),
}).loose();
const walletGraphCoverageSchema = z.object({
  knownBuyCount: countSchema,
  knownBuyerCount: countSchema,
  strongEvidenceBuyCount: countSchema,
  strongEvidenceBuyerCount: countSchema,
  mediumOnlyBuyCount: countSchema,
  mediumOnlyBuyerCount: countSchema,
  noEvidenceBuyCount: countSchema,
  noEvidenceBuyerCount: countSchema,
  unavailableBuyCount: countSchema,
  unavailableBuyerCount: countSchema,
  notProcessedBuyCount: countSchema,
  notProcessedBuyerCount: countSchema,
  analyzedTransactionCount: countSchema,
  evidenceCount: countSchema,
}).loose();
const holdersUnavailableSchema = z.object({
  status: z.literal('NOT_AVAILABLE'),
  snapshots: emptyArraySchema,
  positions: emptyArraySchema,
  clusters: emptyArraySchema,
  clusterAnalysisStatus: z.literal('NOT_AVAILABLE'),
}).loose();
const holdersAvailableBase = z.object({
  status: z.literal('AVAILABLE'),
  methodology: z.literal('OBSERVED_BONDING_CURVE_TRADES'),
  creatorProfile: creatorProfileSchema,
  latestSnapshot: holderSnapshotSchema,
  snapshots: z.array(holderSnapshotSchema),
  positions: z.array(walletPositionSchema),
});
const holdersGraphUnavailableSchema = holdersAvailableBase.extend({
  clusters: emptyArraySchema,
  clusterAnalysisStatus: z.literal('NOT_AVAILABLE'),
}).loose();
const holdersGraphAvailableSchema = holdersAvailableBase.extend({
  clusterAnalysisStatus: z.literal('AVAILABLE'),
  clusterMethodology: z.literal('OBSERVED_PUMPFUN_TRANSACTIONS'),
  clusterCoverage: walletGraphCoverageSchema,
  clusterCount: countSchema,
  clustersTruncated: z.boolean(),
  clusters: z.array(walletClusterSchema),
}).loose();
const holdersAvailableSchema = z.union([holdersGraphUnavailableSchema, holdersGraphAvailableSchema]);
const holdersSchema = z.union([holdersUnavailableSchema, holdersAvailableSchema]);

const launchDetailSchema = launchSummarySchema.extend({
  creator: mintSchema,
  tokenProgram: z.string().min(1),
  launchpad: z.string().min(1),
  initialTokenAmount: decimalIntegerSchema.nullable(),
  initialQuoteAmount: decimalIntegerSchema.nullable(),
  reserveBase: decimalIntegerSchema.nullable(),
  reserveQuote: decimalIntegerSchema.nullable(),
  feeBps: decimalIntegerSchema.nullable(),
  social: socialSchema,
  holders: holdersSchema,
}).loose();

const qualificationSchema = z.object({
  ruleSet: z.object({
    id: z.string().min(1),
    version: versionSchema,
    status: z.literal('UNVALIDATED_RULE_SET'),
    minimumTotalScore: countSchema,
    fingerprint: z.string().nullable(),
  }).loose(),
  scores: scoresSchema,
  evidence: z.array(z.object({
    signal: z.enum([
      'imageValid', 'descriptionAvailable', 'linksReachable', 'socialCrossLinkConfirmed',
      'creatorHasNotSold', 'reverseQuoteAvailable', 'externalBuyersObserved',
    ]),
    status: z.enum(['SATISFIED', 'NOT_SATISFIED', 'UNKNOWN']),
    message: z.string(),
  }).loose()),
  conditions: z.array(z.object({
    code: qualificationReasonCodeSchema,
    mode: z.enum(['DISABLED', 'REPORT_ONLY', 'ENFORCED']),
    status: z.enum(['PASSED', 'TRIGGERED', 'UNKNOWN', 'NOT_CONFIGURED', 'DISABLED']),
    observed: z.record(z.string(), z.union([z.string(), safeIntegerSchema, z.boolean(), z.null()])),
    thresholds: z.record(z.string(), z.union([z.string(), safeIntegerSchema, z.null()])),
    message: z.string(),
  }).loose()),
  blockers: z.array(z.object({
    code: qualificationReasonCodeSchema,
    message: z.string(),
  }).loose()),
  verdict: z.enum(['QUALIFIED', 'WATCHLISTED', 'REJECTED']),
  evaluatedAt: timestampSchema,
}).loose();

const timelineEntrySchema = z.object({
  id: z.string().min(1),
  type: domainEventTypeSchema,
  occurredAt: timestampSchema,
  slot: unsignedIntegerSchema.nullable(),
  confirmationStatus: confirmationStatusSchema,
  payloadVersion: versionSchema,
  payload: jsonValueSchema,
}).loose();

const paperPositionSchema = z.object({
  id: z.string().min(1),
  mint: mintSchema,
  status: z.enum(['PAPER_HOLDING', 'PAPER_CLOSED', 'PAPER_RETRACTED']),
  openedAt: timestampSchema,
  closedAt: timestampSchema.nullable(),
  quoteMint: mintSchema,
  quantity: decimalIntegerSchema,
  entryQuoteAmount: decimalIntegerSchema,
  exitQuoteAmount: decimalIntegerSchema.nullable(),
  realizedPnlQuote: decimalIntegerSchema.nullable(),
  estimatedFeesQuote: decimalIntegerSchema,
  strategyId: z.string().min(1),
  strategyVersion: versionSchema,
  strategySessionId: z.string().nullable(),
  qualificationReportId: z.string().nullable(),
  candidateId: z.string().nullable(),
  externalBuyCount: countSchema.nullable(),
  externalBuyTarget: countSchema.nullable(),
  entryVenue: z.enum(['PUMP_FUN_BONDING_CURVE', 'PUMPSWAP', 'UNKNOWN']),
  reasonCodes: z.array(paperReasonCodeSchema),
}).loose();

const runtimeStateSchema = z.enum(['STARTING', 'RUNNING', 'DEGRADED', 'STOPPING', 'STOPPED']);
const rpcProviderIdSchema = z.enum(['primary', 'fallback-1', 'fallback-2', 'fallback-3']);
const websocketSlotSchema = z.string().regex(/^(?:0|[1-9]\d*)$/u).max(78);
const websocketHealthSchema = z.object({
  version: z.literal(1),
  supervision: z.enum(['INACTIVE', 'ACTIVE']),
  state: z.enum(['STOPPED', 'CONNECTING', 'ACKNOWLEDGED', 'RECOVERING', 'DEGRADED']),
  phase: z.enum([
    'STOPPED', 'CONNECTING', 'WAITING_FOR_ACKS', 'ACKNOWLEDGED', 'RECOVERING',
    'RUNNING', 'DEGRADED', 'UNRECOVERABLE', 'STOPPING',
  ]),
  providerId: rpcProviderIdSchema.nullable(),
  candidateProviderId: rpcProviderIdSchema.nullable(),
  updatedAt: timestampSchema.nullable(),
  heartbeatAt: timestampSchema.nullable(),
  acknowledgedAt: timestampSchema.nullable(),
  lastObservation: z.object({
    observedAt: timestampSchema,
    slot: websocketSlotSchema,
  }).loose().nullable(),
  disconnect: z.object({
    occurredAt: timestampSchema,
    reasonCode: z.enum([
      'SETUP_TIMEOUT', 'ABORTED', 'SOCKET_ERROR', 'REMOTE_CLOSE', 'PROTOCOL_INVALID',
      'NOTIFICATION_FAILED', 'CLEANUP_FAILED', 'UNEXPECTED_RESTART',
    ]),
  }).loose().nullable(),
  recovery: z.object({
    status: z.enum(['NOT_REQUIRED', 'REQUIRED', 'IN_PROGRESS', 'RECOVERED', 'FAILED']),
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
    reasonCode: z.enum([
      'STARTUP', 'UNEXPECTED_RESTART', 'SESSION_FAILURE', 'RPC_UNAVAILABLE',
      'CHECKPOINT_CONFLICT', 'CATCH_UP_WINDOW_EXCEEDED',
    ]).nullable(),
  }).loose(),
}).loose();
const jobCountsSchema = z.object({
  pendingCount: countSchema,
  leasedCount: countSchema,
  retryableFailedCount: countSchema,
  exhaustedCount: countSchema,
}).loose();
const healthSchema = z.object({
  status: z.enum(['OK', 'DEGRADED']),
  observedAt: timestampSchema,
  postgresql: z.object({ status: z.enum(['AVAILABLE', 'UNAVAILABLE']) }).loose(),
  http: z.object({ status: z.enum(['AVAILABLE', 'UNAVAILABLE']) }).loose(),
  pipeline: z.object({
    pumpfun: z.enum(['IDLE', 'RUNNING', 'DEGRADED', 'STOPPED']),
    pumpswap: z.enum(['IDLE', 'RUNNING', 'DEGRADED', 'STOPPED']),
    paperDecision: z.enum(['IDLE', 'RUNNING', 'DEGRADED', 'STOPPED']),
    qualification: z.enum(['IDLE', 'RUNNING', 'DEGRADED', 'STOPPED']),
    social: z.enum(['IDLE', 'RUNNING', 'DEGRADED', 'STOPPED']),
  }).loose(),
  qualification: z.object({
    currentCount: countSchema,
    lastSuccessAt: timestampSchema.nullable(),
  }).loose(),
  socialJobs: jobCountsSchema,
  paperDecisionJobs: jobCountsSchema.extend({
    lastSuccessAt: timestampSchema.nullable(),
    lastErrorCode: z.enum(['RPC_TRANSIENT', 'QUOTE_UNAVAILABLE', 'LEASE_EXPIRED', 'DECISION_INVALID']).nullable(),
  }).loose(),
  checkpoints: z.object({
    launchpad: unsignedIntegerSchema.nullable(),
    market: unsignedIntegerSchema.nullable(),
  }).loose(),
  heartbeat: z.object({
    runtimeState: runtimeStateSchema.nullish(),
    subscriberState: runtimeStateSchema.nullish(),
    scannerState: runtimeStateSchema.nullish(),
    workerState: runtimeStateSchema.nullish(),
    reconcilerState: runtimeStateSchema.nullish(),
    backlogCount: countSchema.nullish(),
    leasedCount: countSchema.nullish(),
    exhaustedCount: countSchema.nullish(),
    startedAt: timestampSchema.nullable(),
    updatedAt: timestampSchema.nullable(),
    lastHttpSlot: unsignedIntegerSchema.nullable(),
    lastWebsocketSlot: unsignedIntegerSchema.nullable(),
    lastFinalizedSlot: unsignedIntegerSchema.nullable(),
    lastSignature: z.string().nullable(),
    pendingTransactions: countSchema.nullable(),
    activeSessions: countSchema.nullable(),
    websocket: websocketHealthSchema.optional(),
  }).loose(),
  lagSlots: unsignedIntegerSchema.nullable(),
}).loose();

const apiMetaSchema = z.object({
  generatedAt: timestampSchema,
  nextCursor: z.string().nullable(),
}).strict();

function successEnvelope<T extends z.ZodType>(data: T): z.ZodObject<{
  apiVersion: z.ZodLiteral<'v1'>;
  meta: typeof apiMetaSchema;
  data: T;
}> {
  return z.object({ apiVersion: z.literal('v1'), meta: apiMetaSchema, data }).strict();
}

export const apiLaunchListEnvelopeSchema = successEnvelope(z.array(launchSummarySchema));
export const apiLaunchDetailEnvelopeSchema = successEnvelope(launchDetailSchema);
export const apiTimelineEnvelopeSchema = successEnvelope(z.array(timelineEntrySchema));
export const apiQualificationEnvelopeSchema = successEnvelope(qualificationSchema.nullable());
export const apiSocialEnvelopeSchema = successEnvelope(socialSchema);
export const apiHoldersEnvelopeSchema = successEnvelope(holdersSchema);
export const apiPaperPositionListEnvelopeSchema = successEnvelope(z.array(paperPositionSchema));
export const apiHealthEnvelopeSchema = successEnvelope(healthSchema);

export const apiSseEventSchema = z.object({
  eventId: z.string().min(1),
  type: domainEventTypeSchema,
  mint: mintSchema,
  source: z.string().min(1),
  program: z.string().min(1),
  signature: z.string().min(1),
  cursor: cursorSchema,
  confirmationStatus: confirmationStatusSchema,
  blockchainTime: timestampSchema.nullable(),
  observedAt: timestampSchema,
  payloadVersion: versionSchema,
  payload: jsonValueSchema,
}).loose();

export const apiFailureSchema = z.object({
  apiVersion: z.literal('v1'),
  error: z.object({
    code: z.enum([
      'ROUTE_NOT_FOUND', 'METHOD_NOT_ALLOWED', 'NOT_ACCEPTABLE', 'INVALID_MINT',
      'INVALID_LIMIT', 'INVALID_CURSOR', 'LAUNCH_NOT_FOUND', 'EVENT_CURSOR_EXPIRED',
      'DEPENDENCY_UNAVAILABLE', 'INTERNAL_ERROR',
    ]),
    message: z.string().min(1),
    correlationId: z.string().min(1).optional(),
  }).strict(),
}).strict();

export type ApiLaunchSummary = z.infer<typeof launchSummarySchema>;
export type ApiLaunchDetail = z.infer<typeof launchDetailSchema>;
export type ApiTimelineEntry = z.infer<typeof timelineEntrySchema>;
export type ApiQualification = z.infer<typeof qualificationSchema>;
export type ApiSocial = z.infer<typeof socialSchema>;
export type ApiHolders = z.infer<typeof holdersSchema>;
export type ApiPaperPosition = z.infer<typeof paperPositionSchema>;
export type ApiHealth = z.infer<typeof healthSchema>;
export type ApiSseEvent = z.infer<typeof apiSseEventSchema>;
export type ApiFailure = z.infer<typeof apiFailureSchema>;

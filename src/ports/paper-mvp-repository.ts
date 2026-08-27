import type {
  PaperMvpCompletionReason,
  PaperMvpPositionSample,
  PaperMvpProviderUsage,
  PaperMvpReportV2,
} from '../domain/paper-mvp.js';

export interface PaperMvpRunConfiguration {
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly quoteMint: string;
  readonly targetClosedPositions: number;
  readonly initialCapitalRaw: bigint;
  readonly networkFeeRawPerTransaction: bigint;
  readonly maxDurationMs: number;
  readonly entryQuoteAmountRaw: bigint;
  readonly slippageBps: bigint;
  readonly minimumConfirmation: 'confirmed' | 'finalized';
  readonly entryWindowMs: number;
  readonly quoteMaxAgeMs: number;
  readonly quoteMaxSlotLag: number;
  readonly creationEntryMaxAgeMs: number;
  readonly creationEntryMaxSlotLag: number;
  readonly externalMinimumBuyAmountRaw: bigint;
  readonly externalUniqueBuyersTarget: number;
  readonly takeProfitMultiplierBps: bigint;
  readonly manualKillSwitch: boolean;
  readonly maximumRoundTripLossBps: bigint;
  readonly decisionPollIntervalMs: number;
  readonly decisionLeaseMs: number;
  readonly decisionRetryMaxAttempts: number;
  readonly decisionRetryBaseDelayMs: number;
  readonly qualificationProfileFingerprint: string;
  readonly providerIdentity: string;
}

export interface PaperMvpRunCounters {
  readonly creationsObserved: number;
  readonly entriesRejected: number;
  readonly unknownTerminalPositions: number;
  readonly duplicateLogicalBuys: number;
  readonly duplicateLogicalSells: number;
  readonly openedPositions?: number;
  readonly openPositions?: number;
}

export type PaperMvpProgressCounters = Omit<
  PaperMvpRunCounters,
  'unknownTerminalPositions'
>;

export type PaperMvpUnknownReason =
  | 'MISSING_CREATION_DETECTED_AT' | 'MISSING_ENTRY_DECISION_AT'
  | 'MISSING_ENTRY_QUOTE_AT' | 'MISSING_PAPER_BUY_AT'
  | 'MISSING_EXIT_TRIGGER_AT' | 'MISSING_EXIT_QUOTE_AT'
  | 'MISSING_PAPER_SELL_AT' | 'INVALID_TIMESTAMP_ORDER'
  | 'MISSING_BUY_TRADE' | 'MISSING_SELL_TRADE'
  | 'UNSUPPORTED_EXIT_REASON' | 'SOURCE_CONTRADICTION'
  | 'POSITION_RETRACTED';

export interface PaperMvpUnknownPosition {
  readonly positionId: string;
  readonly reason: PaperMvpUnknownReason;
}

export interface PaperMvpRun {
  readonly runId: string;
  readonly runnerOwnerId: string | null;
  readonly completionReason: PaperMvpCompletionReason | null;
  readonly configuration: PaperMvpRunConfiguration;
  readonly state: 'RUNNING' | 'COMPLETED' | 'FAILED';
  readonly counters: PaperMvpRunCounters;
  readonly providerUsage: PaperMvpProviderUsage;
  readonly closedPositions: number;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly updatedAtMs: number;
  readonly terminalAtMs: number | null;
  readonly purgeAfterMs: number | null;
  readonly verdict: 'PASS' | 'FAIL' | null;
  readonly failureCode: string | null;
}

export interface PaperMvpProgress {
  readonly runId: string;
  readonly runnerOwnerId: string;
  readonly expectedUpdatedAtMs: number;
  readonly observedAtMs: number;
  readonly counters: PaperMvpProgressCounters;
  readonly providerUsage: PaperMvpProviderUsage;
  readonly samples: readonly PaperMvpPositionSample[];
  readonly unknownPositions: readonly PaperMvpUnknownPosition[];
}

export type PaperMvpTerminalization =
  | Readonly<{
    runId: string;
    runnerOwnerId: string;
    terminalAtMs: number;
    state: 'COMPLETED';
    completionReason: Exclude<PaperMvpCompletionReason, 'LEGACY'>;
    report: PaperMvpReportV2;
    failureCode: null;
  }>
  | Readonly<{
    runId: string;
    runnerOwnerId: string;
    terminalAtMs: number;
    state: 'FAILED';
    completionReason: null;
    report: null;
    failureCode: string;
  }>;

export interface PaperMvpRunSnapshot {
  readonly run: PaperMvpRun;
  readonly samples: readonly PaperMvpPositionSample[];
  readonly unknownPositions: readonly PaperMvpUnknownPosition[];
}

export interface PaperMvpRepository {
  startOrResume(
    configuration: PaperMvpRunConfiguration,
    runnerOwnerId: string,
    nowMs: number,
  ): Promise<PaperMvpRun>;
  recordProgress(progress: PaperMvpProgress): Promise<PaperMvpRun>;
  load(runId: string): Promise<PaperMvpRunSnapshot | null>;
  terminalize(terminalization: PaperMvpTerminalization): Promise<PaperMvpRun>;
}

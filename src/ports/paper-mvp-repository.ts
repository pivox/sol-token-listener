import type {
  PaperMvpPositionSample,
  PaperMvpProviderUsage,
  PaperMvpReportV1,
} from '../domain/paper-mvp.js';

export interface PaperMvpRunConfiguration {
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly quoteMint: string;
  readonly targetClosedPositions: number;
  readonly initialCapitalRaw: bigint;
  readonly networkFeeRawPerTransaction: bigint;
  readonly maxDurationMs: number;
  readonly providerIdentity: string;
}

export interface PaperMvpRunCounters {
  readonly creationsObserved: number;
  readonly entriesRejected: number;
  readonly unknownTerminalPositions: number;
  readonly duplicateLogicalBuys: number;
  readonly duplicateLogicalSells: number;
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
  | 'UNSUPPORTED_EXIT_REASON' | 'SOURCE_CONTRADICTION';

export interface PaperMvpUnknownPosition {
  readonly positionId: string;
  readonly reason: PaperMvpUnknownReason;
}

export interface PaperMvpRun {
  readonly runId: string;
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
  readonly observedAtMs: number;
  readonly counters: PaperMvpProgressCounters;
  readonly providerUsage: PaperMvpProviderUsage;
  readonly samples: readonly PaperMvpPositionSample[];
  readonly unknownPositions: readonly PaperMvpUnknownPosition[];
}

export type PaperMvpTerminalization =
  | Readonly<{
    runId: string;
    terminalAtMs: number;
    state: 'COMPLETED';
    report: PaperMvpReportV1;
    failureCode: null;
  }>
  | Readonly<{
    runId: string;
    terminalAtMs: number;
    state: 'FAILED';
    report: null;
    failureCode: string;
  }>;

export interface PaperMvpRunSnapshot {
  readonly run: PaperMvpRun;
  readonly samples: readonly PaperMvpPositionSample[];
  readonly unknownPositions: readonly PaperMvpUnknownPosition[];
}

export interface PaperMvpRepository {
  startOrResume(configuration: PaperMvpRunConfiguration, nowMs: number): Promise<PaperMvpRun>;
  recordProgress(progress: PaperMvpProgress): Promise<PaperMvpRun>;
  load(runId: string): Promise<PaperMvpRunSnapshot | null>;
  terminalize(terminalization: PaperMvpTerminalization): Promise<PaperMvpRun>;
}

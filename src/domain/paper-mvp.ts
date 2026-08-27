import { assertValidTimestampMs } from './timestamp.js';

const BPS = 10_000n;
const MAX_COUNT = 1_000_000;
const EXIT_REASONS = [
  'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED',
  'TAKE_PROFIT_2X_EXECUTABLE',
  'CREATOR_EARLY_SELL',
  'MANUAL_KILL_SWITCH',
] as const;

export type PaperMvpExitReason = (typeof EXIT_REASONS)[number];
export type PaperMvpExitCategory = '10_UNIQUE_BUYERS' | '2X' | 'SAFETY';
export type PaperMvpCompletionReason =
  | 'TARGET_REACHED' | 'TIMEOUT' | 'SIGINT' | 'SIGTERM' | 'LEGACY';
export type PaperMvpGateCode =
  | 'CLOSED_POSITIONS_BELOW_TARGET'
  | 'NET_PNL_NOT_POSITIVE'
  | 'MAX_DRAWDOWN_EXCEEDED'
  | 'UNKNOWN_TERMINAL_POSITIONS'
  | 'DUPLICATE_LOGICAL_BUYS'
  | 'DUPLICATE_LOGICAL_SELLS'
  | 'UNSUPPORTED_QUOTE_MINT'
  | 'PROVIDER_USAGE_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'RUN_TIMED_OUT'
  | 'RUN_INTERRUPTED';

export interface PaperMvpPositionSampleInput {
  readonly positionId: string;
  readonly mint: string;
  readonly quoteMint: string;
  readonly exitReason: PaperMvpExitReason;
  readonly creationDetectedAtMs: number;
  readonly entryDecisionAtMs: number;
  readonly entryQuoteAtMs: number;
  readonly paperBuyAtMs: number;
  readonly exitTriggerAtMs: number;
  readonly exitQuoteAtMs: number;
  readonly paperSellAtMs: number;
  readonly buyAmountInRaw: bigint;
  readonly buyAmountOutRaw: bigint;
  readonly buyMinimumAmountOutRaw: bigint;
  readonly buyFeesRaw: bigint;
  readonly buySlippageBps: bigint;
  readonly buyPriceImpactBps: bigint;
  readonly sellAmountInRaw: bigint;
  readonly sellAmountOutRaw: bigint;
  readonly sellMinimumAmountOutRaw: bigint;
  readonly sellFeesRaw: bigint;
  readonly sellSlippageBps: bigint;
  readonly sellPriceImpactBps: bigint;
  readonly networkFeeRawPerTransaction: bigint;
}

export interface PaperMvpPositionSample extends PaperMvpPositionSampleInput {
  readonly exitCategory: PaperMvpExitCategory;
  readonly grossPnlRaw: bigint;
  readonly modelNetPnlRaw: bigint;
  readonly detectionToEntryLatencyMs: number;
  readonly exitTriggerToSellLatencyMs: number;
  readonly payloadVersion: 1;
}

export interface PaperMvpProviderUsage {
  readonly status: 'AVAILABLE' | 'UNAVAILABLE';
  readonly creditsUsedStart: bigint | null;
  readonly creditsUsedEnd: bigint | null;
  readonly rateLimitedCount: number;
}

export interface CreatePaperMvpReportInput {
  readonly runId: string;
  readonly completionReason: PaperMvpCompletionReason;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly targetClosedPositions: number;
  readonly initialCapitalRaw: bigint;
  readonly quoteMint: string;
  readonly creationsObserved: number;
  readonly entriesRejected: number;
  readonly openedPositions?: number;
  readonly openPositions?: number;
  readonly samples: readonly PaperMvpPositionSample[];
  readonly unknownTerminalPositions: number;
  readonly duplicateLogicalBuys: number;
  readonly duplicateLogicalSells: number;
  readonly providerUsage: PaperMvpProviderUsage;
}

export interface PaperMvpReportV1 {
  readonly schemaVersion: 'paper-mvp.v1';
  readonly runId: string;
  readonly completionReason: PaperMvpCompletionReason;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly technicalStatus: 'COMPLETED' | 'DEGRADED';
  readonly verdict: 'PASS' | 'FAIL';
  readonly targetClosedPositions: number;
  readonly closedPositions: number;
  readonly creationsObserved: number;
  readonly entriesRejected: number;
  readonly exitCounts: Readonly<Record<PaperMvpExitCategory, number>>;
  readonly grossPnlRaw: string;
  readonly netPnlRaw: string;
  readonly meanNetPnlRaw: string;
  readonly winRateBps: number;
  readonly maximumDrawdownBps: number;
  readonly detectionToEntryLatencyMeanMs: number;
  readonly detectionToEntryLatencyP95Ms: number;
  readonly venueFeesRaw: string;
  readonly networkFeesRaw: string;
  readonly unknownTerminalPositions: number;
  readonly duplicateLogicalBuys: number;
  readonly duplicateLogicalSells: number;
  readonly creditsUsedStartRaw: string | null;
  readonly creditsUsedEndRaw: string | null;
  readonly creditsPerClosedPositionRaw: string | null;
  readonly rateLimitedCount: number;
  readonly failedGateCodes: readonly PaperMvpGateCode[];
}

export interface PaperMvpReportV2 extends Omit<PaperMvpReportV1, 'schemaVersion'> {
  readonly schemaVersion: 'paper-mvp.v2';
  readonly openedPositions: number;
  readonly openPositions: number;
  readonly averageBuySlippageBps: number;
  readonly averageSellSlippageBps: number;
  readonly averageBuyPriceImpactBps: number;
  readonly averageSellPriceImpactBps: number;
}

export function createPaperMvpPositionSample(
  input: PaperMvpPositionSampleInput,
): PaperMvpPositionSample {
  for (const value of [input.positionId, input.mint, input.quoteMint]) boundedText(value);
  if (!EXIT_REASONS.includes(input.exitReason)) throw invalid('exit reason');
  const times = [
    input.creationDetectedAtMs, input.entryDecisionAtMs, input.entryQuoteAtMs,
    input.paperBuyAtMs, input.exitTriggerAtMs, input.exitQuoteAtMs, input.paperSellAtMs,
  ];
  for (const time of times) assertValidTimestampMs('occurredAtMs', time);
  if (
    input.creationDetectedAtMs > input.entryDecisionAtMs
    || input.entryDecisionAtMs > input.entryQuoteAtMs
    || input.entryQuoteAtMs > input.paperBuyAtMs
    || input.paperBuyAtMs > input.exitTriggerAtMs
    || input.exitTriggerAtMs > input.exitQuoteAtMs
    || input.exitQuoteAtMs > input.paperSellAtMs
  ) throw invalid('causal time');
  positive(input.buyAmountInRaw, 'buy amount in');
  positive(input.buyAmountOutRaw, 'buy amount out');
  positive(input.buyMinimumAmountOutRaw, 'buy minimum amount out');
  positive(input.sellAmountInRaw, 'sell amount in');
  positive(input.sellAmountOutRaw, 'sell amount out');
  positive(input.sellMinimumAmountOutRaw, 'sell minimum amount out');
  nonNegative(input.buyFeesRaw, 'buy fees');
  nonNegative(input.sellFeesRaw, 'sell fees');
  nonNegative(input.networkFeeRawPerTransaction, 'network fee');
  for (const value of [
    input.buySlippageBps, input.buyPriceImpactBps,
    input.sellSlippageBps, input.sellPriceImpactBps,
  ]) if (value < 0n || value > BPS) throw invalid('basis points');
  if (
    input.buyMinimumAmountOutRaw > input.buyAmountOutRaw
    || input.sellMinimumAmountOutRaw > input.sellAmountOutRaw
    || input.sellAmountInRaw !== input.buyMinimumAmountOutRaw
  ) throw invalid('quote amounts');
  return Object.freeze({
    ...input,
    exitCategory: exitCategory(input.exitReason),
    grossPnlRaw: input.sellAmountOutRaw - input.buyAmountInRaw,
    modelNetPnlRaw: input.sellMinimumAmountOutRaw
      - input.buyAmountInRaw - 2n * input.networkFeeRawPerTransaction,
    detectionToEntryLatencyMs: input.paperBuyAtMs - input.creationDetectedAtMs,
    exitTriggerToSellLatencyMs: input.paperSellAtMs - input.exitTriggerAtMs,
    payloadVersion: 1,
  });
}

export function createPaperMvpReport(input: CreatePaperMvpReportInput): PaperMvpReportV2 {
  boundedText(input.runId);
  if (!isCompletionReason(input.completionReason)) throw invalid('completion reason');
  boundedText(input.quoteMint);
  assertValidTimestampMs('occurredAtMs', input.startedAtMs);
  assertValidTimestampMs('occurredAtMs', input.completedAtMs);
  if (input.completedAtMs < input.startedAtMs) throw invalid('report time');
  count(input.targetClosedPositions, 1, 1_000);
  positive(input.initialCapitalRaw, 'initial capital');
  const openedPositions = input.openedPositions ?? 0;
  const openPositions = input.openPositions ?? 0;
  for (const value of [
    input.creationsObserved, input.entriesRejected, openedPositions, openPositions,
    input.unknownTerminalPositions,
    input.duplicateLogicalBuys, input.duplicateLogicalSells,
  ]) count(value, 0, MAX_COUNT);
  if (openPositions > openedPositions) throw invalid('open positions');
  if (input.samples.length > 1_000) throw invalid('sample count');
  const ids = new Set<string>();
  let gross = 0n;
  let net = 0n;
  let wins = 0;
  let venueFees = 0n;
  let networkFees = 0n;
  const latencies: number[] = [];
  const exitCounts: Record<PaperMvpExitCategory, number> = {
    '10_UNIQUE_BUYERS': 0, '2X': 0, SAFETY: 0,
  };
  const ordered = input.samples.map(validateSample).sort((left, right) => (
    left.paperSellAtMs - right.paperSellAtMs || left.positionId.localeCompare(right.positionId)
  ));
  let unsupportedQuote = false;
  for (const sample of ordered) {
    if (ids.has(sample.positionId)) throw invalid('duplicate sample');
    ids.add(sample.positionId);
    if (sample.quoteMint !== input.quoteMint) unsupportedQuote = true;
    gross += sample.grossPnlRaw;
    net += sample.modelNetPnlRaw;
    if (sample.modelNetPnlRaw > 0n) wins += 1;
    venueFees += sample.buyFeesRaw + sample.sellFeesRaw;
    networkFees += 2n * sample.networkFeeRawPerTransaction;
    latencies.push(sample.detectionToEntryLatencyMs);
    exitCounts[sample.exitCategory] += 1;
  }
  const drawdown = maximumDrawdownBps(input.initialCapitalRaw, ordered);
  const failed: PaperMvpGateCode[] = [];
  if (ordered.length < input.targetClosedPositions) failed.push('CLOSED_POSITIONS_BELOW_TARGET');
  if (net <= 0n) failed.push('NET_PNL_NOT_POSITIVE');
  if (drawdown > 2_500) failed.push('MAX_DRAWDOWN_EXCEEDED');
  if (input.unknownTerminalPositions !== 0) failed.push('UNKNOWN_TERMINAL_POSITIONS');
  if (input.duplicateLogicalBuys !== 0) failed.push('DUPLICATE_LOGICAL_BUYS');
  if (input.duplicateLogicalSells !== 0) failed.push('DUPLICATE_LOGICAL_SELLS');
  if (unsupportedQuote) failed.push('UNSUPPORTED_QUOTE_MINT');
  const usage = validateProviderUsage(input.providerUsage);
  if (usage.status === 'UNAVAILABLE') failed.push('PROVIDER_USAGE_UNAVAILABLE');
  if (usage.rateLimitedCount !== 0) failed.push('PROVIDER_RATE_LIMITED');
  if (input.completionReason === 'TIMEOUT') failed.push('RUN_TIMED_OUT');
  if (input.completionReason === 'SIGINT' || input.completionReason === 'SIGTERM') {
    failed.push('RUN_INTERRUPTED');
  }
  const nonTargetCompletion = input.completionReason !== 'TARGET_REACHED'
    && input.completionReason !== 'LEGACY';
  const credits = usage.creditsUsedStart === null || usage.creditsUsedEnd === null
    ? null : usage.creditsUsedEnd - usage.creditsUsedStart;
  const completed = ordered.length;
  return Object.freeze({
    schemaVersion: 'paper-mvp.v2', runId: input.runId,
    completionReason: input.completionReason,
    startedAt: new Date(input.startedAtMs).toISOString(),
    completedAt: new Date(input.completedAtMs).toISOString(),
    technicalStatus: !nonTargetCompletion
      && usage.status === 'AVAILABLE' && usage.rateLimitedCount === 0
      ? 'COMPLETED' : 'DEGRADED',
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    targetClosedPositions: input.targetClosedPositions, closedPositions: completed,
    creationsObserved: input.creationsObserved, entriesRejected: input.entriesRejected,
    openedPositions, openPositions,
    exitCounts: Object.freeze(exitCounts), grossPnlRaw: gross.toString(), netPnlRaw: net.toString(),
    meanNetPnlRaw: (completed === 0 ? 0n : net / BigInt(completed)).toString(),
    winRateBps: completed === 0 ? 0 : Number(BigInt(wins) * BPS / BigInt(completed)),
    maximumDrawdownBps: drawdown,
    detectionToEntryLatencyMeanMs: integerMean(latencies),
    detectionToEntryLatencyP95Ms: nearestRank(latencies, 95),
    averageBuySlippageBps: integerBigintMean(ordered.map((sample) => sample.buySlippageBps)),
    averageSellSlippageBps: integerBigintMean(ordered.map((sample) => sample.sellSlippageBps)),
    averageBuyPriceImpactBps: integerBigintMean(ordered.map((sample) => sample.buyPriceImpactBps)),
    averageSellPriceImpactBps: integerBigintMean(ordered.map((sample) => sample.sellPriceImpactBps)),
    venueFeesRaw: venueFees.toString(), networkFeesRaw: networkFees.toString(),
    unknownTerminalPositions: input.unknownTerminalPositions,
    duplicateLogicalBuys: input.duplicateLogicalBuys,
    duplicateLogicalSells: input.duplicateLogicalSells,
    creditsUsedStartRaw: usage.creditsUsedStart?.toString() ?? null,
    creditsUsedEndRaw: usage.creditsUsedEnd?.toString() ?? null,
    creditsPerClosedPositionRaw: credits === null || completed === 0
      ? null : (credits / BigInt(completed)).toString(),
    rateLimitedCount: usage.rateLimitedCount,
    failedGateCodes: Object.freeze(failed),
  });
}

function isCompletionReason(value: unknown): value is PaperMvpCompletionReason {
  return value === 'TARGET_REACHED' || value === 'TIMEOUT' || value === 'SIGINT'
    || value === 'SIGTERM' || value === 'LEGACY';
}

function validateSample(sample: PaperMvpPositionSample): PaperMvpPositionSample {
  const canonical = createPaperMvpPositionSample(sample);
  const payloadVersion: unknown = sample.payloadVersion;
  if (
    payloadVersion !== 1
    || sample.exitCategory !== canonical.exitCategory
    || sample.grossPnlRaw !== canonical.grossPnlRaw
    || sample.modelNetPnlRaw !== canonical.modelNetPnlRaw
    || sample.detectionToEntryLatencyMs !== canonical.detectionToEntryLatencyMs
    || sample.exitTriggerToSellLatencyMs !== canonical.exitTriggerToSellLatencyMs
  ) throw invalid('sample projection');
  return canonical;
}

function maximumDrawdownBps(
  initialCapital: bigint,
  samples: readonly PaperMvpPositionSample[],
): number {
  let equity = initialCapital;
  let peak = initialCapital;
  let maximum = 0n;
  for (const sample of samples) {
    equity += sample.modelNetPnlRaw;
    if (equity > peak) peak = equity;
    const drawdown = equity <= 0n ? BPS : ((peak - equity) * BPS + peak - 1n) / peak;
    if (drawdown > maximum) maximum = drawdown;
  }
  return Number(maximum > BPS ? BPS : maximum);
}

function validateProviderUsage(value: PaperMvpProviderUsage): PaperMvpProviderUsage {
  count(value.rateLimitedCount, 0, MAX_COUNT);
  const status: unknown = value.status;
  if (status === 'UNAVAILABLE') {
    if (value.creditsUsedStart !== null || value.creditsUsedEnd !== null) throw invalid('provider usage');
  } else if (status === 'AVAILABLE') {
    if (value.creditsUsedStart === null || value.creditsUsedEnd === null
      || value.creditsUsedStart < 0n || value.creditsUsedEnd < value.creditsUsedStart) {
      throw invalid('provider usage');
    }
  } else throw invalid('provider status');
  return Object.freeze({ ...value });
}

function exitCategory(reason: PaperMvpExitReason): PaperMvpExitCategory {
  if (reason === 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED') return '10_UNIQUE_BUYERS';
  if (reason === 'TAKE_PROFIT_2X_EXECUTABLE') return '2X';
  return 'SAFETY';
}

function integerMean(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.floor(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function integerBigintMean(values: readonly bigint[]): number {
  if (values.length === 0) return 0;
  return Number(values.reduce((sum, value) => sum + value, 0n) / BigInt(values.length));
}

function nearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length / 100) - 1] ?? 0;
}

function count(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid('count');
}

function positive(value: bigint, field: string): void {
  if (typeof value !== 'bigint' || value <= 0n) throw invalid(field);
}

function nonNegative(value: bigint, field: string): void {
  if (typeof value !== 'bigint' || value < 0n) throw invalid(field);
}

function boundedText(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > 512) throw invalid('text');
}

function invalid(field: string): TypeError {
  return new TypeError(`Paper MVP ${field} is invalid.`);
}

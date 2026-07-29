import { assertValidChainCursor, compareCursors } from './cursor.js';
import { assertValidTimestampMs } from './timestamp.js';
import type { ChainCursor, QuoteAsset } from './types.js';

export const PARTICIPANT_ANALYTICS_PAYLOAD_VERSION = 1 as const;
export const HOLDER_CONCENTRATION_SCALE_BPS = 10_000n;
export const PARTICIPANT_ANALYTICS_CONFIRMATION_ORDER = [
  'processed',
  'confirmed',
  'finalized',
] as const;

export type ActiveParticipantConfirmationStatus =
  (typeof PARTICIPANT_ANALYTICS_CONFIRMATION_ORDER)[number];

export interface ParticipantAnalyticsLaunch {
  readonly eventId: string;
  readonly mint: string;
  readonly creator: string;
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ActiveParticipantConfirmationStatus;
  readonly observedAtMs: number;
}

export interface ParticipantAnalyticsTrade {
  readonly eventId: string;
  readonly tradeId: string;
  readonly launchMint: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ActiveParticipantConfirmationStatus;
  readonly observedAtMs: number;
  readonly kind: 'BUY' | 'SELL';
  readonly trader: string | null;
  readonly baseAmountRaw: bigint;
  readonly quoteAmountRaw: bigint;
  readonly quoteAsset: QuoteAsset;
}

export interface ParticipantAnalyticsInput {
  readonly launch: ParticipantAnalyticsLaunch;
  readonly trades: readonly ParticipantAnalyticsTrade[];
  readonly inputFingerprint: string;
}

export interface ParticipantQuoteFlow {
  readonly quoteAsset: QuoteAsset;
  readonly boughtQuoteRaw: bigint;
  readonly soldQuoteRaw: bigint;
}

export interface CreatorTradeEvidence {
  readonly eventId: string;
  readonly tradeId: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly baseAmountRaw: bigint;
  readonly quoteAmountRaw: bigint;
  readonly quoteAsset: QuoteAsset;
}

export type CreatorInitialBuy = CreatorTradeEvidence;
export type CreatorFirstSell = CreatorTradeEvidence;

export interface CreatorProfile {
  readonly mint: string;
  readonly creator: string;
  readonly payloadVersion: typeof PARTICIPANT_ANALYTICS_PAYLOAD_VERSION;
  readonly inputFingerprint: string;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly totalBoughtBaseRaw: bigint;
  readonly totalSoldBaseRaw: bigint;
  readonly observedNetBaseRaw: bigint;
  readonly hasSold: boolean;
  readonly firstSell: CreatorFirstSell | null;
  readonly initialBuys: readonly CreatorInitialBuy[];
  readonly quoteFlows: readonly ParticipantQuoteFlow[];
  readonly uniqueExternalBuyers: number;
  readonly unknownTraderTradeCount: number;
}

export interface ObservedWalletPosition {
  readonly wallet: string;
  readonly isCreator: boolean;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly boughtBaseRaw: bigint;
  readonly soldBaseRaw: bigint;
  readonly observedNetBaseRaw: bigint;
  readonly quoteFlows: readonly ParticipantQuoteFlow[];
  readonly firstObservedCursor: ChainCursor;
  readonly lastObservedCursor: ChainCursor;
}

export interface HolderDistribution {
  readonly mint: string;
  readonly creator: string;
  readonly payloadVersion: typeof PARTICIPANT_ANALYTICS_PAYLOAD_VERSION;
  readonly inputFingerprint: string;
  readonly positions: readonly ObservedWalletPosition[];
  readonly totalPositiveNetBaseRaw: bigint;
  readonly top1Bps: bigint;
  readonly top5Bps: bigint;
  readonly top10Bps: bigint;
  readonly creatorBps: bigint;
  readonly uniqueKnownBuyers: number;
  readonly uniqueExternalBuyers: number;
  readonly positivePositionCount: number;
  readonly unknownTraderTradeCount: number;
}

export interface ParticipantAnalyticsAsOf {
  readonly eventId: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly observedAtMs: number;
}

export interface ParticipantConfirmationCounts {
  readonly processed: number;
  readonly confirmed: number;
  readonly finalized: number;
}

export interface ParticipantAnalyticsProjection {
  readonly launch: ParticipantAnalyticsLaunch;
  readonly inputFingerprint: string;
  readonly asOf: ParticipantAnalyticsAsOf;
  readonly confirmationStatus: ActiveParticipantConfirmationStatus;
  readonly confirmationCounts: ParticipantConfirmationCounts;
  readonly profile: CreatorProfile;
  readonly distribution: HolderDistribution;
}

export function compareParticipantTrades(
  left: ParticipantAnalyticsTrade,
  right: ParticipantAnalyticsTrade,
): number {
  const cursorOrder = compareCursors(left.cursor, right.cursor);
  if (cursorOrder !== 0) return cursorOrder;
  return left.tradeId.localeCompare(right.tradeId);
}

export function assertValidParticipantAnalyticsInput(
  input: ParticipantAnalyticsInput,
): void {
  assertFrozen(input, 'input');
  assertText(input.inputFingerprint, 'inputFingerprint');
  assertValidLaunch(input.launch);
  assertFrozen(input.trades, 'trades');
  const eventIds = new Set<string>();
  const tradeIds = new Set<string>();
  const cursors = new Set<string>();
  for (const trade of input.trades) {
    assertFrozen(trade, 'trade');
    assertText(trade.eventId, 'trade.eventId');
    assertText(trade.tradeId, 'trade.tradeId');
    assertText(trade.signature, 'trade.signature');
    if (trade.launchMint !== input.launch.mint) {
      throw new TypeError('Trade mint does not match analytics launch.');
    }
    assertActiveConfirmation(trade.confirmationStatus);
    assertValidTimestampMs('observedAtMs', trade.observedAtMs);
    assertFrozen(trade.cursor, 'trade.cursor');
    assertValidChainCursor(trade.cursor);
    assertAmount(trade.baseAmountRaw, 'trade.baseAmountRaw');
    assertAmount(trade.quoteAmountRaw, 'trade.quoteAmountRaw');
    if (trade.kind !== 'BUY' && trade.kind !== 'SELL') {
      throw new TypeError('Trade kind is invalid.');
    }
    if (trade.trader !== null) assertText(trade.trader, 'trade.trader');
    assertQuoteAsset(trade.quoteAsset);
    const cursorKey = [
      trade.cursor.slot,
      trade.cursor.transactionIndex,
      trade.cursor.instructionIndex,
      trade.cursor.innerInstructionIndex ?? 'outer',
    ].join(':');
    if (eventIds.has(trade.eventId) || tradeIds.has(trade.tradeId) || cursors.has(cursorKey)) {
      throw new TypeError('Participant analytics trades must be unique.');
    }
    eventIds.add(trade.eventId);
    tradeIds.add(trade.tradeId);
    cursors.add(cursorKey);
  }
}

export function assertValidCreatorProfile(profile: CreatorProfile): void {
  assertFrozen(profile, 'profile');
  assertText(profile.mint, 'profile.mint');
  assertText(profile.creator, 'profile.creator');
  assertText(profile.inputFingerprint, 'profile.inputFingerprint');
  if (profile.payloadVersion !== PARTICIPANT_ANALYTICS_PAYLOAD_VERSION) {
    throw new TypeError('Creator profile payload version is invalid.');
  }
  assertCount(profile.buyCount, 'profile.buyCount');
  assertCount(profile.sellCount, 'profile.sellCount');
  assertAmount(profile.totalBoughtBaseRaw, 'profile.totalBoughtBaseRaw');
  assertAmount(profile.totalSoldBaseRaw, 'profile.totalSoldBaseRaw');
  assertCount(profile.uniqueExternalBuyers, 'profile.uniqueExternalBuyers');
  assertCount(profile.unknownTraderTradeCount, 'profile.unknownTraderTradeCount');
  if (profile.hasSold !== (profile.sellCount > 0)) {
    throw new TypeError('Creator profile sell evidence is inconsistent.');
  }
  assertFrozen(profile.initialBuys, 'profile.initialBuys');
  assertFrozen(profile.quoteFlows, 'profile.quoteFlows');
}

export function assertValidHolderDistribution(
  distribution: HolderDistribution,
): void {
  assertFrozen(distribution, 'distribution');
  assertText(distribution.mint, 'distribution.mint');
  assertText(distribution.creator, 'distribution.creator');
  assertText(distribution.inputFingerprint, 'distribution.inputFingerprint');
  if (distribution.payloadVersion !== PARTICIPANT_ANALYTICS_PAYLOAD_VERSION) {
    throw new TypeError('Holder distribution payload version is invalid.');
  }
  assertFrozen(distribution.positions, 'distribution.positions');
  assertAmount(distribution.totalPositiveNetBaseRaw, 'distribution.totalPositiveNetBaseRaw');
  for (const [name, value] of [
    ['top1Bps', distribution.top1Bps],
    ['top5Bps', distribution.top5Bps],
    ['top10Bps', distribution.top10Bps],
    ['creatorBps', distribution.creatorBps],
  ] as const) {
    assertAmount(value, name);
    if (value > HOLDER_CONCENTRATION_SCALE_BPS) {
      throw new TypeError(`${name} exceeds the concentration scale.`);
    }
  }
  assertCount(distribution.uniqueKnownBuyers, 'distribution.uniqueKnownBuyers');
  assertCount(distribution.uniqueExternalBuyers, 'distribution.uniqueExternalBuyers');
  assertCount(distribution.positivePositionCount, 'distribution.positivePositionCount');
  assertCount(distribution.unknownTraderTradeCount, 'distribution.unknownTraderTradeCount');
}

function assertValidLaunch(launch: ParticipantAnalyticsLaunch): void {
  assertFrozen(launch, 'launch');
  for (const [name, value] of [
    ['eventId', launch.eventId],
    ['mint', launch.mint],
    ['creator', launch.creator],
    ['source', launch.source],
    ['program', launch.program],
    ['signature', launch.signature],
  ] as const) assertText(value, `launch.${name}`);
  assertActiveConfirmation(launch.confirmationStatus);
  assertValidTimestampMs('observedAtMs', launch.observedAtMs);
  assertFrozen(launch.cursor, 'launch.cursor');
  assertValidChainCursor(launch.cursor);
}

function assertQuoteAsset(asset: QuoteAsset): void {
  assertFrozen(asset, 'quoteAsset');
  assertText(asset.mint, 'quoteAsset.mint');
  if (!Number.isSafeInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255) {
    throw new TypeError('Quote asset decimals are invalid.');
  }
  if (asset.tokenProgram !== 'SPL_TOKEN' && asset.tokenProgram !== 'TOKEN_2022') {
    throw new TypeError('Quote token program is invalid.');
  }
}

function assertActiveConfirmation(value: string): void {
  if (!(PARTICIPANT_ANALYTICS_CONFIRMATION_ORDER as readonly string[]).includes(value)) {
    throw new TypeError('Participant analytics confirmation status is invalid.');
  }
}

function assertAmount(value: bigint, name: string): void {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new TypeError(`${name} must be a non-negative bigint.`);
  }
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
}

function assertText(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
}

function assertFrozen(value: object, name: string): void {
  if (!Object.isFrozen(value)) throw new TypeError(`${name} must be frozen.`);
}

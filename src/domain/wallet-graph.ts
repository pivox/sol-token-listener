import { createHash } from 'node:crypto';
import { assertValidChainCursor } from './cursor.js';
import {
  assertValidParticipantAnalyticsInput,
  type ActiveParticipantConfirmationStatus,
  type ObservedWalletPosition,
  type ParticipantAnalyticsLaunch,
  type ParticipantAnalyticsTrade,
} from './participant-analytics.js';
import { assertValidTimestampMs } from './timestamp.js';
import type { ChainCursor, QuoteAsset } from './types.js';
import {
  assertValidWalletFundingExtractionResult,
  type WalletFundingAssessment,
  type WalletFundingConfidence,
  type WalletFundingEvidence,
  type WalletFundingEvidenceType,
} from './wallet-funding.js';

export const WALLET_GRAPH_PAYLOAD_VERSION = 1 as const;
export const WALLET_GRAPH_CONCENTRATION_SCALE_BPS = 10_000n;
export const WALLET_GRAPH_METHODOLOGY =
  'OBSERVED_PUMPFUN_TRANSACTIONS' as const;

export interface WalletGraphInput {
  readonly launch: ParticipantAnalyticsLaunch;
  readonly participantInputFingerprint: string;
  readonly participantAsOf: WalletGraphAsOf | null;
  readonly participantConfirmationStatus:
    ActiveParticipantConfirmationStatus | null;
  readonly positions: readonly ObservedWalletPosition[];
  readonly buys: readonly ParticipantAnalyticsTrade[];
  readonly assessments: readonly WalletFundingAssessment[];
  readonly evidence: readonly WalletFundingEvidence[];
  readonly inputFingerprint: string;
}

export interface WalletGraphQuoteTotal {
  readonly quoteAsset: QuoteAsset;
  readonly amountRaw: bigint;
}

export interface WalletRelationship {
  readonly id: string;
  readonly mint: string;
  readonly leftWallet: string;
  readonly rightWallet: string;
  readonly type: WalletFundingEvidenceType;
  readonly confidence: WalletFundingConfidence;
  readonly evidenceCount: number;
  readonly quoteTotals: readonly WalletGraphQuoteTotal[];
}

export interface WalletClusterMember {
  readonly wallet: string;
  readonly role: 'PARTICIPANT' | 'AUXILIARY_FUNDER';
  readonly isCreator: boolean;
  readonly observedNetBaseRaw: bigint;
}

export interface WalletCluster {
  readonly id: string;
  readonly mint: string;
  readonly members: readonly WalletClusterMember[];
  readonly participantWalletCount: number;
  readonly auxiliaryWalletCount: number;
  readonly positiveHolderCount: number;
  readonly observedPositiveBaseRaw: bigint;
  readonly concentrationBps: bigint;
  readonly containsCreator: boolean;
  readonly sharedFunderCount: number;
  readonly strongRelationshipCount: number;
  readonly strongEvidenceCount: number;
}

export interface WalletGraphCoverage {
  readonly knownBuyCount: number;
  readonly knownBuyerCount: number;
  readonly strongEvidenceBuyCount: number;
  readonly strongEvidenceBuyerCount: number;
  readonly mediumOnlyBuyCount: number;
  readonly mediumOnlyBuyerCount: number;
  readonly noEvidenceBuyCount: number;
  readonly noEvidenceBuyerCount: number;
  readonly unavailableBuyCount: number;
  readonly unavailableBuyerCount: number;
  readonly notProcessedBuyCount: number;
  readonly notProcessedBuyerCount: number;
  readonly analyzedTransactionCount: number;
  readonly evidenceCount: number;
}

export interface WalletGraphAnalysis {
  readonly relationships: readonly WalletRelationship[];
  readonly clusters: readonly WalletCluster[];
  readonly coverage: WalletGraphCoverage;
}

export interface WalletGraphAsOf {
  readonly eventId: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly observedAtMs: number;
}

export interface WalletGraphConfirmationCounts {
  readonly processed: number;
  readonly confirmed: number;
  readonly finalized: number;
}

export interface WalletGraphProjection extends WalletGraphAnalysis {
  readonly launch: ParticipantAnalyticsLaunch;
  readonly inputFingerprint: string;
  readonly methodology: typeof WALLET_GRAPH_METHODOLOGY;
  readonly asOf: WalletGraphAsOf;
  readonly confirmationStatus: ActiveParticipantConfirmationStatus;
  readonly confirmationCounts: WalletGraphConfirmationCounts;
}

export function createWalletRelationshipId(
  mint: string,
  leftWallet: string,
  rightWallet: string,
  type: WalletFundingEvidenceType,
): string {
  const [left, right] = [leftWallet, rightWallet].sort();
  return hashId('wallet_relationship', [mint, left, right, type]);
}

export function createWalletClusterId(
  mint: string,
  wallets: readonly string[],
): string {
  return hashId('wallet_cluster', [mint, ...[...wallets].sort()]);
}

export function assertValidWalletGraphInput(input: WalletGraphInput): void {
  assertFrozen(input, 'Wallet graph input');
  assertText(input.inputFingerprint, 'inputFingerprint');
  assertText(input.participantInputFingerprint, 'participantInputFingerprint');
  if (
    (input.participantAsOf === null)
    !== (input.participantConfirmationStatus === null)
  ) {
    throw new TypeError('Wallet graph participant projection context is incomplete.');
  }
  if (input.participantAsOf !== null) {
    validateAsOf(input.participantAsOf, 'participantAsOf');
    assertActiveConfirmation(
      input.participantConfirmationStatus,
      'participantConfirmationStatus',
    );
  }
  assertFrozen(input.positions, 'Wallet graph positions');
  assertFrozen(input.buys, 'Wallet graph buys');
  assertFrozen(input.assessments, 'Wallet graph assessments');
  assertFrozen(input.evidence, 'Wallet graph evidence');

  assertValidParticipantAnalyticsInput(Object.freeze({
    launch: input.launch,
    trades: input.buys,
    inputFingerprint: input.participantInputFingerprint,
  }));
  assertValidWalletFundingExtractionResult(Object.freeze({
    assessments: input.assessments,
    evidence: input.evidence,
  }));

  const wallets = new Set<string>();
  for (const position of input.positions) {
    validatePosition(position);
    if (wallets.has(position.wallet)) {
      throw new TypeError('Wallet graph positions must be unique.');
    }
    wallets.add(position.wallet);
  }

  const buyIds = new Set<string>();
  for (const buy of input.buys) {
    if (buy.kind !== 'BUY' || buy.trader === null) {
      throw new TypeError('Wallet graph buys must be known BUY trades.');
    }
    if (buyIds.has(buy.tradeId)) {
      throw new TypeError('Wallet graph buys must be unique.');
    }
    buyIds.add(buy.tradeId);
  }
  for (const assessment of input.assessments) {
    if (!buyIds.has(assessment.buy.tradeId)) {
      throw new TypeError('Wallet graph assessment must reference an input buy.');
    }
    if (assessment.buy.confirmationStatus === 'orphaned') {
      throw new TypeError('Wallet graph assessments must be active.');
    }
  }
  for (const evidence of input.evidence) {
    if (evidence.confirmationStatus === 'orphaned') {
      throw new TypeError('Wallet graph evidence must be active.');
    }
  }
}

export function assertValidWalletGraphAnalysis(
  analysis: WalletGraphAnalysis,
): void {
  assertFrozen(analysis, 'Wallet graph analysis');
  assertFrozen(analysis.relationships, 'Wallet graph relationships');
  assertFrozen(analysis.clusters, 'Wallet graph clusters');
  validateCoverage(analysis.coverage);
  const relationshipIds = new Set<string>();
  for (const relationship of analysis.relationships) {
    validateRelationship(relationship);
    if (relationshipIds.has(relationship.id)) {
      throw new TypeError('Wallet graph relationship IDs must be unique.');
    }
    relationshipIds.add(relationship.id);
  }
  const clusterIds = new Set<string>();
  for (const cluster of analysis.clusters) {
    validateCluster(cluster);
    if (clusterIds.has(cluster.id)) {
      throw new TypeError('Wallet graph cluster IDs must be unique.');
    }
    clusterIds.add(cluster.id);
  }
}

export function assertValidWalletGraphProjection(
  projection: WalletGraphProjection,
): void {
  assertFrozen(projection, 'Wallet graph projection');
  assertValidWalletGraphAnalysis(projection);
  assertText(projection.inputFingerprint, 'projection.inputFingerprint');
  const methodology: unknown = projection.methodology;
  if (methodology !== WALLET_GRAPH_METHODOLOGY) {
    throw new TypeError('Wallet graph methodology is invalid.');
  }
  validateAsOf(projection.asOf, 'projection.asOf');
  assertActiveConfirmation(
    projection.confirmationStatus,
    'projection.confirmationStatus',
  );
  validateCounts(projection.confirmationCounts, 'confirmationCounts');
}

function validatePosition(position: ObservedWalletPosition): void {
  assertFrozen(position, 'Wallet graph position');
  assertText(position.wallet, 'position.wallet');
  assertCount(position.buyCount, 'position.buyCount');
  assertCount(position.sellCount, 'position.sellCount');
  assertNonNegativeBigint(position.boughtBaseRaw, 'position.boughtBaseRaw');
  assertNonNegativeBigint(position.soldBaseRaw, 'position.soldBaseRaw');
  if (typeof position.observedNetBaseRaw !== 'bigint') {
    throw new TypeError('position.observedNetBaseRaw must be a bigint.');
  }
  assertFrozen(position.quoteFlows, 'position.quoteFlows');
  assertFrozen(position.firstObservedCursor, 'position.firstObservedCursor');
  assertFrozen(position.lastObservedCursor, 'position.lastObservedCursor');
  assertValidChainCursor(position.firstObservedCursor);
  assertValidChainCursor(position.lastObservedCursor);
}

function validateRelationship(relationship: WalletRelationship): void {
  assertFrozen(relationship, 'Wallet graph relationship');
  for (const [name, value] of [
    ['id', relationship.id],
    ['mint', relationship.mint],
    ['leftWallet', relationship.leftWallet],
    ['rightWallet', relationship.rightWallet],
  ] as const) assertText(value, `relationship.${name}`);
  if (relationship.leftWallet >= relationship.rightWallet) {
    throw new TypeError('Wallet graph relationship wallets must be canonical.');
  }
  const type: unknown = relationship.type;
  const confidence: unknown = relationship.confidence;
  if (
    (type === 'DIRECT_QUOTE_TRANSFER' && confidence !== 'STRONG')
    || (type === 'FEE_PAYER_FOR_BUYER' && confidence !== 'MEDIUM')
    || (type !== 'DIRECT_QUOTE_TRANSFER' && type !== 'FEE_PAYER_FOR_BUYER')
  ) {
    throw new TypeError('Wallet graph relationship type or confidence is invalid.');
  }
  if (relationship.id !== createWalletRelationshipId(
    relationship.mint,
    relationship.leftWallet,
    relationship.rightWallet,
    relationship.type,
  )) throw new TypeError('Wallet graph relationship ID is not deterministic.');
  assertCount(relationship.evidenceCount, 'relationship.evidenceCount');
  if (relationship.evidenceCount === 0) {
    throw new TypeError('Wallet graph relationship must have evidence.');
  }
  assertFrozen(relationship.quoteTotals, 'relationship.quoteTotals');
  for (const total of relationship.quoteTotals) {
    assertFrozen(total, 'relationship.quoteTotal');
    validateQuoteAsset(total.quoteAsset);
    assertNonNegativeBigint(total.amountRaw, 'relationship.amountRaw');
  }
}

function validateCluster(cluster: WalletCluster): void {
  assertFrozen(cluster, 'Wallet graph cluster');
  assertText(cluster.id, 'cluster.id');
  assertText(cluster.mint, 'cluster.mint');
  assertFrozen(cluster.members, 'cluster.members');
  assertCount(cluster.participantWalletCount, 'cluster.participantWalletCount');
  assertCount(cluster.auxiliaryWalletCount, 'cluster.auxiliaryWalletCount');
  assertCount(cluster.positiveHolderCount, 'cluster.positiveHolderCount');
  assertCount(cluster.sharedFunderCount, 'cluster.sharedFunderCount');
  assertCount(cluster.strongRelationshipCount, 'cluster.strongRelationshipCount');
  assertCount(cluster.strongEvidenceCount, 'cluster.strongEvidenceCount');
  assertNonNegativeBigint(cluster.observedPositiveBaseRaw, 'cluster.observedPositiveBaseRaw');
  assertNonNegativeBigint(cluster.concentrationBps, 'cluster.concentrationBps');
  if (cluster.concentrationBps > WALLET_GRAPH_CONCENTRATION_SCALE_BPS) {
    throw new TypeError('Wallet graph concentration basis points exceed 10000.');
  }
  const memberWallets = new Set<string>();
  for (const member of cluster.members) {
    assertFrozen(member, 'cluster.member');
    assertText(member.wallet, 'cluster.member.wallet');
    if (memberWallets.has(member.wallet)) {
      throw new TypeError('Wallet graph cluster members must be unique.');
    }
    memberWallets.add(member.wallet);
    if (typeof member.observedNetBaseRaw !== 'bigint') {
      throw new TypeError('Cluster member observed balance must be bigint.');
    }
  }
  if (cluster.id !== createWalletClusterId(cluster.mint, [...memberWallets])) {
    throw new TypeError('Wallet graph cluster ID is not deterministic.');
  }
}

function validateCoverage(coverage: WalletGraphCoverage): void {
  assertFrozen(coverage, 'Wallet graph coverage');
  validateCounts(coverage, 'coverage');
}

function validateAsOf(asOf: WalletGraphAsOf, name: string): void {
  assertFrozen(asOf, `Wallet graph ${name}`);
  assertText(asOf.eventId, `${name}.eventId`);
  assertText(asOf.signature, `${name}.signature`);
  assertFrozen(asOf.cursor, `${name}.cursor`);
  assertValidChainCursor(asOf.cursor);
  assertValidTimestampMs('observedAtMs', asOf.observedAtMs);
}

function assertActiveConfirmation(value: unknown, name: string): void {
  if (value !== 'processed' && value !== 'confirmed' && value !== 'finalized') {
    throw new TypeError(`Wallet graph ${name} must be an active confirmation.`);
  }
}

function validateCounts(value: object, name: string): void {
  for (const [key, count] of Object.entries(value)) {
    assertCount(count, `${name}.${key}`);
  }
}

function validateQuoteAsset(asset: QuoteAsset): void {
  assertFrozen(asset, 'Wallet graph quote asset');
  assertText(asset.mint, 'quoteAsset.mint');
  if (!Number.isSafeInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255) {
    throw new TypeError('Wallet graph quote asset decimals are invalid.');
  }
}

function assertNonNegativeBigint(value: bigint, name: string): void {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new TypeError(`${name} must be a non-negative bigint.`);
  }
}

function assertCount(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
}

function assertText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be non-empty text.`);
  }
}

function assertFrozen(value: object, name: string): void {
  if (!Object.isFrozen(value)) throw new TypeError(`${name} must be frozen.`);
}

function hashId(prefix: string, values: readonly unknown[]): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}

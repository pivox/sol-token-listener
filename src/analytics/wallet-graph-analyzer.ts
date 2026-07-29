import {
  WALLET_GRAPH_CONCENTRATION_SCALE_BPS,
  assertValidWalletGraphAnalysis,
  assertValidWalletGraphInput,
  createWalletClusterId,
  createWalletRelationshipId,
  type WalletCluster,
  type WalletClusterMember,
  type WalletGraphAnalysis,
  type WalletGraphCoverage,
  type WalletGraphInput,
  type WalletGraphQuoteTotal,
  type WalletRelationship,
} from '../domain/wallet-graph.js';
import { compareCursors } from '../domain/cursor.js';
import type { ChainCursor, QuoteAsset } from '../domain/types.js';
import type {
  WalletFundingAssessmentStatus,
  WalletFundingEvidence,
  WalletFundingEvidenceType,
} from '../domain/wallet-funding.js';

interface MutableRelationship {
  readonly mint: string;
  readonly leftWallet: string;
  readonly rightWallet: string;
  readonly type: WalletFundingEvidenceType;
  evidenceCount: number;
  readonly quoteTotals: Map<string, { quoteAsset: QuoteAsset; amountRaw: bigint }>;
  firstObservedCursor: ChainCursor;
  lastObservedCursor: ChainCursor;
}

type CoverageStatus = WalletFundingAssessmentStatus | 'NOT_PROCESSED';

export class WalletGraphAnalyzer {
  public analyze(input: WalletGraphInput): WalletGraphAnalysis {
    assertValidWalletGraphInput(input);
    const relationships = buildRelationships(input.evidence);
    const clusters = buildClusters(input, relationships);
    const result = Object.freeze({
      relationships,
      clusters,
      coverage: buildCoverage(input),
    });
    assertValidWalletGraphAnalysis(result);
    return result;
  }
}

function buildRelationships(
  evidenceItems: readonly WalletFundingEvidence[],
): readonly WalletRelationship[] {
  const aggregate = new Map<string, MutableRelationship>();
  for (const evidence of [...evidenceItems].sort((left, right) =>
    left.id.localeCompare(right.id))) {
    const leftWallet = evidence.buyer < evidence.funder
      ? evidence.buyer
      : evidence.funder;
    const rightWallet = evidence.buyer < evidence.funder
      ? evidence.funder
      : evidence.buyer;
    const key = [evidence.mint, leftWallet, rightWallet, evidence.type].join('\0');
    let relationship = aggregate.get(key);
    const observedCursor = evidence.transferCursor ?? evidence.buyCursor;
    if (relationship === undefined) {
      const created: MutableRelationship = {
        mint: evidence.mint,
        leftWallet,
        rightWallet,
        type: evidence.type,
        evidenceCount: 0,
        quoteTotals: new Map(),
        firstObservedCursor: observedCursor,
        lastObservedCursor: observedCursor,
      };
      aggregate.set(key, created);
      relationship = created;
    }
    relationship.evidenceCount += 1;
    if (compareCursors(observedCursor, relationship.firstObservedCursor) < 0) {
      relationship.firstObservedCursor = observedCursor;
    }
    if (compareCursors(observedCursor, relationship.lastObservedCursor) > 0) {
      relationship.lastObservedCursor = observedCursor;
    }
    if (evidence.type === 'DIRECT_QUOTE_TRANSFER') {
      const quoteKey = quoteAssetKey(evidence.quoteAsset);
      const current = relationship.quoteTotals.get(quoteKey);
      relationship.quoteTotals.set(quoteKey, {
        quoteAsset: evidence.quoteAsset,
        amountRaw: (current?.amountRaw ?? 0n) + evidence.amountRaw,
      });
    }
  }
  return Object.freeze([...aggregate.values()]
    .map((item): WalletRelationship => Object.freeze({
      id: createWalletRelationshipId(
        item.mint,
        item.leftWallet,
        item.rightWallet,
        item.type,
      ),
      mint: item.mint,
      leftWallet: item.leftWallet,
      rightWallet: item.rightWallet,
      type: item.type,
      confidence: item.type === 'DIRECT_QUOTE_TRANSFER' ? 'STRONG' : 'MEDIUM',
      evidenceCount: item.evidenceCount,
      firstObservedCursor: item.firstObservedCursor,
      lastObservedCursor: item.lastObservedCursor,
      quoteTotals: Object.freeze([...item.quoteTotals.values()]
        .sort((left, right) => quoteAssetKey(left.quoteAsset)
          .localeCompare(quoteAssetKey(right.quoteAsset)))
        .map((total): WalletGraphQuoteTotal => Object.freeze(total))),
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

function buildClusters(
  input: WalletGraphInput,
  relationships: readonly WalletRelationship[],
): readonly WalletCluster[] {
  const adjacency = new Map<string, Set<string>>();
  for (const relationship of relationships) {
    if (relationship.confidence !== 'STRONG') continue;
    addNeighbor(adjacency, relationship.leftWallet, relationship.rightWallet);
    addNeighbor(adjacency, relationship.rightWallet, relationship.leftWallet);
  }
  const positions = new Map(input.positions.map((item) => [item.wallet, item]));
  const participants = new Set([
    input.launch.creator,
    ...input.positions.map((item) => item.wallet),
  ]);
  const totalPositive = input.positions.reduce(
    (sum, item) => sum + positive(item.observedNetBaseRaw),
    0n,
  );
  const visited = new Set<string>();
  const clusters: WalletCluster[] = [];
  for (const start of [...adjacency.keys()].sort()) {
    if (visited.has(start)) continue;
    const wallets = visitComponent(start, adjacency, visited).sort();
    const participantWalletCount = wallets.filter((wallet) =>
      participants.has(wallet)).length;
    if (participantWalletCount < 2) continue;
    const members = wallets.map((wallet): WalletClusterMember => {
      const position = positions.get(wallet);
      return Object.freeze({
        wallet,
        role: participants.has(wallet) ? 'PARTICIPANT' : 'AUXILIARY_FUNDER',
        isCreator: wallet === input.launch.creator,
        observedNetBaseRaw: position?.observedNetBaseRaw ?? 0n,
      });
    }).sort(compareMembers);
    const memberWallets = new Set(wallets);
    const strongRelations = relationships.filter((relationship) =>
      relationship.confidence === 'STRONG'
      && memberWallets.has(relationship.leftWallet)
      && memberWallets.has(relationship.rightWallet));
    const observedPositiveBaseRaw = members.reduce(
      (sum, member) => sum + positive(member.observedNetBaseRaw),
      0n,
    );
    const sharedFunderCount = countSharedFunders(input.evidence, memberWallets);
    const quoteAssets = new Map<string, QuoteAsset>();
    for (const relationship of strongRelations) {
      for (const total of relationship.quoteTotals) {
        quoteAssets.set(quoteAssetKey(total.quoteAsset), total.quoteAsset);
      }
    }
    clusters.push(Object.freeze({
      id: createWalletClusterId(input.launch.mint, wallets),
      mint: input.launch.mint,
      members: Object.freeze(members),
      participantWalletCount,
      auxiliaryWalletCount: members.length - participantWalletCount,
      positiveHolderCount: members.filter((member) =>
        member.observedNetBaseRaw > 0n).length,
      observedPositiveBaseRaw,
      concentrationBps: totalPositive === 0n
        ? 0n
        : observedPositiveBaseRaw * WALLET_GRAPH_CONCENTRATION_SCALE_BPS
          / totalPositive,
      containsCreator: memberWallets.has(input.launch.creator),
      sharedFunderCount,
      strongRelationshipCount: strongRelations.length,
      strongEvidenceCount: strongRelations.reduce(
        (sum, item) => sum + item.evidenceCount,
        0,
      ),
      quoteAssets: Object.freeze([...quoteAssets.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, asset]) => asset)),
    }));
  }
  return Object.freeze(clusters.sort((left, right) => left.id.localeCompare(right.id)));
}

function buildCoverage(input: WalletGraphInput): WalletGraphCoverage {
  const assessmentByTrade = new Map(input.assessments.map((item) => [
    item.buy.tradeId,
    item,
  ]));
  const buyStatus = new Map<string, CoverageStatus>();
  const buyerStatuses = new Map<string, Set<CoverageStatus>>();
  for (const buy of input.buys) {
    if (buy.trader === null) continue;
    const status = assessmentByTrade.get(buy.tradeId)?.status ?? 'NOT_PROCESSED';
    buyStatus.set(buy.tradeId, status);
    const statuses = buyerStatuses.get(buy.trader) ?? new Set();
    statuses.add(status);
    buyerStatuses.set(buy.trader, statuses);
  }
  const buyerStatus = [...buyerStatuses.values()].map(selectBuyerStatus);
  const countBuy = (status: CoverageStatus): number =>
    [...buyStatus.values()].filter((item) => item === status).length;
  const countBuyer = (status: CoverageStatus): number =>
    buyerStatus.filter((item) => item === status).length;
  return Object.freeze({
    knownBuyCount: input.buys.length,
    knownBuyerCount: buyerStatuses.size,
    strongEvidenceBuyCount: countBuy('STRONG'),
    strongEvidenceBuyerCount: countBuyer('STRONG'),
    mediumOnlyBuyCount: countBuy('MEDIUM_ONLY'),
    mediumOnlyBuyerCount: countBuyer('MEDIUM_ONLY'),
    noEvidenceBuyCount: countBuy('NO_EVIDENCE'),
    noEvidenceBuyerCount: countBuyer('NO_EVIDENCE'),
    unavailableBuyCount: countBuy('UNAVAILABLE'),
    unavailableBuyerCount: countBuyer('UNAVAILABLE'),
    notProcessedBuyCount: countBuy('NOT_PROCESSED'),
    notProcessedBuyerCount: countBuyer('NOT_PROCESSED'),
    analyzedTransactionCount: new Set(
      input.assessments.map((item) => item.buy.signature),
    ).size,
    evidenceCount: input.evidence.length,
  });
}

function selectBuyerStatus(statuses: Set<CoverageStatus>): CoverageStatus {
  for (const status of [
    'STRONG',
    'MEDIUM_ONLY',
    'NOT_PROCESSED',
    'UNAVAILABLE',
    'NO_EVIDENCE',
  ] as const) {
    if (statuses.has(status)) return status;
  }
  return 'NOT_PROCESSED';
}

function countSharedFunders(
  evidenceItems: readonly WalletFundingEvidence[],
  members: ReadonlySet<string>,
): number {
  const buyersByFunder = new Map<string, Set<string>>();
  for (const evidence of evidenceItems) {
    if (
      evidence.type !== 'DIRECT_QUOTE_TRANSFER'
      || !members.has(evidence.funder)
      || !members.has(evidence.buyer)
    ) continue;
    const buyers = buyersByFunder.get(evidence.funder) ?? new Set();
    buyers.add(evidence.buyer);
    buyersByFunder.set(evidence.funder, buyers);
  }
  return [...buyersByFunder.values()].filter((buyers) => buyers.size >= 2).length;
}

function visitComponent(
  start: string,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  visited: Set<string>,
): string[] {
  const members: string[] = [];
  const pending = [start];
  while (pending.length > 0) {
    const wallet = pending.pop();
    if (wallet === undefined || visited.has(wallet)) continue;
    visited.add(wallet);
    members.push(wallet);
    for (const neighbor of [...(adjacency.get(wallet) ?? [])].sort().reverse()) {
      if (!visited.has(neighbor)) pending.push(neighbor);
    }
  }
  return members;
}

function compareMembers(left: WalletClusterMember, right: WalletClusterMember): number {
  if (left.role !== right.role) return left.role === 'PARTICIPANT' ? -1 : 1;
  const leftPositive = positive(left.observedNetBaseRaw);
  const rightPositive = positive(right.observedNetBaseRaw);
  if (leftPositive !== rightPositive) return leftPositive > rightPositive ? -1 : 1;
  return left.wallet.localeCompare(right.wallet);
}

function addNeighbor(
  adjacency: Map<string, Set<string>>,
  wallet: string,
  neighbor: string,
): void {
  const neighbors = adjacency.get(wallet) ?? new Set();
  neighbors.add(neighbor);
  adjacency.set(wallet, neighbors);
}

function quoteAssetKey(asset: QuoteAsset): string {
  return [asset.mint, asset.decimals, asset.tokenProgram].join('\0');
}

function positive(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

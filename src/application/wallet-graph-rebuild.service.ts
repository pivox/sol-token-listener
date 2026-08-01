import { WalletGraphAnalyzer } from '../analytics/wallet-graph-analyzer.js';
import { compareCursors } from '../domain/cursor.js';
import {
  PARTICIPANT_ANALYTICS_CONFIRMATION_ORDER,
  type ActiveParticipantConfirmationStatus,
} from '../domain/participant-analytics.js';
import {
  createWalletClusterDetectedEvent,
} from '../domain/wallet-graph-events.js';
import {
  WALLET_GRAPH_METHODOLOGY,
  assertValidWalletGraphInput,
  assertValidWalletGraphProjection,
  type WalletGraphAnalysis,
  type WalletGraphAsOf,
  type WalletGraphConfirmationCounts,
  type WalletGraphInput,
  type WalletGraphProjection,
} from '../domain/wallet-graph.js';
import type { WalletGraphRepository } from '../ports/wallet-graph-repository.js';
import type { MissingCanonicalLaunchPolicy } from '../domain/projection-reconciliation.js';

interface WalletGraphAnalysisProvider {
  analyze(input: WalletGraphInput): WalletGraphAnalysis;
}

export class WalletGraphLaunchNotFoundError extends Error {
  public constructor(public readonly mint: string) {
    super(`Wallet graph launch not found for mint ${mint}.`);
    this.name = 'WalletGraphLaunchNotFoundError';
  }
}

export class WalletGraphRebuildService {
  public constructor(
    private readonly repository: WalletGraphRepository,
    private readonly analyzer: WalletGraphAnalysisProvider = new WalletGraphAnalyzer(),
  ) {}

  public async rebuild(
    mint: string,
    missingLaunchPolicy: MissingCanonicalLaunchPolicy = 'ERROR',
  ): Promise<WalletGraphProjection | null> {
    if (mint.length === 0) throw new TypeError('Wallet graph mint is required.');
    return this.repository.transact(mint, async (transaction) => {
      const input = await transaction.loadCanonicalInput(mint);
      if (input === null) {
        if (missingLaunchPolicy === 'ERROR') throw new WalletGraphLaunchNotFoundError(mint);
        await transaction.dissolveCurrent(mint);
        return null;
      }
      assertValidWalletGraphInput(input);
      const analysis = this.analyzer.analyze(input);
      const projection: WalletGraphProjection = Object.freeze({
        launch: input.launch,
        inputFingerprint: input.inputFingerprint,
        methodology: WALLET_GRAPH_METHODOLOGY,
        asOf: createAsOf(input),
        confirmationStatus: minimumConfirmation(input),
        confirmationCounts: confirmationCounts(input),
        ...analysis,
      });
      assertValidWalletGraphProjection(projection);
      await transaction.replaceProjection(
        projection,
        createWalletClusterDetectedEvent(projection),
      );
      return projection;
    });
  }
}

function createAsOf(input: WalletGraphInput): WalletGraphAsOf {
  const candidates: WalletGraphAsOf[] = [
    Object.freeze({
      eventId: input.launch.eventId,
      signature: input.launch.signature,
      cursor: input.launch.cursor,
      observedAtMs: input.launch.observedAtMs,
    }),
    ...(input.participantAsOf === null ? [] : [input.participantAsOf]),
    ...input.buys.map((buy): WalletGraphAsOf => Object.freeze({
      eventId: buy.eventId,
      signature: buy.signature,
      cursor: buy.cursor,
      observedAtMs: buy.observedAtMs,
    })),
    ...input.evidence
      .filter((evidence) => evidence.transferCursor !== null)
      .map((evidence): WalletGraphAsOf => Object.freeze({
        eventId: evidence.id,
        signature: evidence.signature,
        cursor: evidence.transferCursor,
        observedAtMs: evidence.observedAtMs,
      })),
  ];
  candidates.sort((left, right) => {
    const cursorOrder = compareCursors(left.cursor, right.cursor);
    return cursorOrder === 0
      ? left.eventId.localeCompare(right.eventId)
      : cursorOrder;
  });
  const latest = candidates.at(-1);
  if (latest === undefined) {
    throw new TypeError('Wallet graph as-of candidates are unavailable.');
  }
  return latest;
}

function minimumConfirmation(
  input: WalletGraphInput,
): ActiveParticipantConfirmationStatus {
  const statuses = [
    input.launch.confirmationStatus,
    ...(input.participantConfirmationStatus === null
      ? []
      : [input.participantConfirmationStatus]),
    ...input.buys.map((buy) => buy.confirmationStatus),
    ...input.evidence.map((evidence) =>
      activeConfirmation(evidence.confirmationStatus)),
  ];
  return statuses.reduce((minimum, status) =>
    confirmationRank(status) < confirmationRank(minimum) ? status : minimum);
}

function confirmationCounts(input: WalletGraphInput): WalletGraphConfirmationCounts {
  const counts: Record<ActiveParticipantConfirmationStatus, number> = {
    processed: 0,
    confirmed: 0,
    finalized: 0,
  };
  counts[input.launch.confirmationStatus] += 1;
  if (input.participantConfirmationStatus !== null) {
    counts[input.participantConfirmationStatus] += 1;
  }
  for (const buy of input.buys) counts[buy.confirmationStatus] += 1;
  for (const evidence of input.evidence) {
    counts[activeConfirmation(evidence.confirmationStatus)] += 1;
  }
  return Object.freeze(counts);
}

function confirmationRank(status: ActiveParticipantConfirmationStatus): number {
  return PARTICIPANT_ANALYTICS_CONFIRMATION_ORDER.indexOf(status);
}

function activeConfirmation(
  status: 'processed' | 'confirmed' | 'finalized' | 'orphaned',
): ActiveParticipantConfirmationStatus {
  if (status === 'orphaned') {
    throw new TypeError('Wallet graph canonical evidence must be active.');
  }
  return status;
}

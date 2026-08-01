import { CreatorProfiler } from '../analytics/creator-profiler.js';
import { ObservedHolderAnalyzer } from '../analytics/observed-holder-analyzer.js';
import {
  createCreatorProfileUpdatedEvent,
  createHolderDistributionUpdatedEvent,
} from '../domain/participant-analytics-events.js';
import {
  assertValidParticipantAnalyticsInput,
  compareParticipantTrades,
  PARTICIPANT_ANALYTICS_CONFIRMATION_ORDER,
  type ActiveParticipantConfirmationStatus,
  type CreatorProfile,
  type HolderDistribution,
  type ParticipantAnalyticsAsOf,
  type ParticipantAnalyticsInput,
  type ParticipantAnalyticsProjection,
  type ParticipantConfirmationCounts,
} from '../domain/participant-analytics.js';
import type { ParticipantAnalyticsRepository } from '../ports/participant-analytics-repository.js';
import type { MissingCanonicalLaunchPolicy } from '../domain/projection-reconciliation.js';

interface CreatorProfileProvider {
  profile(input: ParticipantAnalyticsInput): CreatorProfile;
}

interface HolderDistributionProvider {
  analyze(input: ParticipantAnalyticsInput): HolderDistribution;
}

export class ParticipantAnalyticsLaunchNotFoundError extends Error {
  public constructor(public readonly mint: string) {
    super(`Participant analytics launch not found for mint ${mint}.`);
    this.name = 'ParticipantAnalyticsLaunchNotFoundError';
  }
}

export class LaunchParticipantAnalyticsService {
  public constructor(
    private readonly repository: ParticipantAnalyticsRepository,
    private readonly creatorProfiler: CreatorProfileProvider = new CreatorProfiler(),
    private readonly holderAnalyzer: HolderDistributionProvider = new ObservedHolderAnalyzer(),
  ) {}

  public async rebuild(
    mint: string,
    missingLaunchPolicy: MissingCanonicalLaunchPolicy = 'ERROR',
  ): Promise<ParticipantAnalyticsProjection | null> {
    if (mint.length === 0) throw new TypeError('Participant analytics mint is required.');
    return this.repository.transact(mint, async (transaction) => {
      const input = await transaction.loadCanonicalInput(mint);
      if (input === null) {
        if (missingLaunchPolicy === 'ERROR') {
          throw new ParticipantAnalyticsLaunchNotFoundError(mint);
        }
        await transaction.dissolveCurrent(mint);
        return null;
      }
      assertValidParticipantAnalyticsInput(input);
      const trades = [...input.trades].sort(compareParticipantTrades);
      const profile = this.creatorProfiler.profile(input);
      const distribution = this.holderAnalyzer.analyze(input);
      const projection: ParticipantAnalyticsProjection = Object.freeze({
        launch: input.launch,
        inputFingerprint: input.inputFingerprint,
        asOf: createAsOf(input, trades.at(-1)),
        confirmationStatus: minimumConfirmation(input),
        confirmationCounts: confirmationCounts(input),
        profile,
        distribution,
      });
      const events = Object.freeze([
        createCreatorProfileUpdatedEvent(projection),
        createHolderDistributionUpdatedEvent(projection),
      ]);
      await transaction.replaceProjection(projection, events);
      return projection;
    });
  }
}

function createAsOf(
  input: ParticipantAnalyticsInput,
  trade: ParticipantAnalyticsInput['trades'][number] | undefined,
): ParticipantAnalyticsAsOf {
  if (trade === undefined) {
    return Object.freeze({
      eventId: input.launch.eventId,
      signature: input.launch.signature,
      cursor: input.launch.cursor,
      observedAtMs: input.launch.observedAtMs,
    });
  }
  return Object.freeze({
    eventId: trade.eventId,
    signature: trade.signature,
    cursor: trade.cursor,
    observedAtMs: trade.observedAtMs,
  });
}

function minimumConfirmation(
  input: ParticipantAnalyticsInput,
): ActiveParticipantConfirmationStatus {
  const statuses = [
    input.launch.confirmationStatus,
    ...input.trades.map((trade) => trade.confirmationStatus),
  ];
  return statuses.reduce((minimum, status) => (
    confirmationRank(status) < confirmationRank(minimum) ? status : minimum
  ));
}

function confirmationCounts(
  input: ParticipantAnalyticsInput,
): ParticipantConfirmationCounts {
  const counts: Record<ActiveParticipantConfirmationStatus, number> = {
    processed: 0,
    confirmed: 0,
    finalized: 0,
  };
  counts[input.launch.confirmationStatus] += 1;
  for (const trade of input.trades) counts[trade.confirmationStatus] += 1;
  return Object.freeze(counts);
}

function confirmationRank(status: ActiveParticipantConfirmationStatus): number {
  return PARTICIPANT_ANALYTICS_CONFIRMATION_ORDER.indexOf(status);
}

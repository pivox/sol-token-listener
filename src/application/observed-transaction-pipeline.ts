import type { LaunchpadObservationEventV1 } from '../domain/launchpad-events.js';
import type { LaunchpadEventBatchResult } from '../ports/launchpad-event-sink.js';
import type { LaunchpadProjectionReader } from '../ports/launchpad-projection-reader.js';
import { createSolanaObservedTransaction } from '../solana/rpc/observed-transaction.js';
import type { SolanaObservedTransaction } from '../solana/rpc/observed-transaction.js';
import type { NormalizedTransaction } from '../solana/rpc/types.js';

export const MAX_OBSERVED_PIPELINE_ITEMS = 4_096;

export type ObservedPipelineStage =
  | 'create_observation'
  | 'load_tracked_mints'
  | 'launchpad_observation'
  | 'reload_active_events'
  | 'funding_observation'
  | 'participant_analytics'
  | 'wallet_graph'
  | 'pumpswap_observation';

export interface ObservedPipelineResult {
  readonly launchpadEventCount: number;
  readonly activeEventCount: number;
  readonly fundingAssessmentCount: number;
  readonly fundingEvidenceCount: number;
  readonly affectedMintCount: number;
  readonly participantAnalyticsCount: number;
  readonly walletGraphCount: number;
  readonly marketMigrationCount: number;
  readonly marketActivationCount: number;
}

export class ObservedPipelineError extends Error {
  public readonly code = 'PIPELINE_STAGE_FAILED' as const;

  public constructor(
    public readonly stage: ObservedPipelineStage,
    public readonly mint: string | null = null,
  ) {
    super(`Observed transaction pipeline failed during ${stage}.`);
    this.name = 'ObservedPipelineError';
  }
}

interface LaunchpadObserver {
  observe(
    transaction: SolanaObservedTransaction,
    trackedMints: ReadonlySet<string>,
  ): Promise<LaunchpadEventBatchResult>;
}

interface FundingObservationResult {
  readonly assessments: readonly unknown[];
  readonly evidence: readonly unknown[];
}

interface FundingObserver {
  observe(
    transaction: SolanaObservedTransaction,
    events: readonly Extract<
      LaunchpadObservationEventV1,
      { readonly type: 'BondingCurveTradeObserved' }
    >[],
  ): Promise<FundingObservationResult>;
}

interface MintProjectionRebuilder {
  rebuild(mint: string): Promise<unknown>;
}

interface MarketObservationResult {
  readonly migrations: readonly unknown[];
  readonly activations: readonly unknown[];
}

interface MarketObserver {
  observe(transaction: NormalizedTransaction): Promise<MarketObservationResult>;
}

export class ObservedTransactionPipeline {
  public constructor(
    private readonly reader: LaunchpadProjectionReader,
    private readonly launchpad: LaunchpadObserver,
    private readonly funding: FundingObserver,
    private readonly participants: MintProjectionRebuilder,
    private readonly graph: MintProjectionRebuilder,
    private readonly market: MarketObserver,
    private readonly clock: () => number = Date.now,
  ) {}

  public async process(
    transaction: NormalizedTransaction,
  ): Promise<ObservedPipelineResult> {
    const observed = await this.stage('create_observation', null, () =>
      createSolanaObservedTransaction(transaction, this.clock()));
    const trackedMints = await this.stage('load_tracked_mints', null, async () =>
      boundedMintSet(await this.reader.listTrackedMints()));
    const launchpad = await this.stage('launchpad_observation', null, () =>
      this.launchpad.observe(observed, trackedMints));
    const launchpadEventCount = await this.stage(
      'launchpad_observation',
      null,
      () => boundedArrayLength(launchpad.events),
    );
    const launchpadAffectedMints = await this.stage(
      'launchpad_observation',
      null,
      () => boundedMintList(launchpad.affectedMints),
    );
    const activeEvents = await this.stage('reload_active_events', null, async () =>
      snapshotUniqueEvents(
        await this.reader.listActiveEventsBySignature(observed.signature),
      ));
    const trades = Object.freeze(activeEvents.filter(
      (event): event is Extract<
        LaunchpadObservationEventV1,
        { readonly type: 'BondingCurveTradeObserved' }
      > => event.type === 'BondingCurveTradeObserved',
    ));
    const funding = await this.stage('funding_observation', null, () =>
      this.funding.observe(observed, trades));
    const [fundingAssessmentCount, fundingEvidenceCount] = await this.stage(
      'funding_observation',
      null,
      () => Object.freeze([
        boundedArrayLength(funding.assessments),
        boundedArrayLength(funding.evidence),
      ] as const),
    );
    const affectedMints = await this.stage('reload_active_events', null, () =>
      affectedMintList(activeEvents, launchpadAffectedMints));

    let participantAnalyticsCount = 0;
    let walletGraphCount = 0;
    for (const mint of affectedMints) {
      await this.stage('participant_analytics', mint, () =>
        this.participants.rebuild(mint));
      participantAnalyticsCount += 1;
      await this.stage('wallet_graph', mint, () => this.graph.rebuild(mint));
      walletGraphCount += 1;
    }

    const market = await this.stage('pumpswap_observation', null, () =>
      this.market.observe(transaction));
    const [marketMigrationCount, marketActivationCount] = await this.stage(
      'pumpswap_observation',
      null,
      () => Object.freeze([
        boundedArrayLength(market.migrations),
        boundedArrayLength(market.activations),
      ] as const),
    );
    return Object.freeze({
      launchpadEventCount,
      activeEventCount: activeEvents.length,
      fundingAssessmentCount,
      fundingEvidenceCount,
      affectedMintCount: affectedMints.length,
      participantAnalyticsCount,
      walletGraphCount,
      marketMigrationCount,
      marketActivationCount,
    });
  }

  private async stage<TResult>(
    stage: ObservedPipelineStage,
    mint: string | null,
    operation: () => TResult | Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await operation();
    } catch {
      throw new ObservedPipelineError(stage, mint);
    }
  }
}

function boundedMintSet(values: ReadonlySet<string>): ReadonlySet<string> {
  const result = new Set<string>();
  let visited = 0;
  for (const mint of values) {
    visited += 1;
    if (visited > MAX_OBSERVED_PIPELINE_ITEMS) throw new RangeError('too many mints');
    if (!isSafeMint(mint)) throw new TypeError('invalid mint');
    result.add(mint);
  }
  return result;
}

function snapshotUniqueEvents(
  values: readonly LaunchpadObservationEventV1[],
): readonly LaunchpadObservationEventV1[] {
  if (!Array.isArray(values)) throw new TypeError('active events must be an array');
  if (values.length > MAX_OBSERVED_PIPELINE_ITEMS) throw new RangeError('too many events');
  const ids = new Set<string>();
  const events: LaunchpadObservationEventV1[] = [];
  // Indexing keeps traversal bounded even if an untrusted array overrides its iterator.
  // eslint-disable-next-line @typescript-eslint/prefer-for-of
  for (let index = 0; index < values.length; index += 1) {
    const event: unknown = values[index];
    if (
      !isRecord(event)
      || typeof event.id !== 'string'
      || event.id.length === 0
      || !isSafeMint(event.mint)
      || (
        event.type !== 'TokenLaunchDetected'
        && event.type !== 'BondingCurveTradeObserved'
      )
    ) throw new TypeError('invalid active event');
    if (ids.has(event.id)) continue;
    ids.add(event.id);
    events.push(event as unknown as LaunchpadObservationEventV1);
  }
  return Object.freeze(events);
}

function affectedMintList(
  activeEvents: readonly LaunchpadObservationEventV1[],
  launchpadAffectedMints: readonly string[],
): readonly string[] {
  const mints = new Set([
    ...activeEvents.map((event) => event.mint),
    ...launchpadAffectedMints,
  ]);
  if (mints.size > MAX_OBSERVED_PIPELINE_ITEMS) throw new RangeError('too many affected mints');
  return Object.freeze([...mints].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0));
}

function boundedMintList(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) throw new TypeError('affected mints must be an array');
  if (values.length > MAX_OBSERVED_PIPELINE_ITEMS) throw new RangeError('too many mints');
  const mints = new Set<string>();
  // Indexing keeps traversal bounded even if an untrusted array overrides its iterator.
  // eslint-disable-next-line @typescript-eslint/prefer-for-of
  for (let index = 0; index < values.length; index += 1) {
    const mint: unknown = values[index];
    if (!isSafeMint(mint)) throw new TypeError('invalid mint');
    mints.add(mint);
  }
  return Object.freeze([...mints]);
}

function boundedArrayLength(values: readonly unknown[]): number {
  if (!Array.isArray(values)) throw new TypeError('pipeline result must be an array');
  if (values.length > MAX_OBSERVED_PIPELINE_ITEMS) throw new RangeError('too many results');
  return values.length;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isSafeMint(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/u.test(value);
}

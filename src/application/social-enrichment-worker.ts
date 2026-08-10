import {
  createFailedSocialCollection,
  createSocialCollection,
  socialMetadataSnapshotId,
  type SocialCollectionStatus,
  type SocialEvidenceCollectionV1,
  type SocialHttpObservationV1,
  type SocialLinkV1,
  type SocialVerificationEvidenceV1,
} from '../domain/social-evidence.js';
import type {
  MetadataFailureReason,
  MetadataResolution,
  PublicTokenMetadata,
  TokenMetadataSnapshot,
} from '../domain/pumpfun-observation.js';
import type { ListenerRuntimeState } from '../domain/transaction-ingestion.js';
import type { MetadataProvider } from '../ports/metadata-provider.js';
import type {
  ClaimedSocialJob,
  SocialEvidenceRepository,
  SocialJobFailure,
  SocialJobResult,
} from '../ports/social-evidence-repository.js';
import type { SocialVerificationProvider } from '../ports/social-verification-provider.js';
import { sanitizeMetadataForPersistence } from '../social/social-url-normalizer.js';
import { canonicalStringifyJson } from '../utils/json.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface SocialEnrichmentWorkerOptions {
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly renewalIntervalMs: number;
  readonly shutdownTimeoutMs: number;
}

export interface SocialEnrichmentWorkerScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  now(): number;
}

export type SocialEnrichmentRunResult =
  | Readonly<{ kind: 'idle' | 'closed' }>
  | Readonly<{ kind: 'completed' | 'failed' | 'lease-lost'; jobId: string }>;

export class SocialEnrichmentWorkerError extends Error {
  public constructor(public readonly stage: 'claim' | 'complete' | 'fail' | 'clock') {
    super('Social enrichment worker operation failed.');
    this.name = 'SocialEnrichmentWorkerError';
  }
}

const systemScheduler: SocialEnrichmentWorkerScheduler = Object.freeze({
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  },
  cancel(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  now: Date.now,
});

export class SocialEnrichmentWorker {
  private currentState: ListenerRuntimeState = 'STOPPED';
  private readonly scheduler: SocialEnrichmentWorkerScheduler;
  private readonly options: SocialEnrichmentWorkerOptions;
  private scheduledHandle: unknown = null;
  private inFlight: Promise<void> | null = null;
  private runTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private activeLease: SocialLeaseGuard | null = null;
  private started = false;
  private permanentlyClosed = false;

  public constructor(
    private readonly repository: SocialEvidenceRepository,
    private readonly metadataProvider: MetadataProvider,
    private readonly socialProvider: SocialVerificationProvider,
    options: SocialEnrichmentWorkerOptions,
    scheduler: SocialEnrichmentWorkerScheduler = systemScheduler,
  ) {
    validateOptions(options);
    validateScheduler(scheduler);
    this.options = Object.freeze({ ...options });
    this.scheduler = scheduler;
  }

  public get state(): ListenerRuntimeState {
    return this.currentState;
  }

  public start(): Promise<void> {
    if (this.permanentlyClosed || this.started) return Promise.resolve();
    this.started = true;
    this.currentState = 'STARTING';
    this.scheduleNext(0);
    this.currentState = 'RUNNING';
    return Promise.resolve();
  }

  public runOnce(): Promise<SocialEnrichmentRunResult> {
    const operation = this.runTail.then(() => this.performRunOnce());
    this.runTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  public close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.permanentlyClosed = true;
    this.started = false;
    this.currentState = 'STOPPING';
    if (this.scheduledHandle !== null) {
      this.scheduler.cancel(this.scheduledHandle);
      this.scheduledHandle = null;
    }
    const close = this.finishClose();
    this.closePromise = close;
    return close;
  }

  private async performRunOnce(): Promise<SocialEnrichmentRunResult> {
    if (this.permanentlyClosed) return frozen({ kind: 'closed' as const });
    let claimed: ClaimedSocialJob | null;
    try {
      claimed = await this.repository.claim({ leaseMs: this.options.leaseMs, nowMs: this.readNow() });
    } catch {
      this.currentState = 'DEGRADED';
      throw new SocialEnrichmentWorkerError('claim');
    }
    if (claimed === null) return frozen({ kind: 'idle' as const });
    let job: ClaimedSocialJob;
    try {
      job = snapshotClaimedJob(claimed);
    } catch {
      this.currentState = 'DEGRADED';
      throw new SocialEnrichmentWorkerError('claim');
    }
    const lease = new SocialLeaseGuard(
      job,
      this.repository,
      this.scheduler,
      this.options.leaseMs,
      this.options.renewalIntervalMs,
      () => this.readNow(),
    );
    this.activeLease = lease;
    lease.start();

    let resolution: MetadataResolution;
    if (job.metadataUri === null) {
      resolution = metadataFailure('URI_INVALID');
    } else {
      try {
        resolution = snapshotResolution(await this.metadataProvider.resolve(job.metadataUri));
      } catch {
        return this.failClaim(job, lease, 'PROVIDER_UNAVAILABLE');
      }
    }
    const metadataSnapshot = Object.freeze({
      mint: job.mint,
      uri: job.metadataUri ?? 'urn:pumpfun:metadata-missing',
      resolution,
      fetchedAtMs: this.readNow(),
      payloadVersion: 1,
    });

    if (resolution.status === 'FAILED') {
      const collection = createFailedSocialCollection(Object.freeze({
        mint: job.mint,
        sourceLaunchEventId: job.sourceLaunchEventId,
        metadataSnapshot,
      }));
      if (resolution.retryable) {
        return this.failClaim(job, lease, 'HTTP_TRANSIENT', Object.freeze({
          status: 'METADATA_FAILED' as const,
          metadataSnapshot,
          collection,
        }));
      }
      return this.completeClaim(job, lease, Object.freeze({
        status: 'METADATA_FAILED' as const,
        metadataSnapshot,
        collection,
      }));
    }

    let collected: Awaited<ReturnType<SocialVerificationProvider['collect']>>;
    try {
      const providerResult = await this.socialProvider.collect(Object.freeze({
        mint: job.mint,
        sourceLaunchEventId: job.sourceLaunchEventId,
        metadataSnapshot,
      }));
      collected = snapshotSafeProviderResult(job, providerResult);
    } catch {
      return this.failClaim(job, lease, 'PROVIDER_UNAVAILABLE');
    }
    if (collected.retryable) {
      return this.failClaim(job, lease, 'HTTP_TRANSIENT', Object.freeze({
        status: 'RESOLVED' as const,
        metadataSnapshot: collected.metadataSnapshot,
        collection: collected.collection,
      }));
    }
    return this.completeClaim(job, lease, Object.freeze({
      status: 'RESOLVED' as const,
      metadataSnapshot: collected.metadataSnapshot,
      collection: collected.collection,
    }));
  }

  private async completeClaim(
    job: ClaimedSocialJob,
    lease: SocialLeaseGuard,
    result: SocialJobResult,
  ): Promise<SocialEnrichmentRunResult> {
    const owned = await lease.finish();
    if (this.activeLease === lease) this.activeLease = null;
    if (!owned) return frozen({ kind: 'lease-lost' as const, jobId: job.id });
    try {
      await this.repository.complete(job, result);
    } catch {
      this.currentState = 'DEGRADED';
      throw new SocialEnrichmentWorkerError('complete');
    }
    return frozen({ kind: 'completed' as const, jobId: job.id });
  }

  private async failClaim(
    job: ClaimedSocialJob,
    lease: SocialLeaseGuard,
    code: SocialJobFailure['code'],
    terminalResult?: SocialJobResult,
  ): Promise<SocialEnrichmentRunResult> {
    const owned = await lease.finish();
    if (this.activeLease === lease) this.activeLease = null;
    if (!owned) return frozen({ kind: 'lease-lost' as const, jobId: job.id });
    const failure = Object.freeze({ code, retryable: true, observedAtMs: this.readNow() });
    try {
      await this.repository.fail(job, failure, terminalResult);
    } catch {
      this.currentState = 'DEGRADED';
      throw new SocialEnrichmentWorkerError('fail');
    }
    return frozen({ kind: 'failed' as const, jobId: job.id });
  }

  private scheduleNext(delayMs: number): void {
    if (this.permanentlyClosed || !this.started || this.scheduledHandle !== null) return;
    this.scheduledHandle = this.scheduler.schedule(() => {
      this.scheduledHandle = null;
      const operation = this.tick();
      this.inFlight = operation;
      void operation.finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch {
      this.currentState = 'DEGRADED';
    }
    if (!this.permanentlyClosed && this.started) this.scheduleNext(this.options.pollIntervalMs);
  }

  private async finishClose(): Promise<void> {
    const pending = this.inFlight ?? this.runTail;
    const completed = await settleWithin(pending, this.options.shutdownTimeoutMs);
    if (!completed) {
      this.activeLease?.abandon();
      this.activeLease = null;
    }
    this.currentState = completed ? 'STOPPED' : 'DEGRADED';
  }

  private readNow(): number {
    let value: number;
    try {
      value = this.scheduler.now();
    } catch {
      this.currentState = 'DEGRADED';
      throw new SocialEnrichmentWorkerError('clock');
    }
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      this.currentState = 'DEGRADED';
      throw new SocialEnrichmentWorkerError('clock');
    }
    return value;
  }
}

class SocialLeaseGuard {
  private handle: unknown = null;
  private renewing: Promise<void> | null = null;
  private stopped = false;
  private abandoned = false;
  private owned = true;

  public constructor(
    private readonly job: ClaimedSocialJob,
    private readonly repository: SocialEvidenceRepository,
    private readonly scheduler: SocialEnrichmentWorkerScheduler,
    private readonly leaseMs: number,
    private readonly renewalIntervalMs: number,
    private readonly now: () => number,
  ) {}

  public start(): void {
    this.schedule();
  }

  public async finish(): Promise<boolean> {
    this.stopped = true;
    if (this.handle !== null) {
      this.scheduler.cancel(this.handle);
      this.handle = null;
    }
    if (this.renewing !== null) await this.renewing;
    return this.owned;
  }

  public abandon(): void {
    this.abandoned = true;
    this.stopped = true;
    this.owned = false;
    if (this.handle !== null) {
      this.scheduler.cancel(this.handle);
      this.handle = null;
    }
  }

  private schedule(): void {
    if (this.stopped || !this.owned) return;
    this.handle = this.scheduler.schedule(() => {
      this.handle = null;
      const operation = this.renew();
      this.renewing = operation;
      void operation.finally(() => {
        if (this.renewing === operation) this.renewing = null;
      });
    }, this.renewalIntervalMs);
  }

  private async renew(): Promise<void> {
    try {
      const renewed = await this.repository.renew(
        this.job.id,
        this.job.leaseToken,
        this.leaseMs,
        this.now(),
      );
      if (!this.abandoned) this.owned = renewed;
    } catch {
      this.owned = false;
    }
    if (!this.stopped && this.owned) this.schedule();
  }
}

function snapshotResolution(value: MetadataResolution): MetadataResolution {
  const fields = dataFields(value, 'Metadata resolution');
  const status = fields.status;
  if (status === 'FAILED') {
    exactKeys(fields, ['status', 'reason', 'message', 'retryable'], 'Metadata failure');
    if (!isMetadataFailureReason(fields.reason) || typeof fields.retryable !== 'boolean') {
      throw new TypeError('Metadata failure is invalid.');
    }
    return metadataFailure(fields.reason, fields.retryable);
  }
  if (status !== 'RESOLVED') throw new TypeError('Metadata resolution status is invalid.');
  exactKeys(fields, ['status', 'metadata'], 'Metadata resolution');
  return Object.freeze({
    status: 'RESOLVED' as const,
    metadata: snapshotMetadata(fields.metadata as PublicTokenMetadata),
  });
}

function snapshotMetadata(value: PublicTokenMetadata): PublicTokenMetadata {
  const fields = dataFields(value, 'Public metadata');
  exactKeys(fields, [
    'name', 'symbol', 'description', 'imageUrl', 'videoUrl', 'websiteUrl',
    'twitterUrl', 'telegramUrl',
  ], 'Public metadata');
  return Object.freeze({
    name: nullableText(fields.name),
    symbol: nullableText(fields.symbol),
    description: nullableText(fields.description),
    imageUrl: nullableText(fields.imageUrl),
    videoUrl: nullableText(fields.videoUrl),
    websiteUrl: nullableText(fields.websiteUrl),
    twitterUrl: nullableText(fields.twitterUrl),
    telegramUrl: nullableText(fields.telegramUrl),
  });
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 16_384) {
    throw new TypeError('Social metadata text is invalid.');
  }
  return value;
}

function metadataFailure(
  reason: MetadataFailureReason,
  retryable = false,
): Extract<MetadataResolution, { status: 'FAILED' }> {
  return Object.freeze({
    status: 'FAILED' as const,
    reason,
    message: 'Public metadata is unavailable.',
    retryable,
  });
}

function snapshotSafeProviderResult(
  job: ClaimedSocialJob,
  result: Awaited<ReturnType<SocialVerificationProvider['collect']>>,
): Awaited<ReturnType<SocialVerificationProvider['collect']>> {
  const fields = dataFields(result, 'Social provider result');
  exactKeys(fields, ['metadataSnapshot', 'collection', 'retryable'], 'Social provider result');
  if (typeof fields.retryable !== 'boolean') {
    throw new TypeError('Social provider retryability is invalid.');
  }
  const metadataSnapshot = snapshotTokenMetadata(fields.metadataSnapshot);
  const collection = snapshotCollection(fields.collection);
  if (
    metadataSnapshot.mint !== job.mint
    || collection.mint !== job.mint
    || collection.sourceLaunchEventId !== job.sourceLaunchEventId
    || metadataSnapshot.resolution.status !== 'RESOLVED'
  ) throw new TypeError('Social provider result context is invalid.');
  const expectedId = socialMetadataSnapshotId({
    sourceLaunchEventId: job.sourceLaunchEventId,
    snapshot: metadataSnapshot,
  });
  if (expectedId !== collection.metadataSnapshotId) {
    throw new TypeError('Social provider metadata identity conflicts.');
  }
  const sanitized = sanitizeMetadataForPersistence(
    metadataSnapshot.resolution.metadata,
    collection.links,
  );
  if (canonicalStringifyJson(sanitized)
    !== canonicalStringifyJson(metadataSnapshot.resolution.metadata)) {
    throw new TypeError('Social provider returned unsafe metadata links.');
  }
  return Object.freeze({ metadataSnapshot, collection, retryable: fields.retryable });
}

function snapshotTokenMetadata(value: unknown): TokenMetadataSnapshot {
  const fields = dataFields(value, 'Token metadata snapshot');
  exactKeys(fields, [
    'mint', 'uri', 'resolution', 'fetchedAtMs', 'payloadVersion',
  ], 'Token metadata snapshot');
  return Object.freeze({
    mint: boundedString(fields.mint),
    uri: boundedString(fields.uri),
    resolution: snapshotResolution(fields.resolution as MetadataResolution),
    fetchedAtMs: safeTimestamp(fields.fetchedAtMs),
    payloadVersion: positiveInteger(fields.payloadVersion),
  });
}

function snapshotCollection(value: unknown): SocialEvidenceCollectionV1 {
  const fields = dataFields(value, 'Social evidence collection');
  exactKeys(fields, [
    'id', 'inputFingerprint', 'mint', 'sourceLaunchEventId', 'metadataSnapshotId',
    'status', 'links', 'observations', 'evidence', 'observedAtMs', 'payloadVersion',
  ], 'Social evidence collection');
  const links = frozenArray(fields.links, 'Social links') as readonly SocialLinkV1[];
  const observations = frozenArray(
    fields.observations,
    'Social observations',
  ) as readonly SocialHttpObservationV1[];
  const evidence = frozenArray(
    fields.evidence,
    'Social evidence',
  ) as readonly SocialVerificationEvidenceV1[];
  const rebuilt = createSocialCollection(Object.freeze({
    mint: boundedString(fields.mint),
    sourceLaunchEventId: boundedString(fields.sourceLaunchEventId),
    metadataSnapshotId: boundedString(fields.metadataSnapshotId),
    status: socialCollectionStatus(fields.status),
    links,
    observations,
    evidence,
    observedAtMs: safeTimestamp(fields.observedAtMs),
  }));
  if (
    fields.id !== rebuilt.id
    || fields.inputFingerprint !== rebuilt.inputFingerprint
    || fields.payloadVersion !== rebuilt.payloadVersion
  ) throw new TypeError('Social collection identity is invalid.');
  return rebuilt;
}

function frozenArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value) || !Object.isFrozen(value)) {
    throw new TypeError(`${name} must be a frozen array.`);
  }
  return value;
}

function socialCollectionStatus(value: unknown): SocialCollectionStatus {
  if (value !== 'COMPLETE' && value !== 'PARTIAL' && value !== 'FAILED') {
    throw new TypeError('Social collection status is invalid.');
  }
  return value;
}

function snapshotClaimedJob(value: ClaimedSocialJob): ClaimedSocialJob {
  const fields = dataFields(value, 'Claimed social job');
  exactKeys(fields, [
    'id', 'mint', 'sourceLaunchEventId', 'metadataUri', 'attempts',
    'attemptsInCycle', 'leaseToken', 'leaseExpiresAtMs',
  ], 'Claimed social job');
  const metadataUri = fields.metadataUri === null ? null : boundedString(fields.metadataUri);
  return Object.freeze({
    id: boundedString(fields.id),
    mint: boundedString(fields.mint),
    sourceLaunchEventId: boundedString(fields.sourceLaunchEventId),
    metadataUri,
    attempts: positiveInteger(fields.attempts),
    attemptsInCycle: positiveInteger(fields.attemptsInCycle),
    leaseToken: boundedString(fields.leaseToken),
    leaseExpiresAtMs: safeTimestamp(fields.leaseExpiresAtMs),
  });
}

function dataFields(value: unknown, name: string): Record<string, unknown> {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length !== 0
  ) throw new TypeError(`${name} must be a plain object.`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${name} must contain data fields.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactKeys(fields: Record<string, unknown>, expected: readonly string[], name: string): void {
  const keys = Object.keys(fields);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(fields, key))) {
    throw new TypeError(`${name} fields are invalid.`);
  }
}

function boundedString(value: unknown): string {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > 16_384) {
    throw new TypeError('Social worker text is invalid.');
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Social worker integer is invalid.');
  }
  return value;
}

function safeTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Social worker timestamp is invalid.');
  }
  return value;
}

function isMetadataFailureReason(value: unknown): value is MetadataFailureReason {
  return [
    'URI_INVALID','UNSUPPORTED_URI_SCHEME','FETCH_FAILED','HTTP_STATUS_INVALID',
    'REDIRECT_LIMIT_EXCEEDED','CONTENT_TOO_LARGE','JSON_INVALID','JSON_SHAPE_INVALID',
  ].includes(value as MetadataFailureReason);
}

function validateOptions(options: SocialEnrichmentWorkerOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
      throw new TypeError(`Social enrichment ${name} is invalid.`);
    }
  }
  if (options.renewalIntervalMs >= options.leaseMs) {
    throw new TypeError('Social enrichment renewal must precede lease expiry.');
  }
}

function validateScheduler(scheduler: SocialEnrichmentWorkerScheduler): void {
  if (
    typeof scheduler.schedule !== 'function'
    || typeof scheduler.cancel !== 'function'
    || typeof scheduler.now !== 'function'
  ) throw new TypeError('Social enrichment scheduler is invalid.');
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let resolveTimeout: (value: boolean) => void = () => undefined;
  const timeout = new Promise<boolean>((resolve) => {
    resolveTimeout = resolve;
  });
  const handle = setTimeout(() => { resolveTimeout(false); }, timeoutMs);
  const completed = operation.then(() => true, () => true);
  const result = await Promise.race([completed, timeout]);
  clearTimeout(handle);
  return result;
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
import { isProxy } from 'node:util/types';

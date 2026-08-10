import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SocialEnrichmentWorker,
  type SocialEnrichmentWorkerScheduler,
} from '../src/application/social-enrichment-worker.js';
import type { MetadataResolution, TokenMetadataSnapshot } from '../src/domain/pumpfun-observation.js';
import type { MetadataProvider } from '../src/ports/metadata-provider.js';
import type {
  ClaimedSocialJob,
  SocialEvidenceRepository,
  SocialJobCounts,
  SocialJobFailure,
  SocialJobResult,
} from '../src/ports/social-evidence-repository.js';
import type { SocialVerificationProvider } from '../src/ports/social-verification-provider.js';
import { PublicSocialVerificationProvider } from '../src/social/public-social-verification.provider.js';

const MINT = 'So11111111111111111111111111111111111111112';
const NOW = 1_786_300_000_000;

void test('resolves and completes one enrichment outside the Solana path', async () => {
  const repository = new ScriptedRepository([claimedJob(), null]);
  const worker = new SocialEnrichmentWorker(
    repository,
    metadataProvider(resolved()),
    passthroughSocialProvider(),
    options(),
    new ManualScheduler(),
  );
  assert.deepEqual(await worker.runOnce(), { kind: 'completed', jobId: 'social-job-1' });
  assert.equal(repository.completions.length, 1);
  assert.equal(repository.failures.length, 0);
  assert.equal(repository.completions[0]?.result.status, 'RESOLVED');
});

void test('completes missing URI and permanent metadata failures without social fetch', async () => {
  for (const scenario of [
    { job: claimedJob({ metadataUri: null }), resolution: null },
    { job: claimedJob(), resolution: failed(false) },
  ]) {
    const repository = new ScriptedRepository([scenario.job]);
    let metadataCalls = 0;
    let socialCalls = 0;
    const worker = new SocialEnrichmentWorker(repository, {
      resolve: async () => {
        metadataCalls += 1;
        return scenario.resolution ?? failed(false);
      },
    }, {
      collect: async () => {
        socialCalls += 1;
        throw new Error('social provider must not run');
      },
    }, options(), new ManualScheduler());
    assert.equal((await worker.runOnce()).kind, 'completed');
    assert.equal(metadataCalls, scenario.job.metadataUri === null ? 0 : 1);
    assert.equal(socialCalls, 0);
    assert.equal(repository.completions[0]?.result.status, 'METADATA_FAILED');
  }
});

void test('retries typed transient metadata failure without partial completion', async () => {
  const repository = new ScriptedRepository([claimedJob()]);
  const worker = new SocialEnrichmentWorker(
    repository,
    metadataProvider(failed(true)),
    passthroughSocialProvider(),
    options(),
    new ManualScheduler(),
  );
  assert.deepEqual(await worker.runOnce(), { kind: 'failed', jobId: 'social-job-1' });
  assert.equal(repository.completions.length, 0);
  assert.deepEqual(repository.failures, [Object.freeze({
    job: claimedJob(),
    failure: Object.freeze({
      code: 'HTTP_TRANSIENT', retryable: true, observedAtMs: NOW,
    }),
  })]);
});

void test('retries transient social fetches and carries explicit terminal evidence', async () => {
  const repository = new ScriptedRepository([claimedJob()]);
  const social = new PublicSocialVerificationProvider({
    get: async () => Object.freeze({
      status: 'FAILED' as const, reason: 'TIMEOUT' as const, retryable: true,
    }),
  });
  const worker = new SocialEnrichmentWorker(
    repository,
    metadataProvider(Object.freeze({
      status: 'RESOLVED' as const,
      metadata: Object.freeze({
        name: 'Project', symbol: 'P', description: null, imageUrl: null,
        videoUrl: null, websiteUrl: 'https://project.example/',
        twitterUrl: null, telegramUrl: null,
      }),
    })),
    social,
    options(),
    new ManualScheduler(),
  );

  assert.deepEqual(await worker.runOnce(), { kind: 'failed', jobId: 'social-job-1' });
  assert.equal(repository.completions.length, 0);
  assert.equal(repository.failures[0]?.failure.code, 'HTTP_TRANSIENT');
  assert.equal(repository.failures[0]?.terminalResult?.status, 'RESOLVED');
  assert.equal(repository.failures[0]?.terminalResult?.collection.status, 'FAILED');
});

void test('redacts thrown provider details into a stable retryable failure', async () => {
  const repository = new ScriptedRepository([claimedJob()]);
  const secret = 'https://user:secret@example.test/private';
  const worker = new SocialEnrichmentWorker(
    repository,
    metadataProvider(resolved()),
    { collect: async () => { throw new Error(secret); } },
    options(),
    new ManualScheduler(),
  );
  assert.equal((await worker.runOnce()).kind, 'failed');
  assert.equal(repository.failures[0]?.failure.code, 'PROVIDER_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(repository.failures), /secret|private/iu);
});

void test('renews an in-flight lease and suppresses completion after lease loss', async () => {
  const scheduler = new ManualScheduler();
  const repository = new ScriptedRepository([claimedJob()]);
  repository.renewResult = false;
  const pending = deferred<Awaited<ReturnType<SocialVerificationProvider['collect']>>>();
  const worker = new SocialEnrichmentWorker(
    repository,
    metadataProvider(resolved()),
    { collect: async () => pending.promise },
    options(),
    scheduler,
  );
  const running = worker.runOnce();
  await scheduler.waitForScheduled();
  await scheduler.fireNext();
  pending.resolve(await providerResult(snapshot(resolved())));
  assert.deepEqual(await running, { kind: 'lease-lost', jobId: 'social-job-1' });
  assert.equal(repository.renewals.length, 1);
  assert.equal(repository.completions.length, 0);
});

void test('starts idempotently, polls serially and closes without timers', async () => {
  const scheduler = new ManualScheduler();
  const repository = new ScriptedRepository([null]);
  const worker = new SocialEnrichmentWorker(
    repository,
    metadataProvider(resolved()),
    passthroughSocialProvider(),
    options(),
    scheduler,
  );
  await worker.start();
  await worker.start();
  assert.equal(worker.state, 'RUNNING');
  assert.equal(scheduler.activeCount, 1);
  await scheduler.fireNext();
  await scheduler.waitForScheduled();
  assert.equal(scheduler.activeCount, 1);
  await worker.close();
  assert.equal(worker.state, 'STOPPED');
  assert.equal(scheduler.activeCount, 0);
  await worker.start();
  assert.equal(scheduler.activeCount, 0);
});

void test('rejects hostile job and provider accessors without invoking getters', async () => {
  let getterCalls = 0;
  const hostileJob = Object.freeze(Object.defineProperty({}, 'metadataUri', {
    enumerable: true,
    get: () => { getterCalls += 1; throw new Error('job secret'); },
  })) as ClaimedSocialJob;
  const jobRepository = new ScriptedRepository([hostileJob]);
  const jobWorker = new SocialEnrichmentWorker(
    jobRepository, metadataProvider(resolved()), passthroughSocialProvider(),
    options(), new ManualScheduler(),
  );
  await assert.rejects(jobWorker.runOnce());
  assert.equal(getterCalls, 0);

  const providerRepository = new ScriptedRepository([claimedJob()]);
  const hostileResolution = Object.freeze(Object.defineProperty({}, 'status', {
    enumerable: true,
    get: () => { getterCalls += 1; throw new Error('provider secret'); },
  })) as MetadataResolution;
  const providerWorker = new SocialEnrichmentWorker(
    providerRepository, metadataProvider(hostileResolution), passthroughSocialProvider(),
    options(), new ManualScheduler(),
  );
  assert.equal((await providerWorker.runOnce()).kind, 'failed');
  assert.equal(getterCalls, 0);
  assert.equal(providerRepository.failures[0]?.failure.code, 'PROVIDER_UNAVAILABLE');

  const nestedRepository = new ScriptedRepository([claimedJob()]);
  const good = await providerResult(snapshot(resolved()));
  const hostileSnapshot = Object.freeze(Object.defineProperty({
    uri: good.metadataSnapshot.uri,
    resolution: good.metadataSnapshot.resolution,
    fetchedAtMs: good.metadataSnapshot.fetchedAtMs,
    payloadVersion: good.metadataSnapshot.payloadVersion,
  }, 'mint', {
    enumerable: true,
    get: () => { getterCalls += 1; throw new Error('nested secret'); },
  })) as TokenMetadataSnapshot;
  const nestedWorker = new SocialEnrichmentWorker(
    nestedRepository,
    metadataProvider(resolved()),
    { collect: async () => Object.freeze({ ...good, metadataSnapshot: hostileSnapshot }) },
    options(),
    new ManualScheduler(),
  );
  assert.equal((await nestedWorker.runOnce()).kind, 'failed');
  assert.equal(getterCalls, 0);
});

void test('degrades bounded shutdown and abandons the unresolved lease without timers', async () => {
  const scheduler = new ManualScheduler();
  const repository = new ScriptedRepository([claimedJob()]);
  const pending = deferred<Awaited<ReturnType<SocialVerificationProvider['collect']>>>();
  const worker = new SocialEnrichmentWorker(
    repository,
    metadataProvider(resolved()),
    { collect: async () => pending.promise },
    Object.freeze({ ...options(), shutdownTimeoutMs: 5 }),
    scheduler,
  );
  const running = worker.runOnce();
  await scheduler.waitForScheduled();
  await worker.close();
  assert.equal(worker.state, 'DEGRADED');
  assert.equal(scheduler.activeCount, 0);
  pending.resolve(await providerResult(snapshot(resolved())));
  assert.equal((await running).kind, 'lease-lost');
  assert.equal(repository.completions.length, 0);
  assert.equal(scheduler.activeCount, 0);
});

class ScriptedRepository implements SocialEvidenceRepository {
  readonly completions: { readonly job: ClaimedSocialJob; readonly result: SocialJobResult }[] = [];
  readonly failures: {
    readonly job: ClaimedSocialJob;
    readonly failure: SocialJobFailure;
    readonly terminalResult?: SocialJobResult;
  }[] = [];
  readonly renewals: readonly unknown[] = [];
  public renewResult = true;

  public constructor(private readonly claims: (ClaimedSocialJob | null)[]) {}

  public async claim(): Promise<ClaimedSocialJob | null> {
    return this.claims.shift() ?? null;
  }
  public async renew(...args: [string, string, number, number]): Promise<boolean> {
    (this.renewals as unknown[]).push(Object.freeze(args));
    return this.renewResult;
  }
  public async complete(job: ClaimedSocialJob, result: SocialJobResult): Promise<void> {
    this.completions.push(Object.freeze({ job, result }));
  }
  public async fail(
    job: ClaimedSocialJob,
    failure: SocialJobFailure,
    terminalResult?: SocialJobResult,
  ): Promise<void> {
    this.failures.push(Object.freeze(
      terminalResult === undefined ? { job, failure } : { job, failure, terminalResult },
    ));
  }
  public async counts(): Promise<SocialJobCounts> {
    return Object.freeze({ pending: 0, processing: 0, retryableFailed: 0, exhausted: 0 });
  }
}

class ManualScheduler implements SocialEnrichmentWorkerScheduler {
  readonly #callbacks = new Map<object, () => void>();
  #waiter: (() => void) | null = null;
  public get activeCount(): number { return this.#callbacks.size; }
  public now(): number { return NOW; }
  public schedule(callback: () => void, _delayMs: number): object {
    const handle = {};
    this.#callbacks.set(handle, callback);
    this.#waiter?.();
    this.#waiter = null;
    return handle;
  }
  public cancel(handle: unknown): void { this.#callbacks.delete(handle as object); }
  public async waitForScheduled(): Promise<void> {
    if (this.#callbacks.size !== 0) return;
    await new Promise<void>((resolve) => { this.#waiter = resolve; });
  }
  public async fireNext(): Promise<void> {
    const entry = this.#callbacks.entries().next().value as [object, () => void] | undefined;
    assert.ok(entry);
    this.#callbacks.delete(entry[0]);
    entry[1]();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function options() {
  return Object.freeze({
    pollIntervalMs: 100,
    leaseMs: 10_000,
    renewalIntervalMs: 1_000,
    shutdownTimeoutMs: 100,
  });
}

function claimedJob(overrides: Partial<ClaimedSocialJob> = {}): ClaimedSocialJob {
  return Object.freeze({
    id: 'social-job-1', mint: MINT, sourceLaunchEventId: 'launch-event-1',
    metadataUri: 'https://metadata.example/token.json', attempts: 1,
    attemptsInCycle: 1, leaseToken: 'lease-1', leaseExpiresAtMs: NOW + 10_000,
    ...overrides,
  });
}

function metadataProvider(resolution: MetadataResolution): MetadataProvider {
  return { resolve: async () => resolution };
}

function resolved(): MetadataResolution {
  return Object.freeze({
    status: 'RESOLVED' as const,
    metadata: Object.freeze({
      name: 'Project', symbol: 'P', description: null, imageUrl: null,
      videoUrl: null, websiteUrl: null, twitterUrl: null, telegramUrl: null,
    }),
  });
}

function failed(retryable: boolean): MetadataResolution {
  return Object.freeze({
    status: 'FAILED' as const,
    reason: 'FETCH_FAILED' as const,
    message: 'Metadata unavailable.',
    retryable,
  });
}

function snapshot(resolution: MetadataResolution): TokenMetadataSnapshot {
  return Object.freeze({
    mint: MINT,
    uri: 'https://metadata.example/token.json',
    resolution,
    fetchedAtMs: NOW,
    payloadVersion: 1,
  });
}

function passthroughSocialProvider(): SocialVerificationProvider {
  return { collect: async (input) => providerResult(input.metadataSnapshot) };
}

async function providerResult(metadataSnapshot: TokenMetadataSnapshot) {
  return await new PublicSocialVerificationProvider({
    get: async () => { throw new Error('no declared links'); },
  }).collect(Object.freeze({
    mint: metadataSnapshot.mint,
    sourceLaunchEventId: 'launch-event-1',
    metadataSnapshot,
  }));
}

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return Object.freeze({
    promise,
    resolve(value: T): void {
      const action = resolvePromise;
      assert.ok(action);
      action(value);
    },
  });
}

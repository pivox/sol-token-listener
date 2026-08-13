import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createTokenLaunchDetectedEvent } from '../src/domain/launchpad-events.js';
import { QualificationProjectionService } from '../src/application/qualification-projection.service.js';
import { QualificationRebuildService } from '../src/application/qualification-rebuild.service.js';
import { SocialQualificationRefreshService } from '../src/application/social-qualification-refresh.service.js';
import { createInitialDetectedTransition } from '../src/domain/state-transitions.js';
import type { TokenMetadataSnapshot } from '../src/domain/pumpfun-observation.js';
import type { SocialJobResult } from '../src/ports/social-evidence-repository.js';
import type { LaunchpadEventBatch } from '../src/ports/launchpad-event-sink.js';
import type { PublicHttpResult } from '../src/ports/public-http-client.js';
import { PublicSocialVerificationProvider } from '../src/social/public-social-verification.provider.js';
import { migrateDatabase } from '../src/storage/database.js';
import { createDefaultQualificationRuleSet,QualificationEngine } from '../src/qualification/qualification-engine.js';
import { PostgresPaperDecisionRepository } from '../src/storage/paper-decision.repository.js';
import { PostgresQualificationProjectionRepository } from '../src/storage/qualification-projection.repository.js';
import { PostgresLaunchpadEventRepository } from '../src/storage/launchpad-event.repository.js';
import {
  PostgresSocialEvidenceRepository,
  SocialJobLeaseLostError,
} from '../src/storage/social-evidence.repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const NOW = 1_786_300_000_000;
const MINT = 'So11111111111111111111111111111111111111112';

void test('claims one durable job exclusively and renews only its active lease', async (context) => {
  await withDatabase(context, async (pool) => {
    await enqueue(pool, MINT, 'signature-social-a');
    const repository = new PostgresSocialEvidenceRepository(pool);
    const claimed = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(claimed);
    assert.equal(claimed.mint, MINT);
    assert.equal(claimed.metadataUri, 'https://metadata.example/token.json');
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.attemptsInCycle, 1);
    assert.equal(claimed.leaseExpiresAtMs, NOW + 5_000);
    assert.equal(await repository.claim({ leaseMs: 5_000, nowMs: NOW }), null);
    assert.equal(await repository.renew(claimed.id, 'wrong-token', 5_000, NOW + 1), false);
    assert.equal(await repository.renew(claimed.id, claimed.leaseToken, 6_000, NOW + 1), true);
    const stored = await pool.query(`SELECT status,attempts,attempts_in_cycle,
      (EXTRACT(EPOCH FROM lease_expires_at)*1000)::bigint::text lease_ms
      FROM social_enrichment_jobs`);
    assert.deepEqual(stored.rows[0], {
      status: 'PROCESSING', attempts: 1, attempts_in_cycle: 1,
      lease_ms: String(NOW + 1 + 6_000),
    });
    await completeJob(repository,claimed,await successfulResult(claimed.sourceLaunchEventId));
    assert.equal((await pool.query('SELECT status FROM social_enrichment_jobs')).rows[0].status, 'COMPLETED');
  });
});

void test('terminalizes an expired final-attempt lease instead of stranding it processing', async (context) => {
  await withDatabase(context, async (pool) => {
    await new PostgresLaunchpadEventRepository(pool, 4, Date.now, {
      maxAttempts: 1, baseDelayMs: 500,
    }).record(launchBatch('mint-social-expired', 'signature-social-expired', 'confirmed'));
    const repository = new PostgresSocialEvidenceRepository(pool);
    const claimed = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(claimed);

    assert.equal(await repository.claim({ leaseMs: 5_000, nowMs: NOW + 5_001 }), null);
    const row = await pool.query(`SELECT status,error_code,retry_exhausted_at,
      EXTRACT(EPOCH FROM (purge_after-terminal_at))::int retention_seconds
      FROM social_enrichment_jobs`);
    assert.deepEqual(row.rows[0], {
      status: 'CANCELLED', error_code: 'LEASE_EXPIRED',
      retry_exhausted_at: new Date(NOW + 5_001), retention_seconds: 14_400,
    });
  });
});

void test('schedules bounded retry and reports durable queue counts', async (context) => {
  await withDatabase(context, async (pool) => {
    await enqueue(pool, 'mint-social-b', 'signature-social-b');
    const repository = new PostgresSocialEvidenceRepository(pool);
    const claimed = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(claimed);
    await repository.fail(claimed, Object.freeze({
      code: 'HTTP_TRANSIENT', retryable: true, observedAtMs: NOW + 10,
    }));
    assert.deepEqual(await repository.counts(), {
      pending: 0, processing: 0, retryableFailed: 1, exhausted: 0,
    });
    assert.equal(await repository.claim({ leaseMs: 5_000, nowMs: NOW + 499 }), null);
    const retry = await repository.claim({ leaseMs: 5_000, nowMs: NOW + 510 });
    assert.ok(retry);
    assert.equal(retry.attempts, 2);
    assert.equal(retry.attemptsInCycle, 2);
  });
});

void test('terminalizes permanent failures with exact four-hour retention', async (context) => {
  await withDatabase(context, async (pool) => {
    await enqueue(pool, 'mint-social-c', 'signature-social-c');
    const repository = new PostgresSocialEvidenceRepository(pool);
    const claimed = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(claimed);
    await repository.fail(claimed, Object.freeze({
      code: 'PROVIDER_UNAVAILABLE', retryable: false, observedAtMs: NOW + 20,
    }));
    assert.deepEqual(await repository.counts(), {
      pending: 0, processing: 0, retryableFailed: 0, exhausted: 0,
    });
    const row = await pool.query(`SELECT status,error_code,
      EXTRACT(EPOCH FROM (purge_after-terminal_at))::int retention_seconds
      FROM social_enrichment_jobs`);
    assert.deepEqual(row.rows[0], {
      status: 'CANCELLED', error_code: 'PROVIDER_UNAVAILABLE', retention_seconds: 14_400,
    });
  });
});

void test('persists explicit failed evidence when a transient social retry is exhausted', async (context) => {
  await withDatabase(context, async (pool) => {
    await new PostgresLaunchpadEventRepository(pool, 4, Date.now, {
      maxAttempts: 1, baseDelayMs: 500,
    }).record(launchBatch(MINT, 'signature-social-exhausted', 'confirmed'));
    const repository = new PostgresSocialEvidenceRepository(pool);
    const claimed = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(claimed);
    const terminalResult = await transientSocialResult(claimed.sourceLaunchEventId);

    const failure=Object.freeze({
      code: 'HTTP_TRANSIENT', retryable: true, observedAtMs: NOW + 20,
    });
    await repository.persist(claimed,terminalResult,failure);
    await repository.complete(claimed);

    const stored = await pool.query(`SELECT job.status,job.error_code,
      job.retry_exhausted_at,collection.collection_status,
      (SELECT COUNT(*)::int FROM social_verification_evidence) evidence_count,
      (SELECT COUNT(*)::int FROM api_event_stream
        WHERE event_type='SocialEvidenceCollected') revision_count
      FROM social_enrichment_jobs job
      LEFT JOIN social_evidence_collections collection ON collection.mint=job.mint`);
    assert.deepEqual(stored.rows[0], {
      status: 'COMPLETED', error_code: 'HTTP_TRANSIENT',
      retry_exhausted_at: new Date(NOW + 20), collection_status: 'FAILED',
      evidence_count: 1, revision_count: 1,
    });
  });
});

void test('atomically completes a leased job with safe projections and one SSE revision', async (context) => {
  await withDatabase(context, async (pool) => {
    await enqueue(pool, MINT, 'signature-social-complete');
    const repository = new PostgresSocialEvidenceRepository(pool);
    const claimed = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(claimed);
    const result = await successfulResult(claimed.sourceLaunchEventId);
    await completeJob(repository,claimed,result);

    const counts = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM token_metadata_snapshots) metadata,
      (SELECT COUNT(*)::int FROM social_evidence_collections) collections,
      (SELECT COUNT(*)::int FROM social_links) links,
      (SELECT COUNT(*)::int FROM social_http_observations) observations,
      (SELECT COUNT(*)::int FROM social_verification_evidence) evidence,
      (SELECT COUNT(*)::int FROM domain_events WHERE type='SocialEvidenceCollected') social_events,
      (SELECT COUNT(*)::int FROM api_event_stream WHERE event_type='SocialEvidenceCollected') revisions`);
    assert.deepEqual(counts.rows[0], {
      metadata: 1, collections: 1, links: 1, observations: 1,
      evidence: 3, social_events: 1, revisions: 1,
    });
    const stored = await pool.query(`SELECT status,lease_token,terminal_at,
      EXTRACT(EPOCH FROM (purge_after-terminal_at))::int retention_seconds
      FROM social_enrichment_jobs`);
    assert.deepEqual(stored.rows[0], {
      status: 'COMPLETED', lease_token: null, terminal_at: new Date(NOW),
      retention_seconds: 14_400,
    });

    await repository.complete(claimed);
    assert.equal((await pool.query(`SELECT COUNT(*)::int count FROM api_event_stream
      WHERE event_type='SocialEvidenceCollected'`)).rows[0].count, 1);
  });
});

void test('reclaims persisted evidence in a separate bounded projection retry cycle',async(context)=>{
  await withDatabase(context,async(pool)=>{
    await new PostgresLaunchpadEventRepository(pool,4,Date.now,{
      maxAttempts:2,baseDelayMs:500,
    }).record(launchBatch(MINT,'signature-social-projection-retry','confirmed'));
    const repository=new PostgresSocialEvidenceRepository(pool);
    const providerJob=await repository.claim({ leaseMs:5_000,nowMs:NOW });
    assert.ok(providerJob);
    const result=await successfulResult(providerJob.sourceLaunchEventId);
    await repository.persist(providerJob,result);
    const pending=await pool.query(`SELECT status,attempts_in_cycle,terminal_at,purge_after
      FROM social_enrichment_jobs`);
    assert.deepEqual(pending.rows,[{
      status:'PROCESSING',attempts_in_cycle:0,terminal_at:null,purge_after:null,
    }]);

    const firstRetry=await repository.claim({ leaseMs:5_000,nowMs:NOW+5_001 });
    assert.ok(firstRetry);
    assert.equal(firstRetry.evidencePersisted,true);
    assert.equal(firstRetry.attemptsInCycle,1);
    await repository.release(firstRetry,Object.freeze({
      code:'PROVIDER_UNAVAILABLE',retryable:true,observedAtMs:NOW+5_010,
    }));
    const secondRetry=await repository.claim({ leaseMs:5_000,nowMs:NOW+5_510 });
    assert.ok(secondRetry);
    assert.equal(secondRetry.evidencePersisted,true);
    assert.equal(secondRetry.attemptsInCycle,2);
    await repository.release(secondRetry,Object.freeze({
      code:'PROVIDER_UNAVAILABLE',retryable:true,observedAtMs:NOW+5_520,
    }));

    assert.deepEqual(await repository.counts(),{
      pending:0,processing:0,retryableFailed:0,exhausted:1,
    });
    const stored=await pool.query(`SELECT status,
      (SELECT COUNT(*)::int FROM social_evidence_collections) collections,
      (SELECT COUNT(*)::int FROM domain_events WHERE type='SocialEvidenceCollected') events
      FROM social_enrichment_jobs`);
    assert.deepEqual(stored.rows,[{ status:'CANCELLED',collections:1,events:1 }]);
  });
});

void test('releases an ambiguous committed persist and reclaims its durable evidence',async(context)=>{
  await withDatabase(context,async(pool)=>{
    await enqueue(pool,MINT,'signature-social-ambiguous-commit');
    const repository=new PostgresSocialEvidenceRepository(pool);
    const providerJob=await repository.claim({ leaseMs:5_000,nowMs:NOW });
    assert.ok(providerJob);
    await repository.persist(providerJob,await successfulResult(providerJob.sourceLaunchEventId));

    assert.equal(await repository.release(providerJob,Object.freeze({
      code:'PROVIDER_UNAVAILABLE',retryable:true,observedAtMs:NOW+10,
    })),true);
    assert.equal(await repository.claim({ leaseMs:5_000,nowMs:NOW+509 }),null);
    const projectionJob=await repository.claim({ leaseMs:5_000,nowMs:NOW+510 });
    assert.ok(projectionJob);
    assert.equal(projectionJob.evidencePersisted,true);
    assert.equal(projectionJob.attemptsInCycle,1);

    assert.equal(await repository.release(providerJob,Object.freeze({
      code:'PROVIDER_UNAVAILABLE',retryable:true,observedAtMs:NOW+511,
    })),false);
    const stored=await pool.query(`SELECT status,lease_token,
      (SELECT COUNT(*)::int FROM social_evidence_collections) collections,
      (SELECT COUNT(*)::int FROM domain_events WHERE type='SocialEvidenceCollected') events
      FROM social_enrichment_jobs`);
    assert.deepEqual(stored.rows,[{
      status:'PROCESSING',lease_token:projectionJob.leaseToken,collections:1,events:1,
    }]);
  });
});

void test('releases a rolled-back persist outcome for a provider retry without evidence',async(context)=>{
  await withDatabase(context,async(pool)=>{
    await enqueue(pool,MINT,'signature-social-ambiguous-rollback');
    const repository=new PostgresSocialEvidenceRepository(pool);
    const first=await repository.claim({ leaseMs:5_000,nowMs:NOW });
    assert.ok(first);

    assert.equal(await repository.release(first,Object.freeze({
      code:'PROVIDER_UNAVAILABLE',retryable:true,observedAtMs:NOW+10,
    })),true);
    const retry=await repository.claim({ leaseMs:5_000,nowMs:NOW+510 });
    assert.ok(retry);
    assert.equal(retry.evidencePersisted,false);
    assert.equal(retry.attemptsInCycle,2);
  });
});

void test('rebuilds qualification from persisted social evidence before enqueuing exact paper work',async(context)=>{
  await withDatabase(context,async(pool)=>{
    await enqueue(pool,MINT,'signature-social-live-refresh');
    const liveNow=Date.now();
    await pool.query(`UPDATE raw_chain_events SET observed_at=$1 WHERE mint=$2`,[
      new Date(liveNow),MINT,
    ]);
    await pool.query(`UPDATE domain_events SET observed_at=$1 WHERE mint=$2`,[
      new Date(liveNow),MINT,
    ]);
    const rebuilder=new QualificationRebuildService(new QualificationEngine(
      createDefaultQualificationRuleSet(60),
    ));
    const qualification=new QualificationProjectionService(
      new PostgresQualificationProjectionRepository(pool,rebuilder),rebuilder,['quote'],
    );
    const before=await qualification.rebuild(MINT,'ERROR');
    assert.ok(before.projection);
    const paper=new PostgresPaperDecisionRepository(pool,{},
      createDefaultQualificationRuleSet(60));
    const refresh=new SocialQualificationRefreshService(qualification,paper);
    const social=new PostgresSocialEvidenceRepository(pool);
    const job=await social.claim({ leaseMs:5_000,nowMs:liveNow });
    assert.ok(job);
    await social.persist(job,await successfulResult(job.sourceLaunchEventId));

    await refresh.refresh(MINT);
    await social.complete(job);

    const current=await pool.query(`SELECT report_id,source_event_id,source_raw_event_id,
      evidence_fingerprint FROM qualification_reports
      WHERE mint=$1 AND profile_id='pumpfun-v1-initial'
        AND profile_version=1 AND superseded_at IS NULL`,[MINT]);
    assert.equal(current.rowCount,1);
    assert.notEqual(current.rows[0]?.report_id,before.projection.reportId);
    const queued=await pool.query(`SELECT source_event_id,source_raw_event_id,
      source_confirmation_status,input_fingerprint,status FROM paper_decision_jobs`);
    assert.deepEqual(queued.rows,[{
      source_event_id:current.rows[0]?.source_event_id,
      source_raw_event_id:current.rows[0]?.source_raw_event_id,
      source_confirmation_status:'confirmed',
      input_fingerprint:current.rows[0]?.evidence_fingerprint,
      status:'PENDING',
    }]);
  });
});

void test('rolls back every projection when the derived event cannot be inserted', async (context) => {
  await withDatabase(context, async (pool) => {
    await enqueue(pool, MINT, 'signature-social-rollback');
    const repository = new PostgresSocialEvidenceRepository(pool);
    const claimed = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(claimed);
    const result = await successfulResult(claimed.sourceLaunchEventId);
    await pool.query(`ALTER TABLE domain_events ADD CONSTRAINT reject_social_completion
      CHECK (type <> 'SocialEvidenceCollected')`);
    await assert.rejects(repository.persist(claimed,result));
    const counts = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM token_metadata_snapshots) metadata,
      (SELECT COUNT(*)::int FROM social_evidence_collections) collections,
      (SELECT COUNT(*)::int FROM social_links) links,
      (SELECT COUNT(*)::int FROM social_http_observations) observations,
      (SELECT COUNT(*)::int FROM social_verification_evidence) evidence`);
    assert.deepEqual(counts.rows[0], {
      metadata: 0, collections: 0, links: 0, observations: 0, evidence: 0,
    });
    assert.equal((await pool.query('SELECT status FROM social_enrichment_jobs')).rows[0].status, 'PROCESSING');
  });
});

void test('completes permanent metadata failure as explicit available evidence', async (context) => {
  await withDatabase(context, async (pool) => {
    const mint = '11111111111111111111111111111111';
    await enqueue(pool, mint, 'signature-social-metadata-failed');
    const repository = new PostgresSocialEvidenceRepository(pool);
    const claimed = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(claimed);
    await completeJob(repository,claimed,await failedResult(mint,claimed.sourceLaunchEventId));
    const row = await pool.query(`SELECT collection.collection_status,
      metadata.resolution_status,metadata.failure_reason,metadata.failure_retryable,
      (SELECT COUNT(*)::int FROM social_verification_evidence) evidence_count
      FROM social_evidence_collections collection
      JOIN token_metadata_snapshots metadata
        ON metadata.snapshot_id=collection.metadata_snapshot_id`);
    assert.deepEqual(row.rows[0], {
      collection_status: 'FAILED', resolution_status: 'failed',
      failure_reason: 'FETCH_FAILED', failure_retryable: false, evidence_count: 1,
    });
  });
});

void test('advances one derived event through source finality without duplicate revisions', async (context) => {
  await withDatabase(context, async (pool) => {
    const launchRepository = new PostgresLaunchpadEventRepository(pool);
    await enqueue(pool, MINT, 'signature-social-finality', 'processed');
    const repository = new PostgresSocialEvidenceRepository(pool);
    const claimed = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(claimed);
    await completeJob(repository,claimed,await successfulResult(claimed.sourceLaunchEventId));
    await launchRepository.record(launchBatch(MINT, 'signature-social-finality', 'confirmed'));
    await launchRepository.record(launchBatch(MINT, 'signature-social-finality', 'finalized'));
    await launchRepository.record(launchBatch(MINT, 'signature-social-finality', 'finalized'));

    const event = await pool.query(`SELECT confirmation_status FROM domain_events
      WHERE type='SocialEvidenceCollected'`);
    assert.equal(event.rows[0].confirmation_status, 'finalized');
    const revisions = await pool.query(`SELECT revision,confirmation_status
      FROM api_event_stream WHERE event_type='SocialEvidenceCollected'
      ORDER BY revision`);
    assert.deepEqual(revisions.rows, [
      { revision: '1', confirmation_status: 'processed' },
      { revision: '2', confirmation_status: 'confirmed' },
      { revision: '3', confirmation_status: 'finalized' },
    ]);
  });
});

void test('orphans completed projections and rejects an in-flight stale completion', async (context) => {
  await withDatabase(context, async (pool) => {
    const launchRepository = new PostgresLaunchpadEventRepository(pool, 4, () => NOW + 100);
    await enqueue(pool, MINT, 'signature-social-orphan', 'processed');
    const repository = new PostgresSocialEvidenceRepository(pool);
    const claimed = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(claimed);
    await completeJob(repository,claimed,await successfulResult(claimed.sourceLaunchEventId));
    await launchRepository.record(launchBatch(MINT, 'signature-social-orphan', 'orphaned'));
    const projections = await pool.query(`SELECT collection.confirmation_status,
      collection.terminal_at,event.confirmation_status event_status,event.terminal_at event_terminal,
      metadata.purge_after metadata_purge
      FROM social_evidence_collections collection
      JOIN domain_events event ON event.type='SocialEvidenceCollected'
        AND event.payload->>'collectionId'=collection.collection_id
      JOIN token_metadata_snapshots metadata
        ON metadata.snapshot_id=collection.metadata_snapshot_id`);
    assert.equal(projections.rows[0].confirmation_status, 'orphaned');
    assert.equal(projections.rows[0].event_status, 'orphaned');
    assert.equal(projections.rows[0].terminal_at instanceof Date, true);
    assert.equal(projections.rows[0].event_terminal instanceof Date, true);
    assert.equal(projections.rows[0].metadata_purge instanceof Date, true);

    await enqueue(pool, '11111111111111111111111111111111', 'signature-social-inflight', 'processed');
    const inFlight = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(inFlight);
    const inFlightResult = await failedResult(inFlight.mint, inFlight.sourceLaunchEventId);
    await launchRepository.record(launchBatch(
      inFlight.mint, 'signature-social-inflight', 'orphaned',
    ));
    await assert.rejects(repository.persist(inFlight,inFlightResult),SocialJobLeaseLostError);
  });
});

async function enqueue(
  pool: InstanceType<typeof pg.Pool>,
  mint: string,
  signature: string,
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' = 'confirmed',
): Promise<void> {
  await new PostgresLaunchpadEventRepository(pool).record(
    launchBatch(mint, signature, confirmationStatus),
  );
}

async function completeJob(
  repository:PostgresSocialEvidenceRepository,
  job:NonNullable<Awaited<ReturnType<PostgresSocialEvidenceRepository['claim']>>>,
  result:SocialJobResult,
):Promise<void>{
  await repository.persist(job,result);
  await repository.complete(job);
}

function launchBatch(
  mint: string,
  signature: string,
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | 'orphaned',
): LaunchpadEventBatch {
  const transaction = Object.freeze({
    signature,
    confirmationStatus,
    blockTimeMs: 1_000,
    observedAtMs: NOW,
    cursor: Object.freeze({ slot: 10n, transactionIndex: 0 }),
    raw: null,
  });
  const launch = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: 'pump',
    transaction,
    launch: Object.freeze({
      mint,
      creator: 'creator',
      tokenProgram: 'SPL_TOKEN' as const,
      quoteAssets: Object.freeze([Object.freeze({
        mint: 'quote', decimals: 9, tokenProgram: 'SPL_TOKEN' as const,
      })]),
      launchpad: 'pumpfun',
      createdAt: Object.freeze({
        slot: 10n, transactionIndex: 0, instructionIndex: 1, innerInstructionIndex: null,
      }),
      parameters: Object.freeze({ uri: 'https://metadata.example/token.json' }),
    }),
  });
  const common = Object.freeze({
    source: 'pumpfun',
    program: 'pump',
    signature,
    events: Object.freeze([launch]),
  });
  if (confirmationStatus === 'orphaned') return Object.freeze({
    ...common,
    confirmationStatus,
    stateTransitionAction: 'retract' as const,
    transitions: Object.freeze([] as const),
  });
  return Object.freeze({
    ...common,
    confirmationStatus,
    stateTransitionAction: 'apply' as const,
    transitions: Object.freeze([createInitialDetectedTransition(launch)]),
  });
}

async function successfulResult(sourceLaunchEventId: string): Promise<SocialJobResult> {
  const snapshot: TokenMetadataSnapshot = Object.freeze({
    mint: MINT,
    uri: 'https://metadata.example/token.json',
    resolution: Object.freeze({
      status: 'RESOLVED' as const,
      metadata: Object.freeze({
        name: 'Project', symbol: 'P', description: 'Public project',
        imageUrl: null, videoUrl: null, websiteUrl: 'https://project.example/',
        twitterUrl: null, telegramUrl: null,
      }),
    }),
    fetchedAtMs: NOW,
    payloadVersion: 1,
  });
  const page: PublicHttpResult = Object.freeze({
    status: 'SUCCEEDED' as const,
    finalUrl: 'https://project.example/',
    httpStatus: 200,
    contentType: 'text/html',
    redirectCount: 0,
    body: new TextEncoder().encode(`<p>${MINT}</p>`),
  });
  const collected = await new PublicSocialVerificationProvider({
    get: async () => page,
  }).collect(Object.freeze({ mint: MINT, sourceLaunchEventId, metadataSnapshot: snapshot }));
  return Object.freeze({ status: 'RESOLVED' as const, ...collected });
}

async function transientSocialResult(sourceLaunchEventId: string): Promise<SocialJobResult> {
  const snapshot: TokenMetadataSnapshot = Object.freeze({
    mint: MINT,
    uri: 'https://metadata.example/token.json',
    resolution: Object.freeze({
      status: 'RESOLVED' as const,
      metadata: Object.freeze({
        name: 'Project', symbol: 'P', description: null, imageUrl: null,
        videoUrl: null, websiteUrl: 'https://project.example/',
        twitterUrl: null, telegramUrl: null,
      }),
    }),
    fetchedAtMs: NOW,
    payloadVersion: 1,
  });
  const collected = await new PublicSocialVerificationProvider({
    get: async () => Object.freeze({
      status: 'FAILED' as const, reason: 'TIMEOUT' as const, retryable: true,
    }),
  }).collect(Object.freeze({ mint: MINT, sourceLaunchEventId, metadataSnapshot: snapshot }));
  assert.equal(collected.retryable, true);
  assert.equal(collected.collection.status, 'FAILED');
  return Object.freeze({
    status: 'RESOLVED' as const,
    metadataSnapshot: collected.metadataSnapshot,
    collection: collected.collection,
  });
}

async function failedResult(mint: string, sourceLaunchEventId: string): Promise<SocialJobResult> {
  const snapshot: TokenMetadataSnapshot = Object.freeze({
    mint,
    uri: 'https://metadata.example/token.json',
    resolution: Object.freeze({
      status: 'FAILED' as const,
      reason: 'FETCH_FAILED' as const,
      message: 'Metadata unavailable.',
      retryable: false,
    }),
    fetchedAtMs: NOW,
    payloadVersion: 1,
  });
  const collection = (await new PublicSocialVerificationProvider({
    get: async () => { throw new Error('must not fetch'); },
  }).collect(Object.freeze({ mint, sourceLaunchEventId, metadataSnapshot: snapshot }))).collection;
  return Object.freeze({ status: 'METADATA_FAILED' as const, metadataSnapshot: snapshot, collection });
}

async function withDatabase(
  context: { skip(message?: string): void },
  run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `social_repository_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await migrateDatabase({ pool });
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

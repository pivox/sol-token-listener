import { createHash, randomUUID } from 'node:crypto';
import { createDeterministicDerivedEventId } from '../domain/events.js';
import {
  createSocialCollection,
  PUBLIC_SOCIAL_RETENTION_HOURS,
  socialMetadataSnapshotId,
} from '../domain/social-evidence.js';
import type {
  ClaimedSocialJob,
  SocialEvidenceRepository,
  SocialJobCounts,
  SocialJobFailure,
  SocialJobResult,
} from '../ports/social-evidence-repository.js';
import { getDatabasePool } from './database.js';
import { canonicalStringifyJson, toJsonValue } from '../utils/json.js';

interface Result { readonly rows: readonly unknown[]; readonly rowCount?: number | null }
interface Client { query(text: string, values?: readonly unknown[]): Promise<Result>; release(): void }
interface Pool { connect(): Promise<Client> }

export class SocialEvidenceRepositoryError extends Error {
  public constructor(
    public readonly operation: 'claim' | 'renew' | 'persist' | 'complete' | 'release' | 'fail' | 'counts',
  ) {
    super('Social evidence repository operation failed.');
    this.name = 'SocialEvidenceRepositoryError';
  }
}

export class SocialJobLeaseLostError extends Error {
  public constructor() {
    super('Social enrichment job lease is no longer active.');
    this.name = 'SocialJobLeaseLostError';
  }
}

export class PostgresSocialEvidenceRepository implements SocialEvidenceRepository {
  public constructor(
    private readonly pool: Pool = getDatabasePool(),
    private readonly retentionHours = PUBLIC_SOCIAL_RETENTION_HOURS,
  ) {
    if (
      !Number.isSafeInteger(retentionHours)
      || retentionHours !== PUBLIC_SOCIAL_RETENTION_HOURS
    ) {
      throw new RangeError('Social evidence retention must be four hours.');
    }
  }

  public async claim(options: Readonly<{
    leaseMs: number;
    nowMs: number;
  }>): Promise<ClaimedSocialJob | null> {
    positiveInteger(options.leaseMs, 'leaseMs');
    timestamp(options.nowMs, 'nowMs');
    const client = await this.connect('claim');
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE social_enrichment_jobs SET
        status='CANCELLED',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
        error_code='LEASE_EXPIRED',retry_exhausted_at=$1,terminal_at=$1,
        purge_after=$2,updated_at=$1
        WHERE status='PROCESSING' AND lease_expires_at <= $1
          AND attempts_in_cycle >= max_attempts`, [
        new Date(options.nowMs),
        new Date(options.nowMs + this.retentionHours * 3_600_000),
      ]);
      const leaseToken = `social_lease_${randomUUID()}`;
      const result = await client.query(`WITH candidate AS (
        SELECT job.job_id
        FROM social_enrichment_jobs job
        JOIN domain_events source ON source.event_id=job.source_launch_event_id
        WHERE source.confirmation_status <> 'orphaned'
          AND job.attempts_in_cycle < job.max_attempts
          AND (
            job.status='PENDING'
            OR (job.status='RETRYABLE_FAILED' AND job.next_attempt_at <= $1)
            OR (job.status='PROCESSING' AND job.lease_expires_at <= $1)
          )
        ORDER BY COALESCE(job.next_attempt_at,job.created_at),job.created_at,job.job_id
        FOR UPDATE OF job SKIP LOCKED
        LIMIT 1
      )
      UPDATE social_enrichment_jobs job SET
        status='PROCESSING',attempts=job.attempts+1,
        attempts_in_cycle=job.attempts_in_cycle+1,
        lease_token=$2,lease_expires_at=$3,next_attempt_at=NULL,
        error_code=NULL,updated_at=$1
      FROM candidate WHERE job.job_id=candidate.job_id
      RETURNING job.job_id,job.mint,job.source_launch_event_id,job.metadata_uri,
        job.attempts,job.attempts_in_cycle,job.max_attempts,
        EXISTS(SELECT 1 FROM social_evidence_collections collection
          WHERE collection.mint=job.mint
            AND collection.source_launch_event_id=job.source_launch_event_id) AS evidence_persisted,
        job.lease_token,job.lease_expires_at`, [
        new Date(options.nowMs),
        leaseToken,
        new Date(options.nowMs + options.leaseMs),
      ]);
      await client.query('COMMIT');
      const row = result.rows[0];
      return row === undefined ? null : claimedJob(row);
    } catch {
      await rollback(client);
      throw new SocialEvidenceRepositoryError('claim');
    } finally {
      release(client, 'claim');
    }
  }

  public async renew(
    jobId: string,
    leaseToken: string,
    leaseMs: number,
    nowMs: number,
  ): Promise<boolean> {
    boundedText(jobId, 'jobId');
    boundedText(leaseToken, 'leaseToken');
    positiveInteger(leaseMs, 'leaseMs');
    timestamp(nowMs, 'nowMs');
    const client = await this.connect('renew');
    try {
      const result = await client.query(`UPDATE social_enrichment_jobs SET
        lease_expires_at=$4,updated_at=$3
        WHERE job_id=$1 AND status='PROCESSING' AND lease_token=$2
          AND lease_expires_at > $3
        RETURNING job_id`, [jobId,leaseToken,new Date(nowMs),new Date(nowMs + leaseMs)]);
      return result.rowCount === 1;
    } catch {
      throw new SocialEvidenceRepositoryError('renew');
    } finally {
      release(client, 'renew');
    }
  }

  public async persist(
    job: ClaimedSocialJob,
    result: SocialJobResult,
    terminalFailure?: SocialJobFailure,
  ): Promise<void> {
    assertClaimedJob(job);
    assertJobResult(job, result);
    if(terminalFailure!==undefined)assertFailure(terminalFailure);
    const client = await this.connect('persist');
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [job.mint]);
      const selected = await client.query(`SELECT status,lease_token,attempts,
        attempts_in_cycle,lease_expires_at FROM social_enrichment_jobs
        WHERE job_id=$1 FOR UPDATE`, [job.id]);
      const jobRow = selected.rows[0];
      if (jobRow === undefined) throw new SocialJobLeaseLostError();
      const status = textField(jobRow, 'status');
      if (status !== 'PROCESSING' || nullableTextField(jobRow, 'lease_token') !== job.leaseToken) {
        throw new SocialJobLeaseLostError();
      }
      assertLeaseRow(jobRow, job);

      const sourceResult = await client.query(`SELECT source.event_id,source.raw_event_id,
        source.program,source.signature,source.slot::text AS slot,
        source.transaction_index,source.instruction_index,source.inner_instruction_index,
        source.confirmation_status,source.blockchain_time,raw.event_id AS checked_raw_event_id
        FROM domain_events source
        JOIN raw_chain_events raw ON raw.event_id=source.raw_event_id
        WHERE source.event_id=$1 AND source.mint=$2
        FOR UPDATE OF source,raw`, [job.sourceLaunchEventId,job.mint]);
      const source = sourceResult.rows[0];
      if (source === undefined || textField(source, 'confirmation_status') === 'orphaned') {
        throw new SocialJobLeaseLostError();
      }

      if(job.evidencePersisted){
        await assertCompletionReplay(client,job,result);
      }else{
        await writeMetadataSnapshot(client, job, result);
        await writeSocialCollection(client, source, result);
        await writeSocialDerivedEvent(client, source, result);
      }
      await exact(client, `UPDATE social_enrichment_jobs SET
        attempts_in_cycle=0,error_code=COALESCE($3,error_code),
        retry_exhausted_at=COALESCE($4,retry_exhausted_at),updated_at=$5
        WHERE job_id=$1 AND lease_token=$2`, [
        job.id,job.leaseToken,terminalFailure?.code??null,
        terminalFailure?.retryable===true?new Date(terminalFailure.observedAtMs):null,
        new Date(terminalFailure?.observedAtMs??result.collection.observedAtMs),
      ]);
      await client.query('COMMIT');
    } catch (error: unknown) {
      await rollback(client);
      if (error instanceof SocialJobLeaseLostError) throw error;
      throw new SocialEvidenceRepositoryError('persist');
    } finally {
      release(client, 'persist');
    }
  }

  public async complete(job: ClaimedSocialJob): Promise<void> {
    assertClaimedJob(job);
    const client=await this.connect('complete');
    try{
      await client.query('BEGIN');
      const selected=await client.query(`SELECT job.status,
        EXISTS(SELECT 1 FROM social_evidence_collections collection
          WHERE collection.mint=job.mint
            AND collection.source_launch_event_id=job.source_launch_event_id) AS evidence_persisted
        FROM social_enrichment_jobs job WHERE job.job_id=$1 FOR UPDATE`,[job.id]);
      const row=selected.rows[0];
      if(
        row!==undefined
        &&textField(row,'status')==='COMPLETED'
        &&booleanField(row,'evidence_persisted')
      ){
        await client.query('COMMIT');
        return;
      }
      const result=await client.query(`UPDATE social_enrichment_jobs job SET
        status='COMPLETED',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
        terminal_at=collection.observed_at,
        purge_after=collection.observed_at + INTERVAL '4 hours',
        updated_at=GREATEST(job.updated_at,collection.observed_at)
        FROM social_evidence_collections collection
        JOIN domain_events source ON source.event_id=collection.source_launch_event_id
        WHERE job.job_id=$1 AND job.lease_token=$2 AND job.status='PROCESSING'
          AND collection.mint=job.mint
          AND collection.source_launch_event_id=job.source_launch_event_id
          AND source.confirmation_status<>'orphaned'`,[job.id,job.leaseToken]);
      if(result.rowCount!==1)throw new SocialJobLeaseLostError();
      await client.query('COMMIT');
    }catch(error:unknown){
      await rollback(client);
      if(error instanceof SocialJobLeaseLostError)throw error;
      throw new SocialEvidenceRepositoryError('complete');
    }finally{release(client,'complete');}
  }

  public async release(job:ClaimedSocialJob,failure:SocialJobFailure):Promise<void>{
    assertClaimedJob(job);assertFailure(failure);
    const client=await this.connect('release');
    try{
      await client.query('BEGIN');
      const selected=await client.query(`SELECT attempts_in_cycle,max_attempts,base_delay_ms
        FROM social_enrichment_jobs job
        WHERE job.job_id=$1 AND job.status='PROCESSING' AND job.lease_token=$2
          AND EXISTS(SELECT 1 FROM social_evidence_collections collection
            WHERE collection.mint=job.mint
              AND collection.source_launch_event_id=job.source_launch_event_id)
        FOR UPDATE`,[job.id,job.leaseToken]);
      const row=selected.rows[0];
      if(row===undefined)throw new SocialJobLeaseLostError();
      const attempts=integerField(row,'attempts_in_cycle');
      const maximum=integerField(row,'max_attempts');
      const now=new Date(failure.observedAtMs);
      if(failure.retryable&&attempts<maximum){
        await exact(client,`UPDATE social_enrichment_jobs SET
          status='RETRYABLE_FAILED',lease_token=NULL,lease_expires_at=NULL,
          next_attempt_at=$3,error_code=$4,updated_at=$5
          WHERE job_id=$1 AND lease_token=$2`,[
          job.id,job.leaseToken,new Date(failure.observedAtMs+retryDelay(
            integerField(row,'base_delay_ms'),Math.max(1,attempts),
          )),failure.code,now,
        ]);
      }else{
        await exact(client,`UPDATE social_enrichment_jobs SET
          status='CANCELLED',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
          error_code=$3,retry_exhausted_at=$4,terminal_at=$4,purge_after=$5,updated_at=$4
          WHERE job_id=$1 AND lease_token=$2`,[
          job.id,job.leaseToken,failure.code,now,
          new Date(failure.observedAtMs+this.retentionHours*3_600_000),
        ]);
      }
      await client.query('COMMIT');
    }catch(error:unknown){
      await rollback(client);
      if(error instanceof SocialJobLeaseLostError)throw error;
      throw new SocialEvidenceRepositoryError('release');
    }finally{release(client,'release');}
  }

  public async fail(
    job: ClaimedSocialJob,
    failure: SocialJobFailure,
    terminalResult?: SocialJobResult,
  ): Promise<void> {
    assertClaimedJob(job);
    assertFailure(failure);
    if (terminalResult !== undefined) assertJobResult(job, terminalResult);
    const client = await this.connect('fail');
    try {
      await client.query('BEGIN');
      const selected = await client.query(`SELECT attempts,attempts_in_cycle,max_attempts,
        base_delay_ms,lease_expires_at FROM social_enrichment_jobs
        WHERE job_id=$1 AND status='PROCESSING' AND lease_token=$2
        FOR UPDATE`, [job.id,job.leaseToken]);
      const row = selected.rows[0];
      if (row === undefined) throw new Error('STALE_LEASE');
      assertLeaseRow(row, job);
      const attemptsInCycle = integerField(row, 'attempts_in_cycle');
      const maxAttempts = integerField(row, 'max_attempts');
      const observedAt = new Date(failure.observedAtMs);
      if (failure.retryable && attemptsInCycle < maxAttempts) {
        const delayMs = retryDelay(integerField(row, 'base_delay_ms'), attemptsInCycle);
        await exact(client, `UPDATE social_enrichment_jobs SET
          status='RETRYABLE_FAILED',lease_token=NULL,lease_expires_at=NULL,
          next_attempt_at=$3,error_code=$4,updated_at=$5
          WHERE job_id=$1 AND lease_token=$2`, [
          job.id,job.leaseToken,new Date(failure.observedAtMs + delayMs),failure.code,observedAt,
        ]);
      } else {
        const purgeAfter = new Date(
          failure.observedAtMs + this.retentionHours * 3_600_000,
        );
        if (terminalResult !== undefined) {
          const sourceResult = await client.query(`SELECT source.event_id,source.raw_event_id,
            source.program,source.signature,source.slot::text AS slot,
            source.transaction_index,source.instruction_index,source.inner_instruction_index,
            source.confirmation_status,source.blockchain_time,raw.event_id AS checked_raw_event_id
            FROM domain_events source
            JOIN raw_chain_events raw ON raw.event_id=source.raw_event_id
            WHERE source.event_id=$1 AND source.mint=$2
            FOR UPDATE OF source,raw`, [job.sourceLaunchEventId,job.mint]);
          const source = sourceResult.rows[0];
          if (source === undefined || textField(source, 'confirmation_status') === 'orphaned') {
            throw new SocialJobLeaseLostError();
          }
          await writeMetadataSnapshot(client, job, terminalResult);
          await writeSocialCollection(client, source, terminalResult);
          await writeSocialDerivedEvent(client, source, terminalResult);
          await exact(client, `UPDATE social_enrichment_jobs SET
            status='COMPLETED',lease_token=NULL,lease_expires_at=NULL,
            next_attempt_at=NULL,error_code=$3,retry_exhausted_at=$4,
            terminal_at=$5,purge_after=$6,updated_at=$5
            WHERE job_id=$1 AND lease_token=$2`, [
            job.id,job.leaseToken,failure.code,failure.retryable ? observedAt : null,
            observedAt,purgeAfter,
          ]);
        } else {
          await exact(client, `UPDATE social_enrichment_jobs SET
            status='CANCELLED',lease_token=NULL,lease_expires_at=NULL,
            next_attempt_at=NULL,error_code=$3,retry_exhausted_at=$4,
            terminal_at=$5,purge_after=$6,updated_at=$5
            WHERE job_id=$1 AND lease_token=$2`, [
            job.id,job.leaseToken,failure.code,failure.retryable ? observedAt : null,
            observedAt,purgeAfter,
          ]);
        }
      }
      await client.query('COMMIT');
    } catch {
      await rollback(client);
      throw new SocialEvidenceRepositoryError('fail');
    } finally {
      release(client, 'fail');
    }
  }

  public async counts(): Promise<SocialJobCounts> {
    const client = await this.connect('counts');
    try {
      const result = await client.query(`SELECT
        COUNT(*) FILTER (WHERE status='PENDING')::int AS pending,
        COUNT(*) FILTER (WHERE status='PROCESSING')::int AS processing,
        COUNT(*) FILTER (WHERE status='RETRYABLE_FAILED')::int AS retryable_failed,
        COUNT(*) FILTER (WHERE retry_exhausted_at IS NOT NULL)::int AS exhausted
        FROM social_enrichment_jobs`);
      const row = result.rows[0];
      if (row === undefined) throw new TypeError('Social job counts are missing.');
      return Object.freeze({
        pending: integerField(row, 'pending'),
        processing: integerField(row, 'processing'),
        retryableFailed: integerField(row, 'retryable_failed'),
        exhausted: integerField(row, 'exhausted'),
      });
    } catch {
      throw new SocialEvidenceRepositoryError('counts');
    } finally {
      release(client, 'counts');
    }
  }

  async connect(operation: SocialEvidenceRepositoryError['operation']): Promise<Client> {
    try {
      return await this.pool.connect();
    } catch {
      throw new SocialEvidenceRepositoryError(operation);
    }
  }
}

function assertJobResult(job: ClaimedSocialJob, result: SocialJobResult): void {
  const snapshot = result.metadataSnapshot;
  const collection = result.collection;
  if (
    snapshot.mint !== job.mint
    || collection.mint !== job.mint
    || collection.sourceLaunchEventId !== job.sourceLaunchEventId
    || (job.metadataUri !== null && snapshot.uri !== job.metadataUri)
    || (result.status === 'RESOLVED' && snapshot.resolution.status !== 'RESOLVED')
    || (result.status === 'METADATA_FAILED' && snapshot.resolution.status !== 'FAILED')
    || (result.status === 'METADATA_FAILED' && collection.status !== 'FAILED')
  ) throw new TypeError('Social job result context is invalid.');
  const expectedMetadataId = socialMetadataSnapshotId({
    sourceLaunchEventId: job.sourceLaunchEventId,
    snapshot,
  });
  if (collection.metadataSnapshotId !== expectedMetadataId) {
    throw new TypeError('Social metadata identity conflicts.');
  }
  const rebuilt = createSocialCollection(Object.freeze({
    mint: collection.mint,
    sourceLaunchEventId: collection.sourceLaunchEventId,
    metadataSnapshotId: collection.metadataSnapshotId,
    status: collection.status,
    links: collection.links,
    observations: collection.observations,
    evidence: collection.evidence,
    observedAtMs: collection.observedAtMs,
  }));
  if (canonicalStringifyJson(rebuilt) !== canonicalStringifyJson(collection)) {
    throw new TypeError('Social collection identity conflicts.');
  }
}

async function writeMetadataSnapshot(
  client: Client,
  job: ClaimedSocialJob,
  result: SocialJobResult,
): Promise<void> {
  const snapshot = result.metadataSnapshot;
  const resolution = snapshot.resolution;
  const snapshotId = result.collection.metadataSnapshotId;
  const payloadHash = createHash('sha256')
    .update(canonicalStringifyJson(resolution))
    .digest('hex');
  const inserted = await client.query(`INSERT INTO token_metadata_snapshots (
    snapshot_id,mint,uri,resolution_status,failure_reason,failure_message,
    failure_retryable,payload_version,payload_hash,metadata,fetched_at,
    source_launch_event_id,purge_after
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL)
  ON CONFLICT (snapshot_id) DO NOTHING RETURNING snapshot_id`, [
    snapshotId,
    snapshot.mint,
    snapshot.uri,
    resolution.status.toLowerCase(),
    resolution.status === 'FAILED' ? resolution.reason : null,
    resolution.status === 'FAILED' ? resolution.message : null,
    resolution.status === 'FAILED' ? resolution.retryable : null,
    snapshot.payloadVersion,
    payloadHash,
    resolution.status === 'RESOLVED' ? toJsonValue(resolution.metadata) : null,
    new Date(snapshot.fetchedAtMs),
    job.sourceLaunchEventId,
  ]);
  if (inserted.rowCount !== 1) throw new TypeError('Social metadata snapshot already conflicts.');
}

async function writeSocialCollection(
  client: Client,
  source: unknown,
  result: SocialJobResult,
): Promise<void> {
  const collection = result.collection;
  await exact(client, `INSERT INTO social_evidence_collections (
    collection_id,input_fingerprint,mint,source_launch_event_id,source_raw_event_id,
    metadata_snapshot_id,collection_status,confirmation_status,observed_at,
    payload_version,terminal_at,purge_after
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL)`, [
    collection.id,
    collection.inputFingerprint,
    collection.mint,
    collection.sourceLaunchEventId,
    textField(source, 'raw_event_id'),
    collection.metadataSnapshotId,
    collection.status,
    textField(source, 'confirmation_status'),
    new Date(collection.observedAtMs),
    collection.payloadVersion,
  ]);
  for (const link of collection.links) {
    await exact(client, `INSERT INTO social_links (
      link_id,collection_id,mint,metadata_snapshot_id,link_kind,
      declared_value_sha256,syntax_status,canonical_url,invalid_reason,observed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      link.id,collection.id,link.mint,link.metadataSnapshotId,link.kind,
      link.declaredValueSha256,link.syntaxStatus,link.canonicalUrl,link.invalidReason,
      new Date(link.observedAtMs),
    ]);
  }
  for (const observation of collection.observations) {
    await exact(client, `INSERT INTO social_http_observations (
      observation_id,collection_id,link_id,outcome,final_canonical_url,http_status,
      redirect_count,content_sha256,failure_reason,observed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      observation.id,collection.id,observation.linkId,observation.outcome,
      observation.finalCanonicalUrl,observation.httpStatus,observation.redirectCount,
      observation.contentSha256,observation.failureReason,new Date(observation.observedAtMs),
    ]);
  }
  for (const evidence of collection.evidence) {
    await exact(client, `INSERT INTO social_verification_evidence (
      evidence_id,collection_id,mint,link_id,observation_id,evidence_type,outcome,
      subject_kind,related_kind,reason_code,observed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
      evidence.id,collection.id,evidence.mint,evidence.linkId,evidence.observationId,
      evidence.type,evidence.outcome,evidence.subjectKind,evidence.relatedKind,
      evidence.reasonCode,new Date(evidence.observedAtMs),
    ]);
  }
}

async function writeSocialDerivedEvent(
  client: Client,
  source: unknown,
  result: SocialJobResult,
): Promise<void> {
  const collection = result.collection;
  const cursor = Object.freeze({
    slot: BigInt(textField(source, 'slot')),
    transactionIndex: integerField(source, 'transaction_index'),
    instructionIndex: integerField(source, 'instruction_index'),
    innerInstructionIndex: nullableIntegerField(source, 'inner_instruction_index'),
  });
  const identity = Object.freeze({
    type: 'SocialEvidenceCollected' as const,
    mint: collection.mint,
    source: 'public_social',
    program: textField(source, 'program'),
    signature: textField(source, 'signature'),
    cursor,
    qualifier: collection.inputFingerprint,
  });
  const eventId = createDeterministicDerivedEventId(identity);
  const payload = Object.freeze({
    sourceLaunchEventId: collection.sourceLaunchEventId,
    collectionId: collection.id,
    metadataSnapshotId: collection.metadataSnapshotId,
    collectionStatus: collection.status,
    inputFingerprint: collection.inputFingerprint,
    linkCount: collection.links.length,
    evidenceCount: collection.evidence.length,
  });
  await exact(client, `INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
    instruction_index,inner_instruction_index,confirmation_status,blockchain_time,
    observed_at,payload_version,payload,terminal_at,purge_after
  ) VALUES ($1,$2,'SocialEvidenceCollected',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,NULL,NULL)`, [
    eventId,
    textField(source, 'raw_event_id'),
    collection.mint,
    identity.source,
    identity.program,
    identity.signature,
    cursor.slot.toString(),
    cursor.transactionIndex,
    cursor.instructionIndex,
    cursor.innerInstructionIndex,
    textField(source, 'confirmation_status'),
    nullableDateField(source, 'blockchain_time'),
    new Date(collection.observedAtMs),
    toJsonValue(payload),
  ]);
}

async function assertCompletionReplay(
  client: Client,
  job: ClaimedSocialJob,
  result: SocialJobResult,
): Promise<void> {
  const stored = await client.query(`SELECT collection.collection_id,
    collection.input_fingerprint,collection.metadata_snapshot_id,
    collection.collection_status,collection.confirmation_status,
    collection.observed_at,collection.payload_version,
    metadata.uri,metadata.resolution_status,metadata.failure_reason,
    metadata.failure_message,metadata.failure_retryable,metadata.metadata,
    metadata.fetched_at,metadata.payload_version AS metadata_payload_version
    FROM social_evidence_collections collection
    JOIN token_metadata_snapshots metadata
      ON metadata.snapshot_id=collection.metadata_snapshot_id
    WHERE collection.source_launch_event_id=$1 AND collection.mint=$2`, [
    job.sourceLaunchEventId,job.mint,
  ]);
  const row = stored.rows[0];
  const snapshot=result.metadataSnapshot;
  const resolution=snapshot.resolution;
  if (
    row === undefined
    || textField(row, 'collection_id') !== result.collection.id
    || textField(row, 'input_fingerprint') !== result.collection.inputFingerprint
    || textField(row, 'metadata_snapshot_id') !== result.collection.metadataSnapshotId
    ||textField(row,'collection_status')!==result.collection.status
    ||textField(row,'confirmation_status')==='orphaned'
    ||dateField(row,'observed_at').getTime()!==result.collection.observedAtMs
    ||integerField(row,'payload_version')!==result.collection.payloadVersion
    ||textField(row,'uri')!==snapshot.uri
    ||textField(row,'resolution_status')!==resolution.status.toLowerCase()
    ||nullableTextField(row,'failure_reason')!==(resolution.status==='FAILED'?resolution.reason:null)
    ||nullableTextField(row,'failure_message')!==(resolution.status==='FAILED'?resolution.message:null)
    ||record(row).failure_retryable!==(resolution.status==='FAILED'?resolution.retryable:null)
    ||canonicalStringifyJson(record(row).metadata)
      !==canonicalStringifyJson(resolution.status==='RESOLVED'?resolution.metadata:null)
    ||dateField(row,'fetched_at').getTime()!==snapshot.fetchedAtMs
    ||integerField(row,'metadata_payload_version')!==snapshot.payloadVersion
  ) throw new TypeError('Social completion replay conflicts.');
  await assertReplayRows(client,'social_links','collection_id',result.collection.id,
    result.collection.links.map((item)=>item.id));
  await assertReplayRows(client,'social_http_observations','collection_id',result.collection.id,
    result.collection.observations.map((item)=>item.id));
  await assertReplayRows(client,'social_verification_evidence','collection_id',result.collection.id,
    result.collection.evidence.map((item)=>item.id));
}

async function assertReplayRows(
  client:Client,
  table:'social_links'|'social_http_observations'|'social_verification_evidence',
  foreignKey:'collection_id',
  collectionId:string,
  expectedIds:readonly string[],
):Promise<void>{
  const idColumn=table==='social_links'
    ?'link_id'
    :table==='social_http_observations'?'observation_id':'evidence_id';
  const stored=await client.query(
    `SELECT ${idColumn} AS item_id FROM ${table} WHERE ${foreignKey}=$1 ORDER BY ${idColumn}`,
    [collectionId],
  );
  const ids=stored.rows.map((row)=>textField(row,'item_id'));
  const expected=[...expectedIds].sort();
  if(canonicalStringifyJson(ids)!==canonicalStringifyJson(expected)){
    throw new TypeError('Social completion replay conflicts.');
  }
}

function claimedJob(row: unknown): ClaimedSocialJob {
  return Object.freeze({
    id: textField(row, 'job_id'),
    mint: textField(row, 'mint'),
    sourceLaunchEventId: textField(row, 'source_launch_event_id'),
    metadataUri: nullableTextField(row, 'metadata_uri'),
    attempts: integerField(row, 'attempts'),
    attemptsInCycle: integerField(row, 'attempts_in_cycle'),
    maxAttempts:integerField(row,'max_attempts'),
    evidencePersisted:booleanField(row,'evidence_persisted'),
    leaseToken: textField(row, 'lease_token'),
    leaseExpiresAtMs: dateField(row, 'lease_expires_at').getTime(),
  });
}

function assertClaimedJob(job: ClaimedSocialJob): void {
  boundedText(job.id, 'job.id');
  boundedText(job.mint, 'job.mint');
  boundedText(job.sourceLaunchEventId, 'job.sourceLaunchEventId');
  boundedText(job.leaseToken, 'job.leaseToken');
  positiveInteger(job.attempts, 'job.attempts');
  positiveInteger(job.attemptsInCycle, 'job.attemptsInCycle');
  positiveInteger(job.maxAttempts,'job.maxAttempts');
  if(job.attemptsInCycle>job.maxAttempts)throw new TypeError('job.attemptsInCycle is invalid.');
  if(typeof job.evidencePersisted!=='boolean')throw new TypeError('job.evidencePersisted is invalid.');
  timestamp(job.leaseExpiresAtMs, 'job.leaseExpiresAtMs');
}

function assertFailure(failure: SocialJobFailure): void {
  if (!['HTTP_TRANSIENT','PROVIDER_UNAVAILABLE','LEASE_EXPIRED'].includes(failure.code)) {
    throw new TypeError('Social job failure code is invalid.');
  }
  if (typeof failure.retryable !== 'boolean') throw new TypeError('Social retryability is invalid.');
  timestamp(failure.observedAtMs, 'failure.observedAtMs');
}

function assertLeaseRow(row: unknown, job: ClaimedSocialJob): void {
  const storedExpiryMs = dateField(row, 'lease_expires_at').getTime();
  if (
    integerField(row, 'attempts') !== job.attempts
    || integerField(row, 'attempts_in_cycle') !== job.attemptsInCycle
    || storedExpiryMs < job.leaseExpiresAtMs
  ) throw new TypeError('Social lease identity conflicts.');
}

function retryDelay(baseDelayMs: number, attemptsInCycle: number): number {
  return Math.min(baseDelayMs * (2 ** Math.max(0, attemptsInCycle - 1)), 3_600_000);
}

function record(row: unknown): Readonly<Record<string, unknown>> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new TypeError('Social repository row is invalid.');
  }
  return row as Readonly<Record<string, unknown>>;
}

function textField(row: unknown, field: string): string {
  const value = record(row)[field];
  if (typeof value !== 'string') throw new TypeError('Social repository text is invalid.');
  return value;
}

function nullableTextField(row: unknown, field: string): string | null {
  const value = record(row)[field];
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError('Social repository text is invalid.');
  return value;
}

function integerField(row: unknown, field: string): number {
  const value = record(row)[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('Social repository integer is invalid.');
  }
  return value;
}

function booleanField(row:unknown,field:string):boolean{
  const value=record(row)[field];
  if(typeof value!=='boolean')throw new TypeError('Social repository boolean is invalid.');
  return value;
}

function nullableIntegerField(row: unknown, field: string): number | null {
  const value = record(row)[field];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('Social repository integer is invalid.');
  }
  return value;
}

function dateField(row: unknown, field: string): Date {
  const value = record(row)[field];
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) {
    throw new TypeError('Social repository date is invalid.');
  }
  return value;
}

function nullableDateField(row: unknown, field: string): Date | null {
  const value = record(row)[field];
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) {
    throw new TypeError('Social repository date is invalid.');
  }
  return value;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} is invalid.`);
}

function timestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} is invalid.`);
}

function boundedText(value: string, name: string): void {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > 16_384) {
    throw new TypeError(`${name} is invalid.`);
  }
}

async function exact(client: Client, sql: string, values: readonly unknown[]): Promise<void> {
  const result = await client.query(sql, values);
  if (result.rowCount !== 1) throw new TypeError('Social repository row count is invalid.');
}

async function rollback(client: Client): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* original typed error wins */ }
}

function release(client: Client, operation: SocialEvidenceRepositoryError['operation']): void {
  try { client.release(); } catch { throw new SocialEvidenceRepositoryError(operation); }
}

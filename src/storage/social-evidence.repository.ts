import { randomUUID } from 'node:crypto';
import type {
  ClaimedSocialJob,
  SocialEvidenceRepository,
  SocialJobCounts,
  SocialJobFailure,
  SocialJobResult,
} from '../ports/social-evidence-repository.js';
import { getDatabasePool } from './database.js';

interface Result { readonly rows: readonly unknown[]; readonly rowCount?: number | null }
interface Client { query(text: string, values?: readonly unknown[]): Promise<Result>; release(): void }
interface Pool { connect(): Promise<Client> }

export class SocialEvidenceRepositoryError extends Error {
  public constructor(
    public readonly operation: 'claim' | 'renew' | 'complete' | 'fail' | 'counts',
  ) {
    super('Social evidence repository operation failed.');
    this.name = 'SocialEvidenceRepositoryError';
  }
}

export class PostgresSocialEvidenceRepository implements SocialEvidenceRepository {
  public constructor(
    private readonly pool: Pool = getDatabasePool(),
    private readonly retentionHours = 4,
  ) {
    if (!Number.isSafeInteger(retentionHours) || retentionHours !== 4) {
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
        job.attempts,job.attempts_in_cycle,job.lease_token,job.lease_expires_at`, [
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

  public complete(job: ClaimedSocialJob, result: SocialJobResult): Promise<void> {
    void job;
    void result;
    return Promise.reject(new SocialEvidenceRepositoryError('complete'));
  }

  public async fail(job: ClaimedSocialJob, failure: SocialJobFailure): Promise<void> {
    assertClaimedJob(job);
    assertFailure(failure);
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
        await exact(client, `UPDATE social_enrichment_jobs SET
          status='CANCELLED',lease_token=NULL,lease_expires_at=NULL,
          next_attempt_at=NULL,error_code=$3,retry_exhausted_at=$4,
          terminal_at=$5,purge_after=$6,updated_at=$5
          WHERE job_id=$1 AND lease_token=$2`, [
          job.id,
          job.leaseToken,
          failure.code,
          failure.retryable ? observedAt : null,
          observedAt,
          new Date(failure.observedAtMs + this.retentionHours * 3_600_000),
        ]);
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

function claimedJob(row: unknown): ClaimedSocialJob {
  return Object.freeze({
    id: textField(row, 'job_id'),
    mint: textField(row, 'mint'),
    sourceLaunchEventId: textField(row, 'source_launch_event_id'),
    metadataUri: nullableTextField(row, 'metadata_uri'),
    attempts: integerField(row, 'attempts'),
    attemptsInCycle: integerField(row, 'attempts_in_cycle'),
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
  if (
    integerField(row, 'attempts') !== job.attempts
    || integerField(row, 'attempts_in_cycle') !== job.attemptsInCycle
    || dateField(row, 'lease_expires_at').getTime() !== job.leaseExpiresAtMs
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

function dateField(row: unknown, field: string): Date {
  const value = record(row)[field];
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

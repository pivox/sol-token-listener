import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import {
  reconcileConfirmationStatus,
} from '../domain/confirmation-status.js';
import {
  assertValidClaimedTransaction,
  assertValidFinalityCandidate,
  assertValidFinalityPollObservation,
  assertValidFinalityRevision,
  assertValidInboxCounts,
  assertValidIngestionFailure,
  assertValidProcessingCheckpoint,
  assertValidRuntimeHeartbeat,
  assertValidTransactionNotification,
  createDurableTransactionSnapshot,
  type ClaimedTransaction,
  type DurableNormalizedTransaction,
  type FinalityCandidate,
  type FinalityPollObservation,
  type FinalityRevision,
  type InboxCounts,
  type IngestionFailure,
  type ProcessingCheckpoint,
  type RuntimeHeartbeat,
  type TransactionNotification,
} from '../domain/transaction-ingestion.js';
import type { ChainConfirmationStatus } from '../domain/types.js';
import type { TransactionInboxRepository } from '../ports/transaction-inbox-repository.js';
import type { NormalizedTransaction } from '../solana/rpc/types.js';
import { fromJsonValue, stringifyJson, toJsonValue } from '../utils/json.js';
import { getDatabasePool } from './database.js';

interface Queryable {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly QueryResultRow[];
    readonly rowCount: number | null;
  }>;
}

interface InboxClient extends Queryable {
  release(): void;
}

interface InboxPool extends Queryable {
  connect(): Promise<InboxClient>;
}

interface InboxIdentityRow extends QueryResultRow {
  readonly observed_slot: unknown;
  readonly discovery_sources: unknown;
  readonly target_confirmation_status: unknown;
  readonly processing_status: unknown;
  readonly normalized_transaction: unknown;
}

const SERVICE_KEY = 'transaction-listener';
const MAX_DATE_MS = 8_640_000_000_000_000;

export interface TransactionInboxFailureMetadata {
  readonly stage: 'operation' | 'primary' | 'rollback';
  readonly failureKind: 'DATABASE_OPERATION' | 'DATABASE_ROLLBACK';
  readonly errorName: string;
}

const INTERNAL_REPOSITORY_ERROR = Symbol('internal-repository-error');
const trustedRepositoryErrors = new WeakSet();

export class TransactionInboxRepositoryError extends Error {
  public readonly failures: readonly TransactionInboxFailureMetadata[];

  public constructor(
    failures: readonly TransactionInboxFailureMetadata[] = [],
    trustToken?: symbol,
  ) {
    super('Transaction inbox repository operation failed.');
    this.name = 'TransactionInboxRepositoryError';
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
    if (trustToken === INTERNAL_REPOSITORY_ERROR) trustedRepositoryErrors.add(this);
  }
}

export class TransactionInboxConflictError extends TransactionInboxRepositoryError {
  public constructor(public readonly conflict: 'identity' | 'snapshot' | 'finality' | 'checkpoint') {
    super([], INTERNAL_REPOSITORY_ERROR);
    this.name = 'TransactionInboxConflictError';
    this.message = 'Transaction inbox immutable state conflicts.';
  }
}

export class TransactionInboxLeaseError extends TransactionInboxRepositoryError {
  public constructor() {
    super([], INTERNAL_REPOSITORY_ERROR);
    this.name = 'TransactionInboxLeaseError';
    this.message = 'Transaction inbox lease is stale or missing.';
  }
}

export class PostgresTransactionInboxRepository implements TransactionInboxRepository {
  public constructor(private readonly pool: InboxPool = getDatabasePool()) {}

  public async enqueue(value: TransactionNotification): Promise<void> {
    return this.safely(async () => {
      assertValidTransactionNotification(value);
      await this.transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('transaction-inbox:' || $1, 0))",
          [value.signature],
        );
        const existing = await client.query(
          `SELECT observed_slot, discovery_sources, target_confirmation_status,
             processing_status, normalized_transaction
           FROM chain_transaction_inbox WHERE signature = $1 FOR UPDATE`,
          [value.signature],
        );
        const row = existing.rows[0] as InboxIdentityRow | undefined;
        if (row === undefined) {
          const inserted = await client.query(
            `INSERT INTO chain_transaction_inbox (
              signature, observed_slot, discovery_sources, target_confirmation_status,
              processing_status, observed_at
            ) VALUES ($1,$2,ARRAY[$3]::TEXT[],$4,'PENDING',$5)`,
            [
              value.signature,
              value.slot.toString(),
              value.source,
              value.confirmationStatus,
              dateFromMs(value.observedAtMs),
            ],
          );
          requireOne(inserted.rowCount);
          return;
        }
        if (numericBigInt(row.observed_slot, 'observed slot') !== value.slot) {
          throw new TransactionInboxConflictError('identity');
        }
        const current = confirmation(row.target_confirmation_status);
        const next = reconciledStatus(current, value.confirmationStatus);
        const sources = discoverySources(row.discovery_sources);
        if (!sources.includes(value.source)) sources.push(value.source);
        sources.sort(sourceOrder);
        const processingStatus = inboxStatus(row.processing_status);
        const shouldReplay = processingStatus === 'PROCESSED' && next !== current;
        if (shouldReplay && row.normalized_transaction === null) {
          throw new TransactionInboxConflictError('snapshot');
        }
        const updated = await client.query(
          `UPDATE chain_transaction_inbox SET
             discovery_sources = $2,
             target_confirmation_status = $3,
             processing_status = CASE WHEN $4 THEN 'PENDING' ELSE processing_status END,
             processed_at = CASE WHEN $4 THEN NULL ELSE processed_at END,
             terminal_at = CASE WHEN $4 THEN NULL ELSE terminal_at END,
             purge_after = CASE WHEN $4 THEN NULL ELSE purge_after END,
             missing_finality_polls = CASE WHEN $4 THEN 0 ELSE missing_finality_polls END,
             updated_at = GREATEST(updated_at, $5)
           WHERE signature = $1`,
          [value.signature, sources, next, shouldReplay, dateFromMs(value.observedAtMs)],
        );
        requireOne(updated.rowCount);
      });
    });
  }

  public async claim(nowMs: number, leaseSeconds: number): Promise<ClaimedTransaction | null> {
    return this.safely(async () => {
      const now = dateFromMs(nowMs);
      if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) {
        throw new TypeError('Lease seconds must be a positive safe integer.');
      }
      const leaseMs = leaseSeconds * 1_000;
      if (!Number.isSafeInteger(leaseMs)) throw new TypeError('Lease duration is unsafe.');
      const expires = dateFromMs(nowMs + leaseMs);
      return this.transaction(async (client) => {
        const selected = await client.query(
          `SELECT signature
           FROM chain_transaction_inbox
           WHERE processing_status = 'PENDING'
              OR (processing_status = 'FAILED' AND error_retryable = TRUE
                  AND next_attempt_at <= $1)
              OR (processing_status = 'PROCESSING' AND lease_expires_at <= $1)
           ORDER BY observed_slot, signature
           FOR UPDATE SKIP LOCKED
           LIMIT 1`,
          [now],
        );
        const signature = optionalText(selected.rows[0]?.signature, 'claim signature');
        if (signature === null) return null;
        const token = randomUUID();
        const updated = await client.query(
          `UPDATE chain_transaction_inbox SET
             processing_status = 'PROCESSING', attempts = attempts + 1,
             lease_token = $2, lease_expires_at = $3, next_attempt_at = NULL,
             error_code = NULL, error_name = NULL, error_retryable = NULL,
             updated_at = GREATEST(updated_at, $1)
           WHERE signature = $4
           RETURNING signature, observed_slot, target_confirmation_status, attempts,
             lease_token, lease_expires_at, normalized_transaction, immutable_fingerprint`,
          [now, token, expires, signature],
        );
        requireOne(updated.rowCount);
        return claimFromRow(requiredRow(updated.rows[0]));
      });
    });
  }

  public async renewLease(signature: string, token: string, untilMs: number): Promise<void> {
    return this.safely(async () => {
      requireText(signature, 'signature');
      requireText(token, 'lease token');
      const result = await this.pool.query(
        `UPDATE chain_transaction_inbox SET lease_expires_at = GREATEST(lease_expires_at, $3),
           updated_at = GREATEST(updated_at, clock_timestamp())
         WHERE signature = $1 AND lease_token = $2 AND processing_status = 'PROCESSING'`,
        [signature, token, dateFromMs(untilMs)],
      );
      requireLease(result.rowCount);
    });
  }

  public async saveSnapshot(
    signature: string,
    token: string,
    tx: NormalizedTransaction,
  ): Promise<void> {
    return this.safely(async () => {
      requireText(signature, 'signature');
      requireText(token, 'lease token');
      const snapshot = createDurableTransactionSnapshot(tx);
      if (snapshot.signature !== signature) throw new TransactionInboxConflictError('identity');
      const fingerprint = snapshotFingerprint(snapshot);
      await this.transaction(async (client) => {
        const locked = await leasedRow(client, signature, token,
          'observed_slot, target_confirmation_status, normalized_transaction, immutable_fingerprint');
        if (numericBigInt(locked.observed_slot, 'observed slot') !== snapshot.slot) {
          throw new TransactionInboxConflictError('identity');
        }
        assertSnapshotCompatible(snapshot, confirmation(locked.target_confirmation_status));
        if (locked.normalized_transaction !== null) {
          if (requiredText(locked.immutable_fingerprint, 'immutable fingerprint') !== fingerprint) {
            throw new TransactionInboxConflictError('snapshot');
          }
          decodeSnapshot(
            locked.normalized_transaction,
            requiredFingerprint(locked.immutable_fingerprint),
            signature,
            snapshot.slot,
            confirmation(locked.target_confirmation_status),
          );
        }
        const result = await client.query(
          `UPDATE chain_transaction_inbox SET
             normalized_transaction = COALESCE(normalized_transaction, $3),
             immutable_fingerprint = COALESCE(immutable_fingerprint, $4),
             blockchain_time = COALESCE(blockchain_time, $5),
             updated_at = GREATEST(updated_at, clock_timestamp())
           WHERE signature = $1 AND lease_token = $2 AND processing_status = 'PROCESSING'
             AND (immutable_fingerprint IS NULL OR immutable_fingerprint = $4)`,
          [
            signature,
            token,
            toJsonValue(snapshot),
            fingerprint,
            snapshot.blockTimeMs === null ? null : dateFromMs(snapshot.blockTimeMs),
          ],
        );
        requireLease(result.rowCount);
      });
    });
  }

  public async markProcessed(
    signature: string,
    token: string,
    status: ChainConfirmationStatus,
  ): Promise<void> {
    return this.safely(async () => {
      requireText(signature, 'signature');
      requireText(token, 'lease token');
      requireConfirmation(status);
      await this.transaction(async (client) => {
        const locked = await leasedRow(client, signature, token,
          `observed_slot, target_confirmation_status, normalized_transaction,
           immutable_fingerprint`);
        if (locked.normalized_transaction === null) {
          throw new TransactionInboxConflictError('snapshot');
        }
        const next = reconciledStatus(confirmation(locked.target_confirmation_status), status);
        decodeSnapshot(
          locked.normalized_transaction,
          requiredFingerprint(locked.immutable_fingerprint),
          signature,
          numericBigInt(locked.observed_slot, 'observed slot'),
          next,
        );
        const terminal = next === 'finalized' || next === 'orphaned';
        const result = await client.query(
          `UPDATE chain_transaction_inbox SET
             target_confirmation_status = $3, processing_status = 'PROCESSED',
             lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
             error_code = NULL, error_name = NULL, error_retryable = NULL,
             processed_at = completed.completed_at,
             terminal_at = CASE WHEN $4 THEN completed.completed_at ELSE NULL END,
             purge_after = CASE WHEN $4 THEN completed.completed_at + INTERVAL '4 hours' ELSE NULL END,
             missing_finality_polls = CASE WHEN $4 THEN 0 ELSE missing_finality_polls END,
             updated_at = completed.completed_at
           FROM (SELECT clock_timestamp() AS completed_at) completed
           WHERE signature = $1 AND lease_token = $2 AND processing_status = 'PROCESSING'`,
          [signature, token, next, terminal],
        );
        requireLease(result.rowCount);
      });
    });
  }

  public async markFailed(
    signature: string,
    token: string,
    failure: IngestionFailure,
  ): Promise<void> {
    return this.safely(async () => {
      requireText(signature, 'signature');
      requireText(token, 'lease token');
      assertValidIngestionFailure(failure);
      requireSafeErrorName(failure.errorName);
      await this.transaction(async (client) => {
        await leasedRow(client, signature, token, 'attempts');
        const result = await client.query(
          `UPDATE chain_transaction_inbox SET
             processing_status = 'FAILED', lease_token = NULL, lease_expires_at = NULL,
             error_code = $3, error_name = $4, error_retryable = $5,
             next_attempt_at = CASE WHEN $5 THEN
               clock_timestamp() + LEAST(INTERVAL '60 seconds',
                 INTERVAL '500 milliseconds' * power(2, LEAST(attempts - 1, 16)))
               ELSE NULL END,
             updated_at = clock_timestamp()
           WHERE signature = $1 AND lease_token = $2 AND processing_status = 'PROCESSING'`,
          [signature, token, failure.code, failure.errorName, failure.retryable],
        );
        requireLease(result.rowCount);
      });
    });
  }

  public async listForFinality(limit: number): Promise<readonly FinalityCandidate[]> {
    return this.safely(async () => {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new TypeError('Finality candidate limit must be a positive safe integer.');
      }
      const result = await this.pool.query(
        `SELECT signature, observed_slot, target_confirmation_status,
           missing_finality_polls, processed_at
         FROM chain_transaction_inbox
         WHERE processing_status = 'PROCESSED'
           AND target_confirmation_status IN ('processed', 'confirmed')
         ORDER BY processed_at, observed_slot, signature
         LIMIT $1`,
        [limit],
      );
      return Object.freeze(result.rows.map((row) => finalityCandidateFromRow(row)));
    });
  }

  public async recordFinalityPoll(value: FinalityPollObservation): Promise<FinalityCandidate> {
    return this.safely(async () => {
      assertValidFinalityPollObservation(value);
      return this.transaction(async (client) => {
        const selected = await client.query(
          `SELECT observed_slot, target_confirmation_status, processing_status,
             missing_finality_polls, processed_at
           FROM chain_transaction_inbox WHERE signature = $1 FOR UPDATE`,
          [value.signature],
        );
        const row = selected.rows[0];
        if (row === undefined
          || inboxStatus(row.processing_status) !== 'PROCESSED') {
          throw new TransactionInboxConflictError('finality');
        }
        const current = confirmation(row.target_confirmation_status);
        if (current !== 'processed' && current !== 'confirmed') {
          throw new TransactionInboxConflictError('finality');
        }
        const missing = safeCount(row.missing_finality_polls, 'missing finality polls');
        if (missing !== value.expectedMissingFinalityPolls) {
          throw new TransactionInboxConflictError('finality');
        }
        const nextStatus = value.confirmationStatus === null
          ? current
          : reconciledStatus(current, value.confirmationStatus);
        const nextMissing = value.confirmationStatus === null ? missing + 1 : 0;
        if (!Number.isSafeInteger(nextMissing)) {
          throw new TransactionInboxConflictError('finality');
        }
        const updated = await client.query(
          `UPDATE chain_transaction_inbox SET
             target_confirmation_status = $2,
             missing_finality_polls = $3,
             updated_at = GREATEST(updated_at, $5)
           WHERE signature = $1
             AND processing_status = 'PROCESSED'
             AND target_confirmation_status IN ('processed', 'confirmed')
             AND missing_finality_polls = $4
           RETURNING signature, observed_slot, target_confirmation_status,
             missing_finality_polls, processed_at`,
          [
            value.signature,
            nextStatus,
            nextMissing,
            value.expectedMissingFinalityPolls,
            dateFromMs(value.observedAtMs),
          ],
        );
        if (updated.rowCount !== 1) throw new TransactionInboxConflictError('finality');
        return finalityCandidateFromRow(requiredRow(updated.rows[0]));
      });
    });
  }

  public async enqueueRevision(value: FinalityRevision): Promise<void> {
    return this.safely(async () => {
      assertValidFinalityRevision(value);
      await this.transaction(async (client) => {
        const selected = await client.query(
          `SELECT observed_slot, target_confirmation_status, processing_status,
             normalized_transaction, immutable_fingerprint
           FROM chain_transaction_inbox WHERE signature = $1 FOR UPDATE`,
          [value.signature],
        );
        const row = selected.rows[0];
        if (row === undefined || row.normalized_transaction === null) {
          throw new TransactionInboxConflictError('snapshot');
        }
        const current = confirmation(row.target_confirmation_status);
        const next = reconciledStatus(current, value.confirmationStatus);
        decodeSnapshot(
          row.normalized_transaction,
          requiredFingerprint(row.immutable_fingerprint),
          value.signature,
          numericBigInt(row.observed_slot, 'observed slot'),
          next,
        );
        const status = inboxStatus(row.processing_status);
        if (next === current) {
          if (status === 'PROCESSED' && (current === 'finalized' || current === 'orphaned')) return;
          if (status === 'PENDING') return;
          throw new TransactionInboxConflictError('finality');
        }
        if (status !== 'PROCESSED') throw new TransactionInboxConflictError('finality');
        const result = await client.query(
          `UPDATE chain_transaction_inbox SET
             target_confirmation_status = $2, processing_status = 'PENDING',
             processed_at = NULL, terminal_at = NULL, purge_after = NULL,
             missing_finality_polls = 0, updated_at = GREATEST(updated_at, $3)
           WHERE signature = $1 AND processing_status = 'PROCESSED'
             AND normalized_transaction IS NOT NULL`,
          [value.signature, next, dateFromMs(value.observedAtMs)],
        );
        requireOne(result.rowCount);
      });
    });
  }

  public async readCheckpoint(key: 'launchpad' | 'market'): Promise<ProcessingCheckpoint | null> {
    return this.safely(async () => {
      requireCheckpointKey(key);
      const result = await this.pool.query(
        `SELECT checkpoint_key, slot, signature, updated_at
         FROM processing_checkpoints WHERE checkpoint_key = $1`,
        [key],
      );
      const row = result.rows[0];
      return row === undefined ? null : checkpointFromRow(row);
    });
  }

  public async storeCheckpoint(value: ProcessingCheckpoint): Promise<void> {
    return this.safely(async () => {
      assertValidProcessingCheckpoint(value);
      await this.transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('transaction-checkpoint:' || $1, 0))",
          [value.key],
        );
        const selected = await client.query(
          `SELECT slot, signature, updated_at FROM processing_checkpoints
           WHERE checkpoint_key = $1 FOR UPDATE`,
          [value.key],
        );
        const row = selected.rows[0];
        if (row !== undefined) {
          const currentSlot = numericBigInt(row.slot, 'checkpoint slot');
          const currentSignature = requiredText(row.signature, 'checkpoint signature');
          if (value.slot < currentSlot
            || (value.slot === currentSlot
              && value.signature !== currentSignature
              && value.updatedAtMs <= dateMs(row.updated_at, 'checkpoint updated at'))) {
            throw new TransactionInboxConflictError('checkpoint');
          }
        }
        const result = await client.query(
          `INSERT INTO processing_checkpoints (
             checkpoint_key, source, program, slot, signature, transaction_index,
             payload, updated_at
           ) VALUES ($1,'transaction-inbox',$1,$2,$3,NULL,'{}'::jsonb,$4)
           ON CONFLICT (checkpoint_key) DO UPDATE SET
             slot = EXCLUDED.slot, signature = EXCLUDED.signature,
             updated_at = GREATEST(processing_checkpoints.updated_at, EXCLUDED.updated_at)`,
          [value.key, value.slot.toString(), value.signature, dateFromMs(value.updatedAtMs)],
        );
        requireOne(result.rowCount);
      });
    });
  }

  public async writeHeartbeat(value: RuntimeHeartbeat): Promise<void> {
    return this.safely(async () => {
      assertValidRuntimeHeartbeat(value);
      const result = await this.pool.query(
        `INSERT INTO listener_heartbeats (
           service_key, last_http_slot, last_websocket_slot, last_finalized_slot,
           last_signature, pending_transactions, retry_count, active_sessions, payload,
           updated_at, runtime_state, subscriber_state, scanner_state, worker_state,
           reconciler_state, started_at, leased_transactions
         ) VALUES ($1,$2,$3,$4,$5,$6,0,0,$15,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (service_key) DO UPDATE SET
           last_http_slot = EXCLUDED.last_http_slot,
           last_websocket_slot = EXCLUDED.last_websocket_slot,
           last_finalized_slot = EXCLUDED.last_finalized_slot,
           last_signature = EXCLUDED.last_signature,
           pending_transactions = EXCLUDED.pending_transactions,
           payload = EXCLUDED.payload,
           updated_at = EXCLUDED.updated_at,
           runtime_state = EXCLUDED.runtime_state,
           subscriber_state = EXCLUDED.subscriber_state,
           scanner_state = EXCLUDED.scanner_state,
           worker_state = EXCLUDED.worker_state,
           reconciler_state = EXCLUDED.reconciler_state,
           started_at = EXCLUDED.started_at,
           leased_transactions = EXCLUDED.leased_transactions
         WHERE EXCLUDED.updated_at > listener_heartbeats.updated_at`,
        [
          SERVICE_KEY,
          nullableBigInt(value.lastHttpSlot),
          nullableBigInt(value.lastWebsocketSlot),
          nullableBigInt(value.lastFinalizedSlot),
          value.lastSignature,
          value.backlogCount,
          dateFromMs(value.updatedAtMs),
          value.runtimeState,
          value.subscriberState,
          value.scannerState,
          value.workerState,
          value.reconcilerState,
          dateFromMs(value.startedAtMs),
          value.leasedCount,
          toJsonValue({ startedAt: dateFromMs(value.startedAtMs).toISOString() }),
        ],
      );
      requireZeroOrOne(result.rowCount);
    });
  }

  public async counts(): Promise<InboxCounts> {
    return this.safely(async () => {
      const result = await this.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE processing_status = 'PENDING') AS pending,
           COUNT(*) FILTER (WHERE processing_status = 'PROCESSING') AS processing,
           COUNT(*) FILTER (WHERE processing_status = 'PROCESSED') AS processed,
           COUNT(*) FILTER (WHERE processing_status = 'FAILED') AS failed
         FROM chain_transaction_inbox`,
      );
      const row = requiredRow(result.rows[0]);
      const counts = Object.freeze({
        pending: safeCount(row.pending, 'pending count'),
        processing: safeCount(row.processing, 'processing count'),
        processed: safeCount(row.processed, 'processed count'),
        failed: safeCount(row.failed, 'failed count'),
      });
      assertValidInboxCounts(counts);
      return counts;
    });
  }

  private async transaction<T>(run: (client: InboxClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const value = await run(client);
        await client.query('COMMIT');
        return value;
      } catch (cause) {
        try {
          await client.query('ROLLBACK');
        } catch {
          throw new TransactionInboxRepositoryError([
            safeFailureMetadata('primary'),
            safeFailureMetadata('rollback'),
          ], INTERNAL_REPOSITORY_ERROR);
        }
        throw cause;
      }
    } finally {
      client.release();
    }
  }

  private async safely<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      if (isTrustedRepositoryError(cause)) throw cause;
      throw new TransactionInboxRepositoryError([
        safeFailureMetadata('operation'),
      ], INTERNAL_REPOSITORY_ERROR);
    }
  }
}

async function leasedRow(
  client: Queryable,
  signature: string,
  token: string,
  columns: string,
): Promise<QueryResultRow> {
  const result = await client.query(
    `SELECT ${columns} FROM chain_transaction_inbox
     WHERE signature = $1 AND lease_token = $2 AND processing_status = 'PROCESSING'
     FOR UPDATE`,
    [signature, token],
  );
  const row = result.rows[0];
  if (row === undefined || result.rowCount !== 1) throw new TransactionInboxLeaseError();
  return row;
}

function claimFromRow(row: QueryResultRow): ClaimedTransaction {
  const signature = requiredText(row.signature, 'claim signature');
  const slot = numericBigInt(row.observed_slot, 'claim slot');
  const status = confirmation(row.target_confirmation_status);
  let snapshot: DurableNormalizedTransaction | null = null;
  if (row.normalized_transaction === null) {
    if (row.immutable_fingerprint !== null) {
      throw new TypeError('Stored snapshot fingerprint has no snapshot.');
    }
  } else {
    snapshot = decodeSnapshot(
      row.normalized_transaction,
      requiredFingerprint(row.immutable_fingerprint),
      signature,
      slot,
      status,
    );
  }
  const value = Object.freeze({
    signature,
    slot,
    confirmationStatus: status,
    attempts: safeCount(row.attempts, 'claim attempts'),
    leaseToken: requiredText(row.lease_token, 'claim lease token'),
    leaseExpiresAtMs: dateMs(row.lease_expires_at, 'claim lease expiry'),
    normalizedTransaction: snapshot,
  });
  assertValidClaimedTransaction(value);
  return value;
}

function decodeSnapshot(
  value: unknown,
  fingerprint: string,
  signature: string,
  slot: bigint,
  confirmationStatus: ChainConfirmationStatus,
): DurableNormalizedTransaction {
  const decoded = deepFreeze(fromJsonValue(value)) as DurableNormalizedTransaction;
  const probe = Object.freeze({
    signature,
    slot,
    confirmationStatus,
    attempts: 0,
    leaseToken: 'validation',
    leaseExpiresAtMs: 0,
    normalizedTransaction: decoded,
  });
  assertValidClaimedTransaction(probe);
  if (snapshotFingerprint(decoded) !== fingerprint) {
    throw new TypeError('Stored transaction snapshot fingerprint is invalid.');
  }
  return decoded;
}

function assertSnapshotCompatible(
  snapshot: DurableNormalizedTransaction,
  status: ChainConfirmationStatus,
): void {
  const probe = Object.freeze({
    signature: snapshot.signature,
    slot: snapshot.slot,
    confirmationStatus: status,
    attempts: 0,
    leaseToken: 'validation',
    leaseExpiresAtMs: 0,
    normalizedTransaction: snapshot,
  });
  assertValidClaimedTransaction(probe);
}

function finalityCandidateFromRow(row: QueryResultRow): FinalityCandidate {
  const status = confirmation(row.target_confirmation_status);
  if (status !== 'processed' && status !== 'confirmed') {
    throw new TypeError('Stored finality candidate status is invalid.');
  }
  const value = Object.freeze({
    signature: requiredText(row.signature, 'finality signature'),
    slot: numericBigInt(row.observed_slot, 'finality slot'),
    confirmationStatus: status,
    missingFinalityPolls: safeCount(row.missing_finality_polls, 'missing finality polls'),
    processedAtMs: dateMs(row.processed_at, 'processed at'),
  });
  assertValidFinalityCandidate(value);
  return value;
}

function checkpointFromRow(row: QueryResultRow): ProcessingCheckpoint {
  const key: unknown = row.checkpoint_key;
  requireCheckpointKey(key);
  const value = Object.freeze({
    key,
    slot: numericBigInt(row.slot, 'checkpoint slot'),
    signature: requiredText(row.signature, 'checkpoint signature'),
    updatedAtMs: dateMs(row.updated_at, 'checkpoint updated at'),
  });
  assertValidProcessingCheckpoint(value);
  return value;
}

function reconciledStatus(
  current: ChainConfirmationStatus,
  incoming: ChainConfirmationStatus,
): ChainConfirmationStatus {
  try {
    return reconcileConfirmationStatus(current, incoming) === 'update' ? incoming : current;
  } catch {
    throw new TransactionInboxConflictError('finality');
  }
}

function confirmation(value: unknown): ChainConfirmationStatus {
  requireConfirmation(value);
  return value;
}

function requireConfirmation(value: unknown): asserts value is ChainConfirmationStatus {
  if (value !== 'processed' && value !== 'confirmed'
    && value !== 'finalized' && value !== 'orphaned') {
    throw new TypeError('Stored confirmation status is invalid.');
  }
}

function inboxStatus(value: unknown): 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED' {
  if (value !== 'PENDING' && value !== 'PROCESSING'
    && value !== 'PROCESSED' && value !== 'FAILED') {
    throw new TypeError('Stored inbox status is invalid.');
  }
  return value;
}

function discoverySources(value: unknown): TransactionNotification['source'][] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2
    || value.some((item: unknown) => item !== 'WEBSOCKET' && item !== 'CATCH_UP')) {
    throw new TypeError('Stored discovery sources are invalid.');
  }
  if (value.length === 2 && (value[0] !== 'WEBSOCKET' || value[1] !== 'CATCH_UP')) {
    throw new TypeError('Stored discovery sources are not canonical.');
  }
  return value.map((item: unknown) => {
    if (item === 'WEBSOCKET' || item === 'CATCH_UP') return item;
    throw new TypeError('Stored discovery source is invalid.');
  });
}

function sourceOrder(
  left: TransactionNotification['source'],
  right: TransactionNotification['source'],
): number {
  return (left === 'WEBSOCKET' ? 0 : 1) - (right === 'WEBSOCKET' ? 0 : 1);
}

function numericBigInt(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError(`Stored ${name} is invalid.`);
  }
  return BigInt(value);
}

function safeCount(value: unknown, name: string): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`Stored ${name} is invalid.`);
  return parsed;
}

function dateFromMs(value: number): Date {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
    throw new TypeError('Timestamp must be a PostgreSQL-compatible non-negative integer.');
  }
  return new Date(value);
}

function dateMs(value: unknown, name: string): number {
  const milliseconds = value instanceof Date ? value.getTime()
    : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError(`Stored ${name} is invalid.`);
  }
  return milliseconds;
}

function nullableBigInt(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function optionalText(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  return requiredText(value, name);
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Stored ${name} is invalid.`);
  }
  return value;
}

function requiredFingerprint(value: unknown): string {
  const fingerprint = requiredText(value, 'immutable fingerprint');
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)) {
    throw new TypeError('Stored immutable fingerprint is invalid.');
  }
  return fingerprint;
}

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be non-empty text.`);
  }
}

function requireSafeErrorName(value: string): void {
  if (!/^[A-Za-z_$][A-Za-z0-9_$.-]*$/u.test(value)
    || Buffer.byteLength(value, 'utf8') > 16_384) {
    throw new TypeError('Ingestion failure errorName must be a safe structured name.');
  }
}

function safeFailureMetadata(
  stage: TransactionInboxFailureMetadata['stage'],
): TransactionInboxFailureMetadata {
  return stage === 'rollback'
    ? Object.freeze({
      stage,
      failureKind: 'DATABASE_ROLLBACK',
      errorName: 'TransactionInboxDatabaseRollbackError',
    })
    : Object.freeze({
      stage,
      failureKind: 'DATABASE_OPERATION',
      errorName: 'TransactionInboxDatabaseOperationError',
    });
}

function isTrustedRepositoryError(value: unknown): value is TransactionInboxRepositoryError {
  return typeof value === 'object'
    && value !== null
    && trustedRepositoryErrors.has(value);
}

function requireCheckpointKey(value: unknown): asserts value is 'launchpad' | 'market' {
  if (value !== 'launchpad' && value !== 'market') {
    throw new TypeError('Checkpoint key is invalid.');
  }
}

function requiredRow(row: QueryResultRow | undefined): QueryResultRow {
  if (row === undefined) throw new TypeError('Repository query returned no row.');
  return row;
}

function requireOne(rowCount: number | null): void {
  if (rowCount !== 1) throw new TypeError('Repository mutation affected an unexpected row count.');
}

function requireZeroOrOne(rowCount: number | null): void {
  if (rowCount !== 0 && rowCount !== 1) {
    throw new TypeError('Repository mutation affected an unexpected row count.');
  }
}

function requireLease(rowCount: number | null): void {
  if (rowCount !== 1) throw new TransactionInboxLeaseError();
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function snapshotFingerprint(value: DurableNormalizedTransaction): string {
  return createHash('sha256').update(stringifyJson(canonicalValue(value))).digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    canonicalValue((value as Readonly<Record<string, unknown>>)[key]),
  ]));
}

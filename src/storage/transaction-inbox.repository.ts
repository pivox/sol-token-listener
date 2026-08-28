import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import {
  reconcileConfirmationStatus,
} from '../domain/confirmation-status.js';
import {
  assertValidClaimedTransaction,
  assertValidCatchUpGap,
  assertValidFinalityCandidate,
  assertValidFinalityPollObservation,
  assertValidFinalityRevision,
  assertValidInboxCounts,
  assertValidInboxRecoveryResult,
  assertValidIngestionFailure,
  assertValidProcessingCheckpoint,
  assertValidRuntimeHeartbeat,
  assertValidTransactionNotification,
  createDurableTransactionSnapshot,
  isCanonicalSolanaProgramId,
  MAX_FINALITY_EVIDENCE_VERSION,
  type ClaimedTransaction,
  type CatchUpGap,
  type DurableNormalizedTransaction,
  type FinalityCandidate,
  type FinalityPollObservation,
  type FinalityRevision,
  type InboxCounts,
  type InboxRecoveryResult,
  type IngestionFailure,
  type ProcessingCheckpoint,
  type RuntimeHeartbeat,
  type TransactionNotification,
} from '../domain/transaction-ingestion.js';
import {
  assertValidStrictCatchUpFailure,
  MAX_STRICT_CATCH_UP_SLOT,
  STRICT_CATCH_UP_FAILURE_REASON,
  type StrictCatchUpFailure,
} from '../domain/strict-catch-up.js';
import type { ChainConfirmationStatus } from '../domain/types.js';
import type { StrictCatchUpRepository } from '../ports/strict-catch-up-repository.js';
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
  readonly program_ids: unknown;
  readonly target_confirmation_status: unknown;
  readonly processing_status: unknown;
  readonly normalized_transaction: unknown;
  readonly immutable_fingerprint: unknown;
  readonly processed_at: unknown;
  readonly missing_finality_polls: unknown;
  readonly last_missing_finality_provider_id: unknown;
  readonly finality_evidence_version: unknown;
}

interface FinalizedReplayReceiptRow extends QueryResultRow {
  readonly observed_slot: unknown;
  readonly confirmation_status: unknown;
  readonly finality_evidence_version: unknown;
  readonly immutable_fingerprint: unknown;
  readonly replay_completed_at: unknown;
}

const SERVICE_KEY = 'transaction-listener';
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_EXHAUSTION_RECONCILIATIONS_PER_CLAIM = 100;
const DEFAULT_RETRY_POLICY = Object.freeze({ maxAttempts: 5, baseDelayMs: 500 });

export interface TransactionInboxRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}

export interface TransactionInboxFailureMetadata {
  readonly stage: 'operation' | 'primary' | 'rollback';
  readonly failureKind: 'DATABASE_OPERATION' | 'DATABASE_ROLLBACK';
  readonly errorName: string;
}

const trustedRepositoryErrors = new WeakSet();

export class TransactionInboxRepositoryError extends Error {
  public readonly failures: readonly TransactionInboxFailureMetadata[];

  public constructor(failures: readonly TransactionInboxFailureMetadata[] = []) {
    super('Transaction inbox repository operation failed.');
    this.name = 'TransactionInboxRepositoryError';
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
  }
}

export class TransactionInboxConflictError extends TransactionInboxRepositoryError {
  public constructor(public readonly conflict: 'identity' | 'snapshot' | 'finality' | 'checkpoint') {
    super();
    this.name = 'TransactionInboxConflictError';
    this.message = 'Transaction inbox immutable state conflicts.';
  }
}

export class TransactionInboxLeaseError extends TransactionInboxRepositoryError {
  public constructor() {
    super();
    this.name = 'TransactionInboxLeaseError';
    this.message = 'Transaction inbox lease is stale or missing.';
  }
}

export class PostgresTransactionInboxRepository implements TransactionInboxRepository, StrictCatchUpRepository {
  private readonly retryPolicy: TransactionInboxRetryPolicy;

  public constructor(
    private readonly pool: InboxPool = getDatabasePool(),
    retryPolicy: TransactionInboxRetryPolicy = DEFAULT_RETRY_POLICY,
  ) {
    this.retryPolicy = snapshotRetryPolicy(retryPolicy);
  }

  public async enqueue(value: TransactionNotification): Promise<void> {
    return this.safely(async () => {
      assertValidTransactionNotification(value);
      await this.transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('transaction-inbox:' || $1, 0))",
          [value.signature],
        );
        const existing = await client.query(
          `SELECT observed_slot, discovery_sources, program_ids, target_confirmation_status,
             processing_status, normalized_transaction, immutable_fingerprint, processed_at,
             missing_finality_polls,
             last_missing_finality_provider_id, finality_evidence_version
           FROM chain_transaction_inbox WHERE signature = $1 FOR UPDATE`,
          [value.signature],
        );
        const row = existing.rows[0] as InboxIdentityRow | undefined;
        const receiptResult = await client.query(
          `SELECT observed_slot, confirmation_status, finality_evidence_version,
             immutable_fingerprint, replay_completed_at
           FROM chain_transaction_finality_replay_receipts
           WHERE signature = $1 FOR SHARE`,
          [value.signature],
        );
        const receipt = receiptResult.rows[0] as FinalizedReplayReceiptRow | undefined;
        if (row === undefined) {
          if (receipt !== undefined) {
            assertFinalizedReceiptAcceptsNotification(receipt, value);
            return;
          }
          const inserted = await client.query(
            `INSERT INTO chain_transaction_inbox (
              signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
              processing_status, observed_at, retry_max_attempts, retry_base_delay_ms
            ) VALUES ($1,$2,ARRAY[$3]::TEXT[],$4,$5,'PENDING',$6,$7,$8)`,
            [
              value.signature,
              value.slot.toString(),
              value.source,
              value.programIds,
              value.confirmationStatus,
              dateFromMs(value.observedAtMs),
              this.retryPolicy.maxAttempts,
              this.retryPolicy.baseDelayMs,
            ],
          );
          requireOne(inserted.rowCount);
          return;
        }
        if (numericBigInt(row.observed_slot, 'observed slot') !== value.slot) {
          throw internalRepositoryError(new TransactionInboxConflictError('identity'));
        }
        const current = confirmation(row.target_confirmation_status);
        const processingStatus = inboxStatus(row.processing_status);
        if (current === 'finalized' && processingStatus === 'PROCESSED') {
          reconciledStatus(current, value.confirmationStatus);
          assertFinalizedReceiptMatchesInbox(receipt, row);
          return;
        }
        const next = reconciledStatus(current, value.confirmationStatus);
        const sources = discoverySources(row.discovery_sources);
        if (!sources.includes(value.source)) sources.push(value.source);
        sources.sort(sourceOrder);
        const programs = storedProgramIds(row.program_ids);
        for (const programId of value.programIds) {
          if (!programs.includes(programId)) programs.push(programId);
        }
        programs.sort(lexicalOrder);
        if (programs.length > 16) throw new TypeError('Stored program IDs exceed the limit.');
        if (finalityEvidenceVersion(row.finality_evidence_version) === MAX_FINALITY_EVIDENCE_VERSION) {
          throw internalRepositoryError(new TransactionInboxConflictError('finality'));
        }
        const shouldReplay = processingStatus === 'PROCESSED' && next !== current;
        if (shouldReplay && row.normalized_transaction === null) {
          throw internalRepositoryError(new TransactionInboxConflictError('snapshot'));
        }
        const updated = await client.query(
          `UPDATE chain_transaction_inbox SET
             discovery_sources = $2,
             program_ids = $3,
             target_confirmation_status = $4,
             processing_status = CASE WHEN $5 THEN 'PENDING' ELSE processing_status END,
             processed_at = CASE WHEN $5 THEN NULL ELSE processed_at END,
             terminal_at = CASE WHEN $5 THEN NULL ELSE terminal_at END,
             purge_after = CASE WHEN $5 THEN NULL ELSE purge_after END,
             attempts_in_cycle = CASE WHEN $5 THEN 0 ELSE attempts_in_cycle END,
             retry_exhausted_at = CASE WHEN $5 THEN NULL ELSE retry_exhausted_at END,
             missing_finality_polls = 0,
             last_missing_finality_provider_id = NULL,
             finality_evidence_version = finality_evidence_version + 1,
             updated_at = GREATEST(updated_at, $6)
           WHERE signature = $1`,
          [value.signature, sources, programs, next, shouldReplay, dateFromMs(value.observedAtMs)],
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
        await client.query(
          `WITH exhausted AS (
             SELECT signature
             FROM chain_transaction_inbox
             WHERE attempts_in_cycle >= retry_max_attempts
               AND retry_exhausted_at IS NULL
               AND (
                 (processing_status = 'FAILED' AND error_retryable = TRUE)
                 OR (processing_status = 'PROCESSING' AND lease_expires_at <= $1)
               )
             ORDER BY observed_slot, signature
             FOR UPDATE SKIP LOCKED
             LIMIT $2
           ), completed AS (
             SELECT clock_timestamp() AS completed_at
           )
           UPDATE chain_transaction_inbox inbox SET
             processing_status = 'FAILED',
             lease_token = NULL,
             lease_expires_at = NULL,
             next_attempt_at = NULL,
             error_code = CASE
               WHEN inbox.processing_status = 'PROCESSING' THEN 'WORKER_LEASE_EXPIRED'
               ELSE inbox.error_code
             END,
             error_name = CASE
               WHEN inbox.processing_status = 'PROCESSING' THEN 'TransactionInboxLeaseExpired'
               ELSE inbox.error_name
             END,
             error_retryable = TRUE,
             retry_exhausted_at = completed.completed_at,
             terminal_at = completed.completed_at,
             purge_after = completed.completed_at + INTERVAL '4 hours',
             updated_at = GREATEST(inbox.updated_at, completed.completed_at)
           FROM exhausted, completed
           WHERE inbox.signature = exhausted.signature`,
          [now, MAX_EXHAUSTION_RECONCILIATIONS_PER_CLAIM],
        );
        const selected = await client.query(
          `SELECT signature
           FROM chain_transaction_inbox
           WHERE (processing_status = 'PENDING' AND attempts_in_cycle < retry_max_attempts)
              OR (processing_status = 'FAILED' AND error_retryable = TRUE
                  AND retry_exhausted_at IS NULL AND next_attempt_at <= $1
                  AND attempts_in_cycle < retry_max_attempts)
              OR (processing_status = 'PROCESSING' AND lease_expires_at <= $1
                  AND attempts_in_cycle < retry_max_attempts)
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
             attempts_in_cycle = attempts_in_cycle + 1,
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
      if (snapshot.signature !== signature) {
        throw internalRepositoryError(new TransactionInboxConflictError('identity'));
      }
      const fingerprint = snapshotFingerprint(snapshot);
      await this.transaction(async (client) => {
        const locked = await leasedRow(client, signature, token,
          'observed_slot, target_confirmation_status, normalized_transaction, immutable_fingerprint');
        if (numericBigInt(locked.observed_slot, 'observed slot') !== snapshot.slot) {
          throw internalRepositoryError(new TransactionInboxConflictError('identity'));
        }
        assertSnapshotCompatible(snapshot, confirmation(locked.target_confirmation_status));
        if (locked.normalized_transaction !== null) {
          if (requiredText(locked.immutable_fingerprint, 'immutable fingerprint') !== fingerprint) {
            throw internalRepositoryError(new TransactionInboxConflictError('snapshot'));
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
          throw internalRepositoryError(new TransactionInboxConflictError('snapshot'));
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
          `WITH completed AS MATERIALIZED (
             SELECT clock_timestamp() AS completed_at
           ), updated_inbox AS (
             UPDATE chain_transaction_inbox SET
               target_confirmation_status = $3, processing_status = 'PROCESSED',
               lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
               error_code = NULL, error_name = NULL, error_retryable = NULL,
               processed_at = completed.completed_at,
               terminal_at = CASE WHEN $4 THEN completed.completed_at ELSE NULL END,
               purge_after = CASE WHEN $4 THEN
                 completed.completed_at + INTERVAL '4 hours' ELSE NULL END,
               missing_finality_polls = CASE WHEN $4 THEN 0 ELSE missing_finality_polls END,
               last_missing_finality_provider_id = CASE
                 WHEN $4 THEN NULL ELSE last_missing_finality_provider_id END,
               finality_evidence_version = CASE
                 WHEN $4 AND finality_evidence_version < $5::BIGINT
                   THEN finality_evidence_version + 1
                 ELSE finality_evidence_version
               END,
               updated_at = completed.completed_at
             FROM completed
             WHERE signature = $1 AND lease_token = $2
               AND processing_status = 'PROCESSING'
             RETURNING signature,observed_slot,target_confirmation_status,
               finality_evidence_version,immutable_fingerprint,processed_at
           ), replay_receipt AS (
             INSERT INTO chain_transaction_finality_replay_receipts AS receipt (
               signature,observed_slot,confirmation_status,finality_evidence_version,
               immutable_fingerprint,replay_completed_at
             )
             SELECT signature,observed_slot,target_confirmation_status,
               finality_evidence_version,immutable_fingerprint,processed_at
             FROM updated_inbox
             WHERE target_confirmation_status='finalized'
             ON CONFLICT (signature) DO UPDATE SET signature=EXCLUDED.signature
             WHERE receipt.observed_slot=EXCLUDED.observed_slot
               AND receipt.confirmation_status=EXCLUDED.confirmation_status
               AND receipt.finality_evidence_version=EXCLUDED.finality_evidence_version
               AND receipt.immutable_fingerprint=EXCLUDED.immutable_fingerprint
               AND receipt.replay_completed_at=EXCLUDED.replay_completed_at
             RETURNING signature
           )
           SELECT updated.signature
           FROM updated_inbox updated
           LEFT JOIN replay_receipt receipt ON receipt.signature=updated.signature
           WHERE updated.target_confirmation_status<>'finalized'
             OR receipt.signature IS NOT NULL`,
          [signature, token, next, terminal, MAX_FINALITY_EVIDENCE_VERSION.toString()],
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
        const row = await leasedRow(
          client,
          signature,
          token,
          'attempts_in_cycle, retry_max_attempts, retry_base_delay_ms',
        );
        const attemptsInCycle = safeCount(row.attempts_in_cycle, 'attempts in cycle');
        const maxAttempts = positiveBoundedInteger(
          row.retry_max_attempts,
          'retry max attempts',
          100,
        );
        const baseDelayMs = positiveBoundedInteger(
          row.retry_base_delay_ms,
          'retry base delay milliseconds',
          60_000,
        );
        const exhausted = failure.retryable && attemptsInCycle >= maxAttempts;
        const terminal = !failure.retryable || exhausted;
        const delayMs = retryDelayMs(baseDelayMs, attemptsInCycle);
        const result = await client.query(
          `UPDATE chain_transaction_inbox SET
             processing_status = 'FAILED', lease_token = NULL, lease_expires_at = NULL,
             error_code = $3, error_name = $4, error_retryable = $5,
             next_attempt_at = CASE WHEN $5 AND NOT $6 THEN
               completed.completed_at + ($7::INTEGER * INTERVAL '1 millisecond')
               ELSE NULL END,
             retry_exhausted_at = CASE WHEN $6 THEN completed.completed_at ELSE NULL END,
             terminal_at = CASE WHEN $8 THEN completed.completed_at ELSE NULL END,
             purge_after = CASE WHEN $8 THEN
               completed.completed_at + INTERVAL '4 hours' ELSE NULL END,
             updated_at = completed.completed_at
           FROM (SELECT clock_timestamp() AS completed_at) completed
           WHERE signature = $1 AND lease_token = $2 AND processing_status = 'PROCESSING'`,
          [
            signature,
            token,
            failure.code,
            failure.errorName,
            failure.retryable,
            exhausted,
            delayMs,
            terminal,
          ],
        );
        requireLease(result.rowCount);
      });
    });
  }

  public async recoverExhausted(signature: string): Promise<InboxRecoveryResult> {
    return this.safely(async () => {
      requireText(signature, 'signature');
      return this.transaction(async (client) => {
        const selected = await client.query(
          `SELECT processing_status, attempts, attempts_in_cycle, retry_max_attempts,
             retry_base_delay_ms, error_retryable, retry_exhausted_at, terminal_at,
             purge_after, manual_recovery_count, last_manual_recovery_at,
             purge_after > clock_timestamp() AS recovery_retained
           FROM chain_transaction_inbox
           WHERE signature = $1
           FOR UPDATE`,
          [signature],
        );
        const row = selected.rows[0];
        if (row === undefined) return inboxRecoveryResult('RECOVERY_NOT_FOUND', signature);
        const status = inboxStatus(row.processing_status);
        const recoveryCount = safeCount(row.manual_recovery_count, 'manual recovery count');
        if ((status === 'PENDING' || status === 'PROCESSING')
          && recoveryCount > 0
          && row.last_manual_recovery_at !== null) {
          dateMs(row.last_manual_recovery_at, 'last manual recovery at');
          return inboxRecoveryResult('RECOVERY_ALREADY_SCHEDULED', signature);
        }
        const exhaustedAtMs = nullableDateMs(row.retry_exhausted_at, 'retry exhausted at');
        const terminalAtMs = nullableDateMs(row.terminal_at, 'terminal at');
        const purgeAfterMs = nullableDateMs(row.purge_after, 'purge after');
        if (status !== 'FAILED'
          || row.error_retryable !== true
          || exhaustedAtMs === null
          || terminalAtMs === null
          || purgeAfterMs === null
          || row.recovery_retained !== true) {
          return inboxRecoveryResult('RECOVERY_NOT_ELIGIBLE', signature);
        }
        const lifetimeAttempts = positiveBoundedInteger(
          row.attempts,
          'lifetime attempts',
          2_147_483_647,
        );
        const cycleAttempts = positiveBoundedInteger(
          row.attempts_in_cycle,
          'cycle attempts',
          100,
        );
        const priorMaxAttempts = positiveBoundedInteger(
          row.retry_max_attempts,
          'retry max attempts',
          100,
        );
        const priorBaseDelayMs = positiveBoundedInteger(
          row.retry_base_delay_ms,
          'retry base delay milliseconds',
          60_000,
        );
        if (recoveryCount >= 2_147_483_647) {
          throw new TypeError('Stored manual recovery count is invalid.');
        }
        const updated = await client.query(
          `WITH recovery_clock AS MATERIALIZED (
             SELECT clock_timestamp() AS recovered_at
           ),
           recovery AS (
             INSERT INTO transaction_inbox_recoveries (
               signature, exhausted_at, recovered_at, lifetime_attempts, cycle_attempts,
               retry_max_attempts, retry_base_delay_ms, recovery_source, purge_after
             )
             SELECT inbox.signature, inbox.retry_exhausted_at, recovery_clock.recovered_at,
                    $4, $5, $6, $7, 'LOCAL_CLI',
                    recovery_clock.recovered_at + INTERVAL '4 hours'
             FROM chain_transaction_inbox inbox
             CROSS JOIN recovery_clock
             WHERE inbox.signature = $1
               AND inbox.processing_status = 'FAILED'
               AND inbox.error_retryable = TRUE
               AND inbox.retry_exhausted_at IS NOT NULL
             RETURNING signature, recovered_at
           )
           UPDATE chain_transaction_inbox inbox SET
             processing_status = 'PENDING',
             attempts_in_cycle = 0,
             retry_max_attempts = $2,
             retry_base_delay_ms = $3,
             lease_token = NULL,
             lease_expires_at = NULL,
             next_attempt_at = NULL,
             error_code = NULL,
             error_name = NULL,
             error_retryable = NULL,
             retry_exhausted_at = NULL,
             processed_at = NULL,
             terminal_at = NULL,
             purge_after = NULL,
             manual_recovery_count = inbox.manual_recovery_count + 1,
             last_manual_recovery_at = recovery.recovered_at,
             updated_at = GREATEST(inbox.updated_at, recovery.recovered_at)
           FROM recovery
           WHERE inbox.signature = recovery.signature
             AND inbox.processing_status = 'FAILED'
             AND inbox.error_retryable = TRUE
             AND inbox.retry_exhausted_at IS NOT NULL`,
          [
            signature,
            this.retryPolicy.maxAttempts,
            this.retryPolicy.baseDelayMs,
            lifetimeAttempts,
            cycleAttempts,
            priorMaxAttempts,
            priorBaseDelayMs,
          ],
        );
        requireOne(updated.rowCount);
        return inboxRecoveryResult('RECOVERY_SCHEDULED', signature);
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
           missing_finality_polls, last_missing_finality_provider_id,
           finality_evidence_version, processed_at
         FROM chain_transaction_inbox
         WHERE processing_status = 'PROCESSED'
           AND target_confirmation_status IN ('processed', 'confirmed')
         ORDER BY updated_at, observed_slot, signature
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
             signature, missing_finality_polls, last_missing_finality_provider_id,
             finality_evidence_version, processed_at
           FROM chain_transaction_inbox WHERE signature = $1 FOR UPDATE`,
          [value.signature],
        );
        const row = selected.rows[0];
        if (row === undefined
          || inboxStatus(row.processing_status) !== 'PROCESSED') {
          throw internalRepositoryError(new TransactionInboxConflictError('finality'));
        }
        const current = confirmation(row.target_confirmation_status);
        if (current !== 'processed' && current !== 'confirmed') {
          throw internalRepositoryError(new TransactionInboxConflictError('finality'));
        }
        const candidate = finalityCandidateFromRow(row);
        if (candidate.missingFinalityPolls !== value.expectedMissingFinalityPolls
          || candidate.lastMissingFinalityProviderId !== value.expectedLastMissingFinalityProviderId
          || candidate.finalityEvidenceVersion !== value.expectedFinalityEvidenceVersion
          || candidate.finalityEvidenceVersion === MAX_FINALITY_EVIDENCE_VERSION) {
          throw internalRepositoryError(new TransactionInboxConflictError('finality'));
        }
        const nextStatus = value.confirmationStatus === null
          ? current
          : reconciledStatus(current, value.confirmationStatus);
        const nextMissing = value.confirmationStatus === null
          ? candidate.lastMissingFinalityProviderId === value.providerId
            ? candidate.missingFinalityPolls + 1 : 1
          : 0;
        if (!Number.isSafeInteger(nextMissing)) {
          throw internalRepositoryError(new TransactionInboxConflictError('finality'));
        }
        const updated = await client.query(
          `UPDATE chain_transaction_inbox SET
             target_confirmation_status = $2,
             missing_finality_polls = $3,
             last_missing_finality_provider_id = $4,
             finality_evidence_version = finality_evidence_version + 1,
             updated_at = GREATEST(updated_at, $8, clock_timestamp())
           WHERE signature = $1
             AND processing_status = 'PROCESSED'
             AND target_confirmation_status = $5
             AND missing_finality_polls = $6
             AND last_missing_finality_provider_id IS NOT DISTINCT FROM $7
             AND finality_evidence_version = $9
           RETURNING signature, observed_slot, target_confirmation_status,
             missing_finality_polls, last_missing_finality_provider_id,
             finality_evidence_version, processed_at`,
          [
            value.signature,
            nextStatus,
            nextMissing,
            value.confirmationStatus === null ? value.providerId : null,
            candidate.confirmationStatus,
            value.expectedMissingFinalityPolls,
            value.expectedLastMissingFinalityProviderId,
            dateFromMs(value.observedAtMs),
            value.expectedFinalityEvidenceVersion.toString(),
          ],
        );
        if (updated.rowCount !== 1) {
          throw internalRepositoryError(new TransactionInboxConflictError('finality'));
        }
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
             signature, normalized_transaction, immutable_fingerprint,
             missing_finality_polls, last_missing_finality_provider_id,
             finality_evidence_version, processed_at
           FROM chain_transaction_inbox WHERE signature = $1 FOR UPDATE`,
          [value.signature],
        );
        const row = selected.rows[0];
        if (row === undefined || row.normalized_transaction === null) {
          throw internalRepositoryError(new TransactionInboxConflictError('snapshot'));
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
          throw internalRepositoryError(new TransactionInboxConflictError('finality'));
        }
        if (status !== 'PROCESSED') {
          throw internalRepositoryError(new TransactionInboxConflictError('finality'));
        }
        if (value.confirmationStatus !== 'finalized'
          && finalityEvidenceVersion(row.finality_evidence_version)
            === MAX_FINALITY_EVIDENCE_VERSION) {
          throw internalRepositoryError(new TransactionInboxConflictError('finality'));
        }
        if (value.confirmationStatus === 'orphaned') {
          const candidate = finalityCandidateFromRow(row);
          if (candidate.confirmationStatus !== value.expectedConfirmationStatus
            || candidate.missingFinalityPolls !== value.expectedMissingFinalityPolls
            || candidate.lastMissingFinalityProviderId !== value.expectedLastMissingFinalityProviderId
            || candidate.finalityEvidenceVersion !== value.expectedFinalityEvidenceVersion
            || candidate.finalityEvidenceVersion === MAX_FINALITY_EVIDENCE_VERSION) {
            throw internalRepositoryError(new TransactionInboxConflictError('finality'));
          }
          const result = await client.query(
            `UPDATE chain_transaction_inbox SET
               target_confirmation_status = $2, processing_status = 'PENDING',
               processed_at = NULL, terminal_at = NULL, purge_after = NULL,
               attempts_in_cycle = 0, retry_exhausted_at = NULL,
               missing_finality_polls = 0, last_missing_finality_provider_id = NULL,
               finality_evidence_version = finality_evidence_version + 1,
               updated_at = GREATEST(updated_at, $7)
             WHERE signature = $1 AND processing_status = 'PROCESSED'
               AND normalized_transaction IS NOT NULL
               AND target_confirmation_status = $3
               AND missing_finality_polls = $4
               AND last_missing_finality_provider_id IS NOT DISTINCT FROM $5
               AND finality_evidence_version = $6`,
            [
              value.signature, next, value.expectedConfirmationStatus,
              value.expectedMissingFinalityPolls, value.expectedLastMissingFinalityProviderId,
              value.expectedFinalityEvidenceVersion.toString(), dateFromMs(value.observedAtMs),
            ],
          );
          if (result.rowCount !== 1) {
            throw internalRepositoryError(new TransactionInboxConflictError('finality'));
          }
          return;
        }
        const result = await client.query(
          `UPDATE chain_transaction_inbox SET
             target_confirmation_status = $2, processing_status = 'PENDING',
             processed_at = NULL, terminal_at = NULL, purge_after = NULL,
             attempts_in_cycle = 0, retry_exhausted_at = NULL,
             missing_finality_polls = 0, last_missing_finality_provider_id = NULL,
             finality_evidence_version = CASE
               WHEN finality_evidence_version < $4
                 THEN finality_evidence_version + 1
               ELSE finality_evidence_version
             END,
             updated_at = GREATEST(updated_at, $3)
           WHERE signature = $1 AND processing_status = 'PROCESSED'
             AND normalized_transaction IS NOT NULL`,
          [
            value.signature,next,dateFromMs(value.observedAtMs),
            MAX_FINALITY_EVIDENCE_VERSION.toString(),
          ],
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

  public async compareAndSwapCheckpoint(
    expected: ProcessingCheckpoint | null,
    next: ProcessingCheckpoint,
  ): Promise<void> {
    return this.safely(async () => {
      assertValidStrictCheckpoint(next);
      if (expected !== null) {
        assertValidStrictCheckpoint(expected);
        if (expected.key !== next.key) throw new TypeError('Checkpoint keys must match.');
        if (isCheckpointRegression(expected, next)) {
          throw internalRepositoryError(new TransactionInboxConflictError('checkpoint'));
        }
      }
      await this.transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('transaction-checkpoint:' || $1, 0))",
          [next.key],
        );
        if (expected === null) {
          const inserted = await client.query(
            `INSERT INTO processing_checkpoints (
               checkpoint_key, source, program, slot, signature, transaction_index,
               payload, updated_at
             ) VALUES ($1,'transaction-inbox',$1,$2,$3,NULL,'{}'::jsonb,$4)
             ON CONFLICT (checkpoint_key) DO NOTHING`,
            [next.key, next.slot.toString(), next.signature, dateFromMs(next.updatedAtMs)],
          );
          if (inserted.rowCount === 0) {
            throw internalRepositoryError(new TransactionInboxConflictError('checkpoint'));
          }
          requireOne(inserted.rowCount);
          await resolveStrictCatchUpFailuresAt(client, next.key, null);
          return;
        }
        const updated = await client.query(
          `UPDATE processing_checkpoints SET
             slot = $2, signature = $3, updated_at = $4
           WHERE checkpoint_key = $1 AND slot = $5 AND signature = $6`,
          [
            next.key,
            next.slot.toString(),
            next.signature,
            dateFromMs(next.updatedAtMs),
            expected.slot.toString(),
            expected.signature,
          ],
        );
        if (updated.rowCount === 0) {
          throw internalRepositoryError(new TransactionInboxConflictError('checkpoint'));
        }
        requireOne(updated.rowCount);
        await resolveStrictCatchUpFailuresAt(client, next.key, expected);
      });
    });
  }

  public async recordStrictCatchUpFailure(value: StrictCatchUpFailure): Promise<void> {
    return this.safely(async () => {
      assertValidStrictCatchUpFailure(value);
      await this.transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('transaction-checkpoint:' || $1, 0))",
          [value.checkpointKey],
        );
        const selected = await client.query(
          `SELECT checkpoint_key, slot, signature, updated_at
           FROM processing_checkpoints WHERE checkpoint_key = $1 FOR UPDATE`,
          [value.checkpointKey],
        );
        const current = selected.rows[0] === undefined ? null : checkpointFromRow(selected.rows[0]);
        if (selected.rows.length > 1 || (current !== null && selected.rowCount !== 1)) {
          throw new TypeError('Strict catch-up checkpoint query returned an invalid row count.');
        }
        const stale = !matchesCheckpointBoundary(current, value.previous);
        const inserted = await client.query(
          `INSERT INTO listener_strict_catch_up_failures (
             failure_id, checkpoint_key, previous_slot, previous_signature,
             provider_id, observed_head_slot, reason_code, detected_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (failure_id) DO NOTHING`,
          [
            value.failureId,
            value.checkpointKey,
            value.previous?.slot.toString() ?? null,
            value.previous?.signature ?? null,
            value.providerId,
            nullableBigInt(value.observedHeadSlot),
            value.reasonCode,
            dateFromMs(value.detectedAtMs),
          ],
        );
        requireZeroOrOne(inserted.rowCount);
        if (inserted.rowCount === 0) {
          const existing = await client.query(
            `SELECT checkpoint_key, previous_slot, previous_signature, provider_id,
               observed_head_slot, reason_code
             FROM listener_strict_catch_up_failures WHERE failure_id = $1`,
            [value.failureId],
          );
          const row = requiredRow(existing.rows[0]);
          if (existing.rowCount !== 1 || !strictCatchUpFailureIdentityMatches(row, value)) {
            throw internalRepositoryError(new TransactionInboxConflictError('checkpoint'));
          }
        }
        if (stale) {
          await resolveStrictCatchUpFailureById(client, value.failureId);
        }
      });
    });
  }

  public async resolveStrictCatchUpFailures(
    key: 'launchpad' | 'market',
    previous: ProcessingCheckpoint | null,
  ): Promise<void> {
    return this.safely(async () => {
      requireCheckpointKey(key);
      if (previous !== null) {
        assertValidStrictCheckpoint(previous);
        if (previous.key !== key) throw new TypeError('Checkpoint keys must match.');
      }
      await this.transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('transaction-checkpoint:' || $1, 0))",
          [key],
        );
        await resolveStrictCatchUpFailuresAt(client, key, previous);
      });
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
            throw internalRepositoryError(new TransactionInboxConflictError('checkpoint'));
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

  public async recordCatchUpGap(value: CatchUpGap): Promise<void> {
    return this.safely(async () => {
      assertValidCatchUpGap(value);
      await this.transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('transaction-checkpoint:' || $1, 0))",
          [value.key],
        );
        const selected = await client.query(
          `SELECT slot, signature FROM processing_checkpoints
           WHERE checkpoint_key = $1 FOR UPDATE`,
          [value.key],
        );
        const row = selected.rows[0];
        if (row === undefined) {
          throw internalRepositoryError(new TransactionInboxConflictError('checkpoint'));
        }
        const currentSlot = numericBigInt(row.slot, 'checkpoint slot');
        const currentSignature = requiredText(row.signature, 'checkpoint signature');
        const alreadyAdvanced = currentSlot === value.baselineSlot
          && currentSignature === value.baselineSignature;
        const expectedPrevious = currentSlot === value.previousSlot
          && currentSignature === value.previousSignature;
        if (!alreadyAdvanced && !expectedPrevious) {
          throw internalRepositoryError(new TransactionInboxConflictError('checkpoint'));
        }
        const inserted = await client.query(
          `INSERT INTO listener_catch_up_gaps (
             gap_id, checkpoint_key, previous_slot, previous_signature,
             baseline_slot, baseline_signature, observed_at, purge_after
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (gap_id) DO NOTHING`,
          [
            value.gapId,
            value.key,
            value.previousSlot.toString(),
            value.previousSignature,
            value.baselineSlot.toString(),
            value.baselineSignature,
            dateFromMs(value.observedAtMs),
            dateFromMs(value.purgeAfterMs),
          ],
        );
        if (inserted.rowCount !== 0 && inserted.rowCount !== 1) {
          throw new TypeError('Catch-up gap insert count is invalid.');
        }
        if (alreadyAdvanced) {
          const existing = await client.query(
            `SELECT checkpoint_key,previous_slot,previous_signature,baseline_slot,
               baseline_signature
             FROM listener_catch_up_gaps WHERE gap_id = $1`,
            [value.gapId],
          );
          const gap = existing.rows[0];
          if (gap?.checkpoint_key !== value.key
            || numericBigInt(gap.previous_slot, 'gap previous slot') !== value.previousSlot
            || requiredText(gap.previous_signature, 'gap previous signature') !== value.previousSignature
            || numericBigInt(gap.baseline_slot, 'gap baseline slot') !== value.baselineSlot
            || requiredText(gap.baseline_signature, 'gap baseline signature') !== value.baselineSignature) {
            throw internalRepositoryError(new TransactionInboxConflictError('checkpoint'));
          }
          return;
        }
        const updated = await client.query(
          `UPDATE processing_checkpoints SET
             slot = $2, signature = $3, updated_at = $4
           WHERE checkpoint_key = $1 AND slot = $5 AND signature = $6`,
          [
            value.key,
            value.baselineSlot.toString(),
            value.baselineSignature,
            dateFromMs(value.observedAtMs),
            value.previousSlot.toString(),
            value.previousSignature,
          ],
        );
        requireOne(updated.rowCount);
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
           reconciler_state, started_at, leased_transactions, exhausted_transactions
         ) VALUES ($1,$2,$3,$4,$5,$6,0,0,$15,$7,$8,$9,$10,$11,$12,$13,$14,$16)
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
           leased_transactions = EXCLUDED.leased_transactions,
           exhausted_transactions = EXCLUDED.exhausted_transactions
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
          value.exhaustedCount,
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
           COUNT(*) FILTER (WHERE processing_status = 'FAILED') AS failed,
           COUNT(*) FILTER (
             WHERE processing_status = 'FAILED' AND error_retryable = TRUE
               AND retry_exhausted_at IS NULL AND next_attempt_at IS NOT NULL
           ) AS retryable_failed,
           COUNT(*) FILTER (
             WHERE processing_status = 'FAILED' AND error_retryable = TRUE
               AND retry_exhausted_at IS NOT NULL
           ) AS exhausted_failed
         FROM chain_transaction_inbox`,
      );
      const row = requiredRow(result.rows[0]);
      const counts = Object.freeze({
        pending: safeCount(row.pending, 'pending count'),
        processing: safeCount(row.processing, 'processing count'),
        processed: safeCount(row.processed, 'processed count'),
        failed: safeCount(row.failed, 'failed count'),
        retryableFailed: safeCount(row.retryable_failed, 'retryable failed count'),
        exhaustedFailed: safeCount(row.exhausted_failed, 'exhausted failed count'),
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
          throw internalRepositoryError(new TransactionInboxRepositoryError([
            safeFailureMetadata('primary'),
            safeFailureMetadata('rollback'),
          ]));
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
      if (consumeTrustedRepositoryError(cause)) throw cause;
      throw new TransactionInboxRepositoryError([
        safeFailureMetadata('operation'),
      ]);
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
  if (row === undefined || result.rowCount !== 1) {
    throw internalRepositoryError(new TransactionInboxLeaseError());
  }
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
  const lastMissingFinalityProviderId: unknown = row.last_missing_finality_provider_id;
  const value = Object.freeze({
    signature: requiredText(row.signature, 'finality signature'),
    slot: numericBigInt(row.observed_slot, 'finality slot'),
    confirmationStatus: status,
    missingFinalityPolls: safeCount(row.missing_finality_polls, 'missing finality polls'),
    lastMissingFinalityProviderId,
    finalityEvidenceVersion: finalityEvidenceVersion(row.finality_evidence_version),
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

function isCheckpointRegression(
  expected: ProcessingCheckpoint,
  next: ProcessingCheckpoint,
): boolean {
  return next.slot < expected.slot
    || (next.slot === expected.slot
      && next.signature === expected.signature
      && next.updatedAtMs < expected.updatedAtMs);
}

function assertValidStrictCheckpoint(
  value: unknown,
): asserts value is ProcessingCheckpoint {
  assertValidProcessingCheckpoint(value);
  if (value.slot > MAX_STRICT_CATCH_UP_SLOT) {
    throw new TypeError('Strict checkpoint slot exceeds persistence bounds.');
  }
  strictCatchUpSignature(value.signature, 'Strict checkpoint signature');
}

function strictCatchUpFailureIdentityMatches(
  row: QueryResultRow,
  value: StrictCatchUpFailure,
): boolean {
  requireCheckpointKey(row.checkpoint_key);
  if (row.checkpoint_key !== value.checkpointKey) return false;
  const previous = strictFailurePrevious(row);
  if (value.previous === null) {
    if (previous !== null) return false;
  } else if (previous === null) {
    return false;
  } else if (previous.slot !== value.previous.slot
    || previous.signature !== value.previous.signature) {
    return false;
  }
  requireRpcProviderId(row.provider_id);
  if (row.provider_id !== value.providerId) return false;
  const observedHeadSlot = nullableStrictCatchUpSlot(
    row.observed_head_slot,
    'strict catch-up observed head slot',
  );
  if (observedHeadSlot !== value.observedHeadSlot) return false;
  if (row.reason_code !== STRICT_CATCH_UP_FAILURE_REASON) {
    throw new TypeError('Stored strict catch-up failure reason is invalid.');
  }
  return true;
}

function strictFailurePrevious(row: QueryResultRow): { readonly slot: bigint; readonly signature: string } | null {
  if (row.previous_slot === null && row.previous_signature === null) return null;
  if (row.previous_slot === null || row.previous_signature === null) {
    throw new TypeError('Stored strict catch-up failure boundary is invalid.');
  }
  const slot = nullableStrictCatchUpSlot(row.previous_slot, 'strict catch-up previous slot');
  if (slot === null) throw new TypeError('Stored strict catch-up failure boundary is invalid.');
  return Object.freeze({
    slot,
    signature: strictCatchUpSignature(row.previous_signature, 'strict catch-up previous signature'),
  });
}

function nullableStrictCatchUpSlot(value: unknown, name: string): bigint | null {
  if (value === null) return null;
  const slot = numericBigInt(value, name);
  if (slot > MAX_STRICT_CATCH_UP_SLOT) throw new TypeError(`Stored ${name} is invalid.`);
  return slot;
}

function strictCatchUpSignature(value: unknown, name: string): string {
  const signature = requiredText(value, name);
  if (signature !== signature.trim() || Buffer.byteLength(signature, 'utf8') > 128) {
    throw new TypeError(`Stored ${name} is invalid.`);
  }
  return signature;
}

function requireRpcProviderId(value: unknown): asserts value is StrictCatchUpFailure['providerId'] {
  if (value !== 'primary' && value !== 'fallback-1'
    && value !== 'fallback-2' && value !== 'fallback-3') {
    throw new TypeError('Stored strict catch-up provider is invalid.');
  }
}

function matchesCheckpointBoundary(
  current: ProcessingCheckpoint | null,
  previous: ProcessingCheckpoint | null,
): boolean {
  if (current === null || previous === null) return current === previous;
  return current.key === previous.key
    && current.slot === previous.slot
    && current.signature === previous.signature;
}

async function resolveStrictCatchUpFailuresAt(
  client: Queryable,
  key: ProcessingCheckpoint['key'],
  previous: ProcessingCheckpoint | null,
): Promise<void> {
  if (previous === null) {
    await client.query(
      `WITH resolution_clock AS (
         SELECT clock_timestamp() AS captured_at
       )
       UPDATE listener_strict_catch_up_failures AS failure SET
         resolved_at = GREATEST(failure.detected_at, resolution_clock.captured_at),
         purge_after = GREATEST(failure.detected_at, resolution_clock.captured_at) + INTERVAL '4 hours'
       FROM resolution_clock
       WHERE failure.checkpoint_key = $1
         AND failure.previous_slot IS NULL AND failure.previous_signature IS NULL
         AND failure.resolved_at IS NULL`,
      [key],
    );
    return;
  }
  await client.query(
    `WITH resolution_clock AS (
       SELECT clock_timestamp() AS captured_at
     )
     UPDATE listener_strict_catch_up_failures AS failure SET
       resolved_at = GREATEST(failure.detected_at, resolution_clock.captured_at),
       purge_after = GREATEST(failure.detected_at, resolution_clock.captured_at) + INTERVAL '4 hours'
     FROM resolution_clock
     WHERE failure.checkpoint_key = $1
       AND failure.previous_slot = $2 AND failure.previous_signature = $3
       AND failure.resolved_at IS NULL`,
    [key, previous.slot.toString(), previous.signature],
  );
}

async function resolveStrictCatchUpFailureById(
  client: Queryable,
  failureId: string,
): Promise<void> {
  await client.query(
    `WITH resolution_clock AS (
       SELECT clock_timestamp() AS captured_at
     )
     UPDATE listener_strict_catch_up_failures AS failure SET
       resolved_at = GREATEST(failure.detected_at, resolution_clock.captured_at),
       purge_after = GREATEST(failure.detected_at, resolution_clock.captured_at) + INTERVAL '4 hours'
     FROM resolution_clock
     WHERE failure.failure_id = $1 AND failure.resolved_at IS NULL`,
    [failureId],
  );
}

function reconciledStatus(
  current: ChainConfirmationStatus,
  incoming: ChainConfirmationStatus,
): ChainConfirmationStatus {
  try {
    return reconcileConfirmationStatus(current, incoming) === 'update' ? incoming : current;
  } catch {
    throw internalRepositoryError(new TransactionInboxConflictError('finality'));
  }
}

function assertFinalizedReceiptAcceptsNotification(
  receipt: FinalizedReplayReceiptRow,
  notification: TransactionNotification,
): void {
  if (numericBigInt(receipt.observed_slot, 'receipt observed slot') !== notification.slot) {
    throw internalRepositoryError(new TransactionInboxConflictError('identity'));
  }
  const status = confirmation(receipt.confirmation_status);
  if (status !== 'finalized') {
    throw internalRepositoryError(new TransactionInboxConflictError('finality'));
  }
  finalityEvidenceVersion(receipt.finality_evidence_version);
  requiredFingerprint(receipt.immutable_fingerprint);
  dateMs(receipt.replay_completed_at, 'receipt completion');
  reconciledStatus(status, notification.confirmationStatus);
}

function assertFinalizedReceiptMatchesInbox(
  receipt: FinalizedReplayReceiptRow | undefined,
  inbox: InboxIdentityRow,
): void {
  if (receipt === undefined) {
    throw internalRepositoryError(new TransactionInboxConflictError('finality'));
  }
  try {
    const matches = numericBigInt(receipt.observed_slot, 'receipt observed slot')
        === numericBigInt(inbox.observed_slot, 'observed slot')
      && confirmation(receipt.confirmation_status) === 'finalized'
      && finalityEvidenceVersion(receipt.finality_evidence_version)
        === finalityEvidenceVersion(inbox.finality_evidence_version)
      && requiredFingerprint(receipt.immutable_fingerprint)
        === requiredFingerprint(inbox.immutable_fingerprint)
      && dateMs(receipt.replay_completed_at, 'receipt completion')
        === dateMs(inbox.processed_at, 'processed at');
    if (matches) return;
  } catch {
    // Map malformed or divergent durable terminal evidence to one fixed conflict.
  }
  throw internalRepositoryError(new TransactionInboxConflictError('finality'));
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

function storedProgramIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError('Stored program IDs are invalid.');
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 1
    || lengthDescriptor.value > 16) {
    throw new TypeError('Stored program IDs are invalid.');
  }
  const result: string[] = [];
  let previous: string | null = null;
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError('Stored program IDs are invalid.');
    }
    const programId: unknown = descriptor.value;
    if (typeof programId !== 'string'
      || programId.length < 32
      || programId.length > 44
      || programId !== programId.trim()
      || Buffer.byteLength(programId, 'utf8') > 44
      || !isCanonicalSolanaProgramId(programId)
      || (previous !== null && programId <= previous)) {
      throw new TypeError('Stored program IDs are invalid.');
    }
    result.push(programId);
    previous = programId;
  }
  return result;
}

function lexicalOrder(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function numericBigInt(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError(`Stored ${name} is invalid.`);
  }
  return BigInt(value);
}

function finalityEvidenceVersion(value: unknown): bigint {
  const parsed = numericBigInt(value, 'finality evidence version');
  if (parsed > MAX_FINALITY_EVIDENCE_VERSION) {
    throw new TypeError('Stored finality evidence version is invalid.');
  }
  return parsed;
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

function nullableDateMs(value: unknown, name: string): number | null {
  return value === null ? null : dateMs(value, name);
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

function snapshotRetryPolicy(value: unknown): TransactionInboxRetryPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Transaction inbox retry policy must be an object.');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Transaction inbox retry policy prototype is invalid.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  if (keys.length !== 2 || keys[0] !== 'baseDelayMs' || keys[1] !== 'maxAttempts') {
    throw new TypeError('Transaction inbox retry policy fields are invalid.');
  }
  const maxAttempts = descriptorInteger(descriptors.maxAttempts, 'maxAttempts', 100);
  const baseDelayMs = descriptorInteger(descriptors.baseDelayMs, 'baseDelayMs', 60_000);
  return Object.freeze({ maxAttempts, baseDelayMs });
}

function descriptorInteger(
  descriptor: PropertyDescriptor | undefined,
  name: string,
  maximum: number,
): number {
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError(`Transaction inbox retry policy ${name} is invalid.`);
  }
  return positiveBoundedInteger(descriptor.value, name, maximum);
}

function positiveBoundedInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new TypeError(`Stored ${name} is invalid.`);
  }
  return value as number;
}

function retryDelayMs(baseDelayMs: number, attemptsInCycle: number): number {
  if (!Number.isSafeInteger(attemptsInCycle) || attemptsInCycle <= 0) {
    throw new TypeError('Stored attempts in cycle is invalid.');
  }
  const multiplier = 2 ** Math.min(attemptsInCycle - 1, 16);
  return Math.min(60_000, baseDelayMs * multiplier);
}

function inboxRecoveryResult(
  code: InboxRecoveryResult['code'],
  signature: string,
): InboxRecoveryResult {
  const result = Object.freeze({ code, signature });
  assertValidInboxRecoveryResult(result);
  return result;
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

function consumeTrustedRepositoryError(value: unknown): value is TransactionInboxRepositoryError {
  return typeof value === 'object'
    && value !== null
    && trustedRepositoryErrors.delete(value);
}

function internalRepositoryError<T extends TransactionInboxRepositoryError>(error: T): T {
  trustedRepositoryErrors.add(error);
  return error;
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
  if (rowCount !== 1) throw internalRepositoryError(new TransactionInboxLeaseError());
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

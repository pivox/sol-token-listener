export interface ExecutionIntentExpirationClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly rowCount: number | null;
  }>>;
}

export async function expireExecutionIntentsPreSubmissionInTransaction(
  client: ExecutionIntentExpirationClient,
  limit: number,
): Promise<number> {
  const expired = await client.query(
    `WITH operation AS MATERIALIZED (
       SELECT date_trunc('milliseconds', statement_timestamp()) AS at
     ), candidates AS MATERIALIZED (
       SELECT intent.id,intent.status,intent.attempt_count,intent.state_revision
       FROM execution_intents AS intent CROSS JOIN operation
       WHERE intent.status IN ('PENDING','RETRY_READY','PROCESSING','SIMULATED')
         AND intent.expires_at <= statement_timestamp()
         AND (intent.lease_expires_at IS NULL
           OR intent.lease_expires_at <= statement_timestamp())
         AND intent.state_revision < 9223372036854775807
         AND (SELECT COUNT(*) FROM execution_attempts AS attempt
           WHERE attempt.intent_id=intent.id) = intent.attempt_count
         AND COALESCE((SELECT MAX(attempt.attempt_number)
           FROM execution_attempts AS attempt WHERE attempt.intent_id=intent.id),0)
           = intent.attempt_count
         AND (SELECT COUNT(*) FROM execution_attempts AS attempt
           WHERE attempt.intent_id=intent.id AND attempt.status='STARTED') <= 1
         AND NOT EXISTS (SELECT 1 FROM execution_attempts AS attempt
           WHERE attempt.intent_id=intent.id AND attempt.status='STARTED'
             AND attempt.attempt_number<>intent.attempt_count)
       ORDER BY intent.requested_at,intent.id
       FOR UPDATE OF intent SKIP LOCKED
       LIMIT $1
     ), abandoned AS (
       UPDATE execution_attempts AS attempt
       SET status='ABANDONED',completed_at=operation.at,
         reason_code='INTENT_EXPIRED'
       FROM candidates AS candidate CROSS JOIN operation
       WHERE attempt.intent_id=candidate.id AND attempt.status='STARTED'
       RETURNING attempt.intent_id
     ), journal AS (
       INSERT INTO execution_intent_transitions (
         intent_id,previous_status,next_status,reason_code,human_message,
         activation_phase,attempt_number,evidence,occurred_at
       )
       SELECT candidate.id,candidate.status,'EXPIRED','INTENT_EXPIRED',
         'Execution intent expired before signature.','NONE',
         CASE WHEN candidate.attempt_count=0 THEN NULL ELSE candidate.attempt_count END,
         jsonb_build_object(
           'payloadVersion',1,
           'attemptNumber',CASE WHEN candidate.attempt_count=0
             THEN NULL ELSE candidate.attempt_count END,
           'sourceEventId',NULL,
           'observedAtMs',(EXTRACT(EPOCH FROM operation.at) * 1000)::BIGINT
         ),operation.at
       FROM candidates AS candidate CROSS JOIN operation
       RETURNING intent_id
     ), updated AS (
       UPDATE execution_intents AS intent
       SET status='EXPIRED',last_reason_code='INTENT_EXPIRED',
         terminal_at=operation.at,reconciliation_completed_at=operation.at,
         purge_after=operation.at + INTERVAL '4 hours',
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
         updated_at=operation.at,state_revision=candidate.state_revision + 1
       FROM candidates AS candidate CROSS JOIN operation
       WHERE intent.id=candidate.id
         AND EXISTS (SELECT 1 FROM journal WHERE journal.intent_id=intent.id)
       RETURNING intent.id
     )
     SELECT COUNT(*)::INTEGER AS expired_count FROM updated`,
    [limit],
  );
  if (expired.rowCount !== 1 || expired.rows.length !== 1) {
    throw new Error('PostgreSQL returned an invalid execution intent expiration result.');
  }
  const row = expired.rows[0];
  if (row === undefined || Reflect.ownKeys(row).length !== 1
    || !Object.hasOwn(row, 'expired_count')) {
    throw new Error('PostgreSQL returned an invalid execution intent expiration result.');
  }
  const count = row.expired_count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new Error('PostgreSQL returned an invalid execution intent expiration count.');
  }
  return count;
}

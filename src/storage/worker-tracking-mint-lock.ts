import { isCanonicalSolanaPublicKey } from '../domain/solana-public-key.js';

interface MintLockClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<unknown>;
}

export interface WorkerTrackingAuthority {
  readonly active: boolean;
  readonly at: Date;
}

export function workerTrackingMintLockCte(mintParameterIndex: number): string {
  if (!Number.isSafeInteger(mintParameterIndex) || mintParameterIndex < 1) {
    throw new TypeError('Worker tracking mint parameter index is invalid.');
  }
  return `SELECT pg_advisory_xact_lock(hashtextextended(
    'transaction-inbox-mint:' || $${mintParameterIndex}::TEXT, 0))`;
}

export function workerTrackingPreviewMintLockCte(): string {
  return `SELECT pg_advisory_xact_lock(hashtextextended(
    'transaction-inbox-mint:' || preview.mint, 0))
    FROM worker_tracking_preview AS preview`;
}

export async function readWorkerTrackingDatabaseClock(client: MintLockClient): Promise<Date> {
  const result = await client.query(
    "SELECT date_trunc('milliseconds', clock_timestamp()) AS at",
  ) as { readonly rows?: readonly Record<string, unknown>[]; readonly rowCount?: number | null };
  const at = result.rows?.[0]?.at;
  if (result.rowCount !== 1 || result.rows?.length !== 1
    || !(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new TypeError('Worker tracking authority clock is invalid.');
  }
  return new Date(at.getTime());
}

export async function lockWorkerTrackingMints(
  client: MintLockClient,
  mints: readonly string[],
): Promise<void> {
  const canonical = [...new Set(mints)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0);
  for (const mint of canonical) {
    if (mint.length < 32 || mint.length > 44 || !isCanonicalSolanaPublicKey(mint)) {
      throw new TypeError('Worker tracking mint must be a canonical Solana public key.');
    }
  }
  for (const mint of canonical) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('transaction-inbox-mint:' || $1, 0))",
      [mint],
    );
  }
}

export async function readWorkerTrackingAuthority(
  client: MintLockClient,
  mint: string,
  trackingWindowSeconds: number,
): Promise<WorkerTrackingAuthority> {
  const result = await client.query(workerTrackingAuthoritySql(
    `SELECT database_clock.at,
       EXISTS (SELECT 1 FROM fresh_launch)
       OR EXISTS (SELECT 1 FROM extended_mint) AS active
     FROM database_clock`,
  ), [mint, trackingWindowSeconds]) as {
    readonly rows?: readonly Record<string, unknown>[];
    readonly rowCount?: number | null;
  };
  if (result.rowCount !== 1 || result.rows?.length !== 1) {
    throw new TypeError('Worker tracking authority returned an invalid row count.');
  }
  const row = result.rows[0];
  if (row?.active !== true && row?.active !== false) {
    throw new TypeError('Worker tracking authority is invalid.');
  }
  if (!(row.at instanceof Date) || !Number.isFinite(row.at.getTime())) {
    throw new TypeError('Worker tracking authority clock is invalid.');
  }
  return Object.freeze({ active: row.active, at: new Date(row.at.getTime()) });
}

export async function listWorkerTrackingMints(
  client: MintLockClient,
  trackingWindowSeconds: number,
): Promise<readonly string[]> {
  const result = await client.query(`WITH
    database_clock AS MATERIALIZED (
      SELECT date_trunc('milliseconds', clock_timestamp()) AS at
    ), fresh_launch AS MATERIALIZED (
      SELECT launch.mint
      FROM token_launches AS launch
      JOIN domain_events AS launch_event
        ON launch_event.type='TokenLaunchDetected'
       AND launch_event.mint=launch.mint
       AND launch_event.signature=launch.created_signature
       AND launch_event.slot=launch.created_slot
       AND launch_event.transaction_index=launch.created_transaction_index
       AND launch_event.instruction_index=launch.created_instruction_index
       AND launch_event.inner_instruction_index IS NOT DISTINCT FROM
         launch.created_inner_instruction_index
      CROSS JOIN database_clock
      WHERE launch.current_state<>'RETRACTED'
        AND launch_event.confirmation_status<>'orphaned'
        AND launch.detected_at + ($1::INTEGER * INTERVAL '1 second') > database_clock.at
    ), extended_mint AS MATERIALIZED (
      SELECT candidate.mint
      FROM trading_candidates AS candidate
      JOIN domain_events AS source_event ON source_event.event_id=candidate.source_event_id
      CROSS JOIN database_clock
      WHERE candidate.superseded_at IS NULL AND candidate.state='ELIGIBLE'
        AND candidate.confirmation_status<>'orphaned'
        AND source_event.confirmation_status<>'orphaned'
        AND candidate.eligible_until > database_clock.at
      UNION SELECT session.mint FROM paper_strategy_sessions AS session
        WHERE session.state IN ('BUY_PENDING','PAPER_HOLDING','WAITING_EXTERNAL_BUYS',
          'EXIT_PENDING_QUOTE','SELL_PENDING')
      UNION SELECT position.mint FROM paper_positions AS position
        WHERE position.status='PAPER_HOLDING'
      UNION SELECT intent.mint FROM execution_intents AS intent
        WHERE intent.terminal_at IS NULL
          AND intent.status NOT IN ('SUCCEEDED','FAILED','EXPIRED','CANCELLED')
      UNION SELECT live.mint FROM listener_worker_tracking_live_mints AS live
    ) SELECT mint FROM (
      SELECT mint FROM fresh_launch UNION SELECT mint FROM extended_mint
    ) AS authority ORDER BY mint`, [trackingWindowSeconds]) as {
    readonly rows?: readonly Record<string, unknown>[];
  };
  const values: string[] = [];
  for (const row of result.rows ?? []) {
    if (typeof row.mint !== 'string') throw new TypeError('Worker tracking mint is invalid.');
    values.push(row.mint);
  }
  return Object.freeze(values);
}

function workerTrackingAuthoritySql(selection: string): string {
  return `WITH
    database_clock AS MATERIALIZED (
      SELECT date_trunc('milliseconds', clock_timestamp()) AS at
    ), fresh_launch AS MATERIALIZED (
      SELECT launch.mint
      FROM token_launches AS launch
      JOIN domain_events AS launch_event
        ON launch_event.type='TokenLaunchDetected'
       AND launch_event.mint=launch.mint
       AND launch_event.signature=launch.created_signature
       AND launch_event.slot=launch.created_slot
       AND launch_event.transaction_index=launch.created_transaction_index
       AND launch_event.instruction_index=launch.created_instruction_index
       AND launch_event.inner_instruction_index IS NOT DISTINCT FROM
         launch.created_inner_instruction_index
      CROSS JOIN database_clock
      WHERE launch.mint=$1 AND launch.current_state<>'RETRACTED'
        AND launch_event.confirmation_status<>'orphaned'
        AND launch.detected_at + ($2::INTEGER * INTERVAL '1 second') > database_clock.at
    ), extended_mint AS MATERIALIZED (
      SELECT candidate.mint
      FROM trading_candidates AS candidate
      JOIN domain_events AS source_event ON source_event.event_id=candidate.source_event_id
      CROSS JOIN database_clock
      WHERE candidate.mint=$1 AND candidate.superseded_at IS NULL
        AND candidate.state='ELIGIBLE' AND candidate.confirmation_status<>'orphaned'
        AND source_event.confirmation_status<>'orphaned'
        AND candidate.eligible_until > database_clock.at
      UNION SELECT session.mint FROM paper_strategy_sessions AS session
        WHERE session.mint=$1 AND session.state IN ('BUY_PENDING','PAPER_HOLDING',
          'WAITING_EXTERNAL_BUYS','EXIT_PENDING_QUOTE','SELL_PENDING')
      UNION SELECT position.mint FROM paper_positions AS position
        WHERE position.mint=$1 AND position.status='PAPER_HOLDING'
      UNION SELECT intent.mint FROM execution_intents AS intent
        WHERE intent.mint=$1 AND intent.terminal_at IS NULL
          AND intent.status NOT IN ('SUCCEEDED','FAILED','EXPIRED','CANCELLED')
      UNION SELECT live.mint FROM listener_worker_tracking_live_mints AS live
        WHERE live.mint=$1
    ) ${selection}`;
}

import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { PoolClient } from 'pg';

type PgPool = InstanceType<typeof pg.Pool>;
let sharedPool: PgPool | null = null;
const migrationAdvisoryLockId = 7_347_662_125;
const PAPER_MVP_RETENTION_FENCE_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended('paper-mvp-owner-fence:v1', 0))";

export function getDatabasePool(
  databaseUrl = process.env.DATABASE_URL,
  options: Readonly<Pick<pg.PoolConfig,
    'connectionTimeoutMillis' | 'query_timeout' | 'statement_timeout' | 'lock_timeout'
    | 'idle_in_transaction_session_timeout'>> = {},
): PgPool {
  if (sharedPool !== null) return sharedPool;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required to access PostgreSQL.');
  }
  sharedPool = new pg.Pool({ connectionString: databaseUrl, ...options });
  return sharedPool;
}

export async function closeDatabase(): Promise<void> {
  const pool = sharedPool;
  sharedPool = null;
  if (pool !== null) await pool.end();
}

export async function migrateDatabase(options: {
  readonly pool?: PgPool | undefined;
  readonly migrationsDirectory?: string | undefined;
} = {}): Promise<readonly string[]> {
  const pool = options.pool ?? getDatabasePool();
  const directory = options.migrationsDirectory
    ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
  const names = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));

  const client = await pool.connect();
  const applied: string[] = [];
  let lockAcquired = false;
  const sessionState = { mustBeEvicted: false };
  const primaryFailures: unknown[] = [];
  const migrationAborted = new Error('Migration transaction aborted.');
  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationAdvisoryLockId]);
    lockAcquired = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS migration_history (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    for (const name of names) {
      if (await migrationExists(client, name)) continue;
      const sql = await readFile(resolve(directory, name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO migration_history(version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
          [name],
        );
        await client.query('COMMIT');
        applied.push(name);
      } catch (error) {
        primaryFailures.push(error);
        try {
          await client.query('ROLLBACK');
        } catch (rollbackFailure) {
          primaryFailures.push(rollbackFailure);
          sessionState.mustBeEvicted = true;
        }
        throw migrationAborted;
      }
    }
  } catch (error) {
    if (error !== migrationAborted) primaryFailures.push(error);
  }

  let unlockFailure: unknown;
  let unlockFailed = false;
  if (lockAcquired) {
    try {
      const unlock = await client.query<Record<string, unknown>>(
        'SELECT pg_advisory_unlock($1)',
        [migrationAdvisoryLockId],
      );
      if (!releasedMigrationAdvisoryLock(unlock.rows)) {
        throw new Error('Migration advisory lock was not released.');
      }
    } catch (error) {
      unlockFailed = true;
      unlockFailure = error;
    }
  }

  let releaseFailure: unknown;
  let releaseFailed = false;
  try {
    if (!lockAcquired || unlockFailed || sessionState.mustBeEvicted) client.release(true);
    else client.release();
  } catch (error) {
    releaseFailed = true;
    releaseFailure = error;
  }

  const failures = [
    ...primaryFailures,
    ...(unlockFailed ? [unlockFailure] : []),
    ...(releaseFailed ? [releaseFailure] : []),
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Database migration and cleanup failed.');
  }
  return applied;
}

function releasedMigrationAdvisoryLock(rows: unknown): boolean {
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  const row: unknown = (rows as readonly unknown[])[0];
  if (typeof row !== 'object' || row === null) return false;
  const result = Object.getOwnPropertyDescriptor(row, 'pg_advisory_unlock');
  return result !== undefined && 'value' in result && result.value === true;
}

export async function purgeExpiredFoundationData(pool: PgPool = getDatabasePool()): Promise<{
  readonly metadataSnapshots: number;
  readonly socialEvidence: number;
  readonly socialObservations: number;
  readonly socialLinks: number;
  readonly socialCollections: number;
  readonly socialJobs: number;
  readonly bondingCurveSnapshots: number;
  readonly launchTrades: number;
  readonly marketTrades: number;
  readonly marketReserveSnapshots: number;
  readonly marketPools: number;
  readonly migrations: number;
  readonly paperMvpSamples: number;
  readonly paperMvpRuns: number;
  readonly paperExternalBuys: number;
  readonly paperSessions: number;
  readonly tradingCandidates: number;
  readonly qualificationReports: number;
  readonly paperDecisionJobs: number;
  readonly paperTrades: number;
  readonly paperPositions: number;
  readonly executionDryRunAssessments: number;
  readonly executionSimulationArtifacts: number;
  readonly executionIntentTransitions: number;
  readonly executionAttempts: number;
  readonly executionIntents: number;
  readonly executionRiskRateLimitEvents: number;
  readonly executionRiskReconciliationEvidence: number;
  readonly executionRiskFaults: number;
  readonly executionRiskReservations: number;
  readonly executionRiskAdmissionReports: number;
  readonly executionRiskWalletSnapshots: number;
  readonly executionRiskProviderOperations: number;
  readonly executionRiskProviderSnapshots: number;
  readonly executionRiskTombstones: number;
  readonly stateTransitions: number;
  readonly observedWalletPositions: number;
  readonly holderSnapshots: number;
  readonly creatorProfiles: number;
  readonly walletFundingObservations: number;
  readonly walletFundingEvidence: number;
  readonly walletRelationships: number;
  readonly walletGraphProfiles: number;
  readonly walletClusterMembers: number;
  readonly walletClusters: number;
  readonly walletGraphSnapshots: number;
  readonly transactionInboxRecoveries: number;
  readonly listenerCatchUpGaps: number;
  readonly listenerStrictCatchUpFailures: number;
  readonly websocketHealthEvidence: number;
  readonly transactionInbox: number;
  readonly apiEventStream: number;
  readonly domainEvents: number;
  readonly rawChainEvents: number;
  readonly tokenLaunches: number;
}> {
  const client = await pool.connect();
  let failureCleanupHandled = false;
  try {
    await client.query('BEGIN');
    await client.query(PAPER_MVP_RETENTION_FENCE_SQL);
    const socialEvidence = await client.query(
      `DELETE FROM social_verification_evidence evidence
       USING social_evidence_collections collection
       WHERE evidence.collection_id = collection.collection_id
         AND collection.purge_after <= statement_timestamp()`,
    );
    const socialObservations = await client.query(
      `DELETE FROM social_http_observations observation
       USING social_evidence_collections collection
       WHERE observation.collection_id = collection.collection_id
         AND collection.purge_after <= statement_timestamp()`,
    );
    const socialLinks = await client.query(
      `DELETE FROM social_links link
       USING social_evidence_collections collection
       WHERE link.collection_id = collection.collection_id
         AND collection.purge_after <= statement_timestamp()`,
    );
    const socialCollections = await client.query(
      `DELETE FROM social_evidence_collections
       WHERE purge_after <= statement_timestamp()`,
    );
    const socialJobs = await client.query(
      `DELETE FROM social_enrichment_jobs
       WHERE purge_after <= statement_timestamp()`,
    );
    const metadataSnapshots = await client.query(
      `DELETE FROM token_metadata_snapshots snapshot USING token_launches launch
       WHERE snapshot.mint = launch.mint
         AND (
           snapshot.purge_after <= statement_timestamp()
           OR (
             launch.purge_after <= statement_timestamp()
             AND NOT EXISTS (
               SELECT 1 FROM social_evidence_collections collection
               WHERE collection.metadata_snapshot_id = snapshot.snapshot_id
                 AND (collection.purge_after IS NULL
                   OR collection.purge_after > statement_timestamp())
             )
           )
         )`,
    );
    await client.query(
      `UPDATE paper_mvp_runs SET
        state='FAILED',
        terminal_at=deadline_at + INTERVAL '2 minutes',
        purge_after=deadline_at + INTERVAL '4 hours 2 minutes',
        updated_at=deadline_at + INTERVAL '2 minutes',
        verdict=NULL,
        failure_code='RUN_DEADLINE_ABANDONED',
        report_payload=NULL,
        runner_owner_id=NULL,
        completion_reason=NULL
       WHERE state='RUNNING'
         AND deadline_at + INTERVAL '2 minutes' <= statement_timestamp()`,
    );
    const bondingCurveSnapshots = await client.query(
      `DELETE FROM bonding_curve_snapshots snapshot USING token_launches launch
       WHERE snapshot.mint = launch.mint AND launch.purge_after <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM paper_positions position
           JOIN paper_mvp_runs run
             ON run.state = 'RUNNING'
            AND run.strategy_id = position.strategy_id
            AND run.strategy_version = position.strategy_version
            AND position.opened_at BETWEEN run.started_at AND run.deadline_at
           WHERE position.mint = snapshot.mint
         )`,
    );
    const launchTrades = await client.query(
      `DELETE FROM launch_trades trade USING token_launches launch
       WHERE trade.mint = launch.mint AND launch.purge_after <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM paper_positions position
           JOIN paper_mvp_runs run
             ON run.state = 'RUNNING'
            AND run.strategy_id = position.strategy_id
            AND run.strategy_version = position.strategy_version
            AND position.opened_at BETWEEN run.started_at AND run.deadline_at
           WHERE position.mint = trade.mint
         )`,
    );
    const marketTrades = await client.query(
      `DELETE FROM market_trades trade WHERE purge_after <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM paper_positions position
           JOIN paper_mvp_runs run
             ON run.state = 'RUNNING'
            AND run.strategy_id = position.strategy_id
            AND run.strategy_version = position.strategy_version
            AND position.opened_at BETWEEN run.started_at AND run.deadline_at
           WHERE position.mint = trade.mint
         )`,
    );
    const marketReserveSnapshots = await client.query(
      `DELETE FROM market_reserve_snapshots snapshot WHERE purge_after <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM market_pools pool
           JOIN paper_positions position ON position.mint = pool.base_mint
           JOIN paper_mvp_runs run
             ON run.state = 'RUNNING'
            AND run.strategy_id = position.strategy_id
            AND run.strategy_version = position.strategy_version
            AND position.opened_at BETWEEN run.started_at AND run.deadline_at
           WHERE pool.pool_address = snapshot.pool_address
         )`,
    );
    const marketPools = await client.query(
      `DELETE FROM market_pools pool WHERE purge_after <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM paper_positions position
           JOIN paper_mvp_runs run
             ON run.state = 'RUNNING'
            AND run.strategy_id = position.strategy_id
            AND run.strategy_version = position.strategy_version
            AND position.opened_at BETWEEN run.started_at AND run.deadline_at
           WHERE position.mint = pool.base_mint
         )`,
    );
    const migrations = await client.query(
      `DELETE FROM migrations migration WHERE purge_after <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM paper_positions position
           JOIN paper_mvp_runs run
             ON run.state = 'RUNNING'
            AND run.strategy_id = position.strategy_id
            AND run.strategy_version = position.strategy_version
            AND position.opened_at BETWEEN run.started_at AND run.deadline_at
           WHERE position.mint = migration.mint
         )`,
    );
    const paperMvpSamples = await client.query(
      `DELETE FROM paper_mvp_position_samples sample USING paper_mvp_runs run
       WHERE sample.run_id = run.run_id
         AND run.purge_after <= statement_timestamp()`,
    );
    const paperMvpRuns = await client.query(
      'DELETE FROM paper_mvp_runs WHERE purge_after <= statement_timestamp()',
    );
    const paperExternalBuys = await client.query(
      'DELETE FROM paper_external_buy_events WHERE purge_after <= statement_timestamp()',
    );
    const paperSessions = await client.query(
      'DELETE FROM paper_strategy_sessions WHERE purge_after <= statement_timestamp()',
    );
    const tradingCandidates = await client.query(
      `DELETE FROM trading_candidates candidate
       WHERE candidate.purge_after <= statement_timestamp()
         AND NOT EXISTS (
           SELECT 1 FROM paper_strategy_sessions session
           WHERE session.candidate_id = candidate.candidate_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM paper_mvp_runs run
           WHERE run.state='RUNNING'
             AND run.strategy_id=candidate.strategy_id
             AND run.strategy_version=candidate.strategy_version
             AND candidate.created_at BETWEEN run.started_at AND run.deadline_at
             AND candidate.reason_codes ?| ARRAY['CREATION_ENTRY_REJECTED','CREATION_ENTRY_EXPIRED']
             AND EXISTS (
               SELECT 1 FROM token_launches launch
               WHERE launch.mint=candidate.mint
                 AND launch.detected_at BETWEEN run.started_at AND run.deadline_at
             )
         )`,
    );
    const qualificationReports = await client.query(
      `DELETE FROM qualification_reports report
       WHERE report.purge_after <= statement_timestamp()
         AND NOT EXISTS (
           SELECT 1 FROM trading_candidates candidate
           WHERE candidate.report_id = report.report_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM paper_strategy_sessions session
           WHERE session.report_id = report.report_id
         )`,
    );
    const paperDecisionJobs = await client.query(
      `DELETE FROM paper_decision_jobs job
       WHERE job.purge_after <= statement_timestamp()
         AND NOT EXISTS (
           SELECT 1 FROM paper_positions position
           JOIN paper_mvp_runs run
            ON run.state='RUNNING'
           AND run.strategy_id=position.strategy_id
           AND run.strategy_version=position.strategy_version
           AND position.opened_at BETWEEN run.started_at AND run.deadline_at
           WHERE position.entry_decision_job_id=job.job_id
         )`,
    );
    const paperTrades = await client.query(
      `DELETE FROM paper_trades trade USING paper_positions position
       WHERE trade.position_id = position.position_id
         AND position.purge_after <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM paper_mvp_runs run
           WHERE run.state = 'RUNNING'
             AND run.strategy_id = position.strategy_id
             AND run.strategy_version = position.strategy_version
             AND position.opened_at BETWEEN run.started_at AND run.deadline_at
         )`,
    );
    const paperPositions = await client.query(
      `DELETE FROM paper_positions position
       WHERE position.purge_after <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM paper_mvp_runs run
           WHERE run.state = 'RUNNING'
             AND run.strategy_id = position.strategy_id
             AND run.strategy_version = position.strategy_version
             AND position.opened_at BETWEEN run.started_at AND run.deadline_at
         )`,
    );
    const executionIntentCutoffResult = await client.query<{ readonly purge_cutoff: Date }>(
      "SELECT date_trunc('milliseconds', statement_timestamp()) AS purge_cutoff",
    );
    const executionIntentCutoff = executionIntentCutoffResult.rows[0]?.purge_cutoff;
    if (!(executionIntentCutoff instanceof Date)
      || !Number.isFinite(executionIntentCutoff.getTime())) {
      throw new Error('PostgreSQL returned an invalid execution intent purge cutoff.');
    }
    const executionRiskRateLimitEvents = await client.query(
      `DELETE FROM execution_provider_rate_limit_events event
       WHERE event.event_id IN (
         SELECT candidate.event_id FROM execution_provider_rate_limit_events candidate
         WHERE candidate.purge_after <= $1::TIMESTAMPTZ
         ORDER BY candidate.event_id LIMIT 1000 FOR UPDATE
       )`,
      [executionIntentCutoff],
    );
    const executionRiskWalletSnapshots = await client.query(
      `DELETE FROM execution_wallet_snapshots snapshot
       WHERE snapshot.snapshot_id IN (
         SELECT candidate.snapshot_id FROM execution_wallet_snapshots candidate
         WHERE candidate.purge_after <= $1::TIMESTAMPTZ
         ORDER BY candidate.snapshot_id LIMIT 1000 FOR UPDATE
       )`,
      [executionIntentCutoff],
    );
    const providerSnapshotCohort = await client.query<{ readonly snapshot_id: string }>(
      `SELECT snapshot.snapshot_id FROM execution_provider_usage_snapshots snapshot
       WHERE snapshot.purge_after <= $1::TIMESTAMPTZ
         AND snapshot.billing_period_ends_at <= $1::TIMESTAMPTZ
       ORDER BY snapshot.snapshot_id LIMIT 1000 FOR UPDATE`,
      [executionIntentCutoff],
    );
    const providerSnapshotIds = providerSnapshotCohort.rows.map(({ snapshot_id }) => snapshot_id);
    const executionRiskProviderOperations = await client.query(
      `DELETE FROM execution_provider_usage_counters counter
       WHERE counter.snapshot_id = ANY($1::TEXT[])`,
      [providerSnapshotIds],
    );
    const executionRiskProviderSnapshots = await client.query(
      `DELETE FROM execution_provider_usage_snapshots snapshot
       WHERE snapshot.snapshot_id = ANY($1::TEXT[])
         AND snapshot.purge_after <= $2::TIMESTAMPTZ
         AND snapshot.billing_period_ends_at <= $2::TIMESTAMPTZ`,
      [providerSnapshotIds, executionIntentCutoff],
    );
    const reservationCohort = await client.query<{
      readonly reservation_id: string;
      readonly admission_report_id: string;
    }>(
      `SELECT reservation.reservation_id,reservation.admission_report_id
       FROM execution_exposure_reservations reservation
       JOIN execution_risk_admission_reports report
         ON report.report_id=reservation.admission_report_id
       WHERE reservation.state IN ('CONSUMED','RELEASED')
         AND reservation.purge_after <= $1::TIMESTAMPTZ
       ORDER BY reservation.reservation_id LIMIT 1000
       FOR UPDATE OF reservation,report`,
      [executionIntentCutoff],
    );
    const reservationIds = reservationCohort.rows.map(({ reservation_id }) => reservation_id);
    const admittedReportIds = reservationCohort.rows.map(
      ({ admission_report_id }) => admission_report_id,
    );
    const rejectedReportCohort = await client.query<{ readonly report_id: string }>(
      `SELECT report.report_id FROM execution_risk_admission_reports report
       WHERE report.decision='REJECTED' AND report.purge_after <= $1::TIMESTAMPTZ
       ORDER BY report.report_id LIMIT 1000 FOR UPDATE`,
      [executionIntentCutoff],
    );
    const reportIds = [...new Set([
      ...admittedReportIds,
      ...rejectedReportCohort.rows.map(({ report_id }) => report_id),
    ])];
    const reportTombstones = await client.query(
      `INSERT INTO execution_risk_tombstones (
         tombstone_id,payload_version,source_kind,source_id,source_fingerprint
       ) SELECT
         'execution_risk_tombstone_'
           || md5('ADMISSION_REPORT:' || report.report_id)
           || md5(report.report_id || ':ADMISSION_REPORT'),
         1,'ADMISSION_REPORT',report.report_id,report.report_fingerprint
       FROM execution_risk_admission_reports report
       WHERE report.report_id = ANY($1::TEXT[])
       ORDER BY report.report_id`,
      [reportIds],
    );
    const reservationTombstones = await client.query(
      `INSERT INTO execution_risk_tombstones (
         tombstone_id,payload_version,source_kind,source_id,source_fingerprint
       ) SELECT
         'execution_risk_tombstone_'
           || md5('EXPOSURE_RESERVATION:' || reservation.reservation_id)
           || md5(reservation.reservation_id || ':EXPOSURE_RESERVATION'),
         1,'EXPOSURE_RESERVATION',reservation.reservation_id,reservation.intent_fingerprint
       FROM execution_exposure_reservations reservation
       WHERE reservation.reservation_id = ANY($1::TEXT[])
       ORDER BY reservation.reservation_id`,
      [reservationIds],
    );
    const executionRiskReconciliationEvidence = await client.query(
      `DELETE FROM execution_reconciliation_evidence evidence
       WHERE evidence.reservation_id = ANY($1::TEXT[])
         AND evidence.result IN ('MATCHED','NO_EFFECT')
         AND evidence.purge_after <= $2::TIMESTAMPTZ`,
      [reservationIds, executionIntentCutoff],
    );
    const executionRiskFaults = await client.query(
      `DELETE FROM execution_fault_ledger fault
       WHERE fault.fault_id IN (
         SELECT candidate.fault_id FROM execution_fault_ledger candidate
         WHERE candidate.purge_after <= $1::TIMESTAMPTZ
         ORDER BY candidate.fault_id LIMIT 1000 FOR UPDATE
       )`,
      [executionIntentCutoff],
    );
    const executionRiskReservations = await client.query(
      `DELETE FROM execution_exposure_reservations reservation
       WHERE reservation.reservation_id = ANY($1::TEXT[])
         AND reservation.state IN ('CONSUMED','RELEASED')
         AND reservation.purge_after <= $2::TIMESTAMPTZ`,
      [reservationIds, executionIntentCutoff],
    );
    const executionRiskAdmissionReports = await client.query(
      `DELETE FROM execution_risk_admission_reports report
       WHERE report.report_id = ANY($1::TEXT[])
         AND (
           (report.decision='REJECTED' AND report.purge_after <= $2::TIMESTAMPTZ)
           OR (report.decision='ADMITTED' AND NOT EXISTS (
             SELECT 1 FROM execution_exposure_reservations reservation
             WHERE reservation.admission_report_id=report.report_id
           ))
         )`,
      [reportIds, executionIntentCutoff],
    );
    const executionRiskTombstones = (reportTombstones.rowCount ?? 0)
      + (reservationTombstones.rowCount ?? 0);
    const executionIntentCohort = await client.query<{ readonly id: string }>(
      `SELECT intent.id
       FROM execution_intents intent
       WHERE intent.status IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED')
         AND intent.terminal_at IS NOT NULL
         AND intent.reconciliation_completed_at IS NOT NULL
         AND intent.purge_after <= $1::TIMESTAMPTZ
         AND NOT EXISTS (
           SELECT 1 FROM execution_risk_admission_reports report
           WHERE report.intent_id=intent.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM execution_exposure_reservations reservation
           WHERE reservation.intent_id=intent.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM execution_reconciliation_evidence evidence
           WHERE evidence.intent_id=intent.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM execution_fault_ledger fault
           WHERE fault.intent_id=intent.id
         )
       ORDER BY intent.id
       FOR UPDATE OF intent`,
      [executionIntentCutoff],
    );
    const executionIntentIds = executionIntentCohort.rows.map(({ id }) => id);
    await client.query(
      `INSERT INTO execution_intent_tombstones (
         intent_id,payload_version,logical_order_key,decision_fingerprint,retired_at
       )
       SELECT intent.id,intent.payload_version,intent.logical_order_key,
         intent.decision_fingerprint,$2::TIMESTAMPTZ
       FROM execution_intents intent
       WHERE intent.id = ANY($1::TEXT[])
       ORDER BY intent.id`,
      [executionIntentIds, executionIntentCutoff],
    );
    const executionSimulationArtifacts = await client.query(
      `DELETE FROM execution_simulation_artifacts artifact
       WHERE artifact.intent_id = ANY($1::TEXT[])`,
      [executionIntentIds],
    );
    const executionDryRunAssessments = await client.query(
      `DELETE FROM execution_dry_run_assessments assessment
       WHERE assessment.intent_id = ANY($1::TEXT[])`,
      [executionIntentIds],
    );
    const executionIntentTransitions = await client.query(
      `DELETE FROM execution_intent_transitions transition
       WHERE transition.intent_id = ANY($1::TEXT[])`,
      [executionIntentIds],
    );
    const executionAttempts = await client.query(
      `DELETE FROM execution_attempts attempt
       WHERE attempt.intent_id = ANY($1::TEXT[])`,
      [executionIntentIds],
    );
    const executionIntents = await client.query(
      `DELETE FROM execution_intents intent
       WHERE intent.id = ANY($1::TEXT[])
         AND intent.status IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED')
         AND intent.terminal_at IS NOT NULL
         AND intent.reconciliation_completed_at IS NOT NULL
         AND intent.purge_after <= $2::TIMESTAMPTZ`,
      [executionIntentIds, executionIntentCutoff],
    );
    const transitions = await client.query(
      'DELETE FROM state_transitions WHERE purge_after <= NOW()',
    );
    const walletFundingEvidence = await client.query(
      `DELETE FROM wallet_funding_evidence evidence USING token_launches launch
       WHERE evidence.mint = launch.mint AND launch.purge_after <= NOW()`,
    );
    const walletFundingObservations = await client.query(
      `DELETE FROM wallet_funding_observations observation USING token_launches launch
       WHERE observation.mint = launch.mint AND launch.purge_after <= NOW()`,
    );
    const walletRelationships = await client.query(
      `DELETE FROM wallet_relationships relationship USING token_launches launch
       WHERE relationship.mint = launch.mint AND launch.purge_after <= NOW()`,
    );
    const walletClusterMembers = await client.query(
      `DELETE FROM wallet_cluster_members member USING token_launches launch
       WHERE member.mint = launch.mint AND launch.purge_after <= NOW()`,
    );
    const walletClusters = await client.query(
      `DELETE FROM wallet_clusters cluster USING token_launches launch
       WHERE cluster.mint = launch.mint AND launch.purge_after <= NOW()`,
    );
    const walletGraphSnapshots = await client.query(
      `DELETE FROM wallet_graph_snapshots snapshot USING token_launches launch
       WHERE snapshot.mint = launch.mint AND launch.purge_after <= NOW()`,
    );
    const walletGraphProfiles = await client.query(
      `DELETE FROM wallet_graph_profiles profile USING token_launches launch
       WHERE profile.mint = launch.mint AND launch.purge_after <= NOW()`,
    );
    const observedWalletPositions = await client.query(
      `DELETE FROM observed_wallet_positions position USING token_launches launch
       WHERE position.mint = launch.mint AND launch.purge_after <= NOW()`,
    );
    const holderSnapshots = await client.query(
      `DELETE FROM token_holders_snapshots snapshot USING token_launches launch
       WHERE snapshot.mint = launch.mint AND launch.purge_after <= NOW()`,
    );
    const creatorProfiles = await client.query(
      `DELETE FROM creator_profiles profile USING token_launches launch
       WHERE profile.mint = launch.mint AND launch.purge_after <= NOW()`,
    );
    const transactionInboxRecoveries = await client.query(
      'DELETE FROM transaction_inbox_recoveries WHERE purge_after <= clock_timestamp()',
    );
    const listenerCatchUpGaps = await client.query(
      'DELETE FROM listener_catch_up_gaps WHERE purge_after <= clock_timestamp()',
    );
    const listenerStrictCatchUpFailures = await client.query(
      `DELETE FROM listener_strict_catch_up_failures
       WHERE resolved_at IS NOT NULL
         AND purge_after <= clock_timestamp()`,
    );
    const websocketHealthEvidence = await client.query(
      `UPDATE listener_websocket_health
       SET disconnect_occurred_at = NULL,
           disconnect_reason_code = NULL,
           recovery_status = 'NOT_REQUIRED',
           recovery_started_at = NULL,
           recovery_completed_at = NULL,
           recovery_reason_code = NULL,
           acknowledged_at = CASE WHEN phase = 'STOPPED' THEN NULL ELSE acknowledged_at END,
           last_observation_at = CASE WHEN phase = 'STOPPED' THEN NULL ELSE last_observation_at END,
           last_observation_slot = CASE WHEN phase = 'STOPPED' THEN NULL ELSE last_observation_slot END,
           evidence_purge_after = NULL
       WHERE evidence_purge_after <= clock_timestamp()`,
    );
    await client.query(
      `UPDATE chain_transaction_inbox
       SET terminal_at = processed_at,
           purge_after = processed_at + INTERVAL '4 hours',
           updated_at = GREATEST(updated_at, processed_at)
       WHERE processing_status = 'PROCESSED'
         AND target_confirmation_status IN ('finalized', 'orphaned')
         AND processed_at IS NOT NULL
         AND terminal_at IS NULL
         AND purge_after IS NULL`,
    );
    const transactionInbox = await client.query(
      `DELETE FROM chain_transaction_inbox
       WHERE terminal_at IS NOT NULL
         AND purge_after <= clock_timestamp()
         AND (
           processing_status<>'PROCESSED'
           OR target_confirmation_status NOT IN ('finalized','orphaned')
           OR EXISTS (
             SELECT 1
             FROM chain_transaction_finality_replay_receipts receipt
             WHERE receipt.signature=chain_transaction_inbox.signature
               AND receipt.observed_slot=chain_transaction_inbox.observed_slot
               AND receipt.confirmation_status=target_confirmation_status
               AND receipt.finality_evidence_version=
                 chain_transaction_inbox.finality_evidence_version
               AND receipt.immutable_fingerprint=
                 chain_transaction_inbox.immutable_fingerprint
               AND receipt.replay_completed_at=processed_at
           )
         )`,
    );
    const apiEventStream = await client.query<{ readonly deleted_count: string }>(
      `WITH deleted AS (
         DELETE FROM api_event_stream
         WHERE purge_after <= clock_timestamp()
         RETURNING sequence
       ),
       summary AS (
         SELECT COUNT(*) AS deleted_count, MAX(sequence) AS max_deleted_sequence
         FROM deleted
       ),
       updated_state AS (
         UPDATE api_event_stream_state state
         SET expired_through_sequence = GREATEST(
           state.expired_through_sequence,
           summary.max_deleted_sequence
         )
         FROM summary
         WHERE state.id = 1
           AND summary.max_deleted_sequence IS NOT NULL
         RETURNING state.id
       )
       SELECT deleted_count FROM summary`,
    );
    const participantDomainEvents = await client.query(
      `DELETE FROM domain_events event USING token_launches launch
       WHERE event.mint = launch.mint
         AND event.type IN (
           'CreatorProfileUpdated',
           'HolderDistributionUpdated',
           'WalletClusterDetected'
         )
         AND launch.purge_after <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM qualification_reports report
           WHERE report.source_event_id = event.event_id
              OR report.qualification_event_id = event.event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM trading_candidates candidate
           WHERE candidate.source_event_id = event.event_id
              OR candidate.candidate_event_id = event.event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM paper_strategy_sessions session
           WHERE session.source_event_id = event.event_id
              OR session.session_event_id = event.event_id
         )`,
    );
    const expiredDomainEvents = await client.query(
      `DELETE FROM domain_events WHERE purge_after <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM paper_positions position
           JOIN paper_mvp_runs run
             ON run.state = 'RUNNING'
            AND run.strategy_id = position.strategy_id
            AND run.strategy_version = position.strategy_version
            AND position.opened_at BETWEEN run.started_at AND run.deadline_at
           WHERE position.mint = domain_events.mint
         )
         AND NOT EXISTS (
           SELECT 1 FROM social_enrichment_jobs job
           WHERE job.source_launch_event_id = domain_events.event_id
             AND (job.purge_after IS NULL OR job.purge_after > statement_timestamp())
         )
         AND NOT EXISTS (
           SELECT 1 FROM social_evidence_collections collection
           WHERE collection.source_launch_event_id = domain_events.event_id
             AND (collection.purge_after IS NULL OR collection.purge_after > statement_timestamp())
         )
         AND NOT EXISTS (
           SELECT 1 FROM paper_decision_jobs job
           WHERE job.source_event_id = domain_events.event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM qualification_reports report
           WHERE report.source_event_id = domain_events.event_id
              OR report.qualification_event_id = domain_events.event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM trading_candidates candidate
           WHERE candidate.source_event_id = domain_events.event_id
              OR candidate.candidate_event_id = domain_events.event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM paper_strategy_sessions session
           WHERE session.source_event_id = domain_events.event_id
              OR session.session_event_id = domain_events.event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM paper_external_buy_events counted
           WHERE counted.source_event_id = domain_events.event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM paper_positions position
           WHERE position.close_event_id = domain_events.event_id
         )`,
    );
    const rawEvents = await client.query(
      `DELETE FROM raw_chain_events raw
       WHERE raw.purge_after <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM domain_events domain_event WHERE domain_event.raw_event_id = raw.event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM social_enrichment_jobs job
           WHERE job.source_raw_event_id = raw.event_id
             AND (job.purge_after IS NULL OR job.purge_after > statement_timestamp())
         )
         AND NOT EXISTS (
           SELECT 1 FROM paper_decision_jobs job
           WHERE job.source_raw_event_id = raw.event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM qualification_reports report
           WHERE report.source_raw_event_id = raw.event_id
         )`,
    );
    await client.query(
      `DELETE FROM chain_transaction_finality_replay_receipts receipt
       WHERE NOT EXISTS (
         SELECT 1 FROM raw_chain_events raw
         WHERE raw.signature=receipt.signature
       )
         AND NOT EXISTS (
           SELECT 1 FROM chain_transaction_inbox inbox
           WHERE inbox.signature=receipt.signature
         )`,
    );
    const launches = await client.query(
      `DELETE FROM token_launches launch WHERE purge_after <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM social_enrichment_jobs social_job
           WHERE social_job.mint = launch.mint
             AND (social_job.purge_after IS NULL
               OR social_job.purge_after > statement_timestamp())
         )
         AND NOT EXISTS (
           SELECT 1 FROM social_evidence_collections social_collection
           WHERE social_collection.mint = launch.mint
             AND (social_collection.purge_after IS NULL
               OR social_collection.purge_after > statement_timestamp())
         )
         AND NOT EXISTS (
           SELECT 1 FROM paper_decision_jobs paper_job
           WHERE paper_job.mint = launch.mint
             AND (paper_job.purge_after IS NULL
               OR paper_job.purge_after > statement_timestamp())
         )
         AND NOT EXISTS (
           SELECT 1 FROM qualification_reports report
           WHERE report.mint = launch.mint
             AND report.purge_after > statement_timestamp()
         )
         AND NOT EXISTS (
           SELECT 1 FROM trading_candidates candidate
           WHERE candidate.mint = launch.mint
             AND candidate.purge_after > statement_timestamp()
         )
         AND NOT EXISTS (
           SELECT 1 FROM paper_strategy_sessions session
           WHERE session.mint = launch.mint
             AND (session.purge_after IS NULL
               OR session.purge_after > statement_timestamp())
         )
         AND NOT EXISTS (
           SELECT 1 FROM paper_mvp_runs run
           WHERE run.state='RUNNING'
             AND launch.detected_at BETWEEN run.started_at AND run.deadline_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM paper_positions position
           WHERE position.mint = launch.mint
             AND (position.purge_after IS NULL
               OR position.purge_after > statement_timestamp()
               OR EXISTS (
                 SELECT 1 FROM paper_mvp_runs run
                 WHERE run.state = 'RUNNING'
                   AND run.strategy_id = position.strategy_id
                   AND run.strategy_version = position.strategy_version
                   AND position.opened_at BETWEEN run.started_at AND run.deadline_at
               ))
         )`,
    );
    await client.query('COMMIT');
    return {
      metadataSnapshots: metadataSnapshots.rowCount ?? 0,
      socialEvidence: socialEvidence.rowCount ?? 0,
      socialObservations: socialObservations.rowCount ?? 0,
      socialLinks: socialLinks.rowCount ?? 0,
      socialCollections: socialCollections.rowCount ?? 0,
      socialJobs: socialJobs.rowCount ?? 0,
      bondingCurveSnapshots: bondingCurveSnapshots.rowCount ?? 0,
      launchTrades: launchTrades.rowCount ?? 0,
      marketTrades: marketTrades.rowCount ?? 0,
      marketReserveSnapshots: marketReserveSnapshots.rowCount ?? 0,
      marketPools: marketPools.rowCount ?? 0,
      migrations: migrations.rowCount ?? 0,
      paperMvpSamples: paperMvpSamples.rowCount ?? 0,
      paperMvpRuns: paperMvpRuns.rowCount ?? 0,
      paperExternalBuys: paperExternalBuys.rowCount ?? 0,
      paperSessions: paperSessions.rowCount ?? 0,
      tradingCandidates: tradingCandidates.rowCount ?? 0,
      qualificationReports: qualificationReports.rowCount ?? 0,
      paperDecisionJobs: paperDecisionJobs.rowCount ?? 0,
      paperTrades: paperTrades.rowCount ?? 0,
      paperPositions: paperPositions.rowCount ?? 0,
      executionDryRunAssessments: executionDryRunAssessments.rowCount ?? 0,
      executionSimulationArtifacts: executionSimulationArtifacts.rowCount ?? 0,
      executionIntentTransitions: executionIntentTransitions.rowCount ?? 0,
      executionAttempts: executionAttempts.rowCount ?? 0,
      executionIntents: executionIntents.rowCount ?? 0,
      executionRiskRateLimitEvents: executionRiskRateLimitEvents.rowCount ?? 0,
      executionRiskReconciliationEvidence:
        executionRiskReconciliationEvidence.rowCount ?? 0,
      executionRiskFaults: executionRiskFaults.rowCount ?? 0,
      executionRiskReservations: executionRiskReservations.rowCount ?? 0,
      executionRiskAdmissionReports: executionRiskAdmissionReports.rowCount ?? 0,
      executionRiskWalletSnapshots: executionRiskWalletSnapshots.rowCount ?? 0,
      executionRiskProviderOperations: executionRiskProviderOperations.rowCount ?? 0,
      executionRiskProviderSnapshots: executionRiskProviderSnapshots.rowCount ?? 0,
      executionRiskTombstones,
      stateTransitions: transitions.rowCount ?? 0,
      observedWalletPositions: observedWalletPositions.rowCount ?? 0,
      holderSnapshots: holderSnapshots.rowCount ?? 0,
      creatorProfiles: creatorProfiles.rowCount ?? 0,
      walletFundingObservations: walletFundingObservations.rowCount ?? 0,
      walletFundingEvidence: walletFundingEvidence.rowCount ?? 0,
      walletRelationships: walletRelationships.rowCount ?? 0,
      walletGraphProfiles: walletGraphProfiles.rowCount ?? 0,
      walletClusterMembers: walletClusterMembers.rowCount ?? 0,
      walletClusters: walletClusters.rowCount ?? 0,
      walletGraphSnapshots: walletGraphSnapshots.rowCount ?? 0,
      transactionInboxRecoveries: transactionInboxRecoveries.rowCount ?? 0,
      listenerCatchUpGaps: listenerCatchUpGaps.rowCount ?? 0,
      listenerStrictCatchUpFailures: listenerStrictCatchUpFailures.rowCount ?? 0,
      websocketHealthEvidence: websocketHealthEvidence.rowCount ?? 0,
      transactionInbox: transactionInbox.rowCount ?? 0,
      apiEventStream: Number(apiEventStream.rows[0]?.deleted_count ?? 0),
      domainEvents: (participantDomainEvents.rowCount ?? 0)
        + (expiredDomainEvents.rowCount ?? 0),
      rawChainEvents: rawEvents.rowCount ?? 0,
      tokenLaunches: launches.rowCount ?? 0,
    };
  } catch (primaryFailure) {
    const cleanupFailures: unknown[] = [];
    let mustEvictClient = false;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackFailure) {
      cleanupFailures.push(rollbackFailure);
      mustEvictClient = true;
    }
    failureCleanupHandled = true;
    try {
      if (mustEvictClient) client.release(true);
      else client.release();
    } catch (releaseFailure) {
      cleanupFailures.push(releaseFailure);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        'Foundation data purge and cleanup failed.',
      );
    }
    throw primaryFailure;
  } finally {
    if (!failureCleanupHandled) client.release();
  }
}

async function migrationExists(client: PoolClient, version: string): Promise<boolean> {
  const result = await client.query<{ readonly exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM migration_history WHERE version = $1) AS exists',
    [version],
  );
  return result.rows[0]?.exists === true;
}

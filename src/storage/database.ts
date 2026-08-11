import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { PoolClient } from 'pg';

type PgPool = InstanceType<typeof pg.Pool>;
let sharedPool: PgPool | null = null;
const migrationAdvisoryLockId = 7_347_662_125;

export function getDatabasePool(databaseUrl = process.env.DATABASE_URL): PgPool {
  if (sharedPool !== null) return sharedPool;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required to access PostgreSQL.');
  }
  sharedPool = new pg.Pool({ connectionString: databaseUrl });
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
  let primaryFailure: unknown;
  let primaryFailed = false;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [migrationAdvisoryLockId]);
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
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  }

  let unlockFailure: unknown;
  let unlockFailed = false;
  try {
    const unlock = await client.query<{ readonly unlocked: boolean }>(
      'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
      [migrationAdvisoryLockId],
    );
    if (unlock.rows.length !== 1 || unlock.rows[0]?.unlocked !== true) {
      throw new Error('Migration advisory lock was not released.');
    }
  } catch (error) {
    unlockFailed = true;
    unlockFailure = error;
  }

  let releaseFailure: unknown;
  let releaseFailed = false;
  try {
    client.release();
  } catch (error) {
    releaseFailed = true;
    releaseFailure = error;
  }

  const failures = [
    ...(primaryFailed ? [primaryFailure] : []),
    ...(unlockFailed ? [unlockFailure] : []),
    ...(releaseFailed ? [releaseFailure] : []),
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Database migration and cleanup failed.');
  }
  return applied;
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
  readonly paperExternalBuys: number;
  readonly paperSessions: number;
  readonly tradingCandidates: number;
  readonly qualificationReports: number;
  readonly paperDecisionJobs: number;
  readonly paperTrades: number;
  readonly paperPositions: number;
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
  readonly transactionInbox: number;
  readonly apiEventStream: number;
  readonly domainEvents: number;
  readonly rawChainEvents: number;
  readonly tokenLaunches: number;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
    const bondingCurveSnapshots = await client.query(
      `DELETE FROM bonding_curve_snapshots snapshot USING token_launches launch
       WHERE snapshot.mint = launch.mint AND launch.purge_after <= NOW()`,
    );
    const launchTrades = await client.query(
      `DELETE FROM launch_trades trade USING token_launches launch
       WHERE trade.mint = launch.mint AND launch.purge_after <= NOW()`,
    );
    const marketTrades = await client.query(
      'DELETE FROM market_trades WHERE purge_after <= NOW()',
    );
    const marketReserveSnapshots = await client.query(
      'DELETE FROM market_reserve_snapshots WHERE purge_after <= NOW()',
    );
    const marketPools = await client.query(
      'DELETE FROM market_pools WHERE purge_after <= NOW()',
    );
    const migrations = await client.query(
      'DELETE FROM migrations WHERE purge_after <= NOW()',
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
      'DELETE FROM paper_decision_jobs WHERE purge_after <= statement_timestamp()',
    );
    const paperTrades = await client.query(
      `DELETE FROM paper_trades trade USING paper_positions position
       WHERE trade.position_id = position.position_id
         AND position.purge_after <= NOW()`,
    );
    const paperPositions = await client.query(
      'DELETE FROM paper_positions WHERE purge_after <= NOW()',
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
         AND purge_after <= clock_timestamp()`,
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
             AND (job.purge_after IS NULL OR job.purge_after > statement_timestamp())
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
             AND (job.purge_after IS NULL OR job.purge_after > statement_timestamp())
         )
         AND NOT EXISTS (
           SELECT 1 FROM qualification_reports report
           WHERE report.source_raw_event_id = raw.event_id
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
           SELECT 1 FROM paper_positions position
           WHERE position.mint = launch.mint
             AND (position.purge_after IS NULL
               OR position.purge_after > statement_timestamp())
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
      paperExternalBuys: paperExternalBuys.rowCount ?? 0,
      paperSessions: paperSessions.rowCount ?? 0,
      tradingCandidates: tradingCandidates.rowCount ?? 0,
      qualificationReports: qualificationReports.rowCount ?? 0,
      paperDecisionJobs: paperDecisionJobs.rowCount ?? 0,
      paperTrades: paperTrades.rowCount ?? 0,
      paperPositions: paperPositions.rowCount ?? 0,
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
      transactionInbox: transactionInbox.rowCount ?? 0,
      apiEventStream: Number(apiEventStream.rows[0]?.deleted_count ?? 0),
      domainEvents: (participantDomainEvents.rowCount ?? 0)
        + (expiredDomainEvents.rowCount ?? 0),
      rawChainEvents: rawEvents.rowCount ?? 0,
      tokenLaunches: launches.rowCount ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function migrationExists(client: PoolClient, version: string): Promise<boolean> {
  const result = await client.query<{ readonly exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM migration_history WHERE version = $1) AS exists',
    [version],
  );
  return result.rows[0]?.exists === true;
}

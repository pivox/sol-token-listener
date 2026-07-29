import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { PoolClient } from 'pg';

type PgPool = InstanceType<typeof pg.Pool>;
let sharedPool: PgPool | null = null;

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
  try {
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
  } finally {
    client.release();
  }
  return applied;
}

export async function purgeExpiredFoundationData(pool: PgPool = getDatabasePool()): Promise<{
  readonly metadataSnapshots: number;
  readonly bondingCurveSnapshots: number;
  readonly launchTrades: number;
  readonly marketTrades: number;
  readonly marketReserveSnapshots: number;
  readonly marketPools: number;
  readonly migrations: number;
  readonly paperPositions: number;
  readonly stateTransitions: number;
  readonly apiEventStream: number;
  readonly domainEvents: number;
  readonly rawChainEvents: number;
  readonly tokenLaunches: number;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const metadataSnapshots = await client.query(
      `DELETE FROM token_metadata_snapshots snapshot USING token_launches launch
       WHERE snapshot.mint = launch.mint AND launch.purge_after <= NOW()`,
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
    const paperPositions = await client.query(
      'DELETE FROM paper_positions WHERE purge_after <= NOW()',
    );
    const transitions = await client.query(
      'DELETE FROM state_transitions WHERE purge_after <= NOW()',
    );
    const apiEventStream = await client.query(
      'DELETE FROM api_event_stream WHERE purge_after <= NOW()',
    );
    const domainEvents = await client.query(
      'DELETE FROM domain_events WHERE purge_after <= NOW()',
    );
    const rawEvents = await client.query(
      `DELETE FROM raw_chain_events raw
       WHERE raw.purge_after <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM domain_events domain_event WHERE domain_event.raw_event_id = raw.event_id
         )`,
    );
    const launches = await client.query(
      'DELETE FROM token_launches WHERE purge_after <= NOW()',
    );
    await client.query('COMMIT');
    return {
      metadataSnapshots: metadataSnapshots.rowCount ?? 0,
      bondingCurveSnapshots: bondingCurveSnapshots.rowCount ?? 0,
      launchTrades: launchTrades.rowCount ?? 0,
      marketTrades: marketTrades.rowCount ?? 0,
      marketReserveSnapshots: marketReserveSnapshots.rowCount ?? 0,
      marketPools: marketPools.rowCount ?? 0,
      migrations: migrations.rowCount ?? 0,
      paperPositions: paperPositions.rowCount ?? 0,
      stateTransitions: transitions.rowCount ?? 0,
      apiEventStream: apiEventStream.rowCount ?? 0,
      domainEvents: domainEvents.rowCount ?? 0,
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

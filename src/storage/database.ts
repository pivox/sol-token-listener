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

async function migrationExists(client: PoolClient, version: string): Promise<boolean> {
  const result = await client.query<{ readonly exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM migration_history WHERE version = $1) AS exists',
    [version],
  );
  return result.rows[0]?.exists === true;
}

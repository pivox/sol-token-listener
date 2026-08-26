import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationLockId = 7_347_662_125;

void test('holds the fixed session advisory lock across history reads and migration applications', async () => {
  const directory = await migrationDirectory();
  const database = new RecordingPool();
  try {
    const applied = await migrateDatabase({
      pool: database.pool,
      migrationsDirectory: directory,
    });

    assert.deepEqual(applied, ['001_first.sql']);
    assert.deepEqual(database.events, [
      'lock', 'history-table', 'history-read', 'begin', 'application',
      'history-write', 'commit', 'unlock', 'release',
    ]);
    assert.deepEqual(database.lockValues, [[migrationLockId]]);
    assert.deepEqual(database.unlockValues, [[migrationLockId]]);
    assert.deepEqual(database.lockQueries, ['SELECT pg_advisory_lock($1)']);
    assert.deepEqual(database.unlockQueries, ['SELECT pg_advisory_unlock($1)']);
    assert.deepEqual(database.releaseArguments, [undefined]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('unlocks and releases the session after a migration application fails', async () => {
  const directory = await migrationDirectory();
  const migrationFailure = new Error('migration failed');
  const database = new RecordingPool({ applicationFailure: migrationFailure });
  try {
    await assert.rejects(
      migrateDatabase({ pool: database.pool, migrationsDirectory: directory }),
      migrationFailure,
    );
    assert.deepEqual(database.events, [
      'lock', 'history-table', 'history-read', 'begin', 'application',
      'rollback', 'unlock', 'release',
    ]);
    assert.deepEqual(database.releaseArguments, [undefined]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('preserves migration and rollback failures before unlocking and evicting the session', async () => {
  const directory = await migrationDirectory();
  const migrationFailure = new Error('migration failed');
  const rollbackFailure = new Error('rollback failed');
  const database = new RecordingPool({ applicationFailure: migrationFailure, rollbackFailure });
  try {
    await assert.rejects(
      migrateDatabase({ pool: database.pool, migrationsDirectory: directory }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [migrationFailure, rollbackFailure]);
        return true;
      },
    );
    assert.deepEqual(database.events, [
      'lock', 'history-table', 'history-read', 'begin', 'application',
      'rollback', 'unlock', 'release',
    ]);
    assert.deepEqual(database.releaseArguments, [true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('orders migration, rollback, unlock and eviction failures deterministically', async () => {
  const directory = await migrationDirectory();
  const migrationFailure = new Error('migration failed');
  const rollbackFailure = new Error('rollback failed');
  const unlockFailure = new Error('unlock failed');
  const releaseFailure = new Error('eviction failed');
  const database = new RecordingPool({
    applicationFailure: migrationFailure,
    rollbackFailure,
    unlockFailure,
    releaseFailure,
  });
  try {
    await assert.rejects(
      migrateDatabase({ pool: database.pool, migrationsDirectory: directory }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [
          migrationFailure,
          rollbackFailure,
          unlockFailure,
          releaseFailure,
        ]);
        return true;
      },
    );
    assert.deepEqual(database.events, [
      'lock', 'history-table', 'history-read', 'begin', 'application',
      'rollback', 'unlock', 'release',
    ]);
    assert.deepEqual(database.releaseArguments, [true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('rejects a false advisory unlock result and still releases the session', async () => {
  const directory = await emptyMigrationDirectory();
  const database = new RecordingPool({
    unlockResult: { rows: [{ pg_advisory_unlock: false }] },
  });
  try {
    await assert.rejects(
      migrateDatabase({ pool: database.pool, migrationsDirectory: directory }),
      /Migration advisory lock was not released/u,
    );
    assert.deepEqual(database.events, ['lock', 'history-table', 'unlock', 'release']);
    assert.deepEqual(database.releaseArguments, [true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('rejects a malformed advisory unlock result and still releases the session', async () => {
  const directory = await emptyMigrationDirectory();
  const database = new RecordingPool({ unlockResult: { rows: [] } });
  try {
    await assert.rejects(
      migrateDatabase({ pool: database.pool, migrationsDirectory: directory }),
      /Migration advisory lock was not released/u,
    );
    assert.deepEqual(database.events, ['lock', 'history-table', 'unlock', 'release']);
    assert.deepEqual(database.releaseArguments, [true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('rejects an advisory unlock getter without invoking it and still releases the session', async () => {
  const directory = await emptyMigrationDirectory();
  let getterInvoked = false;
  const unlockRow = Object.defineProperty({}, 'pg_advisory_unlock', {
    enumerable: true,
    get: () => {
      getterInvoked = true;
      return true;
    },
  });
  const database = new RecordingPool({ unlockResult: { rows: [unlockRow] } });
  try {
    await assert.rejects(
      migrateDatabase({ pool: database.pool, migrationsDirectory: directory }),
      /Migration advisory lock was not released/u,
    );
    assert.equal(getterInvoked, false);
    assert.deepEqual(database.events, ['lock', 'history-table', 'unlock', 'release']);
    assert.deepEqual(database.releaseArguments, [true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('rejects a standalone advisory unlock failure after migrations succeed and releases the session', async () => {
  const directory = await migrationDirectory();
  const unlockFailure = new Error('unlock failed');
  const database = new RecordingPool({ unlockFailure });
  try {
    await assert.rejects(
      migrateDatabase({ pool: database.pool, migrationsDirectory: directory }),
      (error: unknown) => {
        assert.equal(error, unlockFailure);
        assert.ok(!(error instanceof AggregateError));
        return true;
      },
    );
    assert.deepEqual(database.events, [
      'lock', 'history-table', 'history-read', 'begin', 'application',
      'history-write', 'commit', 'unlock', 'release',
    ]);
    assert.deepEqual(database.releaseArguments, [true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('aggregates migration and advisory unlock failures with the migration failure first', async () => {
  const directory = await migrationDirectory();
  const migrationFailure = new Error('migration failed');
  const unlockFailure = new Error('unlock failed');
  const database = new RecordingPool({ applicationFailure: migrationFailure, unlockFailure });
  try {
    await assert.rejects(
      migrateDatabase({ pool: database.pool, migrationsDirectory: directory }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [migrationFailure, unlockFailure]);
        return true;
      },
    );
    assert.deepEqual(database.events.at(-2), 'unlock');
    assert.deepEqual(database.events.at(-1), 'release');
    assert.deepEqual(database.releaseArguments, [true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('evicts without unlocking when advisory lock acquisition fails', async () => {
  const directory = await emptyMigrationDirectory();
  const lockFailure = new Error('lock failed');
  const database = new RecordingPool({ lockFailure });
  try {
    await assert.rejects(
      migrateDatabase({ pool: database.pool, migrationsDirectory: directory }),
      (error: unknown) => {
        assert.equal(error, lockFailure);
        assert.ok(!(error instanceof AggregateError));
        return true;
      },
    );
    assert.deepEqual(database.events, ['lock', 'release']);
    assert.deepEqual(database.releaseArguments, [true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('propagates a normal release failure after a successful unlock', async () => {
  const directory = await emptyMigrationDirectory();
  const releaseFailure = new Error('release failed');
  const database = new RecordingPool({ releaseFailure });
  try {
    await assert.rejects(
      migrateDatabase({ pool: database.pool, migrationsDirectory: directory }),
      releaseFailure,
    );
    assert.deepEqual(database.events, ['lock', 'history-table', 'unlock', 'release']);
    assert.deepEqual(database.releaseArguments, [undefined]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('aggregates acquisition and eviction failures without inventing an unlock failure', async () => {
  const directory = await emptyMigrationDirectory();
  const lockFailure = new Error('lock failed');
  const releaseFailure = new Error('eviction failed');
  const database = new RecordingPool({ lockFailure, releaseFailure });
  try {
    await assert.rejects(
      migrateDatabase({ pool: database.pool, migrationsDirectory: directory }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [lockFailure, releaseFailure]);
        return true;
      },
    );
    assert.deepEqual(database.events, ['lock', 'release']);
    assert.deepEqual(database.releaseArguments, [true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('aggregates unlock and eviction failures', async () => {
  const directory = await emptyMigrationDirectory();
  const unlockFailure = new Error('unlock failed');
  const releaseFailure = new Error('eviction failed');
  const database = new RecordingPool({ unlockFailure, releaseFailure });
  try {
    await assert.rejects(
      migrateDatabase({ pool: database.pool, migrationsDirectory: directory }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [unlockFailure, releaseFailure]);
        return true;
      },
    );
    assert.deepEqual(database.events, ['lock', 'history-table', 'unlock', 'release']);
    assert.deepEqual(database.releaseArguments, [true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('orders primary, unlock and eviction failures', async () => {
  const directory = await migrationDirectory();
  const migrationFailure = new Error('migration failed');
  const unlockFailure = new Error('unlock failed');
  const releaseFailure = new Error('eviction failed');
  const database = new RecordingPool({ applicationFailure: migrationFailure, unlockFailure, releaseFailure });
  try {
    await assert.rejects(
      migrateDatabase({ pool: database.pool, migrationsDirectory: directory }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [migrationFailure, unlockFailure, releaseFailure]);
        return true;
      },
    );
    assert.deepEqual(database.events, [
      'lock', 'history-table', 'history-read', 'begin', 'application',
      'rollback', 'unlock', 'release',
    ]);
    assert.deepEqual(database.releaseArguments, [true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('serializes concurrent pools so each canonical migration is recorded once', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live PostgreSQL migration lock test skipped');
    return;
  }

  const schema = `migration_lock_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const firstPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const secondPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const canonical = (await readdir(new URL('../migrations/', import.meta.url)))
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name))
      .sort((left, right) => left.localeCompare(right));
    assert.equal(canonical.length, 18);

    const [firstApplied, secondApplied] = await Promise.all([
      migrateDatabase({ pool: firstPool }),
      migrateDatabase({ pool: secondPool }),
    ]);
    const union = [...new Set([...firstApplied, ...secondApplied])].sort();
    const overlap = firstApplied.filter((name) => secondApplied.includes(name));

    assert.deepEqual(union, canonical);
    assert.deepEqual(overlap, []);
    const history = await firstPool.query<{ version: string; occurrences: string }>(
      'SELECT version, COUNT(*)::text AS occurrences FROM migration_history GROUP BY version ORDER BY version',
    );
    assert.deepEqual(history.rows, canonical.map((version) => ({ version, occurrences: '1' })));
  } finally {
    await firstPool.end();
    await secondPool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

class RecordingPool {
  public readonly events: string[] = [];
  public readonly lockValues: unknown[][] = [];
  public readonly unlockValues: unknown[][] = [];
  public readonly lockQueries: string[] = [];
  public readonly unlockQueries: string[] = [];
  public readonly releaseArguments: (boolean | undefined)[] = [];
  public readonly pool: InstanceType<typeof pg.Pool>;

  public constructor(private readonly options: {
    readonly applicationFailure?: Error;
    readonly lockFailure?: Error;
    readonly releaseFailure?: Error;
    readonly rollbackFailure?: Error;
    readonly unlockFailure?: Error;
    readonly unlockResult?: { readonly rows: readonly unknown[] };
  } = {}) {
    this.pool = {
      connect: async () => ({
        query: async (text: string, values?: unknown[]) => this.query(text, values),
        release: (destroy?: boolean) => {
          this.events.push('release');
          this.releaseArguments.push(destroy);
          if (this.options.releaseFailure !== undefined) throw this.options.releaseFailure;
        },
      }),
    } as unknown as InstanceType<typeof pg.Pool>;
  }

  private async query(text: string, values: unknown[] | undefined): Promise<{ rows: readonly unknown[] }> {
    if (text.includes('pg_advisory_lock')) {
      this.events.push('lock');
      this.lockQueries.push(text);
      this.lockValues.push(values ?? []);
      if (this.options.lockFailure !== undefined) throw this.options.lockFailure;
      return { rows: [] };
    }
    if (text.includes('pg_advisory_unlock')) {
      this.events.push('unlock');
      this.unlockQueries.push(text);
      this.unlockValues.push(values ?? []);
      if (this.options.unlockFailure !== undefined) throw this.options.unlockFailure;
      return this.options.unlockResult ?? { rows: [{ pg_advisory_unlock: true }] };
    }
    if (text.includes('CREATE TABLE IF NOT EXISTS migration_history')) {
      this.events.push('history-table');
    } else if (text.includes('SELECT 1 FROM migration_history')) {
      this.events.push('history-read');
    } else if (text === 'BEGIN') {
      this.events.push('begin');
    } else if (text === 'COMMIT') {
      this.events.push('commit');
    } else if (text === 'ROLLBACK') {
      this.events.push('rollback');
      if (this.options.rollbackFailure !== undefined) throw this.options.rollbackFailure;
    } else if (text.includes('INSERT INTO migration_history')) {
      this.events.push('history-write');
    } else {
      this.events.push('application');
      if (this.options.applicationFailure !== undefined) throw this.options.applicationFailure;
    }
    return { rows: [] };
  }
}

async function migrationDirectory(): Promise<string> {
  const directory = await emptyMigrationDirectory();
  await writeFile(join(directory, '001_first.sql'), 'SELECT 1;\n');
  return directory;
}

async function emptyMigrationDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sol-listener-migration-lock-'));
  const directory = join(root, 'migrations');
  await mkdir(directory);
  return directory;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) throw new Error('Unsafe SQL identifier.');
  return `"${identifier}"`;
}

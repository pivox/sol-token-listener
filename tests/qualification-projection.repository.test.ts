import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { createTokenLaunchDetectedEvent } from '../src/domain/launchpad-events.js';
import { createInitialDetectedTransition } from '../src/domain/state-transitions.js';
import { trustedTerminalAttribution } from '../src/domain/terminal-attribution.js';
import type { LaunchpadEventBatch } from '../src/ports/launchpad-event-sink.js';
import { PostgresLaunchpadEventRepository } from '../src/storage/launchpad-event.repository.js';
import type { QualificationProjectionPool } from '../src/storage/qualification-projection.repository.js';
import { QualificationRebuildService } from '../src/application/qualification-rebuild.service.js';
import type {
  CanonicalQualificationProjection,
  QualificationCanonicalSnapshot,
} from '../src/ports/qualification-projection-repository.js';
import {
  QualificationEngine,
  createDefaultQualificationRuleSet,
} from '../src/qualification/qualification-engine.js';
import { socialMetadataSnapshotId } from '../src/domain/social-evidence.js';
import { toJsonValue } from '../src/utils/json.js';
import { migrateDatabase } from '../src/storage/database.js';
import {
  PostgresQualificationProjectionRepository,
  QualificationProjectionDataError,
  QualificationProjectionRepositoryError,
} from '../src/storage/qualification-projection.repository.js';
import { PostgresApiProjectionRepository } from '../src/storage/api-projection.repository.js';

void test('acquires a session mint lock before repeatable read and always unlocks', async () => {
  const database = new ScriptedPool();
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  const result = await repository.transact('mint', async () => 'result');

  assert.equal(result, 'result');
  assert.match(database.queries[0]?.text ?? '', /pg_advisory_lock/u);
  assert.equal(database.queries[1]?.text, 'BEGIN ISOLATION LEVEL REPEATABLE READ');
  assert.match(
    database.queries[0]?.text ?? '',
    /hashtextextended\('qualification-projection:' \|\| \$1, 0\)/u,
  );
  assert.equal(database.queries.some((call) => call.text.includes('pg_advisory_xact_lock')), false);
  assert.equal(database.queries.at(-2)?.text, 'COMMIT');
  assert.match(database.queries.at(-1)?.text ?? '', /pg_advisory_unlock/u);
  assert.equal(database.released, true);
  assert.deepEqual(database.releaseArguments, [undefined]);
});

void test('rolls back and releases without leaking database causes', async () => {
  const database = new ScriptedPool();
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('mint', async () => {
      throw new Error('password=secret');
    }),
    (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionRepositoryError);
      assert.equal(error.message, 'Qualification projection transaction failed.');
      assert.doesNotMatch(error.message, /secret/u);
      return true;
    },
  );
  assert.equal(database.queries.at(-2)?.text, 'ROLLBACK');
  assert.match(database.queries.at(-1)?.text ?? '', /pg_advisory_unlock/u);
  assert.equal(database.released, true);
});

void test('redacts rollback and unlock failures while releasing the connection', async () => {
  const database = new ScriptedPool((text) => {
    if (text === 'ROLLBACK') throw new Error('rollback-password');
    if (text.includes('pg_advisory_unlock')) throw new Error('unlock-password');
    return undefined;
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('mint', async () => { throw new Error('primary-password'); }),
    (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionRepositoryError);
      assert.equal(error.message, 'Qualification projection transaction failed.');
      assert.doesNotMatch(error.message, /password/u);
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.length, 3);
      assert.doesNotMatch(JSON.stringify(error.cause), /password/u);
      return true;
    },
  );
  assert.equal(database.released, true);
  const eviction = database.releaseArguments[0];
  assert.ok(eviction instanceof Error);
  assert.equal(eviction.message, 'Qualification projection session lock eviction required.');
  assert.doesNotMatch(eviction.message, /password/u);
});

void test('does not unlock when session lock acquisition fails', async () => {
  const database = new ScriptedPool((text) => {
    if (text.includes('pg_advisory_lock')) throw new Error('lock-password');
    return undefined;
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('mint', async () => undefined),
    QualificationProjectionRepositoryError,
  );
  assert.equal(database.queries.some((call) => call.text.includes('pg_advisory_unlock')), false);
  assert.equal(database.released, true);
  const eviction = database.releaseArguments[0];
  assert.ok(eviction instanceof Error);
  assert.equal(eviction.message, 'Qualification projection session lock eviction required.');
  assert.doesNotMatch(eviction.message, /password/u);
});

void test('treats a false session unlock result as a cleanup failure', async () => {
  const database = new ScriptedPool((text) => {
    if (text.includes('pg_advisory_unlock')) {
      return rows([{ pg_advisory_unlock: false }]);
    }
    return undefined;
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('mint', async () => undefined),
    QualificationProjectionRepositoryError,
  );
  assert.equal(database.released, true);
  const eviction = database.releaseArguments[0];
  assert.ok(eviction instanceof Error);
  assert.equal(eviction.message, 'Qualification projection session lock eviction required.');
});

void test('aggregates and redacts an eviction release failure', async () => {
  const database = new ScriptedPool(
    (text) => {
      if (text.includes('pg_advisory_unlock')) throw new Error('unlock-password');
      return undefined;
    },
    () => { throw new Error('release-password'); },
  );
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('mint', async () => { throw new Error('primary-password'); }),
    (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionRepositoryError);
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.length, 3);
      assert.doesNotMatch(error.message, /password/u);
      assert.doesNotMatch(JSON.stringify(error.cause), /password/u);
      return true;
    },
  );
  const eviction = database.releaseArguments[0];
  assert.ok(eviction instanceof Error);
  assert.doesNotMatch(eviction.message, /password/u);
});

void test('rejects empty and mismatched mints', async () => {
  const database = new ScriptedPool();
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('', async () => undefined),
    /Qualification projection mint is required/u,
  );
  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.loadCanonicalInput('other')),
    (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionDataError);
      assert.equal(error.message, 'Qualification projection mint does not match its lock.');
      return true;
    },
  );
});

void test('loads only active raw-backed canonical evidence with a complete cursor order', async () => {
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow()]);
    if (text.includes('qualification_as_of')) return rows([asOfRow()]);
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  const snapshot = await repository.transact('mint', (transaction) => (
    transaction.loadCanonicalInput('mint')
  ));

  assert.ok(snapshot);
  assert.equal(snapshot.asOfRawEventId, 'raw-launch');
  assert.equal(snapshot.asOfEvent.id, 'launch-event');
  assert.equal(snapshot.launch.createdAt.slot, 10n);
  assert.equal(snapshot.metadata, null);
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'asOfEvent', 'asOfRawEventId', 'creatorHasSold', 'launch', 'metadata', 'mint',
  ]);
  assert.equal(database.queries.some((call) =>
    /social_|creator_profiles|token_holders_snapshots|wallet_/u.test(call.text)), false);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.launch), true);
  const asOfSql = database.queries.find((call) =>
    call.text.includes('qualification_as_of'))?.text ?? '';
  assert.match(asOfSql, /JOIN raw_chain_events AS raw/u);
  assert.match(asOfSql, /domain\.raw_event_id IS NOT NULL/u);
  assert.match(asOfSql, /domain\.confirmation_status <> 'orphaned'/u);
  assert.match(asOfSql, /raw\.confirmation_status <> 'orphaned'/u);
  assert.match(asOfSql, /'TokenLaunchDetected'/u);
  assert.match(asOfSql, /'BondingCurveTradeObserved'/u);
  assert.match(asOfSql, /'BondingCurveStateUpdated'/u);
  assert.match(asOfSql, /'BondingCurveCompleted'/u);
  assert.match(asOfSql, /'MigrationObserved'/u);
  assert.match(asOfSql, /'PumpSwapPoolActivated'/u);
  assert.doesNotMatch(asOfSql, /QualificationUpdated|TradingCandidateUpdated|Paper/u);
  assert.match(
    asOfSql,
    /ORDER BY domain\.slot DESC,domain\.transaction_index DESC,\s*domain\.instruction_index DESC,COALESCE\(domain\.inner_instruction_index,-1\) DESC,\s*domain\.event_id DESC/u,
  );
});

void test('fails closed when a canonical row has no exact raw lineage', async () => {
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow()]);
    if (text.includes('qualification_as_of')) return rows([{ ...asOfRow(), raw_event_id: null }]);
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.loadCanonicalInput('mint')),
    (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionDataError);
      assert.equal(error.message, 'Stored qualification projection data is invalid.');
      return true;
    },
  );
  assert.equal(database.queries.at(-2)?.text, 'ROLLBACK');
});

void test('reconstructs metadata only from the active launch event', async () => {
  const evidence = metadataFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow(evidence.mint)]);
    if (text.includes('qualification_as_of')) return rows([asOfRow(evidence.mint)]);
    if (text.includes('qualification_metadata_launch')) return rows([evidence.metadataRow]);
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  const snapshot = await repository.transact(evidence.mint, (transaction) => (
    transaction.loadCanonicalInput(evidence.mint)
  ));

  assert.deepEqual(snapshot?.metadata, evidence.metadata);
  const metadataCall = database.queries.find((call) =>
    call.text.includes('qualification_metadata_launch'));
  assert.match(metadataCall?.text ?? '', /source_launch_event_id=\$2/u);
  assert.match(metadataCall?.text ?? '', /ORDER BY fetched_at DESC,snapshot_id DESC LIMIT 1/u);
  assert.deepEqual(metadataCall?.values, [evidence.mint, 'launch-event']);
});

void test('rejects a metadata row whose identity does not match its content', async () => {
  const evidence = metadataFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow(evidence.mint)]);
    if (text.includes('qualification_as_of')) return rows([asOfRow(evidence.mint)]);
    if (text.includes('qualification_metadata_launch')) {
      return rows([{ ...evidence.metadataRow, uri: 'https://example.test/other.json' }]);
    }
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact(evidence.mint, (transaction) => (
      transaction.loadCanonicalInput(evidence.mint)
    )),
    QualificationProjectionDataError,
  );
});

void test('validates source lineage, supersedes current first and inserts one four-hour report', async () => {
  const projection = projectionFixture();
  let authorized = false;
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) return rows([sourceMappingRow(projection)]);
    return undefined;
  });
  const repository = new PostgresQualificationProjectionRepository(database, {
    reauthorize: (received) => {
      authorized = true;
      qualificationService().reauthorize(received);
    },
  });

  const outcome = await repository.transact('mint', (transaction) => (
    transaction.replaceProjection(projection)
  ));

  assert.equal(outcome, 'UPDATED');
  assert.equal(authorized, true);
  const statements = database.queries.map((call) => call.text);
  const supersedeIndex = statements.findIndex((sql) => sql.includes('UPDATE qualification_reports'));
  const eventIndex = statements.findIndex((sql) => sql.includes('INSERT INTO domain_events'));
  const reportIndex = statements.findIndex((sql) => sql.includes('INSERT INTO qualification_reports'));
  assert.ok(supersedeIndex > 0);
  assert.ok(eventIndex > supersedeIndex);
  assert.ok(reportIndex > eventIndex);
  const sourceSql = statements.find((sql) => sql.includes('qualification_source_mapping')) ?? '';
  assert.match(sourceSql, /source\.raw_event_id=raw\.event_id/u);
  assert.match(sourceSql, /source\.confirmation_status <> 'orphaned'/u);
  const reportCall = database.queries[reportIndex];
  assert.ok(reportCall?.values);
  const dates = reportCall.values.filter((value): value is Date => value instanceof Date);
  assert.equal(dates.length, 2);
  const evaluatedAt = dates[0];
  const purgeAfter = dates[1];
  assert.ok(evaluatedAt);
  assert.ok(purgeAfter);
  assert.equal(purgeAfter.getTime() - evaluatedAt.getTime(), 14_400_000);
  const eventInsert = statements[eventIndex] ?? '';
  assert.match(eventInsert, /ON CONFLICT \(event_id\) DO NOTHING/u);
  assert.match(eventInsert, /terminal_at,purge_after/u);
});

void test('rejects sourceRawEventId substitution before writing', async () => {
  const projection = projectionFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) return rows([]);
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(
    database,
    qualificationService(),
  );

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.replaceProjection(projection)),
    (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionDataError);
      return true;
    },
  );
  assert.equal(database.queries.some((call) => call.text.includes('INSERT INTO domain_events')), false);
});

void test('rejects a raw-backed but non-canonical derived source event', async () => {
  const projection = projectionFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) {
      return rows([{ ...sourceMappingRow(projection), type: 'QualificationUpdated' }]);
    }
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(
    database,
    qualificationService(),
  );

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.replaceProjection(projection)),
    QualificationProjectionDataError,
  );
  assert.equal(database.queries.some((call) => call.text.includes('INSERT INTO domain_events')), false);
});

void test('dissolves the current report without deleting or inventing an event', async () => {
  const database = new ScriptedPool();
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await repository.transact('mint', (transaction) => transaction.dissolveCurrent('mint'));

  const statements = database.queries.map((call) => call.text);
  const dissolve = statements.find((sql) => sql.includes('qualification_dissolve')) ?? '';
  assert.match(dissolve, /UPDATE qualification_reports/u);
  assert.match(dissolve, /superseded_at=GREATEST/u);
  assert.doesNotMatch(dissolve, /DELETE/u);
  assert.equal(statements.some((sql) => sql.includes('INSERT INTO domain_events')), false);
});

void test('returns UNCHANGED for an exact current replay without event or outbox revision', async () => {
  const projection = projectionFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) return rows([sourceMappingRow(projection)]);
    if (text.includes('qualification_current_report')) {
      return rows([{ report_id: projection.reportId }]);
    }
    if (text.includes('qualification_stored_report')) {
      return rows([storedProjectionRow(projection)]);
    }
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(
    database,
    qualificationService(),
  );

  const outcome = await repository.transact('mint', (transaction) => (
    transaction.replaceProjection(projection)
  ));

  assert.equal(outcome, 'UNCHANGED');
  const statements = database.queries.map((call) => call.text);
  assert.equal(statements.some((sql) => sql.includes('INSERT INTO domain_events')), false);
  assert.equal(statements.some((sql) => sql.includes('INSERT INTO qualification_reports')), false);
  assert.equal(statements.some((sql) => sql.includes('UPDATE qualification_reports')), false);
  const currentSql = statements.find((sql) => sql.includes('qualification_current_report')) ?? '';
  assert.match(currentSql, /purge_after > clock_timestamp\(\)/u);
});

void test('round-trips exact quote lineage bigint coordinates from durable JSON', async () => {
  const projection = projectionFixture({ withQuoteLineage: true });
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) return rows([sourceMappingRow(projection)]);
    if (text.includes('qualification_current_report')) {
      return rows([{ report_id: projection.reportId }]);
    }
    if (text.includes('qualification_stored_report')) {
      return rows([storedProjectionRow(projection)]);
    }
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(
    database,
    qualificationService(),
  );

  const outcome = await repository.transact('mint', (transaction) => (
    transaction.replaceProjection(projection)
  ));

  assert.equal(outcome, 'UNCHANGED');
  assert.deepEqual(projection.evaluation.calibrationFacts?.quoteLineage, {
    schemaVersion: 1,
    buy: { quoteId:'buy-exact', observedSlot:11n, observedAtMs:1_100 },
    reverseSell: { quoteId:'sell-exact', observedSlot:12n, observedAtMs:1_200 },
  });
});

void test('recreates a purged report by reusing an exact retained qualification event', async () => {
  const projection = projectionFixture({ observedAtMs: Date.now() });
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) return rows([sourceMappingRow(projection)]);
    if (text.includes('qualification_existing_event')) {
      return rows([qualificationEventRow(projection)]);
    }
    return undefined;
  });
  const repository = new PostgresQualificationProjectionRepository(
    database,
    qualificationService(),
  );

  const outcome = await repository.transact('mint', (transaction) => (
    transaction.replaceProjection(projection)
  ));

  assert.equal(outcome, 'UPDATED');
  assert.equal(database.queries.some((call) => (
    call.text.includes('INSERT INTO domain_events')
  )), false);
  const reportInsert = database.queries.find((call) => (
    call.text.includes('INSERT INTO qualification_reports')
  ));
  assert.ok(reportInsert);
  assert.equal(
    (reportInsert.values?.[20] as Date | undefined)?.getTime(),
    projection.report.evaluatedAtMs + 14_400_000,
  );
});

void test('rejects a never-stored stale projection before writing its event or report', async () => {
  const projection = projectionFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) return rows([sourceMappingRow(projection)]);
    if (text.includes('qualification_write_freshness')) {
      return rows([{ qualification_write_is_fresh: false }]);
    }
    return undefined;
  });
  const repository = new PostgresQualificationProjectionRepository(
    database,
    qualificationService(),
  );

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.replaceProjection(projection)),
    (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionDataError);
      assert.equal(error.message, 'Qualification projection report is already stale.');
      return true;
    },
  );

  const statements = database.queries.map((call) => call.text);
  const freshness = database.queries.find((call) => (
    call.text.includes('qualification_write_freshness')
  ));
  assert.match(freshness?.text ?? '', /clock_timestamp\(\)/u);
  assert.doesNotMatch(freshness?.text ?? '', /transaction_timestamp\(\)/u);
  assert.ok(freshness?.values?.[0] instanceof Date);
  const freshnessIndex = statements.findIndex((sql) => (
    sql.includes('qualification_write_freshness')
  ));
  assert.ok(freshnessIndex > 0);
  assert.equal(statements.some((sql) => sql.includes('UPDATE qualification_reports')), false);
  assert.equal(statements.some((sql) => sql.includes('qualification_existing_event')), false);
  assert.equal(statements.some((sql) => sql.includes('INSERT INTO domain_events')), false);
  assert.equal(statements.some((sql) => sql.includes('INSERT INTO qualification_reports')), false);
  assert.equal(
    statements.slice(0, freshnessIndex).some((sql) => /^\s*(?:INSERT|UPDATE)\b/u.test(sql)),
    false,
  );
});

void test('rolls back with the stable stale error when expiry crosses at event insertion', async () => {
  const projection = projectionFixture({ observedAtMs: Date.now() });
  let freshnessChecks = 0;
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) return rows([sourceMappingRow(projection)]);
    if (text.includes('qualification_write_freshness')) {
      freshnessChecks += 1;
      return rows([{ qualification_write_is_fresh: freshnessChecks === 1 }]);
    }
    if (text.includes('INSERT INTO domain_events')) return { rows: [], rowCount: 0 };
    return undefined;
  });
  const repository = new PostgresQualificationProjectionRepository(
    database,
    qualificationService(),
  );

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.replaceProjection(projection)),
    (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionDataError);
      assert.equal(error.message, 'Qualification projection report is already stale.');
      return true;
    },
  );

  assert.equal(freshnessChecks, 2);
  const eventInsert = database.queries.find((call) => (
    call.text.includes('INSERT INTO domain_events')
  ))?.text ?? '';
  assert.match(eventInsert, /SELECT[\s\S]*WHERE \$18::timestamptz > clock_timestamp\(\)/u);
  assert.equal(database.queries.some((call) => (
    call.text.includes('INSERT INTO qualification_reports')
  )), false);
});

void test('rolls back with the stable stale error when expiry crosses at report insertion', async () => {
  const projection = projectionFixture({ observedAtMs: Date.now() });
  let freshnessChecks = 0;
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) return rows([sourceMappingRow(projection)]);
    if (text.includes('qualification_write_freshness')) {
      freshnessChecks += 1;
      return rows([{ qualification_write_is_fresh: freshnessChecks === 1 }]);
    }
    if (text.includes('qualification_existing_event')) {
      return rows([qualificationEventRow(projection)]);
    }
    if (text.includes('INSERT INTO qualification_reports')) return { rows: [], rowCount: 0 };
    return undefined;
  });
  const repository = new PostgresQualificationProjectionRepository(
    database,
    qualificationService(),
  );

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.replaceProjection(projection)),
    (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionDataError);
      assert.equal(error.message, 'Qualification projection report is already stale.');
      return true;
    },
  );

  assert.equal(freshnessChecks, 2);
  const reportInsert = database.queries.find((call) => (
    call.text.includes('INSERT INTO qualification_reports')
  ))?.text ?? '';
  assert.match(reportInsert, /SELECT[\s\S]*WHERE \$21::timestamptz > clock_timestamp\(\)/u);
});

void test('rolls back when expiry crosses during a successful report insertion', async () => {
  const projection = projectionFixture({ observedAtMs: Date.now() });
  let freshnessChecks = 0;
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) return rows([sourceMappingRow(projection)]);
    if (text.includes('qualification_write_freshness')) {
      freshnessChecks += 1;
      return rows([{ qualification_write_is_fresh: freshnessChecks === 1 }]);
    }
    if (text.includes('qualification_existing_event')) {
      return rows([qualificationEventRow(projection)]);
    }
    return undefined;
  });
  const repository = new PostgresQualificationProjectionRepository(
    database,
    qualificationService(),
  );

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.replaceProjection(projection)),
    (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionDataError);
      assert.equal(error.message, 'Qualification projection report is already stale.');
      return true;
    },
  );

  assert.equal(freshnessChecks, 2);
  assert.equal(database.queries.some((call) => (
    call.text.includes('INSERT INTO qualification_reports')
  )), true);
});

void test('rejects a conflicting retained qualification event before report insert', async () => {
  const projection = projectionFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) return rows([sourceMappingRow(projection)]);
    if (text.includes('qualification_existing_event')) {
      return rows([{
        ...qualificationEventRow(projection),
        payload: toJsonValue({ conflict: true }),
      }]);
    }
    return undefined;
  });
  const repository = new PostgresQualificationProjectionRepository(
    database,
    qualificationService(),
  );

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.replaceProjection(projection)),
    QualificationProjectionDataError,
  );
  assert.equal(database.queries.some((call) => (
    call.text.includes('INSERT INTO qualification_reports')
  )), false);
});

void test('fails closed on an exact expired report without extending its freshness', async () => {
  const projection = projectionFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) return rows([sourceMappingRow(projection)]);
    if (text.includes('qualification_expired_report')) {
      return rows([{ report_id: projection.reportId }]);
    }
    return undefined;
  });
  const repository = new PostgresQualificationProjectionRepository(
    database,
    qualificationService(),
  );

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.replaceProjection(projection)),
    (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionDataError);
      assert.equal(error.message, 'Stored qualification projection report has expired.');
      return true;
    },
  );
  const statements = database.queries.map((call) => call.text);
  const historicalSql = statements.find((sql) => (
    sql.includes('qualification_historical_report')
  )) ?? '';
  const expiredSql = statements.find((sql) => sql.includes('qualification_expired_report')) ?? '';
  assert.match(historicalSql, /purge_after > clock_timestamp\(\)/u);
  assert.match(expiredSql, /purge_after <= clock_timestamp\(\)/u);
  assert.equal(statements.some((sql) => sql.includes('SET superseded_at=NULL')), false);
  assert.equal(statements.some((sql) => sql.includes('INSERT INTO qualification_reports')), false);
});

void test('reactivates an exact historical report after superseding current without cursor veto', async () => {
  const projection = projectionFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) return rows([sourceMappingRow(projection)]);
    if (text.includes('qualification_current_report')) return rows([{ report_id: 'other' }]);
    if (text.includes('qualification_historical_report')) {
      return rows([{ report_id: projection.reportId }]);
    }
    if (text.includes('qualification_stored_report')) {
      return rows([storedProjectionRow(projection)]);
    }
    if (text.includes('SET superseded_at=NULL')) return { rows: [], rowCount: 1 };
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(
    database,
    qualificationService(),
  );

  const outcome = await repository.transact('mint', (transaction) => (
    transaction.replaceProjection(projection)
  ));

  assert.equal(outcome, 'UPDATED');
  const statements = database.queries.map((call) => call.text);
  const supersede = statements.findIndex((sql) => sql.includes('SET superseded_at=GREATEST'));
  const reactivate = statements.findIndex((sql) => sql.includes('SET superseded_at=NULL'));
  assert.ok(supersede > 0);
  assert.ok(reactivate > supersede);
  assert.match(statements[reactivate] ?? '', /purge_after > clock_timestamp\(\)/u);
  assert.equal(statements.some((sql) => sql.includes('INSERT INTO domain_events')), false);
  assert.equal(statements.some((sql) => /as_of_slot.*>/u.test(sql)), false);
});

void test('changes the evidence fingerprint when metadata evidence changes', () => {
  const withoutMetadata = projectionFixture();
  const withMetadata = projectionFixture({ descriptionAvailable: true });

  assert.notEqual(withMetadata.evidenceFingerprint, withoutMetadata.evidenceFingerprint);
  assert.notEqual(withMetadata.reportId, withoutMetadata.reportId);
});

void test('live PostgreSQL keeps one current report across replay, revisions, fallback and concurrency', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live qualification projection test skipped');
    return;
  }
  const schema = `qualification_projection_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    const observedAtMs = Date.now();
    await insertLiveLaunch(pool, observedAtMs);
    const service = qualificationService();
    const repository = new PostgresQualificationProjectionRepository(pool, service);
    const confirmed = projectionFixture({ observedAtMs });
    const api = new PostgresApiProjectionRepository(
      pool, () => new Date(), undefined, confirmed.report.ruleSet,
    );

    const creationOutcomes = await Promise.all([
      repository.transact('mint', (transaction) => transaction.replaceProjection(confirmed)),
      repository.transact('mint', (transaction) => transaction.replaceProjection(confirmed)),
    ]);
    assert.deepEqual([...creationOutcomes].sort(), ['UNCHANGED', 'UPDATED']);
    assert.deepEqual(await liveCounts(pool), ['1', '1', '1', '1']);
    assert.equal((await api.getLaunchRisk('mint'))?.ruleSet.fingerprint, confirmed.report.ruleSet.fingerprint);
    assert.equal(
      await repository.transact('mint', (transaction) => transaction.replaceProjection(confirmed)),
      'UNCHANGED',
    );
    assert.deepEqual(await liveCounts(pool), ['1', '1', '1', '1']);

    await pool.query(`UPDATE raw_chain_events SET confirmation_status='finalized'
      WHERE event_id='raw-source'`);
    await pool.query(`UPDATE domain_events SET confirmation_status='finalized'
      WHERE event_id='source-event'`);
    const finalized = projectionFixture({ confirmationStatus: 'finalized', observedAtMs });
    assert.notEqual(finalized.reportId, confirmed.reportId);
    assert.equal(
      await repository.transact('mint', (transaction) => transaction.replaceProjection(finalized)),
      'UPDATED',
    );
    const evidenceRevision = projectionFixture({
      confirmationStatus: 'finalized',
      observedAtMs,
      descriptionAvailable: true,
    });
    assert.notEqual(evidenceRevision.evidenceFingerprint, finalized.evidenceFingerprint);
    assert.equal(
      await repository.transact(
        'mint',
        (transaction) => transaction.replaceProjection(evidenceRevision),
      ),
      'UPDATED',
    );
    assert.equal(
      (await api.getLaunchRisk('mint'))?.conditions.find((condition) => (
        condition.code === 'METADATA_FETCH_FAILED'
      ))?.status,
      'PASSED',
    );

    await insertLiveTrade(pool, observedAtMs + 1_000);
    const recentSnapshot = await repository.transact(
      'mint',
      (transaction) => transaction.loadCanonicalInput('mint'),
    );
    assert.ok(recentSnapshot);
    assert.equal(recentSnapshot.asOfEvent.id, 'trade-event');
    const recent = canonicalProjectionFromSnapshot(service, recentSnapshot);
    assert.equal(
      await repository.transact('mint', (transaction) => transaction.replaceProjection(recent)),
      'UPDATED',
    );

    await pool.query(`UPDATE raw_chain_events SET confirmation_status='orphaned'
      WHERE event_id='raw-trade'`);
    await pool.query(`UPDATE domain_events SET confirmation_status='orphaned'
      WHERE event_id='trade-event'`);
    const fallbackSnapshot = await repository.transact(
      'mint',
      (transaction) => transaction.loadCanonicalInput('mint'),
    );
    assert.ok(fallbackSnapshot);
    assert.equal(fallbackSnapshot.asOfEvent.id, 'source-event');
    const fallback = canonicalProjectionFromSnapshot(service, fallbackSnapshot);
    assert.equal(fallback.reportId, finalized.reportId);
    assert.equal(
      await repository.transact('mint', (transaction) => transaction.replaceProjection(fallback)),
      'UPDATED',
    );
    assert.deepEqual(await liveCounts(pool), ['4', '1', '4', '4']);
    assert.equal(await liveCurrentReportId(pool), finalized.reportId);

    await pool.query(`UPDATE raw_chain_events SET confirmation_status='orphaned'
      WHERE event_id='raw-source'`);
    await pool.query(`UPDATE domain_events SET confirmation_status='orphaned'
      WHERE event_id='source-event'`);
    const missing = await repository.transact(
      'mint',
      (transaction) => transaction.loadCanonicalInput('mint'),
    );
    assert.equal(missing, null);
    await repository.transact('mint', (transaction) => transaction.dissolveCurrent('mint'));
    assert.deepEqual(await liveCounts(pool), ['4', '0', '4', '4']);
    assert.equal(await api.getLaunchRisk('mint'), null);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

for (const scenario of ['CROSS_MINT_OUTBOX', 'UNCHANGED_SOURCE_REPLAY'] as const) {
for (const policy of [undefined, 'bounded-serialization'] as const) {
  void test(`live PostgreSQL qualification serialization ${scenario} ${policy ?? 'default'}`, { timeout: 30_000 }, async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: serialization reproduction skipped');
      return;
    }
    const schema = `qualification_serialization_${randomUUID().replaceAll('-', '')}`;
    assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const options = `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=5000`;
    const qualificationPool = new pg.Pool({ connectionString: databaseUrl, max: 1, options });
    const writerPool = new pg.Pool({ connectionString: databaseUrl, max: 1, options });
    const ready = serializationGate();
    const resume = serializationGate();
    type Attempt = { ok: true; value: 'UPDATED' | 'UNCHANGED' } | { ok: false; error: unknown };
    let attempt: Promise<Attempt> | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await migrateDatabase({ pool: writerPool });
      const mintA = '11111111111111111111111111111111';
      const mintB = 'So11111111111111111111111111111111111111112';
      const observedAtMs = Date.now();
      const batchA = serializationLaunchBatch(mintA, 'serialization-a', observedAtMs);
      const batchB = serializationLaunchBatch(mintB, 'serialization-b', observedAtMs);
      const writer = new PostgresLaunchpadEventRepository(writerPool);
      assert.deepEqual((await writer.record(batchA)).events.map((event) => event.outcome), ['created']);
      const sourceBefore = await serializationSourceVersions(writerPool, mintA);
      const streamBefore = await serializationStreamState(writerPool);
      const rebuilder = qualificationService();
      const failures: SerializationDriverFailure[] = [];
      const repository = new PostgresQualificationProjectionRepository(
        serializationProbe(qualificationPool, failures), rebuilder,
      );
      let callbacks = 0;
      const rawAttempt = repository.transact(mintA, async (transaction) => {
        callbacks++;
        const snapshot = await transaction.loadCanonicalInput(mintA);
        assert.ok(snapshot);
        if (callbacks === 1) {
          ready.release();
          await resume.promise;
        }
        return transaction.replaceProjection(canonicalProjectionFromSnapshot(rebuilder, snapshot));
      }, policy);
      // Handle rejection immediately, including a failure before reaching the barrier.
      attempt = rawAttempt.then(
        (value): Attempt => ({ ok: true, value }),
        (error: unknown): Attempt => ({ ok: false, error }),
      );
      await Promise.race([
        ready.promise,
        attempt.then((outcome) => {
          if (!outcome.ok) throw outcome.error;
          throw new Error('Qualification completed before the snapshot barrier');
        }),
      ]);
      let committedSource: Awaited<ReturnType<typeof serializationSourceVersions>>;
      let committedStream: Awaited<ReturnType<typeof serializationStreamState>>;
      try {
        if (scenario === 'CROSS_MINT_OUTBOX') {
          assert.deepEqual((await writer.record(batchB)).events.map((event) => event.outcome), ['created']);
          committedSource = await serializationSourceVersions(writerPool, mintB);
          assert.deepEqual(await serializationSourceVersions(writerPool, mintA), sourceBefore);
          committedStream = await serializationStreamState(writerPool);
          assert.ok(BigInt(committedStream.last_sequence) > BigInt(streamBefore.last_sequence));
          assert.notEqual(committedStream.state_xmin, streamBefore.state_xmin);
        } else {
          assert.deepEqual((await writer.record(batchA)).events.map((event) => event.outcome), ['duplicate']);
          committedSource = await serializationSourceVersions(writerPool, mintA);
          assert.notEqual(committedSource.domain_xmin, sourceBefore.domain_xmin);
          assert.deepEqual({ ...committedSource, domain_xmin: sourceBefore.domain_xmin }, sourceBefore);
          committedStream = await serializationStreamState(writerPool);
          assert.deepEqual(committedStream, streamBefore);
        }
      } finally { resume.release(); }

      const outcome = await attempt;
      if (policy === undefined) {
        assert.equal(outcome.ok, false, 'Counterexample: expected serialization rejection did not occur');
        if (outcome.ok) throw new Error('Unexpected successful qualification transaction');
        assert.ok(outcome.error instanceof QualificationProjectionRepositoryError);
        assert.equal(trustedTerminalAttribution(outcome.error)?.diagnosticCode,
          'QUALIFICATION_POSTGRES_SERIALIZATION');
      } else {
        assert.deepEqual(outcome, { ok: true, value: 'UPDATED' });
      }
      assert.equal(callbacks, policy === undefined ? 1 : 2);
      assert.deepEqual(failures, [{
        operation: scenario === 'CROSS_MINT_OUTBOX' ? 'DOMAIN_EVENT_INSERT' : 'SOURCE_MAPPING',
        sqlstate: '40001',
      }]);
      if (policy === undefined) {
        assert.deepEqual(await liveCounts(writerPool), ['0', '0', '0', '0']);
        assert.deepEqual(await serializationStreamState(writerPool), committedStream);
      } else {
        assert.deepEqual(await liveCounts(writerPool), ['1', '1', '1', '1']);
      }
      assert.deepEqual(await serializationSourceVersions(writerPool,
        scenario === 'CROSS_MINT_OUTBOX' ? mintB : mintA), committedSource);
      const committedEvent = await writerPool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM api_event_stream WHERE domain_event_id=$1',
        [committedSource.event_id],
      );
      assert.equal(committedEvent.rows[0]?.count, '1');
      await assertSerializationMintUnlocked(writerPool, mintA);

      // Re-read all evidence in each fresh transaction; never reuse failed snapshot/projection.
      const rebuildFresh = () => repository.transact(mintA, async (transaction) => {
        const snapshot = await transaction.loadCanonicalInput(mintA);
        assert.ok(snapshot);
        const projection = canonicalProjectionFromSnapshot(rebuilder, snapshot);
        const kind = await transaction.replaceProjection(projection);
        return { kind, reportId: projection.reportId, eventId: projection.qualificationEvent.id };
      });
      const rebuilt = await rebuildFresh();
      assert.equal(rebuilt.kind, policy === undefined ? 'UPDATED' : 'UNCHANGED');
      const afterRebuild = await serializationStreamState(writerPool);
      assert.deepEqual(await liveCounts(writerPool), ['1', '1', '1', '1']);
      const replayed = await rebuildFresh();
      assert.deepEqual(replayed, { ...rebuilt, kind: 'UNCHANGED' });
      assert.deepEqual(await liveCounts(writerPool), ['1', '1', '1', '1']);
      assert.deepEqual(await serializationStreamState(writerPool), afterRebuild);
      const linked = await writerPool.query<{ count: string }>(`SELECT COUNT(*)::text AS count
        FROM qualification_reports report
        JOIN domain_events event ON event.event_id=report.qualification_event_id
        JOIN api_event_stream stream ON stream.domain_event_id=event.event_id
        WHERE report.report_id=$1 AND event.event_id=$2 AND report.mint=$3
          AND report.superseded_at IS NULL AND report.confirmation_status='confirmed'
          AND event.confirmation_status='confirmed' AND stream.confirmation_status='confirmed'`,
      [rebuilt.reportId, rebuilt.eventId, mintA]);
      assert.equal(linked.rows[0]?.count, '1');
      assert.equal(failures.length, 1);
      await assertSerializationMintUnlocked(writerPool, mintA);
    } finally {
      // Release the application barrier before draining sessions or dropping the schema.
      resume.release();
      try {
        if (attempt !== undefined) await attempt;
      } finally {
        const drained = await Promise.allSettled([qualificationPool.end(), writerPool.end()]);
        try {
          // If a pool cannot drain, retain its isolated schema for investigation.
          assert.ok(drained.every((result) => result.status === 'fulfilled'), 'Workload pools did not drain');
          await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
        } finally { await admin.end(); }
      }
    }
  });
}
}

void test('live PostgreSQL derives creatorHasSold from an active creator SELL trade', async (context) => {
  await withLiveCreatorTradeSchema(context, async (pool, repository) => {
    await insertLiveCreatorTrade(pool, { id: 'creator-buy', kind: 'BUY', trader: 'creator', slot: 11 });
    await insertLiveCreatorTrade(pool, { id: 'creator-sell', kind: 'SELL', trader: 'creator', slot: 12 });

    const snapshot = await repository.transact('mint', (transaction) => (
      transaction.loadCanonicalInput('mint')
    ));

    assert.equal(snapshot?.creatorHasSold, true);
  });
});

void test('live PostgreSQL keeps creatorHasSold false without a creator SELL trade', async (context) => {
  await withLiveCreatorTradeSchema(context, async (pool, repository) => {
    await insertLiveCreatorTrade(pool, { id: 'creator-buy', kind: 'BUY', trader: 'creator', slot: 11 });
    await insertLiveCreatorTrade(pool, { id: 'other-sell', kind: 'SELL', trader: 'other', slot: 12 });

    const snapshot = await repository.transact('mint', (transaction) => (
      transaction.loadCanonicalInput('mint')
    ));

    assert.equal(snapshot?.creatorHasSold, false);
  });
});

for (const orphaned of ['domain', 'raw'] as const) {
  void test(`live PostgreSQL ignores a creator SELL whose ${orphaned} row is orphaned`, async (context) => {
    await withLiveCreatorTradeSchema(context, async (pool, repository) => {
      await insertLiveCreatorTrade(pool, {
        id: 'creator-sell', kind: 'SELL', trader: 'creator', slot: 11, orphaned,
      });

      const snapshot = await repository.transact('mint', (transaction) => (
        transaction.loadCanonicalInput('mint')
      ));

      assert.ok(snapshot);
      assert.equal(snapshot.creatorHasSold, false);
    });
  });
}

void test('live PostgreSQL ignores historical social and creator rows', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live qualification historical dossier test skipped');
    return;
  }
  const schema = `qualification_dossier_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    const observedAtMs = Date.now();
    await insertLiveLaunch(pool, observedAtMs);
    const repository = new PostgresQualificationProjectionRepository(pool, validator());
    const oversized = 'x'.repeat(1_048_577);
    await pool.query(`INSERT INTO domain_events (
      event_id,raw_event_id,type,mint,source,program,signature,slot,
      transaction_index,instruction_index,inner_instruction_index,
      confirmation_status,blockchain_time,observed_at,payload_version,payload
    ) VALUES (
      'social-oversized-event','raw-source','SocialEvidenceCollected','mint','pumpfun',
      'pump-program','signature',10,0,1,NULL,'confirmed',$1,$2,1,$3
    )`, [new Date(observedAtMs - 100), new Date(observedAtMs), {
      inputFingerprint: 'b'.repeat(64), padding: oversized,
    }]);
    const participantFingerprint = 'd'.repeat(64);
    await pool.query(`INSERT INTO domain_events (
      event_id,raw_event_id,type,mint,source,program,signature,slot,
      transaction_index,instruction_index,inner_instruction_index,
      confirmation_status,blockchain_time,observed_at,payload_version,payload
    ) VALUES (
      'creator-oversized-event','raw-source','CreatorProfileUpdated','mint','pumpfun',
      'pump-program','signature',10,0,1,NULL,'confirmed',$1,$2,1,$3
    )`, [new Date(observedAtMs - 100), new Date(observedAtMs), {
      inputFingerprint: participantFingerprint, padding: oversized,
    }]);
    await pool.query(`INSERT INTO creator_profiles (
      mint,creator,payload_version,input_fingerprint,profile_event_id,
      as_of_slot,as_of_transaction_index,as_of_instruction_index,
      as_of_inner_instruction_index,confirmation_status,total_bought_base_raw,
      total_sold_base_raw,observed_net_base_raw,has_sold,payload,observed_at,purge_after
    ) VALUES ('mint','creator',1,$1,'creator-oversized-event',10,0,1,NULL,
      'confirmed',0,1,0,TRUE,$2,$3,NULL)`, [
      participantFingerprint, { padding: oversized }, new Date(observedAtMs),
    ]);

    const snapshot = await repository.transact('mint', (transaction) => (
      transaction.loadCanonicalInput('mint')
    ));
    assert.ok(snapshot);
    assert.equal(snapshot.metadata, null);
    assert.equal(snapshot.creatorHasSold, false);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('live PostgreSQL excludes expired reports and never extends deterministic freshness', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live qualification expiry test skipped');
    return;
  }
  const schema = `qualification_expiry_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    const observedAtMs = Date.now();
    await insertLiveLaunch(pool, observedAtMs);
    const service = qualificationService();
    const repository = new PostgresQualificationProjectionRepository(pool, service);
    const original = projectionFixture({ observedAtMs });
    await repository.transact('mint', (transaction) => transaction.replaceProjection(original));
    await pool.query(`WITH retained_clock AS (
      SELECT clock_timestamp()-INTERVAL '5 hours' AS evaluated_at
    )
    UPDATE qualification_reports
      SET evaluated_at=retained_clock.evaluated_at,
          purge_after=retained_clock.evaluated_at+INTERVAL '4 hours'
      FROM retained_clock
      WHERE report_id=$1`, [original.reportId]);
    const before = await pool.query<{ readonly purge_after: Date }>(
      'SELECT purge_after FROM qualification_reports WHERE report_id=$1',
      [original.reportId],
    );

    await assert.rejects(
      repository.transact('mint', (transaction) => transaction.replaceProjection(original)),
      (error: unknown) => {
        assert.ok(error instanceof QualificationProjectionDataError);
        assert.equal(error.message, 'Stored qualification projection report has expired.');
        return true;
      },
    );
    const after = await pool.query<{ readonly purge_after: Date; readonly superseded_at: Date | null }>(
      'SELECT purge_after,superseded_at FROM qualification_reports WHERE report_id=$1',
      [original.reportId],
    );
    assert.equal(after.rows[0]?.purge_after.getTime(), before.rows[0]?.purge_after.getTime());
    assert.equal(after.rows[0]?.superseded_at, null);

    const fresh = projectionFixture({ observedAtMs, descriptionAvailable: true });
    assert.notEqual(fresh.reportId, original.reportId);
    const outcomes = await Promise.all([
      repository.transact('mint', (transaction) => transaction.replaceProjection(fresh)),
      repository.transact('mint', (transaction) => transaction.replaceProjection(fresh)),
    ]);
    assert.deepEqual([...outcomes].sort(), ['UNCHANGED', 'UPDATED']);
    const current = await pool.query<{ readonly report_id: string }>(`SELECT report_id
      FROM qualification_reports
      WHERE superseded_at IS NULL AND purge_after > clock_timestamp()`);
    assert.deepEqual(current.rows.map((row) => row.report_id), [fresh.reportId]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('live PostgreSQL rejects a never-stored stale projection before any derived write', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live stale qualification write test skipped');
    return;
  }
  const schema = `qualification_stale_write_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    const observedAtMs = Date.now() - 5 * 60 * 60 * 1_000;
    await insertLiveLaunch(pool, observedAtMs);
    const projection = projectionFixture({ observedAtMs });
    const repository = new PostgresQualificationProjectionRepository(
      pool,
      qualificationService(),
    );

    await assert.rejects(
      repository.transact('mint', (transaction) => transaction.replaceProjection(projection)),
      (error: unknown) => {
        assert.ok(error instanceof QualificationProjectionDataError);
        assert.equal(error.message, 'Qualification projection report is already stale.');
        return true;
      },
    );

    const counts = await pool.query<{
      readonly reports: string;
      readonly events: string;
      readonly outbox: string;
    }>(`SELECT
      (SELECT COUNT(*) FROM qualification_reports)::text AS reports,
      (SELECT COUNT(*) FROM domain_events WHERE type='QualificationUpdated')::text AS events,
      (SELECT COUNT(*) FROM api_event_stream
        WHERE event_type='QualificationUpdated')::text AS outbox`);
    assert.deepEqual(counts.rows[0], { reports: '0', events: '0', outbox: '0' });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('live PostgreSQL rolls back when report insertion crosses its expiry', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live qualification boundary test skipped');
    return;
  }
  const schema = `qualification_expiry_boundary_${randomUUID().replaceAll('-', '')}`;
  const applicationName = `qualification_boundary_${randomUUID().replaceAll('-', '')}`;
  const advisoryKey = Number.parseInt(randomUUID().slice(0, 8), 16) & 0x7fffffff;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: applicationName,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  let blocker: pg.PoolClient | undefined;
  let blockerLocked = false;
  let operation: Promise<unknown> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    await pool.query(`CREATE FUNCTION qualification_block_report_insert()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        PERFORM pg_advisory_lock(${advisoryKey});
        PERFORM pg_advisory_unlock(${advisoryKey});
        RETURN NEW;
      END
      $function$`);
    await pool.query(`CREATE TRIGGER qualification_block_report_insert
      BEFORE INSERT ON qualification_reports
      FOR EACH ROW EXECUTE FUNCTION qualification_block_report_insert()`);
    blocker = await pool.connect();
    await blocker.query('SELECT pg_advisory_lock($1)', [advisoryKey]);
    blockerLocked = true;

    const databaseClock = await pool.query<{ readonly now: Date }>(
      'SELECT clock_timestamp() AS now',
    );
    const deadlineMs = (databaseClock.rows[0]?.now.getTime() ?? 0) + 2_500;
    const observedAtMs = deadlineMs - 14_400_000;
    await insertLiveLaunch(pool, observedAtMs);
    const projection = projectionFixture({ observedAtMs });
    const repository = new PostgresQualificationProjectionRepository(
      pool,
      qualificationService(),
    );

    operation = repository.transact(
      'mint',
      (transaction) => transaction.replaceProjection(projection),
    );
    await waitForCondition(async () => {
      const waiting = await admin.query<{ readonly waiting: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE application_name=$1 AND wait_event='advisory'
          AND query ILIKE '%INSERT INTO qualification_reports%'
      ) AS waiting`, [applicationName]);
      return waiting.rows[0]?.waiting === true;
    }, 'qualification report insert did not reach the advisory trigger');
    await waitForCondition(async () => {
      const crossed = await pool.query<{ readonly crossed: boolean }>(
        'SELECT clock_timestamp() >= $1::timestamptz AS crossed',
        [new Date(deadlineMs)],
      );
      return crossed.rows[0]?.crossed === true;
    }, 'database clock did not cross the qualification expiry');

    await blocker.query('SELECT pg_advisory_unlock($1)', [advisoryKey]);
    blockerLocked = false;
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof QualificationProjectionDataError);
      assert.equal(error.message, 'Qualification projection report is already stale.');
      return true;
    });

    const counts = await pool.query<{
      readonly reports: string;
      readonly events: string;
      readonly outbox: string;
    }>(`SELECT
      (SELECT COUNT(*) FROM qualification_reports)::text AS reports,
      (SELECT COUNT(*) FROM domain_events WHERE type='QualificationUpdated')::text AS events,
      (SELECT COUNT(*) FROM api_event_stream
        WHERE event_type='QualificationUpdated')::text AS outbox`);
    assert.deepEqual(counts.rows[0], { reports: '0', events: '0', outbox: '0' });
  } finally {
    if (blockerLocked && blocker !== undefined) {
      await blocker.query('SELECT pg_advisory_unlock($1)', [advisoryKey]);
    }
    await operation?.catch(() => undefined);
    blocker?.release();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

class ScriptedPool {
  public readonly queries: QueryCall[] = [];
  public readonly releaseArguments: (Error | boolean | undefined)[] = [];
  public released = false;

  public constructor(
    private readonly resolve: (text: string, values: readonly unknown[] | undefined) => {
      readonly rows: readonly Record<string, unknown>[];
      readonly rowCount: number | null;
    } | undefined = () => undefined,
    private readonly releaseClient: (error?: Error | boolean) => void = () => undefined,
  ) {}

  public async connect() {
    return {
      query: async (text: string, values?: readonly unknown[]) => {
        this.queries.push({ text, values });
        const resolved = this.resolve(text, values);
        if (
          text.includes('pg_advisory_unlock')
          && resolved?.rows[0] === undefined
        ) return rows([{ pg_advisory_unlock: true }]);
        if (resolved !== undefined) return resolved;
        if (text.includes('qualification_write_freshness')) {
          return rows([{ qualification_write_is_fresh: true }]);
        }
        return /^(?:INSERT|UPDATE)\b/u.test(text.trim())
          ? { rows: [], rowCount: 1 }
          : rows([]);
      },
      release: (error?: Error | boolean) => {
        this.released = true;
        this.releaseArguments.push(error);
        this.releaseClient(error);
      },
    };
  }
}

function validator() {
  return { reauthorize: () => { throw new Error('not used'); } };
}

function rows(values: readonly Record<string, unknown>[]) {
  return { rows: values, rowCount: values.length };
}

function launchRow(mint = 'mint'): Record<string, unknown> {
  return {
    event_id: 'launch-event', raw_event_id: 'raw-launch', type: 'TokenLaunchDetected',
    mint, source: 'pumpfun', program: 'pump-program', signature: 'signature',
    slot: '10', transaction_index: 0, instruction_index: 1,
    inner_instruction_index: null, confirmation_status: 'confirmed',
    blockchain_time: new Date(900), observed_at: new Date(1_000), payload_version: 1,
    payload: {
      launch: {
        mint, creator: 'creator', tokenProgram: 'SPL_TOKEN', quoteAssets: [],
        launchpad: 'pumpfun',
        createdAt: {
          slot: { $solTokenListenerBigInt: '10' }, transactionIndex: 0,
          instructionIndex: 1, innerInstructionIndex: null,
        },
        parameters: {},
      },
    },
    creator: 'creator', token_program: 'SPL_TOKEN', quote_assets: [],
    program_id: 'pump-program',
    launchpad: 'pumpfun', created_slot: '10', created_transaction_index: 0,
    created_instruction_index: 1, created_inner_instruction_index: null,
  };
}

function asOfRow(mint = 'mint'): Record<string, unknown> {
  return { ...launchRow(mint), payload: {} };
}

function metadataFixture() {
  const mint = '11111111111111111111111111111111';
  const metadata = Object.freeze({
    mint,
    uri: 'https://example.test/metadata.json',
    resolution: Object.freeze({
      status: 'RESOLVED' as const,
      metadata: Object.freeze({
        name: 'Token', symbol: 'TOK', description: 'Description',
        imageUrl: 'https://example.test/image.png', videoUrl: null,
        websiteUrl: 'https://example.test', twitterUrl: null, telegramUrl: null,
      }),
    }),
    fetchedAtMs: 1_010,
    payloadVersion: 1,
  });
  const metadataSnapshotId = socialMetadataSnapshotId({
    sourceLaunchEventId: 'launch-event',
    snapshot: metadata,
  });
  return {
    mint, metadata,
    metadataRow: {
      snapshot_id: metadataSnapshotId, mint, uri: metadata.uri,
      resolution_status: 'resolved', failure_reason: null, failure_message: null,
      failure_retryable: null, metadata: metadata.resolution.metadata,
      fetched_at: new Date(metadata.fetchedAtMs), payload_version: 1,
      source_launch_event_id: 'launch-event',
    },
  };
}

function serializationLaunchBatch(
  mint: string,
  signature: string,
  observedAtMs: number,
): LaunchpadEventBatch {
  const transaction = {
    signature,
    confirmationStatus: 'confirmed' as const,
    blockTimeMs: observedAtMs - 100,
    observedAtMs,
    cursor: { slot: 10n, transactionIndex: 0 },
    raw: null,
  };
  const launch = createTokenLaunchDetectedEvent({
    source: 'pumpfun', program: 'pump', transaction,
    launch: {
      mint, creator: 'creator', tokenProgram: 'SPL_TOKEN',
      quoteAssets: [{ mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' }],
      launchpad: 'pumpfun',
      createdAt: { ...transaction.cursor, instructionIndex: 1, innerInstructionIndex: null },
      parameters: {},
    },
  });
  return {
    source: 'pumpfun', program: 'pump', signature,
    confirmationStatus: 'confirmed', stateTransitionAction: 'apply',
    events: [launch], transitions: [createInitialDetectedTransition(launch)],
  };
}

type SerializationQueryLabel = 'SOURCE_MAPPING' | 'DOMAIN_EVENT_INSERT' | 'OTHER';
type SerializationDriverFailure = Readonly<{
  operation: SerializationQueryLabel;
  sqlstate: '40001' | '40P01' | 'OTHER';
}>;

function serializationQueryLabel(sql: string): SerializationQueryLabel {
  if (sql.includes('/* qualification_source_mapping */')) return 'SOURCE_MAPPING';
  if (/^INSERT INTO domain_events\s*\(/u.test(sql.trim())) return 'DOMAIN_EVENT_INSERT';
  return 'OTHER';
}

function serializationProbe(
  pool: pg.Pool,
  failures: SerializationDriverFailure[],
): QualificationProjectionPool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: readonly unknown[]) {
          try {
            return await client.query(sql, values === undefined ? undefined : [...values]);
          } catch (error: unknown) {
            const descriptor = typeof error === 'object' && error !== null
              ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
            const code: unknown = descriptor !== undefined && 'value' in descriptor
              ? descriptor.value : undefined;
            failures.push({
              operation: serializationQueryLabel(sql),
              sqlstate: code === '40001' || code === '40P01' ? code : 'OTHER',
            });
            throw error;
          }
        },
        release(error?: Error | boolean) { client.release(error); },
      };
    },
  };
}

function serializationGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function serializationSourceVersions(pool: pg.Pool, mint: string) {
  const result = await pool.query<{
    event_id: string; raw_event_id: string; domain_xmin: string; raw_xmin: string;
    domain_status: string; raw_status: string;
  }>(`SELECT d.event_id,d.raw_event_id,d.xmin::text AS domain_xmin,
      r.xmin::text AS raw_xmin,d.confirmation_status AS domain_status,
      r.confirmation_status AS raw_status
    FROM domain_events d JOIN raw_chain_events r ON r.event_id=d.raw_event_id
    WHERE d.mint=$1 AND d.type='TokenLaunchDetected'`, [mint]);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

async function serializationStreamState(pool: pg.Pool) {
  const result = await pool.query<{ last_sequence: string; state_xmin: string }>(
    'SELECT last_sequence::text,state.xmin::text AS state_xmin FROM api_event_stream_state state WHERE id=1',
  );
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

async function assertSerializationMintUnlocked(pool: pg.Pool, mint: string) {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('qualification-projection:' || $1,0)) AS acquired",
      [mint],
    );
    locked = result.rows[0]?.acquired === true;
    assert.equal(locked, true);
  } finally {
    try {
      if (locked) {
        const result = await client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended('qualification-projection:' || $1,0)) AS released",
          [mint],
        );
        assert.equal(result.rows[0]?.released, true);
      }
    } finally { client.release(); }
  }
}

function qualificationService(): QualificationRebuildService {
  return new QualificationRebuildService(
    new QualificationEngine(createDefaultQualificationRuleSet(60)),
  );
}

function projectionFixture(options: Readonly<{
  confirmationStatus?: 'confirmed' | 'finalized';
  descriptionAvailable?: boolean;
  observedAtMs?: number;
  withQuoteLineage?: boolean;
}> = {}): CanonicalQualificationProjection {
  const service = qualificationService();
  const confirmationStatus = options.confirmationStatus ?? 'confirmed';
  const observedAtMs = options.observedAtMs ?? 1_000;
  const asOfEvent = Object.freeze({
    id: 'source-event', type: 'TokenLaunchDetected' as const, mint: 'mint',
    source: 'pumpfun', program: 'pump-program', signature: 'signature',
    cursor: Object.freeze({
      slot: 10n, transactionIndex: 0, instructionIndex: 1,
      innerInstructionIndex: null,
    }),
    confirmationStatus,
    blockchainTimeMs: observedAtMs - 100, observedAtMs, payloadVersion: 1,
    payload: Object.freeze({}),
  });
  const buyQuote = options.withQuoteLineage === true
    ? Object.freeze({
      id:'buy-exact', inputMint:'SOL', outputMint:'mint', amountInRaw:1_000n,
      amountOutRaw:900n, minimumAmountOutRaw:900n, feesRaw:1n,
      slippageBps:100n, priceImpactBps:10n, observedAtMs:1_100, observedSlot:11n,
    })
    : undefined;
  const reverseSellQuote = options.withQuoteLineage === true
    ? Object.freeze({
      id:'sell-exact', inputMint:'mint', outputMint:'SOL', amountInRaw:900n,
      amountOutRaw:800n, minimumAmountOutRaw:800n, feesRaw:1n,
      slippageBps:100n, priceImpactBps:10n, observedAtMs:1_200, observedSlot:12n,
    })
    : undefined;
  const rebuilt = service.rebuild({
    snapshot: Object.freeze({
      mint: 'mint', asOfEvent,
      launch: Object.freeze({
        mint: 'mint', creator: 'creator', tokenProgram: 'SPL_TOKEN' as const,
        quoteAssets: Object.freeze([]), launchpad: 'pumpfun',
        createdAt: asOfEvent.cursor, parameters: Object.freeze({}),
      }),
      metadata: options.descriptionAvailable === undefined
        ? null
        : Object.freeze({
          mint: 'mint', uri: 'https://example.test/metadata.json',
          resolution: Object.freeze({
            status: 'RESOLVED' as const,
            metadata: Object.freeze({
              name: null, symbol: null,
              description: options.descriptionAvailable ? 'Description' : null,
              imageUrl: null, videoUrl: null, websiteUrl: null,
              twitterUrl: null, telegramUrl: null,
            }),
          }),
          fetchedAtMs: observedAtMs, payloadVersion: 1,
        }),
      creatorHasSold: false,
    }),
    buyQuote,
    reverseSellQuote,
  });
  return Object.freeze({
    reportId: rebuilt.reportId,
    sourceEventId: asOfEvent.id,
    sourceRawEventId: 'raw-source',
    evidenceFingerprint: rebuilt.evidenceFingerprint,
    evaluation: rebuilt.evaluation,
    report: rebuilt.report,
    qualificationEvent: rebuilt.event,
  });
}

function canonicalProjectionFromSnapshot(
  service: QualificationRebuildService,
  snapshot: QualificationCanonicalSnapshot,
): CanonicalQualificationProjection {
  const rebuilt = service.rebuild({
    snapshot,
    buyQuote: undefined,
    reverseSellQuote: undefined,
  });
  return Object.freeze({
    reportId: rebuilt.reportId,
    sourceEventId: snapshot.asOfEvent.id,
    sourceRawEventId: snapshot.asOfRawEventId,
    evidenceFingerprint: rebuilt.evidenceFingerprint,
    evaluation: rebuilt.evaluation,
    report: rebuilt.report,
    qualificationEvent: rebuilt.event,
  });
}

function sourceMappingRow(projection: CanonicalQualificationProjection): Record<string, unknown> {
  const event = projection.qualificationEvent;
  return {
    event_id: projection.sourceEventId,
    raw_event_id: projection.sourceRawEventId,
    type: 'TokenLaunchDetected',
    mint: event.mint,
    program: event.program,
    signature: event.signature,
    slot: event.cursor.slot.toString(),
    transaction_index: event.cursor.transactionIndex,
    instruction_index: event.cursor.instructionIndex,
    inner_instruction_index: event.cursor.innerInstructionIndex,
    confirmation_status: event.confirmationStatus,
    blockchain_time: event.blockchainTimeMs === null ? null : new Date(event.blockchainTimeMs),
    observed_at: new Date(event.observedAtMs),
    payload_version: 1,
    payload: {},
  };
}

function qualificationEventRow(
  projection: CanonicalQualificationProjection,
): Record<string, unknown> {
  const event = projection.qualificationEvent;
  return {
    event_id: event.id,
    raw_event_id: projection.sourceRawEventId,
    type: event.type,
    mint: event.mint,
    source: event.source,
    program: event.program,
    signature: event.signature,
    slot: event.cursor.slot.toString(),
    transaction_index: event.cursor.transactionIndex,
    instruction_index: event.cursor.instructionIndex,
    inner_instruction_index: event.cursor.innerInstructionIndex,
    confirmation_status: event.confirmationStatus,
    blockchain_time: event.blockchainTimeMs === null ? null : new Date(event.blockchainTimeMs),
    observed_at: new Date(event.observedAtMs),
    payload_version: event.payloadVersion,
    payload: toJsonValue(event.payload),
  };
}

function storedProjectionRow(
  projection: CanonicalQualificationProjection,
): Record<string, unknown> {
  const event = projection.qualificationEvent;
  const report = projection.report;
  return {
    report_id: projection.reportId,
    mint: event.mint,
    source_event_id: projection.sourceEventId,
    source_raw_event_id: projection.sourceRawEventId,
    qualification_event_id: event.id,
    profile_id: report.ruleSet.id,
    profile_version: report.ruleSet.version,
    profile_fingerprint: report.ruleSet.fingerprint,
    evidence_fingerprint: projection.evidenceFingerprint,
    verdict: report.verdict,
    preparation_score: report.scores.preparation.score,
    social_score: report.scores.socialAuthenticity.score,
    onchain_score: report.scores.onchainHealth.score,
    total_score: report.scores.total.score,
    as_of_slot: event.cursor.slot.toString(),
    as_of_transaction_index: event.cursor.transactionIndex,
    as_of_instruction_index: event.cursor.instructionIndex,
    as_of_inner_instruction_index: event.cursor.innerInstructionIndex,
    confirmation_status: event.confirmationStatus,
    evaluated_at: new Date(report.evaluatedAtMs),
    purge_after: new Date(report.evaluatedAtMs + 14_400_000),
    payload_version: 1,
    payload: toJsonValue(report),
    event_type: event.type,
    event_mint: event.mint,
    event_raw_event_id: projection.sourceRawEventId,
    event_source: event.source,
    event_program: event.program,
    event_signature: event.signature,
    event_slot: event.cursor.slot.toString(),
    event_transaction_index: event.cursor.transactionIndex,
    event_instruction_index: event.cursor.instructionIndex,
    event_inner_instruction_index: event.cursor.innerInstructionIndex,
    event_confirmation_status: event.confirmationStatus,
    event_blockchain_time: event.blockchainTimeMs === null
      ? null
      : new Date(event.blockchainTimeMs),
    event_observed_at: new Date(event.observedAtMs),
    event_payload_version: event.payloadVersion,
    event_payload: toJsonValue(event.payload),
  };
}

async function insertLiveLaunch(
  pool: InstanceType<typeof pg.Pool>,
  observedAtMs = 1_000,
): Promise<void> {
  const launch = {
    mint: 'mint', creator: 'creator', tokenProgram: 'SPL_TOKEN', quoteAssets: [],
    launchpad: 'pumpfun',
    createdAt: {
      slot: 10n, transactionIndex: 0, instructionIndex: 1,
      innerInstructionIndex: null,
    },
    parameters: {},
  };
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    inner_instruction_index,confirmation_status,blockchain_time,observed_at,
    payload_version,payload,processing_status
  ) VALUES (
    'raw-source','pumpfun','pump-program','mint','signature',10,0,1,NULL,
    'confirmed',$1,$2,1,'{}'::jsonb,'processed'
  )`, [new Date(observedAtMs - 100), new Date(observedAtMs)]);
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,
    transaction_index,instruction_index,inner_instruction_index,
    confirmation_status,blockchain_time,observed_at,payload_version,payload
  ) VALUES (
    'source-event','raw-source','TokenLaunchDetected','mint','pumpfun',
    'pump-program','signature',10,0,1,NULL,'confirmed',$1,$2,1,$3
  )`, [new Date(observedAtMs - 100), new Date(observedAtMs), toJsonValue({ launch })]);
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
    created_signature,created_slot,created_transaction_index,
    created_instruction_index,created_inner_instruction_index,detected_at,updated_at
  ) VALUES (
    'mint','pumpfun','pump-program','creator','SPL_TOKEN','[]'::jsonb,'DETECTED',
    'signature',10,0,1,NULL,$1,$1
  )`, [new Date(observedAtMs)]);
}

async function insertLiveTrade(
  pool: InstanceType<typeof pg.Pool>,
  observedAtMs = 2_000,
): Promise<void> {
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    inner_instruction_index,confirmation_status,blockchain_time,observed_at,
    payload_version,payload,processing_status
  ) VALUES (
    'raw-trade','pumpfun','pump-program','mint','trade-signature',11,0,2,NULL,
    'finalized',$1,$2,1,'{}'::jsonb,'processed'
  )`, [new Date(observedAtMs - 100), new Date(observedAtMs)]);
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,
    transaction_index,instruction_index,inner_instruction_index,
    confirmation_status,blockchain_time,observed_at,payload_version,payload
  ) VALUES (
    'trade-event','raw-trade','BondingCurveTradeObserved','mint','pumpfun',
    'pump-program','trade-signature',11,0,2,NULL,'finalized',$1,$2,1,'{}'::jsonb
  )`, [new Date(observedAtMs - 100), new Date(observedAtMs)]);
}

async function withLiveCreatorTradeSchema(
  context: TestContext,
  run: (
    pool: InstanceType<typeof pg.Pool>,
    repository: PostgresQualificationProjectionRepository,
  ) => Promise<void>,
): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live creator trade test skipped');
    return;
  }
  const schema = `qualification_creator_trade_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    await insertLiveLaunch(pool);
    await run(pool, new PostgresQualificationProjectionRepository(pool, qualificationService()));
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function insertLiveCreatorTrade(
  pool: InstanceType<typeof pg.Pool>,
  trade: Readonly<{
    id: string;
    kind: 'BUY' | 'SELL';
    trader: string;
    slot: number;
    orphaned?: 'domain' | 'raw';
  }>,
): Promise<void> {
  const signature = `${trade.id}-signature`;
  const cursor = {
    slot: BigInt(trade.slot), transactionIndex: 0, instructionIndex: 2,
    innerInstructionIndex: null,
  };
  const payload = toJsonValue({
    trade: {
      id: trade.id, launchMint: 'mint', kind: trade.kind, trader: trade.trader,
      baseAmountRaw: 1_000n, quoteAmountRaw: 100n,
      quoteAsset: { mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' },
      cursor,
    },
  });
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    inner_instruction_index,confirmation_status,blockchain_time,observed_at,
    payload_version,payload,processing_status
  ) VALUES (
    $1,'pumpfun','pump-program','mint',$2,$3,0,2,NULL,$4,$5,$6,1,'{}'::jsonb,'processed'
  )`, [
    `raw-${trade.id}`, signature, trade.slot,
    trade.orphaned === 'raw' ? 'orphaned' : 'confirmed', new Date(1_900), new Date(2_000),
  ]);
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,
    transaction_index,instruction_index,inner_instruction_index,
    confirmation_status,blockchain_time,observed_at,payload_version,payload
  ) VALUES (
    $1,$2,'BondingCurveTradeObserved','mint','pumpfun','pump-program',$3,$4,0,2,NULL,
    $5,$6,$7,1,$8
  )`, [
    `event-${trade.id}`, `raw-${trade.id}`, signature, trade.slot,
    trade.orphaned === 'domain' ? 'orphaned' : 'confirmed',
    new Date(1_900), new Date(2_000), payload,
  ]);
}

async function liveCounts(
  pool: InstanceType<typeof pg.Pool>,
): Promise<readonly string[]> {
  const result = await pool.query<{
    readonly reports: string;
    readonly current_reports: string;
    readonly events: string;
    readonly outbox: string;
  }>(`SELECT
    (SELECT COUNT(*) FROM qualification_reports)::text AS reports,
    (SELECT COUNT(*) FROM qualification_reports WHERE superseded_at IS NULL)::text
      AS current_reports,
    (SELECT COUNT(*) FROM domain_events WHERE type='QualificationUpdated')::text AS events,
    (SELECT COUNT(*) FROM api_event_stream WHERE event_type='QualificationUpdated')::text
      AS outbox`);
  const row = result.rows[0];
  return [
    row?.reports ?? '-1',
    row?.current_reports ?? '-1',
    row?.events ?? '-1',
    row?.outbox ?? '-1',
  ];
}

async function liveCurrentReportId(pool: InstanceType<typeof pg.Pool>): Promise<string> {
  const row = (await pool.query<{ report_id: string }>(
    'SELECT report_id FROM qualification_reports WHERE superseded_at IS NULL',
  )).rows[0];
  assert.ok(row);
  return row.report_id;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) throw new Error('Unsafe SQL identifier.');
  return `"${identifier}"`;
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  failureMessage: string,
): Promise<void> {
  const timeoutAt = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() >= timeoutAt) throw new Error(failureMessage);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

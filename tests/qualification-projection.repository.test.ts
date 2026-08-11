import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { QualificationRebuildService } from '../src/application/qualification-rebuild.service.js';
import type {
  CanonicalQualificationProjection,
  QualificationCanonicalSnapshot,
} from '../src/ports/qualification-projection-repository.js';
import {
  QualificationEngine,
  createDefaultQualificationRuleSet,
} from '../src/qualification/qualification-engine.js';
import {
  createWalletClusterId,
  createWalletRelationshipId,
} from '../src/domain/wallet-graph.js';
import {
  createSocialCollection,
  socialHttpObservationId,
  socialLinkId,
  socialMetadataSnapshotId,
  socialVerificationEvidenceId,
} from '../src/domain/social-evidence.js';
import { toJsonValue } from '../src/utils/json.js';
import { migrateDatabase } from '../src/storage/database.js';
import {
  PostgresQualificationProjectionRepository,
  QualificationProjectionDataError,
  QualificationProjectionRepositoryError,
} from '../src/storage/qualification-projection.repository.js';

const SOCIAL_LINK_ROW_MAXIMUM = 3;
const SOCIAL_OBSERVATION_ROW_MAXIMUM = 3;
const SOCIAL_EVIDENCE_ROW_MAXIMUM = 64;
const WALLET_RELATIONSHIP_ROW_MAXIMUM = 1_000;
const WALLET_CLUSTER_ROW_MAXIMUM = 256;
const WALLET_MEMBER_ROW_MAXIMUM = 1_024;
const WALLET_MEMBERS_PER_CLUSTER_MAXIMUM = 256;
const WALLET_FUNDING_EVIDENCE_ROW_MAXIMUM = 4_096;

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
  assert.equal(snapshot.social, null);
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

void test('reconstructs metadata and social evidence only through the active launch collection', async () => {
  const evidence = socialFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow(evidence.mint)]);
    if (text.includes('qualification_as_of')) return rows([asOfRow(evidence.mint)]);
    if (text.includes('qualification_social */')) return rows([evidence.collectionRow]);
    if (text.includes('qualification_social_links')) return rows([evidence.linkRow]);
    if (text.includes('qualification_social_observations')) return rows([evidence.observationRow]);
    if (text.includes('qualification_social_verification')) return rows([evidence.evidenceRow]);
    if (text.includes('qualification_metadata_collection')) return rows([evidence.metadataRow]);
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  const snapshot = await repository.transact(evidence.mint, (transaction) => (
    transaction.loadCanonicalInput(evidence.mint)
  ));

  assert.deepEqual(snapshot?.metadata, evidence.metadata);
  assert.deepEqual(snapshot?.social, evidence.collection);
  assert.equal(Object.isFrozen(snapshot?.social?.links), true);
  const socialSql = database.queries.find((call) =>
    call.text.includes('qualification_social */'))?.text ?? '';
  assert.match(socialSql, /launch_event\.event_id=collection\.source_launch_event_id/u);
  assert.match(socialSql, /social_event\.type='SocialEvidenceCollected'/u);
  assert.match(socialSql, /social_event\.confirmation_status=collection\.confirmation_status/u);
  assert.match(socialSql, /collection\.confirmation_status=launch_event\.confirmation_status/u);
  assert.match(socialSql, /social_event\.payload_version AS social_event_payload_version/u);
  assert.match(socialSql, /END AS social_event_payload/u);
  const metadataSql = database.queries.find((call) =>
    call.text.includes('qualification_metadata_collection'))?.text ?? '';
  assert.match(metadataSql, /snapshot_id=\$1/u);
  assert.doesNotMatch(metadataSql, /ORDER BY fetched_at/u);
});

void test('rejects a social event summary that differs from the reconstructed collection', async () => {
  const evidence = socialFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow(evidence.mint)]);
    if (text.includes('qualification_as_of')) return rows([asOfRow(evidence.mint)]);
    if (text.includes('qualification_social */')) {
      return rows([{
        ...evidence.collectionRow,
        social_event_payload: toJsonValue({
          ...(evidence.collectionRow.social_event_payload as Record<string, unknown>),
          evidenceCount: 2,
        }),
      }]);
    }
    if (text.includes('qualification_social_links')) return rows([evidence.linkRow]);
    if (text.includes('qualification_social_observations')) return rows([evidence.observationRow]);
    if (text.includes('qualification_social_verification')) return rows([evidence.evidenceRow]);
    if (text.includes('qualification_metadata_collection')) return rows([evidence.metadataRow]);
    return undefined;
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact(evidence.mint, (transaction) => (
      transaction.loadCanonicalInput(evidence.mint)
    )),
    QualificationProjectionDataError,
  );
});

void test('surfaces an oversized active social event and fails before loading child evidence', async () => {
  const evidence = socialFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow(evidence.mint)]);
    if (text.includes('qualification_as_of')) return rows([asOfRow(evidence.mint)]);
    if (text.includes('qualification_social')) {
      return rows([{
        ...evidence.collectionRow,
        social_event_payload_bytes: 1_048_577,
        social_event_payload: null,
      }]);
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

  const socialSql = database.queries.find((call) => (
    call.text.includes('qualification_social')
  ))?.text ?? '';
  assert.match(socialSql, /octet_length\(social_event\.payload::text\).*social_event_payload_bytes/u);
  assert.match(socialSql, /CASE[\s\S]*octet_length\(social_event\.payload::text\)[\s\S]*social_event\.payload/u);
  assert.doesNotMatch(socialSql, /WHERE[\s\S]*octet_length\(social_event\.payload::text\)\s*<=/u);
  assert.equal(database.queries.some((call) => call.text.includes('qualification_social_links')), false);
});

void test('loads participant and complete current wallet graph only through active derived events', async () => {
  const evidence = analyticsFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow()]);
    if (text.includes('qualification_as_of')) return rows([asOfRow()]);
    if (text.includes('qualification_creator')) return rows([evidence.profileRow]);
    if (text.includes('qualification_holders')) return rows([evidence.holderRow]);
    if (text.includes('qualification_graph */')) return rows([evidence.graphRow]);
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  const snapshot = await repository.transact('mint', (transaction) => (
    transaction.loadCanonicalInput('mint')
  ));

  assert.equal(snapshot?.creatorProfile?.totalBoughtBaseRaw, 2n);
  assert.equal(snapshot?.holderSnapshot?.top10Bps, 5_000n);
  assert.deepEqual(snapshot?.walletGraph, evidence.graph);
  const graphSql = database.queries.find((call) =>
    call.text.includes('qualification_graph */'))?.text ?? '';
  assert.match(graphSql, /event\.type='WalletClusterDetected'/u);
  assert.match(graphSql, /JOIN raw_chain_events AS raw/u);
  assert.match(graphSql, /raw\.confirmation_status=event\.confirmation_status/u);
  assert.match(graphSql, /event\.confirmation_status=graph\.confirmation_status/u);
  assert.match(graphSql, /event\.payload_version AS graph_event_payload_version/u);
  assert.match(graphSql, /event\.payload AS graph_event_payload/u);
  assert.match(graphSql, /snapshot\.input_fingerprint=graph\.input_fingerprint/u);
  assert.match(graphSql, /snapshot\.graph_event_id=graph\.graph_event_id/u);
  const holderSql = database.queries.find((call) => (
    call.text.includes('qualification_holders')
  ))?.text ?? '';
  assert.doesNotMatch(holderSql, /holder\.payload(?:,|\s)/u);
  assert.match(holderSql, /octet_length\(event\.payload::text\) <= \$3/u);
});

void test('surfaces an oversized active creator profile before holder matching', async () => {
  const evidence = analyticsFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow()]);
    if (text.includes('qualification_as_of')) return rows([asOfRow()]);
    if (text.includes('qualification_creator')) {
      return rows([{
        ...evidence.profileRow,
        profile_payload_bytes: 1_048_577,
        profile_event_payload_bytes: 1_048_577,
        profile_payload: null,
        profile_event_payload: null,
      }]);
    }
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.loadCanonicalInput('mint')),
    QualificationProjectionDataError,
  );

  const creatorSql = database.queries.find((call) => (
    call.text.includes('qualification_creator')
  ))?.text ?? '';
  assert.match(creatorSql, /profile_payload_bytes/u);
  assert.match(creatorSql, /profile_event_payload_bytes/u);
  assert.match(creatorSql, /CASE[\s\S]*profile\.payload/u);
  assert.match(creatorSql, /CASE[\s\S]*event\.payload/u);
  assert.doesNotMatch(creatorSql, /WHERE[\s\S]*octet_length\((?:profile|event)\.payload::text\)\s*<=/u);
  assert.equal(database.queries.some((call) => call.text.includes('qualification_holders')), false);
});

void test('reconstructs holder aggregates without touching the snapshot payload', async () => {
  const evidence = analyticsFixture();
  let touched = false;
  const holderRow = { ...evidence.holderRow };
  Object.defineProperty(holderRow, 'payload', {
    enumerable: true,
    get: () => {
      touched = true;
      throw new Error('oversized holder payload materialized');
    },
  });
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow()]);
    if (text.includes('qualification_as_of')) return rows([asOfRow()]);
    if (text.includes('qualification_creator')) return rows([evidence.profileRow]);
    if (text.includes('qualification_holders')) return rows([holderRow]);
    if (text.includes('qualification_graph */')) return rows([evidence.graphRow]);
    return undefined;
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  const snapshot = await repository.transact('mint', (transaction) => (
    transaction.loadCanonicalInput('mint')
  ));

  assert.equal(touched, false);
  assert.equal(
    snapshot?.holderSnapshot === null
      ? true
      : Object.hasOwn(snapshot?.holderSnapshot ?? {}, 'positions'),
    false,
  );
  assert.equal(snapshot?.holderSnapshot?.totalPositiveNetBaseRaw, 2n);
});

void test('rejects a holder event summary that differs from reconstructed scalars', async () => {
  const evidence = analyticsFixture();
  const originalEvent = evidence.holderRow.event_payload as Record<string, unknown>;
  const holderRow = {
    ...evidence.holderRow,
    event_payload: toJsonValue({
      inputFingerprint: 'c'.repeat(64),
      confirmationCounts: { processed: 0, confirmed: 1, finalized: 0 },
      distribution: {
        ...(originalEvent.distribution as Record<string, unknown>),
        totalPositiveNetBaseRaw: 3n,
      },
    }),
  };
  const database = analyticsPool(evidence, evidence.graphRow, holderRow);
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.loadCanonicalInput('mint')),
    QualificationProjectionDataError,
  );
});

void test('rejects a holder summary concentration outside the basis-point scale', async () => {
  const evidence = analyticsFixture();
  const originalEvent = evidence.holderRow.event_payload as Record<string, unknown>;
  const originalSummary = originalEvent.distribution as Record<string, unknown>;
  const holderRow = {
    ...evidence.holderRow,
    top1_bps: '10001',
    event_payload: toJsonValue({
      inputFingerprint: 'c'.repeat(64),
      confirmationCounts: { processed: 0, confirmed: 1, finalized: 0 },
      distribution: { ...originalSummary, top1Bps: 10_001n },
    }),
  };
  const database = analyticsPool(evidence, evidence.graphRow, holderRow);
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.loadCanonicalInput('mint')),
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

void test('fails closed when participant and graph revisions do not align', async () => {
  const evidence = analyticsFixture('d'.repeat(64), 'c'.repeat(64));
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow()]);
    if (text.includes('qualification_as_of')) return rows([asOfRow()]);
    if (text.includes('qualification_creator')) return rows([evidence.profileRow]);
    if (text.includes('qualification_holders')) return rows([evidence.holderRow]);
    if (text.includes('qualification_graph */')) return rows([evidence.graphRow]);
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.loadCanonicalInput('mint')),
    QualificationProjectionDataError,
  );
});

for (const mutation of [
  {
    name: 'missing aggregate',
    mutate: (payload: Record<string, unknown>) => {
      const remaining = { ...payload };
      Reflect.deleteProperty(remaining, 'maximumClusterBps');
      return remaining;
    },
  },
  {
    name: 'wrong aggregate',
    mutate: (payload: Record<string, unknown>) => ({
      ...payload,
      strongRelationshipCount: 1,
    }),
  },
  {
    name: 'extra field',
    mutate: (payload: Record<string, unknown>) => ({ ...payload, extra: true }),
  },
  {
    name: 'malformed bigint',
    mutate: (payload: Record<string, unknown>) => ({
      ...payload,
      maximumClusterBps: '0',
    }),
  },
] as const) {
  void test(`rejects graph event payload with ${mutation.name}`, async () => {
    const evidence = analyticsFixture();
    const original = evidence.graphRow.graph_event_payload;
    assert.ok(typeof original === 'object' && original !== null && !Array.isArray(original));
    const graphRow = {
      ...evidence.graphRow,
      graph_event_payload: mutation.mutate(original as Record<string, unknown>),
    };
    const database = analyticsPool(evidence, graphRow);
    const repository = new PostgresQualificationProjectionRepository(database, validator());

    await assert.rejects(
      repository.transact('mint', (transaction) => transaction.loadCanonicalInput('mint')),
      QualificationProjectionDataError,
    );
  });
}

void test('rejects a graph event payload version other than one', async () => {
  const evidence = analyticsFixture();
  const database = analyticsPool(evidence, {
    ...evidence.graphRow,
    graph_event_payload_version: 2,
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.loadCanonicalInput('mint')),
    QualificationProjectionDataError,
  );
});

void test('rejects every social child overflow before decoding hostile rows', async () => {
  const evidence = socialFixture();
  const cases = [
    ['qualification_social_links', SOCIAL_LINK_ROW_MAXIMUM],
    ['qualification_social_observations', SOCIAL_OBSERVATION_ROW_MAXIMUM],
    ['qualification_social_verification', SOCIAL_EVIDENCE_ROW_MAXIMUM],
  ] as const;
  for (const [target, maximum] of cases) {
    let touched = false;
    const hostile = hostileRows(maximum + 1, () => { touched = true; });
    const database = new ScriptedPool((text) => {
      if (text.includes('qualification_launch')) return rows([launchRow(evidence.mint)]);
      if (text.includes('qualification_as_of')) return rows([asOfRow(evidence.mint)]);
      if (text.includes('qualification_social */')) return rows([evidence.collectionRow]);
      if (text.includes(target)) return rows(hostile);
      if (text.includes('qualification_social_links')) return rows([evidence.linkRow]);
      if (text.includes('qualification_social_observations')) {
        return rows([evidence.observationRow]);
      }
      if (text.includes('qualification_social_verification')) return rows([evidence.evidenceRow]);
      if (text.includes('qualification_metadata_collection')) return rows([evidence.metadataRow]);
      return rows([]);
    });
    const repository = new PostgresQualificationProjectionRepository(database, validator());
    await assert.rejects(
      repository.transact(evidence.mint, (transaction) => (
        transaction.loadCanonicalInput(evidence.mint)
      )),
      QualificationProjectionDataError,
    );
    assert.equal(touched, false, `${target} decoded an overflow row`);
  }
});

void test('rejects every wallet child overflow before decoding hostile rows', async () => {
  const evidence = analyticsFixture();
  const cases = [
    ['qualification_graph_relationships', WALLET_RELATIONSHIP_ROW_MAXIMUM],
    ['qualification_graph_clusters', WALLET_CLUSTER_ROW_MAXIMUM],
    ['qualification_graph_members', WALLET_MEMBER_ROW_MAXIMUM],
  ] as const;
  for (const [target, maximum] of cases) {
    let touched = false;
    const hostile = hostileRows(maximum + 1, () => { touched = true; });
    const database = new ScriptedPool((text) => {
      if (text.includes('qualification_launch')) return rows([launchRow()]);
      if (text.includes('qualification_as_of')) return rows([asOfRow()]);
      if (text.includes('qualification_creator')) return rows([evidence.profileRow]);
      if (text.includes('qualification_holders')) return rows([evidence.holderRow]);
      if (text.includes('qualification_graph */')) return rows([evidence.graphRow]);
      if (text.includes(target)) return rows(hostile);
      return rows([]);
    });
    const repository = new PostgresQualificationProjectionRepository(database, validator());
    await assert.rejects(
      repository.transact('mint', (transaction) => transaction.loadCanonicalInput('mint')),
      QualificationProjectionDataError,
    );
    assert.equal(touched, false, `${target} decoded an overflow row`);
  }
});

void test('accepts exact social child boundaries and queries only maximum plus one', async () => {
  const evidence = socialBoundaryFixture();
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow(evidence.mint)]);
    if (text.includes('qualification_as_of')) return rows([asOfRow(evidence.mint)]);
    if (text.includes('qualification_social */')) return rows([evidence.collectionRow]);
    if (text.includes('qualification_social_links')) return rows(evidence.linkRows);
    if (text.includes('qualification_social_observations')) return rows(evidence.observationRows);
    if (text.includes('qualification_social_verification')) return rows(evidence.evidenceRows);
    if (text.includes('qualification_metadata_collection')) return rows([evidence.metadataRow]);
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  const snapshot = await repository.transact(evidence.mint, (transaction) => (
    transaction.loadCanonicalInput(evidence.mint)
  ));

  assert.deepEqual(snapshot?.social, evidence.collection);
  for (const [marker, maximum] of [
    ['qualification_social_links', SOCIAL_LINK_ROW_MAXIMUM],
    ['qualification_social_observations', SOCIAL_OBSERVATION_ROW_MAXIMUM],
    ['qualification_social_verification', SOCIAL_EVIDENCE_ROW_MAXIMUM],
  ] as const) {
    const call = database.queries.find((query) => query.text.includes(marker));
    assert.match(call?.text ?? '', /LIMIT \$2/u);
    assert.equal(call?.values?.[1], maximum + 1);
  }
});

for (const family of ['relationships', 'clusters', 'members'] as const) {
  void test(`accepts the exact wallet ${family} boundary and queries only maximum plus one`, async () => {
    const evidence = walletBoundaryFixture(family);
    const database = new ScriptedPool((text) => {
      if (text.includes('qualification_launch')) return rows([launchRow()]);
      if (text.includes('qualification_as_of')) return rows([asOfRow()]);
      if (text.includes('qualification_creator')) return rows([evidence.profileRow]);
      if (text.includes('qualification_holders')) return rows([evidence.holderRow]);
      if (text.includes('qualification_graph */')) return rows([evidence.graphRow]);
      if (text.includes('qualification_graph_relationships')) {
        return rows(evidence.relationshipRows);
      }
      if (text.includes('qualification_graph_clusters')) return rows(evidence.clusterRows);
      if (text.includes('qualification_graph_members')) return rows(evidence.memberRows);
      return rows([]);
    });
    const repository = new PostgresQualificationProjectionRepository(database, validator());

    const snapshot = await repository.transact('mint', (transaction) => (
      transaction.loadCanonicalInput('mint')
    ));

    assert.equal(snapshot?.walletGraph?.relationships.length, evidence.relationshipRows.length);
    assert.equal(snapshot?.walletGraph?.clusters.length, evidence.clusterRows.length);
    assert.equal(
      snapshot?.walletGraph?.clusters.reduce((count, cluster) => count + cluster.members.length, 0),
      evidence.memberRows.length,
    );
    const relationshipCall = database.queries.find((query) => (
      query.text.includes('qualification_graph_relationships')
    ));
    assert.match(relationshipCall?.text ?? '', /LIMIT \$3/u);
    assert.equal(relationshipCall?.values?.[2], WALLET_RELATIONSHIP_ROW_MAXIMUM + 1);
    const clusterCall = database.queries.find((query) => (
      query.text.includes('qualification_graph_clusters')
    ));
    assert.match(clusterCall?.text ?? '', /LIMIT \$3/u);
    assert.equal(clusterCall?.values?.[2], WALLET_CLUSTER_ROW_MAXIMUM + 1);
    const memberCall = database.queries.find((query) => (
      query.text.includes('qualification_graph_members')
    ));
    assert.match(
      memberCall?.text ?? '',
      /\(ROW_NUMBER\(\) OVER \(PARTITION BY cluster_id ORDER BY wallet\)\)::integer/u,
    );
    assert.match(memberCall?.text ?? '', /LIMIT \$3/u);
    assert.equal(memberCall?.values?.[2], WALLET_MEMBER_ROW_MAXIMUM + 1);
    assert.equal(memberCall?.values?.[3], WALLET_MEMBERS_PER_CLUSTER_MAXIMUM + 1);
  });
}

void test('accepts the exact per-cluster wallet member boundary', async () => {
  const evidence = walletBoundaryFixture('per_cluster');
  const database = graphPool(evidence);
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  const snapshot = await repository.transact('mint', (transaction) => (
    transaction.loadCanonicalInput('mint')
  ));

  assert.equal(
    snapshot?.walletGraph?.clusters[0]?.members.length,
    WALLET_MEMBERS_PER_CLUSTER_MAXIMUM,
  );
});

void test('rejects a wallet cluster member per-cluster overflow before decoding', async () => {
  const evidence = analyticsFixture();
  let touched = false;
  const overflowRow = new Proxy(
    { cluster_member_ordinal: WALLET_MEMBERS_PER_CLUSTER_MAXIMUM + 1 },
    {
      get(target, property) {
        if (property === 'cluster_member_ordinal') return target.cluster_member_ordinal;
        touched = true;
        return undefined;
      },
    },
  );
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow()]);
    if (text.includes('qualification_as_of')) return rows([asOfRow()]);
    if (text.includes('qualification_creator')) return rows([evidence.profileRow]);
    if (text.includes('qualification_holders')) return rows([evidence.holderRow]);
    if (text.includes('qualification_graph */')) return rows([evidence.graphRow]);
    if (text.includes('qualification_graph_members')) return rows([overflowRow]);
    return rows([]);
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.loadCanonicalInput('mint')),
    QualificationProjectionDataError,
  );
  assert.equal(touched, false);
});

for (const mutation of [
  ['participant_wallet_count', 3],
  ['auxiliary_wallet_count', 1],
  ['positive_holder_count', 1],
  ['observed_positive_base_raw', '1'],
  ['concentration_bps', '1'],
  ['contains_creator', true],
  ['shared_funder_count', 1],
  ['strong_relationship_count', 0],
  ['strong_evidence_count', 0],
  ['quote_assets', [{ mint: 'quote', decimals: 6, tokenProgram: 'SPL_TOKEN' }]],
] as const) {
  void test(`rejects wallet cluster ${mutation[0]} mismatch`, async () => {
    const evidence = walletBoundaryFixture('clusters');
    const first = evidence.clusterRows[0];
    assert.ok(first);
    const clusterRows = [
      { ...first, [mutation[0]]: mutation[1] },
      ...evidence.clusterRows.slice(1),
    ];
    const database = graphPool(evidence, { clusterRows });
    const repository = new PostgresQualificationProjectionRepository(database, validator());

    await assert.rejects(
      repository.transact('mint', (transaction) => transaction.loadCanonicalInput('mint')),
      QualificationProjectionDataError,
    );
  });
}

void test('bounds active direct funding evidence before decoding hostile rows', async () => {
  const evidence = walletBoundaryFixture('clusters');
  let touched = false;
  const database = graphPool(evidence, {
    fundingRows: hostileRows(WALLET_FUNDING_EVIDENCE_ROW_MAXIMUM + 1, () => { touched = true; }),
  });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  await assert.rejects(
    repository.transact('mint', (transaction) => transaction.loadCanonicalInput('mint')),
    QualificationProjectionDataError,
  );
  assert.equal(touched, false);
});

void test('recomputes shared funders from bounded active direct evidence', async () => {
  const evidence = walletBoundaryFixture('members');
  const firstCluster = evidence.clusterRows[0];
  const firstClusterId = firstCluster?.cluster_id;
  assert.equal(typeof firstClusterId, 'string');
  const members = evidence.memberRows.filter((row) => row.cluster_id === firstClusterId);
  const funder = members[1]?.wallet;
  const buyer1 = members[0]?.wallet;
  const buyer2 = members[2]?.wallet;
  assert.equal(typeof funder, 'string');
  assert.equal(typeof buyer1, 'string');
  assert.equal(typeof buyer2, 'string');
  const clusterRows = evidence.clusterRows.map((row, index) => (
    index === 0 ? { ...row, shared_funder_count: 1 } : row
  ));
  const fundingRows = [
    { buyer: buyer1, funder },
    { buyer: buyer2, funder },
  ];
  const database = graphPool(evidence, { clusterRows, fundingRows });
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  const snapshot = await repository.transact('mint', (transaction) => (
    transaction.loadCanonicalInput('mint')
  ));

  assert.equal(snapshot?.walletGraph?.clusters[0]?.sharedFunderCount, 1);
  const fundingCall = database.queries.find((query) => (
    query.text.includes('qualification_graph_funding')
  ));
  assert.match(fundingCall?.text ?? '', /LIMIT \$2/u);
  assert.equal(fundingCall?.values?.[1], WALLET_FUNDING_EVIDENCE_ROW_MAXIMUM + 1);
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

void test('recreates a purged report by reusing an exact retained qualification event', async () => {
  const projection = projectionFixture();
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

    await Promise.all([
      repository.transact('mint', (transaction) => transaction.replaceProjection(confirmed)),
      repository.transact('mint', (transaction) => transaction.replaceProjection(confirmed)),
    ]);
    assert.deepEqual(await liveCounts(pool), ['1', '1', '1', '1']);
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
    await repository.transact('mint', (transaction) => transaction.replaceProjection(finalized));
    const evidenceRevision = projectionFixture({
      confirmationStatus: 'finalized',
      descriptionAvailable: true,
      observedAtMs,
    });
    await repository.transact(
      'mint',
      (transaction) => transaction.replaceProjection(evidenceRevision),
    );

    await insertLiveTrade(pool, observedAtMs + 1_000);
    const recentSnapshot = await repository.transact(
      'mint',
      (transaction) => transaction.loadCanonicalInput('mint'),
    );
    assert.ok(recentSnapshot);
    assert.equal(recentSnapshot.asOfEvent.id, 'trade-event');
    const recent = canonicalProjectionFromSnapshot(service, recentSnapshot);
    await repository.transact('mint', (transaction) => transaction.replaceProjection(recent));

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
    await repository.transact('mint', (transaction) => transaction.replaceProjection(fallback));
    assert.deepEqual(await liveCounts(pool), ['4', '1', '4', '4']);

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
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('live PostgreSQL rejects present oversized social and creator JSON evidence', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live qualification payload bound test skipped');
    return;
  }
  const schema = `qualification_payload_bounds_${randomUUID().replaceAll('-', '')}`;
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
    const metadataSnapshotId = 'metadata-oversized';
    const collectionId = `social_collection_${'a'.repeat(64)}`;
    const fingerprint = 'b'.repeat(64);
    await pool.query(`INSERT INTO token_metadata_snapshots (
      snapshot_id,mint,uri,resolution_status,failure_reason,failure_message,
      payload_version,payload_hash,metadata,fetched_at,purge_after,source_launch_event_id
    ) VALUES ($1,'mint','https://example.test/metadata.json','resolved',NULL,NULL,
      1,$2,'{}'::jsonb,$3,NULL,'source-event')`, [
      metadataSnapshotId, 'c'.repeat(64), new Date(observedAtMs),
    ]);
    await pool.query(`INSERT INTO domain_events (
      event_id,raw_event_id,type,mint,source,program,signature,slot,
      transaction_index,instruction_index,inner_instruction_index,
      confirmation_status,blockchain_time,observed_at,payload_version,payload
    ) VALUES (
      'social-oversized-event','raw-source','SocialEvidenceCollected','mint','pumpfun',
      'pump-program','signature',10,0,1,NULL,'confirmed',$1,$2,1,$3
    )`, [new Date(observedAtMs - 100), new Date(observedAtMs), {
      inputFingerprint: fingerprint, padding: oversized,
    }]);
    await pool.query(`INSERT INTO social_evidence_collections (
      collection_id,input_fingerprint,mint,source_launch_event_id,source_raw_event_id,
      metadata_snapshot_id,collection_status,confirmation_status,observed_at,
      payload_version,terminal_at,purge_after
    ) VALUES ($1,$2,'mint','source-event','raw-source',$3,'COMPLETE','confirmed',$4,
      1,NULL,NULL)`, [collectionId, fingerprint, metadataSnapshotId, new Date(observedAtMs)]);

    await assert.rejects(
      repository.transact('mint', (transaction) => transaction.loadCanonicalInput('mint')),
      QualificationProjectionDataError,
    );

    await pool.query('DELETE FROM social_evidence_collections');
    await pool.query("DELETE FROM domain_events WHERE event_id='social-oversized-event'");
    await pool.query('DELETE FROM token_metadata_snapshots');
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
    ) VALUES ('mint','different-creator',1,$1,'creator-oversized-event',10,0,1,NULL,
      'confirmed',0,0,0,FALSE,$2,$3,NULL)`, [
      participantFingerprint, { padding: oversized }, new Date(observedAtMs),
    ]);

    await assert.rejects(
      repository.transact('mint', (transaction) => transaction.loadCanonicalInput('mint')),
      QualificationProjectionDataError,
    );
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
    await pool.query(`UPDATE qualification_reports
      SET evaluated_at=clock_timestamp()-INTERVAL '5 hours',
          purge_after=clock_timestamp()-INTERVAL '1 hour'
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

function hostileRows(
  count: number,
  touch: () => void,
): readonly Record<string, unknown>[] {
  return Array.from({ length: count }, () => new Proxy<Record<string, unknown>>({}, {
    get: () => {
      touch();
      throw new Error('hostile row decoded');
    },
  }));
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

function socialFixture() {
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
  const linkBase = Object.freeze({
    mint, metadataSnapshotId, kind: 'WEBSITE' as const,
    declaredValueSha256: 'a'.repeat(64), syntaxStatus: 'VALID' as const,
    canonicalUrl: 'https://example.test/', invalidReason: null, observedAtMs: 1_011,
  });
  const link = Object.freeze({ id: socialLinkId(linkBase), ...linkBase });
  const observationBase = Object.freeze({
    linkId: link.id, outcome: 'SUCCEEDED' as const,
    finalCanonicalUrl: 'https://example.test/', httpStatus: 200,
    redirectCount: 0, contentSha256: 'b'.repeat(64), failureReason: null,
    observedAtMs: 1_012,
  });
  const observation = Object.freeze({
    id: socialHttpObservationId(observationBase), ...observationBase,
  });
  const evidenceBase = Object.freeze({
    mint, linkId: link.id, observationId: observation.id,
    type: 'URL_REACHABLE' as const, outcome: 'CONFIRMED' as const,
    subjectKind: 'WEBSITE' as const, relatedKind: null,
    reasonCode: 'HTTP_OK', observedAtMs: 1_013,
  });
  const socialEvidence = Object.freeze({
    id: socialVerificationEvidenceId(evidenceBase), ...evidenceBase,
  });
  const collection = createSocialCollection(Object.freeze({
    mint, sourceLaunchEventId: 'launch-event', metadataSnapshotId,
    status: 'COMPLETE' as const, links: Object.freeze([link]),
    observations: Object.freeze([observation]), evidence: Object.freeze([socialEvidence]),
    observedAtMs: 1_014,
  }));
  const socialEventPayload = toJsonValue({
    sourceLaunchEventId: 'launch-event', collectionId: collection.id,
    metadataSnapshotId, collectionStatus: 'COMPLETE',
    inputFingerprint: collection.inputFingerprint,
    linkCount: collection.links.length, evidenceCount: collection.evidence.length,
  });
  return {
    mint, metadata, collection,
    collectionRow: {
      collection_id: collection.id, input_fingerprint: collection.inputFingerprint,
      mint, source_launch_event_id: 'launch-event',
      source_raw_event_id: 'raw-launch',
      metadata_snapshot_id: metadataSnapshotId, collection_status: 'COMPLETE',
      observed_at: new Date(1_014), payload_version: 1,
      social_event_payload_version: 1,
      social_event_payload_bytes: Buffer.byteLength(JSON.stringify(socialEventPayload), 'utf8'),
      social_event_payload: socialEventPayload,
    },
    linkRow: {
      link_id: link.id, mint, metadata_snapshot_id: metadataSnapshotId,
      link_kind: link.kind, declared_value_sha256: link.declaredValueSha256,
      syntax_status: link.syntaxStatus, canonical_url: link.canonicalUrl,
      invalid_reason: link.invalidReason, observed_at: new Date(link.observedAtMs),
    },
    observationRow: {
      observation_id: observation.id, link_id: link.id, outcome: observation.outcome,
      final_canonical_url: observation.finalCanonicalUrl, http_status: observation.httpStatus,
      redirect_count: observation.redirectCount, content_sha256: observation.contentSha256,
      failure_reason: observation.failureReason, observed_at: new Date(observation.observedAtMs),
    },
    evidenceRow: {
      evidence_id: socialEvidence.id, mint, link_id: link.id,
      observation_id: observation.id, evidence_type: socialEvidence.type,
      outcome: socialEvidence.outcome, subject_kind: socialEvidence.subjectKind,
      related_kind: socialEvidence.relatedKind, reason_code: socialEvidence.reasonCode,
      observed_at: new Date(socialEvidence.observedAtMs),
    },
    metadataRow: {
      snapshot_id: metadataSnapshotId, mint, uri: metadata.uri,
      resolution_status: 'resolved', failure_reason: null, failure_message: null,
      failure_retryable: null, metadata: metadata.resolution.metadata,
      fetched_at: new Date(metadata.fetchedAtMs), payload_version: 1,
      source_launch_event_id: 'launch-event',
    },
  };
}

function socialBoundaryFixture() {
  const mint = '11111111111111111111111111111111';
  const metadata = Object.freeze({
    mint,
    uri: 'https://example.test/boundary.json',
    resolution: Object.freeze({
      status: 'RESOLVED' as const,
      metadata: Object.freeze({
        name: 'Boundary', symbol: 'BND', description: null,
        imageUrl: null, videoUrl: null, websiteUrl: null,
        twitterUrl: null, telegramUrl: null,
      }),
    }),
    fetchedAtMs: 1_020,
    payloadVersion: 1,
  });
  const metadataSnapshotId = socialMetadataSnapshotId({
    sourceLaunchEventId: 'launch-event',
    snapshot: metadata,
  });
  const kinds = ['WEBSITE', 'X', 'TELEGRAM'] as const;
  const links = Object.freeze(kinds.map((kind, index) => {
    const base = Object.freeze({
      mint, metadataSnapshotId, kind,
      declaredValueSha256: String(index + 1).repeat(64),
      syntaxStatus: 'VALID' as const,
      canonicalUrl: `https://example.test/${kind.toLowerCase()}`,
      invalidReason: null,
      observedAtMs: 1_021 + index,
    });
    return Object.freeze({ id: socialLinkId(base), ...base });
  }));
  const observations = Object.freeze(links.map((link, index) => {
    const base = Object.freeze({
      linkId: link.id,
      outcome: 'SUCCEEDED' as const,
      finalCanonicalUrl: link.canonicalUrl,
      httpStatus: 200,
      redirectCount: 0,
      contentSha256: ['a', 'b', 'c'][index]?.repeat(64) ?? 'd'.repeat(64),
      failureReason: null,
      observedAtMs: 1_030 + index,
    });
    return Object.freeze({ id: socialHttpObservationId(base), ...base });
  }));
  const evidenceTypes = [
    'URL_SYNTAX_VALID', 'URL_REACHABLE', 'CROSS_LINK_CONFIRMED',
    'MINT_PUBLISHED', 'ACCOUNT_TOO_RECENT', 'DOMAIN_MISMATCH',
    'CONTENT_UNAVAILABLE', 'VERIFICATION_UNKNOWN',
  ] as const;
  const evidence = Object.freeze(Array.from(
    { length: SOCIAL_EVIDENCE_ROW_MAXIMUM },
    (_, index) => {
      const base = Object.freeze({
        mint,
        linkId: links[0]?.id ?? null,
        observationId: observations[0]?.id ?? null,
        type: evidenceTypes[index % evidenceTypes.length] ?? 'VERIFICATION_UNKNOWN',
        outcome: 'CONFIRMED' as const,
        subjectKind: 'WEBSITE' as const,
        relatedKind: null,
        reasonCode: `BOUNDARY_${index}`,
        observedAtMs: 1_040 + index,
      });
      return Object.freeze({ id: socialVerificationEvidenceId(base), ...base });
    },
  ));
  const collection = createSocialCollection(Object.freeze({
    mint,
    sourceLaunchEventId: 'launch-event',
    metadataSnapshotId,
    status: 'COMPLETE' as const,
    links,
    observations,
    evidence,
    observedAtMs: 1_200,
  }));
  const socialEventPayload = toJsonValue({
    sourceLaunchEventId: 'launch-event', collectionId: collection.id,
    metadataSnapshotId, collectionStatus: 'COMPLETE',
    inputFingerprint: collection.inputFingerprint,
    linkCount: collection.links.length, evidenceCount: collection.evidence.length,
  });
  return {
    mint,
    collection,
    collectionRow: {
      collection_id: collection.id,
      input_fingerprint: collection.inputFingerprint,
      mint,
      source_launch_event_id: 'launch-event',
      source_raw_event_id: 'raw-launch',
      metadata_snapshot_id: metadataSnapshotId,
      collection_status: 'COMPLETE',
      observed_at: new Date(collection.observedAtMs),
      payload_version: 1,
      social_event_payload_version: 1,
      social_event_payload_bytes: Buffer.byteLength(JSON.stringify(socialEventPayload), 'utf8'),
      social_event_payload: socialEventPayload,
    },
    linkRows: collection.links.map((link) => ({
      link_id: link.id, mint, metadata_snapshot_id: metadataSnapshotId,
      link_kind: link.kind, declared_value_sha256: link.declaredValueSha256,
      syntax_status: link.syntaxStatus, canonical_url: link.canonicalUrl,
      invalid_reason: link.invalidReason, observed_at: new Date(link.observedAtMs),
    })),
    observationRows: collection.observations.map((observation) => ({
      observation_id: observation.id, link_id: observation.linkId,
      outcome: observation.outcome, final_canonical_url: observation.finalCanonicalUrl,
      http_status: observation.httpStatus, redirect_count: observation.redirectCount,
      content_sha256: observation.contentSha256, failure_reason: observation.failureReason,
      observed_at: new Date(observation.observedAtMs),
    })),
    evidenceRows: collection.evidence.map((item) => ({
      evidence_id: item.id, mint, link_id: item.linkId,
      observation_id: item.observationId, evidence_type: item.type,
      outcome: item.outcome, subject_kind: item.subjectKind,
      related_kind: item.relatedKind, reason_code: item.reasonCode,
      observed_at: new Date(item.observedAtMs),
    })),
    metadataRow: {
      snapshot_id: metadataSnapshotId, mint, uri: metadata.uri,
      resolution_status: 'resolved', failure_reason: null, failure_message: null,
      failure_retryable: null, metadata: metadata.resolution.metadata,
      fetched_at: new Date(metadata.fetchedAtMs), payload_version: 1,
      source_launch_event_id: 'launch-event',
    },
  };
}

function analyticsFixture(
  holderFingerprint = 'c'.repeat(64),
  graphParticipantFingerprint = 'c'.repeat(64),
) {
  const inputFingerprint = 'c'.repeat(64);
  const profile = Object.freeze({
    mint: 'mint', creator: 'creator', payloadVersion: 1, inputFingerprint,
    buyCount: 1, sellCount: 0, totalBoughtBaseRaw: 2n, totalSoldBaseRaw: 0n,
    observedNetBaseRaw: 2n, hasSold: false, firstSell: null,
    initialBuys: Object.freeze([]), quoteFlows: Object.freeze([]),
    uniqueExternalBuyers: 1, unknownTraderTradeCount: 0,
  });
  const holder = Object.freeze({
    mint: 'mint', creator: 'creator', payloadVersion: 1,
    inputFingerprint: holderFingerprint,
    positions: Object.freeze([]), totalPositiveNetBaseRaw: 2n,
    top1Bps: 5_000n, top5Bps: 5_000n, top10Bps: 5_000n, creatorBps: 0n,
    uniqueKnownBuyers: 1, uniqueExternalBuyers: 1,
    positivePositionCount: 1, unknownTraderTradeCount: 0,
  });
  const coverage = Object.freeze({
    knownBuyCount: 0, knownBuyerCount: 0, strongEvidenceBuyCount: 0,
    strongEvidenceBuyerCount: 0, mediumOnlyBuyCount: 0, mediumOnlyBuyerCount: 0,
    noEvidenceBuyCount: 0, noEvidenceBuyerCount: 0, unavailableBuyCount: 0,
    unavailableBuyerCount: 0, notProcessedBuyCount: 0, notProcessedBuyerCount: 0,
    analyzedTransactionCount: 0, evidenceCount: 0,
  });
  const graph = Object.freeze({
    relationships: Object.freeze([]), clusters: Object.freeze([]), coverage,
  });
  const confirmationCounts = { processed: 0, confirmed: 1, finalized: 0 };
  const holderSummary = {
    mint: holder.mint, creator: holder.creator, payloadVersion: holder.payloadVersion,
    inputFingerprint: holder.inputFingerprint,
    totalPositiveNetBaseRaw: holder.totalPositiveNetBaseRaw,
    top1Bps: holder.top1Bps, top5Bps: holder.top5Bps,
    top10Bps: holder.top10Bps, creatorBps: holder.creatorBps,
    uniqueKnownBuyers: holder.uniqueKnownBuyers,
    uniqueExternalBuyers: holder.uniqueExternalBuyers,
    positivePositionCount: holder.positivePositionCount,
    unknownTraderTradeCount: holder.unknownTraderTradeCount,
  };
  const profilePayload = toJsonValue(profile);
  const profileEventPayload = toJsonValue({
    inputFingerprint, confirmationCounts, profile,
  });
  return {
    graph,
    profileRow: {
      mint: 'mint', creator: 'creator', payload_version: 1, input_fingerprint: inputFingerprint,
      profile_event_id: 'profile-event', confirmation_status: 'confirmed',
      total_bought_base_raw: '2', total_sold_base_raw: '0',
      observed_net_base_raw: '2', has_sold: false,
      profile_payload_bytes: Buffer.byteLength(JSON.stringify(profilePayload), 'utf8'),
      profile_payload: profilePayload,
      profile_event_payload_bytes: Buffer.byteLength(JSON.stringify(profileEventPayload), 'utf8'),
      profile_event_payload: profileEventPayload,
    },
    holderRow: {
      snapshot_id: 'holder-snapshot', mint: 'mint', input_fingerprint: holderFingerprint,
      holder_event_id: 'holder-event', payload_version: 1, confirmation_status: 'confirmed',
      total_positive_net_base_raw: '2', top1_bps: '5000', top5_bps: '5000',
      top10_bps: '5000', creator_bps: '0', unique_known_buyers: 1,
      unique_external_buyers: 1, positive_position_count: 1,
      unknown_trader_trade_count: 0, payload: toJsonValue(holder),
      event_payload_version: 1,
      event_payload: toJsonValue({
        inputFingerprint: holderFingerprint,
        confirmationCounts,
        distribution: holderSummary,
      }),
    },
    graphRow: {
      input_fingerprint: inputFingerprint, methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS',
      participant_input_fingerprint: graphParticipantFingerprint,
      graph_event_id: 'graph-event', confirmation_status: 'confirmed',
      coverage: toJsonValue(coverage), strong_relationship_count: 0,
      confirmation_counts: confirmationCounts,
      medium_relationship_count: 0, cluster_count: 0, maximum_cluster_bps: '0',
      creator_cluster_count: 0,
      as_of_slot: '10', as_of_transaction_index: 0, as_of_instruction_index: 1,
      as_of_inner_instruction_index: null,
      graph_event_payload_version: 1,
      graph_event_payload: toJsonValue({
        inputFingerprint,
        methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS',
        coverage,
        strongRelationshipCount: 0,
        mediumRelationshipCount: 0,
        clusterCount: 0,
        maximumClusterBps: 0n,
        creatorClusterCount: 0,
        confirmationCounts,
      }),
    },
  };
}

function walletBoundaryFixture(
  family: 'relationships' | 'clusters' | 'members' | 'per_cluster',
) {
  const evidence = analyticsFixture();
  const inputFingerprint = 'c'.repeat(64);
  const relationshipCount = family === 'relationships'
    ? WALLET_RELATIONSHIP_ROW_MAXIMUM
    : 0;
  const relationshipRow = (leftWallet: string, rightWallet: string) => {
    const left = leftWallet < rightWallet ? leftWallet : rightWallet;
    const right = leftWallet < rightWallet ? rightWallet : leftWallet;
    return {
      relationship_id: createWalletRelationshipId(
        'mint', left, right, 'DIRECT_QUOTE_TRANSFER',
      ),
      mint: 'mint', left_wallet: left, right_wallet: right,
      relationship_type: 'DIRECT_QUOTE_TRANSFER', confidence: 'STRONG',
      evidence_count: 1, quote_totals: [],
      first_observed_cursor: toJsonValue({
        slot: 10n, transactionIndex: 0, instructionIndex: 1,
        innerInstructionIndex: null,
      }),
      last_observed_cursor: toJsonValue({
        slot: 10n, transactionIndex: 0, instructionIndex: 1,
        innerInstructionIndex: null,
      }),
      input_fingerprint: inputFingerprint,
    };
  };
  const relationshipRows = Array.from({ length: relationshipCount }, (_, index) => {
    const leftWallet = `left-${String(index).padStart(4, '0')}`;
    const rightWallet = `right-${String(index).padStart(4, '0')}`;
    return relationshipRow(leftWallet, rightWallet);
  });
  const clusterCount = family === 'clusters'
    ? WALLET_CLUSTER_ROW_MAXIMUM
    : family === 'members' ? WALLET_CLUSTER_ROW_MAXIMUM
      : family === 'per_cluster' ? 1 : 0;
  const membersPerCluster = family === 'members'
    ? 4
    : family === 'per_cluster' ? WALLET_MEMBERS_PER_CLUSTER_MAXIMUM : 2;
  const clusterRows: Record<string, unknown>[] = [];
  const memberRows: Record<string, unknown>[] = [];
  for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex += 1) {
    const wallets = Array.from({ length: membersPerCluster }, (_, memberIndex) => (
      `wallet-${String(clusterIndex).padStart(3, '0')}-${String(memberIndex).padStart(3, '0')}`
    ));
    const clusterId = createWalletClusterId('mint', wallets);
    const strongRelationshipCount = wallets.length - 1;
    for (let index = 1; index < wallets.length; index += 1) {
      const left = wallets[index - 1];
      const right = wallets[index];
      assert.ok(left);
      assert.ok(right);
      relationshipRows.push(relationshipRow(left, right));
    }
    clusterRows.push({
      cluster_id: clusterId, mint: 'mint', input_fingerprint: inputFingerprint,
      participant_wallet_count: wallets.length, auxiliary_wallet_count: 0,
      positive_holder_count: 0, observed_positive_base_raw: '0', concentration_bps: '0',
      contains_creator: false, shared_funder_count: 0,
      strong_relationship_count: strongRelationshipCount,
      strong_evidence_count: strongRelationshipCount, quote_assets: [],
    });
    memberRows.push(...wallets.map((wallet, memberIndex) => ({
      cluster_id: clusterId, wallet, member_role: 'PARTICIPANT', is_creator: false,
      observed_net_base_raw: '0', input_fingerprint: inputFingerprint,
      cluster_member_ordinal: memberIndex + 1,
    })));
  }
  const confirmationCounts = { processed: 0, confirmed: 1, finalized: 0 };
  const graphRow = {
    ...evidence.graphRow,
    strong_relationship_count: relationshipRows.length,
    cluster_count: clusterRows.length,
    graph_event_payload: toJsonValue({
      inputFingerprint,
      methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS',
      coverage: evidence.graphRow.coverage,
      strongRelationshipCount: relationshipRows.length,
      mediumRelationshipCount: 0,
      clusterCount: clusterRows.length,
      maximumClusterBps: 0n,
      creatorClusterCount: 0,
      confirmationCounts,
    }),
  };
  return {
    ...evidence,
    graphRow,
    relationshipRows,
    clusterRows,
    memberRows,
  };
}

function analyticsPool(
  evidence: ReturnType<typeof analyticsFixture>,
  graphRow: Record<string, unknown> = evidence.graphRow,
  holderRow: Record<string, unknown> = evidence.holderRow,
): ScriptedPool {
  return new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow()]);
    if (text.includes('qualification_as_of')) return rows([asOfRow()]);
    if (text.includes('qualification_creator')) return rows([evidence.profileRow]);
    if (text.includes('qualification_holders')) return rows([holderRow]);
    if (text.includes('qualification_graph */')) return rows([graphRow]);
    return rows([]);
  });
}

function graphPool(
  evidence: ReturnType<typeof walletBoundaryFixture>,
  options: Readonly<{
    clusterRows?: readonly Record<string, unknown>[];
    fundingRows?: readonly Record<string, unknown>[];
  }> = {},
): ScriptedPool {
  return new ScriptedPool((text) => {
    if (text.includes('qualification_launch')) return rows([launchRow()]);
    if (text.includes('qualification_as_of')) return rows([asOfRow()]);
    if (text.includes('qualification_creator')) return rows([evidence.profileRow]);
    if (text.includes('qualification_holders')) return rows([evidence.holderRow]);
    if (text.includes('qualification_graph */')) return rows([evidence.graphRow]);
    if (text.includes('qualification_graph_relationships')) {
      return rows(evidence.relationshipRows);
    }
    if (text.includes('qualification_graph_clusters')) {
      return rows(options.clusterRows ?? evidence.clusterRows);
    }
    if (text.includes('qualification_graph_members')) return rows(evidence.memberRows);
    if (text.includes('qualification_graph_funding')) return rows(options.fundingRows ?? []);
    return undefined;
  });
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
      social: null, creatorProfile: null,
      holderSnapshot: null, walletGraph: null,
    }),
    buyQuote: undefined,
    reverseSellQuote: undefined,
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

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) throw new Error('Unsafe SQL identifier.');
  return `"${identifier}"`;
}

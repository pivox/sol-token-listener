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

void test('uses a repeatable-read mint lock and commits and releases', async () => {
  const database = new ScriptedPool();
  const repository = new PostgresQualificationProjectionRepository(database, validator());

  const result = await repository.transact('mint', async () => 'result');

  assert.equal(result, 'result');
  assert.deepEqual(database.queries.slice(0, 2).map((call) => call.text), [
    'BEGIN ISOLATION LEVEL REPEATABLE READ',
    database.queries[1]?.text,
  ]);
  assert.match(
    database.queries[1]?.text ?? '',
    /hashtextextended\('qualification-projection:' \|\| \$1, 0\)/u,
  );
  assert.deepEqual(database.queries.at(-1)?.text, 'COMMIT');
  assert.equal(database.released, true);
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
  assert.equal(database.queries.at(-1)?.text, 'ROLLBACK');
  assert.equal(database.released, true);
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
  assert.equal(database.queries.at(-1)?.text, 'ROLLBACK');
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
  const metadataSql = database.queries.find((call) =>
    call.text.includes('qualification_metadata_collection'))?.text ?? '';
  assert.match(metadataSql, /snapshot_id=\$1/u);
  assert.doesNotMatch(metadataSql, /ORDER BY fetched_at/u);
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
  assert.match(graphSql, /snapshot\.input_fingerprint=graph\.input_fingerprint/u);
  assert.match(graphSql, /snapshot\.graph_event_id=graph\.graph_event_id/u);
});

void test('validates source lineage, supersedes current first and inserts one four-hour report', async () => {
  const projection = projectionFixture();
  let authorized = false;
  const database = new ScriptedPool((text) => {
    if (text.includes('qualification_source_mapping')) return rows([sourceMappingRow(projection)]);
    return rows([]);
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
    await insertLiveLaunch(pool);
    const service = qualificationService();
    const repository = new PostgresQualificationProjectionRepository(pool, service);
    const confirmed = projectionFixture();

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
    const finalized = projectionFixture({ confirmationStatus: 'finalized' });
    await repository.transact('mint', (transaction) => transaction.replaceProjection(finalized));
    const evidenceRevision = projectionFixture({
      confirmationStatus: 'finalized',
      descriptionAvailable: true,
    });
    await repository.transact(
      'mint',
      (transaction) => transaction.replaceProjection(evidenceRevision),
    );

    await insertLiveTrade(pool);
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

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

class ScriptedPool {
  public readonly queries: QueryCall[] = [];
  public released = false;

  public constructor(
    private readonly resolve: (text: string, values: readonly unknown[] | undefined) => {
      readonly rows: readonly Record<string, unknown>[];
      readonly rowCount: number | null;
    } = () => rows([]),
  ) {}

  public async connect() {
    return {
      query: async (text: string, values?: readonly unknown[]) => {
        this.queries.push({ text, values });
        const resolved = this.resolve(text, values);
        if (resolved.rowCount === 0 && /^(?:INSERT|UPDATE)\b/u.test(text.trim())) {
          return { ...resolved, rowCount: 1 };
        }
        return resolved;
      },
      release: () => { this.released = true; },
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
  return {
    mint, metadata, collection,
    collectionRow: {
      collection_id: collection.id, input_fingerprint: collection.inputFingerprint,
      mint, source_launch_event_id: 'launch-event',
      source_raw_event_id: 'raw-launch',
      metadata_snapshot_id: metadataSnapshotId, collection_status: 'COMPLETE',
      observed_at: new Date(1_014), payload_version: 1,
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
  return {
    graph,
    profileRow: {
      mint: 'mint', creator: 'creator', payload_version: 1, input_fingerprint: inputFingerprint,
      profile_event_id: 'profile-event', confirmation_status: 'confirmed',
      total_bought_base_raw: '2', total_sold_base_raw: '0',
      observed_net_base_raw: '2', has_sold: false, payload: toJsonValue(profile),
      event_payload: toJsonValue({
        inputFingerprint, confirmationCounts, profile,
      }),
    },
    holderRow: {
      snapshot_id: 'holder-snapshot', mint: 'mint', input_fingerprint: holderFingerprint,
      holder_event_id: 'holder-event', payload_version: 1, confirmation_status: 'confirmed',
      total_positive_net_base_raw: '2', top1_bps: '5000', top5_bps: '5000',
      top10_bps: '5000', creator_bps: '0', unique_known_buyers: 1,
      unique_external_buyers: 1, positive_position_count: 1,
      unknown_trader_trade_count: 0, payload: toJsonValue(holder),
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
    },
  };
}

function qualificationService(): QualificationRebuildService {
  return new QualificationRebuildService(
    new QualificationEngine(createDefaultQualificationRuleSet(60)),
  );
}

function projectionFixture(options: Readonly<{
  confirmationStatus?: 'confirmed' | 'finalized';
  descriptionAvailable?: boolean;
}> = {}): CanonicalQualificationProjection {
  const service = qualificationService();
  const confirmationStatus = options.confirmationStatus ?? 'confirmed';
  const asOfEvent = Object.freeze({
    id: 'source-event', type: 'TokenLaunchDetected' as const, mint: 'mint',
    source: 'pumpfun', program: 'pump-program', signature: 'signature',
    cursor: Object.freeze({
      slot: 10n, transactionIndex: 0, instructionIndex: 1,
      innerInstructionIndex: null,
    }),
    confirmationStatus,
    blockchainTimeMs: 900, observedAtMs: 1_000, payloadVersion: 1,
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
          fetchedAtMs: 1_000, payloadVersion: 1,
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

async function insertLiveLaunch(pool: InstanceType<typeof pg.Pool>): Promise<void> {
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
  )`, [new Date(900), new Date(1_000)]);
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,
    transaction_index,instruction_index,inner_instruction_index,
    confirmation_status,blockchain_time,observed_at,payload_version,payload
  ) VALUES (
    'source-event','raw-source','TokenLaunchDetected','mint','pumpfun',
    'pump-program','signature',10,0,1,NULL,'confirmed',$1,$2,1,$3
  )`, [new Date(900), new Date(1_000), toJsonValue({ launch })]);
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
    created_signature,created_slot,created_transaction_index,
    created_instruction_index,created_inner_instruction_index,detected_at,updated_at
  ) VALUES (
    'mint','pumpfun','pump-program','creator','SPL_TOKEN','[]'::jsonb,'DETECTED',
    'signature',10,0,1,NULL,$1,$1
  )`, [new Date(1_000)]);
}

async function insertLiveTrade(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    inner_instruction_index,confirmation_status,blockchain_time,observed_at,
    payload_version,payload,processing_status
  ) VALUES (
    'raw-trade','pumpfun','pump-program','mint','trade-signature',11,0,2,NULL,
    'finalized',$1,$2,1,'{}'::jsonb,'processed'
  )`, [new Date(1_900), new Date(2_000)]);
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,
    transaction_index,instruction_index,inner_instruction_index,
    confirmation_status,blockchain_time,observed_at,payload_version,payload
  ) VALUES (
    'trade-event','raw-trade','BondingCurveTradeObserved','mint','pumpfun',
    'pump-program','trade-signature',11,0,2,NULL,'finalized',$1,$2,1,'{}'::jsonb
  )`, [new Date(1_900), new Date(2_000)]);
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

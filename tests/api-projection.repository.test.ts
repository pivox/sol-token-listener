import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiProjectionDataError,
  PostgresApiProjectionRepository,
  type Queryable,
} from '../src/storage/api-projection.repository.js';
import {
  MAX_TIMELINE_INDEX,
  encodeLaunchCursor,
  encodePaperPositionCursor,
  encodeTimelineCursor,
} from '../src/api/cursor.js';
import { toJsonValue } from '../src/utils/json.js';
import { QUALIFICATION_REASON_CODES } from '../src/domain/qualification-reasons.js';
import {
  createDefaultQualificationRuleSet,
  QualificationEngine,
} from '../src/qualification/qualification-engine.js';

interface Call {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

class FakeQueryable implements Queryable {
  public readonly calls: Call[] = [];

  public constructor(private readonly respond: (call: Call) => readonly Record<string, unknown>[]) {}

  public async query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }> {
    const call = { text, values };
    this.calls.push(call);
    return { rows: this.respond(call) };
  }
}

class FakeConnectable implements Queryable {
  public readonly calls: Call[] = [];
  public released = false;
  public connectCount = 0;

  public constructor(private readonly respond: (call: Call) => readonly Record<string, unknown>[]) {}

  public async query(): Promise<{ readonly rows: readonly Record<string, unknown>[] }> {
    throw new Error('Queries must use the snapshot client');
  }

  public async connect(): Promise<{
    query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
    release(): void;
  }> {
    this.connectCount += 1;
    return {
      query: async (text, values) => {
        const call = { text, values };
        this.calls.push(call);
        return { rows: this.respond(call) };
      },
      release: () => { this.released = true; },
    };
  }
}

const detectedAt = new Date('2026-07-01T12:00:00.000Z');
const openedAt = new Date('2026-07-02T12:00:00.000Z');

function calibratedConditions(): Record<string, unknown>[] {
  return QUALIFICATION_REASON_CODES.map((code) => {
    if (code === 'HOLDER_CONCENTRATION_EXCEEDED') return {
      code, mode: 'ENFORCED', status: 'PASSED',
      observed: { top1HolderBps: '1', top5HoldersBps: '2', top10HoldersBps: '3' },
      thresholds: { maximumTop1Bps: '100', maximumTop5Bps: '200', maximumTop10Bps: '300' }, message: 'Passed.',
    };
    if (code === 'RELATED_WALLET_CLUSTER_EXCEEDED') return {
      code, mode: 'ENFORCED', status: 'PASSED', observed: { maximumRelatedClusterBps: '1' },
      thresholds: { maximumClusterBps: '100' }, message: 'Passed.',
    };
    if (code === 'SHARED_FUNDER_CLUSTER') return {
      code, mode: 'ENFORCED', status: 'PASSED', observed: { maximumSharedFunderCount: 0 },
      thresholds: { minimumSharedFunders: 1 }, message: 'Passed.',
    };
    if (code === 'BUY_SIMULATION_FAILED') return {
      code, mode: 'ENFORCED', status: 'PASSED', observed: { buySimulationSucceeded: true },
      thresholds: {}, message: 'Passed.',
    };
    if (code === 'SELL_QUOTE_UNAVAILABLE') return {
      code, mode: 'ENFORCED', status: 'PASSED', observed: { sellQuoteAvailable: true },
      thresholds: {}, message: 'Passed.',
    };
    if (code === 'ROUND_TRIP_LOSS_EXCEEDED') return {
      code, mode: 'ENFORCED', status: 'TRIGGERED', observed: { roundTripLossBps: 3001n },
      thresholds: { maximumRoundTripLossBps: 3000n },
      message: 'Perte aller-retour supérieure au seuil configuré.',
    };
    return { code, mode: 'ENFORCED', status: 'UNKNOWN', observed: {}, thresholds: {}, message: 'Unavailable.' };
  });
}

function launch(mint: string, at = detectedAt): Record<string, unknown> {
  return {
    mint,
    detected_at: at,
    created_slot: '900719925474099312345',
    current_state: 'DETECTED',
    creator: 'creator',
    token_program: 'token-program',
    launchpad: 'pumpfun',
    quote_assets: [{ mint: 'quote', decimals: 6 }],
    initial_token_amount: null,
    initial_quote_amount: null,
  };
}

function projectionRows(call: Call): readonly Record<string, unknown>[] {
  if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a'), launch('mint-b')];
  if (call.text.includes('token_metadata_snapshots')) {
    return [{ mint: 'mint-a', metadata: { name: 'Alpha', symbol: 'ALP' } }];
  }
  if (call.text.includes('bonding_curve_snapshots')) {
    return [{
      mint: 'mint-a', quote_mint: 'quote', quote_decimals: 6,
      real_base_reserves_raw: '100', real_quote_reserves_raw: '200',
      virtual_quote_reserves_raw: '300',
    }];
  }
  if (call.text.includes('FROM migrations AS migration')) return [];
  return [];
}

void test('lists launches with a stable keyset, exact decimals, and grouped projections', async () => {
  const database = new FakeQueryable(projectionRows);
  const repository = new PostgresApiProjectionRepository(database);

  const page = await repository.listLaunches({
    limit: 1,
    after: { detectedAtMs: detectedAt.getTime(), mint: 'previous-mint' },
  });

  assert.deepEqual(page, {
    items: [{
      mint: 'mint-a', detectedAt: detectedAt.toISOString(),
      detectedSlot: '900719925474099312345', status: 'DETECTED',
      name: 'Alpha', symbol: 'ALP', quoteMint: 'quote', quoteDecimals: 6,
      marketCapQuote: null, liquidityQuote: '200',
    }],
    nextCursor: encodeLaunchCursor({ detectedAtMs: detectedAt.getTime(), mint: 'mint-a' }),
  });
  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.items), true);
  assert.equal(Object.isFrozen(page.items[0]), true);
  assert.equal(database.calls.length, 4);
  assert.match(database.calls[0]?.text ?? '', /detected_at DESC, launch\.mint ASC/u);
  assert.match(database.calls[0]?.text ?? '', /detected_at < \$1[\s\S]*detected_at = \$1[\s\S]*mint > \$2/u);
  assert.deepEqual(database.calls[0]?.values, [detectedAt, 'previous-mint', 2]);
  for (const call of database.calls.slice(1)) {
    assert.match(call.text, /= ANY\(\$1\)/u);
    assert.deepEqual(call.values, [['mint-a', 'mint-b']]);
  }
  assert.match(database.calls[0]?.text ?? '', /confirmation_status = 'orphaned'/u);
  assert.match(database.calls[1]?.text ?? '', /DISTINCT ON \(snapshot\.mint\)[\s\S]*ORDER BY snapshot\.mint, snapshot\.fetched_at DESC/u);
  assert.match(database.calls[1]?.text ?? '', /ORDER BY snapshot\.mint, snapshot\.fetched_at DESC, snapshot\.snapshot_id DESC/u);
  assert.match(database.calls[2]?.text ?? '', /DISTINCT ON \(curve\.mint\)[\s\S]*curve\.confirmation_status <> 'orphaned'[\s\S]*ORDER BY curve\.mint, curve\.slot DESC, curve\.transaction_index DESC,[\s\S]*curve\.instruction_index DESC, COALESCE\(curve\.inner_instruction_index, -1\) DESC,[\s\S]*curve\.snapshot_id DESC/u);
  assert.match(database.calls[3]?.text ?? '', /JOIN domain_events AS migration_event ON migration_event\.event_id = migration\.event_id/u);
  assert.match(database.calls[3]?.text ?? '', /migration\.confirmation_status <> 'orphaned'/u);
  assert.match(database.calls[3]?.text ?? '', /market_pool\.confirmation_status <> 'orphaned'[\s\S]*ORDER BY market_pool\.slot DESC, market_pool\.transaction_index DESC,[\s\S]*market_pool\.instruction_index DESC, COALESCE\(market_pool\.inner_instruction_index, -1\) DESC,[\s\S]*market_pool\.pool_address DESC/u);
  assert.match(database.calls[3]?.text ?? '', /snapshot\.confirmation_status <> 'orphaned'[\s\S]*ORDER BY snapshot\.observed_slot DESC, snapshot\.trigger_slot DESC,[\s\S]*snapshot\.transaction_index DESC, snapshot\.instruction_index DESC,[\s\S]*COALESCE\(snapshot\.inner_instruction_index, -1\) DESC, snapshot\.snapshot_id DESC/u);
  assert.match(database.calls[3]?.text ?? '', /ORDER BY migration\.mint, migration_event\.slot DESC, migration_event\.transaction_index DESC,[\s\S]*migration_event\.instruction_index DESC,[\s\S]*COALESCE\(migration_event\.inner_instruction_index, -1\) DESC,[\s\S]*migration\.event_id DESC,[\s\S]*migration\.migration_id DESC/u);
});

void test('keeps the database query count bounded as page size grows', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a'), launch('mint-b'), launch('mint-c')];
    return projectionRows(call);
  });
  const repository = new PostgresApiProjectionRepository(database);

  await repository.listLaunches({ limit: 2, after: null });

  assert.equal(database.calls.length, 4);
  assert.equal(database.calls.filter((call) => call.text.includes('= ANY($1)')).length, 3);
  assert.ok(database.calls.every((call) => !call.text.includes("'mint-a'")));
});

void test('reads an exact launch and returns null only when it is absent', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    return projectionRows(call);
  });
  const repository = new PostgresApiProjectionRepository(database);

  const detail = await repository.getLaunch('mint-a');

  assert.deepEqual(detail, {
    mint: 'mint-a', detectedAt: detectedAt.toISOString(),
    detectedSlot: '900719925474099312345', status: 'DETECTED',
    name: 'Alpha', symbol: 'ALP', quoteMint: 'quote', quoteDecimals: 6,
    marketCapQuote: null, liquidityQuote: '200', creator: 'creator',
    tokenProgram: 'token-program', launchpad: 'pumpfun',
    initialTokenAmount: null, initialQuoteAmount: null,
    reserveBase: '100', reserveQuote: '200', feeBps: null,
    candidate: null, paperStrategy: null,
    social: { status: 'NOT_AVAILABLE', links: [], evidence: [] },
    holders: {
      status: 'NOT_AVAILABLE', snapshots: [], positions: [], clusters: [],
      clusterAnalysisStatus: 'NOT_AVAILABLE',
    },
  });
  assert.equal(Object.isFrozen(detail), true);
  assert.equal(Object.isFrozen(detail?.social ?? {}), true);

  const absent = new PostgresApiProjectionRepository(new FakeQueryable(() => []));
  assert.equal(await absent.getLaunch('absent'), null);
});

void test('uses the real quote vault for PumpSwap liquidity and reserves', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    if (call.text.includes('FROM migrations AS migration')) return [{
      mint: 'mint-a', quote_mint: 'quote', quote_decimals: 6, base_reserves_raw: '100',
      quote_vault_amount_raw: '250', effective_quote_reserves_raw: '999', pool_payload: {},
    }];
    return [];
  });

  const detail = await new PostgresApiProjectionRepository(database).getLaunch('mint-a');

  assert.equal(detail?.marketCapQuote, null);
  assert.equal(detail?.liquidityQuote, '250');
  assert.equal(detail?.reserveQuote, '250');
  assert.match(
    database.calls.find((call) => call.text.includes('FROM migrations AS migration'))?.text ?? '',
    /reserve\.quote_vault_amount_raw/u,
  );
});

void test('exposes current candidate and bounded paper strategy progress on launch detail', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    if (call.text.includes('FROM trading_candidates')) return [{
      candidate_id: `candidate_${'a'.repeat(64)}`, state: 'ELIGIBLE',
      strategy_id: 'validated-external-buys', strategy_version: 1,
      report_id: `qreport_${'b'.repeat(64)}`, quote_mint: 'quote', quote_decimals: 6,
      reason_codes: ['QUALIFIED_ENTRY'], eligible_until: detectedAt, created_at: openedAt,
    }];
    if (call.text.includes('FROM paper_strategy_sessions')) return [{
      session_id: `paper_session_${'c'.repeat(64)}`, state: 'WAITING_EXTERNAL_BUYS',
      reason_code: 'EXTERNAL_BUY_OBSERVED', strategy_id: 'validated-external-buys',
      strategy_version: 1, position_id: 'position-a', quote_mint: 'quote',
      external_buy_target: 10, external_buy_count: 3, minimum_confirmation: 'confirmed',
      updated_at: detectedAt,
      payload: toJsonValue({ lastError: { code: 'QUOTE_UNAVAILABLE', message: 'hidden', retryable: true } }),
    }];
    return projectionRows(call);
  });

  const detail = await new PostgresApiProjectionRepository(database).getLaunch('mint-a');

  assert.deepEqual(detail?.candidate, {
    id: `candidate_${'a'.repeat(64)}`, state: 'ELIGIBLE',
    strategyId: 'validated-external-buys', strategyVersion: 1,
    qualificationReportId: `qreport_${'b'.repeat(64)}`, quoteMint: 'quote',
    quoteDecimals: 6, reasonCodes: ['QUALIFIED_ENTRY'],
    eligibleUntil: detectedAt.toISOString(), createdAt: openedAt.toISOString(),
  });
  assert.deepEqual(detail?.paperStrategy, {
    id: `paper_session_${'c'.repeat(64)}`, state: 'WAITING_EXTERNAL_BUYS',
    reasonCode: 'EXTERNAL_BUY_OBSERVED', strategyId: 'validated-external-buys',
    strategyVersion: 1, positionId: 'position-a', quoteMint: 'quote',
    externalBuyTarget: 10, externalBuyCount: 3, minimumConfirmation: 'confirmed',
    updatedAt: detectedAt.toISOString(), lastErrorCode: 'QUOTE_UNAVAILABLE',
    lastErrorRetryable: true,
  });
  assert.doesNotMatch(JSON.stringify(detail), /hidden/u);
});

void test('fails closed on incoherent candidate windows and paper progress', async () => {
  const candidate = {
    candidate_id: `candidate_${'a'.repeat(64)}`, state: 'ELIGIBLE',
    strategy_id: 'validated-external-buys', strategy_version: 1,
    report_id: `qreport_${'b'.repeat(64)}`, quote_mint: 'quote', quote_decimals: 6,
    reason_codes: ['QUALIFIED_ENTRY'], eligible_until: detectedAt, created_at: openedAt,
  };
  const session = {
    session_id: `paper_session_${'c'.repeat(64)}`, state: 'WAITING_EXTERNAL_BUYS',
    reason_code: 'EXTERNAL_BUY_OBSERVED', strategy_id: 'validated-external-buys',
    strategy_version: 1, position_id: 'position-a', quote_mint: 'quote',
    external_buy_target: 10, external_buy_count: 3, minimum_confirmation: 'confirmed',
    updated_at: detectedAt, payload: toJsonValue({ lastError: null }),
  };
  const repository = (candidateRow: Record<string, unknown>, sessionRow: Record<string, unknown>) =>
    new PostgresApiProjectionRepository(new FakeQueryable((call) => {
      if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
      if (call.text.includes('FROM trading_candidates')) return [candidateRow];
      if (call.text.includes('FROM paper_strategy_sessions')) return [sessionRow];
      return projectionRows(call);
    }));

  await assert.rejects(
    repository({ ...candidate, eligible_until: null }, session).getLaunch('mint-a'),
    ApiProjectionDataError,
  );
  await assert.rejects(
    repository(candidate, { ...session, external_buy_count: 11 }).getLaunch('mint-a'),
    ApiProjectionDataError,
  );
});

void test('uses one sequential repeatable-read snapshot and releases it', async () => {
  const database = new FakeConnectable(projectionRows);

  await new PostgresApiProjectionRepository(database).listLaunches({ limit: 1, after: null });

  assert.deepEqual(database.calls.map((call) => {
    if (call.text.startsWith('BEGIN')) return 'BEGIN';
    if (call.text === 'COMMIT') return 'COMMIT';
    if (call.text.includes('FROM token_launches AS launch')) return 'launches';
    if (call.text.includes('token_metadata_snapshots')) return 'metadata';
    if (call.text.includes('bonding_curve_snapshots')) return 'curves';
    if (call.text.includes('FROM migrations AS migration')) return 'markets';
    return call.text;
  }), ['BEGIN', 'launches', 'metadata', 'curves', 'markets', 'COMMIT']);
  assert.match(database.calls[0]?.text ?? '', /REPEATABLE READ READ ONLY/u);
  assert.equal(database.released, true);
});

void test('rolls back and releases a snapshot when a grouped query fails', async () => {
  const database = new FakeConnectable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    if (call.text.includes('token_metadata_snapshots')) throw new Error('projection failed');
    return [];
  });

  await assert.rejects(
    new PostgresApiProjectionRepository(database).getLaunch('mint-a'),
    /projection failed/u,
  );
  assert.equal(database.calls.at(-1)?.text, 'ROLLBACK');
  assert.equal(database.calls.some((call) => call.text === 'COMMIT'), false);
  assert.equal(database.calls.some((call) => call.text.includes('bonding_curve_snapshots')), false);
  assert.equal(database.released, true);
});

void test('rejects an invalid launch page before acquiring a snapshot client', async () => {
  const database = new FakeConnectable(() => []);

  await assert.rejects(
    new PostgresApiProjectionRepository(database).listLaunches({ limit: 201, after: null }),
    ApiProjectionDataError,
  );

  assert.equal(database.connectCount, 0);
  assert.equal(database.calls.length, 0);
});

void test('returns NOT_AVAILABLE social and holders only for an existing launch', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    return projectionRows(call);
  });
  const repository = new PostgresApiProjectionRepository(database);

  assert.deepEqual(await repository.getLaunchSocial('mint-a'), {
    status: 'NOT_AVAILABLE', links: [], evidence: [],
  });
  assert.deepEqual(await repository.getLaunchHolders('mint-a'), {
    status: 'NOT_AVAILABLE', snapshots: [], positions: [], clusters: [],
    clusterAnalysisStatus: 'NOT_AVAILABLE',
  });
  assert.equal(await new PostgresApiProjectionRepository(new FakeQueryable(() => [])).getLaunchSocial('none'), null);
  assert.equal(await new PostgresApiProjectionRepository(new FakeQueryable(() => [])).getLaunchHolders('none'), null);
});

void test('exposes the latest completed non-orphaned social collection with stable bounded evidence', async () => {
  const observedAt = new Date('2026-08-10T12:00:00.000Z');
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    if (call.text.includes('FROM social_evidence_collections AS collection')) return [{
      collection_id: 'social_collection_a', metadata_snapshot_id: 'pumpfun_metadata_a',
      collection_status: 'PARTIAL', observed_at: observedAt,
      declared_link_count: '2', inspected_link_count: '1', evidence_count: '2',
      confirmed_evidence_count: '1', rejected_evidence_count: '0', unknown_evidence_count: '1',
    }];
    if (call.text.includes('FROM social_links AS link')) return [{
      link_id: 'social_link_website', link_kind: 'WEBSITE', declared_value_sha256: 'a'.repeat(64),
      syntax_status: 'VALID', canonical_url: 'https://project.example/', invalid_reason: null,
      observed_at: observedAt,
    }, {
      link_id: 'social_link_x', link_kind: 'X', declared_value_sha256: 'b'.repeat(64),
      syntax_status: 'INVALID', canonical_url: null, invalid_reason: 'URL_INVALID',
      observed_at: observedAt,
    }];
    if (call.text.includes('FROM social_verification_evidence AS evidence')) return [{
      evidence_id: 'social_evidence_reachable', evidence_type: 'URL_REACHABLE',
      outcome: 'CONFIRMED', subject_kind: 'WEBSITE', related_kind: null,
      subject_url: 'https://project.example/', final_url: 'https://project.example/',
      http_status: 200, redirect_count: 0, content_sha256: 'c'.repeat(64),
      reason_code: 'HTTP_2XX', observed_at: observedAt,
    }, {
      evidence_id: 'social_evidence_unknown', evidence_type: 'VERIFICATION_UNKNOWN',
      outcome: 'UNKNOWN', subject_kind: 'X', related_kind: null,
      subject_url: null, final_url: null, http_status: null, redirect_count: 0,
      content_sha256: null, reason_code: 'URL_INVALID', observed_at: observedAt,
    }];
    return [];
  });
  const repository = new PostgresApiProjectionRepository(database);

  const social = await repository.getLaunchSocial('mint-a');

  assert.deepEqual(social, {
    status: 'AVAILABLE', collectionStatus: 'PARTIAL', collectionId: 'social_collection_a',
    metadataSnapshotId: 'pumpfun_metadata_a', observedAt: observedAt.toISOString(),
    linkCount: 2, linksTruncated: false,
    links: [{
      id: 'social_link_website', kind: 'WEBSITE', declaredValueSha256: 'a'.repeat(64),
      syntaxStatus: 'VALID', canonicalUrl: 'https://project.example/', invalidReason: null,
      observedAt: observedAt.toISOString(),
    }, {
      id: 'social_link_x', kind: 'X', declaredValueSha256: 'b'.repeat(64),
      syntaxStatus: 'INVALID', canonicalUrl: null, invalidReason: 'URL_INVALID',
      observedAt: observedAt.toISOString(),
    }],
    evidenceCount: 2, evidenceTruncated: false,
    evidence: [{
      id: 'social_evidence_reachable', type: 'URL_REACHABLE', outcome: 'CONFIRMED',
      subjectKind: 'WEBSITE', relatedKind: null, subjectUrl: 'https://project.example/',
      finalUrl: 'https://project.example/', httpStatus: 200, redirectCount: 0,
      contentSha256: 'c'.repeat(64), reasonCode: 'HTTP_2XX', observedAt: observedAt.toISOString(),
    }, {
      id: 'social_evidence_unknown', type: 'VERIFICATION_UNKNOWN', outcome: 'UNKNOWN',
      subjectKind: 'X', relatedKind: null, subjectUrl: null, finalUrl: null,
      httpStatus: null, redirectCount: 0, contentSha256: null, reasonCode: 'URL_INVALID',
      observedAt: observedAt.toISOString(),
    }],
    coverage: {
      declaredLinkCount: 2, inspectedLinkCount: 1, confirmedEvidenceCount: 1,
      rejectedEvidenceCount: 0, unknownEvidenceCount: 1,
    },
  });
  assert.equal(Object.isFrozen(social ?? {}), true);
  assert.equal(Object.isFrozen(social?.links ?? []), true);
  assert.match(database.calls[1]?.text ?? '', /SocialEvidenceCollected/u);
  assert.match(database.calls[1]?.text ?? '', /confirmation_status <> 'orphaned'/u);
  assert.match(database.calls[2]?.text ?? '', /ORDER BY CASE link\.link_kind/u);
  assert.match(database.calls[3]?.text ?? '', /ORDER BY CASE evidence\.evidence_type/u);
});

void test('fails closed on malformed social projection data', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    if (call.text.includes('FROM social_evidence_collections AS collection')) return [{
      collection_id: 'social_collection_a', metadata_snapshot_id: 'pumpfun_metadata_a',
      collection_status: 'COMPLETE', observed_at: detectedAt,
      declared_link_count: '-1', inspected_link_count: '0', evidence_count: '0',
      confirmed_evidence_count: '0', rejected_evidence_count: '0', unknown_evidence_count: '0',
    }];
    return [];
  });

  await assert.rejects(
    new PostgresApiProjectionRepository(database).getLaunchSocial('mint-a'),
    ApiProjectionDataError,
  );
});

void test('returns failed metadata evidence as AVAILABLE and truncates oversized evidence explicitly', async () => {
  const evidenceRows = Array.from({ length: 64 }, (_, index) => ({
    evidence_id: `social_evidence_${String(index).padStart(2, '0')}`,
    evidence_type: 'VERIFICATION_UNKNOWN', outcome: 'UNKNOWN', subject_kind: null,
    related_kind: null, subject_url: null, final_url: null, http_status: null,
    redirect_count: 0, content_sha256: null, reason_code: 'METADATA_UNAVAILABLE',
    observed_at: detectedAt,
  }));
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    if (call.text.includes('FROM social_evidence_collections AS collection')) return [{
      collection_id: 'social_collection_failed', metadata_snapshot_id: 'pumpfun_metadata_failed',
      collection_status: 'FAILED', observed_at: detectedAt,
      declared_link_count: '0', inspected_link_count: '0', evidence_count: '65',
      confirmed_evidence_count: '0', rejected_evidence_count: '0', unknown_evidence_count: '65',
    }];
    if (call.text.includes('FROM social_verification_evidence AS evidence')) return evidenceRows;
    return [];
  });

  const social = await new PostgresApiProjectionRepository(database).getLaunchSocial('mint-a');

  assert.equal(social?.status, 'AVAILABLE');
  if (social?.status !== 'AVAILABLE') return;
  assert.equal(social.collectionStatus, 'FAILED');
  assert.equal(social.linkCount, 0);
  assert.equal(social.evidenceCount, 65);
  assert.equal(social.evidence.length, 64);
  assert.equal(social.evidenceTruncated, true);
  assert.deepEqual(database.calls.at(-1)?.values, ['social_collection_failed', 64]);
});

void test('embeds the same immutable social projection in launch detail as the dedicated route', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    if (call.text.includes('token_metadata_snapshots')) return [];
    if (call.text.includes('bonding_curve_snapshots')) return [];
    if (call.text.includes('FROM migrations AS migration')) return [];
    if (call.text.includes('FROM creator_profiles')) return [];
    if (call.text.includes('FROM social_evidence_collections AS collection')) return [{
      collection_id: 'social_collection_empty', metadata_snapshot_id: 'pumpfun_metadata_empty',
      collection_status: 'COMPLETE', observed_at: detectedAt,
      declared_link_count: '0', inspected_link_count: '0', evidence_count: '0',
      confirmed_evidence_count: '0', rejected_evidence_count: '0', unknown_evidence_count: '0',
    }];
    return [];
  });
  const repository = new PostgresApiProjectionRepository(database);

  const detail = await repository.getLaunch('mint-a');
  const dedicated = await repository.getLaunchSocial('mint-a');

  assert.deepEqual(detail?.social, dedicated);
  assert.equal(detail?.social.status, 'AVAILABLE');
  assert.equal(Object.isFrozen(detail?.social ?? {}), true);
});

void test('expose les profils et positions observés avec des limites SQL bornées', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    if (call.text.includes('FROM creator_profiles')) return [{
      payload: toJsonValue({
        mint: 'mint-a',
        creator: 'creator',
        payloadVersion: 1,
        inputFingerprint: 'fingerprint',
        buyCount: 1,
        sellCount: 0,
        totalBoughtBaseRaw: 10n,
        totalSoldBaseRaw: 0n,
        observedNetBaseRaw: 10n,
        hasSold: false,
        firstSell: null,
        initialBuys: [],
        quoteFlows: [{
          quoteAsset: { mint: 'sol', decimals: 9, tokenProgram: 'SPL_TOKEN' },
          boughtQuoteRaw: 2n,
          soldQuoteRaw: 0n,
        }],
        uniqueExternalBuyers: 1,
        unknownTraderTradeCount: 0,
      }),
    }];
    if (call.text.includes('FROM token_holders_snapshots')) return [{
      snapshot_id: 'snapshot',
      input_fingerprint: 'fingerprint',
      observed_at: detectedAt,
      confirmation_status: 'confirmed',
      as_of_slot: '10',
      as_of_transaction_index: 0,
      as_of_instruction_index: 2,
      as_of_inner_instruction_index: null,
      total_positive_net_base_raw: '10',
      top1_bps: '10000',
      top5_bps: '10000',
      top10_bps: '10000',
      creator_bps: '0',
      unique_known_buyers: 1,
      unique_external_buyers: 1,
      positive_position_count: 1,
      unknown_trader_trade_count: 0,
    }];
    if (call.text.includes('FROM observed_wallet_positions')) return [{
      payload: toJsonValue({
        wallet: 'buyer',
        isCreator: false,
        buyCount: 1,
        sellCount: 0,
        boughtBaseRaw: 10n,
        soldBaseRaw: 0n,
        observedNetBaseRaw: 10n,
        quoteFlows: [],
        firstObservedCursor: {
          slot: 10n,
          transactionIndex: 0,
          instructionIndex: 2,
          innerInstructionIndex: null,
        },
        lastObservedCursor: {
          slot: 10n,
          transactionIndex: 0,
          instructionIndex: 2,
          innerInstructionIndex: null,
        },
      }),
    }];
    return [];
  });
  const repository = new PostgresApiProjectionRepository(
    database,
    () => detectedAt,
    { httpAvailable: true, pumpfun: 'IDLE', pumpswap: 'IDLE', paperDecision: 'IDLE', social: 'IDLE' },
    {
      positions: 1,
      snapshots: 2,
      clusters: 50,
      clusterMembers: 50,
      totalClusterMembers: 500,
    },
  );

  const holders = await repository.getLaunchHolders('mint-a');

  assert.deepEqual(holders, {
    status: 'AVAILABLE',
    methodology: 'OBSERVED_BONDING_CURVE_TRADES',
    creatorProfile: {
      mint: 'mint-a', creator: 'creator', buyCount: 1, sellCount: 0,
      totalBoughtBaseRaw: '10', totalSoldBaseRaw: '0', observedNetBaseRaw: '10',
      hasSold: false, firstSell: null, initialBuys: [],
      quoteFlows: [{
        quoteAsset: { mint: 'sol', decimals: 9, tokenProgram: 'SPL_TOKEN' },
        boughtQuoteRaw: '2', soldQuoteRaw: '0',
      }],
      uniqueExternalBuyers: 1, unknownTraderTradeCount: 0,
    },
    latestSnapshot: {
      id: 'snapshot', inputFingerprint: 'fingerprint',
      observedAt: detectedAt.toISOString(), confirmationStatus: 'confirmed',
      cursor: {
        slot: '10', transactionIndex: '0', instructionIndex: '2',
        innerInstructionIndex: null,
      },
      totalPositiveNetBaseRaw: '10', top1Bps: '10000', top5Bps: '10000',
      top10Bps: '10000', creatorBps: '0', uniqueKnownBuyers: 1,
      uniqueExternalBuyers: 1, positivePositionCount: 1,
      unknownTraderTradeCount: 0,
    },
    snapshots: [{
      id: 'snapshot', inputFingerprint: 'fingerprint',
      observedAt: detectedAt.toISOString(), confirmationStatus: 'confirmed',
      cursor: {
        slot: '10', transactionIndex: '0', instructionIndex: '2',
        innerInstructionIndex: null,
      },
      totalPositiveNetBaseRaw: '10', top1Bps: '10000', top5Bps: '10000',
      top10Bps: '10000', creatorBps: '0', uniqueKnownBuyers: 1,
      uniqueExternalBuyers: 1, positivePositionCount: 1,
      unknownTraderTradeCount: 0,
    }],
    positions: [{
      wallet: 'buyer', isCreator: false, buyCount: 1, sellCount: 0,
      boughtBaseRaw: '10', soldBaseRaw: '0', observedNetBaseRaw: '10',
      quoteFlows: [],
      firstObservedCursor: {
        slot: '10', transactionIndex: '0', instructionIndex: '2',
        innerInstructionIndex: null,
      },
      lastObservedCursor: {
        slot: '10', transactionIndex: '0', instructionIndex: '2',
        innerInstructionIndex: null,
      },
    }],
    clusters: [],
    clusterAnalysisStatus: 'NOT_AVAILABLE',
  });
  assert.deepEqual(
    database.calls.find((call) =>
      call.text.includes('FROM token_holders_snapshots')
      && call.text.includes('ORDER BY as_of_slot DESC'))?.values,
    ['mint-a', 2],
  );
  assert.deepEqual(
    database.calls.find((call) => call.text.includes('FROM observed_wallet_positions'))?.values,
    ['mint-a', 1],
  );
});

void test('utilise le snapshot de l’empreinte courante après orphaning', async () => {
  const current = {
    snapshot_id: 'current',
    input_fingerprint: 'current-fingerprint',
    observed_at: detectedAt,
    confirmation_status: 'confirmed',
    as_of_slot: '10',
    as_of_transaction_index: 0,
    as_of_instruction_index: 1,
    as_of_inner_instruction_index: null,
    total_positive_net_base_raw: '0',
    top1_bps: '0',
    top5_bps: '0',
    top10_bps: '0',
    creator_bps: '0',
    unique_known_buyers: 0,
    unique_external_buyers: 0,
    positive_position_count: 0,
    unknown_trader_trade_count: 0,
  };
  const stale = {
    ...current,
    snapshot_id: 'stale',
    input_fingerprint: 'stale-fingerprint',
    as_of_instruction_index: 2,
    total_positive_net_base_raw: '10',
    top1_bps: '10000',
    top5_bps: '10000',
    top10_bps: '10000',
    positive_position_count: 1,
  };
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    if (call.text.includes('FROM creator_profiles')) return [{
      payload: toJsonValue({
        mint: 'mint-a', creator: 'creator', payloadVersion: 1,
        inputFingerprint: 'current-fingerprint', buyCount: 0, sellCount: 0,
        totalBoughtBaseRaw: 0n, totalSoldBaseRaw: 0n, observedNetBaseRaw: 0n,
        hasSold: false, firstSell: null, initialBuys: [], quoteFlows: [],
        uniqueExternalBuyers: 0, unknownTraderTradeCount: 0,
      }),
    }];
    if (
      call.text.includes('FROM token_holders_snapshots')
      && call.text.includes('input_fingerprint = $2')
    ) return [current];
    if (call.text.includes('FROM token_holders_snapshots')) return [stale, current];
    return [];
  });

  const holders = await new PostgresApiProjectionRepository(database).getLaunchHolders('mint-a');

  assert.equal(holders?.status, 'AVAILABLE');
  if (holders?.status !== 'AVAILABLE') return;
  assert.equal(holders.latestSnapshot.id, 'current');
  assert.deepEqual(holders.snapshots.map((snapshot) => snapshot.id), ['stale', 'current']);
});

void test('exposes current clusters with per-cluster truncation and one shared member budget', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    if (call.text.includes('FROM creator_profiles')) return [creatorProfileRow()];
    if (call.text.includes('FROM token_holders_snapshots')) return [holderSnapshotRow()];
    if (call.text.includes('FROM observed_wallet_positions')) return [];
    if (call.text.includes('FROM wallet_graph_profiles')) return [{
      input_fingerprint: 'graph-current',
      methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS',
    }];
    if (call.text.includes('FROM wallet_graph_snapshots')) return [{
      input_fingerprint: 'graph-current',
      methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS',
      coverage: graphCoverage(),
      cluster_count: 3,
    }];
    if (call.text.includes('FROM wallet_clusters AS cluster')) return [
      clusterRow('cluster-high', '9000', '3', 40),
      clusterRow('cluster-low', '5000', '2'),
      clusterRow('cluster-truncated', '1000', '2'),
    ];
    if (call.text.includes('WITH ranked_members AS')) return [
      memberRow('cluster-high', 'buyer-a', '50'),
      memberRow('cluster-high', 'buyer-b', '25'),
      memberRow('cluster-low', 'buyer-c', '10'),
    ];
    return [];
  });
  const repository = new PostgresApiProjectionRepository(
    database,
    () => detectedAt,
    { httpAvailable: true, pumpfun: 'IDLE', pumpswap: 'IDLE', paperDecision: 'IDLE', social: 'IDLE' },
    {
      positions: 1,
      snapshots: 1,
      clusters: 2,
      clusterMembers: 2,
      totalClusterMembers: 3,
    },
  );

  const holders = await repository.getLaunchHolders('mint-a');

  assert.equal(holders?.status, 'AVAILABLE');
  if (holders?.status !== 'AVAILABLE') return;
  assert.equal(holders.clusterAnalysisStatus, 'AVAILABLE');
  if (holders.clusterAnalysisStatus !== 'AVAILABLE') return;
  assert.equal(holders.clusterCount, 3);
  assert.equal(holders.clustersTruncated, true);
  assert.deepEqual(holders.clusters.map((cluster) => cluster.id), [
    'cluster-high',
    'cluster-low',
  ]);
  assert.deepEqual(holders.clusters.map((cluster) => cluster.members.length), [2, 1]);
  assert.equal(holders.clusters[0]?.quoteAssets.length, 8);
  assert.equal(holders.clusters[0]?.quoteAssetCount, 40);
  assert.equal(holders.clusters[0]?.quoteAssetsTruncated, true);
  assert.deepEqual(holders.clusters.map((cluster) => cluster.membersTruncated), [
    true,
    true,
  ]);
  assert.equal(
    holders.clusters.reduce((count, cluster) => count + cluster.members.length, 0),
    3,
  );
  assert.deepEqual(
    database.calls.find((call) =>
      call.text.includes('FROM wallet_clusters AS cluster'))?.values,
    ['mint-a', 'graph-current', 3],
  );
  assert.deepEqual(
    database.calls.find((call) =>
      call.text.includes('WITH ranked_members AS'))?.values,
    ['mint-a', 'graph-current', ['cluster-high', 'cluster-low'], 2, 3],
  );
  assert.equal(database.calls.some((call) =>
    call.text.includes('FROM wallet_relationships')), false);
});

void test('distinguishes a successful zero-cluster analysis from unavailable graph data', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    if (call.text.includes('FROM creator_profiles')) return [creatorProfileRow()];
    if (call.text.includes('FROM token_holders_snapshots')) return [holderSnapshotRow()];
    if (call.text.includes('FROM observed_wallet_positions')) return [];
    if (call.text.includes('FROM wallet_graph_profiles')) return [{
      input_fingerprint: 'graph-empty',
      methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS',
    }];
    if (call.text.includes('FROM wallet_graph_snapshots')) return [{
      input_fingerprint: 'graph-empty',
      methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS',
      coverage: graphCoverage(),
      cluster_count: 0,
    }];
    return [];
  });
  const holders = await new PostgresApiProjectionRepository(database)
    .getLaunchHolders('mint-a');
  assert.equal(holders?.status, 'AVAILABLE');
  if (holders?.status !== 'AVAILABLE') return;
  assert.equal(holders.clusterAnalysisStatus, 'AVAILABLE');
  if (holders.clusterAnalysisStatus !== 'AVAILABLE') return;
  assert.deepEqual(holders.clusters, []);
  assert.equal(holders.clusterCount, 0);
  assert.equal(holders.clustersTruncated, false);
});

void test('shares one bounded quote-asset budget across emitted clusters', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    if (call.text.includes('FROM creator_profiles')) return [creatorProfileRow()];
    if (call.text.includes('FROM token_holders_snapshots')) return [holderSnapshotRow()];
    if (call.text.includes('FROM observed_wallet_positions')) return [];
    if (call.text.includes('FROM wallet_graph_profiles')) return [{
      input_fingerprint: 'graph-quotes',
      methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS',
    }];
    if (call.text.includes('FROM wallet_graph_snapshots')) return [{
      input_fingerprint: 'graph-quotes',
      methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS',
      coverage: graphCoverage(),
      cluster_count: 9,
    }];
    if (call.text.includes('FROM wallet_clusters AS cluster')) {
      return Array.from({ length: 9 }, (_, index) =>
        clusterRow(`cluster-${index}`, '1000', '0', 40));
    }
    if (call.text.includes('WITH ranked_members AS')) return [];
    return [];
  });
  const repository = new PostgresApiProjectionRepository(
    database,
    () => detectedAt,
    { httpAvailable: true, pumpfun: 'IDLE', pumpswap: 'IDLE', paperDecision: 'IDLE', social: 'IDLE' },
    {
      positions: 1,
      snapshots: 1,
      clusters: 9,
      clusterMembers: 1,
      totalClusterMembers: 1,
    },
  );

  const holders = await repository.getLaunchHolders('mint-a');

  assert.equal(holders?.status, 'AVAILABLE');
  if (holders?.status !== 'AVAILABLE'
    || holders.clusterAnalysisStatus !== 'AVAILABLE') return;
  assert.equal(holders.clusters.reduce(
    (count, cluster) => count + cluster.quoteAssets.length,
    0,
  ), 64);
  assert.equal(holders.clusters[8]?.quoteAssets.length, 0);
  assert.equal(holders.clusters[8]?.quoteAssetsTruncated, true);
});

void test('rejects a graph snapshot whose current cluster rows are incomplete', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('FROM token_launches AS launch')) return [launch('mint-a')];
    if (call.text.includes('FROM creator_profiles')) return [creatorProfileRow()];
    if (call.text.includes('FROM token_holders_snapshots')) return [holderSnapshotRow()];
    if (call.text.includes('FROM wallet_graph_profiles')) return [{
      input_fingerprint: 'graph-incomplete',
      methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS',
    }];
    if (call.text.includes('FROM wallet_graph_snapshots')) return [{
      input_fingerprint: 'graph-incomplete',
      methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS',
      coverage: graphCoverage(),
      cluster_count: 1,
    }];
    return [];
  });

  await assert.rejects(
    new PostgresApiProjectionRepository(database).getLaunchHolders('mint-a'),
    ApiProjectionDataError,
  );
});

void test('orders domain events and explicit transitions by the complete cursor', async () => {
  const database = new FakeQueryable((call) => {
    if (
      call.text.includes('WITH timeline')
      && call.text.includes('UNION ALL')
      && call.text.includes('FROM state_transitions AS transition')
      && call.text.includes('transition.mint = $1')
      && call.text.includes('domain_event.event_id = transition.event_id')
      && call.text.includes('jsonb_build_object')
      && call.text.includes('ORDER BY slot, transaction_index, instruction_index, inner_sort, id')
    ) return [{
      id: 'domain-1', type: 'QualificationUpdated', occurred_at: detectedAt,
      slot: '900719925474099312345', transaction_index: 1, instruction_index: 2,
      inner_instruction_index: null, confirmation_status: 'confirmed', payload_version: 1,
      payload: { score: 90, amount: '42' },
    }, {
      id: 'transition-1', type: 'TokenLaunchDetected', occurred_at: openedAt,
      slot: '900719925474099312346', transaction_index: 0, instruction_index: 0,
      inner_instruction_index: 1, confirmation_status: 'finalized', payload_version: 1,
      payload: { previousStatus: null, newStatus: 'DETECTED', reasonCode: null, message: 'Token launch detected', evidence: {} },
    }];
    return [];
  });

  const page = await new PostgresApiProjectionRepository(database).listLaunchEvents('mint-a', { limit: 10, after: null });
  const entries = page.items;

  assert.deepEqual(entries, [{
    id: 'domain-1', type: 'QualificationUpdated', occurredAt: detectedAt.toISOString(),
    slot: '900719925474099312345', confirmationStatus: 'confirmed', payloadVersion: 1,
    payload: { score: 90, amount: '42' },
  }, {
    id: 'transition-1', type: 'TokenLaunchDetected', occurredAt: openedAt.toISOString(),
    slot: '900719925474099312346', confirmationStatus: 'finalized', payloadVersion: 1,
    payload: { previousStatus: null, newStatus: 'DETECTED', reasonCode: null, message: 'Token launch detected', evidence: {} },
  }]);
  assert.match(database.calls[0]?.text ?? '', /WITH timeline/u);
  assert.match(database.calls[0]?.text ?? '', /COALESCE\(domain_event\.inner_instruction_index, -1\) AS inner_sort/u);
  assert.match(database.calls[0]?.text ?? '', /ORDER BY slot, transaction_index, instruction_index, inner_sort, id/u);
  assert.equal(Object.isFrozen(entries), true);
  assert.equal(Object.isFrozen(entries[0]?.payload ?? {}), true);
  assert.equal(page.nextCursor, null);
});

function creatorProfileRow(): Record<string, unknown> {
  return {
    payload: toJsonValue({
      mint: 'mint-a',
      creator: 'creator',
      payloadVersion: 1,
      inputFingerprint: 'holder-current',
      buyCount: 0,
      sellCount: 0,
      totalBoughtBaseRaw: 0n,
      totalSoldBaseRaw: 0n,
      observedNetBaseRaw: 0n,
      hasSold: false,
      firstSell: null,
      initialBuys: [],
      quoteFlows: [],
      uniqueExternalBuyers: 0,
      unknownTraderTradeCount: 0,
    }),
  };
}

function holderSnapshotRow(): Record<string, unknown> {
  return {
    snapshot_id: 'holder-current',
    input_fingerprint: 'holder-current',
    observed_at: detectedAt,
    confirmation_status: 'confirmed',
    as_of_slot: '10',
    as_of_transaction_index: 0,
    as_of_instruction_index: 1,
    as_of_inner_instruction_index: null,
    total_positive_net_base_raw: '0',
    top1_bps: '0',
    top5_bps: '0',
    top10_bps: '0',
    creator_bps: '0',
    unique_known_buyers: 0,
    unique_external_buyers: 0,
    positive_position_count: 0,
    unknown_trader_trade_count: 0,
  };
}

function graphCoverage(): Record<string, number> {
  return {
    knownBuyCount: 3,
    knownBuyerCount: 3,
    strongEvidenceBuyCount: 2,
    strongEvidenceBuyerCount: 2,
    mediumOnlyBuyCount: 0,
    mediumOnlyBuyerCount: 0,
    noEvidenceBuyCount: 0,
    noEvidenceBuyerCount: 0,
    unavailableBuyCount: 0,
    unavailableBuyerCount: 0,
    notProcessedBuyCount: 1,
    notProcessedBuyerCount: 1,
    analyzedTransactionCount: 2,
    evidenceCount: 2,
  };
}

function clusterRow(
  clusterId: string,
  concentrationBps: string,
  memberCount: string,
  quoteAssetCount = 1,
): Record<string, unknown> {
  return {
    cluster_id: clusterId,
    quote_assets: Array.from({ length: quoteAssetCount }, (_, index) => ({
      mint: `quote-mint-${index.toString().padStart(3, '0')}`,
      decimals: 9,
      tokenProgram: 'SPL_TOKEN',
    })),
    participant_wallet_count: 2,
    auxiliary_wallet_count: 1,
    positive_holder_count: 2,
    observed_positive_base_raw: '75',
    concentration_bps: concentrationBps,
    contains_creator: false,
    shared_funder_count: 1,
    strong_relationship_count: 2,
    strong_evidence_count: 2,
    member_count: memberCount,
  };
}

function memberRow(
  clusterId: string,
  wallet: string,
  observedNetBaseRaw: string,
): Record<string, unknown> {
  return {
    cluster_id: clusterId,
    wallet,
    member_role: 'PARTICIPANT',
    is_creator: false,
    observed_net_base_raw: observedNetBaseRaw,
    member_rank: '1',
  };
}

void test('wraps invalid timeline payload conversion in a safe projection error', async () => {
  const repository = new PostgresApiProjectionRepository(new FakeQueryable(() => [{
    id: 'bad', type: 'QualificationUpdated', occurred_at: detectedAt, slot: '1', transaction_index: 0,
    instruction_index: 0, inner_instruction_index: null, confirmation_status: 'confirmed', payload_version: 1,
    payload: { amount: 42 },
  }]));
  await assert.rejects(repository.listLaunchEvents('mint-a', { limit: 10, after: null }), (error: unknown) => {
    assert.ok(error instanceof ApiProjectionDataError);
    assert.equal(error.message, 'Stored API projection data is invalid.');
    assert.ok(error.cause instanceof TypeError);
    return true;
  });
});

void test('restores bigint markers in timeline JSONB as exact decimal strings', async () => {
  const database = new FakeQueryable(() => [{
    id: 'bigint', type: 'QualificationUpdated', occurred_at: detectedAt, slot: '5',
    transaction_index: 0, instruction_index: 0, inner_instruction_index: null,
    confirmation_status: 'confirmed', payload_version: 1,
    payload: { amount: { $solTokenListenerBigInt: '900719925474099312345' } },
  }]);

  const page = await new PostgresApiProjectionRepository(database)
    .listLaunchEvents('mint-a', { limit: 10, after: null });

  assert.deepEqual(page.items[0]?.payload, { amount: '900719925474099312345' });
});

void test('paginates a timeline with the complete ascending keyset', async () => {
  const database = new FakeQueryable(() => [{
    id: 'event-a', type: 'QualificationUpdated', occurred_at: detectedAt, slot: '10',
    transaction_index: 1, instruction_index: 2, inner_instruction_index: null,
    confirmation_status: 'confirmed', payload_version: 1, payload: {},
  }, {
    id: 'event-b', type: 'QualificationUpdated', occurred_at: openedAt, slot: '10',
    transaction_index: 1, instruction_index: 2, inner_instruction_index: 3,
    confirmation_status: 'confirmed', payload_version: 1, payload: {},
  }]);
  const after = {
    slot: '9', transactionIndex: 4, instructionIndex: 5, innerInstructionIndex: null, id: 'previous',
  };
  const page = await new PostgresApiProjectionRepository(database)
    .listLaunchEvents('mint-a', { limit: 1, after });

  assert.deepEqual(database.calls[0]?.values, ['mint-a', '9', 4, 5, -1, 'previous', 2]);
  assert.match(database.calls[0]?.text ?? '', /\(slot, transaction_index, instruction_index, inner_sort, id\)\s*>\s*\(\$2::numeric, \$3::integer, \$4::integer, \$5::integer, \$6::text\)/u);
  assert.equal(page.items[0]?.id, 'event-a');
  assert.equal(page.nextCursor, encodeTimelineCursor({
    slot: '10', transactionIndex: 1, instructionIndex: 2, innerInstructionIndex: null, id: 'event-a',
  }));
});

void test('rejects timeline PostgreSQL integer overflow before querying', async () => {
  const database = new FakeQueryable(() => []);
  const repository = new PostgresApiProjectionRepository(database);

  await assert.rejects(repository.listLaunchEvents('mint-a', {
    limit: 1,
    after: {
      slot: '1', transactionIndex: MAX_TIMELINE_INDEX + 1, instructionIndex: 0,
      innerInstructionIndex: null, id: 'event',
    },
  }), ApiProjectionDataError);
  assert.equal(database.calls.length, 0);
});

void test('uses the latest non-orphaned qualification event and rejects malformed data safely', async () => {
  const report = {
    ruleSet: { id: 'rules', version: 1, status: 'UNVALIDATED_RULE_SET', minimumTotalScore: 60 },
    scores: {
      preparation: { score: 1, maximum: 2 }, socialAuthenticity: { score: 3, maximum: 4 },
      onchainHealth: { score: 5, maximum: 6 }, total: { score: 9, maximum: 12 },
    }, evidence: [], blockers: [], verdict: 'QUALIFIED', evaluatedAtMs: detectedAt.getTime(),
  };
  const database = new FakeQueryable((call) => call.text.includes('QualificationUpdated')
    ? [{ payload: report }] : []);
  const value = await new PostgresApiProjectionRepository(database).getLaunchRisk('mint-a');
  assert.deepEqual(value, {
    ruleSet: { ...report.ruleSet, fingerprint: null }, scores: report.scores, evidence: report.evidence,
    conditions: [], blockers: report.blockers, verdict: report.verdict,
    evaluatedAt: detectedAt.toISOString(),
  });
  assert.match(database.calls[0]?.text ?? '', /confirmation_status <> 'orphaned'/u);
  assert.match(
    database.calls[0]?.text ?? '',
    /ORDER BY\s+slot DESC,\s*transaction_index DESC,\s*instruction_index DESC,\s*COALESCE\(inner_instruction_index, -1\) DESC,\s*event_id DESC/u,
  );

  const malformed = new PostgresApiProjectionRepository(new FakeQueryable(() => [{ payload: '{bad json' }]));
  await assert.rejects(malformed.getLaunchRisk('mint-a'), ApiProjectionDataError);
});

void test('projects calibrated qualification evidence as canonical V1 condition fields', async () => {
  const report = {
    ruleSet: {
      id: 'rules', version: 1, status: 'UNVALIDATED_RULE_SET', minimumTotalScore: 60,
      fingerprint: 'a'.repeat(64),
    },
    scores: {
      preparation: { score: 1, maximum: 2 }, socialAuthenticity: { score: 3, maximum: 4 },
      onchainHealth: { score: 5, maximum: 6 }, total: { score: 9, maximum: 12 },
    },
    evidence: [], conditions: calibratedConditions(),
    blockers: [], verdict: 'QUALIFIED', evaluatedAtMs: detectedAt.getTime(),
  };
  const databasePayload = JSON.parse(JSON.stringify(toJsonValue(report))) as unknown;
  const repository = new PostgresApiProjectionRepository(new FakeQueryable(() => [{ payload: databasePayload }]));

  const value = await repository.getLaunchRisk('mint-a');

  assert.deepEqual(value?.ruleSet.fingerprint, 'a'.repeat(64));
  assert.deepEqual(value?.conditions.find((item) => item.code === 'ROUND_TRIP_LOSS_EXCEEDED'), {
    code: 'ROUND_TRIP_LOSS_EXCEEDED', mode: 'ENFORCED', status: 'TRIGGERED',
    observed: { roundTripLossBps: '3001' }, thresholds: { maximumRoundTripLossBps: '3000' },
    message: 'Perte aller-retour supérieure au seuil configuré.',
  });
  assert.equal(Object.isFrozen(value?.conditions), true);
  assert.equal(Object.isFrozen(value?.conditions[0]?.observed), true);
});

void test('rejects incomplete or malformed calibrated qualification evidence fail closed', async () => {
  const valid = {
    ruleSet: {
      id: 'rules', version: 1, status: 'UNVALIDATED_RULE_SET', minimumTotalScore: 60,
      fingerprint: 'a'.repeat(64),
    },
    scores: {
      preparation: { score: 1, maximum: 2 }, socialAuthenticity: { score: 3, maximum: 4 },
      onchainHealth: { score: 5, maximum: 6 }, total: { score: 9, maximum: 12 },
    }, evidence: [], blockers: [], verdict: 'QUALIFIED', evaluatedAtMs: detectedAt.getTime(),
    conditions: calibratedConditions(),
  };
  const roundTripIndex = QUALIFICATION_REASON_CODES.indexOf('ROUND_TRIP_LOSS_EXCEEDED');
  const malformed: readonly unknown[] = [
    { ...valid, ruleSet: { ...valid.ruleSet, fingerprint: undefined } },
    { ...valid, conditions: undefined },
    { ...valid, ruleSet: { ...valid.ruleSet, fingerprint: 'A'.repeat(64) } },
    { ...valid, conditions: valid.conditions.map((item, index) => index === roundTripIndex ? { ...item, observed: { roundTripLossBps: '03' } } : item) },
    { ...valid, conditions: valid.conditions.map((item, index) => index === roundTripIndex ? { ...item, observed: { roundTripLossBps: ['3001'] } } : item) },
    { ...valid, conditions: valid.conditions.map((item, index) => index === roundTripIndex ? { ...item, observed: { roundTripLossBps: { $solTokenListenerBigInt: '03' } } } : item) },
    { ...valid, conditions: valid.conditions.map((item, index) => index === roundTripIndex ? { ...item, observed: { roundTripLossBps: { $solTokenListenerBigInt: '-0' } } } : item) },
    { ...valid, conditions: valid.conditions.map((item, index) => index === roundTripIndex ? { ...item, observed: { roundTripLossBps: { $solTokenListenerBigInt: '10001' } } } : item) },
    { ...valid, conditions: valid.conditions.map((item, index) => index === roundTripIndex ? { ...item, observed: { roundTripLossBps: { $solTokenListenerBigInt: '3001', extra: true } } } : item) },
    { ...valid, conditions: valid.conditions.map((item, index) => index === roundTripIndex ? { ...item, mode: 'UNKNOWN' } : item) },
    { ...valid, conditions: valid.conditions.map((item, index) => index === roundTripIndex ? { ...item, status: 'INVALID' } : item) },
    { ...valid, conditions: valid.conditions.map((item, index) => index === roundTripIndex ? { ...item, code: 'INVALID' } : item) },
    { ...valid, conditions: valid.conditions.map((item, index) => index === roundTripIndex ? { ...item, unexpected: true } : item) },
    { ...valid, conditions: valid.conditions.map((item, index) => index === roundTripIndex ? { ...item, observed: { roundTripLossBps: 9_007_199_254_740_992 } } : item) },
    { ...valid, conditions: valid.conditions.slice(0, -1) },
  ];

  for (const payload of malformed) {
    const repository = new PostgresApiProjectionRepository(new FakeQueryable(() => [{ payload }]));
    await assert.rejects(repository.getLaunchRisk('mint-a'), ApiProjectionDataError);
  }
});

void test('requires new calibrated qualifications to use the complete canonical condition registry', async () => {
  const valid = {
    ruleSet: { id: 'rules', version: 1, status: 'UNVALIDATED_RULE_SET', minimumTotalScore: 60, fingerprint: 'a'.repeat(64) },
    scores: { preparation: { score: 1, maximum: 2 }, socialAuthenticity: { score: 3, maximum: 4 }, onchainHealth: { score: 5, maximum: 6 }, total: { score: 9, maximum: 12 } },
    evidence: [], blockers: [], verdict: 'QUALIFIED', evaluatedAtMs: detectedAt.getTime(), conditions: calibratedConditions(),
  };
  const reordered = [...valid.conditions];
  const first = reordered[0];
  const second = reordered[1];
  if (first === undefined || second === undefined) throw new Error('Missing canonical conditions.');
  reordered[0] = second;
  reordered[1] = first;
  const disabled = valid.conditions.map((item) => item.code === 'CREATOR_EARLY_SELL'
    ? { ...item, mode: 'DISABLED', status: 'PASSED' } : item);
  const statusDisabled = valid.conditions.map((item) => item.code === 'CREATOR_EARLY_SELL'
    ? { ...item, status: 'DISABLED' } : item);

  for (const conditions of [[], valid.conditions.slice(0, -1), reordered, disabled, statusDisabled]) {
    const repository = new PostgresApiProjectionRepository(new FakeQueryable(() => [{ payload: { ...valid, conditions } }]));
    await assert.rejects(repository.getLaunchRisk('mint-a'), ApiProjectionDataError);
  }
});

void test('enforces shared-funder observation and threshold bounds exactly', async () => {
  const conditions = calibratedConditions();
  const index = QUALIFICATION_REASON_CODES.indexOf('SHARED_FUNDER_CLUSTER');
  const shared = conditions[index];
  if (shared === undefined) throw new Error('Missing shared-funder condition.');
  const valid = {
    ruleSet: { id: 'rules', version: 1, status: 'UNVALIDATED_RULE_SET', minimumTotalScore: 60, fingerprint: 'a'.repeat(64) },
    scores: { preparation: { score: 1, maximum: 2 }, socialAuthenticity: { score: 3, maximum: 4 }, onchainHealth: { score: 5, maximum: 6 }, total: { score: 9, maximum: 12 } },
    evidence: [], blockers: [], verdict: 'QUALIFIED', evaluatedAtMs: detectedAt.getTime(), conditions,
  };
  for (const replacement of [
    { ...shared, observed: { maximumSharedFunderCount: -0 } },
    { ...shared, observed: { maximumSharedFunderCount: 0.5 } },
    { ...shared, thresholds: { minimumSharedFunders: 0 } },
    { ...shared, thresholds: { minimumSharedFunders: 10_001 } },
  ]) {
    const invalidConditions = [...conditions];
    invalidConditions[index] = replacement;
    const repository = new PostgresApiProjectionRepository(new FakeQueryable(() => [{ payload: { ...valid, conditions: invalidConditions } }]));
    await assert.rejects(repository.getLaunchRisk('mint-a'), ApiProjectionDataError);
  }
});

void test('rejects hostile qualification payload descriptors and proxies without leaking trap secrets', async () => {
  const secret = 'qualification-trap-secret';
  let proxyTrapCalled = false;
  const proxy = new Proxy({}, {
    getPrototypeOf: () => { proxyTrapCalled = true; throw new Error(secret); },
    get: () => { proxyTrapCalled = true; throw new Error(secret); },
  });
  const accessor = {};
  Object.defineProperty(accessor, 'ruleSet', {
    enumerable: true,
    get: () => { throw new Error(secret); },
  });
  for (const payload of [proxy, accessor]) {
    const repository = new PostgresApiProjectionRepository(new FakeQueryable(() => [{ payload }]));
    await assert.rejects(repository.getLaunchRisk('mint-a'), (error: unknown) => {
      assert.ok(error instanceof ApiProjectionDataError);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
  assert.equal(proxyTrapCalled, false);
});

void test('projects complete engine evidence from calibrated and legacy persisted reports', async () => {
  const report = new QualificationEngine(createDefaultQualificationRuleSet(60)).evaluate({
    evaluatedAtMs: detectedAt.getTime(), signals: {}, blockers: [], calibrationFacts: null,
  });
  const calibrated = JSON.parse(JSON.stringify(toJsonValue(report))) as Record<string, unknown>;
  const legacy = JSON.parse(JSON.stringify(toJsonValue(report))) as Record<string, unknown>;
  const legacyRuleSet = legacy.ruleSet as Record<string, unknown>;
  Reflect.deleteProperty(legacyRuleSet, 'fingerprint');
  Reflect.deleteProperty(legacy, 'conditions');

  for (const payload of [calibrated, legacy]) {
    const repository = new PostgresApiProjectionRepository(new FakeQueryable(() => [{ payload }]));
    const value = await repository.getLaunchRisk('mint-a');
    assert.deepEqual(value?.evidence, report.evidence.map(({ signal, status, message }) => ({ signal, status, message })));
  }

  for (const change of [
    { dimension: 'invalid' },
    { required: 'true' },
    { weight: 101 },
  ]) {
    const corrupt = JSON.parse(JSON.stringify(toJsonValue(report))) as Record<string, unknown>;
    const evidence = corrupt.evidence as Record<string, unknown>[];
    evidence[0] = { ...evidence[0], ...change };
    const repository = new PostgresApiProjectionRepository(new FakeQueryable(() => [{ payload: corrupt }]));
    await assert.rejects(repository.getLaunchRisk('mint-a'), ApiProjectionDataError);
  }
});

void test('lists paper positions by stable keyset without decimal coercion', async () => {
  const database = new FakeQueryable(() => [{
    position_id: 'position-a', mint: 'mint-a', status: 'PAPER_HOLDING', opened_at: openedAt,
    closed_at: null, quote_mint: 'quote', remaining_base_raw: '100000000000000000001',
    strategy_id: 'strategy', strategy_version: 1, strategy_session_id: null,
    qualification_report_id: null, candidate_id: null, external_buy_count: null,
    external_buy_target: null, reason_codes: null, entry_venue: 'UNKNOWN',
    quote_cost_raw: '200000000000000000002', quote_proceeds_raw: null,
    net_pnl_quote_raw: null, round_trip_loss_bps: '17', entry_fees_raw: '7',
    exit_trade_id: null, exit_fees_raw: null,
  }, {
    position_id: 'position-b', mint: 'mint-b', status: 'PAPER_CLOSED', opened_at: openedAt,
    closed_at: detectedAt, quote_mint: 'quote', remaining_base_raw: '0', quote_cost_raw: '2',
    strategy_id: 'strategy', strategy_version: 1, strategy_session_id: null,
    qualification_report_id: null, candidate_id: null, external_buy_count: null,
    external_buy_target: null, reason_codes: null, entry_venue: 'UNKNOWN',
    quote_proceeds_raw: '3', net_pnl_quote_raw: '1', round_trip_loss_bps: '4',
    entry_fees_raw: '8', exit_trade_id: 'exit-b', exit_fees_raw: '13',
  }]);
  const page = await new PostgresApiProjectionRepository(database).listPaperPositions({ limit: 1, after: null });

  assert.deepEqual(page, {
    items: [{
      id: 'position-a', mint: 'mint-a', status: 'PAPER_HOLDING', openedAt: openedAt.toISOString(),
      closedAt: null, quoteMint: 'quote', quantity: '100000000000000000001',
      entryQuoteAmount: '200000000000000000002', exitQuoteAmount: null,
      realizedPnlQuote: null, estimatedFeesQuote: '7',
      strategyId: 'strategy', strategyVersion: 1, strategySessionId: null,
      qualificationReportId: null, candidateId: null, externalBuyCount: null,
      externalBuyTarget: null, entryVenue: 'UNKNOWN', reasonCodes: [],
    }], nextCursor: encodePaperPositionCursor({ openedAtMs: openedAt.getTime(), id: 'position-a' }),
  });
  assert.match(database.calls[0]?.text ?? '', /position\.opened_at DESC, position\.position_id ASC/u);
  assert.deepEqual(database.calls[0]?.values, [2]);
  assert.match(database.calls[0]?.text ?? '', /position\.position_id/u);
  assert.match(database.calls[0]?.text ?? '', /position\.opened_at DESC, position\.position_id ASC/u);
});

void test('adds exact entry and exit fees for a closed paper position', async () => {
  const database = new FakeQueryable(() => [{
    position_id: 'position-b', mint: 'mint-b', status: 'PAPER_CLOSED', opened_at: openedAt,
    closed_at: detectedAt, quote_mint: 'quote', remaining_base_raw: '0', quote_cost_raw: '2',
    strategy_id: 'strategy', strategy_version: 1, strategy_session_id: null,
    qualification_report_id: null, candidate_id: null, external_buy_count: null,
    external_buy_target: null, reason_codes: null, entry_venue: 'UNKNOWN',
    quote_proceeds_raw: '3', net_pnl_quote_raw: '1',
    entry_fees_raw: '900719925474099312345', exit_trade_id: 'exit-b', exit_fees_raw: '11',
  }]);

  const page = await new PostgresApiProjectionRepository(database)
    .listPaperPositions({ limit: 1, after: null });

  assert.equal(page.items[0]?.estimatedFeesQuote, '900719925474099312356');
  assert.match(database.calls[0]?.text ?? '', /LEFT JOIN paper_trades AS exit_trade/u);
});

void test('exposes paper position lineage, progress, venue and stable reasons', async () => {
  const database = new FakeQueryable(() => [{
    position_id: 'position-progress', mint: 'mint-a', status: 'PAPER_HOLDING',
    opened_at: openedAt, closed_at: null, quote_mint: 'quote', remaining_base_raw: '50',
    quote_cost_raw: '100', quote_proceeds_raw: null, net_pnl_quote_raw: null,
    entry_fees_raw: '2', exit_trade_id: null, exit_fees_raw: null,
    strategy_id: 'validated-external-buys', strategy_version: 1,
    strategy_session_id: `paper_session_${'a'.repeat(64)}`,
    qualification_report_id: `qreport_${'b'.repeat(64)}`,
    candidate_id: `candidate_${'c'.repeat(64)}`,
    external_buy_count: 7, external_buy_target: 10,
    reason_codes: ['QUALIFIED_ENTRY', 'EXTERNAL_BUY_OBSERVED'],
    entry_venue: 'PUMPSWAP',
  }]);

  const page = await new PostgresApiProjectionRepository(database)
    .listPaperPositions({ limit: 1, after: null });

  assert.deepEqual(page.items[0], {
    id: 'position-progress', mint: 'mint-a', status: 'PAPER_HOLDING',
    openedAt: openedAt.toISOString(), closedAt: null, quoteMint: 'quote', quantity: '50',
    entryQuoteAmount: '100', exitQuoteAmount: null, realizedPnlQuote: null,
    estimatedFeesQuote: '2', strategyId: 'validated-external-buys', strategyVersion: 1,
    strategySessionId: `paper_session_${'a'.repeat(64)}`,
    qualificationReportId: `qreport_${'b'.repeat(64)}`,
    candidateId: `candidate_${'c'.repeat(64)}`,
    externalBuyCount: 7, externalBuyTarget: 10, entryVenue: 'PUMPSWAP',
    reasonCodes: ['QUALIFIED_ENTRY', 'EXTERNAL_BUY_OBSERVED'],
  });
  assert.match(database.calls[0]?.text ?? '', /FROM market_pools AS entry_pool/u);
});

void test('rejects a closed paper position without a persisted exit trade', async () => {
  const database = new FakeQueryable(() => [{
    position_id: 'position-b', mint: 'mint-b', status: 'PAPER_CLOSED', opened_at: openedAt,
    closed_at: detectedAt, quote_mint: 'quote', remaining_base_raw: '0', quote_cost_raw: '2',
    strategy_id: 'strategy', strategy_version: 1, strategy_session_id: null,
    qualification_report_id: null, candidate_id: null, external_buy_count: null,
    external_buy_target: null, reason_codes: null, entry_venue: 'UNKNOWN',
    quote_proceeds_raw: '3', net_pnl_quote_raw: '1',
    entry_fees_raw: '5', exit_trade_id: null, exit_fees_raw: null,
  }]);

  await assert.rejects(
    new PostgresApiProjectionRepository(database).listPaperPositions({ limit: 1, after: null }),
    ApiProjectionDataError,
  );
});

void test('uses a strict paper keyset and encodes the final emitted position', async () => {
  const database = new FakeQueryable(() => [{
    position_id: 'position-c', mint: 'mint-c', status: 'PAPER_HOLDING', opened_at: openedAt,
    closed_at: null, quote_mint: 'quote', remaining_base_raw: '1', quote_cost_raw: '2',
    strategy_id: 'strategy', strategy_version: 1, strategy_session_id: null,
    qualification_report_id: null, candidate_id: null, external_buy_count: null,
    external_buy_target: null, reason_codes: null, entry_venue: 'UNKNOWN',
    quote_proceeds_raw: null, net_pnl_quote_raw: null, entry_fees_raw: '3',
  }, {
    position_id: 'position-d', mint: 'mint-d', status: 'PAPER_HOLDING', opened_at: openedAt,
    closed_at: null, quote_mint: 'quote', remaining_base_raw: '1', quote_cost_raw: '2',
    strategy_id: 'strategy', strategy_version: 1, strategy_session_id: null,
    qualification_report_id: null, candidate_id: null, external_buy_count: null,
    external_buy_target: null, reason_codes: null, entry_venue: 'UNKNOWN',
    quote_proceeds_raw: null, net_pnl_quote_raw: null, entry_fees_raw: '3',
  }]);
  const page = await new PostgresApiProjectionRepository(database).listPaperPositions({
    limit: 1, after: { openedAtMs: openedAt.getTime(), id: 'position-b' },
  });
  assert.equal(page.nextCursor, encodePaperPositionCursor({ openedAtMs: openedAt.getTime(), id: 'position-c' }));
  assert.match(database.calls[0]?.text ?? '', /position\.opened_at < \$1[\s\S]*position\.opened_at = \$1[\s\S]*position\.position_id > \$2/u);
  assert.deepEqual(database.calls[0]?.values, [openedAt, 'position-b', 2]);
});

void test('returns health without exposing database URLs or secrets', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('SELECT 1 AS available')) return [{ available: 1 }];
    if (call.text.includes('processing_checkpoints')) return [{ checkpoint_key: 'launchpad', slot: '55' }, { checkpoint_key: 'market', slot: '54' }];
    if (call.text.includes('listener_heartbeats')) return [{
      updated_at: openedAt, last_http_slot: '60', last_websocket_slot: '59',
      last_finalized_slot: '58', last_signature: 'signature', pending_transactions: 0, active_sessions: 1,
      runtime_state: 'RUNNING', subscriber_state: 'RUNNING', scanner_state: 'RUNNING',
      worker_state: 'RUNNING', reconciler_state: 'RUNNING', started_at: openedAt,
      leased_transactions: 0, exhausted_transactions: 2,
    }];
    if (call.text.includes('FROM social_enrichment_jobs')) return [{
      pending_count: 2, leased_count: 1, retryable_failed_count: 3, exhausted_count: 4,
    }];
    if (call.text.includes('FROM paper_decision_jobs')) return [{
      pending_count: 5, leased_count: 2, retryable_failed_count: 1, exhausted_count: 3,
      last_success_at: openedAt, last_error_code: 'QUOTE_UNAVAILABLE',
    }];
    return [];
  });
  const repository = new PostgresApiProjectionRepository(database, () => openedAt, {
    httpAvailable: false, pumpfun: 'RUNNING', pumpswap: 'IDLE', paperDecision: 'IDLE', social: 'RUNNING',
  });
  const health = await repository.getHealth();

  assert.deepEqual(health, {
    status: 'DEGRADED', observedAt: openedAt.toISOString(),
    postgresql: { status: 'AVAILABLE' }, http: { status: 'UNAVAILABLE' },
    pipeline: { pumpfun: 'RUNNING', pumpswap: 'IDLE', paperDecision: 'IDLE', social: 'RUNNING' },
    socialJobs: { pendingCount: 2, leasedCount: 1, retryableFailedCount: 3, exhaustedCount: 4 },
    paperDecisionJobs: {
      pendingCount: 5, leasedCount: 2, retryableFailedCount: 1, exhaustedCount: 3,
      lastSuccessAt: openedAt.toISOString(), lastErrorCode: 'QUOTE_UNAVAILABLE',
    },
    checkpoints: { launchpad: '55', market: '54' },
    heartbeat: {
      runtimeState: 'RUNNING', subscriberState: 'RUNNING', scannerState: 'RUNNING',
      workerState: 'RUNNING', reconcilerState: 'RUNNING', backlogCount: 0, leasedCount: 0,
      exhaustedCount: 2,
      startedAt: openedAt.toISOString(), updatedAt: openedAt.toISOString(), lastHttpSlot: '60',
      lastWebsocketSlot: '59', lastFinalizedSlot: '58', lastSignature: 'signature',
      pendingTransactions: 0, activeSessions: 1,
    }, lagSlots: '1',
  });
  assert.match(database.calls[2]?.text ?? '', /started_at/u);
  assert.doesNotMatch(JSON.stringify(health), /:\/\/|DATABASE_URL|password|secret|localhost/u);
});

void test('degrades only social health when its bounded count projection fails', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('SELECT 1 AS available')) return [{ available: 1 }];
    if (call.text.includes('listener_heartbeats')) return [{
      updated_at: openedAt, started_at: openedAt, last_http_slot: '60',
      last_websocket_slot: '60', last_finalized_slot: '59', last_signature: null,
      pending_transactions: 0, active_sessions: 0, leased_transactions: 0,
      exhausted_transactions: 0, runtime_state: 'RUNNING', subscriber_state: 'RUNNING',
      scanner_state: 'RUNNING', worker_state: 'RUNNING', reconciler_state: 'RUNNING',
    }];
    if (call.text.includes('FROM social_enrichment_jobs')) {
      throw new Error('https://metadata.example/private social count failure');
    }
    return [];
  });
  const health = await new PostgresApiProjectionRepository(database, () => openedAt, {
    httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING', paperDecision: 'RUNNING', social: 'RUNNING',
  }).getHealth();

  assert.equal(health.status, 'DEGRADED');
  assert.equal(health.postgresql.status, 'AVAILABLE');
  assert.deepEqual(health.pipeline, {
    pumpfun: 'RUNNING', pumpswap: 'RUNNING', paperDecision: 'RUNNING', social: 'DEGRADED',
  });
  assert.deepEqual(health.socialJobs, {
    pendingCount: 0, leasedCount: 0, retryableFailedCount: 0, exhaustedCount: 0,
  });
  assert.doesNotMatch(JSON.stringify(health), /metadata|private|failure|:\/\//u);
});

void test('degrades only paper health when its bounded queue projection fails', async () => {
  const database = new FakeQueryable((call) => {
    if (call.text.includes('SELECT 1 AS available')) return [{ available: 1 }];
    if (call.text.includes('listener_heartbeats')) return [{
      updated_at: openedAt, started_at: openedAt, last_http_slot: '60',
      last_websocket_slot: '60', last_finalized_slot: '59', last_signature: null,
      pending_transactions: 0, active_sessions: 0, leased_transactions: 0,
      exhausted_transactions: 0, runtime_state: 'RUNNING', subscriber_state: 'RUNNING',
      scanner_state: 'RUNNING', worker_state: 'RUNNING', reconciler_state: 'RUNNING',
    }];
    if (call.text.includes('FROM social_enrichment_jobs')) return [{
      pending_count: 0, leased_count: 0, retryable_failed_count: 0, exhausted_count: 0,
    }];
    if (call.text.includes('FROM paper_decision_jobs')) {
      throw new Error('postgres://private/paper-count-failure');
    }
    return [];
  });
  const health = await new PostgresApiProjectionRepository(database, () => openedAt, {
    httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING',
    paperDecision: 'RUNNING', social: 'RUNNING',
  }).getHealth();

  assert.equal(health.status, 'DEGRADED');
  assert.deepEqual(health.pipeline, {
    pumpfun: 'RUNNING', pumpswap: 'RUNNING', paperDecision: 'DEGRADED', social: 'RUNNING',
  });
  assert.deepEqual(health.paperDecisionJobs, {
    pendingCount: 0, leasedCount: 0, retryableFailedCount: 0, exhaustedCount: 0,
    lastSuccessAt: null, lastErrorCode: null,
  });
  assert.doesNotMatch(JSON.stringify(health), /postgres:\/\/|private|failure/u);
});

void test('returns nullable unknown heartbeat fields when no heartbeat exists', async () => {
  const database = new FakeQueryable((call) =>
    call.text.includes('SELECT 1 AS available') ? [{ available: 1 }] : []);
  const health = await new PostgresApiProjectionRepository(database, () => openedAt, {
    httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'IDLE', paperDecision: 'IDLE', social: 'RUNNING',
  }).getHealth();

  assert.equal(health.status, 'DEGRADED');
  assert.deepEqual(health.heartbeat, {
    runtimeState: null, subscriberState: null, scannerState: null, workerState: null,
    reconcilerState: null, backlogCount: null, leasedCount: null, exhaustedCount: null,
    startedAt: null, updatedAt: null, lastHttpSlot: null, lastWebsocketSlot: null,
    lastFinalizedSlot: null, lastSignature: null, pendingTransactions: null, activeSessions: null,
  });
  assert.equal(health.lagSlots, null);
});

void test('degrades stale heartbeats and reads the canonical runtime start column', async () => {
  const staleAt = new Date(openedAt.getTime() - 30_001);
  const database = new FakeQueryable((call) => {
    if (call.text.includes('SELECT 1 AS available')) return [{ available: 1 }];
    if (call.text.includes('listener_heartbeats')) return [{
      updated_at: staleAt, started_at: detectedAt, payload: { startedAt: detectedAt.toISOString() },
      last_http_slot: '40', last_websocket_slot: '43', last_finalized_slot: null,
      last_signature: null, pending_transactions: 0, active_sessions: null,
      runtime_state: 'DEGRADED', subscriber_state: 'RUNNING', scanner_state: 'RUNNING',
      worker_state: 'DEGRADED', reconciler_state: 'RUNNING', leased_transactions: 0,
      exhausted_transactions: 0,
    }];
    return [];
  });
  const health = await new PostgresApiProjectionRepository(database, () => openedAt, {
    httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'IDLE', paperDecision: 'IDLE', social: 'RUNNING',
  }).getHealth();

  assert.equal(health.status, 'DEGRADED');
  assert.equal(health.heartbeat.startedAt, detectedAt.toISOString());
  assert.equal(health.lagSlots, '-3');
});

void test('degrades a heartbeat timestamped in the future', async () => {
  const futureAt = new Date(openedAt.getTime() + 1);
  const database = new FakeQueryable((call) => {
    if (call.text.includes('SELECT 1 AS available')) return [{ available: 1 }];
    if (call.text.includes('listener_heartbeats')) return [{
      updated_at: futureAt, payload: {}, last_http_slot: '40', last_websocket_slot: '40',
      last_finalized_slot: null, last_signature: null, pending_transactions: 0, active_sessions: 0,
      runtime_state: 'RUNNING', subscriber_state: 'RUNNING', scanner_state: 'RUNNING',
      worker_state: 'RUNNING', reconciler_state: 'RUNNING', started_at: openedAt,
      leased_transactions: 0, exhausted_transactions: 0,
    }];
    return [];
  });
  const health = await new PostgresApiProjectionRepository(database, () => openedAt, {
    httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'IDLE', paperDecision: 'IDLE', social: 'RUNNING',
  }).getHealth();

  assert.equal(health.status, 'DEGRADED');
});

void test('rejects invalid heartbeat runtime states and impossible runtime counts', async () => {
  for (const heartbeat of [{
    runtime_state: 'UNKNOWN', subscriber_state: 'RUNNING', scanner_state: 'RUNNING',
    worker_state: 'RUNNING', reconciler_state: 'RUNNING', pending_transactions: 0,
    leased_transactions: 0, exhausted_transactions: 0,
  }, {
    runtime_state: 'RUNNING', subscriber_state: 'RUNNING', scanner_state: 'RUNNING',
    worker_state: 'RUNNING', reconciler_state: 'RUNNING', pending_transactions: 1,
    leased_transactions: 2, exhausted_transactions: 0,
  }, {
    runtime_state: 'RUNNING', subscriber_state: 'RUNNING', scanner_state: 'RUNNING',
    worker_state: 'RUNNING', reconciler_state: 'RUNNING', pending_transactions: 0,
    leased_transactions: 0, exhausted_transactions: -1,
  }]) {
    const database = new FakeQueryable((call) => {
      if (call.text.includes('SELECT 1 AS available')) return [{ available: 1 }];
      if (call.text.includes('listener_heartbeats')) return [{
        ...heartbeat, updated_at: openedAt, started_at: openedAt,
        last_http_slot: null, last_websocket_slot: null, last_finalized_slot: null,
        last_signature: null, active_sessions: 0,
      }];
      return [];
    });
    const health = await new PostgresApiProjectionRepository(database, () => openedAt, {
      httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING', paperDecision: 'RUNNING', social: 'RUNNING',
    }).getHealth();
    assert.equal(health.status, 'DEGRADED');
    assert.equal(health.postgresql.status, 'UNAVAILABLE');
    assert.equal(health.heartbeat.runtimeState, null);
  }
});

void test('redacts hostile dynamic pipeline providers into canonical DEGRADED health', async () => {
  let getterReads = 0;
  const getterState = Object.defineProperty({}, 'httpAvailable', {
    enumerable: true,
    get() { getterReads += 1; throw new Error('pipeline getter secret'); },
  });
  const hostileProxy = new Proxy({}, {
    ownKeys() { throw new Error('pipeline proxy secret'); },
    getOwnPropertyDescriptor() { throw new Error('pipeline descriptor secret'); },
    get() { throw new Error('pipeline get secret'); },
  });
  const providers: (() => unknown)[] = [
    () => { throw new Error('pipeline provider secret'); },
    () => getterState,
    () => hostileProxy,
  ];

  for (const provider of providers) {
    const repository = new PostgresApiProjectionRepository(
      new FakeQueryable(() => { throw new Error('must not query after invalid pipeline'); }),
      () => openedAt,
      provider as () => {
        httpAvailable: boolean; pumpfun: 'RUNNING'; pumpswap: 'RUNNING'; paperDecision: 'RUNNING'; social: 'RUNNING';
      },
    );
    const health = await repository.getHealth();
    assert.equal(health.status, 'DEGRADED');
    assert.deepEqual(health.http, { status: 'UNAVAILABLE' });
    assert.deepEqual(health.pipeline, {
      pumpfun: 'DEGRADED', pumpswap: 'DEGRADED', paperDecision: 'DEGRADED', social: 'DEGRADED',
    });
    assert.ok(Object.isFrozen(health.pipeline));
    assert.doesNotMatch(JSON.stringify(health), /secret/u);
  }
  assert.equal(getterReads, 0);
});

void test('snapshots a dynamic pipeline provider exactly once without retaining its object', async () => {
  let providerCalls = 0;
  const original = {
    httpAvailable: true, pumpfun: 'RUNNING' as const, pumpswap: 'RUNNING' as const,
    paperDecision: 'RUNNING' as const,
    social: 'RUNNING' as const,
  };
  const database = new FakeQueryable((call) => {
    if (call.text.includes('SELECT 1 AS available')) return [{ available: 1 }];
    if (call.text.includes('listener_heartbeats')) return [{
      updated_at: openedAt, started_at: openedAt, last_http_slot: '10',
      last_websocket_slot: '10', last_finalized_slot: '9', last_signature: null,
      pending_transactions: 0, active_sessions: 0, leased_transactions: 0,
      exhausted_transactions: 0,
      runtime_state: 'RUNNING', subscriber_state: 'RUNNING', scanner_state: 'RUNNING',
      worker_state: 'RUNNING', reconciler_state: 'RUNNING',
    }];
    return [];
  });
  const health = await new PostgresApiProjectionRepository(database, () => openedAt, () => {
    providerCalls += 1;
    if (providerCalls > 1) throw new Error('stateful provider secret');
    return original;
  }).getHealth();

  original.pumpfun = 'RUNNING';
  assert.equal(providerCalls, 1);
  assert.deepEqual(health.pipeline, {
    pumpfun: 'RUNNING', pumpswap: 'RUNNING', paperDecision: 'RUNNING', social: 'RUNNING',
  });
  assert.ok(Object.isFrozen(health.pipeline));
  assert.notEqual(health.pipeline, original);
  assert.doesNotMatch(JSON.stringify(health), /secret/u);
});

void test('reports PostgreSQL unavailable without leaking a rejected health query', async () => {
  const database = new FakeQueryable(() => { throw new Error('connection secret'); });
  const health = await new PostgresApiProjectionRepository(database, () => openedAt).getHealth();

  assert.equal(health.status, 'DEGRADED');
  assert.deepEqual(health.postgresql, { status: 'UNAVAILABLE' });
  assert.deepEqual(health.checkpoints, { launchpad: null, market: null });
  assert.equal(health.heartbeat.updatedAt, null);
  assert.equal(health.lagSlots, null);
  assert.doesNotMatch(JSON.stringify(health), /connection secret/u);
});

void test('rejects page sizes above the shared API maximum before querying', async () => {
  const database = new FakeQueryable(() => []);
  const repository = new PostgresApiProjectionRepository(database);

  await assert.rejects(repository.listLaunches({ limit: 201, after: null }), ApiProjectionDataError);
  await assert.rejects(repository.listPaperPositions({ limit: 201, after: null }), ApiProjectionDataError);
  await assert.rejects(repository.listLaunchEvents('mint-a', { limit: 201, after: null }), ApiProjectionDataError);
  assert.equal(database.calls.length, 0);
});

void test('rejects invalid dates and unsafe numeric rows with a safe typed error', async () => {
  const invalidDate = new PostgresApiProjectionRepository(new FakeQueryable((call) =>
    call.text.includes('FROM token_launches AS launch') ? [launch('mint-a', new Date('invalid'))] : [],
  ));
  await assert.rejects(invalidDate.getLaunch('mint-a'), ApiProjectionDataError);

  const unsafe = new PostgresApiProjectionRepository(new FakeQueryable((call) =>
    call.text.includes('FROM token_launches AS launch') ? [{ ...launch('mint-a'), created_slot: Number.MAX_SAFE_INTEGER + 1 }] : [],
  ));
  await assert.rejects(unsafe.getLaunch('mint-a'), ApiProjectionDataError);

  const invalidEnum = new PostgresApiProjectionRepository(new FakeQueryable((call) =>
    call.text.includes('FROM token_launches AS launch') ? [{ ...launch('mint-a'), current_state: 'UNKNOWN' }] : [],
  ));
  await assert.rejects(invalidEnum.getLaunch('mint-a'), ApiProjectionDataError);

  const nonCanonicalIso = new PostgresApiProjectionRepository(new FakeQueryable((call) =>
    call.text.includes('FROM token_launches AS launch') ? [launch('mint-a', '2026-07-01 12:00:00Z' as unknown as Date)] : [],
  ));
  await assert.rejects(nonCanonicalIso.getLaunch('mint-a'), ApiProjectionDataError);

  const negativeZero = new PostgresApiProjectionRepository(new FakeQueryable((call) =>
    call.text.includes('FROM token_launches AS launch') ? [{ ...launch('mint-a'), created_slot: '-0' }] : [],
  ));
  await assert.rejects(negativeZero.getLaunch('mint-a'), ApiProjectionDataError);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiProjectionDataError,
  PostgresApiProjectionRepository,
  type Queryable,
} from '../src/storage/api-projection.repository.js';
import { encodeLaunchCursor, encodePaperPositionCursor } from '../src/api/cursor.js';

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

const detectedAt = new Date('2026-07-01T12:00:00.000Z');
const openedAt = new Date('2026-07-02T12:00:00.000Z');

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
    initial_token_amount: '123456789012345678901',
    initial_quote_amount: '42',
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
      marketCapQuote: '300', liquidityQuote: '200',
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
    marketCapQuote: '300', liquidityQuote: '200', creator: 'creator',
    tokenProgram: 'token-program', launchpad: 'pumpfun',
    initialTokenAmount: '123456789012345678901', initialQuoteAmount: '42',
    reserveBase: '100', reserveQuote: '200', feeBps: null,
    social: { status: 'NOT_AVAILABLE', links: [], evidence: [] },
    holders: { status: 'NOT_AVAILABLE', snapshots: [], clusters: [] },
  });
  assert.equal(Object.isFrozen(detail), true);
  assert.equal(Object.isFrozen(detail?.social ?? {}), true);

  const absent = new PostgresApiProjectionRepository(new FakeQueryable(() => []));
  assert.equal(await absent.getLaunch('absent'), null);
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
    status: 'NOT_AVAILABLE', snapshots: [], clusters: [],
  });
  assert.equal(await new PostgresApiProjectionRepository(new FakeQueryable(() => [])).getLaunchSocial('none'), null);
  assert.equal(await new PostgresApiProjectionRepository(new FakeQueryable(() => [])).getLaunchHolders('none'), null);
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

  const entries = await new PostgresApiProjectionRepository(database).listLaunchEvents('mint-a');

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
});

void test('wraps invalid timeline payload conversion in a safe projection error', async () => {
  const repository = new PostgresApiProjectionRepository(new FakeQueryable(() => [{
    id: 'bad', type: 'QualificationUpdated', occurred_at: detectedAt, slot: '1', transaction_index: 0,
    instruction_index: 0, inner_instruction_index: null, confirmation_status: 'confirmed', payload_version: 1,
    payload: { amount: 42 },
  }]));
  await assert.rejects(repository.listLaunchEvents('mint-a'), (error: unknown) => {
    assert.ok(error instanceof ApiProjectionDataError);
    assert.equal(error.message, 'Stored API projection data is invalid.');
    assert.ok(error.cause instanceof TypeError);
    return true;
  });
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
    ruleSet: report.ruleSet, scores: report.scores, evidence: report.evidence,
    blockers: report.blockers, verdict: report.verdict,
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

void test('lists paper positions by stable keyset without decimal coercion', async () => {
  const database = new FakeQueryable(() => [{
    position_id: 'position-a', mint: 'mint-a', status: 'PAPER_HOLDING', opened_at: openedAt,
    closed_at: null, quote_mint: 'quote', remaining_base_raw: '100000000000000000001',
    quote_cost_raw: '200000000000000000002', quote_proceeds_raw: null,
    net_pnl_quote_raw: null, round_trip_loss_bps: '17', entry_fees_raw: '7',
  }, {
    position_id: 'position-b', mint: 'mint-b', status: 'PAPER_CLOSED', opened_at: openedAt,
    closed_at: detectedAt, quote_mint: 'quote', remaining_base_raw: '0', quote_cost_raw: '2',
    quote_proceeds_raw: '3', net_pnl_quote_raw: '1', round_trip_loss_bps: '4', entry_fees_raw: '8',
  }]);
  const page = await new PostgresApiProjectionRepository(database).listPaperPositions({ limit: 1, after: null });

  assert.deepEqual(page, {
    items: [{
      id: 'position-a', mint: 'mint-a', status: 'PAPER_HOLDING', openedAt: openedAt.toISOString(),
      closedAt: null, quoteMint: 'quote', quantity: '100000000000000000001',
      entryQuoteAmount: '200000000000000000002', exitQuoteAmount: null,
      realizedPnlQuote: null, estimatedFeesQuote: '7',
    }], nextCursor: encodePaperPositionCursor({ openedAtMs: openedAt.getTime(), id: 'position-a' }),
  });
  assert.match(database.calls[0]?.text ?? '', /position\.opened_at DESC, position\.position_id ASC/u);
  assert.deepEqual(database.calls[0]?.values, [2]);
  assert.match(database.calls[0]?.text ?? '', /position\.position_id/u);
  assert.match(database.calls[0]?.text ?? '', /position\.opened_at DESC, position\.position_id ASC/u);
});

void test('uses a strict paper keyset and encodes the final emitted position', async () => {
  const database = new FakeQueryable(() => [{
    position_id: 'position-c', mint: 'mint-c', status: 'PAPER_HOLDING', opened_at: openedAt,
    closed_at: null, quote_mint: 'quote', remaining_base_raw: '1', quote_cost_raw: '2',
    quote_proceeds_raw: null, net_pnl_quote_raw: null, entry_fees_raw: '3',
  }, {
    position_id: 'position-d', mint: 'mint-d', status: 'PAPER_HOLDING', opened_at: openedAt,
    closed_at: null, quote_mint: 'quote', remaining_base_raw: '1', quote_cost_raw: '2',
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
    }];
    return [];
  });
  const repository = new PostgresApiProjectionRepository(database, () => openedAt, {
    httpAvailable: false, pumpfun: 'RUNNING', pumpswap: 'IDLE',
  });
  const health = await repository.getHealth();

  assert.deepEqual(health, {
    status: 'DEGRADED', observedAt: openedAt.toISOString(),
    postgresql: { status: 'AVAILABLE' }, http: { status: 'UNAVAILABLE' },
    pipeline: { pumpfun: 'RUNNING', pumpswap: 'IDLE' },
    checkpoints: { launchpad: '55', market: '54' },
    heartbeat: {
      startedAt: openedAt.toISOString(), updatedAt: openedAt.toISOString(), lastHttpSlot: '60',
      lastWebsocketSlot: '59', lastFinalizedSlot: '58', lastSignature: 'signature',
      pendingTransactions: 0, activeSessions: 1,
    }, lagSlots: '2',
  });
  assert.doesNotMatch(database.calls[2]?.text ?? '', /started_at/u);
  assert.doesNotMatch(JSON.stringify(health), /:\/\/|DATABASE_URL|password|secret|localhost/u);
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

import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createTokenLaunchDetectedEvent, createBondingCurveTradeObservedEvent } from '../src/domain/launchpad-events.js';
import { createInitialDetectedTransition } from '../src/domain/state-transitions.js';
import { ConfirmationStatusConflictError } from '../src/domain/confirmation-status.js';
import type { LaunchParameterObject } from '../src/domain/types.js';
import type { LaunchpadEventBatch } from '../src/ports/launchpad-event-sink.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresLaunchpadEventRepository } from '../src/storage/launchpad-event.repository.js';
import { toJsonValue } from '../src/utils/json.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

void test('atomically persists creation and initial buy and restores active events', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `launchpad_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  context.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await migrateDatabase({ pool });
  const repository = new PostgresLaunchpadEventRepository(pool);
  const batch = fixture('confirmed');
  const result = await repository.record(batch);
  assert.deepEqual(result.events.map((item) => item.outcome), ['created', 'created']);
  assert.deepEqual(result.affectedMints, ['mint-a']);
  assert.ok(Object.isFrozen(result.affectedMints));
  const counts = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM raw_chain_events) raw,
    (SELECT COUNT(*)::int FROM domain_events) domain,
    (SELECT COUNT(*)::int FROM token_launches) launches,
    (SELECT COUNT(*)::int FROM launch_trades) trades,
    (SELECT COUNT(*)::int FROM state_transitions) transitions`);
  assert.deepEqual(counts.rows[0], { raw: 2, domain: 2, launches: 1, trades: 1, transitions: 1 });
  const tracked = await repository.listTrackedMints();
  assert.deepEqual([...tracked], ['mint-a']);
  assert.throws(() => (tracked as Set<string>).add('mutated'), TypeError);
  const ownerValues: ReadonlySet<string>[] = [];
  const thisArg = { marker: true };
  tracked.forEach(function (this: typeof thisArg, _value, _key, owner) {
    assert.equal(this, thisArg);
    ownerValues.push(owner);
    assert.throws(() => (owner as Set<string>).add('mutated'), TypeError);
  }, thisArg);
  assert.deepEqual(ownerValues, [tracked]);
  const restored = await repository.listActiveEventsBySignature('signature-a');
  assert.deepEqual(restored, batch.events);
  assert.equal(restored[1]?.type, 'BondingCurveTradeObserved');
  assert.equal(typeof (restored[1]?.type === 'BondingCurveTradeObserved' ? restored[1].payload.trade.baseAmountRaw : null), 'bigint');
  assert.equal(Object.isFrozen(restored), true);
});

void test('restores only launchpad events when market events share the signature', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    const batch = fixture('confirmed');
    await repository.record(batch);
    await pool.query(`INSERT INTO raw_chain_events (
      event_id, source, program, mint, signature, slot, transaction_index,
      instruction_index, confirmation_status, observed_at, payload_version,
      payload, processing_status
    ) VALUES (
      'market-raw', 'pumpswap', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      'mint-a', 'signature-a', 10, 4, 3, 'confirmed', NOW(), 1, '{}'::jsonb,
      'processed'
    )`);
    await pool.query(`INSERT INTO domain_events (
      event_id, raw_event_id, type, mint, source, program, signature, slot,
      transaction_index, instruction_index, confirmation_status, observed_at,
      payload_version, payload
    ) VALUES (
      'market-event', 'market-raw', 'MigrationObserved', 'mint-a', 'pumpswap',
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'signature-a', 10, 4, 3,
      'confirmed', NOW(), 1, '{}'::jsonb
    )`);

    assert.deepEqual(await repository.listActiveEventsBySignature(batch.signature), batch.events);
  });
});

void test('canonical payload fingerprints ignore reordered outer and nested keys', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    const batch = fixture('confirmed');
    await repository.record(batch);
    const launchEvent = batch.events[0];
    assert.ok(launchEvent?.type === 'TokenLaunchDetected');
    const launch = launchEvent.payload.launch;
    const reorderedEvent = {
      payload: { launch: {
        parameters: { nested: { a: 1, b: 2 }, initialSupply: 1_000_000_000_000_000_000n },
        createdAt: { innerInstructionIndex: null, instructionIndex: 2, transactionIndex: 4, slot: 9_007_199_254_740_993n },
        launchpad: launch.launchpad, quoteAssets: launch.quoteAssets.map((quote) => ({ tokenProgram: quote.tokenProgram, decimals: quote.decimals, mint: quote.mint })),
        tokenProgram: launch.tokenProgram, creator: launch.creator, mint: launch.mint,
      } },
      payloadVersion: launchEvent.payloadVersion, observedAtMs: launchEvent.observedAtMs,
      blockchainTimeMs: launchEvent.blockchainTimeMs, confirmationStatus: launchEvent.confirmationStatus,
      cursor: { innerInstructionIndex: null, instructionIndex: 2, transactionIndex: 4, slot: 9_007_199_254_740_993n },
      signature: launchEvent.signature, program: launchEvent.program, source: launchEvent.source,
      mint: launchEvent.mint, type: launchEvent.type, id: launchEvent.id,
    } as typeof launchEvent;
    const tradeEvent = batch.events[1];
    assert.ok(tradeEvent);
    const replay = await repository.record({ ...batch, events: [reorderedEvent, tradeEvent] });
    assert.deepEqual(replay.events.map((event) => event.outcome), ['duplicate', 'duplicate']);
    assert.equal((await pool.query('SELECT COUNT(*)::int count FROM raw_chain_events')).rows[0].count, 2);
    assert.equal((await repository.listActiveEventsBySignature(batch.signature)).length, 2);
  });
});

void test('redacts hostile batches before connecting without invoking getters', async () => {
  let connections = 0;
  let getterCalls = 0;
  const repository = new PostgresLaunchpadEventRepository({ connect: () => { connections += 1; throw new Error('secret-connect'); } });
  const getterBatch = Object.defineProperty({}, 'source', { enumerable: true, get() { getterCalls += 1; throw new Error('secret-getter'); } });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const hostile = [
    getterBatch,
    new Proxy({}, { getPrototypeOf() { throw new Error('secret-proxy'); } }),
    cyclic,
    { ...fixture('confirmed'), events: new Array(1_025).fill(fixture('confirmed').events[0]) },
  ];
  for (const value of hostile) {
    await assert.rejects(repository.record(value as LaunchpadEventBatch), (error: unknown) => {
      assert.equal((error as Error).message, 'Launchpad event repository operation failed.');
      assert.equal(JSON.stringify(error).includes('secret'), false);
      assert.equal(Object.hasOwn(error as object, 'cause'), false);
      return true;
    });
  }
  assert.equal(getterCalls, 0);
  assert.equal(connections, 0);
});

void test('bounds batch key bytes and escaped JSON before acquiring a client', async () => {
  let connections = 0;
  const repository = new PostgresLaunchpadEventRepository({
    connect: () => { connections += 1; throw new Error('must not connect'); },
  });
  const oversizedKey = fixture('confirmed', 'signature-key', 'mint-key', 2_000, 1_000, {
    ['é'.repeat(8_193)]: true,
  });
  const escapedOutput = fixture('confirmed', 'signature-nul', 'mint-nul', 2_000, 1_000, {
    escaped: Array.from({ length: 12 }, () => '\0'.repeat(16_384)),
  });
  for (const batch of [oversizedKey, escapedOutput]) {
    await assert.rejects(repository.record(batch), (error: unknown) => {
      assert.equal((error as Error).name, 'LaunchpadEventRepositoryError');
      assert.equal((error as Error).message, 'Launchpad event repository operation failed.');
      return true;
    });
  }
  assert.equal(connections, 0);
});

void test('preserves multiple outer and inner events in one transaction and accepts different signatures concurrently', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    const batch = fixture('confirmed');
    const firstTrade = batch.events[1];
    assert.ok(firstTrade?.type === 'BondingCurveTradeObserved');
    const transaction = { signature: batch.signature, confirmationStatus: batch.confirmationStatus, blockTimeMs: 1_000, observedAtMs: 2_000, cursor: { slot: firstTrade.cursor.slot, transactionIndex: firstTrade.cursor.transactionIndex }, raw: null };
    const secondTrade = createBondingCurveTradeObservedEvent({ source: batch.source, program: batch.program, transaction, trade: { ...firstTrade.payload.trade, id: 'trade-b', cursor: { ...firstTrade.cursor, instructionIndex: 2, innerInstructionIndex: null } } });
    await repository.record({ ...batch, events: [...batch.events, secondTrade] });
    assert.equal((await pool.query('SELECT COUNT(*)::int count FROM launch_trades')).rows[0].count, 2);
    const active = await repository.listActiveEventsBySignature(batch.signature);
    assert.deepEqual(active.map(event => [event.cursor.instructionIndex, event.cursor.innerInstructionIndex]), [[2, null], [2, null], [2, 1]]);
    assert.equal((active[0]?.id ?? '') < (active[1]?.id ?? ''), true);

    await Promise.all([repository.record(fixture('confirmed', 'signature-b', 'mint-b')), repository.record(fixture('confirmed', 'signature-c', 'mint-c'))]);
    assert.deepEqual([...await repository.listTrackedMints()], ['mint-a', 'mint-b', 'mint-c']);
  });
});

void test('validates deterministic fingerprints before acquiring a database client', async () => {
  let connections = 0;
  const repository = new PostgresLaunchpadEventRepository({ connect: () => { connections += 1; throw new Error('must not connect'); } });
  const batch = fixture('confirmed');
  const trade = batch.events[1];
  assert.ok(trade?.type === 'BondingCurveTradeObserved');
  const launch = batch.events[0];
  assert.ok(launch);
  await assert.rejects(repository.record({ ...batch, events: [launch, { ...trade, id: 'tampered' }] }), (error: unknown) => {
    assert.equal((error as Error).name, 'LaunchpadEventConflictError');
    return true;
  });
  assert.equal(connections, 0);
});

void test('replays exactly, promotes finality, retracts confirmed observations, and filters readers', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool, 4, () => 10_000);
    assert.deepEqual((await repository.record(fixture('processed'))).events.map(x => x.outcome), ['created','created']);
    assert.deepEqual((await repository.record(fixture('processed'))).events.map(x => x.outcome), ['duplicate','duplicate']);
    assert.deepEqual((await repository.record(fixture('confirmed', 'signature-a', 'mint-a', 3_000))).events.map(x => x.outcome), ['confirmation_updated','confirmation_updated']);
    assert.equal((await pool.query("SELECT COUNT(*)::int count FROM domain_events")).rows[0].count, 2);
    assert.deepEqual((await repository.record(fixture('orphaned'))).events.map(x => x.outcome), ['confirmation_updated','confirmation_updated']);
    assert.deepEqual(await repository.listActiveEventsBySignature('signature-a'), []);
    assert.deepEqual([...await repository.listTrackedMints()], []);
    const rows = await pool.query("SELECT confirmation_status, terminal_at IS NOT NULL terminal FROM raw_chain_events ORDER BY event_id");
    assert.equal(rows.rows.every(row => row.confirmation_status === 'orphaned' && row.terminal === true), true);
  });
});

void test('first orphan persists raw proof without active projections', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    await repository.record(fixture('orphaned'));
    const counts = await pool.query(`SELECT (SELECT COUNT(*)::int FROM raw_chain_events) raw,
      (SELECT COUNT(*)::int FROM domain_events) domain,(SELECT COUNT(*)::int FROM token_launches) launches`);
    assert.deepEqual(counts.rows[0], { raw: 2, domain: 0, launches: 0 });
  });
});

void test('replaying a first-seen orphan remains a duplicate raw proof without projections', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    await repository.record(fixture('orphaned'));
    const replay = await repository.record(fixture('orphaned'));
    assert.deepEqual(replay.events.map((event) => event.outcome), ['duplicate', 'duplicate']);
    const counts = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM raw_chain_events) raw,
      (SELECT COUNT(*)::int FROM domain_events) domain,
      (SELECT COUNT(*)::int FROM token_launches) launches,
      (SELECT COUNT(*)::int FROM launch_trades) trades,
      (SELECT COUNT(*)::int FROM state_transitions) transitions`);
    assert.deepEqual(counts.rows[0], {
      raw: 2, domain: 0, launches: 0, trades: 0, transitions: 0,
    });
  });
});

void test('reconciles supplied transition occurrences independently of event outcome', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    await repository.record(fixture('processed', 'signature-a', 'mint-a', 5_000, null));
    await repository.record(fixture('processed', 'signature-a', 'mint-a', 4_000, null));
    assert.deepEqual(await storedOccurrence(pool), { occurred_at_ms: '4000', occurred_at_source: 'observation' });

    await repository.record(fixture('confirmed', 'signature-a', 'mint-a', 6_000, 4_500));
    assert.deepEqual(await storedOccurrence(pool), { occurred_at_ms: '4500', occurred_at_source: 'blockchain' });

    const worse = await repository.record(fixture('confirmed', 'signature-a', 'mint-a', 3_000, null));
    assert.equal(worse.events[0]?.outcome, 'duplicate');
    assert.deepEqual(await storedOccurrence(pool), { occurred_at_ms: '4500', occurred_at_source: 'blockchain' });

    await repository.record(fixture('finalized', 'signature-a', 'mint-a', 7_000, 4_400));
    await repository.record(fixture('finalized', 'signature-a', 'mint-a', 7_000, 4_600));
    assert.deepEqual(await storedOccurrence(pool), { occurred_at_ms: '4400', occurred_at_source: 'blockchain' });
    assert.equal((await pool.query('SELECT COUNT(*)::int count FROM state_transitions')).rows[0].count, 1);
  });
});

void test('rejects stored transition identity, reason, and evidence contradictions', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    const batch = fixture('confirmed');
    const transition = batch.transitions[0];
    assert.ok(transition);
    await repository.record(batch);
    for (const mutation of [
      "UPDATE state_transitions SET transition_id='corrupt'",
      "UPDATE state_transitions SET human_message='corrupt'",
      `UPDATE state_transitions SET evidence='{"source":"other","program":"pump"}'::jsonb`,
      "UPDATE state_transitions SET trigger_event='BondingCurveTradeObserved'",
    ]) {
      await pool.query(mutation);
      await assert.rejects(repository.record(batch), (error: unknown) => {
        assert.equal((error as Error).name, 'LaunchpadEventConflictError');
        return true;
      });
      await pool.query(`UPDATE state_transitions SET transition_id=$1,
        human_message='Token launch detected',
        evidence='{"source":"pumpfun","program":"pump"}'::jsonb,
        trigger_event='TokenLaunchDetected'`, [transition.id]);
    }
  });
});

void test('rejects immutable corruption in every persisted launchpad projection', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    const batch = fixture('confirmed');
    await repository.record(batch);
    const mutations = [
      { mutate: "UPDATE raw_chain_events SET mint='corrupt' WHERE mint='mint-a'", restore: "UPDATE raw_chain_events SET mint='mint-a' WHERE mint='corrupt'" },
      { mutate: "UPDATE domain_events SET program='corrupt' WHERE type='TokenLaunchDetected'", restore: "UPDATE domain_events SET program='pump' WHERE program='corrupt'" },
      { mutate: "UPDATE domain_events SET raw_event_id=NULL WHERE type='TokenLaunchDetected'", restore: "UPDATE domain_events SET raw_event_id=(SELECT raw.event_id FROM raw_chain_events raw WHERE raw.payload->>'id'=domain_events.event_id) WHERE type='TokenLaunchDetected'" },
      { mutate: "UPDATE token_launches SET creator='corrupt' WHERE mint='mint-a'", restore: "UPDATE token_launches SET creator='creator' WHERE mint='mint-a'" },
      { mutate: "UPDATE launch_trades SET base_amount_raw=2 WHERE mint='mint-a'", restore: "UPDATE launch_trades SET base_amount_raw=9007199254740993 WHERE mint='mint-a'" },
    ];
    for (const mutation of mutations) {
      await pool.query(mutation.mutate);
      await assert.rejects(repository.record(batch), (error: unknown) => {
        assert.equal((error as Error).name, 'LaunchpadEventConflictError');
        return true;
      });
      await pool.query(mutation.restore);
    }
  });
});

void test('rejects finalized orphaning and immutable payload contradictions', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    await repository.record(fixture('finalized'));
    await assert.rejects(repository.record(fixture('orphaned')), ConfirmationStatusConflictError);
    const changed = fixture('finalized');
    const trade = changed.events[1];
    assert.ok(trade?.type === 'BondingCurveTradeObserved');
    const launch = changed.events[0];
    assert.ok(launch);
    const contradictory = { ...changed, events: [launch, { ...trade, payload: { trade: { ...trade.payload.trade, quoteAmountRaw: 2n } } }] };
    await assert.rejects(repository.record(contradictory), (error: unknown) => {
      assert.equal((error as Error).name, 'LaunchpadEventConflictError');
      assert.equal((error as Error).message, 'Launchpad event immutable state conflicts.');
      return true;
    });
  });
});

void test('serializes concurrent same-signature replays without duplicating rows', async (context) => {
  await withDatabase(context, async (pool) => {
    const first = new PostgresLaunchpadEventRepository(pool);
    const second = new PostgresLaunchpadEventRepository(pool);
    const outcomes = await Promise.all([first.record(fixture('confirmed')), second.record(fixture('confirmed'))]);
    assert.deepEqual(outcomes.flatMap(x => x.events.map(y => y.outcome)).sort(), ['created','created','duplicate','duplicate']);
    assert.equal((await pool.query('SELECT COUNT(*)::int count FROM domain_events')).rows[0].count, 2);
  });
});

void test('reader sorts full cursors, restores bigints, and rejects corrupt rows safely', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    const batch = fixture('confirmed');
    await repository.record({ ...batch, events: [...batch.events].reverse() });
    const events = await repository.listActiveEventsBySignature('signature-a');
    assert.deepEqual(events.map(event => event.type), ['TokenLaunchDetected','BondingCurveTradeObserved']);
    await pool.query("UPDATE domain_events SET payload='{\"trade\":{\"baseAmountRaw\":{\"$solTokenListenerBigInt\":\"not-a-bigint\"}}}'::jsonb WHERE type='BondingCurveTradeObserved'");
    await assert.rejects(repository.listActiveEventsBySignature('signature-a'), (error: unknown) => {
      assert.equal((error as Error).name, 'LaunchpadEventRepositoryError');
      assert.equal((error as Error).message, 'Launchpad event repository operation failed.');
      assert.equal(Object.hasOwn(error as object, 'cause'), false);
      return true;
    });
    const trade = batch.events[1];
    assert.ok(trade?.type === 'BondingCurveTradeObserved');
    await pool.query("UPDATE domain_events SET payload=$1 WHERE type='BondingCurveTradeObserved'", [toJsonValue(trade.payload)]);
    await pool.query("UPDATE raw_chain_events SET payload='{}'::jsonb WHERE mint='mint-a'");
    await assert.rejects(
      repository.listActiveEventsBySignature('signature-a'),
      (error: unknown) => (error as Error).name === 'LaunchpadEventRepositoryError',
    );
  });
});

void test('active signature reader uses its full-cursor partial index without a sort', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    await repository.record(fixture('confirmed'));
    await pool.query(`INSERT INTO raw_chain_events (
      event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
      inner_instruction_index,confirmation_status,observed_at,payload_version,payload,
      processing_status
    ) SELECT 'plan-raw-' || value,'pumpfun','pump','plan-mint-' || value,
      'plan-signature-' || value,value,0,0,NULL,'confirmed',clock_timestamp(),1,
      '{}'::jsonb,'processed' FROM generate_series(1, 20000) AS value`);
    await pool.query(`INSERT INTO domain_events (
      event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
      instruction_index,inner_instruction_index,confirmation_status,observed_at,
      payload_version,payload
    ) SELECT 'plan-domain-' || value,'plan-raw-' || value,'TokenLaunchDetected',
      'plan-mint-' || value,'pumpfun','pump','plan-signature-' || value,value,0,0,
      NULL,'confirmed',clock_timestamp(),1,'{}'::jsonb
      FROM generate_series(1, 20000) AS value`);
    await pool.query('ANALYZE raw_chain_events');
    await pool.query('ANALYZE domain_events');
    const explained = await pool.query(`EXPLAIN (FORMAT JSON) SELECT
      domain.event_id,domain.raw_event_id,domain.type,domain.mint,domain.source,
      domain.program,domain.signature,domain.slot::text AS slot,
      domain.transaction_index,domain.instruction_index,domain.inner_instruction_index,
      domain.confirmation_status,domain.blockchain_time,domain.observed_at,
      domain.payload_version,domain.payload,raw.payload AS raw_payload,
      raw.confirmation_status AS raw_confirmation_status
      FROM domain_events AS domain
      JOIN raw_chain_events AS raw ON raw.event_id=domain.raw_event_id
      WHERE domain.signature=$1 AND domain.confirmation_status <> 'orphaned'
        AND domain.terminal_at IS NULL
      ORDER BY domain.slot,domain.transaction_index,domain.instruction_index,
        COALESCE(domain.inner_instruction_index,-1),domain.event_id`, ['signature-a']);
    const nodes = planNodes(explained.rows[0]);
    assert.equal(nodes.some((node) => node['Node Type'] === 'Sort'), false);
    assert.equal(nodes.some((node) =>
      node['Index Name'] === 'domain_events_active_signature_cursor_idx'), true);
    assert.deepEqual((await repository.listActiveEventsBySignature('signature-a'))
      .map((event) => event.type), ['TokenLaunchDetected', 'BondingCurveTradeObserved']);
  });
});

void test('rolls back statement failures, releases clients, and redacts database secrets', async () => {
  let released = false;
  const secret = 'postgres://user:password@secret-host/private';
  const client = { query(text: string) { if (text.includes('INSERT INTO raw_chain_events')) throw new Error(secret); return Promise.resolve({ rows: [], rowCount: 1 }); }, release() { released = true; } };
  const repository = new PostgresLaunchpadEventRepository({ connect: () => Promise.resolve(client) });
  await assert.rejects(repository.record(fixture('confirmed')), (error: unknown) => {
    assert.equal((error as Error).message.includes(secret), false);
    assert.equal(Object.hasOwn(error as object, 'cause'), false);
    return true;
  });
  assert.equal(released, true);
});

async function withDatabase(context: { skip(message?: string): void }, run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>) {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `launchpad_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try { await admin.query(`CREATE SCHEMA ${schema}`); await migrateDatabase({ pool }); await run(pool); }
  finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
}

function fixture(status: 'processed' | 'confirmed' | 'finalized' | 'orphaned', signature = 'signature-a', mint = 'mint-a', observedAtMs = 2_000, blockTimeMs: number | null = 1_000, parameters: LaunchParameterObject = { initialSupply: 1_000_000_000_000_000_000n, nested: { b: 2, a: 1 } }) {
  const transaction = { signature, confirmationStatus: status, blockTimeMs, observedAtMs, cursor: { slot: 9_007_199_254_740_993n, transactionIndex: 4 }, raw: null };
  const quoteAsset = { mint: 'quote', decimals: 9, tokenProgram: 'SPL_TOKEN' as const };
  const launch = createTokenLaunchDetectedEvent({ source: 'pumpfun', program: 'pump', transaction, launch: { mint, creator: 'creator', tokenProgram: 'SPL_TOKEN', quoteAssets: [quoteAsset], launchpad: 'pumpfun', createdAt: { ...transaction.cursor, instructionIndex: 2, innerInstructionIndex: null }, parameters } });
  const trade = createBondingCurveTradeObservedEvent({ source: 'pumpfun', program: 'pump', transaction, trade: { id: `trade-${mint}`, launchMint: mint, kind: 'BUY', trader: 'buyer', baseAmountRaw: 9007199254740993n, quoteAmountRaw: 1000000000n, quoteAsset, cursor: { ...transaction.cursor, instructionIndex: 2, innerInstructionIndex: 1 } } });
  return status === 'orphaned' ? { source: 'pumpfun', program: 'pump', signature: transaction.signature, confirmationStatus: status, events: [launch, trade], stateTransitionAction: 'retract' as const, transitions: [] as const } : { source: 'pumpfun', program: 'pump', signature: transaction.signature, confirmationStatus: status, events: [launch, trade], stateTransitionAction: 'apply' as const, transitions: [createInitialDetectedTransition(launch)] };
}

async function storedOccurrence(pool: InstanceType<typeof pg.Pool>): Promise<{
  readonly occurred_at_ms: string;
  readonly occurred_at_source: string;
}> {
  const result = await pool.query<{
    readonly occurred_at_ms: string;
    readonly occurred_at_source: string;
  }>(`SELECT (EXTRACT(EPOCH FROM occurred_at) * 1000)::bigint::text AS occurred_at_ms,
    occurred_at_source FROM state_transitions`);
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

function planNodes(row: unknown): readonly Record<string, unknown>[] {
  if (typeof row !== 'object' || row === null) throw new TypeError('Missing query plan.');
  const value = Object.values(row as Record<string, unknown>)[0];
  if (!Array.isArray(value) || typeof value[0] !== 'object' || value[0] === null) {
    throw new TypeError('Invalid query plan.');
  }
  const root = (value[0] as Record<string, unknown>).Plan;
  if (typeof root !== 'object' || root === null) throw new TypeError('Invalid query plan root.');
  const nodes: Record<string, unknown>[] = [];
  const visit = (node: Record<string, unknown>): void => {
    nodes.push(node);
    const children = node.Plans;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child !== 'object' || child === null) throw new TypeError('Invalid query plan node.');
        visit(child as Record<string, unknown>);
      }
    }
  };
  visit(root as Record<string, unknown>);
  return nodes;
}

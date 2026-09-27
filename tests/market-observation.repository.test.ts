import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { ConfirmationStatusConflictError } from '../src/domain/confirmation-status.js';
import type { ChainConfirmationStatus } from '../src/domain/types.js';
import type { MatchedMigration } from '../src/application/pumpswap-migration-matcher.js';
import {
  marketPoolDefinition,
  type RawMarketObservation,
} from '../src/domain/market.js';
import {
  MarketObservationPayloadConflictError,
  PostgresMarketObservationRepository,
} from '../src/storage/market-observation.repository.js';
import { migrateDatabase } from '../src/storage/database.js';
import { toJsonValue } from '../src/utils/json.js';

const MINT = '11111111111111111111111111111111';

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

class InstrumentedClient {
  public readonly calls: QueryCall[] = [];
  public readonly rawRows = new Map<string, Record<string, unknown>>();
  public readonly reserveRows = new Map<string, Record<string, unknown>>();
  public readonly launchStates: string[] = ['OBSERVING', 'MIGRATION_PENDING'];
  public throwOn: RegExp | null = null;
  public released = false;

  public query(text: string, values: readonly unknown[] = []) {
    this.calls.push({ text, values });
    if (this.throwOn?.test(text) === true) throw new Error('database failure');
    if (text.includes('SELECT confirmation_status, payload FROM raw_chain_events')) {
      const row = this.rawRows.get(String(values[0]));
      return Promise.resolve({ rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 });
    }
    if (text.includes('SELECT current_state FROM token_launches')) {
      return Promise.resolve({ rows: [{ current_state: this.launchStates.shift() ?? 'PUMPSWAP_ACTIVE' }], rowCount: 1 });
    }
    if (
      text.includes('FROM market_reserve_snapshots WHERE snapshot_id=$1')
    ) {
      const row = this.reserveRows.get(String(values[0]));
      return Promise.resolve({
        rows: row === undefined ? [] : [row],
        rowCount: row === undefined ? 0 : 1,
      });
    }
    if (text.includes('SELECT pool_state,confirmation_status FROM market_pools')) {
      return Promise.resolve({
        rows: [{ pool_state: 'active', confirmation_status: 'finalized' }],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  public release() {
    this.released = true;
  }
}

void test('market observation repository writes migration and activation atomically', async () => {
  const client = new InstrumentedClient();
  const repository = repositoryWith(client);
  const fixture = matched('confirmed');
  const result = await repository.record({
    rawEvents: fixture.rawEvents,
    matches: [fixture.match],
    reserveSnapshots: [],
    trades: [],
  });

  const statements = client.calls.map(label).filter((value) => value !== null);
  assert.deepEqual(statements, [
    'BEGIN',
    'INSERT raw MigrationObserved',
    'INSERT domain MigrationObserved',
    'INSERT migrations',
    'INSERT transition MIGRATION_PENDING',
    'INSERT raw PumpSwapPoolActivated',
    'INSERT domain PumpSwapPoolActivated',
    'INSERT market_pools',
    'INSERT transition PUMPSWAP_ACTIVE',
    'COMMIT',
  ]);
  assert.equal(result.migrations.length, 1);
  assert.equal(result.activations.length, 1);
  const transitions = client.calls.filter((call) =>
    call.text.includes('INSERT INTO state_transitions'));
  assert.equal(transitions.length, 2);
  assert.equal(transitions.every((call) =>
    (call.values[4] === 'blockchain' || call.values[4] === 'observation')
    && call.values[5] === 1), true);
  assert.equal(client.released, true);
});

void test('first orphaned observation persists raw proof only', async () => {
  const client = new InstrumentedClient();
  const fixture = matched('orphaned');
  const result = await repositoryWith(client).record({
    rawEvents: fixture.rawEvents,
    matches: [fixture.match],
    reserveSnapshots: [],
    trades: [],
  });
  assert.equal(result.migrations.length, 0);
  assert.equal(result.activations.length, 0);
  assert.equal(client.calls.some((call) => call.text.includes('INSERT INTO domain_events')), false);
  assert.equal(client.calls.filter((call) => call.text.includes('INSERT INTO raw_chain_events')).length, 2);
  assert.equal(
    client.calls.some((call) => call.text.includes('UPDATE token_launches')),
    false,
  );
});

void test('replay enriches finality but rejects payload contradiction', async () => {
  const fixture = matched('confirmed');
  const client = new InstrumentedClient();
  for (const raw of fixture.rawEvents) {
    client.rawRows.set(raw.id, {
      confirmation_status: 'processed',
      payload: toJsonValue(raw.payload),
    });
  }
  await repositoryWith(client).record({
    rawEvents: fixture.rawEvents,
    matches: [fixture.match],
    reserveSnapshots: [],
    trades: [],
  });
  const updates = client.calls.filter((call) =>
    call.text.includes('UPDATE raw_chain_events SET confirmation_status'));
  assert.equal(updates.length, 2);
  assert.equal(updates.every((call) => call.values[1] === 'confirmed'), true);

  const conflictClient = new InstrumentedClient();
  conflictClient.rawRows.set(fixture.rawEvents[0]?.id ?? '', {
    confirmation_status: 'processed',
    payload: { changed: true },
  });
  await assert.rejects(
    repositoryWith(conflictClient).record({
      rawEvents: fixture.rawEvents,
      matches: [fixture.match],
      reserveSnapshots: [],
      trades: [],
    }),
    MarketObservationPayloadConflictError,
  );
  assert.equal(conflictClient.calls.at(-1)?.text, 'ROLLBACK');
});

void test('finalized observations cannot become orphaned', async () => {
  const fixture = matched('orphaned');
  const client = new InstrumentedClient();
  const raw = fixture.rawEvents[0];
  assert.ok(raw);
  client.rawRows.set(raw.id, {
    confirmation_status: 'finalized',
    payload: toJsonValue(raw.payload),
  });
  await assert.rejects(
    repositoryWith(client).record({
      rawEvents: fixture.rawEvents,
      matches: [fixture.match],
      reserveSnapshots: [],
      trades: [],
    }),
    ConfirmationStatusConflictError,
  );
  assert.equal(client.calls.at(-1)?.text, 'ROLLBACK');
});

void test('confirmed orphaning retracts dependent market projections', async () => {
  const fixture = matched('orphaned');
  const client = new InstrumentedClient();
  for (const raw of fixture.rawEvents) {
    client.rawRows.set(raw.id, {
      confirmation_status: 'confirmed',
      payload: toJsonValue(raw.payload),
    });
  }
  const result = await repositoryWith(client).record({
    rawEvents: fixture.rawEvents,
    matches: [fixture.match],
    reserveSnapshots: [],
    trades: [],
  });
  assert.deepEqual(result, { migrations: [], activations: [], affectedMints: [MINT] });
  assert.equal(
    client.calls.some((call) =>
      call.text.includes("pool_state='retracted'")),
    true,
  );
  assert.equal(
    client.calls.some((call) =>
      call.text.includes('UPDATE state_transitions SET terminal_at')),
    true,
  );
  assert.equal(client.calls.at(-1)?.text, 'COMMIT');
});

void test('intermediate repository errors rollback the whole batch', async () => {
  const fixture = matched('confirmed');
  const client = new InstrumentedClient();
  client.throwOn = /INSERT INTO migrations/u;
  await assert.rejects(
    repositoryWith(client).record({
      rawEvents: fixture.rawEvents,
      matches: [fixture.match],
      reserveSnapshots: [],
      trades: [],
    }),
    /database failure/u,
  );
  assert.equal(client.calls.at(-1)?.text, 'ROLLBACK');
  assert.equal(client.released, true);
});

void test('reserve replay rejects contradictory immutable amounts', async () => {
  const client = new InstrumentedClient();
  client.reserveRows.set('reserve', {
    confirmation_status: 'confirmed',
    pool_address: 'pool',
    base_reserves_raw: '99',
    quote_vault_amount_raw: '200',
    virtual_quote_reserves_raw: '50',
    effective_quote_reserves_raw: '250',
    observed_slot: '10',
    trigger_slot: '9',
    transaction_index: 0,
    instruction_index: 1,
    inner_instruction_index: null,
  });
  await assert.rejects(
    repositoryWith(client).record({
      rawEvents: [],
      matches: [],
      trades: [],
      reserveSnapshots: [{
        id: 'reserve',
        reserves: {
          pool: 'pool',
          baseReservesRaw: 100n,
          quoteVaultAmountRaw: 200n,
          virtualQuoteReservesRaw: 50n,
          effectiveQuoteReservesRaw: 250n,
          observedSlot: 10n,
          observedAtMs: 2_000,
        },
        triggerCursor: {
          slot: 9n,
          transactionIndex: 0,
          instructionIndex: 1,
          innerInstructionIndex: null,
        },
        confirmationStatus: 'finalized',
      }],
    }),
    MarketObservationPayloadConflictError,
  );
  assert.equal(client.calls.at(-1)?.text, 'ROLLBACK');
});

void test('late processed replay keeps finalized projections', async () => {
  const fixture = matched('processed');
  const client = new InstrumentedClient();
  client.launchStates.splice(0, 2, 'PUMPSWAP_ACTIVE', 'PUMPSWAP_ACTIVE');
  for (const raw of fixture.rawEvents) {
    client.rawRows.set(raw.id, {
      confirmation_status: 'finalized',
      payload: toJsonValue(raw.payload),
    });
  }
  await repositoryWith(client).record({
    rawEvents: fixture.rawEvents,
    matches: [fixture.match],
    reserveSnapshots: [],
    trades: [],
  });
  const projectionWrites = client.calls.filter((call) =>
    call.text.includes('INSERT INTO domain_events')
    || call.text.includes('INSERT INTO migrations')
    || call.text.includes('INSERT INTO market_pools'));
  assert.equal(
    projectionWrites.every((call) => call.values.includes('finalized')),
    true,
  );
});

void test('market orphaning waits on the shared mint lock before removing candidate source proof',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL is not configured');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      await migrateDatabase({ pool });
      const fixture = orphanedMigrationOnly();
      await seedCandidateDependingOnMigration(pool, fixture);
      const blocker = await pool.connect();
      const market = await pool.connect();
      const marketPid = await backendPid(market);
      let record: Promise<unknown> | null = null;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('transaction-inbox-mint:' || $1, 0))",
          [MINT],
        );
        record = new PostgresMarketObservationRepository({
          connect: () => Promise.resolve(market),
        }, 4, () => 10_000).record(fixture);
        await waitForLock(pool, marketPid);

        assert.deepEqual(await candidateSourceState(pool), [{
          candidate_state: 'ELIGIBLE',
          source_confirmation_status: 'confirmed',
        }]);

        await blocker.query('COMMIT');
        await record;
        assert.deepEqual(await candidateSourceState(pool), [{
          candidate_state: 'ELIGIBLE',
          source_confirmation_status: 'orphaned',
        }]);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
        if (record === null) market.release();
        else await record.catch(() => undefined);
      }
    });
  });

function repositoryWith(client: InstrumentedClient) {
  return new PostgresMarketObservationRepository({
    connect: () => Promise.resolve(client),
  }, 4, () => 10_000);
}

function matched(status: ChainConfirmationStatus): {
  readonly match: MatchedMigration;
  readonly rawEvents: readonly RawMarketObservation[];
} {
  const migrationCursor = {
    slot: 10n, transactionIndex: 0, instructionIndex: 2,
    innerInstructionIndex: null,
  };
  const activationCursor = { ...migrationCursor, innerInstructionIndex: 1 };
  const quoteAsset = {
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    tokenProgram: 'SPL_TOKEN' as const,
  };
  const migrationEvent: MatchedMigration['migrationEvent'] = {
    id: 'migration-event',
    type: 'MigrationObserved',
    mint: MINT,
    source: 'pumpfun',
    program: 'pump',
    signature: 'signature',
    cursor: migrationCursor,
    confirmationStatus: status,
    blockchainTimeMs: 1_000,
    observedAtMs: 2_000,
    payloadVersion: 1,
    payload: {
      migration: {
        instruction: 'MIGRATE',
        mint: MINT,
        bondingCurve: 'curve',
        announcedPool: 'pool',
        baseTokenProgram: 'SPL_TOKEN',
        quoteAsset,
        cursor: migrationCursor,
      },
    },
  };
  const activationEvent: NonNullable<MatchedMigration['activationEvent']> = {
    ...migrationEvent,
    id: 'activation-event',
    type: 'PumpSwapPoolActivated',
    cursor: activationCursor,
    payload: {
      migrationEventId: migrationEvent.id,
      pool: {
        address: 'pool',
        market: 'pumpswap',
        programId: 'pumpswap',
        baseMint: MINT,
        quoteAsset,
        index: 0,
        creator: 'creator',
        baseVault: 'base-vault',
        quoteVault: 'quote-vault',
        lpMint: 'lp-mint',
        baseTokenProgram: 'SPL_TOKEN',
        activatedAt: activationCursor,
        confirmationStatus: status,
      },
    },
  };
  const rawEvents = [
    raw('raw-migration', migrationEvent.id, migrationEvent, status),
    raw('raw-activation', activationEvent.id, activationEvent, status),
  ];
  return {
    match: { migrationEvent, activationEvent },
    rawEvents,
  };
}

function orphanedMigrationOnly() {
  const fixture = matched('orphaned');
  const migrationRaw = fixture.rawEvents[0];
  if (migrationRaw === undefined) throw new Error('Migration raw fixture is unavailable.');
  return {
    rawEvents: [migrationRaw],
    matches: [{ ...fixture.match, activationEvent: null }],
    reserveSnapshots: [],
    trades: [],
  } as const;
}

async function seedCandidateDependingOnMigration(
  pool: InstanceType<typeof pg.Pool>,
  fixture: ReturnType<typeof orphanedMigrationOnly>,
): Promise<void> {
  const rawEvent = fixture.rawEvents[0];
  const migration = fixture.matches[0]?.migrationEvent;
  assert.ok(rawEvent !== undefined && migration !== undefined);
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,current_state,created_signature,
    created_slot,created_transaction_index,created_instruction_index,detected_at,updated_at
  ) VALUES ($1,'pumpfun','pump','creator','SPL_TOKEN','MIGRATION_PENDING',$2,10,0,1,
    to_timestamp(1),to_timestamp(1))`, [MINT, migration.signature]);
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    inner_instruction_index,confirmation_status,blockchain_time,observed_at,
    payload_version,payload,processing_status
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10,$11,$12,$13,'processed')`, [
    rawEvent.id, rawEvent.source, rawEvent.program, rawEvent.mint, rawEvent.signature,
    rawEvent.cursor.slot.toString(), rawEvent.cursor.transactionIndex,
    rawEvent.cursor.instructionIndex, rawEvent.cursor.innerInstructionIndex,
    new Date(rawEvent.blockchainTimeMs ?? 0), new Date(rawEvent.observedAtMs),
    rawEvent.payloadVersion, toJsonValue(rawEvent.payload),
  ]);
  for (const [eventId, type] of [
    [migration.id, 'MigrationObserved'],
    ['qualification-event', 'QualificationUpdated'],
    ['candidate-event', 'TradingCandidateUpdated'],
  ] as const) {
    await pool.query(`INSERT INTO domain_events (
      event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
      instruction_index,inner_instruction_index,confirmation_status,blockchain_time,
      observed_at,payload_version,payload
    ) VALUES ($1,$2,$3,$4,'pumpfun','pump',$5,10,0,2,NULL,'confirmed',to_timestamp(1),
      to_timestamp(2),1,'{}')`, [eventId, rawEvent.id, type, MINT, migration.signature]);
  }
  await pool.query(`INSERT INTO qualification_reports (
    report_id,mint,source_event_id,source_raw_event_id,qualification_event_id,
    profile_id,profile_version,profile_fingerprint,evidence_fingerprint,verdict,
    preparation_score,social_score,onchain_score,total_score,as_of_slot,
    as_of_transaction_index,as_of_instruction_index,confirmation_status,evaluated_at,
    purge_after,payload_version,payload
  ) VALUES ($1,$2,$3,$4,'qualification-event','market-race',1,$5,$6,'QUALIFIED',
    0,0,60,60,10,0,2,'confirmed',to_timestamp(2),to_timestamp(2)+INTERVAL '4 hours',1,'{}')`, [
    `qreport_${'1'.repeat(64)}`, MINT, migration.id, rawEvent.id,
    '2'.repeat(64), '3'.repeat(64),
  ]);
  await pool.query(`INSERT INTO trading_candidates (
    candidate_id,mint,report_id,source_event_id,candidate_event_id,strategy_id,
    strategy_version,evidence_fingerprint,confirmation_status,state,quote_mint,
    quote_decimals,quote_token_program,reason_codes,eligible_until,created_at,purge_after,
    payload_version,payload
  ) VALUES ($1,$2,$3,$4,'candidate-event','market-race',1,$5,'confirmed','ELIGIBLE',
    'So11111111111111111111111111111111111111112',9,'SPL_TOKEN','["QUALIFIED_ENTRY"]',
    NOW()+INTERVAL '1 hour',to_timestamp(2),to_timestamp(2)+INTERVAL '4 hours',1,'{}')`, [
    `candidate_${'4'.repeat(64)}`, MINT, `qreport_${'1'.repeat(64)}`, migration.id,
    '5'.repeat(64),
  ]);
}

async function candidateSourceState(pool: InstanceType<typeof pg.Pool>) {
  const result = await pool.query<{
    readonly candidate_state: string;
    readonly source_confirmation_status: string;
  }>(`SELECT candidate.state AS candidate_state,
      source.confirmation_status AS source_confirmation_status
    FROM trading_candidates candidate
    JOIN domain_events source ON source.event_id=candidate.source_event_id`);
  return result.rows;
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ readonly pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('PostgreSQL backend pid is unavailable.');
  return pid;
}

async function waitForLock(
  pool: InstanceType<typeof pg.Pool>,
  processId: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = (await pool.query<{ readonly wait_event_type: string | null }>(
      'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [processId],
    )).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
  assert.fail('Market orphaning did not wait for the shared mint lock.');
}

async function withTemporarySchema(
  databaseUrl: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `market_mint_lock_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await callback(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

function raw(
  id: string,
  sourceId: string,
  event: MatchedMigration['migrationEvent'] | NonNullable<MatchedMigration['activationEvent']>,
  status: ChainConfirmationStatus,
): RawMarketObservation {
  const payload = event.type === 'PumpSwapPoolActivated'
    ? { ...event.payload, pool: marketPoolDefinition(event.payload.pool) }
    : event.payload;
  return {
    id,
    source: event.source,
    program: event.program,
    mint: event.mint,
    signature: event.signature,
    cursor: event.cursor,
    confirmationStatus: status,
    blockchainTimeMs: event.blockchainTimeMs,
    observedAtMs: event.observedAtMs,
    payloadVersion: 1,
    payload: {
      kind: event.type,
      value: {
        id: sourceId,
        type: event.type,
        payloadVersion: event.payloadVersion,
        payload: toJsonValue(payload),
      },
    },
  };
}

function label(call: QueryCall): string | null {
  const sql = call.text;
  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return sql;
  if (sql.includes('INSERT INTO raw_chain_events')) {
    return `INSERT raw ${(call.values[13] as { kind: string }).kind}`;
  }
  if (sql.includes('INSERT INTO domain_events')) return `INSERT domain ${String(call.values[2])}`;
  if (sql.includes('INSERT INTO migrations')) return 'INSERT migrations';
  if (sql.includes('INSERT INTO market_pools')) return 'INSERT market_pools';
  if (sql.includes('INSERT INTO state_transitions')) {
    return `INSERT transition ${String(call.values[8])}`;
  }
  return null;
}

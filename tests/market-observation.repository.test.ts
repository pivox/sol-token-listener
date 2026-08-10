import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfirmationStatusConflictError } from '../src/domain/confirmation-status.js';
import type { ChainConfirmationStatus } from '../src/domain/types.js';
import type { MatchedMigration } from '../src/application/pumpswap-migration-matcher.js';
import type { RawMarketObservation } from '../src/domain/market.js';
import {
  MarketObservationPayloadConflictError,
  PostgresMarketObservationRepository,
} from '../src/storage/market-observation.repository.js';
import { toJsonValue } from '../src/utils/json.js';

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
  assert.deepEqual(result, { migrations: [], activations: [], affectedMints: ['mint'] });
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
    mint: 'mint',
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
        mint: 'mint',
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
        baseMint: 'mint',
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

function raw(
  id: string,
  sourceId: string,
  event: MatchedMigration['migrationEvent'] | NonNullable<MatchedMigration['activationEvent']>,
  status: ChainConfirmationStatus,
): RawMarketObservation {
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
    payload: { kind: event.type, value: { ...toJsonValue(event) as object, id: sourceId } },
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

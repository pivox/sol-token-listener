import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeLedgerCursor, encodeLedgerCursor } from '../src/api/cursor.js';
import type { ExecutorDatabaseSource } from '../src/executor/database.js';
import {
  ACTIVE_WALLET_SQL,
  CURVE_RESERVES_SQL,
  createLiveOverviewReader,
  HISTORY_SQL,
  OPEN_POSITIONS_SQL,
  POOL_RESERVES_SQL,
  REALIZED_TOTAL_SQL,
} from '../src/operator-api/repository.js';

type Row = Readonly<Record<string, unknown>>;

const WALLET = '11111111111111111111111111111111';
const MINT_POOL = 'So11111111111111111111111111111111111111112';
const MINT_CURVE = '4Nd1mYQzvgQ1NhVU9oKRf7qZsV4W1YqTf1m4eZxY2k5y';
const MINT_BARE = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const SIGNATURE = '5'.repeat(88);

function fakeDatabase(answers: ReadonlyMap<string, readonly Row[]>) {
  const calls: { readonly text: string; readonly values: readonly unknown[] | undefined }[] = [];
  let released = 0;
  const source: ExecutorDatabaseSource = {
    connect: () => Promise.resolve({
      query: (text, values) => {
        calls.push({ text, values });
        const rows = answers.get(text);
        if (rows === undefined) return Promise.reject(new Error('unexpected SQL'));
        return Promise.resolve({ rows, rowCount: rows.length });
      },
      release: () => { released += 1; },
    }),
  };
  return { source, calls, released: () => released };
}

function openRow(positionId: string, mint: string, remaining: string): Row {
  return {
    position_id: positionId, mint, state: 'OPEN',
    opened_at: new Date('2026-10-06T11:55:00.000Z'),
    exit_deadline_at: new Date('2026-10-06T12:10:00.000Z'),
    remaining_base_raw: remaining, quote_cost_raw: '1000000', fee_lamports: '5000',
  };
}

function historyRow(id: string, closedAt: string, net: string): Row {
  return {
    position_id: id, mint: MINT_POOL, opened_at: new Date('2026-10-06T10:00:00.000Z'),
    closed_at: new Date(closedAt), entry_signature: SIGNATURE, exit_signature: SIGNATURE,
    net_lamports: net,
  };
}

const balances = {
  read: () => Promise.resolve({ lamports: 2_500_000_000n, observedAtMs: NOW - 3_000 }),
};

void test('without an active wallet generation the overview is NOT_AVAILABLE and reads nothing else', async () => {
  const database = fakeDatabase(new Map([[ACTIVE_WALLET_SQL, []]]));
  const reader = createLiveOverviewReader({ database: database.source, balances });

  const page = await reader.read({ limit: 50, cursor: null });

  assert.deepEqual(page, {
    data: {
      availability: 'NOT_AVAILABLE', wallet: null, balance: null, open: [], history: [],
      totals: { realizedLamports: 0n, unrealizedLamports: 0n, openCount: 0, positionsWithoutPnl: 0 },
    },
    nextCursor: null,
  });
  assert.equal(database.calls.length, 1);
  assert.equal(database.released(), 1);
});

void test('assembles open PnL from pool then curve reserves, realized totals and a history cursor', async () => {
  const database = fakeDatabase(new Map<string, readonly Row[]>([
    [ACTIVE_WALLET_SQL, [{ wallet_public_key: WALLET }]],
    [OPEN_POSITIONS_SQL, [
      openRow('execution_live_position_pool', MINT_POOL, '35000000000'),
      openRow('execution_live_position_curve', MINT_CURVE, '35000000000'),
      openRow('execution_live_position_bare', MINT_BARE, '35000000000'),
    ]],
    // The curve query answers for two mints; the pool answer must win for MINT_POOL.
    [CURVE_RESERVES_SQL, [
      { mint: MINT_POOL, quote_reserves_raw: '1', base_reserves_raw: '1' },
      { mint: MINT_CURVE, quote_reserves_raw: '30000000000', base_reserves_raw: '1073000000000000' },
    ]],
    [POOL_RESERVES_SQL, [
      { mint: MINT_POOL, quote_reserves_raw: '60000000000', base_reserves_raw: '1073000000000000' },
    ]],
    [REALIZED_TOTAL_SQL, [{ realized_lamports: '-12345' }]],
    [HISTORY_SQL, [
      historyRow('execution_live_position_c', '2026-10-06T11:30:00.000Z', '-4205'),
      historyRow('execution_live_position_b', '2026-10-06T11:00:00.000Z', '900'),
      historyRow('execution_live_position_a', '2026-10-06T10:30:00.000Z', '-9000'),
    ]],
  ]));
  const reader = createLiveOverviewReader({ database: database.source, balances });

  const { data, nextCursor } = await reader.read({ limit: 2, cursor: null });

  assert.equal(data.availability, 'AVAILABLE');
  assert.equal(data.wallet, WALLET);
  assert.deepEqual(data.balance, { lamports: 2_500_000_000n, observedAt: '2026-10-06T11:59:57.000Z' });
  assert.deepEqual(data.open.map((position) => [
    position.positionId, position.costLamports, position.spotValueLamports, position.unrealizedLamports,
  ]), [
    ['execution_live_position_pool', 1_005_000n, 1_957_129n, 952_129n],
    ['execution_live_position_curve', 1_005_000n, 978_564n, -26_436n],
    ['execution_live_position_bare', 1_005_000n, null, null],
  ]);
  assert.deepEqual(data.totals, {
    realizedLamports: -12_345n, unrealizedLamports: 925_693n, openCount: 3, positionsWithoutPnl: 1,
  });
  assert.deepEqual(data.history.map((position) => [position.positionId, position.realizedLamports]), [
    ['execution_live_position_c', -4_205n], ['execution_live_position_b', 900n],
  ]);
  assert.equal(data.history[0]?.closedAt, '2026-10-06T11:30:00.000Z');
  assert.deepEqual(decodeLedgerCursor(nextCursor ?? ''), {
    closedAtMs: Date.parse('2026-10-06T11:00:00.000Z'), id: 'execution_live_position_b',
  });
  const historyCall = database.calls.find((call) => call.text === HISTORY_SQL);
  assert.deepEqual(historyCall?.values, [WALLET, null, null, 3]);
  assert.equal(database.released(), 1);
});

void test('the last history page has no cursor and a cursor request is a keyset on the ledger', async () => {
  const cursor = { closedAtMs: Date.parse('2026-10-06T11:00:00.000Z'), id: 'execution_live_position_b' };
  assert.equal(decodeLedgerCursor(encodeLedgerCursor(cursor)).id, cursor.id);
  const database = fakeDatabase(new Map<string, readonly Row[]>([
    [ACTIVE_WALLET_SQL, [{ wallet_public_key: WALLET }]],
    [OPEN_POSITIONS_SQL, []],
    [REALIZED_TOTAL_SQL, [{ realized_lamports: '0' }]],
    [HISTORY_SQL, [historyRow('execution_live_position_a', '2026-10-06T10:30:00.000Z', '-9000')]],
  ]));
  const reader = createLiveOverviewReader({
    database: database.source, balances: { read: () => Promise.resolve(null) },
  });

  const page = await reader.read({ limit: 2, cursor });

  assert.equal(page.nextCursor, null);
  assert.equal(page.data.balance, null);
  assert.deepEqual(database.calls.find((call) => call.text === HISTORY_SQL)?.values,
    [WALLET, String(cursor.closedAtMs), cursor.id, 3]);
  assert.equal(database.calls.some((call) => call.text === POOL_RESERVES_SQL), false);
});

void test('the database client is released when a query fails', async () => {
  const database = fakeDatabase(new Map());
  const reader = createLiveOverviewReader({ database: database.source, balances });

  await assert.rejects(reader.read({ limit: 50, cursor: null }));
  assert.equal(database.released(), 1);
});

void test('a latest pool snapshot with zero base reserves yields no spot value and no curve fallback', async () => {
  const database = fakeDatabase(new Map<string, readonly Row[]>([
    [ACTIVE_WALLET_SQL, [{ wallet_public_key: WALLET }]],
    [OPEN_POSITIONS_SQL, [openRow('execution_live_position_pool', MINT_POOL, '35000000000')]],
    [CURVE_RESERVES_SQL, [
      { mint: MINT_POOL, quote_reserves_raw: '30000000000', base_reserves_raw: '1073000000000000' },
    ]],
    [POOL_RESERVES_SQL, [{ mint: MINT_POOL, quote_reserves_raw: '60000000000', base_reserves_raw: '0' }]],
    [REALIZED_TOTAL_SQL, [{ realized_lamports: '0' }]],
    [HISTORY_SQL, []],
  ]));
  const reader = createLiveOverviewReader({ database: database.source, balances });

  const { data } = await reader.read({ limit: 50, cursor: null });

  assert.deepEqual(data.open.map((position) => [position.spotValueLamports, position.unrealizedLamports]),
    [[null, null]]);
  assert.deepEqual(data.totals, {
    realizedLamports: 0n, unrealizedLamports: 0n, openCount: 1, positionsWithoutPnl: 1,
  });
});

import type { ExecutorDatabaseClient, ExecutorDatabaseSource } from '../executor/database.js';
import { encodeLedgerCursor, type LedgerPagePosition } from '../api/cursor.js';
import type { BalanceCache } from './balance-cache.js';
import { spotValueLamports, unrealizedLamports, WSOL_MINT, type SpotReserves } from './pnl.js';

export type LiveOpenState = 'OPEN' | 'EXIT_PENDING' | 'UNKNOWN';

export interface LiveOpenPosition {
  readonly positionId: string;
  readonly mint: string;
  readonly state: LiveOpenState;
  readonly openedAt: string;
  readonly exitDeadlineAt: string;
  readonly remainingRaw: bigint;
  readonly costLamports: bigint;
  readonly spotValueLamports: bigint | null;
  readonly unrealizedLamports: bigint | null;
}

export interface LiveClosedPosition {
  readonly positionId: string;
  readonly mint: string;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly entrySignature: string;
  readonly exitSignature: string;
  readonly realizedLamports: bigint;
}

export interface LiveOverviewData {
  readonly availability: 'AVAILABLE' | 'NOT_AVAILABLE';
  readonly wallet: string | null;
  readonly balance: { readonly lamports: bigint; readonly observedAt: string } | null;
  readonly open: readonly LiveOpenPosition[];
  readonly history: readonly LiveClosedPosition[];
  readonly totals: {
    readonly realizedLamports: bigint;
    readonly unrealizedLamports: bigint;
    readonly openCount: number;
    readonly positionsWithoutPnl: number;
  };
}

export interface LiveOverviewRequest {
  readonly limit: number;
  readonly cursor: LedgerPagePosition | null;
}

export interface LiveOverviewPage {
  readonly data: LiveOverviewData;
  readonly nextCursor: string | null;
}

export interface LiveOverviewReader {
  readonly read: (request: LiveOverviewRequest) => Promise<LiveOverviewPage>;
}

type Row = Readonly<Record<string, unknown>>;

export const ACTIVE_WALLET_SQL = `SELECT wallet_public_key FROM execution_wallet_generations
  WHERE retired_at IS NULL ORDER BY created_at DESC, generation_id LIMIT 1`;

export const OPEN_POSITIONS_SQL = `SELECT position_id, mint, state, opened_at, exit_deadline_at,
    remaining_base_raw::TEXT AS remaining_base_raw, quote_cost_raw::TEXT AS quote_cost_raw,
    fee_lamports::TEXT AS fee_lamports
  FROM execution_live_positions
  WHERE wallet_public_key = $1 AND state IN ('OPEN','EXIT_PENDING','UNKNOWN')
  ORDER BY opened_at DESC, position_id DESC`;

// $1 mints, $2 quote mint. Latest non-orphaned reserve snapshot of the active PumpSwap pool per
// mint. A zero-base snapshot is deliberately kept: spotValueLamports turns it into "no value".
export const POOL_RESERVES_SQL = `SELECT DISTINCT ON (pool.base_mint) pool.base_mint AS mint,
    snapshot.effective_quote_reserves_raw::TEXT AS quote_reserves_raw,
    snapshot.base_reserves_raw::TEXT AS base_reserves_raw
  FROM market_pools pool
  JOIN market_reserve_snapshots snapshot ON snapshot.pool_address = pool.pool_address
  WHERE pool.base_mint = ANY($1::TEXT[]) AND pool.quote_mint = $2 AND pool.pool_state = 'active'
    AND pool.confirmation_status <> 'orphaned' AND snapshot.confirmation_status <> 'orphaned'
  ORDER BY pool.base_mint, snapshot.observed_slot DESC, snapshot.trigger_slot DESC,
    snapshot.transaction_index DESC, snapshot.instruction_index DESC,
    COALESCE(snapshot.inner_instruction_index, -1) DESC, snapshot.snapshot_id DESC`;

// $1 mints, $2 quote mint. Latest non-orphaned bonding curve virtual reserves per mint.
export const CURVE_RESERVES_SQL = `SELECT DISTINCT ON (curve.mint) curve.mint,
    curve.virtual_quote_reserves_raw::TEXT AS quote_reserves_raw,
    curve.virtual_base_reserves_raw::TEXT AS base_reserves_raw
  FROM bonding_curve_snapshots curve
  WHERE curve.mint = ANY($1::TEXT[]) AND curve.quote_mint = $2
    AND curve.confirmation_status <> 'orphaned'
  ORDER BY curve.mint, curve.slot DESC, curve.transaction_index DESC,
    curve.instruction_index DESC, COALESCE(curve.inner_instruction_index, -1) DESC,
    curve.snapshot_id DESC`;

export const REALIZED_TOTAL_SQL = `SELECT COALESCE(SUM(net_lamports), 0)::TEXT AS realized_lamports
  FROM execution_live_position_ledger WHERE wallet_public_key = $1`;

// $1 wallet, $2 cursor closed-at epoch ms or NULL, $3 cursor position id or NULL, $4 row count.
export const HISTORY_SQL = `SELECT position_id, mint, opened_at, closed_at, entry_signature,
    exit_signature, net_lamports::TEXT AS net_lamports
  FROM execution_live_position_ledger
  WHERE wallet_public_key = $1
    AND ($2::BIGINT IS NULL OR (closed_at, position_id) <
      (TIMESTAMPTZ 'epoch' + ($2::BIGINT * INTERVAL '1 millisecond'), $3::TEXT))
  ORDER BY closed_at DESC, position_id DESC
  LIMIT $4::INTEGER`;

export interface LiveOverviewReaderOptions {
  readonly database: ExecutorDatabaseSource;
  readonly balances: BalanceCache;
}

export function createLiveOverviewReader(options: LiveOverviewReaderOptions): LiveOverviewReader {
  return Object.freeze({
    read: async (request: LiveOverviewRequest): Promise<LiveOverviewPage> => {
      const client = await options.database.connect();
      let stored: StoredOverview;
      try {
        stored = await readStored(client, request);
      } finally {
        client.release();
      }
      if (stored.wallet === null) {
        return { data: emptyOverview(), nextCursor: null };
      }
      const observation = await options.balances.read(stored.wallet);
      return {
        data: {
          availability: 'AVAILABLE',
          wallet: stored.wallet,
          balance: observation === null ? null : {
            lamports: observation.lamports,
            observedAt: new Date(observation.observedAtMs).toISOString(),
          },
          open: stored.open,
          history: stored.history,
          totals: stored.totals,
        },
        nextCursor: stored.nextCursor,
      };
    },
  });
}

interface StoredOverview {
  readonly wallet: string | null;
  readonly open: readonly LiveOpenPosition[];
  readonly history: readonly LiveClosedPosition[];
  readonly nextCursor: string | null;
  readonly totals: LiveOverviewData['totals'];
}

async function readStored(
  client: ExecutorDatabaseClient,
  request: LiveOverviewRequest,
): Promise<StoredOverview> {
  const walletRow = (await client.query(ACTIVE_WALLET_SQL)).rows[0];
  if (walletRow === undefined) {
    return { wallet: null, open: [], history: [], nextCursor: null, totals: emptyOverview().totals };
  }
  const wallet = text(walletRow, 'wallet_public_key');
  const openRows = (await client.query(OPEN_POSITIONS_SQL, [wallet])).rows;
  const mints = openRows.map((row) => text(row, 'mint'));
  const reserves = mints.length === 0 ? new Map<string, SpotReserves>() : await readReserves(client, mints);
  const open = openRows.map((row) => {
    const mint = text(row, 'mint');
    const remainingRaw = bigint(row, 'remaining_base_raw');
    const costLamports = bigint(row, 'quote_cost_raw') + bigint(row, 'fee_lamports');
    const spot = spotValueLamports(remainingRaw, reserves.get(mint) ?? null);
    return Object.freeze({
      positionId: text(row, 'position_id'),
      mint,
      state: openState(row),
      openedAt: timestamp(row, 'opened_at'),
      exitDeadlineAt: timestamp(row, 'exit_deadline_at'),
      remainingRaw,
      costLamports,
      spotValueLamports: spot,
      unrealizedLamports: unrealizedLamports(spot, costLamports),
    });
  });
  const realizedRow = (await client.query(REALIZED_TOTAL_SQL, [wallet])).rows[0];
  const historyRows = (await client.query(HISTORY_SQL, [
    wallet,
    request.cursor === null ? null : String(request.cursor.closedAtMs),
    request.cursor?.id ?? null,
    request.limit + 1,
  ])).rows;
  const page = historyRows.slice(0, request.limit);
  const history = page.map((row) => Object.freeze({
    positionId: text(row, 'position_id'),
    mint: text(row, 'mint'),
    openedAt: timestamp(row, 'opened_at'),
    closedAt: timestamp(row, 'closed_at'),
    entrySignature: text(row, 'entry_signature'),
    exitSignature: text(row, 'exit_signature'),
    realizedLamports: bigint(row, 'net_lamports'),
  }));
  const lastRow = page.at(-1);
  const nextCursor = historyRows.length > request.limit && lastRow !== undefined
    ? encodeLedgerCursor({
      closedAtMs: date(lastRow, 'closed_at').getTime(), id: text(lastRow, 'position_id'),
    })
    : null;
  return {
    wallet,
    open,
    history,
    nextCursor,
    totals: {
      realizedLamports: realizedRow === undefined ? 0n : bigint(realizedRow, 'realized_lamports'),
      unrealizedLamports: open.reduce((sum, position) => sum + (position.unrealizedLamports ?? 0n), 0n),
      openCount: open.length,
      positionsWithoutPnl: open.filter((position) => position.unrealizedLamports === null).length,
    },
  };
}

async function readReserves(
  client: ExecutorDatabaseClient,
  mints: readonly string[],
): Promise<ReadonlyMap<string, SpotReserves>> {
  const reserves = new Map<string, SpotReserves>();
  // The curve is the fallback: PumpSwap reserves win when the mint has a pool snapshot.
  for (const sql of [CURVE_RESERVES_SQL, POOL_RESERVES_SQL]) {
    for (const row of (await client.query(sql, [mints, WSOL_MINT])).rows) {
      reserves.set(text(row, 'mint'), {
        quoteReservesRaw: bigint(row, 'quote_reserves_raw'),
        baseReservesRaw: bigint(row, 'base_reserves_raw'),
      });
    }
  }
  return reserves;
}

function emptyOverview(): LiveOverviewData {
  return {
    availability: 'NOT_AVAILABLE', wallet: null, balance: null, open: [], history: [],
    totals: { realizedLamports: 0n, unrealizedLamports: 0n, openCount: 0, positionsWithoutPnl: 0 },
  };
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Invalid column ${key}`);
  return value;
}

function bigint(row: Row, key: string): bigint {
  const value = text(row, key);
  if (!/^-?\d+$/u.test(value)) throw new TypeError(`Invalid column ${key}`);
  return BigInt(value);
}

function date(row: Row, key: string): Date {
  const value = row[key];
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`Invalid column ${key}`);
  }
  return value;
}

function timestamp(row: Row, key: string): string {
  return date(row, key).toISOString();
}

function openState(row: Row): LiveOpenState {
  const value = text(row, 'state');
  if (value !== 'OPEN' && value !== 'EXIT_PENDING' && value !== 'UNKNOWN') {
    throw new TypeError('Invalid column state');
  }
  return value;
}

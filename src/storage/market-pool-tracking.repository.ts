import type { Pool } from 'pg';
import type { TrackedPoolCandidate } from '../application/market-pool-selection.js';

export interface PoolCheckpoint {
  readonly poolAddress: string;
  readonly slot: bigint;
  readonly signature: string;
}

export interface PoolCheckpointPosition {
  readonly slot: bigint;
  readonly signature: string;
}

// Must match the active-state set of paper_strategy_sessions_active_idx (migration 015).
const ACTIVE_PAPER_STATES = Object.freeze([
  'BUY_PENDING', 'PAPER_HOLDING', 'WAITING_EXTERNAL_BUYS', 'EXIT_PENDING_QUOTE', 'SELL_PENDING',
]);

export class PostgresMarketPoolTrackingRepository {
  public constructor(private readonly pool: Pool) {}

  public async listCandidates(windowStartMs: number): Promise<readonly TrackedPoolCandidate[]> {
    const result = await this.pool.query<{
      pool_address: string; base_mint: string; signature: string; slot: string;
      activated_at_ms: string; engaged: boolean;
    }>(
      `SELECT * FROM (
         SELECT p.pool_address, p.base_mint, e.signature, e.slot::text AS slot,
                floor(extract(epoch FROM e.observed_at) * 1000)::bigint::text AS activated_at_ms,
                (EXISTS (SELECT 1 FROM paper_strategy_sessions s
                          WHERE s.mint = p.base_mint AND s.state = ANY($2::text[]))
                 OR EXISTS (SELECT 1 FROM live_positions l
                          WHERE l.mint = p.base_mint AND l.status IN ('OPEN','RECONCILIATION_REQUIRED'))
                ) AS engaged,
                e.observed_at
           FROM market_pools p
           JOIN domain_events e ON e.event_id = p.activation_event_id
          WHERE p.pool_state = 'active' AND p.confirmation_status <> 'orphaned'
       ) candidate
       WHERE candidate.engaged OR candidate.observed_at >= $1
       ORDER BY candidate.pool_address`,
      [new Date(windowStartMs), ACTIVE_PAPER_STATES],
    );
    return Object.freeze(result.rows.map((row) => Object.freeze({
      poolAddress: row.pool_address,
      baseMint: row.base_mint,
      engaged: row.engaged,
      activatedAtMs: Number(row.activated_at_ms),
      activationSignature: row.signature,
      activationSlot: BigInt(row.slot),
    })));
  }

  public async readCheckpoint(poolAddress: string): Promise<PoolCheckpoint | null> {
    const result = await this.pool.query<{ slot: string; signature: string }>(
      'SELECT slot::text AS slot, signature FROM market_pool_checkpoints WHERE pool_address = $1',
      [poolAddress],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : Object.freeze({ poolAddress, slot: BigInt(row.slot), signature: row.signature });
  }

  public async seedFromActivation(candidate: TrackedPoolCandidate, nowMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO market_pool_checkpoints (pool_address, slot, signature, source, updated_at)
       VALUES ($1, $2, $3, 'pool-activation', $4)
       ON CONFLICT (pool_address) DO NOTHING`,
      [candidate.poolAddress, candidate.activationSlot.toString(), candidate.activationSignature, new Date(nowMs)],
    );
  }

  public async storeCheckpoint(
    poolAddress: string,
    next: PoolCheckpointPosition,
    nowMs: number,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE market_pool_checkpoints
          SET slot = $2, signature = $3, source = 'rolling-catch-up', updated_at = $4
        WHERE pool_address = $1 AND slot <= $2`,
      [poolAddress, next.slot.toString(), next.signature, new Date(nowMs)],
    );
    if (result.rowCount !== 1) {
      throw new Error('Pool checkpoint store refused: missing row or non-monotonic slot.');
    }
  }

  public async reseedAtFrontier(
    poolAddress: string,
    frontier: PoolCheckpointPosition,
    nowMs: number,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE market_pool_checkpoints
          SET previous = jsonb_build_object('slot', slot::text, 'signature', signature, 'source', source),
              slot = $2, signature = $3, source = 'operator-approved-pool-frontier-seed', updated_at = $4
        WHERE pool_address = $1 AND slot <= $2`,
      [poolAddress, frontier.slot.toString(), frontier.signature, new Date(nowMs)],
    );
    if (result.rowCount !== 1) {
      throw new Error('Pool re-seed refused: missing checkpoint or frontier behind the checkpoint.');
    }
  }
}

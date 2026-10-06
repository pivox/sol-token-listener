import type { Pool } from 'pg';
import { listWorkerTrackingMints } from './worker-tracking-mint-lock.js';

export interface TrackedPool {
  readonly poolAddress: string;
  readonly baseMint: string;
  readonly activationSignature: string;
  readonly activationSlot: bigint;
}

export interface PoolCheckpoint {
  readonly slot: bigint;
  readonly signature: string;
}

export const MAX_TRACKED_POOLS = 20;

export class PostgresTrackedPoolRepository {
  public constructor(private readonly pool: Pool) {}

  public async listTrackedPools(trackingWindowSeconds: number): Promise<readonly TrackedPool[]> {
    const client = await this.pool.connect();
    try {
      const mints = await listWorkerTrackingMints(client, trackingWindowSeconds);
      if (mints.length === 0) return Object.freeze([]);
      const result = await client.query<{
        pool_address: string; base_mint: string; signature: string; slot: string;
      }>(
        `SELECT p.pool_address, p.base_mint, e.signature, e.slot::text AS slot
           FROM market_pools p
           JOIN domain_events e ON e.event_id = p.activation_event_id
          WHERE p.pool_state = 'active' AND p.confirmation_status <> 'orphaned'
            AND p.pool_index = 0 AND p.base_mint = ANY($1::text[])
          ORDER BY e.slot DESC, p.pool_address
          LIMIT $2`,
        [mints, MAX_TRACKED_POOLS],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({
        poolAddress: row.pool_address,
        baseMint: row.base_mint,
        activationSignature: row.signature,
        activationSlot: BigInt(row.slot),
      })));
    } finally {
      client.release();
    }
  }

  public async readCheckpoint(poolAddress: string): Promise<PoolCheckpoint | null> {
    const result = await this.pool.query<{ slot: string; signature: string }>(
      `SELECT slot::text AS slot, signature
         FROM listener_tracked_pool_checkpoints WHERE pool_address = $1`,
      [poolAddress],
    );
    const row = result.rows[0];
    return row === undefined ? null : { slot: BigInt(row.slot), signature: row.signature };
  }

  public async seedCheckpoint(
    target: TrackedPool,
    value: PoolCheckpoint,
    nowMs: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO listener_tracked_pool_checkpoints (pool_address, slot, signature, updated_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (pool_address) DO NOTHING`,
      [target.poolAddress, value.slot.toString(), value.signature, new Date(nowMs)],
    );
  }

  public async storeCheckpoint(
    poolAddress: string,
    value: PoolCheckpoint,
    nowMs: number,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE listener_tracked_pool_checkpoints
          SET slot = $2, signature = $3, updated_at = $4
        WHERE pool_address = $1 AND slot <= $2`,
      [poolAddress, value.slot.toString(), value.signature, new Date(nowMs)],
    );
    if (result.rowCount !== 1) {
      throw new Error('Tracked pool checkpoint is missing or would move backwards.');
    }
  }
}

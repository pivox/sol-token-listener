import { PublicKey } from '@solana/web3.js';
import type { Pool, PoolClient } from 'pg';
import { bondingCurvePda } from '../launchpads/pumpfun/official-sdk.js';
import { MAX_TRACKED_POOLS, type PoolCheckpoint, type TrackedPool } from './tracked-pool.repository.js';
import { listWorkerTrackingMints } from './worker-tracking-mint-lock.js';

/**
 * Bonding curves of the tracked mints that have not migrated, in the TrackedPoolPoller target
 * shape: `poolAddress` is the bonding curve, `baseMint` the mint, the activation is the create.
 */
export class PostgresTrackedCurveRepository {
  public constructor(private readonly pool: Pool) {}

  public async listTrackedPools(trackingWindowSeconds: number): Promise<readonly TrackedPool[]> {
    const client = await this.pool.connect();
    try {
      const mints = await listWorkerTrackingMints(client, trackingWindowSeconds);
      return mints.length === 0 ? Object.freeze([]) : await selectTrackedCurves(client, mints);
    } finally {
      client.release();
    }
  }

  public async readCheckpoint(bondingCurve: string): Promise<PoolCheckpoint | null> {
    const result = await this.pool.query<{ slot: string; signature: string }>(
      `SELECT slot::text AS slot, signature
         FROM listener_tracked_curve_checkpoints WHERE bonding_curve = $1`,
      [bondingCurve],
    );
    const row = result.rows[0];
    return row === undefined ? null : { slot: BigInt(row.slot), signature: row.signature };
  }

  public async seedCheckpoint(target: TrackedPool, value: PoolCheckpoint, nowMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO listener_tracked_curve_checkpoints (bonding_curve, mint, slot, signature, updated_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (bonding_curve) DO NOTHING`,
      [target.poolAddress, target.baseMint, value.slot.toString(), value.signature, new Date(nowMs)],
    );
  }

  public async storeCheckpoint(bondingCurve: string, value: PoolCheckpoint, nowMs: number): Promise<void> {
    const result = await this.pool.query(
      `UPDATE listener_tracked_curve_checkpoints
          SET slot = $2, signature = $3, updated_at = $4
        WHERE bonding_curve = $1 AND slot <= $2`,
      [bondingCurve, value.slot.toString(), value.signature, new Date(nowMs)],
    );
    if (result.rowCount !== 1) {
      throw new Error('Tracked curve checkpoint is missing or would move backwards.');
    }
  }
}

/** Live positions first, then the newest launches; migrated mints are left to the pool poller. */
export async function selectTrackedCurves(
  client: Pick<PoolClient, 'query'>,
  mints: readonly string[],
): Promise<readonly TrackedPool[]> {
  const result = await client.query<{ mint: string; signature: string; slot: string }>(
    `SELECT launch.mint, launch.created_signature AS signature, launch.created_slot::text AS slot
       FROM token_launches AS launch
      WHERE launch.mint = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM market_pools AS pool
           WHERE pool.base_mint = launch.mint AND pool.pool_state = 'active'
             AND pool.confirmation_status <> 'orphaned')
      ORDER BY (launch.mint IN (SELECT mint FROM listener_worker_tracking_live_mints)) DESC,
               launch.created_slot DESC, launch.mint
      LIMIT $2`,
    [mints, MAX_TRACKED_POOLS],
  );
  return Object.freeze(result.rows.map((row) => Object.freeze({
    poolAddress: bondingCurvePda(new PublicKey(row.mint)).toBase58(),
    baseMint: row.mint,
    activationSignature: row.signature,
    activationSlot: BigInt(row.slot),
  })));
}

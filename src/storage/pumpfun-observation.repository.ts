import type { QueryResult, QueryResultRow } from 'pg';
import type {
  BondingCurveSnapshot,
  PersistedLaunchTrade,
  TokenMetadataSnapshot,
} from '../domain/pumpfun-observation.js';
import { toJsonValue } from '../utils/json.js';
import { getDatabasePool } from './database.js';
import { createRepositoryId } from './repositories.js';

interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export class PumpFunObservationRepository {
  public constructor(private readonly database: Queryable = getDatabasePool()) {}

  public async upsertMetadataSnapshot(snapshot: TokenMetadataSnapshot): Promise<void> {
    const snapshotId = createRepositoryId('pumpfun_metadata', [
      snapshot.mint, snapshot.uri, snapshot.fetchedAtMs, snapshot.payloadVersion,
      snapshot.resolution.status,
    ]);
    const payload = snapshot.resolution.status === 'RESOLVED'
      ? toJsonValue(snapshot.resolution.metadata)
      : null;
    const payloadHash = createRepositoryId('pumpfun_metadata_payload', [
      snapshot.mint, JSON.stringify(payload), snapshot.resolution.status,
    ]);
    await this.database.query(
      `INSERT INTO token_metadata_snapshots (
        snapshot_id, mint, uri, resolution_status, failure_reason, failure_message,
        payload_version, payload_hash, metadata, fetched_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (snapshot_id) DO NOTHING`,
      [
        snapshotId, snapshot.mint, snapshot.uri,
        snapshot.resolution.status.toLowerCase(),
        snapshot.resolution.status === 'FAILED' ? snapshot.resolution.reason : null,
        snapshot.resolution.status === 'FAILED' ? snapshot.resolution.message : null,
        snapshot.payloadVersion, payloadHash, payload, new Date(snapshot.fetchedAtMs),
      ],
    );
  }

  public async upsertBondingCurveSnapshot(snapshot: BondingCurveSnapshot): Promise<void> {
    const snapshotId = createRepositoryId('pumpfun_curve', [
      snapshot.launchMint, snapshot.cursor.slot, snapshot.cursor.transactionIndex,
      snapshot.cursor.instructionIndex, snapshot.cursor.innerInstructionIndex,
    ]);
    await this.database.query(
      `INSERT INTO bonding_curve_snapshots (
        snapshot_id, mint, quote_mint, quote_decimals, quote_token_program,
        real_base_reserves_raw, real_quote_reserves_raw, virtual_base_reserves_raw,
        virtual_quote_reserves_raw, progress_bps, complete, slot, transaction_index,
        instruction_index, inner_instruction_index, confirmation_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (snapshot_id) DO UPDATE SET
        confirmation_status = CASE
          WHEN bonding_curve_snapshots.confirmation_status = 'orphaned'
            OR EXCLUDED.confirmation_status = 'orphaned' THEN 'orphaned'
          WHEN bonding_curve_snapshots.confirmation_status = 'finalized'
            OR EXCLUDED.confirmation_status = 'finalized' THEN 'finalized'
          WHEN bonding_curve_snapshots.confirmation_status = 'confirmed'
            OR EXCLUDED.confirmation_status = 'confirmed' THEN 'confirmed'
          ELSE 'processed'
        END`,
      [
        snapshotId, snapshot.launchMint, snapshot.quoteAsset.mint,
        snapshot.quoteAsset.decimals, snapshot.quoteAsset.tokenProgram,
        snapshot.realBaseReservesRaw.toString(), snapshot.realQuoteReservesRaw.toString(),
        snapshot.virtualBaseReservesRaw.toString(), snapshot.virtualQuoteReservesRaw.toString(),
        snapshot.progressBps.toString(), snapshot.complete, snapshot.cursor.slot.toString(),
        snapshot.cursor.transactionIndex, snapshot.cursor.instructionIndex,
        snapshot.cursor.innerInstructionIndex, snapshot.confirmationStatus,
      ],
    );
  }

  public async upsertTrade(trade: PersistedLaunchTrade): Promise<void> {
    await this.database.query(
      `INSERT INTO launch_trades (
        trade_id, mint, trade_kind, trader, base_amount_raw, quote_amount_raw,
        quote_mint, quote_decimals, quote_token_program, slot, transaction_index,
        instruction_index, inner_instruction_index, confirmation_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (trade_id) DO UPDATE SET
        confirmation_status = CASE
          WHEN launch_trades.confirmation_status = 'orphaned'
            OR EXCLUDED.confirmation_status = 'orphaned' THEN 'orphaned'
          WHEN launch_trades.confirmation_status = 'finalized'
            OR EXCLUDED.confirmation_status = 'finalized' THEN 'finalized'
          WHEN launch_trades.confirmation_status = 'confirmed'
            OR EXCLUDED.confirmation_status = 'confirmed' THEN 'confirmed'
          ELSE 'processed'
        END`,
      [
        trade.id, trade.launchMint, trade.kind, trade.trader,
        trade.baseAmountRaw.toString(), trade.quoteAmountRaw.toString(),
        trade.quoteAsset.mint, trade.quoteAsset.decimals, trade.quoteAsset.tokenProgram,
        trade.cursor.slot.toString(), trade.cursor.transactionIndex,
        trade.cursor.instructionIndex, trade.cursor.innerInstructionIndex,
        trade.confirmationStatus,
      ],
    );
  }
}

import { createHash } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import type { PoolInfo, SwapEvent, TokenSession, TradeRecord } from '../domain/types.js';
import type { TokenRiskReport } from '../security/token-risk.types.js';
import { fromJsonValue, toJsonValue } from '../utils/json.js';
import { getDatabasePool } from './database.js';

interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

interface PayloadRow extends QueryResultRow {
  readonly payload: unknown;
}

export function createRepositoryId(namespace: string, parts: readonly (string | number | bigint | null)[]): string {
  const canonical = parts.map((part) => {
    const value = part === null ? '<null>' : String(part);
    return `${Buffer.byteLength(value, 'utf8')}:${value}`;
  }).join('|');
  const digest = createHash('sha256').update(`${namespace}\u001f${canonical}`).digest('hex');
  return `${namespace}_${digest}`;
}

export class PoolRepository {
  constructor(private readonly database: Queryable = getDatabasePool()) {}

  async save(pool: PoolInfo): Promise<void> {
    await this.database.query(
      `INSERT INTO discovered_pools (
        pool_address, dex, program_id, token_mint, wsol_mint, token_vault, wsol_vault,
        lp_mint, token_program, wsol_token_program, creator, open_time_unix, created_slot,
        created_signature, created_instruction_index, confirmation_status, payload, discovered_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'CONFIRMED',$16,$17
      )
      ON CONFLICT (pool_address) DO UPDATE SET
        payload = EXCLUDED.payload,
        confirmation_status = CASE
          WHEN discovered_pools.confirmation_status = 'FINALIZED' THEN 'FINALIZED'
          ELSE EXCLUDED.confirmation_status
        END,
        updated_at = NOW()`,
      [
        pool.pool,
        pool.dex,
        pool.programId,
        pool.tokenMint,
        pool.wsolMint,
        pool.tokenVault,
        pool.wsolVault,
        pool.lpMint,
        pool.tokenProgram,
        pool.wsolTokenProgram,
        pool.creator,
        pool.openTimeUnix.toString(),
        pool.createdSlot.toString(),
        pool.createdSignature,
        pool.createdInstructionIndex,
        toJsonValue(pool),
        new Date(pool.discoveredAtMs),
      ],
    );
  }

  async list(limit: number): Promise<PoolInfo[]> {
    const result = await this.database.query<PayloadRow>(
      'SELECT payload FROM discovered_pools ORDER BY discovered_at DESC LIMIT $1',
      [limit],
    );
    return result.rows.map((row) => decodePayload(row.payload) as PoolInfo);
  }

  async listConfirmedSignatures(): Promise<string[]> {
    const result = await this.database.query<{ readonly created_signature: string }>(
      `SELECT DISTINCT created_signature
       FROM discovered_pools
       WHERE confirmation_status = 'CONFIRMED'
       ORDER BY created_signature`,
    );
    return result.rows.map((row) => row.created_signature);
  }

  async markFinalizedBySignature(signature: string): Promise<PoolInfo[]> {
    return this.updateConfirmation(signature, 'FINALIZED');
  }

  async markOrphanedBySignature(signature: string): Promise<PoolInfo[]> {
    return this.updateConfirmation(signature, 'ORPHANED');
  }

  private async updateConfirmation(signature: string, status: 'FINALIZED' | 'ORPHANED'): Promise<PoolInfo[]> {
    const result = await this.database.query<PayloadRow>(
      `UPDATE discovered_pools
       SET confirmation_status = $2, updated_at = NOW()
       WHERE created_signature = $1
       RETURNING payload`,
      [signature, status],
    );
    return result.rows.map((row) => decodePayload(row.payload) as PoolInfo);
  }
}

export class SessionRepository {
  constructor(private readonly database: Queryable = getDatabasePool()) {}

  async save(session: TokenSession): Promise<void> {
    await this.database.query(
      `INSERT INTO token_sessions (
        session_id, pool_address, token_mint, status, subsequent_buy_count,
        target_buy_count, expires_at, payload, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (session_id) DO UPDATE SET
        status = EXCLUDED.status,
        subsequent_buy_count = EXCLUDED.subsequent_buy_count,
        target_buy_count = EXCLUDED.target_buy_count,
        expires_at = EXCLUDED.expires_at,
        payload = EXCLUDED.payload,
        updated_at = EXCLUDED.updated_at`,
      [
        session.id,
        session.pool.pool,
        session.pool.tokenMint,
        session.status,
        session.subsequentBuyCount,
        session.targetBuysAfterEntry,
        new Date(session.expiresAtMs),
        toJsonValue(session),
        new Date(session.createdAtMs),
        new Date(session.updatedAtMs),
      ],
    );
  }

  async findByPool(pool: string): Promise<TokenSession | null> {
    const result = await this.database.query<PayloadRow>(
      'SELECT payload FROM token_sessions WHERE pool_address = $1 ORDER BY created_at DESC LIMIT 1',
      [pool],
    );
    return result.rows[0] === undefined ? null : decodePayload(result.rows[0].payload) as TokenSession;
  }

  async loadActive(): Promise<TokenSession[]> {
    const result = await this.database.query<PayloadRow>(
      `SELECT payload FROM token_sessions
       WHERE status NOT IN ('CLOSED','REJECTED','EXPIRED','ORPHANED')
       ORDER BY updated_at`,
    );
    return result.rows.map((row) => decodePayload(row.payload) as TokenSession);
  }

  async list(limit: number): Promise<TokenSession[]> {
    const result = await this.database.query<PayloadRow>(
      'SELECT payload FROM token_sessions ORDER BY updated_at DESC LIMIT $1',
      [limit],
    );
    return result.rows.map((row) => decodePayload(row.payload) as TokenSession);
  }

  async countOpenPositions(): Promise<number> {
    const result = await this.database.query<{ readonly count: string }>(
      `SELECT COUNT(*)::text AS count FROM token_sessions
       WHERE status IN ('BUY_PENDING','HOLDING','SELL_PENDING','MANUAL_REVIEW')`,
    );
    return Number(result.rows[0]?.count ?? '0');
  }
}

export class SwapEventRepository {
  constructor(
    private readonly database: Queryable = getDatabasePool(),
    private readonly leaseSeconds = 120,
  ) {}

  async claim(event: SwapEvent): Promise<boolean> {
    const inserted = await this.database.query(
      `INSERT INTO swap_events (
        event_id, pool_address, signature, slot, transaction_index, instruction_index,
        inner_instruction_index, kind, amount_wsol_raw, amount_token_raw,
        confirmation_status, processing_status, payload, observed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PROCESSING',$12,$13)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id`,
      [
        event.id,
        event.pool,
        event.signature,
        event.cursor.slot.toString(),
        event.cursor.transactionIndex,
        event.cursor.instructionIndex,
        event.cursor.innerInstructionIndex,
        event.kind,
        event.amountWsolRaw.toString(),
        event.amountTokenRaw.toString(),
        event.confirmationStatus,
        toJsonValue(event),
        new Date(event.observedAtMs),
      ],
    );
    if (inserted.rowCount === 1) return true;

    const reclaimed = await this.database.query(
      `UPDATE swap_events
       SET processing_status = 'PROCESSING', processing_error = NULL, updated_at = NOW()
       WHERE event_id = $1
         AND (
           processing_status IN ('PENDING','FAILED')
           OR (processing_status = 'PROCESSING' AND updated_at < NOW() - ($2 * INTERVAL '1 second'))
         )
       RETURNING event_id`,
      [event.id, this.leaseSeconds],
    );
    return reclaimed.rowCount === 1;
  }

  async markProcessed(id: string): Promise<void> {
    await this.database.query(
      `UPDATE swap_events SET processing_status = 'PROCESSED', processed_at = NOW(), updated_at = NOW()
       WHERE event_id = $1`,
      [id],
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.database.query(
      `UPDATE swap_events SET processing_status = 'FAILED', processing_error = $2, updated_at = NOW()
       WHERE event_id = $1`,
      [id, error],
    );
  }

  async listConfirmedSignatures(): Promise<string[]> {
    const result = await this.database.query<{ readonly signature: string }>(
      `SELECT DISTINCT signature FROM swap_events
       WHERE confirmation_status = 'CONFIRMED'
       ORDER BY signature`,
    );
    return result.rows.map((row) => row.signature);
  }

  async markFinalizedBySignature(signature: string): Promise<void> {
    await this.markConfirmation(signature, 'FINALIZED');
  }

  async markOrphanedBySignature(signature: string): Promise<void> {
    await this.markConfirmation(signature, 'ORPHANED');
  }

  private async markConfirmation(signature: string, status: 'FINALIZED' | 'ORPHANED'): Promise<void> {
    await this.database.query(
      'UPDATE swap_events SET confirmation_status = $2, updated_at = NOW() WHERE signature = $1',
      [signature, status],
    );
  }
}

export class TradeRepository {
  constructor(private readonly database: Queryable = getDatabasePool()) {}

  async save(trade: TradeRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO trades (
        trade_id, idempotency_key, session_id, pool_address, token_mint, side, mode,
        status, amount_in_raw, amount_out_raw, quoted_out_raw, signature, slot,
        fee_lamports, rent_delta_lamports, priority_fee_lamports, compute_units,
        error, payload, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
      )
      ON CONFLICT (idempotency_key) DO UPDATE SET
        status = EXCLUDED.status,
        amount_out_raw = EXCLUDED.amount_out_raw,
        signature = EXCLUDED.signature,
        slot = EXCLUDED.slot,
        error = EXCLUDED.error,
        payload = EXCLUDED.payload,
        updated_at = EXCLUDED.updated_at`,
      [
        trade.id,
        trade.idempotencyKey,
        trade.sessionId,
        trade.pool,
        trade.tokenMint,
        trade.side,
        trade.mode,
        trade.status,
        trade.amountInRaw.toString(),
        trade.amountOutRaw.toString(),
        trade.quotedOutRaw.toString(),
        trade.signature ?? null,
        trade.slot?.toString() ?? null,
        trade.feeLamports?.toString() ?? null,
        trade.rentDeltaLamports?.toString() ?? null,
        trade.priorityFeeLamports?.toString() ?? null,
        trade.computeUnits?.toString() ?? null,
        trade.error ?? null,
        toJsonValue(trade),
        new Date(trade.createdAtMs),
        new Date(trade.updatedAtMs),
      ],
    );
  }

  async findByIdempotencyKey(key: string): Promise<TradeRecord | null> {
    const result = await this.database.query<PayloadRow>(
      'SELECT payload FROM trades WHERE idempotency_key = $1',
      [key],
    );
    return result.rows[0] === undefined ? null : decodePayload(result.rows[0].payload) as TradeRecord;
  }

  async listBySession(sessionId: string): Promise<TradeRecord[]> {
    const result = await this.database.query<PayloadRow>(
      'SELECT payload FROM trades WHERE session_id = $1 ORDER BY created_at',
      [sessionId],
    );
    return result.rows.map((row) => decodePayload(row.payload) as TradeRecord);
  }
}

export class RiskReportRepository {
  constructor(private readonly database: Queryable = getDatabasePool()) {}

  async save(report: TokenRiskReport): Promise<void> {
    await this.database.query(
      `INSERT INTO token_risk_reports (
        id, session_id, token_mint, pool_address, slot, score, verdict,
        checks, evidence, report, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO NOTHING`,
      [
        report.id,
        report.sessionId,
        report.tokenMint,
        report.pool,
        report.slot.toString(),
        report.score,
        report.verdict,
        toJsonValue(report.checks),
        toJsonValue(report.evidence),
        toJsonValue(report),
        new Date(report.createdAtMs),
      ],
    );
  }

  async latestBySession(sessionId: string): Promise<TokenRiskReport | null> {
    const result = await this.database.query<{ readonly report: unknown }>(
      `SELECT report FROM token_risk_reports
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [sessionId],
    );
    return result.rows[0] === undefined ? null : decodePayload(result.rows[0].report) as TokenRiskReport;
  }
}

export interface ProcessingCheckpoint {
  readonly listenerKey: string;
  readonly slot: bigint;
  readonly signature: string | null;
  readonly transactionIndex: number | null;
  readonly payload: Record<string, unknown>;
  readonly updatedAtMs: number;
}

export class CheckpointRepository {
  constructor(private readonly database: Queryable = getDatabasePool()) {}

  async get(listenerKey: string): Promise<ProcessingCheckpoint | null> {
    const result = await this.database.query<{
      readonly listener_key: string;
      readonly slot: string;
      readonly signature: string | null;
      readonly transaction_index: number | null;
      readonly payload: unknown;
      readonly updated_at: Date;
    }>(
      'SELECT * FROM listener_checkpoints WHERE listener_key = $1',
      [listenerKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      listenerKey: row.listener_key,
      slot: BigInt(row.slot),
      signature: row.signature,
      transactionIndex: row.transaction_index,
      payload: decodePayload(row.payload) as Record<string, unknown>,
      updatedAtMs: row.updated_at.getTime(),
    };
  }

  async save(checkpoint: ProcessingCheckpoint): Promise<void> {
    await this.database.query(
      `INSERT INTO listener_checkpoints (
        listener_key, slot, signature, transaction_index, payload, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (listener_key) DO UPDATE SET
        slot = EXCLUDED.slot,
        signature = EXCLUDED.signature,
        transaction_index = EXCLUDED.transaction_index,
        payload = EXCLUDED.payload,
        updated_at = EXCLUDED.updated_at`,
      [
        checkpoint.listenerKey,
        checkpoint.slot.toString(),
        checkpoint.signature,
        checkpoint.transactionIndex,
        toJsonValue(checkpoint.payload),
        new Date(checkpoint.updatedAtMs),
      ],
    );
  }
}

function decodePayload(value: unknown): unknown {
  return fromJsonValue(value);
}

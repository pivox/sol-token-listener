import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type {
  CheckpointProgram,
  CheckpointRebaseGap,
  CheckpointRebasePlan,
  CheckpointRebaseRepository,
  CheckpointRebaseState,
  ProcessingCheckpointSnapshot,
} from '../application/checkpoint-rebase-operator.js';
import {
  isDemonstratedOutOfWindow,
  type RecordedLiveEdgeCutoverPlan,
} from '../application/recorded-live-edge-cutover.js';

export class PostgresCheckpointRebaseRepository implements CheckpointRebaseRepository {
  public constructor(private readonly pool: Pool) {}

  public async inspect(program: CheckpointProgram): Promise<CheckpointRebaseState> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const checkpointResult = await client.query<QueryResultRow>(
        `SELECT checkpoint_key, source, program, slot, signature, transaction_index, payload, updated_at
         FROM processing_checkpoints WHERE checkpoint_key = $1`,
        [program],
      );
      const checkpointRow = checkpointResult.rows[0];
      const availability = await client.query<{ available: boolean }>(
        "SELECT pg_catalog.to_regclass('processing_checkpoint_rebase_gaps') IS NOT NULL AS available",
      );
      const auditTableAvailable = availability.rows[0]?.available === true;
      let latestGap: CheckpointRebaseGap | null = null;
      if (auditTableAvailable) {
        const gapResult = await client.query<QueryResultRow>(
          `SELECT checkpoint_key, previous_slot, previous_signature, new_slot, new_signature,
                  finalized_head_slot, genesis_hash, reason, recorded_at
           FROM processing_checkpoint_rebase_gaps
           WHERE checkpoint_key = $1 ORDER BY recorded_at DESC, rebase_id DESC LIMIT 1`,
          [program],
        );
        const gapRow = gapResult.rows[0];
        latestGap = gapRow === undefined ? null : gapFromRow(gapRow);
      }
      await client.query('COMMIT');
      return Object.freeze({
        checkpoint: checkpointRow === undefined ? null : checkpointFromRow(checkpointRow),
        latestGap,
        auditTableAvailable,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async apply(plan: CheckpointRebasePlan): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('transaction-checkpoint:' || $1, 0))",
        [plan.previous.key],
      );
      const selected = await client.query<QueryResultRow>(
        `SELECT checkpoint_key, source, program, slot, signature, transaction_index, payload, updated_at
         FROM processing_checkpoints WHERE checkpoint_key = $1 FOR UPDATE`,
        [plan.previous.key],
      );
      const row = selected.rows[0];
      if (row === undefined) throw new Error('Checkpoint disappeared before rebase.');
      const current = checkpointFromRow(row);
      if (!sameCheckpoint(current, plan.previous)) {
        const priorGap = await client.query<{ new_slot: unknown; new_signature: unknown }>(
          `SELECT new_slot, new_signature FROM processing_checkpoint_rebase_gaps
           WHERE checkpoint_key = $1 AND previous_slot = $2
             AND previous_signature IS NOT DISTINCT FROM $3`,
          [plan.previous.key, plan.previous.slot.toString(), plan.previous.signature],
        );
        if (priorGap.rows.length === 1
          && current.slot >= numericBigInt(priorGap.rows[0]?.new_slot)
          && current.signature === text(priorGap.rows[0]?.new_signature)) {
          await client.query('COMMIT');
          return 'ALREADY_APPLIED';
        }
        throw new Error('Checkpoint changed after the operator plan was created.');
      }
      if (current.slot <= plan.finalizedHeadSlot || plan.next.slot > plan.finalizedHeadSlot) {
        throw new Error('Checkpoint no longer satisfies the future-slot rebase guard.');
      }
      const duplicate = await client.query(
        `SELECT rebase_id FROM processing_checkpoint_rebase_gaps
         WHERE checkpoint_key = $1 AND previous_slot = $2
           AND previous_signature IS NOT DISTINCT FROM $3`,
        [current.key, current.slot.toString(), current.signature],
      );
      if (duplicate.rows.length > 0) throw new Error('Checkpoint rebase evidence already exists for this old checkpoint.');

      await client.query(
        `INSERT INTO processing_checkpoint_rebase_gaps (
           rebase_id, checkpoint_key, previous_source, previous_program, previous_slot,
           previous_signature, previous_transaction_index, previous_payload, previous_updated_at,
           new_slot, new_signature, finalized_head_slot, genesis_hash, reason, recorded_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,
        [randomUUID(), current.key, current.source, current.program, current.slot.toString(),
          current.signature, current.transactionIndex, JSON.stringify(current.payload),
          new Date(current.updatedAtMs), plan.next.slot.toString(), plan.next.signature,
          plan.finalizedHeadSlot.toString(), plan.genesisHash, plan.reason, new Date(plan.recordedAtMs)],
      );
      const updated = await client.query(
        `UPDATE processing_checkpoints SET source = 'transaction-inbox', program = $2,
           slot = $3, signature = $4, transaction_index = NULL, payload = '{}'::jsonb, updated_at = $5
         WHERE checkpoint_key = $1 AND slot = $6 AND signature IS NOT DISTINCT FROM $7`,
        [current.key, current.key, plan.next.slot.toString(), plan.next.signature,
          new Date(plan.recordedAtMs), current.slot.toString(), current.signature],
      );
      if (updated.rowCount !== 1) throw new Error('Checkpoint changed while applying the rebase.');
      await client.query('COMMIT');
      return 'APPLIED';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async applyRecordedLiveEdgeCutover(
    plan: RecordedLiveEdgeCutoverPlan,
  ): Promise<Readonly<{ status: 'APPLIED' | 'ALREADY_APPLIED'; evidenceId: string }>> {
    const evidenceId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('transaction-checkpoint:' || $1, 0))",
        [plan.program],
      );
      const selected = await client.query<QueryResultRow>(
        `SELECT checkpoint_key, source, program, slot, signature, transaction_index, payload, updated_at
         FROM processing_checkpoints WHERE checkpoint_key = $1 FOR UPDATE`,
        [plan.program],
      );
      const row = selected.rows[0];
      if (row === undefined) throw new Error('Checkpoint disappeared before live-edge cutover.');
      const current = checkpointFromRow(row);
      if (!sameCheckpoint(current, plan.previous)) {
        const existing = await client.query<{ rebase_id: unknown; new_slot: unknown; new_signature: unknown;
          finalized_head_slot: unknown; reason: unknown }>(
          `SELECT rebase_id, new_slot, new_signature, finalized_head_slot, reason
           FROM processing_checkpoint_rebase_gaps
           WHERE checkpoint_key = $1 AND previous_slot = $2
             AND previous_signature IS NOT DISTINCT FROM $3
             AND reason = 'operator-approved-live-edge-cutover'`,
          [plan.program, plan.previous.slot.toString(), plan.previous.signature],
        );
        const prior = existing.rows[0];
        if (prior !== undefined
          && current.slot === numericBigInt(prior.new_slot)
          && current.signature === text(prior.new_signature)
          && numericBigInt(prior.finalized_head_slot) === plan.frontier.slot) {
          await client.query('COMMIT');
          return Object.freeze({ status: 'ALREADY_APPLIED', evidenceId: text(prior.rebase_id) });
        }
        throw new Error('Checkpoint changed after the recorded live-edge plan was created.');
      }
      if (plan.previous.signature === null
        || plan.frontier.program !== plan.program
        || plan.previous.slot >= plan.frontier.slot
        || plan.scan.program !== plan.program
        || plan.scan.frontierSlot !== plan.frontier.slot.toString()
        || plan.scan.frontierSignature !== plan.frontier.signature
        || plan.scan.checkpointSlot !== plan.previous.slot.toString()
        || plan.scan.checkpointSignatureFound
        || !isDemonstratedOutOfWindow(plan.scan, {
          pageSize: plan.scan.pageSize,
          maxPages: plan.scan.maxPages,
        })) {
        throw new Error('Recorded live-edge cutover evidence is invalid.');
      }

      const evidence = Object.freeze({
        schema: 'listener.live-edge-cutover.v2',
        reason: 'operator-approved-live-edge-cutover',
        operatorOption: '--allow-recorded-live-edge-cutover',
        frontier: {
          program: plan.frontier.program,
          signature: plan.frontier.signature,
          slot: plan.frontier.slot.toString(),
          confirmationStatus: plan.frontier.confirmationStatus,
        },
        frontierSlot: plan.frontier.slot.toString(),
        frontierSignature: plan.frontier.signature,
        scan: plan.scan,
      });
      await client.query(
        `INSERT INTO processing_checkpoint_rebase_gaps (
           rebase_id, checkpoint_key, previous_source, previous_program, previous_slot,
           previous_signature, previous_transaction_index, previous_payload, previous_updated_at,
           new_slot, new_signature, finalized_head_slot, genesis_hash, reason, recorded_at, evidence
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,
                   'operator-approved-live-edge-cutover',$14,$15::jsonb)`,
        [evidenceId, plan.program, current.source, current.program, current.slot.toString(),
          current.signature, current.transactionIndex, JSON.stringify(current.payload),
          new Date(current.updatedAtMs), plan.frontier.slot.toString(), plan.frontier.signature,
          plan.frontier.slot.toString(), plan.genesisHash, new Date(plan.recordedAtMs),
          JSON.stringify(evidence)],
      );
      const updated = await client.query(
        `UPDATE processing_checkpoints SET source = 'transaction-inbox', program = $2,
           slot = $3, signature = $4, transaction_index = NULL, payload = '{}'::jsonb, updated_at = $5
         WHERE checkpoint_key = $1 AND slot = $6 AND signature IS NOT DISTINCT FROM $7`,
        [plan.program, plan.program, plan.frontier.slot.toString(), plan.frontier.signature,
          new Date(plan.recordedAtMs), current.slot.toString(), current.signature],
      );
      if (updated.rowCount !== 1) throw new Error('Checkpoint changed during the live-edge transaction.');
      await client.query('COMMIT');
      return Object.freeze({ status: 'APPLIED', evidenceId });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function checkpointFromRow(row: QueryResultRow): ProcessingCheckpointSnapshot {
  const key = text(row.checkpoint_key);
  if (key !== 'launchpad' && key !== 'market') throw new TypeError('Invalid checkpoint key.');
  const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at));
  if (!Number.isFinite(updatedAt.getTime())) throw new TypeError('Invalid checkpoint timestamp.');
  const transactionIndex = row.transaction_index === null ? null : Number(row.transaction_index);
  if (transactionIndex !== null && (!Number.isSafeInteger(transactionIndex) || transactionIndex < 0)) {
    throw new TypeError('Invalid checkpoint transaction index.');
  }
  return Object.freeze({
    key,
    source: text(row.source),
    program: text(row.program),
    slot: numericBigInt(row.slot),
    signature: row.signature === null ? null : text(row.signature),
    transactionIndex,
    payload: row.payload as unknown,
    updatedAtMs: updatedAt.getTime(),
  });
}

function gapFromRow(row: QueryResultRow): CheckpointRebaseGap {
  const program = text(row.checkpoint_key);
  if (program !== 'launchpad' && program !== 'market') throw new TypeError('Invalid checkpoint key.');
  const reason = text(row.reason);
  if (reason !== 'invalid-future-checkpoint'
    && reason !== 'operator-approved-live-edge-cutover') {
    throw new TypeError('Invalid checkpoint rebase reason.');
  }
  const recordedAt = row.recorded_at instanceof Date ? row.recorded_at : new Date(String(row.recorded_at));
  if (!Number.isFinite(recordedAt.getTime())) throw new TypeError('Invalid checkpoint rebase timestamp.');
  return Object.freeze({
    program,
    previousSlot: numericBigInt(row.previous_slot),
    previousSignature: row.previous_signature === null ? null : text(row.previous_signature),
    newSlot: numericBigInt(row.new_slot),
    newSignature: text(row.new_signature),
    finalizedHeadSlot: numericBigInt(row.finalized_head_slot),
    genesisHash: text(row.genesis_hash),
    reason,
    recordedAtMs: recordedAt.getTime(),
  });
}

function sameCheckpoint(left: ProcessingCheckpointSnapshot, right: ProcessingCheckpointSnapshot): boolean {
  return left.key === right.key && left.slot === right.slot && left.signature === right.signature
    && left.updatedAtMs === right.updatedAtMs;
}

function numericBigInt(value: unknown): bigint {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new TypeError('Invalid checkpoint integer.');
  }
  const parsed = BigInt(value);
  if (parsed < 0n) throw new TypeError('Invalid checkpoint integer.');
  return parsed;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Invalid checkpoint text.');
  return value;
}

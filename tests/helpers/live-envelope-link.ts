import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { mutateWithTriggersDisabled } from './execution-preflight-v2-source-fixture.js';

export type EnvelopeSeed = Readonly<{
  state: 'ACTIVE' | 'REVOKED' | 'EXPIRED'; priorLossRaw: string; maxLossRaw: string;
}>;

/**
 * A lot-3 shaped (payload v1) envelope row of the fixture generation. The realized-loss update
 * does not depend on the envelope payload version, and a v2 envelope cannot be created for the
 * fixture's exact-signing wallet, so the row is inserted directly.
 */
export async function insertEnvelope(
  pool: InstanceType<typeof pg.Pool>,
  generationId: string,
  seed: EnvelopeSeed,
): Promise<string> {
  const envelopeId = `envelope:${randomUUID()}`;
  await pool.query(`INSERT INTO execution_entry_envelopes (
    envelope_id,generation_id,operator_id,payload_version,fingerprint,per_buy_quote_amount_raw,
    max_buys,max_open_positions,max_total_exposure_raw,max_realized_loss_raw,valid_from,
    valid_until,state,realized_loss_raw,revoked_at,created_at,updated_at
  ) VALUES ($1,$2,'operator-primary',1,$3,1000,3,1,3000,$4::NUMERIC,
    date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 minute',
    date_trunc('milliseconds',statement_timestamp())+INTERVAL '1 hour',$5,$6::NUMERIC,
    CASE WHEN $5='REVOKED' THEN date_trunc('milliseconds',statement_timestamp()) END,
    date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 minute',
    date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 minute')`, [
    envelopeId, generationId, 'e'.repeat(64), seed.maxLossRaw, seed.state, seed.priorLossRaw,
  ]);
  return envelopeId;
}

/** Binds the fixture position's armament to a new envelope (envelope_id is immutable). */
export async function linkEnvelope(
  pool: InstanceType<typeof pg.Pool>,
  generationId: string,
  seed: EnvelopeSeed,
): Promise<string> {
  const envelopeId = await insertEnvelope(pool, generationId, seed);
  await mutateWithTriggersDisabled(pool, `UPDATE execution_activation_armaments SET envelope_id=$1
    WHERE armament_id=(SELECT armament_id FROM execution_live_positions)`, [envelopeId]);
  return envelopeId;
}

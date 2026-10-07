import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '065_entry_envelope_auto_arm.sql';
const GENERATION_ID = `execution_wallet_generation_${'a'.repeat(64)}`;
const ENVELOPE_FINGERPRINT = 'e'.repeat(64);
const ENVELOPE_ID = `execution_entry_envelope_${ENVELOPE_FINGERPRINT}`;
const ENVELOPE_AUTHORIZATION_ID = `execution_operator_authorization_${'9'.repeat(64)}`;
const ARM_AUTHORIZATION_ID = `execution_operator_authorization_${'c'.repeat(64)}`;
const QUALIFICATION_ID = `execution_safety_qualification_${'b'.repeat(64)}`;
const PUBLIC_KEY = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const POLICY_FINGERPRINT = 'b'.repeat(64);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

void test('065 declares the envelope scope, the ENVELOPE action and the envelope-bound armament', async () => {
  const sql = await readFile(new URL(`../migrations/${migrationName}`, import.meta.url), 'utf8');
  for (const fragment of [
    "ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'CANARY'",
    'execution_safety_qualifications_envelope_fkey',
    "envelope_id ~ '^execution_entry_envelope_[0-9a-f]{64}$'",
    "INTERVAL '24 hours'",
    "action='ENVELOPE' AND phase IS NULL",
    "'EXECUTOR_COUNTERS'",
    'execution_entry_envelopes_v2_check',
    'guard_execution_entry_envelope_insert',
    'guard_execution_entry_envelope_update',
    'execution_activation_armaments_envelope_fkey',
    "NEW.target_strategy_id='fast-entry-v1'",
    "INTERVAL '15 minutes'",
    'qualification.expires_at=envelope.valid_until',
    "operator_auth.action='ENVELOPE'",
    'NEW.envelope_id IS DISTINCT FROM OLD.envelope_id',
    'envelope counter update required',
  ]) assert.ok(sql.includes(fragment), `missing migration contract: ${fragment}`);
  assert.doesNotMatch(sql, /\b(?:DELETE FROM|TRUNCATE|DROP TABLE)\b/u);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/u);
});

void test('065 applies on an empty schema and replays cleanly', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationName);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    const sql = await readFile(new URL(`../migrations/${migrationName}`, import.meta.url), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
  });
});

void test('065 scopes safety qualifications: CANARY 5 minutes, ENVELOPE bound and at most 24 hours', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    const nowMs = await seedGeneration(pool);
    await insertEnvelopeAuthorization(pool, { nowMs });
    await insertV2Envelope(pool, { nowMs });
    const at = new Date(nowMs);

    await insertQualification(pool, { id: '1', qualifiedAt: at, expiresInMs: 5 * MINUTE });
    await assert.rejects(insertQualification(pool, { id: '2', qualifiedAt: at, expiresInMs: 6 * MINUTE }),
      { code: '23514' });
    await insertQualification(pool, { id: '3', qualifiedAt: at, expiresInMs: 23 * HOUR,
      payloadVersion: 2, scope: 'ENVELOPE', envelopeId: ENVELOPE_ID });
    await assert.rejects(insertQualification(pool, { id: '4', qualifiedAt: at, expiresInMs: 25 * HOUR,
      payloadVersion: 2, scope: 'ENVELOPE', envelopeId: ENVELOPE_ID }), { code: '23514' });
    await assert.rejects(insertQualification(pool, { id: '5', qualifiedAt: at, expiresInMs: 23 * HOUR,
      payloadVersion: 2, scope: 'ENVELOPE', envelopeId: null }), { code: '23514' });
    await assert.rejects(insertQualification(pool, { id: '6', qualifiedAt: at, expiresInMs: 5 * MINUTE,
      payloadVersion: 1, scope: 'ENVELOPE', envelopeId: ENVELOPE_ID }), { code: '23514' });
    await assert.rejects(insertQualification(pool, { id: '7', qualifiedAt: at, expiresInMs: 23 * HOUR,
      payloadVersion: 2, scope: 'ENVELOPE', envelopeId: ENVELOPE_ID, phase: 'PILOT' }), { code: '23514' });
    await assert.rejects(insertQualification(pool, { id: '8', qualifiedAt: at, expiresInMs: 23 * HOUR,
      payloadVersion: 2, scope: 'ENVELOPE', envelopeId: `execution_entry_envelope_${'0'.repeat(64)}` }),
    { code: '23503' });
    await assert.rejects(pool.query(`UPDATE execution_safety_qualifications SET provider_id='other'
      WHERE qualification_id=$1`, [qualificationId('3')]), { code: '55000' });
    const scopes = await pool.query<{ readonly scope: string }>(`SELECT scope
      FROM execution_safety_qualifications ORDER BY qualification_id`);
    assert.deepEqual(scopes.rows.map((row) => row.scope), ['CANARY', 'ENVELOPE']);
  });
});

void test('065 admits the v1 ENVELOPE authorization and still forbids a new v1 ARM', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    const nowMs = await seedGeneration(pool);
    await insertEnvelopeAuthorization(pool, { nowMs, consumed: false });
    await assert.rejects(insertEnvelopeAuthorization(pool, { nowMs, id: '1', phase: 'CANARY' }),
      { code: '23514' });
    await assert.rejects(insertEnvelopeAuthorization(pool, { nowMs, id: '2', action: 'ARM', phase: 'CANARY' }),
      { code: '55000' });
    await assert.rejects(insertEnvelopeAuthorization(pool, { nowMs, id: '3', payloadVersion: 2 }),
      { code: '55000' });
    await pool.query(`UPDATE execution_operator_authorizations
      SET consumed_at=issued_at, purge_after=issued_at+INTERVAL '4 hours' WHERE authorization_id=$1`,
    [ENVELOPE_AUTHORIZATION_ID]);
  });
});

void test('065 admits an EXECUTOR_COUNTERS provider snapshot and nothing else new', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    await insertProviderSnapshot(pool, '1', 'EXECUTOR_COUNTERS');
    await assert.rejects(insertProviderSnapshot(pool, '2', 'GUESSED'), { code: '23514' });
  });
});

void test('065 guards the v2 envelope insert with a consumed v1 ENVELOPE authorization', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    const nowMs = await seedGeneration(pool);
    await assert.rejects(insertV2Envelope(pool, { nowMs }), { code: '55000' });
    await insertEnvelopeAuthorization(pool, { nowMs, consumed: false });
    await assert.rejects(insertV2Envelope(pool, { nowMs }), { code: '55000' });
    await insertEnvelopeAuthorization(pool, { nowMs, id: '1', consumed: true });
    await insertEnvelopeAuthorization(pool, { nowMs, id: '2', consumed: true, action: 'RESUME' });
    // A7: the guard binds the envelope's own authorization id and its ENVELOPE action.
    await assert.rejects(insertV2Envelope(pool, { nowMs, authorizationId: authorizationId('3') }),
      { code: '55000' });
    await assert.rejects(insertV2Envelope(pool, { nowMs, authorizationId: authorizationId('2') }),
      { code: '55000' });
    await assert.rejects(insertV2Envelope(pool, { nowMs, authorizationId: authorizationId('1'),
      operatorId: 'intruder' }), { code: '55000' });
    await assert.rejects(insertV2Envelope(pool, { nowMs, authorizationId: authorizationId('1'),
      state: 'EXHAUSTED' }), { code: '55000' });
    await assert.rejects(insertV2Envelope(pool, { nowMs, authorizationId: authorizationId('1'),
      validFromMs: nowMs + MINUTE }), { code: '55000' });
    await assert.rejects(insertV2Envelope(pool, { nowMs, authorizationId: authorizationId('1'),
      maxTotalExposure: '0' }), { code: '23514' });
    await assert.rejects(insertV2Envelope(pool, { nowMs, authorizationId: authorizationId('1'),
      perBuy: '4', maxTotalExposure: '3' }), { code: '23514' });
    await assert.rejects(insertV2Envelope(pool, { nowMs, authorizationId: authorizationId('1'),
      envelopeId: `execution_entry_envelope_${'0'.repeat(64)}` }), { code: '23514' });
    for (const column of ['risk_policy', 'policy_fingerprint', 'maximum_holding_ms']) {
      await assert.rejects(insertV2Envelope(pool, { nowMs, authorizationId: authorizationId('1'),
        nullColumn: column }), { code: '23514' }, column);
    }
    const microsecondUntil = (await pool.query<{ readonly value: string }>(`SELECT
      to_char(to_timestamp($1::DOUBLE PRECISION/1000) AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS') || '123+00' AS value`, [nowMs + 2 * HOUR])).rows[0]?.value ?? '';
    await assert.rejects(insertV2Envelope(pool, { nowMs, authorizationId: authorizationId('1'),
      validUntilText: microsecondUntil }), { code: '23514' });
    await insertV2Envelope(pool, { nowMs, authorizationId: authorizationId('1') });
    await pool.query(`INSERT INTO execution_entry_envelopes (
      envelope_id,generation_id,operator_id,payload_version,fingerprint,per_buy_quote_amount_raw,
      max_buys,max_open_positions,max_total_exposure_raw,max_realized_loss_raw,valid_from,valid_until,
      state,buys_armed,revoked_at,created_at,updated_at
    ) VALUES ('lot-3-envelope','lot-3-generation','operator',1,$1,10000000,5,1,1000000000,500000000,
      $2,$3,'ACTIVE',0,NULL,$2,$2)`, ['a'.repeat(64), new Date(nowMs - MINUTE), new Date(nowMs + HOUR)]);
  });
});

void test('065 envelope insert guard rejects stale, retired, pre-counted, revoked or closed envelopes', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    const nowMs = await seedGeneration(pool);
    await insertEnvelopeAuthorization(pool, { nowMs, id: '1', issuedOffsetMs: -10 * MINUTE });
    await assert.rejects(insertV2Envelope(pool, { nowMs, authorizationId: authorizationId('1') }),
      { code: '55000' }, 'expired authorization');
    await insertEnvelopeAuthorization(pool, { nowMs });
    await assert.rejects(insertV2Envelope(pool, { nowMs, buysArmed: 1 }), { code: '55000' }, 'buys_armed');
    await assert.rejects(insertV2Envelope(pool, { nowMs, revokedAt: new Date(nowMs) }),
      { code: '55000' }, 'revoked_at');
    await assert.rejects(insertV2Envelope(pool, { nowMs, validUntilMs: nowMs - 1_000 }),
      { code: '55000' }, 'valid_until');
    await withReplicaRole(pool, () => pool.query(`UPDATE execution_wallet_generations
      SET retired_at=created_at WHERE generation_id=$1`, [GENERATION_ID]));
    await assert.rejects(insertV2Envelope(pool, { nowMs }), { code: '55000' }, 'retired generation');
  });
});

void test('065 refuses arming a closed, exhausted or not-yet-open envelope', async (context) => {
  for (const scenario of [
    { maxBuys: 1, maxTotalExposure: '1' },
    { maxBuys: 3, maxTotalExposure: '1' },
  ] as const) {
    await withTemporarySchema(context, async (pool) => {
      await migrateDatabase({ pool });
      await seedEnvelopeArmament(pool, scenario);
      await insertEnvelopeArmament(pool);
      await assert.rejects(insertEnvelopeArmament(pool),
        { code: '55000', message: /guarded V2 armament insert required/u }, 'second arm');
      assert.deepEqual(await envelopeCounters(pool), { buys_armed: 1, state: 'EXHAUSTED' });
    });
  }
  const forced: readonly Readonly<{ name: string; seed?: EnvelopeArmamentSeed; assignments: string; buys: number }>[] = [
    { name: 'revoked', assignments: "state='REVOKED',revoked_at=updated_at", buys: 0 },
    { name: 'expired', assignments: "state='EXPIRED'", buys: 0 },
    { name: 'max_buys', seed: { maxBuys: 3, maxTotalExposure: '3' }, assignments: 'buys_armed=3', buys: 3 },
    { name: 'total_exposure', seed: { maxBuys: 3, maxTotalExposure: '2' }, assignments: 'buys_armed=2', buys: 2 },
    { name: 'valid_from_future', assignments: "valid_from=date_trunc('milliseconds',statement_timestamp())+INTERVAL '1 minute'", buys: 0 },
  ];
  for (const variant of forced) {
    await withTemporarySchema(context, async (pool) => {
      await migrateDatabase({ pool });
      await seedEnvelopeArmament(pool, {
        ...variant.seed,
        ...(variant.name === 'valid_from_future' ? { intentRequestedOffsetMs: 3 * MINUTE } : {}),
      });
      await withReplicaRole(pool, () => pool.query(
        `UPDATE execution_entry_envelopes SET ${variant.assignments} WHERE envelope_id=$1`, [ENVELOPE_ID]));
      await assert.rejects(insertEnvelopeArmament(pool),
        { code: '55000', message: /guarded V2 armament insert required/u }, variant.name);
      assert.equal((await envelopeCounters(pool)).buys_armed, variant.buys, variant.name);
    });
  }
});

async function envelopeCounters(pool: pg.Pool): Promise<Readonly<{ buys_armed: number; state: string }>> {
  const result = await pool.query<{ readonly buys_armed: number; readonly state: string }>(
    'SELECT buys_armed,state FROM execution_entry_envelopes WHERE envelope_id=$1', [ENVELOPE_ID]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('envelope row missing');
  return { buys_armed: row.buys_armed, state: row.state };
}

async function withReplicaRole(pool: pg.Pool, run: () => Promise<unknown>): Promise<void> {
  await pool.query('SET session_replication_role = replica');
  try {
    await run();
  } finally {
    await pool.query('SET session_replication_role = origin');
  }
}

void test('065 keeps envelope identity immutable and its counters monotonic', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    const nowMs = await seedGeneration(pool);
    await insertEnvelopeAuthorization(pool, { nowMs });
    await insertV2Envelope(pool, { nowMs, maxBuys: 5 });
    const update = (assignments: string): Promise<unknown> => pool.query(
      `UPDATE execution_entry_envelopes SET ${assignments} WHERE envelope_id=$1`, [ENVELOPE_ID]);

    await update('buys_armed=1');
    await assert.rejects(update('buys_armed=0'), { code: '55000' });
    await assert.rejects(update('buys_armed=4'), { code: '23514' });
    await assert.rejects(update('per_buy_quote_amount_raw=2'), { code: '55000' });
    await assert.rejects(update("policy_fingerprint='" + 'c'.repeat(64) + "'"), { code: '55000' });
    await assert.rejects(update('valid_until=valid_until+INTERVAL \'1 minute\''), { code: '55000' });
    await assert.rejects(update(`authorization_id='${authorizationId('7')}'`), { code: '55000' });
    await assert.rejects(update('updated_at=updated_at-INTERVAL \'1 second\''), { code: '55000' });
    await update('realized_loss_raw=1');
    await assert.rejects(update('realized_loss_raw=0'), { code: '55000' });
    await update("state='REVOKED',revoked_at=updated_at");
    await assert.rejects(update("state='ACTIVE',revoked_at=NULL"), { code: '55000' });
    await assert.rejects(update('revoked_at=revoked_at+INTERVAL \'1 second\''), { code: '55000' });
    await update('realized_loss_raw=2');
  });
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    const nowMs = await seedGeneration(pool);
    await insertEnvelopeAuthorization(pool, { nowMs });
    await insertV2Envelope(pool, { nowMs });
    await pool.query(`UPDATE execution_entry_envelopes SET state='EXPIRED' WHERE envelope_id=$1`, [ENVELOPE_ID]);
    await assert.rejects(pool.query(`UPDATE execution_entry_envelopes SET state='EXHAUSTED'
      WHERE envelope_id=$1`, [ENVELOPE_ID]), { code: '55000' });
  });
});

void test('065 arms an ENVELOPE armament, counts it and exhausts the envelope at its cap', async (context) => {
  for (const scenario of [
    { maxBuys: 1, maxTotalExposure: '1', state: 'EXHAUSTED' },
    { maxBuys: 3, maxTotalExposure: '1', state: 'EXHAUSTED' },
    { maxBuys: 3, maxTotalExposure: '2', state: 'ACTIVE' },
    { maxBuys: 3, maxTotalExposure: '3', state: 'ACTIVE' },
  ] as const) {
    await withTemporarySchema(context, async (pool) => {
      await migrateDatabase({ pool });
      await seedEnvelopeArmament(pool, scenario);
      await insertEnvelopeArmament(pool);
      const envelope = await pool.query<{ readonly buys_armed: number; readonly state: string }>(
        'SELECT buys_armed,state FROM execution_entry_envelopes WHERE envelope_id=$1', [ENVELOPE_ID]);
      assert.deepEqual({ ...envelope.rows[0] }, { buys_armed: 1, state: scenario.state });
      // A8: the armament's envelope binding is immutable.
      await assert.rejects(pool.query(`UPDATE execution_activation_armaments
        SET envelope_id=NULL,state_revision=state_revision+1,state='REVOKED',terminal_at=armed_at,
          purge_after=armed_at+INTERVAL '4 hours'`),
      { code: '55000', message: /identity is immutable/u });
      await pool.query(`UPDATE execution_activation_armaments
        SET state_revision=state_revision+1,state='REVOKED',terminal_at=armed_at,
          purge_after=armed_at+INTERVAL '4 hours'`);
    });
  }
});

void test('065 refuses an ENVELOPE armament outside its envelope binding', async (context) => {
  const variants: readonly Readonly<{ name: string; seed?: EnvelopeArmamentSeed; armament?: ArmamentOverrides }>[] = [
    // A6: the qualification must expire exactly at the envelope's end.
    { name: 'qualification_expiry', seed: { qualificationExpiryOffsetMs: -1_000 } },
    { name: 'arming_cut_off', seed: { validUntilOffsetMs: 10 * MINUTE } },
    { name: 'strategy', seed: { strategyId: 'strategy' } },
    { name: 'no_envelope_id', armament: { envelopeId: null } },
    { name: 'canary_qualification', seed: { canaryQualification: true } },
    { name: 'policy', armament: { policyFingerprint: 'd'.repeat(64) } },
    { name: 'holding', armament: { maximumHoldingMs: 60_000 } },
    { name: 'per_buy', seed: { perBuy: '2', maxTotalExposure: '6' } },
    { name: 'loss_cap', seed: { realizedLoss: true } },
    { name: 'intent_before_envelope', seed: { intentRequestedOffsetMs: -2 * MINUTE } },
    { name: 'operator', seed: { armOperatorId: 'other' }, armament: { operatorId: 'other' } },
  ];
  for (const variant of variants) {
    await withTemporarySchema(context, async (pool) => {
      await migrateDatabase({ pool });
      await seedEnvelopeArmament(pool, variant.seed ?? {});
      await assert.rejects(insertEnvelopeArmament(pool, variant.armament ?? {}),
        { code: '55000', message: /guarded V2 armament insert required/u }, variant.name);
      const envelope = await pool.query<{ readonly buys_armed: number }>(
        'SELECT buys_armed FROM execution_entry_envelopes WHERE envelope_id=$1', [ENVELOPE_ID]);
      assert.equal(envelope.rows[0]?.buys_armed, 0, variant.name);
    });
  }
});

void test('065 refuses a CANARY armament that names an envelope', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    await seedEnvelopeArmament(pool, { canaryQualification: true });
    await assert.rejects(insertEnvelopeArmament(pool, { envelopeId: ENVELOPE_ID }),
      { code: '55000', message: /guarded V2 armament insert required/u });
    await insertEnvelopeArmament(pool, { envelopeId: null });
    const envelope = await pool.query<{ readonly buys_armed: number }>(
      'SELECT buys_armed FROM execution_entry_envelopes WHERE envelope_id=$1', [ENVELOPE_ID]);
    assert.equal(envelope.rows[0]?.buys_armed, 0);
  });
});

type EnvelopeArmamentSeed = Readonly<{
  maxBuys?: number;
  maxTotalExposure?: string;
  perBuy?: string;
  qualificationExpiryOffsetMs?: number;
  validUntilOffsetMs?: number;
  strategyId?: string;
  canaryQualification?: boolean;
  realizedLoss?: boolean;
  intentRequestedOffsetMs?: number;
  armOperatorId?: string;
}>;

type ArmamentOverrides = Readonly<{
  envelopeId?: string | null;
  policyFingerprint?: string;
  maximumHoldingMs?: number;
  operatorId?: string;
}>;

let currentTargetId = '';

async function seedEnvelopeArmament(pool: pg.Pool, seed: EnvelopeArmamentSeed): Promise<void> {
  const nowMs = await seedGeneration(pool);
  const validFromMs = nowMs - MINUTE;
  const validUntilMs = nowMs + (seed.validUntilOffsetMs ?? 2 * HOUR);
  await insertEnvelopeAuthorization(pool, { nowMs });
  await insertV2Envelope(pool, {
    nowMs, validFromMs, validUntilMs, maxBuys: seed.maxBuys ?? 3,
    maxTotalExposure: seed.maxTotalExposure ?? '3', perBuy: seed.perBuy ?? '1',
  });
  if (seed.realizedLoss === true) {
    await pool.query(`UPDATE execution_entry_envelopes SET realized_loss_raw=max_realized_loss_raw
      WHERE envelope_id=$1`, [ENVELOPE_ID]);
  }
  const qualifiedAt = new Date(nowMs - 1_000);
  if (seed.canaryQualification === true) {
    await insertQualification(pool, { id: 'b', qualifiedAt, expiresInMs: 5 * MINUTE,
      fingerprint: '1'.repeat(64) });
  } else {
    await insertQualification(pool, {
      id: 'b', qualifiedAt, fingerprint: '1'.repeat(64), payloadVersion: 2, scope: 'ENVELOPE',
      envelopeId: ENVELOPE_ID,
      expiresInMs: validUntilMs + (seed.qualificationExpiryOffsetMs ?? 0) - qualifiedAt.getTime(),
    });
  }
  const target = createExecutionIntentDraft({
    strategyId: seed.strategyId ?? 'fast-entry-v1', strategyVersion: 1, positionId: 'position',
    logicalCommandId: 'command', mint: PUBLIC_KEY, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: WSOL, quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: 1n,
    baseAmountRaw: null, minimumAmountOutRaw: 1n, decisionEventId: 'decision',
    decisionFingerprint: '8'.repeat(64),
    requestedAtMs: validFromMs + (seed.intentRequestedOffsetMs ?? MINUTE - 1_000),
    expiresAtMs: nowMs + 600_000,
  });
  currentTargetId = target.id;
  const now = `date_trunc('milliseconds',statement_timestamp())`;
  const gateExpiry = new Date(seed.canaryQualification === true ? nowMs + 5 * MINUTE : validUntilMs);
  const bindingEvidence = seed.canaryQualification !== true;
  await pool.query('SET session_replication_role = replica');
  try {
    await pool.query(`INSERT INTO execution_operator_authorizations (
      authorization_id,payload_version,authorization_fingerprint,generation_id,action,phase,
      context_fingerprint,nonce_hash,operator_id,issued_at,expires_at,consumed_at,purge_after
    ) VALUES ($1,2,'${'5'.repeat(64)}',$2,'ARM','CANARY','${'6'.repeat(64)}',
      '${'7'.repeat(64)}',$3,${now},${now}+INTERVAL '60 seconds',${now},${now}+INTERVAL '4 hours')`,
    [ARM_AUTHORIZATION_ID, GENERATION_ID, seed.armOperatorId ?? 'operator']);
    await pool.query(`INSERT INTO execution_intents (
      id,logical_order_key,strategy_id,strategy_version,position_id,logical_command_id,mint,side,
      venue_policy,quote_mint,quote_token_program,quote_decimals,quote_amount_raw,
      minimum_amount_out_raw,decision_event_id,decision_fingerprint,requested_at,expires_at,status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'BUY','PUMP_FUN_ONLY',$8,'SPL_TOKEN',9,1,1,$9,$10,$11,$12,'PENDING')`, [
      target.id, target.logicalOrderKey, target.strategyId, target.strategyVersion, target.positionId,
      target.logicalCommandId, target.mint, WSOL, target.decisionEventId, target.decisionFingerprint,
      new Date(target.requestedAtMs), new Date(target.expiresAtMs),
    ]);
    await pool.query(`INSERT INTO execution_wallet_snapshots (
      snapshot_id,snapshot_fingerprint,generation_id,provider_id,state_revision,slot,observed_at,
      commitment,wallet_lamports,token_balance_count,open_positions,realized_net_pnl_raw
    ) VALUES ('execution_wallet_snapshot_${'a'.repeat(64)}','${'c'.repeat(64)}',$1,'provider',0,1,
      ${now}-INTERVAL '1 second','finalized',1,0,0,0)`, [GENERATION_ID]);
    await insertProviderSnapshot(pool, 'b', 'OPERATOR_REPORT', 'd'.repeat(64));
    await pool.query(`INSERT INTO execution_safety_gate_evidence (
      qualification_id,gate_index,gate_id,status,evidence_type,evidence_id,evidence_fingerprint,observed_at,expires_at
    ) VALUES
      ($1,7,'PROVIDER_EXIT_CAPACITY_VERIFIED','PASSED','PROVIDER_SNAPSHOT',$2,$3,${now}-INTERVAL '1 second',$6),
      ($1,9,'WALLET_CHAIN_LIMITS_VERIFIED','PASSED','WALLET_SNAPSHOT',$4,$5,${now}-INTERVAL '1 second',$6)`, [
      QUALIFICATION_ID,
      bindingEvidence ? 'provider-binding:provider' : `execution_provider_usage_${'b'.repeat(64)}`,
      bindingEvidence ? '2'.repeat(64) : 'd'.repeat(64),
      bindingEvidence ? `wallet-binding:${GENERATION_ID}` : `execution_wallet_snapshot_${'a'.repeat(64)}`,
      bindingEvidence ? '3'.repeat(64) : 'c'.repeat(64),
      gateExpiry,
    ]);
    await pool.query(`INSERT INTO execution_risk_admission_reports (
      report_id,report_fingerprint,input_fingerprint,intent_id,generation_id,policy_fingerprint,
      wallet_snapshot_fingerprint,provider_snapshot_fingerprint,decision,quote_amount_raw,
      projected_capital_raw,projected_exposure_raw,projected_drawdown_raw,quota_state,wallet_state_revision
    ) VALUES ('execution_risk_admission_${'e'.repeat(64)}','${'9'.repeat(64)}','${'a'.repeat(64)}',$1,$2,
      '${POLICY_FINGERPRINT}','${'c'.repeat(64)}','${'d'.repeat(64)}','ADMITTED',1,1,1,0,'NORMAL',0)`,
    [target.id, GENERATION_ID]);
    await pool.query(`INSERT INTO execution_exposure_reservations (
      reservation_id,intent_id,generation_id,admission_report_id,position_id,side,mint,quote_mint,
      maximum_amount_raw,intent_fingerprint,policy_fingerprint,wallet_snapshot_fingerprint,
      provider_snapshot_fingerprint,state
    ) VALUES ('execution_exposure_reservation_${'f'.repeat(64)}',$1,$2,
      'execution_risk_admission_${'e'.repeat(64)}','position','BUY',$3,$4,1,'${'e'.repeat(64)}',
      '${POLICY_FINGERPRINT}','${'c'.repeat(64)}','${'d'.repeat(64)}','RESERVED')`,
    [target.id, GENERATION_ID, PUBLIC_KEY, WSOL]);
  } finally {
    await pool.query('SET session_replication_role = origin');
  }
}

async function insertEnvelopeArmament(pool: pg.Pool, overrides: ArmamentOverrides = {}): Promise<unknown> {
  return pool.query(`INSERT INTO execution_activation_armaments (
    armament_id,payload_version,armament_fingerprint,qualification_id,qualification_fingerprint,
    generation_id,authorization_id,state,phase,build_hash,configuration_fingerprint,
    strategy_fingerprint,wallet_public_key,cluster,genesis_hash,provider_id,maximum_buys,
    maximum_capital_lamports,maximum_exposure_bps,maximum_open_positions,maximum_holding_ms,
    operator_id,operator_reason,armed_at,expires_at,armament_request_fingerprint,
    canary_evidence_fingerprint,target_intent_id,target_intent_state_revision,target_strategy_id,
    target_strategy_version,target_decision_fingerprint,target_mint,target_quote_mint,
    target_quote_amount_raw,target_admission_report_id,target_reservation_id,target_policy_fingerprint,
    target_wallet_snapshot_fingerprint,target_provider_snapshot_fingerprint,runtime_quote_max_age_ms,
    runtime_slippage_bps,runtime_snapshot_max_slot_lag,runtime_max_compute_units,
    runtime_max_fee_lamports,runtime_max_fee_payer_lamport_debit,runtime_max_rpc_calls_per_attempt,
    runtime_lease_ms,envelope_id
  ) SELECT
    'execution_activation_armament_${'0'.repeat(64)}',2,'${'1'.repeat(64)}',$1,'${'1'.repeat(64)}',
    $2,$3,'ARMED','CANARY','${'2'.repeat(64)}','${'3'.repeat(64)}','${'4'.repeat(64)}',
    '${PUBLIC_KEY}','mainnet-beta','${PUBLIC_KEY}','provider',1,1,500,1,$4,$8,'reason',
    date_trunc('milliseconds',statement_timestamp()),
    date_trunc('milliseconds',statement_timestamp())+INTERVAL '4 minutes','${'6'.repeat(64)}',
    '${'7'.repeat(64)}',intent.id,0,intent.strategy_id,1,'${'8'.repeat(64)}','${PUBLIC_KEY}','${WSOL}',1,
    'execution_risk_admission_${'e'.repeat(64)}','execution_exposure_reservation_${'f'.repeat(64)}',
    $5,'${'c'.repeat(64)}','${'d'.repeat(64)}',60000,0,128,1400000,10000000,10000000000,12,3000,$6
  FROM execution_intents intent WHERE intent.id=$7`, [
    QUALIFICATION_ID, GENERATION_ID, ARM_AUTHORIZATION_ID, overrides.maximumHoldingMs ?? 30_000,
    overrides.policyFingerprint ?? POLICY_FINGERPRINT,
    overrides.envelopeId === undefined ? ENVELOPE_ID : overrides.envelopeId, currentTargetId,
    overrides.operatorId ?? 'operator',
  ]);
}

async function seedGeneration(pool: pg.Pool): Promise<number> {
  await pool.query('SET session_replication_role = replica');
  try {
    await pool.query(`INSERT INTO execution_wallet_generations (
      generation_id,wallet_public_key,cluster,genesis_hash,generation
    ) VALUES ($1,$2,'mainnet-beta',$2,1)`, [GENERATION_ID, PUBLIC_KEY]);
    await pool.query(`INSERT INTO execution_wallet_risk_state (
      generation_id,reconciled_capital_lamports,reserved_exposure_raw,conservative_drawdown_raw,unknown_block
    ) VALUES ($1,0,0,0,FALSE)`, [GENERATION_ID]);
    await pool.query(`INSERT INTO execution_control_state (generation_id,state) VALUES ($1,'RUNNING')`,
      [GENERATION_ID]);
  } finally {
    await pool.query('SET session_replication_role = origin');
  }
  const result = await pool.query<{ readonly now_ms: string }>(
    `SELECT (extract(epoch FROM date_trunc('milliseconds',statement_timestamp()))*1000)::BIGINT::TEXT AS now_ms`);
  return Number(result.rows[0]?.now_ms);
}

async function insertEnvelopeAuthorization(pool: pg.Pool, input: Readonly<{
  nowMs: number;
  id?: string;
  consumed?: boolean;
  action?: string;
  phase?: string | null;
  payloadVersion?: number;
  issuedOffsetMs?: number;
}>): Promise<unknown> {
  const issuedAt = new Date(input.nowMs + (input.issuedOffsetMs ?? -1_000));
  const consumedAt = input.consumed === false ? null : issuedAt;
  const expiresAt = new Date(issuedAt.getTime() + 4 * MINUTE + 1_000);
  return pool.query(`INSERT INTO execution_operator_authorizations (
    authorization_id,payload_version,authorization_fingerprint,generation_id,action,phase,
    context_fingerprint,nonce_hash,operator_id,issued_at,expires_at,consumed_at,purge_after
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'operator',$9,$10,$11,COALESCE($11::TIMESTAMPTZ,$10::TIMESTAMPTZ)+INTERVAL '4 hours')`, [
    input.id === undefined ? ENVELOPE_AUTHORIZATION_ID : authorizationId(input.id),
    input.payloadVersion ?? 1, (input.id ?? 'f').repeat(64).slice(0, 64).replace(/[^0-9a-f]/gu, 'a'),
    GENERATION_ID, input.action ?? 'ENVELOPE', input.phase ?? null, ENVELOPE_FINGERPRINT,
    'd'.repeat(64), issuedAt, expiresAt, consumedAt,
  ]);
}

async function insertV2Envelope(pool: pg.Pool, input: Readonly<{
  nowMs: number;
  envelopeId?: string;
  authorizationId?: string;
  operatorId?: string;
  state?: string;
  validFromMs?: number;
  validUntilMs?: number;
  perBuy?: string;
  maxBuys?: number;
  maxTotalExposure?: string;
  nullColumn?: string;
  validUntilText?: string;
  buysArmed?: number;
  revokedAt?: Date;
}>): Promise<unknown> {
  const createdAt = new Date(input.nowMs);
  return pool.query(`INSERT INTO execution_entry_envelopes (
    envelope_id,generation_id,operator_id,payload_version,fingerprint,per_buy_quote_amount_raw,
    max_buys,max_open_positions,max_total_exposure_raw,max_realized_loss_raw,valid_from,valid_until,
    state,created_at,updated_at,authorization_id,risk_policy,policy_fingerprint,maximum_holding_ms,
    buys_armed,revoked_at
  ) VALUES ($1,$2,$3,2,$4,$5,$6,1,$7,5,$8,$9,$10,$11,$11,$12,$14::JSONB,$13,$15,$16,$17)`, [
    input.envelopeId ?? ENVELOPE_ID, GENERATION_ID, input.operatorId ?? 'operator', ENVELOPE_FINGERPRINT,
    input.perBuy ?? '1', input.maxBuys ?? 3, input.maxTotalExposure ?? '3',
    new Date(input.validFromMs ?? input.nowMs - MINUTE), input.validUntilText ?? new Date(input.validUntilMs ?? input.nowMs + 2 * HOUR),
    input.state ?? 'ACTIVE', createdAt, input.authorizationId ?? ENVELOPE_AUTHORIZATION_ID,
    input.nullColumn === 'policy_fingerprint' ? null : POLICY_FINGERPRINT,
    input.nullColumn === 'risk_policy' ? null : '{"payloadVersion":1}',
    input.nullColumn === 'maximum_holding_ms' ? null : 30_000,
    input.buysArmed ?? 0, input.revokedAt ?? null,
  ]);
}

async function insertQualification(pool: pg.Pool, input: Readonly<{
  id: string;
  qualifiedAt: Date;
  expiresInMs: number;
  fingerprint?: string;
  payloadVersion?: number;
  scope?: string;
  envelopeId?: string | null;
  phase?: string;
}>): Promise<unknown> {
  const expiresAt = new Date(input.qualifiedAt.getTime() + input.expiresInMs);
  const columns = input.scope === undefined ? '' : ',scope,envelope_id';
  const values = input.scope === undefined ? '' : ',$14,$15';
  const parameters: unknown[] = [
    qualificationId(input.id), input.payloadVersion ?? 1,
    input.fingerprint ?? input.id.repeat(64).slice(0, 64), input.phase ?? 'CANARY', '2'.repeat(64),
    '3'.repeat(64), '4'.repeat(64), GENERATION_ID, PUBLIC_KEY, PUBLIC_KEY, 'provider',
    input.qualifiedAt, expiresAt,
  ];
  if (input.scope !== undefined) parameters.push(input.scope, input.envelopeId ?? null);
  return pool.query(`INSERT INTO execution_safety_qualifications (
    qualification_id,payload_version,evaluator_version,qualification_fingerprint,phase,build_hash,
    configuration_fingerprint,strategy_fingerprint,generation_id,wallet_public_key,cluster,genesis_hash,
    provider_id,qualified_at,expires_at,purge_after${columns}
  ) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,'mainnet-beta',$10,$11,$12,$13,$13::TIMESTAMPTZ+INTERVAL '4 hours'${values})`,
  parameters);
}

async function insertProviderSnapshot(
  pool: pg.Pool,
  id: string,
  provenance: string,
  fingerprint = id.repeat(64).slice(0, 64),
): Promise<unknown> {
  const now = `date_trunc('milliseconds',statement_timestamp())`;
  return pool.query(`INSERT INTO execution_provider_usage_snapshots (
    snapshot_id,snapshot_fingerprint,provider_id,plan_id,billing_period_id,billing_period_started_at,
    billing_period_ends_at,limit_units,used_units,measured_at,expires_at,provenance
  ) VALUES ($1,$2,'provider','plan','period',${now}-INTERVAL '1 minute',${now}+INTERVAL '10 minutes',
    100,0,${now}-INTERVAL '1 second',${now}+INTERVAL '5 minutes',$3)`,
  [`execution_provider_usage_${id.repeat(64).slice(0, 64)}`, fingerprint, provenance]);
}

function qualificationId(char: string): string {
  return `execution_safety_qualification_${char.repeat(64)}`;
}

function authorizationId(char: string): string {
  return `execution_operator_authorization_${char.repeat(64)}`;
}

async function withTemporarySchema(context: TestContext, run: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: entry envelope migration PG tests skipped');
    return;
  }
  const schema = `entry_envelope_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

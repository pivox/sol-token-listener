import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorAuthorization } from '../src/domain/execution-operations.js';
import {
  ExecutionLiveRepositoryError,
  PostgresExecutionLiveRepository,
} from '../src/storage/execution-live.repository.js';
import {
  ExecutionOperationsRepositoryError,
  PostgresExecutionOperationsRepository,
} from '../src/storage/execution-operations.repository.js';
import {
  armCanary, armEnvelope, currentDatabaseTimeMs, envelopeArmRequest, envelopeBuyFixture,
  fastEntryIntent, generationId, openEnvelope, PER_BUY, type Pool, prepareEnvelope,
  resumeWith, seedEnvelopeBase, seedProviderSnapshot, withSchema,
} from './helpers/entry-envelope-fixture.js';
import { mutateWithTriggersDisabled } from './helpers/execution-preflight-v2-source-fixture.js';

/*
 * Lot 4a safety checklist: what stays impossible (plan Task 11, items 1-9).
 *
 * Each property is checked at the DB layer, the last line of defence: a real ENVELOPE
 * armament produced by `armEnvelope` is copied under a fresh identity (new armament id,
 * fingerprint and a copy of its consumed authorization) and re-inserted directly, after a
 * setup that breaks exactly one property, all inside a rolled-back transaction. The unmodified
 * copy passes the 065 guard and is stopped only by the K=1 unique index (23505), so a 55000
 * there means the guard itself refused. Where cheap, `armEnvelope` is checked too.
 */

const K1_INDEX = 'execution_activation_armaments_generation_active_unique';
const NOW = `date_trunc('milliseconds',statement_timestamp())`;

void test('1. no armament without an ACTIVE v2 envelope', async (context) => {
  await withSchema(context, async (pool) => {
    const armed = await armedEnvelope(pool);
    assert.deepEqual(await copyArmament(pool, armed.armamentId), k1Refusal());
    assert.equal((await copyArmament(pool, armed.armamentId, { overrides: { envelope_id: null } })).code,
      '55000', 'no envelope');
    for (const [name, assignments] of [
      ['lot-3 v1 envelope', 'payload_version=1'],
      ['REVOKED', "state='REVOKED',revoked_at=updated_at"],
      ['EXPIRED', "state='EXPIRED'"],
      ['EXHAUSTED', "state='EXHAUSTED'"],
      ['ACTIVE but past valid_until', `valid_from=${NOW}-INTERVAL '2 hours',
        valid_until=${NOW}-INTERVAL '1 second'`],
    ] as const) {
      assert.equal((await copyArmament(pool, armed.armamentId, {
        setup: [`UPDATE execution_entry_envelopes SET ${assignments}`],
      })).code, '55000', name);
    }
    const missing = await envelopeArmRequest(armed.repository, armed.prepared, armed.spareIntentId);
    await assert.rejects(armed.repository.armEnvelope({
      ...missing, envelopeId: `execution_entry_envelope_${'0'.repeat(64)}`,
    }), isRepositoryError('ENVELOPE_NOT_ARMABLE'), 'no envelope');
    await armed.repository.revokeEnvelope({ generationId, envelopeId: armed.prepared.envelope.envelopeId,
      operatorId: 'operator-primary', occurredAtMs: Date.now() });
    await assert.rejects(armed.repository.armEnvelope(missing), isRepositoryError('ENVELOPE_NOT_ARMABLE'),
      'REVOKED');
    await assertBuysArmed(pool, 1);
  });
});

void test('2a. no armament with a CANARY qualification plus an envelope_id', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const prepared = await prepareEnvelope(pool, repository, simulation);
    await repository.createEnvelope(prepared);
    const canary = await armCanary(pool, repository, simulation, { returnRequest: true });
    await assert.rejects(repository.armEnvelope({
      request: canary.request, authorization: canary.authorization,
      envelopeId: prepared.envelope.envelopeId,
    }), isRepositoryError('CONFLICT'));
    assert.deepEqual(await copyArmament(pool, canary.armament.armamentId), k1Refusal());
    assert.equal((await copyArmament(pool, canary.armament.armamentId, {
      overrides: { envelope_id: prepared.envelope.envelopeId },
    })).code, '55000');
    await assertBuysArmed(pool, 0);
  });
});

void test('2b. no armament with an ENVELOPE qualification bound to another envelope', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const first = await prepareEnvelope(pool, repository, simulation, { nonce: '1' });
    await repository.createEnvelope(first);
    await repository.revokeEnvelope({ generationId, envelopeId: first.envelope.envelopeId,
      operatorId: 'operator-primary', occurredAtMs: Date.now() });
    const second = await prepareEnvelope(pool, repository, simulation, { nonce: '2', expiresInMs: 3 * 3_600_000 });
    await repository.createEnvelope(second);
    await resumeWith(repository, second.qualification, 'second');
    await seedProviderSnapshot(pool);
    const nowMs = await currentDatabaseTimeMs(pool);
    const intentId = await fastEntryIntent(pool, second.envelope, nowMs);
    const foreign = await envelopeArmRequest(repository, first, intentId);
    await assert.rejects(repository.armEnvelope({ ...foreign, envelopeId: second.envelope.envelopeId }),
      isRepositoryError('ENVELOPE_NOT_ARMABLE'));
    const armament = await armEnvelope(repository, second, intentId);
    assert.deepEqual(await copyArmament(pool, armament.armamentId), k1Refusal());
    assert.equal((await copyArmament(pool, armament.armamentId, { overrides: {
      qualification_id: first.qualification.qualificationId,
      qualification_fingerprint: first.qualification.qualificationFingerprint,
    } })).code, '55000');
  });
});

void test('2c. no armament with an expired ENVELOPE qualification', async (context) => {
  await withSchema(context, async (pool) => {
    // The qualification expires exactly at valid_until (A6) and arming stops 15 minutes plus the
    // holding before it (item 7), so an ACTIVE envelope never carries an expired qualification by
    // time alone. Qualifications are immutable: expiring one in place is also a tamper.
    const armed = await armedEnvelope(pool);
    const expire = `UPDATE execution_safety_qualifications SET
      expires_at=qualified_at+INTERVAL '1 millisecond',
      purge_after=qualified_at+INTERVAL '1 millisecond'+INTERVAL '4 hours'`;
    assert.equal((await copyArmament(pool, armed.armamentId, { setup: [expire] })).code, '55000');
    const request = await envelopeArmRequest(armed.repository, armed.prepared, armed.spareIntentId);
    await mutateWithTriggersDisabled(pool, expire, []);
    // The stored row no longer matches its fingerprint.
    await assert.rejects(armed.repository.armEnvelope(request), isRepositoryError('INVALID_DATA'));
    await assertBuysArmed(pool, 1);
  });
});

void test('3. no armament unless control is RUNNING and the wallet is not unknown_block', async (context) => {
  await withSchema(context, async (pool) => {
    const armed = await armedEnvelope(pool);
    for (const [name, statement] of [
      ['ENTRY_STOP', "UPDATE execution_control_state SET state='ENTRY_STOP'"],
      ['HARD_STOP', "UPDATE execution_control_state SET state='HARD_STOP'"],
      ['unknown_block', 'UPDATE execution_wallet_risk_state SET unknown_block=TRUE'],
    ] as const) {
      assert.equal((await copyArmament(pool, armed.armamentId, { setup: [statement] })).code, '55000', name);
    }
    const request = await envelopeArmRequest(armed.repository, armed.prepared, armed.spareIntentId);
    for (const mode of ['ENTRY_STOP', 'HARD_STOP'] as const) {
      await armed.repository.setStop({ payloadVersion: 1, commandId: `command:stop:${mode}`, generationId,
        operatorId: 'operator-primary', occurredAtMs: Date.now() }, mode);
      await assert.rejects(armed.repository.armEnvelope(request), isRepositoryError('CONTROL_STOPPED'), mode);
    }
    await assertBuysArmed(pool, 1);
  });
});

void test('4. K=1: no second armament while one is ARMED or LOCKED', async (context) => {
  await withSchema(context, async (pool) => {
    const armed = await armedEnvelope(pool);
    assert.deepEqual(await copyArmament(pool, armed.armamentId), k1Refusal(), 'ARMED');
    const lock = `UPDATE execution_activation_armaments SET
      state='LOCKED',state_revision=1,consumed_buys=1,locked_intent_id=target_intent_id,
      locked_attempt_number=1,locked_reservation_id=target_reservation_id,
      locked_lease_token=gen_random_uuid(),locked_at=${NOW},terminal_at=NULL,purge_after=NULL
      WHERE armament_id='${armed.armamentId}'`;
    assert.deepEqual(await copyArmament(pool, armed.armamentId, { setup: [lock] }), k1Refusal(), 'LOCKED');
    const request = await envelopeArmRequest(armed.repository, armed.prepared, armed.spareIntentId);
    await assert.rejects(armed.repository.armEnvelope(request), isRepositoryError('ARMAMENT_CONTENDED'), 'ARMED');
    await mutateWithTriggersDisabled(pool, lock, []);
    await assert.rejects(armed.repository.armEnvelope(request), isRepositoryError('ARMAMENT_CONTENDED'), 'LOCKED');
    await assertBuysArmed(pool, 1);
  });
});

void test('5. caps: max_buys, cumulative exposure and realized loss block arming; counters never decrease',
  async (context) => {
    await withSchema(context, async (pool) => {
      // 3 buys of 10 000 000 within 50 000 000: after one arm (buys_armed 1) each cap is isolated.
      const armed = await armedEnvelope(pool, { maxBuys: 3, maxTotalExposureRaw: 5n * PER_BUY });
      const envelope = (assignments: string) => `UPDATE execution_entry_envelopes SET ${assignments}`;
      assert.deepEqual(await copyArmament(pool, armed.armamentId), k1Refusal());
      for (const [name, assignments] of [
        ['buys_armed = max_buys', 'buys_armed=3'],
        ['(buys_armed + 1) x per_buy > max_total_exposure', 'buys_armed=2,max_total_exposure_raw=20000000'],
        ['realized_loss = max_realized_loss', 'realized_loss_raw=max_realized_loss_raw'],
      ] as const) {
        assert.equal((await copyArmament(pool, armed.armamentId, { setup: [envelope(assignments)] })).code,
          '55000', name);
      }
      // Table CHECKs: buys_armed <= max_buys and buys_armed x per_buy <= max_total_exposure.
      assert.equal((await codeOf(pool, [], envelope('buys_armed=4'))).code, '23514', 'max_buys CHECK');
      assert.equal((await codeOf(pool, [envelope('max_total_exposure_raw=20000000')],
        envelope('buys_armed=3'))).code, '23514', 'exposure CHECK');
      // Update guard: counters are monotonic.
      assert.equal((await codeOf(pool, [], envelope('buys_armed=0'))).code, '55000', 'buys_armed decrease');
      assert.equal((await codeOf(pool, [envelope('realized_loss_raw=5')], envelope('realized_loss_raw=4'))).code,
        '55000', 'realized_loss decrease');
      const request = await envelopeArmRequest(armed.repository, armed.prepared, armed.spareIntentId);
      await pool.query(envelope('realized_loss_raw=max_realized_loss_raw'));
      await assert.rejects(armed.repository.armEnvelope(request), isRepositoryError('ENVELOPE_NOT_ARMABLE'));
      await assertBuysArmed(pool, 1);
    });
  });

void test('6. exact values: per-buy quote and capital, holding, policy, operator, strategy, requested_at',
  async (context) => {
    await withSchema(context, async (pool) => {
      const armed = await armedEnvelope(pool);
      assert.deepEqual(await copyArmament(pool, armed.armamentId), k1Refusal());
      const target = `WHERE id=(SELECT target_intent_id FROM execution_activation_armaments
        WHERE armament_id='${armed.armamentId}')`;
      for (const [name, change] of [
        ['maximum_capital != per_buy', { overrides: { maximum_capital_lamports: String(PER_BUY + 1n) } }],
        ['quote != per_buy', { overrides: { target_quote_amount_raw: String(PER_BUY - 1n) } }],
        ['holding != envelope', { overrides: { maximum_holding_ms: 120_000 } }],
        ['policy != envelope', { overrides: { target_policy_fingerprint: '0'.repeat(64) } }],
        ['operator != envelope', { overrides: { operator_id: 'operator-other' } }],
        ['strategy != fast-entry-v1', {
          setup: [`UPDATE execution_intents SET strategy_id='canary-target' ${target}`],
          overrides: { target_strategy_id: 'canary-target' },
        }],
        ['intent requested before valid_from', {
          setup: [`UPDATE execution_intents SET requested_at=(SELECT valid_from-INTERVAL '1 second'
            FROM execution_entry_envelopes) ${target}`],
        }],
      ] as const) {
        assert.equal((await copyArmament(pool, armed.armamentId, change)).code, '55000', name);
      }
      const otherOperator = await envelopeArmRequest(armed.repository, armed.prepared, armed.spareIntentId,
        { operatorId: 'operator-other' });
      await assert.rejects(armed.repository.armEnvelope(otherOperator), isRepositoryError('ENVELOPE_NOT_ARMABLE'));
      const smaller = await fastEntryIntent(pool, armed.prepared.envelope, await currentDatabaseTimeMs(pool),
        PER_BUY / 2n);
      await assert.rejects(armEnvelope(armed.repository, armed.prepared, smaller), isRepositoryError('CONFLICT'));
      await assertBuysArmed(pool, 1);
    });
  });

void test('7. cut-off: no armament if valid_until < now + holding + 15 minutes', async (context) => {
  await withSchema(context, async (pool) => {
    const armed = await armedEnvelope(pool);
    // The qualification follows valid_until (A6), so only the cut-off changes.
    const cutOff = (offset: string) => [
      `UPDATE execution_entry_envelopes SET valid_until=${NOW}
        +maximum_holding_ms*INTERVAL '1 millisecond'+INTERVAL '15 minutes'${offset}`,
      `UPDATE execution_safety_qualifications qualification SET expires_at=envelope.valid_until,
        purge_after=envelope.valid_until+INTERVAL '4 hours'
        FROM execution_entry_envelopes envelope WHERE qualification.envelope_id=envelope.envelope_id`,
    ];
    assert.deepEqual(await copyArmament(pool, armed.armamentId, { setup: cutOff("+INTERVAL '30 seconds'") }),
      k1Refusal(), 'just after the cut-off');
    assert.equal((await copyArmament(pool, armed.armamentId, { setup: cutOff("-INTERVAL '1 second'") })).code,
      '55000', 'just before the cut-off');
    const request = await envelopeArmRequest(armed.repository, armed.prepared, armed.spareIntentId);
    for (const statement of cutOff("-INTERVAL '1 second'")) await mutateWithTriggersDisabled(pool, statement, []);
    await assert.rejects(armed.repository.armEnvelope(request), isRepositoryError('ENVELOPE_NOT_ARMABLE'));
    await assertBuysArmed(pool, 1);
  });
});

void test('8. a v2 envelope insert requires its consumed ENVELOPE authorization bound to its fingerprint',
  async (context) => {
    await withSchema(context, async (pool) => {
      const simulation = await seedEnvelopeBase(pool);
      const repository = new PostgresExecutionOperationsRepository(pool);
      const prepared = await prepareEnvelope(pool, repository, simulation);
      const nowMs = await currentDatabaseTimeMs(pool);
      const unbound = createOperatorAuthorization({
        payloadVersion: 1, generationId, action: 'ENVELOPE', phase: null,
        contextFingerprint: '0'.repeat(64), nonceHash: '8'.repeat(64), operatorId: 'operator-primary',
        issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
      });
      await repository.recordAuthorization(unbound);
      await assert.rejects(repository.createEnvelope({ ...prepared, authorization: unbound }),
        isRepositoryError('CONFLICT'));
      assert.equal((await pool.query('SELECT 1 FROM execution_entry_envelopes')).rows.length, 0);
      await repository.createEnvelope(prepared);
      const copy = (change: CopyChange = {}) => copyRow(pool, 'execution_entry_envelopes', 'envelope_id',
        prepared.envelope.envelopeId, change);
      const authorization = (assignments: string) => `UPDATE execution_operator_authorizations
        SET ${assignments} WHERE authorization_id='${prepared.authorization.authorizationId}'`;
      // The unchanged copy passes the guard and only meets the primary key.
      assert.equal((await copy()).code, '23505');
      for (const [name, change] of [
        ['unconsumed', { setup: [authorization("consumed_at=NULL,purge_after=expires_at+INTERVAL '4 hours'")] }],
        ['context != fingerprint', { setup: [authorization(`context_fingerprint='${'0'.repeat(64)}'`)] }],
        ['not an ENVELOPE action', { setup: [authorization("action='RESUME'")] }],
        ['absent', { overrides: { authorization_id: `execution_operator_authorization_${'0'.repeat(64)}` } }],
      ] as const) {
        assert.equal((await copy(change)).code, '55000', name);
      }
    });
  });

void test('9. an ENVELOPE armament cannot be signed once its qualification has expired', async (context) => {
  await withSchema(context, async (pool) => {
    const fixture = await envelopeBuyFixture(pool);
    await mutateWithTriggersDisabled(pool, `UPDATE execution_safety_qualifications SET
      expires_at=qualified_at+INTERVAL '1 millisecond',
      purge_after=qualified_at+INTERVAL '1 millisecond'+INTERVAL '4 hours'
      WHERE qualification_id=(SELECT qualification_id FROM execution_activation_armaments
        WHERE armament_id=$1)`, [fixture.armamentId]);
    await assert.rejects(new PostgresExecutionLiveRepository(pool).authorizeExactSigning(fixture.input),
      (error) => error instanceof ExecutionLiveRepositoryError && error.code === 'PREFLIGHT_EXPIRED');
    assert.deepEqual((await pool.query(`SELECT COUNT(*)::INTEGER AS locks
      FROM execution_pre_signature_locks`)).rows, [{ locks: 0 }]);
  });
});

/** An open envelope with one real armament and a spare fast-entry intent. */
async function armedEnvelope(pool: Pool, options: Parameters<typeof openEnvelope>[3] = {}) {
  const simulation = await seedEnvelopeBase(pool);
  const repository = new PostgresExecutionOperationsRepository(pool);
  const prepared = await openEnvelope(pool, repository, simulation, options);
  await seedProviderSnapshot(pool);
  const nowMs = await currentDatabaseTimeMs(pool);
  const intentId = await fastEntryIntent(pool, prepared.envelope, nowMs);
  const spareIntentId = await fastEntryIntent(pool, prepared.envelope, nowMs);
  const armament = await armEnvelope(repository, prepared, intentId);
  return Object.freeze({ repository, prepared, armamentId: armament.armamentId, spareIntentId });
}

type CopyChange = Readonly<{ setup?: readonly string[]; overrides?: Readonly<Record<string, unknown>> }>;
type Refusal = Readonly<{ code: string | null; constraint: string | null }>;

function k1Refusal(): Refusal {
  return { code: '23505', constraint: K1_INDEX };
}

/**
 * Re-inserts the armament under a fresh identity (and a copy of its consumed authorization), so
 * that an unchanged copy meets nothing but the K=1 index.
 */
async function copyArmament(pool: Pool, armamentId: string, change: CopyChange = {}): Promise<Refusal> {
  const fresh = 'f'.repeat(64);
  const authorizationId = `execution_operator_authorization_${fresh}`;
  return copyRow(pool, 'execution_activation_armaments', 'armament_id', armamentId, {
    setup: [`INSERT INTO execution_operator_authorizations
      SELECT (jsonb_populate_record(NULL::execution_operator_authorizations, to_jsonb(operator_auth)
        || jsonb_build_object('authorization_id','${authorizationId}',
          'authorization_fingerprint','${fresh}','nonce_hash','${fresh}'))).*
      FROM execution_operator_authorizations operator_auth WHERE authorization_id=(
        SELECT authorization_id FROM execution_activation_armaments WHERE armament_id='${armamentId}')`,
    ...(change.setup ?? [])],
    overrides: {
      armament_id: `execution_activation_armament_${fresh}`, armament_fingerprint: fresh,
      authorization_id: authorizationId, ...change.overrides,
    },
  });
}

/** Directly re-inserts a row as it is now, after `setup`, with `overrides`. */
async function copyRow(
  pool: Pool,
  table: string,
  key: string,
  value: string,
  change: CopyChange,
): Promise<Refusal> {
  const row = (await pool.query<{ readonly row: string }>(
    `SELECT to_jsonb(source)::TEXT AS row FROM ${table} source WHERE ${key}=$1`, [value])).rows[0]?.row;
  assert.ok(row !== undefined);
  return codeOf(pool, change.setup ?? [], `INSERT INTO ${table}
    SELECT (jsonb_populate_record(NULL::${table}, $1::JSONB || $2::JSONB)).*`,
  [row, JSON.stringify(change.overrides ?? {})]);
}

/**
 * Runs `setup` with triggers disabled, then `statement` with every trigger and constraint on,
 * and rolls everything back. Returns the PostgreSQL refusal, or nulls if it was accepted.
 */
async function codeOf(
  pool: Pool,
  setup: readonly string[],
  statement: string,
  values: readonly unknown[] = [],
): Promise<Refusal> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role=replica');
    for (const text of setup) await client.query(text);
    await client.query('SET LOCAL session_replication_role=origin');
    try {
      await client.query(statement, [...values]);
      return { code: null, constraint: null };
    } catch (error) {
      const failure = error as { readonly code?: string; readonly constraint?: string };
      return { code: failure.code ?? 'unknown', constraint: failure.constraint ?? null };
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function assertBuysArmed(pool: Pool, expected: number): Promise<void> {
  assert.deepEqual((await pool.query(`SELECT COALESCE(SUM(buys_armed),0)::INTEGER AS buys
    FROM execution_entry_envelopes`)).rows, [{ buys: expected }]);
}

function isRepositoryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionOperationsRepositoryError && error.code === code;
}

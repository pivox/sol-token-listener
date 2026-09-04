import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { assertExecutionIntent, createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';

const migrationName = '031_execution_intents.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);
const paperTableReference = /\bREFERENCES\s+(?:(?:"[^"]+"|[a-z_][a-z0-9_$]*)\s*\.\s*)?(?:"paper_[^"]*"|paper_[a-z0-9_$]*)/iu;

void test('execution intent migration defines the inert durable ledger contract', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const executableSql = withoutSqlComments(sql);

  assert.match(executableSql, /CREATE TABLE IF NOT EXISTS execution_intents/u);
  assert.match(executableSql, /CREATE TABLE IF NOT EXISTS execution_attempts/u);
  assert.match(executableSql, /CREATE TABLE IF NOT EXISTS execution_intent_transitions/u);
  assert.match(executableSql, /CREATE TABLE IF NOT EXISTS execution_intent_tombstones/u);
  assert.match(executableSql, /intent_id TEXT PRIMARY KEY/u);
  assert.match(executableSql, /logical_order_key TEXT NOT NULL UNIQUE/u);
  assert.match(executableSql, /decision_fingerprint TEXT NOT NULL/u);
  assert.match(executableSql, /execution_intent_tombstones_fingerprint_check CHECK \(\s*decision_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/u);
  const tombstoneDefinition = /CREATE TABLE IF NOT EXISTS execution_intent_tombstones \(([\s\S]*?)\);/u
    .exec(executableSql)?.[1];
  assert.ok(tombstoneDefinition !== undefined);
  assert.doesNotMatch(
    tombstoneDefinition,
    /REFERENCES|mint|wallet|amount|quote|payload(?!_version)|purge_after/iu,
  );
  assert.match(executableSql, /UNIQUE\s*\(logical_order_key\)/u);
  assert.match(executableSql, /state_revision BIGINT NOT NULL DEFAULT 0/u);
  assert.match(executableSql, /execution_intents_state_revision_check CHECK \(state_revision >= 0\)/u);
  assert.match(
    executableSql,
    /CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_one_started_idx\s+ON execution_attempts \(intent_id\)\s+WHERE status = 'STARTED'/u,
  );
  assert.doesNotMatch(executableSql, paperTableReference);
  for (const amountColumn of ['quote_amount_raw', 'base_amount_raw', 'minimum_amount_out_raw']) {
    assert.match(
      executableSql,
      new RegExp(`\\b${amountColumn}\\s*=\\s*trunc\\(\\s*${amountColumn}\\s*\\)`, 'u'),
    );
    assert.match(
      executableSql,
      new RegExp(`\\bscale\\(\\s*${amountColumn}\\s*\\)\\s*=\\s*0`, 'u'),
    );
  }
  assert.match(executableSql, /date_trunc\('milliseconds', requested_at\) = requested_at/u);
  assert.match(executableSql, /expires_at <= requested_at \+ INTERVAL '4 hours'/u);
  assert.match(executableSql, /TIMESTAMPTZ '1970-01-01 00:00:00\.000\+00'/u);
  assert.match(executableSql, /TIMESTAMPTZ '275760-09-13 00:00:00\.000\+00'/u);
  assert.doesNotMatch(executableSql, /purge_after = completed_at \+ INTERVAL '4 hours'/u);
  assert.match(executableSql, /evidence - ARRAY\['payloadVersion', 'attemptNumber', 'sourceEventId', 'observedAtMs'\]/u);
  assert.match(executableSql, /evidence \?& ARRAY\['payloadVersion', 'attemptNumber', 'sourceEventId', 'observedAtMs'\]/u);
  assert.match(executableSql, /execution_attempts_retention_check CHECK \(purge_after IS NULL\)/u);
  for (const table of [
    'execution_intents', 'execution_attempts', 'execution_intent_transitions',
  ]) {
    const definition = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\);`, 'u')
      .exec(executableSql)?.[1];
    assert.ok(definition !== undefined);
    assert.match(definition, /'RECONCILIATION_PROVED_NO_EFFECT'/u);
  }
  assert.match(
    executableSql,
    /execution_intent_transitions_reconciliation_proof_check CHECK \(\s*\(previous_status = 'UNKNOWN_REQUIRES_RECONCILIATION'\s+AND next_status IN \('FAILED', 'RETRY_READY'\)\)\s*=\s*\(reason_code = 'RECONCILIATION_PROVED_NO_EFFECT'\)\s*\)/u,
  );
  assert.match(executableSql,
    /status = 'RETRY_READY'\s+AND last_reason_code = 'RECONCILIATION_PROVED_NO_EFFECT'/u);
  assert.match(executableSql,
    /next_status = 'RETRY_READY'\s+AND reason_code = 'RECONCILIATION_PROVED_NO_EFFECT'/u);
  assert.match(executableSql, /evidence -> 'attemptNumber' = to_jsonb\(attempt_number\)/u);
  assert.match(executableSql, /quote_amount_raw NUMERIC,/u);
  assert.match(executableSql, /WHERE status = 'PENDING'/u);
  assert.doesNotMatch(executableSql, /signed_transaction|private_key|keypair/iu);
});

void test('database requires no-effect proof exclusively when UNKNOWN becomes terminal or retryable', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: reconciliation proof invariant test skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, 'execution_intent_reconciliation_proof', async (pool) => {
    await migrateDatabase({ pool });
    const unknown = draft('unknown-proof-parent', 'BUY', 1n, null);
    await insertIntent(pool, intentRow(unknown, { status: 'UNKNOWN_REQUIRES_RECONCILIATION' }));

    for (const reasonCode of [
      'SUBMISSION_AMBIGUOUS', 'CONFIRMATION_TIMEOUT', 'RECONCILIATION_REQUIRED', 'QUOTE_STALE',
    ]) {
      await assert.rejects(insertTransitionReason(pool, unknown.id,
        'UNKNOWN_REQUIRES_RECONCILIATION', 'FAILED', reasonCode));
    }
    await insertTransitionReason(pool, unknown.id, 'UNKNOWN_REQUIRES_RECONCILIATION', 'FAILED',
      'RECONCILIATION_PROVED_NO_EFFECT');

    const retry = draft('unknown-retry-proof-parent', 'BUY', 1n, null);
    await insertIntent(pool, intentRow(retry, { status: 'UNKNOWN_REQUIRES_RECONCILIATION' }));
    await assert.rejects(insertTransitionReason(pool, retry.id,
      'UNKNOWN_REQUIRES_RECONCILIATION', 'RETRY_READY', 'RETRY_AUTHORIZED'));
    await insertTransitionReason(pool, retry.id, 'UNKNOWN_REQUIRES_RECONCILIATION', 'RETRY_READY',
      'RECONCILIATION_PROVED_NO_EFFECT');

    const unsafeRetryParent = draft('unsafe-retry-parent', 'BUY', 1n, null);
    await assert.rejects(insertIntent(pool, intentRow(unsafeRetryParent, {
      status: 'RETRY_READY', lastReasonCode: 'RETRY_AUTHORIZED',
    })));
    const provedRetryParent = draft('proved-retry-parent', 'BUY', 1n, null);
    await insertIntent(pool, intentRow(provedRetryParent, {
      status: 'RETRY_READY', lastReasonCode: 'RECONCILIATION_PROVED_NO_EFFECT',
    }));

    const processing = draft('misplaced-proof-parent', 'BUY', 1n, null);
    await insertIntent(pool, intentRow(processing, {
      status: 'PROCESSING', lastReasonCode: 'EXECUTION_STARTED',
    }));
    await assert.rejects(insertTransitionReason(pool, processing.id, 'PROCESSING', 'FAILED',
      'RECONCILIATION_PROVED_NO_EFFECT'));

    const failed = draft('proved-failed-parent', 'BUY', 1n, null);
    await insertIntent(pool, intentRow(failed, {
      status: 'FAILED', lastReasonCode: 'RECONCILIATION_PROVED_NO_EFFECT',
      terminalAtMs: 1_000, reconciliationCompletedAtMs: 2_000, purgeAfterMs: 14_402_000,
    }));
    await insertAttemptWithReason(pool, processing.id, 1, 'ABANDONED',
      'RECONCILIATION_PROVED_NO_EFFECT');
  });
});

void test('database rejects lifetimes beyond four hours and contradictory reason semantics', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: execution intent invariant test skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, 'execution_intent_reason_semantics', async (pool) => {
    await migrateDatabase({ pool });
    const tooLong = draft('ttl-too-long', 'BUY', 1n, null);
    await assert.rejects(insertIntent(pool, intentRow(tooLong, { expiresAtMs: 14_400_001 })));

    const processing = draft('processing-reason', 'BUY', 1n, null);
    await assert.rejects(insertIntent(pool, intentRow(processing, {
      status: 'PROCESSING', lastReasonCode: 'INTENT_DUPLICATE',
    })));
    await insertIntent(pool, intentRow(processing, {
      status: 'PROCESSING', lastReasonCode: 'EXECUTION_STARTED',
    }));
    await assert.rejects(pool.query(`INSERT INTO execution_attempts (
      intent_id,attempt_number,status,started_at,completed_at,reason_code
    ) VALUES ($1,1,'COMPLETED',to_timestamp(1),to_timestamp(2),'QUOTE_STALE')`, [processing.id]));
    await pool.query(`INSERT INTO execution_attempts (
      intent_id,attempt_number,status,started_at,completed_at,reason_code
    ) VALUES ($1,1,'COMPLETED',to_timestamp(1),to_timestamp(2),'ATTEMPT_COMPLETED')`, [processing.id]);
    await assert.rejects(pool.query(`INSERT INTO execution_attempts (
      intent_id,attempt_number,status,started_at,completed_at,reason_code
    ) VALUES ($1,2,'ABANDONED',to_timestamp(1),to_timestamp(2),'ATTEMPT_COMPLETED')`, [processing.id]));
  });
});

void test('database enforces the minimal tombstone identity and timestamp contract', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: execution intent tombstone invariant test skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, 'execution_intent_tombstone_invariants', async (pool) => {
    await migrateDatabase({ pool });
    const valid = await pool.query<{ readonly millisecond_aligned: boolean }>(`INSERT INTO
      execution_intent_tombstones (intent_id,logical_order_key,decision_fingerprint)
      VALUES ('intent','logical-key',$1)
      RETURNING retired_at = date_trunc('milliseconds', retired_at) AS millisecond_aligned`, [
      'a'.repeat(64),
    ]);
    assert.equal(valid.rows[0]?.millisecond_aligned, true);

    const invalidRows = [
      ['', 'another-key', 'a'.repeat(64), '1970-01-01T00:00:00.000Z'],
      ['another-intent', 'x'.repeat(257), 'a'.repeat(64), '1970-01-01T00:00:00.000Z'],
      ['another-intent', 'another-key', 'A'.repeat(64), '1970-01-01T00:00:00.000Z'],
      ['another-intent', 'another-key', 'b'.repeat(64), 'infinity'],
      ['another-intent', 'another-key', 'b'.repeat(64), '1970-01-01T00:00:00.000001Z'],
    ] as const;
    for (const row of invalidRows) {
      await assert.rejects(pool.query(`INSERT INTO execution_intent_tombstones (
        intent_id,logical_order_key,decision_fingerprint,retired_at
      ) VALUES ($1,$2,$3,$4::TIMESTAMPTZ)`, [...row]));
    }
  });
});

void test('paper foreign-key guard recognizes executable reference forms without reading prose', () => {
  for (const reference of [
    'REFERENCES paper_hidden(id)',
    'REFERENCES public.paper_hidden(id)',
    'REFERENCES "paper_" (id)',
    'REFERENCES "public"."paper_" (id)',
    'REFERENCES/**/paper_hidden(id)',
  ]) {
    assert.match(withoutSqlComments(reference), paperTableReference);
  }
  assert.doesNotMatch(
    withoutSqlComments('-- REFERENCES paper_hidden(id) is forbidden prose'),
    paperTableReference,
  );
  assert.doesNotMatch(
    withoutSqlComments('/* REFERENCES "paper_" (id) is forbidden prose */'),
    paperTableReference,
  );
});

void test('execution intent migration applies and replays on an isolated schema', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: execution intent migration test skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'execution_intents', async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), '038_execution_live_rpc_budget.sql');
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    const schemaState = await pool.query(`SELECT current_schema() AS schema,
      to_regclass('execution_intents')::TEXT AS execution_intents`);
    assert.equal(schemaState.rows[0]?.execution_intents, 'execution_intents');

    const canonical = draft('canonical', 'BUY', 1n, null);
    await insertIntent(pool, intentRow(canonical));
    assertExecutionIntent(Object.freeze(intentFromRow(await readIntentRow(pool, canonical.id))));
    const reconciled = draft('reconciled-terminal', 'BUY', 1n, null);
    await insertIntent(pool, intentRow(reconciled, {
      status: 'SUCCEEDED', terminalAtMs: 1_000, reconciliationCompletedAtMs: 2_000,
      purgeAfterMs: 14_402_000, lastReasonCode: 'INTENT_SUCCEEDED',
    }));
    assertExecutionIntent(Object.freeze(intentFromRow(await readIntentRow(pool, reconciled.id))));

    const u64Maximum = 18_446_744_073_709_551_615n;
    await insertIntent(pool, intentRow(draft('u64-buy', 'BUY', u64Maximum, null)));
    await insertIntent(pool, intentRow(draft('u64-sell', 'SELL', null, u64Maximum)));
    const amounts = await pool.query<{ readonly quote: string | null; readonly base: string | null }>(`SELECT
      quote_amount_raw::TEXT AS quote, base_amount_raw::TEXT AS base
      FROM execution_intents WHERE id IN ($1, $2) ORDER BY id`, [
      draft('u64-buy', 'BUY', u64Maximum, null).id,
      draft('u64-sell', 'SELL', null, u64Maximum).id,
    ]);
    assert.deepEqual(amounts.rows.map((row) => [row.quote, row.base]).sort(), [
      [null, u64Maximum.toString()], [u64Maximum.toString(), null],
    ].sort());

    const maximumTimestamp = 8_640_000_000_000_000;
    const upperBound = draft('upper-bound', 'BUY', 1n, null);
    await insertIntent(pool, intentRow(upperBound, {
      requestedAtMs: maximumTimestamp - 1,
      expiresAtMs: maximumTimestamp,
    }));
    const upperRoundTrip = await pool.query<{ readonly expires_at: string }>(`SELECT to_char(
      expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) AS expires_at FROM execution_intents WHERE id = $1`, [upperBound.id]);
    assert.equal(timestampTextToMs(upperRoundTrip.rows[0]?.expires_at), maximumTimestamp);

    for (const [name, invalidRow] of [
      ['quote', (amount: string) => intentRow(draft(`invalid-quote-${amount}`, 'BUY', 1n, null), {
        quoteAmountRaw: amount,
      })],
      ['base', (amount: string) => intentRow(draft(`invalid-base-${amount}`, 'SELL', null, 1n), {
        baseAmountRaw: amount,
      })],
      ['minimum', (amount: string) => intentRow(draft(`invalid-minimum-${amount}`, 'BUY', 1n, null), {
        minimumAmountOutRaw: amount,
      })],
    ] as const) {
      for (const amount of [
        '0', '-1', '1.0', '1.000', '1.5', 'NaN', 'Infinity', '-Infinity',
        '18446744073709551616',
      ]) {
        await assert.rejects(
          insertIntent(pool, invalidRow(amount)),
          /execution_intents_amounts_check/u,
          `${name} amount ${amount} must be rejected`,
        );
      }
    }
    for (const invalidTimestamp of [
      -1,
      '275760-09-13T00:00:00.001+00',
      '1970-01-01T00:00:00.0001Z',
    ]) {
      await assert.rejects(
        insertIntent(pool, intentRow(draft(`invalid-time-${String(invalidTimestamp)}`, 'BUY', 1n, null), {
          requestedAtMs: invalidTimestamp,
        })),
        /execution_intents_temporal_check/u,
      );
    }
    await assert.rejects(
      insertIntent(pool, intentRow(draft('invalid-lease-time', 'BUY', 1n, null), {
        leaseOwner: 'worker',
        leaseToken: '00000000-0000-0000-0000-000000000001',
        leaseExpiresAtMs: '1970-01-01T00:00:00.0001Z',
      })),
      /execution_intents_temporal_check/u,
    );

    await assert.rejects(
      insertIntent(pool, intentRow(draft('pending-attempt', 'BUY', 1n, null), { attemptCount: 1 })),
      /execution_intents_pending_check/u,
    );
    await assert.rejects(
      insertIntent(pool, intentRow(draft('terminal-missing-time', 'BUY', 1n, null), { status: 'SUCCEEDED' })),
      /execution_intents_terminal_check/u,
    );
    await assert.rejects(
      insertIntent(pool, intentRow(draft('reconciled-missing-terminal', 'BUY', 1n, null), {
        status: 'PROCESSING',
        lastReasonCode: 'EXECUTION_STARTED',
        reconciliationCompletedAtMs: 1_000,
      })),
      /execution_intents_reconciliation_retention_check/u,
    );
    await assert.rejects(
      insertIntent(pool, intentRow(draft('purge-wrong-time', 'BUY', 1n, null), {
        status: 'SUCCEEDED', terminalAtMs: 1_000, reconciliationCompletedAtMs: 2_000, purgeAfterMs: 2_001,
        lastReasonCode: 'INTENT_SUCCEEDED',
      })),
      /execution_intents_reconciliation_retention_check/u,
    );

    const processing = draft('processing-attempt', 'BUY', 1n, null);
    await insertIntent(pool, intentRow(processing, {
      status: 'PROCESSING', attemptCount: 1, lastReasonCode: 'EXECUTION_STARTED',
    }));
    await insertAttempt(pool, processing.id, 1, 'COMPLETED', 0, 1, null);
    assert.deepEqual((await pool.query(`SELECT purge_after FROM execution_attempts WHERE intent_id = $1`, [
      processing.id,
    ])).rows, [{ purge_after: null }]);
    await assert.rejects(
      insertAttempt(pool, processing.id, 2, 'COMPLETED', 0, 1, 0),
      /execution_attempts_retention_check/u,
    );
    await assert.rejects(
      insertAttempt(pool, processing.id, 3, 'COMPLETED', 0, 1, 2),
      /execution_attempts_retention_check/u,
    );

    const exactEvidence = {
      payloadVersion: 1, attemptNumber: 1, sourceEventId: null, observedAtMs: 0,
    };
    await insertTransition(pool, processing.id, exactEvidence);
    for (const evidence of [
      null,
      [],
      true,
      {},
      { ...exactEvidence, extra: true },
      { ...exactEvidence, payloadVersion: '1' },
      { ...exactEvidence, attemptNumber: 0 },
      '{"payloadVersion":1,"attemptNumber":1.0,"sourceEventId":null,"observedAtMs":0}',
      { ...exactEvidence, sourceEventId: '' },
      { ...exactEvidence, observedAtMs: -1 },
      '{"payloadVersion":1,"attemptNumber":null,"sourceEventId":null,"observedAtMs":1.0}',
      { ...exactEvidence, observedAtMs: maximumTimestamp + 1 },
    ]) {
      await assert.rejects(
        insertTransition(pool, processing.id, evidence),
        /execution_intent_transitions_evidence_check/u,
      );
    }
    await assert.rejects(
      insertTransition(pool, processing.id, { ...exactEvidence, attemptNumber: null }),
      /execution_intent_transitions_evidence_check/u,
    );
    await assert.rejects(
      insertTransition(pool, processing.id, { ...exactEvidence, attemptNumber: 2 }),
      /execution_intent_transitions_evidence_check/u,
    );
    await assert.rejects(
      insertTransition(pool, processing.id, exactEvidence, 0, null),
      /execution_intent_transitions_evidence_check/u,
    );

    const timedProcessing = draft('timestamped-attempts', 'BUY', 1n, null);
    await insertIntent(pool, intentRow(timedProcessing, { status: 'PROCESSING', attemptCount: 1 }));
    await insertAttempt(pool, timedProcessing.id, 1, 'COMPLETED', maximumTimestamp - 1, maximumTimestamp, null);
    await insertTransition(pool, timedProcessing.id, exactEvidence, maximumTimestamp);
    for (const invalidTimestamp of [-1, '275760-09-13T00:00:00.001+00', '1970-01-01T00:00:00.0001Z']) {
      await assert.rejects(
        insertAttempt(pool, timedProcessing.id, 2, 'COMPLETED', invalidTimestamp, maximumTimestamp, null),
        /execution_attempts_temporal_check/u,
      );
      await assert.rejects(
        insertTransition(pool, timedProcessing.id, exactEvidence, invalidTimestamp),
        /execution_intent_transitions_occurred_at_check/u,
      );
    }

    await assertCatalogContract(pool);
    await pool.query('DELETE FROM execution_intents WHERE id = $1', [processing.id]);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM execution_attempts
      WHERE intent_id = $1`, [processing.id])).rows[0]?.count, 0);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM execution_intent_transitions
      WHERE intent_id = $1`, [processing.id])).rows[0]?.count, 0);
  });
});

void test('purges only reconciled terminal execution intent ledgers after retention', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: execution intent purge test skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'execution_intent_purge', async (pool) => {
    await migrateDatabase({ pool });
    const terminalStatuses = ['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED'] as const;
    const terminalIds: string[] = [];
    const expectedTombstones: Record<string, unknown>[] = [];
    for (const status of terminalStatuses) {
      const value = draft(`purge-${status.toLowerCase()}`, 'BUY', 1n, null);
      terminalIds.push(value.id);
      expectedTombstones.push({
        intent_id: value.id,
        payload_version: 1,
        logical_order_key: value.logicalOrderKey,
        decision_fingerprint: value.decisionFingerprint,
      });
      await insertIntent(pool, intentRow(value, {
        status, attemptCount: 1, terminalAtMs: 1_000,
        reconciliationCompletedAtMs: 2_000, purgeAfterMs: 14_402_000,
      }));
      await insertAttempt(pool, value.id, 1, 'COMPLETED', 0, 1_000, null);
      await insertTransition(pool, value.id, {
        payloadVersion: 1, attemptNumber: 1, sourceEventId: null, observedAtMs: 1_000,
      }, 1_000);
      await insertDryRunAssessment(pool, value);
    }

    const retainedIds: string[] = [];
    const beforeBoundary = Date.now() + 60_000;
    const retainedTerminal = draft('retain-before-purge-boundary', 'BUY', 1n, null);
    retainedIds.push(retainedTerminal.id);
    await insertIntent(pool, intentRow(retainedTerminal, {
      status: 'SUCCEEDED', terminalAtMs: beforeBoundary - 14_401_000,
      reconciliationCompletedAtMs: beforeBoundary - 14_400_000,
      purgeAfterMs: beforeBoundary,
    }));
    const nonTerminalIds: string[] = [];
    for (const status of ['PENDING', 'PROCESSING', 'UNKNOWN_REQUIRES_RECONCILIATION'] as const) {
      const value = draft(`retain-${status.toLowerCase()}`, 'BUY', 1n, null);
      retainedIds.push(value.id);
      nonTerminalIds.push(value.id);
      await insertIntent(pool, intentRow(value));
      if (status === 'PENDING') await insertDryRunAssessment(pool, value);
    }
    // Exercise the purge predicate defensively against legacy/corrupt rows whose
    // stale retention timestamps no longer satisfy the current schema checks.
    await pool.query(`ALTER TABLE execution_intents
      DROP CONSTRAINT execution_intents_pending_check,
      DROP CONSTRAINT execution_intents_terminal_check,
      DROP CONSTRAINT execution_intents_reconciliation_retention_check`);
    for (const [id, status] of nonTerminalIds.map((id, index) => [
      id, ['PENDING', 'PROCESSING', 'UNKNOWN_REQUIRES_RECONCILIATION'][index],
    ] as const)) {
      await pool.query(`UPDATE execution_intents SET
        status = $2, terminal_at = to_timestamp(1),
        reconciliation_completed_at = to_timestamp(2), purge_after = to_timestamp(14402)
        WHERE id = $1`, [id, status]);
    }

    const purged = await purgeExpiredFoundationData(pool);
    assert.equal(purged.executionDryRunAssessments, terminalStatuses.length);
    assert.equal(purged.executionIntentTransitions, terminalStatuses.length);
    assert.equal(purged.executionAttempts, terminalStatuses.length);
    assert.equal(purged.executionIntents, terminalStatuses.length);
    assert.deepEqual((await pool.query(`SELECT intent_id, payload_version, logical_order_key,
      decision_fingerprint FROM execution_intent_tombstones ORDER BY intent_id`)).rows,
    expectedTombstones.sort((left, right) => String(left.intent_id).localeCompare(String(right.intent_id))));
    assert.deepEqual((await pool.query<{ readonly id: string }>(
      'SELECT id FROM execution_intents ORDER BY id',
    )).rows.map(({ id }) => id).sort(), retainedIds.sort());
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_attempts WHERE intent_id = ANY($1::TEXT[])',
      [terminalIds],
    )).rows[0]?.count, 0);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_intent_transitions WHERE intent_id = ANY($1::TEXT[])',
      [terminalIds],
    )).rows[0]?.count, 0);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_dry_run_assessments WHERE intent_id = ANY($1::TEXT[])',
      [terminalIds],
    )).rows[0]?.count, 0);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_dry_run_assessments WHERE intent_id = $1',
      [nonTerminalIds[0]],
    )).rows[0]?.count, 1);
    const secondPass = await purgeExpiredFoundationData(pool);
    assert.deepEqual([
      secondPass.executionDryRunAssessments, secondPass.executionIntentTransitions,
      secondPass.executionAttempts, secondPass.executionIntents,
    ], [0, 0, 0, 0]);
  });
});

void test('rolls back execution intent child purges when the parent delete fails', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: execution intent purge rollback test skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'execution_intent_purge_rollback', async (pool) => {
    await migrateDatabase({ pool });
    const value = draft('purge-rollback', 'BUY', 1n, null);
    await insertIntent(pool, intentRow(value, {
      status: 'SUCCEEDED', attemptCount: 1, terminalAtMs: 1_000,
      reconciliationCompletedAtMs: 2_000, purgeAfterMs: 14_402_000,
    }));
    await insertAttempt(pool, value.id, 1, 'COMPLETED', 0, 1_000, null);
    await insertTransition(pool, value.id, {
      payloadVersion: 1, attemptNumber: 1, sourceEventId: null, observedAtMs: 1_000,
    }, 1_000);
    await insertDryRunAssessment(pool, value);
    await pool.query(`CREATE FUNCTION reject_execution_intent_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced execution intent purge rollback'; END $$`);
    await pool.query(`CREATE TRIGGER reject_execution_intent_delete
      BEFORE DELETE ON execution_intents FOR EACH ROW EXECUTE FUNCTION reject_execution_intent_delete()`);

    await assert.rejects(
      purgeExpiredFoundationData(pool),
      /forced execution intent purge rollback/u,
    );
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_intents WHERE id = $1', [value.id],
    )).rows[0]?.count, 1);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_attempts WHERE intent_id = $1', [value.id],
    )).rows[0]?.count, 1);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_intent_transitions WHERE intent_id = $1', [value.id],
    )).rows[0]?.count, 1);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_intent_tombstones WHERE intent_id = $1', [value.id],
    )).rows[0]?.count, 0);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_dry_run_assessments WHERE intent_id = $1', [value.id],
    )).rows[0]?.count, 1);
  });
});

void test('rolls back an execution intent purge when tombstone insertion collides', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: execution intent tombstone collision test skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'execution_intent_tombstone_collision', async (pool) => {
    await migrateDatabase({ pool });
    const value = draft('purge-tombstone-collision', 'BUY', 1n, null);
    await insertIntent(pool, intentRow(value, {
      status: 'SUCCEEDED', attemptCount: 1, terminalAtMs: 1_000,
      reconciliationCompletedAtMs: 2_000, purgeAfterMs: 14_402_000,
    }));
    await insertAttempt(pool, value.id, 1, 'COMPLETED', 0, 1_000, null);
    await insertTransition(pool, value.id, {
      payloadVersion: 1, attemptNumber: 1, sourceEventId: null, observedAtMs: 1_000,
    }, 1_000);
    await insertDryRunAssessment(pool, value);
    await pool.query(`INSERT INTO execution_intent_tombstones (
      intent_id,logical_order_key,decision_fingerprint,retired_at
    ) VALUES ('different-intent',$1,$2,to_timestamp(1))`, [
      value.logicalOrderKey, value.decisionFingerprint,
    ]);

    await assert.rejects(purgeExpiredFoundationData(pool), /duplicate key/u);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_intents WHERE id=$1', [value.id],
    )).rows[0]?.count, 1);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_attempts WHERE intent_id=$1', [value.id],
    )).rows[0]?.count, 1);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_intent_transitions WHERE intent_id=$1', [value.id],
    )).rows[0]?.count, 1);
  });
});

void test('pins one execution intent purge cohort across all child and parent deletes', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: execution intent purge cohort test skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'execution_intent_purge_cohort', async (pool) => {
    await migrateDatabase({ pool });
    const value = draft('purge-cohort-boundary', 'BUY', 1n, null);
    const futurePurgeAtMs = Date.now() + 60_000;
    await insertIntent(pool, intentRow(value, {
      status: 'SUCCEEDED', attemptCount: 1,
      terminalAtMs: futurePurgeAtMs - 28_800_000,
      reconciliationCompletedAtMs: futurePurgeAtMs - 14_400_000,
      purgeAfterMs: futurePurgeAtMs,
    }));
    await insertAttempt(pool, value.id, 1, 'COMPLETED', 0, 1_000, null);
    await insertTransition(pool, value.id, {
      payloadVersion: 1, attemptNumber: 1, sourceEventId: null, observedAtMs: 1_000,
    }, 1_000);
    await insertDryRunAssessment(pool, value);
    await pool.query(`CREATE FUNCTION advance_execution_intent_purge_boundary() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        UPDATE execution_intents SET
          reconciliation_completed_at = date_trunc('milliseconds', statement_timestamp())
            - INTERVAL '4 hours',
          purge_after = date_trunc('milliseconds', statement_timestamp())
        WHERE id = TG_ARGV[0];
        RETURN NULL;
      END $$`);
    await pool.query(`CREATE TRIGGER advance_execution_intent_purge_boundary
      AFTER DELETE ON execution_intent_transitions FOR EACH STATEMENT
      EXECUTE FUNCTION advance_execution_intent_purge_boundary('${value.id}')`);

    const first = await purgeExpiredFoundationData(pool);
    assert.deepEqual([
      first.executionDryRunAssessments, first.executionIntentTransitions,
      first.executionAttempts, first.executionIntents,
    ], [0, 0, 0, 0]);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_intents WHERE id = $1', [value.id],
    )).rows[0]?.count, 1);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_attempts WHERE intent_id = $1', [value.id],
    )).rows[0]?.count, 1);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_intent_transitions WHERE intent_id = $1',
      [value.id],
    )).rows[0]?.count, 1);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_dry_run_assessments WHERE intent_id = $1',
      [value.id],
    )).rows[0]?.count, 1);

    await pool.query('DROP TRIGGER advance_execution_intent_purge_boundary ON execution_intent_transitions');
    const second = await purgeExpiredFoundationData(pool);
    assert.deepEqual([
      second.executionDryRunAssessments, second.executionIntentTransitions,
      second.executionAttempts, second.executionIntents,
    ], [1, 1, 1, 1]);
  });
});

void test('aggregates purge, rollback, and release failures and evicts the client', async () => {
  const primaryFailure = new Error('secret primary purge failure');
  const rollbackFailure = new Error('secret rollback failure');
  const releaseFailure = new Error('secret release failure');
  const releaseArguments: unknown[] = [];
  const client = {
    query: async (sql: string): Promise<{ readonly rowCount: number; readonly rows: readonly [] }> => {
      if (sql === 'BEGIN') return { rowCount: 0, rows: [] };
      if (sql === 'ROLLBACK') throw rollbackFailure;
      throw primaryFailure;
    },
    release: (destroy?: unknown): void => {
      releaseArguments.push(destroy);
      throw releaseFailure;
    },
  };
  const pool = { connect: async () => client };

  await assert.rejects(
    purgeExpiredFoundationData(pool as never),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'Foundation data purge and cleanup failed.');
      assert.deepEqual(error.errors, [primaryFailure, rollbackFailure, releaseFailure]);
      assert.doesNotMatch(error.message, /secret/u);
      return true;
    },
  );
  assert.deepEqual(releaseArguments, [true]);
});

function draft(
  logicalCommandId: string,
  side: 'BUY' | 'SELL',
  quoteAmountRaw: bigint | null,
  baseAmountRaw: bigint | null,
) {
  return createExecutionIntentDraft({
    strategyId: 'execution-intent-migration', strategyVersion: 1,
    positionId: `position-${logicalCommandId}`, logicalCommandId,
    mint: '11111111111111111111111111111111', side,
    venuePolicy: side === 'BUY' ? 'PUMP_FUN_ONLY' : 'CANONICAL_EXIT',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw, baseAmountRaw, minimumAmountOutRaw: 1n,
    decisionEventId: `event-${logicalCommandId}`, decisionFingerprint: 'a'.repeat(64),
    requestedAtMs: 0, expiresAtMs: 1_000,
  });
}

type TimestampInput = number | string | null;
type IntentRow = Readonly<{
  readonly draft: ReturnType<typeof draft>;
  readonly quoteAmountRaw: string | null;
  readonly baseAmountRaw: string | null;
  readonly minimumAmountOutRaw: string;
  readonly requestedAtMs: TimestampInput;
  readonly expiresAtMs: TimestampInput;
  readonly status: string;
  readonly attemptCount: number;
  readonly stateRevision: bigint;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAtMs: TimestampInput;
  readonly lastReasonCode: string | null;
  readonly terminalAtMs: TimestampInput;
  readonly reconciliationCompletedAtMs: TimestampInput;
  readonly purgeAfterMs: TimestampInput;
}>;

function intentRow(draftValue: ReturnType<typeof draft>, overrides: Partial<IntentRow> = {}): IntentRow {
  const status = overrides.status ?? 'PENDING';
  return {
    draft: draftValue,
    quoteAmountRaw: draftValue.quoteAmountRaw?.toString() ?? null,
    baseAmountRaw: draftValue.baseAmountRaw?.toString() ?? null,
    minimumAmountOutRaw: draftValue.minimumAmountOutRaw.toString(),
    requestedAtMs: draftValue.requestedAtMs, expiresAtMs: draftValue.expiresAtMs,
    status, attemptCount: 0, stateRevision: 0n, leaseOwner: null, leaseToken: null,
    leaseExpiresAtMs: null, lastReasonCode: migrationReasonForStatus(status), terminalAtMs: null,
    reconciliationCompletedAtMs: null, purgeAfterMs: null, ...overrides,
  };
}

function migrationReasonForStatus(status: string): string | null {
  const reasons: Readonly<Record<string, string>> = {
    PROCESSING: 'EXECUTION_STARTED', SIMULATED: 'SIMULATION_SUCCEEDED',
    RETRY_READY: 'RECONCILIATION_PROVED_NO_EFFECT',
    SIGNED_NOT_SUBMITTED: 'SIGNATURE_PERSISTED',
    SUBMITTED: 'SUBMISSION_ACCEPTED', CONFIRMED: 'CONFIRMATION_OBSERVED',
    RECONCILING: 'RECONCILIATION_STARTED', SUCCEEDED: 'INTENT_SUCCEEDED',
    FAILED: 'QUOTE_STALE', EXPIRED: 'INTENT_EXPIRED', CANCELLED: 'INTENT_CANCELLED',
    UNKNOWN_REQUIRES_RECONCILIATION: 'RECONCILIATION_REQUIRED',
  };
  return reasons[status] ?? null;
}

async function insertIntent(pool: InstanceType<typeof pg.Pool>, row: IntentRow): Promise<void> {
  const value = row.draft;
  await pool.query(`INSERT INTO execution_intents (
    id, payload_version, logical_order_key, strategy_id, strategy_version, position_id,
    logical_command_id, mint, side, venue_policy, quote_mint, quote_token_program,
    quote_decimals, quote_amount_raw, base_amount_raw, minimum_amount_out_raw,
    decision_event_id, decision_fingerprint, requested_at, expires_at, status,
    attempt_count, state_revision, lease_owner, lease_token, lease_expires_at, last_reason_code,
    terminal_at, reconciliation_completed_at, purge_after
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
    $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::UUID, $26, $27, $28, $29, $30
  )`, [
    value.id, value.payloadVersion, value.logicalOrderKey, value.strategyId, value.strategyVersion,
    value.positionId, value.logicalCommandId, value.mint, value.side, value.venuePolicy,
    value.quoteMint, value.quoteTokenProgram, value.quoteDecimals, row.quoteAmountRaw,
    row.baseAmountRaw, row.minimumAmountOutRaw, value.decisionEventId, value.decisionFingerprint,
    timestampParameter(row.requestedAtMs), timestampParameter(row.expiresAtMs), row.status,
    row.attemptCount, row.stateRevision.toString(), row.leaseOwner, row.leaseToken,
    timestampParameter(row.leaseExpiresAtMs), row.lastReasonCode, timestampParameter(row.terminalAtMs),
    timestampParameter(row.reconciliationCompletedAtMs), timestampParameter(row.purgeAfterMs),
  ]);
}

async function insertAttempt(
  pool: InstanceType<typeof pg.Pool>, intentId: string, attemptNumber: number,
  status: 'COMPLETED' | 'ABANDONED', startedAtMs: TimestampInput,
  completedAtMs: TimestampInput, purgeAfterMs: TimestampInput,
): Promise<void> {
  await pool.query(`INSERT INTO execution_attempts (
    intent_id, attempt_number, status, effective_venue, provider_id,
    started_at, completed_at, reason_code, purge_after
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
    intentId, attemptNumber, status, 'PUMP_FUN', 'provider', timestampParameter(startedAtMs),
    timestampParameter(completedAtMs), status === 'COMPLETED' ? 'ATTEMPT_COMPLETED' : 'QUOTE_STALE',
    timestampParameter(purgeAfterMs),
  ]);
}

async function insertTransition(
  pool: InstanceType<typeof pg.Pool>, intentId: string, evidence: unknown,
  occurredAtMs: TimestampInput = 0, attemptNumber: number | null = 1,
): Promise<void> {
  await pool.query(`INSERT INTO execution_intent_transitions (
    intent_id, previous_status, next_status, reason_code, human_message,
    activation_phase, attempt_number, evidence, occurred_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9)`, [
    intentId, 'PROCESSING', 'SIMULATED', 'SIMULATION_SUCCEEDED', 'migration test', 'NONE', attemptNumber,
    typeof evidence === 'string' ? evidence : JSON.stringify(evidence), timestampParameter(occurredAtMs),
  ]);
}

async function insertDryRunAssessment(
  pool: InstanceType<typeof pg.Pool>, value: ReturnType<typeof draft>,
): Promise<void> {
  await pool.query(`INSERT INTO execution_dry_run_assessments (
    assessment_id,payload_version,specification_version,evaluator_version,intent_id,
    strategy_id,strategy_version,decision_fingerprint,intent_state_revision,intent_status,
    input_fingerprint,result_fingerprint,outcome,coverage,quote_status,build_status,
    simulation_status,signature_status,submission_status,recorded_at
  ) VALUES (
    $1,1,'1.4.0',1,$2,$3,$4,$5,0,'PENDING',$5,$5,'FOUNDATION_VALIDATED',
    'INTENT_AND_LEASE_ONLY','NOT_RUN','NOT_RUN','NOT_RUN','NOT_RUN','NOT_RUN',to_timestamp(0)
  )`, [
    `execution_dry_run_assessment_${value.id.slice('execution_intent_'.length)}`,
    value.id, value.strategyId, value.strategyVersion, value.decisionFingerprint,
  ]);
}

async function insertTransitionReason(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
  previousStatus: string,
  nextStatus: string,
  reasonCode: string,
): Promise<void> {
  await pool.query(`INSERT INTO execution_intent_transitions (
    intent_id,previous_status,next_status,reason_code,human_message,
    activation_phase,attempt_number,evidence,occurred_at
  ) VALUES ($1,$2,$3,$4,'reconciliation proof test','NONE',NULL,
    '{"payloadVersion":1,"attemptNumber":null,"sourceEventId":null,"observedAtMs":0}'::JSONB,
    to_timestamp(0))`, [intentId, previousStatus, nextStatus, reasonCode]);
}

async function insertAttemptWithReason(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
  attemptNumber: number,
  status: 'ABANDONED',
  reasonCode: string,
): Promise<void> {
  await pool.query(`INSERT INTO execution_attempts (
    intent_id,attempt_number,status,effective_venue,provider_id,started_at,completed_at,reason_code
  ) VALUES ($1,$2,$3,'PUMP_FUN','provider',to_timestamp(0),to_timestamp(1),$4)`, [
    intentId, attemptNumber, status, reasonCode,
  ]);
}

function timestampParameter(value: TimestampInput): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  const iso = new Date(value).toISOString();
  return iso.startsWith('+') ? `${iso.slice(1, -1)}+00` : iso;
}

function timestampTextToMs(value: unknown): number {
  const timestamp = text(value);
  const normalized = timestamp.replace(/^(\d{5,}-)/u, '+$1');
  const milliseconds = new Date(normalized).getTime();
  assert.equal(Number.isSafeInteger(milliseconds), true);
  return milliseconds;
}

async function readIntentRow(
  pool: InstanceType<typeof pg.Pool>, intentId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await pool.query<Record<string, unknown>>(`SELECT
    id, payload_version, logical_order_key, strategy_id, strategy_version, position_id,
    logical_command_id, mint, side, venue_policy, quote_mint, quote_token_program,
    quote_decimals, quote_amount_raw::TEXT AS quote_amount_raw,
    base_amount_raw::TEXT AS base_amount_raw,
    minimum_amount_out_raw::TEXT AS minimum_amount_out_raw,
    decision_event_id, decision_fingerprint,
    (EXTRACT(EPOCH FROM requested_at) * 1000)::TEXT AS requested_at_ms,
    (EXTRACT(EPOCH FROM expires_at) * 1000)::TEXT AS expires_at_ms,
    status, attempt_count, state_revision::TEXT AS state_revision, last_reason_code,
    (EXTRACT(EPOCH FROM terminal_at) * 1000)::TEXT AS terminal_at_ms,
    (EXTRACT(EPOCH FROM reconciliation_completed_at) * 1000)::TEXT AS reconciliation_completed_at_ms,
    (EXTRACT(EPOCH FROM purge_after) * 1000)::TEXT AS purge_after_ms,
    (EXTRACT(EPOCH FROM created_at) * 1000)::TEXT AS created_at_ms,
    (EXTRACT(EPOCH FROM updated_at) * 1000)::TEXT AS updated_at_ms
    FROM execution_intents WHERE id = $1`, [intentId]);
  return result.rows[0];
}

function intentFromRow(row: Record<string, unknown> | undefined): object {
  assert.ok(row !== undefined);
  return {
    id: text(row.id), payloadVersion: integer(row.payload_version),
    logicalOrderKey: text(row.logical_order_key), strategyId: text(row.strategy_id),
    strategyVersion: integer(row.strategy_version), positionId: text(row.position_id),
    logicalCommandId: text(row.logical_command_id), mint: text(row.mint), side: text(row.side),
    venuePolicy: text(row.venue_policy), quoteMint: text(row.quote_mint),
    quoteTokenProgram: text(row.quote_token_program), quoteDecimals: integer(row.quote_decimals),
    quoteAmountRaw: BigInt(text(row.quote_amount_raw)),
    baseAmountRaw: row.base_amount_raw === null ? null : BigInt(text(row.base_amount_raw)),
    minimumAmountOutRaw: BigInt(text(row.minimum_amount_out_raw)),
    decisionEventId: text(row.decision_event_id), decisionFingerprint: text(row.decision_fingerprint),
    requestedAtMs: integer(row.requested_at_ms), expiresAtMs: integer(row.expires_at_ms),
    status: text(row.status), attemptCount: integer(row.attempt_count),
    stateRevision: BigInt(text(row.state_revision)),
    lastReasonCode: row.last_reason_code, terminalAtMs: nullableTimestamp(row.terminal_at_ms),
    reconciliationCompletedAtMs: nullableTimestamp(row.reconciliation_completed_at_ms),
    purgeAfterMs: nullableTimestamp(row.purge_after_ms),
    createdAtMs: integer(row.created_at_ms), updatedAtMs: integer(row.updated_at_ms),
  };
}

async function assertCatalogContract(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  const columns = await pool.query<{ readonly table_name: string; readonly column_name: string }>(`SELECT
    table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name IN (
        'execution_intents', 'execution_attempts', 'execution_intent_transitions',
        'execution_intent_tombstones'
      )
    ORDER BY table_name, ordinal_position`);
  assert.deepEqual(columns.rows, [
    ...['execution_attempts'].flatMap((table_name) => [
      'intent_id', 'attempt_number', 'status', 'effective_venue', 'provider_id', 'started_at',
      'completed_at', 'reason_code', 'purge_after', 'reconciliation_signature',
      'reconciliation_blockhash', 'reconciliation_last_valid_block_height',
      'reconciliation_message_hash', 'reconciliation_build_fingerprint',
      'reconciliation_snapshot_fingerprint', 'reconciliation_maximum_fee_lamports',
      'reconciliation_maximum_fee_payer_lamport_debit',
    ].map((column_name) => ({ table_name, column_name }))),
    ...['execution_intent_tombstones'].flatMap((table_name) => [
      'intent_id', 'payload_version', 'logical_order_key', 'decision_fingerprint', 'retired_at',
    ].map((column_name) => ({ table_name, column_name }))),
    ...['execution_intent_transitions'].flatMap((table_name) => [
      'sequence', 'intent_id', 'previous_status', 'next_status', 'reason_code', 'human_message',
      'activation_phase', 'attempt_number', 'evidence', 'occurred_at',
    ].map((column_name) => ({ table_name, column_name }))),
    ...['execution_intents'].flatMap((table_name) => [
      'id', 'payload_version', 'logical_order_key', 'strategy_id', 'strategy_version', 'position_id',
      'logical_command_id', 'mint', 'side', 'venue_policy', 'quote_mint', 'quote_token_program',
      'quote_decimals', 'quote_amount_raw', 'base_amount_raw', 'minimum_amount_out_raw',
      'decision_event_id', 'decision_fingerprint', 'requested_at', 'expires_at', 'status', 'attempt_count',
      'state_revision',
      'lease_owner', 'lease_token', 'lease_expires_at', 'last_reason_code', 'terminal_at',
      'reconciliation_completed_at', 'created_at', 'updated_at', 'purge_after',
    ].map((column_name) => ({ table_name, column_name }))),
  ]);
  const foreignKeys = await pool.query(`SELECT source_table.relname AS source, target_table.relname AS target,
    constraint_row.confdeltype AS delete_type
    FROM pg_constraint constraint_row
    JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
    JOIN pg_class target_table ON target_table.oid = constraint_row.confrelid
    JOIN pg_namespace source_namespace ON source_namespace.oid = source_table.relnamespace
    WHERE constraint_row.contype = 'f'
      AND source_namespace.nspname = current_schema()
      AND source_table.relname IN (
        'execution_attempts', 'execution_intent_transitions', 'execution_intent_tombstones'
      )
    ORDER BY source_table.relname`);
  assert.deepEqual(foreignKeys.rows, [
    { source: 'execution_attempts', target: 'execution_intents', delete_type: 'c' },
    { source: 'execution_intent_transitions', target: 'execution_intents', delete_type: 'c' },
  ]);
  const indexes = await pool.query<{ readonly indexname: string; readonly indexdef: string }>(`SELECT
    indexname, indexdef FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = 'execution_attempts_one_started_idx'`);
  assert.equal(indexes.rows.length, 1);
  assert.match(indexes.rows[0]?.indexdef ?? '', /UNIQUE INDEX .* \(intent_id\) WHERE \(status = 'STARTED'::text\)$/u);
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Expected text database field.');
  return value;
}

function integer(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(text(value));
  assert.equal(Number.isSafeInteger(result), true);
  return result;
}

function nullableTimestamp(value: unknown): number | null {
  return value === null ? null : integer(value);
}

async function withTemporarySchema(
  databaseUrl: string,
  prefix: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  let schemaCreated = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    schemaCreated = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    try {
      await pool.end();
    } finally {
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}

function withoutSqlComments(sql: string): string {
  return sql.replace(/--[^\r\n]*/gu, ' ').replace(/\/\*[\s\S]*?\*\//gu, ' ');
}

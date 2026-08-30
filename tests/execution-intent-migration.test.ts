import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '031_execution_intents.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);
const paperTableReference = /\bREFERENCES\s+(?:(?:"[^"]+"|[a-z_][a-z0-9_$]*)\s*\.\s*)?(?:"paper_[^"]*"|paper_[a-z0-9_$]*)/iu;

void test('execution intent migration defines the inert durable ledger contract', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const executableSql = withoutSqlComments(sql);

  assert.match(executableSql, /CREATE TABLE IF NOT EXISTS execution_intents/u);
  assert.match(executableSql, /CREATE TABLE IF NOT EXISTS execution_attempts/u);
  assert.match(executableSql, /CREATE TABLE IF NOT EXISTS execution_intent_transitions/u);
  assert.match(executableSql, /UNIQUE\s*\(logical_order_key\)/u);
  assert.doesNotMatch(executableSql, paperTableReference);
  for (const amountColumn of ['quote_amount_raw', 'base_amount_raw', 'minimum_amount_out_raw']) {
    assert.match(
      executableSql,
      new RegExp(`\\b${amountColumn}\\s*=\\s*trunc\\(\\s*${amountColumn}\\s*\\)`, 'u'),
    );
  }
  assert.match(executableSql, /quote_amount_raw NUMERIC,/u);
  assert.match(executableSql, /WHERE status = 'PENDING'/u);
  assert.doesNotMatch(executableSql, /signed_transaction|private_key|keypair/iu);
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
    assert.equal(applied.at(-1), migrationName);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await pool.query(await readFile(migrationUrl, 'utf8'));

    await pool.query(validIntentSql('valid-boundary', '18446744073709551615'));
    await pool.query(`INSERT INTO execution_intents (
      id, logical_order_key, strategy_id, strategy_version, position_id,
      logical_command_id, mint, side, venue_policy, quote_mint,
      quote_token_program, quote_decimals, base_amount_raw, minimum_amount_out_raw,
      decision_event_id, decision_fingerprint, requested_at, expires_at, status
    ) VALUES (
      'valid-sell', 'logical-sell', 'strategy', 1, 'position', 'command-sell',
      'mint', 'SELL', 'CANONICAL_EXIT', 'quote-mint', 'TOKEN_2022', 0,
      1, 1, 'event', ${fingerprintLiteral()},
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'PENDING'
    )`);
    await pool.query(`INSERT INTO execution_attempts (
      intent_id, attempt_number, status, effective_venue, provider_id,
      started_at, completed_at, reason_code, purge_after
    ) VALUES (
      'valid-boundary', 2147483647, 'COMPLETED', 'PUMP_FUN', repeat('p', 256),
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'QUOTE_STALE',
      '2026-01-01T04:01:00.000Z'
    )`);
    await pool.query(`INSERT INTO execution_intent_transitions (
      intent_id, previous_status, next_status, reason_code, human_message,
      activation_phase, attempt_number, evidence
    ) VALUES (
      'valid-boundary', 'PENDING', 'PROCESSING', 'QUOTE_STALE', repeat('m', 256),
      'NONE', 2147483647, '{"payloadVersion":1}'::jsonb
    )`);

    await assert.rejects(
      pool.query(validIntentSql('fractional', '1.5')),
      /execution_intents_amounts_check/u,
    );
    await assert.rejects(
      pool.query(validIntentSql('too-large', '18446744073709551616')),
      /execution_intents_amounts_check/u,
    );
    await assert.rejects(
      pool.query(validIntentSql('wrong-side', '1').replace("'BUY', 'PUMP_FUN_ONLY'", "'BUY', 'CANONICAL_EXIT'")),
      /execution_intents_side_venue_amount_check/u,
    );
    await assert.rejects(
      pool.query(validIntentSql('incomplete-lease', '1').replace(
        'requested_at, expires_at, status\n  )',
        'requested_at, expires_at, status, lease_owner, lease_token, lease_expires_at\n  )',
      ).replace(
        "'2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'PENDING'",
        "'2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'PENDING', 'worker', NULL, NULL",
      )),
      /execution_intents_lease_check/u,
    );
    await assert.rejects(
      pool.query(validIntentSql('terminal-without-time', '1').replace("'PENDING'", "'SUCCEEDED'")),
      /execution_intents_terminal_check/u,
    );
    await assert.rejects(
      pool.query(validIntentSql('terminal-with-lease', '1').replace(
        'requested_at, expires_at, status\n  )',
        'requested_at, expires_at, status, terminal_at, lease_owner, lease_token, lease_expires_at\n  )',
      ).replace(
        "'2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'PENDING'",
        "'2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'SUCCEEDED', '2026-01-01T00:01:00.000Z', 'worker', '00000000-0000-0000-0000-000000000001', '2026-01-01T00:02:00.000Z'",
      )),
      /execution_intents_terminal_check/u,
    );
  });
});

function validIntentSql(id: string, quoteAmount: string): string {
  return `INSERT INTO execution_intents (
    id, logical_order_key, strategy_id, strategy_version, position_id,
    logical_command_id, mint, side, venue_policy, quote_mint,
    quote_token_program, quote_decimals, quote_amount_raw, minimum_amount_out_raw,
    decision_event_id, decision_fingerprint, requested_at, expires_at, status
  ) VALUES (
    '${id}', 'logical-${id}', 'strategy', 1, 'position', 'command-${id}',
    'mint', 'BUY', 'PUMP_FUN_ONLY', 'quote-mint', 'SPL_TOKEN', 255,
    ${quoteAmount}, 1, 'event', ${fingerprintLiteral()},
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'PENDING'
  )`;
}

function fingerprintLiteral(): string {
  return `'${'a'.repeat(64)}'`;
}

async function withTemporarySchema(
  databaseUrl: string,
  prefix: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}

function withoutSqlComments(sql: string): string {
  return sql.replace(/--[^\r\n]*/gu, ' ').replace(/\/\*[\s\S]*?\*\//gu, ' ');
}

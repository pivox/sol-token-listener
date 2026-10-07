import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { migrateDatabase } from '../src/storage/database.js';
import {
  createExitPendingFixture,
  requiredDatabaseUrl,
  withTemporarySchema,
} from './helpers/live-sell-fixture.js';

const migrationName = '066_live_position_reexit.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);
const canaryUrl = new URL('../migrations/036_execution_live_canary.sql', import.meta.url);
const TRANSITION_CHECK =
  "  IF NOT execution_live_state_transition_allowed('LIVE_POSITION',OLD.state,NEW.state) THEN";

void test('066 is the 036 position guard verbatim plus one EXIT_PENDING re-exit branch',
  async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const canary = await readFile(canaryUrl, 'utf8');
    const start = canary.indexOf('CREATE OR REPLACE FUNCTION guard_execution_live_position_update()');
    const end = canary.indexOf('CREATE OR REPLACE FUNCTION guard_execution_exit_authorization_insert()');
    assert.ok(start > 0 && end > start);
    const original = canary.slice(start, end).trimEnd().split('\n');
    assert.ok(original.includes(TRANSITION_CHECK));
    // Every line of the 036 function and trigger binding, except the transition check that
    // becomes the ELSIF of the new branch, appears in 066 in the same order.
    let cursor = 0;
    for (const line of original) {
      if (line === TRANSITION_CHECK) continue;
      const found = sql.indexOf(`${line}\n`, cursor);
      assert.ok(found >= cursor, `066 does not keep 036 line: ${line}`);
      cursor = found + line.length;
    }
    for (const fragment of [
      "IF OLD.state='EXIT_PENDING' AND NEW.state='EXIT_PENDING' THEN",
      "  ELSIF NOT execution_live_state_transition_allowed('LIVE_POSITION',OLD.state,NEW.state) THEN",
      "old_exit.status IN ('FAILED','EXPIRED')",
      'old_exit.terminal_at IS NOT NULL AND old_exit.reconciliation_completed_at IS NOT NULL',
      "old_exit.terminal_at <= statement_timestamp() - INTERVAL '30 seconds'",
      "new_exit.status='PENDING'",
      'new_exit.live_reserved=TRUE',
      'new_exit.base_amount_raw=NEW.remaining_base_raw',
      'new_exit.minimum_amount_out_raw=1',
      'new_exit.strategy_id=old_exit.strategy_id',
      "(?::retry-[12])?$'",
      "artifact.state NOT IN ('RECONCILED','REVOKED_NO_SEND')",
      "evidence.result='MATCHED'",
      "evidence.result IN ('UNKNOWN','MISMATCH')",
      'evidence.resolved_by_evidence_id IS NULL',
      "exit_auth.state='ACTIVE'",
      'risk.unknown_block=FALSE',
      'OLD.exit_reconciliation_fingerprint IS NOT NULL',
      'NEW.exit_reconciliation_fingerprint IS NOT NULL',
      "'execution live position re-exit is not permitted' USING ERRCODE='55000'",
    ]) assert.ok(sql.includes(fragment), `missing migration contract: ${fragment}`);
    assert.doesNotMatch(sql, /execution_live_state_transition_allowed\(\s*entity_type/u);
    assert.doesNotMatch(sql, /\b(?:DELETE FROM|TRUNCATE|DROP TABLE|GRANT|REVOKE)\b/u);
    assert.doesNotMatch(sql, /SECURITY DEFINER/u);
  });

void test('066 applies on an empty schema and replays cleanly', async (context) => {
  const databaseUrl = requiredDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationName);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const triggers = await pool.query(`SELECT tgname FROM pg_trigger
      WHERE tgrelid='execution_live_positions'::regclass AND NOT tgisinternal
        AND tgname='execution_live_positions_guarded_update' AND tgenabled='O'`);
    assert.equal(triggers.rowCount, 1);
  });
});

void test('066 keeps every other live position transition of 036', async (context) => {
  const databaseUrl = requiredDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    // OPEN -> EXIT_PENDING went through the trigger when the fixture created its SELL.
    const fixture = await createExitPendingFixture(pool);
    const positionId = fixture.entry.position?.positionId;
    assert.ok(positionId !== undefined);
    const attempt = async (statements: readonly string[]): Promise<string> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const statement of statements) {
          await client.query(`UPDATE execution_live_positions SET
            state_revision=state_revision+1,${statement} WHERE position_id=$1`, [positionId]);
        }
        return 'OK';
      } catch (error) {
        return (error as { code?: string }).code ?? 'UNKNOWN';
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    const closed = `state='CLOSED',remaining_base_raw=0,
      closed_at=date_trunc('milliseconds',statement_timestamp()),
      purge_after=date_trunc('milliseconds',statement_timestamp())+INTERVAL '4 hours',
      exit_reconciliation_fingerprint='${'f'.repeat(64)}'`;
    assert.equal(await attempt([closed]), 'OK', 'EXIT_PENDING -> CLOSED');
    assert.equal(await attempt(["state='UNKNOWN'"]), 'OK', 'EXIT_PENDING -> UNKNOWN');
    assert.equal(await attempt(["state='UNKNOWN'", "state='EXIT_PENDING'"]), 'OK',
      'UNKNOWN -> EXIT_PENDING');
    assert.equal(await attempt(["state='UNKNOWN'", closed]), 'OK', 'UNKNOWN -> CLOSED');
    assert.equal(await attempt(["state='OPEN',exit_intent_id=NULL"]), '55000',
      'EXIT_PENDING -> OPEN');
    assert.equal(await attempt(["state='EXIT_PENDING'"]), '55000',
      'EXIT_PENDING -> EXIT_PENDING without a dead intent');
    assert.equal(await attempt(["state='UNKNOWN'", "state='UNKNOWN'"]), '55000',
      'UNKNOWN -> UNKNOWN');
    assert.equal(await attempt([`mint='${'1'.repeat(32)}'`]), '55000', 'identity');
  });
});

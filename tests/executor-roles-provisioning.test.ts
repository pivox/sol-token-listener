import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';

const scriptUrl = new URL('../scripts/provision-executor-roles.sql', import.meta.url);
const repositoryUrl = new URL('../src/storage/execution-operations.repository.ts', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);
const environmentUrl = new URL('../.env.example', import.meta.url);
const smokeUrl = new URL('../scripts/deployment-smoke.mjs', import.meta.url);
const runbookUrl = new URL('../docs/operations/executor-live-canary.md', import.meta.url);
const databaseUrl = new URL('../src/storage/database.ts', import.meta.url);

void test('executor role provisioning is explicit, passwordless and least-privilege', async () => {
  const sql = await readFile(scriptUrl, 'utf8');
  const repository = await readFile(repositoryUrl, 'utf8');
  const executable = sql.replace(/--[^\r\n]*/gu, ' ');
  for (const role of [
    'sol_token_listener_writer', 'sol_token_executor_worker',
    'sol_token_executor_live',
    'sol_token_executor_operations', 'sol_token_operator_reader', 'sol_token_public_api',
    'sol_token_retention_worker',
  ]) assert.match(sql, new RegExp(`CREATE ROLE ${role} NOLOGIN`, 'u'));
  assert.doesNotMatch(executable, /\b(?:PASSWORD|SUPERUSER|CREATEDB|CREATEROLE|BYPASSRLS)\b/iu);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC/iu);
  assert.match(sql, /TO sol_token_executor_operations/u);
  assert.match(sql, /TO sol_token_operator_reader/u);
  assert.match(sql, /FROM sol_token_public_api,sol_token_listener_writer,sol_token_executor_worker/u);
  assert.match(sql, /GRANT USAGE ON SCHEMA public\s+TO sol_token_executor_live,sol_token_executor_operations,sol_token_operator_reader/iu);
  assert.doesNotMatch(
    executable,
    /GRANT\s+[^;]*\bDELETE\b[^;]*\bTO\s+(?!sol_token_retention_worker\b)/iu,
  );
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_safety_qualifications,\s+execution_safety_gate_evidence/iu);
  assert.match(sql, /GRANT INSERT,UPDATE ON TABLE\s+execution_control_state/iu);
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_control_events/iu);
  assert.match(sql, /GRANT INSERT,UPDATE ON TABLE\s+execution_operator_authorizations,\s+execution_activation_armaments/iu);
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_activation_events/iu);
  assert.doesNotMatch(sql, /(?:private_key|secret_key|seed_phrase|signed_bytes|rpc_url)/iu);
  for (const readOnlyTable of [
    'execution_wallet_generations',
    'execution_wallet_risk_state',
    'execution_safety_qualifications',
  ]) {
    assert.doesNotMatch(
      repository,
      new RegExp(`FROM\\s+${readOnlyTable}[^;]*FOR UPDATE`, 'iu'),
      `${readOnlyTable} must remain usable with SELECT-only privileges`,
    );
  }
});

void test('signed live capability is visible only to the dedicated executor role', async () => {
  const sql = await readFile(scriptUrl, 'utf8');
  assert.match(sql, /GRANT USAGE ON SCHEMA public[\s\S]*?sol_token_executor_live/iu);
  assert.match(sql, /REVOKE ALL ON TABLE\s+execution_signed_transactions,\s+execution_live_unsigned_simulation_evidence,\s+execution_signed_simulation_evidence,\s+execution_submission_preflight_evidence,\s+execution_pre_submission_revocations,\s+execution_submission_events,\s+execution_live_positions,\s+execution_exit_authorizations,\s+execution_reconciliation_evidence\s+FROM PUBLIC,sol_token_listener_writer,sol_token_executor_worker,\s+sol_token_executor_operations,sol_token_operator_reader,sol_token_public_api/iu);
  assert.match(sql, /REVOKE UPDATE ON TABLE\s+execution_signed_transactions,[\s\S]*?execution_reconciliation_evidence\s+FROM sol_token_executor_live/iu);
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_signed_transactions,\s+execution_live_positions,\s+execution_exit_authorizations\s+TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(state,state_revision,signed_simulated_at,[\s\S]*?revoked_at,purge_after\)\s+ON TABLE execution_signed_transactions TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(state,state_revision,exit_intent_id,[\s\S]*?purge_after\)\s+ON TABLE execution_live_positions TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(state,state_revision,locked_intent_id,[\s\S]*?purge_after\)\s+ON TABLE execution_exit_authorizations TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT SELECT,INSERT ON TABLE\s+execution_submission_events,\s+execution_live_unsigned_simulation_evidence,\s+execution_signed_simulation_evidence,\s+execution_submission_preflight_evidence,\s+execution_pre_submission_revocations\s+TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT SELECT,INSERT ON TABLE[\s\S]*execution_signed_simulation_evidence[\s\S]*TO sol_token_executor_live/iu);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*?execution_submission_preflight_evidence[\s\S]*?FROM PUBLIC,sol_token_listener_writer/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:UPDATE|DELETE|ALL)\s+ON TABLE\s+execution_submission_preflight_evidence/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:UPDATE|DELETE|ALL)\s+ON TABLE\s+execution_pre_submission_revocations/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:UPDATE|DELETE|ALL)\s+ON TABLE\s+execution_signed_simulation_evidence/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:UPDATE|DELETE|ALL)\s+ON TABLE\s+execution_live_unsigned_simulation_evidence/iu);
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_intents,\s+execution_attempts,\s+execution_wallet_risk_state,\s+execution_provider_usage_counters,\s+execution_exposure_reservations,\s+execution_activation_armaments\s+TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(status,state_revision,attempt_count,[\s\S]*?updated_at\)\s+ON TABLE execution_intents TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(status,effective_venue,provider_id,[\s\S]*?reconciliation_maximum_fee_payer_lamport_debit\)\s+ON TABLE execution_attempts TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(state_revision,reconciled_capital_lamports,[\s\S]*?updated_at\)\s+ON TABLE execution_wallet_risk_state TO sol_token_executor_live/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT,)?UPDATE ON TABLE\s+(?:execution_signed_transactions|execution_intents)/iu);
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_intent_transitions,\s+execution_risk_admission_reports,\s+execution_reconciliation_evidence,\s+execution_fault_ledger,\s+execution_activation_events\s+TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(resolved_by_evidence_id,resolved_at,purge_after\)\s+ON TABLE execution_reconciliation_evidence\s+TO sol_token_executor_live/iu);
  assert.doesNotMatch(sql, /GRANT[^;]*execution_signed_transactions[^;]*TO\s+(?:sol_token_listener_writer|sol_token_executor_worker|sol_token_executor_operations|sol_token_operator_reader|sol_token_public_api)/iu);
  assert.doesNotMatch(
    sql.replace(/--[^\r\n]*/gu, ' '),
    /GRANT\s+[^;]*\bDELETE\b[^;]*\bTO\s+(?!sol_token_retention_worker\b)/iu,
  );
});

void test('foundation retention has an isolated executable role without signed-byte access', async () => {
  const sql = await readFile(scriptUrl, 'utf8');
  const database = await readFile(databaseUrl, 'utf8');
  const executable = sql.replace(/--[^\r\n]*/gu, ' ');
  const purge = database.slice(
    database.indexOf('export async function purgeExpiredFoundationData'),
    database.indexOf('\nasync function migrationExists'),
  );

  assert.match(sql, /CREATE ROLE sol_token_retention_worker NOLOGIN NOSUPERUSER\s+NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/iu);
  assert.match(sql, /GRANT USAGE ON SCHEMA public[\s\S]*?sol_token_retention_worker/iu);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON SCHEMA public\s+FROM sol_token_retention_worker/iu);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public\s+FROM sol_token_retention_worker/iu);
  assert.match(sql, /GRANT DELETE ON TABLE[\s\S]*?execution_signed_transactions[\s\S]*?TO sol_token_retention_worker/iu);
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_risk_tombstones,\s+execution_intent_tombstones\s+TO sol_token_retention_worker/iu);
  assert.match(sql, /GRANT UPDATE \([^)]+\)\s+ON TABLE paper_mvp_runs TO sol_token_retention_worker/iu);
  assert.match(sql, /GRANT SELECT \(artifact_id,state,purge_after,exit_authorization_id\)\s+ON TABLE execution_signed_transactions TO sol_token_retention_worker/iu);
  assert.doesNotMatch(
    executable,
    /GRANT\s+SELECT\s+ON\s+TABLE\s+execution_signed_transactions[^;]*TO\s+sol_token_retention_worker/iu,
  );
  assert.doesNotMatch(executable, /signed_transaction_bytes[^;]*sol_token_retention_worker/iu);
  assert.doesNotMatch(
    executable,
    /GRANT\s+(?:ALL(?:\s+PRIVILEGES)?|UPDATE\s+ON\s+TABLE)[^;]*TO\s+sol_token_retention_worker/iu,
  );
  assert.match(purge, /pg_advisory_xact_lock\(hashtextextended\('foundation-retention-fence:v1', 0\)\)/u);
  assert.doesNotMatch(purge, /FOR UPDATE/iu);
});

void test('provisioned retention role runs the complete purge without reading signed bytes', async (context) => {
  const configuredUrl = process.env.TEST_DATABASE_URL;
  if (configuredUrl === undefined || configuredUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL is not configured.');
    return;
  }
  const baseUrl = new URL(configuredUrl);
  const maintenanceUrl = new URL(baseUrl);
  const maintenance = new pg.Pool({ connectionString: maintenanceUrl.href });
  const capabilities = await maintenance.query<{ rolsuper: boolean; rolcreatedb: boolean }>(
    'SELECT rolsuper,rolcreatedb FROM pg_roles WHERE rolname=current_user',
  );
  if (!capabilities.rows[0]?.rolsuper || !capabilities.rows[0].rolcreatedb) {
    await maintenance.end();
    context.skip('A PostgreSQL superuser with CREATEDB is required for isolated role testing.');
    return;
  }

  const databaseName = `retention_role_test_${randomUUID().replaceAll('-', '')}`;
  const isolatedUrl = new URL(baseUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  let isolated: InstanceType<typeof pg.Pool> | undefined;
  try {
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`);
    isolated = new pg.Pool({ connectionString: isolatedUrl.href });
    await migrateDatabase({ pool: isolated });
    await isolated.query(await readFile(scriptUrl, 'utf8'));

    const restrictedClient = await isolated.connect();
    await restrictedClient.query('SET ROLE sol_token_retention_worker');
    const restrictedPool = { connect: async () => restrictedClient };
    await purgeExpiredFoundationData(restrictedPool as never);

    const byteProbe = await isolated.connect();
    try {
      await byteProbe.query('SET ROLE sol_token_retention_worker');
      await assert.rejects(
        byteProbe.query('SELECT signed_transaction_bytes FROM execution_signed_transactions'),
        (error: unknown) => typeof error === 'object' && error !== null
          && 'code' in error && error.code === '42501',
      );
    } finally {
      try { await byteProbe.query('RESET ROLE'); } finally { byteProbe.release(); }
    }
  } finally {
    if (isolated !== undefined) await isolated.end();
    await maintenance.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [databaseName],
    );
    await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await maintenance.end();
  }
});

void test('live canary operational wiring stays explicit, inert and smoke-visible', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8')) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  const environment = await readFile(environmentUrl, 'utf8');
  const smoke = await readFile(smokeUrl, 'utf8');
  const runbook = await readFile(runbookUrl, 'utf8');
  assert.equal(packageJson.scripts?.['executor:live:start'], undefined);
  assert.match(environment, /^EXECUTOR_MODE=dry-run$/mu);
  assert.match(environment, /^LIVE_TRADING_ENABLED=false$/mu);
  assert.match(environment, /^EXECUTOR_KEYPAIR_PATH=$/mu);
  assert.match(smoke, /'036_execution_live_canary\.sql'/u);
  for (const counter of [
    'executionExitAuthorizations', 'executionLivePositions',
    'executionSignedTransactions', 'executionSubmissionEvents',
  ]) assert.match(smoke, new RegExp(`'${counter}'`, 'u'));
  assert.match(runbook, /npm run live:preflight/u);
  assert.match(runbook, /npm run live:resume/u);
  assert.match(runbook, /npm run live:arm --/u);
  assert.match(runbook, /npm run live:status/u);
  assert.match(runbook, /npm run live:kill-switch --/u);
  assert.match(runbook, /NON_EXECUTED\s*\/\s*NON_VALIDATED/u);
  assert.match(runbook, /aucune commande[\s\S]{0,80}enchaîne\s+automatiquement/iu);
  assert.match(runbook, /(?:ne modifie|ne change|maintient|laisse)[^\n]*ENTRY_STOP/iu);
  assert.match(runbook, /binaire[\s\S]{0,160}(?:non composé|indémarrable|pas démarrable)/iu);
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

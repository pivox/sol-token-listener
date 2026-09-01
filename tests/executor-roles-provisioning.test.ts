import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptUrl = new URL('../scripts/provision-executor-roles.sql', import.meta.url);
const repositoryUrl = new URL('../src/storage/execution-operations.repository.ts', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);
const environmentUrl = new URL('../.env.example', import.meta.url);
const smokeUrl = new URL('../scripts/deployment-smoke.mjs', import.meta.url);
const runbookUrl = new URL('../docs/operations/executor-live-canary.md', import.meta.url);

void test('executor role provisioning is explicit, passwordless and least-privilege', async () => {
  const sql = await readFile(scriptUrl, 'utf8');
  const repository = await readFile(repositoryUrl, 'utf8');
  const executable = sql.replace(/--[^\r\n]*/gu, ' ');
  for (const role of [
    'sol_token_listener_writer', 'sol_token_executor_worker',
    'sol_token_executor_live',
    'sol_token_executor_operations', 'sol_token_operator_reader', 'sol_token_public_api',
  ]) assert.match(sql, new RegExp(`CREATE ROLE ${role} NOLOGIN`, 'u'));
  assert.doesNotMatch(executable, /\b(?:PASSWORD|SUPERUSER|CREATEDB|CREATEROLE|BYPASSRLS)\b/iu);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC/iu);
  assert.match(sql, /TO sol_token_executor_operations/u);
  assert.match(sql, /TO sol_token_operator_reader/u);
  assert.match(sql, /FROM sol_token_public_api,sol_token_listener_writer,sol_token_executor_worker/u);
  assert.match(sql, /GRANT USAGE ON SCHEMA public\s+TO sol_token_executor_live,sol_token_executor_operations,sol_token_operator_reader/iu);
  assert.doesNotMatch(executable, /GRANT\s+[^;]*\bDELETE\b/iu);
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
  assert.match(sql, /REVOKE ALL ON TABLE\s+execution_signed_transactions,\s+execution_submission_events,\s+execution_live_positions,\s+execution_exit_authorizations\s+FROM PUBLIC,sol_token_listener_writer,sol_token_executor_worker,\s+sol_token_executor_operations,sol_token_operator_reader,sol_token_public_api/iu);
  assert.match(sql, /GRANT SELECT,INSERT,UPDATE ON TABLE\s+execution_signed_transactions,\s+execution_live_positions,\s+execution_exit_authorizations\s+TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT SELECT,INSERT ON TABLE\s+execution_submission_events\s+TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT INSERT,UPDATE ON TABLE\s+execution_intents,\s+execution_attempts,\s+execution_wallet_risk_state,\s+execution_provider_usage_counters,\s+execution_exposure_reservations,\s+execution_activation_armaments\s+TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_intent_transitions,\s+execution_risk_admission_reports,\s+execution_reconciliation_evidence,\s+execution_fault_ledger,\s+execution_activation_events\s+TO sol_token_executor_live/iu);
  assert.doesNotMatch(sql, /GRANT[^;]*execution_signed_transactions[^;]*TO\s+(?:sol_token_listener_writer|sol_token_executor_worker|sol_token_executor_operations|sol_token_operator_reader|sol_token_public_api)/iu);
  assert.doesNotMatch(sql, /GRANT\s+[^;]*\bDELETE\b/iu);
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

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptUrl = new URL('../scripts/provision-executor-roles.sql', import.meta.url);
const repositoryUrl = new URL('../src/storage/execution-operations.repository.ts', import.meta.url);

void test('executor role provisioning is explicit, passwordless and least-privilege', async () => {
  const sql = await readFile(scriptUrl, 'utf8');
  const repository = await readFile(repositoryUrl, 'utf8');
  const executable = sql.replace(/--[^\r\n]*/gu, ' ');
  for (const role of [
    'sol_token_listener_writer', 'sol_token_executor_worker',
    'sol_token_executor_operations', 'sol_token_operator_reader', 'sol_token_public_api',
  ]) assert.match(sql, new RegExp(`CREATE ROLE ${role} NOLOGIN`, 'u'));
  assert.doesNotMatch(executable, /\b(?:PASSWORD|SUPERUSER|CREATEDB|CREATEROLE|BYPASSRLS)\b/iu);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC/iu);
  assert.match(sql, /TO sol_token_executor_operations/u);
  assert.match(sql, /TO sol_token_operator_reader/u);
  assert.match(sql, /FROM sol_token_public_api,sol_token_listener_writer,sol_token_executor_worker/u);
  assert.match(sql, /GRANT USAGE ON SCHEMA public\s+TO sol_token_executor_operations,sol_token_operator_reader/iu);
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

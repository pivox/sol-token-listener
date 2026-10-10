import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  DATABASE_LOGINS,
  DATABASE_LOGIN_NAMES,
  REQUIRED_ROLES,
  ROLES,
  ROLE_NAMES,
  STACK_USERS,
  isRoleName,
  isStackMode,
  loginPasswordFile,
  roleSecretFiles,
} from '../src/deploy/stack.js';

void test('stack users carry the fixed UIDs of spec 6.1', () => {
  assert.deepEqual(STACK_USERS, {
    listener: 10001, h2b: 10002, h2a: 10003, autoarm: 10004,
    opapi: 10005, retention: 10006, worker: 10007, ops: 10008,
  });
});

void test('each login belongs to one role and joins a group role of the provisioning script', async () => {
  const provisioning = await readFile(
    new URL('../scripts/provision-executor-roles.sql', import.meta.url), 'utf8',
  );
  for (const group of new Set(Object.values(DATABASE_LOGINS))) {
    assert.match(provisioning, new RegExp(`CREATE ROLE ${group} NOLOGIN`, 'u'));
  }
  const logins = ROLE_NAMES.flatMap((name) => {
    const database = ROLES[name].database;
    return database === undefined ? [] : [database.login];
  });
  assert.deepEqual([...logins].sort(), [...DATABASE_LOGIN_NAMES].sort());
  assert.equal(loginPasswordFile('sol_live'), 'pg-sol_live-password');
});

void test('the keypair reaches only H2b, the evidence keys only ops, the API token only opapi', () => {
  for (const name of ROLE_NAMES) {
    const files = roleSecretFiles(ROLES[name]).map((secret) => secret.file);
    if (files.includes('wallet-keypair.json')) assert.equal(name, 'h2b');
    if (files.includes('evidence-private-key') || files.includes('helius-admin-api-key')) {
      assert.equal(ROLES[name].user, 'ops');
    }
    if (files.includes('operator-api-token')) assert.equal(name, 'opapi');
  }
});

void test('RPC: the account list for the listener only, the executor project for opapi and the executors', () => {
  assert.equal(ROLES.listener.heliusAccounts, 'helius-listener-accounts');
  assert.equal(ROLES.listener.httpRpc, undefined);
  assert.equal(ROLES.opapi.httpRpc, 'helius-executor-http-url');
  assert.equal(ROLES.h2b.httpRpc, 'helius-executor-http-url');
  assert.equal(ROLES.operations.httpRpc, undefined);
  for (const name of ROLE_NAMES) {
    if (name !== 'listener') assert.equal(ROLES[name].heliusAccounts, undefined, name);
  }
});

void test('observe needs no execution secret; live adds the executor programs and the boot entry-stop', () => {
  assert.deepEqual(REQUIRED_ROLES.observe, ['listener', 'opapi', 'retention']);
  assert.deepEqual(REQUIRED_ROLES.live, [
    'listener', 'opapi', 'retention', 'h2a', 'h2b', 'autoarm', 'operations',
  ]);
  const observeFiles = REQUIRED_ROLES.observe.flatMap(
    (name) => roleSecretFiles(ROLES[name]).map((secret) => secret.file),
  );
  for (const file of [
    'wallet-keypair.json', 'evidence-private-key', 'helius-admin-api-key',
  ]) {
    assert.equal(observeFiles.includes(file), false, file);
  }
});

void test('role and mode guards accept only known names', () => {
  assert.equal(isRoleName('evidence-bundle'), true);
  assert.equal(isRoleName('toString'), false);
  assert.equal(isStackMode('live'), true);
  assert.equal(isStackMode('LIVE'), false);
});

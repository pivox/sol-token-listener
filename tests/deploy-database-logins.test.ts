import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAdminDatabaseCli } from '../scripts/deploy/admin-database.js';
import {
  DatabaseProvisioningError,
  adminDatabaseUrl,
  ensureLogin,
  groupRolesSql,
  scramSha256Verifier,
  type SqlClient,
} from '../src/deploy/database-logins.js';

const ATTRIBUTES = 'LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
const VERIFIER = "'SCRAM-SHA-256\\$4096:[A-Za-z0-9+/]{22}==\\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}='";

class RecordingClient implements SqlClient {
  public readonly statements: string[] = [];

  public constructor(
    private readonly existing: boolean,
    private readonly memberships: readonly string[],
    private readonly failOn: string | null = null,
  ) {}

  public async query(text: string): Promise<{ readonly rows: readonly Record<string, unknown>[] }> {
    this.statements.push(text.replaceAll(/\s+/gu, ' ').trim());
    if (this.failOn !== null && text.startsWith(this.failOn)) throw new Error('simulated failure');
    if (text.startsWith('SELECT 1 FROM pg_catalog.pg_roles')) {
      return { rows: this.existing ? [{ present: 1 }] : [] };
    }
    if (text.includes('pg_auth_members')) return { rows: this.memberships.map((rolname) => ({ rolname })) };
    return { rows: [] };
  }
}

void test('a new login is created NOINHERIT with exactly its group membership', async () => {
  const client = new RecordingClient(false, []);
  await ensureLogin(client, 'sol_live', 'a'.repeat(64));
  assert.equal(client.statements[0], 'BEGIN');
  assert.match(client.statements[2] ?? '', new RegExp(`^CREATE ROLE "sol_live" ${ATTRIBUTES} PASSWORD ${VERIFIER}$`, 'u'));
  assert.ok(client.statements.every((statement) => !statement.includes('a'.repeat(64))), 'password sent in clear');
  assert.equal(
    client.statements.at(-2),
    'GRANT "sol_token_executor_live" TO "sol_live" WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',
  );
  assert.equal(client.statements.at(-1), 'COMMIT');
});

void test('an existing login gets its new password and loses every other membership', async () => {
  const client = new RecordingClient(true, ['sol_token_executor_live', 'sol_token_executor_operations']);
  await ensureLogin(client, 'sol_live', 'b'.repeat(64));
  const alter = new RegExp(`^ALTER ROLE "sol_live" WITH ${ATTRIBUTES} PASSWORD ${VERIFIER}$`, 'u');
  assert.equal(client.statements.filter((statement) => alter.test(statement)).length, 1);
  assert.ok(client.statements.every((statement) => !statement.includes('b'.repeat(64))), 'password sent in clear');
  assert.ok(client.statements.includes('REVOKE "sol_token_executor_operations" FROM "sol_live"'));
  assert.equal(client.statements.includes('REVOKE "sol_token_executor_live" FROM "sol_live"'), false);
});

void test('the SCRAM-SHA-256 verifier answers the RFC 7677 exchange', () => {
  const verifier = scramSha256Verifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'));
  const parts = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/u.exec(verifier);
  assert.ok(parts !== null, verifier);
  assert.equal(parts[1], 'W22ZaJ0SNY7soEsUEjb6gQ==');
  const storedKey = Buffer.from(parts[2] ?? '', 'base64');
  const serverKey = Buffer.from(parts[3] ?? '', 'base64');
  const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
  const authMessage = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`;
  // ServerKey reproduces the RFC's server signature; StoredKey accepts the RFC's client proof.
  assert.equal(createHmac('sha256', serverKey).update(authMessage).digest('base64'),
    '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  const signature = createHmac('sha256', storedKey).update(authMessage).digest();
  const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
  const clientKey = Buffer.from(proof.map((byte, index) => byte ^ (signature[index] ?? 0)));
  assert.deepEqual(createHash('sha256').update(clientKey).digest(), storedKey);
});

void test('a weak or unsafe password is refused before any statement', async () => {
  const client = new RecordingClient(false, []);
  await assert.rejects(ensureLogin(client, 'sol_ops', 'short'), DatabaseProvisioningError);
  await assert.rejects(
    ensureLogin(client, 'sol_ops', `${'x'.repeat(30)}'; DROP ROLE sol_owner; --`),
    DatabaseProvisioningError,
  );
  assert.deepEqual(client.statements, []);
});

void test('a failing statement rolls the login back', async () => {
  const client = new RecordingClient(false, [], 'GRANT');
  await assert.rejects(ensureLogin(client, 'sol_ops', 'c'.repeat(64)), /simulated failure/u);
  assert.equal(client.statements.at(-1), 'ROLLBACK');
});

void test('the group-role block comes verbatim from the provisioning script', async () => {
  const sql = await readFile(new URL('../scripts/provision-executor-roles.sql', import.meta.url), 'utf8');
  const block = groupRolesSql(sql);
  assert.match(block, /^DO \$roles\$\n/u);
  assert.match(block, /\n\$roles\$;$/u);
  assert.equal((block.match(/CREATE ROLE /gu) ?? []).length, 9);
  assert.doesNotMatch(block, /GRANT|REVOKE|ALTER/u);
  assert.throws(() => groupRolesSql('SELECT 1;'), DatabaseProvisioningError);
});

void test('the admin URL encodes the password and names sol_owner', () => {
  assert.equal(
    adminDatabaseUrl('sol_token_listener', `${'A'.repeat(24)}/+=`),
    `postgresql://sol_owner:${'A'.repeat(24)}%2F%2B%3D@postgres:5432/sol_token_listener`,
  );
  assert.throws(() => adminDatabaseUrl('Bad', 'A'.repeat(24)), DatabaseProvisioningError);
});

void test('sol-admin prints the admin URL and reports missing secrets by file name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sol-admin-'));
  try {
    await mkdir(join(root, 'logins'));
    await writeFile(join(root, 'postgres-admin-password'), `${'A'.repeat(30)}/+=\n`);
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (text: string) => { out.push(text); }, stderr: (text: string) => { err.push(text); } };
    const environment = { SOL_DB_SECRETS_DIR: root, POSTGRES_DB: 'smoke' };
    assert.equal(await runAdminDatabaseCli(['url'], environment, io), 0);
    assert.deepEqual(out, [`postgresql://sol_owner:${'A'.repeat(30)}%2F%2B%3D@postgres:5432/smoke\n`]);
    assert.equal(await runAdminDatabaseCli(['drop'], environment, io), 64);
    assert.equal(await runAdminDatabaseCli(['migrate'], environment, io), 1);
    assert.equal(err.at(-1), `sol-admin: missing file ${root}/logins/pg-sol_listener-password\n`);
    await writeFile(join(root, 'postgres-admin-password'), 'short\n');
    assert.equal(await runAdminDatabaseCli(['url'], environment, io), 1);
    assert.equal(
      err.at(-1),
      'sol-admin: postgres-admin-password: expected 24 to 256 characters from [A-Za-z0-9._~+/=-]\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

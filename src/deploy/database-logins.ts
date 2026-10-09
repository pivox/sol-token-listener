import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import {
  DATABASE_ADMIN,
  DATABASE_HOST,
  DATABASE_LOGINS,
  DATABASE_PORT,
  type DatabaseLogin,
} from './stack.js';

export class DatabaseProvisioningError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DatabaseProvisioningError';
  }
}

/** `openssl rand -hex 32` fits; no quote, backslash or space can ever reach SQL. */
const PASSWORD = /^[A-Za-z0-9._~+/=-]{24,256}$/u;
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const LOGIN_ATTRIBUTES =
  'LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
/** PostgreSQL's default `scram_iterations`. */
const SCRAM_ITERATIONS = 4096;

export function assertPassword(password: string, file: string): void {
  if (!PASSWORD.test(password)) {
    throw new DatabaseProvisioningError(
      `${file}: expected 24 to 256 characters from [A-Za-z0-9._~+/=-]`,
    );
  }
}

export function adminDatabaseUrl(databaseName: string, password: string): string {
  if (!DATABASE_NAME.test(databaseName)) {
    throw new DatabaseProvisioningError('POSTGRES_DB must be a plain lower-case database name');
  }
  assertPassword(password, 'postgres-admin-password');
  return `postgresql://${DATABASE_ADMIN}:${encodeURIComponent(password)}`
    + `@${DATABASE_HOST}:${DATABASE_PORT}/${databaseName}`;
}

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for a password (RFC 5802, RFC 7677). Sent in place
 * of the password, it keeps the password out of the server's logs, even when a statement fails.
 * SASLprep leaves the ASCII alphabet of `assertPassword` unchanged.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest('base64');
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$${String(SCRAM_ITERATIONS)}:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}

export interface SqlClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

/**
 * Creates or updates one LOGIN: NOINHERIT, the SCRAM verifier of its password from the secret
 * file, and membership of exactly its group role with ADMIN FALSE, INHERIT FALSE, SET TRUE
 * (spec 9.1).
 */
export async function ensureLogin(
  client: SqlClient,
  login: DatabaseLogin,
  password: string,
): Promise<void> {
  assertPassword(password, `pg-${login}-password`);
  const group = DATABASE_LOGINS[login];
  await client.query('BEGIN');
  try {
    const existing = await client.query(
      'SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [login],
    );
    const verifier = literal(scramSha256Verifier(password));
    await client.query(existing.rows.length === 0
      ? `CREATE ROLE ${identifier(login)} ${LOGIN_ATTRIBUTES} PASSWORD ${verifier}`
      : `ALTER ROLE ${identifier(login)} WITH ${LOGIN_ATTRIBUTES} PASSWORD ${verifier}`);
    const memberships = await client.query(
      `SELECT granted.rolname AS rolname
       FROM pg_catalog.pg_auth_members membership
       JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
       JOIN pg_catalog.pg_roles grantee ON grantee.oid = membership.member
       WHERE grantee.rolname = $1`,
      [login],
    );
    for (const row of memberships.rows) {
      const granted = row.rolname;
      if (typeof granted !== 'string') throw new DatabaseProvisioningError('unexpected membership row');
      if (granted !== group) {
        await client.query(`REVOKE ${identifier(granted)} FROM ${identifier(login)}`);
      }
    }
    await client.query(
      `GRANT ${identifier(group)} TO ${identifier(login)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The `DO $roles$ … $roles$;` block of the provisioning script: the NOLOGIN group roles only. */
export function groupRolesSql(provisioningSql: string): string {
  const match = /^DO \$roles\$\n[\s\S]*?\n\$roles\$;$/mu.exec(provisioningSql);
  if (match === null) {
    throw new DatabaseProvisioningError('group role block not found in provision-executor-roles.sql');
  }
  return match[0];
}

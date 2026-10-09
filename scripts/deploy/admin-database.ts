import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  DatabaseProvisioningError,
  adminDatabaseUrl,
  ensureLogin,
  groupRolesSql,
  type SqlClient,
} from '../../src/deploy/database-logins.js';
import { DATABASE_LOGIN_NAMES, loginPasswordFile } from '../../src/deploy/stack.js';
import { migrateDatabase } from '../../src/storage/database.js';

/** The unprivileged `node` user of the base image: SQL runs without root once secrets are read. */
const NODE_UID = 1000;

export interface AdminDatabaseCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * `sol-admin` in the migrate container, the only holder of the admin password:
 * - `migrate`: migrations under the advisory lock, provisioning replay, the nine logins;
 * - `group-roles`: the NOLOGIN group roles only, before a `pg_restore`;
 * - `url`: prints the admin URL for `sol-admin report`.
 */
export async function runAdminDatabaseCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: AdminDatabaseCliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  if ((command !== 'migrate' && command !== 'group-roles' && command !== 'url') || rest.length > 0) {
    io.stderr('usage: admin-database migrate|group-roles|url\n');
    return 64;
  }
  try {
    const secretsDirectory = environment.SOL_DB_SECRETS_DIR ?? '/root/secrets/db';
    const url = adminDatabaseUrl(
      environment.POSTGRES_DB ?? 'sol_token_listener',
      secretLine(`${secretsDirectory}/postgres-admin-password`),
    );
    if (command === 'url') {
      io.stdout(`${url}\n`);
      return 0;
    }
    const passwords = command === 'migrate'
      ? DATABASE_LOGIN_NAMES.map((login) => [
        login, secretLine(`${secretsDirectory}/logins/${loginPasswordFile(login)}`),
      ] as const)
      : [];
    const provisioningSql = readFileSync(
      new URL('../provision-executor-roles.sql', import.meta.url), 'utf8',
    );
    dropPrivileges();
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      if (command === 'group-roles') {
        await pool.query(groupRolesSql(provisioningSql));
        io.stdout(`${JSON.stringify({ service: 'sol-admin', event: 'database.group_roles_ensured' })}\n`);
        return 0;
      }
      const applied = await migrateDatabase({ pool });
      await pool.query(provisioningSql);
      const client = await pool.connect();
      try {
        const sql: SqlClient = {
          query: async (text, values) => client.query(text, values === undefined ? [] : [...values]),
        };
        for (const [login, password] of passwords) await ensureLogin(sql, login, password);
      } finally {
        client.release();
      }
      io.stdout(`${JSON.stringify({
        service: 'sol-admin', event: 'database.provisioned', applied, logins: DATABASE_LOGIN_NAMES,
      })}\n`);
      return 0;
    } finally {
      await pool.end();
    }
  } catch (error) {
    const reason = error instanceof DatabaseProvisioningError
      ? error.message
      : `database provisioning failed (${sqlState(error)})`;
    io.stderr(`sol-admin: ${reason}\n`);
    return 1;
  }
}

function secretLine(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new DatabaseProvisioningError(`missing file ${path}`);
  }
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw;
}

function dropPrivileges(): void {
  if (process.getuid?.() !== 0) return;
  process.setgroups?.([]);
  process.setgid?.(NODE_UID);
  process.setuid?.(NODE_UID);
}

/** Only a five-character SQLSTATE reaches the log, never a message (it may quote SQL). */
function sqlState(error: unknown): string {
  const code = typeof error === 'object' && error !== null
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code) ? code : 'unknown';
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runAdminDatabaseCli(process.argv.slice(2), process.env, {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}

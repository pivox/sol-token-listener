import { parse } from 'dotenv';
import { HeliusAccountsError, parseHeliusAccountsFile, withApiKey } from '../config/helius-accounts.js';
import {
  DATABASE_HOST,
  DATABASE_LOGINS,
  DATABASE_PORT,
  ROLES,
  STACK_USERS,
  loginPasswordFile,
  type DatabaseLogin,
  type RoleName,
  type StackMode,
} from './stack.js';

/** Messages name files and variables, never a value. */
export class RoleEnvironmentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RoleEnvironmentError';
  }
}

/** Variables `sol-run` derives from secret files: a configuration file must never set them. */
export const INJECTED_KEYS: ReadonlySet<string> = new Set([
  'DATABASE_URL',
  'OPERATOR_API_DATABASE_URL',
  'SOLANA_HTTP_RPC_URL',
  'SOLANA_WS_RPC_URL',
  'LISTENER_HELIUS_ACCOUNTS_PATH',
  'EXECUTOR_KEYPAIR_PATH',
  'HELIUS_API_KEY_PATH',
  'EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH',
  'OPERATOR_API_TOKEN',
  'SOL_RUN_USER',
  'SOL_RUN_UID',
]);

const SECRET_KEY = /PASSWORD|PRIVATE_KEY|SECRET|TOKEN|KEYPAIR|MNEMONIC|RECOVERY_PHRASE/u;
const CREDENTIAL_VALUE = /api[-_]?key=|:\/\/[^/\s@]*:[^/\s@]*@/iu;
const VARIABLE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const SECRET_TEXT = /^[\x21-\x7e]{1,4096}$/u;

/** The one rule for the name of a configuration variable. */
export function isVariableName(value: string): boolean {
  return VARIABLE.test(value);
}

/** Parses a non-secret dotenv file and refuses anything that belongs in a secret file. */
export function parseRoleConfig(text: string, label: string): Readonly<Record<string, string>> {
  const parsed = parse(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (!isVariableName(key)) throw new RoleEnvironmentError(`${label}: invalid variable name`);
    if (INJECTED_KEYS.has(key) || SECRET_KEY.test(key)) {
      throw new RoleEnvironmentError(
        `${label}: ${key} comes from a secret file, not from the configuration`,
      );
    }
    if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
      throw new RoleEnvironmentError(`${label}: ${key} must be a single line`);
    }
    if (CREDENTIAL_VALUE.test(value)) {
      throw new RoleEnvironmentError(`${label}: ${key} looks like a credential`);
    }
  }
  return Object.freeze({ ...parsed });
}

/** A secret file holds one printable line, optionally followed by one newline. */
export function secretText(raw: string, file: string): string {
  const value = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!SECRET_TEXT.test(value)) {
    throw new RoleEnvironmentError(`${file}: expected one printable line without spaces`);
  }
  return value;
}

/** The LOGIN connects with `options=-c role=<group>`, as the canary runbook prescribes. */
export function loginDatabaseUrl(input: Readonly<{
  login: DatabaseLogin;
  password: string;
  databaseName: string;
  searchPath: boolean;
}>): string {
  if (!DATABASE_NAME.test(input.databaseName)) {
    throw new RoleEnvironmentError('POSTGRES_DB must be a plain lower-case database name');
  }
  const role = `-c role=${DATABASE_LOGINS[input.login]}`;
  const options = input.searchPath ? `${role} -c search_path=pg_catalog,public` : role;
  return `postgresql://${input.login}:${encodeURIComponent(input.password)}`
    + `@${DATABASE_HOST}:${DATABASE_PORT}/${input.databaseName}?options=${encodeURIComponent(options)}`;
}

/** An RPC URL secret as boot reads it (one printable line, a URL of this protocol); vault-import applies the same rule. */
export function rpcUrl(raw: string, file: string, protocol: 'https:' | 'wss:'): string {
  const value = secretText(raw, file);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RoleEnvironmentError(`${file}: not a URL`);
  }
  if (url.protocol !== protocol) {
    throw new RoleEnvironmentError(`${file}: expected a ${protocol.slice(0, -1)} URL`);
  }
  return value;
}

export const DEFAULT_HELIUS_RPC_HTTP_URL = 'https://mainnet.helius-rpc.com/';
export const DEFAULT_HELIUS_RPC_WS_URL = 'wss://mainnet.helius-rpc.com/';

/** A Helius address of the configuration (or its default): this protocol, never a key. */
function heliusAddress(
  value: string | undefined,
  fallback: string,
  variable: string,
  protocol: 'https:' | 'wss:',
): string {
  let url: URL;
  try {
    url = new URL(value === undefined || value === '' ? fallback : value);
  } catch {
    throw new RoleEnvironmentError(`${variable}: not a URL`);
  }
  if (url.protocol !== protocol) {
    throw new RoleEnvironmentError(`${variable}: expected a ${protocol.slice(0, -1)} URL`);
  }
  if (url.searchParams.has('api-key') || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new RoleEnvironmentError(`${variable}: must not carry a key`);
  }
  return url.toString();
}

export interface RoleEnvironmentInput {
  readonly role: RoleName;
  readonly mode: StackMode;
  readonly databaseName: string;
  readonly configText: string;
  readonly overrideText: string | null;
  /** Secrets live in `<runDirectory>/<user>/<file>`. */
  readonly runDirectory: string;
  readonly readSecret: (path: string) => string;
  readonly secretExists: (path: string) => boolean;
}

export function buildRoleEnvironment(input: RoleEnvironmentInput): Readonly<Record<string, string>> {
  const role = ROLES[input.role];
  const environment: Record<string, string> = {
    ...parseRoleConfig(input.configText, role.configFile),
    ...(input.overrideText === null
      ? {}
      : parseRoleConfig(input.overrideText, `override ${role.configFile}`)),
  };
  const directory = `${input.runDirectory}/${role.user}`;
  if (role.database !== undefined) {
    const file = loginPasswordFile(role.database.login);
    environment[role.database.variable] = loginDatabaseUrl({
      login: role.database.login,
      password: secretText(input.readSecret(`${directory}/${file}`), file),
      databaseName: input.databaseName,
      searchPath: role.database.searchPath,
    });
  }
  if (role.httpRpc !== undefined) {
    environment.SOLANA_HTTP_RPC_URL = rpcUrl(
      input.readSecret(`${directory}/${role.httpRpc}`), role.httpRpc, 'https:',
    );
  }
  if (role.heliusAccounts !== undefined) {
    const path = `${directory}/${role.heliusAccounts}`;
    let first: string | undefined;
    try {
      first = parseHeliusAccountsFile(input.readSecret(path), role.heliusAccounts)[0]?.apiKey;
    } catch (error) {
      if (error instanceof HeliusAccountsError) throw new RoleEnvironmentError(error.message);
      throw error;
    }
    if (first === undefined) throw new RoleEnvironmentError(`${role.heliusAccounts}: no account`);
    environment.SOLANA_HTTP_RPC_URL = withApiKey(heliusAddress(
      environment.HELIUS_RPC_HTTP_URL, DEFAULT_HELIUS_RPC_HTTP_URL, 'HELIUS_RPC_HTTP_URL', 'https:',
    ), first);
    environment.SOLANA_WS_RPC_URL = withApiKey(heliusAddress(
      environment.HELIUS_RPC_WS_URL, DEFAULT_HELIUS_RPC_WS_URL, 'HELIUS_RPC_WS_URL', 'wss:',
    ), first);
    environment.LISTENER_HELIUS_ACCOUNTS_PATH = path;
  }
  for (const [variable, file] of Object.entries(role.secretPaths ?? {})) {
    const path = `${directory}/${file}`;
    if (!input.secretExists(path)) throw new RoleEnvironmentError(`missing file ${path}`);
    environment[variable] = path;
  }
  for (const [variable, file] of Object.entries(role.secretValues ?? {})) {
    environment[variable] = secretText(input.readSecret(`${directory}/${file}`), file);
  }
  environment.SOL_RUN_USER = role.user;
  environment.SOL_RUN_UID = String(STACK_USERS[role.user]);
  return Object.freeze(environment);
}

/** `export NAME='value'` lines for `eval` in POSIX sh; a single quote is the only special case. */
export function renderShellExports(environment: Readonly<Record<string, string>>): string {
  return Object.keys(environment).sort().map((key) => {
    if (!isVariableName(key)) throw new RoleEnvironmentError('invalid variable name');
    const value = environment[key] ?? '';
    return `export ${key}='${value.replaceAll("'", "'\\''")}'\n`;
  }).join('');
}

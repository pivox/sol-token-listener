/**
 * The Docker Compose stack as data (docs/superpowers/specs/2026-10-09-full-bot-compose-design.md):
 * Unix users of the back container, PostgreSQL logins, secret files and the process roles that
 * `sol-run` launches. Pure: no I/O.
 */

export type StackMode = 'observe' | 'live';

export function isStackMode(value: unknown): value is StackMode {
  return value === 'observe' || value === 'live';
}

/** One Unix user per process family, with fixed UIDs (spec 6.1). */
export const STACK_USERS = Object.freeze({
  listener: 10001,
  h2b: 10002,
  h2a: 10003,
  autoarm: 10004,
  opapi: 10005,
  retention: 10006,
  worker: 10007,
  ops: 10008,
} as const);
export type StackUser = keyof typeof STACK_USERS;
export const STACK_USER_NAMES: readonly StackUser[] = Object.freeze(
  Object.keys(STACK_USERS) as StackUser[],
);

/** Each LOGIN role joins exactly one NOLOGIN group role (spec 6.2 and 9.1). */
export const DATABASE_LOGINS = Object.freeze({
  sol_listener: 'sol_token_listener_writer',
  sol_live: 'sol_token_executor_live',
  sol_recovery: 'sol_token_executor_live_recovery',
  sol_autoarm: 'sol_token_executor_operations',
  sol_reader: 'sol_token_operator_reader',
  sol_retention: 'sol_token_retention_worker',
  sol_worker: 'sol_token_executor_worker',
  sol_ops: 'sol_token_executor_operations',
  sol_readiness: 'sol_token_executor_readiness',
} as const);
export type DatabaseLogin = keyof typeof DATABASE_LOGINS;
export const DATABASE_LOGIN_NAMES: readonly DatabaseLogin[] = Object.freeze(
  Object.keys(DATABASE_LOGINS) as DatabaseLogin[],
);

/** The administrator keeps its production name, so table ownership survives the restore (9.1). */
export const DATABASE_ADMIN = 'sol_owner';
export const DATABASE_HOST = 'postgres';
export const DATABASE_PORT = 5432;

export function loginPasswordFile(login: DatabaseLogin): string {
  return `pg-${login}-password`;
}

/** Secret files of the back container, besides the login passwords (spec 7.1). */
export type BackSecret =
  | 'helius-listener-http-url'
  | 'helius-listener-ws-url'
  | 'helius-executor-http-url'
  | 'helius-admin-api-key'
  | 'evidence-private-key'
  | 'wallet-keypair.json'
  | 'operator-api-token';

export type RoleName =
  | 'listener'
  | 'h2b'
  | 'h2a'
  | 'autoarm'
  | 'opapi'
  | 'retention'
  | 'worker'
  | 'operations'
  | 'readiness'
  | 'evidence-provider'
  | 'evidence-bundle';

export interface RoleDatabase {
  readonly login: DatabaseLogin;
  readonly variable: 'DATABASE_URL' | 'OPERATOR_API_DATABASE_URL';
  /** The simulation worker also pins `search_path` on its connections. */
  readonly searchPath: boolean;
}

export interface RoleDefinition {
  readonly user: StackUser;
  /** Non-secret configuration: `<config directory>/<configFile>`. */
  readonly configFile: string;
  readonly database?: RoleDatabase;
  /** `SOLANA_HTTP_RPC_URL`. `by-mode`: listener project in observe, executor project in live. */
  readonly httpRpc?: BackSecret | 'by-mode';
  /** `SOLANA_WS_RPC_URL`. */
  readonly wsRpc?: BackSecret;
  /** Variables set to the tmpfs path of a secret file, which the process reads itself. */
  readonly secretPaths?: Readonly<Record<string, BackSecret>>;
  /** Variables set to the content of a secret file. */
  readonly secretValues?: Readonly<Record<string, BackSecret>>;
}

const EXECUTOR_RPC: BackSecret = 'helius-executor-http-url';

function loginDatabase(login: DatabaseLogin, searchPath = false): RoleDatabase {
  return { login, variable: 'DATABASE_URL', searchPath };
}

const ROLE_TABLE: Record<RoleName, RoleDefinition> = {
  listener: {
    user: 'listener', configFile: 'listener.env', database: loginDatabase('sol_listener'),
    httpRpc: 'helius-listener-http-url', wsRpc: 'helius-listener-ws-url',
  },
  h2b: {
    user: 'h2b', configFile: 'live.env', database: loginDatabase('sol_live'), httpRpc: EXECUTOR_RPC,
    secretPaths: { EXECUTOR_KEYPAIR_PATH: 'wallet-keypair.json' },
  },
  h2a: {
    user: 'h2a', configFile: 'live-recovery.env', database: loginDatabase('sol_recovery'),
    httpRpc: EXECUTOR_RPC,
  },
  autoarm: {
    user: 'autoarm', configFile: 'operations.env', database: loginDatabase('sol_autoarm'),
    httpRpc: EXECUTOR_RPC,
  },
  opapi: {
    user: 'opapi', configFile: 'operator-api.env',
    database: { login: 'sol_reader', variable: 'OPERATOR_API_DATABASE_URL', searchPath: false },
    httpRpc: 'by-mode',
    secretValues: { OPERATOR_API_TOKEN: 'operator-api-token' },
  },
  retention: {
    user: 'retention', configFile: 'retention.env', database: loginDatabase('sol_retention'),
  },
  worker: {
    user: 'worker', configFile: 'worker-sim.env', database: loginDatabase('sol_worker', true),
    httpRpc: EXECUTOR_RPC,
  },
  // The operations CLI gets no RPC variable (docs/operations/executor-live-canary.md boundaries).
  operations: {
    user: 'ops', configFile: 'operations.env', database: loginDatabase('sol_ops'),
  },
  readiness: {
    user: 'ops', configFile: 'readiness.env', database: loginDatabase('sol_readiness'),
    httpRpc: EXECUTOR_RPC,
  },
  'evidence-provider': {
    user: 'ops', configFile: 'provider-evidence.env',
    secretPaths: {
      HELIUS_API_KEY_PATH: 'helius-admin-api-key',
      EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH: 'evidence-private-key',
    },
  },
  'evidence-bundle': {
    user: 'ops', configFile: 'preflight-bundle.env',
    secretPaths: { EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH: 'evidence-private-key' },
  },
};

export const ROLES: Readonly<Record<RoleName, RoleDefinition>> = Object.freeze(ROLE_TABLE);
export const ROLE_NAMES: readonly RoleName[] = Object.freeze(Object.keys(ROLE_TABLE) as RoleName[]);

export function isRoleName(value: string): value is RoleName {
  return Object.hasOwn(ROLE_TABLE, value);
}

/** Roles supervisord starts in each mode; their secrets are mandatory (spec 6.2, amended). */
export const REQUIRED_ROLES: Readonly<Record<StackMode, readonly RoleName[]>> = Object.freeze({
  observe: Object.freeze<RoleName[]>(['listener', 'opapi', 'retention']),
  live: Object.freeze<RoleName[]>([
    'listener', 'opapi', 'retention', 'h2a', 'h2b', 'autoarm', 'operations',
  ]),
});

export function resolveHttpRpc(role: RoleDefinition, mode: StackMode): BackSecret | undefined {
  if (role.httpRpc !== 'by-mode') return role.httpRpc;
  return mode === 'live' ? EXECUTOR_RPC : 'helius-listener-http-url';
}

export type SecretSource = 'logins' | 'back';

export interface RoleSecretFile {
  readonly source: SecretSource;
  readonly file: string;
}

/** The secret files a role reads in a mode, relative to `/root/secrets/<source>/`. */
export function roleSecretFiles(role: RoleDefinition, mode: StackMode): readonly RoleSecretFile[] {
  const files: RoleSecretFile[] = [];
  if (role.database !== undefined) {
    files.push({ source: 'logins', file: loginPasswordFile(role.database.login) });
  }
  const httpRpc = resolveHttpRpc(role, mode);
  if (httpRpc !== undefined) files.push({ source: 'back', file: httpRpc });
  if (role.wsRpc !== undefined) files.push({ source: 'back', file: role.wsRpc });
  for (const file of Object.values(role.secretPaths ?? {})) files.push({ source: 'back', file });
  for (const file of Object.values(role.secretValues ?? {})) files.push({ source: 'back', file });
  return Object.freeze(files);
}

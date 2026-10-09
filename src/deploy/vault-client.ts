/**
 * Minimal client of the Vault HTTP API for the stack's scripts
 * (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 7 and 8). No dependency. An error
 * message names the method, the path and the HTTP status, never a body or a value.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { VAULT_MOUNT } from './vault-layout.js';

/** The `fetch` of the platform, or a stand-in of the tests. */
export type VaultFetch = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const INITIALIZE_TIMEOUT_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 120_000;
/** How long `unseal` waits for the node to become active. */
const ACTIVE_WAIT_MS = 60_000;
/** The longest delay Node's timers honour (`AbortSignal.timeout`, `setTimeout`): 2^31 − 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** One segment of a path: lower case, digits, `_` and `-`, plus `.` after the first character. */
const PATH_SEGMENT = /^[a-z0-9_-][a-z0-9._-]*$/u;

/**
 * Unreachable, sealed (503), uninitialized (501), standby (429, 500), redirected (3xx),
 * rate-limited or failing: try again later.
 */
export class VaultUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'VaultUnavailableError';
  }
}

/** Credentials or policy refused: 400, 401 or 403, or a login answered 2xx without a token. */
export class VaultDeniedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'VaultDeniedError';
  }
}

/** Nothing at this path: 404. */
export class VaultMissingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'VaultMissingError';
  }
}

export interface AppRoleCredentials {
  readonly role_id: string;
  readonly secret_id: string;
}

/** The content of an AppRole file (`secrets/vault/approle/<name>.json`). */
export function parseAppRoleCredentials(text: string): AppRoleCredentials {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError('expected an AppRole JSON object');
  }
  const roleId = field(value, 'role_id');
  const secretId = field(value, 'secret_id');
  if (typeof roleId !== 'string' || typeof secretId !== 'string' || roleId === '' || secretId === '') {
    throw new TypeError('expected an AppRole JSON object');
  }
  return Object.freeze({ role_id: roleId, secret_id: secretId });
}

export interface VaultClientOptions {
  readonly address: string;
  readonly fetch?: VaultFetch | undefined;
  /** For one request, 10 s by default. A positive integer. */
  readonly timeoutMs?: number;
  /** Between two `sys/health` polls of `unseal`, 100 ms by default. A positive integer. */
  readonly pollIntervalMs?: number;
}

interface RequestOptions {
  readonly token?: string;
  readonly body?: unknown;
  /** Replaces the client's timeout for this request. */
  readonly timeoutMs?: number;
}

export class VaultClient {
  private readonly address: string;
  private readonly fetchImpl: VaultFetch;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  public constructor(options: VaultClientOptions) {
    this.address = options.address.replace(/\/+$/u, '');
    this.fetchImpl = options.fetch ?? (async (url, init): Promise<Response> => fetch(url, init));
    this.timeoutMs = positiveInteger('timeoutMs', options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.pollIntervalMs = positiveInteger('pollIntervalMs', options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  public async sealStatus(): Promise<Readonly<{ initialized: boolean; sealed: boolean }>> {
    const body = await this.json('GET', 'sys/seal-status');
    const initialized = field(body, 'initialized');
    const sealed = field(body, 'sealed');
    // Anything but two booleans must not read as "not initialized": a guard would then open.
    if (typeof initialized !== 'boolean' || typeof sealed !== 'boolean') {
      throw new VaultUnavailableError('vault GET sys/seal-status: unexpected answer');
    }
    return Object.freeze({ initialized, sealed });
  }

  /** One key share (spec 5): the unseal key and the root token. */
  public async initialize(): Promise<Readonly<{ unsealKey: string; rootToken: string }>> {
    // 60 s: the first raft leader election takes 5 to 10 s, and an abort after Vault initialized loses both keys.
    const body = await this.json('PUT', 'sys/init', {
      body: { secret_shares: 1, secret_threshold: 1 },
      timeoutMs: INITIALIZE_TIMEOUT_MS,
    });
    const keys = field(body, 'keys_base64');
    const unsealKey: unknown = Array.isArray(keys) ? keys[0] : undefined;
    const rootToken = field(body, 'root_token');
    if (typeof unsealKey !== 'string' || typeof rootToken !== 'string') {
      throw new VaultUnavailableError('vault PUT sys/init: unexpected answer');
    }
    return Object.freeze({ unsealKey, rootToken });
  }

  /**
   * Unseals, then returns once the node is active: right after the unseal it is briefly standby,
   * and the next call would get a 500 ("local node not active").
   */
  public async unseal(key: string): Promise<void> {
    const body = await this.json('PUT', 'sys/unseal', { body: { key } });
    if (field(body, 'sealed') !== false) throw new VaultUnavailableError('vault PUT sys/unseal: still sealed');
    const deadline = Date.now() + ACTIVE_WAIT_MS;
    while (!(await this.isActive())) {
      if (Date.now() >= deadline) throw new VaultUnavailableError('vault GET sys/health: not active');
      await delay(this.pollIntervalMs);
    }
  }

  public async appRoleLogin(credentials: AppRoleCredentials): Promise<string> {
    return this.login('auth/approle/login', { role_id: credentials.role_id, secret_id: credentials.secret_id });
  }

  public async userpassLogin(username: string, password: string): Promise<string> {
    return this.login(`auth/userpass/login/${encodeURIComponent(username)}`, { password });
  }

  public async readKv(token: string, path: string): Promise<Readonly<Record<string, unknown>>> {
    const answer = await this.json('GET', `${VAULT_MOUNT}/data/${path}`, { token });
    const data = field(field(answer, 'data'), 'data');
    if (!isRecord(data)) throw new VaultUnavailableError(`vault GET ${VAULT_MOUNT}/data/${path}: unexpected answer`);
    return data;
  }

  public async writeKv(token: string, path: string, data: Readonly<Record<string, string>>): Promise<void> {
    await this.json('POST', `${VAULT_MOUNT}/data/${path}`, { token, body: { data } });
  }

  public async revokeSelf(token: string): Promise<void> {
    await this.json('POST', 'auth/token/revoke-self', { token });
  }

  public async enableKv2(token: string, path: string): Promise<void> {
    await this.json('POST', `sys/mounts/${path}`, { token, body: { type: 'kv', options: { version: '2' } } });
  }

  public async enableAuth(token: string, type: 'approle' | 'userpass'): Promise<void> {
    await this.json('POST', `sys/auth/${type}`, { token, body: { type } });
  }

  /**
   * A `file` audit device writing to the server's stdout, so every authenticated request and its
   * answer reach the container log (spec 1 and 3). String values are HMAC'd; numbers and booleans
   * in answers are logged as is, which is why every entry holds strings only.
   */
  public async enableStdoutAudit(token: string): Promise<void> {
    await this.json('PUT', 'sys/audit/file', { token, body: { type: 'file', options: { file_path: 'stdout' } } });
  }

  public async putPolicy(token: string, name: string, policy: string): Promise<void> {
    await this.json('PUT', `sys/policies/acl/${name}`, { token, body: { policy } });
  }

  /** An AppRole whose 5-minute token carries the policy of the same name (spec 6.3). */
  public async createAppRole(token: string, name: string): Promise<AppRoleCredentials> {
    await this.json('POST', `auth/approle/role/${name}`, {
      token,
      body: {
        token_policies: [name], token_ttl: '5m', token_max_ttl: '5m',
        secret_id_ttl: '0', secret_id_num_uses: 0,
      },
    });
    const roleId = await this.dataString('GET', `auth/approle/role/${name}/role-id`, token, 'role_id');
    const secretId = await this.dataString('POST', `auth/approle/role/${name}/secret-id`, token, 'secret_id');
    return Object.freeze({ role_id: roleId, secret_id: secretId });
  }

  /** A userpass login whose token lives one hour, renewable up to eight (plan deviation 6). */
  public async createUser(token: string, username: string, password: string, policy: string): Promise<void> {
    await this.json('POST', `auth/userpass/users/${encodeURIComponent(username)}`, {
      token, body: { password, token_policies: [policy], token_ttl: '1h', token_max_ttl: '8h' },
    });
  }

  /** The raft snapshot (gzip), as a stream. 120 s: the timeout also bounds the reading of the body. */
  public async snapshot(token: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.send('GET', 'sys/storage/raft/snapshot', { token, timeoutMs: SNAPSHOT_TIMEOUT_MS });
    if (response.body === null) throw new VaultUnavailableError('vault GET sys/storage/raft/snapshot: empty answer');
    return response.body;
  }

  /** Only the active node answers `sys/health` 200: a standby (429), sealed (503) or uninitialized (501) one is an error. */
  private async isActive(): Promise<boolean> {
    try {
      await this.json('GET', 'sys/health');
      return true;
    } catch (error) {
      if (error instanceof VaultUnavailableError) return false;
      throw error;
    }
  }

  private async login(path: string, body: unknown): Promise<string> {
    const token = field(field(await this.json('POST', path, { body }), 'auth'), 'client_token');
    if (typeof token !== 'string' || token === '') throw new VaultDeniedError(`vault POST ${path}: no token`);
    return token;
  }

  /** `data.<key>` of an answer, which must be a string. */
  private async dataString(method: string, path: string, token: string, key: string): Promise<string> {
    const value = field(field(await this.json(method, path, { token }), 'data'), key);
    if (typeof value !== 'string') throw new VaultUnavailableError(`vault ${method} ${path}: unexpected answer`);
    return value;
  }

  private async json(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const response = await this.send(method, path, options);
    let text: string;
    try {
      text = await response.text();
    } catch {
      // A reset, an abort or the timeout while the body is read: a failed request, and the
      // platform error stays out of the message.
      throw new VaultUnavailableError(`vault ${method} ${path}: unreachable`);
    }
    if (text === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new VaultUnavailableError(`vault ${method} ${path}: unreadable answer`);
    }
  }

  private async send(method: string, path: string, options: RequestOptions): Promise<Response> {
    // The scripts pass constants: a segment outside the alphabet is a programming error.
    if (!path.split('/').every((segment) => PATH_SEGMENT.test(segment))) throw new TypeError('invalid Vault path');
    const headers: Record<string, string> = {};
    if (options.token !== undefined) headers['X-Vault-Token'] = options.token;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.address}/v1/${path}`, {
        method,
        headers,
        body: options.body === undefined ? null : JSON.stringify(options.body),
        // A redirect is never followed: the token would travel to its target.
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      });
    } catch {
      throw new VaultUnavailableError(`vault ${method} ${path}: unreachable`);
    }
    if (response.ok) return response;
    await response.text().catch(() => '');
    const label = `vault ${method} ${path}: HTTP ${String(response.status)}`;
    if (response.status === 404) throw new VaultMissingError(label);
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new VaultDeniedError(label);
    }
    throw new VaultUnavailableError(label);
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new TypeError(`${name} must be an integer from 1 to ${String(MAX_TIMER_MS)}`);
  }
  return value;
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

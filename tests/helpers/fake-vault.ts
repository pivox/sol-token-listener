import type { AppRoleCredentials, VaultFetch } from '../../src/deploy/vault-client.js';

interface TokenGrant {
  readonly kind: 'root' | 'approle' | 'operator';
  /** The policy the token carries: `root`, the one of its AppRole or the one of its user. */
  readonly policy: string;
  revoked: boolean;
}

/** Read prefixes under `sol/data/` per policy, as in deploy/vault/policies (spec 6.2). */
const READABLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  back: ['config/', 'secrets/back/', 'secrets/logins/'],
  migrate: ['secrets/logins/'],
  backup: [],
});

/**
 * The Vault HTTP API endpoints the stack's scripts call, in memory, with the status codes measured
 * on Vault 2.1.2. AppRole tokens read the prefixes of the policy their role was created with; only
 * root and operator tokens write; only root administers; the snapshot is root's or the `backup`
 * policy's. A mount or an auth method that is not enabled does not answer, and `sys/init` hands out
 * a Vault where none is, with no audit device either: a test starts from a configured Vault (`sol`,
 * `approle` and `userpass` enabled, no audit device) unless it initializes it. An audit device is
 * enabled by root, once per name. Root turns off the user lockout of an enabled auth mount;
 * `lockoutDisabled` records it, and the logins do not model the lockout itself.
 */
export class FakeVault {
  public initialized = true;
  public sealed = false;
  public unreachable = false;
  /** After an unseal, this many requests find the node standby: health 429, the others 500. */
  public standbyRequestsAfterUnseal = 0;
  public readonly kv = new Map<string, Record<string, unknown>>();
  public readonly policies = new Map<string, string>();
  public readonly mounts = new Set<string>(['sol']);
  public readonly auths = new Set<string>(['approle', 'userpass']);
  /** The auth mounts whose user lockout root turned off (`sys/auth/<mount>/tune`). */
  public readonly lockoutDisabled = new Set<string>();
  public readonly audits = new Set<string>();
  public readonly appRoles = new Map<string, AppRoleCredentials>();
  public readonly users = new Map<string, Readonly<{ password: string; policy: string }>>();
  public readonly requests: string[] = [];
  public readonly unsealKey = 'fake-unseal-key-0123456789';
  public readonly rootToken = 'fake-root-token-0123456789';
  public snapshotBytes = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0x2a]);
  private readonly tokens = new Map<string, TokenGrant>();
  private readonly rolePolicies = new Map<string, string>();
  private standbyRemaining = 0;
  private issued = 0;

  public constructor() {
    this.tokens.set(this.rootToken, { kind: 'root', policy: 'root', revoked: false });
  }

  public readonly fetch: VaultFetch = async (url, init) => {
    if (this.unreachable) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname.replace(/^\/v1\//u, '');
    this.requests.push(`${method} ${path}`);
    const token = new Headers(init.headers).get('X-Vault-Token');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    return this.route(method, path, token, body);
  };

  /** Adds an AppRole whose tokens carry `policy`: the policy of the same name unless told otherwise. */
  public addAppRole(name: string, policy = name): AppRoleCredentials {
    const credentials = Object.freeze({ role_id: `role-id-${name}`, secret_id: `secret-id-${name}-0123456789` });
    this.appRoles.set(name, credentials);
    this.rolePolicies.set(name, policy);
    return credentials;
  }

  public isRevoked(token: string): boolean {
    return this.tokens.get(token)?.revoked === true;
  }

  public issuedTokens(): readonly string[] {
    return [...this.tokens.keys()].filter((token) => token !== this.rootToken);
  }

  private route(method: string, path: string, token: string | null, body: Record<string, unknown>): Response {
    if (path === 'sys/seal-status') return json(200, { initialized: this.initialized, sealed: this.sealed });
    if (method === 'GET' && path === 'sys/health') return this.health();
    if (method === 'PUT' && path === 'sys/init') return this.initialize();
    if (method === 'PUT' && path === 'sys/unseal') return this.unseal(body);
    // An uninitialized Vault is sealed too.
    if (!this.initialized || this.sealed) return json(503, { errors: ['Vault is sealed'] });
    if (this.consumeStandby()) {
      return json(500, { errors: ['local node not active but active cluster node not found'] });
    }
    if (method === 'POST' && path === 'auth/approle/login') return this.appRoleLogin(body);
    const userLogin = /^auth\/userpass\/login\/(.+)$/u.exec(path);
    if (method === 'POST' && userLogin !== null) {
      return this.userpassLogin(decodeURIComponent(userLogin[1] ?? ''), body);
    }
    const grant = token === null ? undefined : this.tokens.get(token);
    if (grant === undefined || grant.revoked) return json(403, { errors: ['permission denied'] });
    if (method === 'POST' && path === 'auth/token/revoke-self') {
      grant.revoked = true;
      return new Response(null, { status: 204 });
    }
    const kv = /^sol\/data\/(.+)$/u.exec(path);
    if (kv !== null) return this.kvRoute(method, kv[1] ?? '', grant, body);
    if (path === 'sys/storage/raft/snapshot') {
      return grant.kind === 'root' || (grant.kind === 'approle' && grant.policy === 'backup')
        ? new Response(this.snapshotBytes, { status: 200 })
        : json(403, { errors: ['permission denied'] });
    }
    if (grant.kind !== 'root') return json(403, { errors: ['permission denied'] });
    return this.adminRoute(method, path, body);
  }

  /** 501 uninitialized, 503 sealed, 429 standby, 200 active. */
  private health(): Response {
    if (!this.initialized) return json(501, { initialized: false, sealed: true, standby: false });
    if (this.sealed) return json(503, { initialized: true, sealed: true, standby: false });
    const standby = this.consumeStandby();
    return json(standby ? 429 : 200, { initialized: true, sealed: false, standby });
  }

  /** Takes one request of the standby window that follows an unseal; false once it is over. */
  private consumeStandby(): boolean {
    if (this.standbyRemaining === 0) return false;
    this.standbyRemaining -= 1;
    return true;
  }

  private initialize(): Response {
    if (this.initialized) return json(400, { errors: ['Vault is already initialized'] });
    this.initialized = true;
    this.sealed = true;
    this.standbyRemaining = 0;
    // A fresh Vault has no mount, no auth method, no audit device, no policy, no AppRole, no entry and no user.
    this.mounts.clear();
    this.auths.clear();
    this.lockoutDisabled.clear();
    this.audits.clear();
    this.policies.clear();
    this.appRoles.clear();
    this.rolePolicies.clear();
    this.kv.clear();
    this.users.clear();
    return json(200, { keys: ['00'], keys_base64: [this.unsealKey], root_token: this.rootToken });
  }

  private unseal(body: Record<string, unknown>): Response {
    if (!this.initialized) return json(400, { errors: ['Vault is not initialized'] });
    if (body.key !== this.unsealKey) return json(400, { errors: ['invalid key'] });
    if (this.sealed) this.standbyRemaining = this.standbyRequestsAfterUnseal;
    this.sealed = false;
    return json(200, { sealed: false });
  }

  private appRoleLogin(body: Record<string, unknown>): Response {
    if (!this.auths.has('approle')) return json(403, { errors: ['permission denied'] });
    const name = [...this.appRoles.entries()]
      .find(([, credentials]) => credentials.role_id === body.role_id && credentials.secret_id === body.secret_id)?.[0];
    return name === undefined
      ? json(400, { errors: ['invalid role or secret ID'] })
      : this.issue('approle', this.rolePolicies.get(name) ?? name);
  }

  private userpassLogin(username: string, body: Record<string, unknown>): Response {
    if (!this.auths.has('userpass')) return json(403, { errors: ['permission denied'] });
    const user = this.users.get(username);
    return user === undefined || user.password !== body.password
      ? json(400, { errors: ['invalid username or password'] })
      : this.issue('operator', user.policy);
  }

  private kvRoute(method: string, path: string, grant: TokenGrant, body: Record<string, unknown>): Response {
    // The policy is checked first, the mount after: a token without rights gets 403 even where nothing is mounted.
    const allowed = method === 'GET'
      ? grant.kind !== 'approle' || (READABLE[grant.policy] ?? []).some((prefix) => path.startsWith(prefix))
      : method === 'POST' && grant.kind !== 'approle';
    if (!allowed) return json(403, { errors: ['permission denied'] });
    if (!this.mounts.has('sol')) return json(404, { errors: [] });
    if (method === 'POST') {
      this.kv.set(path, { ...(body.data as Record<string, unknown>) });
      return json(200, { data: { version: 1 } });
    }
    const data = this.kv.get(path);
    return data === undefined ? json(404, { errors: [] }) : json(200, { data: { data, metadata: { version: 1 } } });
  }

  private adminRoute(method: string, path: string, body: Record<string, unknown>): Response {
    const mount = /^sys\/mounts\/(.+)$/u.exec(path);
    if (method === 'POST' && mount !== null) {
      this.mounts.add(mount[1] ?? '');
      return new Response(null, { status: 204 });
    }
    const tune = /^sys\/auth\/([^/]+)\/tune$/u.exec(path);
    if (method === 'POST' && tune !== null) {
      const name = tune[1] ?? '';
      if (!this.auths.has(name)) return json(400, { errors: [`tune of path "auth/${name}/" failed: no mount entry found`] });
      // Vault also answers 204 to a field it does not know, and changes nothing.
      const lockout = body.user_lockout_config as Record<string, unknown> | null | undefined;
      if (lockout?.lockout_disable === true) this.lockoutDisabled.add(name);
      return new Response(null, { status: 204 });
    }
    const auth = /^sys\/auth\/(.+)$/u.exec(path);
    if (method === 'POST' && auth !== null) {
      this.auths.add(auth[1] ?? '');
      return new Response(null, { status: 204 });
    }
    const audit = /^sys\/audit\/(.+)$/u.exec(path);
    if (method === 'PUT' && audit !== null) {
      const name = audit[1] ?? '';
      if (this.audits.has(name)) return json(400, { errors: ['path already in use: invalid configuration'] });
      this.audits.add(name);
      return new Response(null, { status: 204 });
    }
    const policy = /^sys\/policies\/acl\/(.+)$/u.exec(path);
    if (method === 'PUT' && policy !== null) {
      this.policies.set(policy[1] ?? '', String(body.policy));
      return new Response(null, { status: 204 });
    }
    const role = /^auth\/approle\/role\/([^/]+)(?:\/(role-id|secret-id))?$/u.exec(path);
    if (role !== null) return this.roleRoute(method, role[1] ?? '', role[2], body);
    const user = /^auth\/userpass\/users\/(.+)$/u.exec(path);
    if (method === 'POST' && user !== null) {
      if (!this.auths.has('userpass')) return json(404, { errors: [] });
      const policies = body.token_policies;
      this.users.set(decodeURIComponent(user[1] ?? ''), Object.freeze({
        password: String(body.password),
        policy: Array.isArray(policies) ? String(policies[0]) : '',
      }));
      return new Response(null, { status: 204 });
    }
    return json(404, { errors: [] });
  }

  /** `auth/approle/role/<name>` (POST creates), then `/role-id` (GET only) and `/secret-id` (POST only). */
  private roleRoute(method: string, name: string, suffix: string | undefined, body: Record<string, unknown>): Response {
    if (!this.auths.has('approle')) return json(404, { errors: [] });
    if (suffix === undefined) {
      if (method !== 'POST') return json(404, { errors: [] });
      const policies = body.token_policies;
      this.addAppRole(name, Array.isArray(policies) ? String(policies[0]) : 'default');
      return new Response(null, { status: 204 });
    }
    const credentials = this.appRoles.get(name);
    if (credentials === undefined) return json(404, { errors: [] });
    if (suffix === 'role-id') {
      return method === 'GET'
        ? json(200, { data: { role_id: credentials.role_id } })
        : json(400, { errors: ['missing role_id'] });
    }
    return method === 'POST'
      ? json(200, { data: { secret_id: credentials.secret_id } })
      : json(405, { errors: ['unsupported operation'] });
  }

  private issue(kind: 'approle' | 'operator', policy: string): Response {
    this.issued += 1;
    const token = `fake-token-${String(this.issued)}`;
    this.tokens.set(token, { kind, policy, revoked: false });
    return json(200, { auth: { client_token: token, lease_duration: 300 } });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

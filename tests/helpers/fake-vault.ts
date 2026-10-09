import type { AppRoleCredentials, VaultFetch } from '../../src/deploy/vault-client.js';

interface TokenGrant {
  readonly kind: 'root' | 'approle' | 'operator';
  readonly name: string;
  revoked: boolean;
}

/** Read prefixes under `sol/data/` per AppRole, as in deploy/vault/policies (spec 6.2). */
const READABLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  back: ['config/', 'secrets/back/', 'secrets/logins/'],
  migrate: ['secrets/logins/'],
  backup: [],
});

/**
 * The Vault HTTP API endpoints the stack's scripts call, in memory. AppRole tokens read the
 * prefixes of their policy; only root and operator tokens write; only root administers; the
 * snapshot is root's or backup's.
 */
export class FakeVault {
  public initialized = true;
  public sealed = false;
  public unreachable = false;
  public readonly kv = new Map<string, Record<string, unknown>>();
  public readonly policies = new Map<string, string>();
  public readonly mounts = new Set<string>();
  public readonly auths = new Set<string>();
  public readonly appRoles = new Map<string, AppRoleCredentials>();
  public readonly users = new Map<string, Readonly<{ password: string; policy: string }>>();
  public readonly requests: string[] = [];
  public readonly unsealKey = 'fake-unseal-key-0123456789';
  public readonly rootToken = 'fake-root-token-0123456789';
  public snapshotBytes = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0x2a]);
  private readonly tokens = new Map<string, TokenGrant>();
  private issued = 0;

  public constructor() {
    this.tokens.set(this.rootToken, { kind: 'root', name: 'root', revoked: false });
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

  /** Adds an AppRole whose tokens read like the policy of the same name. */
  public addAppRole(name: string): AppRoleCredentials {
    const credentials = Object.freeze({ role_id: `role-id-${name}`, secret_id: `secret-id-${name}-0123456789` });
    this.appRoles.set(name, credentials);
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
    if (method === 'PUT' && path === 'sys/init') {
      if (this.initialized) return json(400, { errors: ['Vault is already initialized'] });
      this.initialized = true;
      this.sealed = true;
      return json(200, { keys: ['00'], keys_base64: [this.unsealKey], root_token: this.rootToken });
    }
    if (!this.initialized) return json(501, { errors: [] });
    if (method === 'PUT' && path === 'sys/unseal') {
      if (body.key !== this.unsealKey) return json(400, { errors: ['invalid key'] });
      this.sealed = false;
      return json(200, { sealed: false });
    }
    if (this.sealed) return json(503, { errors: ['Vault is sealed'] });
    if (method === 'POST' && path === 'auth/approle/login') {
      const name = [...this.appRoles.entries()]
        .find(([, credentials]) => credentials.role_id === body.role_id && credentials.secret_id === body.secret_id)?.[0];
      return name === undefined ? json(400, { errors: ['invalid role or secret ID'] }) : this.issue('approle', name);
    }
    const userLogin = /^auth\/userpass\/login\/(.+)$/u.exec(path);
    if (method === 'POST' && userLogin !== null) {
      const user = this.users.get(decodeURIComponent(userLogin[1] ?? ''));
      return user === undefined || user.password !== body.password
        ? json(400, { errors: ['invalid username or password'] })
        : this.issue('operator', user.policy);
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
      return grant.kind === 'root' || (grant.kind === 'approle' && grant.name === 'backup')
        ? new Response(this.snapshotBytes, { status: 200 })
        : json(403, { errors: ['permission denied'] });
    }
    if (grant.kind !== 'root') return json(403, { errors: ['permission denied'] });
    return this.adminRoute(method, path, body);
  }

  private kvRoute(method: string, path: string, grant: TokenGrant, body: Record<string, unknown>): Response {
    if (method === 'GET') {
      const readable = grant.kind !== 'approle'
        || (READABLE[grant.name] ?? []).some((prefix) => path.startsWith(prefix));
      if (!readable) return json(403, { errors: ['permission denied'] });
      const data = this.kv.get(path);
      return data === undefined ? json(404, { errors: [] }) : json(200, { data: { data, metadata: { version: 1 } } });
    }
    if (method === 'POST' && grant.kind !== 'approle') {
      this.kv.set(path, { ...(body.data as Record<string, unknown>) });
      return json(200, { data: { version: 1 } });
    }
    return json(403, { errors: ['permission denied'] });
  }

  private adminRoute(method: string, path: string, body: Record<string, unknown>): Response {
    const mount = /^sys\/mounts\/(.+)$/u.exec(path);
    if (method === 'POST' && mount !== null) {
      this.mounts.add(mount[1] ?? '');
      return new Response(null, { status: 204 });
    }
    const auth = /^sys\/auth\/(.+)$/u.exec(path);
    if (method === 'POST' && auth !== null) {
      this.auths.add(auth[1] ?? '');
      return new Response(null, { status: 204 });
    }
    const policy = /^sys\/policies\/acl\/(.+)$/u.exec(path);
    if (method === 'PUT' && policy !== null) {
      this.policies.set(policy[1] ?? '', String(body.policy));
      return new Response(null, { status: 204 });
    }
    const role = /^auth\/approle\/role\/([^/]+)(?:\/(role-id|secret-id))?$/u.exec(path);
    if (role !== null) {
      const name = role[1] ?? '';
      if (role[2] === undefined && method === 'POST') {
        this.addAppRole(name);
        return new Response(null, { status: 204 });
      }
      const credentials = this.appRoles.get(name);
      if (credentials === undefined) return json(404, { errors: [] });
      return role[2] === 'role-id'
        ? json(200, { data: { role_id: credentials.role_id } })
        : json(200, { data: { secret_id: credentials.secret_id } });
    }
    const user = /^auth\/userpass\/users\/(.+)$/u.exec(path);
    if (method === 'POST' && user !== null) {
      const policies = body.token_policies;
      this.users.set(decodeURIComponent(user[1] ?? ''), Object.freeze({
        password: String(body.password),
        policy: Array.isArray(policies) ? String(policies[0]) : '',
      }));
      return new Response(null, { status: 204 });
    }
    return json(404, { errors: [] });
  }

  private issue(kind: 'approle' | 'operator', name: string): Response {
    this.issued += 1;
    const token = `fake-token-${String(this.issued)}`;
    this.tokens.set(token, { kind, name, revoked: false });
    return json(200, { auth: { client_token: token, lease_duration: 300 } });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

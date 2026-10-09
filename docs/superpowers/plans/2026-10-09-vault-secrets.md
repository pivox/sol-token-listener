# Secrets and configuration under Vault — implementation plan (sub-project 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every variable of the back processes into a Vault container of the compose stack. That covers each role's non-secret configuration and its secrets. `back` and `migrate` read them at boot into tmpfs at today's paths, so the rest of the stack does not change.

**Architecture:**
- **Vault service:** a `vault` service built from the pinned `hashicorp/vault` image. It uses raft storage on a `vault-data` volume and unseals itself from a host key file. Its UI is published on `127.0.0.1` only.
- **Client and CLIs:** all calls to Vault go through a small Node client of its HTTP API (`src/deploy/vault-client.ts`). Four CLIs in the back image use it:
  - `vault-pull` runs at boot of back and migrate;
  - `vault-setup` runs once;
  - `vault-import` imports today's role files;
  - `vault-snapshot` runs for the backups.
- **Tool services:** `vault-setup`, `vault-import` and `vault-snapshot` run as one-shot compose services under profile `tools`, so Vault never leaves the internal network.
- **Host files:** only bootstrap secrets stay on the host: the unseal key, the AppRole files, the PostgreSQL admin password and the front hash.

**Tech Stack:** TypeScript (Node 22, tsx, node:test), POSIX sh and bash, HashiCorp Vault 2.1.2 (KV v2, AppRole, userpass, integrated storage), Docker Compose v2 (profiles, long-syntax binds).

**Spec:** `docs/superpowers/specs/2026-10-09-vault-secrets-design.md`. Task 1 records in it where this plan departs from it.

---

## Deviations from the validated spec (Task 1 records them in the spec, section 13)

1. **The vault files on the host sit in two directories:** `secrets/vault/unseal/unseal-key` and `secrets/vault/approle/<name>.json`.
   - The unseal key does not exist at Vault's first start, before `vault-init`. A bind mount of a missing file makes Docker create a directory in its place, so `vault` mounts the `unseal/` directory instead.
   - `back` and `migrate` mount their AppRole file with the long bind syntax, which fails on a missing file instead of creating a directory.
2. **Three one-shot tool services under profile `tools`:** `vault-setup`, `vault-import` and `vault-snapshot`.
   - They run on the back image and on the `internal` network. `up` never starts them; the host scripts call `docker compose run`.
   - No Vault client is needed on the host, and Vault stays unreachable from the host except through its local UI port.
3. **The scripts talk to Vault's HTTP API from Node.** The back image ships no `vault` binary. The vault image keeps its CLI for the healthcheck and the manual procedures of the runbook.
4. **`SOL_VAULT_PULL_TIMEOUT_MS` (default 60000)** bounds the retries of `vault-pull`. The smoke sets it to 5000 to prove the fail-closed start in seconds.
5. **The import applies what the runbook did by hand:**
   - it drops the injected variables;
   - it rewrites the evidence paths to `/var/lib/sol/evidence`;
   - it sets the stack bindings: `API_HOST=0.0.0.0` and `API_PORT=3000` (listener), `OPERATOR_API_HOST=0.0.0.0` and `OPERATOR_API_PORT=3100` (operator API).

   A role file the source lacks comes from its repository template.
6. **The `operator` login gets a 1-hour token, renewable up to 8 hours.** Vault's default is 32 days.

## Evidence gathered before writing this plan (2026-10-09, pinned images)

**Image and probes:**
- `hashicorp/vault:2.1.2` is pinned as `hashicorp/vault@sha256:c2f666266f383d2cf424d86b8bb8ce7d065562173ffec2b476d762943608bb55`. It is Vault v2.1.2, on Alpine.
  - Default user `vault` (uid 100, gid 1000). `/vault/{config,file,logs}` belong to it. `su-exec`, `wget` and `dumb-init` are present; `curl`, `jq` and `setcap` are not.
  - Entrypoint `docker-entrypoint.sh`, command `server -dev`.
- Every probe below ran against a throwaway server with the raft configuration of Task 7 (`storage "raft"` on `/vault/file`, `disable_mlock`, `tls_disable`). The Node calls ran from `node:22.22.0-bookworm-slim`, the base of the back image.

**Initialization and unsealing:**
- Uninitialized: `vault status` exits 2, and `GET /v1/sys/health` answers 501. `GET /v1/sys/seal-status` answers 200 with `initialized:false`.
- `PUT /v1/sys/init` with `{"secret_shares":1,"secret_threshold":1}` answers `keys`, `keys_base64` and `root_token`. The base64 key is 44 characters long.
- `vault operator unseal -` treats `-` as a key (HTTP 400). Without an argument it needs a TTY. So the entrypoint unseals with `printf '{"key":"%s"}' "$(head -n 1 key)" | wget -q -O /dev/null --post-file=/dev/stdin http://127.0.0.1:8200/v1/sys/unseal`, which works.
- Sealed: `POST /v1/auth/approle/login` and `GET /v1/sys/health` answer 503 with `{"errors":["Vault is sealed"]}`. `vault status` exits 2.

**Administration and data:**
- From Node `fetch`, with the root token:
  - `POST sys/mounts/sol {type:kv, options:{version:"2"}}`, `POST sys/auth/approle` and `POST sys/auth/userpass` answer 204;
  - `PUT sys/policies/acl/<name> {policy}` answers 204;
  - `POST auth/approle/role/<name> {token_policies, token_ttl:"5m", token_max_ttl:"5m", secret_id_ttl:"0", secret_id_num_uses:0}` answers 204;
  - `GET .../role-id` and `POST .../secret-id` answer 200 with `data.role_id` and `data.secret_id`;
  - `POST auth/userpass/users/operator {password, token_policies}` answers 204;
  - `POST auth/token/revoke-self` answers 204, after which the root token gets 403;
  - a second `PUT sys/init` answers 400 `Vault is already initialized`.
- AppRole login answers 200 with `auth.client_token`, `lease_duration` 300 and policies `back` and `default`.
- With that token:
  - `GET sol/data/<path>` answers `data.data` (fields) and `data.metadata.version`;
  - a missing entry answers 404 `{"errors":[]}`;
  - a write answers 403;
  - `sys/storage/raft/snapshot` answers 403;
  - after `revoke-self` (204), every call answers 403.
- A wrong `secret_id` answers 400 `invalid role or secret ID`. An unknown host makes `fetch` throw `TypeError` with `cause.code` `ENOTFOUND`.
- The `vault kv put … value=-` and `vault write …/users/operator password=-` CLI forms read stdin.
- A token of the `backup` AppRole downloads `GET /v1/sys/storage/raft/snapshot`, a 27 KB gzip (`1f 8b`), with `wget` alone.

**Auto-unseal entrypoint:**
- Two variants of `deploy/vault/vault-entrypoint` (Task 7) were run as root, with `--init`, `no-new-privileges`, `--cap-drop NET_RAW --cap-drop MKNOD` and `--ulimit core=0`.
  - Both unseal Vault on start and again after `docker restart` (`vault.unsealed`, `vault status` exits 0). `ps` shows `vault server` running as `vault`.
  - The variant that `exec`s the server leaves the unseal subshell as a zombie. The variant that keeps the shell as parent (`trap` + `wait`) reaps it. That second variant is the one in Task 7.
  - `docker stop` takes 1 s with exit code 0. The only error line is `core: unlocking HA lock failed: error="cannot find peer"`, which is benign on a single raft node.
- The same compose hardening as `back` (`security_opt no-new-privileges:true`, `cap_drop [NET_RAW, MKNOD]`, `ulimits core: 0`) gives `ulimit -c` 0/0 and `NoNewPrivs 1`, and `setpriv --reuid=1000` still works (verified with PR #263).

## Prerequisites for every task

The worktree is `.worktrees/vault-secrets` on branch `feat/vault-secrets` (base `main` 78fa4d1c, draft PR #264 with the spec). Before the first test run:

```bash
npm ci
npm run build:backend
```

Backend tests run with `npx tsx --test <file>`. The full suite needs a disposable PostgreSQL:

```bash
docker run -d --name sol-vault-plan-test-pg -p 127.0.0.1:55438:5432 \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=sol_token_listener_test \
  postgres:16.14-alpine3.23@sha256:42b8b8b29c8a4e933d88943e5b03001a78794905cf786e6e7634e9f2abd5a0d3
```

Use `TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55438/sol_token_listener_test`. Never use port 5432, and never touch another session's container.

Lint is `npm run lint:backend` (eslint, plus `node --check` of the smoke). Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File structure

| Path | Responsibility |
|---|---|
| `src/deploy/vault-layout.ts` | Pure: the `sol/` paths, the entries each container reads per mode, rendering a configuration entry as `.env` text, secret value check |
| `src/deploy/vault-client.ts` | Vault HTTP API client: seal status, init, unseal, logins, KV v2 read and write, revoke, administration, raft snapshot; three error classes |
| `scripts/deploy/vault-pull.ts` | CLI at boot of back (`vault-pull back <mode>`) and migrate (`vault-pull migrate`) |
| `scripts/deploy/vault-setup.ts` | CLI `vault-setup init`, run once by `deploy/host/vault-init.sh` |
| `scripts/deploy/vault-import.ts` | CLI `vault-import`, run by `deploy/host/vault-import.sh` |
| `scripts/deploy/vault-snapshot.ts` | CLI `vault-snapshot`, run by `deploy/host/backup.sh` |
| `deploy/vault/vault.hcl`, `deploy/vault/vault-entrypoint` | Vault server configuration and auto-unseal entrypoint |
| `deploy/vault/policies/{back,migrate,backup,operator}.hcl` | The four policies |
| `deploy/host/vault-init.sh`, `deploy/host/vault-import.sh` | Host wrappers |
| `tests/helpers/fake-vault.ts` | In-memory Vault HTTP API for the tests |
| `tests/deploy-vault-{layout,client,pull,setup,import,snapshot}.test.ts` | Unit tests |
| Modified: `Dockerfile`, `deploy/compose.yaml`, `deploy/env.example`, `deploy/back/bin/sol-entrypoint`, `deploy/back/bin/sol-admin`, `deploy/host/init-secrets.sh`, `deploy/host/backup.sh`, `scripts/deployment-smoke.mjs` | Wiring |
| Modified: `tests/deployment-artifacts.test.ts`, `tests/deploy-back-container.test.ts`, `tests/deploy-host-tooling.test.ts`, `tests/deployment-smoke-diagnostics.test.ts` | Static and behaviour tests of the wiring |
| Modified: `docs/operations/deployment.md`, `README.md`, `docs/system-overview.html`, both specs | Documentation |

**Task order:**
- Tasks 2–6 add code and tests without touching a deployment artifact, so every existing test stays green.
- Tasks 7–11 wire the stack, and each one updates the assertions of the existing tests it invalidates.
- Task 12 is the documentation. Task 13 verifies everything and turns PR #264 into the implementation PR.
- Task 14 (validation on the Mac with the real files) needs the user's explicit go.

---

## Task 1: Amend the specs

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-vault-secrets-design.md`
- Modify: `docs/superpowers/specs/2026-10-09-full-bot-compose-design.md:217-222`

- [ ] **Step 1: Record the deviations in the Vault spec**

In section 6.3, replace « `secrets/vault/<rôle>-approle.json` » with « `secrets/vault/approle/<rôle>.json` ». In section 5, bullet « Script d'entrée `vault-entrypoint` », step 3, replace « la clé montée en lecture seule depuis `secrets/vault/unseal-key` » with « la clé du dossier `secrets/vault/unseal/`, monté en lecture seule ». In section 8.1, step 2, replace « `secrets/vault/unseal-key` » with « `secrets/vault/unseal/unseal-key` ». In section 8.5, replace the first bullet with « `secrets/vault/unseal/unseal-key` et `secrets/vault/approle/{back,migrate,backup}.json` ; ». Then append this section at the end of the spec:

```markdown
## 13. Amendements du 2026-10-09 (plan d'implémentation)

Le plan `docs/superpowers/plans/2026-10-09-vault-secrets.md` précise ce spec sur six points,
reportés dans les sections concernées :

1. Les fichiers de Vault sur l'hôte vivent dans deux dossiers, `secrets/vault/unseal/` et
   `secrets/vault/approle/` (5, 6.3, 8.1, 8.5).
   - La clé de déverrouillage n'existe pas au premier démarrage de `vault` : un montage de
     fichier absent ferait créer un dossier par Docker. `vault` monte donc le dossier `unseal/`.
   - `back` et `migrate` montent leur fichier AppRole en syntaxe longue, qui échoue sur un
     fichier absent au lieu de créer un dossier.
2. Trois services ponctuels sur l'image back, au profil `tools` : `vault-setup`, `vault-import`
   et `vault-snapshot`. Ils sont lancés par `docker compose run` depuis les scripts de l'hôte et
   jamais par `up`. Vault reste sur le réseau `internal`, et l'hôte n'a besoin d'aucun client
   Vault.
3. Les scripts appellent l'API HTTP de Vault depuis Node. L'image back n'embarque pas le binaire
   `vault` ; l'image vault le garde pour sa santé et les procédures manuelles.
4. `SOL_VAULT_PULL_TIMEOUT_MS` (60000 par défaut) borne les nouvelles tentatives de
   `vault-pull`. Le smoke la fixe à 5000 pour prouver le refus de démarrer en quelques secondes.
5. L'import reprend ce que le runbook faisait à la main (8.2) :
   - il retire les variables injectées ;
   - il réécrit les chemins de preuves vers `/var/lib/sol/evidence` ;
   - il fixe les liaisons de la stack : `API_HOST`, `API_PORT`, `OPERATOR_API_HOST`,
     `OPERATOR_API_PORT`.

   Un fichier de rôle absent de la source vient du modèle du dépôt.
6. Le login `operator` reçoit un jeton d'une heure, renouvelable jusqu'à 8 heures. La valeur par
   défaut de Vault est de 32 jours.
```

- [ ] **Step 2: Point the sub-project 1 spec at the Vault spec**

In `docs/superpowers/specs/2026-10-09-full-bot-compose-design.md`, section 7.3, append this paragraph after the existing one:

```markdown
Réalisé par le sous-projet 2, `docs/superpowers/specs/2026-10-09-vault-secrets-design.md` :
un AppRole par conteneur plutôt qu'un rôle par utilisateur (section 6.3 de ce document), et la
configuration non secrète passe elle aussi dans Vault.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-09-vault-secrets-design.md docs/superpowers/specs/2026-10-09-full-bot-compose-design.md
git commit -m "docs(spec): record the Vault plan deviations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 2: Vault layout (pure)

**Files:**
- Create: `src/deploy/vault-layout.ts`
- Test: `tests/deploy-vault-layout.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/deploy-vault-layout.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoleEnvironmentError } from '../src/deploy/role-environment.js';
import {
  CONFIG_NAMES,
  VaultLayoutError,
  backEntries,
  migrateEntries,
  renderConfig,
  secretValue,
} from '../src/deploy/vault-layout.js';

void test('observe reads every configuration and secret of the mode except the keypair', () => {
  const entries = backEntries('observe');
  assert.deepEqual(entries.filter((entry) => entry.required).map((entry) => entry.path), [
    'config/listener', 'config/operator-api', 'config/retention',
    'secrets/back/helius-listener-http-url', 'secrets/back/helius-listener-ws-url',
    'secrets/back/operator-api-token',
    'secrets/logins/sol_listener', 'secrets/logins/sol_reader', 'secrets/logins/sol_retention',
  ]);
  assert.deepEqual(
    entries.filter((entry) => entry.kind === 'config').map((entry) => entry.file),
    CONFIG_NAMES.map((name) => `${name}.env`),
  );
  assert.equal(entries.some((entry) => entry.path.includes('wallet-keypair')), false);
  assert.deepEqual(entries.find((entry) => entry.path === 'secrets/back/helius-executor-http-url'), {
    kind: 'secret', path: 'secrets/back/helius-executor-http-url',
    file: 'back/helius-executor-http-url', required: false,
  });
});

void test('live requires the executor entries, the keypair included', () => {
  assert.deepEqual(backEntries('live').filter((entry) => entry.required).map((entry) => entry.path), [
    'config/listener', 'config/live', 'config/live-recovery', 'config/operations',
    'config/operator-api', 'config/retention',
    'secrets/back/helius-executor-http-url', 'secrets/back/helius-listener-http-url',
    'secrets/back/helius-listener-ws-url', 'secrets/back/operator-api-token',
    'secrets/back/wallet-keypair.json',
    'secrets/logins/sol_autoarm', 'secrets/logins/sol_listener', 'secrets/logins/sol_live',
    'secrets/logins/sol_ops', 'secrets/logins/sol_reader', 'secrets/logins/sol_recovery',
    'secrets/logins/sol_retention',
  ]);
  assert.deepEqual(backEntries('live').find((entry) => entry.path === 'secrets/back/wallet-keypair.json'), {
    kind: 'secret', path: 'secrets/back/wallet-keypair.json', file: 'back/wallet-keypair.json', required: true,
  });
});

void test('migrate requires the nine login passwords at the paths admin-database reads', () => {
  const entries = migrateEntries();
  assert.equal(entries.length, 9);
  assert.ok(entries.every((entry) => entry.kind === 'secret' && entry.required));
  assert.deepEqual(entries[0], {
    kind: 'secret', path: 'secrets/logins/sol_listener', file: 'logins/pg-sol_listener-password', required: true,
  });
});

void test('a configuration renders sorted and must survive the .env round trip', () => {
  assert.equal(
    renderConfig('listener', { API_PORT: '3000', API_HOST: '0.0.0.0', EMPTY: '' }),
    'API_HOST=0.0.0.0\nAPI_PORT=3000\nEMPTY=\n',
  );
  for (const value of ['a#private', ' padded', "'single'", '"double"', 'two\nlines']) {
    assert.throws(() => renderConfig('listener', { KEY: value }), (error: unknown) => {
      assert.ok(error instanceof VaultLayoutError || error instanceof RoleEnvironmentError, JSON.stringify(value));
      assert.equal((error as Error).message.includes('private'), false);
      return true;
    });
  }
  assert.throws(() => renderConfig('listener', { KEY: 3 }), VaultLayoutError);
  assert.throws(() => renderConfig('listener', { DATABASE_URL: 'x' }), RoleEnvironmentError);
  assert.throws(() => renderConfig('listener', { API_TOKEN: 'x' }), RoleEnvironmentError);
  assert.throws(() => renderConfig('listener', { RPC: 'https://h.invalid/?api-key=x' }), RoleEnvironmentError);
});

void test('a secret entry keeps its value unchanged and names only its path when invalid', () => {
  assert.equal(secretValue('secrets/back/x', { value: '[1,2]\n' }), '[1,2]\n');
  assert.throws(() => secretValue('secrets/back/x', { value: '' }), /^VaultLayoutError: secrets\/back\/x: expected a non-empty value field$/u);
  assert.throws(() => secretValue('secrets/back/x', { other: 'v' }), VaultLayoutError);
});
```

The `/^VaultLayoutError: …$/` form matches `String(error)`; `assert.throws` with a RegExp tests the error's string form.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test tests/deploy-vault-layout.test.ts`
Expected: FAIL, `Cannot find module '../src/deploy/vault-layout.js'`.

- [ ] **Step 3: Write the module**

Create `src/deploy/vault-layout.ts`:

```ts
import { parseRoleConfig } from './role-environment.js';
import { secretGrants } from './secret-distribution.js';
import {
  DATABASE_LOGIN_NAMES,
  REQUIRED_ROLES,
  ROLES,
  loginPasswordFile,
  type DatabaseLogin,
  type StackMode,
} from './stack.js';

/**
 * Where the stack's variables live in Vault and which entries each container reads at boot
 * (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 6.1 and 7.1). Pure: no I/O.
 */
export const VAULT_MOUNT = 'sol';

/** One entry per former `config/<name>.env` file. */
export const CONFIG_NAMES = Object.freeze([
  'listener', 'live', 'live-recovery', 'operations', 'operator-api',
  'readiness', 'worker-sim', 'provider-evidence', 'preflight-bundle', 'retention',
] as const);
export type ConfigName = (typeof CONFIG_NAMES)[number];

/** Messages name entries and variables, never a value. */
export class VaultLayoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'VaultLayoutError';
  }
}

/** A Vault entry a container reads at boot, and the file it becomes. */
export interface PullEntry {
  readonly kind: 'config' | 'secret';
  /** KV v2 path under the `sol/` mount. */
  readonly path: string;
  /** File relative to the container's configuration or secrets directory. */
  readonly file: string;
  /** A required entry stops the container when absent; the others are skipped. */
  readonly required: boolean;
}

export function isConfigName(value: string): value is ConfigName {
  return (CONFIG_NAMES as readonly string[]).includes(value);
}

function configNameOf(configFile: string): ConfigName {
  const name = configFile.replace(/\.env$/u, '');
  if (!isConfigName(name)) throw new VaultLayoutError(`unknown configuration file ${configFile}`);
  return name;
}

function loginOf(passwordFile: string): DatabaseLogin {
  const login = DATABASE_LOGIN_NAMES.find((candidate) => loginPasswordFile(candidate) === passwordFile);
  if (login === undefined) throw new VaultLayoutError(`unknown login file ${passwordFile}`);
  return login;
}

/**
 * The back reads the configuration and the secrets of its mode (`secretGrants`). The entries of
 * the roles supervisord starts are required. In observe mode it never reads the keypair.
 */
export function backEntries(mode: StackMode): readonly PullEntry[] {
  const required = new Set(REQUIRED_ROLES[mode].map((role) => configNameOf(ROLES[role].configFile)));
  const configs = CONFIG_NAMES.map((name): PullEntry => Object.freeze({
    kind: 'config', path: `config/${name}`, file: `${name}.env`, required: required.has(name),
  }));
  const secrets = new Map<string, PullEntry>();
  for (const grant of secretGrants(mode)) {
    if (mode === 'observe' && grant.file === 'wallet-keypair.json') continue;
    const path = grant.source === 'logins'
      ? `secrets/logins/${loginOf(grant.file)}`
      : `secrets/back/${grant.file}`;
    secrets.set(path, Object.freeze({
      kind: 'secret',
      path,
      file: `${grant.source}/${grant.file}`,
      required: grant.required || secrets.get(path)?.required === true,
    }));
  }
  const sorted = [...secrets.values()].sort((left, right) => (left.path < right.path ? -1 : 1));
  return Object.freeze([...configs, ...sorted]);
}

/** Migrate reads the nine login passwords, all required. */
export function migrateEntries(): readonly PullEntry[] {
  return Object.freeze(DATABASE_LOGIN_NAMES.map((login): PullEntry => Object.freeze({
    kind: 'secret',
    path: `secrets/logins/${login}`,
    file: `logins/${loginPasswordFile(login)}`,
    required: true,
  })));
}

/**
 * The `.env` text of a configuration entry: sorted `VARIABLE=value` lines. Refused when the entry
 * breaks the configuration rules (`parseRoleConfig`) or when dotenv would not read it back as is.
 */
export function renderConfig(name: ConfigName, data: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(data).sort();
  const text = keys.map((key) => {
    const value = data[key];
    if (typeof value !== 'string') throw new VaultLayoutError(`config/${name}: ${key} must be a string`);
    return `${key}=${value}\n`;
  }).join('');
  const parsed = parseRoleConfig(text, `config/${name}`);
  const changed = keys.find((key) => parsed[key] !== data[key]);
  if (changed !== undefined || Object.keys(parsed).length !== keys.length) {
    throw new VaultLayoutError(
      `config/${name}: ${changed ?? 'a variable'} does not survive the .env format (#, quotes or outer spaces)`,
    );
  }
  return text;
}

/** A secret entry keeps its text in `value`; the file receives it unchanged. */
export function secretValue(path: string, data: Readonly<Record<string, unknown>>): string {
  const value = data.value;
  if (typeof value !== 'string' || value.length === 0) {
    throw new VaultLayoutError(`${path}: expected a non-empty value field`);
  }
  return value;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test tests/deploy-vault-layout.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Check types and lint, then commit**

```bash
npx tsc -p tsconfig.json --noEmit && npm run lint:backend
git add src/deploy/vault-layout.ts tests/deploy-vault-layout.test.ts
git commit -m "feat(deploy): Vault layout of the stack's configuration and secrets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 3: Vault HTTP client and the fake Vault of the tests

**Files:**
- Create: `src/deploy/vault-client.ts`
- Create: `tests/helpers/fake-vault.ts`
- Test: `tests/deploy-vault-client.test.ts`

- [ ] **Step 1: Write the fake Vault**

Create `tests/helpers/fake-vault.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing client tests**

Create `tests/deploy-vault-client.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VaultClient,
  VaultDeniedError,
  VaultMissingError,
  VaultUnavailableError,
  parseAppRoleCredentials,
} from '../src/deploy/vault-client.js';
import { FakeVault } from './helpers/fake-vault.js';

void test('reads, writes and errors follow the HTTP API without ever quoting a body or a value', async () => {
  const vault = new FakeVault();
  const client = new VaultClient({ address: 'http://vault:8200/', fetch: vault.fetch });
  vault.kv.set('secrets/back/x', { value: 'top-secret-value' });
  const credentials = vault.addAppRole('back');
  const token = await client.appRoleLogin(credentials);
  assert.deepEqual(await client.readKv(token, 'secrets/back/x'), { value: 'top-secret-value' });
  await assert.rejects(client.readKv(token, 'secrets/back/absent'),
    (error) => error instanceof VaultMissingError && error.message === 'vault GET sol/data/secrets/back/absent: HTTP 404');
  await assert.rejects(client.writeKv(token, 'secrets/back/x', { value: 'y' }), VaultDeniedError);
  await assert.rejects(client.appRoleLogin({ role_id: credentials.role_id, secret_id: 'wrong' }),
    (error) => error instanceof VaultDeniedError && error.message === 'vault POST auth/approle/login: HTTP 400');
  await client.revokeSelf(token);
  assert.equal(vault.isRevoked(token), true);
  await assert.rejects(client.readKv(token, 'secrets/back/x'), VaultDeniedError);
  vault.sealed = true;
  await assert.rejects(client.appRoleLogin(credentials),
    (error) => error instanceof VaultUnavailableError && error.message === 'vault POST auth/approle/login: HTTP 503');
  vault.unreachable = true;
  await assert.rejects(client.sealStatus(),
    (error) => error instanceof VaultUnavailableError && error.message === 'vault GET sys/seal-status: unreachable');
  assert.ok(vault.requests.every((request) => !request.includes('top-secret-value')));
});

void test('init, unseal, administration and snapshot use the root token, then the backup AppRole', async () => {
  const vault = new FakeVault();
  vault.initialized = false;
  vault.sealed = true;
  const client = new VaultClient({ address: 'http://vault:8200', fetch: vault.fetch });
  assert.deepEqual(await client.sealStatus(), { initialized: false, sealed: true });
  const { unsealKey, rootToken } = await client.initialize();
  await client.unseal(unsealKey);
  assert.deepEqual(await client.sealStatus(), { initialized: true, sealed: false });
  await client.enableKv2(rootToken, 'sol');
  await client.enableAuth(rootToken, 'approle');
  await client.putPolicy(rootToken, 'backup', 'path "sys/storage/raft/snapshot" { capabilities = ["read"] }\n');
  const backup = await client.createAppRole(rootToken, 'backup');
  await client.createUser(rootToken, 'operator', 'operator-password-0123456789', 'operator');
  assert.deepEqual([...vault.mounts], ['sol']);
  assert.deepEqual([...vault.auths], ['approle']);
  assert.equal(vault.users.get('operator')?.policy, 'operator');
  const stream = await client.snapshot(await client.appRoleLogin(backup));
  assert.deepEqual([...new Uint8Array(await new Response(stream).arrayBuffer())].slice(0, 2), [0x1f, 0x8b]);
  await assert.rejects(client.initialize(), VaultDeniedError);
});

void test('AppRole credentials come from a JSON object with two non-empty strings', () => {
  assert.deepEqual(parseAppRoleCredentials('{"role_id":"r","secret_id":"s"}\n'), { role_id: 'r', secret_id: 's' });
  for (const text of ['', 'not json', '{"role_id":"r"}', '{"role_id":"","secret_id":"s"}', '[]']) {
    assert.throws(() => parseAppRoleCredentials(text), /^TypeError: expected an AppRole JSON object$/u);
  }
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx tsx --test tests/deploy-vault-client.test.ts`
Expected: FAIL, `Cannot find module '../src/deploy/vault-client.js'`.

- [ ] **Step 4: Write the client**

Create `src/deploy/vault-client.ts`:

```ts
import { VAULT_MOUNT } from './vault-layout.js';

/**
 * Minimal client of the Vault HTTP API for the stack's scripts
 * (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 7 and 8). No dependency. An error
 * message names the method, the path and the HTTP status, never a body or a value.
 */
export type VaultFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Unreachable, sealed (503), uninitialized (501), rate-limited or failing: try again later. */
export class VaultUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'VaultUnavailableError';
  }
}

/** Credentials or policy refused: 400, 401 or 403. */
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
  readonly timeoutMs?: number;
}

interface RequestOptions {
  readonly token?: string;
  readonly body?: unknown;
}

export class VaultClient {
  private readonly address: string;
  private readonly fetchImpl: VaultFetch;
  private readonly timeoutMs: number;

  public constructor(options: VaultClientOptions) {
    this.address = options.address.replace(/\/+$/u, '');
    this.fetchImpl = options.fetch ?? (async (url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  public async sealStatus(): Promise<Readonly<{ initialized: boolean; sealed: boolean }>> {
    const body = await this.json('GET', 'sys/seal-status');
    return Object.freeze({
      initialized: field(body, 'initialized') === true,
      sealed: field(body, 'sealed') !== false,
    });
  }

  /** One key share (spec 5): the unseal key and the root token. */
  public async initialize(): Promise<Readonly<{ unsealKey: string; rootToken: string }>> {
    const body = await this.json('PUT', 'sys/init', { body: { secret_shares: 1, secret_threshold: 1 } });
    const keys = field(body, 'keys_base64');
    const unsealKey: unknown = Array.isArray(keys) ? keys[0] : undefined;
    const rootToken = field(body, 'root_token');
    if (typeof unsealKey !== 'string' || typeof rootToken !== 'string') {
      throw new VaultUnavailableError('vault PUT sys/init: unexpected answer');
    }
    return Object.freeze({ unsealKey, rootToken });
  }

  public async unseal(key: string): Promise<void> {
    const body = await this.json('PUT', 'sys/unseal', { body: { key } });
    if (field(body, 'sealed') !== false) throw new VaultUnavailableError('vault PUT sys/unseal: still sealed');
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
    const roleId = field(field(await this.json('GET', `auth/approle/role/${name}/role-id`, { token }), 'data'), 'role_id');
    const secretId = field(field(await this.json('POST', `auth/approle/role/${name}/secret-id`, { token }), 'data'), 'secret_id');
    if (typeof roleId !== 'string' || typeof secretId !== 'string') {
      throw new VaultUnavailableError(`vault auth/approle/role/${name}: unexpected answer`);
    }
    return Object.freeze({ role_id: roleId, secret_id: secretId });
  }

  /** A userpass login whose token lives one hour, renewable up to eight (plan deviation 6). */
  public async createUser(token: string, username: string, password: string, policy: string): Promise<void> {
    await this.json('POST', `auth/userpass/users/${encodeURIComponent(username)}`, {
      token, body: { password, token_policies: [policy], token_ttl: '1h', token_max_ttl: '8h' },
    });
  }

  /** The raft snapshot (gzip), as a stream. */
  public async snapshot(token: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.send('GET', 'sys/storage/raft/snapshot', { token });
    if (response.body === null) throw new VaultUnavailableError('vault GET sys/storage/raft/snapshot: empty answer');
    return response.body;
  }

  private async login(path: string, body: unknown): Promise<string> {
    const token = field(field(await this.json('POST', path, { body }), 'auth'), 'client_token');
    if (typeof token !== 'string' || token === '') throw new VaultDeniedError(`vault POST ${path}: no token`);
    return token;
  }

  private async json(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const text = await (await this.send(method, path, options)).text();
    if (text === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new VaultUnavailableError(`vault ${method} ${path}: unreadable answer`);
    }
  }

  private async send(method: string, path: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.token !== undefined) headers['X-Vault-Token'] = options.token;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.address}/v1/${path}`, {
        method,
        headers,
        body: options.body === undefined ? null : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
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

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test tests/deploy-vault-client.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Check types and lint, then commit**

```bash
npx tsc -p tsconfig.json --noEmit && npm run lint:backend
git add src/deploy/vault-client.ts tests/helpers/fake-vault.ts tests/deploy-vault-client.test.ts
git commit -m "feat(deploy): minimal Vault HTTP client and its in-memory fake

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 4: `vault-pull`, the boot-time reader of back and migrate

**Files:**
- Create: `scripts/deploy/vault-pull.ts`
- Test: `tests/deploy-vault-pull.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/deploy-vault-pull.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runVaultPullCli, writePulledFile, type VaultPullDependencies } from '../scripts/deploy/vault-pull.js';
import { backEntries } from '../src/deploy/vault-layout.js';
import { FakeVault } from './helpers/fake-vault.js';

interface PullRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly files: ReadonlyMap<string, Readonly<{ content: string; mode: number }>>;
  readonly sleeps: readonly number[];
}

/** A Vault holding every entry of live mode: configurations `LOG_LEVEL=info`, secrets `value-of-<path>`. */
function seededVault(): FakeVault {
  const vault = new FakeVault();
  for (const entry of backEntries('live')) {
    vault.kv.set(entry.path, entry.kind === 'config' ? { LOG_LEVEL: 'info' } : { value: `value-of-${entry.path}` });
  }
  return vault;
}

async function pull(
  vault: FakeVault,
  argv: readonly string[],
  approle: string,
  options: Readonly<{ environment?: NodeJS.ProcessEnv; onSleep?: () => void }> = {},
): Promise<PullRun> {
  let clock = 0;
  const files = new Map<string, Readonly<{ content: string; mode: number }>>();
  const sleeps: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: VaultPullDependencies = {
    fetch: vault.fetch,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
      options.onSleep?.();
    },
    readFile: (path) => {
      if (path !== '/root/vault/approle.json') throw new Error(`unexpected read of ${path}`);
      return approle;
    },
    writeFile: (path, content, mode) => { files.set(path, Object.freeze({ content, mode })); },
  };
  const code = await runVaultPullCli(argv, options.environment ?? {}, {
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
  }, dependencies);
  return { code, stdout: stdout.join(''), stderr: stderr.join(''), files, sleeps };
}

void test('live writes every configuration 0644 and every secret 0600 at the current paths, then revokes', async () => {
  const vault = seededVault();
  const run = await pull(vault, ['back', 'live'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.files.get('/etc/sol/config/listener.env'), { content: 'LOG_LEVEL=info\n', mode: 0o644 });
  assert.deepEqual(run.files.get('/root/secrets/back/wallet-keypair.json'), {
    content: 'value-of-secrets/back/wallet-keypair.json', mode: 0o600,
  });
  assert.deepEqual(run.files.get('/root/secrets/logins/pg-sol_live-password'), {
    content: 'value-of-secrets/logins/sol_live', mode: 0o600,
  });
  const entries = backEntries('live');
  assert.equal(run.files.size, entries.length);
  assert.deepEqual(JSON.parse(run.stdout), {
    service: 'vault-pull', event: 'vault.pulled', container: 'back', mode: 'live',
    configs: 10, secrets: entries.length - 10, absent: [],
  });
  assert.ok(vault.issuedTokens().length > 0 && vault.issuedTokens().every((token) => vault.isRevoked(token)));
  assert.equal(`${run.stdout}${run.stderr}`.includes('value-of-'), false);
});

void test('observe never reads the keypair and skips absent optional entries', async () => {
  const vault = seededVault();
  vault.kv.delete('config/readiness');
  vault.kv.delete('secrets/back/helius-admin-api-key');
  const run = await pull(vault, ['back', 'observe'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(vault.requests.some((request) => request.includes('wallet-keypair')), false);
  assert.equal([...run.files.keys()].some((path) => path.includes('wallet-keypair')), false);
  assert.deepEqual((JSON.parse(run.stdout) as { absent: string[] }).absent, [
    'config/readiness', 'secrets/back/helius-admin-api-key',
  ]);
});

void test('missing required entries stop the pull before any write and are all named', async () => {
  const vault = seededVault();
  vault.kv.delete('config/live');
  vault.kv.delete('secrets/back/wallet-keypair.json');
  const run = await pull(vault, ['back', 'live'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 78);
  assert.equal(run.files.size, 0);
  assert.equal(run.stderr, 'vault-pull: missing required entries: config/live, secrets/back/wallet-keypair.json\n');
  assert.ok(vault.issuedTokens().every((token) => vault.isRevoked(token)));
});

void test('an unavailable Vault is retried every 2 s until the deadline, then exits 69', async () => {
  const sealed = seededVault();
  const approle = JSON.stringify(sealed.addAppRole('back'));
  sealed.sealed = true;
  const failed = await pull(sealed, ['back', 'observe'], approle, { environment: { SOL_VAULT_PULL_TIMEOUT_MS: '10000' } });
  assert.equal(failed.code, 69);
  assert.deepEqual(failed.sleeps, [2000, 2000, 2000, 2000, 2000]);
  assert.equal(failed.stderr, 'vault-pull: Vault unavailable for 10 s (vault POST auth/approle/login: HTTP 503)\n');
  assert.equal(failed.files.size, 0);

  const recovering = seededVault();
  const credentials = JSON.stringify(recovering.addAppRole('back'));
  recovering.unreachable = true;
  const recovered = await pull(recovering, ['back', 'observe'], credentials, {
    onSleep: () => { recovering.unreachable = false; },
  });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.deepEqual(recovered.sleeps, [2000]);
});

void test('a refused AppRole exits 77 and an unreadable AppRole file 78', async () => {
  const vault = seededVault();
  const credentials = vault.addAppRole('back');
  const refused = await pull(vault, ['back', 'observe'], JSON.stringify({ ...credentials, secret_id: 'wrong' }));
  assert.equal(refused.code, 77);
  assert.equal(refused.stderr, 'vault-pull: refused by Vault (vault POST auth/approle/login: HTTP 400)\n');
  const unreadable = await pull(vault, ['back', 'observe'], 'not json');
  assert.equal(unreadable.code, 78);
  assert.equal(unreadable.stderr, 'vault-pull: missing or invalid AppRole file /root/vault/approle.json\n');
});

void test('an invalid configuration value exits 78 naming the variable, never the value', async () => {
  const vault = seededVault();
  vault.kv.set('config/listener', { API_HOST: 'leaked#tail' });
  const run = await pull(vault, ['back', 'observe'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 78);
  assert.equal(run.files.size, 0);
  assert.match(run.stderr, /^vault-pull: config\/listener: API_HOST does not survive the \.env format/u);
  assert.equal(run.stderr.includes('leaked'), false);
});

void test('migrate writes the nine login passwords under its own secrets directory', async () => {
  const vault = seededVault();
  const run = await pull(vault, ['migrate'], JSON.stringify(vault.addAppRole('migrate')));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.files.size, 9);
  assert.ok([...run.files.keys()].every((path) => /^\/root\/secrets\/db\/logins\/pg-sol_[a-z]+-password$/u.test(path)));
  assert.deepEqual(JSON.parse(run.stdout), {
    service: 'vault-pull', event: 'vault.pulled', container: 'migrate', configs: 0, secrets: 9, absent: [],
  });
});

void test('usage errors exit 64', async () => {
  const vault = new FakeVault();
  for (const argv of [[], ['back'], ['back', 'paper'], ['migrate', 'live'], ['front'], ['back', 'live', 'x']]) {
    assert.equal((await pull(vault, argv, '{}')).code, 64, JSON.stringify(argv));
  }
});

void test('the file writer creates owner-only directories and sets the exact mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vault-pull-'));
  try {
    writePulledFile(join(directory, 'secrets/back/token'), 'v', 0o600);
    writePulledFile(join(directory, 'config.env'), 'A=b\n', 0o644);
    assert.equal((await stat(join(directory, 'secrets'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'secrets/back/token'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'config.env'))).mode & 0o777, 0o644);
    assert.equal(await readFile(join(directory, 'secrets/back/token'), 'utf8'), 'v');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test tests/deploy-vault-pull.test.ts`
Expected: FAIL, `Cannot find module '../scripts/deploy/vault-pull.js'`.

- [ ] **Step 3: Write the command**

Create `scripts/deploy/vault-pull.ts`:

```ts
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { RoleEnvironmentError } from '../../src/deploy/role-environment.js';
import { isStackMode, type StackMode } from '../../src/deploy/stack.js';
import {
  VaultClient,
  VaultDeniedError,
  VaultMissingError,
  VaultUnavailableError,
  parseAppRoleCredentials,
  type AppRoleCredentials,
  type VaultFetch,
} from '../../src/deploy/vault-client.js';
import {
  VaultLayoutError,
  backEntries,
  isConfigName,
  migrateEntries,
  renderConfig,
  secretValue,
  type PullEntry,
} from '../../src/deploy/vault-layout.js';

export interface VaultPullIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface VaultPullDependencies {
  readonly fetch?: VaultFetch | undefined;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, content: string, mode: number) => void;
}

/** Owner-only parent directories, then the exact mode whatever the umask. */
export function writePulledFile(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

const NODE_DEPENDENCIES: VaultPullDependencies = Object.freeze({
  now: () => Date.now(),
  sleep: async (milliseconds: number) => { await delay(milliseconds); },
  readFile: (path: string) => readFileSync(path, 'utf8'),
  writeFile: writePulledFile,
});

const RETRY_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/** An unreadable AppRole file or missing required entries: EX_CONFIG. */
class PullConfigurationError extends Error {}

type Target =
  | Readonly<{ container: 'back'; mode: StackMode }>
  | Readonly<{ container: 'migrate'; mode: null }>;

interface PulledFile {
  readonly kind: 'config' | 'secret';
  readonly path: string;
  readonly content: string;
  readonly mode: number;
}

/**
 * `vault-pull back observe|live` (sol-entrypoint) and `vault-pull migrate` (sol-admin migrate)
 * read the container's Vault entries into tmpfs at the current paths
 * (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 7). Nothing is written until every
 * required entry is read and valid, and no value is ever printed. Exit codes: 0; 64 usage;
 * 69 Vault unavailable past SOL_VAULT_PULL_TIMEOUT_MS (60 s); 77 AppRole or policy refused;
 * 78 unreadable AppRole file, missing required entry or invalid entry.
 */
export async function runVaultPullCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: VaultPullIo,
  dependencies: VaultPullDependencies = NODE_DEPENDENCIES,
): Promise<number> {
  const target = parseTarget(argv);
  if (target === null) {
    io.stderr('usage: vault-pull back observe|live | vault-pull migrate\n');
    return 64;
  }
  const entries = target.container === 'back' ? backEntries(target.mode) : migrateEntries();
  const secretsDirectory = environment.SOL_SECRETS_DIR
    ?? (target.container === 'back' ? '/root/secrets' : '/root/secrets/db');
  const configDirectory = environment.SOL_CONFIG_DIR ?? '/etc/sol/config';
  const timeoutMs = timeoutOf(environment.SOL_VAULT_PULL_TIMEOUT_MS);
  const client = new VaultClient({
    address: environment.VAULT_ADDR ?? 'http://vault:8200', fetch: dependencies.fetch,
  });
  try {
    const credentials = readCredentials(dependencies, environment.SOL_VAULT_APPROLE ?? '/root/vault/approle.json');
    const deadline = dependencies.now() + timeoutMs;
    for (;;) {
      try {
        const values = await readEntries(client, credentials, entries);
        const files = materialize(entries, values, secretsDirectory, configDirectory);
        for (const file of files) dependencies.writeFile(file.path, file.content, file.mode);
        io.stdout(`${JSON.stringify({
          service: 'vault-pull',
          event: 'vault.pulled',
          container: target.container,
          ...(target.mode === null ? {} : { mode: target.mode }),
          configs: files.filter((file) => file.kind === 'config').length,
          secrets: files.filter((file) => file.kind === 'secret').length,
          absent: entries.filter((entry) => !values.has(entry.path)).map((entry) => entry.path),
        })}\n`);
        return 0;
      } catch (error) {
        if (!(error instanceof VaultUnavailableError) || dependencies.now() >= deadline) throw error;
        await dependencies.sleep(RETRY_INTERVAL_MS);
      }
    }
  } catch (error) {
    return reportFailure(error, io, timeoutMs);
  }
}

function parseTarget(argv: readonly string[]): Target | null {
  const [container, mode, ...rest] = argv;
  if (rest.length > 0) return null;
  if (container === 'back' && mode !== undefined && isStackMode(mode)) return { container, mode };
  if (container === 'migrate' && mode === undefined) return { container, mode: null };
  return null;
}

function timeoutOf(raw: string | undefined): number {
  return raw !== undefined && /^[1-9][0-9]{0,6}$/u.test(raw) ? Number(raw) : DEFAULT_TIMEOUT_MS;
}

function readCredentials(dependencies: VaultPullDependencies, path: string): AppRoleCredentials {
  try {
    return parseAppRoleCredentials(dependencies.readFile(path));
  } catch {
    throw new PullConfigurationError(`missing or invalid AppRole file ${path}`);
  }
}

async function readEntries(
  client: VaultClient,
  credentials: AppRoleCredentials,
  entries: readonly PullEntry[],
): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
  const token = await client.appRoleLogin(credentials);
  try {
    const values = new Map<string, Readonly<Record<string, unknown>>>();
    const missing: string[] = [];
    for (const entry of entries) {
      try {
        values.set(entry.path, await client.readKv(token, entry.path));
      } catch (error) {
        if (!(error instanceof VaultMissingError)) throw error;
        if (entry.required) missing.push(entry.path);
      }
    }
    if (missing.length > 0) throw new PullConfigurationError(`missing required entries: ${missing.join(', ')}`);
    return values;
  } finally {
    await client.revokeSelf(token).catch(() => undefined);
  }
}

function materialize(
  entries: readonly PullEntry[],
  values: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  secretsDirectory: string,
  configDirectory: string,
): readonly PulledFile[] {
  const files: PulledFile[] = [];
  for (const entry of entries) {
    const data = values.get(entry.path);
    if (data === undefined) continue;
    if (entry.kind === 'config') {
      const name = entry.path.slice('config/'.length);
      if (!isConfigName(name)) throw new VaultLayoutError(`unknown configuration ${entry.path}`);
      files.push({ kind: 'config', path: `${configDirectory}/${entry.file}`, content: renderConfig(name, data), mode: 0o644 });
    } else {
      files.push({ kind: 'secret', path: `${secretsDirectory}/${entry.file}`, content: secretValue(entry.path, data), mode: 0o600 });
    }
  }
  return files;
}

function reportFailure(error: unknown, io: VaultPullIo, timeoutMs: number): number {
  if (error instanceof VaultUnavailableError) {
    io.stderr(`vault-pull: Vault unavailable for ${String(Math.round(timeoutMs / 1_000))} s (${error.message})\n`);
    return 69;
  }
  if (error instanceof VaultDeniedError || error instanceof VaultMissingError) {
    io.stderr(`vault-pull: refused by Vault (${error.message})\n`);
    return 77;
  }
  if (error instanceof PullConfigurationError || error instanceof VaultLayoutError || error instanceof RoleEnvironmentError) {
    io.stderr(`vault-pull: ${error.message}\n`);
    return 78;
  }
  io.stderr('vault-pull: cannot write the pulled files\n');
  return 1;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runVaultPullCli(process.argv.slice(2), process.env, {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test tests/deploy-vault-pull.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Check types and lint, then commit**

```bash
npx tsc -p tsconfig.json --noEmit && npm run lint:backend
git add scripts/deploy/vault-pull.ts tests/deploy-vault-pull.test.ts
git commit -m "feat(deploy): vault-pull reads back and migrate entries at boot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 5: `vault-setup` and the four policies

**Files:**
- Create: `deploy/vault/policies/back.hcl`, `deploy/vault/policies/migrate.hcl`, `deploy/vault/policies/backup.hcl`, `deploy/vault/policies/operator.hcl`
- Create: `scripts/deploy/vault-setup.ts`
- Test: `tests/deploy-vault-setup.test.ts`, `tests/deploy-vault-container.test.ts`

- [ ] **Step 1: Write the policies**

`deploy/vault/policies/back.hcl`:

```hcl
# Back container AppRole (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 6.2): reads
# its configuration, its secrets and the login passwords at boot, nothing else.
path "sol/data/config/*" {
  capabilities = ["read"]
}

path "sol/data/secrets/back/*" {
  capabilities = ["read"]
}

path "sol/data/secrets/logins/*" {
  capabilities = ["read"]
}
```

`deploy/vault/policies/migrate.hcl`:

```hcl
# Migrate container AppRole (spec 6.2): reads the nine login passwords, nothing else.
path "sol/data/secrets/logins/*" {
  capabilities = ["read"]
}
```

`deploy/vault/policies/backup.hcl`:

```hcl
# Backup AppRole (spec 6.2, 8.4): takes a raft snapshot, nothing else.
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
```

`deploy/vault/policies/operator.hcl`:

```hcl
# The operator login (spec 6.2): every entry under sol/ with its versions; nothing on policies or
# authentication.
path "sol/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/deploy-vault-container.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { VAULT_POLICIES } from '../scripts/deploy/vault-setup.js';

const root = new URL('../', import.meta.url);

async function artifact(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

function grants(policy: string): readonly string[] {
  return [...policy.matchAll(/^path "([^"]+)" \{\n {2}capabilities = \[([^\]]*)\]\n\}$/gmu)]
    .map((match) => `${match[1] ?? ''} ${match[2] ?? ''}`);
}

void test('the four policies grant only what spec 6.2 lists', async () => {
  assert.deepEqual(grants(await artifact('deploy/vault/policies/back.hcl')), [
    'sol/data/config/* "read"', 'sol/data/secrets/back/* "read"', 'sol/data/secrets/logins/* "read"',
  ]);
  assert.deepEqual(grants(await artifact('deploy/vault/policies/migrate.hcl')), ['sol/data/secrets/logins/* "read"']);
  assert.deepEqual(grants(await artifact('deploy/vault/policies/backup.hcl')), ['sys/storage/raft/snapshot "read"']);
  assert.deepEqual(grants(await artifact('deploy/vault/policies/operator.hcl')), [
    'sol/* "create", "read", "update", "delete", "list"',
  ]);
  for (const name of VAULT_POLICIES) {
    const policy = await artifact(`deploy/vault/policies/${name}.hcl`);
    assert.equal((policy.match(/^path /gmu) ?? []).length, grants(policy).length, name);
  }
});
```

Create `tests/deploy-vault-setup.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VAULT_APPROLES,
  VAULT_POLICIES,
  runVaultSetupCli,
  type VaultSetupDependencies,
} from '../scripts/deploy/vault-setup.js';
import type { VaultFetch } from '../src/deploy/vault-client.js';
import { DATABASE_LOGIN_NAMES } from '../src/deploy/stack.js';
import { FakeVault } from './helpers/fake-vault.js';

interface SetupRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly files: ReadonlyMap<string, string>;
}

async function setup(
  vault: FakeVault,
  options: Readonly<{ fetch?: VaultFetch; missingPolicy?: string }> = {},
): Promise<SetupRun> {
  const files = new Map<string, string>();
  const stdout: string[] = [];
  const stderr: string[] = [];
  let draws = 0;
  const dependencies: VaultSetupDependencies = {
    fetch: options.fetch ?? vault.fetch,
    readFile: (path) => {
      const name = /^\/etc\/sol\/vault\/policies\/([a-z]+)\.hcl$/u.exec(path)?.[1];
      if (name === undefined || name === options.missingPolicy) throw new Error(`no ${path}`);
      return `# policy ${name}\n`;
    },
    writeSecretFile: (path, content) => {
      if (files.has(path)) throw new Error(`overwrite of ${path}`);
      files.set(path, content);
    },
    random: (bytes) => {
      draws += 1;
      return Buffer.alloc(bytes, draws);
    },
  };
  const code = await runVaultSetupCli(['init'], {}, {
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
  }, dependencies);
  return { code, stdout: stdout.join(''), stderr: stderr.join(''), files };
}

function freshVault(): FakeVault {
  const vault = new FakeVault();
  vault.initialized = false;
  vault.sealed = true;
  return vault;
}

void test('init unseals, configures Vault and writes only the unseal key and the AppRole files', async () => {
  const vault = freshVault();
  const run = await setup(vault);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(vault.sealed, false);
  assert.deepEqual([...vault.mounts], ['sol']);
  assert.deepEqual([...vault.auths].sort(), ['approle', 'userpass']);
  assert.deepEqual([...vault.policies.keys()].sort(), [...VAULT_POLICIES].sort());
  assert.deepEqual([...vault.appRoles.keys()].sort(), [...VAULT_APPROLES].sort());
  assert.deepEqual([...run.files.keys()].sort(), [
    '/out/approle/back.json', '/out/approle/backup.json', '/out/approle/migrate.json', '/out/unseal/unseal-key',
  ]);
  assert.equal(run.files.get('/out/unseal/unseal-key'), `${vault.unsealKey}\n`);
  assert.deepEqual(JSON.parse(run.files.get('/out/approle/back.json') ?? ''), vault.appRoles.get('back'));
  for (const login of DATABASE_LOGIN_NAMES) {
    assert.match(String(vault.kv.get(`secrets/logins/${login}`)?.value), /^[0-9a-f]{64}$/u, login);
  }
  assert.match(String(vault.kv.get('secrets/back/operator-api-token')?.value), /^[0-9a-f]{64}$/u);
  const operator = vault.users.get('operator');
  assert.equal(operator?.policy, 'operator');
  assert.equal(vault.isRevoked(vault.rootToken), true);
  const lines = run.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    service: 'vault-setup', event: 'vault.initialized', approles: ['back', 'migrate', 'backup'], logins: 9,
  });
  assert.equal(lines[1], `operator password, shown once (store it in your password manager): ${operator?.password ?? ''}`);
  for (const value of [
    vault.unsealKey, vault.rootToken, vault.appRoles.get('back')?.secret_id ?? '',
    String(vault.kv.get('secrets/logins/sol_live')?.value),
  ]) {
    assert.equal(`${run.stdout}${run.stderr}`.includes(value), false);
  }
});

void test('an initialized Vault is refused before any change', async () => {
  const vault = new FakeVault();
  const run = await setup(vault);
  assert.equal(run.code, 78);
  assert.equal(run.stderr, 'vault-setup: Vault is already initialized; nothing changed\n');
  assert.equal(run.files.size, 0);
  assert.deepEqual(vault.requests, ['GET sys/seal-status']);
});

void test('a missing policy file stops the setup before any request', async () => {
  const vault = freshVault();
  const run = await setup(vault, { missingPolicy: 'backup' });
  assert.equal(run.code, 78);
  assert.equal(run.stderr, 'vault-setup: missing policy file /etc/sol/vault/policies/backup.hcl\n');
  assert.deepEqual(vault.requests, []);
});

void test('the unseal key is saved before a later failure, and the message says so', async () => {
  const vault = freshVault();
  const failing: VaultFetch = async (url, init) => {
    if (url.endsWith('/v1/sys/mounts/sol')) throw new TypeError('fetch failed');
    return vault.fetch(url, init);
  };
  const run = await setup(vault, { fetch: failing });
  assert.equal(run.code, 69);
  assert.deepEqual([...run.files.keys()], ['/out/unseal/unseal-key']);
  assert.equal(
    run.stderr,
    'vault-setup: Vault unavailable (vault POST sys/mounts/sol: unreachable); the unseal key is saved: start over as the runbook says\n',
  );
});

void test('usage errors exit 64', async () => {
  const errors: string[] = [];
  const code = await runVaultSetupCli([], {}, { stdout: () => undefined, stderr: (text) => { errors.push(text); } });
  assert.equal(code, 64);
  assert.deepEqual(errors, ['usage: vault-setup init\n']);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx tsx --test tests/deploy-vault-setup.test.ts tests/deploy-vault-container.test.ts`
Expected: FAIL, `Cannot find module '../scripts/deploy/vault-setup.js'`.

- [ ] **Step 4: Write the command**

Create `scripts/deploy/vault-setup.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATABASE_LOGIN_NAMES } from '../../src/deploy/stack.js';
import {
  VaultClient,
  VaultDeniedError,
  VaultMissingError,
  VaultUnavailableError,
  type VaultFetch,
} from '../../src/deploy/vault-client.js';
import { VAULT_MOUNT } from '../../src/deploy/vault-layout.js';

export const VAULT_POLICIES = Object.freeze(['back', 'migrate', 'backup', 'operator'] as const);
export const VAULT_APPROLES = Object.freeze(['back', 'migrate', 'backup'] as const);

export interface VaultSetupIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface VaultSetupDependencies {
  readonly fetch?: VaultFetch | undefined;
  readonly readFile: (path: string) => string;
  /** Owner-only parent directory and file; never overwrites an existing file. */
  readonly writeSecretFile: (path: string, content: string) => void;
  readonly random: (bytes: number) => Buffer;
}

export function writeSecretFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

const NODE_DEPENDENCIES: VaultSetupDependencies = Object.freeze({
  readFile: (path: string) => readFileSync(path, 'utf8'),
  writeSecretFile,
  random: (bytes: number) => randomBytes(bytes),
});

class SetupFileError extends Error {}

/**
 * `vault-setup init` runs once, from deploy/host/vault-init.sh, in the `vault-setup` tools
 * container (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 8.1). It initializes Vault
 * with one key share and saves the unseal key first, then:
 * - unseals Vault and enables `sol/` (KV v2), AppRole and userpass;
 * - loads the four policies, creates the three AppRoles and writes their files;
 * - generates the nine login passwords and the operator API token in Vault;
 * - creates the `operator` login, prints its password once and revokes the root token.
 * Files go under SOL_VAULT_OUT_DIR (/out): `unseal/unseal-key`, `approle/<name>.json`.
 * Exit codes: 0; 64 usage; 69 Vault unavailable; 77 refused; 78 Vault already initialized or a
 * policy file missing; 1 any other failure.
 */
export async function runVaultSetupCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: VaultSetupIo,
  dependencies: VaultSetupDependencies = NODE_DEPENDENCIES,
): Promise<number> {
  if (argv.length !== 1 || argv[0] !== 'init') {
    io.stderr('usage: vault-setup init\n');
    return 64;
  }
  const out = environment.SOL_VAULT_OUT_DIR ?? '/out';
  const policiesDirectory = environment.SOL_VAULT_POLICIES_DIR ?? '/etc/sol/vault/policies';
  const client = new VaultClient({
    address: environment.VAULT_ADDR ?? 'http://vault:8200', fetch: dependencies.fetch,
  });
  let unsealKeySaved = false;
  try {
    const policies = VAULT_POLICIES.map((name) => [
      name, readPolicy(dependencies, `${policiesDirectory}/${name}.hcl`),
    ] as const);
    if ((await client.sealStatus()).initialized) {
      io.stderr('vault-setup: Vault is already initialized; nothing changed\n');
      return 78;
    }
    const { unsealKey, rootToken } = await client.initialize();
    dependencies.writeSecretFile(`${out}/unseal/unseal-key`, `${unsealKey}\n`);
    unsealKeySaved = true;
    await client.unseal(unsealKey);
    await client.enableKv2(rootToken, VAULT_MOUNT);
    await client.enableAuth(rootToken, 'approle');
    await client.enableAuth(rootToken, 'userpass');
    for (const [name, policy] of policies) await client.putPolicy(rootToken, name, policy);
    for (const name of VAULT_APPROLES) {
      const credentials = await client.createAppRole(rootToken, name);
      dependencies.writeSecretFile(`${out}/approle/${name}.json`, `${JSON.stringify(credentials)}\n`);
    }
    for (const login of DATABASE_LOGIN_NAMES) {
      await client.writeKv(rootToken, `secrets/logins/${login}`, { value: dependencies.random(32).toString('hex') });
    }
    await client.writeKv(rootToken, 'secrets/back/operator-api-token', {
      value: dependencies.random(32).toString('hex'),
    });
    const operatorPassword = dependencies.random(24).toString('base64url');
    await client.createUser(rootToken, 'operator', operatorPassword, 'operator');
    await client.revokeSelf(rootToken);
    io.stdout(`${JSON.stringify({
      service: 'vault-setup', event: 'vault.initialized',
      approles: VAULT_APPROLES, logins: DATABASE_LOGIN_NAMES.length,
    })}\n`);
    io.stdout(`operator password, shown once (store it in your password manager): ${operatorPassword}\n`);
    return 0;
  } catch (error) {
    const tail = unsealKeySaved ? '; the unseal key is saved: start over as the runbook says' : '';
    if (error instanceof SetupFileError) {
      io.stderr(`vault-setup: ${error.message}\n`);
      return 78;
    }
    if (error instanceof VaultUnavailableError) {
      io.stderr(`vault-setup: Vault unavailable (${error.message})${tail}\n`);
      return 69;
    }
    if (error instanceof VaultDeniedError || error instanceof VaultMissingError) {
      io.stderr(`vault-setup: refused by Vault (${error.message})${tail}\n`);
      return 77;
    }
    io.stderr(`vault-setup: setup failed${tail}\n`);
    return 1;
  }
}

function readPolicy(dependencies: VaultSetupDependencies, path: string): string {
  try {
    return dependencies.readFile(path);
  } catch {
    throw new SetupFileError(`missing policy file ${path}`);
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runVaultSetupCli(process.argv.slice(2), process.env, {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test tests/deploy-vault-setup.test.ts tests/deploy-vault-container.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Check types and lint, then commit**

```bash
npx tsc -p tsconfig.json --noEmit && npm run lint:backend
git add deploy/vault/policies scripts/deploy/vault-setup.ts tests/deploy-vault-setup.test.ts tests/deploy-vault-container.test.ts
git commit -m "feat(deploy): vault-setup initializes Vault once, with four least-privilege policies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 6: `vault-import` and `vault-snapshot`

**Files:**
- Create: `scripts/deploy/vault-import.ts`, `scripts/deploy/vault-snapshot.ts`
- Test: `tests/deploy-vault-import.test.ts`, `tests/deploy-vault-snapshot.test.ts`

- [ ] **Step 1: Write the failing import tests**

Create `tests/deploy-vault-import.test.ts`:

```ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runVaultImportCli } from '../scripts/deploy/vault-import.js';
import { FakeVault } from './helpers/fake-vault.js';

const PASSWORD = 'operator-password-0123456789';

function operatorVault(): FakeVault {
  const vault = new FakeVault();
  vault.users.set('operator', Object.freeze({ password: PASSWORD, policy: 'operator' }));
  return vault;
}

async function withSource(files: Readonly<Record<string, string>>, body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'vault-import-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), content);
    }
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function importInto(vault: FakeVault, directory: string, input: string, environment: NodeJS.ProcessEnv = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runVaultImportCli([], { SOL_IMPORT_DIR: directory, ...environment }, input, {
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
  }, { fetch: vault.fetch, exists: (path) => existsSync(path), readFile: (path) => readFileSync(path, 'utf8') });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

const SOURCE = Object.freeze({
  'env/listener.env': [
    'API_HOST=127.0.0.1', 'LOG_LEVEL=info', 'DATABASE_URL=postgresql://u:p@h/db',
    'SOLANA_HTTP_RPC_URL=https://rpc.invalid/?api-key=listener-key',
    'SOLANA_WS_RPC_URL=wss://rpc.invalid/?api-key=listener-key', '',
  ].join('\n'),
  'env/live.env': 'EXECUTOR_PHASE=CANARY\nSOLANA_HTTP_RPC_URL="https://exec.invalid/?api-key=executor-key"\nEXECUTOR_KEYPAIR_PATH=/host/keypair.json\n',
  'env/operations.env': 'EXECUTOR_PREFLIGHT_EVIDENCE_PATH=/Users/me/lot5/evidence/bundle/qualification.json\n',
  'templates/retention.env.example': 'RETENTION_HOURS=4\n',
  'templates/listener.env.example': 'API_HOST=template\n',
  'keys/wallet-keypair.json': '[1,2,3]\n',
});

void test('the import maps role files, key files and templates into Vault and prints only names', async () => {
  await withSource(SOURCE, async (directory) => {
    const vault = operatorVault();
    const run = await importInto(vault, directory, `${PASSWORD}\n`, { SOL_IMPORT_EVIDENCE_PREFIX: '/Users/me/lot5/evidence' });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(vault.kv.get('config/listener'), { API_HOST: '0.0.0.0', API_PORT: '3000', LOG_LEVEL: 'info' });
    assert.deepEqual(vault.kv.get('config/live'), { EXECUTOR_PHASE: 'CANARY' });
    assert.deepEqual(vault.kv.get('config/operations'), {
      EXECUTOR_PREFLIGHT_EVIDENCE_PATH: '/var/lib/sol/evidence/bundle/qualification.json',
    });
    assert.deepEqual(vault.kv.get('config/retention'), { RETENTION_HOURS: '4' });
    assert.deepEqual(vault.kv.get('secrets/back/helius-listener-http-url'), { value: 'https://rpc.invalid/?api-key=listener-key' });
    assert.deepEqual(vault.kv.get('secrets/back/helius-executor-http-url'), { value: 'https://exec.invalid/?api-key=executor-key' });
    assert.deepEqual(vault.kv.get('secrets/back/wallet-keypair.json'), { value: '[1,2,3]\n' });
    assert.deepEqual(JSON.parse(run.stdout), {
      service: 'vault-import', event: 'vault.imported',
      configs: ['listener', 'live', 'operations'], templates: ['retention'],
      secrets: ['helius-listener-http-url', 'helius-listener-ws-url', 'helius-executor-http-url', 'wallet-keypair.json'],
    });
    for (const value of ['listener-key', 'executor-key', '[1,2,3]', PASSWORD]) {
      assert.equal(`${run.stdout}${run.stderr}`.includes(value), false, value);
    }
    assert.ok(vault.issuedTokens().length === 1 && vault.isRevoked(vault.issuedTokens()[0] ?? ''));
  });
});

void test('an invalid source is refused before the login, with nothing written', async () => {
  for (const [file, content, message] of [
    ['env/listener.env', 'SOLANA_HTTP_RPC_URL=http://insecure.invalid\n', 'vault-import: listener.env: SOLANA_HTTP_RPC_URL must be one https URL\n'],
    ['env/listener.env', 'API_TOKEN=x\n', 'vault-import: config/listener: API_TOKEN comes from a secret file, not from the configuration\n'],
    ['keys/wallet-keypair.json', ' \n', 'vault-import: keys/wallet-keypair.json is empty\n'],
  ] as const) {
    await withSource({ [file]: content }, async (directory) => {
      const vault = operatorVault();
      const run = await importInto(vault, directory, `${PASSWORD}\n`);
      assert.equal(run.code, 78, file);
      assert.equal(run.stderr, message);
      assert.equal(vault.kv.size, 0);
      assert.deepEqual(vault.requests, []);
    });
  }
  await withSource({}, async (directory) => {
    const run = await importInto(operatorVault(), directory, `${PASSWORD}\n`);
    assert.equal(run.code, 78);
    assert.equal(run.stderr, `vault-import: nothing to import under ${directory}\n`);
  });
});

void test('a wrong password exits 77, a sealed Vault 69, and usage errors 64', async () => {
  await withSource(SOURCE, async (directory) => {
    const vault = operatorVault();
    const refused = await importInto(vault, directory, 'wrong-password\n');
    assert.equal(refused.code, 77);
    assert.equal(refused.stderr, 'vault-import: refused by Vault (vault POST auth/userpass/login/operator: HTTP 400)\n');
    assert.equal(vault.kv.size, 0);
    vault.sealed = true;
    assert.equal((await importInto(vault, directory, `${PASSWORD}\n`)).code, 69);
    assert.equal((await importInto(vault, directory, '\n')).code, 64);
  });
});
```

- [ ] **Step 2: Write the failing snapshot tests**

Create `tests/deploy-vault-snapshot.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runVaultSnapshotCli } from '../scripts/deploy/vault-snapshot.js';
import { FakeVault } from './helpers/fake-vault.js';

async function snapshot(vault: FakeVault, input: string, argv: readonly string[] = []) {
  const chunks: Uint8Array[] = [];
  const stderr: string[] = [];
  const code = await runVaultSnapshotCli(argv, {}, input, async (chunk) => { chunks.push(chunk); }, {
    stderr: (text) => { stderr.push(text); },
  }, vault.fetch);
  return { code, bytes: Buffer.concat(chunks), stderr: stderr.join('') };
}

void test('the backup AppRole streams the raft snapshot to the output, then revokes its token', async () => {
  const vault = new FakeVault();
  const run = await snapshot(vault, `${JSON.stringify(vault.addAppRole('backup'))}\n`);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual([...run.bytes], [...vault.snapshotBytes]);
  assert.ok(vault.issuedTokens().length === 1 && vault.isRevoked(vault.issuedTokens()[0] ?? ''));
});

void test('another AppRole is refused, a sealed Vault is unavailable, bad input is a usage error', async () => {
  const vault = new FakeVault();
  const back = await snapshot(vault, JSON.stringify(vault.addAppRole('back')));
  assert.equal(back.code, 77);
  assert.equal(back.stderr, 'vault-snapshot: refused by Vault (vault GET sys/storage/raft/snapshot: HTTP 403)\n');
  assert.equal(back.bytes.length, 0);
  const invalid = await snapshot(vault, 'not json');
  assert.equal(invalid.code, 78);
  assert.equal(invalid.stderr, 'vault-snapshot: expected the backup AppRole JSON on stdin\n');
  vault.sealed = true;
  assert.equal((await snapshot(vault, JSON.stringify(vault.addAppRole('backup')))).code, 69);
  assert.equal((await snapshot(vault, '{}', ['extra'])).code, 64);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx tsx --test tests/deploy-vault-import.test.ts tests/deploy-vault-snapshot.test.ts`
Expected: FAIL, `Cannot find module '../scripts/deploy/vault-import.js'` and `'../scripts/deploy/vault-snapshot.js'`.

- [ ] **Step 4: Write `vault-import`**

Create `scripts/deploy/vault-import.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse } from 'dotenv';
import { INJECTED_KEYS, RoleEnvironmentError } from '../../src/deploy/role-environment.js';
import {
  VaultClient,
  VaultDeniedError,
  VaultMissingError,
  VaultUnavailableError,
  type VaultFetch,
} from '../../src/deploy/vault-client.js';
import { CONFIG_NAMES, VaultLayoutError, renderConfig, type ConfigName } from '../../src/deploy/vault-layout.js';

/** The back's URL secrets and the role-file variable each one comes from (the runbook's former copies). */
const URL_SECRETS = Object.freeze([
  { secret: 'helius-listener-http-url', source: 'listener', variable: 'SOLANA_HTTP_RPC_URL', protocol: 'https:' },
  { secret: 'helius-listener-ws-url', source: 'listener', variable: 'SOLANA_WS_RPC_URL', protocol: 'wss:' },
  { secret: 'helius-executor-http-url', source: 'live', variable: 'SOLANA_HTTP_RPC_URL', protocol: 'https:' },
] as const);
/** Key files that deploy/host/vault-import.sh mounts under /import/keys. */
const KEY_FILES = Object.freeze(['helius-admin-api-key', 'evidence-private-key', 'wallet-keypair.json'] as const);
/** Bindings the stack needs whatever the source says (plan deviation 5). */
const STACK_BINDINGS: Readonly<Partial<Record<ConfigName, Readonly<Record<string, string>>>>> = Object.freeze({
  listener: Object.freeze({ API_HOST: '0.0.0.0', API_PORT: '3000' }),
  'operator-api': Object.freeze({ OPERATOR_API_HOST: '0.0.0.0', OPERATOR_API_PORT: '3100' }),
});
const EVIDENCE_DIRECTORY = '/var/lib/sol/evidence';

export interface VaultImportIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface VaultImportDependencies {
  readonly fetch?: VaultFetch | undefined;
  readonly exists: (path: string) => boolean;
  readonly readFile: (path: string) => string;
}

const NODE_DEPENDENCIES: VaultImportDependencies = Object.freeze({
  exists: (path: string) => existsSync(path),
  readFile: (path: string) => readFileSync(path, 'utf8'),
});

class ImportSourceError extends Error {}

interface ImportPlan {
  readonly writes: readonly (readonly [string, Readonly<Record<string, string>>])[];
  readonly configs: readonly string[];
  readonly templates: readonly string[];
  readonly secrets: readonly string[];
}

/**
 * `vault-import` runs from deploy/host/vault-import.sh in the `vault-import` tools container
 * (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 8.2, and plan deviation 5).
 * It reads the operator password on stdin and three sources under SOL_IMPORT_DIR:
 * - `env/`: the role files, in the lot5 layout;
 * - `keys/`: the key files;
 * - `templates/`: the repository templates.
 * Every entry is validated before the first write, and no value is printed.
 * Exit codes: 0; 64 usage; 69 Vault unavailable; 77 operator login refused; 78 invalid source.
 */
export async function runVaultImportCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  input: string,
  io: VaultImportIo,
  dependencies: VaultImportDependencies = NODE_DEPENDENCIES,
): Promise<number> {
  const password = (input.split('\n')[0] ?? '').replace(/\r$/u, '');
  if (argv.length !== 0 || password === '') {
    io.stderr('usage: vault-import < operator password\n');
    return 64;
  }
  try {
    const plan = planImport(
      environment.SOL_IMPORT_DIR ?? '/import', environment.SOL_IMPORT_EVIDENCE_PREFIX ?? '', dependencies,
    );
    const client = new VaultClient({
      address: environment.VAULT_ADDR ?? 'http://vault:8200', fetch: dependencies.fetch,
    });
    const token = await client.userpassLogin('operator', password);
    try {
      for (const [path, data] of plan.writes) await client.writeKv(token, path, data);
    } finally {
      await client.revokeSelf(token).catch(() => undefined);
    }
    io.stdout(`${JSON.stringify({
      service: 'vault-import', event: 'vault.imported',
      configs: plan.configs, templates: plan.templates, secrets: plan.secrets,
    })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ImportSourceError || error instanceof VaultLayoutError || error instanceof RoleEnvironmentError) {
      io.stderr(`vault-import: ${error.message}\n`);
      return 78;
    }
    if (error instanceof VaultUnavailableError) {
      io.stderr(`vault-import: Vault unavailable (${error.message})\n`);
      return 69;
    }
    if (error instanceof VaultDeniedError || error instanceof VaultMissingError) {
      io.stderr(`vault-import: refused by Vault (${error.message})\n`);
      return 77;
    }
    io.stderr('vault-import: import failed\n');
    return 1;
  }
}

function planImport(directory: string, evidencePrefix: string, dependencies: VaultImportDependencies): ImportPlan {
  const writes: (readonly [string, Readonly<Record<string, string>>])[] = [];
  const configs: string[] = [];
  const templates: string[] = [];
  const secrets: string[] = [];
  const roleFiles = new Map<ConfigName, Readonly<Record<string, string>>>();
  for (const name of CONFIG_NAMES) {
    const own = `${directory}/env/${name}.env`;
    const template = `${directory}/templates/${name}.env.example`;
    const fromOwn = dependencies.exists(own);
    if (!fromOwn && !dependencies.exists(template)) continue;
    const parsed = parse(dependencies.readFile(fromOwn ? own : template));
    if (fromOwn) roleFiles.set(name, parsed);
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (INJECTED_KEYS.has(key)) continue;
      data[key] = evidencePrefix !== '' && value.startsWith(evidencePrefix)
        ? `${EVIDENCE_DIRECTORY}${value.slice(evidencePrefix.length)}`
        : value;
    }
    Object.assign(data, STACK_BINDINGS[name] ?? {});
    renderConfig(name, data);
    writes.push([`config/${name}`, Object.freeze(data)]);
    (fromOwn ? configs : templates).push(name);
  }
  for (const entry of URL_SECRETS) {
    const value = roleFiles.get(entry.source)?.[entry.variable];
    if (value === undefined || value === '') continue;
    if (!isUrl(value, entry.protocol)) {
      throw new ImportSourceError(
        `${entry.source}.env: ${entry.variable} must be one ${entry.protocol.slice(0, -1)} URL`,
      );
    }
    writes.push([`secrets/back/${entry.secret}`, Object.freeze({ value })]);
    secrets.push(entry.secret);
  }
  for (const file of KEY_FILES) {
    const path = `${directory}/keys/${file}`;
    if (!dependencies.exists(path)) continue;
    const value = dependencies.readFile(path);
    if (value.trim() === '') throw new ImportSourceError(`keys/${file} is empty`);
    writes.push([`secrets/back/${file}`, Object.freeze({ value })]);
    secrets.push(file);
  }
  if (writes.length === 0) throw new ImportSourceError(`nothing to import under ${directory}`);
  return Object.freeze({ writes, configs, templates, secrets });
}

function isUrl(value: string, protocol: string): boolean {
  if (/\s/u.test(value)) return false;
  try {
    return new URL(value).protocol === protocol;
  } catch {
    return false;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runVaultImportCli(process.argv.slice(2), process.env, readFileSync(0, 'utf8'), {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}
```

- [ ] **Step 5: Write `vault-snapshot`**

Create `scripts/deploy/vault-snapshot.ts`:

```ts
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  VaultClient,
  VaultDeniedError,
  VaultMissingError,
  VaultUnavailableError,
  parseAppRoleCredentials,
  type AppRoleCredentials,
  type VaultFetch,
} from '../../src/deploy/vault-client.js';

/**
 * `vault-snapshot` runs from deploy/host/backup.sh in the `vault-snapshot` tools container
 * (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 8.4). It reads the backup AppRole
 * JSON on stdin and writes Vault's raft snapshot (gzip) to stdout.
 * Exit codes: 0; 64 usage; 69 Vault unavailable; 77 refused; 78 invalid AppRole JSON.
 */
export async function runVaultSnapshotCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  input: string,
  output: (chunk: Uint8Array) => Promise<void>,
  io: Readonly<{ stderr: (text: string) => void }>,
  fetchImpl?: VaultFetch,
): Promise<number> {
  if (argv.length !== 0) {
    io.stderr('usage: vault-snapshot < backup AppRole JSON > snapshot\n');
    return 64;
  }
  let credentials: AppRoleCredentials;
  try {
    credentials = parseAppRoleCredentials(input);
  } catch {
    io.stderr('vault-snapshot: expected the backup AppRole JSON on stdin\n');
    return 78;
  }
  const client = new VaultClient({ address: environment.VAULT_ADDR ?? 'http://vault:8200', fetch: fetchImpl });
  try {
    const token = await client.appRoleLogin(credentials);
    try {
      const reader = (await client.snapshot(token)).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await output(value);
      }
    } finally {
      await client.revokeSelf(token).catch(() => undefined);
    }
    return 0;
  } catch (error) {
    if (error instanceof VaultUnavailableError) {
      io.stderr(`vault-snapshot: Vault unavailable (${error.message})\n`);
      return 69;
    }
    if (error instanceof VaultDeniedError || error instanceof VaultMissingError) {
      io.stderr(`vault-snapshot: refused by Vault (${error.message})\n`);
      return 77;
    }
    io.stderr('vault-snapshot: snapshot failed\n');
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runVaultSnapshotCli(
    process.argv.slice(2),
    process.env,
    readFileSync(0, 'utf8'),
    async (chunk) => new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, (error) => { if (error === null || error === undefined) resolve(); else reject(error); });
    }),
    { stderr: (text) => { process.stderr.write(text); } },
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test tests/deploy-vault-import.test.ts tests/deploy-vault-snapshot.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Check types and lint, then commit**

```bash
npx tsc -p tsconfig.json --noEmit && npm run lint:backend
git add scripts/deploy/vault-import.ts scripts/deploy/vault-snapshot.ts tests/deploy-vault-import.test.ts tests/deploy-vault-snapshot.test.ts
git commit -m "feat(deploy): vault-import and vault-snapshot tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 7: The vault image

**Files:**
- Create: `deploy/vault/vault.hcl`, `deploy/vault/vault-entrypoint` (mode 0755)
- Modify: `Dockerfile` (new last stage `vault`)
- Test: `tests/deploy-vault-container.test.ts`, `tests/deployment-artifacts.test.ts` (« Dockerfile pins reviewed images… »)

- [ ] **Step 1: Write the failing tests**

Append to `tests/deploy-vault-container.test.ts`, and add `import { spawnSync } from 'node:child_process';` to its imports:

```ts
void test('the vault entrypoint unseals from the key file without ever exposing the key', async () => {
  const entrypoint = await artifact('deploy/vault/vault-entrypoint');
  assert.ok(entrypoint.startsWith('#!/bin/sh\n'));
  const syntax = spawnSync('sh', ['-n'], { input: entrypoint, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  for (const line of [
    'key_file=/run/vault/unseal-key',
    `*'"initialized":false'*)`,
    `  if printf '{"key":"%s"}' "$(head -n 1 "$key_file")" \\`,
    '    | wget -q -O /dev/null --post-file=/dev/stdin "$api/v1/sys/unseal"; then',
    'su-exec vault vault server -config=/vault/config/vault.hcl &',
    `trap 'kill -TERM "$server" 2> /dev/null || true' TERM INT`,
    'unseal_when_ready || true',
    'wait "$server" || status=$?',
  ]) {
    assert.ok(entrypoint.includes(line), line);
  }
  // The key reaches wget through a pipe only; the shell that execs Vault would leave a zombie.
  assert.doesNotMatch(entrypoint, /echo[^\n]*head|export [A-Z_]*KEY|vault operator unseal|exec su-exec/u);
});

void test('the vault server keeps raft on its volume and listens inside the Docker networks only', async () => {
  const config = await artifact('deploy/vault/vault.hcl');
  for (const line of [
    'ui            = true',
    'disable_mlock = true',
    'api_addr      = "http://vault:8200"',
    'cluster_addr  = "http://vault:8201"',
    '  path    = "/vault/file"',
    '  node_id = "sol-vault"',
    '  address     = "0.0.0.0:8200"',
    '  tls_disable = true',
  ]) {
    assert.ok(config.includes(`${line}\n`), line);
  }
});
```

In `tests/deployment-artifacts.test.ts`, after the `postgresImage` constant, add:

```ts
const vaultImage =
  'hashicorp/vault:2.1.2@sha256:c2f666266f383d2cf424d86b8bb8ce7d065562173ffec2b476d762943608bb55';
```

In the test « Dockerfile pins reviewed images and builds exact workspace artifacts », add `[vaultImage, 'vault'],` as the last row of the expected `fromLines`, and append at the end of the test:

```ts
  const vault = stage(dockerfile, 'vault');
  assert.match(vault, /^USER root$/m);
  assert.match(vault, /^ENV VAULT_ADDR=http:\/\/127\.0\.0\.1:8200$/m);
  assert.match(vault, /^COPY deploy\/vault\/vault\.hcl \/vault\/config\/vault\.hcl$/m);
  assert.match(vault, /^COPY --chmod=0755 deploy\/vault\/vault-entrypoint \/usr\/local\/bin\/vault-entrypoint$/m);
  assert.match(vault, /^EXPOSE 8200$/m);
  assert.match(vault, /^ENTRYPOINT \["vault-entrypoint"\]$/m);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test tests/deploy-vault-container.test.ts tests/deployment-artifacts.test.ts`
Expected: FAIL on the missing `deploy/vault/vault-entrypoint`, `deploy/vault/vault.hcl` and Docker stage `vault`.

- [ ] **Step 3: Write the server configuration and the entrypoint**

Create `deploy/vault/vault.hcl`:

```hcl
# Vault server of the stack (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 5): one
# node, integrated storage on the vault-data volume, HTTP inside the Docker networks only.
ui            = true
disable_mlock = true
api_addr      = "http://vault:8200"
cluster_addr  = "http://vault:8201"

storage "raft" {
  path    = "/vault/file"
  node_id = "sol-vault"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}
```

Create `deploy/vault/vault-entrypoint` and `chmod 0755` it:

```sh
#!/bin/sh
# Entrypoint of the vault container (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 5):
# starts Vault as the image's `vault` user and, once Vault is initialized, unseals it with the
# host key file. Only this root shell reads the key: printf is a shell builtin and wget takes the
# request body on stdin, so the key never enters argv, the environment or the logs. The shell
# stays the parent of Vault and of the unseal job, so it reaps both and forwards TERM.
set -eu
key_file=/run/vault/unseal-key
api=http://127.0.0.1:8200

unseal_when_ready() {
  tries=0
  until seal="$(wget -q -O- "$api/v1/sys/seal-status" 2> /dev/null)"; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      echo '{"service":"vault-entrypoint","event":"vault.api_unavailable"}' >&2
      return 1
    fi
    sleep 1
  done
  case "$seal" in
    *'"initialized":false'*)
      echo '{"service":"vault-entrypoint","event":"vault.uninitialized"}'
      return 0 ;;
    *'"sealed":false'*) return 0 ;;
  esac
  if [ ! -s "$key_file" ]; then
    echo '{"service":"vault-entrypoint","event":"vault.unseal_key_missing"}' >&2
    return 1
  fi
  if printf '{"key":"%s"}' "$(head -n 1 "$key_file")" \
    | wget -q -O /dev/null --post-file=/dev/stdin "$api/v1/sys/unseal"; then
    echo '{"service":"vault-entrypoint","event":"vault.unsealed"}'
  else
    echo '{"service":"vault-entrypoint","event":"vault.unseal_failed"}' >&2
    return 1
  fi
}

su-exec vault vault server -config=/vault/config/vault.hcl &
server=$!
trap 'kill -TERM "$server" 2> /dev/null || true' TERM INT
unseal_when_ready || true
status=0
wait "$server" || status=$?
if [ "$status" -gt 128 ]; then
  # A signal interrupted wait: let Vault finish its own shutdown.
  status=0
  wait "$server" || status=$?
fi
exit "$status"
```

- [ ] **Step 4: Add the Docker stage**

Append to `Dockerfile`, after the `frontend` stage:

```Dockerfile

FROM hashicorp/vault:2.1.2@sha256:c2f666266f383d2cf424d86b8bb8ce7d065562173ffec2b476d762943608bb55 AS vault

# vault-entrypoint starts as root to read the unseal key, then runs Vault as the image's vault
# user (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 5).
USER root
ENV VAULT_ADDR=http://127.0.0.1:8200
COPY deploy/vault/vault.hcl /vault/config/vault.hcl
COPY --chmod=0755 deploy/vault/vault-entrypoint /usr/local/bin/vault-entrypoint

EXPOSE 8200

ENTRYPOINT ["vault-entrypoint"]
CMD []
```

- [ ] **Step 5: Run the tests and build the image**

Run: `npx tsx --test tests/deploy-vault-container.test.ts tests/deployment-artifacts.test.ts`
Expected: PASS.

Run: `docker build --target vault -t sol-vault-plan-check . && docker image rm sol-vault-plan-check`
Expected: the build succeeds.

- [ ] **Step 6: Commit**

```bash
git add deploy/vault/vault.hcl deploy/vault/vault-entrypoint Dockerfile tests/deploy-vault-container.test.ts tests/deployment-artifacts.test.ts
git commit -m "feat(deploy): vault image with raft storage and automatic unseal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 8: Back and migrate read Vault at boot

**Files:**
- Modify: `deploy/back/bin/sol-entrypoint`, `deploy/back/bin/sol-admin`, `Dockerfile` (backend stage)
- Test: `tests/deploy-back-container.test.ts`, `tests/deployment-artifacts.test.ts` (« backend image ships compiled artifacts… »)

- [ ] **Step 1: Update the tests first**

In `tests/deploy-back-container.test.ts`, test « the entrypoint distributes secrets and applies the boot entry-stop before supervisord », insert this marker before the `distribute-secrets.js` one:

```ts
    'node /app/dist/scripts/deploy/vault-pull.js back "$mode"',
```

Then append this test:

```ts
void test('sol-admin migrate reads the login passwords from Vault before migrating', async () => {
  const solAdmin = await artifact('deploy/back/bin/sol-admin');
  assertOrder(solAdmin, [
    '  migrate)\n',
    '    node /app/dist/scripts/deploy/vault-pull.js migrate\n',
    '    exec node /app/dist/scripts/deploy/admin-database.js migrate ;;\n',
    '  group-roles)\n',
    '    exec node /app/dist/scripts/deploy/admin-database.js group-roles ;;\n',
    '  report)\n',
  ]);
});
```

In `tests/deployment-artifacts.test.ts`, test « backend image ships compiled artifacts… », append `'COPY deploy/vault/policies/ /etc/sol/vault/policies/',` at the end of the expected `copies`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test tests/deploy-back-container.test.ts tests/deployment-artifacts.test.ts`
Expected: FAIL on the three new expectations.

- [ ] **Step 3: Wire the entrypoint**

In `deploy/back/bin/sol-entrypoint`, replace the header comment and the distribution line:

```sh
#!/bin/sh
# Entrypoint of the back container (root): read the variables of SOL_STACK_MODE from Vault into
# tmpfs, distribute the secrets into /run/sol, select the programs, apply the boot entry-stop in
# live mode, then run supervisord.
```

```sh
printf '%s\n' "$mode" > /run/sol/mode
# Without Vault the container stops here: never a fallback to host files (Vault spec 7.3).
node /app/dist/scripts/deploy/vault-pull.js back "$mode"
node /app/dist/scripts/deploy/distribute-secrets.js "$mode"
```

- [ ] **Step 4: Wire `sol-admin`**

Replace `deploy/back/bin/sol-admin` with:

```sh
#!/bin/sh
# Administrator commands of the migrate container (root; the admin password lives only here):
#   sol-admin migrate       login passwords from Vault, then migrations, provisioning replay and
#                           the nine logins (default command)
#   sol-admin group-roles   the NOLOGIN group roles only, before a pg_restore
#   sol-admin report        fast-path report as the administrator, run as the node user
set -eu
command="${1:-}"
[ "$#" -eq 0 ] || shift
case "$command" in
  migrate)
    node /app/dist/scripts/deploy/vault-pull.js migrate
    exec node /app/dist/scripts/deploy/admin-database.js migrate ;;
  group-roles)
    exec node /app/dist/scripts/deploy/admin-database.js group-roles ;;
  report)
    DATABASE_URL="$(node /app/dist/scripts/deploy/admin-database.js url)"
    export DATABASE_URL
    exec setpriv --reuid=1000 --regid=1000 --clear-groups -- node /app/dist/src/cli/fast-path-report.js "$@" ;;
  *)
    echo 'usage: sol-admin migrate|group-roles|report' >&2
    exit 64 ;;
esac
```

- [ ] **Step 5: Ship the policies in the back image**

In the `backend` stage of `Dockerfile`, after `COPY deploy/back/supervisor/programs/ /etc/sol/programs/`, add:

```Dockerfile
# vault-setup loads the policies into Vault (deploy/host/vault-init.sh).
COPY deploy/vault/policies/ /etc/sol/vault/policies/
```

- [ ] **Step 6: Run the tests to verify they pass, then commit**

Run: `npx tsx --test tests/deploy-back-container.test.ts tests/deployment-artifacts.test.ts`
Expected: PASS.

```bash
git add deploy/back/bin/sol-entrypoint deploy/back/bin/sol-admin Dockerfile tests/deploy-back-container.test.ts tests/deployment-artifacts.test.ts
git commit -m "feat(deploy): back and migrate pull their entries from Vault at boot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 9: Compose topology with Vault

**Files:**
- Modify: `deploy/compose.yaml`, `deploy/env.example`
- Test: `tests/deployment-artifacts.test.ts` (the three Compose tests and the compose-input template test)

- [ ] **Step 1: Replace the static topology test**

In `tests/deployment-artifacts.test.ts`, replace the whole test « Compose defines postgres, migrate, back and front, with no published database or backend port » with:

```ts
void test('Compose defines postgres, vault, migrate, back, front and the Vault tools, publishing only the front and the local Vault UI', async () => {
  const [compose, server] = await Promise.all([
    readArtifact('deploy/compose.yaml'),
    readArtifact('deploy/compose.server.yaml'),
  ]);

  assert.match(compose, /^name: sol-token-listener$/m);
  const networksOffset = compose.indexOf('\nnetworks:');
  assert.notEqual(networksOffset, -1, 'missing networks section');
  const serviceNames = [...compose.slice(compose.indexOf('\nservices:'), networksOffset)
    .matchAll(/^ {2}([a-z][a-z-]*):\s*$/gm)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  const tools = ['vault-setup', 'vault-import', 'vault-snapshot'];
  assert.deepEqual(serviceNames, ['postgres', 'vault', 'migrate', 'back', 'front', ...tools]);
  assert.match(compose, new RegExp(`^    image: ${postgresImage.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  for (const service of ['migrate', 'back', ...tools]) {
    assert.match(composeService(compose, service), /^ {4}image: \$\{BACKEND_IMAGE:\?BACKEND_IMAGE is required\}$/m, service);
  }
  assert.match(composeService(compose, 'front'), /^ {4}image: \$\{FRONTEND_IMAGE:\?FRONTEND_IMAGE is required\}$/m);
  assert.match(composeService(compose, 'vault'), /^ {4}image: \$\{VAULT_IMAGE:\?VAULT_IMAGE is required\}$/m);
  for (const service of ['back', 'front', 'vault']) {
    assert.match(composeService(compose, service), /^ {4}build:\s*$/m, service);
  }
  assert.match(composeService(compose, 'vault'), /^ {6}target: vault$/m);
  for (const service of ['migrate', ...tools]) {
    assert.doesNotMatch(composeService(compose, service), /^ {4}build:\s*$/m, service);
  }

  assert.equal((compose.match(/^ {4}ports:/gm) ?? []).length, 2);
  assert.match(composeService(compose, 'front'), /^ {4}ports: \["127\.0\.0\.1:\$\{FRONT_PORT:-8080\}:8080"\]$/m);
  assert.match(composeService(compose, 'vault'), /^ {4}ports: \["127\.0\.0\.1:\$\{VAULT_PORT:-8200\}:8200"\]$/m);
  assert.match(server, /^ {4}ports: !override\n {6}- "80:80"\n {6}- "443:443"$/m);
  assert.match(server, /^ {6}SITE_ADDRESS: \$\{SITE_ADDRESS:\?SITE_ADDRESS is required on the server\}$/m);
  assert.doesNotMatch(server, /vault/u);

  const postgres = composeService(compose, 'postgres');
  const vault = composeService(compose, 'vault');
  const migrate = composeService(compose, 'migrate');
  const back = composeService(compose, 'back');
  const front = composeService(compose, 'front');
  assert.match(postgres, /^ {6}POSTGRES_USER: sol_owner$/m);
  assert.match(postgres, /^ {6}POSTGRES_PASSWORD_FILE: \/root\/secrets\/postgres-admin-password$/m);
  const approle = (name: string): string => [
    '      - type: bind\n',
    `        source: \${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/vault/approle/${name}.json\n`,
    '        target: /root/vault/approle.json\n',
    '        read_only: true\n',
  ].join('');
  for (const [service, mount] of [
    [postgres, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/db/postgres-admin-password:/root/secrets/postgres-admin-password:ro'],
    [vault, '      - vault-data:/vault/file'],
    [vault, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/vault/unseal:/run/vault:ro'],
    [migrate, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/db/postgres-admin-password:/root/secrets/db/postgres-admin-password:ro'],
    [migrate, approle('migrate')],
    [back, approle('back')],
    [back, '      - evidence:/var/lib/sol/evidence'],
    [front, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/front/front-basic-auth-hash:/root/secrets/front-basic-auth-hash:ro'],
    [composeService(compose, 'vault-setup'), '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/vault:/out'],
  ] as const) {
    assert.ok(service.includes(mount), `missing mount ${mount}`);
  }
  // Vault replaces the host directories of sub-project 1, and no bind creates a missing file.
  assert.doesNotMatch(compose, /SOL_HOST_DIR[^\n]*\/(?:secrets\/back|secrets\/db\/logins|config)\b|create_host_path: true/u);
  assert.match(migrate, /^ {4}tmpfs: \["\/root\/secrets\/db\/logins:mode=0700,size=1m"\]$/m);
  assert.match(back, /^ {4}tmpfs:\n {6}- \/run\/sol:mode=0711,size=16m\n {6}- \/root\/secrets:mode=0700,size=4m\n {6}- \/etc\/sol\/config:mode=0755,size=1m$/m);
  assert.match(migrate, /^ {4}command: \["sol-admin", "migrate"\]$/m);
  assert.match(back, /^ {4}command: \["sol-entrypoint"\]$/m);
  for (const service of [migrate, back]) {
    assert.match(service, /^ {6}SOL_VAULT_PULL_TIMEOUT_MS: \$\{SOL_VAULT_PULL_TIMEOUT_MS:-60000\}$/m);
  }
  assert.match(back, /^ {6}SOL_STACK_MODE: \$\{SOL_STACK_MODE:-observe\}$/m);
  assert.match(back, /^ {6}SOL_HEALTH_REQUIRE_OK: \$\{SOL_HEALTH_REQUIRE_OK:-true\}$/m);
  for (const service of [back, vault]) assert.match(service, /^ {4}init: true$/m);
  assert.match(back, /^ {4}stop_grace_period: 240s$/m);
  assert.match(compose, /^x-hardening: &hardening\n {2}security_opt: \["no-new-privileges:true"\]\n {2}cap_drop: \[NET_RAW, MKNOD\]\n {2}ulimits:\n {4}core: 0$/m);
  for (const service of [vault, migrate, back, ...tools.map((name) => composeService(compose, name))]) {
    assert.match(service, /^ {4}<<: \*hardening$/m);
  }
  // Caddy binds 80 and 443 as a non-root user through its file capability: no-new-privileges
  // would drop it. The front gets a CPU share instead, against bcrypt floods.
  assert.doesNotMatch(front, /hardening|no-new-privileges/u);
  assert.match(front, /^ {4}cpus: 0\.5$/m);
  assert.match(back, /^ {6}test: \["CMD", "sol-health"\]$/m);
  assert.match(vault, /^ {6}test: \["CMD", "vault", "status"\]$/m);
  for (const name of tools) {
    const tool = composeService(compose, name);
    assert.match(tool, /^ {4}profiles: \[tools\]$/m, name);
    assert.match(tool, new RegExp(`^ {4}entrypoint: \\["node", "/app/dist/scripts/deploy/${name}\\.js"\\]$`, 'm'), name);
    assert.match(tool, /^ {4}networks: \[internal\]$/m, name);
    assert.match(tool, /^ {4}restart: "no"$/m, name);
  }
  assert.match(composeService(compose, 'vault-setup'), /^ {4}command: \["init"\]$/m);

  assert.match(postgres, /^ {4}networks: \[internal\]$/m);
  assert.match(vault, /^ {4}networks: \[internal, vault-ui\]$/m);
  assert.match(migrate, /^ {4}networks: \[internal\]$/m);
  assert.match(back, /^ {4}networks: \[internal, egress, edge\]$/m);
  assert.match(front, /^ {4}networks: \[edge\]$/m);
  assert.match(compose, /^networks:\n {2}internal:\n {4}internal: true\n {2}egress:\n {2}edge:\n {2}vault-ui:$/m);
  assert.match(compose, /^volumes:\n {2}postgres-data:\n {2}evidence:\n {2}caddy-data:\n {2}vault-data:$/m);
  assert.match(migrate, /depends_on:\n {6}postgres:\n {8}condition: service_healthy\n {6}vault:\n {8}condition: service_healthy/);
  assert.match(back, /depends_on:\n {6}migrate:\n {8}condition: service_completed_successfully\n {6}vault:\n {8}condition: service_healthy/);
  assert.match(front, /depends_on:\n {6}back:\n {8}condition: service_healthy/);
  for (const name of ['vault-import', 'vault-snapshot']) {
    assert.match(composeService(compose, name), /depends_on:\n {6}vault:\n {8}condition: service_healthy/, name);
  }
  assert.doesNotMatch(composeService(compose, 'vault-setup'), /depends_on/u);
  assert.match(compose, /^x-logging: &logging\n {2}driver: json-file\n {2}options:\n {4}max-size: "20m"\n {4}max-file: "5"$/m);
  assert.equal((compose.match(/^ {4}logging: \*logging$/gm) ?? []).length, 8);

  assert.doesNotMatch(compose, /DATABASE_URL|SOLANA_|LISTENER_|EXECUTOR_|POSTGRES_PASSWORD:|privileged:|network_mode: host|docker\.sock/u);
  assert.doesNotMatch(compose, /api-key|keypair|wallet/iu);
  for (const imageLine of compose.match(/^ {4}image: .+$/gm) ?? []) {
    assert.match(imageLine, /(?:@sha256:[0-9a-f]{64}|\$\{(?:BACKEND|FRONTEND|VAULT)_IMAGE:\?)/u);
  }
});
```

- [ ] **Step 2: Update the resolved-configuration test**

In the test « Compose resolves the stack… », add `readonly tmpfs?: readonly string[];` to `ResolvedService`, then replace everything from `const services = resolvedConfig(['deploy/compose.yaml']);` to the line before `const server = resolvedConfig(` with:

```ts
  const services = resolvedConfig(['deploy/compose.yaml']);
  assert.deepEqual(Object.keys(services).sort(), ['back', 'front', 'migrate', 'postgres', 'vault']);
  assert.deepEqual(services.back?.environment, {
    POSTGRES_DB: 'sol_token_listener', SOL_HEALTH_REQUIRE_OK: 'true', SOL_STACK_MODE: 'observe',
    SOL_VAULT_PULL_TIMEOUT_MS: '60000',
  });
  assert.deepEqual(services.migrate?.environment, { POSTGRES_DB: 'sol_token_listener', SOL_VAULT_PULL_TIMEOUT_MS: '60000' });
  assert.deepEqual(services.front?.environment, { FRONT_BASIC_AUTH_USER: 'operator', SITE_ADDRESS: 'http://:8080' });
  assert.deepEqual(ports(services.front), ['127.0.0.1:8080:8080']);
  assert.deepEqual(ports(services.vault), ['127.0.0.1:8200:8200']);
  for (const name of ['postgres', 'migrate', 'back']) assert.deepEqual(ports(services[name]), [], name);
  assert.deepEqual(binds(services.postgres), [
    '/srv/sol-token-listener/secrets/db/postgres-admin-password:/root/secrets/postgres-admin-password:ro',
  ]);
  assert.deepEqual(binds(services.vault), ['/srv/sol-token-listener/secrets/vault/unseal:/run/vault:ro']);
  assert.deepEqual(binds(services.migrate), [
    '/srv/sol-token-listener/secrets/db/postgres-admin-password:/root/secrets/db/postgres-admin-password:ro',
    '/srv/sol-token-listener/secrets/vault/approle/migrate.json:/root/vault/approle.json:ro',
  ]);
  assert.deepEqual(binds(services.back), [
    '/srv/sol-token-listener/secrets/vault/approle/back.json:/root/vault/approle.json:ro',
  ]);
  assert.deepEqual(services.back?.tmpfs, [
    '/run/sol:mode=0711,size=16m', '/root/secrets:mode=0700,size=4m', '/etc/sol/config:mode=0755,size=1m',
  ]);
  assert.deepEqual(binds(services.front), [
    '/srv/sol-token-listener/secrets/front/front-basic-auth-hash:/root/secrets/front-basic-auth-hash:ro',
  ]);
  for (const name of ['vault', 'migrate', 'back']) {
    const service = services[name];
    assert.deepEqual(service?.security_opt, ['no-new-privileges:true'], name);
    assert.deepEqual(service?.cap_drop, ['NET_RAW', 'MKNOD'], name);
    assert.ok(Object.hasOwn(service?.ulimits ?? {}, 'core'), name);
  }
  assert.equal(services.front?.security_opt, undefined);
  assert.equal(services.back?.stop_grace_period, '4m0s');
  assert.equal(services.front?.cpus, 0.5);

  const tools = resolvedConfig(['deploy/compose.yaml'], { COMPOSE_PROFILES: 'tools' });
  assert.deepEqual(Object.keys(tools).sort(), [
    'back', 'front', 'migrate', 'postgres', 'vault', 'vault-import', 'vault-setup', 'vault-snapshot',
  ]);
  assert.deepEqual(binds(tools['vault-setup']), ['/srv/sol-token-listener/secrets/vault:/out:rw']);
  for (const name of ['vault-import', 'vault-snapshot']) assert.deepEqual(binds(tools[name]), [], name);

```

- [ ] **Step 3: Update the compose-input template test**

In the test « the compose input template holds no secret and documents every input », add these two lines to the expected values:

```ts
    `VAULT_IMAGE=registry.invalid/sol-token-listener/vault@sha256:${'2'.repeat(64)}`,
    'VAULT_PORT=8200',
```

and extend the image loop to `['BACKEND_IMAGE', 'FRONTEND_IMAGE', 'VAULT_IMAGE']`.

- [ ] **Step 4: Run them to verify they fail**

Run: `npx tsx --test tests/deployment-artifacts.test.ts`
Expected: FAIL in the three updated tests.

- [ ] **Step 5: Rewrite `deploy/compose.yaml`**

```yaml
name: sol-token-listener

# Full-bot stack (docs/superpowers/specs/2026-10-09-full-bot-compose-design.md) whose variables
# live in Vault (docs/superpowers/specs/2026-10-09-vault-secrets-design.md). Only the bootstrap
# secrets are host files under ${SOL_HOST_DIR}/secrets: nothing secret lives here.
x-logging: &logging
  driver: json-file
  options:
    max-size: "20m"
    max-file: "5"

# The back image drops root itself (setpriv, supervisord `user=`) and Vault runs as its image's
# vault user: no process may gain privileges again, and no core dump may carry a secret out.
x-hardening: &hardening
  security_opt: ["no-new-privileges:true"]
  cap_drop: [NET_RAW, MKNOD]
  ulimits:
    core: 0

services:
  postgres:
    image: postgres:16.14-alpine3.23@sha256:42b8b8b29c8a4e933d88943e5b03001a78794905cf786e6e7634e9f2abd5a0d3
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-sol_token_listener}
      POSTGRES_USER: sol_owner
      POSTGRES_PASSWORD_FILE: /root/secrets/postgres-admin-password
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/db/postgres-admin-password:/root/secrets/postgres-admin-password:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sol_owner -d \"$$POSTGRES_DB\""]
      interval: 5s
      timeout: 3s
      retries: 12
      start_period: 5s
    networks: [internal]
    logging: *logging
    restart: unless-stopped

  vault:
    <<: *hardening
    image: ${VAULT_IMAGE:?VAULT_IMAGE is required}
    build:
      context: ..
      dockerfile: Dockerfile
      target: vault
    volumes:
      - vault-data:/vault/file
      # A directory, not the key file: the key does not exist before deploy/host/vault-init.sh.
      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/vault/unseal:/run/vault:ro
    # Local only; on the server, reach the UI through `ssh -L 8200:127.0.0.1:8200`.
    ports: ["127.0.0.1:${VAULT_PORT:-8200}:8200"]
    init: true
    healthcheck:
      test: ["CMD", "vault", "status"]
      interval: 5s
      timeout: 3s
      retries: 24
      start_period: 10s
    networks: [internal, vault-ui]
    logging: *logging
    restart: unless-stopped

  migrate:
    <<: *hardening
    image: ${BACKEND_IMAGE:?BACKEND_IMAGE is required}
    command: ["sol-admin", "migrate"]
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-sol_token_listener}
      SOL_VAULT_PULL_TIMEOUT_MS: ${SOL_VAULT_PULL_TIMEOUT_MS:-60000}
    volumes:
      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/db/postgres-admin-password:/root/secrets/db/postgres-admin-password:ro
      - type: bind
        source: ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/vault/approle/migrate.json
        target: /root/vault/approle.json
        read_only: true
    tmpfs: ["/root/secrets/db/logins:mode=0700,size=1m"]
    depends_on:
      postgres:
        condition: service_healthy
      vault:
        condition: service_healthy
    networks: [internal]
    logging: *logging
    restart: "no"

  back:
    <<: *hardening
    image: ${BACKEND_IMAGE:?BACKEND_IMAGE is required}
    build:
      context: ..
      dockerfile: Dockerfile
      target: backend
    command: ["sol-entrypoint"]
    environment:
      SOL_STACK_MODE: ${SOL_STACK_MODE:-observe}
      SOL_HEALTH_REQUIRE_OK: ${SOL_HEALTH_REQUIRE_OK:-true}
      POSTGRES_DB: ${POSTGRES_DB:-sol_token_listener}
      SOL_VAULT_PULL_TIMEOUT_MS: ${SOL_VAULT_PULL_TIMEOUT_MS:-60000}
    volumes:
      - type: bind
        source: ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/vault/approle/back.json
        target: /root/vault/approle.json
        read_only: true
      - evidence:/var/lib/sol/evidence
    # vault-pull fills /root/secrets and /etc/sol/config at each start (Vault spec 7.1).
    tmpfs:
      - /run/sol:mode=0711,size=16m
      - /root/secrets:mode=0700,size=4m
      - /etc/sol/config:mode=0755,size=1m
    init: true
    # supervisord stops its programs one after the other (deploy/back/supervisor/programs).
    stop_grace_period: 240s
    depends_on:
      migrate:
        condition: service_completed_successfully
      vault:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "sol-health"]
      interval: 15s
      timeout: 10s
      retries: 4
      start_period: 60s
    networks: [internal, egress, edge]
    logging: *logging
    restart: unless-stopped

  front:
    image: ${FRONTEND_IMAGE:?FRONTEND_IMAGE is required}
    build:
      context: ..
      dockerfile: Dockerfile
      target: frontend
    environment:
      SITE_ADDRESS: http://:8080
      FRONT_BASIC_AUTH_USER: ${FRONT_BASIC_AUTH_USER:-operator}
    volumes:
      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/front/front-basic-auth-hash:/root/secrets/front-basic-auth-hash:ro
      - caddy-data:/data
    ports: ["127.0.0.1:${FRONT_PORT:-8080}:8080"]
    # Each failed basic_auth attempt costs one bcrypt comparison: a flood stays within this share.
    cpus: 0.5
    depends_on:
      back:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-q", "-T", "2", "-O", "/dev/null", "http://127.0.0.1:2019/config/"]
      interval: 5s
      timeout: 3s
      retries: 30
      start_period: 10s
    networks: [edge]
    logging: *logging
    restart: unless-stopped

  # One-shot tools on the back image (profile `tools`, never started by `up`), run by
  # deploy/host/vault-init.sh, deploy/host/vault-import.sh and deploy/host/backup.sh.
  vault-setup:
    <<: *hardening
    image: ${BACKEND_IMAGE:?BACKEND_IMAGE is required}
    profiles: [tools]
    entrypoint: ["node", "/app/dist/scripts/deploy/vault-setup.js"]
    command: ["init"]
    volumes:
      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/vault:/out
    networks: [internal]
    logging: *logging
    restart: "no"

  vault-import:
    <<: *hardening
    image: ${BACKEND_IMAGE:?BACKEND_IMAGE is required}
    profiles: [tools]
    entrypoint: ["node", "/app/dist/scripts/deploy/vault-import.js"]
    depends_on:
      vault:
        condition: service_healthy
    networks: [internal]
    logging: *logging
    restart: "no"

  vault-snapshot:
    <<: *hardening
    image: ${BACKEND_IMAGE:?BACKEND_IMAGE is required}
    profiles: [tools]
    entrypoint: ["node", "/app/dist/scripts/deploy/vault-snapshot.js"]
    depends_on:
      vault:
        condition: service_healthy
    networks: [internal]
    logging: *logging
    restart: "no"

networks:
  internal:
    internal: true
  egress:
  edge:
  vault-ui:

volumes:
  postgres-data:
  evidence:
  caddy-data:
  vault-data:
```

- [ ] **Step 6: Rewrite `deploy/env.example`**

```bash
# Compose inputs of the full-bot stack (docs/operations/deployment.md). Copy this file
# outside version control: ~/.sol-token-listener/docker/compose.env on the Mac,
# /srv/sol-token-listener/compose.env on the server. It holds no secret: the variables of the
# processes live in Vault, and the few bootstrap secrets are files under $SOL_HOST_DIR/secrets.

# Host directory with secrets/ and backups/ (mode 0700, outside the repository).
SOL_HOST_DIR=/srv/sol-token-listener
# observe: listener, operator API and retention. live: adds H2a, H2b and auto-arm; no new BUY
# before `sol trading start`.
SOL_STACK_MODE=observe
# true: the back is healthy only when the listener health is OK; false also accepts DEGRADED.
SOL_HEALTH_REQUIRE_OK=true
POSTGRES_DB=sol_token_listener

# Replace the three documentation-only digests with the immutable images of the release. A local
# build may use plain local tags instead (docs/operations/deployment.md, « Images »).
BACKEND_IMAGE=registry.invalid/sol-token-listener/backend@sha256:0000000000000000000000000000000000000000000000000000000000000000
FRONTEND_IMAGE=registry.invalid/sol-token-listener/frontend@sha256:1111111111111111111111111111111111111111111111111111111111111111
VAULT_IMAGE=registry.invalid/sol-token-listener/vault@sha256:2222222222222222222222222222222222222222222222222222222222222222

# Mac: the front listens on 127.0.0.1 only. The server override publishes 80 and 443 instead.
FRONT_PORT=8080
FRONT_BASIC_AUTH_USER=operator
# Vault's interface, on 127.0.0.1 only; on the server, through `ssh -L 8200:127.0.0.1:8200`.
VAULT_PORT=8200
# Server only (deploy/compose.server.yaml): the public DNS name Caddy serves over HTTPS.
SITE_ADDRESS=
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx tsx --test tests/deployment-artifacts.test.ts`
Expected: PASS. In the resolved configuration, compose may render the long-syntax binds with an extra `bind` key. The `binds()` helper reads only `type`, `source`, `target` and `read_only`.

Run: `SOL_HOST_DIR=/tmp/none docker compose --env-file deploy/env.example -f deploy/compose.yaml config --quiet`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add deploy/compose.yaml deploy/env.example tests/deployment-artifacts.test.ts
git commit -m "feat(deploy): vault service, Vault tools and Vault-fed back and migrate in compose

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 10: Host scripts

**Files:**
- Modify: `deploy/host/init-secrets.sh`, `deploy/host/backup.sh`
- Create: `deploy/host/vault-init.sh`, `deploy/host/vault-import.sh` (mode 0755)
- Test: `tests/deploy-host-tooling.test.ts`

- [ ] **Step 1: Update and add the tests**

In `tests/deploy-host-tooling.test.ts`:

1. In « host scripts are bash and parse », iterate over `['init-secrets.sh', 'backup.sh', 'vault-init.sh', 'vault-import.sh']`.
2. Replace the test « init-secrets creates the host layout once, owner-only, and prints no database secret » with:

```ts
void test('init-secrets creates only the bootstrap layout once, owner-only, and prints no database secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-init-'));
  try {
    const dockerArgs = join(directory, 'docker-args');
    const bin = await fakeDocker(directory,
      `cat > /dev/null; printf '%s' "$*" > '${dockerArgs}'; printf '%s\\n' '${FAKE_HASH}'`);
    const host = join(directory, 'host');
    const run = (): ReturnType<typeof spawnSync> => spawnSync(
      'bash', [join(repository, 'deploy/host/init-secrets.sh'), host],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } },
    );
    const first = run();
    assert.equal(first.status, 0, String(first.stderr));
    const output = String(first.stdout);
    const admin = (await readFile(join(host, 'secrets/db/postgres-admin-password'), 'utf8')).trim();
    assert.match(admin, /^[0-9a-f]{64}$/u);
    assert.equal(output.includes(admin), false);
    assert.equal((output.match(/^front password, shown once/gmu) ?? []).length, 1);
    assert.equal((await readFile(join(host, 'secrets/front/front-basic-auth-hash'), 'utf8')).trim(), FAKE_HASH);
    assert.match(await readFile(dockerArgs, 'utf8'), / hash-password --bcrypt-cost 10$/u);
    for (const path of ['secrets', 'secrets/vault', 'secrets/vault/unseal', 'secrets/vault/approle', 'backups']) {
      assert.equal((await stat(join(host, path))).mode & 0o777, 0o700, path);
    }
    assert.deepEqual((await readdir(join(host, 'secrets'))).sort(), ['db', 'front', 'vault']);
    assert.deepEqual(await readdir(join(host, 'secrets/vault/unseal')), []);
    assert.deepEqual((await readdir(host)).sort(), ['backups', 'secrets']);
    assert.match(output, /^next: deploy\/host\/vault-init\.sh, then deploy\/host\/vault-import\.sh/mu);

    const second = run();
    assert.equal(second.status, 0, String(second.stderr));
    assert.equal((await readFile(join(host, 'secrets/db/postgres-admin-password'), 'utf8')).trim(), admin);
    assert.doesNotMatch(String(second.stdout), /front password|created/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

3. Replace the test « backup dumps through the postgres container… » with:

```ts
void test('backup dumps the database and snapshots Vault, with checksums and 14 days kept', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-backup-'));
  try {
    const bin = await fakeDocker(directory, [
      'printf "%s\\n" "$*" >> "$SOL_HOST_DIR/docker-args"',
      'case "$*" in',
      '  *" exec -T postgres "*) printf "PGDMP-fake" ;;',
      '  *" run --rm -T vault-snapshot") cat > "$SOL_HOST_DIR/snapshot-stdin"; printf "SNAP-fake" ;;',
      '  *) exit 99 ;;',
      'esac',
    ].join('\n'));
    const host = join(directory, 'host');
    await mkdir(join(host, 'backups'), { recursive: true });
    await mkdir(join(host, 'secrets/vault/approle'), { recursive: true });
    await writeFile(join(host, 'secrets/vault/approle/backup.json'), '{"role_id":"r","secret_id":"s"}\n');
    for (const name of ['sol-20260101T000000Z.dump', 'vault-20260101T000000Z.snap']) {
      const old = join(host, 'backups', name);
      await writeFile(old, 'old');
      await utimes(old, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    }
    const result = spawnSync('bash', [join(repository, 'deploy/host/backup.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host, SOL_REPOSITORY: repository },
    });
    assert.equal(result.status, 0, result.stderr);
    const files = (await readdir(join(host, 'backups'))).sort();
    assert.equal(files.length, 4);
    const [dump, dumpSum, snapshot, snapshotSum] = files;
    assert.match(dump ?? '', /^sol-\d{8}T\d{6}Z\.dump$/u);
    assert.equal(dumpSum, `${dump ?? ''}.sha256`);
    assert.equal(snapshot, `vault-${(dump ?? '').slice(4, -5)}.snap`);
    assert.equal(snapshotSum, `${snapshot ?? ''}.sha256`);
    assert.equal(await readFile(join(host, 'backups', dump ?? ''), 'utf8'), 'PGDMP-fake');
    assert.equal(await readFile(join(host, 'backups', snapshot ?? ''), 'utf8'), 'SNAP-fake');
    assert.equal(await readFile(join(host, 'snapshot-stdin'), 'utf8'), '{"role_id":"r","secret_id":"s"}\n');
    const compose = `compose --env-file ${host}/compose.env -f ${repository}/deploy/compose.yaml`;
    assert.equal(await readFile(join(host, 'docker-args'), 'utf8'), [
      `${compose} exec -T postgres sh -c exec pg_dump -Fc -U sol_owner -d "$POSTGRES_DB"`,
      `${compose} run --rm -T vault-snapshot`,
      '',
    ].join('\n'));
    assert.equal(result.stdout, `backup ${host}/backups/${dump ?? ''} ${host}/backups/${snapshot ?? ''}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

4. Append:

```ts
void test('vault-init runs vault-setup once as the calling user and refuses a second time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-vault-init-'));
  try {
    const log = join(directory, 'docker-log');
    const bin = await fakeDocker(directory, [
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$*" in',
      `  *" vault-setup init") echo '{"service":"vault-setup","event":"vault.initialized"}'; echo 'operator password, shown once (store it in your password manager): fake-operator-password' ;;`,
      'esac',
    ].join('\n'));
    const host = join(directory, 'host');
    await mkdir(join(host, 'secrets/vault/unseal'), { recursive: true });
    const run = (): ReturnType<typeof spawnSync> => spawnSync('bash', [join(repository, 'deploy/host/vault-init.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    const first = run();
    assert.equal(first.status, 0, String(first.stderr));
    const compose = `compose --env-file ${host}/compose.env -f ${repository}/deploy/compose.yaml`;
    const user = `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`;
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
      `${compose} up --detach vault`,
      `${compose} exec -T vault wget -q -O /dev/null http://127.0.0.1:8200/v1/sys/seal-status`,
      `${compose} run --rm --no-deps --user ${user} vault-setup init`,
      `${compose} up --detach --wait vault`,
    ]);
    assert.equal((String(first.stdout).match(/fake-operator-password/gu) ?? []).length, 1);

    await writeFile(join(host, 'secrets/vault/unseal/unseal-key'), 'key\n');
    await rm(log);
    const second = run();
    assert.equal(second.status, 78);
    assert.match(String(second.stderr), /already initialized/u);
    await assert.rejects(stat(log), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('vault-import mounts the role files, the key files they name and the templates, and sends the password on stdin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-vault-import-'));
  try {
    const log = join(directory, 'docker-log');
    const stdin = join(directory, 'docker-stdin');
    const bin = await fakeDocker(directory, `printf '%s\\n' "$*" >> '${log}'; cat > '${stdin}'`);
    const host = join(directory, 'host');
    const lot5 = join(directory, 'lot5');
    const env = join(lot5, 'env');
    await mkdir(env, { recursive: true });
    await mkdir(host, { recursive: true });
    const adminKey = join(lot5, 'keys', 'helius-admin.key');
    const keypair = join(directory, 'wallet.json');
    await mkdir(dirname(adminKey), { recursive: true });
    await writeFile(adminKey, 'admin-key-value\n');
    await writeFile(keypair, '[1,2]\n');
    await writeFile(join(env, 'provider-evidence.env'), `HELIUS_API_KEY_PATH="${adminKey}"\n`);
    await writeFile(join(env, 'live.env'), `EXECUTOR_KEYPAIR_PATH=${keypair}\nSOLANA_HTTP_RPC_URL=https://x.invalid/?api-key=secret-value\n`);
    const result = spawnSync('bash', [join(repository, 'deploy/host/vault-import.sh'), env], {
      encoding: 'utf8', input: 'operator-password-0123\n',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    assert.equal(result.status, 0, result.stderr);
    const compose = `compose --env-file ${host}/compose.env -f ${repository}/deploy/compose.yaml`;
    assert.equal((await readFile(log, 'utf8')).trim(), [
      `${compose} run --rm -T`,
      `-v ${env}:/import/env:ro -v ${repository}/deploy/config:/import/templates:ro`,
      `-v ${adminKey}:/import/keys/helius-admin-api-key:ro -v ${keypair}:/import/keys/wallet-keypair.json:ro`,
      `-e SOL_IMPORT_EVIDENCE_PREFIX=${lot5}/evidence vault-import`,
    ].join(' '));
    assert.equal(await readFile(stdin, 'utf8'), 'operator-password-0123\n');
    for (const value of ['secret-value', 'admin-key-value', 'operator-password-0123']) {
      assert.equal(`${result.stdout}${result.stderr}`.includes(value), false, value);
    }

    await writeFile(join(env, 'live.env'), 'EXECUTOR_KEYPAIR_PATH=/nonexistent/wallet.json\n');
    const missing = spawnSync('bash', [join(repository, 'deploy/host/vault-import.sh'), env], {
      encoding: 'utf8', input: 'x\n', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    assert.equal(missing.status, 78);
    assert.equal(missing.stderr, 'vault-import: /nonexistent/wallet.json (named by EXECUTOR_KEYPAIR_PATH) does not exist\n');
    const usage = spawnSync('bash', [join(repository, 'deploy/host/vault-import.sh')], {
      encoding: 'utf8', env: { ...process.env, SOL_HOST_DIR: host },
    });
    assert.equal(usage.status, 64);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

Add `dirname` to the `node:path` import of the file.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test tests/deploy-host-tooling.test.ts`
Expected: FAIL on the missing scripts and the old layout of `init-secrets.sh` and `backup.sh`.

- [ ] **Step 3: Rewrite `deploy/host/init-secrets.sh`**

```bash
#!/usr/bin/env bash
# Creates the host directory of the stack (docs/operations/deployment.md, « Dossier hôte et
# Vault »). It holds only the bootstrap secrets, since every other variable lives in Vault:
# - secrets/ (0700): the PostgreSQL admin password, the front bcrypt hash, and the empty
#   secrets/vault/ directories that deploy/host/vault-init.sh fills;
# - backups/ (0700).
# It never overwrites a file and prints no secret, except the generated front password, shown once
# so the operator can store it.
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo 'usage: deploy/host/init-secrets.sh <host directory>' >&2
  exit 64
fi
host="$1"
caddy_image='caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
umask 077
mkdir -p "$host/secrets/db" "$host/secrets/front" "$host/secrets/vault/unseal" "$host/secrets/vault/approle" "$host/backups"
chmod 0700 "$host" "$host/secrets" "$host/secrets/vault" "$host/secrets/vault/unseal" "$host/secrets/vault/approle" "$host/backups"

admin_file="$host/secrets/db/postgres-admin-password"
if [ ! -e "$admin_file" ]; then
  openssl rand -hex 32 > "$admin_file"
  chmod 0600 "$admin_file"
  echo "created $admin_file"
fi

hash_file="$host/secrets/front/front-basic-auth-hash"
if [ ! -e "$hash_file" ]; then
  password="$(openssl rand -base64 24 | tr -d '\n')"
  # Cost 10: each failed login costs Caddy one bcrypt comparison, and the password is random.
  # The hash lands in place only once complete: a failed run leaves no empty secret behind.
  printf '%s\n' "$password" \
    | docker run --rm -i --entrypoint caddy "$caddy_image" hash-password --bcrypt-cost 10 > "$hash_file.tmp"
  grep -Eq '^\$2a\$10\$[./A-Za-z0-9]{53}$' "$hash_file.tmp"
  chmod 0600 "$hash_file.tmp"
  mv "$hash_file.tmp" "$hash_file"
  printf 'front password, shown once (store it in your password manager): %s\n' "$password"
  unset password
fi

echo 'next: deploy/host/vault-init.sh, then deploy/host/vault-import.sh (docs/operations/deployment.md)'
```

- [ ] **Step 4: Create `deploy/host/vault-init.sh`**

```bash
#!/usr/bin/env bash
# Initializes the stack's Vault once (docs/operations/deployment.md, « Dossier hôte et Vault »):
# starts the vault service, waits for its API, runs `vault-setup init` in a tools container as the
# calling user (secrets/vault/ stays the operator's), then waits for Vault to be healthy. Prints
# only the operator password, once. Refuses to run when an unseal key already exists.
set -euo pipefail
: "${SOL_HOST_DIR:?SOL_HOST_DIR is required}"
repository="$(cd "$(dirname "$0")/../.." && pwd)"
compose() {
  docker compose --env-file "$SOL_HOST_DIR/compose.env" -f "$repository/deploy/compose.yaml" "$@"
}
if [ -e "$SOL_HOST_DIR/secrets/vault/unseal/unseal-key" ]; then
  echo 'vault-init: secrets/vault/unseal/unseal-key exists: Vault is already initialized' >&2
  exit 78
fi
compose up --detach vault
ready=no
for _ in $(seq 60); do
  if compose exec -T vault wget -q -O /dev/null http://127.0.0.1:8200/v1/sys/seal-status 2> /dev/null; then
    ready=yes
    break
  fi
  sleep 1
done
if [ "$ready" != yes ]; then
  echo 'vault-init: the Vault API did not answer within 60 s: see docker compose logs vault' >&2
  exit 69
fi
compose run --rm --no-deps --user "$(id -u):$(id -g)" vault-setup init
compose up --detach --wait vault
```

- [ ] **Step 5: Create `deploy/host/vault-import.sh`**

```bash
#!/usr/bin/env bash
# Imports the current role files into Vault (docs/operations/deployment.md, « Dossier hôte et
# Vault »). It mounts read-only into a vault-import tools container:
# - the env directory (lot5 layout);
# - the key files that its *_PATH variables name;
# - the repository's configuration templates.
# The operator password goes on stdin. No value is printed.
set -euo pipefail
: "${SOL_HOST_DIR:?SOL_HOST_DIR is required}"
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo 'usage: deploy/host/vault-import.sh <env directory> [evidence directory]' >&2
  exit 64
fi
source_dir="$(cd "$1" && pwd)"
evidence_dir="${2:-$(dirname "$source_dir")/evidence}"
repository="$(cd "$(dirname "$0")/../.." && pwd)"
compose() {
  docker compose --env-file "$SOL_HOST_DIR/compose.env" -f "$repository/deploy/compose.yaml" "$@"
}
# A *_PATH variable of a role file, without surrounding quotes. Paths only, never a secret value.
path_of() {
  [ -f "$2" ] || return 0
  sed -n "s/^$1=//p" "$2" | head -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
mounts=(-v "$source_dir:/import/env:ro" -v "$repository/deploy/config:/import/templates:ro")
add_key() {
  if [ -n "$2" ]; then
    if [ ! -f "$2" ]; then
      echo "vault-import: $2 (named by $3) does not exist" >&2
      exit 78
    fi
    mounts+=(-v "$2:/import/keys/$1:ro")
  fi
}
add_key helius-admin-api-key "$(path_of HELIUS_API_KEY_PATH "$source_dir/provider-evidence.env")" HELIUS_API_KEY_PATH
add_key evidence-private-key "$(path_of EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH "$source_dir/provider-evidence.env")" EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH
add_key wallet-keypair.json "$(path_of EXECUTOR_KEYPAIR_PATH "$source_dir/live.env")" EXECUTOR_KEYPAIR_PATH
IFS= read -r -s -p 'Vault operator password: ' password
echo >&2
printf '%s\n' "$password" \
  | compose run --rm -T "${mounts[@]}" -e "SOL_IMPORT_EVIDENCE_PREFIX=$evidence_dir" vault-import
unset password
```

- [ ] **Step 6: Extend `deploy/host/backup.sh`**

```bash
#!/usr/bin/env bash
# Backup of the stack (full-bot spec 9.4, Vault spec 8.4): pg_dump -Fc through the postgres
# container and Vault's raft snapshot through a vault-snapshot tools container, each with its
# SHA-256, kept 14 days. The snapshot is encrypted; restoring it needs the unseal key, which is
# never part of a backup. Copying backups off the machine stays the operator's job.
set -euo pipefail
: "${SOL_HOST_DIR:?SOL_HOST_DIR is required}"
: "${SOL_REPOSITORY:?SOL_REPOSITORY is required}"
backups="$SOL_HOST_DIR/backups"
umask 077
mkdir -p "$backups"
compose() {
  docker compose --env-file "$SOL_HOST_DIR/compose.env" -f "$SOL_REPOSITORY/deploy/compose.yaml" "$@"
}
checksum() {
  if command -v sha256sum > /dev/null; then
    (cd "$backups" && sha256sum "$1" > "$1.sha256")
  else
    (cd "$backups" && shasum -a 256 "$1" > "$1.sha256")
  fi
}
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump="sol-$stamp.dump"
compose exec -T postgres sh -c 'exec pg_dump -Fc -U sol_owner -d "$POSTGRES_DB"' > "$backups/$dump.partial"
mv "$backups/$dump.partial" "$backups/$dump"
checksum "$dump"
snapshot="vault-$stamp.snap"
compose run --rm -T vault-snapshot < "$SOL_HOST_DIR/secrets/vault/approle/backup.json" > "$backups/$snapshot.partial"
mv "$backups/$snapshot.partial" "$backups/$snapshot"
checksum "$snapshot"
find "$backups" -maxdepth 1 -type f \( -name 'sol-*.dump*' -o -name 'vault-*.snap*' \) -mtime +14 -delete
echo "backup $backups/$dump $backups/$snapshot"
```

- [ ] **Step 7: Make the new scripts executable, run the tests, commit**

```bash
chmod 0755 deploy/host/vault-init.sh deploy/host/vault-import.sh
npx tsx --test tests/deploy-host-tooling.test.ts
```

Expected: PASS.

```bash
git add deploy/host tests/deploy-host-tooling.test.ts
git commit -m "feat(deploy): host scripts initialize, import and back up Vault

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 11: Deployment smoke with a real throwaway Vault

**Files:**
- Modify: `scripts/deployment-smoke.mjs`
- Test: `tests/deployment-artifacts.test.ts` (the smoke tests), `tests/deployment-smoke-diagnostics.test.ts`

- [ ] **Step 1: Update the static smoke tests**

In `tests/deployment-artifacts.test.ts`, test « deployment smoke is bounded, isolated, secret-free, and always cleans its project »:

- delete `assert.match(smoke, /operatorApiToken\s*=\s*randomBytes\(32\)\.toString\('hex'\)/);`;
- replace the two `secrets\/back\/helius-listener-*` assertions and the `const override = …` assertion with:

```ts
  assert.match(smoke, /'SOLANA_HTTP_RPC_URL=https:\/\/rpc\.invalid'/);
  assert.match(smoke, /'SOLANA_WS_RPC_URL=wss:\/\/rpc\.invalid'/);
  assert.match(smoke, /'LISTENER_ENABLED=false'/);
  assert.match(smoke, /VAULT_IMAGE:\s*deploymentImages\.vault/);
  assert.match(smoke, /VAULT_PORT:\s*'0'/);
  assert.match(smoke, /SOL_VAULT_PULL_TIMEOUT_MS:\s*'5000'/);
```

- replace `/await compose\(\['build', 'back', 'front'\]\)/` with `/await compose\(\['build', 'back', 'front', 'vault'\]\)/`.

In the test « deployment smoke proves users, secret isolation, front authentication, logins and closed operations »:

- extend the phase list to `['HOST_SETUP', 'VAULT_SETUP', 'VAULT_IMPORT', 'PROCESS_USERS', 'NON_ROOT_FRONT', 'SECRET_ISOLATION', 'FRONT_AUTH', 'LOGINS', 'OPERATIONS', 'BACKUP', 'SECRET_LEAKS', 'VAULT_RESTART', 'VAULT_FAIL_CLOSED']`;
- replace `"assertEqual(stdout, 'h2b 400\\nopapi 400\\n'"` with `"assertEqual(stdout, 'listener 400\\nopapi 400\\n'"`;
- add these statements:

```ts
    "if (pulled.includes('wallet-keypair'))",
    "await readBackSecret('back/operator-api-token')",
    'readBackSecret(`logins/pg-${login}-password`)',
    "stdout.includes('vault-pull: Vault unavailable')",
    "assertEqual(String(await distributions()), String(before)",
```

In `tests/deployment-smoke-diagnostics.test.ts`, test « real deployment sequencing attaches the failing phase and preserves successful cleanup », add after `writeSmokeHost = async () => undefined;`:

```ts
    setupSmokeVault = async () => undefined;
    importSmokeVault = async () => undefined;
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test tests/deployment-artifacts.test.ts tests/deployment-smoke-diagnostics.test.ts`
Expected: FAIL in the two smoke tests of `deployment-artifacts`. The diagnostics test still passes: the stubs are not referenced yet.

- [ ] **Step 3: Change the smoke's constants and secrets**

In `scripts/deployment-smoke.mjs`:

1. Replace `SMOKE_PHASES` with:

```js
const SMOKE_PHASES = new Set([
  'BUILD', 'HOST_SETUP', 'VAULT_SETUP', 'VAULT_IMPORT', 'START', 'PORT_DISCOVERY', 'SIGNAL_PROBE',
  'PROCESS_USERS', 'NON_ROOT_FRONT', 'SECRET_ISOLATION', 'FRONT_AUTH', 'PUBLIC_HEALTH', 'CORS',
  'MIGRATIONS', 'LOGINS', 'OPERATIONS', 'FRONTEND', 'SSE_SHUTDOWN', 'APP_RESTART',
  'HEALTH_RECOVERY', 'RETENTION', 'BACKUP', 'SECRET_LEAKS', 'VAULT_RESTART', 'VAULT_FAIL_CLOSED',
  'CLEANUP',
]);
```

2. Replace the block from `const postgresPassword = …` to `const basicAuthorization = …` with:

```js
const postgresPassword = randomBytes(24).toString('hex');
const frontPassword = randomBytes(24).toString('hex');
// Same table as src/deploy/stack.ts DATABASE_LOGINS (tests/deployment-artifacts.test.ts checks it).
const loginGroups = Object.freeze({
  sol_listener: 'sol_token_listener_writer',
  sol_live: 'sol_token_executor_live',
  sol_recovery: 'sol_token_executor_live_recovery',
  sol_autoarm: 'sol_token_executor_operations',
  sol_reader: 'sol_token_operator_reader',
  sol_retention: 'sol_token_retention_worker',
  sol_worker: 'sol_token_executor_worker',
  sol_ops: 'sol_token_executor_operations',
  sol_readiness: 'sol_token_executor_readiness',
});
// Throwaway: random bytes, never a funded key; proves that observe mode leaves it in Vault.
const throwawayKeypair = JSON.stringify([...randomBytes(64)]);
// Grows at run time with what Vault generates or the back pulls: every value is redacted.
const smokeSecrets = [postgresPassword, frontPassword];
let operatorPassword = null;
const basicAuthorization = `Basic ${Buffer.from(`${SMOKE_USER}:${frontPassword}`).toString('base64')}`;
```

3. In `deploymentImagesFor`, add `vault: \`sol-token-listener-smoke-vault:${name}\`,`. In `environment`, add `SOL_VAULT_PULL_TIMEOUT_MS: '5000',`, `VAULT_IMAGE: deploymentImages.vault,` and `VAULT_PORT: '0',`. In `faultCleanupEnvironment`, add `VAULT_IMAGE: deploymentImagesFor(faultName).vault,` and `VAULT_PORT: '0',`.

4. Just before `const environment = Object.freeze({`, add:

```js
// The compose inputs the smoke sets, also written to compose.env for deploy/host/backup.sh.
const COMPOSE_INPUTS = Object.freeze([
  'COMPOSE_PROJECT_NAME', 'SOL_HOST_DIR', 'SOL_STACK_MODE', 'SOL_HEALTH_REQUIRE_OK',
  'SOL_VAULT_PULL_TIMEOUT_MS', 'POSTGRES_DB', 'BACKEND_IMAGE', 'FRONTEND_IMAGE', 'VAULT_IMAGE',
  'FRONT_PORT', 'VAULT_PORT', 'FRONT_BASIC_AUTH_USER',
]);
```

- [ ] **Step 4: Sequence the new phases**

In `runDeployment`:
- change the build to `await smokePhase('BUILD', async () => { await compose(['build', 'back', 'front', 'vault']); });`;
- insert after the `HOST_SETUP` line:

```js
      await smokePhase('VAULT_SETUP', setupSmokeVault);
      await smokePhase('VAULT_IMPORT', importSmokeVault);
```

- insert after the `RETENTION` line:

```js
      await smokePhase('BACKUP', assertBackup);
      await smokePhase('SECRET_LEAKS', assertNoSecretLeak);
      await smokePhase('VAULT_RESTART', assertVaultAutoUnseal);
      await smokePhase('VAULT_FAIL_CLOSED', assertBackFailsClosed);
```

- [ ] **Step 5: Replace `writeSmokeHost` and add the Vault phases**

Replace `writeSmokeHost` with:

```js
async function writeSmokeHost() {
  const { stdout: frontHash } = await runDocker([
    'run', '--rm', '-i', '--entrypoint', 'caddy', deploymentImages.frontend, 'hash-password',
    '--bcrypt-cost', '10',
  ], { input: `${frontPassword}\n`, reflectFailureOutput: false });
  if (!/^\$2a\$10\$[./A-Za-z0-9]{53}\n$/u.test(frontHash)) throw new Error('Caddy did not return a bcrypt hash.');
  for (const directory of [
    'secrets/db', 'secrets/front', 'secrets/vault/unseal', 'secrets/vault/approle',
    'import/env', 'import/keys', 'backups',
  ]) {
    await mkdir(join(hostDirectory, directory), { recursive: true, mode: 0o700 });
  }
  await chmod(hostDirectory, 0o700);
  await writeFile(join(hostDirectory, 'secrets/db/postgres-admin-password'), `${postgresPassword}\n`, { mode: 0o600 });
  await writeFile(join(hostDirectory, 'secrets/front/front-basic-auth-hash'), frontHash, { mode: 0o600 });
  // Import source in the lot5 layout. The smoke never contacts an RPC: its listener only serves the API.
  const listener = await readFile(resolve(root, 'deploy/config/listener.env.example'), 'utf8');
  await writeFile(join(hostDirectory, 'import/env/listener.env'), [
    listener.trimEnd(), 'LISTENER_ENABLED=false', 'SOLANA_HTTP_RPC_URL=https://rpc.invalid',
    'SOLANA_WS_RPC_URL=wss://rpc.invalid', '',
  ].join('\n'), { mode: 0o600 });
  await writeFile(join(hostDirectory, 'import/keys/wallet-keypair.json'), `${throwawayKeypair}\n`, { mode: 0o600 });
  await writeFile(
    join(hostDirectory, 'compose.env'),
    COMPOSE_INPUTS.map((name) => `${name}=${environment[name]}\n`).join(''),
    { mode: 0o600 },
  );
}

async function setupSmokeVault() {
  await compose(['up', '--detach', 'vault']);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await compose([
        'exec', '-T', 'vault', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8200/v1/sys/seal-status',
      ], { reflectFailureOutput: false });
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      await delay(1_000);
    }
  }
  const user = `${process.getuid()}:${process.getgid()}`;
  const { stdout } = await compose(
    ['run', '--rm', '--no-deps', '--user', user, 'vault-setup', 'init'],
    { reflectFailureOutput: false },
  );
  const password = /^operator password, shown once \(store it in your password manager\): (\S+)$/mu.exec(stdout)?.[1];
  if (password === undefined) throw new Error('vault-setup did not print the operator password.');
  operatorPassword = password;
  smokeSecrets.push(password);
  smokeSecrets.push((await readFile(join(hostDirectory, 'secrets/vault/unseal/unseal-key'), 'utf8')).trim());
  for (const name of ['back', 'migrate', 'backup']) {
    const approle = parseJson(
      await readFile(join(hostDirectory, `secrets/vault/approle/${name}.json`), 'utf8'),
      'vault-setup wrote an unreadable AppRole file.',
    );
    smokeSecrets.push(approle.secret_id);
  }
  await compose(['up', '--detach', '--wait', '--wait-timeout', '60', 'vault']);
}

async function importSmokeVault() {
  const { stdout } = await compose([
    'run', '--rm', '-T',
    '-v', `${join(hostDirectory, 'import/env')}:/import/env:ro`,
    '-v', `${join(hostDirectory, 'import/keys')}:/import/keys:ro`,
    '-v', `${resolve(root, 'deploy/config')}:/import/templates:ro`,
    'vault-import',
  ], { input: `${operatorPassword}\n`, reflectFailureOutput: false });
  const summary = parseJson(stdout.trim().split('\n').at(-1) ?? '', 'vault-import did not print its summary.');
  assertEqual(summary.configs.join(','), 'listener', 'vault-import did not take the listener role file.');
  assertEqual(
    summary.secrets.join(','),
    'helius-listener-http-url,helius-listener-ws-url,wallet-keypair.json',
    'vault-import did not import the expected secrets.',
  );
}

/** A file the back pulled from Vault into its root-only tmpfs; the value joins the redactions. */
async function readBackSecret(file) {
  const { stdout } = await compose(['exec', '-T', 'back', 'cat', `/root/secrets/${file}`], { reflectFailureOutput: false });
  const value = stdout.replace(/\n$/u, '');
  if (value === '') throw new Error('The back pulled an empty secret.');
  smokeSecrets.push(value);
  return value;
}
```

- [ ] **Step 6: Rewire the isolation, authentication and login checks**

Replace `assertSecretIsolation` with:

```js
async function assertSecretIsolation() {
  const secretPaths = ['/run/sol/listener/pg-sol_listener-password', '/run/sol/opapi/operator-api-token'];
  const { stdout } = await compose(['exec', '-T', 'back', 'stat', '-c', '%U %a', ...secretPaths]);
  assertEqual(stdout, 'listener 400\nopapi 400\n', 'Secrets are not owner-only in the tmpfs.');
  for (const path of secretPaths.slice(1)) {
    let readable = true;
    try {
      await compose([
        'exec', '-T', 'back', 'setpriv', '--reuid=listener', '--regid=listener', '--clear-groups', 'cat', path,
      ], { reflectFailureOutput: false });
    } catch {
      readable = false;
    }
    if (readable) throw new Error('The listener user can read the secret of another user.');
  }
  // Observe mode never pulls the keypair out of Vault (Vault spec 7.1).
  const { stdout: pulled } = await compose(['exec', '-T', 'back', 'sh', '-c', 'ls -A /root/secrets/back /run/sol/h2b']);
  if (pulled.includes('wallet-keypair')) throw new Error('The observe stack pulled the keypair out of Vault.');
}
```

In `assertFrontAuthentication`, add as its first line `const operatorApiToken = await readBackSecret('back/operator-api-token');`.

In `assertLogins`, at the top of the `for (const [login, group] of Object.entries(loginGroups))` loop, add `const password = await readBackSecret(\`logins/pg-${login}-password\`);`, and replace `` `PGPASSWORD=${loginPasswords[login]}` `` with `` `PGPASSWORD=${password}` ``.

- [ ] **Step 7: Add the backup, leak, restart and fail-closed checks**

Append, after `assertRetentionOneShot`:

```js
async function assertBackup() {
  const { stdout } = await runCommand('bash', [resolve(root, 'deploy/host/backup.sh')], {
    commandEnvironment: { ...environment, SOL_REPOSITORY: root },
  });
  const files = /^backup (\S+\.dump) (\S+\.snap)$/mu.exec(stdout);
  if (files === null) throw new Error('backup.sh did not report its dump and its snapshot.');
  const dump = await readFile(files[1]);
  if (dump.subarray(0, 5).toString('latin1') !== 'PGDMP') throw new Error('The database backup is not a pg_dump archive.');
  const snapshot = await readFile(files[2]);
  if (snapshot[0] !== 0x1f || snapshot[1] !== 0x8b) throw new Error('The Vault backup is not a gzip raft snapshot.');
}

async function assertNoSecretLeak() {
  const { stdout: ids } = await compose(['ps', '--all', '--quiet']);
  const { stdout: inspect } = await runDocker(['inspect', ...ids.split('\n').filter((id) => id !== '')]);
  const { stdout: logs } = await compose(['logs', '--no-color']);
  for (const secret of smokeSecrets) {
    if (inspect.includes(secret)) throw new Error('A secret value appears in docker inspect.');
    if (logs.includes(secret)) throw new Error('A secret value appears in the container logs.');
  }
}

async function assertVaultAutoUnseal() {
  await compose(['restart', 'vault']);
  await compose(['up', '--detach', '--wait', '--wait-timeout', '60', 'vault']);
  const { stdout } = await compose(['exec', '-T', 'vault', 'vault', 'status', '-format=json']);
  assertEqual(String(parseJson(stdout, 'vault status did not answer JSON.').sealed), 'false',
    'Vault did not unseal itself after a restart.');
}

async function assertBackFailsClosed() {
  const distributions = async () => (
    (await compose(['logs', '--no-color', 'back'])).stdout.match(/"event":"secrets\.distributed"/gu) ?? []
  ).length;
  const before = await distributions();
  await compose(['stop', 'vault']);
  await compose(['restart', 'back']);
  for (let attempt = 1; ; attempt += 1) {
    const { stdout } = await compose(['logs', '--no-color', 'back']);
    if (stdout.includes('vault-pull: Vault unavailable')) break;
    if (attempt >= 30) throw new Error('The back did not report Vault as unavailable.');
    await delay(1_000);
  }
  assertEqual(String(await distributions()), String(before), 'The back distributed secrets without Vault.');
}
```

- [ ] **Step 8: Run the static tests, then the smoke**

Run: `npx tsx --test tests/deployment-artifacts.test.ts tests/deployment-smoke-diagnostics.test.ts && npm run lint:backend`
Expected: PASS.

Run: `npm run build:backend && npm run deployment:smoke && npm run deployment:smoke:signal`
Expected: `Deployment smoke passed.` and `Deployment signal fault probe passed.`

If a phase fails, the error line names it (`phase=VAULT_SETUP` …). Fix the cause in the task that owns the artifact, then rerun.

- [ ] **Step 9: Commit**

```bash
git add scripts/deployment-smoke.mjs tests/deployment-artifacts.test.ts tests/deployment-smoke-diagnostics.test.ts
git commit -m "test(deploy): smoke the stack with a real throwaway Vault

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 12: Runbook and documentation

**Files:**
- Modify: `docs/operations/deployment.md`, `README.md`, `docs/system-overview.html`
- Test: `tests/deployment-artifacts.test.ts` (« deployment runbook documents the full-bot lifecycle… »)

- [ ] **Step 1: Update the runbook test**

In « deployment runbook documents the full-bot lifecycle, takeover and security boundary »:

1. Replace the heading list with:

```ts
    '## Topologie', '## Prérequis', '## Images', '## Dossier hôte et Vault',
    '## Démarrage et arrêt', '## Commandes sol', '## Trading', "## Qualification d'une enveloppe (gate 10)",
    '## Santé et journaux', '## Sauvegardes', '## Reprise de la base actuelle', '## Retour arrière',
    '## Bascule vers le serveur', '## Rotation des secrets', '## Frontière de sécurité',
```

2. Add these commands to the expected list:

```ts
    'deploy/host/vault-init.sh',
    'deploy/host/vault-import.sh "$HOME/.sol-token-listener/lot5/env"',
    'vault kv patch sol/config/',
    'sol_compose restart back',
    'vault operator raft snapshot restore -force /tmp/restore.snap',
```

3. Replace `const secrets = runbook.slice(runbook.indexOf('## Dossier hôte'), runbook.indexOf('## Images'));` with:

```ts
  const secrets = runbook.slice(runbook.indexOf('## Dossier hôte et Vault'), runbook.indexOf('## Démarrage et arrêt'));
  assert.ok(secrets.length > 0);
```

Run: `npx tsx --test tests/deployment-artifacts.test.ts`
Expected: FAIL on the runbook test.

- [ ] **Step 2: Rewrite the runbook sections**

In `docs/operations/deployment.md`:

1. In « Topologie », add a row after `postgres`:

```markdown
| `vault` | HashiCorp Vault 2.1.2, stockage raft dans le volume `vault-data`, déverrouillage automatique | `internal`, `vault-ui` | `127.0.0.1:8200` (interface locale) |
```

2. Move « Images » before the host-directory section. Rename « Dossier hôte, secrets et configuration » to « Dossier hôte et Vault ». Replace its whole body (everything up to « ## Images », now « ## Démarrage et arrêt ») with:

````markdown
Les variables des processus vivent dans Vault : configuration de chaque rôle et secrets. Sur
l'hôte ne restent que les secrets d'amorçage :

- le mot de passe administrateur PostgreSQL ;
- l'empreinte du mot de passe du front ;
- la clé de déverrouillage de Vault ;
- les identifiants AppRole de `back`, `migrate` et de la sauvegarde.

1. Créer le dossier hôte. Le script affiche une seule fois le mot de passe du front :

   ```bash
   deploy/host/init-secrets.sh "$SOL_HOST_DIR"
   cp deploy/env.example "$SOL_ENV"
   chmod 0600 "$SOL_ENV"
   ```

   Dans `compose.env`, renseigner :
   - `SOL_HOST_DIR` ;
   - les trois images `BACKEND_IMAGE`, `FRONTEND_IMAGE` et `VAULT_IMAGE` (section « Images ») ;
   - `SOL_STACK_MODE` ;
   - `SITE_ADDRESS`, sur le serveur.

   Ce fichier ne contient aucun secret.

2. Initialiser Vault, une seule fois :

   ```bash
   deploy/host/vault-init.sh
   ```

   Le script :
   - démarre `vault` et l'initialise avec une seule part de clé ;
   - écrit la clé de déverrouillage dans `secrets/vault/unseal/` et les trois AppRoles dans
     `secrets/vault/approle/` ;
   - génère dans Vault les neuf mots de passe de login et le jeton de l'API opérateur ;
   - affiche une seule fois le mot de passe du login `operator`.

   Garder ce mot de passe et une copie du fichier `secrets/vault/unseal/unseal-key` dans le
   gestionnaire de mots de passe : sans eux, aucune sauvegarde de Vault ne se restaure.

   En cas d'échec après l'initialisation, repartir de zéro : Vault ne contient encore rien.

   ```bash
   sol_compose rm --stop --force vault
   docker volume rm sol-token-listener_vault-data
   rm -f "$SOL_HOST_DIR"/secrets/vault/unseal/* "$SOL_HOST_DIR"/secrets/vault/approle/*
   ```

3. Importer les fichiers actuels. Le script lit les fichiers de rôle du lot 5 et les fichiers de
   clés qu'ils nomment, demande le mot de passe `operator`, puis écrit le tout dans Vault sans
   rien afficher :

   ```bash
   deploy/host/vault-import.sh "$HOME/.sol-token-listener/lot5/env"
   ```

   L'import :
   - retire les variables que `sol-run` injecte ;
   - réécrit les chemins de preuves vers `/var/lib/sol/evidence` ;
   - fixe `API_HOST=0.0.0.0`, `API_PORT=3000`, `OPERATOR_API_HOST=0.0.0.0` et
     `OPERATOR_API_PORT=3100` ;
   - prend le modèle du dépôt pour un rôle absent de la source (`retention` par exemple).

   Le relancer crée une nouvelle version de chaque entrée et écrase les modifications faites
   depuis dans Vault.

4. Ouvrir l'interface, `http://127.0.0.1:8200` (login `operator`), et vérifier sous `sol/config/` :
   - `operator-api` : `OPERATOR_API_ALLOWED_ORIGIN=http://127.0.0.1:8080`, ou
     `https://<SITE_ADDRESS>` sur le serveur ;
   - `operations` : `EXECUTOR_PREFLIGHT_EVIDENCE_PATH` et `EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH`
     sous `/var/lib/sol/evidence` ;
   - `preflight-bundle` : `EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY=/var/lib/sol/evidence/bundle`.

   Sur le serveur, l'interface passe par un tunnel : `ssh -L 8200:127.0.0.1:8200 <serveur>`.

### Modifier une valeur

Dans l'interface, ou en ligne de commande avec le login `operator` :

```bash
sol_compose exec -it vault sh -c 'vault login -method=userpass username=operator > /dev/null && vault kv patch sol/config/live EXECUTOR_SLIPPAGE_BPS=300'
sol_compose restart back
```

Vault garde les versions précédentes de chaque entrée : `vault kv rollback -version=<n>
sol/config/live`, ou le bouton de l'interface. Le back ne lit Vault qu'à son démarrage. Le
redémarrage pose l'entry-stop : relancer `sol trading start` (section « Trading »).

`sol-run` refuse toujours une configuration qui contient un mot de passe, une clé, un jeton, une
URL avec identifiants ou une variable injectée. Le message nomme l'entrée et la variable, jamais
la valeur.

Les preuves et le catalogue de gates vivent dans le volume `evidence`, propriété de l'utilisateur
`ops`. Pour y copier un fichier existant, une fois la stack créée :

```bash
evidence_file=gate-catalog.json
sol_compose cp "$HOME/.sol-token-listener/lot5/evidence/$evidence_file" "back:/var/lib/sol/evidence/$evidence_file"
sol_compose exec back chown ops:ops "/var/lib/sol/evidence/$evidence_file"
```
````

3. In « Images », replace the code block with:

   ```bash
   revision="$(git rev-parse --short=12 HEAD)"
   printf 'BACKEND_IMAGE=sol-token-listener/backend:%s\nFRONTEND_IMAGE=sol-token-listener/frontend:%s\nVAULT_IMAGE=sol-token-listener/vault:%s\n' "$revision" "$revision" "$revision"
   sol_compose build back front vault
   ```

4. In « Démarrage et arrêt », replace the first paragraph with:

```markdown
`vault` démarre et se déverrouille seul avec la clé de `secrets/vault/unseal/`. La tâche
`migrate` attend Vault et PostgreSQL, lit les mots de passe des logins dans Vault, puis s'exécute
sous le verrou consultatif `pg_advisory_lock` des migrations. Elle :
- applique les migrations, qui restent forward-only ;
- rejoue `scripts/provision-executor-roles.sql` ;
- crée ou met à jour les neuf logins `NOINHERIT`, chacun membre d'un seul rôle de groupe.

Le back lit ensuite sa configuration et ses secrets dans Vault. Sans Vault, ni `migrate` ni le
back ne démarrent, et aucun ne se rabat sur des fichiers.
```

Keep the sentence « Les migrations restent forward-only. » exactly as it is: the runbook test checks it.

5. In « Santé et journaux », add these bullets:

```markdown
- `vault` est sain une fois déverrouillé. Son journal montre `vault.unsealed` à chaque démarrage,
  ou `vault.unseal_key_missing` si le fichier de clé manque.
- `vault-pull: Vault unavailable` dans le journal du back : Vault était arrêté ou verrouillé
  pendant 60 s. Le back redémarre en boucle jusqu'au retour de Vault, puis reprend seul.
```

6. In « Sauvegardes », replace the first paragraph with the following text, and add the restore procedure after the systemd block:

````markdown
`deploy/host/backup.sh` lance `pg_dump -Fc` dans le conteneur `postgres` et prend un instantané
raft de Vault avec l'AppRole `backup`. Il écrit l'empreinte SHA-256 de chacun et garde 14 jours
dans `$SOL_HOST_DIR/backups`.

L'instantané est chiffré. Le restaurer exige la clé de déverrouillage, qui n'est jamais dans les
sauvegardes. Le dossier des secrets n'est jamais sauvegardé. La copie hors machine (sauvegarde
externe) reste à la charge de l'opérateur.

### Restaurer Vault

Sur un Vault vide, avec la clé de déverrouillage d'origine et les fichiers AppRole d'origine dans
`secrets/vault/` :

```bash
snapshot="$SOL_HOST_DIR/backups/vault-<horodatage>.snap"
sol_compose stop back migrate
sol_compose rm --stop --force vault
docker volume rm sol-token-listener_vault-data
sol_compose up --detach vault
sol_compose exec -it vault vault operator init -key-shares=1 -key-threshold=1
sol_compose exec -it vault vault operator unseal
sol_compose cp "$snapshot" vault:/tmp/restore.snap
sol_compose exec -it vault sh -c 'vault login > /dev/null && vault operator raft snapshot restore -force /tmp/restore.snap'
sol_compose restart vault
sol_compose up --detach --wait --wait-timeout 180
```

Pendant la restauration :
- `operator init` affiche une clé et un jeton root temporaires ;
- `operator unseal` et `vault login` les demandent au TTY ;
- `restore -force` remplace ces clés et ces données par celles de l'instantané.

Au redémarrage, Vault se déverrouille avec la clé d'origine. Les AppRoles et le login `operator`
d'origine fonctionnent de nouveau.
````

7. In « Bascule vers le serveur », replace the bullet « copier `secrets/` et `config/` du Mac par `scp -rp`, en conservant les modes ; » with « copier `secrets/` du Mac par `scp -rp`, en conservant les modes ; puis restaurer l'instantané de Vault du Mac (« Restaurer Vault ») ; ».

8. Replace the body of « Rotation des secrets » with:

````markdown
- **Une valeur de Vault** (URL Helius, clé, jeton, configuration) : la modifier dans Vault, puis
  `sol_compose restart back` et `sol trading start`.
- **Le mot de passe d'un login :** le modifier dans Vault (`sol/secrets/logins/<login>`), puis
  `sol_compose run --rm migrate` et `sol_compose restart back`.
- **Le mot de passe du front :** supprimer `secrets/front/front-basic-auth-hash`, relancer
  `deploy/host/init-secrets.sh "$SOL_HOST_DIR"`, puis `sol_compose restart front`.
- **Le secret d'un AppRole :** générer un jeton root, écrire un nouveau `secret_id` dans le
  fichier, révoquer l'ancien. Les deux commandes `generate-root` demandent la clé de
  déverrouillage au TTY.

  ```bash
  sol_compose exec -it vault vault operator generate-root -generate-otp
  sol_compose exec -it vault vault operator generate-root -init -otp='<otp>'
  sol_compose exec -it vault vault operator generate-root -nonce='<nonce>'
  sol_compose exec -it vault vault operator generate-root -decode='<encoded>' -otp='<otp>'
  ```

  Avec ce jeton root (`vault login` au TTY), dans `sol_compose exec -it vault sh` :
  1. `vault write -f -field=secret_id auth/approle/role/back/secret-id` ;
  2. remplacer `secret_id` dans `secrets/vault/approle/back.json` ;
  3. `vault write auth/approle/role/back/secret-id-accessor/destroy secret_id_accessor=<ancien>` ;
  4. `vault token revoke -self`.

  Puis `sol_compose restart back`.
- **Le mot de passe administrateur PostgreSQL :** il passe par l'entrée standard, jamais par la
  ligne de commande.

  ```bash
  new_password="$(openssl rand -hex 32)"
  printf "ALTER ROLE sol_owner PASSWORD '%s';\n" "$new_password" \
    | sol_compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sol_owner -d sol_token_listener
  printf '%s\n' "$new_password" > "$SOL_HOST_DIR/secrets/db/postgres-admin-password"
  unset new_password
  ```
````

9. In « Frontière de sécurité », add:

```markdown
- Vault n'est joignable que depuis le réseau `internal` et sur `127.0.0.1:8200` de l'hôte, jamais
  par le front. Chaque conteneur lit Vault avec son propre AppRole, en lecture seule sur ses
  chemins, avec un jeton de 5 minutes révoqué après usage. Aucun jeton root ne survit à
  l'initialisation.
- Le déverrouillage automatique garde le bot autonome : qui est root sur l'hôte peut lire la clé.
  Vault centralise et trace les accès ; il ne protège pas contre un hôte compromis.
- En mode `observe`, la keypair ne sort jamais de Vault.
```

- [ ] **Step 3: Update the README and the overview**

In `README.md`, deployment section, replace the sentence about the secret files with:

```markdown
Les variables des processus (configuration et secrets) vivent dans un conteneur Vault de la stack.
`deploy/host/vault-init.sh` l'initialise une fois et `deploy/host/vault-import.sh` y importe les
fichiers actuels. Voir `docs/operations/deployment.md`.
```

In `docs/system-overview.html`, card « Déploiement de référence », replace « Les secrets sont des fichiers hors du dépôt, copiés en mémoire pour chaque utilisateur ; la keypair n’est lisible que par H2b. » with « Configuration et secrets vivent dans un conteneur Vault local, lu au démarrage et copié en mémoire pour chaque utilisateur ; la keypair n’est lisible que par H2b. »

- [ ] **Step 4: Run the documentation checks and commit**

Run: `npx tsx --test tests/deployment-artifacts.test.ts && npm run docs:check`
Expected: PASS, and `docs:check: OK`.

```bash
git add docs/operations/deployment.md README.md docs/system-overview.html tests/deployment-artifacts.test.ts
git commit -m "docs(deploy): runbook of the Vault-backed stack

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 13: Full verification and the pull request

**Files:** none new.

- [ ] **Step 1: Static checks and build**

```bash
npm run check:backend
npm run lint
npm run build:backend
npm run docs:check
```

Expected: all exit 0.

- [ ] **Step 2: The whole backend suite against the disposable database**

```bash
TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55438/sol_token_listener_test npm run test:backend
```

Expected: 0 failures. Known local flake: `live-sell-fixture` hits `PREFLIGHT_EXPIRED` when the host clock and the Docker VM clock differ. It passes in CI; rerun the file alone before judging.

- [ ] **Step 3: Container contract**

```bash
npm run deployment:smoke
npm run deployment:smoke:signal
```

Expected: `Deployment smoke passed.` and `Deployment signal fault probe passed.`

- [ ] **Step 4: Rehearse the restore on a throwaway project**

The « Restaurer Vault » procedure of the runbook, on a throwaway project with throwaway values. `COMPOSE_PROJECT_NAME` is exported so that no command can reach a real stack.

```bash
export COMPOSE_PROJECT_NAME=sol-vault-restore-check
check="$(mktemp -d)"
export SOL_HOST_DIR="$check/host"
deploy/host/init-secrets.sh "$SOL_HOST_DIR"
revision="$(git rev-parse --short=12 HEAD)"
printf '%s\n' \
  "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME" "SOL_HOST_DIR=$SOL_HOST_DIR" 'POSTGRES_DB=restore_check' \
  "BACKEND_IMAGE=sol-token-listener/backend:$revision" "FRONTEND_IMAGE=sol-token-listener/frontend:$revision" \
  "VAULT_IMAGE=sol-token-listener/vault:$revision" 'FRONT_PORT=0' 'VAULT_PORT=0' > "$SOL_HOST_DIR/compose.env"
check_compose() { docker compose --env-file "$SOL_HOST_DIR/compose.env" -f deploy/compose.yaml "$@"; }
check_compose build back front vault
deploy/host/vault-init.sh
mkdir -p "$check/import" && printf 'RESTORE_CHECK=1\n' > "$check/import/retention.env"
deploy/host/vault-import.sh "$check/import"
check_compose up --detach --wait postgres vault
SOL_REPOSITORY="$PWD" deploy/host/backup.sh
snapshot="$(ls "$SOL_HOST_DIR"/backups/vault-*.snap)"
check_compose rm --stop --force vault
docker volume rm sol-vault-restore-check_vault-data
check_compose up --detach vault
check_compose exec -it vault vault operator init -key-shares=1 -key-threshold=1
check_compose exec -it vault vault operator unseal
check_compose cp "$snapshot" vault:/tmp/restore.snap
check_compose exec -it vault sh -c 'vault login > /dev/null && vault operator raft snapshot restore -force /tmp/restore.snap'
check_compose restart vault
check_compose up --detach --wait vault
check_compose exec -it vault sh -c 'vault login -method=userpass username=operator > /dev/null && vault kv get -field=RESTORE_CHECK sol/config/retention'
check_compose down --volumes --rmi local
rm -rf "$check"
unset COMPOSE_PROJECT_NAME SOL_HOST_DIR
```

Expected:
- `vault-import.sh` and the last `vault login` ask for the operator password that `vault-init.sh` printed;
- `operator unseal` and the first `vault login` ask for the temporary key and token that `operator init` printed;
- after the restore, Vault unseals itself on `restart`, and the last command prints `1`.

If a runbook command fails, fix the runbook (Task 12) and rerun.

- [ ] **Step 5: Turn PR #264 into the implementation PR**

Write the body to a scratch file. It covers:
- summary;
- the six plan deviations;
- the evidence (image probes, smoke, restore rehearsal);
- the test plan;
- the closing line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

```bash
git push
gh pr edit 264 --title "feat(deploy): secrets and configuration under Vault" --body-file <scratch file>
gh pr ready 264
```

- [ ] **Step 6: Independent review, then merge**

Ask an independent reviewer (subagent) for an adversarial review of the branch, focused on:
- secret exposure (argv, environment, logs, files, inspect);
- the fail-closed boot;
- the policies;
- the restore and rotation procedures.

Apply the fixes, push, wait for a green CI, merge, and update `main` in the main checkout.

## Task 14: Validation on the Mac — STOP: needs the user's explicit go

This task replaces the « Dossier hôte » steps of Task 16 of `docs/superpowers/plans/2026-10-09-full-bot-compose.md`. It handles the real keys and starts the listener (RPC credits), so it needs the user's explicit go.

- [ ] **Step 1:** `deploy/host/init-secrets.sh "$SOL_HOST_DIR"`, `compose.env`, `sol_compose build back front vault`, then `deploy/host/vault-init.sh`. The user stores the operator password and a copy of the unseal key in a password manager.
- [ ] **Step 2:** `deploy/host/vault-import.sh "$HOME/.sol-token-listener/lot5/env"`. In the UI (`http://127.0.0.1:8200`), the user checks:
  - the entries under `sol/config/`;
  - `OPERATOR_API_ALLOWED_ORIGIN`;
  - the three evidence paths.

  Nothing is printed.
- [ ] **Step 3:** Continue with Task 16 of the sub-project 1 plan:
  1. takeover steps 1 to 4;
  2. start in `live` mode, trading stopped;
  3. checks.

  The `migrate` task now sets the logins from Vault.
- [ ] **Step 4:** Report to the user:
  - what passed;
  - the Helius credits consumed;
  - the next decision: go for the takeover (Task 17 of sub-project 1), or roll back.

  Rolling back means `sol_compose down` and keeping the 5433 container.

---

## Spec coverage

| Spec section | Tasks |
|---|---|
| 1–3 Purpose, current state, framing decisions | 1 |
| 4 Approach A (pull at boot) | 4, 8 |
| 5 Topology: vault service, auto-unseal, health, dependencies | 7, 9 |
| 6.1 Paths under `sol/` | 2 |
| 6.2 Policies | 5 |
| 6.3 AppRoles, operator, root token | 3, 5, 10 |
| 7.1 Back boot | 4, 8, 9 |
| 7.2 Migrate | 4, 8, 9 |
| 7.3 Failures, no fallback | 4, 11 |
| 8.1 Initialization | 5, 10 |
| 8.2 Import | 6, 10 |
| 8.3 Changes and rotation | 12 |
| 8.4 Backups | 6, 10, 11, 13 |
| 8.5 What stays on the host | 9, 10 |
| 8.6 Effects on sub-project 1 | 1, 12, 14 |
| 9 Security invariants | 3, 4, 7, 9, 11 |
| 10 Tests and validation | 2–11, 13, 14 |
| 12 Acceptance criteria | 11, 13, 14 |

# Full bot on Docker Compose — implementation plan (sub-project 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the whole bot (listener and public API, operator API, H2a, H2b, auto-arm, retention, simulation worker, operator CLIs) in a reproducible Docker Compose stack of three containers: `postgres`, `back` (every Node process under `supervisord`, one Unix user per process) and `front` (Caddy, HTTPS, password, read-only). It runs first on the Mac, then 24/7 on a Linux server, without weakening today's guarantees.

**Architecture:**
- The `back` image keeps the compiled `dist/` and adds `supervisord`, eight Unix users with fixed UIDs and six small POSIX scripts in `deploy/back/bin/`. Its entrypoint (root) copies each user's secrets from read-only mounts under `/root/secrets/` into `/run/sol/<user>/` (tmpfs, owner-only), then runs `supervisord`.
- Every process starts through `sol-run <role> <command>`. A TypeScript role table (`src/deploy/stack.ts`) and environment builder (`src/deploy/role-environment.ts`) turn `/etc/sol/config/<file>.env` (non-secret) plus the role's secret files into environment variables: `DATABASE_URL` with the encoded password and `options=-c role=<group>`, `SOLANA_HTTP_RPC_URL`, `EXECUTOR_KEYPAIR_PATH` for H2b only, and so on. Application code is unchanged except H2b's exit code 75 when it has no runnable work.
- A one-shot `migrate` task, the only holder of the admin password, applies the migrations, replays `scripts/provision-executor-roles.sql` and creates or updates the nine LOGIN roles.
- `front` is Caddy: static console, `/api/v1` and `/operator/v1/` relays, GET/HEAD/OPTIONS only, `basic_auth` from a bcrypt hash file, automatic Let's Encrypt on the server.
- The CI `deployment-contract` job keeps running `scripts/deployment-smoke.mjs`, rewritten for the new topology with throwaway secrets.

**Tech Stack:** TypeScript (Node 22, tsx, node:test), POSIX sh, supervisor 4.2.5 (Debian bookworm package), Caddy 2.10.2, Docker Compose v2 (the `!override` tag needs Compose ≥ 2.24.4), PostgreSQL 16.14.

**Spec:** `docs/superpowers/specs/2026-10-09-full-bot-compose-design.md`. Task 1 amends it where this plan departs from it.

---

## Deviations from the validated spec (Task 1 records them in the spec)

1. **Trading on and off goes through the database control state, not through starting and stopping `autoarm`.** Auto-arm also carries the provider snapshot of an open position forward (`refreshDue`, `src/storage/execution-operations.repository.ts:1298`). The runbook already says it must stay up while a position is open (`docs/operations/executor-live-canary.md`, lot 4a procedure, step 7). With the spec's design, a container restart would leave `autoarm` stopped and could block the SELL of an open position. Instead:
   - in `live` mode `autoarm` starts with the other programs;
   - before `supervisord` starts, the entrypoint turns a `RUNNING` control state into `ENTRY_STOP` (existing `kill-switch --mode=entry-stop`);
   - `sol trading start` checks for an ACTIVE envelope, waits for H2b, then runs the existing TTY-confirmed `resume`;
   - `sol trading stop` runs `kill-switch --mode=entry-stop`.

   The spec's invariant still holds: after any restart, no new BUY without a human action, and exits stay automatic.
2. **The operator API needs a secret the spec missed.** `OPERATOR_API_TOKEN` (32–256 characters, `src/operator-api/config.ts:29`) becomes the secret file `operator-api-token`. The console sends it as `Authorization: Bearer` (`frontend/src/data/operator-client.ts:33`), which a browser cannot combine with HTTP basic credentials. So `/operator/v1/` is relayed outside `basic_auth` and authenticated by the API's own token. The API also answers only the Host it binds (`OPERATOR_API_HOST:OPERATOR_API_PORT`, `src/operator-api/main.ts:30`), so Caddy rewrites that route's Host to `0.0.0.0:3100`. Caddy strips the basic credentials before relaying to the listener API.
3. **`sol report` becomes `docker compose run --rm migrate sol-admin report`.** The fast-path report reads the database as the administrator, and the admin password stays in `migrate`.
4. **The host secrets directory has one sub-directory per audience:** `db/` (admin password), `db/logins/`, `back/`, `front/`. Each container mounts only its own directories or files, so optional execution secrets may be absent in `observe` mode.
5. **The back health check is strict by default (`SOL_HEALTH_REQUIRE_OK=true`, listener health `OK`).** It can be relaxed to accept `DEGRADED` while the listener's RPC project is exhausted, and the smoke relaxes it because its listener is disabled.
6. **`sol qualify start` turns the gate-10 probe on** through a root-owned tmpfs override (`/run/sol/overrides/listener.env`), and `sol qualify stop` removes it. This keeps the runbook rule: probe only during a qualification.

## Evidence gathered before writing this plan (2026-10-09, pinned images)

- Caddy 2.10.2 with the Caddyfile of Task 10, in front of a fake back, behaves as follows. A GET without credentials gets 401 and a GET with them gets 200. Any POST gets 405, with or without credentials, operator route included. `/api/v1` and `/api/v1/…` reach port 3000, and `/operator/v1/…` reaches port 3100 carrying the bearer header. Unknown paths fall back to `index.html`. `index.html` and `config.json` are `no-store`, `/assets/*` is immutable, and the security headers are present without `Server`. The SSE stream is relayed unbuffered, and `wget http://127.0.0.1:2019/config/` succeeds inside the container.
- The front entrypoint of Task 10 runs Caddy as UID 10100 (PID 1). A root `docker exec` cannot read that process's environment.
- supervisor 4.2.5-1 from bookworm (python3 3.11.2) behaves as follows. `user=` switches the program UID, and `supervisorctl pid` with `stat -c %u /proc/<pid>` shows it. A non-root user gets `Permission denied` on the 0700 socket. `status <name>` prints `RUNNING` in column 2 and exits 3 when a listed program is not running. With `nodaemon=true`, supervisord already echoes its own log to stdout, so `logfile=/dev/null` avoids duplicate lines. `stdout_logfile=/dev/stdout` with `stdout_logfile_maxbytes=0` forwards program output to `docker logs`.
- The pinned Node image ships `setpriv` (util-linux 2.38.1) and the `node` user (UID 1000).
- `printf '%s\n' "$pw" | docker run --rm -i --entrypoint caddy <caddy image> hash-password` prints a `$2a$14$` bcrypt hash.
- `scripts/provision-executor-roles.sql` holds no psql meta-command: one `BEGIN … COMMIT`, runnable through node-postgres' simple query protocol.
- Tasks 2–14 were applied from this plan to a scratch worktree. Every file this plan creates is byte-identical to the validated copy (45 files); the Dockerfile stages, the smoke edits and the documentation edits were generated from the validated files. Results:
  - `tsc --noEmit`, `npm run lint:backend` and `npm run docs:check` passed;
  - every new test passed (46 in the deploy files), and so did the updated `tests/deployment-artifacts.test.ts` (46 tests);
  - with `dist/` built, every suite that reads the edited documents passed;
  - `npm run deployment:smoke` and `npm run deployment:smoke:signal` passed end to end.

  Before the smoke, the stack of Task 11 also ran by hand in `observe` mode on throwaway secrets, with no RPC:
  - `migrate` applied 68 migrations, replayed the provisioning and created the nine logins (NOINHERIT, one group, `ADMIN FALSE, INHERIT FALSE, SET TRUE`);
  - the back became healthy, with `listener`, `opapi` and `retention` running as UIDs 10001, 10005 and 10006;
  - the keypair was `h2b 0400` and unreadable by `listener`;
  - the front answered 401, then 200 with credentials, and 405 to a POST. The operator route answered 401 without its token and 200 with it;
  - the retention one-shot printed one clean JSON line, and `docker compose stop back` took 1 s.

  Two defects found that way are fixed in this plan: `RUN chmod -R a+rX /app/dist` (the build writes the qualification profiles 0600, so the `listener` user could not start), and the operator Host rewrite.
- `sol ops status` needs an active wallet generation (`readStatus`, `src/storage/execution-operations.repository.ts:2002`). On an empty database it prints the closed error line `{"service":"sol-token-executor-operations","event":"executor.operations_failed","errorCode":"EXECUTION_OPERATIONS_FAILED"}`. The smoke therefore checks that closed answer, and checks each login's role with psql.
- The executor templates of Task 11 parse with the real parsers: `parseLiveExecutorConfig`, `parseLiveRecoveryConfig`, `parseExecutorConfig`, `parseExecutionReadinessConfig`, `parseHeliusProviderEvidenceConfig`, `parseExecutionPreflightBundleConfig`, `parseExecutionOperationsConfig`, `parseExecutionAutoArmConfig`, `parseOperatorApiConfig` and the listener's `parseConfig`. Each was given the variables `sol-run` injects, so no injected or baseline variable trips a parser's deny-list.

## Prerequisites for every task

- Work in the worktree `.worktrees/full-bot-compose` on branch `feat/full-bot-compose`.
- Run `npm ci` once in the worktree (its own `node_modules`; see memory note «Test environment»).
- The new tests need neither PostgreSQL nor RPC. Never start a listener, never touch the native PostgreSQL on 5432, never read or print a value from `~/.sol-token-listener/` (variable names and file names only).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Commands used throughout:

```bash
npx tsx --test tests/<file>.test.ts        # one test file
npx tsc -p tsconfig.json --noEmit           # types
npm run lint:backend                        # eslint + node --check of the smoke
```

## File structure

| Path | Responsibility |
|---|---|
| `src/deploy/stack.ts` | Pure data: modes, Unix users and UIDs, logins → group roles, secret files, the 11 process roles, required roles per mode |
| `src/deploy/role-environment.ts` | Builds one role's environment from its config text and secret files; config validation; `export` rendering |
| `src/deploy/secret-distribution.ts` | Which secret file goes to which user in which mode; copies them with an injectable file system |
| `src/deploy/database-logins.ts` | Admin URL, password policy, `ensureLogin` (create/alter, one membership), group-role block extraction |
| `scripts/deploy/role-env.ts` | CLI behind `sol-run`: prints `export K='v'` lines |
| `scripts/deploy/distribute-secrets.ts` | CLI run by the entrypoint as root |
| `scripts/deploy/admin-database.ts` | CLI behind `sol-admin`: `migrate`, `group-roles`, `url` |
| `scripts/deploy/operations-state.ts` | Reads `ops status` / `envelope show` JSON for the shell scripts |
| `deploy/back/bin/{sol-entrypoint,sol-run,sol-h2b,sol,sol-health,sol-admin}` | POSIX scripts of the back image |
| `deploy/back/supervisor/supervisord.conf`, `deploy/back/supervisor/programs/{common,live}.conf` | Supervisor configuration |
| `deploy/front/Caddyfile`, `deploy/front/front-entrypoint` | Front configuration and entrypoint |
| `deploy/compose.yaml` (rewritten), `deploy/compose.server.yaml` (new), `deploy/env.example` (rewritten) | Stack definition, server override, compose inputs |
| `deploy/config/*.env.example` (10 files) | Non-secret configuration templates, one per config file |
| `deploy/host/{init-secrets.sh,backup.sh,sol-backup.service,sol-backup.timer,com.sol-token-listener.backup.plist}` | Host-side tooling |
| `deploy/sql/{table-row-counts.sql,takeover-precondition.sql}` | Takeover checks |
| `deploy/nginx.conf`, `deploy/compose.smoke.yaml` | Deleted |
| `Dockerfile` | `backend` and `frontend` stages rewritten |
| `src/executor-live/main.ts` | Exit code 75 for `LIVE_EXECUTOR_NO_WORK` |
| `scripts/deployment-smoke.mjs` | Smoke adapted to the new topology |
| `tests/deploy-*.test.ts` (7 new files), `tests/deployment-artifacts.test.ts`, `tests/executor-live-main.integration.test.ts` | Tests |
| `docs/operations/deployment.md` (rewritten), `README.md`, `docs/system-overview.html`, `docs/operations/block-hydration-canary.md`, `docs/operations/executor-live-canary.md`, the spec | Documentation |

Task order: Tasks 1–8 add code and tests without touching any deployment artifact, so the existing deployment tests stay green. Tasks 9–14 replace the artifacts, and each one updates the assertions of `tests/deployment-artifacts.test.ts` it invalidates. Task 15 verifies everything locally and ships the PR. Tasks 16–18 are operational and need the user's explicit go.

---

## Task 1: Amend the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-full-bot-compose-design.md`

- [ ] **Step 1: Replace the `autoarm` row of the table in section 6.2**

Old:

```markdown
| `autoarm` | `dist/src/executor-operations/auto-arm-main.js` | jamais seul (6.4) | `sol_autoarm` → `sol_token_executor_operations` |
```

New:

```markdown
| `autoarm` | `dist/src/executor-operations/auto-arm-main.js` | automatique en mode `live` ; n'arme qu'en état de contrôle `RUNNING` (6.4) | `sol_autoarm` → `sol_token_executor_operations` |
```

- [ ] **Step 2: Replace the mode sentence of section 6.2**

Old:

```markdown
y utilise l'URL Helius du listener. Le mode `live` ajoute `h2b`, `h2a` et rend `autoarm` et
`worker` disponibles ; `opapi` y utilise l'URL Helius de l'exécuteur.
```

New:

```markdown
y utilise l'URL Helius du listener. Le mode `live` ajoute `h2b`, `h2a` et `autoarm`, et rend
`worker` disponible ; `opapi` y utilise l'URL Helius de l'exécuteur.
```

- [ ] **Step 3: Replace the body of section 6.4 (keep the heading `### 6.4 Démarrage du trading`)**

Old:

```markdown
`sol trading start` exige une enveloppe active, attend au plus 60 s que H2b soit `RUNNING`, puis
démarre `autoarm` ; sans enveloppe active ou sans H2b prêt dans ce délai, la commande échoue
sans démarrer `autoarm`. `sol trading stop` arrête `autoarm`, puis laisse H2b finir son travail
en cours. Après un crash ou un redémarrage du conteneur, `autoarm` reste arrêté : aucun nouvel
achat ne part sans une commande humaine, alors que les sorties continuent.
```

New:

```markdown
`autoarm` a deux rôles : armer les achats d'une enveloppe active et rafraîchir le snapshot
provider d'une position ouverte, sans lequel le SELL est refusé. Il tourne donc en permanence en
mode `live`, et l'autorisation d'acheter passe par l'état de contrôle en base :

- au démarrage du conteneur, avant `supervisord`, le script d'entrée ramène un état `RUNNING` à
  `ENTRY_STOP` (`kill-switch --mode=entry-stop`) ; un état `HARD_STOP` est laissé tel quel ;
- `sol trading start` exige une enveloppe `ACTIVE`, attend au plus 60 s que H2b soit `RUNNING`
  depuis au moins 15 s, puis lance `resume`, confirmé au TTY ; sans enveloppe active ou sans H2b
  prêt dans ce délai, la commande échoue sans rien changer ;
- `sol trading stop` pose `ENTRY_STOP` : plus aucun armement ni signature de BUY, alors que les
  sorties continuent.

Après un crash ou un redémarrage du conteneur, aucun nouvel achat ne part sans une commande
humaine, alors que les sorties continuent.
```

- [ ] **Step 4: Replace the end of section 6.5**

Old:

```markdown
ou en attente normale de travail, et si `autoarm` est `RUNNING` lorsque le trading a été
démarré.
```

New:

```markdown
ou en attente normale de travail, et si `autoarm` est `RUNNING` en mode `live`. Par défaut,
l'endpoint du listener doit répondre `OK` ; `SOL_HEALTH_REQUIRE_OK=false` accepte `DEGRADED`
(listener désactivé dans le smoke, ou projet RPC du listener épuisé).
```

- [ ] **Step 5: Replace the end of section 6.7**

Old:

```markdown
`sol ops status`, `sol readiness …`, `sol evidence provider`, `sol evidence bundle`,
`sol report`.
```

New:

```markdown
`sol ops status`, `sol readiness …`, `sol evidence provider`, `sol evidence bundle`,
`sol qualify start|stop`, `sol trading start|stop`. Le rapport lit la base en administrateur :
il passe par la tâche `migrate`, seule détentrice du mot de passe administrateur,
avec `docker compose run --rm migrate sol-admin report`.
```

- [ ] **Step 6: Add the operator API token to the table of section 7.1**

Insert this row right after the `wallet-keypair.json` row:

```markdown
| Jeton de l'API opérateur (32 à 256 caractères) | `operator-api-token` | `back`, `opapi` |
```

- [ ] **Step 7: Replace the first two bullets of section 7.2**

Old:

```markdown
- Dossier sur l'hôte, hors du dépôt, en 0700 : `~/.sol-token-listener/docker/secrets/` sur le
  Mac, `/srv/sol-token-listener/secrets/` sur le serveur. Un fichier par secret, en 0600.
- Chaque conteneur ne monte que les fichiers qu'il utilise, en lecture seule, sous
  `/root/secrets/` : seul root peut traverser `/root`.
```

New:

```markdown
- Dossier sur l'hôte, hors du dépôt, en 0700 : `~/.sol-token-listener/docker/secrets/` sur le
  Mac, `/srv/sol-token-listener/secrets/` sur le serveur. Un fichier par secret, en 0600, rangé
  par destinataire : `db/postgres-admin-password`, `db/logins/pg-<login>-password`, `back/…`,
  `front/front-basic-auth-hash`.
- Chaque conteneur ne monte que ses fichiers ou dossiers, en lecture seule, sous
  `/root/secrets/` : seul root peut traverser `/root`. `postgres` monte le fichier
  administrateur, `migrate` le dossier `db/`, `back` les dossiers `db/logins/` et `back/`,
  `front` le fichier d'empreinte.
```

- [ ] **Step 8: Replace the authentication bullet of section 8**

Old:

```markdown
- Authentification `basic_auth` sur toutes les routes, interface comprise. Mot de passe
  aléatoire d'au moins 24 caractères ; Caddy ne reçoit que son empreinte bcrypt, depuis le
  fichier secret, jamais dans le `Caddyfile` ni dans le compose.
```

New:

```markdown
- Authentification `basic_auth` sur toutes les routes, interface comprise, sauf `/operator/v1/` :
  la console y envoie son propre `Authorization: Bearer`, que l'API opérateur vérifie avec
  `operator-api-token`, et un navigateur ne peut pas joindre en plus des identifiants HTTP
  basic. L'API ne répond qu'à l'en-tête Host qu'elle écoute : Caddy le réécrit en
  `0.0.0.0:3100` sur cette route. Mot de passe aléatoire d'au moins 24 caractères ; Caddy ne reçoit que son empreinte
  bcrypt, depuis le fichier secret, jamais dans le `Caddyfile` ni dans le compose. Caddy retire
  l'en-tête `Authorization` avant de relayer vers l'API du listener.
```

- [ ] **Step 9: Replace the supervisor bullet of section 11.1**

Old:

```markdown
- dans la configuration de `supervisord`, `autoarm` n'a jamais `autostart=true`, et chaque
  programme a son utilisateur et ses délais d'arrêt ;
```

New:

```markdown
- dans la configuration de `supervisord`, `worker` n'a jamais `autostart=true`, `autoarm`
  n'existe qu'en mode `live`, chaque programme a son utilisateur et ses délais d'arrêt, et le
  script d'entrée pose l'entry-stop avant de lancer `supervisord` ;
```

- [ ] **Step 10: Replace the `autoarm` invariant of section 13**

Old:

```markdown
- `autoarm` ne démarre jamais sans `sol trading start` ; après tout redémarrage, aucun nouvel
  achat sans action humaine. Les sorties restent automatiques.
```

New:

```markdown
- Aucun armement sans `sol trading start` : au démarrage du conteneur en mode `live`, un état
  de contrôle `RUNNING` est ramené à `ENTRY_STOP` avant le lancement des programmes, et seul
  `sol trading start` (confirmation TTY) le rétablit. Les sorties restent automatiques : H2a,
  H2b et le rafraîchissement provider d'`autoarm` tournent en permanence.
```

- [ ] **Step 11: Append section 16 at the end of the spec**

```markdown

## 16. Amendements du 2026-10-09 (plan d'implémentation)

Le plan `docs/superpowers/plans/2026-10-09-full-bot-compose.md` a modifié ce spec sur six points,
reportés dans les sections concernées :

1. Trading par l'état de contrôle en base (6.2, 6.4, 6.5, 11.1, 13) : `autoarm` rafraîchit aussi
   le snapshot provider des positions ouvertes ; l'arrêter bloquerait les sorties.
2. Jeton de l'API opérateur (7.1) et route `/operator/v1/` hors `basic_auth`, authentifiée par ce
   jeton (8).
3. Rapport administrateur par `docker compose run --rm migrate sol-admin report` (6.7).
4. Secrets rangés par destinataire, montés par dossier (7.2).
5. Santé stricte par défaut, assouplie par `SOL_HEALTH_REQUIRE_OK=false` (6.5).
6. `sol qualify start` active la sonde du gate 10 par une surcharge en tmpfs, `sol qualify stop`
   la retire (runbook du lot 4a, étape 1).
```

- [ ] **Step 12: Commit**

```bash
git add docs/superpowers/specs/2026-10-09-full-bot-compose-design.md
git commit -m "docs(spec): amend the full-bot compose design before implementation

Trading through the control state (auto-arm also refreshes the provider snapshot of open
positions), operator API token and bearer route, admin report through migrate, secrets
grouped by audience, configurable health strictness, gate-10 probe override.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: H2b exits 75 when it has no runnable work

**Files:**
- Modify: `src/executor-live/main.ts:421-434` (`reportLiveExecutorEntrypointFailure`)
- Test: `tests/executor-live-main.integration.test.ts` (new test after the one ending at line 914)

- [ ] **Step 1: Write the failing test**

Insert after the test `'fatal handler preserves closed H2b startup identities without exposing details'` (it ends at line 914):

```ts
void test('fatal handler exits 75 (EX_TEMPFAIL) only when H2b has no runnable work', () => {
  const hostileNoWork = Object.freeze({
    name: 'Error',
    get code() { return 'LIVE_EXECUTOR_NO_WORK'; },
  });
  const cases: readonly (readonly [unknown, number])[] = [
    [new ExecutionLiveRepositoryError('LIVE_EXECUTOR_NO_WORK'), 75],
    [new ExecutionLiveRepositoryError('LIVE_EXECUTOR_FOREIGN_LEASE_ACTIVE'), 1],
    [hostileNoWork, 1],
    [new Error('LIVE_EXECUTOR_NO_WORK'), 1],
  ];
  for (const [error, expected] of cases) {
    const writes: string[] = [];
    const processLike: { exitCode?: string | number; stderr: { write(chunk: string): unknown } } = {
      stderr: { write: (chunk) => { writes.push(chunk); } },
    };
    reportLiveExecutorEntrypointFailure(error, processLike);
    assert.equal(processLike.exitCode, expected);
    assert.equal(writes.length, 1);
    assert.match(writes[0] ?? '', /"event":"executor_live\.start_failed"/u);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test tests/executor-live-main.integration.test.ts`
Expected: FAIL in `fatal handler exits 75 (EX_TEMPFAIL) only when H2b has no runnable work` with `1 !== 75`.

- [ ] **Step 3: Implement**

Replace the whole function in `src/executor-live/main.ts`:

```ts
/** EX_TEMPFAIL: no runnable work yet; the `sol-h2b` loop relaunches H2b later (spec 6.3). */
export const LIVE_EXECUTOR_NO_WORK_EXIT_CODE = 75;

export function reportLiveExecutorEntrypointFailure(
  error: unknown,
  runtime: { exitCode?: string | number | undefined; stderr: Readonly<{ write(chunk: string): unknown }> } = process,
): void {
  const errorCode = safeErrorProperty(
    error, 'code', LIVE_EXECUTOR_SAFE_ERROR_CODE_SET, 'LIVE_EXECUTOR_START_FAILED',
  );
  runtime.exitCode = errorCode === 'LIVE_EXECUTOR_NO_WORK' ? LIVE_EXECUTOR_NO_WORK_EXIT_CODE : 1;
  runtime.stderr.write(`${JSON.stringify(Object.freeze({
    service: 'sol-token-executor-live',
    event: 'executor_live.start_failed',
    errorName: safeErrorProperty(error, 'name', SAFE_FATAL_NAMES, 'UnknownError'),
    errorCode,
  }))}\n`);
}
```

The code comes from `safeErrorProperty`, which only accepts an own data property from the safe set. A getter or a message never yields 75.

- [ ] **Step 4: Run the file again**

Run: `npx tsx --test tests/executor-live-main.integration.test.ts`
Expected: PASS (all tests of the file, including the two existing fatal-handler tests that still expect 1).

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc -p tsconfig.json --noEmit
git add src/executor-live/main.ts tests/executor-live-main.integration.test.ts
git commit -m "feat(executor-live): exit 75 (EX_TEMPFAIL) when H2b has no runnable work

The compose stack relaunches H2b on demand: a sol-h2b loop retries 15 s after exit 75 and
backs off after any other exit (spec 6.3). Every other startup failure still exits 1.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Stack model (users, logins, roles, secret files)

**Files:**
- Create: `src/deploy/stack.ts`
- Test: `tests/deploy-stack.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/deploy-stack.test.ts`:

```ts
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
  resolveHttpRpc,
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
  for (const mode of ['observe', 'live'] as const) {
    for (const name of ROLE_NAMES) {
      const files = roleSecretFiles(ROLES[name], mode).map((secret) => secret.file);
      if (files.includes('wallet-keypair.json')) assert.equal(name, 'h2b');
      if (files.includes('evidence-private-key') || files.includes('helius-admin-api-key')) {
        assert.equal(ROLES[name].user, 'ops');
      }
      if (files.includes('operator-api-token')) assert.equal(name, 'opapi');
    }
  }
});

void test('RPC projects: listener for the listener, by mode for opapi, none for the operations CLI', () => {
  assert.equal(resolveHttpRpc(ROLES.listener, 'live'), 'helius-listener-http-url');
  assert.equal(resolveHttpRpc(ROLES.opapi, 'observe'), 'helius-listener-http-url');
  assert.equal(resolveHttpRpc(ROLES.opapi, 'live'), 'helius-executor-http-url');
  assert.equal(resolveHttpRpc(ROLES.h2b, 'live'), 'helius-executor-http-url');
  assert.equal(resolveHttpRpc(ROLES.operations, 'live'), undefined);
  assert.equal(resolveHttpRpc(ROLES['evidence-provider'], 'live'), undefined);
  assert.equal(resolveHttpRpc(ROLES['evidence-bundle'], 'live'), undefined);
});

void test('observe needs no execution secret; live adds the executor programs and the boot entry-stop', () => {
  assert.deepEqual(REQUIRED_ROLES.observe, ['listener', 'opapi', 'retention']);
  assert.deepEqual(REQUIRED_ROLES.live, [
    'listener', 'opapi', 'retention', 'h2a', 'h2b', 'autoarm', 'operations',
  ]);
  const observeFiles = REQUIRED_ROLES.observe.flatMap(
    (name) => roleSecretFiles(ROLES[name], 'observe').map((secret) => secret.file),
  );
  for (const file of [
    'wallet-keypair.json', 'helius-executor-http-url', 'evidence-private-key', 'helius-admin-api-key',
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test tests/deploy-stack.test.ts`
Expected: FAIL, `Cannot find module '../src/deploy/stack.js'`.

- [ ] **Step 3: Implement**

Create `src/deploy/stack.ts`:

```ts
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
```

- [ ] **Step 4: Run the test**

Run: `npx tsx --test tests/deploy-stack.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx tsc -p tsconfig.json --noEmit && npm run lint:backend
git add src/deploy/stack.ts tests/deploy-stack.test.ts
git commit -m "feat(deploy): describe the compose stack roles, users, logins and secrets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Role environment builder

**Files:**
- Create: `src/deploy/role-environment.ts`
- Test: `tests/deploy-role-environment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/deploy-role-environment.test.ts`:

```ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  RoleEnvironmentError,
  buildRoleEnvironment,
  loginDatabaseUrl,
  parseRoleConfig,
  renderShellExports,
  secretText,
} from '../src/deploy/role-environment.js';
import type { RoleName, StackMode } from '../src/deploy/stack.js';

const LEAK = 'value-that-must-not-leak';
const SECRETS: Readonly<Record<string, string>> = Object.freeze({
  '/run/sol/listener/pg-sol_listener-password': 'p@ss/word:with?reserved#chars\n',
  '/run/sol/listener/helius-listener-http-url': 'https://listener.invalid/?api-key=listener-key\n',
  '/run/sol/listener/helius-listener-ws-url': 'wss://listener.invalid/?api-key=listener-key\n',
  '/run/sol/opapi/pg-sol_reader-password': 'reader-password-0123456789\n',
  '/run/sol/opapi/operator-api-token': 'operator-token-0123456789abcdef0123456789abcdef\n',
  '/run/sol/opapi/helius-listener-http-url': 'https://listener.invalid/?api-key=listener-key\n',
  '/run/sol/opapi/helius-executor-http-url': 'https://executor.invalid/?api-key=executor-key\n',
  '/run/sol/h2b/pg-sol_live-password': 'live-password-0123456789\n',
  '/run/sol/h2b/helius-executor-http-url': 'https://executor.invalid/?api-key=executor-key\n',
  '/run/sol/h2b/wallet-keypair.json': '[1,2,3]\n',
  '/run/sol/worker/pg-sol_worker-password': 'worker-password-0123456789\n',
  '/run/sol/worker/helius-executor-http-url': 'https://executor.invalid/\n',
  '/run/sol/ops/helius-admin-api-key': 'admin-key\n',
  '/run/sol/ops/evidence-private-key': 'private-key-material\n',
});

function build(
  role: RoleName,
  configText: string,
  options: Readonly<{ mode?: StackMode; overrideText?: string }> = {},
): Readonly<Record<string, string>> {
  return buildRoleEnvironment({
    role,
    mode: options.mode ?? 'live',
    databaseName: 'sol_token_listener',
    configText,
    overrideText: options.overrideText ?? null,
    runDirectory: '/run/sol',
    readSecret: (path) => {
      const value = SECRETS[path];
      if (value === undefined) throw new RoleEnvironmentError(`missing file ${path}`);
      return value;
    },
    secretExists: (path) => SECRETS[path] !== undefined,
  });
}

void test('the listener gets its configuration, an encoded login URL and both listener RPC URLs', () => {
  const environment = build('listener', 'LISTENER_ENABLED=true\nAPI_HOST=0.0.0.0\n');
  assert.equal(environment.LISTENER_ENABLED, 'true');
  assert.equal(
    environment.DATABASE_URL,
    'postgresql://sol_listener:p%40ss%2Fword%3Awith%3Freserved%23chars@postgres:5432/sol_token_listener'
      + '?options=-c%20role%3Dsol_token_listener_writer',
  );
  assert.equal(environment.SOLANA_HTTP_RPC_URL, 'https://listener.invalid/?api-key=listener-key');
  assert.equal(environment.SOLANA_WS_RPC_URL, 'wss://listener.invalid/?api-key=listener-key');
  assert.equal(environment.SOL_RUN_USER, 'listener');
  assert.equal(environment.SOL_RUN_UID, '10001');
  assert.equal(environment.EXECUTOR_KEYPAIR_PATH, undefined);
});

void test('only H2b gets the keypair path, and the worker pins its search_path', () => {
  const h2b = build('h2b', 'EXECUTOR_MODE=live\n');
  assert.equal(h2b.EXECUTOR_KEYPAIR_PATH, '/run/sol/h2b/wallet-keypair.json');
  assert.equal(h2b.SOLANA_HTTP_RPC_URL, 'https://executor.invalid/?api-key=executor-key');
  const worker = build('worker', 'EXECUTOR_MODE=simulation-only\n');
  assert.match(
    worker.DATABASE_URL ?? '',
    /\?options=-c%20role%3Dsol_token_executor_worker%20-c%20search_path%3Dpg_catalog%2Cpublic$/u,
  );
  assert.equal(worker.EXECUTOR_KEYPAIR_PATH, undefined);
});

void test('the operator API reads its token and follows the mode for its RPC project', () => {
  const observe = build('opapi', 'OPERATOR_API_HOST=0.0.0.0\n', { mode: 'observe' });
  assert.equal(observe.OPERATOR_API_TOKEN, 'operator-token-0123456789abcdef0123456789abcdef');
  assert.equal(observe.SOLANA_HTTP_RPC_URL, 'https://listener.invalid/?api-key=listener-key');
  assert.match(observe.OPERATOR_API_DATABASE_URL ?? '', /^postgresql:\/\/sol_reader:/u);
  assert.equal(observe.DATABASE_URL, undefined);
  const live = build('opapi', 'OPERATOR_API_HOST=0.0.0.0\n', { mode: 'live' });
  assert.equal(live.SOLANA_HTTP_RPC_URL, 'https://executor.invalid/?api-key=executor-key');
});

void test('evidence roles get secret file paths and nothing else', () => {
  const provider = build('evidence-provider', 'HELIUS_PROJECT_ID=project\n');
  assert.equal(provider.HELIUS_API_KEY_PATH, '/run/sol/ops/helius-admin-api-key');
  assert.equal(provider.EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH, '/run/sol/ops/evidence-private-key');
  const bundle = build(
    'evidence-bundle', 'EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY=/var/lib/sol/evidence\n',
  );
  assert.deepEqual(Object.keys(bundle).sort(), [
    'EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH',
    'EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY',
    'SOL_RUN_UID',
    'SOL_RUN_USER',
  ]);
});

void test('configuration files cannot carry secrets, injected variables or credentials', () => {
  for (const key of [
    'DATABASE_URL', 'SOLANA_HTTP_RPC_URL', 'EXECUTOR_KEYPAIR_PATH', 'OPERATOR_API_TOKEN',
    'POSTGRES_PASSWORD', 'EXECUTOR_PRIVATE_KEY', 'SOL_RUN_UID',
  ]) {
    assert.throws(
      () => parseRoleConfig(`${key}=${LEAK}\n`, 'live.env'),
      (error: unknown) => error instanceof RoleEnvironmentError
        && error.message === `live.env: ${key} comes from a secret file, not from the configuration`,
    );
  }
  for (const value of [`https://x.invalid/?api-key=${LEAK}`, `postgresql://user:${LEAK}@host/db`]) {
    assert.throws(
      () => parseRoleConfig(`LISTENER_NOTE=${value}\n`, 'listener.env'),
      (error: unknown) => error instanceof RoleEnvironmentError
        && error.message === 'listener.env: LISTENER_NOTE looks like a credential',
    );
  }
  assert.throws(() => parseRoleConfig('MULTI="a\nb"\n', 'listener.env'), RoleEnvironmentError);
  assert.deepEqual(
    parseRoleConfig('# comment\nEXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64=AAAA\n', 'operations.env'),
    { EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: 'AAAA' },
  );
});

void test('an override wins over the configuration and obeys the same rules', () => {
  const environment = build('listener', 'FAST_ENTRY_PROBE_ENABLED=false\n', {
    overrideText: 'FAST_ENTRY_PROBE_ENABLED=true\n',
  });
  assert.equal(environment.FAST_ENTRY_PROBE_ENABLED, 'true');
  assert.throws(
    () => build('listener', '', { overrideText: `DATABASE_URL=${LEAK}\n` }),
    (error: unknown) => error instanceof RoleEnvironmentError
      && error.message.startsWith('override listener.env: ')
      && !error.message.includes(LEAK),
  );
});

void test('a missing or malformed secret fails with its file name only', () => {
  assert.throws(
    () => build('autoarm', 'EXECUTOR_POLL_MS=500\n'),
    (error: unknown) => error instanceof RoleEnvironmentError
      && error.message === 'missing file /run/sol/autoarm/pg-sol_autoarm-password',
  );
  assert.throws(
    () => secretText(`two ${LEAK}\n`, 'pg-sol_ops-password'),
    (error: unknown) => error instanceof RoleEnvironmentError
      && error.message === 'pg-sol_ops-password: expected one printable line without spaces',
  );
  assert.equal(secretText('value\r\n', 'file'), 'value');
  assert.throws(
    () => loginDatabaseUrl({
      login: 'sol_ops', password: 'x'.repeat(24), databaseName: 'Bad-Name', searchPath: false,
    }),
    RoleEnvironmentError,
  );
});

void test('shell exports keep hostile values literal', () => {
  const hostile = "it's $(touch /nonexistent/never) `x` \\ \"q\"";
  const rendered = renderShellExports({ SOL_RUN_USER: 'listener', LISTENER_NOTE: hostile });
  assert.equal(
    rendered,
    "export LISTENER_NOTE='it'\\''s $(touch /nonexistent/never) `x` \\ \"q\"'\n"
      + "export SOL_RUN_USER='listener'\n",
  );
  const shell = spawnSync('sh', ['-c', `${rendered}printf '%s' "$LISTENER_NOTE"`], { encoding: 'utf8' });
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(shell.stdout, hostile);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test tests/deploy-role-environment.test.ts`
Expected: FAIL, `Cannot find module '../src/deploy/role-environment.js'`.

- [ ] **Step 3: Implement**

Create `src/deploy/role-environment.ts`:

```ts
import { parse } from 'dotenv';
import {
  DATABASE_HOST,
  DATABASE_LOGINS,
  DATABASE_PORT,
  ROLES,
  STACK_USERS,
  loginPasswordFile,
  resolveHttpRpc,
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

/** Parses a non-secret dotenv file and refuses anything that belongs in a secret file. */
export function parseRoleConfig(text: string, label: string): Readonly<Record<string, string>> {
  const parsed = parse(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (!VARIABLE.test(key)) throw new RoleEnvironmentError(`${label}: invalid variable name`);
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

function rpcUrl(raw: string, file: string, protocol: 'https:' | 'wss:'): string {
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
  const httpRpc = resolveHttpRpc(role, input.mode);
  if (httpRpc !== undefined) {
    environment.SOLANA_HTTP_RPC_URL = rpcUrl(
      input.readSecret(`${directory}/${httpRpc}`), httpRpc, 'https:',
    );
  }
  if (role.wsRpc !== undefined) {
    environment.SOLANA_WS_RPC_URL = rpcUrl(
      input.readSecret(`${directory}/${role.wsRpc}`), role.wsRpc, 'wss:',
    );
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
    if (!VARIABLE.test(key)) throw new RoleEnvironmentError('invalid variable name');
    const value = environment[key] ?? '';
    return `export ${key}='${value.replaceAll("'", "'\\''")}'\n`;
  }).join('');
}
```

- [ ] **Step 4: Run the test**

Run: `npx tsx --test tests/deploy-role-environment.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx tsc -p tsconfig.json --noEmit && npm run lint:backend
git add src/deploy/role-environment.ts tests/deploy-role-environment.test.ts
git commit -m "feat(deploy): build each role's environment from its config and secret files

Config files may not carry secrets, injected variables or credentials; database URLs encode
the password and pin the group role; errors name files and variables, never values.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: `role-env` command (the engine of `sol-run`)

**Files:**
- Create: `scripts/deploy/role-env.ts`
- Test: `tests/deploy-role-env-cli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/deploy-role-env-cli.test.ts`:

```ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runRoleEnvCli } from '../scripts/deploy/role-env.js';

async function fixture(): Promise<Readonly<{ root: string; environment: NodeJS.ProcessEnv }>> {
  const root = await mkdtemp(join(tmpdir(), 'sol-role-env-'));
  const config = join(root, 'config');
  const run = join(root, 'run');
  await mkdir(config);
  await mkdir(join(run, 'retention'), { recursive: true });
  await mkdir(join(run, 'overrides'));
  await writeFile(join(config, 'retention.env'), 'DATA_RETENTION_HOURS=4\nRETENTION_PURGE_INTERVAL_MS=900000\n');
  await writeFile(join(run, 'retention', 'pg-sol_retention-password'), "retention'password-0123456789\n");
  return {
    root,
    environment: { SOL_CONFIG_DIR: config, SOL_RUN_DIR: run, SOL_STACK_MODE: 'observe', POSTGRES_DB: 'smoke' },
  };
}

function capture(): Readonly<{
  out: string[];
  err: string[];
  io: Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>;
}> {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (text) => { out.push(text); }, stderr: (text) => { err.push(text); } } };
}

void test('role-env prints exports that sh evaluates into the role environment', async () => {
  const { root, environment } = await fixture();
  try {
    const { out, err, io } = capture();
    assert.equal(runRoleEnvCli(['retention'], environment, io), 0);
    assert.deepEqual(err, []);
    const shell = spawnSync('sh', [
      '-c', `${out.join('')}printf '%s|%s|%s' "$DATA_RETENTION_HOURS" "$SOL_RUN_UID" "$DATABASE_URL"`,
    ], { encoding: 'utf8' });
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(
      shell.stdout,
      "4|10006|postgresql://sol_retention:retention'password-0123456789@postgres:5432/smoke"
        + '?options=-c%20role%3Dsol_token_retention_worker',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('an override file in the run directory wins over the configuration', async () => {
  const { root, environment } = await fixture();
  try {
    await writeFile(join(root, 'run', 'overrides', 'retention.env'), 'DATA_RETENTION_HOURS=5\n');
    const { out, io } = capture();
    assert.equal(runRoleEnvCli(['retention'], environment, io), 0);
    assert.match(out.join(''), /^export DATA_RETENTION_HOURS='5'$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('role-env refuses unknown roles and reports missing files without values', async () => {
  const { root, environment } = await fixture();
  try {
    let captured = capture();
    assert.equal(runRoleEnvCli(['nosuch'], environment, captured.io), 64);
    assert.deepEqual(captured.err, ['usage: role-env <role>\n']);

    captured = capture();
    assert.equal(runRoleEnvCli(['listener'], environment, captured.io), 78);
    assert.deepEqual(captured.out, []);
    assert.match(captured.err.join(''), /^sol-run listener: missing file .*\/config\/listener\.env\n$/u);

    captured = capture();
    assert.equal(runRoleEnvCli(['retention'], { ...environment, SOL_STACK_MODE: 'LIVE' }, captured.io), 78);
    assert.deepEqual(captured.err, ['sol-run retention: SOL_STACK_MODE must be observe or live\n']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test tests/deploy-role-env-cli.test.ts`
Expected: FAIL, `Cannot find module '../scripts/deploy/role-env.js'`.

- [ ] **Step 3: Implement**

Create `scripts/deploy/role-env.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  RoleEnvironmentError,
  buildRoleEnvironment,
  renderShellExports,
} from '../../src/deploy/role-environment.js';
import { ROLES, isRoleName, isStackMode } from '../../src/deploy/stack.js';

export interface RoleEnvCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * Prints the `export` lines `sol-run` evaluates before it execs a process of the stack.
 * Exit codes: 0, 64 (usage), 78 (EX_CONFIG: missing or invalid configuration or secret).
 */
export function runRoleEnvCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: RoleEnvCliIo,
): number {
  const [role, ...rest] = argv;
  if (role === undefined || rest.length > 0 || !isRoleName(role)) {
    io.stderr('usage: role-env <role>\n');
    return 64;
  }
  try {
    const mode = environment.SOL_STACK_MODE ?? 'observe';
    if (!isStackMode(mode)) throw new RoleEnvironmentError('SOL_STACK_MODE must be observe or live');
    const definition = ROLES[role];
    const configDirectory = environment.SOL_CONFIG_DIR ?? '/etc/sol/config';
    const runDirectory = environment.SOL_RUN_DIR ?? '/run/sol';
    const overridePath = `${runDirectory}/overrides/${definition.configFile}`;
    io.stdout(renderShellExports(buildRoleEnvironment({
      role,
      mode,
      databaseName: environment.POSTGRES_DB ?? 'sol_token_listener',
      configText: readRequired(`${configDirectory}/${definition.configFile}`),
      overrideText: existsSync(overridePath) ? readRequired(overridePath) : null,
      runDirectory,
      readSecret: readRequired,
      secretExists: (path) => existsSync(path),
    })));
    return 0;
  } catch (error) {
    const reason = error instanceof RoleEnvironmentError ? error.message : 'cannot build the environment';
    io.stderr(`sol-run ${role}: ${reason}\n`);
    return 78;
  }
}

function readRequired(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new RoleEnvironmentError(`missing file ${path}`);
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = runRoleEnvCli(process.argv.slice(2), process.env, {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}
```

- [ ] **Step 4: Run the test**

Run: `npx tsx --test tests/deploy-role-env-cli.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx tsc -p tsconfig.json --noEmit && npm run lint:backend
git add scripts/deploy/role-env.ts tests/deploy-role-env-cli.test.ts
git commit -m "feat(deploy): add the role-env command behind sol-run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Secret distribution (entrypoint side)

**Files:**
- Create: `src/deploy/secret-distribution.ts`
- Create: `scripts/deploy/distribute-secrets.ts`
- Test: `tests/deploy-secret-distribution.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/deploy-secret-distribution.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDistributeSecretsCli } from '../scripts/deploy/distribute-secrets.js';
import {
  SecretDistributionError,
  distributeSecrets,
  secretGrants,
  type DistributionFileSystem,
} from '../src/deploy/secret-distribution.js';

function describe(mode: 'observe' | 'live', user: string): string[] {
  return secretGrants(mode)
    .filter((grant) => grant.user === user)
    .map((grant) => `${grant.source}/${grant.file}${grant.required ? '' : ' (optional)'}`)
    .sort();
}

void test('live grants give every program its own secrets and nothing else', () => {
  assert.deepEqual(describe('live', 'listener'), [
    'back/helius-listener-http-url', 'back/helius-listener-ws-url', 'logins/pg-sol_listener-password',
  ]);
  assert.deepEqual(describe('live', 'h2b'), [
    'back/helius-executor-http-url', 'back/wallet-keypair.json', 'logins/pg-sol_live-password',
  ]);
  assert.deepEqual(describe('live', 'h2a'), [
    'back/helius-executor-http-url', 'logins/pg-sol_recovery-password',
  ]);
  assert.deepEqual(describe('live', 'autoarm'), [
    'back/helius-executor-http-url', 'logins/pg-sol_autoarm-password',
  ]);
  assert.deepEqual(describe('live', 'opapi'), [
    'back/helius-executor-http-url', 'back/operator-api-token', 'logins/pg-sol_reader-password',
  ]);
  assert.deepEqual(describe('live', 'retention'), ['logins/pg-sol_retention-password']);
  assert.deepEqual(describe('live', 'worker'), [
    'back/helius-executor-http-url (optional)', 'logins/pg-sol_worker-password (optional)',
  ]);
  assert.deepEqual(describe('live', 'ops'), [
    'back/evidence-private-key (optional)',
    'back/helius-admin-api-key (optional)',
    'back/helius-executor-http-url (optional)',
    'logins/pg-sol_ops-password',
    'logins/pg-sol_readiness-password (optional)',
  ]);
});

void test('observe needs only the listener, operator API and retention secrets', () => {
  const required = secretGrants('observe')
    .filter((grant) => grant.required)
    .map((grant) => `${grant.user}:${grant.file}`)
    .sort();
  assert.deepEqual(required, [
    'listener:helius-listener-http-url',
    'listener:helius-listener-ws-url',
    'listener:pg-sol_listener-password',
    'opapi:helius-listener-http-url',
    'opapi:operator-api-token',
    'opapi:pg-sol_reader-password',
    'retention:pg-sol_retention-password',
  ]);
});

function recordingFileSystem(present: readonly string[]): Readonly<{
  fs: DistributionFileSystem;
  operations: string[];
}> {
  const files = new Set(present);
  const operations: string[] = [];
  return {
    operations,
    fs: {
      exists: (path) => files.has(path),
      makeDirectory: (path, mode) => { operations.push(`mkdir ${path} ${mode.toString(8)}`); },
      copy: (source, target) => { operations.push(`copy ${source} ${target}`); },
      chown: (path, uid, gid) => { operations.push(`chown ${path} ${uid}:${gid}`); },
      chmod: (path, mode) => { operations.push(`chmod ${path} ${mode.toString(8)}`); },
    },
  };
}

const OBSERVE_REQUIRED = Object.freeze([
  '/s/logins/pg-sol_listener-password',
  '/s/back/helius-listener-http-url',
  '/s/back/helius-listener-ws-url',
  '/s/logins/pg-sol_reader-password',
  '/s/back/operator-api-token',
  '/s/logins/pg-sol_retention-password',
]);

void test('distribution copies present secrets owner-only, and the keypair to H2b alone', () => {
  const { fs, operations } = recordingFileSystem([...OBSERVE_REQUIRED, '/s/back/wallet-keypair.json']);
  const copied = distributeSecrets({ mode: 'observe', secretsDirectory: '/s', runDirectory: '/r', fs });
  assert.equal(copied, operations.filter((operation) => operation.startsWith('copy ')).length);
  assert.deepEqual(operations.slice(0, 3), [
    'mkdir /r/listener 700', 'chown /r/listener 10001:10001', 'chmod /r/listener 700',
  ]);
  assert.deepEqual(operations.filter((operation) => operation.includes('wallet-keypair.json')), [
    'copy /s/back/wallet-keypair.json /r/h2b/wallet-keypair.json',
    'chown /r/h2b/wallet-keypair.json 10002:10002',
    'chmod /r/h2b/wallet-keypair.json 400',
  ]);
  assert.ok(operations.includes('copy /s/back/helius-listener-http-url /r/opapi/helius-listener-http-url'));
});

void test('a missing required secret stops the distribution before any write', () => {
  const { fs, operations } = recordingFileSystem(OBSERVE_REQUIRED.slice(1));
  assert.throws(
    () => distributeSecrets({ mode: 'observe', secretsDirectory: '/s', runDirectory: '/r', fs }),
    (error: unknown) => error instanceof SecretDistributionError
      && error.message === 'missing required secret files for observe: logins/pg-sol_listener-password',
  );
  assert.deepEqual(operations, []);
});

void test('the command refuses a non-root caller and an unknown mode', () => {
  const err: string[] = [];
  const io = { stdout: () => undefined, stderr: (text: string) => { err.push(text); } };
  const { fs } = recordingFileSystem([]);
  assert.equal(runDistributeSecretsCli(['live'], {}, io, { uid: 1000, fs }), 77);
  assert.equal(runDistributeSecretsCli(['prod'], {}, io, { uid: 0, fs }), 64);
  assert.equal(
    runDistributeSecretsCli(['live'], { SOL_SECRETS_DIR: '/s', SOL_RUN_DIR: '/r' }, io, { uid: 0, fs }),
    78,
  );
  assert.match(err.at(-1) ?? '', /^sol-entrypoint: missing required secret files for live: /u);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test tests/deploy-secret-distribution.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the plan**

Create `src/deploy/secret-distribution.ts`:

```ts
import {
  REQUIRED_ROLES,
  ROLES,
  ROLE_NAMES,
  STACK_USERS,
  STACK_USER_NAMES,
  roleSecretFiles,
  type SecretSource,
  type StackMode,
  type StackUser,
} from './stack.js';

export interface SecretGrant {
  readonly user: StackUser;
  readonly source: SecretSource;
  readonly file: string;
  /** A program supervisord starts in this mode reads it: its absence stops the container. */
  readonly required: boolean;
}

export class SecretDistributionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SecretDistributionError';
  }
}

/** Which secret file each Unix user receives in a mode (spec 7.2). */
export function secretGrants(mode: StackMode): readonly SecretGrant[] {
  const required = new Set<string>(REQUIRED_ROLES[mode]);
  const grants = new Map<string, SecretGrant>();
  for (const name of ROLE_NAMES) {
    const role = ROLES[name];
    for (const secret of roleSecretFiles(role, mode)) {
      const key = `${role.user}/${secret.file}`;
      grants.set(key, Object.freeze({
        user: role.user,
        source: secret.source,
        file: secret.file,
        required: required.has(name) || grants.get(key)?.required === true,
      }));
    }
  }
  return Object.freeze([...grants.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, grant]) => grant));
}

export interface DistributionFileSystem {
  readonly exists: (path: string) => boolean;
  readonly makeDirectory: (path: string, mode: number) => void;
  readonly copy: (source: string, target: string) => void;
  readonly chown: (path: string, uid: number, gid: number) => void;
  readonly chmod: (path: string, mode: number) => void;
}

/**
 * Copies every present secret into `<runDirectory>/<user>/`: directory 0700 and file 0400, both
 * owned by the user. Every required file is checked first, so a missing one changes nothing.
 */
export function distributeSecrets(input: Readonly<{
  mode: StackMode;
  secretsDirectory: string;
  runDirectory: string;
  fs: DistributionFileSystem;
}>): number {
  const grants = secretGrants(input.mode);
  const source = (grant: SecretGrant): string =>
    `${input.secretsDirectory}/${grant.source}/${grant.file}`;
  const missing = [...new Set(grants
    .filter((grant) => grant.required && !input.fs.exists(source(grant)))
    .map((grant) => `${grant.source}/${grant.file}`))].sort();
  if (missing.length > 0) {
    throw new SecretDistributionError(
      `missing required secret files for ${input.mode}: ${missing.join(', ')}`,
    );
  }
  for (const user of STACK_USER_NAMES) {
    const directory = `${input.runDirectory}/${user}`;
    input.fs.makeDirectory(directory, 0o700);
    input.fs.chown(directory, STACK_USERS[user], STACK_USERS[user]);
    input.fs.chmod(directory, 0o700);
  }
  let copied = 0;
  for (const grant of grants) {
    if (!input.fs.exists(source(grant))) continue;
    const target = `${input.runDirectory}/${grant.user}/${grant.file}`;
    input.fs.copy(source(grant), target);
    input.fs.chown(target, STACK_USERS[grant.user], STACK_USERS[grant.user]);
    input.fs.chmod(target, 0o400);
    copied += 1;
  }
  return copied;
}
```

- [ ] **Step 4: Implement the command**

Create `scripts/deploy/distribute-secrets.ts`:

```ts
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  SecretDistributionError,
  distributeSecrets,
  type DistributionFileSystem,
} from '../../src/deploy/secret-distribution.js';
import { isStackMode } from '../../src/deploy/stack.js';

export interface DistributeSecretsCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const NODE_FILE_SYSTEM: DistributionFileSystem = Object.freeze({
  exists: (path: string) => existsSync(path),
  makeDirectory: (path: string, mode: number) => { mkdirSync(path, { recursive: true, mode }); },
  copy: (source: string, target: string) => { copyFileSync(source, target); },
  chown: (path: string, uid: number, gid: number) => { chownSync(path, uid, gid); },
  chmod: (path: string, mode: number) => { chmodSync(path, mode); },
});

/** Run by `sol-entrypoint` as root. Exit codes: 0, 64 (usage), 77 (not root), 78 (missing secret). */
export function runDistributeSecretsCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: DistributeSecretsCliIo,
  options: Readonly<{ uid: number | undefined; fs: DistributionFileSystem }> = {
    uid: process.getuid?.(),
    fs: NODE_FILE_SYSTEM,
  },
): number {
  const [mode, ...rest] = argv;
  if (mode === undefined || rest.length > 0 || !isStackMode(mode)) {
    io.stderr('usage: distribute-secrets observe|live\n');
    return 64;
  }
  if (options.uid !== 0) {
    io.stderr('sol-entrypoint: only root distributes the secrets\n');
    return 77;
  }
  try {
    const files = distributeSecrets({
      mode,
      secretsDirectory: environment.SOL_SECRETS_DIR ?? '/root/secrets',
      runDirectory: environment.SOL_RUN_DIR ?? '/run/sol',
      fs: options.fs,
    });
    io.stdout(`${JSON.stringify({ service: 'sol-entrypoint', event: 'secrets.distributed', mode, files })}\n`);
    return 0;
  } catch (error) {
    const reason = error instanceof SecretDistributionError ? error.message : 'secret distribution failed';
    io.stderr(`sol-entrypoint: ${reason}\n`);
    return 78;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = runDistributeSecretsCli(process.argv.slice(2), process.env, {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}
```

- [ ] **Step 5: Run the test**

Run: `npx tsx --test tests/deploy-secret-distribution.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Type-check, lint, commit**

```bash
npx tsc -p tsconfig.json --noEmit && npm run lint:backend
git add src/deploy/secret-distribution.ts scripts/deploy/distribute-secrets.ts tests/deploy-secret-distribution.test.ts
git commit -m "feat(deploy): distribute each user's secrets into an owner-only tmpfs directory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: Database logins and the `sol-admin` command

**Files:**
- Create: `src/deploy/database-logins.ts`
- Create: `scripts/deploy/admin-database.ts`
- Test: `tests/deploy-database-logins.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/deploy-database-logins.test.ts`:

```ts
import assert from 'node:assert/strict';
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
  type SqlClient,
} from '../src/deploy/database-logins.js';

const ATTRIBUTES = 'LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';

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
  assert.equal(client.statements[2], `CREATE ROLE "sol_live" ${ATTRIBUTES} PASSWORD '${'a'.repeat(64)}'`);
  assert.equal(
    client.statements.at(-2),
    'GRANT "sol_token_executor_live" TO "sol_live" WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',
  );
  assert.equal(client.statements.at(-1), 'COMMIT');
});

void test('an existing login gets its new password and loses every other membership', async () => {
  const client = new RecordingClient(true, ['sol_token_executor_live', 'sol_token_executor_operations']);
  await ensureLogin(client, 'sol_live', 'b'.repeat(64));
  assert.ok(client.statements.includes(`ALTER ROLE "sol_live" WITH ${ATTRIBUTES} PASSWORD '${'b'.repeat(64)}'`));
  assert.ok(client.statements.includes('REVOKE "sol_token_executor_operations" FROM "sol_live"'));
  assert.equal(client.statements.includes('REVOKE "sol_token_executor_live" FROM "sol_live"'), false);
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test tests/deploy-database-logins.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the login module**

Create `src/deploy/database-logins.ts`:

```ts
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

export interface SqlClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

/**
 * Creates or updates one LOGIN: NOINHERIT, its password from the secret file, and membership of
 * exactly its group role with ADMIN FALSE, INHERIT FALSE, SET TRUE (spec 9.1).
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
    await client.query(existing.rows.length === 0
      ? `CREATE ROLE ${identifier(login)} ${LOGIN_ATTRIBUTES} PASSWORD ${literal(password)}`
      : `ALTER ROLE ${identifier(login)} WITH ${LOGIN_ATTRIBUTES} PASSWORD ${literal(password)}`);
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
```

- [ ] **Step 4: Implement the command**

Create `scripts/deploy/admin-database.ts`:

```ts
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
```

In the image, `dist/scripts/deploy/admin-database.js` resolves `../provision-executor-roles.sql` to `dist/scripts/provision-executor-roles.sql`, which Task 10 copies there. From source, the URL points at the real `scripts/provision-executor-roles.sql`.

- [ ] **Step 5: Run the test**

Run: `npx tsx --test tests/deploy-database-logins.test.ts`
Expected: PASS (7 tests). No database is contacted: every CLI case fails or succeeds before the pool opens.

- [ ] **Step 6: Type-check, lint, commit**

```bash
npx tsc -p tsconfig.json --noEmit && npm run lint:backend
git add src/deploy/database-logins.ts scripts/deploy/admin-database.ts tests/deploy-database-logins.test.ts
git commit -m "feat(deploy): provision the nine NOINHERIT logins from secret files

sol-admin migrate applies the migrations, replays provision-executor-roles.sql and creates
or updates each login with exactly one group membership; group-roles prepares a restore;
url feeds the admin report. Secrets are read as root, SQL runs as the node user.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Reading the operations JSON from the shell scripts

**Files:**
- Create: `scripts/deploy/operations-state.ts`
- Test: `tests/deploy-operations-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/deploy-operations-state.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  controlStateOf,
  hasActiveEnvelope,
  runOperationsStateCli,
} from '../scripts/deploy/operations-state.js';

void test('the control state comes from the status JSON', () => {
  assert.equal(
    controlStateOf('{"payloadVersion":1,"command":"status","controlState":"RUNNING"}'),
    'RUNNING',
  );
  assert.throws(() => controlStateOf('{"controlState":"PAUSED"}'), TypeError);
  assert.throws(() => controlStateOf('not json'), SyntaxError);
});

void test('an envelope counts only when ACTIVE and inside its window', () => {
  const show = (state: string, validUntilMs: number): string => JSON.stringify({
    payloadVersion: 1, command: 'envelope-show', envelopes: [{ envelopeId: 'e', state, validUntilMs }],
  });
  assert.equal(hasActiveEnvelope(show('ACTIVE', 2_000), 1_000), true);
  assert.equal(hasActiveEnvelope(show('ACTIVE', 1_000), 1_000), false);
  assert.equal(hasActiveEnvelope(show('EXHAUSTED', 2_000), 1_000), false);
  assert.equal(hasActiveEnvelope('{"envelopes":[]}', 1_000), false);
  assert.throws(() => hasActiveEnvelope('{}', 1_000), TypeError);
});

void test('the command maps answers to exit codes for the shell scripts', () => {
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (text: string) => { out.push(text); }, stderr: (text: string) => { err.push(text); } };
  assert.equal(runOperationsStateCli(['control-state'], '{"controlState":"HARD_STOP"}', io, 0), 0);
  assert.deepEqual(out, ['HARD_STOP\n']);
  assert.equal(runOperationsStateCli(['active-envelope'], '{"envelopes":[]}', io, 0), 1);
  assert.equal(runOperationsStateCli(['active-envelope'], 'garbage', io, 0), 65);
  assert.equal(runOperationsStateCli(['other'], '', io, 0), 64);
  assert.deepEqual(err, [
    'operations-state: unreadable envelope output\n',
    'usage: operations-state control-state|active-envelope < command output\n',
  ]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test tests/deploy-operations-state.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `scripts/deploy/operations-state.ts`:

```ts
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type ControlState = 'RUNNING' | 'ENTRY_STOP' | 'HARD_STOP';

/** `controlState` of `sol ops status` (one JSON line, see `statusJson` in executor-operations). */
export function controlStateOf(output: string): ControlState {
  const value: unknown = JSON.parse(output);
  const state = typeof value === 'object' && value !== null
    ? (value as { readonly controlState?: unknown }).controlState
    : undefined;
  if (state !== 'RUNNING' && state !== 'ENTRY_STOP' && state !== 'HARD_STOP') {
    throw new TypeError('operations status has no control state');
  }
  return state;
}

/** True when `sol ops envelope show` lists an ACTIVE envelope still inside its window. */
export function hasActiveEnvelope(output: string, nowMs: number): boolean {
  const value: unknown = JSON.parse(output);
  const envelopes = typeof value === 'object' && value !== null
    ? (value as { readonly envelopes?: unknown }).envelopes
    : undefined;
  if (!Array.isArray(envelopes)) throw new TypeError('envelope show has no envelope list');
  return envelopes.some((envelope: unknown) => {
    if (typeof envelope !== 'object' || envelope === null) return false;
    const { state, validUntilMs } = envelope as {
      readonly state?: unknown;
      readonly validUntilMs?: unknown;
    };
    return state === 'ACTIVE' && typeof validUntilMs === 'number' && validUntilMs > nowMs;
  });
}

/**
 * `control-state` prints the state; `active-envelope` exits 0 when one is active, 1 otherwise.
 * 64: usage. 65 (EX_DATAERR): the operations output is unreadable.
 */
export function runOperationsStateCli(
  argv: readonly string[],
  input: string,
  io: Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>,
  nowMs: number,
): number {
  const [command, ...rest] = argv;
  if ((command !== 'control-state' && command !== 'active-envelope') || rest.length > 0) {
    io.stderr('usage: operations-state control-state|active-envelope < command output\n');
    return 64;
  }
  try {
    if (command === 'control-state') {
      io.stdout(`${controlStateOf(input)}\n`);
      return 0;
    }
    return hasActiveEnvelope(input, nowMs) ? 0 : 1;
  } catch {
    io.stderr(`operations-state: unreadable ${command === 'control-state' ? 'status' : 'envelope'} output\n`);
    return 65;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = runOperationsStateCli(process.argv.slice(2), readFileSync(0, 'utf8'), {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  }, Date.now());
}
```

- [ ] **Step 4: Run the test**

Run: `npx tsx --test tests/deploy-operations-state.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx tsc -p tsconfig.json --noEmit && npm run lint:backend
git add scripts/deploy/operations-state.ts tests/deploy-operations-state.test.ts
git commit -m "feat(deploy): read the control state and active envelope for the shell scripts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: Back container scripts and supervisor configuration

**Files:**
- Create: `deploy/back/bin/sol-run`, `deploy/back/bin/sol-entrypoint`, `deploy/back/bin/sol-h2b`, `deploy/back/bin/sol-health`, `deploy/back/bin/sol`, `deploy/back/bin/sol-admin`
- Create: `deploy/back/supervisor/supervisord.conf`, `deploy/back/supervisor/programs/common.conf`, `deploy/back/supervisor/programs/live.conf`
- Test: `tests/deploy-back-container.test.ts`

The Dockerfile (Task 10) copies these files with `--chmod=0755`, so their git mode does not matter. Still run `git update-index --chmod=+x deploy/back/bin/*` in Step 5, so they also run from a checkout.

- [ ] **Step 1: Write the failing test**

Create `tests/deploy-back-container.test.ts`:

```ts
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ROLES, type RoleName } from '../src/deploy/stack.js';

const root = new URL('../', import.meta.url);
const SCRIPTS = Object.freeze(['sol', 'sol-admin', 'sol-entrypoint', 'sol-h2b', 'sol-health', 'sol-run']);
const SUPERVISOR_FILES = Object.freeze([
  'deploy/back/supervisor/supervisord.conf',
  'deploy/back/supervisor/programs/common.conf',
  'deploy/back/supervisor/programs/live.conf',
]);

async function artifact(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

interface Program {
  readonly name: string;
  readonly settings: ReadonlyMap<string, string>;
}

function programs(ini: string): readonly Program[] {
  const result: { name: string; settings: Map<string, string> }[] = [];
  for (const raw of ini.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';')) continue;
    const section = /^\[program:([a-z0-9]+)\]$/u.exec(line);
    if (section !== null) {
      result.push({ name: section[1] ?? '', settings: new Map() });
      continue;
    }
    const setting = /^([a-z_]+)=(.*)$/u.exec(line);
    const current = result.at(-1);
    if (setting !== null && current !== undefined) current.settings.set(setting[1] ?? '', setting[2] ?? '');
  }
  return result;
}

function assertOrder(source: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    assert.ok(index > previous, `${marker} is missing or out of order`);
    previous = index;
  }
}

void test('every back script is POSIX sh and parses', async () => {
  assert.deepEqual((await readdir(new URL('deploy/back/bin/', root))).sort(), [...SCRIPTS]);
  for (const name of SCRIPTS) {
    const source = await artifact(`deploy/back/bin/${name}`);
    assert.match(source, /^#!\/bin\/sh\n/u, name);
    const syntax = spawnSync('sh', ['-n'], { input: source, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${name}: ${syntax.stderr}`);
  }
});

void test('supervisor runs each program as its own user with bounded stops', async () => {
  const common = programs(await artifact('deploy/back/supervisor/programs/common.conf'));
  const live = programs(await artifact('deploy/back/supervisor/programs/live.conf'));
  assert.deepEqual(common.map((program) => program.name), ['listener', 'opapi', 'retention']);
  assert.deepEqual(live.map((program) => program.name), ['h2a', 'h2b', 'autoarm', 'worker']);
  const commands: Readonly<Record<string, string>> = {
    listener: '/usr/local/bin/sol-run listener node /app/dist/src/app.js',
    opapi: '/usr/local/bin/sol-run opapi node /app/dist/src/operator-api/main.js',
    retention: '/usr/local/bin/sol-run retention node /app/dist/scripts/purge-retained-data.js',
    h2a: '/usr/local/bin/sol-run h2a node /app/dist/src/executor-live-recovery/main.js',
    h2b: '/usr/local/bin/sol-h2b',
    autoarm: '/usr/local/bin/sol-run autoarm node /app/dist/src/executor-operations/auto-arm-main.js',
    worker: '/usr/local/bin/sol-run worker node /app/dist/src/executor/main.js',
  };
  for (const program of [...common, ...live]) {
    const settings = program.settings;
    assert.equal(settings.get('command'), commands[program.name], program.name);
    assert.equal(settings.get('user'), ROLES[program.name as RoleName].user, program.name);
    assert.equal(settings.get('directory'), '/app', program.name);
    assert.equal(settings.get('autostart'), program.name === 'worker' ? 'false' : 'true', program.name);
    assert.equal(settings.get('stopsignal'), 'TERM', program.name);
    assert.equal(settings.get('stopwaitsecs'), '40', program.name);
    assert.equal(settings.get('killasgroup'), 'true', program.name);
    assert.equal(settings.get('stdout_logfile'), '/dev/stdout', program.name);
    assert.equal(settings.get('stdout_logfile_maxbytes'), '0', program.name);
    assert.equal(settings.get('redirect_stderr'), 'true', program.name);
  }
  // sol-h2b forwards TERM to H2b itself: supervisord must not signal the child directly.
  assert.equal(live.find((program) => program.name === 'h2b')?.settings.get('stopasgroup'), 'false');
});

void test('supervisord keeps its socket root-only and loads the programs the entrypoint selects', async () => {
  const lines = (await artifact('deploy/back/supervisor/supervisord.conf')).split('\n');
  for (const line of [
    'nodaemon=true', 'user=root', 'logfile=/dev/null', 'file=/run/sol/supervisor.sock', 'chmod=0700',
    'serverurl=unix:///run/sol/supervisor.sock', 'files = /run/sol/programs/*.conf',
  ]) {
    assert.ok(lines.includes(line), line);
  }
});

void test('the entrypoint distributes secrets and applies the boot entry-stop before supervisord', async () => {
  const entrypoint = await artifact('deploy/back/bin/sol-entrypoint');
  assertOrder(entrypoint, [
    'node /app/dist/scripts/deploy/distribute-secrets.js "$mode"',
    'install -m 0644 /etc/sol/programs/common.conf /run/sol/programs/common.conf',
    'install -m 0644 /etc/sol/programs/live.conf /run/sol/programs/live.conf',
    'executor-operations/main.js status',
    'if [ "$state" = RUNNING ]; then',
    'kill-switch --mode=entry-stop --reason=OPERATOR_ENTRY_STOP',
    'exec supervisord -n -c /etc/sol/supervisord.conf',
  ]);
});

void test('sol-run drops root to the role user and refuses a foreign role', async () => {
  const solRun = await artifact('deploy/back/bin/sol-run');
  assertOrder(solRun, [
    'exports="$(node /app/dist/scripts/deploy/role-env.js "$role")"',
    'eval "$exports"',
    'exec setpriv --reuid="$SOL_RUN_UID" --regid="$SOL_RUN_UID" --clear-groups -- "$@"',
    'if [ "$current" != "$SOL_RUN_UID" ]; then',
    'exec "$@"',
  ]);
});

void test('only the H2b role points at the keypair; no script or supervisor file names it', async () => {
  const keypairRoles = Object.entries(ROLES)
    .filter(([, role]) => Object.values(role.secretPaths ?? {}).includes('wallet-keypair.json'))
    .map(([name]) => name);
  assert.deepEqual(keypairRoles, ['h2b']);
  for (const path of [...SCRIPTS.map((name) => `deploy/back/bin/${name}`), ...SUPERVISOR_FILES]) {
    assert.doesNotMatch(await artifact(path), /keypair/iu, path);
  }
});

void test('sol trading start needs an ACTIVE envelope and a running H2b, then resumes at the TTY', async () => {
  const sol = await artifact('deploy/back/bin/sol');
  assertOrder(sol, [
    'trading() {', 'envelope show', 'active-envelope', 'until h2b_ready; do',
    'executor-operations/main.js resume', 'kill-switch --mode=entry-stop --reason=OPERATOR_ENTRY_STOP',
    'qualify() {', ': > /run/sol/qualify', 'ctl stop retention',
    "printf 'FAST_ENTRY_PROBE_ENABLED=true\\n' > /run/sol/overrides/listener.env",
    'ctl restart listener', 'ctl start worker',
    'ctl stop worker', 'rm -f /run/sol/overrides/listener.env', 'ctl start retention',
  ]);
});

void test('sol-h2b relaunches after exit 75, backs off after a failure and stops cleanly on TERM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-h2b-'));
  try {
    const bin = join(directory, 'bin');
    const log = join(directory, 'launches');
    const state = join(directory, 'state');
    await mkdir(bin);
    await writeFile(join(bin, 'sol-run'), [
      '#!/bin/sh',
      `log='${log}'`,
      'count=$(( $(cat "$log" 2> /dev/null | wc -l) + 1 ))',
      'echo "$*" >> "$log"',
      'if [ "$count" -eq 1 ]; then exit 75; fi',
      'if [ "$count" -eq 2 ]; then exit 1; fi',
      'trap \'echo terminated >> "$log"; exit 0\' TERM',
      'while :; do sleep 1; done',
      '',
    ].join('\n'), { mode: 0o755 });
    const child = spawn('sh', [fileURLToPath(new URL('deploy/back/bin/sol-h2b', root))], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        SOL_H2B_STATE_FILE: state,
        SOL_H2B_IDLE_SECONDS: '1',
        SOL_H2B_BACKOFF_SECONDS: '1',
        SOL_H2B_BACKOFF_MAX_SECONDS: '2',
      },
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => { resolve(code); });
    });
    const seen = new Set<string>();
    const deadline = Date.now() + 20_000;
    for (;;) {
      const current = await readFile(state, 'utf8').catch(() => '');
      seen.add(current.split(' ')[0] ?? '');
      const launches = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
      if (launches.length >= 3 && current.startsWith('running ')) break;
      assert.ok(Date.now() < deadline, 'sol-h2b did not relaunch H2b three times');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(seen.has('idle'), 'exit 75 must leave the idle state');
    assert.ok(seen.has('failing'), 'exit 1 must leave the failing state');
    assert.deepEqual(
      (await readFile(log, 'utf8')).trim().split('\n'),
      Array.from({ length: 3 }, () => 'h2b node /app/dist/src/executor-live/main.js'),
    );
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.match(await readFile(log, 'utf8'), /terminated\n$/u);
    assert.match(await readFile(state, 'utf8'), /^stopped \d+\n$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test tests/deploy-back-container.test.ts`
Expected: FAIL, `ENOENT` on `deploy/back/bin/`.

- [ ] **Step 3: Write the scripts**

Create `deploy/back/bin/sol-run`:

```sh
#!/bin/sh
# sol-run <role> <command> [args...]: start one process of the stack with its role's
# configuration and secrets (docs/operations/deployment.md, « Commandes sol »).
# Run as root, it drops to the role's user; run by supervisord as that user, it refuses any
# other role. Secret values travel only through the environment, never through argv or logs.
set -eu
if [ "$#" -lt 2 ]; then
  echo 'usage: sol-run <role> <command> [args...]' >&2
  exit 64
fi
role="$1"
shift
exports="$(node /app/dist/scripts/deploy/role-env.js "$role")"
eval "$exports"
current="$(id -u)"
if [ "$current" = 0 ]; then
  exec setpriv --reuid="$SOL_RUN_UID" --regid="$SOL_RUN_UID" --clear-groups -- "$@"
fi
if [ "$current" != "$SOL_RUN_UID" ]; then
  echo "sol-run: role $role belongs to user $SOL_RUN_USER" >&2
  exit 77
fi
exec "$@"
```

Create `deploy/back/bin/sol-entrypoint`:

```sh
#!/bin/sh
# Entrypoint of the back container (root): distribute the secrets into /run/sol, select the
# programs of SOL_STACK_MODE, apply the boot entry-stop in live mode, then run supervisord.
set -eu
mode="${SOL_STACK_MODE:-observe}"
case "$mode" in
  observe|live) ;;
  *) echo 'sol-entrypoint: SOL_STACK_MODE must be observe or live' >&2; exit 64 ;;
esac
install -d -m 0711 /run/sol
install -d -m 0755 /run/sol/programs /run/sol/overrides
rm -f /run/sol/programs/*.conf /run/sol/overrides/*.env /run/sol/qualify
printf '%s\n' "$mode" > /run/sol/mode
node /app/dist/scripts/deploy/distribute-secrets.js "$mode"
install -m 0644 /etc/sol/programs/common.conf /run/sol/programs/common.conf
if [ "$mode" = live ]; then
  install -m 0644 /etc/sol/programs/live.conf /run/sol/programs/live.conf
  # Invariant (spec 13): after any restart, no new BUY before a human `sol trading start`.
  state="$(sol-run operations node /app/dist/src/executor-operations/main.js status \
    | node /app/dist/scripts/deploy/operations-state.js control-state)"
  if [ "$state" = RUNNING ]; then
    sol-run operations node /app/dist/src/executor-operations/main.js \
      kill-switch --mode=entry-stop --reason=OPERATOR_ENTRY_STOP > /dev/null
    echo '{"service":"sol-entrypoint","event":"boot.entry_stop","previousControlState":"RUNNING"}'
  fi
fi
exec supervisord -n -c /etc/sol/supervisord.conf
```

Create `deploy/back/bin/sol-h2b`:

```sh
#!/bin/sh
# H2b on demand (spec 6.3), run by supervisord as user h2b. Exit 75 (EX_TEMPFAIL) means no
# runnable work: relaunch after SOL_H2B_IDLE_SECONDS. Any other exit: exponential backoff from
# SOL_H2B_BACKOFF_SECONDS, capped at SOL_H2B_BACKOFF_MAX_SECONDS, reset after 5 min of running.
# The state file (`running|idle|failing|stopped <epoch>`) feeds sol-health and `sol trading start`.
set -u
state_file="${SOL_H2B_STATE_FILE:-/run/sol/h2b/state}"
idle_seconds="${SOL_H2B_IDLE_SECONDS:-15}"
backoff_start="${SOL_H2B_BACKOFF_SECONDS:-5}"
backoff_max="${SOL_H2B_BACKOFF_MAX_SECONDS:-300}"
backoff="$backoff_start"
child=0
pause=0

write_state() {
  printf '%s %s\n' "$1" "$(date +%s)" > "$state_file.tmp"
  mv "$state_file.tmp" "$state_file"
}

stop() {
  if [ "$pause" -ne 0 ]; then kill "$pause" 2> /dev/null || true; fi
  if [ "$child" -ne 0 ]; then
    kill -TERM "$child" 2> /dev/null || true
    wait "$child" || true
  fi
  write_state stopped
  exit 0
}
trap stop TERM INT

while :; do
  started="$(date +%s)"
  write_state running
  sol-run h2b node /app/dist/src/executor-live/main.js &
  child=$!
  status=0
  wait "$child" || status=$?
  child=0
  if [ "$status" -eq 75 ]; then
    write_state idle
    delay="$idle_seconds"
    backoff="$backoff_start"
  else
    write_state failing
    if [ $(( $(date +%s) - started )) -ge 300 ]; then backoff="$backoff_start"; fi
    delay="$backoff"
    backoff=$(( backoff * 2 ))
    if [ "$backoff" -gt "$backoff_max" ]; then backoff="$backoff_max"; fi
  fi
  sleep "$delay" &
  pause=$!
  wait "$pause" || true
  pause=0
done
```

Create `deploy/back/bin/sol-health`:

```sh
#!/bin/sh
# Docker healthcheck of the back container (spec 6.5, amended): every program of the mode is
# RUNNING, H2b runs or waits for work, and the listener API answers.
set -u
fail() {
  printf 'sol-health: %s\n' "$1"
  exit 1
}
running() {
  [ "$(supervisorctl -c /etc/sol/supervisord.conf status "$1" 2> /dev/null | awk '{ print $2 }')" = RUNNING ]
}
mode="$(cat /run/sol/mode 2> /dev/null)" || fail 'mode unknown'
programs='listener opapi'
if [ ! -e /run/sol/qualify ]; then programs="$programs retention"; fi
if [ "$mode" = live ]; then programs="$programs h2a h2b autoarm"; fi
for program in $programs; do
  running "$program" || fail "$program is not RUNNING"
done
if [ "$mode" = live ]; then
  state="$(cut -d ' ' -f 1 /run/sol/h2b/state 2> /dev/null)"
  case "$state" in
    running|idle) ;;
    *) fail "h2b is ${state:-unknown}" ;;
  esac
fi
if [ "${SOL_HEALTH_REQUIRE_OK:-true}" = true ]; then
  node /app/dist/scripts/deployment-healthcheck.js --require-ok > /dev/null || fail 'listener API is not OK'
else
  node /app/dist/scripts/deployment-healthcheck.js > /dev/null || fail 'listener API is unavailable'
fi
```

Create `deploy/back/bin/sol`:

```sh
#!/bin/sh
# Operator commands inside the back container (spec 6.7):
#   docker compose exec -it back sol <command> …
set -eu
ctl() { supervisorctl -c /etc/sol/supervisord.conf "$@"; }
die() {
  printf 'sol: %s\n' "$1" >&2
  exit "${2:-1}"
}
mode() { cat /run/sol/mode; }
operations() { sol-run operations node /app/dist/src/executor-operations/main.js "$@"; }

h2b_ready() {
  # `running` for at least 15 s: H2b passed its startup checks (exit 75 or 1 would have ended it).
  set -- $(cat /run/sol/h2b/state 2> /dev/null || echo none 0)
  [ "$1" = running ] && [ $(( $(date +%s) - $2 )) -ge 15 ]
}

trading() {
  [ "$(mode)" = live ] || die 'trading needs SOL_STACK_MODE=live'
  case "${1:-}" in
    start)
      operations envelope show | node /app/dist/scripts/deploy/operations-state.js active-envelope \
        || die 'no ACTIVE envelope: create one with sol ops envelope create'
      deadline=$(( $(date +%s) + 60 ))
      until h2b_ready; do
        [ "$(date +%s)" -lt "$deadline" ] || die 'H2b is not RUNNING after 60 s: see docker compose logs back'
        sleep 2
      done
      # TTY confirmation: run it with docker compose exec -it.
      exec sol-run operations node /app/dist/src/executor-operations/main.js resume ;;
    stop)
      exec sol-run operations node /app/dist/src/executor-operations/main.js \
        kill-switch --mode=entry-stop --reason=OPERATOR_ENTRY_STOP ;;
    *) die 'usage: sol trading start|stop' 64 ;;
  esac
}

qualify() {
  [ "$(mode)" = live ] || die 'qualification needs SOL_STACK_MODE=live'
  case "${1:-}" in
    start)
      # Gate 10: probe on, retention suspended, simulation-only worker on (lot 4a, step 1).
      : > /run/sol/qualify
      ctl stop retention || true
      printf 'FAST_ENTRY_PROBE_ENABLED=true\n' > /run/sol/overrides/listener.env
      chmod 0644 /run/sol/overrides/listener.env
      ctl restart listener
      ctl start worker ;;
    stop)
      ctl stop worker || true
      rm -f /run/sol/overrides/listener.env
      ctl restart listener
      ctl start retention
      rm -f /run/sol/qualify ;;
    *) die 'usage: sol qualify start|stop' 64 ;;
  esac
}

[ "$(id -u)" = 0 ] || die 'run it as root: docker compose exec -it back sol …' 77
command="${1:-}"
[ "$#" -eq 0 ] || shift
case "$command" in
  ops) exec sol-run operations node /app/dist/src/executor-operations/main.js "$@" ;;
  readiness) exec sol-run readiness node /app/dist/src/executor-readiness/main.js "$@" ;;
  evidence)
    kind="${1:-}"
    [ "$#" -eq 0 ] || shift
    case "$kind" in
      provider) exec sol-run evidence-provider node /app/dist/src/provider-evidence/main.js "$@" ;;
      bundle) exec sol-run evidence-bundle node /app/dist/src/preflight-bundle/main.js "$@" ;;
      *) die 'usage: sol evidence provider|bundle' 64 ;;
    esac ;;
  trading) trading "$@" ;;
  qualify) qualify "$@" ;;
  ctl) exec supervisorctl -c /etc/sol/supervisord.conf "$@" ;;
  status)
    ctl status || true
    printf 'mode %s\n' "$(mode)"
    if [ -f /run/sol/h2b/state ]; then printf 'h2b %s\n' "$(cat /run/sol/h2b/state)"; fi
    if [ -e /run/sol/qualify ]; then echo 'qualification in progress: retention stopped'; fi ;;
  *) die 'usage: sol ops|readiness|evidence|trading|qualify|ctl|status …' 64 ;;
esac
```

Create `deploy/back/bin/sol-admin`:

```sh
#!/bin/sh
# Administrator commands of the migrate container (root; the admin password lives only here):
#   sol-admin migrate       migrations, provisioning replay, the nine logins (default command)
#   sol-admin group-roles   the NOLOGIN group roles only, before a pg_restore
#   sol-admin report        fast-path report as the administrator, run as the node user
set -eu
command="${1:-}"
[ "$#" -eq 0 ] || shift
case "$command" in
  migrate|group-roles)
    exec node /app/dist/scripts/deploy/admin-database.js "$command" ;;
  report)
    DATABASE_URL="$(node /app/dist/scripts/deploy/admin-database.js url)"
    export DATABASE_URL
    exec setpriv --reuid=1000 --regid=1000 --clear-groups -- node /app/dist/src/cli/fast-path-report.js "$@" ;;
  *)
    echo 'usage: sol-admin migrate|group-roles|report' >&2
    exit 64 ;;
esac
```

- [ ] **Step 4: Write the supervisor configuration**

Create `deploy/back/supervisor/supervisord.conf`:

```ini
; supervisord of the back container (spec 6.1): with the entrypoint, the only root process.
[supervisord]
nodaemon=true
user=root
logfile=/dev/null
logfile_maxbytes=0
pidfile=/run/sol/supervisord.pid

[unix_http_server]
; Root-only socket: only `docker compose exec back sol …` (root) starts or stops programs.
file=/run/sol/supervisor.sock
chmod=0700

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix:///run/sol/supervisor.sock

[include]
files = /run/sol/programs/*.conf
```

Create `deploy/back/supervisor/programs/common.conf`:

```ini
; Programs of both modes (spec 6.2). Each one runs as its own Unix user through sol-run, which
; injects only that role's configuration and secrets. Lower priority starts first, stops last.

[program:listener]
command=/usr/local/bin/sol-run listener node /app/dist/src/app.js
user=listener
directory=/app
priority=100
autostart=true
autorestart=true
startsecs=10
startretries=10
stopsignal=TERM
stopwaitsecs=40
stopasgroup=true
killasgroup=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
redirect_stderr=true

[program:opapi]
command=/usr/local/bin/sol-run opapi node /app/dist/src/operator-api/main.js
user=opapi
directory=/app
priority=110
autostart=true
autorestart=true
startsecs=5
startretries=10
stopsignal=TERM
stopwaitsecs=40
stopasgroup=true
killasgroup=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
redirect_stderr=true

[program:retention]
command=/usr/local/bin/sol-run retention node /app/dist/scripts/purge-retained-data.js
user=retention
directory=/app
priority=120
autostart=true
autorestart=true
startsecs=5
startretries=10
stopsignal=TERM
stopwaitsecs=40
stopasgroup=true
killasgroup=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
redirect_stderr=true
```

Create `deploy/back/supervisor/programs/live.conf`:

```ini
; Live mode only (spec 6.2 and 6.4, amended). Stop order is the reverse priority: worker and
; auto-arm first, then H2b, H2a and the common programs.

[program:h2a]
command=/usr/local/bin/sol-run h2a node /app/dist/src/executor-live-recovery/main.js
user=h2a
directory=/app
priority=200
autostart=true
autorestart=true
startsecs=5
startretries=10
stopsignal=TERM
stopwaitsecs=40
stopasgroup=true
killasgroup=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
redirect_stderr=true

[program:h2b]
; On demand: sol-h2b relaunches H2b 15 s after exit 75 (no runnable work) and backs off otherwise.
command=/usr/local/bin/sol-h2b
user=h2b
directory=/app
priority=210
autostart=true
autorestart=true
startsecs=1
startretries=10
stopsignal=TERM
stopwaitsecs=40
stopasgroup=false
killasgroup=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
redirect_stderr=true

[program:autoarm]
; Always up in live mode: it arms only while the control state is RUNNING (sol trading start)
; and keeps the provider snapshot of an open position fresh for its SELL.
command=/usr/local/bin/sol-run autoarm node /app/dist/src/executor-operations/auto-arm-main.js
user=autoarm
directory=/app
priority=300
autostart=true
autorestart=true
startsecs=5
startretries=10
stopsignal=TERM
stopwaitsecs=40
stopasgroup=true
killasgroup=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
redirect_stderr=true

[program:worker]
; Simulation-only worker for the gate-10 probe: started and stopped by sol qualify only.
command=/usr/local/bin/sol-run worker node /app/dist/src/executor/main.js
user=worker
directory=/app
priority=310
autostart=false
autorestart=true
startsecs=5
startretries=10
stopsignal=TERM
stopwaitsecs=40
stopasgroup=true
killasgroup=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
redirect_stderr=true
```

- [ ] **Step 5: Run the test**

```bash
git update-index --add --chmod=+x deploy/back/bin/* 2>/dev/null || true
chmod 0755 deploy/back/bin/*
npx tsx --test tests/deploy-back-container.test.ts
```

Expected: PASS (8 tests). The `sol-h2b` test takes about 3 s.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint:backend
git add deploy/back tests/deploy-back-container.test.ts
git update-index --chmod=+x deploy/back/bin/sol deploy/back/bin/sol-admin deploy/back/bin/sol-entrypoint deploy/back/bin/sol-h2b deploy/back/bin/sol-health deploy/back/bin/sol-run
git commit -m "feat(deploy): back container scripts and supervisor programs

sol-entrypoint distributes secrets, selects the programs of the mode and applies the boot
entry-stop before supervisord; sol-run drops root to the role user; sol-h2b relaunches H2b on
demand; sol-health, sol (ops, readiness, evidence, trading, qualify, ctl, status), sol-admin.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Dockerfile stages and the Caddy front

**Files:**
- Modify: `Dockerfile` (stages `backend` and `frontend`)
- Create: `deploy/front/Caddyfile`, `deploy/front/front-entrypoint`
- Delete: `deploy/nginx.conf`
- Test: `tests/deployment-artifacts.test.ts` (image constant, three image tests, the Nginx test)

The compose file still describes the old services until Task 11; only the static tests run in this task.

- [ ] **Step 1: Update the tests first**

In `tests/deployment-artifacts.test.ts`:

1. Add the import after the `node:test` import (line 7):

```ts
import { STACK_USERS } from '../src/deploy/stack.js';
```

2. Replace the `nginxImage` constant (lines 21–22) with:

```ts
const caddyImage =
  'caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d';
```

3. In `'Dockerfile pins reviewed images and builds exact workspace artifacts'`, replace `[nginxImage, 'frontend'],` with `[caddyImage, 'frontend'],`.

4. Replace the whole test `'backend image contains only compiled application artifacts and production dependencies'` with:

```ts
void test('backend image ships compiled artifacts, supervisor and one Unix user per process', async () => {
  const dockerfile = await readArtifact('Dockerfile');
  const backend = stage(dockerfile, 'backend');
  const copies = backend.match(/^COPY\s+.+$/gm) ?? [];

  assert.deepEqual(copies, [
    'COPY --from=production-dependencies /app/node_modules ./node_modules',
    'COPY --from=build /app/dist ./dist',
    'COPY package.json package-lock.json ./',
    'COPY --from=build /app/scripts/provision-executor-roles.sql ./dist/scripts/provision-executor-roles.sql',
    'COPY --chmod=0755 deploy/back/bin/ /usr/local/bin/',
    'COPY deploy/back/supervisor/supervisord.conf /etc/sol/supervisord.conf',
    'COPY deploy/back/supervisor/programs/ /etc/sol/programs/',
  ]);
  assert.doesNotMatch(backend, /\btests?\/|fixtures?|\.env\b|\.git\b|\.worktrees|npm-cache|secret|keypair|wallet/iu);
  assert.match(backend, /^ENV\s+NODE_ENV=production$/m);
  assert.match(backend, /apt-get install --yes --no-install-recommends supervisor/u);
  for (const [user, uid] of Object.entries(STACK_USERS)) {
    assert.ok(backend.includes(`${user}:${uid}`), `missing Unix user ${user}`);
  }
  assert.match(backend, /install -d -o ops -g ops -m 0700 \/var\/lib\/sol\/evidence/u);
  // The build writes the qualification profiles 0600: without this the listener user cannot start.
  assert.match(backend, /^RUN chmod -R a\+rX \/app\/dist$/mu);
  assert.doesNotMatch(backend, /^USER\s+/mu, 'the entrypoint needs root; each program drops to its user');
  assert.match(backend, /^EXPOSE\s+3000 3100$/m);
  assert.match(backend, /^CMD\s+\["sol-entrypoint"\]$/m);
});
```

5. Replace the whole test `'frontend image contains only built static assets and the reviewed unprivileged config'` with:

```ts
void test('front image serves only the built console through the reviewed Caddyfile, as a non-root user', async () => {
  const dockerfile = await readArtifact('Dockerfile');
  const frontend = stage(dockerfile, 'frontend');
  const copies = frontend.match(/^COPY\s+.+$/gm) ?? [];

  assert.deepEqual(copies, [
    'COPY --from=build /app/frontend/dist /srv',
    'COPY deploy/front/Caddyfile /etc/caddy/Caddyfile',
    'COPY --chmod=0755 deploy/front/front-entrypoint /usr/local/bin/front-entrypoint',
  ]);
  assert.match(frontend, /addgroup -S -g 10100 caddy/u);
  assert.match(frontend, /adduser -S -D -H -u 10100 -G caddy -s \/sbin\/nologin caddy/u);
  assert.match(frontend, /chown -R caddy:caddy \/data \/config/u);
  assert.match(frontend, /^EXPOSE\s+8080 80 443$/m);
  assert.match(frontend, /^CMD\s+\["front-entrypoint"\]$/m);
  assert.doesNotMatch(frontend, /(?:^|\/)src(?:\/|\s)|\btests?\b|fixtures?|\.env\b|\.git\b|\.worktrees/iu);
});
```

6. Replace the whole test `'Nginx serves the SPA with bounded caching and proxies only the read-only V1 API'` with these two tests:

```ts
void test('Caddy relays only reads, authenticates every route but the operator API, streams SSE', async () => {
  const caddyfile = await readArtifact('deploy/front/Caddyfile');
  const route = caddyfile.slice(caddyfile.indexOf('route {'));
  let previous = -1;
  for (const marker of [
    '@write not method GET HEAD OPTIONS',
    'respond @write 405',
    'reverse_proxy /operator/v1/* back:3100 {',
    'header_up Host 0.0.0.0:3100',
    'basic_auth {',
    '{$FRONT_BASIC_AUTH_USER} {$FRONT_BASIC_AUTH_HASH}',
    'reverse_proxy /api/v1/events back:3000 {',
    'reverse_proxy @api back:3000 {',
    'try_files {path} /index.html',
    'file_server',
  ]) {
    const index = route.indexOf(marker);
    assert.ok(index > previous, `${marker} is missing or out of order`);
    previous = index;
  }
  assert.ok(caddyfile.includes('{$SITE_ADDRESS:http://:8080} {'));
  assert.ok(caddyfile.includes('admin localhost:2019'));
  assert.match(caddyfile, /@api path \/api\/v1 \/api\/v1\/\*/u);
  assert.match(caddyfile, /flush_interval -1/u);
  assert.match(caddyfile, /read_timeout 1h/u);
  assert.equal((caddyfile.match(/header_up -Authorization/gu) ?? []).length, 2);
  for (const header of [
    'Strict-Transport-Security "max-age=31536000"', 'X-Frame-Options "DENY"',
    'Referrer-Policy "no-referrer"', 'X-Content-Type-Options "nosniff"', '-Server',
  ]) {
    assert.ok(caddyfile.includes(header), `missing header ${header}`);
  }
  assert.ok(caddyfile.includes('header @immutable Cache-Control "public, max-age=31536000, immutable"'));
  assert.ok(caddyfile.includes('header @mutable Cache-Control "no-store"'));
  assert.doesNotMatch(caddyfile, /\$2[aby]\$|password/iu);
});

void test('the front entrypoint reads only the bcrypt hash and drops root before starting Caddy', async () => {
  const entrypoint = await readArtifact('deploy/front/front-entrypoint');
  assert.ok(entrypoint.startsWith('#!/bin/sh\n'));
  assert.match(entrypoint, /^set -eu$/mu);
  assert.ok(entrypoint.includes('hash_file=/root/secrets/front-basic-auth-hash'));
  assert.ok(entrypoint.includes("'$2a$'*|'$2b$'*|'$2y$'*) ;;"));
  assert.ok(entrypoint.includes(
    "exec su -s /bin/sh caddy -c 'exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile'",
  ));
  const syntax = spawnSync('sh', ['-n'], { input: entrypoint, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});
```

- [ ] **Step 2: Run the file and watch the new tests fail**

Run: `npx tsx --test tests/deployment-artifacts.test.ts`
Expected: FAIL in the five tests above (Dockerfile stages and missing `deploy/front/` files). The other tests still pass.

- [ ] **Step 3: Replace the `backend` and `frontend` stages of the `Dockerfile`**

Keep the stages `dependencies`, `build` and `production-dependencies` unchanged. Replace everything from `FROM node:22.22.0-bookworm-slim@sha256:… AS backend` to the end of the file with:

```dockerfile
FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS backend

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install --yes --no-install-recommends supervisor \
  && rm -rf /var/lib/apt/lists/*

# One Unix user per process family (spec 6.1); only the entrypoint and supervisord stay root.
RUN set -eu; \
  for entry in listener:10001 h2b:10002 h2a:10003 autoarm:10004 opapi:10005 retention:10006 worker:10007 ops:10008; do \
    name="${entry%%:*}"; uid="${entry##*:}"; \
    groupadd --system --gid "$uid" "$name"; \
    useradd --system --uid "$uid" --gid "$uid" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$name"; \
  done; \
  install -d -o ops -g ops -m 0700 /var/lib/sol/evidence

WORKDIR /app

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY --from=build /app/scripts/provision-executor-roles.sql ./dist/scripts/provision-executor-roles.sql
# The build writes the qualification profiles owner-only; every service user reads dist/.
RUN chmod -R a+rX /app/dist
COPY --chmod=0755 deploy/back/bin/ /usr/local/bin/
COPY deploy/back/supervisor/supervisord.conf /etc/sol/supervisord.conf
COPY deploy/back/supervisor/programs/ /etc/sol/programs/

EXPOSE 3000 3100

CMD ["sol-entrypoint"]

FROM caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d AS frontend

RUN addgroup -S -g 10100 caddy \
  && adduser -S -D -H -u 10100 -G caddy -s /sbin/nologin caddy \
  && chown -R caddy:caddy /data /config

COPY --from=build /app/frontend/dist /srv
COPY deploy/front/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 deploy/front/front-entrypoint /usr/local/bin/front-entrypoint

EXPOSE 8080 80 443

CMD ["front-entrypoint"]
```

Application files stay owned by root and read-only for the service users. The named volume `evidence` is initialised from `/var/lib/sol/evidence` (owner `ops`, mode 0700) on first use.

- [ ] **Step 4: Create the front files and delete the Nginx configuration**

Create `deploy/front/Caddyfile`:

```caddyfile
# Front of the stack (spec 8): static console and read-only relays to the back. basic_auth
# covers every route except the operator API, which checks its own bearer token.
{
	admin localhost:2019
}

{$SITE_ADDRESS:http://:8080} {
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
		X-Content-Type-Options "nosniff"
		-Server
	}

	route {
		# Read-only surface: nothing but GET, HEAD and OPTIONS reaches a backend.
		@write not method GET HEAD OPTIONS
		respond @write 405

		# The console sends its own `Authorization: Bearer` token, checked by the operator API, which
		# only answers the Host it binds (OPERATOR_API_HOST:OPERATOR_API_PORT of operator-api.env).
		reverse_proxy /operator/v1/* back:3100 {
			header_up Host 0.0.0.0:3100
		}

		basic_auth {
			{$FRONT_BASIC_AUTH_USER} {$FRONT_BASIC_AUTH_HASH}
		}

		reverse_proxy /api/v1/events back:3000 {
			header_up -Authorization
			flush_interval -1
			transport http {
				read_timeout 1h
			}
		}

		@api path /api/v1 /api/v1/*
		reverse_proxy @api back:3000 {
			header_up -Authorization
		}

		@immutable path /assets/*
		header @immutable Cache-Control "public, max-age=31536000, immutable"
		@mutable not path /assets/*
		header @mutable Cache-Control "no-store"

		root * /srv
		try_files {path} /index.html
		file_server
	}
}
```

The Caddyfile uses tabs for indentation, as `caddy fmt` does.

Create `deploy/front/front-entrypoint`:

```sh
#!/bin/sh
# Entrypoint of the front container (root): read the bcrypt hash of the basic_auth password
# from its secret file, then run Caddy as the unprivileged `caddy` user. The hash never enters
# the Caddyfile, the image or the compose file.
set -eu
hash_file=/root/secrets/front-basic-auth-hash
if [ ! -s "$hash_file" ]; then
  echo 'front-entrypoint: missing secret front-basic-auth-hash' >&2
  exit 78
fi
FRONT_BASIC_AUTH_HASH="$(head -n 1 "$hash_file")"
case "$FRONT_BASIC_AUTH_HASH" in
  '$2a$'*|'$2b$'*|'$2y$'*) ;;
  *) echo 'front-entrypoint: front-basic-auth-hash is not a bcrypt hash' >&2; exit 78 ;;
esac
case "${FRONT_BASIC_AUTH_USER:-}" in
  ''|*[!A-Za-z0-9._-]*) echo 'front-entrypoint: FRONT_BASIC_AUTH_USER must match [A-Za-z0-9._-]+' >&2; exit 78 ;;
esac
export FRONT_BASIC_AUTH_HASH
exec su -s /bin/sh caddy -c 'exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile'
```

Then:

```bash
git rm deploy/nginx.conf
chmod 0755 deploy/front/front-entrypoint
```

- [ ] **Step 5: Run the file**

Run: `npx tsx --test tests/deployment-artifacts.test.ts`
Expected: PASS. The compose and smoke tests are untouched in this task and still pass.

- [ ] **Step 6: Build both images once and inspect them**

```bash
docker build --target backend -t sol-plan-backend:check .
docker build --target frontend -t sol-plan-frontend:check .
docker run --rm --entrypoint sh sol-plan-backend:check -c 'id listener; id h2b; id ops; supervisord --version; test -x /usr/local/bin/sol-run; test -f /app/dist/scripts/provision-executor-roles.sql; test -f /app/dist/scripts/deploy/role-env.js; stat -c "%U %a" /var/lib/sol/evidence'
docker run --rm --entrypoint sh sol-plan-frontend:check -c 'id caddy; test -f /srv/index.html; caddy version'
docker image rm sol-plan-backend:check sol-plan-frontend:check
```

Expected:
- `uid=10001(listener)`, `uid=10002(h2b)`, `uid=10008(ops)`;
- `4.2.5`;
- `ops 700`;
- `uid=10100(caddy)`, then `v2.10.2 …`.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile deploy/front tests/deployment-artifacts.test.ts
git update-index --chmod=+x deploy/front/front-entrypoint
git commit -m "feat(deploy): back image with supervisor and per-process users, Caddy front

The backend image adds supervisor, eight Unix users with fixed UIDs, the sol scripts and the
provisioning SQL; it starts as root so the entrypoint can distribute secrets. The frontend image
moves from nginx to Caddy: GET/HEAD/OPTIONS only, basic_auth from a bcrypt hash file except on
the bearer-protected operator API, SSE unbuffered, Caddy running as an unprivileged user.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Compose topology, compose inputs and configuration templates

**Files:**
- Rewrite: `deploy/compose.yaml`, `deploy/env.example`
- Create: `deploy/compose.server.yaml`, `deploy/config/*.env.example` (10 files)
- Delete: `deploy/compose.smoke.yaml`
- Test: `tests/deployment-artifacts.test.ts`

The smoke script still targets the old services until Task 12; it only runs in CI, on the final PR.

- [ ] **Step 1: Update the tests first**

In `tests/deployment-artifacts.test.ts`:

1. Add `readdir` to the `node:fs/promises` import, and replace the stack import added in Task 10 with:

```ts
import { parseRoleConfig } from '../src/deploy/role-environment.js';
import { ROLES, STACK_USERS } from '../src/deploy/stack.js';
```

2. Replace the first test, `'frontend readiness waits for local HTTP without weakening backend checks'` (lines 10–17 only: keep the image constants and helpers below it), with:

```ts
void test('front readiness probes the local Caddy admin endpoint, never the protected site', async () => {
  const front = composeService(await readArtifact('deploy/compose.yaml'), 'front');
  for (const line of [
    '    healthcheck:',
    '      test: ["CMD", "wget", "-q", "-T", "2", "-O", "/dev/null", "http://127.0.0.1:2019/config/"]',
    '      interval: 5s', '      timeout: 3s', '      retries: 30', '      start_period: 10s',
  ]) assert.ok(front.includes(line), `Missing front readiness line: ${line}`);
});
```

3. Replace the whole test `'Compose defines an observe-only, five-service deployment without exposed database or backend'` with:

```ts
void test('Compose defines postgres, migrate, back and front, with no published database or backend port', async () => {
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
  assert.deepEqual(serviceNames, ['postgres', 'migrate', 'back', 'front']);
  assert.match(compose, new RegExp(`^    image: ${postgresImage.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  for (const service of ['migrate', 'back']) {
    assert.match(composeService(compose, service), /^ {4}image: \$\{BACKEND_IMAGE:\?BACKEND_IMAGE is required\}$/m);
  }
  assert.match(composeService(compose, 'front'), /^ {4}image: \$\{FRONTEND_IMAGE:\?FRONTEND_IMAGE is required\}$/m);
  assert.match(composeService(compose, 'back'), /^ {4}build:\s*$/m);
  assert.match(composeService(compose, 'front'), /^ {4}build:\s*$/m);
  assert.doesNotMatch(composeService(compose, 'migrate'), /^ {4}build:\s*$/m);

  assert.equal((compose.match(/^ {4}ports:/gm) ?? []).length, 1);
  assert.match(composeService(compose, 'front'), /^ {4}ports: \["127\.0\.0\.1:\$\{FRONT_PORT:-8080\}:8080"\]$/m);
  assert.match(server, /^ {4}ports: !override\n {6}- "80:80"\n {6}- "443:443"$/m);
  assert.match(server, /^ {6}SITE_ADDRESS: \$\{SITE_ADDRESS:\?SITE_ADDRESS is required on the server\}$/m);

  const postgres = composeService(compose, 'postgres');
  const migrate = composeService(compose, 'migrate');
  const back = composeService(compose, 'back');
  const front = composeService(compose, 'front');
  assert.match(postgres, /^ {6}POSTGRES_USER: sol_owner$/m);
  assert.match(postgres, /^ {6}POSTGRES_PASSWORD_FILE: \/root\/secrets\/postgres-admin-password$/m);
  for (const [service, mount] of [
    [postgres, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/db/postgres-admin-password:/root/secrets/postgres-admin-password:ro'],
    [migrate, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/db:/root/secrets/db:ro'],
    [back, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/db/logins:/root/secrets/logins:ro'],
    [back, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/back:/root/secrets/back:ro'],
    [back, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/config:/etc/sol/config:ro'],
    [back, '      - evidence:/var/lib/sol/evidence'],
    [front, '      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/front/front-basic-auth-hash:/root/secrets/front-basic-auth-hash:ro'],
  ] as const) {
    assert.ok(service.includes(mount), `missing mount ${mount}`);
  }
  assert.match(migrate, /^ {4}command: \["sol-admin", "migrate"\]$/m);
  assert.match(back, /^ {4}command: \["sol-entrypoint"\]$/m);
  assert.match(back, /^ {6}SOL_STACK_MODE: \$\{SOL_STACK_MODE:-observe\}$/m);
  assert.match(back, /^ {6}SOL_HEALTH_REQUIRE_OK: \$\{SOL_HEALTH_REQUIRE_OK:-true\}$/m);
  assert.match(back, /^ {4}tmpfs: \["\/run\/sol:mode=0711,size=16m"\]$/m);
  assert.match(back, /^ {4}init: true$/m);
  assert.match(back, /^ {4}stop_grace_period: 60s$/m);
  assert.match(back, /^ {6}test: \["CMD", "sol-health"\]$/m);

  assert.match(postgres, /^ {4}networks: \[internal\]$/m);
  assert.match(migrate, /^ {4}networks: \[internal\]$/m);
  assert.match(back, /^ {4}networks: \[internal, egress, edge\]$/m);
  assert.match(front, /^ {4}networks: \[edge\]$/m);
  assert.match(compose, /^networks:\n {2}internal:\n {4}internal: true\n {2}egress:\n {2}edge:$/m);
  assert.match(compose, /^volumes:\n {2}postgres-data:\n {2}evidence:\n {2}caddy-data:$/m);
  assert.match(migrate, /depends_on:\n {6}postgres:\n {8}condition: service_healthy/);
  assert.match(back, /depends_on:\n {6}migrate:\n {8}condition: service_completed_successfully/);
  assert.match(front, /depends_on:\n {6}back:\n {8}condition: service_healthy/);
  assert.match(compose, /^x-logging: &logging\n {2}driver: json-file\n {2}options:\n {4}max-size: "20m"\n {4}max-file: "5"$/m);
  assert.equal((compose.match(/^ {4}logging: \*logging$/gm) ?? []).length, 4);

  assert.doesNotMatch(compose, /DATABASE_URL|SOLANA_|LISTENER_|EXECUTOR_|POSTGRES_PASSWORD:|privileged:|network_mode: host|docker\.sock/u);
  assert.doesNotMatch(compose, /api-key|keypair|wallet/iu);
  for (const imageLine of compose.match(/^ {4}image: .+$/gm) ?? []) {
    assert.match(imageLine, /(?:@sha256:[0-9a-f]{64}|\$\{(?:BACKEND|FRONTEND)_IMAGE:\?)/u);
  }
});
```

4. Replace the whole test `'Compose forwards catch-up policy, block hydration and ingestion scope with safe defaults'` with:

```ts
void test('the listener template keeps the catch-up, block hydration and ingestion scope defaults', async () => {
  const [compose, listener, localEnvironment] = await Promise.all([
    readArtifact('deploy/compose.yaml'),
    readArtifact('deploy/config/listener.env.example'),
    readArtifact('.env.example'),
  ]);
  const settings = Object.freeze([
    ['LISTENER_WORKER_COUNT', '1'],
    ['LISTENER_CATCH_UP_POLICY', 'live-edge'],
    ['LISTENER_CATCH_UP_MAX_PAGES', '20'],
    ['LISTENER_CATCH_UP_PAGE_SIZE', '100'],
    ['LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED', 'false'],
    ['LISTENER_PUMPFUN_CATCH_UP_COVERAGE_FAST_PATH_ENABLED', 'false'],
    ['LISTENER_BLOCK_HYDRATION_ENABLED', 'false'],
    ['LISTENER_BLOCK_HYDRATION_MAX_ENTRIES', '64'],
    ['LISTENER_BLOCK_HYDRATION_MAX_BYTES', '67108864'],
    ['LISTENER_BLOCK_HYDRATION_MAX_ENTRY_BYTES', '8388608'],
    ['LISTENER_BLOCK_HYDRATION_CONFIRMED_TTL_MS', '10000'],
    ['LISTENER_BLOCK_HYDRATION_FINALIZED_TTL_MS', '60000'],
    ['LISTENER_BLOCK_HYDRATION_FETCH_INTERVAL_MS', '250'],
  ] as const);

  for (const [name, fallback] of settings) {
    assert.equal((listener.match(new RegExp(`^${name}=${fallback}$`, 'gmu')) ?? []).length, 1, name);
  }
  assert.match(listener, /^LISTENER_INGESTION_SCOPE=launchpad-and-market$/mu);
  assert.match(listener, /^EXECUTION_MODE=observe$/mu);
  assert.match(listener, /^API_HOST=0\.0\.0\.0$/mu);
  assert.match(listener, /# Restart-only Pump\.fun catch-up page admission canary\. Keep false outside an explicitly observed canary\./u);
  assert.match(localEnvironment, /^LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false$/mu);
  assert.match(localEnvironment, /# Restart-only Pump\.fun catch-up page admission canary\. Keep false outside an explicitly observed canary\./u);
  assert.doesNotMatch(compose, /LISTENER_/u);
  assert.doesNotMatch(listener, /PRIVATE_KEY|SECRET_KEY|WALLET/iu);
});
```

5. In `'deployment keeps executable bounded admission disabled until the follow-up delivery gates'`:
   - read `deploy/config/listener.env.example` instead of `deploy/env.example`;
   - delete `const app = composeService(compose, 'app');` and the `assert.equal((app.match(…)) ?? []).length, 1)` block inside the `for` loop;
   - insert `assert.doesNotMatch(compose, /LISTENER_/u);` right before `for (const example of [environment, localEnvironment]) {`.

6. In `'bounded worker admission canary remains post-merge, observe-only and fail-closed'`:
   - read `deploy/config/listener.env.example` instead of `deploy/env.example`;
   - replace the `assert.match(composeService(compose, 'app'), /LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED: …/u);` statement with `assert.doesNotMatch(compose, /LISTENER_/u);`.

7. Replace the whole test `'Compose resolves catch-up scan limit defaults and overrides only for app'` with:

```ts
void test('Compose resolves the stack: only mode inputs reach the containers, secrets stay read-only files', (context) => {
  const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 10_000 });
  if (docker.error !== undefined || docker.status !== 0) {
    context.skip('Docker Compose unavailable: resolved configuration contract skipped');
    return;
  }
  interface ResolvedService {
    readonly environment?: Readonly<Record<string, string>>;
    readonly ports?: readonly Readonly<{ host_ip?: string; published?: string | number; target?: number }>[];
    readonly volumes?: readonly Readonly<{ type?: string; source?: string; target?: string; read_only?: boolean }>[];
  }
  const resolvedConfig = (
    files: readonly string[],
    extra: Readonly<Record<string, string>> = {},
  ): Readonly<Record<string, ResolvedService>> => {
    const result = spawnSync('docker', [
      'compose', '--env-file', 'deploy/env.example', ...files.flatMap((file) => ['-f', file]),
      'config', '--format', 'json',
    ], {
      cwd: fileURLToPath(root), encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, ...extra },
    });
    assert.equal(result.status, 0, result.stderr);
    return (JSON.parse(result.stdout) as { readonly services: Readonly<Record<string, ResolvedService>> }).services;
  };
  const ports = (service: ResolvedService | undefined): string[] => (service?.ports ?? [])
    .map((port) => `${port.host_ip ?? ''}:${String(port.published)}:${String(port.target)}`);
  const binds = (service: ResolvedService | undefined): string[] => (service?.volumes ?? [])
    .filter((volume) => volume.type === 'bind')
    .map((volume) => `${volume.source ?? ''}:${volume.target ?? ''}:${volume.read_only === true ? 'ro' : 'rw'}`);

  const services = resolvedConfig(['deploy/compose.yaml']);
  assert.deepEqual(Object.keys(services).sort(), ['back', 'front', 'migrate', 'postgres']);
  assert.deepEqual(services.back?.environment, {
    POSTGRES_DB: 'sol_token_listener', SOL_HEALTH_REQUIRE_OK: 'true', SOL_STACK_MODE: 'observe',
  });
  assert.deepEqual(services.migrate?.environment, { POSTGRES_DB: 'sol_token_listener' });
  assert.deepEqual(services.front?.environment, { FRONT_BASIC_AUTH_USER: 'operator', SITE_ADDRESS: 'http://:8080' });
  assert.deepEqual(ports(services.front), ['127.0.0.1:8080:8080']);
  for (const name of ['postgres', 'migrate', 'back']) assert.deepEqual(ports(services[name]), [], name);
  assert.deepEqual(binds(services.postgres), [
    '/srv/sol-token-listener/secrets/db/postgres-admin-password:/root/secrets/postgres-admin-password:ro',
  ]);
  assert.deepEqual(binds(services.migrate), ['/srv/sol-token-listener/secrets/db:/root/secrets/db:ro']);
  assert.deepEqual(binds(services.back), [
    '/srv/sol-token-listener/secrets/db/logins:/root/secrets/logins:ro',
    '/srv/sol-token-listener/secrets/back:/root/secrets/back:ro',
    '/srv/sol-token-listener/config:/etc/sol/config:ro',
  ]);
  assert.deepEqual(binds(services.front), [
    '/srv/sol-token-listener/secrets/front/front-basic-auth-hash:/root/secrets/front-basic-auth-hash:ro',
  ]);

  const server = resolvedConfig(['deploy/compose.yaml', 'deploy/compose.server.yaml'], {
    SITE_ADDRESS: 'bot.example.invalid',
  });
  assert.deepEqual(ports(server.front), [':80:80', ':443:443']);
  assert.equal(server.front?.environment?.SITE_ADDRESS, 'bot.example.invalid');
});
```

8. Delete the whole test `'Compose catch-up admission resolves default-off and explicit activation without other service exposure'`. The listener variables no longer pass through Compose; `tests/deploy-role-environment.test.ts` covers them.

9. Replace the whole test `'Compose keeps the raw PostgreSQL password separate from its URI-encoded form'` with:

```ts
void test('Compose never carries a database password or URL: the containers read secret files', async () => {
  const compose = await readArtifact('deploy/compose.yaml');
  assert.match(composeService(compose, 'postgres'), /^ {6}POSTGRES_PASSWORD_FILE: \/root\/secrets\/postgres-admin-password$/m);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:|POSTGRES_PASSWORD_URI_ENCODED|DATABASE_URL|postgresql:\/\//u);
});
```

10. Replace the whole test `'Compose environment template contains documentation-only required inputs'` with these two tests:

```ts
void test('the compose input template holds no secret and documents every input', async () => {
  const environment = await readArtifact('deploy/env.example');
  const lines = environment.split('\n');
  for (const value of [
    'SOL_HOST_DIR=/srv/sol-token-listener',
    'SOL_STACK_MODE=observe',
    'SOL_HEALTH_REQUIRE_OK=true',
    'POSTGRES_DB=sol_token_listener',
    `BACKEND_IMAGE=registry.invalid/sol-token-listener/backend@sha256:${'0'.repeat(64)}`,
    `FRONTEND_IMAGE=registry.invalid/sol-token-listener/frontend@sha256:${'1'.repeat(64)}`,
    'FRONT_PORT=8080',
    'FRONT_BASIC_AUTH_USER=operator',
    'SITE_ADDRESS=',
  ]) {
    assert.ok(lines.includes(value), `missing compose input: ${value}`);
  }
  assert.match(environment, /outside version control/iu);
  assert.match(environment, /holds no secret/iu);
  assert.doesNotMatch(environment, /PASSWORD|PRIVATE_KEY|SECRET_KEY|WALLET|api-key|SOLANA_/iu);
  for (const name of ['BACKEND_IMAGE', 'FRONTEND_IMAGE']) {
    assert.match(environment, new RegExp(`^${name}=registry\\.invalid/[^\\s@]+@sha256:[0-9a-f]{64}$`, 'm'));
  }
});

void test('every role has a configuration template, and no template carries a secret', async () => {
  const files = [...new Set(Object.values(ROLES).map((role) => role.configFile))].sort();
  assert.deepEqual(files, [
    'listener.env', 'live-recovery.env', 'live.env', 'operations.env', 'operator-api.env',
    'preflight-bundle.env', 'provider-evidence.env', 'readiness.env', 'retention.env', 'worker-sim.env',
  ]);
  assert.deepEqual((await readdir(new URL('deploy/config/', root))).sort(), files.map((file) => `${file}.example`));
  for (const file of files) {
    const text = await readArtifact(`deploy/config/${file}.example`);
    assert.doesNotThrow(() => parseRoleConfig(text, file), file);
    assert.doesNotMatch(text, /api-key|postgresql:\/\//iu, file);
  }
  const operatorApi = parseRoleConfig(await readArtifact('deploy/config/operator-api.env.example'), 'operator-api.env');
  assert.equal(operatorApi.OPERATOR_API_HOST, '0.0.0.0');
  assert.equal(operatorApi.OPERATOR_API_PORT, '3100');
  const operations = parseRoleConfig(await readArtifact('deploy/config/operations.env.example'), 'operations.env');
  assert.equal(operations.SOLANA_HTTP_RPC_URL, undefined);
});
```

- [ ] **Step 2: Run the file and watch the updated tests fail**

Run: `npx tsx --test tests/deployment-artifacts.test.ts`
Expected: FAIL in the tests above (old compose, missing templates and server override).

- [ ] **Step 3: Rewrite the compose files**

Replace the whole content of `deploy/compose.yaml` with:

```yaml
name: sol-token-listener

# Full-bot stack (docs/superpowers/specs/2026-10-09-full-bot-compose-design.md). Secrets are files
# under ${SOL_HOST_DIR}/secrets, mounted read-only under /root/secrets: nothing secret lives here.
x-logging: &logging
  driver: json-file
  options:
    max-size: "20m"
    max-file: "5"

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

  migrate:
    image: ${BACKEND_IMAGE:?BACKEND_IMAGE is required}
    command: ["sol-admin", "migrate"]
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-sol_token_listener}
    volumes:
      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/db:/root/secrets/db:ro
    depends_on:
      postgres:
        condition: service_healthy
    networks: [internal]
    logging: *logging
    restart: "no"

  back:
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
    volumes:
      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/db/logins:/root/secrets/logins:ro
      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/secrets/back:/root/secrets/back:ro
      - ${SOL_HOST_DIR:?SOL_HOST_DIR is required}/config:/etc/sol/config:ro
      - evidence:/var/lib/sol/evidence
    tmpfs: ["/run/sol:mode=0711,size=16m"]
    init: true
    stop_grace_period: 60s
    depends_on:
      migrate:
        condition: service_completed_successfully
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

networks:
  internal:
    internal: true
  egress:
  edge:

volumes:
  postgres-data:
  evidence:
  caddy-data:
```

Create `deploy/compose.server.yaml`:

```yaml
services:
  front:
    environment:
      SITE_ADDRESS: ${SITE_ADDRESS:?SITE_ADDRESS is required on the server}
    ports: !override
      - "80:80"
      - "443:443"
```

Replace the whole content of `deploy/env.example` with:

```dotenv
# Compose inputs of the full-bot stack (docs/operations/deployment.md). Copy this file
# outside version control: ~/.sol-token-listener/docker/compose.env on the Mac,
# /srv/sol-token-listener/compose.env on the server. It holds no secret: every secret is a file
# under $SOL_HOST_DIR/secrets, and the process settings live in $SOL_HOST_DIR/config.

# Host directory with secrets/, config/ and backups/ (mode 0700, outside the repository).
SOL_HOST_DIR=/srv/sol-token-listener
# observe: listener, operator API and retention. live: adds H2a, H2b and auto-arm; no new BUY
# before `sol trading start`.
SOL_STACK_MODE=observe
# true: the back is healthy only when the listener health is OK; false also accepts DEGRADED.
SOL_HEALTH_REQUIRE_OK=true
POSTGRES_DB=sol_token_listener

# Replace both documentation-only digests with the immutable images of the release. A local
# build may use plain local tags instead (docs/operations/deployment.md, « Images »).
BACKEND_IMAGE=registry.invalid/sol-token-listener/backend@sha256:0000000000000000000000000000000000000000000000000000000000000000
FRONTEND_IMAGE=registry.invalid/sol-token-listener/frontend@sha256:1111111111111111111111111111111111111111111111111111111111111111

# Mac: the front listens on 127.0.0.1 only. The server override publishes 80 and 443 instead.
FRONT_PORT=8080
FRONT_BASIC_AUTH_USER=operator
# Server only (deploy/compose.server.yaml): the public DNS name Caddy serves over HTTPS.
SITE_ADDRESS=
```

Then delete the smoke override, now useless: the smoke writes its own listener configuration (Task 12).

```bash
git rm deploy/compose.smoke.yaml
```

- [ ] **Step 4: Create the ten configuration templates**

Every value is an example in the format the real parsers accept. The executor examples satisfy the timing constraints of `parseLiveExecutorConfig` and `parseExecutionAutoArmConfig`, for example `EXECUTOR_LEASE_MS=45000`. The runbook (Task 14) builds the real files from the current `~/.sol-token-listener/lot5/env/` files.

Create `deploy/config/listener.env.example`:

```dotenv
# Listener and public API (user listener, login sol_listener -> sol_token_listener_writer).
# sol-run injects DATABASE_URL, SOLANA_HTTP_RPC_URL and SOLANA_WS_RPC_URL from the secret files:
# never put a URL, password or key here. Copy to $SOL_HOST_DIR/config/listener.env (mode 0644).
# These are the safe historical defaults; the trading bot uses the values of the current
# ~/.sol-token-listener/lot5/env/listener.env (docs/operations/deployment.md).
POSTGRES_AUTO_MIGRATE=false
EXECUTION_MODE=observe
PAPER_STRATEGY_ENABLED=false
API_ENABLED=true
# The front reaches the API through the edge network: listen on every interface of the container.
API_HOST=0.0.0.0
API_PORT=3000
DATA_RETENTION_HOURS=4
LISTENER_ENABLED=true
# Required when LISTENER_ENABLED=true. Obtain and independently verify the
# canonical 32-byte base58 genesis hash for the intended Solana cluster.
SOLANA_EXPECTED_GENESIS_HASH=
# Fallback RPC URLs carry provider keys: they come with the multi-account work (sub-project 3).
SOLANA_HTTP_RPC_FALLBACK_URLS=
SOLANA_WS_RPC_FALLBACK_URLS=
# Historical default. Set launchpad-only explicitly for the block hydration canary.
LISTENER_INGESTION_SCOPE=launchpad-and-market
ENTRY_MODE=off
# Fresh databases ignore the first validated history page; existing checkpoints stay strict.
LISTENER_CATCH_UP_POLICY=live-edge
# Internal transaction workers. Values 2..4 require block hydration plus launchpad-only; first canary uses 2.
LISTENER_WORKER_COUNT=1
# Bounded strict scan defaults. H2i may use PAGE_SIZE=1000 only during an explicitly observed canary.
LISTENER_CATCH_UP_MAX_PAGES=20
LISTENER_CATCH_UP_PAGE_SIZE=100
# Restart-only Pump.fun catch-up page admission canary. Keep false outside an explicitly observed canary.
LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false
# Executable classification (#176), restart-only; requires the strict catch-up page classifier.
# Operational activation prohibited until #177 is merged AND post-merge CI is green. Keep false.
# The tracking window is parsed only; #177 supplies its bounded authority and canary contract.
LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED=false
LISTENER_PUMPFUN_TRACKING_WINDOW_SECONDS=45
# Restart-only durable coverage optimization. Keep false until its dedicated observe-only canary.
LISTENER_PUMPFUN_CATCH_UP_COVERAGE_FAST_PATH_ENABLED=false
# Restart-only block hydration cache. Keep disabled outside a controlled canary.
LISTENER_BLOCK_HYDRATION_ENABLED=false
LISTENER_BLOCK_HYDRATION_MAX_ENTRIES=64
LISTENER_BLOCK_HYDRATION_MAX_BYTES=67108864
LISTENER_BLOCK_HYDRATION_MAX_ENTRY_BYTES=8388608
LISTENER_BLOCK_HYDRATION_CONFIRMED_TTL_MS=10000
LISTENER_BLOCK_HYDRATION_FINALIZED_TTL_MS=60000
LISTENER_BLOCK_HYDRATION_FETCH_INTERVAL_MS=250
```

Create `deploy/config/live.env.example`:

```dotenv
# H2b, the live executor (user h2b, login sol_live -> sol_token_executor_live). sol-run injects
# DATABASE_URL, SOLANA_HTTP_RPC_URL and the path of the wallet file in the h2b tmpfs directory.
# Example values only: copy the real ones from ~/.sol-token-listener/lot5/env/live.env
# (docs/operations/deployment.md). The EXECUTOR_* runtime values must equal operations.env.
EXECUTOR_MODE=live
LIVE_TRADING_ENABLED=true
SOLANA_CLUSTER=mainnet-beta
EXECUTOR_ACTIVATION_PHASE=CANARY
EXECUTOR_WALLET_GENERATION_ID=execution_wallet_generation_0000000000000000000000000000000000000000000000000000000000000000
EXECUTOR_PUBLIC_KEY=11111111111111111111111111111111
# Replace with the independently verified genesis hash of the intended cluster.
SOLANA_EXPECTED_GENESIS_HASH=11111111111111111111111111111111
EXECUTOR_RPC_PROVIDER_ID=helius-executor
EXECUTOR_BUILD_HASH=0000000000000000000000000000000000000000000000000000000000000000
EXECUTOR_CONFIGURATION_FINGERPRINT=0000000000000000000000000000000000000000000000000000000000000000
EXECUTOR_STRATEGY_FINGERPRINT=0000000000000000000000000000000000000000000000000000000000000000
EXECUTOR_POLL_MS=500
EXECUTOR_LEASE_MS=45000
EXECUTOR_DB_STATEMENT_TIMEOUT_MS=3000
EXECUTOR_SHUTDOWN_GRACE_MS=30000
EXECUTOR_RPC_TIMEOUT_MS=5000
EXECUTOR_QUOTE_MAX_AGE_MS=30000
EXECUTOR_SLIPPAGE_BPS=500
EXECUTOR_SNAPSHOT_MAX_SLOT_LAG=32
EXECUTOR_MAX_COMPUTE_UNITS=200000
EXECUTOR_MAX_FEE_LAMPORTS=100000
EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT=15000000
EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS=0
EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT=16
LIVE_QUOTE_MINT_ALLOWLIST=So11111111111111111111111111111111111111112
```

Create `deploy/config/live-recovery.env.example`:

```dotenv
# H2a, the recovery executor (user h2a, login sol_recovery -> sol_token_executor_live_recovery).
# sol-run injects DATABASE_URL and SOLANA_HTTP_RPC_URL. Example values only: copy the real ones
# from ~/.sol-token-listener/lot5/env/live-recovery.env.
EXECUTOR_LIVE_RECOVERY_ENABLED=true
EXECUTOR_MODE=live
SOLANA_CLUSTER=mainnet-beta
EXECUTOR_WALLET_GENERATION_ID=execution_wallet_generation_0000000000000000000000000000000000000000000000000000000000000000
EXECUTOR_PUBLIC_KEY=11111111111111111111111111111111
EXECUTOR_RPC_PROVIDER_ID=helius-executor
# Replace with the independently verified genesis hash of the intended cluster.
SOLANA_EXPECTED_GENESIS_HASH=11111111111111111111111111111111
EXECUTOR_POLL_MS=500
EXECUTOR_LEASE_MS=45000
EXECUTOR_DB_STATEMENT_TIMEOUT_MS=3000
EXECUTOR_SHUTDOWN_GRACE_MS=30000
EXECUTOR_RPC_TIMEOUT_MS=5000
EXECUTOR_MAX_RPC_CALLS_PER_PASS=8
EXECUTOR_LIVE_RECOVERY_OWNER_ID=h2a
```

Create `deploy/config/operations.env.example`:

```dotenv
# Operations CLI (sol ops: user ops, login sol_ops) and auto-arm daemon (user autoarm, login
# sol_autoarm), both -> sol_token_executor_operations. sol-run injects DATABASE_URL, and
# SOLANA_HTTP_RPC_URL for auto-arm only. Example values only: copy the real ones from
# ~/.sol-token-listener/lot5/env/operations.env, with paths under /var/lib/sol/evidence.
# The EXECUTOR_* runtime values must equal live.env.
EXECUTOR_WALLET_GENERATION_ID=execution_wallet_generation_0000000000000000000000000000000000000000000000000000000000000000
EXECUTOR_PUBLIC_KEY=11111111111111111111111111111111
# Replace with the independently verified genesis hash of the intended cluster.
SOLANA_EXPECTED_GENESIS_HASH=11111111111111111111111111111111
EXECUTOR_RPC_PROVIDER_ID=helius-executor
EXECUTOR_BUILD_HASH=0000000000000000000000000000000000000000000000000000000000000000
EXECUTOR_CONFIGURATION_FINGERPRINT=0000000000000000000000000000000000000000000000000000000000000000
EXECUTOR_STRATEGY_FINGERPRINT=0000000000000000000000000000000000000000000000000000000000000000
EXECUTOR_ACTIVATION_PHASE=CANARY
EXECUTOR_OPERATOR_ID=operator
EXECUTOR_PREFLIGHT_EVIDENCE_PATH=/var/lib/sol/evidence/bundle/qualification.json
EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH=/var/lib/sol/evidence/gate-catalog.json
EXECUTOR_AUTO_ARM_POLL_MS=1000
EXECUTOR_POLL_MS=500
EXECUTOR_LEASE_MS=45000
EXECUTOR_DB_STATEMENT_TIMEOUT_MS=3000
EXECUTOR_SHUTDOWN_GRACE_MS=30000
EXECUTOR_RPC_TIMEOUT_MS=5000
EXECUTOR_QUOTE_MAX_AGE_MS=30000
EXECUTOR_SLIPPAGE_BPS=500
EXECUTOR_SNAPSHOT_MAX_SLOT_LAG=32
EXECUTOR_MAX_COMPUTE_UNITS=200000
EXECUTOR_MAX_FEE_LAMPORTS=100000
EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT=15000000
EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS=0
EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT=16
LIVE_QUOTE_MINT_ALLOWLIST=So11111111111111111111111111111111111111112
```

Create `deploy/config/operator-api.env.example`:

```dotenv
# Operator API (user opapi, login sol_reader -> sol_token_operator_reader). sol-run injects
# OPERATOR_API_DATABASE_URL, OPERATOR_API_TOKEN and SOLANA_HTTP_RPC_URL: never put them here.
# Keep 0.0.0.0 and 3100: the front relays /operator/v1/ here and rewrites its Host to 0.0.0.0:3100,
# the only Host this API answers.
OPERATOR_API_HOST=0.0.0.0
OPERATOR_API_PORT=3100
# Exact origin of the console: http://127.0.0.1:8080 on the Mac, https://<SITE_ADDRESS> on the server.
OPERATOR_API_ALLOWED_ORIGIN=http://127.0.0.1:8080
```

Create `deploy/config/retention.env.example`:

```dotenv
# Retention purge (user retention, login sol_retention -> sol_token_retention_worker).
# sol-run injects DATABASE_URL. sol qualify start stops this program during a gate-10 probe.
POSTGRES_AUTO_MIGRATE=false
DATA_RETENTION_HOURS=4
RETENTION_PURGE_INTERVAL_MS=900000
```

Create `deploy/config/worker-sim.env.example`:

```dotenv
# Simulation-only worker for the gate-10 probe (user worker, login sol_worker ->
# sol_token_executor_worker), started by sol qualify start only. sol-run injects DATABASE_URL
# (with search_path) and SOLANA_HTTP_RPC_URL. Example values only: copy the real ones from
# ~/.sol-token-listener/lot5/env/worker-sim.env.
POSTGRES_AUTO_MIGRATE=false
EXECUTOR_MODE=simulation-only
LIVE_TRADING_ENABLED=false
EXECUTOR_PUBLIC_KEY=11111111111111111111111111111111
EXECUTOR_RPC_PROVIDER_ID=helius-executor
# Replace with the independently verified genesis hash of the intended cluster.
SOLANA_EXPECTED_GENESIS_HASH=11111111111111111111111111111111
EXECUTOR_POLL_MS=500
EXECUTOR_LEASE_MS=45000
EXECUTOR_DB_STATEMENT_TIMEOUT_MS=3000
EXECUTOR_SHUTDOWN_GRACE_MS=30000
EXECUTOR_RPC_TIMEOUT_MS=5000
EXECUTOR_QUOTE_MAX_AGE_MS=30000
EXECUTOR_SLIPPAGE_BPS=500
EXECUTOR_SNAPSHOT_MAX_SLOT_LAG=32
EXECUTOR_MAX_COMPUTE_UNITS=200000
EXECUTOR_MAX_FEE_LAMPORTS=100000
EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT=15000000
EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS=0
EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT=16
LIVE_QUOTE_MINT_ALLOWLIST=So11111111111111111111111111111111111111112
```

Create `deploy/config/readiness.env.example`:

```dotenv
# H2d readiness (sol readiness: user ops, login sol_readiness -> sol_token_executor_readiness).
# sol-run injects DATABASE_URL and SOLANA_HTTP_RPC_URL. Example values only: copy the real ones
# from ~/.sol-token-listener/lot5/env/readiness.env, with paths under /var/lib/sol/evidence.
SOLANA_CLUSTER=mainnet-beta
# Replace with the independently verified genesis hash of the intended cluster.
SOLANA_EXPECTED_GENESIS_HASH=11111111111111111111111111111111
EXECUTOR_RPC_PROVIDER_ID=helius-executor
EXECUTOR_PUBLIC_KEY=11111111111111111111111111111111
EXECUTOR_WALLET_GENERATION_NUMBER=1
EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
EXECUTOR_PROVIDER_EVIDENCE_PATH=/var/lib/sol/evidence/provider-evidence.json
EXECUTOR_READINESS_MAX_SLOT_LAG=8
EXECUTOR_RPC_TIMEOUT_MS=5000
```

Create `deploy/config/provider-evidence.env.example`:

```dotenv
# H2e provider evidence (sol evidence provider: user ops). sol-run injects HELIUS_API_KEY_PATH and
# EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH (files of the ops tmpfs directory); this process takes no
# database or RPC URL. Example values only: copy the real ones from
# ~/.sol-token-listener/lot5/env/provider-evidence.env, with paths under /var/lib/sol/evidence.
HELIUS_PROJECT_ID=00000000-0000-4000-8000-000000000000
EXECUTOR_RPC_PROVIDER_ID=helius-executor
EXECUTOR_PROVIDER_EVIDENCE_PATH=/var/lib/sol/evidence/provider-evidence.json
EXECUTOR_PROVIDER_EVIDENCE_TTL_MS=300000
EXECUTOR_PROVIDER_EVIDENCE_TIMEOUT_MS=10000
```

Create `deploy/config/preflight-bundle.env.example`:

```dotenv
# H2f preflight bundle (sol evidence bundle: user ops). sol-run injects
# EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH; this process takes no database, RPC or Helius variable.
# Example values only: copy the real ones from ~/.sol-token-listener/lot5/env/preflight-bundle.env,
# with paths under /var/lib/sol/evidence.
EXECUTOR_PREFLIGHT_DRAFT_PATH=/var/lib/sol/evidence/preflight-draft.json
EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY=/var/lib/sol/evidence/bundle
```

- [ ] **Step 5: Run the tests and resolve the compose file**

```bash
npx tsx --test tests/deployment-artifacts.test.ts tests/deploy-*.test.ts
docker compose --env-file deploy/env.example -f deploy/compose.yaml config -q
SITE_ADDRESS=bot.example.invalid docker compose --env-file deploy/env.example -f deploy/compose.yaml -f deploy/compose.server.yaml config -q
```

Expected: PASS, and both `config -q` commands exit 0 silently.

- [ ] **Step 6: Commit**

```bash
git add deploy/compose.yaml deploy/compose.server.yaml deploy/env.example deploy/config tests/deployment-artifacts.test.ts
git commit -m "feat(deploy): four-service compose stack with file secrets and role templates

postgres, migrate (admin password only there), back (supervisord, tmpfs secrets, evidence volume)
and front (Caddy, loopback on the Mac, 80/443 through deploy/compose.server.yaml). The compose
file carries no secret and no process setting: those live in the host secrets/ and config/
directories, with one configuration template per role.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: Deployment smoke on the new topology

**Files:**
- Modify: `scripts/deployment-smoke.mjs`
- Test: `tests/deployment-artifacts.test.ts` (smoke contract tests)

The smoke keeps its structure: bounded commands, signal handling, redacted failures, guaranteed cleanup. It now writes a throwaway host directory with every secret and configuration file, builds `back` and `front`, and starts the stack in `observe` mode with the listener disabled, so no RPC is contacted. It then proves the contract of spec 11.2:
- the program users and the non-root Caddy;
- the owner-only tmpfs secrets, which the `listener` user cannot read;
- the front: 401 without credentials, 405 on a write, the bearer-protected operator API;
- the nine logins and their group roles;
- the closed `sol ops status` answer, no H2b, and neither envelope nor signed transaction;
- SSE shutdown through `sol ctl stop listener` and the retention one-shot.

Validated on 2026-10-09: `npm run deployment:smoke` and `npm run deployment:smoke:signal` both passed with exactly these edits, and left no container, volume, network, image or host directory behind.

- [ ] **Step 1: Update the smoke contract tests first**

Apply these edits to `tests/deployment-artifacts.test.ts`, each replacing the old text with the new one.

1. Old:

```ts
import { ROLES, STACK_USERS } from '../src/deploy/stack.js';
```

   New:

```ts
import { DATABASE_LOGINS, ROLES, STACK_USERS } from '../src/deploy/stack.js';
```

2. Old:

```ts
  assert.match(smoke, /POSTGRES_PASSWORD:\s*postgresPassword/);
  assert.match(smoke, /POSTGRES_PASSWORD_URI_ENCODED:\s*encodeURIComponent\(postgresPassword\)/);
  assert.match(smoke, /SOLANA_HTTP_RPC_URL:\s*'https:\/\/rpc\.invalid'/);
  assert.match(smoke, /SOLANA_WS_RPC_URL:\s*'wss:\/\/rpc\.invalid'/);
  assert.match(smoke, /LISTENER_ENABLED:\s*'false'/);
```

   New:

```ts
  assert.match(smoke, /frontPassword\s*=\s*randomBytes\(24\)\.toString\('hex'\)/);
  assert.match(smoke, /operatorApiToken\s*=\s*randomBytes\(32\)\.toString\('hex'\)/);
  assert.match(smoke, /SOL_HOST_DIR:\s*hostDirectory/);
  assert.match(smoke, /SOL_STACK_MODE:\s*'observe'/);
  assert.match(smoke, /SOL_HEALTH_REQUIRE_OK:\s*'false'/);
  assert.match(smoke, /\['secrets\/back\/helius-listener-http-url', 'https:\/\/rpc\.invalid\\n'\]/);
  assert.match(smoke, /\['secrets\/back\/helius-listener-ws-url', 'wss:\/\/rpc\.invalid\\n'\]/);
  assert.match(smoke, /const override = name === 'listener' \? 'LISTENER_ENABLED=false\\n' : '';/);
```

3. Old:

```ts
  assert.match(smoke, /const smokeComposeFile = resolve\(root, 'deploy\/compose\.smoke\.yaml'\)/);
  assert.match(
    smoke,
    /return \['compose', \.\.\.projectArgs, '-f', composeFile, '-f', smokeComposeFile, \.\.\.args\];/,
  );
  assert.match(smoke, /await compose\(\['build', 'app', 'frontend'\]\)/);
```

   New:

```ts
  assert.doesNotMatch(smoke, /compose\.smoke\.yaml|smokeComposeFile/);
  assert.match(smoke, /return \['compose', \.\.\.projectArgs, '-f', composeFile, \.\.\.args\];/);
  assert.match(smoke, /await compose\(\['build', 'back', 'front'\]\)/);
```

4. Old:

```ts
  assert.doesNotMatch(smoke, /--privileged|network_mode|host networking|docker system prune|private[_ -]?key|\bwallet\b/iu);
```

   New:

```ts
  assert.doesNotMatch(smoke, /--privileged|network_mode|host networking|docker system prune|private[_ -]?key/iu);
  // The only keypair is random bytes that prove the tmpfs isolation; it never holds funds.
  assert.match(smoke, /const throwawayKeypair = JSON\.stringify\(\[\.\.\.randomBytes\(64\)\]\);/u);
```

5. Old:

```ts
    /const \{ stdout, stderr \} = await compose\(\[\s*'exec', '-T', 'retention'/,
```

   New:

```ts
    /const \{ stdout, stderr \} = await compose\(\[\s*'exec', '-T', 'back', 'sol-run', 'retention'/,
```

6. Old:

```ts
  assert.match(smoke, /'exec', '-T', 'app', 'node', '-e', 'setInterval\(\(\) => undefined, 1_000\)'/);
```

   New:

```ts
  assert.match(smoke, /'exec', '-T', 'back', 'node', '-e', 'setInterval\(\(\) => undefined, 1_000\)'/);
```

7. Old:

```ts
  assert.match(smoke, /FRONTEND_PORT:\s*'0'/);
  assert.match(smoke, /\['port', 'frontend', '8080'\]/);
```

   New:

```ts
  assert.match(smoke, /FRONT_PORT:\s*'0'/);
  assert.match(smoke, /\['port', 'front', '8080'\]/);
```

8. Old:

```ts
  assert.match(smoke, /await cleanupFaultProject\(faultName, cleanupFailures\)/);
```

   New:

```ts
  assert.match(smoke, /await cleanupFaultProject\(faultName, cleanupFailures\)/);
  assert.match(smoke, /await rm\(hostDirectoryFor\(faultName\), \{ recursive: true, force: true \}\)/);
```

9. Old:

```ts
void test('top-level deployment errors are categorized, bounded, and never reflect input', () => {
```

   New:

```ts
void test('deployment smoke proves users, secret isolation, front authentication, logins and closed operations', async () => {
  const smoke = await readArtifact('scripts/deployment-smoke.mjs');
  for (const phase of ['HOST_SETUP', 'PROCESS_USERS', 'NON_ROOT_FRONT', 'SECRET_ISOLATION', 'FRONT_AUTH', 'LOGINS', 'OPERATIONS']) {
    assert.ok(smoke.includes(`await smokePhase('${phase}'`), `missing smoke phase ${phase}`);
  }
  for (const statement of [
    "assertEqual(stdout, 'listener 10001\\nopapi 10005\\nretention 10006\\n'",
    "assertEqual(stdout.trim(), '10100'",
    "assertEqual(stdout, 'h2b 400\\nopapi 400\\n'",
    "'setpriv', '--reuid=listener', '--regid=listener', '--clear-groups', 'cat', path",
    'assertEqual(anonymous.status, 401',
    'assertEqual(write.status, 405',
    'assertEqual(operator.status, 401',
    'assertEqual(authorized.status, 200',
    '`PGOPTIONS=-c role=${group}`',
    "assertEqual(counts.trim(), '0|0'",
  ]) {
    assert.ok(smoke.includes(statement), `missing smoke check: ${statement}`);
  }
  for (const [login, group] of Object.entries(DATABASE_LOGINS)) {
    assert.ok(smoke.includes(`  ${login}: '${group}',`), `smoke login table differs for ${login}`);
  }
});

void test('top-level deployment errors are categorized, bounded, and never reflect input', () => {
```

- [ ] **Step 2: Run the file and watch the smoke tests fail**

Run: `npx tsx --test tests/deployment-artifacts.test.ts`
Expected: FAIL in the smoke tests (old services, old environment, missing phases).

- [ ] **Step 3: Edit `scripts/deployment-smoke.mjs`**

Apply these 24 edits in order. Each one replaces an exact old text, a whole function where the old text is a function, with the new text.

1. Old:

```js
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
```

   New:

```js
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
```

2. Old:

```js
const SMOKE_PHASES = new Set([
  'BUILD', 'START', 'PORT_DISCOVERY', 'SIGNAL_PROBE', 'NON_ROOT_APP',
  'NON_ROOT_FRONTEND', 'PUBLIC_HEALTH', 'CORS', 'MIGRATIONS', 'FRONTEND',
  'SSE_SHUTDOWN', 'APP_RESTART', 'HEALTH_RECOVERY', 'RETENTION', 'CLEANUP',
]);
```

   New:

```js
const SMOKE_PHASES = new Set([
  'BUILD', 'HOST_SETUP', 'START', 'PORT_DISCOVERY', 'SIGNAL_PROBE', 'PROCESS_USERS',
  'NON_ROOT_FRONT', 'SECRET_ISOLATION', 'FRONT_AUTH', 'PUBLIC_HEALTH', 'CORS', 'MIGRATIONS',
  'LOGINS', 'OPERATIONS', 'FRONTEND', 'SSE_SHUTDOWN', 'APP_RESTART', 'HEALTH_RECOVERY',
  'RETENTION', 'CLEANUP',
]);
```

3. Old:

```js
const composeFile = resolve(root, 'deploy/compose.yaml');
const smokeComposeFile = resolve(root, 'deploy/compose.smoke.yaml');
```

   New:

```js
const composeFile = resolve(root, 'deploy/compose.yaml');
```

4. Old:

```js
const deploymentImages = deploymentImagesFor(projectName);
const postgresPassword = randomBytes(24).toString('hex');
```

   New:

```js
const deploymentImages = deploymentImagesFor(projectName);
const hostDirectory = hostDirectoryFor(projectName);
const SMOKE_USER = 'smoke';
const postgresPassword = randomBytes(24).toString('hex');
const frontPassword = randomBytes(24).toString('hex');
const operatorApiToken = randomBytes(32).toString('hex');
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
const loginPasswords = Object.freeze(Object.fromEntries(
  Object.keys(loginGroups).map((login) => [login, randomBytes(24).toString('hex')]),
));
// Throwaway: random bytes, never a funded key; only used to prove the tmpfs isolation.
const throwawayKeypair = JSON.stringify([...randomBytes(64)]);
const smokeSecrets = Object.freeze([
  postgresPassword, frontPassword, operatorApiToken, ...Object.values(loginPasswords),
]);
const basicAuthorization = `Basic ${Buffer.from(`${SMOKE_USER}:${frontPassword}`).toString('base64')}`;
```

5. Old:

```js
function deploymentImagesFor(name) {
```

   New:

```js
function hostDirectoryFor(name) {
  return join(tmpdir(), `${name}-host`);
}

function deploymentImagesFor(name) {
```

6. Old:

```js
const environment = Object.freeze({
  ...process.env,
  COMPOSE_PROJECT_NAME: projectName,
  POSTGRES_DB: 'smoke',
  POSTGRES_USER: 'smoke',
  POSTGRES_PASSWORD: postgresPassword,
  POSTGRES_PASSWORD_URI_ENCODED: encodeURIComponent(postgresPassword),
  BACKEND_IMAGE: deploymentImages.backend,
  FRONTEND_IMAGE: deploymentImages.frontend,
  SOLANA_HTTP_RPC_URL: 'https://rpc.invalid',
  SOLANA_WS_RPC_URL: 'wss://rpc.invalid',
  LISTENER_ENABLED: 'false',
  FRONTEND_PORT: '0',
});
```

   New:

```js
const environment = Object.freeze({
  ...process.env,
  COMPOSE_PROJECT_NAME: projectName,
  SOL_HOST_DIR: hostDirectory,
  SOL_STACK_MODE: 'observe',
  SOL_HEALTH_REQUIRE_OK: 'false',
  POSTGRES_DB: 'smoke',
  BACKEND_IMAGE: deploymentImages.backend,
  FRONTEND_IMAGE: deploymentImages.frontend,
  FRONT_PORT: '0',
  FRONT_BASIC_AUTH_USER: SMOKE_USER,
});
```

7. Old:

```js
      await smokePhase('BUILD', async () => { await compose(['build', 'app', 'frontend']); });
      await smokePhase('START', async () => { await compose(['up', '--detach', '--wait', '--wait-timeout', '120']); });
      baseUrl = await smokePhase('PORT_DISCOVERY', discoverFrontendBaseUrl);
      if (selfSignal !== null) {
        await smokePhase('SIGNAL_PROBE', async () => { await runActiveChildSignalProbe(selfSignal); });
      }
      await smokePhase('NON_ROOT_APP', () => assertNonRoot('app'));
      await smokePhase('NON_ROOT_FRONTEND', () => assertNonRoot('frontend'));
      await smokePhase('PUBLIC_HEALTH', assertPublicHealth);
```

   New:

```js
      await smokePhase('BUILD', async () => { await compose(['build', 'back', 'front']); });
      await smokePhase('HOST_SETUP', writeSmokeHost);
      await smokePhase('START', async () => { await compose(['up', '--detach', '--wait', '--wait-timeout', '180']); });
      baseUrl = await smokePhase('PORT_DISCOVERY', discoverFrontendBaseUrl);
      if (selfSignal !== null) {
        await smokePhase('SIGNAL_PROBE', async () => { await runActiveChildSignalProbe(selfSignal); });
      }
      await smokePhase('PROCESS_USERS', assertProcessUsers);
      await smokePhase('NON_ROOT_FRONT', assertFrontNonRoot);
      await smokePhase('SECRET_ISOLATION', assertSecretIsolation);
      await smokePhase('FRONT_AUTH', assertFrontAuthentication);
      await smokePhase('PUBLIC_HEALTH', assertPublicHealth);
```

8. Old:

```js
      await smokePhase('FRONTEND', assertFrontendContract);
      await smokePhase('SSE_SHUTDOWN', assertGracefulSseShutdown);
      await smokePhase('APP_RESTART', async () => { await compose(['start', 'app']); });
```

   New:

```js
      await smokePhase('LOGINS', assertLogins);
      await smokePhase('OPERATIONS', assertOperations);
      await smokePhase('FRONTEND', assertFrontendContract);
      await smokePhase('SSE_SHUTDOWN', assertGracefulSseShutdown);
      await smokePhase('APP_RESTART', async () => { await compose(['exec', '-T', 'back', 'sol', 'ctl', 'start', 'listener']); });
```

9. Old:

```js
      await cleanupExplicitImages(deploymentImages, environment, cleanupFailures);
      for (const check of projectResourceChecks) {
```

   New:

```js
      await cleanupExplicitImages(deploymentImages, environment, cleanupFailures);
      try {
        await rm(hostDirectory, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
      for (const check of projectResourceChecks) {
```

10. Old:

```js
      'exec', '-T', 'app', 'node', '-e', 'setInterval(() => undefined, 1_000)',
```

   New:

```js
      'exec', '-T', 'back', 'node', '-e', 'setInterval(() => undefined, 1_000)',
```

11. Old:

```js
  await cleanupExplicitImages(deploymentImagesFor(faultName), faultEnvironment, cleanupFailures);
  const faultLabel
```

   New:

```js
  await cleanupExplicitImages(deploymentImagesFor(faultName), faultEnvironment, cleanupFailures);
  try {
    await rm(hostDirectoryFor(faultName), { recursive: true, force: true });
  } catch (error) {
    cleanupFailures.push(error);
  }
  const faultLabel
```

12. Old:

```js
function faultCleanupEnvironment(faultName) {
  return Object.freeze({
    ...process.env,
    COMPOSE_PROJECT_NAME: faultName,
    POSTGRES_DB: 'smoke',
    POSTGRES_USER: 'smoke',
    POSTGRES_PASSWORD: 'cleanup-only',
    POSTGRES_PASSWORD_URI_ENCODED: 'cleanup-only',
    BACKEND_IMAGE: deploymentImagesFor(faultName).backend,
    FRONTEND_IMAGE: deploymentImagesFor(faultName).frontend,
    SOLANA_HTTP_RPC_URL: 'https://rpc.invalid',
    SOLANA_WS_RPC_URL: 'wss://rpc.invalid',
    LISTENER_ENABLED: 'false',
    FRONTEND_PORT: '0',
  });
}
```

   New:

```js
function faultCleanupEnvironment(faultName) {
  return Object.freeze({
    ...process.env,
    COMPOSE_PROJECT_NAME: faultName,
    SOL_HOST_DIR: hostDirectoryFor(faultName),
    POSTGRES_DB: 'smoke',
    BACKEND_IMAGE: deploymentImagesFor(faultName).backend,
    FRONTEND_IMAGE: deploymentImagesFor(faultName).frontend,
    FRONT_PORT: '0',
  });
}
```

13. Old:

```js
  return ['compose', ...projectArgs, '-f', composeFile, '-f', smokeComposeFile, ...args];
```

   New:

```js
  return ['compose', ...projectArgs, '-f', composeFile, ...args];
```

14. Old:

```js
  { cleanup = false, reflectFailureOutput = true, commandEnvironment = environment } = {},
) {
```

   New:

```js
  { cleanup = false, reflectFailureOutput = true, commandEnvironment = environment, input } = {},
) {
```

15. Old:

```js
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeSignalRuntime?.track(child, !cleanup);
```

   New:

```js
      shell: false,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (input !== undefined) child.stdin.end(input);
    activeSignalRuntime?.track(child, !cleanup);
```

16. Old:

```js
    && value !== composeFile
    && value !== smokeComposeFile);
```

   New:

```js
    && value !== composeFile);
```

17. Old:

```js
function redact(value) {
  return value.replaceAll(postgresPassword, '[REDACTED]')
    .replaceAll(encodeURIComponent(postgresPassword), '[REDACTED]');
}
```

   New:

```js
function redact(value) {
  let redacted = value;
  for (const secret of smokeSecrets) {
    redacted = redacted.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]');
  }
  return redacted;
}
```

18. Old:

```js
    ['port', 'frontend', '8080'],
```

   New:

```js
    ['port', 'front', '8080'],
```

19. Old:

```js
async function assertNonRoot(service) {
  const { stdout } = await compose(['exec', '-T', service, 'id', '-u']);
  const uid = stdout.trim();
  assertMatch(uid, /^[1-9][0-9]*$/u, `${service} runs as root or returned an invalid UID.`);
}
```

   New:

```js
async function writeSmokeHost() {
  const { stdout: frontHash } = await runDocker([
    'run', '--rm', '-i', '--entrypoint', 'caddy', deploymentImages.frontend, 'hash-password',
  ], { input: `${frontPassword}\n`, reflectFailureOutput: false });
  if (!/^\$2a\$\d{2}\$[./A-Za-z0-9]{53}\n$/u.test(frontHash)) throw new Error('Caddy did not return a bcrypt hash.');
  const secrets = join(hostDirectory, 'secrets');
  const files = [
    ['secrets/db/postgres-admin-password', `${postgresPassword}\n`],
    ...Object.entries(loginPasswords).map(([login, password]) => [`secrets/db/logins/pg-${login}-password`, `${password}\n`]),
    ['secrets/back/helius-listener-http-url', 'https://rpc.invalid\n'],
    ['secrets/back/helius-listener-ws-url', 'wss://rpc.invalid\n'],
    ['secrets/back/operator-api-token', `${operatorApiToken}\n`],
    ['secrets/back/wallet-keypair.json', `${throwawayKeypair}\n`],
    ['secrets/front/front-basic-auth-hash', frontHash],
  ];
  for (const directory of ['secrets/db/logins', 'secrets/back', 'secrets/front', 'config']) {
    await mkdir(join(hostDirectory, directory), { recursive: true, mode: 0o700 });
  }
  for (const [path, content] of files) await writeFile(join(hostDirectory, path), content, { mode: 0o600 });
  await chmod(hostDirectory, 0o700);
  await chmod(secrets, 0o700);
  for (const name of [
    'listener', 'live', 'live-recovery', 'operations', 'operator-api', 'retention', 'worker-sim',
    'readiness', 'provider-evidence', 'preflight-bundle',
  ]) {
    const template = await readFile(resolve(root, `deploy/config/${name}.env.example`), 'utf8');
    // The smoke never contacts an RPC: its listener only serves the API.
    const override = name === 'listener' ? 'LISTENER_ENABLED=false\n' : '';
    await writeFile(join(hostDirectory, 'config', `${name}.env`), `${template}${override}`, { mode: 0o644 });
  }
  await chmod(join(hostDirectory, 'config'), 0o755);
}

async function assertProcessUsers() {
  const { stdout } = await compose([
    'exec', '-T', 'back', 'sh', '-c',
    'for program in listener opapi retention; do pid="$(sol ctl pid "$program")"; printf "%s %s\\n" "$program" "$(stat -c %u "/proc/$pid")"; done',
  ]);
  assertEqual(stdout, 'listener 10001\nopapi 10005\nretention 10006\n', 'Back programs do not run as their own users.');
}

async function assertFrontNonRoot() {
  const { stdout } = await compose(['exec', '-T', 'front', 'stat', '-c', '%u', '/proc/1']);
  assertEqual(stdout.trim(), '10100', 'Caddy does not run as the unprivileged caddy user.');
}

async function assertSecretIsolation() {
  const secretPaths = ['/run/sol/h2b/wallet-keypair.json', '/run/sol/opapi/operator-api-token'];
  const { stdout } = await compose(['exec', '-T', 'back', 'stat', '-c', '%U %a', ...secretPaths]);
  assertEqual(stdout, 'h2b 400\nopapi 400\n', 'Secrets are not owner-only in the tmpfs.');
  for (const path of secretPaths) {
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
}

async function assertFrontAuthentication() {
  const anonymous = await fetchBounded('/index.html', { authenticated: false });
  assertEqual(anonymous.status, 401, 'The front served the console without credentials.');
  const write = await fetchBounded('/api/v1/health', { method: 'POST' });
  assertEqual(write.status, 405, 'The front relayed a write method.');
  const operator = await fetchBounded('/operator/v1/live/overview', { authenticated: false });
  assertEqual(operator.status, 401, 'The operator API answered without its bearer token.');
  const authorized = await fetchBounded('/operator/v1/live/overview', {
    authenticated: false, headers: { authorization: `Bearer ${operatorApiToken}` },
  });
  assertEqual(authorized.status, 200, 'The operator API refused its bearer token through the front.');
}

async function assertLogins() {
  const sql = [
    "SELECT grantee.rolname || '|' || grantee.rolinherit || '|' || coalesce(string_agg(",
    "granted.rolname || ':' || membership.admin_option || ':' || membership.inherit_option || ':'",
    "|| membership.set_option, ','), '') FROM pg_roles grantee",
    'LEFT JOIN pg_auth_members membership ON membership.member = grantee.oid',
    'LEFT JOIN pg_roles granted ON granted.oid = membership.roleid',
    "WHERE grantee.rolcanlogin AND grantee.rolname <> 'sol_owner'",
    'GROUP BY grantee.rolname, grantee.rolinherit ORDER BY grantee.rolname',
  ].join(' ');
  const { stdout } = await runDocker(composeCommand([
    'exec', '-T', 'postgres', 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'sol_owner', '-d', 'smoke', '-c', sql,
  ]));
  const expected = Object.keys(loginGroups).sort()
    .map((login) => `${login}|false|${loginGroups[login]}:false:false:true`).join('\n');
  assertEqual(stdout.trim(), expected, 'Logins are not NOINHERIT members of exactly their group role.');
  for (const [login, group] of Object.entries(loginGroups)) {
    const { stdout: role } = await runDocker(composeCommand([
      'exec', '-T', '-e', `PGPASSWORD=${loginPasswords[login]}`, '-e', `PGOPTIONS=-c role=${group}`,
      'postgres', 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', login, '-d', 'smoke',
      '-c', 'SELECT current_user',
    ]), { reflectFailureOutput: false });
    assertEqual(role.trim(), group, `Login ${login} cannot take its group role.`);
  }
}

async function assertOperations() {
  const { stdout } = await compose(['exec', '-T', 'back', 'sh', '-c', 'sol ops status 2>&1; echo "exit=$?"']);
  assertMatch(
    stdout,
    /^\{"service":"sol-token-executor-operations","event":"executor\.operations_failed","errorCode":"EXECUTION_OPERATIONS_FAILED"\}\nexit=[1-9][0-9]*\n$/u,
    'sol ops status did not give its closed answer on a database without wallet generation.',
  );
  const supervised = await compose(['exec', '-T', 'back', 'sh', '-c', 'sol ctl status h2b; echo "exit=$?"']);
  assertMatch(supervised.stdout, /^h2b: ERROR \(no such process\)\nexit=4\n$/u, 'H2b is supervised in observe mode.');
  const { stdout: counts } = await runDocker(composeCommand([
    'exec', '-T', 'postgres', 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'sol_owner', '-d', 'smoke', '-c',
    "SELECT (SELECT count(*) FROM execution_entry_envelopes) || '|' || (SELECT count(*) FROM execution_signed_transactions)",
  ]));
  assertEqual(counts.trim(), '0|0', 'The observe stack created an envelope or a signed transaction.');
}
```

20. Old:

```js
    'exec', '-T', 'postgres', 'psql',
    '-X', '-A', '-t', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-U', 'smoke', '-d', 'smoke', '-c', sql,
```

   New:

```js
    'exec', '-T', 'postgres', 'psql',
    '-X', '-A', '-t', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-U', 'sol_owner', '-d', 'smoke', '-c', sql,
```

21. Old:

```js
  const response = await requestWithDeadline(`${publicBaseUrl()}/api/v1/events`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
```

   New:

```js
  const response = await requestWithDeadline(`${publicBaseUrl()}/api/v1/events`, {
    headers: { accept: 'text/event-stream', authorization: basicAuthorization },
    signal: controller.signal,
  });
```

22. Old:

```js
      compose(['stop', '--timeout', '40', 'app']),
```

   New:

```js
      compose(['exec', '-T', 'back', 'sol', 'ctl', 'stop', 'listener']),
```

23. Old:

```js
  const { stdout, stderr } = await compose([
    'exec', '-T', 'retention', 'node', 'dist/scripts/purge-retained-data.js', '--once',
  ], { reflectFailureOutput: false });
```

   New:

```js
  const { stdout, stderr } = await compose([
    'exec', '-T', 'back', 'sol-run', 'retention', 'node', '/app/dist/scripts/purge-retained-data.js', '--once',
  ], { reflectFailureOutput: false });
```

24. Old:

```js
async function fetchBounded(path, options = {}) {
  const response = await requestWithDeadline(`${publicBaseUrl()}${path}`, options);
```

   New:

```js
async function fetchBounded(path, { authenticated = true, headers = {}, ...options } = {}) {
  const response = await requestWithDeadline(`${publicBaseUrl()}${path}`, {
    ...options,
    headers: authenticated ? { authorization: basicAuthorization, ...headers } : headers,
  });
```

- [ ] **Step 3b: Update the smoke diagnostics harness**

`tests/deployment-smoke-diagnostics.test.ts` evaluates slices of the smoke inside a `vm` context. That context does not see the module constants added above, and its deployment sequencing test stubs the old phases only. Without this step the 12 diagnostics tests fail: CI caught it on PR #263. Apply both edits.

Old:

```ts
    deadlineAt: Date.now() + 60_000, postgresPassword: 'generated-test-password',
```

New:

```ts
    deadlineAt: Date.now() + 60_000, postgresPassword: 'generated-test-password',
    smokeSecrets: ['generated-test-password'], hostDirectory: '/nonexistent/smoke-host',
    rm: async () => undefined,
```

Old:

```ts
    discoverFrontendBaseUrl = async () => 'http://127.0.0.1:43210';
    assertNonRoot = async () => undefined;
```

New:

```ts
    discoverFrontendBaseUrl = async () => 'http://127.0.0.1:43210';
    writeSmokeHost = async () => undefined;
    assertProcessUsers = async () => undefined;
    assertFrontNonRoot = async () => undefined;
    assertSecretIsolation = async () => undefined;
    assertFrontAuthentication = async () => undefined;
```

- [ ] **Step 4: Check syntax and the static tests**

```bash
node --check scripts/deployment-smoke.mjs
npx tsx --test tests/deployment-artifacts.test.ts tests/deployment-smoke-diagnostics.test.ts
npm run lint:backend
```

Expected: PASS.

- [ ] **Step 5: Run the smoke and the signal probe locally (Docker required, about 2 minutes each)**

```bash
npm run deployment:smoke
npm run deployment:smoke:signal
```

Expected: `Deployment smoke passed.` then `Deployment signal fault probe passed.` A failure prints one redacted line such as `Deployment smoke failed: Error(validation){phase=LOGINS}.`. To debug a phase, rerun its commands by hand on a stack started with the same variables; never print a secret.

- [ ] **Step 6: Commit**

```bash
git add scripts/deployment-smoke.mjs tests/deployment-artifacts.test.ts tests/deployment-smoke-diagnostics.test.ts
git commit -m "test(deploy): smoke the four-service stack with throwaway secrets

The smoke writes a throwaway host directory and starts the stack in observe mode without RPC.
It proves program users, owner-only tmpfs secrets, the authenticated read-only front, the
bearer-protected operator API and the nine logins with their group roles. It also checks the
closed operations answer, no H2b in observe, SSE shutdown through supervisorctl and the
retention one-shot; cleanup also removes the host directory.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: Host tooling: secrets layout, backups, takeover SQL

**Files:**
- Create: `deploy/host/init-secrets.sh`, `deploy/host/backup.sh`, `deploy/host/sol-backup.service`, `deploy/host/sol-backup.timer`, `deploy/host/com.sol-token-listener.backup.plist`
- Create: `deploy/sql/table-row-counts.sql`, `deploy/sql/takeover-precondition.sql`
- Test: `tests/deploy-host-tooling.test.ts`

Validated on 2026-10-09 against a provisioned database: `takeover-precondition.sql` printed `0|0|0|0`, and `table-row-counts.sql` listed 74 tables. A full restore rehearsal also passed on a fresh database, in this order: `sol-admin group-roles`, then `pg_restore --exit-on-error --single-transaction`, then the same 74 counts, then `docker compose run --rm migrate` replayed cleanly.

- [ ] **Step 1: Write the failing test**

Create `tests/deploy-host-tooling.test.ts`:

```ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const repository = fileURLToPath(root).replace(/\/$/u, '');
const FAKE_HASH = `$2a$14$${'a'.repeat(53)}`;

async function artifact(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

async function fakeDocker(directory: string, body: string): Promise<string> {
  const bin = join(directory, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'docker'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

void test('host scripts are bash and parse', async () => {
  for (const name of ['init-secrets.sh', 'backup.sh']) {
    const source = await artifact(`deploy/host/${name}`);
    assert.ok(source.startsWith('#!/usr/bin/env bash\n'), name);
    assert.match(source, /^set -euo pipefail$/mu, name);
    const syntax = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${name}: ${syntax.stderr}`);
  }
});

void test('init-secrets creates the host layout once, owner-only, and prints no database secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-init-'));
  try {
    const bin = await fakeDocker(directory, `cat > /dev/null; printf '%s\\n' '${FAKE_HASH}'`);
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
    assert.equal((await readdir(join(host, 'secrets/db/logins'))).length, 9);
    assert.equal((await stat(join(host, 'secrets'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(host, 'secrets/db/logins/pg-sol_live-password'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(host, 'config'))).mode & 0o777, 0o755);
    assert.equal((await stat(join(host, 'config/live.env'))).mode & 0o777, 0o644);
    assert.match(output, /to provide: .*\/secrets\/back\/wallet-keypair\.json/u);

    const second = run();
    assert.equal(second.status, 0, String(second.stderr));
    assert.equal((await readFile(join(host, 'secrets/db/postgres-admin-password'), 'utf8')).trim(), admin);
    assert.doesNotMatch(String(second.stdout), /front password|created/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('init-secrets hashes the front password with the Caddy image pinned in the Dockerfile', async () => {
  const [script, dockerfile] = await Promise.all([artifact('deploy/host/init-secrets.sh'), artifact('Dockerfile')]);
  const image = /^caddy_image='([^']+)'$/mu.exec(script)?.[1];
  assert.ok(image !== undefined, 'missing caddy_image');
  assert.ok(dockerfile.includes(`FROM ${image} AS frontend`));
});

void test('backup dumps through the postgres container, writes a checksum and keeps 14 days', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-backup-'));
  try {
    const bin = await fakeDocker(directory, 'printf "%s" "$*" > "$SOL_HOST_DIR/docker-args"; printf "PGDMP-fake"');
    const host = join(directory, 'host');
    await mkdir(join(host, 'backups'), { recursive: true });
    const old = join(host, 'backups', 'sol-20260101T000000Z.dump');
    await writeFile(old, 'old');
    await utimes(old, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    const result = spawnSync('bash', [join(repository, 'deploy/host/backup.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host, SOL_REPOSITORY: repository,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const [dump, checksum, ...rest] = (await readdir(join(host, 'backups'))).sort();
    assert.deepEqual(rest, []);
    assert.match(dump ?? '', /^sol-\d{8}T\d{6}Z\.dump$/u);
    assert.equal(checksum, `${dump ?? ''}.sha256`);
    assert.equal(await readFile(join(host, 'backups', dump ?? ''), 'utf8'), 'PGDMP-fake');
    assert.equal(
      await readFile(join(host, 'docker-args'), 'utf8'),
      `compose --env-file ${host}/compose.env -f ${repository}/deploy/compose.yaml exec -T postgres sh -c `
        + 'exec pg_dump -Fc -U sol_owner -d "$POSTGRES_DB"',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('the takeover SQL checks the stop precondition and counts rows in a stable order', async () => {
  const [precondition, counts] = await Promise.all([
    artifact('deploy/sql/takeover-precondition.sql'),
    artifact('deploy/sql/table-row-counts.sql'),
  ]);
  for (const fragment of [
    "execution_entry_envelopes WHERE state = 'ACTIVE'",
    "execution_activation_armaments WHERE state IN ('ARMED', 'LOCKED')",
    "execution_live_positions WHERE state IN ('OPEN', 'EXIT_PENDING', 'UNKNOWN')",
    "WHERE state NOT IN ('RECONCILED', 'REVOKED_NO_SEND')",
  ]) {
    assert.ok(precondition.includes(fragment), fragment);
  }
  assert.match(counts, /table_schema = 'public' AND table_type = 'BASE TABLE'/u);
  assert.match(counts, /ORDER BY table_name COLLATE "C";/u);
});

void test('the backup jobs run backup.sh daily on the server and on the Mac', async () => {
  const [service, timer, plist] = await Promise.all([
    artifact('deploy/host/sol-backup.service'),
    artifact('deploy/host/sol-backup.timer'),
    artifact('deploy/host/com.sol-token-listener.backup.plist'),
  ]);
  assert.match(service, /^Type=oneshot$/mu);
  assert.match(service, /^ExecStart=\/usr\/bin\/env bash \/srv\/sol-token-listener\/repository\/deploy\/host\/backup\.sh$/mu);
  assert.match(timer, /^OnCalendar=\*-\*-\* 04:30:00$/mu);
  assert.match(timer, /^Persistent=true$/mu);
  assert.ok(plist.includes('<string>__SOL_REPOSITORY__/deploy/host/backup.sh</string>'));
  assert.ok(plist.includes('<key>StartCalendarInterval</key>'));
  const lint = spawnSync('plutil', ['-lint', '-'], { input: plist, encoding: 'utf8' });
  if (lint.error === undefined) assert.equal(lint.status, 0, lint.stdout);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test tests/deploy-host-tooling.test.ts`
Expected: FAIL, `ENOENT` on `deploy/host/init-secrets.sh`.

- [ ] **Step 3: Write the host scripts and jobs**

Create `deploy/host/init-secrets.sh`:

```bash
#!/usr/bin/env bash
# Creates the host directory of the stack (docs/operations/deployment.md, « Dossier hôte »):
# secrets/ (0700) with generated database passwords and operator API token, config/ (0755) with
# the role templates, backups/ (0700). It never overwrites a file and prints no secret, except
# the generated front password, shown once so the operator can store it.
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo 'usage: deploy/host/init-secrets.sh <host directory>' >&2
  exit 64
fi
host="$1"
repository="$(cd "$(dirname "$0")/../.." && pwd)"
caddy_image='caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
umask 077
mkdir -p "$host/secrets/db/logins" "$host/secrets/back" "$host/secrets/front" "$host/backups" "$host/config"
chmod 0700 "$host" "$host/secrets" "$host/backups"
chmod 0755 "$host/config"

generate() {
  # 32 random bytes in hex, only when the file does not exist yet.
  if [ ! -e "$1" ]; then
    openssl rand -hex 32 > "$1"
    chmod 0600 "$1"
    echo "created $1"
  fi
}
generate "$host/secrets/db/postgres-admin-password"
for login in sol_listener sol_live sol_recovery sol_autoarm sol_reader sol_retention sol_worker sol_ops sol_readiness; do
  generate "$host/secrets/db/logins/pg-$login-password"
done
generate "$host/secrets/back/operator-api-token"

hash_file="$host/secrets/front/front-basic-auth-hash"
if [ ! -e "$hash_file" ]; then
  password="$(openssl rand -base64 24 | tr -d '\n')"
  printf '%s\n' "$password" | docker run --rm -i --entrypoint caddy "$caddy_image" hash-password > "$hash_file"
  chmod 0600 "$hash_file"
  printf 'front password, shown once (store it in your password manager): %s\n' "$password"
  unset password
fi

for template in "$repository"/deploy/config/*.env.example; do
  target="$host/config/$(basename "$template" .example)"
  if [ ! -e "$target" ]; then
    cp "$template" "$target"
    chmod 0644 "$target"
    echo "created $target (example values: replace them, see the runbook)"
  fi
done

for file in helius-listener-http-url helius-listener-ws-url helius-executor-http-url helius-admin-api-key evidence-private-key wallet-keypair.json; do
  if [ ! -e "$host/secrets/back/$file" ]; then echo "to provide: $host/secrets/back/$file"; fi
done
```

Create `deploy/host/backup.sh`:

```bash
#!/usr/bin/env bash
# Logical backup of the stack database (spec 9.4): pg_dump -Fc through the postgres container,
# SHA-256 next to it, 14-day rotation. The secrets directory is never part of a backup; copying
# backups off the machine stays the operator's job.
set -euo pipefail
: "${SOL_HOST_DIR:?SOL_HOST_DIR is required}"
: "${SOL_REPOSITORY:?SOL_REPOSITORY is required}"
backups="$SOL_HOST_DIR/backups"
umask 077
mkdir -p "$backups"
name="sol-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose --env-file "$SOL_HOST_DIR/compose.env" -f "$SOL_REPOSITORY/deploy/compose.yaml" \
  exec -T postgres sh -c 'exec pg_dump -Fc -U sol_owner -d "$POSTGRES_DB"' > "$backups/$name.partial"
mv "$backups/$name.partial" "$backups/$name"
if command -v sha256sum > /dev/null; then
  (cd "$backups" && sha256sum "$name" > "$name.sha256")
else
  (cd "$backups" && shasum -a 256 "$name" > "$name.sha256")
fi
find "$backups" -maxdepth 1 -type f -name 'sol-*.dump*' -mtime +14 -delete
echo "backup $backups/$name"
```

Create `deploy/host/sol-backup.service`:

```ini
# Server backup job (spec 9.4). Install: deploy/host/sol-backup.service and .timer into
# /etc/systemd/system, then `systemctl enable --now sol-backup.timer`.
[Unit]
Description=Backup of the sol-token-listener database (pg_dump -Fc)
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
Environment=SOL_HOST_DIR=/srv/sol-token-listener
Environment=SOL_REPOSITORY=/srv/sol-token-listener/repository
ExecStart=/usr/bin/env bash /srv/sol-token-listener/repository/deploy/host/backup.sh
```

Create `deploy/host/sol-backup.timer`:

```ini
[Unit]
Description=Daily backup of the sol-token-listener database

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

Create `deploy/host/com.sol-token-listener.backup.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Mac backup job (spec 9.4). Replace __SOL_REPOSITORY__ and __SOL_HOST_DIR__, copy to
     ~/Library/LaunchAgents/ and load it with launchctl (docs/operations/deployment.md). -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.sol-token-listener.backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>__SOL_REPOSITORY__/deploy/host/backup.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SOL_HOST_DIR</key>
    <string>__SOL_HOST_DIR__</string>
    <key>SOL_REPOSITORY</key>
    <string>__SOL_REPOSITORY__</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>__SOL_HOST_DIR__/backups/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>__SOL_HOST_DIR__/backups/launchd.log</string>
</dict>
</plist>
```

- [ ] **Step 4: Write the takeover SQL**

Create `deploy/sql/table-row-counts.sql`:

```sql
-- Exact row count of every table of schema public, one `table|rows` line each, compared before
-- and after a restore (docs/operations/deployment.md, « Reprise de la base actuelle »).
SELECT table_name || '|' || (xpath('/row/c/text()', query_to_xml(
    format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name COLLATE "C";
```

Create `deploy/sql/takeover-precondition.sql`:

```sql
-- Takeover precondition (spec 9.2, step 1): trading fully stopped. Expected line: 0|0|0|0
-- (active envelopes | armed or locked armaments | open positions | non-terminal signed transactions).
SELECT (SELECT count(*) FROM execution_entry_envelopes WHERE state = 'ACTIVE')
  || '|' || (SELECT count(*) FROM execution_activation_armaments WHERE state IN ('ARMED', 'LOCKED'))
  || '|' || (SELECT count(*) FROM execution_live_positions WHERE state IN ('OPEN', 'EXIT_PENDING', 'UNKNOWN'))
  || '|' || (SELECT count(*) FROM execution_signed_transactions
             WHERE state NOT IN ('RECONCILED', 'REVOKED_NO_SEND'));
```

`COLLATE "C"` matters. The current database (Debian image, glibc `en_US.utf8`) sorts text as `a,a_,B,_z`, while the stack image (Alpine, as in CI) sorts as `B,_z,a,a_`. Without a fixed collation, the two count files would not compare line by line.

- [ ] **Step 5: Run the test**

```bash
chmod 0755 deploy/host/init-secrets.sh deploy/host/backup.sh
npx tsx --test tests/deploy-host-tooling.test.ts
```

Expected: PASS (6 tests). The tests fake `docker` and use the real `openssl`.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint:backend
git add deploy/host deploy/sql tests/deploy-host-tooling.test.ts
git update-index --chmod=+x deploy/host/init-secrets.sh deploy/host/backup.sh
git commit -m "feat(deploy): host secrets layout, daily backups and takeover checks

init-secrets.sh creates the 0700 secrets tree with generated database passwords, operator token
and front password hash, never overwriting a file. backup.sh dumps through the postgres container
with a checksum and 14-day rotation, scheduled by systemd on the server and launchd on the Mac.
The takeover SQL checks that trading is stopped and counts rows in a collation-stable order.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 14: Runbook and documentation

**Files:**
- Rewrite: `docs/operations/deployment.md`
- Modify: `README.md` (section « Déploiement de référence »), `docs/system-overview.html` (deployment card), `docs/operations/block-hydration-canary.md`, `docs/operations/executor-live-canary.md` (one note each)
- Test: `tests/deployment-artifacts.test.ts`

Validated on 2026-10-09:
- the 21 bash blocks of the runbook pass `bash -n`;
- `npm run docs:check` passes;
- with `dist/` built, every suite that reads these documents passes: 416 tests, 0 failures, 174 skipped without a test database.

- [ ] **Step 1: Update the runbook tests first**

In `tests/deployment-artifacts.test.ts`, replace the whole test `'deployment runbook documents the safe production lifecycle and safety boundary'` with:

```ts
void test('deployment runbook documents the full-bot lifecycle, takeover and security boundary', async () => {
  const runbook = await readArtifact('docs/operations/deployment.md');
  let previous = -1;
  for (const heading of [
    '## Topologie', '## Prérequis', '## Dossier hôte, secrets et configuration', '## Images',
    '## Démarrage et arrêt', '## Commandes sol', '## Trading', "## Qualification d'une enveloppe (gate 10)",
    '## Santé et journaux', '## Sauvegardes', '## Reprise de la base actuelle', '## Retour arrière',
    '## Bascule vers le serveur', '## Rotation des secrets', '## Frontière de sécurité',
  ]) {
    const index = runbook.indexOf(`\n${heading}\n`);
    assert.ok(index > previous, `missing or misplaced runbook section: ${heading}`);
    previous = index;
  }
  for (const command of [
    'deploy/host/init-secrets.sh "$SOL_HOST_DIR"',
    'docker compose --env-file "$SOL_ENV" -f deploy/compose.yaml "$@"',
    'docker compose --env-file "$SOL_ENV" -f deploy/compose.yaml -f deploy/compose.server.yaml "$@"',
    'sol_compose up --detach --wait --wait-timeout 180',
    'sol_compose stop --timeout 60',
    'sol_compose exec -it back sol trading start',
    'sol_compose exec back sol trading stop',
    'sol_compose exec back sol qualify start',
    'sol_compose exec back sol qualify stop',
    'sol_compose run --rm migrate sol-admin report',
    'sol_compose run --rm migrate sol-admin group-roles',
    'pg_restore --exit-on-error --single-transaction -U sol_owner',
    'deploy/sql/takeover-precondition.sql',
    'deploy/sql/table-row-counts.sql',
    'diff "$takeover/source.counts" "$takeover/target.counts"',
    'docker stop sol-token-listener-live-pg',
    'sudo systemctl enable --now sol-backup.timer',
    'launchctl bootstrap "gui/$(id -u)" "$plist"',
  ]) {
    assert.ok(runbook.includes(command), `missing runbook command: ${command}`);
  }
  const secrets = runbook.slice(runbook.indexOf('## Dossier hôte'), runbook.indexOf('## Images'));
  assert.doesNotMatch(secrets, /\b(?:cat|echo)\s+"?\$(?:back|SOL_HOST_DIR)/u, 'secrets are copied, never printed');
  assert.match(runbook, /pg_advisory_lock/u);
  assert.match(runbook, /Les migrations\s+restent forward-only/u);
  assert.match(runbook, /`down --volumes` est destructif/u);
  assert.match(runbook, /ENTRY_STOP/u);
  assert.match(runbook, /0\|0\|0\|0/u);
  assert.match(runbook, /réplica unique/u);
  assert.match(runbook, /sauvegarde externe/u);
});
```

Then, in `'operator documentation activates the safe websocket failover contract'`, apply these three edits:

1. Old:

```ts
  assert.match(readme, /TLS externe/i);
```

   New:

```ts
  assert.match(readme, /HTTPS/u);
```

2. Old:

```ts
  assert.match(overview, /TLS externe/i);
```

   New:

```ts
  assert.match(overview, /HTTPS/u);
```

3. Old:

```ts
  assert.match(deployment, /docker compose --env-file deploy\/\.env -f deploy\/compose\.yaml up -d migrate/);
  assert.match(deployment, /DOTENV_CONFIG_PATH=deploy\/\.env npm run rpc:check/);
  assert.match(deployment, /docker compose --env-file deploy\/\.env -f deploy\/compose\.yaml up -d --wait --wait-timeout 60 app frontend retention/);
  assert.match(deployment, /docker compose --env-file deploy\/\.env -f deploy\/compose\.yaml exec -T app[\s\S]*deployment-healthcheck\.js --require-ok/);
  assert.match(deployment, /références immuables précédentes/i);
  assert.match(deployment, /migrations[^.]*forward-only/i);
  assert.ok(
    deployment.indexOf('up -d --wait --wait-timeout 60 app frontend retention')
      < deployment.indexOf('deployment-healthcheck.js --require-ok'),
    'Compose readiness must be awaited before the strict healthcheck',
  );
```

   New:

```ts
  assert.match(deployment, /sol_compose up --detach --wait --wait-timeout 180/u);
  assert.match(deployment, /Les migrations\s+restent forward-only/u);
  assert.match(deployment, /SOL_HEALTH_REQUIRE_OK=false/u);
```

The tests `'every deployment runbook shell block is syntactically valid Bash'` and `'deployment runbook verifies a real SSE heartbeat with a bounded, cleanup-safe curl probe'` stay unchanged: the new runbook keeps a valid SSE probe.

- [ ] **Step 2: Run the file and watch the runbook tests fail**

Run: `npx tsx --test tests/deployment-artifacts.test.ts`
Expected: FAIL in the two tests above.

- [ ] **Step 3: Rewrite the runbook**

Replace the whole content of `docs/operations/deployment.md` with:

````markdown
# Déploiement du bot complet (Docker Compose)

Ce runbook exploite la stack décrite par le spec
`docs/superpowers/specs/2026-10-09-full-bot-compose-design.md` : trois conteneurs
(`postgres`, `back`, `front`) et une tâche `migrate`. Il remplace les processus lancés à la main
sur l'hôte. Les secrets sont des fichiers hors du dépôt, jamais affichés : ne lancez aucun `cat`,
`echo` ou `env` sur eux.

## Topologie

| Conteneur | Contenu | Réseaux | Ports publiés |
|---|---|---|---|
| `postgres` | PostgreSQL 16.14, volume `postgres-data` | `internal` | aucun |
| `migrate` | tâche ponctuelle : migrations, droits, neuf logins | `internal` | aucun |
| `back` | `supervisord` et un utilisateur Unix par processus | `internal`, `egress`, `edge` | aucun |
| `front` | Caddy : console, relais `/api/v1` et `/operator/v1/`, mot de passe | `edge` | Mac : `127.0.0.1:8080` ; serveur : 80 et 443 |

Programmes du back : `listener`, `opapi` et `retention` en mode `observe` ; s'y ajoutent `h2a`,
`h2b` (relancé à la demande) et `autoarm` en mode `live` ; `worker` ne tourne que pendant
`sol qualify`. `autoarm` n'arme rien tant que l'état de contrôle n'est pas `RUNNING`, ce que seul
`sol trading start` rétablit après un redémarrage.

## Prérequis

- Docker avec le plugin Compose 2.24.4 ou plus récent (Docker Desktop sur le Mac).
- `openssl`, et un checkout du dépôt au commit livré.
- Pour le mode `live` : les fichiers actuels de `~/.sol-token-listener/lot5/` (environnements,
  clés) et la base actuelle (conteneur `sol-token-listener-live-pg`, port 5433).

Préparer le shell, sur le Mac :

```bash
export SOL_HOST_DIR="$HOME/.sol-token-listener/docker"
export SOL_ENV="$SOL_HOST_DIR/compose.env"
sol_compose() {
  docker compose --env-file "$SOL_ENV" -f deploy/compose.yaml "$@"
}
```

Sur le serveur, le fichier `deploy/compose.server.yaml` publie 80 et 443 et active HTTPS :

```bash
export SOL_HOST_DIR=/srv/sol-token-listener
export SOL_ENV="$SOL_HOST_DIR/compose.env"
sol_compose() {
  docker compose --env-file "$SOL_ENV" -f deploy/compose.yaml -f deploy/compose.server.yaml "$@"
}
```

## Dossier hôte, secrets et configuration

Créer l'arborescence, les mots de passe PostgreSQL, le jeton de l'API opérateur et l'empreinte du
mot de passe du front. Le script ne remplace jamais un fichier existant. Il n'affiche qu'un seul
secret, le mot de passe du front, une seule fois : le ranger aussitôt dans un gestionnaire de mots
de passe.

```bash
deploy/host/init-secrets.sh "$SOL_HOST_DIR"
cp deploy/env.example "$SOL_ENV"
chmod 0600 "$SOL_ENV"
```

Dans `compose.env`, renseigner `SOL_HOST_DIR`, les images et `SOL_STACK_MODE`, puis `SITE_ADDRESS`
sur le serveur. Ce fichier ne contient aucun secret.

Les six secrets du back proviennent des fichiers actuels. Les commandes suivantes les recopient
sans jamais les afficher :

```bash
lot5="$HOME/.sol-token-listener/lot5/env"
back="$SOL_HOST_DIR/secrets/back"
value() { sed -n "s/^$1=//p" "$2"; }
value SOLANA_HTTP_RPC_URL "$lot5/listener.env" > "$back/helius-listener-http-url"
value SOLANA_WS_RPC_URL "$lot5/listener.env" > "$back/helius-listener-ws-url"
value SOLANA_HTTP_RPC_URL "$lot5/live.env" > "$back/helius-executor-http-url"
cp "$(value HELIUS_API_KEY_PATH "$lot5/provider-evidence.env")" "$back/helius-admin-api-key"
cp "$(value EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH "$lot5/provider-evidence.env")" "$back/evidence-private-key"
cp "$(value EXECUTOR_KEYPAIR_PATH "$lot5/live.env")" "$back/wallet-keypair.json"
chmod 0600 "$back"/*
```

Si une valeur est entourée de guillemets dans le fichier source, retirer les guillemets du
secret : `sol-run` refuse une URL qui n'en est pas une, sans afficher sa valeur.

La configuration non secrète de chaque rôle reprend les fichiers actuels, privés de toute
variable que `sol-run` injecte depuis les secrets :

```bash
lot5="$HOME/.sol-token-listener/lot5/env"
config="$SOL_HOST_DIR/config"
strip() {
  grep -v -E '^(DATABASE_URL|OPERATOR_API_DATABASE_URL|SOLANA_HTTP_RPC_URL|SOLANA_WS_RPC_URL|EXECUTOR_KEYPAIR_PATH|HELIUS_API_KEY_PATH|EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH|OPERATOR_API_TOKEN)=' "$1"
}
for name in listener live live-recovery operations operator-api readiness worker-sim provider-evidence preflight-bundle; do
  strip "$lot5/$name.env" > "$config/$name.env"
done
sed -i.bak "s#$HOME/.sol-token-listener/lot5/evidence#/var/lib/sol/evidence#g" "$config"/*.env
rm -f "$config"/*.env.bak
chmod 0644 "$config"/*.env
```

Puis compléter à la main, en s'appuyant sur les modèles `deploy/config/*.env.example` :

- `listener.env` : `API_HOST=0.0.0.0` et `API_PORT=3000`, pour que le front joigne l'API.
- `operator-api.env` : `OPERATOR_API_HOST=0.0.0.0`, `OPERATOR_API_PORT=3100` et
  `OPERATOR_API_ALLOWED_ORIGIN=http://127.0.0.1:8080`, ou `https://<SITE_ADDRESS>` sur le serveur.
  Le front réécrit l'en-tête Host de `/operator/v1/` en `0.0.0.0:3100`, seule valeur que l'API
  accepte.
- `operations.env` : `EXECUTOR_PREFLIGHT_EVIDENCE_PATH=/var/lib/sol/evidence/bundle/qualification.json`
  et `EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH=/var/lib/sol/evidence/<catalogue>.json`.
- `preflight-bundle.env` : `EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY=/var/lib/sol/evidence/bundle`.
- vérifier qu'aucun autre chemin ne pointe hors de `/var/lib/sol/evidence` :
  `grep -h '_PATH=\|_DIRECTORY=' "$SOL_HOST_DIR"/config/*.env`.

`sol-run` refuse de démarrer un processus dont la configuration contient un mot de passe, une
clé, un jeton, une URL avec identifiants ou une variable injectée. Le message nomme le fichier et
la variable, jamais la valeur.

Les preuves et le catalogue de gates vivent dans le volume `evidence`, propriété de l'utilisateur
`ops`. Pour y copier un fichier existant, une fois la stack créée :

```bash
evidence_file=gate-catalog.json
sol_compose cp "$HOME/.sol-token-listener/lot5/evidence/$evidence_file" "back:/var/lib/sol/evidence/$evidence_file"
sol_compose exec back chown ops:ops "/var/lib/sol/evidence/$evidence_file"
```

## Images

Construire les images sur l'hôte depuis le commit livré, avec une étiquette qui porte son SHA.
Renseigner ensuite ces étiquettes dans `compose.env` (`BACKEND_IMAGE`, `FRONTEND_IMAGE`) :

```bash
revision="$(git rev-parse --short=12 HEAD)"
printf 'BACKEND_IMAGE=sol-token-listener/backend:%s\nFRONTEND_IMAGE=sol-token-listener/frontend:%s\n' "$revision" "$revision"
sol_compose build back front
```

Le smoke isolé valide la topologie sans RPC ni secret réel : `npm run deployment:smoke`.

## Démarrage et arrêt

La tâche `migrate` s'exécute avant le back, sous le verrou consultatif `pg_advisory_lock` des
migrations. Elle applique les migrations, rejoue `scripts/provision-executor-roles.sql` et crée
ou met à jour les neuf logins `NOINHERIT`, chacun membre d'un seul rôle de groupe. Les migrations
restent forward-only.

```bash
sol_compose up --detach --wait --wait-timeout 180
sol_compose exec back sol status
```

En mode `live`, le script d'entrée du back ramène un état de contrôle `RUNNING` à `ENTRY_STOP`
avant de lancer les programmes : aucun nouvel achat ne part après un redémarrage, alors que H2a,
H2b et `autoarm` assurent les sorties. Si le back redémarre en boucle en mode `live`, lire
`sol_compose logs back` : la lecture de l'état de contrôle a échoué, souvent à cause d'une
configuration `operations.env` invalide.

Arrêt normal, qui conserve la base :

```bash
sol_compose stop --timeout 60
```

`down --volumes` est destructif : il efface la base. Ne jamais l'utiliser pour un arrêt normal.

## Commandes sol

Toutes s'exécutent dans le back, en root, qui les lance sous l'utilisateur `ops` avec la
configuration et les secrets du rôle demandé. Ajouter `-it` aux commandes qui demandent une
confirmation au TTY.

| Commande | Effet |
|---|---|
| `sol status` | programmes, mode, état de H2b |
| `sol ops status`, `sol ops envelope show` | état de contrôle, enveloppes |
| `sol ops envelope create …`, `sol ops resume` | création d'enveloppe, reprise (TTY) |
| `sol ops kill-switch --mode=hard-stop --reason=OPERATOR_HARD_STOP` | arrêt d'urgence, sorties comprises |
| `sol readiness` | H2d |
| `sol evidence provider`, `sol evidence bundle` | H2e, H2f |
| `sol qualify start`, `sol qualify stop` | sonde du gate 10 |
| `sol trading start`, `sol trading stop` | autoriser ou suspendre les achats |
| `sol ctl …` | `supervisorctl` (status, restart d'un programme) |

Le rapport fast-path lit la base en administrateur : il passe par la tâche `migrate`, seule
détentrice du mot de passe administrateur.

```bash
sol_compose run --rm migrate sol-admin report
```

## Trading

```bash
sol_compose exec -it back sol trading start
sol_compose exec back sol trading stop
```

`sol trading start` exige une enveloppe `ACTIVE` et attend au plus 60 s que H2b tourne depuis
15 s. Il lance ensuite `resume`, à confirmer au TTY. `sol trading stop` pose `ENTRY_STOP` : plus
aucun achat, mais les positions ouvertes continuent d'être vendues à leur échéance. Après tout
redémarrage du back, relancer `sol trading start`.

## Qualification d'une enveloppe (gate 10)

La procédure reprend celle du runbook canary (lot 4a). `sol qualify start` suspend la
rétention, active la sonde du listener et démarre le worker de simulation. La sonde écrit au plus
un intent de 0,001 SOL toutes les 10 minutes, jamais armable.

```bash
sol_compose exec back sol qualify start
sol_compose exec back sol evidence provider
sol_compose exec back sol readiness
sol_compose exec back sh -c 'sol ops envelope prepare --valid-ms=21600000 > /var/lib/sol/evidence/preflight-draft.json'
sol_compose exec back rm -rf /var/lib/sol/evidence/bundle
sol_compose exec back sol evidence bundle
sol_compose exec -it back sol ops envelope create --per-buy-lamports=10000000 --max-buys=5 \
  --max-exposure-lamports=10000000 --max-loss-lamports=30000000 --holding-ms=300000
sol_compose exec back sol qualify stop
sol_compose exec -it back sol trading start
```

`envelope prepare` échoue tant qu'aucun artefact de simulation `SUCCESS` de moins de 24 h
n'existe : attendre la sonde suivante, puis recommencer. H2f exige un répertoire de sortie absent,
d'où le `rm -rf` du paquet précédent, déjà consommé.

## Santé et journaux

- `sol_compose ps` : `back` est sain quand chaque programme du mode tourne, que H2b tourne ou attend
  du travail, et que l'API du listener répond `OK`. Avec `SOL_HEALTH_REQUIRE_OK=false`, l'état
  `DEGRADED` est aussi accepté, utile si le projet RPC du listener est épuisé.
- `sol_compose logs -f back` : une ligne JSON par événement, avec le nom du service. Le pilote
  `json-file` garde 5 fichiers de 20 Mo par conteneur.

Vérifier le flux SSE à travers le front ; `curl` demande le mot de passe du front :

```bash
set -euo pipefail
sse_headers="$(mktemp)"
sse_body="$(mktemp)"
trap 'rm -f "$sse_headers" "$sse_body"' EXIT
sse_status=0
curl --fail-with-body --silent --show-error --no-buffer --max-time 20 --user operator \
  --dump-header "$sse_headers" --output "$sse_body" http://127.0.0.1:8080/api/v1/events || sse_status=$?
if [ "$sse_status" -ne 28 ]; then
  echo "Le flux SSE s'est terminé avec le code $sse_status." >&2
  exit 1
fi
grep -Eiq '^content-type:[[:space:]]*text/event-stream' "$sse_headers"
grep -Fq ': heartbeat' "$sse_body"
```

## Sauvegardes

`deploy/host/backup.sh` lance `pg_dump -Fc` dans le conteneur `postgres`, écrit l'empreinte
SHA-256 à côté et garde 14 jours dans `$SOL_HOST_DIR/backups`. Le dossier des secrets n'est
jamais sauvegardé. La copie hors machine (sauvegarde externe) reste à la charge de l'opérateur.

Sur le Mac, avec launchd :

```bash
plist="$HOME/Library/LaunchAgents/com.sol-token-listener.backup.plist"
sed -e "s#__SOL_REPOSITORY__#$PWD#g" -e "s#__SOL_HOST_DIR__#$SOL_HOST_DIR#g" \
  deploy/host/com.sol-token-listener.backup.plist > "$plist"
launchctl bootstrap "gui/$(id -u)" "$plist"
```

Sur le serveur, avec systemd, le dépôt étant cloné dans `/srv/sol-token-listener/repository` :

```bash
sudo cp deploy/host/sol-backup.service deploy/host/sol-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sol-backup.timer
```

La restauration doit être répétée régulièrement sur un projet jetable : les mêmes étapes que la
reprise ci-dessous, avec un autre `--project-name`.

## Reprise de la base actuelle

La base actuelle (conteneur `sol-token-listener-live-pg`, PostgreSQL 16.15 Debian) passe dans la
stack (PostgreSQL 16.14 Alpine). L'ordre de tri des textes change : glibc `en_US.utf8` d'un côté,
octets de l'autre, comme en CI. La restauration reconstruit les index ; seul l'ordre des
résultats textuels change.

1. Précondition, trading complètement arrêté. La ligne attendue est `0|0|0|0` : enveloppes
   actives, armements, positions ouvertes, transactions signées non terminales.

   ```bash
   docker exec -i sol-token-listener-live-pg psql -X -A -t -v ON_ERROR_STOP=1 -U sol_owner -d sol_token_listener \
     < deploy/sql/takeover-precondition.sql
   ```

2. Arrêter les processus de l'hôte, dans l'ordre : auto-arm, H2b, H2a, listener, API opérateur.

   ```bash
   for pattern in auto-arm-main.js executor-live/main.js executor-live-recovery/main.js dist/src/app.js operator-api/main.js; do
     pkill -TERM -f "$pattern" || true
     while pgrep -f "$pattern" > /dev/null; do sleep 1; done
   done
   ```

3. Exporter la base actuelle, avec son empreinte et le compte de lignes de chaque table.

   ```bash
   takeover="$SOL_HOST_DIR/backups/takeover-$(date -u +%Y%m%dT%H%M%SZ)"
   mkdir -p "$takeover"
   docker exec sol-token-listener-live-pg pg_dump -Fc -U sol_owner -d sol_token_listener > "$takeover/source.dump"
   shasum -a 256 "$takeover/source.dump" > "$takeover/source.dump.sha256"
   docker exec -i sol-token-listener-live-pg psql -X -A -t -v ON_ERROR_STOP=1 -U sol_owner -d sol_token_listener \
     < deploy/sql/table-row-counts.sql > "$takeover/source.counts"
   ```

4. Restaurer dans la stack : base vide, rôles de groupe, `pg_restore` dans une seule transaction,
   comparaison, puis `migrate` (droits et logins).

   ```bash
   sol_compose up --detach --wait postgres
   sol_compose run --rm migrate sol-admin group-roles
   sol_compose exec -T postgres sh -c 'exec pg_restore --exit-on-error --single-transaction -U sol_owner -d "$POSTGRES_DB"' \
     < "$takeover/source.dump"
   sol_compose exec -T postgres sh -c 'exec psql -X -A -t -v ON_ERROR_STOP=1 -U sol_owner -d "$POSTGRES_DB"' \
     < deploy/sql/table-row-counts.sql > "$takeover/target.counts"
   diff "$takeover/source.counts" "$takeover/target.counts"
   sol_compose run --rm migrate
   ```

   Le `diff` doit être vide. Une erreur de `pg_restore` annule toute la restauration : corriger la
   cause, puis repartir d'une base vide avec `sol_compose down --volumes`, qui détruit seulement la
   base de la stack.

5. Démarrer en mode `live`, trading arrêté, puis vérifier.

   ```bash
   sed -i.bak 's/^SOL_STACK_MODE=.*/SOL_STACK_MODE=live/' "$SOL_ENV"
   rm -f "$SOL_ENV.bak"
   sol_compose up --detach --wait --wait-timeout 180
   sol_compose exec back sol status
   sol_compose exec back sol ops status
   sol_compose exec back sol ops envelope show
   ```

   `sol ops status` doit montrer `ENTRY_STOP` (ou `HARD_STOP`) et la même dernière qualification
   qu'avant la reprise. Aucune requalification n'est due : wallet, fournisseur et configuration
   n'ont pas changé.

6. Arrêter l'ancien conteneur sans le supprimer : `docker stop sol-token-listener-live-pg`.

## Retour arrière

L'ancien conteneur est conservé sept jours. Tant qu'aucun trade n'a eu lieu dans la stack :
`sol_compose stop --timeout 60`, `docker start sol-token-listener-live-pg`, puis relancer les
processus de l'hôte comme avant, depuis un `dist/` reconstruit sur `main`. Après un trade, le
retour passe par un dump inverse : les étapes 3 et 4 dans l'autre sens, de la stack vers une base
vide.

## Bascule vers le serveur

Prérequis :

- Docker et son plugin Compose ;
- un pare-feu limité à SSH, 80 et 443 ;
- l'enregistrement DNS de `SITE_ADDRESS` ;
- les dossiers `/srv/sol-token-listener/{secrets,config,backups}` ;
- le timer de sauvegarde ;
- un budget RPC du listener tenable. Sa charge HTTP est estimée entre 20 000 et 55 000 crédits par
  heure, au-delà d'un forfait gratuit.

Procédure :

- copier `secrets/` et `config/` du Mac par `scp -rp`, en conservant les modes ;
- arrêter la stack du Mac ;
- exporter sa base avec `sol_compose exec -T postgres pg_dump -Fc …` ;
- restaurer sur le serveur avec l'étape 4 ;
- démarrer avec `deploy/compose.server.yaml`. Caddy obtient le certificat Let's Encrypt au premier
  démarrage.

## Rotation des secrets

- Un fichier du back (URL Helius, clé, jeton) : remplacer le fichier, puis `sol_compose restart back`.
- Un mot de passe de login : remplacer le fichier, puis `sol_compose run --rm migrate` et
  `sol_compose restart back`.
- Le mot de passe du front : supprimer `secrets/front/front-basic-auth-hash`, relancer
  `deploy/host/init-secrets.sh "$SOL_HOST_DIR"`, puis `sol_compose restart front`.
- Le mot de passe administrateur : il passe par l'entrée standard, jamais par la ligne de
  commande.

  ```bash
  new_password="$(openssl rand -hex 32)"
  printf "ALTER ROLE sol_owner PASSWORD '%s';\n" "$new_password" \
    | sol_compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sol_owner -d sol_token_listener
  printf '%s\n' "$new_password" > "$SOL_HOST_DIR/secrets/db/postgres-admin-password"
  unset new_password
  ```

## Frontière de sécurité

- La keypair n'est lisible que par l'utilisateur `h2b`, dans un tmpfs. Elle n'apparaît dans aucune
  image, aucun compose, aucune variable d'environnement de conteneur et aucun log.
- Chaque processus se connecte avec son propre login PostgreSQL `NOINHERIT`, membre d'un seul rôle
  de groupe ; seul `migrate` reçoit le mot de passe administrateur.
- Aucun achat sans `sol trading start` après un redémarrage ; les sorties restent automatiques.
- Ni la base ni le back ne publient de port ; le front n'expose que GET, HEAD et OPTIONS, derrière
  un mot de passe ou, pour `/operator/v1/`, le jeton de l'API opérateur.
- Caddy ne bloque pas les tentatives répétées : la longueur du mot de passe (32 caractères
  aléatoires) compense, et un fail2ban sur les journaux de Caddy reste possible sur le serveur.
- La stack est limitée à un réplica unique. Elle n'offre aucune promesse de première position, de
  sellabilité ou de profit.
````

- [ ] **Step 4: Update the README, the overview and the two canary runbooks**

In `README.md`, replace:

````markdown
## Déploiement de référence

Le compose de référence démarre une seule application listener, un worker de
rétention et un frontend same-origin ; PostgreSQL et l’API backend restent
privés. Il est strictement observe/paper : il ne charge aucun wallet, ne signe
et n’envoie aucune transaction. Le worker conserve les données terminales 4
heures et les purge à cadence bornée. TLS externe et sauvegarde externe restent
sous la responsabilité de l’opérateur.

Avant une livraison, exécuter le smoke isolé puis suivre le
[guide de déploiement](docs/operations/deployment.md) pour les secrets, la
migration, le rollback et l’arrêt :
````

with:

````markdown
## Déploiement de référence

La stack Docker Compose exécute le bot complet en trois conteneurs : PostgreSQL
privé, un conteneur `back` où `supervisord` lance chaque processus Node sous
son propre utilisateur Unix, et un front Caddy en HTTPS, protégé par mot de passe
et limité à la lecture. Le mode `observe` ne lance que le listener, l’API
opérateur et la rétention ; le mode `live` ajoute H2a, H2b et l’auto-arm, sans
nouvel achat avant `sol trading start`. Les secrets sont des fichiers hors du
dépôt et la keypair n’est lisible que par H2b. Les données terminales sont
gardées 4 heures. La sauvegarde externe (copie hors machine) reste sous la
responsabilité de l’opérateur.

Avant une livraison, exécuter le smoke isolé puis suivre le
[guide de déploiement](docs/operations/deployment.md) pour les secrets, les
commandes `sol`, la reprise de la base, les sauvegardes et la bascule :
````

In `docs/system-overview.html`, replace:

````html
<h3 class="h5">Déploiement de référence</h3><p>Compose exécute un réplica unique : PostgreSQL privé, migration sérialisée par verrou consultatif, une application, un worker de rétention puis le frontend same-origin. Les données terminales ont une rétention de 4 heures ; la purge planifiée par défaut est de 15 minutes et ne raccourcit pas cette fenêtre.</p><p class="mb-0">Le healthcheck accepte <code>DEGRADED</code> seulement pour le smoke avec listener désactivé. En production, un listener activé doit converger vers <code>OK</code>. TLS externe et sauvegarde externe relèvent de l’opérateur.</p></div></div></div><div class="col-lg-5"><div class="alert alert-warning h-100 mb-0"><h3 class="h5">Frontière et arrêt</h3><p><code>EXECUTION_MODE=observe</code> est la référence ; seuls <code>observe</code> et <code>paper</code> sont admis. Aucun wallet, ordre réel ou transaction live.</p>
````

with:

````html
<h3 class="h5">Déploiement de référence</h3><p>Compose exécute un réplica unique en trois conteneurs : PostgreSQL privé, un conteneur back où <code>supervisord</code> lance chaque processus sous son propre utilisateur Unix, et un front Caddy en HTTPS, protégé par mot de passe et limité à la lecture. Une tâche <code>migrate</code> applique les migrations sous verrou consultatif et crée un login PostgreSQL par processus. Les données terminales ont une rétention de 4 heures ; la purge planifiée par défaut est de 15 minutes et ne raccourcit pas cette fenêtre.</p><p class="mb-0">Le mode <code>observe</code> lance le listener, l’API opérateur et la rétention ; le mode <code>live</code> ajoute H2a, H2b et l’auto-arm. Après tout redémarrage, aucun achat avant <code>sol trading start</code>. La sauvegarde externe (copie hors machine) relève de l’opérateur.</p></div></div></div><div class="col-lg-5"><div class="alert alert-warning h-100 mb-0"><h3 class="h5">Frontière et arrêt</h3><p>Les secrets sont des fichiers hors du dépôt, copiés en mémoire pour chaque utilisateur ; la keypair n’est lisible que par H2b. Ni la base ni le back ne publient de port.</p>
````

In `docs/system-overview.html`, replace:

````html
<p class="mt-3 mb-0">Voir le <a href="operations/deployment.md">guide de déploiement</a> pour les secrets externes, la sauvegarde, la répétition de restauration, le rollback forward-only, le proxy SSE et l’arrêt incident.
````

with:

````html
<p class="mt-3 mb-0">Voir le <a href="operations/deployment.md">guide de déploiement</a> pour le dossier des secrets, les commandes <code>sol</code>, la reprise de la base, les sauvegardes, le retour arrière et la bascule vers le serveur.
````

In `docs/operations/block-hydration-canary.md`, insert this note after the first paragraph (right after the title block, before the next blank line):

````markdown
> **Stack de référence.** Les commandes de ce runbook visent la stack d'observation antérieure au
> 2026-10-09 (services `app`, `frontend`, `retention`). Dans la stack actuelle
> (`docs/operations/deployment.md`), le listener est le programme `listener` du conteneur `back` :
> `sol ctl stop listener` remplace `stop app`, et sa configuration vit dans `config/listener.env`.
````

In `docs/operations/executor-live-canary.md`, insert this note after the first paragraph (right after the title block, before the next blank line):

````markdown
> **Stack Docker Compose.** Depuis le 2026-10-09, les commandes `npm run live:*` et
> `executor:*` de ce runbook s'exécutent par `docker compose exec -it back sol …`
> (`docs/operations/deployment.md`, « Commandes sol »), avec la configuration de
> `config/<rôle>.env` et les secrets distribués par la stack.
````

- [ ] **Step 5: Run the checks**

```bash
npx tsx --test tests/deployment-artifacts.test.ts
npm run docs:check
npm run build:backend
grep -l "executor-live-canary.md\|block-hydration-canary.md\|system-overview.html\|README.md" tests/*.test.ts | xargs npx tsx --test
```

Expected: PASS everywhere. The last command needs `dist/` for the architecture graphs.

- [ ] **Step 6: Commit**

```bash
git add docs/operations/deployment.md README.md docs/system-overview.html docs/operations/block-hydration-canary.md docs/operations/executor-live-canary.md tests/deployment-artifacts.test.ts
git commit -m "docs(deploy): runbook of the full-bot compose stack

Host directory and secrets copied without printing them, images, start and stop, sol commands,
trading and gate-10 qualification, health and logs, backups, takeover of the 5433 database with
row-count comparison, rollback, server switch, secret rotation and the security boundary.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 15: Full verification and pull request

**Files:** none new.

The new `deploy/compose.yaml` no longer serves as a disposable test database: its postgres service now reads the admin password from a host file. For the PostgreSQL suites, start a standalone container on 55432, never on 5432.

- [ ] **Step 1: Static checks and build**

```bash
npm run check:backend
npm run lint
npm run build:backend
```

Expected: all exit 0.

- [ ] **Step 2: The whole backend suite against a disposable database**

```bash
docker run -d --name sol-compose-plan-test-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=sol_token_listener_test \
  postgres:16.14-alpine3.23@sha256:42b8b8b29c8a4e933d88943e5b03001a78794905cf786e6e7634e9f2abd5a0d3
until docker exec sol-compose-plan-test-pg pg_isready -U test -q; do sleep 1; done
TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55432/sol_token_listener_test npm run test:backend
docker rm -f sol-compose-plan-test-pg
```

Expected: 0 failures. If port 55432 is taken by another session's project, use another free port and never stop someone else's container.

- [ ] **Step 3: Container contract**

```bash
npm run deployment:smoke
npm run deployment:smoke:signal
```

Expected: `Deployment smoke passed.` and `Deployment signal fault probe passed.`

- [ ] **Step 4: Push and open the PR**

Write the body to a scratch file. It covers: summary, the six spec deviations of this plan, the evidence (smoke, restore rehearsal, parser checks), the test plan, and the closing line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Then:

```bash
git push -u origin feat/full-bot-compose
gh pr create --base main --head feat/full-bot-compose \
  --title "feat(deploy): full bot on Docker Compose (postgres, back, front)" \
  --body-file "$PR_BODY_FILE"
```

- [ ] **Step 5: Wait for CI and merge**

```bash
gh pr checks --watch --interval 60
gh pr merge --merge
git -C ../.. pull --ff-only origin main
```

Expected: `quality`, `deployment-contract` and `frontend-e2e` green before the merge. Merging changes only the repository; the processes running on the host keep running until Task 17.

---

## Task 16: Validation on the Mac (spec 11.3) — STOP: needs the user's explicit go

Live mode calls Helius (listener, H2a, auto-arm, H2b) with the real keys. Do not start this task without an explicit go from the user. The listener also needs a usable RPC project, which is the pending decision about the exhausted listener project. Until then, validate with `SOL_HEALTH_REQUIRE_OK=false`.

Follow `docs/operations/deployment.md` on the Mac, with `SOL_HOST_DIR=$HOME/.sol-token-listener/docker`:

- [ ] **Step 1:** « Dossier hôte, secrets et configuration ». Run `init-secrets.sh`, copy the six back secrets and build the configuration from `~/.sol-token-listener/lot5/env/`, then adjust it by hand. Never print a secret.
- [ ] **Step 2:** « Images »: build `back` and `front` at the merged commit.
- [ ] **Step 3:** « Reprise de la base actuelle », steps 1 to 4:
  - the precondition `0|0|0|0`;
  - stop the host processes, so that one keypair holder runs at a time;
  - dump, restore and diff the counts (the diff must be empty);
  - `migrate`.

  The 5433 container stays intact.
- [ ] **Step 4:** Step 5 of the takeover: start in `live` mode, trading stopped. Check:
  - every program `RUNNING`;
  - `h2b running` or `idle` in `sol status`;
  - the back healthy;
  - `sol ops status` at `ENTRY_STOP` with the same latest qualification;
  - the front at `http://127.0.0.1:8080`: login, console, operator page with its token.
- [ ] **Step 5:** `sol_compose exec -it back sol trading start` without an ACTIVE envelope must fail with `no ACTIVE envelope`. Then `sol trading stop` must keep `ENTRY_STOP`.
- [ ] **Step 6:** Report to the user: what passed, what failed, and the Helius credits consumed during the validation. Ask for the go of Task 17, or roll back (« Retour arrière »).

## Task 17: Takeover (spec 9.2) — STOP: needs the user's explicit go

- [ ] **Step 1:** If no host process ran since the dump of Task 16, the restored stack database is already the takeover. Otherwise, redo steps 1 to 4 of « Reprise de la base actuelle » with a fresh dump.
- [ ] **Step 2:** `docker stop sol-token-listener-live-pg`. Keep the container seven days, and write the date in the memory notes.
- [ ] **Step 3:** Record in the memory notes:
  - the new operating mode (stack on the Mac, `sol` commands);
  - the obsolete test-database recipe (Task 15, Step 2 replaces it);
  - the rollback deadline.

## Task 18: Backups on the Mac

- [ ] **Step 1:** Install the launchd job (« Sauvegardes »).
- [ ] **Step 2:** Run one backup by hand: `SOL_HOST_DIR="$SOL_HOST_DIR" SOL_REPOSITORY="$PWD" deploy/host/backup.sh`.
- [ ] **Step 3:** Rehearse a restore of that dump on a throwaway compose project, and compare the counts.

The server switch (spec section 10) is phase 2: a new plan once the listener RPC budget is settled.

---

## Spec coverage

| Spec section | Tasks |
|---|---|
| 5 Topology, networks, ports, volumes | 11 |
| 6.1 Supervisor and users | 9, 10 |
| 6.2 Programs, modes | 3, 9 |
| 6.3 H2b on demand, exit 75 | 2, 9 |
| 6.4 Trading start/stop (amended) | 1, 8, 9 |
| 6.5 Health | 9 |
| 6.6 Logs | 9, 11 |
| 6.7 Manual commands | 9, 14 |
| 7.1–7.2 Secrets inventory and file phase | 3, 4, 5, 6, 11, 13 |
| 7.3 Vault seam | unchanged directories `/run/sol/<user>/` (sub-project 2) |
| 7.4 Rotation | 14 |
| 8 Caddy front | 10 |
| 9.1 Logins | 7 |
| 9.2 Takeover | 13, 14, 17 |
| 9.3 Rollback | 14 |
| 9.4 Backups | 13, 18 |
| 10 Server switch | 14 (runbook); execution in phase 2 |
| 11.1 Static tests | 9, 10, 11, 12, 13, 14 |
| 11.2 Container tests in CI | 12 |
| 11.3 Mac validation | 16 |
| 13 Live invariants | 2, 6, 9, 10, 11, 12 |
| 15 Acceptance criteria | 15, 16, 17 |

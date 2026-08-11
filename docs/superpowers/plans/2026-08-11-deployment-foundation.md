# Deployment Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package and verify a single-replica, observe-only deployment of the compiled Pump.fun backend, PostgreSQL, retention worker, and independent operator frontend.

**Architecture:** One multi-stage Dockerfile produces a non-root Node backend target and an unprivileged Nginx frontend target. Compose serializes PostgreSQL health, a globally locked one-shot migration, application/retention startup, and same-origin frontend proxying; a bounded Node smoke script validates the real deployment and always removes its resources.

**Tech Stack:** TypeScript strict ESM, Node.js 22.22.0, PostgreSQL 16.14, Docker BuildKit/Compose, unprivileged Nginx 1.30.4, Node test runner, GitHub Actions.

---

## File map

- `frontend/src/data/runtime-config.ts` — accept exact same-origin `/` safely.
- `frontend/src/data/runtime-config.test.ts` — same-origin and hostile-origin tests.
- `frontend/public/config.json` — portable same-origin public configuration.
- `src/storage/database.ts` — serialize migrations with a session advisory lock.
- `tests/migration-lock.test.ts` — fake-boundary and real PostgreSQL concurrency tests.
- `scripts/migrate.ts` — keep the compiled one-shot migration entrypoint.
- `src/operations/retention-runner.ts` — bounded, stoppable retention scheduler.
- `scripts/purge-retained-data.ts` — compiled retention CLI boundary.
- `tests/retention-runner.test.ts` — timing, shutdown, logging, and error contracts.
- `src/operations/deployment-healthcheck.ts` — bounded health-envelope probe.
- `scripts/deployment-healthcheck.ts` — compiled container healthcheck entrypoint.
- `tests/deployment-healthcheck.test.ts` — OK/DEGRADED/failure/size/timeout tests.
- `Dockerfile` — pinned multi-stage backend and frontend images.
- `.dockerignore` — minimal secret-free build context.
- `deploy/nginx.conf` — same-origin SPA/API/SSE static serving contract.
- `deploy/compose.yaml` — PostgreSQL, migrate, app, retention, and frontend.
- `deploy/env.example` — non-secret deployment variable model.
- `tests/deployment-artifacts.test.ts` — static security and orchestration contracts.
- `scripts/deployment-smoke.mjs` — bounded real Compose smoke and cleanup.
- `.github/workflows/ci.yml` — isolated deployment-contract job.
- `docs/operations/deployment.md` — deployment, rollback, backup, and incident runbook.
- `README.md` — concise deployment entry point and safety boundary.
- `package.json` — compiled operational and smoke commands.

## Pinned base images

Use these reviewed multi-architecture manifest digests:

```text
node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
nginxinc/nginx-unprivileged:1.30.4-alpine@sha256:44e36330f74d4f3a1d4e222acca9e23b401fb87811a7597024502bb759c4dd49
postgres:16.14-alpine3.23@sha256:42b8b8b29c8a4e933d88943e5b03001a78794905cf786e6e7634e9f2abd5a0d3
```

### Task 1: Support a portable same-origin frontend

**Files:**
- Modify: `frontend/src/data/runtime-config.ts`
- Modify: `frontend/src/data/runtime-config.test.ts`
- Modify: `frontend/public/config.json`
- Modify: `frontend/README.md`

- [ ] **Step 1: Write failing same-origin tests**

Add tests that inject a trusted origin and prove only exact `/` selects it:

```ts
const response = jsonResponse({ apiBaseUrl: '/' });
const config = await loadRuntimeConfig(async () => response, undefined, 'https://tokens.example');
assert.deepEqual(config, { apiBaseUrl: 'https://tokens.example' });

for (const invalid of ['./', '/api', '//evil.example', ' / ']) {
  await assert.rejects(
    loadRuntimeConfig(async () => jsonResponse({ apiBaseUrl: invalid }), undefined, 'https://tokens.example'),
    hasCode('CONFIG_INVALID'),
  );
}
```

Also reject missing, credentialed, non-HTTP, query-bearing, and non-origin
trusted origin arguments without invoking a getter.

- [ ] **Step 2: Run the focused tests RED**

Run:

```bash
npm test --workspace frontend -- --run runtime-config
```

Expected: failure because `/` is not an absolute URL and no origin dependency
exists.

- [ ] **Step 3: Implement the narrow contract**

Change the signature and normalization only as follows:

```ts
export async function loadRuntimeConfig(
  fetchFn: typeof fetch,
  signal?: AbortSignal,
  currentOrigin = globalThis.location?.origin,
): Promise<RuntimeConfig> {
  // existing bounded fetch and JSON validation
  return Object.freeze({
    apiBaseUrl: normalizeApiBaseUrl(parsed.data.apiBaseUrl, currentOrigin),
  });
}

function normalizeApiBaseUrl(value: string, currentOrigin: string | undefined): string {
  if (value === '/') return normalizeOrigin(currentOrigin);
  // preserve the existing absolute HTTP(S) validation byte-for-byte
}

function normalizeOrigin(value: string | undefined): string {
  if (value === undefined || value.trim() !== value) throw new RuntimeConfigError('CONFIG_INVALID');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new RuntimeConfigError('CONFIG_INVALID');
  }
  return url.origin;
}
```

Set `frontend/public/config.json` to:

```json
{ "apiBaseUrl": "/" }
```

- [ ] **Step 4: Verify frontend GREEN**

Run:

```bash
npm run check --workspace frontend
npm run lint --workspace frontend
npm test --workspace frontend -- --run runtime-config api-client sse-client
```

Expected: all selected checks pass and no existing absolute-URL case regresses.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/data/runtime-config.ts frontend/src/data/runtime-config.test.ts frontend/public/config.json frontend/README.md
git commit -m "feat: support same-origin frontend deployment (#45)"
```

### Task 2: Serialize compiled database migrations

**Files:**
- Modify: `src/storage/database.ts`
- Create: `tests/migration-lock.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the migration-lock contract RED**

Create a focused fake client test that records these calls:

```ts
assert.deepEqual(calls[0], ['SELECT pg_advisory_lock($1)', [7_347_662_125]]);
assert.match(String(calls[1]?.[0]), /CREATE TABLE IF NOT EXISTS migration_history/u);
assert.deepEqual(calls.at(-1), ['SELECT pg_advisory_unlock($1)', [7_347_662_125]]);
```

Cover success, migration failure, unlock failure, and primary-plus-unlock failure.
The primary error must remain first in an `AggregateError`; the client must
always release.

When `TEST_DATABASE_URL` is present, use two pools against a unique schema and
run two `migrateDatabase` calls concurrently. Assert that the union of applied
migrations is the canonical 13 names, their intersection is empty, and
`migration_history` contains one row per name.

- [ ] **Step 2: Run the focused test RED**

```bash
npx tsx --test tests/migration-lock.test.ts
```

Expected: failure because no advisory lock query is issued.

- [ ] **Step 3: Implement the fixed session lock**

Add a module-private exact integer constant and bracket the existing migration
body:

```ts
const MIGRATION_ADVISORY_LOCK_ID = 7_347_662_125;

await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_ID]);
let primaryError: unknown;
try {
  // existing history creation and per-file transactions
} catch (error) {
  primaryError = error;
} finally {
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_ID]);
  } catch (unlockError) {
    if (primaryError !== undefined) throw new AggregateError([primaryError, unlockError], 'Database migration failed.');
    throw unlockError;
  } finally {
    client.release();
  }
}
if (primaryError !== undefined) throw primaryError;
```

Keep the lock session-scoped and outside the per-migration transactions.

Add a compiled-only package command:

```json
"db:migrate:compiled": "node dist/scripts/migrate.js"
```

- [ ] **Step 4: Verify migration GREEN**

```bash
npx tsx --test tests/migration-lock.test.ts tests/copy-migrations.test.ts tests/api-event-stream-migration.test.ts
npm run build:backend
node --check dist/scripts/migrate.js
```

The last command may fail only because `DATABASE_URL` is absent; it must load
the compiled entrypoint without a missing-module or `tsx` error.

- [ ] **Step 5: Commit**

```bash
git add src/storage/database.ts tests/migration-lock.test.ts package.json package-lock.json
git commit -m "fix: serialize deployment migrations (#45)"
```

### Task 3: Add a bounded retention runtime

**Files:**
- Create: `src/operations/retention-runner.ts`
- Create: `scripts/purge-retained-data.ts`
- Create: `tests/retention-runner.test.ts`
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Specify the runner RED**

Define tests against injected dependencies for this contract:

```ts
export interface RetentionRunnerDependencies {
  readonly purge: () => Promise<Readonly<Record<string, number>>>;
  readonly closeDatabase: () => Promise<void>;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly logInfo: (context: object, message: string) => void;
}

export interface RetentionRunnerOptions {
  readonly intervalMs: number;
  readonly once: boolean;
  readonly signal: AbortSignal;
}
```

Prove immediate purge, repeated purge only after the wait resolves, exact
interval bounds `60_000..86_400_000`, one-shot exit, abort during wait, database
close exactly once, aggregate count logging only, and redacted failure logging.

- [ ] **Step 2: Run RED**

```bash
npx tsx --test tests/retention-runner.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement the runner and CLI**

Implement an iterative loop with no overlapping purge:

```ts
export async function runRetention(
  options: RetentionRunnerOptions,
  dependencies: RetentionRunnerDependencies,
): Promise<void> {
  assertOptions(options);
  try {
    for (;;) {
      const counts = await dependencies.purge();
      dependencies.logInfo({ event: 'retention.purged', counts: sanitizeCounts(counts) }, 'Expired data purged.');
      if (options.once) return;
      await dependencies.wait(options.intervalMs, options.signal);
    }
  } catch (error) {
    if (!options.signal.aborted) throw error;
  } finally {
    await dependencies.closeDatabase();
  }
}
```

`assertOptions` accepts only a boolean `once`, a real `AbortSignal`, and an
integer interval from 60,000 through 86,400,000 milliseconds. `sanitizeCounts`
copies own enumerable entries only, accepts canonical keys matching
`^[a-z][A-Za-z0-9]{0,63}$`, and accepts safe non-negative integer counts only;
it returns a frozen null-prototype snapshot so external getters and prototypes
cannot reach structured logs.

The CLI accepts only `--once` or no argument. It reads
`RETENTION_PURGE_INTERVAL_MS`, defaults to `900000`, installs SIGINT/SIGTERM,
uses the real purge function, and reports only a stable error name.

Add:

```json
"db:purge": "tsx scripts/purge-retained-data.ts --once",
"db:purge:compiled": "node dist/scripts/purge-retained-data.js --once",
"retention:start:compiled": "node dist/scripts/purge-retained-data.js"
```

Add `RETENTION_PURGE_INTERVAL_MS=900000` to `.env.example` with no secret.

- [ ] **Step 4: Verify GREEN**

```bash
npx tsx --test tests/retention-runner.test.ts tests/config-safety.test.ts
npm run build:backend
node dist/scripts/purge-retained-data.js --invalid
```

Expected: tests pass; the final command exits non-zero with a stable redacted
usage error before opening PostgreSQL.

- [ ] **Step 5: Commit**

```bash
git add src/operations/retention-runner.ts scripts/purge-retained-data.ts tests/retention-runner.test.ts package.json package-lock.json .env.example
git commit -m "feat: schedule bounded data retention (#45)"
```

### Task 4: Add a compiled deployment healthcheck

**Files:**
- Create: `src/operations/deployment-healthcheck.ts`
- Create: `scripts/deployment-healthcheck.ts`
- Create: `tests/deployment-healthcheck.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write healthcheck tests RED**

Use injected `fetch` and assert:

```ts
await assert.doesNotReject(checkDeploymentHealth({
  url: 'http://127.0.0.1:3000/api/v1/health',
  fetchFn: async () => healthResponse('DEGRADED', 'AVAILABLE'),
}));
await assert.rejects(
  checkDeploymentHealth({ url, fetchFn: async () => healthResponse('OK', 'UNAVAILABLE') }),
  hasCode('POSTGRESQL_UNAVAILABLE'),
);
```

Also cover `OK`, HTTP non-200, malformed JSON, unexpected keys/types, response
over 64 KiB, timeout, redirect, credentials in URL, and non-loopback probe URL.

- [ ] **Step 2: Run RED**

```bash
npx tsx --test tests/deployment-healthcheck.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement bounded validation**

The healthcheck must use `redirect: 'error'`, a three-second abort timeout, a
64-KiB streaming limit, and strict validation of only the required envelope
path:

```ts
type ProbeResult = Readonly<{
  apiVersion: 'v1';
  data: Readonly<{
    status: 'OK' | 'DEGRADED';
    postgresql: Readonly<{ status: 'AVAILABLE' | 'UNAVAILABLE' }>;
  }>;
}>;
```

The CLI probes exact loopback URL
`http://127.0.0.1:${API_PORT}/api/v1/health`, writes no success payload, and
exits 1 after logging only a stable code.

Add:

```json
"deployment:healthcheck:compiled": "node dist/scripts/deployment-healthcheck.js"
```

- [ ] **Step 4: Verify GREEN**

```bash
npx tsx --test tests/deployment-healthcheck.test.ts
npm run build:backend
```

Expected: all focused tests pass and both compiled files exist.

- [ ] **Step 5: Commit**

```bash
git add src/operations/deployment-healthcheck.ts scripts/deployment-healthcheck.ts tests/deployment-healthcheck.test.ts package.json package-lock.json
git commit -m "feat: add bounded deployment healthcheck (#45)"
```

### Task 5: Package non-root backend and frontend images

**Files:**
- Create: `tests/deployment-artifacts.test.ts`
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `deploy/nginx.conf`

- [ ] **Step 1: Write static artifact contracts RED**

The test reads the four files and proves:

```ts
assert.match(dockerfile, /node:22\.22\.0-bookworm-slim@sha256:dd9d2197/u);
assert.match(dockerfile, /nginxinc\/nginx-unprivileged:1\.30\.4-alpine@sha256:44e36330/u);
assert.match(dockerfile, /^USER node$/mu);
assert.doesNotMatch(dockerfile, /(?:PRIVATE_KEY|KEYPAIR|POSTGRES_PASSWORD)=/u);
assert.match(dockerignore, /^\.env\.\*$/mu);
assert.match(dockerignore, /^\.worktrees\/$/mu);
assert.match(nginx, /proxy_buffering off;/u);
assert.match(nginx, /try_files \$uri \$uri\/ \/index\.html;/u);
```

Also assert no `COPY . .` after the final runtime stage, frontend port 8080,
no root user in either runtime target, no source/tests in the final copy list,
`config.json` no-store, immutable asset cache, and proxy methods limited by the
backend read-only API contract.

- [ ] **Step 2: Run RED**

```bash
npx tsx --test tests/deployment-artifacts.test.ts
```

Expected: missing artifact files.

- [ ] **Step 3: Create the multi-stage Dockerfile**

Use named stages `dependencies`, `build`, `production-dependencies`, `backend`,
and `frontend`. The runtime skeleton is:

```dockerfile
FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json eslint.config.js ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY config ./config
COPY frontend ./frontend
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --workspaces=false && npm cache clean --force

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS backend
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/src/app.js"]

FROM nginxinc/nginx-unprivileged:1.30.4-alpine@sha256:44e36330f74d4f3a1d4e222acca9e23b401fb87811a7597024502bb759c4dd49 AS frontend
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
```

Do not add a frontend `USER` directive that conflicts with the upstream
unprivileged image; verify its runtime UID through the smoke test.

- [ ] **Step 4: Create safe ignore and Nginx contracts**

`.dockerignore` must exclude at least Git, all `.env*` except no re-inclusion,
worktrees, dependency/build/test output, coverage, fixtures, and local logs.

Nginx must proxy exact `/api/v1/` to `http://app:3000`, keep SSE buffering off,
set `proxy_read_timeout 1h`, serve config without cache, and use SPA fallback.
It must not add credentialed CORS headers or expose directory listings.

- [ ] **Step 5: Verify image targets**

```bash
npx tsx --test tests/deployment-artifacts.test.ts
docker build --target backend -t sol-token-listener-backend:test .
docker build --target frontend -t sol-token-listener-frontend:test .
docker run --rm --entrypoint id sol-token-listener-backend:test -u
docker run --rm --entrypoint id sol-token-listener-frontend:test -u
```

Expected: contract tests pass; both IDs are non-zero.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore deploy/nginx.conf tests/deployment-artifacts.test.ts
git commit -m "build: package non-root runtime images (#45)"
```

### Task 6: Define the safe Compose topology

**Files:**
- Create: `deploy/compose.yaml`
- Create: `deploy/env.example`
- Modify: `tests/deployment-artifacts.test.ts`

- [ ] **Step 1: Extend artifact tests RED**

Assert the Compose model has exactly five services and no database port:

```ts
assert.deepEqual(serviceNames, ['app', 'frontend', 'migrate', 'postgres', 'retention']);
assert.equal(compose.services.postgres.ports, undefined);
assert.equal(compose.services.app.ports, undefined);
assert.deepEqual(compose.services.frontend.ports, ['127.0.0.1:${FRONTEND_PORT:-8080}:8080']);
assert.equal(compose.services.app.environment.EXECUTION_MODE, 'observe');
assert.equal(compose.services.app.environment.POSTGRES_AUTO_MIGRATE, 'false');
```

Use a small strict YAML-subset reader or textual assertions; do not add a YAML
runtime dependency solely for this test.

Also reject `privileged`, host networking, Docker socket mounts, private-key
variables, floating image tags, and published app/PostgreSQL ports.

- [ ] **Step 2: Run RED**

```bash
npx tsx --test tests/deployment-artifacts.test.ts
```

Expected: missing Compose and environment model.

- [ ] **Step 3: Create Compose services**

Use the pinned PostgreSQL image, an internal network, one named data volume,
and these dependency conditions:

```yaml
services:
  postgres:
    image: postgres:16.14-alpine3.23@sha256:42b8b8b29c8a4e933d88943e5b03001a78794905cf786e6e7634e9f2abd5a0d3
    environment:
      POSTGRES_DB: ${POSTGRES_DB:?POSTGRES_DB is required}
      POSTGRES_USER: ${POSTGRES_USER:?POSTGRES_USER is required}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
    volumes: ["postgres-data:/var/lib/postgresql/data"]

  migrate:
    build: { context: .., dockerfile: Dockerfile, target: backend }
    command: ["node", "dist/scripts/migrate.js"]
    restart: "no"
    depends_on:
      postgres: { condition: service_healthy }

  app:
    build: { context: .., dockerfile: Dockerfile, target: backend }
    init: true
    stop_grace_period: 40s
    depends_on:
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "node", "dist/scripts/deployment-healthcheck.js"]

  retention:
    build: { context: .., dockerfile: Dockerfile, target: backend }
    command: ["node", "dist/scripts/purge-retained-data.js"]
    init: true
    depends_on:
      migrate: { condition: service_completed_successfully }

  frontend:
    build: { context: .., dockerfile: Dockerfile, target: frontend }
    depends_on:
      app: { condition: service_healthy }
    ports: ["127.0.0.1:${FRONTEND_PORT:-8080}:8080"]
```

Deduplicate the shared `DATABASE_URL` and safe application environment with
YAML anchors. Keep `API_HOST=0.0.0.0`, `API_PORT=3000`,
`POSTGRES_AUTO_MIGRATE=false`, and `EXECUTION_MODE=observe` literal in the
reviewed file. RPC URLs and database credentials must be required interpolation
inputs, never defaults.

- [ ] **Step 4: Create `deploy/env.example`**

Use non-working documentation values only:

```dotenv
POSTGRES_DB=sol_token_listener
POSTGRES_USER=sol_token_listener
POSTGRES_PASSWORD=replace-with-a-secret
SOLANA_HTTP_RPC_URL=https://rpc-provider.invalid
SOLANA_WS_RPC_URL=wss://rpc-provider.invalid
FRONTEND_PORT=8080
LISTENER_ENABLED=true
RETENTION_PURGE_INTERVAL_MS=900000
```

Document that this file must be copied outside version control and that the
password/RPC URLs must be replaced.

- [ ] **Step 5: Validate Compose GREEN**

```bash
POSTGRES_DB=smoke POSTGRES_USER=smoke POSTGRES_PASSWORD=smoke-only \
SOLANA_HTTP_RPC_URL=https://rpc.invalid SOLANA_WS_RPC_URL=wss://rpc.invalid \
LISTENER_ENABLED=false docker compose -f deploy/compose.yaml config --quiet
npx tsx --test tests/deployment-artifacts.test.ts tests/config-safety.test.ts
```

Expected: valid Compose and passing security contracts.

- [ ] **Step 6: Commit**

```bash
git add deploy/compose.yaml deploy/env.example tests/deployment-artifacts.test.ts
git commit -m "build: define safe deployment topology (#45)"
```

### Task 7: Add the real deployment smoke and CI job

**Files:**
- Create: `scripts/deployment-smoke.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/deployment-artifacts.test.ts`

- [ ] **Step 1: Specify smoke safety RED**

Extend artifact tests to prove the script:

- generates a unique `COMPOSE_PROJECT_NAME` from process ID plus random bytes;
- sets `LISTENER_ENABLED=false`, observe mode, and `.invalid` RPC URLs;
- uses explicit 180-second global and 10-second request deadlines;
- calls `docker compose down --volumes --remove-orphans` in `finally`;
- never uses `--privileged`, host networking, a wallet, or a private key;
- queries migration history through `docker compose exec -T postgres psql`;
- never runs `docker system prune` or deletes a shared image/volume.

- [ ] **Step 2: Run RED**

```bash
npx tsx --test tests/deployment-artifacts.test.ts
```

Expected: missing smoke command/script/CI job.

- [ ] **Step 3: Implement bounded orchestration**

Use only Node standard modules. Wrap `spawn` in an argument-array helper; never
invoke a shell. Set this exact base environment:

```js
const environment = Object.freeze({
  ...process.env,
  COMPOSE_PROJECT_NAME: `sol-listener-smoke-${process.pid}-${randomBytes(4).toString('hex')}`,
  POSTGRES_DB: 'smoke',
  POSTGRES_USER: 'smoke',
  POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
  SOLANA_HTTP_RPC_URL: 'https://rpc.invalid',
  SOLANA_WS_RPC_URL: 'wss://rpc.invalid',
  LISTENER_ENABLED: 'false',
  FRONTEND_PORT: await reserveLoopbackPort(),
});
```

Execute and assert in order:

1. `compose build`;
2. `compose up --detach --wait`;
3. backend and frontend UIDs are not zero;
4. public health is V1/DEGRADED/PostgreSQL AVAILABLE/pipelines STOPPED;
5. `OPTIONS /api/v1/events` exposes the exact read-only CORS contract;
6. migration history is the sorted canonical 13 names;
7. rerun migrate and assert names plus `applied_at` values are unchanged;
8. `/config.json` returns `/` and no-store;
9. `/health` and `/launches/So11111111111111111111111111111111111111112`
   direct routes return the SPA
   document while a discovered asset URL returns an immutable real asset;
10. open SSE, stop app with 40-second timeout, and observe
    `event: server_shutdown` before EOF;
11. start app and wait for health again;
12. run retention one-shot and assert a stable success event without row data.

In `finally`, always call down with volumes and orphans, then verify no container
with the unique project label remains.

- [ ] **Step 4: Add package and CI commands**

Add:

```json
"deployment:smoke": "node scripts/deployment-smoke.mjs"
```

Add a dedicated GitHub Actions job after checkout:

```yaml
deployment-contract:
  runs-on: ubuntu-latest
  timeout-minutes: 15
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 22.13.0
        cache: npm
    - run: npm ci
    - run: npm run deployment:smoke
```

Do not pass any repository secret to this job.

- [ ] **Step 5: Run the real smoke GREEN twice**

```bash
npm run deployment:smoke
npm run deployment:smoke
docker ps -a --filter label=com.docker.compose.project --format '{{.Names}}'
```

Expected: both runs pass independently; no smoke container remains.

- [ ] **Step 6: Commit**

```bash
git add scripts/deployment-smoke.mjs package.json package-lock.json .github/workflows/ci.yml tests/deployment-artifacts.test.ts
git commit -m "test: verify deployment contract end to end (#45)"
```

### Task 8: Document operations and safety boundaries

**Files:**
- Create: `docs/operations/deployment.md`
- Modify: `README.md`
- Modify: `docs/system-overview.html`
- Modify: `scripts/check-system-overview.ts` if a new required section reference is necessary
- Test: `tests/deployment-artifacts.test.ts`

- [ ] **Step 1: Add failing documentation contracts**

Require the runbook to contain exact sections for prerequisites, immutable
images, external secrets, migration lock, startup, shutdown, health, retention,
backup, restore rehearsal, rollback, SSE proxy, TLS, single replica, incident
stop, and no-live boundary. Require README and system overview links.

- [ ] **Step 2: Run RED**

```bash
npx tsx --test tests/deployment-artifacts.test.ts
npm run docs:check
```

Expected: deployment documentation references are absent.

- [ ] **Step 3: Write the runbook**

The runbook must include exact safe commands using `deploy/compose.yaml`, state
that `deploy/env.example` is never a production secret file, and prescribe:

```text
backup database before migration
build/pull immutable images
run migrate one-shot
start one app and one retention worker
verify health, SSE, and retention logs
start frontend behind TLS
rollback application image without reversing applied schema migrations
restore only from a rehearsed backup when forward compatibility is impossible
```

It must explicitly explain that a Compose volume deletion is destructive and
must never be used on the production project during normal shutdown.

Document production alerting: `DEGRADED` is accepted only for the listener-off
smoke; an enabled production listener must converge to `OK`.

- [ ] **Step 4: Update overview and README**

Link the runbook, list `npm run deployment:smoke`, and state the current limits:
single listener, observe/paper only, four-hour purge cadence, external TLS and
backup ownership, no guarantee of first position, sellability, or profit.

- [ ] **Step 5: Verify docs GREEN**

```bash
npx tsx --test tests/deployment-artifacts.test.ts
npm run docs:check
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add docs/operations/deployment.md README.md docs/system-overview.html scripts/check-system-overview.ts tests/deployment-artifacts.test.ts
git commit -m "docs: publish deployment runbook (#45)"
```

### Task 9: Full verification and three-cycle PR delivery

**Files:**
- Verify all files in the branch

- [ ] **Step 1: Reinstall from the reviewed lockfile**

```bash
npm ci
```

Expected: clean install with only the explicitly documented residual production
audit advisories from PR #44.

- [ ] **Step 2: Run static and unit gates**

```bash
npm run build
npm run check
npm run lint
npm test
npm run docs:check
git diff --check origin/main...HEAD
```

Expected: zero failures. Local PostgreSQL skips are permitted only if the real
database suite is run in Step 3.

- [ ] **Step 3: Run real PostgreSQL and browser gates**

Create a unique temporary database, then run:

```bash
DEPLOY_TEST_DB=sol_token_listener_deploy_45_verify
createdb "$DEPLOY_TEST_DB"
TEST_DATABASE_URL="postgresql://127.0.0.1/$DEPLOY_TEST_DB" npm test
dropdb "$DEPLOY_TEST_DB"
npm run frontend:e2e
```

Expected: no backend skip, all frontend tests and Chromium E2E pass. Drop only
the exact temporary database after completion.

- [ ] **Step 4: Run deployment twice and inspect cleanup**

```bash
npm run deployment:smoke
npm run deployment:smoke
docker compose -f deploy/compose.yaml config --quiet
git status --short
```

Expected: both smokes pass, Compose is valid, and the worktree is clean.

- [ ] **Step 5: Independent reviews**

Dispatch a spec reviewer and a security/quality reviewer over
`origin/main...HEAD`. Resolve all Blocker/Major findings and technically valid
Minor findings before publication.

- [ ] **Step 6: Push and open the PR**

Create one PR closing #45. Include image digests, single-replica and observe-only
boundaries, migration/retention behavior, smoke evidence, and residual npm audit
status.

- [ ] **Step 7: Run exactly three GitHub review cycles maximum**

Request Codex review three times sequentially. Address actionable findings and
rerun CI, but never request a fourth review. Merge only with green checks, a
clean merge state, and zero unresolved non-outdated threads.

- [ ] **Step 8: Verify merged `main` and clean the owned worktree**

Fast-forward `main`, rerun the standard build/check/lint/test gate, then remove
only `.worktrees/feature-deployment-foundation-45` and its merged feature branch.

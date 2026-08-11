# Deployment Foundation Design

**Issue:** #45  
**Date:** 2026-08-11  
**Status:** approved through the standing recommendation-first instruction

## 1. Purpose

This change makes the existing Pump.fun observation and paper-trading system
reproducibly deployable without enabling transaction submission. It packages
the compiled backend and the independent operator frontend, starts PostgreSQL
in a private network, serializes schema migration, runs the existing retention
purge, and verifies the resulting deployment in CI.

The change does not alter token detection, qualification, paper decisions,
PumpSwap tracking, or Raydium CPMM behavior.

## 2. Current state

The application already provides the runtime primitives required by a safe
deployment:

- `npm run build` produces the backend, migrations, qualification profile, and
  frontend assets;
- configuration rejects live execution and private-key variables;
- `EXECUTION_MODE=observe` is the default;
- application startup is fail-closed and shutdown handles `SIGINT`/`SIGTERM`;
- PostgreSQL migrations are versioned, transactional, and replayable;
- `/api/v1/health` and resumable SSE are public read-only contracts;
- the frontend loads a bounded public `config.json` before making API calls;
- expired foundation data can already be purged transactionally.

The repository does not currently contain a container image, Compose contract,
static hosting configuration, migration deployment job, retention scheduler,
or an end-to-end deployment smoke test. The existing purge function is not
called by the production runtime.

## 3. Considered approaches

### 3.1 Selected: separate backend and frontend images with Compose

A multi-stage Dockerfile produces two runtime targets. The backend target runs
one compiled Node process as a non-root user. The frontend target serves static
assets through an unprivileged Nginx process and reverse-proxies the read-only
API and SSE endpoints. PostgreSQL, migration, application, retention, and
frontend are separate Compose services with explicit dependencies.

This keeps process ownership and failure states visible, preserves the
independent frontend boundary, and can later be translated to a managed
container platform.

### 3.2 Rejected: one all-in-one container

Bundling PostgreSQL, Node, and the static server would require an additional
process supervisor and would obscure readiness, logs, upgrades, and graceful
shutdown. It would also couple database persistence to an application image.

### 3.3 Deferred: Kubernetes or provider-specific manifests

High availability, leader election, managed secrets, certificates, and
provider load-balancer behavior require a selected deployment platform. Adding
those contracts now would create unvalidated operational complexity.

## 4. Deployment topology

```text
browser
  |
  | HTTP(S) :8080 in the reference deployment
  v
frontend (unprivileged Nginx)
  |-- static SPA, config.json, immutable hashed assets
  `-- /api/v1/* --------------------------.
                                             v
                                         app :3000
                                             |
                     .-----------------------+-----------------------.
                     v                       v                       v
              PostgreSQL :5432       Solana HTTP RPC         Solana WS RPC
              private network        deployment secret       deployment secret
                     ^
                     |
              migrate + retention
              compiled one-purpose commands
```

Only the frontend port is published by the reference Compose deployment.
PostgreSQL and the backend API are reachable only inside the Compose network.
TLS terminates at an external ingress or reverse proxy in production.

## 5. Image contract

### 5.1 Backend target

The backend uses a multi-stage Node 22.13 build:

1. install the exact lockfile with `npm ci`;
2. compile backend and frontend artifacts;
3. create a production-only dependency tree;
4. copy only production dependencies, `dist/`, package metadata, and required
   runtime configuration into the final image;
5. run as the pre-existing unprivileged Node user;
6. start `node dist/src/app.js` by default.

The runtime image must contain no source `.env`, Git metadata, worktrees,
fixtures, private keys, browser tooling, TypeScript runner, or npm cache.

The same immutable image runs the migration and retention commands. Those
commands use compiled JavaScript; they must not depend on `tsx` or other
development dependencies at runtime.

### 5.2 Frontend target

The frontend target copies only `frontend/dist` and reviewed Nginx
configuration into an unprivileged static-server image. It listens on port
`8080` and runs without root privileges.

Its behavior is explicit:

- `config.json` is served with `Cache-Control: no-store`;
- `index.html` is not cached as immutable content;
- fingerprinted assets are cached as immutable;
- real files return their bytes directly;
- unknown product routes fall back to `index.html`;
- `/api/v1/events` disables proxy buffering and caching and uses a long read
  timeout;
- all `/api/v1/*` routes proxy to the backend without introducing write
  methods or credentials.

## 6. Frontend runtime configuration

The existing absolute HTTP(S) `apiBaseUrl` contract remains supported for
separate-origin deployments. The schema additionally accepts exactly `/` to
mean the current browser origin. No other relative value is accepted.

The reference image ships:

```json
{ "apiBaseUrl": "/" }
```

At bootstrap, `/` is normalized to `window.location.origin` through an
explicit origin dependency that is testable outside the browser. This avoids
unsafe shell-based JSON generation and makes the same frontend image portable
behind any same-origin TLS endpoint.

## 7. Database migration and startup order

The reference sequence is:

```text
postgres healthy
  -> migrate exits successfully
     -> app and retention start
        -> frontend starts
```

The application always uses `POSTGRES_AUTO_MIGRATE=false` in this topology.
Migration is a separate one-shot service running the compiled migration
command.

`migrateDatabase` obtains a fixed PostgreSQL session advisory lock before it
reads or applies migration history and releases the lock in `finally`. A lost
process releases the session lock when PostgreSQL closes the connection. This
prevents two deployment jobs from racing while preserving per-migration
transactions and replay behavior.

V1 supports exactly one active listener application replica and one retention
worker. Horizontal listener scaling and leader election are out of scope.

## 8. Retention worker

The deployment introduces a compiled retention command around the existing
`purgeExpiredFoundationData` transaction.

The command:

- runs one purge immediately after startup;
- repeats at a bounded configurable interval, defaulting to 15 minutes;
- accepts `SIGINT` and `SIGTERM` and closes the shared database pool;
- never logs row contents, URLs, wallet addresses, or database credentials;
- logs one structured event containing only the aggregate deletion counters;
- returns non-zero after a startup or purge failure so the orchestrator can
  restart it;
- supports a one-shot mode for operations and tests.

The data rows continue to carry their existing four-hour `purge_after`
contract. The worker schedules deletion; it does not recalculate retention or
silently shorten existing lineage.

## 9. Health and graceful shutdown

The backend container health probe calls the real public health endpoint and
validates a bounded V1 JSON envelope. It requires:

- HTTP 200;
- API version `v1`;
- PostgreSQL status `AVAILABLE`;
- a recognized overall status.

It deliberately accepts `DEGRADED` when the listener is disabled in the CI
smoke environment, because `STOPPED` pipelines are then honest and expected.
Production monitoring must alert unless an enabled listener converges to `OK`.

Compose stop grace must exceed the configured 30-second listener shutdown
budget plus API and database cleanup. The reference value is 40 seconds.
The SSE shutdown frame remains part of the tested public contract.

## 10. Safe reference configuration

The deployment example contains no working external credential. It fixes:

- `EXECUTION_MODE=observe`;
- `PAPER_STRATEGY_ENABLED=false`;
- `POSTGRES_AUTO_MIGRATE=false`;
- `API_ENABLED=true`;
- `API_HOST=0.0.0.0` inside the private container network;
- `DATA_RETENTION_HOURS=4`;
- no private-key or keypair variable.

The production operator must provide database and RPC credentials outside Git.
The smoke test uses syntactically valid `.invalid` RPC URLs and
`LISTENER_ENABLED=false`, so it cannot contact Solana.

## 11. Deployment smoke test

A bounded Node orchestration script owns the Compose smoke lifecycle and always
runs `down --volumes` in `finally`. CI invokes it in a dedicated deployment job.

The smoke test proves:

1. both runtime targets build from a clean Docker context;
2. every runtime process is non-root;
3. PostgreSQL starts with an empty named volume and has no published port;
4. all 13 canonical migrations apply exactly once;
5. a second migration run keeps the same migration history;
6. the observe application starts without a wallet or private key;
7. real `/api/v1/health` reports PostgreSQL available and stopped pipelines;
8. SSE CORS allows `GET`, `HEAD`, `OPTIONS`, and `Last-Event-ID` only;
9. an open SSE session receives the server shutdown event on application stop;
10. the application restarts against the same database;
11. frontend `config.json` selects same-origin mode;
12. a direct SPA route returns `index.html` while a hashed asset stays a real
    immutable asset;
13. the one-shot retention command runs without exposing row data;
14. cleanup removes containers, networks, and volumes even after failure.

The existing Playwright suite remains the authority for browser cursor resume,
cursor expiry, resynchronization, and the absence of write requests.

## 12. CI and local verification

The existing quality and frontend E2E jobs remain unchanged in authority. A
new deployment-contract job runs the Compose smoke after checkout. Local
verification remains possible through one documented npm command.

The final gate is:

```text
npm ci
npm run build
npm run check
npm run lint
npm test with PostgreSQL
npm run frontend:e2e
npm run docs:check
npm run deployment:smoke
```

## 13. Operations documentation

`docs/operations/deployment.md` documents:

- prerequisites and exact startup/shutdown commands;
- external secret injection and prohibited key variables;
- migration, replay, and advisory-lock behavior;
- four-hour retention scheduling;
- health, logs, SSE, and restart verification;
- database backup before rollout and restore rehearsal;
- rollback to a previous immutable image without reversing schema migrations;
- same-origin proxying, TLS termination, and upstream timeouts;
- single-replica limitations;
- incident stop procedure that preserves the database volume.

The README links to the runbook and states that the reference deployment is an
observe/paper foundation, not a profit, sellability, or latency guarantee.

## 14. Security invariants

- No transaction signing, submission, wallet, or private-key path is added.
- `live` remains impossible through configuration.
- No secret is committed or copied into an image layer.
- No PostgreSQL port is published by the reference topology.
- The frontend contains public data only and has no credentialed CORS mode.
- Financial values and deletion counters retain their integer/string
  contracts.
- Raydium CPMM remains a secondary adapter and is neither deleted nor activated
  by deployment work.

## 15. Explicit non-goals

- Kubernetes, Terraform, or a cloud-provider template;
- automated TLS certificate issuance;
- automated PostgreSQL backup storage;
- multi-replica listener or retention leader election;
- production RPC selection or mainnet smoke traffic;
- frontend authentication;
- real trading or any Solana transaction;
- changes to qualification thresholds or paper strategy behavior.

## 16. Acceptance criteria

The design is accepted when the PR demonstrates all of the following:

- clean builds and tests on the supported Node floor;
- two non-root runtime targets with a minimal Docker context;
- empty-database migration and exact replay under a global migration lock;
- observe-mode startup without any private key;
- same-origin frontend/API/SSE operation with SPA fallback;
- scheduled use of the existing four-hour retention purge;
- deterministic Compose smoke cleanup;
- green existing backend, PostgreSQL, frontend, and Playwright suites;
- a deployment runbook with backup, restore, rollback, TLS, secret, and
  single-replica boundaries;
- no production domain behavior or execution capability change.

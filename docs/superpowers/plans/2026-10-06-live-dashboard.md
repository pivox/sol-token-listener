# Live Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator one read-only `/live` console page showing the live wallet balance, open positions, realized and unrealized PnL and the history of closed live positions, fed by a durable ledger written by the recovery runtime and served by a separate token-authenticated operator API process.

**Architecture:** Migration 061 adds the append-only `execution_live_position_ledger`; `commitSellReconciliation` appends one row in the transaction that closes a position (BUY and SELL `wallet_lamport_delta` read from the reconciliation evidence). A new read-only process `src/operator-api/` (role `sol_token_operator_reader`, bearer token, Host allowlist, one-origin CORS, GET/OPTIONS only) serves `GET /operator/v1/live/overview` in the public API envelope. The frontend adds `/live`, using `operatorApiBaseUrl` from `public/config.json` and a token kept in `sessionStorage`.

**Tech Stack:** TypeScript (Node >= 22.13, `node:test` through `tsx`), PostgreSQL 16, `pg`, React 19 + TanStack Query 5 + Zod 4 + Vitest (frontend workspace).

---

## Standing rules for the implementer

- Simplest approach, reuse main's machinery; no optional component. Commit after every task; never `git stash`.
- Work only in `/Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/live-dashboard-main` (branch `feature/live-dashboard-main`).
- Never touch any network, any real RPC, or a Postgres other than the dedicated test one below. Never use port 5432, never use port 55432, never use the compose project `sol-token-listener-test` (another session owns it), never start or stop a listener.
- Diffs in this plan are authoritative: apply them with `git apply` (save the block to a file first) or reproduce the `-`/`+` lines with the Edit tool. New files are given in full.
- All code below was typechecked, linted (`--max-warnings=0`) and run against a scratch copy of the repository before being written here.
- Every commit message body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Test environment

A dedicated, disposable PostgreSQL 16 on `127.0.0.1:55433` (compose project `sol-token-listener-live-dashboard-test`). `deploy/compose.yaml` sets no `container_name` and its volume `postgres-data` is scoped by the project name, so a distinct `-p` name gives a distinct container, network and volume; nothing collides with any other project.

```bash
cd /Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/live-dashboard-main

cat > /tmp/live-dashboard-compose.override.yaml <<'EOF'
services:
  postgres:
    ports: ["127.0.0.1:55433:5432"]
    networks: [internal, application]
EOF
cat > /tmp/live-dashboard-test.env <<'EOF'
POSTGRES_USER=test
POSTGRES_PASSWORD=test
POSTGRES_DB=sol_token_listener_test
POSTGRES_PASSWORD_URI_ENCODED=test
BACKEND_IMAGE=unused
FRONTEND_IMAGE=unused
SOLANA_HTTP_RPC_URL=http://127.0.0.1:1
SOLANA_WS_RPC_URL=ws://127.0.0.1:1
EOF

docker compose --env-file /tmp/live-dashboard-test.env -p sol-token-listener-live-dashboard-test \
  -f deploy/compose.yaml -f /tmp/live-dashboard-compose.override.yaml up -d --wait postgres
```

(`internal` is an internal-only network that cannot publish ports, hence the second network.) Every shell that runs a Postgres test must export:

```bash
export TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55433/sol_token_listener_test
```

Postgres tests skip silently when `TEST_DATABASE_URL` is unset, so a "pass" without the variable proves nothing; check the `skipped` counter. The role and provisioning tests need PostgreSQL 16 with a superuser that can `CREATEDB`: the `test` user of this container qualifies. Migration-heavy tests take minutes: run only the files named in each task. Some architecture tests read `dist/`; run `npm run build:backend` before them (Task 7 and Task 11 say when).

Cleanup when everything is finished, touching only this project:

```bash
docker compose --env-file /tmp/live-dashboard-test.env -p sol-token-listener-live-dashboard-test \
  -f deploy/compose.yaml -f /tmp/live-dashboard-compose.override.yaml down -v
```

## Deviations from the spec found while reading the code

| # | Spec statement | Reality in the code | Resolution in this plan |
|---|---|---|---|
| 1 | `sol_token_operator_reader` simply gains grants | The preflight source export (`src/preflight-source/database.ts`) runs as the same role and validates its authority *exactly* at every checkout (`EXECUTION_PREFLIGHT_SOURCE_TABLES`, `..._RESTRICTED_COLUMNS`); extra grants would make H2h refuse to start | Task 3 extends those two constants with the new tables/columns. Task 7 reuses the same wrapper (`createExecutionPreflightSourceDatabase`) for the operator API, so it gets the exact-authority check, `SET ROLE`, `search_path` and `session_replication_role` enforcement for free |
| 2 | Recovery gets `INSERT` on the ledger only | The writer reads `execution_live_positions.opened_at` and `base_amount_raw`, which the recovery role cannot `SELECT` (`LIVE_RECOVERY_DATABASE_AUTHORITY` is an exact column list) | Task 3 adds `SELECT (base_amount_raw, opened_at)` on `execution_live_positions` to the recovery grant and to `src/executor-live-recovery/database-authority.ts` |
| 3 | Spot price "in raw quote per raw base, computed with bigint and rounded down" | Per-raw-unit prices are about `2.8e-5` lamport, so the floored ratio is `0` for every real token | Task 4 computes the position *value* `remaining * quoteReserves / baseReserves` (one multiplication, one floor division) instead of a stored ratio |
| 4 | "Envelope identical to the public API" with the shared helpers | `writeJson` hard-codes `access-control-allow-origin: *`; `ApiErrorCode` has no `UNAUTHORIZED`; the frontend `apiFailureSchema` enum is closed | Task 6 passes the configured origin through `writeJson`'s `extraHeaders` (which override `*`), builds its own error body with the same shape, and Task 8 adds `UNAUTHORIZED` and `HOST_NOT_ALLOWED` to the frontend failure enum |
| 5 | "Ledger added to the existing REVOKE lists" | The list at `provision-executor-roles.sql` (~:1514) is pinned verbatim by a regex in `tests/executor-roles-provisioning.test.ts:250` | Task 3 adds a separate `REVOKE ALL ON TABLE execution_live_position_ledger FROM PUBLIC, ...` statement with the same role list immediately after it (same effect, no existing test rewritten) |
| 6 | Migration 061 plus the catalog | The migration head is pinned in about 45 places (startup validators, deployment smoke and its regex, ~35 tests, migration counts) | Task 1 ships a one-shot script that updates every pin deterministically and lists what must remain |
| 7 | "Simulation" badge elsewhere | The shell's existing label is `Simulation uniquement`, asserted by tests | Kept as is; only `/live` swaps it for `Live · lecture seule` |
| 8 | "Both evidence rows exist at that point" | The BUY evidence is purged 4 h after finalization; a position stuck `UNKNOWN` for more than 4 h would lose it | The ledger insert is an `INSERT ... SELECT ... JOIN` so a missing BUY evidence writes no row and never blocks the close (documented risk) |
| 9 | Environment of the operator API | `import 'dotenv/config'` would load a shared `.env` containing keys the process must refuse | `main.ts` loads only `.env.operator` (git-ignored by `.env.*`) when present, via `process.loadEnvFile` |
| 10 | Many concurrent browser polls | `createExecutorDatabase` allows one active client and throws on a second | The server serializes overview reads with a promise queue |
| 11 | `public/config.json` "gains" `operatorApiBaseUrl` | The shipped file is the production default | The schema accepts the optional key; the shipped file is left unchanged and the README documents the key |

## File map

| Path | Action | Task |
|---|---|---|
| `migrations/061_execution_live_position_ledger.sql` | create | 1 |
| `src/execution-migrations/live-catalog.ts`, `src/executor-live/startup-validator.ts`, `src/executor-live-recovery/startup-validator.ts`, `scripts/deployment-smoke.mjs`, ~35 migration/startup tests | edit by script (head pin, counts) | 1 |
| `tests/transaction-inbox-pool-trade-migration.test.ts` | edit | 1 |
| `tests/execution-live-position-ledger-migration.test.ts` | create | 1 |
| `src/storage/execution-live.repository.ts` | edit (`LIVE_POSITION_LEDGER_INSERT_SQL`, call in `commitSellReconciliation`) | 2 |
| `tests/execution-live-sell-reconciliation.test.ts` | edit | 2 |
| `scripts/provision-executor-roles.sql` | edit (grants, REVOKE) | 3 |
| `src/executor-live-recovery/database-authority.ts` | edit | 3 |
| `src/preflight-source/database.ts` | edit (exact reader authority) | 3 |
| `tests/listener-database-authority.test.ts` | edit | 3 |
| `tests/live-ledger-roles.test.ts` | create (extended in Task 5) | 3, 5 |
| `src/api/cursor.ts`, `tests/api-cursor.test.ts` | edit (ledger cursor) | 4 |
| `src/operator-api/pnl.ts`, `balance-cache.ts`, `rpc-balance.ts` | create | 4 |
| `tests/operator-api-pure.test.ts` | create | 4 |
| `src/operator-api/repository.ts`, `tests/operator-api-repository.test.ts` | create | 5 |
| `src/operator-api/server.ts`, `tests/operator-api-server.test.ts` | create | 6 |
| `src/operator-api/config.ts`, `database.ts`, `main.ts` | create | 7 |
| `tests/operator-api-config.test.ts`, `tests/operator-api-architecture.test.ts` | create | 7 |
| `package.json`, `docs/operations/executor-live-canary.md` | edit | 7 |
| `frontend/src/data/api-client.ts`, `api-schemas.ts`, `runtime-config.ts`(+test), `query-keys.ts`, `queries.ts`, `frontend/tests/fixtures/api.ts` | edit | 8 |
| `frontend/src/data/operator-schemas.ts`, `operator-client.ts`(+test), `operator-token.ts`(+test) | create | 8 |
| `frontend/src/features/live/format-sol.ts`, `token-prompt.tsx`, `live-page.tsx`(+test) | create | 9 |
| `frontend/src/app/app.tsx`, `app-shell.tsx`, `app.test.tsx`, `frontend/src/main.tsx`, `frontend/README.md`, `README.md` | edit | 10 |

---

### Task 1: Migration 061, catalog and head pins

**Files:**
- Create: `migrations/061_execution_live_position_ledger.sql`
- Create: `tests/execution-live-position-ledger-migration.test.ts`
- Modify by script: `src/execution-migrations/live-catalog.ts` (:68 is the 060 line), `src/executor-live/startup-validator.ts` (:34, :592), `src/executor-live-recovery/startup-validator.ts` (:39, :265), `scripts/deployment-smoke.mjs` (:115), `tests/executor-live-main.integration.test.ts` (:545), and the migration tests listed by the script
- Modify: `tests/transaction-inbox-pool-trade-migration.test.ts` (:8, :28-29)

Facts verified: `LIVE_EXECUTION_MIGRATION_CATALOG` (`src/execution-migrations/live-catalog.ts`) must list every migration with its sha256 (`validateLiveExecutionMigrationFiles` rejects a missing or changed file); both live startup validators pin `migrationHead`; `reject_execution_live_immutable_update()` already exists (`migrations/036_execution_live_canary.sql:829`, SQLSTATE `55000`) and is reused for the immutability trigger.

- [ ] **Step 0: confirm 061 is still free**

```bash
git fetch origin && git ls-tree --name-only origin/main migrations/ | tail -3
```

Expected last line: `migrations/060_listener_tracked_pool_checkpoints.sql`. If another migration numbered 061 (or higher) exists, use the next free number *for this one step*: rename the SQL file, its catalog line, the constants `migrationName` below, `NEW` in the bump script and every `061_execution_live_position_ledger.sql` string in this plan consistently. Everything else in the plan says 061.

- [ ] **Step 1: write the failing migration test**

Create `tests/execution-live-position-ledger-migration.test.ts`:

````ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { LIVE_EXECUTION_MIGRATION_CATALOG } from '../src/execution-migrations/live-catalog.js';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '061_execution_live_position_ledger.sql';
const wallet = '11111111111111111111111111111111';
const mint = 'So11111111111111111111111111111111111111112';

void test('061 defines an append-only ledger and the catalog pins it', async () => {
  const sql = await readFile(new URL(`../migrations/${migrationName}`, import.meta.url), 'utf8');
  for (const fragment of [
    'CREATE TABLE IF NOT EXISTS execution_live_position_ledger',
    'position_id TEXT PRIMARY KEY',
    'net_lamports = entry_wallet_lamport_delta + exit_wallet_lamport_delta',
    'BEFORE UPDATE OR DELETE ON execution_live_position_ledger',
    'reject_execution_live_immutable_update()',
  ]) assert.ok(sql.includes(fragment), `missing migration contract: ${fragment}`);
  assert.doesNotMatch(sql, /\bREFERENCES\b/u, 'the purged position must not be referenced');
  assert.doesNotMatch(sql, /\b(?:DELETE FROM|TRUNCATE|DROP TABLE)\b/u);
  assert.equal(LIVE_EXECUTION_MIGRATION_CATALOG.at(-1)?.name, migrationName);
});

void test('061 stores one immutable, arithmetically consistent row per closed position', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await insertLedger(pool, {});
    const stored = await pool.query(`SELECT net_lamports::TEXT AS net_lamports,
      recorded_at IS NOT NULL AS recorded FROM execution_live_position_ledger`);
    assert.deepEqual(stored.rows, [{ net_lamports: '-4205', recorded: true }]);

    await assert.rejects(insertLedger(pool, {}), { code: '23505' });
    for (const override of [
      { id: 'b', net: '-4204' },
      { id: 'c', closedAt: '2026-10-06T09:59:59.000Z' },
      { id: 'd', exitSignature: 'not-a-signature' },
      { id: 'e', base: '0' },
      { id: 'f', entry: '-5000.5', net: '-4205.5' },
    ]) {
      await assert.rejects(insertLedger(pool, override), { code: '23514' }, JSON.stringify(override));
    }
    await assert.rejects(pool.query('UPDATE execution_live_position_ledger SET net_lamports=0'),
      { code: '55000' });
    await assert.rejects(pool.query('DELETE FROM execution_live_position_ledger'), { code: '55000' });
    assert.equal((await pool.query('SELECT 1 FROM execution_live_position_ledger')).rowCount, 1);
  });
});

async function insertLedger(
  pool: InstanceType<typeof pg.Pool>,
  overrides: Partial<Record<'id' | 'closedAt' | 'exitSignature' | 'base' | 'entry' | 'net', string>>,
): Promise<unknown> {
  const values = {
    id: 'a', closedAt: '2026-10-06T10:05:00.000Z', exitSignature: '2'.repeat(64),
    base: '95', entry: '-5000', net: '-4205', ...overrides,
  };
  return pool.query(`INSERT INTO execution_live_position_ledger (
    position_id,wallet_public_key,mint,opened_at,closed_at,base_amount_raw,
    entry_wallet_lamport_delta,exit_wallet_lamport_delta,net_lamports,
    entry_signature,exit_signature
  ) VALUES ('execution_live_position_'||repeat($1,64),$2,$3,TIMESTAMPTZ '2026-10-06T10:00:00.000Z',
    $4::TIMESTAMPTZ,$5::NUMERIC,$6::NUMERIC,795,$7::NUMERIC,$8,$9)`, [
    values.id, wallet, mint, values.closedAt, values.base, values.entry, values.net,
    '1'.repeat(64), values.exitSignature,
  ]);
}

async function withTemporarySchema(
  context: TestContext,
  run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live position ledger migration test skipped');
    return;
  }
  const schema = `live_position_ledger_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1,
  });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await run(pool);
  } finally {
    await pool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
  }
}
````

- [ ] **Step 2: run it and see it fail**

```bash
export TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55433/sol_token_listener_test
npx tsx --test tests/execution-live-position-ledger-migration.test.ts
```

Expected: both tests fail (`ENOENT ... migrations/061_execution_live_position_ledger.sql`; `relation "execution_live_position_ledger" does not exist`).

- [ ] **Step 3: create the migration**

Create `migrations/061_execution_live_position_ledger.sql`:

````sql
-- Durable, append-only ledger of closed live positions. execution_live_positions and the
-- reconciliation evidence are purged four hours after close; this table is written once by
-- the recovery runtime in the transaction that closes the position and is never purged.
-- position_id deliberately has no foreign key: the position row it describes is purged.
CREATE TABLE IF NOT EXISTS execution_live_position_ledger (
  position_id TEXT PRIMARY KEY,
  wallet_public_key TEXT NOT NULL,
  mint TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL,
  base_amount_raw NUMERIC NOT NULL,
  entry_wallet_lamport_delta NUMERIC NOT NULL,
  exit_wallet_lamport_delta NUMERIC NOT NULL,
  net_lamports NUMERIC NOT NULL,
  entry_signature TEXT NOT NULL,
  exit_signature TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  CONSTRAINT execution_live_position_ledger_identity_check CHECK (
    position_id ~ '^execution_live_position_[0-9a-f]{64}$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND entry_signature ~ '^[1-9A-HJ-NP-Za-km-z]{32,128}$'
    AND exit_signature ~ '^[1-9A-HJ-NP-Za-km-z]{32,128}$'
  ),
  CONSTRAINT execution_live_position_ledger_amounts_check CHECK (
    base_amount_raw <> 'NaN'::NUMERIC AND base_amount_raw > 0
    AND base_amount_raw = trunc(base_amount_raw) AND scale(base_amount_raw) = 0
    AND entry_wallet_lamport_delta <> 'NaN'::NUMERIC
    AND entry_wallet_lamport_delta = trunc(entry_wallet_lamport_delta)
    AND scale(entry_wallet_lamport_delta) = 0
    AND exit_wallet_lamport_delta <> 'NaN'::NUMERIC
    AND exit_wallet_lamport_delta = trunc(exit_wallet_lamport_delta)
    AND scale(exit_wallet_lamport_delta) = 0
    AND net_lamports = entry_wallet_lamport_delta + exit_wallet_lamport_delta
  ),
  CONSTRAINT execution_live_position_ledger_temporal_check CHECK (
    isfinite(opened_at) AND isfinite(closed_at) AND closed_at >= opened_at
    AND date_trunc('milliseconds', closed_at) = closed_at
  )
);

CREATE INDEX IF NOT EXISTS execution_live_position_ledger_wallet_closed_idx
  ON execution_live_position_ledger (wallet_public_key, closed_at DESC, position_id DESC);

DROP TRIGGER IF EXISTS execution_live_position_ledger_immutable
  ON execution_live_position_ledger;
CREATE TRIGGER execution_live_position_ledger_immutable
  BEFORE UPDATE OR DELETE ON execution_live_position_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_execution_live_immutable_update();
````

- [ ] **Step 4: register it and move every head pin**

Create `/tmp/bump-migration-head.mjs` (outside the repository) with this content, then run it from the repository root. It appends the catalog line with the real sha256 of the file just written, appends the new name to the six name lists, extends the regular expression that pins the deployment smoke list, moves every "latest migration" pin and count, and fails if any edit changes nothing.

````js
// Run from the repository root: node /tmp/bump-migration-head.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const OLD = '060_listener_tracked_pool_checkpoints.sql';
const NEW = '061_execution_live_position_ledger.sql';

function edit(path, transform) {
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`no change in ${path}`);
  writeFileSync(path, after);
}

// 1. Catalog: append the checksum of the migration file just written.
const hash = createHash('sha256').update(readFileSync(`migrations/${NEW}`)).digest('hex');
edit('src/execution-migrations/live-catalog.ts', (text) => text.replace(
  /^(060_listener_tracked_pool_checkpoints\.sql [0-9a-f]{64})$/mu,
  `$1\n${NEW} ${hash}`,
));

// 2. Tests and sources whose assertion lists the migration names one per line: add the new
//    name after the old one.
const listFiles = [
  'tests/paper-claim-scheduler-migration.test.ts',
  'tests/paper-finality-replay-migration.test.ts',
  'tests/execution-wallet-snapshot-refresh-migration.test.ts',
  'tests/api-event-stream-migration.test.ts',
  'tests/provider-affine-finality-migration.test.ts',
  'scripts/deployment-smoke.mjs',
];
for (const path of listFiles) {
  edit(path, (text) => text.replace(
    /^([ \t]+)'060_listener_tracked_pool_checkpoints\.sql',\n/mu,
    `$&$1'${NEW}',\n`,
  ));
}
// The deployment smoke is also pinned by a regular expression in the live main test.
edit('tests/executor-live-main.integration.test.ts', (text) => text.replace(
  "{2}'060_listener_tracked_pool_checkpoints\\.sql',\\n",
  (match) => `${match} {2}'061_execution_live_position_ledger\\.sql',\\n`,
));

// 3. Every other occurrence is a "latest migration" pin: move it to the new head.
const headFiles = [
  'src/executor-live/startup-validator.ts',
  'src/executor-live-recovery/startup-validator.ts',
  'tests/migration-lock.test.ts',
  'tests/execution-preflight-intent-preparation-migration.test.ts',
  'tests/websocket-health-migration.test.ts',
  'tests/participant-analytics-migration.test.ts',
  'tests/execution-risk-migration.test.ts',
  'tests/executor-live-startup.test.ts',
  'tests/execution-wallet-snapshot-refresh-migration.test.ts',
  'tests/execution-intent-lineage-migration.test.ts',
  'tests/paper-entry-boundary-migration.test.ts',
  'tests/transaction-inbox-urgent-fairness-migration.test.ts',
  'tests/transaction-inbox-bounded-tracking-migration.test.ts',
  'tests/execution-live-orchestration-migration.test.ts',
  'tests/transaction-ingestion-migration.test.ts',
  'tests/execution-dry-run-migration.test.ts',
  'tests/transaction-inbox-worker-admission-migration.test.ts',
  'tests/transaction-inbox-timestamp-migration.test.ts',
  'tests/creation-entry-migration.test.ts',
  'tests/execution-preflight-intent-pair-migration.test.ts',
  'tests/paper-mvp-migration.test.ts',
  'tests/social-persistence-retry-migration.test.ts',
  'tests/execution-operations-migration.test.ts',
  'tests/paper-global-position-cap-migration.test.ts',
  'tests/wallet-graph-migration.test.ts',
  'tests/execution-simulation-migration.test.ts',
  'tests/execution-intent-migration.test.ts',
  'tests/execution-canary-migration.test.ts',
  'tests/transaction-inbox-tracked-trade-migration.test.ts',
  'tests/transaction-inbox-retry-migration.test.ts',
  'tests/executor-live-recovery-startup.test.ts',
];
for (const path of headFiles) {
  edit(path, (text) => text.replaceAll(OLD, NEW));
}
// The wallet-snapshot test mixes a head pin and a list; the list entry was already extended
// above, so the replacement just made the old list entry a duplicate of the new one.
edit('tests/execution-wallet-snapshot-refresh-migration.test.ts', (text) => text.replace(
  `      '${NEW}',\n      '${NEW}',\n`,
  `      '${OLD}',\n      '${NEW}',\n`,
));

// 2b. Lists that end with the "latest" constant: the previous head becomes an explicit entry.
for (const path of [
  'tests/execution-dry-run-migration.test.ts',
  'tests/execution-simulation-migration.test.ts',
  'tests/websocket-health-migration.test.ts',
]) {
  edit(path, (text) => text.replace(
    /^([ \t]+)'059_transaction_inbox_qualification_attribution\.sql',\n([ \t]+)latestMigrationName,\n/mu,
    `$1'059_transaction_inbox_qualification_attribution.sql',\n$1'${OLD}',\n$2latestMigrationName,\n`,
  ));
}

// 4. Migration counts.
for (const path of [
  'tests/migration-lock.test.ts',
  'tests/executor-live-startup.test.ts',
  'tests/executor-live-recovery-startup.test.ts',
  'tests/transaction-inbox-urgent-fairness-migration.test.ts',
  'tests/transaction-inbox-bounded-tracking-migration.test.ts',
  'tests/transaction-inbox-worker-admission-migration.test.ts',
  'tests/transaction-inbox-tracked-trade-migration.test.ts',
]) edit(path, (text) => text.replace(/\blength, 60\)/gu, 'length, 61)'));
console.log('migration head bumped to', NEW, hash);
````

```bash
node /tmp/bump-migration-head.mjs
grep -rn "060_listener_tracked_pool_checkpoints" src tests scripts | cut -c1-120
```

Expected: the script prints `migration head bumped to 061_execution_live_position_ledger.sql <sha256>`; the grep lists only the catalog line (`live-catalog.ts:68`), `tests/transaction-inbox-pool-trade-migration.test.ts:8`, `scripts/deployment-smoke.mjs`, the regex line of `tests/executor-live-main.integration.test.ts`, and the `060` entries inside the lists of `paper-claim-scheduler`, `paper-finality-replay`, `execution-wallet-snapshot-refresh`, `api-event-stream`, `provider-affine-finality`, `execution-dry-run`, `execution-simulation` and `websocket-health` tests (each followed by the 061 entry). No `at(-1)` or `migrationHead` pin may still say 060.

- [ ] **Step 5: fix the 060-specific test, which asserted "the latest migration"**

Apply to `tests/transaction-inbox-pool-trade-migration.test.ts`:

````diff
--- a/tests/transaction-inbox-pool-trade-migration.test.ts
+++ b/tests/transaction-inbox-pool-trade-migration.test.ts
@@ -24,8 +24,8 @@
 void test('060 accepts pool trade hints with a canonical mint and keeps checkpoints bounded', async (context) => {
   await withTemporarySchema(context, async (pool) => {
     await migrateDatabase({ pool });
-    assert.equal((await pool.query('SELECT version FROM migration_history ORDER BY version DESC LIMIT 1'))
-      .rows[0]?.version, migrationName);
+    assert.equal((await pool.query('SELECT 1 FROM migration_history WHERE version = $1',
+      [migrationName])).rowCount, 1);
     await seedPool(pool, 'POOL');
 
     await pool.query(`INSERT INTO listener_tracked_pool_checkpoints (pool_address, slot, signature, updated_at)
````

- [ ] **Step 6: run the migration, startup and pin tests**

```bash
export TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55433/sol_token_listener_test
npx tsx --test --test-concurrency=4 tests/*migration*.test.ts tests/executor-live-startup.test.ts tests/executor-live-recovery-startup.test.ts
```

Expected (several minutes): `fail 0`, `skipped` equal to the tests that skip without a database in those files only (3 at the time of writing), including `2 tests pass` for the new file, the catalog hash check in `executor-live-startup.test.ts` and the `migration-lock` test with `canonical.length === 61`.

- [ ] **Step 7: commit**

```bash
git add migrations/061_execution_live_position_ledger.sql tests src scripts
git commit -m "feat(migrations): add the durable live position ledger (061)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Append the ledger row when a live position closes

**Files:**
- Modify: `src/storage/execution-live.repository.ts` (new constant just above `commitSellReconciliation`, :4500; call after the `requiredUpdates` check, ~:4960)
- Modify: `tests/execution-live-sell-reconciliation.test.ts` (new test before the `'SELL MATCHED direct from ACCEPTED ...'` test, ~:158)

Facts verified: `commitSellReconciliation` closes the position (`state='CLOSED'`, `closed_at` from `finalizedAtMs`) and consumes capabilities in one transaction (`this.transaction`, :1411). `position.entry_reconciliation_fingerprint` equals the BUY `evidence_fingerprint` (`createEntryRecords`, :4465). A replayed SELL returns early (`replay !== undefined`, ~:4547) so the `ON CONFLICT DO NOTHING` is a second line of defence. The statement needs only `INSERT` on the ledger (no conflict target, no `RETURNING`) plus the column `SELECT`s granted in Task 3.

- [ ] **Step 1: write the failing test**

````diff
--- a/tests/execution-live-sell-reconciliation.test.ts
+++ b/tests/execution-live-sell-reconciliation.test.ts
@@ -155,6 +155,45 @@
     });
   });
 
+void test('SELL MATCHED appends one immutable ledger row and a replay appends none',
+  async (context) => {
+    const databaseUrl = requiredDatabaseUrl(context);
+    if (databaseUrl === null) return;
+    await withTemporarySchema(databaseUrl, async (pool) => {
+      const fixture = await createSellFixture(pool, 'ACCEPTED');
+      const matched = sellEvidence(fixture, 'MATCHED', fixture.observedAtMs);
+      assert.deepEqual((await pool.query('SELECT 1 FROM execution_live_position_ledger')).rows, []);
+
+      await fixture.live.commitReconciliation(fixture.claim, matched);
+      await fixture.live.commitReconciliation(fixture.claim, matched);
+
+      const ledger = await pool.query(`SELECT
+        ledger.base_amount_raw::TEXT AS base_amount_raw,
+        ledger.entry_wallet_lamport_delta::TEXT AS entry_wallet_lamport_delta,
+        ledger.exit_wallet_lamport_delta::TEXT AS exit_wallet_lamport_delta,
+        ledger.net_lamports::TEXT AS net_lamports,
+        ledger.entry_signature,ledger.exit_signature,
+        ledger.wallet_public_key=position.wallet_public_key AS same_wallet,
+        ledger.mint=position.mint AS same_mint,
+        ledger.opened_at=position.opened_at AS same_opened_at,
+        ledger.closed_at=position.closed_at AS same_closed_at
+        FROM execution_live_position_ledger ledger
+        JOIN execution_live_positions position ON position.position_id=ledger.position_id
+        WHERE position.state='CLOSED'`);
+      assert.deepEqual(ledger.rows, [{
+        base_amount_raw: '95', entry_wallet_lamport_delta: '-5000',
+        exit_wallet_lamport_delta: '795', net_lamports: '-4205',
+        entry_signature: fixture.buyEvidence.signature,
+        exit_signature: fixture.artifact.signature,
+        same_wallet: true, same_mint: true, same_opened_at: true, same_closed_at: true,
+      }]);
+      await assert.rejects(pool.query('UPDATE execution_live_position_ledger SET net_lamports=0'),
+        { code: '55000' });
+      await assert.rejects(pool.query('DELETE FROM execution_live_position_ledger'),
+        { code: '55000' });
+    });
+  });
+
 void test('SELL MATCHED direct from ACCEPTED journals confirmation before success',
   async (context) => {
     const databaseUrl = requiredDatabaseUrl(context);
````

- [ ] **Step 2: run it and see it fail**

```bash
export TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55433/sol_token_listener_test
npx tsx --test --test-name-pattern "appends one immutable ledger row" tests/execution-live-sell-reconciliation.test.ts
```

Expected: FAIL with `AssertionError ... deepEqual` (`ledger.rows` is `[]`, one row expected). The test passes the migration because Task 1 is applied.

- [ ] **Step 3: implement**

Apply to `src/storage/execution-live.repository.ts`:

````diff
--- a/src/storage/execution-live.repository.ts
+++ b/src/storage/execution-live.repository.ts
@@ -4497,6 +4497,26 @@
   return Object.freeze({ position, authorization });
 }
 
+// Appends the durable, never-purged result of a closed live position. The BUY evidence is
+// still retained when the position closes (holding time is at most 15 minutes and evidence
+// is purged four hours after finalization); without it no row is written. ON CONFLICT DO
+// NOTHING (without a conflict target, so no SELECT privilege on the ledger is needed)
+// keeps a replayed close from failing. $1 closed-at epoch ms, $2 exit wallet lamport delta,
+// $3 exit signature, $4 position id.
+export const LIVE_POSITION_LEDGER_INSERT_SQL = `INSERT INTO execution_live_position_ledger (
+  position_id,wallet_public_key,mint,opened_at,closed_at,base_amount_raw,
+  entry_wallet_lamport_delta,exit_wallet_lamport_delta,net_lamports,
+  entry_signature,exit_signature
+) SELECT position.position_id,position.wallet_public_key,position.mint,position.opened_at,
+    TIMESTAMPTZ 'epoch'+($1::BIGINT*INTERVAL '1 millisecond'),position.base_amount_raw,
+    buy.wallet_lamport_delta,$2::NUMERIC,buy.wallet_lamport_delta+$2::NUMERIC,
+    buy.signature,$3::TEXT
+  FROM execution_live_positions position
+  JOIN execution_reconciliation_evidence buy
+    ON buy.evidence_fingerprint=position.entry_reconciliation_fingerprint AND buy.side='BUY'
+  WHERE position.position_id=$4::TEXT
+  ON CONFLICT DO NOTHING`;
+
 async function commitSellReconciliation(
   client: DatabaseClient,
   claim: ClaimedExecutionIntent,
@@ -4942,6 +4962,9 @@
   if (requiredUpdates.some((result) => result.rowCount !== 1)) {
     throw failure('CONFLICT');
   }
+  await client.query(LIVE_POSITION_LEDGER_INSERT_SQL, [
+    finalizedAtMs, evidence.walletLamportDelta.toString(), evidence.signature, row.position_id,
+  ]);
   await insertLiveStateEvent(
     client, artifact, 'CONFIRMED', 'RECONCILED', 'INTENT_SUCCEEDED', finalizedAtMs,
   );
````

- [ ] **Step 4: run the new test, then the whole file and the contract tests**

```bash
export TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55433/sol_token_listener_test
npx tsx --test --test-name-pattern "appends one immutable ledger row" tests/execution-live-sell-reconciliation.test.ts
npx tsx --test tests/execution-live-sell-reconciliation.test.ts tests/execution-live-repository-contract.test.ts tests/worker-tracking-mint-lock-architecture.test.ts
```

Expected: first command `pass 1`; second `fail 0` (the SELL file has 11 tests including the new one).

- [ ] **Step 5: commit**

```bash
git add src/storage/execution-live.repository.ts tests/execution-live-sell-reconciliation.test.ts
git commit -m "feat(execution-live): append the durable ledger row when a live position closes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Role grants for the ledger and the console reads

**Files:**
- Create: `tests/live-ledger-roles.test.ts`
- Modify: `scripts/provision-executor-roles.sql` (recovery grants ~:1190-1264, REVOKE list ~:1514-1526, operator reader grants ~:2519-2535)
- Modify: `src/executor-live-recovery/database-authority.ts` (positions entry :207, new ledger entry)
- Modify: `src/preflight-source/database.ts` (:13 and :40)
- Modify: `tests/listener-database-authority.test.ts` (:60)

Facts verified: provisioning first revokes every table privilege from each role, then grants; a new table therefore starts with no grant for anyone. The recovery startup validator compares the role's effective column privileges with `LIVE_RECOVERY_DATABASE_AUTHORITY` (sorted sets), so grants and authority must change together. The H2h export validates the reader's exact table list and the exact restricted column list at each checkout; PostgreSQL orders `information_schema.table_privileges` by table name, so the new names must be inserted in alphabetical position (`bonding_curve_snapshots` first, the ledger after `execution_exposure_reservations`, `market_pools` and `market_reserve_snapshots` before `migration_history`; `execution_live_positions` between `execution_intents` and `execution_preflight_...`).

- [ ] **Step 1: write the failing role test**

Create `tests/live-ledger-roles.test.ts` (the first version; Task 5 extends it):

````ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';
import { LIVE_POSITION_LEDGER_INSERT_SQL } from '../src/storage/execution-live.repository.js';
import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';

const scriptUrl = new URL('../scripts/provision-executor-roles.sql', import.meta.url);
const databaseSourceUrl = new URL('../src/storage/database.ts', import.meta.url);

void test('only the recovery role inserts and only the operator reader selects the ledger', async () => {
  const sql = await readFile(scriptUrl, 'utf8');
  const executable = sql.replace(/--[^\r\n]*/gu, ' ');
  assert.match(executable, /GRANT INSERT \(\s*position_id,wallet_public_key,mint,opened_at,closed_at,base_amount_raw,\s*entry_wallet_lamport_delta,exit_wallet_lamport_delta,net_lamports,\s*entry_signature,exit_signature\s*\)\s*ON TABLE execution_live_position_ledger TO sol_token_executor_live_recovery;/u);
  assert.match(executable, /REVOKE ALL ON TABLE execution_live_position_ledger\s+FROM PUBLIC,sol_token_listener_writer,sol_token_executor_worker,\s+sol_token_executor_operations,sol_token_operator_reader,sol_token_public_api;/u);
  assert.match(executable, /execution_live_position_ledger,\s+bonding_curve_snapshots,\s+market_pools,\s+market_reserve_snapshots,\s+migration_history\s+TO sol_token_operator_reader/u);
  assert.match(executable, /GRANT SELECT \(\s*position_id,wallet_public_key,mint,quote_mint,quote_cost_raw,base_amount_raw,\s*remaining_base_raw,fee_lamports,opened_at,exit_deadline_at,state,closed_at\s*\)\s*ON TABLE execution_live_positions TO sol_token_operator_reader;/u);
  for (const statement of executable.split(';')) {
    if (!/\bGRANT\b/iu.test(statement) || !statement.includes('execution_live_position_ledger')) continue;
    assert.match(statement, /\bTO\s+sol_token_(?:executor_live_recovery|operator_reader)\s*$/u);
    assert.doesNotMatch(statement, /\b(?:DELETE|UPDATE|TRUNCATE|ALL)\b/iu);
  }
});

void test('retention never purges the ledger', async () => {
  assert.doesNotMatch(await readFile(databaseSourceUrl, 'utf8'), /execution_live_position_ledger/u);
});

void test('PostgreSQL 16 grants on the live position ledger are exact', async (context) => {
  await withProvisionedDatabase(context, async (pool) => {
    const recovery = 'sol_token_executor_live_recovery';
    const reader = 'sol_token_operator_reader';
    // Privileges are checked at execution time even when no row matches.
    assert.equal(await probe(pool, recovery, LIVE_POSITION_LEDGER_INSERT_SQL,
      ['1', '795', 'signature', 'execution_live_position_missing']), 'allowed');
    for (const statement of [
      'SELECT 1 FROM execution_live_position_ledger',
      'UPDATE execution_live_position_ledger SET net_lamports=0',
      'DELETE FROM execution_live_position_ledger',
    ]) assert.equal(await probe(pool, recovery, statement), 'denied', statement);

    for (const statement of [
      'SELECT position_id,net_lamports,entry_signature FROM execution_live_position_ledger',
      'SELECT position_id,state,opened_at,remaining_base_raw FROM execution_live_positions',
      'SELECT mint,virtual_quote_reserves_raw FROM bonding_curve_snapshots',
      'SELECT pool_address,base_mint FROM market_pools',
      'SELECT pool_address,effective_quote_reserves_raw FROM market_reserve_snapshots',
    ]) assert.equal(await probe(pool, reader, statement), 'allowed', statement);
    for (const statement of [
      'DELETE FROM execution_live_position_ledger',
      'UPDATE execution_live_position_ledger SET net_lamports=0',
      'SELECT exit_reconciliation_fingerprint FROM execution_live_positions',
      'SELECT signed_transaction_bytes FROM execution_signed_transactions',
    ]) assert.equal(await probe(pool, reader, statement), 'denied', statement);
    assert.equal(await probe(pool, reader, LIVE_POSITION_LEDGER_INSERT_SQL,
      ['1', '795', 'signature', 'execution_live_position_missing']), 'denied');

    for (const role of [
      'sol_token_public_api', 'sol_token_listener_writer', 'sol_token_executor_worker',
      'sol_token_executor_operations', 'sol_token_executor_readiness',
      'sol_token_executor_live', 'sol_token_retention_worker',
    ]) assert.equal(
      await probe(pool, role, 'SELECT 1 FROM execution_live_position_ledger'), 'denied', role,
    );
  });
});

async function probe(
  pool: InstanceType<typeof pg.Pool>,
  role: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<'allowed' | 'denied'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(text, [...values]);
    return 'allowed';
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42501') {
      return 'denied';
    }
    throw error;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function withProvisionedDatabase(
  context: TestContext,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const configuredUrl = process.env.TEST_DATABASE_URL;
  if (configuredUrl === undefined || configuredUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL is not configured.');
    return;
  }
  const maintenance = new pg.Pool({ connectionString: configuredUrl });
  const capability = (await maintenance.query<{
    readonly rolsuper: boolean; readonly rolcreatedb: boolean; readonly version: number;
  }>(`SELECT rolsuper,rolcreatedb,current_setting('server_version_num')::INTEGER AS version
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (!capability?.rolsuper || !capability.rolcreatedb || capability.version < 160_000) {
    await maintenance.end();
    context.skip('PostgreSQL 16 superuser with CREATEDB is required.');
    return;
  }
  const release = await acquireExecutorRoleTestLock(maintenance);
  const databaseName = `live_ledger_roles_${randomUUID().replaceAll('-', '')}`;
  const isolatedUrl = new URL(configuredUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  let isolated: InstanceType<typeof pg.Pool> | undefined;
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    isolated = new pg.Pool({ connectionString: isolatedUrl.href });
    await migrateDatabase({ pool: isolated });
    const provisioningSql = await readFile(scriptUrl, 'utf8');
    await isolated.query(provisioningSql);
    await isolated.query(provisioningSql);
    await callback(isolated);
  } finally {
    try {
      await isolated?.end();
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      try { await release(); } finally { await maintenance.end(); }
    }
  }
}
````

- [ ] **Step 2: run it and see it fail**

```bash
export TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55433/sol_token_listener_test
npx tsx --test tests/live-ledger-roles.test.ts
```

Expected: the first test fails (`The input did not match the regular expression`), the PostgreSQL test fails (`allowed` expected, got a permission error), `retention never purges the ledger` passes.

- [ ] **Step 3: provisioning SQL**

````diff
--- a/scripts/provision-executor-roles.sql
+++ b/scripts/provision-executor-roles.sql
@@ -1204,7 +1204,8 @@
 GRANT SELECT (
   position_id,buy_intent_id,generation_id,armament_id,wallet_public_key,mint,
   quote_mint,state,state_revision,exit_intent_id,remaining_base_raw,
-  quote_cost_raw,exit_deadline_at,entry_reconciliation_fingerprint
+  quote_cost_raw,base_amount_raw,opened_at,exit_deadline_at,
+  entry_reconciliation_fingerprint
 ), INSERT (
   position_id,payload_version,buy_intent_id,generation_id,armament_id,
   wallet_public_key,mint,quote_mint,entry_venue,quote_cost_raw,base_amount_raw,
@@ -1262,6 +1263,15 @@
   observed_at,finalized_at,result,reason_code,purge_after
 ), UPDATE (resolved_by_evidence_id,resolved_at,purge_after)
 ON TABLE execution_reconciliation_evidence TO sol_token_executor_live_recovery;
+
+-- The recovery runtime appends one immutable ledger row in the transaction that closes a
+-- live position. It never reads, updates or deletes the ledger.
+GRANT INSERT (
+  position_id,wallet_public_key,mint,opened_at,closed_at,base_amount_raw,
+  entry_wallet_lamport_delta,exit_wallet_lamport_delta,net_lamports,
+  entry_signature,exit_signature
+)
+ON TABLE execution_live_position_ledger TO sol_token_executor_live_recovery;
 
 GRANT INSERT (
   intent_id,previous_status,next_status,reason_code,human_message,
@@ -1522,6 +1532,10 @@
   execution_live_positions,
   execution_exit_authorizations,
   execution_reconciliation_evidence
+FROM PUBLIC,sol_token_listener_writer,sol_token_executor_worker,
+  sol_token_executor_operations,sol_token_operator_reader,sol_token_public_api;
+
+REVOKE ALL ON TABLE execution_live_position_ledger
 FROM PUBLIC,sol_token_listener_writer,sol_token_executor_worker,
   sol_token_executor_operations,sol_token_operator_reader,sol_token_public_api;
 
@@ -2532,10 +2546,22 @@
   execution_activation_armaments,
   execution_activation_events,
   execution_simulation_artifacts,
+  execution_live_position_ledger,
+  bonding_curve_snapshots,
+  market_pools,
+  market_reserve_snapshots,
   migration_history
 TO sol_token_operator_reader;
 
+-- The operator console reads only the position columns it displays, never the intent,
+-- authorization, armament or fingerprint columns.
 GRANT SELECT (
+  position_id,wallet_public_key,mint,quote_mint,quote_cost_raw,base_amount_raw,
+  remaining_base_raw,fee_lamports,opened_at,exit_deadline_at,state,closed_at
+)
+ON TABLE execution_live_positions TO sol_token_operator_reader;
+
+GRANT SELECT (
   id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,candidate_id,
   logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,
   quote_decimals,quote_amount_raw,base_amount_raw,minimum_amount_out_raw,
````

- [ ] **Step 4: recovery authority, exact reader authority, listener list**

````diff
--- a/src/executor-live-recovery/database-authority.ts
+++ b/src/executor-live-recovery/database-authority.ts
@@ -218,6 +218,8 @@
         'exit_intent_id',
         'remaining_base_raw',
         'quote_cost_raw',
+        'base_amount_raw',
+        'opened_at',
         'exit_deadline_at',
         'entry_reconciliation_fingerprint',
       ),
@@ -299,7 +301,25 @@
         'open_positions',
         'unknown_block',
         'updated_at',
+      ),
+    ),
+    table(
+      'execution_live_position_ledger',
+      columns(),
+      columns(
+        'position_id',
+        'wallet_public_key',
+        'mint',
+        'opened_at',
+        'closed_at',
+        'base_amount_raw',
+        'entry_wallet_lamport_delta',
+        'exit_wallet_lamport_delta',
+        'net_lamports',
+        'entry_signature',
+        'exit_signature',
       ),
+      columns(),
     ),
     table(
       'execution_exposure_reservations',
````

````diff
--- a/src/preflight-source/database.ts
+++ b/src/preflight-source/database.ts
@@ -8,13 +8,19 @@
 import { PostgresExecutionPreflightSourceRepository } from './repository.js';
 
 export const EXECUTION_PREFLIGHT_SOURCE_ROLE = 'sol_token_operator_reader';
+// The same read-only role also serves the operator console API (src/operator-api), so its
+// exact authority includes the live ledger, the market snapshots and the position columns
+// listed below in addition to the preflight source tables.
 export const EXECUTION_PREFLIGHT_SOURCE_TABLES = Object.freeze([
+  'bonding_curve_snapshots',
   'execution_activation_armaments', 'execution_activation_events',
   'execution_control_events', 'execution_control_state', 'execution_exposure_reservations',
+  'execution_live_position_ledger',
   'execution_provider_usage_snapshots', 'execution_reconciliation_evidence',
   'execution_safety_gate_evidence', 'execution_safety_qualifications',
   'execution_simulation_artifacts', 'execution_wallet_generations',
-  'execution_wallet_risk_state', 'execution_wallet_snapshots', 'migration_history',
+  'execution_wallet_risk_state', 'execution_wallet_snapshots',
+  'market_pools', 'market_reserve_snapshots', 'migration_history',
 ] as const);
 export const EXECUTION_PREFLIGHT_SOURCE_INTENT_COLUMNS = Object.freeze([
   'attempt_count', 'base_amount_raw', 'candidate_id', 'created_at', 'decision_event_id',
@@ -36,6 +42,11 @@
     'assessment_id', 'intent_id', 'result_fingerprint',
   ]),
   execution_intents: EXECUTION_PREFLIGHT_SOURCE_INTENT_COLUMNS,
+  execution_live_positions: Object.freeze([
+    'base_amount_raw', 'closed_at', 'exit_deadline_at', 'fee_lamports', 'mint', 'opened_at',
+    'position_id', 'quote_cost_raw', 'quote_mint', 'remaining_base_raw', 'state',
+    'wallet_public_key',
+  ]),
   execution_preflight_intent_pair_memberships: Object.freeze(['intent_id', 'lane', 'pair_id']),
   execution_preflight_intent_pairs: Object.freeze([
     'expires_at', 'pair_fingerprint', 'pair_id', 'simulation_intent_id', 'target_intent_id',
````

````diff
--- a/tests/listener-database-authority.test.ts
+++ b/tests/listener-database-authority.test.ts
@@ -44,7 +44,7 @@
   'execution_attempts', 'execution_control_events', 'execution_control_state',
   'execution_dry_run_assessments', 'execution_exit_authorizations',
   'execution_exposure_reservations', 'execution_fault_ledger',
-  'execution_intent_transitions', 'execution_live_positions',
+  'execution_intent_transitions', 'execution_live_position_ledger', 'execution_live_positions',
   'execution_live_rpc_budgets', 'execution_live_unsigned_simulation_evidence',
   'execution_operator_authorizations', 'execution_pre_signature_locks',
   'execution_pre_submission_revocations', 'execution_provider_rate_limit_events',
````

- [ ] **Step 5: run the role tests, authority tests and the existing provisioning suites**

```bash
export TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55433/sol_token_listener_test
npx tsx --test --test-concurrency=1 tests/live-ledger-roles.test.ts tests/executor-roles-provisioning.test.ts tests/listener-database-authority.test.ts tests/execution-preflight-source-database.test.ts tests/execution-preflight-source.repository.test.ts tests/executor-live-recovery-startup.test.ts tests/executor-live-recovery-database.test.ts
```

Expected: `fail 0`, `skipped 0` (the PostgreSQL 16 role tests really ran: they replay the provisioning twice and start the recovery and H2h wrappers against the new grants).

- [ ] **Step 6: commit**

```bash
git add scripts/provision-executor-roles.sql src/executor-live-recovery/database-authority.ts src/preflight-source/database.ts tests/listener-database-authority.test.ts tests/live-ledger-roles.test.ts
git commit -m "feat(roles): grant the ledger insert to recovery and the console reads to the operator reader" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Ledger cursor and the pure operator-API helpers

**Files:**
- Modify: `src/api/cursor.ts` (after `PaperPositionPagePosition`, :14; new encode/decode before `encodeTimelineCursor`)
- Modify: `tests/api-cursor.test.ts`
- Create: `src/operator-api/pnl.ts`, `src/operator-api/balance-cache.ts`, `src/operator-api/rpc-balance.ts`
- Create: `tests/operator-api-pure.test.ts`

Facts verified: `src/api/cursor.ts` holds the canonical opaque cursor codecs (`encodePaperPositionCursor` is the template); `closed_at` has millisecond precision by CHECK so a millisecond epoch is an exact keyset.

- [ ] **Step 1: write the failing tests**

Create `tests/operator-api-pure.test.ts`:

````ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBalanceCache } from '../src/operator-api/balance-cache.js';
import { spotValueLamports, unrealizedLamports } from '../src/operator-api/pnl.js';
import { createRpcBalanceReader } from '../src/operator-api/rpc-balance.js';

const WALLET = '11111111111111111111111111111111';

void test('spot value multiplies before dividing and rounds down', () => {
  // 2.8e-5 lamport per raw unit: a per-unit price would round down to zero.
  const reserves = { quoteReservesRaw: 30_000_000_000n, baseReservesRaw: 1_073_000_000_000_000n };
  assert.equal(spotValueLamports(35_000_000_000n, reserves), 978_564n);
  assert.equal(spotValueLamports(0n, reserves), 0n);
  assert.equal(spotValueLamports(1n, { quoteReservesRaw: 1n, baseReservesRaw: 3n }), 0n);
});

void test('spot value is unavailable without usable reserves', () => {
  assert.equal(spotValueLamports(10n, null), null);
  assert.equal(spotValueLamports(10n, { quoteReservesRaw: 5n, baseReservesRaw: 0n }), null);
});

void test('unrealized PnL is the spot value minus cost and stays unknown without a spot value', () => {
  assert.equal(unrealizedLamports(978_564n, 1_005_000n), -26_436n);
  assert.equal(unrealizedLamports(1_200_000n, 1_005_000n), 195_000n);
  assert.equal(unrealizedLamports(null, 1_005_000n), null);
});

void test('the balance cache serves 15 s from memory and shares one in-flight RPC', async () => {
  let nowMs = 1_000;
  let calls = 0;
  let release: (value: bigint) => void = () => undefined;
  const cache = createBalanceCache({
    now: () => nowMs,
    fetchLamports: () => {
      calls += 1;
      return new Promise<bigint>((resolve) => { release = resolve; });
    },
  });

  const first = cache.read(WALLET);
  const second = cache.read(WALLET);
  assert.equal(calls, 1);
  release(5_000_000_000n);
  assert.deepEqual(await first, { lamports: 5_000_000_000n, observedAtMs: 1_000 });
  assert.equal(await second, await first);

  nowMs = 15_999;
  assert.deepEqual(await cache.read(WALLET), { lamports: 5_000_000_000n, observedAtMs: 1_000 });
  assert.equal(calls, 1);

  nowMs = 16_000;
  const refreshed = cache.read(WALLET);
  assert.equal(calls, 2);
  release(6_000_000_000n);
  assert.deepEqual(await refreshed, { lamports: 6_000_000_000n, observedAtMs: 16_000 });
});

void test('the balance cache keeps the last known value on RPC failure and is null before any success', async () => {
  let nowMs = 0;
  let fail = true;
  const cache = createBalanceCache({
    now: () => nowMs,
    fetchLamports: () => (fail ? Promise.reject(new Error('429')) : Promise.resolve(7n)),
  });

  assert.equal(await cache.read(WALLET), null);
  fail = false;
  assert.deepEqual(await cache.read(WALLET), { lamports: 7n, observedAtMs: 0 });
  fail = true;
  nowMs = 20_000;
  assert.deepEqual(await cache.read(WALLET), { lamports: 7n, observedAtMs: 0 });
});

void test('the RPC balance reader asks getBalance only and parses a safe integer', async () => {
  const requests: { readonly url: string; readonly body: unknown }[] = [];
  const respond = (payload: unknown, status = 200) => (
    url: string | URL | Request, init?: RequestInit,
  ): Promise<Response> => {
    assert.equal(typeof url, 'string');
    assert.equal(typeof init?.body, 'string');
    requests.push({ url: url as string, body: JSON.parse(init?.body as string) as unknown });
    return Promise.resolve(new Response(JSON.stringify(payload), { status }));
  };
  const read = createRpcBalanceReader({
    rpcUrl: 'https://rpc.example',
    fetchFn: respond({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: 1_234_567_890 } }),
  });

  assert.equal(await read(WALLET), 1_234_567_890n);
  assert.deepEqual(requests, [{
    url: 'https://rpc.example',
    body: {
      jsonrpc: '2.0', id: 1, method: 'getBalance',
      params: [WALLET, { commitment: 'confirmed' }],
    },
  }]);
  for (const payload of [{ result: { value: -1 } }, { result: { value: 1.5 } }, { error: {} }, null]) {
    await assert.rejects(createRpcBalanceReader({ rpcUrl: 'https://rpc.example', fetchFn: respond(payload) })(WALLET));
  }
  await assert.rejects(createRpcBalanceReader({
    rpcUrl: 'https://rpc.example', fetchFn: respond({}, 429),
  })(WALLET));
});
````

Apply to `tests/api-cursor.test.ts`:

````diff
--- a/tests/api-cursor.test.ts
+++ b/tests/api-cursor.test.ts
@@ -7,10 +7,12 @@
   MAX_TIMELINE_INDEX,
   MAX_TIMELINE_SLOT,
   decodeLaunchCursor,
+  decodeLedgerCursor,
   decodePaperPositionCursor,
   decodeStreamCursor,
   decodeTimelineCursor,
   encodeLaunchCursor,
+  encodeLedgerCursor,
   encodePaperPositionCursor,
   encodeStreamCursor,
   encodeTimelineCursor,
@@ -118,3 +120,14 @@
     ...maximum, innerInstructionIndex: MAX_TIMELINE_INDEX + 1,
   }), TypeError);
 });
+
+void test('the live ledger cursor is canonical, bounded and route-specific', () => {
+  const position = { closedAtMs: 1_780_000_000_000, id: 'execution_live_position_a' };
+  const cursor = encodeLedgerCursor(position);
+  assert.deepEqual(decodeLedgerCursor(cursor), position);
+  assert.throws(() => decodeLedgerCursor(encodePaperPositionCursor({ openedAtMs: 1, id: 'p' })), TypeError);
+  assert.throws(() => decodePaperPositionCursor(cursor), TypeError);
+  assert.throws(() => decodeLedgerCursor(`${cursor}A`), TypeError);
+  assert.throws(() => encodeLedgerCursor({ closedAtMs: -1, id: 'x' }), TypeError);
+  assert.throws(() => encodeLedgerCursor({ closedAtMs: 1, id: '' }), TypeError);
+});
````

- [ ] **Step 2: run them and see them fail**

```bash
npx tsx --test tests/operator-api-pure.test.ts tests/api-cursor.test.ts
```

Expected: `operator-api-pure` fails with `Cannot find module '../src/operator-api/balance-cache.js'`; `api-cursor` fails with `encodeLedgerCursor is not a function` (SyntaxError on the missing export).

- [ ] **Step 3: implement**

````diff
--- a/src/api/cursor.ts
+++ b/src/api/cursor.ts
@@ -15,6 +15,11 @@
   readonly id: string;
 }
 
+export interface LedgerPagePosition {
+  readonly closedAtMs: number;
+  readonly id: string;
+}
+
 export interface TimelinePagePosition {
   readonly slot: string;
   readonly transactionIndex: number;
@@ -73,6 +78,29 @@
   return Object.freeze(position);
 }
 
+export function encodeLedgerCursor(position: LedgerPagePosition): string {
+  assertTimestamp(position.closedAtMs, 'closedAtMs');
+  assertText(position.id, 'id');
+  return encodeTuple(['live_ledger', 1, position.closedAtMs, position.id]);
+}
+
+export function decodeLedgerCursor(cursor: string): LedgerPagePosition {
+  const tuple = decodeTuple(cursor);
+  if (tuple.length !== 4 || tuple[0] !== 'live_ledger' || tuple[1] !== 1) {
+    throw new TypeError('Invalid live ledger cursor');
+  }
+  const closedAtMs = tuple[2];
+  const id = tuple[3];
+  if (typeof closedAtMs !== 'number' || typeof id !== 'string') {
+    throw new TypeError('Invalid live ledger cursor');
+  }
+  const position: LedgerPagePosition = { closedAtMs, id };
+  assertTimestamp(position.closedAtMs, 'closedAtMs');
+  assertText(position.id, 'id');
+  if (encodeLedgerCursor(position) !== cursor) throw new TypeError('Non-canonical live ledger cursor');
+  return Object.freeze(position);
+}
+
 export function encodeTimelineCursor(position: TimelinePagePosition): string {
   assertTimelineSlot(position.slot);
   assertIndex(position.transactionIndex, 'transactionIndex');
````

Create `src/operator-api/pnl.ts`:

````ts
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface SpotReserves {
  readonly quoteReservesRaw: bigint;
  readonly baseReservesRaw: bigint;
}

/**
 * Indicative mid-price value of `remainingBaseRaw` tokens: no slippage, no fees. The value is
 * computed as one multiplication then one division because the per-raw-unit price is far below
 * one lamport and would round down to zero. Returns null without usable reserves.
 */
export function spotValueLamports(
  remainingBaseRaw: bigint,
  reserves: SpotReserves | null,
): bigint | null {
  if (reserves === null || reserves.baseReservesRaw <= 0n || reserves.quoteReservesRaw < 0n) {
    return null;
  }
  return (remainingBaseRaw * reserves.quoteReservesRaw) / reserves.baseReservesRaw;
}

export function unrealizedLamports(
  spotValue: bigint | null,
  costLamports: bigint,
): bigint | null {
  return spotValue === null ? null : spotValue - costLamports;
}
````

Create `src/operator-api/balance-cache.ts`:

````ts
export const BALANCE_CACHE_TTL_MS = 15_000;

export interface BalanceObservation {
  readonly lamports: bigint;
  readonly observedAtMs: number;
}

export interface BalanceCache {
  readonly read: (wallet: string) => Promise<BalanceObservation | null>;
}

export interface BalanceCacheOptions {
  readonly fetchLamports: (wallet: string) => Promise<bigint>;
  readonly now: () => number;
  readonly ttlMs?: number;
}

/**
 * Serves one wallet balance from memory for `ttlMs`, shares a single in-flight RPC between
 * concurrent readers, and falls back to the last known observation (or null) when the RPC
 * fails.
 */
export function createBalanceCache(options: BalanceCacheOptions): BalanceCache {
  const ttlMs = options.ttlMs ?? BALANCE_CACHE_TTL_MS;
  let last: { readonly wallet: string; readonly observation: BalanceObservation } | null = null;
  let inFlight: { readonly wallet: string; readonly promise: Promise<BalanceObservation | null> } | null = null;

  async function refresh(wallet: string): Promise<BalanceObservation | null> {
    try {
      const lamports = await options.fetchLamports(wallet);
      const observation = Object.freeze({ lamports, observedAtMs: options.now() });
      last = { wallet, observation };
      return observation;
    } catch {
      return last?.wallet === wallet ? last.observation : null;
    } finally {
      inFlight = null;
    }
  }

  return Object.freeze({
    read: (wallet: string): Promise<BalanceObservation | null> => {
      if (last?.wallet === wallet && options.now() - last.observation.observedAtMs < ttlMs) {
        return Promise.resolve(last.observation);
      }
      if (inFlight?.wallet === wallet) return inFlight.promise;
      const promise = refresh(wallet);
      inFlight = { wallet, promise };
      return promise;
    },
  });
}
````

Create `src/operator-api/rpc-balance.ts`:

````ts
export interface RpcBalanceReaderOptions {
  readonly rpcUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

/** The operator API's only RPC call: the confirmed lamport balance of one public key. */
export function createRpcBalanceReader(
  options: RpcBalanceReaderOptions,
): (wallet: string) => Promise<bigint> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return async (wallet: string): Promise<bigint> => {
    const response = await fetchFn(options.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getBalance',
        params: [wallet, { commitment: 'confirmed' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error('getBalance request failed');
    const body: unknown = await response.json();
    const value = balanceValue(body);
    if (value === null) throw new Error('getBalance response is invalid');
    return BigInt(value);
  };
}

function balanceValue(body: unknown): number | null {
  if (typeof body !== 'object' || body === null || !('result' in body)) return null;
  const result = body.result;
  if (typeof result !== 'object' || result === null || !('value' in result)) return null;
  const value = result.value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
````

- [ ] **Step 4: run them and lint**

```bash
npx tsx --test tests/operator-api-pure.test.ts tests/api-cursor.test.ts
npx eslint src/operator-api src/api/cursor.ts tests/operator-api-pure.test.ts tests/api-cursor.test.ts --max-warnings=0
```

Expected: `fail 0`; eslint prints nothing.

- [ ] **Step 5: commit**

```bash
git add src/api/cursor.ts tests/api-cursor.test.ts src/operator-api tests/operator-api-pure.test.ts
git commit -m "feat(operator-api): add the ledger cursor, spot valuation, balance cache and getBalance reader" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Overview repository

**Files:**
- Create: `src/operator-api/repository.ts`
- Create: `tests/operator-api-repository.test.ts`
- Modify: `tests/live-ledger-roles.test.ts` (adds the real-SQL test)

Facts verified: `ExecutorDatabaseSource` / `ExecutorDatabaseClient` (`src/executor/database.ts:3-13`) is what the validated reader wrapper returns; the active wallet is the single `retired_at IS NULL` generation (unique index per cluster, `migrations/034_execution_risk_reconciliation.sql:130`). Spot data: PumpSwap `effective_quote_reserves_raw / base_reserves_raw` from `market_reserve_snapshots` joined to `market_pools`, else bonding curve `virtual_quote_reserves_raw / virtual_base_reserves_raw` (`migrations/005`, `migrations/003`), both non-orphaned and WSOL-quoted. All SQL below was executed under `SET ROLE sol_token_operator_reader`.

- [ ] **Step 1: write the failing tests**

````ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeLedgerCursor, encodeLedgerCursor } from '../src/api/cursor.js';
import type { ExecutorDatabaseSource } from '../src/executor/database.js';
import {
  ACTIVE_WALLET_SQL,
  CURVE_RESERVES_SQL,
  createLiveOverviewReader,
  HISTORY_SQL,
  OPEN_POSITIONS_SQL,
  POOL_RESERVES_SQL,
  REALIZED_TOTAL_SQL,
} from '../src/operator-api/repository.js';

type Row = Readonly<Record<string, unknown>>;

const WALLET = '11111111111111111111111111111111';
const MINT_POOL = 'So11111111111111111111111111111111111111112';
const MINT_CURVE = '4Nd1mYQzvgQ1NhVU9oKRf7qZsV4W1YqTf1m4eZxY2k5y';
const MINT_BARE = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const SIGNATURE = '5'.repeat(88);

function fakeDatabase(answers: ReadonlyMap<string, readonly Row[]>) {
  const calls: { readonly text: string; readonly values: readonly unknown[] | undefined }[] = [];
  let released = 0;
  const source: ExecutorDatabaseSource = {
    connect: () => Promise.resolve({
      query: (text, values) => {
        calls.push({ text, values });
        const rows = answers.get(text);
        if (rows === undefined) return Promise.reject(new Error('unexpected SQL'));
        return Promise.resolve({ rows, rowCount: rows.length });
      },
      release: () => { released += 1; },
    }),
  };
  return { source, calls, released: () => released };
}

function openRow(positionId: string, mint: string, remaining: string): Row {
  return {
    position_id: positionId, mint, state: 'OPEN',
    opened_at: new Date('2026-10-06T11:55:00.000Z'),
    exit_deadline_at: new Date('2026-10-06T12:10:00.000Z'),
    remaining_base_raw: remaining, quote_cost_raw: '1000000', fee_lamports: '5000',
  };
}

function historyRow(id: string, closedAt: string, net: string): Row {
  return {
    position_id: id, mint: MINT_POOL, opened_at: new Date('2026-10-06T10:00:00.000Z'),
    closed_at: new Date(closedAt), entry_signature: SIGNATURE, exit_signature: SIGNATURE,
    net_lamports: net,
  };
}

const balances = {
  read: () => Promise.resolve({ lamports: 2_500_000_000n, observedAtMs: NOW - 3_000 }),
};

void test('without an active wallet generation the overview is NOT_AVAILABLE and reads nothing else', async () => {
  const database = fakeDatabase(new Map([[ACTIVE_WALLET_SQL, []]]));
  const reader = createLiveOverviewReader({ database: database.source, balances, now: () => NOW });

  const page = await reader.read({ limit: 50, cursor: null });

  assert.deepEqual(page, {
    data: {
      availability: 'NOT_AVAILABLE', wallet: null, balance: null, open: [], history: [],
      totals: { realizedLamports: 0n, unrealizedLamports: 0n, openCount: 0, positionsWithoutPnl: 0 },
    },
    nextCursor: null,
  });
  assert.equal(database.calls.length, 1);
  assert.equal(database.released(), 1);
});

void test('assembles open PnL from pool then curve reserves, realized totals and a history cursor', async () => {
  const database = fakeDatabase(new Map<string, readonly Row[]>([
    [ACTIVE_WALLET_SQL, [{ wallet_public_key: WALLET }]],
    [OPEN_POSITIONS_SQL, [
      openRow('execution_live_position_pool', MINT_POOL, '35000000000'),
      openRow('execution_live_position_curve', MINT_CURVE, '35000000000'),
      openRow('execution_live_position_bare', MINT_BARE, '35000000000'),
    ]],
    // The curve query answers for two mints; the pool answer must win for MINT_POOL.
    [CURVE_RESERVES_SQL, [
      { mint: MINT_POOL, quote_reserves_raw: '1', base_reserves_raw: '1' },
      { mint: MINT_CURVE, quote_reserves_raw: '30000000000', base_reserves_raw: '1073000000000000' },
    ]],
    [POOL_RESERVES_SQL, [
      { mint: MINT_POOL, quote_reserves_raw: '60000000000', base_reserves_raw: '1073000000000000' },
    ]],
    [REALIZED_TOTAL_SQL, [{ realized_lamports: '-12345' }]],
    [HISTORY_SQL, [
      historyRow('execution_live_position_c', '2026-10-06T11:30:00.000Z', '-4205'),
      historyRow('execution_live_position_b', '2026-10-06T11:00:00.000Z', '900'),
      historyRow('execution_live_position_a', '2026-10-06T10:30:00.000Z', '-9000'),
    ]],
  ]));
  const reader = createLiveOverviewReader({ database: database.source, balances, now: () => NOW });

  const { data, nextCursor } = await reader.read({ limit: 2, cursor: null });

  assert.equal(data.availability, 'AVAILABLE');
  assert.equal(data.wallet, WALLET);
  assert.deepEqual(data.balance, { lamports: 2_500_000_000n, observedAt: '2026-10-06T11:59:57.000Z' });
  assert.deepEqual(data.open.map((position) => [
    position.positionId, position.costLamports, position.spotValueLamports, position.unrealizedLamports,
  ]), [
    ['execution_live_position_pool', 1_005_000n, 1_957_129n, 952_129n],
    ['execution_live_position_curve', 1_005_000n, 978_564n, -26_436n],
    ['execution_live_position_bare', 1_005_000n, null, null],
  ]);
  assert.deepEqual(data.totals, {
    realizedLamports: -12_345n, unrealizedLamports: 925_693n, openCount: 3, positionsWithoutPnl: 1,
  });
  assert.deepEqual(data.history.map((position) => [position.positionId, position.realizedLamports]), [
    ['execution_live_position_c', -4_205n], ['execution_live_position_b', 900n],
  ]);
  assert.equal(data.history[0]?.closedAt, '2026-10-06T11:30:00.000Z');
  assert.deepEqual(decodeLedgerCursor(nextCursor ?? ''), {
    closedAtMs: Date.parse('2026-10-06T11:00:00.000Z'), id: 'execution_live_position_b',
  });
  const historyCall = database.calls.find((call) => call.text === HISTORY_SQL);
  assert.deepEqual(historyCall?.values, [WALLET, null, null, 3]);
  assert.equal(database.released(), 1);
});

void test('the last history page has no cursor and a cursor request is a keyset on the ledger', async () => {
  const cursor = { closedAtMs: Date.parse('2026-10-06T11:00:00.000Z'), id: 'execution_live_position_b' };
  assert.equal(decodeLedgerCursor(encodeLedgerCursor(cursor)).id, cursor.id);
  const database = fakeDatabase(new Map<string, readonly Row[]>([
    [ACTIVE_WALLET_SQL, [{ wallet_public_key: WALLET }]],
    [OPEN_POSITIONS_SQL, []],
    [REALIZED_TOTAL_SQL, [{ realized_lamports: '0' }]],
    [HISTORY_SQL, [historyRow('execution_live_position_a', '2026-10-06T10:30:00.000Z', '-9000')]],
  ]));
  const reader = createLiveOverviewReader({
    database: database.source, balances: { read: () => Promise.resolve(null) }, now: () => NOW,
  });

  const page = await reader.read({ limit: 2, cursor });

  assert.equal(page.nextCursor, null);
  assert.equal(page.data.balance, null);
  assert.deepEqual(database.calls.find((call) => call.text === HISTORY_SQL)?.values,
    [WALLET, String(cursor.closedAtMs), cursor.id, 3]);
  assert.equal(database.calls.some((call) => call.text === POOL_RESERVES_SQL), false);
});

void test('the database client is released when a query fails', async () => {
  const database = fakeDatabase(new Map());
  const reader = createLiveOverviewReader({ database: database.source, balances, now: () => NOW });

  await assert.rejects(reader.read({ limit: 50, cursor: null }));
  assert.equal(database.released(), 1);
});
````

Extend the role test (adds a real-database test that runs every overview query under the reader role and pages real ledger rows by keyset):

````diff
--- a/tests/live-ledger-roles.test.ts
+++ b/tests/live-ledger-roles.test.ts
@@ -3,6 +3,14 @@
 import { readFile } from 'node:fs/promises';
 import test, { type TestContext } from 'node:test';
 import pg from 'pg';
+import {
+  ACTIVE_WALLET_SQL,
+  CURVE_RESERVES_SQL,
+  HISTORY_SQL,
+  OPEN_POSITIONS_SQL,
+  POOL_RESERVES_SQL,
+  REALIZED_TOTAL_SQL,
+} from '../src/operator-api/repository.js';
 import { migrateDatabase } from '../src/storage/database.js';
 import { LIVE_POSITION_LEDGER_INSERT_SQL } from '../src/storage/execution-live.repository.js';
 import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';
@@ -67,6 +75,56 @@
   });
 });
 
+void test('PostgreSQL 16 operator reader runs every overview query and pages the ledger by keyset', async (context) => {
+  await withProvisionedDatabase(context, async (pool) => {
+    const wallet = '11111111111111111111111111111111';
+    const mint = 'So11111111111111111111111111111111111111112';
+    for (const [letter, closedAt, net] of [
+      ['a', '2026-10-06 10:30:00+00', '-9000'], ['b', '2026-10-06 11:00:00+00', '900'],
+      ['c', '2026-10-06 11:00:00+00', '-4205'], ['d', '2026-10-06 11:30:00+00', '15'],
+    ] as const) {
+      await pool.query(`INSERT INTO execution_live_position_ledger (
+        position_id,wallet_public_key,mint,opened_at,closed_at,base_amount_raw,
+        entry_wallet_lamport_delta,exit_wallet_lamport_delta,net_lamports,
+        entry_signature,exit_signature
+      ) VALUES ('execution_live_position_'||repeat($1,64),$2,$3,TIMESTAMPTZ '2026-10-06 10:00:00+00',
+        $4::TIMESTAMPTZ,95,-1000,$5::NUMERIC+1000,$5::NUMERIC,repeat('1',64),repeat('2',64))`,
+      [letter, wallet, mint, closedAt, net]);
+    }
+    const reader = 'sol_token_operator_reader';
+    const firstPage = await readAs(pool, reader, HISTORY_SQL, [wallet, null, null, 3]);
+    assert.deepEqual(firstPage.map((row) => String(row.position_id).slice(-1)), ['d', 'c', 'b']);
+    const cursor = firstPage[2];
+    assert.ok(cursor?.closed_at instanceof Date);
+    const secondPage = await readAs(pool, reader, HISTORY_SQL,
+      [wallet, String(cursor.closed_at.getTime()), cursor.position_id, 3]);
+    assert.deepEqual(secondPage.map((row) => String(row.position_id).slice(-1)), ['a']);
+    assert.deepEqual(await readAs(pool, reader, REALIZED_TOTAL_SQL, [wallet]),
+      [{ realized_lamports: '-12290' }]);
+    assert.deepEqual(await readAs(pool, reader, ACTIVE_WALLET_SQL), []);
+    assert.deepEqual(await readAs(pool, reader, OPEN_POSITIONS_SQL, [wallet]), []);
+    assert.deepEqual(await readAs(pool, reader, POOL_RESERVES_SQL, [[mint], mint]), []);
+    assert.deepEqual(await readAs(pool, reader, CURVE_RESERVES_SQL, [[mint], mint]), []);
+  });
+});
+
+async function readAs(
+  pool: InstanceType<typeof pg.Pool>,
+  role: string,
+  text: string,
+  values: readonly unknown[] = [],
+): Promise<readonly Record<string, unknown>[]> {
+  const client = await pool.connect();
+  try {
+    await client.query('BEGIN');
+    await client.query(`SET LOCAL ROLE ${role}`);
+    return (await client.query<Record<string, unknown>>(text, [...values])).rows;
+  } finally {
+    await client.query('ROLLBACK').catch(() => undefined);
+    client.release();
+  }
+}
+
 async function probe(
   pool: InstanceType<typeof pg.Pool>,
   role: string,
````

- [ ] **Step 2: run them and see them fail**

```bash
export TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55433/sol_token_listener_test
npx tsx --test tests/operator-api-repository.test.ts tests/live-ledger-roles.test.ts
```

Expected: both fail with `Cannot find module '../src/operator-api/repository.js'`.

- [ ] **Step 3: implement**

Create `src/operator-api/repository.ts`:

````ts
import type { ExecutorDatabaseClient, ExecutorDatabaseSource } from '../executor/database.js';
import { encodeLedgerCursor, type LedgerPagePosition } from '../api/cursor.js';
import type { BalanceCache } from './balance-cache.js';
import { spotValueLamports, unrealizedLamports, WSOL_MINT, type SpotReserves } from './pnl.js';

export type LiveOpenState = 'OPEN' | 'EXIT_PENDING' | 'UNKNOWN';

export interface LiveOpenPosition {
  readonly positionId: string;
  readonly mint: string;
  readonly state: LiveOpenState;
  readonly openedAt: string;
  readonly exitDeadlineAt: string;
  readonly remainingRaw: bigint;
  readonly costLamports: bigint;
  readonly spotValueLamports: bigint | null;
  readonly unrealizedLamports: bigint | null;
}

export interface LiveClosedPosition {
  readonly positionId: string;
  readonly mint: string;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly entrySignature: string;
  readonly exitSignature: string;
  readonly realizedLamports: bigint;
}

export interface LiveOverviewData {
  readonly availability: 'AVAILABLE' | 'NOT_AVAILABLE';
  readonly wallet: string | null;
  readonly balance: { readonly lamports: bigint; readonly observedAt: string } | null;
  readonly open: readonly LiveOpenPosition[];
  readonly history: readonly LiveClosedPosition[];
  readonly totals: {
    readonly realizedLamports: bigint;
    readonly unrealizedLamports: bigint;
    readonly openCount: number;
    readonly positionsWithoutPnl: number;
  };
}

export interface LiveOverviewRequest {
  readonly limit: number;
  readonly cursor: LedgerPagePosition | null;
}

export interface LiveOverviewPage {
  readonly data: LiveOverviewData;
  readonly nextCursor: string | null;
}

export interface LiveOverviewReader {
  readonly read: (request: LiveOverviewRequest) => Promise<LiveOverviewPage>;
}

type Row = Readonly<Record<string, unknown>>;

export const ACTIVE_WALLET_SQL = `SELECT wallet_public_key FROM execution_wallet_generations
  WHERE retired_at IS NULL ORDER BY created_at DESC, generation_id LIMIT 1`;

export const OPEN_POSITIONS_SQL = `SELECT position_id, mint, state, opened_at, exit_deadline_at,
    remaining_base_raw::TEXT AS remaining_base_raw, quote_cost_raw::TEXT AS quote_cost_raw,
    fee_lamports::TEXT AS fee_lamports
  FROM execution_live_positions
  WHERE wallet_public_key = $1 AND state IN ('OPEN','EXIT_PENDING','UNKNOWN')
  ORDER BY opened_at DESC, position_id DESC`;

// $1 mints, $2 quote mint. Latest non-orphaned PumpSwap reserve snapshot per mint.
export const POOL_RESERVES_SQL = `SELECT DISTINCT ON (pool.base_mint) pool.base_mint AS mint,
    snapshot.effective_quote_reserves_raw::TEXT AS quote_reserves_raw,
    snapshot.base_reserves_raw::TEXT AS base_reserves_raw
  FROM market_pools pool
  JOIN market_reserve_snapshots snapshot ON snapshot.pool_address = pool.pool_address
  WHERE pool.base_mint = ANY($1::TEXT[]) AND pool.quote_mint = $2
    AND pool.confirmation_status <> 'orphaned' AND snapshot.confirmation_status <> 'orphaned'
    AND snapshot.base_reserves_raw > 0
  ORDER BY pool.base_mint, snapshot.observed_slot DESC, snapshot.trigger_slot DESC,
    snapshot.transaction_index DESC, snapshot.instruction_index DESC,
    COALESCE(snapshot.inner_instruction_index, -1) DESC, snapshot.snapshot_id DESC`;

// $1 mints, $2 quote mint. Latest non-orphaned bonding curve virtual reserves per mint.
export const CURVE_RESERVES_SQL = `SELECT DISTINCT ON (curve.mint) curve.mint,
    curve.virtual_quote_reserves_raw::TEXT AS quote_reserves_raw,
    curve.virtual_base_reserves_raw::TEXT AS base_reserves_raw
  FROM bonding_curve_snapshots curve
  WHERE curve.mint = ANY($1::TEXT[]) AND curve.quote_mint = $2
    AND curve.confirmation_status <> 'orphaned' AND curve.virtual_base_reserves_raw > 0
  ORDER BY curve.mint, curve.slot DESC, curve.transaction_index DESC,
    curve.instruction_index DESC, COALESCE(curve.inner_instruction_index, -1) DESC,
    curve.snapshot_id DESC`;

export const REALIZED_TOTAL_SQL = `SELECT COALESCE(SUM(net_lamports), 0)::TEXT AS realized_lamports
  FROM execution_live_position_ledger WHERE wallet_public_key = $1`;

// $1 wallet, $2 cursor closed-at epoch ms or NULL, $3 cursor position id or NULL, $4 row count.
export const HISTORY_SQL = `SELECT position_id, mint, opened_at, closed_at, entry_signature,
    exit_signature, net_lamports::TEXT AS net_lamports
  FROM execution_live_position_ledger
  WHERE wallet_public_key = $1
    AND ($2::BIGINT IS NULL OR (closed_at, position_id) <
      (TIMESTAMPTZ 'epoch' + ($2::BIGINT * INTERVAL '1 millisecond'), $3::TEXT))
  ORDER BY closed_at DESC, position_id DESC
  LIMIT $4::INTEGER`;

export interface LiveOverviewReaderOptions {
  readonly database: ExecutorDatabaseSource;
  readonly balances: BalanceCache;
  readonly now: () => number;
}

export function createLiveOverviewReader(options: LiveOverviewReaderOptions): LiveOverviewReader {
  return Object.freeze({
    read: async (request: LiveOverviewRequest): Promise<LiveOverviewPage> => {
      const client = await options.database.connect();
      let stored: StoredOverview;
      try {
        stored = await readStored(client, request);
      } finally {
        client.release();
      }
      if (stored.wallet === null) {
        return { data: emptyOverview(), nextCursor: null };
      }
      const observation = await options.balances.read(stored.wallet);
      return {
        data: {
          availability: 'AVAILABLE',
          wallet: stored.wallet,
          balance: observation === null ? null : {
            lamports: observation.lamports,
            observedAt: new Date(observation.observedAtMs).toISOString(),
          },
          open: stored.open,
          history: stored.history,
          totals: stored.totals,
        },
        nextCursor: stored.nextCursor,
      };
    },
  });
}

interface StoredOverview {
  readonly wallet: string | null;
  readonly open: readonly LiveOpenPosition[];
  readonly history: readonly LiveClosedPosition[];
  readonly nextCursor: string | null;
  readonly totals: LiveOverviewData['totals'];
}

async function readStored(
  client: ExecutorDatabaseClient,
  request: LiveOverviewRequest,
): Promise<StoredOverview> {
  const walletRow = (await client.query(ACTIVE_WALLET_SQL)).rows[0];
  if (walletRow === undefined) {
    return { wallet: null, open: [], history: [], nextCursor: null, totals: emptyOverview().totals };
  }
  const wallet = text(walletRow, 'wallet_public_key');
  const openRows = (await client.query(OPEN_POSITIONS_SQL, [wallet])).rows;
  const mints = openRows.map((row) => text(row, 'mint'));
  const reserves = mints.length === 0 ? new Map<string, SpotReserves>() : await readReserves(client, mints);
  const open = openRows.map((row) => {
    const mint = text(row, 'mint');
    const remainingRaw = bigint(row, 'remaining_base_raw');
    const costLamports = bigint(row, 'quote_cost_raw') + bigint(row, 'fee_lamports');
    const spot = spotValueLamports(remainingRaw, reserves.get(mint) ?? null);
    return Object.freeze({
      positionId: text(row, 'position_id'),
      mint,
      state: openState(row),
      openedAt: timestamp(row, 'opened_at'),
      exitDeadlineAt: timestamp(row, 'exit_deadline_at'),
      remainingRaw,
      costLamports,
      spotValueLamports: spot,
      unrealizedLamports: unrealizedLamports(spot, costLamports),
    });
  });
  const realizedRow = (await client.query(REALIZED_TOTAL_SQL, [wallet])).rows[0];
  const historyRows = (await client.query(HISTORY_SQL, [
    wallet,
    request.cursor === null ? null : String(request.cursor.closedAtMs),
    request.cursor?.id ?? null,
    request.limit + 1,
  ])).rows;
  const page = historyRows.slice(0, request.limit);
  const history = page.map((row) => Object.freeze({
    positionId: text(row, 'position_id'),
    mint: text(row, 'mint'),
    openedAt: timestamp(row, 'opened_at'),
    closedAt: timestamp(row, 'closed_at'),
    entrySignature: text(row, 'entry_signature'),
    exitSignature: text(row, 'exit_signature'),
    realizedLamports: bigint(row, 'net_lamports'),
  }));
  const lastRow = page.at(-1);
  const nextCursor = historyRows.length > request.limit && lastRow !== undefined
    ? encodeLedgerCursor({
      closedAtMs: date(lastRow, 'closed_at').getTime(), id: text(lastRow, 'position_id'),
    })
    : null;
  return {
    wallet,
    open,
    history,
    nextCursor,
    totals: {
      realizedLamports: realizedRow === undefined ? 0n : bigint(realizedRow, 'realized_lamports'),
      unrealizedLamports: open.reduce((sum, position) => sum + (position.unrealizedLamports ?? 0n), 0n),
      openCount: open.length,
      positionsWithoutPnl: open.filter((position) => position.unrealizedLamports === null).length,
    },
  };
}

async function readReserves(
  client: ExecutorDatabaseClient,
  mints: readonly string[],
): Promise<ReadonlyMap<string, SpotReserves>> {
  const reserves = new Map<string, SpotReserves>();
  // The curve is the fallback: PumpSwap reserves win when the mint has a pool snapshot.
  for (const sql of [CURVE_RESERVES_SQL, POOL_RESERVES_SQL]) {
    for (const row of (await client.query(sql, [mints, WSOL_MINT])).rows) {
      reserves.set(text(row, 'mint'), {
        quoteReservesRaw: bigint(row, 'quote_reserves_raw'),
        baseReservesRaw: bigint(row, 'base_reserves_raw'),
      });
    }
  }
  return reserves;
}

function emptyOverview(): LiveOverviewData {
  return {
    availability: 'NOT_AVAILABLE', wallet: null, balance: null, open: [], history: [],
    totals: { realizedLamports: 0n, unrealizedLamports: 0n, openCount: 0, positionsWithoutPnl: 0 },
  };
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Invalid column ${key}`);
  return value;
}

function bigint(row: Row, key: string): bigint {
  const value = text(row, key);
  if (!/^-?\d+$/u.test(value)) throw new TypeError(`Invalid column ${key}`);
  return BigInt(value);
}

function date(row: Row, key: string): Date {
  const value = row[key];
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`Invalid column ${key}`);
  }
  return value;
}

function timestamp(row: Row, key: string): string {
  return date(row, key).toISOString();
}

function openState(row: Row): LiveOpenState {
  const value = text(row, 'state');
  if (value !== 'OPEN' && value !== 'EXIT_PENDING' && value !== 'UNKNOWN') {
    throw new TypeError('Invalid column state');
  }
  return value;
}
````

- [ ] **Step 4: run them, typecheck and lint**

```bash
export TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55433/sol_token_listener_test
npx tsx --test tests/operator-api-repository.test.ts tests/live-ledger-roles.test.ts
npx tsc -p tsconfig.json --noEmit
npx eslint src/operator-api tests/operator-api-repository.test.ts tests/live-ledger-roles.test.ts --max-warnings=0
```

Expected: `fail 0`, `skipped 0`; tsc and eslint print nothing.

- [ ] **Step 5: commit**

```bash
git add src/operator-api/repository.ts tests/operator-api-repository.test.ts tests/live-ledger-roles.test.ts
git commit -m "feat(operator-api): assemble the live overview from the ledger, positions and market snapshots" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: HTTP server

**Files:**
- Create: `src/operator-api/server.ts`
- Create: `tests/operator-api-server.test.ts`

Facts verified: `success` and `writeJson` (`src/interfaces/http/api-response.ts:14,37`) produce the public envelope; `writeJson` spreads `extraHeaders` after its defaults, so `access-control-allow-origin` set there replaces the hard-coded `*`. The tests use a real loopback server on port 0 (same pattern as `tests/api-safety.test.ts`) and `node:http` because `fetch` cannot set `Host`.

- [ ] **Step 1: write the failing test**

````ts
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import test from 'node:test';
import { encodeLedgerCursor } from '../src/api/cursor.js';
import type { LiveOverviewPage, LiveOverviewRequest } from '../src/operator-api/repository.js';
import { createOperatorApiHandler } from '../src/operator-api/server.js';

const TOKEN = 't'.repeat(32);
const ORIGIN = 'http://127.0.0.1:4173';

const page: LiveOverviewPage = {
  data: {
    availability: 'AVAILABLE',
    wallet: '11111111111111111111111111111111',
    balance: { lamports: 2_500_000_000n, observedAt: '2026-10-06T11:59:57.000Z' },
    open: [],
    history: [],
    totals: { realizedLamports: -4_205n, unrealizedLamports: 0n, openCount: 0, positionsWithoutPnl: 0 },
  },
  nextCursor: 'next',
};

interface Started {
  readonly requests: LiveOverviewRequest[];
  readonly errors: string[];
  readonly send: (options: {
    readonly method?: string; readonly path?: string; readonly headers?: Record<string, string>;
    readonly host?: string;
  }) => Promise<{ readonly status: number; readonly headers: Record<string, unknown>; readonly body: string }>;
  readonly close: () => Promise<void>;
}

async function start(read?: () => Promise<LiveOverviewPage>): Promise<Started> {
  const requests: LiveOverviewRequest[] = [];
  const errors: string[] = [];
  const server: Server = createServer();
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const allowedHost = `127.0.0.1:${String(address.port)}`;
  server.on('request', createOperatorApiHandler({
    token: TOKEN, allowedHost, allowedOrigin: ORIGIN, now: () => Date.parse('2026-10-06T12:00:00.000Z'),
    overview: { read: (input) => { requests.push(input); return (read ?? (() => Promise.resolve(page)))(); } },
    logError: (name) => { errors.push(name); },
  }));
  return {
    requests, errors,
    send: (options) => new Promise((resolve, reject) => {
      const outgoing = httpRequest({
        host: '127.0.0.1', port: address.port, method: options.method ?? 'GET',
        path: options.path ?? '/operator/v1/live/overview',
        headers: { host: options.host ?? allowedHost, ...options.headers },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        incoming.once('end', () => {
          resolve({
            status: incoming.statusCode ?? 0, headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      outgoing.once('error', reject);
      outgoing.end();
    }),
    close: () => new Promise((resolve) => { server.close(() => { resolve(); }); server.closeAllConnections(); }),
  };
}

const authorized = { authorization: `Bearer ${TOKEN}` };

void test('serves the overview in the public envelope with decimal-string amounts for one origin', async () => {
  const api = await start();
  try {
    const response = await api.send({ path: '/operator/v1/live/overview?limit=20', headers: authorized });

    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(response.body), {
      apiVersion: 'v1',
      meta: { generatedAt: '2026-10-06T12:00:00.000Z', nextCursor: 'next' },
      data: {
        availability: 'AVAILABLE', wallet: '11111111111111111111111111111111',
        balance: { lamports: '2500000000', observedAt: '2026-10-06T11:59:57.000Z' },
        open: [], history: [],
        totals: { realizedLamports: '-4205', unrealizedLamports: '0', openCount: 0, positionsWithoutPnl: 0 },
      },
    });
    assert.deepEqual(api.requests, [{ limit: 20, cursor: null }]);
  } finally { await api.close(); }
});

void test('rejects a missing, malformed or wrong bearer token before reading anything', async () => {
  const api = await start();
  try {
    for (const headers of [
      {}, { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` },
      { authorization: `Bearer ${TOKEN}x` }, { authorization: 'Bearer ' }, { authorization: `bearer ${TOKEN}` },
    ]) {
      const response = await api.send({ headers });
      assert.equal(response.status, 401, JSON.stringify(headers));
      assert.equal(JSON.parse(response.body).error.code, 'UNAUTHORIZED');
    }
    assert.deepEqual(api.requests, []);
  } finally { await api.close(); }
});

void test('only accepts the exact Host header', async () => {
  const api = await start();
  try {
    for (const host of ['evil.example', 'localhost:3100', '127.0.0.1']) {
      const response = await api.send({ host, headers: authorized });
      assert.equal(response.status, 421, host);
      assert.equal(JSON.parse(response.body).error.code, 'HOST_NOT_ALLOWED');
    }
    assert.deepEqual(api.requests, []);
  } finally { await api.close(); }
});

void test('answers the CORS preflight for the console origin, allowing Authorization, and nothing else', async () => {
  const api = await start();
  try {
    const response = await api.send({ method: 'OPTIONS', headers: {
      origin: ORIGIN, 'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    } });
    assert.equal(response.status, 204);
    assert.equal(response.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(response.headers['access-control-allow-methods'], 'GET, OPTIONS');
    assert.equal(response.headers['access-control-allow-headers'], 'Authorization');
    assert.equal(response.body, '');
    assert.notEqual(response.headers['access-control-allow-origin'], '*');
  } finally { await api.close(); }
});

void test('serves only GET and OPTIONS on the single overview route', async () => {
  const api = await start();
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const response = await api.send({ method, headers: authorized });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.allow, 'GET, OPTIONS');
    }
    const missing = await api.send({ path: '/operator/v1/live/other', headers: authorized });
    assert.equal(missing.status, 404);
    assert.deepEqual(api.requests, []);
  } finally { await api.close(); }
});

void test('validates limit and cursor and forwards the decoded keyset', async () => {
  const api = await start();
  try {
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'limit=10.5']) {
      const response = await api.send({ path: `/operator/v1/live/overview?${query}`, headers: authorized });
      assert.equal(response.status, 400, query);
      assert.equal(JSON.parse(response.body).error.code, 'INVALID_LIMIT');
    }
    const bad = await api.send({ path: '/operator/v1/live/overview?cursor=not-a-cursor', headers: authorized });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).error.code, 'INVALID_CURSOR');
    const cursor = encodeLedgerCursor({ closedAtMs: 1_780_000_000_000, id: 'execution_live_position_a' });
    const ok = await api.send({ path: `/operator/v1/live/overview?limit=100&cursor=${cursor}`, headers: authorized });
    assert.equal(ok.status, 200);
    assert.deepEqual(api.requests, [{
      limit: 100, cursor: { closedAtMs: 1_780_000_000_000, id: 'execution_live_position_a' },
    }]);
  } finally { await api.close(); }
});

void test('a failing reader returns a redacted 500 and logs only the error name', async () => {
  const api = await start(() => Promise.reject(new TypeError('connection string postgres://secret')));
  try {
    const response = await api.send({ headers: authorized });
    assert.equal(response.status, 500);
    assert.equal(JSON.parse(response.body).error.code, 'INTERNAL_ERROR');
    assert.equal(response.body.includes('secret'), false);
    assert.deepEqual(api.errors, ['TypeError']);
    const next = await api.send({ headers: authorized });
    assert.equal(next.status, 500);
  } finally { await api.close(); }
});

void test('serializes concurrent overview reads', async () => {
  let active = 0;
  let peak = 0;
  const api = await start(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    active -= 1;
    return page;
  });
  try {
    const responses = await Promise.all([1, 2, 3].map(() => api.send({ headers: authorized })));
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
    assert.equal(peak, 1);
  } finally { await api.close(); }
});
````

- [ ] **Step 2: run it and see it fail**

```bash
npx tsx --test tests/operator-api-server.test.ts
```

Expected: `Cannot find module '../src/operator-api/server.js'`.

- [ ] **Step 3: implement**

Create `src/operator-api/server.ts`:

````ts
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodeLedgerCursor } from '../api/cursor.js';
import { success, writeJson } from '../interfaces/http/api-response.js';
import type { LiveOverviewReader, LiveOverviewRequest } from './repository.js';

export const OPERATOR_OVERVIEW_PATH = '/operator/v1/live/overview';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ALLOW = 'GET, OPTIONS';

export type OperatorApiErrorCode =
  | 'UNAUTHORIZED' | 'HOST_NOT_ALLOWED' | 'METHOD_NOT_ALLOWED' | 'ROUTE_NOT_FOUND'
  | 'INVALID_LIMIT' | 'INVALID_CURSOR' | 'INTERNAL_ERROR';

const MESSAGES: Readonly<Record<OperatorApiErrorCode, string>> = {
  UNAUTHORIZED: 'A valid operator token is required',
  HOST_NOT_ALLOWED: 'The request host is not allowed',
  METHOD_NOT_ALLOWED: 'The HTTP method is not allowed for this route',
  ROUTE_NOT_FOUND: 'The requested route was not found',
  INVALID_LIMIT: 'The limit is invalid',
  INVALID_CURSOR: 'The cursor is invalid',
  INTERNAL_ERROR: 'An internal error occurred',
};

export interface OperatorApiHandlerOptions {
  readonly token: string;
  readonly allowedHost: string;
  readonly allowedOrigin: string;
  readonly overview: LiveOverviewReader;
  readonly now: () => number;
  readonly logError?: (errorName: string) => void;
}

export type OperatorApiHandler = (request: IncomingMessage, response: ServerResponse) => void;

export function createOperatorApiHandler(options: OperatorApiHandlerOptions): OperatorApiHandler {
  const expectedDigest = digest(options.token);
  const corsHeaders = Object.freeze({
    'access-control-allow-origin': options.allowedOrigin,
    vary: 'Origin',
  });
  // The database wrapper allows one active client; requests wait for each other.
  let queue: Promise<unknown> = Promise.resolve();

  const fail = (
    response: ServerResponse, status: number, code: OperatorApiErrorCode,
    extra: Readonly<Record<string, string>> = {},
  ): void => {
    writeJson(response, status, {
      apiVersion: 'v1', error: { code, message: MESSAGES[code] },
    }, false, { ...corsHeaders, ...extra });
  };

  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.headers.host !== options.allowedHost) {
      fail(response, 421, 'HOST_NOT_ALLOWED');
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...corsHeaders,
        allow: ALLOW,
        'access-control-allow-methods': ALLOW,
        'access-control-allow-headers': 'Authorization',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
      });
      response.end();
      return;
    }
    if (request.method !== 'GET') {
      fail(response, 405, 'METHOD_NOT_ALLOWED', { allow: ALLOW });
      return;
    }
    if (!isAuthorized(request.headers.authorization, expectedDigest)) {
      fail(response, 401, 'UNAUTHORIZED', { 'www-authenticate': 'Bearer' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://operator.invalid');
    if (url.pathname !== OPERATOR_OVERVIEW_PATH) {
      fail(response, 404, 'ROUTE_NOT_FOUND');
      return;
    }
    const parsed = parseRequest(url.searchParams);
    if (typeof parsed === 'string') {
      fail(response, 400, parsed);
      return;
    }
    const run = queue.then(() => options.overview.read(parsed));
    queue = run.catch(() => undefined);
    const page = await run;
    writeJson(response, 200, success(page.data, options.now(), page.nextCursor), false, corsHeaders);
  };

  return (request, response) => {
    serve(request, response).catch((error: unknown) => {
      try {
        options.logError?.(error instanceof Error ? error.name : 'UnknownError');
      } catch { /* diagnostics never change the response */ }
      if (!response.headersSent) fail(response, 500, 'INTERNAL_ERROR');
      else response.destroy();
    });
  };
}

function parseRequest(query: URLSearchParams): LiveOverviewRequest | 'INVALID_LIMIT' | 'INVALID_CURSOR' {
  const rawLimit = query.get('limit');
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^[1-9]\d{0,2}$/u.test(rawLimit)) return 'INVALID_LIMIT';
    limit = Number(rawLimit);
    if (limit > MAX_LIMIT) return 'INVALID_LIMIT';
  }
  const rawCursor = query.get('cursor');
  if (rawCursor === null) return { limit, cursor: null };
  try {
    return { limit, cursor: decodeLedgerCursor(rawCursor) };
  } catch {
    return 'INVALID_CURSOR';
  }
}

function isAuthorized(header: string | undefined, expectedDigest: Buffer): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice('Bearer '.length)), expectedDigest);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
````

- [ ] **Step 4: run, typecheck, lint**

```bash
npx tsx --test tests/operator-api-server.test.ts
npx tsc -p tsconfig.json --noEmit
npx eslint src/operator-api tests/operator-api-server.test.ts --max-warnings=0
```

Expected: 8 tests pass; tsc and eslint print nothing.

- [ ] **Step 5: commit**

```bash
git add src/operator-api/server.ts tests/operator-api-server.test.ts
git commit -m "feat(operator-api): serve the overview behind a bearer token, Host allowlist and one-origin CORS" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Configuration, entrypoint, scripts, boundary test, operations doc

**Files:**
- Create: `src/operator-api/config.ts`, `src/operator-api/database.ts`, `src/operator-api/main.ts`
- Create: `tests/operator-api-config.test.ts`, `tests/operator-api-architecture.test.ts`
- Modify: `package.json` (scripts, after `executor:live:start`, :31)
- Modify: `docs/operations/executor-live-canary.md` (new section before `## Exécuter H2j sans autorité live`, :291)

Facts verified: `createExecutionPreflightSourceDatabase` (`src/preflight-source/database.ts`) forces `SET ROLE sol_token_operator_reader`, `SET search_path = pg_catalog, public` and validates `session_replication_role = origin` plus the exact authority on every checkout; its import graph reaches only domain modules (no `executor-live*`, no keypair, no write SQL). `literalRuntimeModuleSpecifiers` is exported from `tests/helpers/execution-boundary.ts:189`. The runbook has a section on "sept environnements"; this adds the eighth.

- [ ] **Step 1: write the failing tests**

````ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { OperatorApiConfigError, parseOperatorApiConfig } from '../src/operator-api/config.js';

const ENVIRONMENT = Object.freeze({
  OPERATOR_API_DATABASE_URL: 'postgresql://operator:secret@127.0.0.1:5432/sol_token_listener',
  OPERATOR_API_TOKEN: 'a'.repeat(32),
  OPERATOR_API_ALLOWED_ORIGIN: 'http://127.0.0.1:4173',
  SOLANA_HTTP_RPC_URL: 'https://rpc.example/key',
});

void test('parses the operator API environment with loopback defaults', () => {
  assert.deepEqual(parseOperatorApiConfig(ENVIRONMENT), {
    databaseUrl: ENVIRONMENT.OPERATOR_API_DATABASE_URL,
    token: ENVIRONMENT.OPERATOR_API_TOKEN,
    host: '127.0.0.1',
    port: 3100,
    allowedOrigin: 'http://127.0.0.1:4173',
    solanaHttpRpcUrl: 'https://rpc.example/key',
  });
  assert.deepEqual(
    parseOperatorApiConfig({ ...ENVIRONMENT, OPERATOR_API_HOST: 'localhost', OPERATOR_API_PORT: '3999' }),
    { ...parseOperatorApiConfig(ENVIRONMENT), host: 'localhost', port: 3999 },
  );
});

void test('rejects a short token, a bad origin, a bad port and missing variables', () => {
  for (const changed of [
    { OPERATOR_API_TOKEN: 'a'.repeat(31) },
    { OPERATOR_API_TOKEN: `${'a'.repeat(31)} ` },
    { OPERATOR_API_ALLOWED_ORIGIN: 'http://127.0.0.1:4173/' },
    { OPERATOR_API_ALLOWED_ORIGIN: 'http://127.0.0.1:4173/console' },
    { OPERATOR_API_ALLOWED_ORIGIN: '*' },
    { OPERATOR_API_PORT: '0' },
    { OPERATOR_API_PORT: '65536' },
    { OPERATOR_API_PORT: '3100.5' },
    { OPERATOR_API_HOST: '::1' },
    { OPERATOR_API_DATABASE_URL: 'mysql://operator@db/x' },
    { SOLANA_HTTP_RPC_URL: 'wss://rpc.example' },
  ]) {
    assert.throws(() => parseOperatorApiConfig({ ...ENVIRONMENT, ...changed }),
      OperatorApiConfigError, JSON.stringify(changed));
  }
  for (const key of Object.keys(ENVIRONMENT)) {
    const { [key as keyof typeof ENVIRONMENT]: _removed, ...rest } = ENVIRONMENT;
    assert.throws(() => parseOperatorApiConfig(rest), OperatorApiConfigError, key);
  }
  assert.throws(() => parseOperatorApiConfig(null), OperatorApiConfigError);
});

void test('refuses any keypair, live-mode or arming variable in the process environment', () => {
  for (const key of [
    'EXECUTOR_KEYPAIR_PATH', 'SOLANA_PRIVATE_KEY', 'WALLET_SECRET_KEY', 'LIVE_TRADING_ENABLED',
    'EXECUTOR_MODE', 'EXECUTOR_ARMAMENT_ID', 'EXECUTOR_RECOVERY_PHRASE',
  ]) {
    assert.throws(() => parseOperatorApiConfig({ ...ENVIRONMENT, [key]: 'x' }),
      OperatorApiConfigError, key);
  }
});

void test('the configuration error carries no secret', () => {
  try {
    parseOperatorApiConfig({ ...ENVIRONMENT, OPERATOR_API_TOKEN: 'short' });
    assert.fail('expected rejection');
  } catch (error) {
    assert.ok(error instanceof OperatorApiConfigError);
    assert.equal(error.message.includes('short'), false);
    assert.equal(error.message.includes('secret'), false);
  }
});
````

````ts
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { literalRuntimeModuleSpecifiers } from './helpers/execution-boundary.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = resolve(repositoryRoot, 'src/operator-api/main.ts');

async function readGraph(entry: string): Promise<{
  readonly sources: ReadonlyMap<string, string>;
  readonly externals: ReadonlySet<string>;
}> {
  const sources = new Map<string, string>();
  const externals = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    if (sources.has(path)) return;
    const source = await readFile(path, 'utf8');
    sources.set(path, source);
    for (const specifier of literalRuntimeModuleSpecifiers(source, path)) {
      if (!specifier.startsWith('.')) {
        externals.add(specifier);
        continue;
      }
      const target = resolve(dirname(path), specifier.replace(/\.js$/u, '.ts'));
      await access(target);
      await visit(target);
    }
  };
  await visit(entry);
  return { sources, externals };
}

void test('the operator API graph cannot reach live execution, keypairs or signing', async () => {
  const { sources } = await readGraph(ENTRY);
  const paths = [...sources.keys()].map((path) => relative(repositoryRoot, path));
  assert.ok(paths.includes('src/operator-api/server.ts'));
  assert.ok(paths.includes('src/preflight-source/database.ts'));
  assert.deepEqual(paths.filter((path) => (
    /^src\/(?:executor-live|executor-live-recovery|executor-operations|execution)\//u.test(path)
    || /(?:keypair|transaction-signer|submission-gateway)/u.test(path)
  )), []);
  for (const [path, source] of sources) {
    assert.doesNotMatch(source,
      /\b(?:Keypair|sendRawTransaction|sendTransaction|signTransaction|signMessage|simulateTransaction)\b/u,
      `signing or submission capability in ${relative(repositoryRoot, path)}`);
  }
});

void test('the operator API graph contains no write SQL and a single RPC method', async () => {
  const { sources, externals } = await readGraph(ENTRY);
  for (const [path, source] of sources) {
    assert.doesNotMatch(source,
      /\b(?:INSERT\s+INTO|UPDATE\s+["\w]+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE)\b/iu,
      `write SQL in ${relative(repositoryRoot, path)}`);
  }
  const rpc = await readFile(resolve(repositoryRoot, 'src/operator-api/rpc-balance.ts'), 'utf8');
  assert.deepEqual([...rpc.matchAll(/jsonrpc:[^}]*?method:\s*'([A-Za-z]+)'/gu)].map((match) => match[1]), ['getBalance']);
  // @solana/web3.js is reached only through shared domain modules (address validation); the
  // Keypair and submission capabilities are excluded by the previous test.
  assert.deepEqual([...externals].sort(), [
    '@solana/web3.js', 'node:crypto', 'node:fs', 'node:http', 'node:url', 'node:util/types', 'pg',
  ]);
});

void test('the operator API server handles only GET and OPTIONS', async () => {
  const server = await readFile(resolve(repositoryRoot, 'src/operator-api/server.ts'), 'utf8');
  assert.deepEqual([...server.matchAll(/request\.method\s*[!=]==\s*'([A-Z]+)'/gu)].map((match) => match[1]),
    ['OPTIONS', 'GET']);
  assert.doesNotMatch(server, /\b(?:POST|PUT|PATCH|DELETE|HEAD)\b/u);
});
````

- [ ] **Step 2: run them and see them fail**

```bash
npx tsx --test tests/operator-api-config.test.ts tests/operator-api-architecture.test.ts
```

Expected: config test `Cannot find module '../src/operator-api/config.js'`; architecture tests fail with `ENOENT ... src/operator-api/main.ts`.

- [ ] **Step 3: implement**

Create `src/operator-api/config.ts`:

````ts
import { isProxy } from 'node:util/types';

// The operator console API holds no wallet, signing, live-mode or arming capability.
const FORBIDDEN_KEY = /(?:PRIVATE_KEY|SECRET_KEY|KEYPAIR|MNEMONIC|RECOVERY_PHRASE|LIVE_TRADING_ENABLED|EXECUTOR_MODE|ARMAMENT)/u;
const MINIMUM_TOKEN_LENGTH = 32;
const MAXIMUM_TOKEN_LENGTH = 256;

export interface OperatorApiConfig {
  readonly databaseUrl: string;
  readonly token: string;
  readonly host: string;
  readonly port: number;
  readonly allowedOrigin: string;
  readonly solanaHttpRpcUrl: string;
}

export class OperatorApiConfigError extends TypeError {
  public readonly code = 'INVALID_OPERATOR_API_CONFIG' as const;
  public constructor() {
    super('Invalid operator API configuration.');
    this.name = 'OperatorApiConfigError';
  }
}

export function parseOperatorApiConfig(input: unknown): OperatorApiConfig {
  try {
    if (!isEnvironment(input)) throw invalid();
    for (const key of Object.keys(input)) if (FORBIDDEN_KEY.test(key)) throw invalid();
    const token = required(input, 'OPERATOR_API_TOKEN');
    if (token.length < MINIMUM_TOKEN_LENGTH || token.length > MAXIMUM_TOKEN_LENGTH
      || !/^[\x21-\x7e]+$/u.test(token)) throw invalid();
    const host = optional(input, 'OPERATOR_API_HOST') ?? '127.0.0.1';
    if (!/^[A-Za-z0-9.-]{1,253}$/u.test(host)) throw invalid();
    const rawPort = optional(input, 'OPERATOR_API_PORT') ?? '3100';
    if (!/^[1-9]\d{0,4}$/u.test(rawPort) || Number(rawPort) > 65_535) throw invalid();
    return Object.freeze({
      databaseUrl: postgresUrl(required(input, 'OPERATOR_API_DATABASE_URL')),
      token,
      host,
      port: Number(rawPort),
      allowedOrigin: origin(required(input, 'OPERATOR_API_ALLOWED_ORIGIN')),
      solanaHttpRpcUrl: httpUrl(required(input, 'SOLANA_HTTP_RPC_URL')),
    });
  } catch { throw invalid(); }
}

function isEnvironment(value: unknown): value is Record<string, string | undefined> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isProxy(value);
}

function optional(environment: Record<string, string | undefined>, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(environment, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)
    || typeof descriptor.value !== 'string') throw invalid();
  const value = descriptor.value;
  if (value.length === 0 || value.trim() !== value || value.includes('\0')) throw invalid();
  return value;
}

function required(environment: Record<string, string | undefined>, key: string): string {
  const value = optional(environment, key);
  if (value === undefined) throw invalid();
  return value;
}

function postgresUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'postgresql:' && url.protocol !== 'postgres:')
    || url.hostname.length === 0 || url.hash.length > 0) throw invalid();
  return value;
}

function httpUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hash.length > 0) throw invalid();
  return value;
}

function origin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) throw invalid();
  return value;
}

function invalid(): OperatorApiConfigError {
  return new OperatorApiConfigError();
}
````

Create `src/operator-api/database.ts`:

````ts
import pg from 'pg';
import type { ExecutorDatabaseSource } from '../executor/database.js';
import { createExecutionPreflightSourceDatabase } from '../preflight-source/database.js';

export interface OperatorApiDatabase {
  readonly source: ExecutorDatabaseSource;
  readonly close: () => Promise<void>;
}

/**
 * One bounded connection that forces SET ROLE sol_token_operator_reader, the closed search
 * path and session_replication_role=origin on every checkout and refuses to serve when the
 * role authority drifts: the same exact-authority wrapper the preflight source export uses.
 */
export function openOperatorApiDatabase(options: Readonly<{
  databaseUrl: string;
  statementTimeoutMs: number;
  onIdleError: () => void;
}>): OperatorApiDatabase {
  const timeout = options.statementTimeoutMs;
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: 1,
    connectionTimeoutMillis: timeout,
    query_timeout: timeout,
    statement_timeout: timeout,
    lock_timeout: timeout,
    idle_in_transaction_session_timeout: timeout,
  });
  pool.on('error', options.onIdleError);
  return Object.freeze({
    source: createExecutionPreflightSourceDatabase(pool).pool,
    close: () => pool.end(),
  });
}
````

Create `src/operator-api/main.ts`:

````ts
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createBalanceCache } from './balance-cache.js';
import { parseOperatorApiConfig } from './config.js';
import { openOperatorApiDatabase } from './database.js';
import { createLiveOverviewReader } from './repository.js';
import { createRpcBalanceReader } from './rpc-balance.js';
import { createOperatorApiHandler } from './server.js';

const ENVIRONMENT_FILE = '.env.operator';

export async function main(): Promise<void> {
  if (existsSync(ENVIRONMENT_FILE)) process.loadEnvFile(ENVIRONMENT_FILE);
  const config = parseOperatorApiConfig(process.env);
  let stop: () => void = () => undefined;
  const database = openOperatorApiDatabase({
    databaseUrl: config.databaseUrl,
    statementTimeoutMs: 10_000,
    onIdleError: () => { process.stderr.write('OPERATOR_API_DATABASE_ERROR\n'); stop(); },
  });
  // Fail fast on a drifted role instead of at the first browser request.
  (await database.source.connect()).release();
  const server = createServer(createOperatorApiHandler({
    token: config.token,
    allowedHost: `${config.host}:${String(config.port)}`,
    allowedOrigin: config.allowedOrigin,
    now: Date.now,
    overview: createLiveOverviewReader({
      database: database.source,
      balances: createBalanceCache({
        fetchLamports: createRpcBalanceReader({ rpcUrl: config.solanaHttpRpcUrl }),
        now: Date.now,
      }),
      now: Date.now,
    }),
    logError: (name) => { process.stderr.write(`OPERATOR_API_REQUEST_FAILED ${name}\n`); },
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  process.stdout.write(`OPERATOR_API_LISTENING ${config.host}:${String(config.port)}\n`);
  const closed = new Promise<void>((resolve) => {
    stop = (): void => {
      server.close(() => { resolve(); });
      server.closeAllConnections();
    };
  });
  process.once('SIGINT', () => { stop(); });
  process.once('SIGTERM', () => { stop(); });
  await closed;
  await database.close();
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().catch(() => {
    process.stderr.write('OPERATOR_API_FAILED\n');
    process.exitCode = 1;
  });
}
````

Add the scripts:

````diff
--- a/package.json
+++ b/package.json
@@ -28,6 +28,8 @@
     "executor:live:recovery:start": "node dist/src/executor-live-recovery/main.js",
     "executor:live:dev": "tsx src/executor-live/main.ts",
     "executor:live:start": "node dist/src/executor-live/main.js",
+    "operator:api:dev": "tsx src/operator-api/main.ts",
+    "operator:api:start": "node dist/src/operator-api/main.js",
     "live:preflight": "node dist/src/executor-operations/main.js preflight",
     "live:status": "node dist/src/executor-operations/main.js status",
     "live:arm": "node dist/src/executor-operations/main.js arm",
````

Add the operations section:

````diff
--- a/docs/operations/executor-live-canary.md
+++ b/docs/operations/executor-live-canary.md
@@ -287,7 +287,56 @@
 swaps PumpSwap est volontairement inactif et l'API doit exposer
 `pipeline.pumpswap=IDLE`. Aucune preuve market antérieure ne doit dégrader cet
 état. Ce scope ne change aucune gate H2c et n'autorise aucune action réelle.
+
+## Console opérateur live (huitième frontière)
+
+La page `/live` de la console lit l'API opérateur `src/operator-api/`, un
+processus séparé, en lecture seule et authentifié par jeton. Il n'est pas
+déployé par Docker Compose ni exposé par nginx : le lancer à la main, sur la
+boucle locale.
+
+- login PostgreSQL membre uniquement de `sol_token_operator_reader`, comme
+  l'export H2h : `NOINHERIT`, `ADMIN FALSE, INHERIT FALSE, SET TRUE`, aucun
+  objet possédé. Le processus force `SET ROLE`, `search_path=pg_catalog,public`
+  et `session_replication_role=origin` à chaque checkout et refuse de servir si
+  l'autorité exacte du rôle dérive (même contrôle que H2h) ;
+- endpoint HTTP Mainnet, utilisé uniquement pour `getBalance` du wallet de la
+  génération active ;
+- aucune variable keypair, mode live, armement ou écriture : le processus refuse
+  de démarrer si l'une d'elles est présente.
 
+| Variable | Règle |
+|---|---|
+| `OPERATOR_API_DATABASE_URL` | login membre uniquement de `sol_token_operator_reader` |
+| `OPERATOR_API_TOKEN` | au moins 32 caractères ASCII imprimables |
+| `OPERATOR_API_HOST` / `OPERATOR_API_PORT` | `127.0.0.1` / `3100` par défaut ; l'en-tête `Host` doit valoir exactement `HOST:PORT` |
+| `OPERATOR_API_ALLOWED_ORIGIN` | origine exacte de la console, par exemple `http://127.0.0.1:4173` |
+| `SOLANA_HTTP_RPC_URL` | endpoint HTTP, appelé au plus toutes les 15 secondes |
+
+Les valeurs peuvent être exportées ou placées dans `.env.operator` à la racine
+(ignoré par Git, chargé s'il existe). Générer le jeton avec
+`openssl rand -base64 48 | tr -d '\n'`.
+
+Après la migration 061, rejouer `scripts/provision-executor-roles.sql` : le
+runtime H2a reçoit `INSERT` sur `execution_live_position_ledger`, le rôle
+`sol_token_operator_reader` reçoit `SELECT` sur le ledger, `SELECT` sur
+`bonding_curve_snapshots`, `market_pools`, `market_reserve_snapshots` et un
+`SELECT` par colonnes sur `execution_live_positions`. Le ledger n'est jamais
+purgé. Les positions fermées avant la migration ne sont pas reconstituées.
+
+```bash
+npm run build:backend
+npm run operator:api:start
+```
+
+Seule la route `GET /operator/v1/live/overview?limit=&cursor=` existe, avec
+`Authorization: Bearer <jeton>` ; `OPTIONS` répond au préflight CORS de l'unique
+origine autorisée. Toute autre méthode renvoie 405. Côté console, renseigner
+`operatorApiBaseUrl` dans `frontend/public/config.json`. Les montants affichés
+en PnL non réalisé sont un prix mid indicatif (sans glissement ni frais) ; le
+PnL réalisé est la somme `entrée + sortie` des deltas de lamports du wallet,
+frais et rent inclus.
+
 ## Exécuter H2j sans autorité live
 
 L'administrateur rejoue d'abord `scripts/provision-executor-roles.sql`, puis
````

- [ ] **Step 4: run, build, lint**

```bash
npx tsx --test tests/operator-api-config.test.ts tests/operator-api-architecture.test.ts tests/operator-api-server.test.ts tests/operator-api-pure.test.ts
npm run build:backend
npx tsx --test tests/executor-architecture.test.ts tests/executor-roles-provisioning.test.ts
npx tsc -p tsconfig.json --noEmit
npm run lint:backend
```

Expected: every test file `fail 0` (the second command needs `dist/` from `build:backend`; `executor-roles-provisioning` reads the runbook and still finds its assertions); `lint:backend` prints nothing.

- [ ] **Step 5: commit**

```bash
git add src/operator-api tests/operator-api-config.test.ts tests/operator-api-architecture.test.ts package.json docs/operations/executor-live-canary.md
git commit -m "feat(operator-api): add the separate read-only process, its scripts and its operations section" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Frontend data layer (runtime config, operator client, schema, query)

**Files:**
- Modify: `frontend/src/data/api-client.ts` (extract the request closure into exported `createJsonRequester`; behaviour unchanged)
- Modify: `frontend/src/data/api-schemas.ts` (export `successEnvelope`; two failure codes)
- Modify: `frontend/src/data/runtime-config.ts`, `frontend/src/data/runtime-config.test.ts`
- Modify: `frontend/src/data/query-keys.ts`, `frontend/src/data/queries.ts`
- Modify: `frontend/tests/fixtures/api.ts`
- Create: `frontend/src/data/operator-schemas.ts`, `operator-client.ts`, `operator-client.test.ts`, `operator-token.ts`, `operator-token.test.ts`

Facts verified: all commands below run from `frontend/` or through the workspace (`npm test --workspace frontend`). `exactOptionalPropertyTypes` is on, so an absent optional key must be omitted, not `undefined`. Do not assert on `localStorage` in tests (Node 25 prints an experimental-localStorage warning and the global is unusable).

- [ ] **Step 1: write the failing tests**

````ts
// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { liveOverview, success } from '../../tests/fixtures/api.js';
import { ApiContractError, ApiHttpError } from './api-client.js';
import { createOperatorClient } from './operator-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('operator client', () => {
  it('sends the bearer token on a GET and returns the overview with its cursor', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(success(liveOverview, 'next')));
    const client = createOperatorClient({
      operatorApiBaseUrl: 'http://127.0.0.1:3100', token: 'secret-token', fetchFn,
    });

    const page = await client.getLiveOverview({ limit: 50, cursor: 'opaque/+=' });

    expect(page.nextCursor).toBe('next');
    expect(page.overview.history[0]?.realizedLamports).toBe('-4205');
    const [input, init] = fetchFn.mock.calls[0] ?? [];
    expect((input as URL).href).toBe('http://127.0.0.1:3100/operator/v1/live/overview?limit=50&cursor=opaque%2F%2B%3D');
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer secret-token' },
    });
    expect(init).not.toHaveProperty('body');
  });

  it('maps a 401 to an HTTP error carrying the status and never exposes the token', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      apiVersion: 'v1', error: { code: 'UNAUTHORIZED', message: 'A valid operator token is required' },
    }, 401));
    const client = createOperatorClient({
      operatorApiBaseUrl: 'http://127.0.0.1:3100', token: 'secret-token', fetchFn,
    });

    const error = await client.getLiveOverview().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiHttpError);
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED', retryable: false });
    expect(JSON.stringify(error)).not.toContain('secret-token');
  });

  it('rejects an overview whose amounts are not decimal strings', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(success({
      ...liveOverview, totals: { ...liveOverview.totals, realizedLamports: -4205 },
    })));
    const client = createOperatorClient({
      operatorApiBaseUrl: 'http://127.0.0.1:3100', token: 'secret-token', fetchFn,
    });

    await expect(client.getLiveOverview()).rejects.toBeInstanceOf(ApiContractError);
  });

  it('accepts an overview without an active wallet', async () => {
    const empty = {
      availability: 'NOT_AVAILABLE', wallet: null, balance: null, open: [], history: [],
      totals: { realizedLamports: '0', unrealizedLamports: '0', openCount: 0, positionsWithoutPnl: 0 },
    };
    const client = createOperatorClient({
      operatorApiBaseUrl: 'http://127.0.0.1:3100', token: 'secret-token',
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(success(empty))),
    });

    expect((await client.getLiveOverview()).overview.availability).toBe('NOT_AVAILABLE');
  });
});
````

````ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearOperatorToken, readOperatorToken, saveOperatorToken } from './operator-token.js';

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('operator token storage', () => {
  it('keeps the token in sessionStorage only and forgets it on demand', () => {
    expect(readOperatorToken()).toBeNull();
    saveOperatorToken('secret-token');
    expect(readOperatorToken()).toBe('secret-token');
    expect(window.sessionStorage.getItem('operator-api-token')).toBe('secret-token');
    clearOperatorToken();
    expect(readOperatorToken()).toBeNull();
  });

  it('tolerates a blocked storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readOperatorToken()).toBeNull();
    expect(() => { saveOperatorToken('secret-token'); }).not.toThrow();
    expect(() => { clearOperatorToken(); }).not.toThrow();
  });
});
````

Fixture used by the tests and by Task 9 (append to `frontend/tests/fixtures/api.ts`) and the runtime-config tests:

````diff
--- a/frontend/tests/fixtures/api.ts
+++ b/frontend/tests/fixtures/api.ts
@@ -345,3 +345,34 @@
 } {
   return { apiVersion: 'v1', meta: { generatedAt: NOW, nextCursor }, data };
 }
+
+export const SIGNATURE = '5'.repeat(88);
+
+export const liveOverview = {
+  availability: 'AVAILABLE',
+  wallet: MINT,
+  balance: { lamports: '2500000000', observedAt: NOW },
+  open: [{
+    positionId: 'execution_live_position_open',
+    mint: QUOTE_MINT,
+    state: 'OPEN',
+    openedAt: '2026-08-10T23:55:00.000Z',
+    exitDeadlineAt: '2026-08-11T00:10:00.000Z',
+    remainingRaw: '35000000000',
+    costLamports: '1005000',
+    spotValueLamports: '1200000',
+    unrealizedLamports: '195000',
+  }],
+  history: [{
+    positionId: 'execution_live_position_closed',
+    mint: QUOTE_MINT,
+    openedAt: '2026-08-10T22:00:00.000Z',
+    closedAt: '2026-08-10T22:05:00.000Z',
+    entrySignature: SIGNATURE,
+    exitSignature: SIGNATURE,
+    realizedLamports: '-4205',
+  }],
+  totals: {
+    realizedLamports: '-4205', unrealizedLamports: '195000', openCount: 1, positionsWithoutPnl: 0,
+  },
+} as const;
````

````diff
--- a/frontend/src/data/runtime-config.test.ts
+++ b/frontend/src/data/runtime-config.test.ts
@@ -23,6 +23,33 @@
     }));
   });
 
+  it('loads an optional operator API URL with the same normalization and leaves it absent otherwise', async () => {
+    const withOperator = vi.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify({
+      apiBaseUrl: 'https://api.example.test',
+      operatorApiBaseUrl: 'http://127.0.0.1:3100/',
+    })));
+    await expect(loadRuntimeConfig(withOperator)).resolves.toEqual({
+      apiBaseUrl: 'https://api.example.test',
+      operatorApiBaseUrl: 'http://127.0.0.1:3100',
+    });
+    const without = vi.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify({
+      apiBaseUrl: 'https://api.example.test',
+    })));
+    expect(await loadRuntimeConfig(without)).not.toHaveProperty('operatorApiBaseUrl');
+  });
+
+  it.each([
+    ['relative URL', '/operator'],
+    ['credentials', 'https://user:password@operator.example.test'],
+    ['query', 'https://operator.example.test?token=value'],
+    ['javascript scheme', 'javascript:alert(1)'],
+  ])('rejects an operator API URL with %s', async (_label, operatorApiBaseUrl) => {
+    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify({
+      apiBaseUrl: 'https://api.example.test', operatorApiBaseUrl,
+    })));
+    await expect(loadRuntimeConfig(fetchFn)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
+  });
+
   it('uses an injected canonical origin when the public API URL is exactly root', async () => {
     const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify({ apiBaseUrl: '/' })));
 
````

- [ ] **Step 2: run them and see them fail**

```bash
npm test --workspace frontend -- src/data
```

Expected: `operator-client.test.ts` and `operator-token.test.ts` fail to import (`Failed to resolve import "./operator-client.js"`), the two new `runtime-config` tests fail (`operatorApiBaseUrl` rejected by the strict schema).

- [ ] **Step 3: implement**

````diff
--- a/frontend/src/data/api-client.ts
+++ b/frontend/src/data/api-client.ts
@@ -61,13 +61,22 @@
   readonly maxResponseBytes?: number;
 }
 
-export function createApiClient(options: ApiClientOptions): ApiClient {
-  const fetchFn = options.fetchFn ?? fetch;
-  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
-  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
+export interface JsonRequesterOptions {
+  readonly apiBaseUrl: string;
+  readonly fetchFn: typeof fetch;
+  readonly timeoutMs: number;
+  readonly maxResponseBytes: number;
+  readonly headers: Readonly<Record<string, string>>;
+}
+
+export type JsonRequester = <T>(route: string, schema: z.ZodType<T>, signal?: AbortSignal) => Promise<T>;
+
+/** Bounded, timed, GET-only JSON request with schema validation, shared by every client. */
+export function createJsonRequester(options: JsonRequesterOptions): JsonRequester {
+  const { fetchFn, timeoutMs, maxResponseBytes } = options;
   const baseUrl = `${options.apiBaseUrl.replace(/\/+$/u, '')}/`;
 
-  async function request<T>(route: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
+  return async function request<T>(route: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
     if (didAbort(signal)) throw signal?.reason;
     const requestController = new AbortController();
     const timeout = setTimeout(() => {
@@ -82,7 +91,7 @@
       try {
         response = await fetchFn(new URL(route.replace(/^\/+/, ''), baseUrl), {
           method: 'GET',
-          headers: { Accept: 'application/json' },
+          headers: options.headers,
           signal: requestController.signal,
         });
       } catch (error) {
@@ -119,8 +128,18 @@
       clearTimeout(timeout);
       signal?.removeEventListener('abort', propagateAbort);
     }
-  }
+  };
+}
 
+export function createApiClient(options: ApiClientOptions): ApiClient {
+  const request = createJsonRequester({
+    apiBaseUrl: options.apiBaseUrl,
+    fetchFn: options.fetchFn ?? fetch,
+    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
+    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
+    headers: { Accept: 'application/json' },
+  });
+
   function pageRoute(route: string, input: PageInput = {}): string {
     const query = new URLSearchParams();
     if (input.limit !== undefined) query.set('limit', String(input.limit));
````

````diff
--- a/frontend/src/data/api-schemas.ts
+++ b/frontend/src/data/api-schemas.ts
@@ -874,7 +874,7 @@
   nextCursor: z.string().nullable(),
 }).strict();
 
-function successEnvelope<T extends z.ZodType>(data: T): z.ZodObject<{
+export function successEnvelope<T extends z.ZodType>(data: T): z.ZodObject<{
   apiVersion: z.ZodLiteral<'v1'>;
   meta: typeof apiMetaSchema;
   data: T;
@@ -912,7 +912,7 @@
     code: z.enum([
       'ROUTE_NOT_FOUND', 'METHOD_NOT_ALLOWED', 'NOT_ACCEPTABLE', 'INVALID_MINT',
       'INVALID_LIMIT', 'INVALID_CURSOR', 'LAUNCH_NOT_FOUND', 'EVENT_CURSOR_EXPIRED',
-      'DEPENDENCY_UNAVAILABLE', 'INTERNAL_ERROR',
+      'DEPENDENCY_UNAVAILABLE', 'INTERNAL_ERROR', 'UNAUTHORIZED', 'HOST_NOT_ALLOWED',
     ]),
     message: z.string().min(1),
     correlationId: z.string().min(1).optional(),
````

````diff
--- a/frontend/src/data/runtime-config.ts
+++ b/frontend/src/data/runtime-config.ts
@@ -6,10 +6,12 @@
 
 const runtimeConfigSchema = z.object({
   apiBaseUrl: z.string().min(1).max(2_048),
+  operatorApiBaseUrl: z.string().min(1).max(2_048).optional(),
 }).strict();
 
 export interface RuntimeConfig {
   readonly apiBaseUrl: string;
+  readonly operatorApiBaseUrl?: string;
 }
 
 export type RuntimeConfigErrorCode =
@@ -57,7 +59,13 @@
   }
   const parsed = runtimeConfigSchema.safeParse(decoded);
   if (!parsed.success) throw new RuntimeConfigError('CONFIG_INVALID');
-  return Object.freeze({ apiBaseUrl: normalizeApiBaseUrl(parsed.data.apiBaseUrl, currentOrigin) });
+  const { apiBaseUrl, operatorApiBaseUrl } = parsed.data;
+  return Object.freeze({
+    apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl, currentOrigin),
+    ...(operatorApiBaseUrl === undefined
+      ? {}
+      : { operatorApiBaseUrl: normalizeApiBaseUrl(operatorApiBaseUrl, currentOrigin) }),
+  });
 }
 
 function assertContentLength(value: string | null): void {
````

````diff
--- a/frontend/src/data/query-keys.ts
+++ b/frontend/src/data/query-keys.ts
@@ -11,6 +11,7 @@
   holders: (mint: string): QueryKey => ['launches', mint, 'holders'],
   paperPositions: Object.freeze({ all: ['paper-positions'] as const }),
   health: ['health'] as const,
+  liveOverview: ['live', 'overview'] as const,
 });
 
 const HOLDER_EVENTS = new Set<ApiSseEvent['type']>([
````

````diff
--- a/frontend/src/data/queries.ts
+++ b/frontend/src/data/queries.ts
@@ -6,6 +6,7 @@
   UndefinedInitialDataOptions,
 } from '@tanstack/react-query';
 import type { ApiClient, ApiPage, PageInput } from './api-client.js';
+import type { OperatorClient, OperatorOverviewPage } from './operator-client.js';
 import type {
   ApiHealth,
   ApiHolders,
@@ -139,3 +140,23 @@
     ...retryOptions,
   });
 }
+
+export function liveOverviewInfiniteQuery(
+  client: OperatorClient,
+  limit = DEFAULT_PAGE_SIZE,
+): UndefinedInitialDataInfiniteOptions<
+  OperatorOverviewPage,
+  Error,
+  InfiniteData<OperatorOverviewPage, string | null>,
+  typeof queryKeys.liveOverview,
+  string | null
+> {
+  return infiniteQueryOptions({
+    queryKey: queryKeys.liveOverview,
+    queryFn: async ({ pageParam, signal }) => await client.getLiveOverview(pageInput(pageParam, signal, limit)),
+    initialPageParam: null as string | null,
+    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
+    refetchInterval: 15_000,
+    ...retryOptions,
+  });
+}
````

Create `frontend/src/data/operator-schemas.ts`:

````ts
import { z } from 'zod';
import { successEnvelope } from './api-schemas.js';

const unsignedIntegerSchema = z.string().regex(/^\d+$/u);
const signedIntegerSchema = z.string().regex(/^-?\d+$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const publicKeySchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u);
const signatureSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,128}$/u);

const openPositionSchema = z.object({
  positionId: z.string().min(1),
  mint: publicKeySchema,
  state: z.enum(['OPEN', 'EXIT_PENDING', 'UNKNOWN']),
  openedAt: timestampSchema,
  exitDeadlineAt: timestampSchema,
  remainingRaw: unsignedIntegerSchema,
  costLamports: unsignedIntegerSchema,
  spotValueLamports: unsignedIntegerSchema.nullable(),
  unrealizedLamports: signedIntegerSchema.nullable(),
}).loose();

const closedPositionSchema = z.object({
  positionId: z.string().min(1),
  mint: publicKeySchema,
  openedAt: timestampSchema,
  closedAt: timestampSchema,
  entrySignature: signatureSchema,
  exitSignature: signatureSchema,
  realizedLamports: signedIntegerSchema,
}).loose();

const liveOverviewSchema = z.object({
  availability: z.enum(['AVAILABLE', 'NOT_AVAILABLE']),
  wallet: publicKeySchema.nullable(),
  balance: z.object({
    lamports: unsignedIntegerSchema,
    observedAt: timestampSchema,
  }).loose().nullable(),
  open: z.array(openPositionSchema),
  history: z.array(closedPositionSchema),
  totals: z.object({
    realizedLamports: signedIntegerSchema,
    unrealizedLamports: signedIntegerSchema,
    openCount: z.number().int().nonnegative(),
    positionsWithoutPnl: z.number().int().nonnegative(),
  }).loose(),
}).loose();

export const operatorLiveOverviewEnvelopeSchema = successEnvelope(liveOverviewSchema);

export type OperatorLiveOverview = z.infer<typeof liveOverviewSchema>;
export type OperatorOpenPosition = z.infer<typeof openPositionSchema>;
export type OperatorClosedPosition = z.infer<typeof closedPositionSchema>;
````

Create `frontend/src/data/operator-client.ts`:

````ts
import { createJsonRequester } from './api-client.js';
import type { PageInput } from './api-client.js';
import { operatorLiveOverviewEnvelopeSchema } from './operator-schemas.js';
import type { OperatorLiveOverview } from './operator-schemas.js';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface OperatorOverviewPage {
  readonly overview: OperatorLiveOverview;
  readonly nextCursor: string | null;
}

export interface OperatorClient {
  getLiveOverview(input?: PageInput): Promise<OperatorOverviewPage>;
}

export interface OperatorClientOptions {
  readonly operatorApiBaseUrl: string;
  readonly token: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** Same bounded GET-only transport as the public client, plus the operator bearer token. */
export function createOperatorClient(options: OperatorClientOptions): OperatorClient {
  const request = createJsonRequester({
    apiBaseUrl: options.operatorApiBaseUrl,
    fetchFn: options.fetchFn ?? fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    headers: { Accept: 'application/json', Authorization: `Bearer ${options.token}` },
  });
  return Object.freeze({
    async getLiveOverview(input: PageInput = {}): Promise<OperatorOverviewPage> {
      const query = new URLSearchParams();
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      if (input.cursor !== undefined) query.set('cursor', input.cursor);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      const envelope = await request(
        `/operator/v1/live/overview${suffix}`, operatorLiveOverviewEnvelopeSchema, input.signal,
      );
      return { overview: envelope.data, nextCursor: envelope.meta.nextCursor };
    },
  });
}
````

Create `frontend/src/data/operator-token.ts`:

````ts
const TOKEN_KEY = 'operator-api-token';

// sessionStorage keeps the token for this tab only; every access tolerates a blocked store.
export function readOperatorToken(): string | null {
  try {
    const value = globalThis.sessionStorage.getItem(TOKEN_KEY);
    return value === null || value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

export function saveOperatorToken(token: string): void {
  try {
    globalThis.sessionStorage.setItem(TOKEN_KEY, token);
  } catch { /* the token then lives only in component state */ }
}

export function clearOperatorToken(): void {
  try {
    globalThis.sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* nothing was stored */ }
}
````

- [ ] **Step 4: run the whole data layer, typecheck and lint**

```bash
npm test --workspace frontend -- src/data
npm run check --workspace frontend
npm run lint --workspace frontend
```

Expected: `Test Files 12 passed`, including the untouched `api-client.test.ts` (regression guard for the refactor); check and lint print nothing.

- [ ] **Step 5: commit**

```bash
git add frontend
git commit -m "feat(frontend): add the operator client, schema, token storage and live overview query" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Token prompt and `/live` page

**Files:**
- Create: `frontend/src/features/live/format-sol.ts`, `token-prompt.tsx`, `live-page.tsx`, `live-page.test.tsx`

Facts verified: `formatRawAmount(raw, 9)` and `formatBasisPoints` (`frontend/src/data/decimal.ts`) format via `bigint`; `SafeExternalLink` (`frontend/src/components/safe-external-link.tsx`) renders `target=_blank rel="noopener noreferrer"` and refuses non-HTTP URLs; `ApiHttpError` (`frontend/src/data/api-errors.ts`) carries `status`. The token never enters a query key or the URL; a 401 clears `sessionStorage`, drops the cached overview and shows the prompt with `Token refusé`.

- [ ] **Step 1: write the failing test**

````tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveOverview, SIGNATURE, success } from '../../../tests/fixtures/api.js';
import { ApiHttpError } from '../../data/api-errors.js';
import type { OperatorClient } from '../../data/operator-client.js';
import { operatorLiveOverviewEnvelopeSchema } from '../../data/operator-schemas.js';
import { LivePage } from './live-page.js';
import type { LivePageProps } from './live-page.js';

const overview = operatorLiveOverviewEnvelopeSchema.parse(success(liveOverview)).data;

afterEach(() => {
  window.sessionStorage.clear();
});

function renderPage(
  getLiveOverview: OperatorClient['getLiveOverview'],
  operatorApiBaseUrl: string | null = 'http://127.0.0.1:3100',
): ReturnType<typeof vi.fn> {
  const createClient = vi.fn<NonNullable<LivePageProps['createClient']>>(() => ({ getLiveOverview }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><LivePage operatorApiBaseUrl={operatorApiBaseUrl} createClient={createClient} /></MemoryRouter>
    </QueryClientProvider>,
  );
  return createClient;
}

async function enterToken(token = 'secret-token'): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Jeton opérateur'), token);
  await user.click(screen.getByRole('button', { name: 'Valider' }));
}

describe('live page', () => {
  it('explains that the operator surface is not configured', () => {
    renderPage(vi.fn(), null);
    expect(screen.getByText('Surface opérateur non configurée')).toBeVisible();
    expect(screen.queryByLabelText('Jeton opérateur')).toBeNull();
  });

  it('asks for the token once, keeps it in sessionStorage and then shows the dashboard', async () => {
    const getLiveOverview = vi.fn<OperatorClient['getLiveOverview']>()
      .mockResolvedValue({ overview, nextCursor: null });
    const createClient = renderPage(getLiveOverview);
    expect(createClient).not.toHaveBeenCalled();

    await enterToken();

    expect(await screen.findByRole('heading', { name: 'Live' })).toBeVisible();
    expect(createClient).toHaveBeenCalledWith('http://127.0.0.1:3100', 'secret-token');
    expect(window.sessionStorage.getItem('operator-api-token')).toBe('secret-token');
  });

  it('shows balance, PnL, the open position with its spot value and the closed history with Solscan links', async () => {
    window.sessionStorage.setItem('operator-api-token', 'secret-token');
    renderPage(vi.fn<OperatorClient['getLiveOverview']>().mockResolvedValue({ overview, nextCursor: null }));

    expect(await screen.findByText('2.500000000 SOL')).toBeVisible();
    // Once as the realized KPI and once in the closed history row.
    expect(screen.getAllByText('-0.000004205 SOL')).toHaveLength(2);
    expect(screen.getAllByText('+0.000195000 SOL').length).toBeGreaterThan(0);
    expect(screen.getByText('indicatif, prix spot')).toBeVisible();
    const openRow = within(screen.getByRole('heading', { name: 'Positions ouvertes' }).parentElement!)
      .getAllByRole('row')[1]!;
    expect(within(openRow).getByText('0.001200000 SOL')).toBeVisible();
    expect(within(openRow).getByText(/\+19\.40%/u)).toBeVisible();
    expect(within(openRow).getByRole('link')).toHaveAttribute('href', `/launches/${overview.open[0]?.mint ?? ''}`);
    const links = screen.getAllByRole('link', { name: /Entrée|Sortie/u });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `https://solscan.io/tx/${SIGNATURE}`, `https://solscan.io/tx/${SIGNATURE}`,
    ]);
    expect(screen.queryByText('Actualisation indisponible', { exact: false })).toBeNull();
  });

  it('forgets a rejected token and prompts again with an error', async () => {
    window.sessionStorage.setItem('operator-api-token', 'wrong-token');
    renderPage(vi.fn<OperatorClient['getLiveOverview']>()
      .mockRejectedValue(new ApiHttpError(401, 'UNAUTHORIZED', 'A valid operator token is required')));

    expect(await screen.findByText('Token refusé')).toBeVisible();
    expect(screen.getByLabelText('Jeton opérateur')).toBeVisible();
    expect(window.sessionStorage.getItem('operator-api-token')).toBeNull();
  });

  it('forgets the token on demand', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem('operator-api-token', 'secret-token');
    renderPage(vi.fn<OperatorClient['getLiveOverview']>().mockResolvedValue({ overview, nextCursor: null }));

    await user.click(await screen.findByRole('button', { name: 'Oublier le token' }));

    expect(screen.getByLabelText('Jeton opérateur')).toBeVisible();
    expect(screen.queryByText('Token refusé')).toBeNull();
    expect(window.sessionStorage.getItem('operator-api-token')).toBeNull();
  });

  it('reports a missing wallet generation', async () => {
    window.sessionStorage.setItem('operator-api-token', 'secret-token');
    const empty = { ...overview, availability: 'NOT_AVAILABLE' as const, wallet: null, balance: null, open: [], history: [] };
    renderPage(vi.fn<OperatorClient['getLiveOverview']>().mockResolvedValue({ overview: empty, nextCursor: null }));

    expect(await screen.findByText('Aucun wallet live actif')).toBeVisible();
  });

  it('keeps the page usable when the balance and a spot price are unknown', async () => {
    window.sessionStorage.setItem('operator-api-token', 'secret-token');
    const open = { ...overview.open[0]!, spotValueLamports: null, unrealizedLamports: null };
    const degraded = {
      ...overview, balance: null, open: [open],
      totals: { ...overview.totals, unrealizedLamports: '0', positionsWithoutPnl: 1 },
    };
    renderPage(vi.fn<OperatorClient['getLiveOverview']>().mockResolvedValue({ overview: degraded, nextCursor: null }));

    expect(await screen.findByText('indisponible')).toBeVisible();
    expect(screen.getAllByText('non disponible')).toHaveLength(2);
    expect(screen.getByText('1 position exclue')).toBeVisible();
  });

  it('loads another history page with the opaque cursor', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem('operator-api-token', 'secret-token');
    const older = {
      ...overview.history[0]!, positionId: 'execution_live_position_older',
      closedAt: '2026-08-10T21:05:00.000Z', realizedLamports: '900',
    };
    const getLiveOverview = vi.fn<OperatorClient['getLiveOverview']>()
      .mockResolvedValueOnce({ overview, nextCursor: 'ledger-next' })
      .mockResolvedValueOnce({ overview: { ...overview, history: [older] }, nextCursor: null })
      .mockResolvedValue({ overview, nextCursor: 'ledger-next' });
    renderPage(getLiveOverview);

    await user.click(await screen.findByRole('button', { name: 'Charger plus' }));

    expect(await screen.findByText('+0.000000900 SOL')).toBeVisible();
    expect(getLiveOverview).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'ledger-next' }));
    expect(screen.queryByRole('button', { name: 'Charger plus' })).toBeNull();
  });
});
````

- [ ] **Step 2: run it and see it fail**

```bash
npm test --workspace frontend -- src/features/live
```

Expected: `Failed to resolve import "./live-page.js"`.

- [ ] **Step 3: implement**

Create `frontend/src/features/live/format-sol.ts`:

````ts
import { formatBasisPoints, formatRawAmount } from '../../data/decimal.js';

/** Lamports as SOL through bigint only; `signed` adds an explicit plus for profits. */
export function formatSol(lamports: string, signed = false): string {
  const amount = formatRawAmount(lamports, 9);
  const prefixed = signed && !amount.startsWith('-') && BigInt(lamports) !== 0n ? `+${amount}` : amount;
  return `${prefixed} SOL`;
}

/** Unrealized PnL over cost in basis points, truncated toward zero, e.g. `19.40%`. */
export function formatPnlPercent(unrealizedLamports: string, costLamports: string): string {
  const basisPoints = (BigInt(unrealizedLamports) * 10_000n) / BigInt(costLamports);
  const formatted = formatBasisPoints(basisPoints.toString());
  return basisPoints > 0n ? `+${formatted}` : formatted;
}
````

Create `frontend/src/features/live/token-prompt.tsx`:

````tsx
import { useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';

export interface TokenPromptProps {
  readonly refused: boolean;
  readonly onSubmit: (token: string) => void;
}

export function TokenPrompt({ refused, onSubmit }: TokenPromptProps): ReactNode {
  const [value, setValue] = useState('');
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const token = value.trim();
    if (token.length > 0) onSubmit(token);
  };
  return (
    <form className="card shadow-sm" onSubmit={submit}>
      <div className="card-body d-grid gap-3">
        <h1 className="h4 mb-0">Surface live opérateur</h1>
        {refused && <p className="alert alert-danger mb-0" role="alert">Token refusé</p>}
        <div>
          <label className="form-label" htmlFor="operator-token">Jeton opérateur</label>
          <input
            id="operator-token"
            className="form-control"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => { setValue(event.target.value); }}
          />
          <p className="form-text mb-0">Conservé uniquement pour cet onglet.</p>
        </div>
        <div><button type="submit" className="btn btn-primary">Valider</button></div>
      </div>
    </form>
  );
}
````

Create `frontend/src/features/live/live-page.tsx`:

````tsx
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingState } from '../../components/async-state.js';
import { ShortIdentifier, Timestamp } from '../../components/format.js';
import { SafeExternalLink } from '../../components/safe-external-link.js';
import { ApiHttpError } from '../../data/api-errors.js';
import { formatInteger } from '../../data/decimal.js';
import { createOperatorClient } from '../../data/operator-client.js';
import type { OperatorClient } from '../../data/operator-client.js';
import type {
  OperatorClosedPosition,
  OperatorLiveOverview,
  OperatorOpenPosition,
} from '../../data/operator-schemas.js';
import { clearOperatorToken, readOperatorToken, saveOperatorToken } from '../../data/operator-token.js';
import { liveOverviewInfiniteQuery } from '../../data/queries.js';
import { queryKeys } from '../../data/query-keys.js';
import { formatPnlPercent, formatSol } from './format-sol.js';
import { TokenPrompt } from './token-prompt.js';

export interface LivePageProps {
  readonly operatorApiBaseUrl: string | null;
  readonly createClient?: (operatorApiBaseUrl: string, token: string) => OperatorClient;
}

function defaultCreateClient(operatorApiBaseUrl: string, token: string): OperatorClient {
  return createOperatorClient({ operatorApiBaseUrl, token });
}

export function LivePage({ operatorApiBaseUrl, createClient = defaultCreateClient }: LivePageProps): ReactNode {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(() => readOperatorToken());
  const [refused, setRefused] = useState(false);
  const forget = useCallback((wasRefused: boolean): void => {
    clearOperatorToken();
    queryClient.removeQueries({ queryKey: queryKeys.liveOverview });
    setToken(null);
    setRefused(wasRefused);
  }, [queryClient]);
  const client = useMemo(
    () => (operatorApiBaseUrl === null || token === null ? null : createClient(operatorApiBaseUrl, token)),
    [createClient, operatorApiBaseUrl, token],
  );

  if (operatorApiBaseUrl === null) return <EmptyState>Surface opérateur non configurée</EmptyState>;
  if (client === null) {
    return (
      <TokenPrompt
        refused={refused}
        onSubmit={(value) => { saveOperatorToken(value); setRefused(false); setToken(value); }}
      />
    );
  }
  return <LiveDashboard client={client} onForget={forget} />;
}

function LiveDashboard({ client, onForget }: {
  readonly client: OperatorClient;
  readonly onForget: (refused: boolean) => void;
}): ReactNode {
  const query = useInfiniteQuery(liveOverviewInfiniteQuery(client));
  const unauthorized = query.error instanceof ApiHttpError && query.error.status === 401;
  useEffect(() => {
    if (unauthorized) onForget(true);
  }, [unauthorized, onForget]);

  if (unauthorized) return null;
  if (query.isPending) return <LoadingState label="Chargement de la surface live…" />;
  const first = query.data?.pages[0];
  if (first === undefined) return <ErrorState>Surface opérateur indisponible.</ErrorState>;
  const { overview } = first;
  const history = query.data?.pages.flatMap((page) => page.overview.history) ?? [];
  return (
    <section aria-labelledby="live-title" className="d-grid gap-3">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2">
        <h1 className="h3 mb-0" id="live-title">Live</h1>
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => { onForget(false); }}>
          Oublier le token
        </button>
      </div>
      {query.isError && <ErrorState>Actualisation indisponible : dernières données conservées.</ErrorState>}
      {overview.availability === 'NOT_AVAILABLE' ? <EmptyState>Aucun wallet live actif</EmptyState> : (
        <>
          <KpiRow overview={overview} />
          <OpenPositionsTable positions={overview.open} />
          <HistoryTable positions={history} />
          {query.hasNextPage && (
            <div>
              <button
                type="button"
                className="btn btn-outline-secondary btn-sm"
                disabled={query.isFetchingNextPage}
                onClick={() => { void query.fetchNextPage(); }}
              >
                Charger plus
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function KpiRow({ overview }: { readonly overview: OperatorLiveOverview }): ReactNode {
  const { balance, totals } = overview;
  const excluded = totals.positionsWithoutPnl;
  return (
    <div className="row g-3">
      <Kpi label="Solde du wallet">
        {balance === null ? 'indisponible' : (
          <>{formatSol(balance.lamports)} <small className="text-secondary d-block">observé <Timestamp value={balance.observedAt} /></small></>
        )}
      </Kpi>
      <Kpi label="PnL réalisé">{formatSol(totals.realizedLamports, true)}</Kpi>
      <Kpi label="PnL non réalisé">
        {formatSol(totals.unrealizedLamports, true)}
        <small className="text-secondary d-block">indicatif, prix spot</small>
        {excluded > 0 && (
          <small className="text-secondary d-block">
            {excluded === 1 ? '1 position exclue' : `${String(excluded)} positions exclues`}
          </small>
        )}
      </Kpi>
      <Kpi label="Positions ouvertes">{String(totals.openCount)}</Kpi>
    </div>
  );
}

function Kpi({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <div className="col-6 col-lg-3">
      <div className="card shadow-sm h-100"><div className="card-body">
        <div className="text-secondary small">{label}</div>
        <div className="fs-5 fw-semibold">{children}</div>
      </div></div>
    </div>
  );
}

function OpenPositionsTable({ positions }: { readonly positions: readonly OperatorOpenPosition[] }): ReactNode {
  return (
    <div>
      <h2 className="h5">Positions ouvertes</h2>
      {positions.length === 0 ? <EmptyState>Aucune position ouverte.</EmptyState> : (
        <div className="table-responsive"><table className="table table-sm align-middle">
          <thead><tr>
            <th scope="col">Token</th><th scope="col">État</th><th scope="col">Quantité restante</th>
            <th scope="col">Coût</th><th scope="col">Valeur spot</th><th scope="col">PnL non réalisé</th>
            <th scope="col">Sortie avant</th>
          </tr></thead>
          <tbody>{positions.map((position) => (
            <tr key={position.positionId}>
              <td><Link to={`/launches/${position.mint}`}><ShortIdentifier value={position.mint} /></Link></td>
              <td>{position.state}</td>
              <td>{formatInteger(position.remainingRaw)}</td>
              <td>{formatSol(position.costLamports)}</td>
              <td>{position.spotValueLamports === null ? 'non disponible' : formatSol(position.spotValueLamports)}</td>
              <td>
                {position.unrealizedLamports === null ? 'non disponible' : (
                  <>{formatSol(position.unrealizedLamports, true)} ({formatPnlPercent(position.unrealizedLamports, position.costLamports)})</>
                )}
              </td>
              <td><Timestamp value={position.exitDeadlineAt} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

function HistoryTable({ positions }: { readonly positions: readonly OperatorClosedPosition[] }): ReactNode {
  return (
    <div>
      <h2 className="h5">Historique</h2>
      {positions.length === 0 ? <EmptyState>Aucune position fermée enregistrée.</EmptyState> : (
        <div className="table-responsive"><table className="table table-sm align-middle">
          <thead><tr>
            <th scope="col">Token</th><th scope="col">Ouverte</th><th scope="col">Fermée</th>
            <th scope="col">PnL réalisé</th><th scope="col">Transactions</th>
          </tr></thead>
          <tbody>{positions.map((position) => (
            <tr key={position.positionId}>
              <td><Link to={`/launches/${position.mint}`}><ShortIdentifier value={position.mint} /></Link></td>
              <td><Timestamp value={position.openedAt} /></td>
              <td><Timestamp value={position.closedAt} /></td>
              <td>{formatSol(position.realizedLamports, true)}</td>
              <td className="d-flex gap-2">
                <SafeExternalLink href={`https://solscan.io/tx/${position.entrySignature}`}>Entrée</SafeExternalLink>
                <SafeExternalLink href={`https://solscan.io/tx/${position.exitSignature}`}>Sortie</SafeExternalLink>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}
````

- [ ] **Step 4: run, typecheck, lint**

```bash
npm test --workspace frontend -- src/features/live
npm run check --workspace frontend
npm run lint --workspace frontend
```

Expected: 8 tests pass; check and lint print nothing.

- [ ] **Step 5: commit**

```bash
git add frontend/src/features/live
git commit -m "feat(frontend): add the read-only live page with its token prompt" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Route, navigation, route-dependent badge, bootstrap and READMEs

**Files:**
- Modify: `frontend/src/app/app.tsx`, `frontend/src/app/app-shell.tsx`, `frontend/src/app/app.test.tsx`, `frontend/src/main.tsx`
- Modify: `frontend/README.md` (config section :25-35, routes :41-45, intro), `README.md` (:457-462)

Facts verified: the shell's nav is `Radar`, `Positions paper`, `Santé`; the live link goes between `Radar` and `Positions paper`. `public/config.json` stays `{ "apiBaseUrl": "/" }`.

- [ ] **Step 1: write the failing test**

````diff
--- a/frontend/src/app/app.test.tsx
+++ b/frontend/src/app/app.test.tsx
@@ -50,6 +50,24 @@
     expect(screen.getByRole('heading', { name: 'Radar des lancements' })).toBeVisible();
   });
 
+  it('adds a Live link whose page swaps the simulation badge for the read-only live badge', async () => {
+    const user = userEvent.setup();
+    render(<App apiBaseUrl="https://api.example" realtimeClient={fakeRealtimeClient()} apiClient={fakeApiClient()} />);
+    const links = screen.getAllByRole('link').map((link) => link.textContent);
+    expect(links.indexOf('Live')).toBe(links.indexOf('Radar') + 1);
+    expect(links.indexOf('Positions paper')).toBe(links.indexOf('Live') + 1);
+    expect(screen.getByText('Simulation uniquement')).toBeVisible();
+    expect(screen.queryByText('Live · lecture seule')).toBeNull();
+
+    await user.click(screen.getByRole('link', { name: 'Live' }));
+
+    expect(await screen.findByText('Surface opérateur non configurée')).toBeVisible();
+    expect(screen.getByText('Live · lecture seule')).toBeVisible();
+    expect(screen.queryByText('Simulation uniquement')).toBeNull();
+    await user.click(screen.getByRole('link', { name: 'Radar' }));
+    expect(screen.getByText('Simulation uniquement')).toBeVisible();
+  });
+
   it('renders a useful not-found route', () => {
     window.history.replaceState({}, '', '/unknown');
     render(<App apiBaseUrl="https://api.example" realtimeClient={fakeRealtimeClient('DISCONNECTED')} apiClient={fakeApiClient()} />);
````

- [ ] **Step 2: run it and see it fail**

```bash
npm test --workspace frontend -- src/app/app.test.tsx
```

Expected: the new test fails (`Unable to find an accessible element with the role "link" and name "Live"` or `indexOf('Live')` is `-1`).

- [ ] **Step 3: implement**

````diff
--- a/frontend/src/app/app.tsx
+++ b/frontend/src/app/app.tsx
@@ -11,16 +11,20 @@
 import { LaunchPage } from '../features/launch/launch-page.js';
 import { PaperPage } from '../features/paper/paper-page.js';
 import { HealthPage } from '../features/health/health-page.js';
+import { LivePage } from '../features/live/live-page.js';
 import { AppShell } from './app-shell.js';
 import { ErrorBoundary } from './error-boundary.js';
 
 export interface AppProps {
   readonly apiBaseUrl: string;
+  readonly operatorApiBaseUrl?: string;
   readonly realtimeClient?: SseClient;
   readonly apiClient?: ApiClient;
 }
 
-export function App({ apiBaseUrl, realtimeClient, apiClient: providedApiClient }: AppProps): ReactNode {
+export function App({
+  apiBaseUrl, operatorApiBaseUrl, realtimeClient, apiClient: providedApiClient,
+}: AppProps): ReactNode {
   const [queryClient] = useState(() => new QueryClient({
     defaultOptions: { queries: { staleTime: 5_000, gcTime: 5 * 60_000 } },
   }));
@@ -34,6 +38,7 @@
               <Route element={<AppShell />}>
                 <Route index element={<RadarPage />} />
                 <Route path="launches/:mint" element={<LaunchPage />} />
+                <Route path="live" element={<LivePage operatorApiBaseUrl={operatorApiBaseUrl ?? null} />} />
                 <Route path="paper-positions" element={<PaperPage />} />
                 <Route path="health" element={<HealthPage />} />
                 <Route path="*" element={<NotFoundPage />} />
````

````diff
--- a/frontend/src/app/app-shell.tsx
+++ b/frontend/src/app/app-shell.tsx
@@ -1,4 +1,4 @@
-import { NavLink, Outlet } from 'react-router-dom';
+import { NavLink, Outlet, useLocation } from 'react-router-dom';
 import type { ReactNode } from 'react';
 import { useRealtimeSnapshot } from '../data/realtime-context.js';
 import type { RealtimeState } from '../data/sse-client.js';
@@ -15,6 +15,7 @@
 
 export function AppShell(): ReactNode {
   const realtime = useRealtimeSnapshot();
+  const live = useLocation().pathname === '/live';
   return (
     <div className="min-vh-100 d-flex flex-column bg-body-tertiary">
       <header className="navbar navbar-expand-md navbar-dark bg-dark border-bottom border-secondary sticky-top">
@@ -22,11 +23,14 @@
           <NavLink className="navbar-brand fw-semibold" to="/">Pump Radar</NavLink>
           <nav className="navbar-nav flex-row gap-2" aria-label="Navigation principale">
             <NavItem to="/">Radar</NavItem>
+            <NavItem to="/live">Live</NavItem>
             <NavItem to="/paper-positions">Positions paper</NavItem>
             <NavItem to="/health">Santé</NavItem>
           </nav>
           <div className="ms-auto d-flex flex-wrap align-items-center justify-content-end gap-2 small">
-            <span className="badge text-bg-warning">Simulation uniquement</span>
+            {live
+              ? <span className="badge text-bg-danger">Live · lecture seule</span>
+              : <span className="badge text-bg-warning">Simulation uniquement</span>}
             <span className="text-light" role="status" aria-live="polite">
               Temps réel : {realtimeLabels[realtime.state]}
             </span>
````

````diff
--- a/frontend/src/main.tsx
+++ b/frontend/src/main.tsx
@@ -12,7 +12,14 @@
   const root = createRoot(container);
   try {
     const config = await loadRuntimeConfig(fetch);
-    root.render(<StrictMode><App apiBaseUrl={config.apiBaseUrl} /></StrictMode>);
+    root.render(
+      <StrictMode>
+        <App
+          apiBaseUrl={config.apiBaseUrl}
+          {...(config.operatorApiBaseUrl === undefined ? {} : { operatorApiBaseUrl: config.operatorApiBaseUrl })}
+        />
+      </StrictMode>,
+    );
   } catch {
     root.render(<StrictMode><ConfigurationError /></StrictMode>);
   }
````

````diff
--- a/frontend/README.md
+++ b/frontend/README.md
@@ -1,9 +1,11 @@
 # Console opérateur Pump.fun
 
 Application React/Vite/Bootstrap publique et indépendante du processus backend.
-Elle consomme exclusivement l’API HTTP/SSE V1 en lecture seule. La console ne
-demande aucun wallet, aucune clé privée et ne construit, signe ou envoie aucune
-transaction. Le libellé permanent `Simulation uniquement` rappelle que le PnL
+Elle consomme l’API HTTP/SSE V1 en lecture seule et, pour `/live`, l’API
+opérateur en lecture seule. La console ne demande aucun wallet, aucune clé
+privée (le jeton opérateur n’en est pas une) et ne construit, signe ou envoie
+aucune transaction. Le libellé `Simulation uniquement` (remplacé par
+`Live · lecture seule` sur `/live`) rappelle que le PnL
 paper est estimé et qu’il n’existe aucune garantie de profit ou de sellabilité.
 
 ## Démarrage local
@@ -37,10 +39,22 @@
 aucun secret ne doit y être placé. Une configuration invalide arrête le
 bootstrap avant toute requête métier ou connexion SSE.
 
+`operatorApiBaseUrl` est optionnel, suit les mêmes règles de validation et
+désigne l'API opérateur `src/operator-api/` (par exemple
+`"operatorApiBaseUrl": "http://127.0.0.1:3100"`). Sans lui, la page `/live`
+affiche « Surface opérateur non configurée ». Cette adresse n'est pas un secret ;
+le jeton opérateur, lui, n'est jamais écrit dans `config.json`.
+
 ## Routes produit
 
 - `/` : radar paginé des lancements retenus ;
 - `/launches/:mint` : aperçu, timeline, risque, social et détenteurs ;
+- `/live` : solde, positions ouvertes, PnL réalisé et non réalisé, historique des
+  positions live fermées, en lecture seule. La page demande le jeton opérateur
+  une fois, le garde dans `sessionStorage` (effacé à la fermeture de l'onglet,
+  bouton « Oublier le token ») et le redemande après un 401. Le PnL non réalisé
+  est un prix mid indicatif ; le badge de l'en-tête affiche « Live · lecture
+  seule » sur cette route ;
 - `/paper-positions` : positions et PnL paper estimés ;
 - `/health` : état public du listener, des workers et checkpoints.
 
````

````diff
--- a/README.md
+++ b/README.md
@@ -457,7 +457,9 @@
 lit son `apiBaseUrl` dans `frontend/public/config.json`, puis consomme les huit
 projections JSON et le flux SSE reprenable. Ses routes produit sont le radar
 `/`, la fiche `/launches/:mint`, les simulations `/paper-positions` et la santé
-`/health`.
+`/health`. La route `/live` (lecture seule) lit l'API opérateur séparée
+`npm run operator:api:start`, authentifiée par jeton ; voir le
+[runbook](docs/operations/executor-live-canary.md).
 
 ```bash
 npm run frontend:dev
````

- [ ] **Step 4: run the whole frontend gate and the docs check**

```bash
npm run check --workspace frontend
npm run lint --workspace frontend
npm test --workspace frontend
npm run build --workspace frontend
npm run docs:check
```

Expected: `Test Files 20 passed (20)`, `Tests 201 passed`; build ends with `built in`; `docs:check: OK`.

- [ ] **Step 5: commit**

```bash
git add frontend README.md
git commit -m "feat(frontend): route /live, add the Live link and the route-dependent read-only badge" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Full verification and manual checklist

**Files:** none (verification only; the manual checklist edits `frontend/public/config.json` temporarily and reverts it).

- [ ] **Step 1: static gates**

```bash
npm run check
npm run lint
npm run build
```

Expected: no output errors; `npm run build` builds backend then frontend.

- [ ] **Step 2: full test suite against the dedicated database**

```bash
export TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55433/sol_token_listener_test
npm test
```

Expected: `fail 0` in both the backend and the frontend runs. The backend run takes a long time (every migration test replays 61 migrations); `skipped` must only count tests that are skipped for reasons unrelated to the database. If a failure looks unrelated to this work, rerun that single file on a clean tree (`git stash` is forbidden: use `git worktree add` on `origin/main`) before concluding.

- [ ] **Step 3: manual end-to-end checklist on the dedicated database only**

```bash
export TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55433/sol_token_listener_test
DATABASE_URL=$TEST_DATABASE_URL npm run db:migrate
docker compose --env-file /tmp/live-dashboard-test.env -p sol-token-listener-live-dashboard-test \
  -f deploy/compose.yaml -f /tmp/live-dashboard-compose.override.yaml exec -T postgres \
  psql -X -v ON_ERROR_STOP=1 -U test -d sol_token_listener_test < scripts/provision-executor-roles.sql
docker compose --env-file /tmp/live-dashboard-test.env -p sol-token-listener-live-dashboard-test \
  -f deploy/compose.yaml -f /tmp/live-dashboard-compose.override.yaml exec -T postgres \
  psql -X -v ON_ERROR_STOP=1 -U test -d sol_token_listener_test <<'SQL'
CREATE ROLE live_dashboard_operator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD 'operator';
GRANT sol_token_operator_reader TO live_dashboard_operator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
INSERT INTO execution_wallet_generations (generation_id,payload_version,wallet_public_key,cluster,genesis_hash,generation)
  VALUES ('execution_wallet_generation_' || repeat('a',64),1,'11111111111111111111111111111111','mainnet-beta','11111111111111111111111111111111',1);
INSERT INTO execution_live_position_ledger (position_id,wallet_public_key,mint,opened_at,closed_at,base_amount_raw,
  entry_wallet_lamport_delta,exit_wallet_lamport_delta,net_lamports,entry_signature,exit_signature)
  VALUES ('execution_live_position_' || repeat('b',64),'11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112','2026-10-06T10:00:00Z','2026-10-06T10:05:00Z',95,-5000,795,-4205,
  repeat('5',88),repeat('6',88));
SQL
```

Start the process (the RPC URL is deliberately unreachable: the balance must show as unavailable, the rest of the page unaffected):

```bash
OPERATOR_API_DATABASE_URL=postgresql://live_dashboard_operator:operator@127.0.0.1:55433/sol_token_listener_test \
OPERATOR_API_TOKEN=0123456789abcdef0123456789abcdef \
OPERATOR_API_ALLOWED_ORIGIN=http://127.0.0.1:4173 \
SOLANA_HTTP_RPC_URL=http://127.0.0.1:9 \
npm run operator:api:dev
```

Expected `OPERATOR_API_LISTENING 127.0.0.1:3100`. In another shell:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/operator/v1/live/overview                       # 401
curl -s -H 'Authorization: Bearer 0123456789abcdef0123456789abcdef' http://127.0.0.1:3100/operator/v1/live/overview   # 200, availability AVAILABLE, balance null, history with -4205
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' -H 'Authorization: Bearer 0123456789abcdef0123456789abcdef' http://127.0.0.1:3100/operator/v1/live/overview   # 421
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Authorization: Bearer 0123456789abcdef0123456789abcdef' http://127.0.0.1:3100/operator/v1/live/overview   # 405
curl -s -i -X OPTIONS -H 'Origin: http://127.0.0.1:4173' http://127.0.0.1:3100/operator/v1/live/overview | grep -i 'access-control'
```

Then the console: temporarily set `frontend/public/config.json` to `{ "apiBaseUrl": "/", "operatorApiBaseUrl": "http://127.0.0.1:3100" }`, run `npm run frontend:dev`, open `http://127.0.0.1:4173/live` and check: token prompt, a wrong token gives `Token refusé`, the right token shows the badge `Live · lecture seule`, balance `indisponible`, realized PnL `-0.000004205 SOL`, one history row with two Solscan links, `Oublier le token` returns to the prompt, other routes show `Simulation uniquement`. Stop both processes and restore the config: `git checkout frontend/public/config.json`.

Finally stop the process (Ctrl-C) and clean up with the `down -v` command of the Test environment section.

- [ ] **Step 4: final confirmation**

```bash
git status --short
git log --oneline -12
```

Expected: a clean tree and one commit per task (Tasks 1-10).

## Open risks

- The ledger is not backfilled; positions closed before 061 are absent. A position stuck `UNKNOWN` for more than four hours may lose its BUY evidence before closing: then no ledger row is written (the close itself is never blocked).
- The operator API shares the reader role with the H2h export; any future grant to `sol_token_operator_reader` must update `EXECUTION_PREFLIGHT_SOURCE_TABLES` / `..._RESTRICTED_COLUMNS` or both processes refuse to start.
- Unrealized PnL is an indicative mid price (no slippage, no fees, no sellability check); thin pools will overstate it.
- The 15 s refetch of an infinite query reloads every loaded history page; acceptable for a handful of pages, revisit if history grows large in one session.
- `getBalance` is the only RPC call (at most one per 15 s); a 429 storm only degrades the balance cell.

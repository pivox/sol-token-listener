# Tracked Pump.fun Trade Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avoid transaction-body RPC calls for explicitly untracked Pump.fun trades while prioritizing every creation and trade belonging to a canonically tracked launch.

**Architecture:** The bounded WebSocket parser emits a non-authoritative hint plus an optional public mint. PostgreSQL owns the tracked/untracked decision, persists reversible deferred rows for four hours, and exposes an idempotent mint synchronization operation called by the transaction pipeline after launchpad persistence. The full Pump.fun transaction decoder remains the sole business authority.

**Tech Stack:** TypeScript strict ESM, Node test runner, PostgreSQL 16 migrations and repositories, Solana WebSocket JSON-RPC, official versioned Pump.fun IDL snapshot.

---

### Task 1: Extend the closed Pump.fun WebSocket hint contract

**Files:**
- Modify: `src/launchpads/pumpfun/websocket-create-hint.ts`
- Modify: `src/domain/transaction-ingestion.ts`
- Test: `tests/pumpfun-websocket-create-hint.test.ts`
- Test: `tests/transaction-ingestion-contracts.test.ts`

- [ ] **Step 1: Write failing parser tests**

Add fixtures that encode the official `TradeEvent` discriminator followed by a
32-byte public key and assert the exact result shape:

```ts
const mint = new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
assert.deepEqual(pumpFunWebSocketHintFromLogs([tradeLine(mint)]), {
  hint: 'PUMPFUN_TRADE',
  hintMint: mint.toBase58(),
});
assert.deepEqual(pumpFunWebSocketHintFromLogs([tradeLine(mint), createLine]), {
  hint: 'PUMPFUN_CREATE',
  hintMint: null,
});
```

Also assert malformed, truncated, accessor-backed, proxied and oversized input
returns the frozen `NONE/null` result without invoking hostile code.

- [ ] **Step 2: Run the parser tests and verify RED**

Run:

```bash
npx tsx --test tests/pumpfun-websocket-create-hint.test.ts tests/transaction-ingestion-contracts.test.ts
```

Expected: failure because `pumpFunWebSocketHintFromLogs`,
`PUMPFUN_TRADE`, and `ingestionHintMint` do not exist.

- [ ] **Step 3: Implement the minimal parser and domain validation**

Use the generated discriminator and an exact 32-byte slice:

```ts
export interface PumpFunWebSocketHintResult {
  readonly hint: 'NONE' | 'PUMPFUN_CREATE' | 'PUMPFUN_TRADE';
  readonly hintMint: string | null;
}

const TRADE_EVENT_DISCRIMINATOR = Buffer.from(PUMP_EVENTS.TradeEvent.discriminator);

function tradeMint(decoded: Buffer): string | null {
  if (decoded.length < TRADE_EVENT_DISCRIMINATOR.length + 32) return null;
  try {
    return new PublicKey(decoded.subarray(8, 40)).toBase58();
  } catch {
    return null;
  }
}
```

Scan every bounded line, remember the first canonical trade mint, and return a
creation if any canonical creation discriminator occurs. Add
`ingestionHintMint` to `TransactionNotification` and require the exact legal
pairings: create/null, trade/canonical mint, null/null. Catch-up accepts only
null/null.

- [ ] **Step 4: Run the parser and domain tests and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit the contract**

```bash
git add src/launchpads/pumpfun/websocket-create-hint.ts src/domain/transaction-ingestion.ts tests/pumpfun-websocket-create-hint.test.ts tests/transaction-ingestion-contracts.test.ts
git commit -m "feat(ingestion): classify Pump.fun trade hints (#102)"
```

### Task 2: Carry the hint mint through the native WebSocket boundary

**Files:**
- Modify: `src/solana/rpc/ws-program-session.ts`
- Modify: `src/application/websocket-failover-supervisor.ts`
- Modify: `src/solana/rpc/program-subscriber.ts`
- Test: `tests/ws-program-session.test.ts`
- Test: `tests/websocket-failover-supervisor.test.ts`
- Test: `tests/program-subscriber.test.ts`

- [ ] **Step 1: Write failing transport tests**

Assert a Pump.fun notification forwards both fields and a PumpSwap notification
is always null/null:

```ts
assert.deepEqual(notification, {
  endpointId: 'primary',
  program: 'pumpfun',
  signature,
  slot: 42n,
  hint: 'PUMPFUN_TRADE',
  hintMint: mint,
});
```

Add negative supervisor cases for trade/null, create/mint, PumpSwap/trade and an
accessor-backed mint. Assert none reaches the durable reporter.

- [ ] **Step 2: Run the transport tests and verify RED**

```bash
npx tsx --test tests/ws-program-session.test.ts tests/websocket-failover-supervisor.test.ts tests/program-subscriber.test.ts
```

Expected: the asserted field is absent and the trade hint is rejected.

- [ ] **Step 3: Implement minimal propagation**

Change `WsProgramNotification` to include:

```ts
readonly hint: 'NONE' | 'PUMPFUN_CREATE' | 'PUMPFUN_TRADE';
readonly hintMint: string | null;
```

Call the new parser once per valid Pump.fun notification. In the supervisor,
snapshot both own data fields, validate their closed pairing, and construct the
domain notification without retaining the input object. Keep PumpSwap and the
legacy `ProgramSubscriber` on null/null.

- [ ] **Step 4: Run the transport tests and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit transport propagation**

```bash
git add src/solana/rpc/ws-program-session.ts src/application/websocket-failover-supervisor.ts src/solana/rpc/program-subscriber.ts tests/ws-program-session.test.ts tests/websocket-failover-supervisor.test.ts tests/program-subscriber.test.ts
git commit -m "feat(listener): propagate Pump.fun trade mints (#102)"
```

### Task 3: Add migration 047 for deferred ingestion

**Files:**
- Create: `migrations/047_transaction_inbox_tracked_trade_priority.sql`
- Create: `tests/transaction-inbox-tracked-trade-migration.test.ts`
- Modify: `tests/transaction-inbox-priority-migration.test.ts`

- [ ] **Step 1: Write failing migration tests**

Test an empty database, an upgrade from migration 046, and direct replay. Assert
the final catalogue has:

```ts
assert.deepEqual(enumLabels, ['NORMAL', 'LAUNCH_CANDIDATE', 'TRACKED_TRADE']);
assert.deepEqual(statusCheck, ['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEFERRED']);
assert.equal(row.ingestion_hint, 'PUMPFUN_TRADE');
assert.equal(row.ingestion_hint_mint, mint);
```

Insert every invalid hint/mint/status/lease/error/snapshot/retention combination
and expect the named 047 checks to reject it.

- [ ] **Step 2: Run the migration tests and verify RED**

```bash
npx tsx --test tests/transaction-inbox-tracked-trade-migration.test.ts tests/transaction-inbox-priority-migration.test.ts
```

Expected: migration 047 is missing.

- [ ] **Step 3: Implement the replayable migration**

The migration must:

```sql
ALTER TYPE chain_transaction_inbox_priority
  ADD VALUE IF NOT EXISTS 'TRACKED_TRADE' AFTER 'LAUNCH_CANDIDATE';

ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS ingestion_hint TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS ingestion_hint_mint TEXT;

ALTER TABLE chain_transaction_inbox_claim_scheduler
  RENAME COLUMN consecutive_launch_candidate_claims TO consecutive_urgent_claims;
```

Backfill 044 rows before installing validated exact constraints. Extend the
status, lease, error, snapshot, terminal and timestamp checks for `DEFERRED`.
Rebuild the claim index on urgent-vs-normal then slot/signature and keep the
four-hour purge index. Validate pre-existing objects and fail on incompatible
drift rather than silently replacing data.

- [ ] **Step 4: Run migration tests and verify GREEN**

Run the command from Step 2 with `TEST_DATABASE_URL` pointing at PostgreSQL 16.
Expected: all tests pass and replay applies zero additional migrations.

- [ ] **Step 5: Commit migration 047**

```bash
git add migrations/047_transaction_inbox_tracked_trade_priority.sql tests/transaction-inbox-tracked-trade-migration.test.ts tests/transaction-inbox-priority-migration.test.ts
git commit -m "feat(storage): add deferred tracked trade ingestion (#102)"
```

### Task 4: Make enqueue classification durable and reversible

**Files:**
- Modify: `src/ports/transaction-inbox-repository.ts`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Test: `tests/transaction-inbox.repository.test.ts`
- Test: `tests/transaction-ingestion-recovery.test.ts`

- [ ] **Step 1: Write failing repository tests**

Cover these exact transitions on real PostgreSQL 16:

```ts
await repository.enqueue(tradeNotification(untrackedMint));
assert.deepEqual(await inboxRow(signature), {
  processing_status: 'DEFERRED',
  ingestion_priority: 'NORMAL',
  ingestion_hint: 'PUMPFUN_TRADE',
  ingestion_hint_mint: untrackedMint,
});
assert.equal(await repository.claim(now, 30), null);
```

Also cover tracked-at-enqueue, catch-up replay of a deferred signature, late
create upgrade, normal-to-untracked demotion only before lease/attempt, four-hour
retention, concurrent enqueue convergence and corrupt stored combinations.

- [ ] **Step 2: Run repository tests and verify RED**

```bash
npx tsx --test --test-concurrency=1 tests/transaction-inbox.repository.test.ts tests/transaction-ingestion-recovery.test.ts
```

Expected: trade hints are treated as normal and `syncTrackedMint` is absent.

- [ ] **Step 3: Implement enqueue and synchronization**

Extend the port with:

```ts
syncTrackedMint(mint: string): Promise<void>;
```

Within the existing per-signature transaction, check active
`token_launches` only for `PUMPFUN_TRADE`. Insert or converge to PENDING urgent,
DEFERRED untracked, or normal safety state according to the spec. Never demote a
creation, leased row, attempted row, snapshot row or processed row.

Implement `syncTrackedMint` under
`pg_advisory_xact_lock(hashtextextended('transaction-inbox-mint:' || $1, 0))`.
Use one database clock and one set-wise update for activation or deactivation.
Validate the public mint before acquiring a client.

Update claim selection to treat every non-NORMAL priority as urgent and update
`consecutive_urgent_claims`. Ensure `DEFERRED` is excluded from exhaustion,
claim, retry, finality and actionable counts but remains purgeable.

- [ ] **Step 4: Run repository tests and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit repository behavior**

```bash
git add src/ports/transaction-inbox-repository.ts src/storage/transaction-inbox.repository.ts tests/transaction-inbox.repository.test.ts tests/transaction-ingestion-recovery.test.ts
git commit -m "feat(ingestion): defer untracked Pump.fun trades (#102)"
```

### Task 5: Synchronize affected mints in the pipeline

**Files:**
- Modify: `src/application/observed-transaction-pipeline.ts`
- Modify: `src/application/production-listener-factory.ts`
- Test: `tests/observed-transaction-pipeline.test.ts`
- Test: `tests/production-listener-factory.test.ts`
- Create: `tests/tracked-trade-ingestion.integration.test.ts`

- [ ] **Step 1: Write failing pipeline tests**

Inject a synchronization port and assert lexical calls immediately after
launchpad persistence:

```ts
assert.deepEqual(order, [
  'tracked', 'launchpad', 'sync:MintA', 'sync:MintB', 'reload',
  'funding', 'participants', 'graph', 'pumpswap', 'qualification', 'paper',
]);
```

Assert a sync failure is reported as `sync_tracked_mint` with its mint and stops
all later stages. Add a real PostgreSQL test where a trade notification is
deferred before its creation transaction is processed, then becomes claimable
and produces `BondingCurveTradeObserved` after the creation commits.

- [ ] **Step 2: Run pipeline tests and verify RED**

```bash
npx tsx --test --test-concurrency=1 tests/observed-transaction-pipeline.test.ts tests/production-listener-factory.test.ts tests/tracked-trade-ingestion.integration.test.ts
```

Expected: no sync stage or dependency exists.

- [ ] **Step 3: Implement pipeline synchronization**

Add `sync_tracked_mint` to `ObservedPipelineStage`, inject a minimal
`TrackedMintInboxSynchronizer`, and call it for the validated lexical
`launchpad.affectedMints` before reloading active events. Wire the same
`PostgresTransactionInboxRepository` instance in the production factory.

- [ ] **Step 4: Run pipeline tests and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit pipeline integration**

```bash
git add src/application/observed-transaction-pipeline.ts src/application/production-listener-factory.ts tests/observed-transaction-pipeline.test.ts tests/production-listener-factory.test.ts tests/tracked-trade-ingestion.integration.test.ts
git commit -m "feat(pipeline): reactivate tracked Pump.fun trades (#102)"
```

### Task 6: Update deployment catalogues, roles and operator documentation

**Files:**
- Modify: `src/execution-migrations/live-catalog.ts`
- Modify: `scripts/deployment-smoke.mjs`
- Modify: `scripts/provision-executor-roles.sql`
- Modify: `README.md`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/operations/executor-live-canary.md`
- Modify: `docs/system-overview.html`
- Modify: `tests/executor-live-main.integration.test.ts`
- Modify: `tests/listener-database-authority.test.ts`
- Modify: `tests/config-safety.test.ts`

- [ ] **Step 1: Write failing catalogue and documentation assertions**

Require migration 047 exactly once in every canonical migration list, its
non-placeholder SHA-256 in the live catalogue, the renamed scheduler-column
grant, and documentation containing `PUMPFUN_TRADE`, `DEFERRED`, four-hour
retention and `CANARY_NOT_STARTED`.

- [ ] **Step 2: Run focused checks and verify RED**

```bash
npx tsx --test tests/executor-live-main.integration.test.ts tests/listener-database-authority.test.ts tests/config-safety.test.ts
npm run docs:check
```

Expected: migration 047 and its documented contract are absent.

- [ ] **Step 3: Update catalogues, least-privilege grants and docs**

Compute the exact migration bytes hash after SQL is final. Grant only the
columns and enum usage required by the listener role. Document the filtered
and actionable backlog metrics for H2i; do not publish URLs, secrets, wallet
paths or an assertion that a canary ran.

- [ ] **Step 4: Run focused checks and verify GREEN**

Run the commands from Step 2. Expected: all tests and docs checks pass.

- [ ] **Step 5: Commit deployment updates**

```bash
git add src/execution-migrations/live-catalog.ts scripts/deployment-smoke.mjs scripts/provision-executor-roles.sql README.md docs/architecture/pumpfun-v1.md docs/operations/executor-live-canary.md docs/system-overview.html tests/executor-live-main.integration.test.ts tests/listener-database-authority.test.ts tests/config-safety.test.ts
git commit -m "docs(operations): publish tracked trade ingestion gates (#102)"
```

### Task 7: Verify end to end and prepare the pull request

**Files:**
- Modify only files required by findings from the bounded local review

- [ ] **Step 1: Run focused behavioral and PostgreSQL tests**

```bash
npx tsx --test --test-concurrency=1 tests/pumpfun-websocket-create-hint.test.ts tests/ws-program-session.test.ts tests/transaction-inbox-tracked-trade-migration.test.ts tests/transaction-inbox.repository.test.ts tests/observed-transaction-pipeline.test.ts tests/tracked-trade-ingestion.integration.test.ts
```

Expected: all pass with zero skip when `TEST_DATABASE_URL` is configured.

- [ ] **Step 2: Run the complete quality gate**

```bash
npm run build
npm run check
npm run lint
npm test
npm run docs:check
npm run deployment:smoke
git diff --check origin/main
```

Expected: every command exits zero.

- [ ] **Step 3: Review the exact diff**

Confirm no `.env`, wallet material, provider URL, log payload, live enablement,
signer import, submission import, unrelated refactor or historical migration
rewrite is present. Confirm migration 047 is additive and retained decisions
purge after exactly four hours.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin perf/issue-102-tracked-trade-priority
gh pr create --base main --head perf/issue-102-tracked-trade-priority --title "perf(listener): prioritize tracked Pump.fun trades" --body "Closes #102"
gh pr comment <PR_NUMBER> --body '@codex please review this PR. Focus on durable race handling, no silent ingestion loss, PostgreSQL replay, RPC reduction, finality, and absence of live execution capability.'
```

- [ ] **Step 5: Complete at most two review cycles**

Wait for CI and Codex review. Address only verified blocking feedback, rerun the
relevant tests and complete suite, then merge with a normal merge commit once
all checks are green and no blocking thread remains.

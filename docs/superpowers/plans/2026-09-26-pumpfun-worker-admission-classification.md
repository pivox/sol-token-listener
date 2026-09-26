# Pump.fun Worker Admission and Classification Implementation Plan

> **For agentic workers:** use `subagent-driven-development` or
> `executing-plans`, implement each behavior test-first, and keep the deployment
> flag false.

**Goal:** Deliver #176 as one independently mergeable PR that activates the
durable Pump.fun admission/classification boundary without activating it in any
environment.

**Architecture:** A frozen V1 policy is parsed once and injected into the inbox
repository. The disabled branch preserves legacy SQL. The enabled branch uses
shared WebSocket hints, current tracked-mint authority, durable catch-up
classification and an admission-gated claim predicate. No new migration or
runtime worker is added.

**Tech stack:** TypeScript strict ESM, Node.js `node:test`, PostgreSQL 16,
Solana WebSocket logs, existing migration 053 and Docker deployment contracts.

**Plan revision:** 1.0.0

---

### Task 1: Activate the frozen policy safely

**Files:**

- Modify: `src/domain/worker-admission.ts`
- Modify: `src/config/env.ts`
- Modify: `tests/worker-admission.test.ts`
- Modify: `tests/config-safety.test.ts`

- [ ] Add RED tests accepting exact `true` and `false` domain values while
  rejecting every non-boolean and invalid window.
- [ ] Add RED config tests proving bounded admission requires catch-up page
  admission and inherits its observe/launchpad-only/live-edge/hydration/genesis
  gates.
- [ ] Preserve default false and replace the obsolete “not available until B”
  error with one stable classifier-dependency error.
- [ ] Run the two targeted suites, backend check and lint.
- [ ] Commit as `feat(capacity): activate worker admission policy`.

### Task 2: Unify WebSocket Pump.fun hints

**Files:**

- Modify: `src/solana/rpc/program-subscriber.ts`
- Modify: `tests/program-subscriber.test.ts`
- Verify: `src/solana/rpc/ws-program-session.ts`
- Verify: `src/launchpads/pumpfun/websocket-create-hint.ts`
- Modify tests only where parity evidence is missing.

- [ ] Add RED tests for canonical CREATE, canonical TRADE mint, PumpSwap, veto,
  truncation, conflicting mints and malformed logs through the direct
  subscriber.
- [ ] Reuse `pumpFunWebSocketHintFromLogs` and the existing veto program set;
  do not create a second parser or copy discriminators.
- [ ] Prove immutable notification snapshots and unchanged lifecycle/error
  behavior.
- [ ] Run subscriber, session and hint suites plus check/lint.
- [ ] Commit as `feat(listener): classify Pump.fun websocket admission hints`.

### Task 3: Add explicit enabled repository writes and claims

**Files:**

- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `src/ports/transaction-inbox-repository.ts` only if its public
  contract must expose policy evidence.
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify focused finality/recovery/concurrency tests as required.

- [ ] Add RED constructor and OFF-equivalence tests with the policy omitted,
  explicitly false and explicitly true.
- [ ] Add RED PostgreSQL tests for CREATE, tracked TRADE, untracked TRADE and
  ambiguous WebSocket decisions in enabled mode.
- [ ] Add RED tests showing all three claim branches exclude null admission but
  preserve 32:1 and 3:1 fairness/order.
- [ ] Inject an optional frozen policy with a disabled default. Keep disabled
  write and claim SQL unchanged; implement separate enabled SQL.
- [ ] Add RED catch-up tests for `PENDING/NULL -> PENDING/admitted`, truthful
  `catchUpEnqueued`, replay stability and `DEFERRED -> PENDING` compatibility.
- [ ] Add RED conflicts for terminal ignored/quarantined/deferred evidence and
  both WebSocket/catch-up finality orders.
- [ ] Implement promotion using the durable null-to-non-null transition and
  classification clock; never rewrite first detection.
- [ ] Run repository, admission, catch-up, finality and recovery suites against
  a task-owned PostgreSQL 16 database.
- [ ] Commit as `feat(storage): enforce durable worker admission`.

### Task 4: Wire production and publish safe deployment contracts

**Files:**

- Modify: `src/application/production-listener-factory.ts`
- Modify: `tests/production-listener-factory.test.ts`
- Modify: `.env.example`
- Modify: `deploy/env.example`
- Modify: `deploy/compose.yaml` only if an existing contract is incomplete.
- Modify: `README.md`
- Modify: `docs/system-overview.html`
- Modify: `tests/deployment-artifacts.test.ts`

- [ ] Add RED architecture tests proving one policy is passed to one inbox and
  no worker/RPC/cache/executor composition changes.
- [ ] Wire the validated policy; do not add a timer, scanner or background job.
- [ ] Document restart-only behavior, classifier dependency, false defaults,
  OFF/ON semantics, four-hour retention and the explicit ban on canary
  activation before #177.
- [ ] Run deployment tests, smoke contracts, docs, check and lint.
- [ ] Commit as `docs(capacity): document bounded admission classification`.

### Task 5: Validate and deliver #176

- [ ] Start one task-owned PostgreSQL 16 instance; record its exact URL only in
  the local session and remove it with its temporary data after validation.
- [ ] Run targeted PostgreSQL suites with zero unexplained skips.
- [ ] Run `npm run build`, `npm run check`, `npm run lint`,
  `npm run docs:check`, full backend PostgreSQL tests, frontend tests/E2E and
  deployment smoke/signal.
- [ ] Review cycle 1/2: config dependency, OFF equivalence, hint provenance,
  claim fence, catch-up receipt, finality and prohibited scope.
- [ ] Correct confirmed findings test-first and perform only the GitHub review
  as cycle 2/2. Do not request a third cycle.
- [ ] Push one branch/PR closing #176 and referencing #171. State explicitly
  that the flag remains false and #177 is mandatory before canary activation.
- [ ] Merge only with clean SHA, green CI and no unresolved blocking thread;
  verify post-merge CI before starting #177.

## Required non-regression evidence

- no migration file changes;
- no source under wallet, signer, executor, RPC budgeting, block cache or live
  transaction submission changes;
- no extra worker, queue or periodic task;
- `EXECUTION_MODE=observe` needs no private key;
- duplicate/orphaned/finality reconciliation and four-hour retention remain
  covered.

# Mainnet Paper MVP Validation Implementation Plan

> **For agentic workers:** execute task-by-task with tests first. Do not add live execution.

**Goal:** Add a resumable 50-position Mainnet paper runner and reproducible `paper-mvp.v1` gate by
measuring the existing creation strategy and paper ledger.

**Architecture:** Add a pure report domain, one additive PostgreSQL run/sample projection, a bounded
collector, and a CLI around the existing application bootstrap. Keep all financial math in bigint.

---

### Task 1: Define the closed report and gate domain

**Files:** create `src/domain/paper-mvp.ts`, create `tests/paper-mvp.test.ts`.

- [ ] Test canonical per-position facts, causal timestamp rejection, exit mapping, bigint totals,
  integer mean/win-rate/p95/drawdown, multi-quote fail-closed behavior, provider degradation, and
  the exact PASS predicates.
- [ ] Implement immutable `PaperMvpPositionSampleV1` and `PaperMvpReportV1` factories with bounded
  arrays, decimal strings at JSON boundaries, and stable reason codes.
- [ ] Run the focused tests and commit.

### Task 2: Persist resumable runs and immutable samples

**Files:** create `migrations/018_paper_mvp_validation.sql`, create
`src/ports/paper-mvp-repository.ts`, create `src/storage/paper-mvp.repository.ts`, add repository and
migration tests, update canonical migration/deployment assertions.

- [ ] Test migrations 001–018 on an empty schema and replay.
- [ ] Test start-or-resume equality, one active run, sample idempotence/contradiction, atomic
  progress, terminalization, and four-hour purge order.
- [ ] Implement additive tables and a transactionally locked repository.
- [ ] Run PostgreSQL tests and commit.

### Task 3: Collect exact position latency and cost facts

**Files:** create `src/application/paper-mvp-collector.ts`, create
`tests/paper-mvp-collector.test.ts`, add PostgreSQL integration coverage.

- [ ] Test all seven timestamps, quote causal ordering, venue fee/slippage/impact fields, network
  fee adjustment, exit categories, unknown positions, and duplicate logical BUY/SELL detection.
- [ ] Use bounded set-wise SQL over the existing launch/candidate/job/session/position/trade/event
  projections; do not recalculate fills or query RPC.
- [ ] Persist samples before source paper retention and commit.

### Task 4: Add provider usage evidence as a port

**Files:** create `src/ports/provider-usage-probe.ts`, create a fail-closed unavailable adapter,
add tests and structured health evidence.

- [ ] Define exact start/end credits and 429 counters without credentials in durable payloads.
- [ ] Return `UNAVAILABLE` explicitly until a provider-specific authoritative adapter is configured.
- [ ] Keep adapter selection closed; never infer credits from request counts.
- [ ] Commit. Provider-specific implementation remains the only human-dependent item.

### Task 5: Add the bounded resumable CLI

**Files:** create `src/cli/paper-mvp.ts`, modify `package.json`, `.env.example`, README/runbook, and
create `tests/paper-mvp-cli.test.ts`.

- [ ] Test strict arguments, paper/Mainnet/creation safety gates, automatic compatible resume,
  incompatible-run rejection, target/timeout/signal finalization, `0600` exclusive report output,
  required positive initial capital, and redacted failures.
- [ ] Run the existing application bootstrap and poll the durable collector; never import a signer
  or transaction submission port.
- [ ] Add `npm run paper:mvp` and operator documentation.
- [ ] Commit.

### Task 6: Validate scenarios and full repository gates

**Files:** extend creation strategy, paper worker/repository, deployment safety, and report tests only
where coverage is missing.

- [ ] Prove repeated wallet, ten wallets, theoretical/executable 2x, creator sell, stale quote,
  orphaning, crash replay, and no duplicate logical fills are represented correctly in the report.
- [ ] Run docs/build/check/lint/full PostgreSQL tests and deployment contracts.
- [ ] Request at most three review cycles, address final feedback, and merge the implementation PR.

### Task 7: Execute the operator validation

- [ ] Configure a Mainnet RPC provider and authoritative usage probe outside the repository.
- [ ] Run to 50 closed positions, retain the generated report outside the four-hour operational
  database window, and verify its hash.
- [ ] Close #49 only if the report is reproducible and its verdict is honest. A non-PASS result is
  evidence for calibration, not permission to implement live execution.

# Final Heartbeat Counts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist post-drain inbox counts in the final `STOPPED` listener heartbeat without making shutdown RPC calls.

**Architecture:** `PersistentListenerHeartbeat` keeps its periodic full refresh for `RUNNING`, while its final write performs a PostgreSQL-only count refresh. Runtime ordering and public interfaces remain unchanged.

**Tech Stack:** TypeScript strict, Node test runner, PostgreSQL repository port, bigint-safe runtime heartbeat contracts.

---

### Task 1: Final count refresh

**Files:**
- Modify: `tests/production-listener-factory.test.ts`
- Modify: `src/application/production-listener-factory.ts`

- [ ] Add a focused test whose first `counts()` result contains one processing row and whose second result contains only pending/retryable rows.
- [ ] Assert the test fails because the final heartbeat still contains the first backlog and lease counts.
- [ ] Refresh `inbox.counts()` before constructing a `STOPPED` heartbeat, using `safeInboxBacklog` and preserving cached RPC slots.
- [ ] Assert the final heartbeat uses the second count result and that slot RPC methods were each called only once.
- [ ] Run `npx tsx --test tests/production-listener-factory.test.ts` and verify green.

### Task 2: Failure and acceptance

**Files:**
- Modify: `tests/production-listener-factory.test.ts`
- Modify: `docs/system-overview.html`
- Modify: `scripts/check-system-overview.ts` only if the accepted test total changes.

- [ ] Add a test where the second `counts()` call rejects with private text.
- [ ] Assert stop throws `ListenerControllerCloseError('heartbeat', 'dependency')`, does not retain the private text and does not write `STOPPED`.
- [ ] Verify concurrent stop idempotence remains covered by the shared stop promise.
- [ ] Update the operational document to remove the stale-final-count limitation.
- [ ] Run build, check, lint, documentation validation, focused tests, full PostgreSQL tests and `git diff --check`.
- [ ] Commit and push the verified correction to `main`.


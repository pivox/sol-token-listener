# RPC Soak Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded, read-only command that produces redacted HTTP/WebSocket evidence for a dedicated Solana RPC endpoint.

**Architecture:** A pure soak runner aggregates injected observations into a frozen `rpc-soak.v1` report. Separate HTTP and WebSocket adapters touch the network, while a thin CLI parses bounded environment values and renders one JSON line.

**Tech Stack:** TypeScript strict ESM, Node fetch/WebSocket/test runner, canonical Pump program constants.

---

### Task 1: Report contract and pure runner

**Files:**
- Create: `src/solana/rpc/rpc-soak.ts`
- Create: `tests/rpc-soak.test.ts`

- [ ] Write failing tests for configuration bounds, deterministic sample timing, integer latency percentiles, slot progress, program counts and frozen output.
- [ ] Run `npx tsx --test tests/rpc-soak.test.ts` and confirm failure because the module is absent.
- [ ] Implement the transport port, fixed error codes, runner and verdict aggregation with no network imports.
- [ ] Run the focused test to green and inspect every public value for endpoint/signature leakage.

### Task 2: HTTP and WebSocket adapters

**Files:**
- Create: `src/solana/rpc/rpc-soak-transport.ts`
- Create: `tests/rpc-soak-transport.test.ts`

- [ ] Write failing HTTP adapter tests for canonical slots, 429, other HTTP failure, invalid JSON-RPC and hostile thrown values.
- [ ] Write failing WebSocket tests for exactly two acknowledged canonical program subscriptions, normalized callbacks, disconnect health and complete cleanup.
- [ ] Implement cancellable `getSlot` sampling and two read-only `logsSubscribe` calls behind one bounded WebSocket session.
- [ ] Run both focused test files to green.

### Task 3: CLI and operator contract

**Files:**
- Create: `scripts/rpc-soak.ts`
- Create: `tests/rpc-soak-cli.test.ts`
- Create: `docs/operations/rpc-qualification.md`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] Write failing tests for default/exact configuration bounds, exit codes, one-line JSON and source-level safety imports.
- [ ] Implement the CLI around `loadConfig`, the adapters and the pure runner.
- [ ] Add `npm run rpc:soak`, safe environment examples and provider-dashboard guidance.
- [ ] Run focused tests and documentation validation.

### Task 4: Acceptance and PR

**Files:**
- Modify only files required by verified acceptance findings.

- [ ] Run `npm run build`, `npm run check`, `npm run lint`, `npm run docs:check`, `TEST_DATABASE_URL=postgresql:///postgres npm test` and `git diff --check`.
- [ ] Review the complete diff for secrets, production imports, floats, accidental writes and unrelated edits.
- [ ] Commit with issue #29, push the branch and open the PR with test evidence.
- [ ] Request `@codex` review, allow at most three review-correction cycles, and merge only with green checks and no blocking feedback.

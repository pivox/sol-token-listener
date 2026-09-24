# Bounded Finality Reconciler Diagnostics Implementation Plan

Version: 1.0.0 — 2026-09-24 — issue #151

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans and
> preserve the RED → GREEN → review sequence below.

**Goal:** Explain finality pass transitions into `DEGRADED` and their recovery
with stable, redacted and rate-bounded structured diagnostics, without changing
finality, retry, readiness, RPC or execution behavior.

**Architecture:** Add an immutable V1 diagnostic contract in the domain layer.
The existing recurring controller owns a private incident tracker and converts
only typed provider-selection failures and `FinalityReconcilerError` instances
to the closed reason vocabulary. An injected no-throw sink is wired by the
production factory through a small structured-logger adapter. No persistence,
API, frontend or migration changes are allowed.

**Tech Stack:** TypeScript strict ESM, Node test runner, Pino structured logs,
Markdown operator documentation.

---

### Task 1: Immutable diagnostic contract

**Files:**
- Create: `src/domain/finality-reconciler-diagnostic.ts`
- Create: `tests/finality-reconciler-diagnostic.test.ts`

- [ ] **Step 1: Write RED contract tests**

Assert the exact closed reason vocabulary, exact own enumerable keys, frozen
objects, non-negative safe integer bounds, phase/reason invariants and rejection
of extra keys. Cover saturation at and below `Number.MAX_SAFE_INTEGER`.

- [ ] **Step 2: Implement the minimal domain factory**

Expose `FINALITY_RECONCILER_DIAGNOSTIC_REASONS`,
`FinalityReconcilerDiagnosticReason`, `FinalityReconcilerDiagnosticV1`,
`createFinalityReconcilerDiagnostic(input: unknown)` and
`saturatingDiagnosticIncrement(value: number)`. The module must not import
application, logging, RPC, storage or execution code.

- [ ] **Step 3: Verify Task 1**

Run:

```bash
npx tsx --test tests/finality-reconciler-diagnostic.test.ts
npm run check:backend
npx eslint src/domain/finality-reconciler-diagnostic.ts tests/finality-reconciler-diagnostic.test.ts --max-warnings=0
git diff --check
```

The first command must fail before implementation because the module is absent,
then pass after implementation. Commit the contract separately.

### Task 2: Recurring-controller incident lifecycle

**Files:**
- Create: `src/application/finality-reconciler-diagnostic-tracker.ts`
- Create: `tests/finality-reconciler-diagnostic-tracker.test.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `tests/production-listener-factory.test.ts`

- [ ] **Step 1: Write RED transition and taxonomy tests**

Inject a diagnostic sink and deterministic clock. Cover `FAIL_START` before
rethrow, `DEGRADED_RETRY`, scheduled failure, explicit-start recovery, scheduled
recovery, all nine `FinalityReconcilerError` stages, provider unavailable,
provider epoch change and `UNKNOWN` for primitive, structural spoof, proxy and
`new FinalityReconcilerError('bogus' as never)` rejections. Classification must
use an exhaustive switch with a runtime default. Assert readiness and
scheduling remain unchanged.

- [ ] **Step 2: Write RED cadence, time and shutdown tests**

First define a pure reducer API in the RED tests:

```ts
createFinalityDiagnosticTrackerState(seed?: unknown): FinalityDiagnosticTrackerState
recordFinalityDiagnosticFailure(state, reasonCode, observedAtMs): FinalityDiagnosticReduction
recordFinalityDiagnosticRecovery(state, observedAtMs): FinalityDiagnosticReduction
```

All returned state and diagnostics are frozen and detached. Assert immediate
failure 1, no event for failures 2–11, a summary on 12 carrying the latest
reason, continued summaries at 24, cumulative suppressed counts and one
recovery. Seed the pure tracker at `Number.MAX_SAFE_INTEGER - 1` with cadence
position 11 and prove that total saturation does not stop the independent
0-to-11 cadence. Cover non-regressing time, invalid/throwing injected clock,
throwing sink, close in flight and close timeout. The close timeout must not be
reported as a pass failure.

- [ ] **Step 3: Implement typed classification and the incident tracker**

Implement the pure reducer in the new application module. Replace the two
generic provider-selection errors with a private closed typed error while
preserving the public messages and control flow. Wrap the complete error
classifier in `try/catch`. Extend `RecurringFinalityOptions` with
`diagnosticSink?: (diagnostic: FinalityReconcilerDiagnosticV1) => void` and
`diagnosticNow?: () => number`; capture each once in the constructor. Keep one
frozen reducer state, and offer diagnostics only after existing state decisions.
Swallow only clock/sink failures, never reconciler failures.

- [ ] **Step 4: Prove behavioral non-regression**

Run:

```bash
npx tsx --test tests/finality-reconciler-diagnostic-tracker.test.ts tests/production-listener-factory.test.ts tests/finality-reconciler.test.ts
npm run check:backend
npx eslint src/application/finality-reconciler-diagnostic-tracker.ts src/application/production-listener-factory.ts tests/finality-reconciler-diagnostic-tracker.test.ts tests/production-listener-factory.test.ts --max-warnings=0
git diff --check
```

The new diagnostic assertions must fail before implementation and all listed
tests must pass after it. Commit controller instrumentation separately.

### Task 3: Production structured logging and operator meaning

**Files:**
- Create: `src/application/finality-reconciler-diagnostic-logger.ts`
- Create: `tests/finality-reconciler-diagnostic-logger.test.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `tests/production-listener-factory.test.ts`
- Modify: `docs/operations/block-hydration-canary.md`
- Modify: `tests/deployment-artifacts.test.ts`

- [ ] **Step 1: Write RED logger-adapter tests**

Define
`createFinalityReconcilerDiagnosticSink(logger: FinalityDiagnosticLogger)` where
the logger exposes only `warn(record, message)` and `info(record, message)`.
With a narrow fake logger, assert `DEGRADED` maps to warn event
`listener.finality_reconciler_degraded`, `RECOVERED` maps to info event
`listener.finality_reconciler_recovered`, messages are fixed and application
records contain exactly event plus diagnostic fields. Prove no error, stack,
URL, signature, payload, mint, wallet or secret field can enter the record.

- [ ] **Step 2: Implement and compose the logger adapter**

Create a pure adapter around the narrow logger interface and pass its sink into
the production `RecurringFinalityReconciler`. Do not add configuration flags,
public API fields or persistence.

- [ ] **Step 3: Version the runbook**

Bump the canary runbook patch version. Document both event names, every reason
code, the one-in-twelve summary cadence, recovery duration and the fact that
observability does not make a degraded canary pass. First add a RED assertion
to `tests/deployment-artifacts.test.ts` for the new version, both event names,
all 12 reason codes, cadence and explicit non-PASS boundary.

- [ ] **Step 4: Verify Task 3**

Run:

```bash
npx tsx --test tests/finality-reconciler-diagnostic-logger.test.ts tests/production-listener-factory.test.ts tests/deployment-artifacts.test.ts
npm run docs:check
npm run check:backend
npx eslint src/application/finality-reconciler-diagnostic-logger.ts src/application/production-listener-factory.ts tests/finality-reconciler-diagnostic-logger.test.ts tests/production-listener-factory.test.ts tests/deployment-artifacts.test.ts --max-warnings=0
git diff --check
```

The logger and runbook assertions must fail before implementation, then pass.
Commit composition and documentation separately.

### Task 4: Release gate, PR and integration

**Files:**
- Modify only files already listed if a verified gate exposes a scoped defect.

- [ ] **Step 1: Independent local review**

Check the diff against issue #151 and design v1.0.0. Reject behavior changes,
unbounded logs, external values, API/storage widening, wallet/signing/submission
imports and any raw error logging. Apply only findings reproduced by tests.

- [ ] **Step 2: Run the complete gate**

Run `npm run build`, `npm run check`, `npm run lint`, `npm test`,
`npm run docs:check` and `git diff --check`. Use at most one task-owned
PostgreSQL container if the suite requires it, then remove that resource.

- [ ] **Step 3: Deliver with at most two review cycles**

Push the branch, open a PR closing #151, request one Codex review, resolve and
test valid findings, and request at most one final review. Merge only with all
required checks green and no unresolved blocking thread.

- [ ] **Step 4: Verify `main` and stop**

Confirm the merge commit and post-merge `main` CI. Update the ignored local
tracking file with point 1 and point 2 evidence. Do not start the Mainnet dry
run, RPC attestation, gates, wallet conversion, armament or trade.

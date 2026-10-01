# Qualification terminal attribution implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Two review cycles total maximum per user instruction.

**Goal:** Identify qualification failures without changing their handling.
**Architecture:** Closed trusted attribution through existing weak-map provenance;
additive SQL allowlist migration. No new logs or retries.
**Tech Stack:** TypeScript strict ESM, node:test, PostgreSQL, existing migrations.

## Task 1 — Domain and repository boundary

Files: `src/domain/terminal-attribution.ts`,
`src/storage/qualification-projection.repository.ts`,
`tests/terminal-attribution.test.ts`,
`tests/qualification-terminal-diagnostics.test.ts` (new).

- [ ] Write failing enum and real repository-method tests using the ScriptedPool
  pattern from `tests/qualification-projection.repository.test.ts`.
  Assert `trustedTerminalAttribution(error)?.diagnosticCode` against each exact
  code in the spec. Inject connect rejection; actual query rejection 40001 and
  40P01; callback with spoofed `{code:'40001'}`; TypeError/RangeError; unknown
  query/callback; cleanup-only; primary plus rollback/unlock/release failures.
  Assert public error classes/messages, aggregate length and query/release order
  are unchanged. Getter/proxy SQLSTATE must not execute getters or replace errors.
- [ ] Run RED:
  `node --import tsx --test tests/qualification-terminal-diagnostics.test.ts`.
  Missing diagnostic, not import/type errors, must be the failing assertion.
- [ ] Add eight spec codes to existing closed enum. Use existing
  `registerTrustedTerminalAttribution`, `trustedTerminalAttribution`, and
  `inheritTrustedTerminalAttribution`; do not register pipeline origins.
  Register fixed evidence only:
  ```ts
  registerTrustedTerminalAttribution(error, {
    version: 1, diagnosticCode, causeKind: null, pumpWire: null,
  });
  ```
  Guard optional registration. Wrap actual database query boundary to attest only
  own data-property SQLSTATE40001/40P01; preserve original thrown values. Carry
  primary provenance into existing redacted wrappers, cleanup fallback only if
  there was no primary failure. Keep connect/transaction/cleanup flow identical.
- [ ] Run GREEN plus existing repository/domain tests; record skips separately.
- [ ] Commit intended Task1 files only.

## Task 2 — Service and pipeline propagation

Files: `src/application/qualification-projection.service.ts`,
`tests/qualification-projection.service.test.ts`,
`tests/observed-transaction-pipeline.test.ts`, new diagnostic tests from Task1.

- [ ] RED: missing canonical launch retains its existing error identity/type and
  receives LAUNCH_MISSING; synchronous rebuilder rejection receives
  REBUILD_UNKNOWN unless already specifically attributed. Inject an error with
  secret text and assert only the fixed label survives exported evidence.
- [ ] Register missing-launch attribution at creation and rebuild attribution
  only around `this.rebuilder.rebuild(...)`. Rethrow the same value. Existing
  pipeline `inheritObservedPipelineOrigin` already inherits terminal attribution;
  prove it through pipeline failure rather than add another propagation path.
- [ ] Assert resulting failure remains stage qualification, origin UNKNOWN and
  retryable true exactly as before; no SQLSTATE inference from service errors.
- [ ] Run service/pipeline/domain tests GREEN and commit intended files.

## Task 3 — Persistence and export

Files: `migrations/059_transaction_inbox_qualification_attribution.sql` (new),
`tests/transaction-inbox-terminal-attribution.repository.test.ts`,
`tests/migrations.test.ts`, relevant existing terminal-artifact validator tests.

- [ ] RED: each new code roundtrips only with stage qualification; wrong stage
  and arbitrary diagnostic are rejected; existing v1 codes/rows stay valid.
- [ ] Add migration059 following migration058's structural drift/replay pattern.
  Extend diagnostic allowlists and stage compatibility without changing any
  older migration, row value, retention timestamp or table shape. Ensure replay
  checks distinguish exact supported prior/current definitions from drift.
- [ ] Prove base-empty and058-upgrade preserving preexisting evidence, replay,
  rejection of drift, and artifact parse/export propagation. Use existing test
  database harness; do not use the root .env or start a Mainnet process.
- [ ] Run build/check/lint/docs and focused tests; full PostgreSQL suite in CI.
  If no local database, report integration tests unexecuted rather than green.
- [ ] Commit. Review spec compliance then quality (local cycle1), address issues,
  open PR and request GitHub review (cycle2). Merge only after green full CI and
  all blocking feedback resolved; no third cycle.

## Completion evidence

No raw messages/SQL/credentials in attribution. All eight categories tested at
their actual boundary, exact retry/outcome preserved, migration safe, export
roundtrip proven. This completes attribution only, not capacity or trading gates.

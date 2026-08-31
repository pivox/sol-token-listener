# Executor Preflight and Operations Implementation Plan

> Keep #51-F structurally unable to sign or submit. Use TDD, a real PostgreSQL
> database, and no more than three GitHub review cycles.

**Goal:** Deliver the versioned #51-F safety preflight, durable stop controls,
inert manual armament, redacted operator commands and explicit least-privilege
PostgreSQL provisioning.

**Architecture:** Pure strict domains validate canonical evidence and operator
decisions. Migration 035 stores append-only proofs/events plus CAS aggregates.
A dedicated local CLI uses one repository; neither the listener nor executor
worker imports it. No runtime consumes an armament before #51-G.

**Normative design:**
`docs/superpowers/specs/2026-08-31-executor-preflight-operations-design.md`
version 1.0.5, parent version 1.6.4.

## Task 1 — Closed domain contracts

- Add `src/domain/execution-safety-qualification.ts`.
- Add `src/domain/execution-operations.ts`.
- Define the eleven canonical gate IDs, exact evidence DTOs, qualification
  fingerprint, five-minute TTL, stop transitions, phase bounds and armament
  fingerprint.
- Reject proxies, accessors, extra keys, unsafe dates/numbers and all numeric
  financial values that are not bigint.
- Test deterministic identity, all boundaries, replay and hostile inputs.

## Task 2 — Migration 035

- Add `migrations/035_execution_preflight_operations.sql` with seven closed
  tables from spec 1.0.5.
- Use relational gate rows, not JSON evidence.
- Add partial uniqueness for one current control state and one active armament
  per generation.
- Add immutability triggers for qualifications, evidence, authorizations and
  terminal events.
- Add four-hour purge markers only to terminal/expired payloads.
- Test empty schema, replay, upgrade from 034, catalog types, constraints and
  forbidden secret/URL/byte columns.

## Task 3 — Repository transactions

- Add `src/ports/execution-operations-repository.ts`.
- Add `src/storage/execution-operations.repository.ts`.
- Persist one qualification and its eleven proofs atomically.
- Serialize control and armament operations with the wallet-generation advisory
  lock already used by #51-E.
- Implement exact replay, CAS transitions, status snapshot and bounded report.
- Read PostgreSQL time as the lower bound for expiry decisions.
- Test concurrent kill switches, stale qualification, nonce replay, restart,
  active-armament uniqueness and rollback injection.

## Task 4 — Inert operator service and CLI

- Add `src/executor-operations/service.ts` with preflight, status, arm, stop,
  resume and report use cases.
- Add `src/executor-operations/config.ts` with public identities only.
- Add `src/executor-operations/terminal.ts` for injectable TTY confirmation.
- Add `src/executor-operations/main.ts` as a separate entrypoint.
- Add the six `live:*` npm scripts while keeping executor config rejection of
  live mode, live enablement and every secret variable unchanged.
- Emit one fixed versioned JSON envelope and fixed redacted errors.
- Test argv grammar, non-TTY refusal, exact phrase/nonce, expiration, command
  idempotence and absence of output leakage.

## Task 5 — PostgreSQL roles and operations documentation

- Add `scripts/provision-executor-roles.sql` for administrator-owned explicit
  role variables and least-privilege grants.
- Do not create passwords or grant elevated cluster attributes.
- Add `docs/operations/executor-preflight.md` with provisioning, preflight,
  status, stop, arm, resume and report runbooks.
- Document that #49 remains non-validated and #51-G is still mandatory.
- Add SQL inspection tests and optional real-role privilege tests.

## Task 6 — Architecture and retention

- Extend source and compiled graph guards so listener/API/paper/worker cannot
  import operator modules and operator modules cannot import signing/submission.
- Extend retention with bounded cohorts for expired qualifications,
  authorizations and terminal armaments while preserving active dependencies.
- Extend deployment smoke counters and docs contracts.
- Prove armaments have no production consumer.

## Task 7 — Full validation and PR

- Run focused domain and PostgreSQL tests.
- Run `npm run build`, `npm run check`, `npm run lint`, `npm run docs:check`.
- Run full backend/frontend tests with `TEST_DATABASE_URL` and zero unexpected
  skips.
- Verify `.env.example`, logs, reports, source and dist contain no new secret or
  submission capability.
- Commit, push and open one PR closing #51-F scope within issue #51.
- Request at most three Codex review cycles, address blocking threads and merge
  only with green CI and no unresolved thread.

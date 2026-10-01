# Qualification serialization reproduction and recovery — v1.1.0

## Purpose and evidence

Follow-up to #205/#206 and capacity issue #171. Canary `7c63710` has already
recorded 39 `QUALIFICATION_POSTGRES_SERIALIZATION` occurrences near T+5. The
complete run is still active. These labels prove query-boundary SQLSTATE 40001,
not which SQL statement failed or how much latency the failures caused.

Establish deterministic PostgreSQL reproductions before choosing a production
correction. This is an intermediate investigation, not completion of the capacity
goal or authorization to trade. Recommended-choice approval applies.

## Decision

Use two sessions, real migrations and the real qualification repository, with
explicit promise barriers rather than elapsed-time races. Reuse the existing
qualification fixtures and authority. Alternatives rejected at this stage:
another telemetry-only change does not establish a mechanism; changing isolation
or the global outbox allocator would change safety properties before proof.

No production behavior change is included in this revision. A corrective design
must be versioned after the reproduction results and before a fix is implemented.
Keep the investigation and resulting correction on one focused branch; do not
claim a test-only change resolves the runtime failures.

## Reproduction A: cross-mint outbox update

1. Seed canonical qualification sources for mint A in an isolated schema.
2. Start `PostgresQualificationProjectionRepository.transact` for A, call
   `loadCanonicalInput`, and pause after the snapshot has been established.
3. Commit a new domain event for another mint through a real repository writer.
   Verify A's source revisions remain unchanged and the API stream advances.
4. Resume A and call `replaceProjection` built from that snapshot.
5. A test-only driver wrapper records a closed operation label and SQLSTATE,
   never query parameters. Determine whether the failing statement is the
   qualification domain-event insert whose trigger updates API stream state.
6. Assert 40001 diagnostic attribution, complete rollback of A's report/event/API
   publication, preservation of B's committed event, and release of A's lock.
7. Rebuild from a fresh transaction and replay: one current report, one matching
   event/API publication, and `UNCHANGED` for the exact replay.

## Reproduction B: source replay without outbox change

Repeat A's snapshot barrier, then replay its original launchpad batch unchanged
through the launchpad repository in session B. Assert its physical domain-row
update does not advance the API stream. Resume A and determine whether
`qualification_source_mapping` fails on `FOR SHARE OF source,raw` with 40001.
Verify rollback, lock release, fresh reconstruction and exact replay as above.

## Invariants

- Session qualification lock remains before BEGIN REPEATABLE READ.
- Do not weaken source validation, finality, retention or idempotence.
- Do not remove the outbox global lock or replace it with a sequence: the
  existing committed publication order and resumable SSE contract must remain.
- No arbitrary retries, worker/cache increase, raw-error logging or new RPC.
- Promise barriers must release in finally blocks; database cleanup must target
  only the generated isolated schema after all sessions finish.
- No database tests run concurrently with the Mainnet canary. Reuse one bounded
  disposable disk-backed PostgreSQL container after canary cleanup.
- One code-review cycle, per the user's latest instruction; full CI before merge.

## Acceptance and interpretation

Both scenarios must either reproduce the attributed driver failure at the stated
boundary or return a documented counterexample that changes the proposed cause.
Do not alter test expectations to force a desired diagnosis. Verify successful
fresh reconstruction and absence of duplicate publications independently.

Even a successful reproduction proves a possible mechanism, not the exact cause
of every historical canary occurrence. The eventual fix must address the proven
case without losing coherent snapshots or hiding failed work; capacity still
requires a separate passing observation run.

## Observed reproduction results (2026-10-02)

The completed `7c63710` canary retained 137 qualification serialization
occurrences (115/19/2/1 across worker attempts 1/2/3/4), and capacity remained
FAIL. The two local PostgreSQL characterization tests then passed without skips:
cross-mint publication rejected `DOMAIN_EVENT_INSERT/40001`; unchanged launch
replay rejected `SOURCE_MAPPING/40001`. Both asserted full qualification rollback,
preserved concurrent publication, lock release, fresh reconstruction and an
unchanged exact replay with one linked qualification publication.

Command: `node --import tsx --test --test-concurrency=1 --test-name-pattern='qualification serialization' tests/qualification-projection.repository.test.ts`
with the isolated PostgreSQL 16.15 test URL configured. The adjacent repository,
service, launchpad, diagnostic and API-stream suites passed 137 tests with zero
failures or skips. Backend type checking and scoped ESLint also passed. These
observations establish both mechanisms; they
do not identify which statement caused each canary occurrence. No production
retry or isolation change has been made.

## Corrective design after reproduction

The recommended correction is explicit bounded whole-transaction replay, enabled
only by the qualification service whose callback reloads canonical input and
rebuilds its projection. Preserve the repository's default single-attempt
contract for all other callers and the characterization tests.

Add an optional closed transaction policy `'none' | 'bounded-serialization'` to
the qualification repository port, defaulting to `'none'`. The service selects
`'bounded-serialization'` for its canonical reconstruction. This policy promises
that its callback has no external effects and can be rerun with a new transaction.

The PostgreSQL implementation allows at most three attempts, separated by 10 ms
and 20 ms, matching an existing local bounded-backoff convention. These are
technical retry bounds, not trading thresholds or a promise of total latency.
Release the session lock and connection completely before waiting/reconnecting.
Each attempt reacquires the mint lock before BEGIN REPEATABLE READ and reloads
all evidence. Never reuse the earlier snapshot, projection or quotes as if they
had been reauthorized; the existing quote freshness checks run on each snapshot.

Retry eligibility is private per-attempt evidence from an actual query rejection
with an own data-property SQLSTATE `40001`. Do not authorize a retry using an
arbitrary error's `code`, a public diagnostic label, inherited fields, accessors,
proxies, a callback-spoofed error or a failure from an earlier attempt. Keep the
existing diagnostics, redaction and final failure origin/retryability unchanged.
Deadlock `40P01` is outside this observed correction and is not retried here.

A retry requires all of the following: BEGIN succeeded, the primary failure is
the actual recorded 40001, no commit succeeded, ROLLBACK succeeded, the session
unlock returned true, release succeeded, and there was exactly one primary
failure with no cleanup failures. A COMMIT 40001 may be retried after successful
rollback because it reports an aborted transaction; an unknown COMMIT outcome
must not be retried. Connect, BEGIN, lock, cleanup-only, data and rebuild errors
are not eligible. Failure of the injected test backoff preserves the original
redacted failure rather than exposing the wait error.

An internal private WeakSet of sanitized retry-eligible attempt errors can carry
this capability to the outer bounded loop; it must not become a persisted field,
new event taxonomy or publicly forgeable eligibility flag. Query-boundary
evidence is local to each attempt. Validate policy before connecting.

Alternatives not selected: holding the global API-stream lock throughout the
entire rebuild would serialize unrelated writers; lowering isolation would lose
the coherent snapshot invariant. Neither is needed to recover the two proven
conflicts. No migration, worker/cache increase or evaluator change is included.

### Correction acceptance tests

- Preserve both original single-attempt reproductions and their exact labels.
- Under explicit policy, both real PostgreSQL interleavings succeed on a fresh
  second attempt with one report/event/API publication and exact replay unchanged.
- Service opts into the policy; each retried callback reloads and rebuilds.
- Repeated conflicts stop after three attempts and waits `[10,20]`, preserving
  the final sanitized error and diagnostic; no fourth attempt occurs.
- No retry for forged diagnostic/SQLSTATE, hostile errors, deadlock, connect or
  BEGIN failure, successful-commit cleanup failure, unknown COMMIT outcome,
  rollback failure, unlock false/throw, or release failure.
- Show lock-before-BEGIN and rollback/unlock/release-before-backoff ordering;
  a new transaction object and connection are used for every attempt.
- Run existing qualification, pipeline, outbox, finality and paper tests. One
  code-review cycle and green full CI before merge. A later capacity canary is
  still required; successful replay tests alone do not establish readiness.

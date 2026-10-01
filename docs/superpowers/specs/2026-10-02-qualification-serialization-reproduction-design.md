# Qualification serialization reproduction — v1.0.0

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

# Wallet Graph Transaction Convergence

Date: 2026-09-27

Issue: #186

Status: approved for implementation

Contract revision: 1.0.0

## Context

The Mainnet observe-only canary and the existing deterministic PostgreSQL test
prove the same failure mode. Two workers for one mint may both open
`REPEATABLE READ` before the per-mint advisory lock. The second transaction
continues after the first commit with its older snapshot and PostgreSQL rejects
it with SQLSTATE `40001`.

The repository already authenticates `40001` and `40P01` only at the
PostgreSQL query boundary and registers exact-identity terminal diagnostics.
Public `code`, name, message, cause chains, and arbitrary callback errors are
not authority.

## Decision

`PostgresWalletGraphRepository.transact` retries the complete transaction at
most twice, for at most three attempts total. Fixed internal delays are:

```text
retry 1: 10 ms
retry 2: 20 ms
maximum cumulative delay: 30 ms
```

The delays are not configurable and have no jitter. The constructor accepts an
internal wait dependency for deterministic tests; production uses
`node:timers/promises`.

Every attempt is a new unit:

```text
BEGIN ISOLATION LEVEL REPEATABLE READ
→ acquire the same per-mint advisory transaction lock
→ create a new PostgresWalletGraphTransaction
→ execute the complete callback
→ COMMIT
```

On rejection, the repository first executes `ROLLBACK`. Only after a successful
rollback may it inspect `trustedTerminalAttribution(error)?.diagnosticCode`.
It retries only exact authenticated identities carrying
`WALLET_GRAPH_POSTGRES_SERIALIZATION` or `WALLET_GRAPH_POSTGRES_DEADLOCK` and
only while a delay remains. The third rejection is rethrown unchanged.

The same pooled connection is reused after a successful rollback and released
exactly once. The transaction object is never reused, so attempt-local loaded
fingerprints and snapshot state cannot leak across retries.

## No-retry boundaries

The repository performs one attempt only for:

- arbitrary errors or primitives;
- public lookalikes with `code='40001'` or a forged diagnostic property;
- hostile or revoked proxies;
- wrappers whose cause is an authentic PostgreSQL error;
- every other SQLSTATE or terminal diagnostic;
- a failed rollback;
- a failed injected wait.

Classification reads only the exact trusted terminal-attribution sidecar. It
does not read public properties, prototypes, cause chains, or proxy traps.

If rollback fails, the rollback error remains the active error and the session
is released without retry. If waiting fails, the wait error is propagated and
no new `BEGIN` occurs. A `COMMIT` authenticated as `40001` or `40P01` is rolled
back and the complete callback is replayed.

## Callback contract and idempotence

The repository port documents that its callback may run up to three times, but
only after a complete successful rollback of an authenticated transaction
conflict. The production callback performs database reads, pure analysis, and
transactional deterministic writes; it has no external effects.

The existing advisory lock, isolation level, canonical fingerprints, event
identities, uniqueness constraints, and replacement writes remain unchanged.
Successful convergence must leave one canonical profile, snapshot, cluster
event, and relation/member set without duplicates.

## Preserved boundaries

- No migration or durable schema change.
- No new environment variable or runtime configuration.
- No worker, pipeline, RPC, cache, wallet, signer, or execution change.
- No retry of the outer ingestion job is added or removed.
- Successful internal convergence produces no terminal failure.
- Exhaustion preserves the exact final `40001`/`40P01` identity and existing
  diagnostic for the outer pipeline and canary.

## Acceptance

- exact unit sequences prove two retries, delays `[10, 20]`, fresh transaction
  objects, rollback-before-wait, and one release;
- hostile and untrusted errors never retry or trigger accessors;
- rollback/wait/commit failure paths are deterministic and bounded;
- the two-worker PostgreSQL 16 reproduction converges without duplication and
  proves the retry reads the post-commit canonical state;
- focused wallet-graph, pipeline, check, lint, and docs tests pass;
- at most two review cycles and no RPC, wallet, signer, or order.

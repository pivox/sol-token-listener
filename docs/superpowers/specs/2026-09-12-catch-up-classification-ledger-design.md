# Catch-up Classification Ledger V1 Design

Version: 3 — 2026-09-13

## Scope

This change prepares the durable boundary required by issue #120 before any
block classifier is connected to production. It reuses
`chain_transaction_inbox`: one signature remains one technical ledger row and
no second classification table is introduced. The production scanner, RPC
composition, wallet and execution paths remain unchanged.

## Durable classification contract

A classified catch-up row records these seven fields as one immutable group:

- `catch_up_classification_version`, initially exactly `1`;
- `catch_up_disposition`: `ACTIONABLE`, `DEFERRED`, `IGNORED` or
  `QUARANTINED`;
- `catch_up_reason_code`, from the closed V1 registry;
- `catch_up_action_key`, derived as `PUMPFUN_CREATE`,
  `PUMPFUN_TRADE:<canonical-mint>` or `NONE` and immutable even when the current
  inbox hint later converges;
- `catch_up_mints`, a canonical sorted unique array of zero to sixteen Solana
  public keys;
- `catch_up_evidence_fingerprint`, a lowercase SHA-256 hexadecimal digest;
- `catch_up_classified_at`, a finite millisecond timestamp no earlier than the
  durable observation.

All seven values are null on legacy/unclassified rows or all seven are present.
Every classified row contains `CATCH_UP` in `discovery_sources`. Actionable and
deferred Pump actions require at least one mint; ignored and quarantined rows
may use the canonical empty array when no mint can be proven.

The stable reason registry is:

- `PUMP_ACTION_SUPPORTED` for `ACTIONABLE`;
- `PUMP_TRADE_UNTRACKED` for `DEFERRED`;
- `SOLANA_TRANSACTION_FAILED` or `NO_SUPPORTED_PUMP_ACTION` for `IGNORED`;
- `PUMP_SCHEMA_UNSUPPORTED` or `PROVIDER_SIGNATURE_MISSING` for
  `QUARANTINED`.

`ACTIONABLE` enters the existing actionable inbox lifecycle. `DEFERRED` uses
the existing promotable deferred lifecycle. `IGNORED` and `QUARANTINED` are
new terminal, non-claimable technical states with no decoder error and an
exact four-hour retention deadline.

## Repository boundary

The dedicated catch-up classification repository accepts one deeply immutable
classified notification. Validation happens before database access. Trade
persistence locks mint, then signature, then the inbox row, and writes the
classification together with the admission decision in one transaction. Trade
enqueue uses the same `mint -> signature -> row` order; `syncTrackedMint` uses
the compatible `mint -> rows` order. Membership is read while the mint lock is
held, so an active tracked mint is admitted as `PENDING/TRACKED_TRADE` even when
the original evidence disposition was `DEFERRED`.

Exact replay is idempotent. The immutable action key compares the original
CREATE/TRADE/NONE evidence without trusting the mutable current inbox hint.
Replay unions canonical program IDs, reconciles `confirmed` to `finalized`, and
preserves normal multi-program convergence of a trade hint to `NONE`. A changed
action key, version, disposition, reason, mint set, evidence fingerprint or
classification timestamp is an immutable classification conflict.

When exact finalized evidence arrives after an actionable row was processed at
`confirmed`, classification replay follows the inbox finality replay lifecycle:
the durable snapshot is retained, processing returns to `PENDING`, cycle-local
retry and terminal fields are cleared, and the finality evidence version is
advanced. Finalized is therefore not projected as processed until the retained
snapshot has been reclaimed and processed again. Missing snapshots or saturated
finality evidence fail closed.

Multi-mint values are stored only in `catch_up_mints`. The existing singular
`ingestion_hint_mint` remains for compatibility with the inactive current
runtime and identifies the current canonical hinted trade when required. The
immutable action key retains the initially classified trade mint if that hint
later becomes `NONE`. No
transaction-index or wait-for-mints column is added because neither is needed
to prove B1 atomicity.

## Strict-run accounting

`listener_strict_catch_up_runs` gains `signatures_classified BIGINT NOT NULL`.
Migration 048 backfills it from `signatures_enqueued`. Domain and database
constraints require:

`0 <= signatures_enqueued <= signatures_classified <= 9223372036854775807`.

The current scanner records both counters identically, so this addition has no
runtime selection or admission effect. Later B2/B3 work may classify more
signatures than it admits.

## Migration and retention safety

Migration 048 must apply from 047, apply on an empty database, and replay
without changing rows. It rejects incompatible columns or weakened
constraints. Existing rows are preserved as unclassified. Purging continues
through the existing inbox retention boundary: terminal ignored and
quarantined rows become eligible exactly four hours after classification,
while actionable work follows its existing lifecycle.

The SQL constraint decodes base58 arithmetically and requires exactly 32 bytes
per mint. It uses built-in PostgreSQL 16 PL/pgSQL and `NUMERIC` only, without an
extension. Alphabet-compatible impostors such as 44 `z` or 32 `2` characters
are rejected. Trade action keys require the exact literal
`PUMPFUN_TRADE:` prefix; SQL pattern wildcards are not used.

## Verification

Tests cover the pure domain contract, the 047-to-048 upgrade, empty database
and direct replay, catalog constraints, canonical multi-mint ordering,
terminal four-hour purge, exact replay, contradictory action replay,
program/finality convergence, concurrent lock ordering, transactional rollback,
processed-confirmed finality replay, exact action-key prefixes, exact 32-byte
base58 decoding and `signatures_classified >=
signatures_enqueued`. No test contacts an RPC provider or loads
signing/submission code.

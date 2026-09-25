# Pump.fun Paper MVP Technical Design

**Status:** accepted implementation contract for issues #149 and #28  
**Date:** 2026-09-25  
**Safety boundary:** paper execution only; no signer, private key, transaction submission, or live arming

## Outcome

Prove one bounded causal cycle on a fresh canonical Pump.fun launch:

```text
technical qualification
-> exactly one paper BUY
-> N distinct external buyers after the paper entry boundary
-> exactly one paper SELL of the remaining position
-> fees and position PnL reported
```

The historical qualification profile remains unchanged. The MVP profile is selected
explicitly and treats metadata, social evidence, holder concentration, and wallet
clusters as information rather than entry prerequisites.

## Decisions

### One qualification engine, two explicit profiles

Add `config/qualification/pumpfun-mvp-technical-v1.json`. The existing loader and
engine remain authoritative. The new profile:

- requires creator non-sale and the persisted technical quote facts;
- enforces simulation, reverse quote, round-trip loss, quote mint, and supported
  token constraints;
- assigns no required status to image, social cross-link, or pre-entry external
  buyers;
- uses a profile-owned minimum score and fingerprint;
- is never the implicit default.

The build copies a fixed allowlist of the historical and MVP profiles, validates
both before replacing the target directory, and ignores arbitrary JSON files.

### Persist the quote-backed decision

Today the projection is persisted before quotes exist. A later in-memory candidate
cannot safely repair this because repository admission requires the exact current
persisted report and fingerprint.

In paper mode, the worker therefore:

1. reauthorizes the canonical launch;
2. obtains the exact BUY and reverse SELL quotes;
3. rebuilds and persists the qualification with those quotes under the existing
   per-mint projection lock;
4. creates the candidate from that exact persisted report and quote pair;
5. opens the paper position atomically or retries fail-closed if the projection was
   superseded.

Observe mode performs no additional quote request or projection mutation.

### Causal entry boundary

The external-buyer counter must not start at the earlier qualification cursor.
The successful paper BUY records an explicit entry cursor/watermark in the durable
strategy session. Recovery reloads the same boundary. Only canonical BUY trades
strictly after it may count.

This paper boundary does not claim to be an on-chain execution cursor. The real
executor must later use its confirmed on-chain BUY cursor under #89.

### One active MVP position globally

The bounded proof permits one active `creation-entry-v1` position at a time across
all mints. The constraint is durable and transactional, not a count-then-insert
check. Existing data that violates the invariant makes the migration fail closed.
Terminal close/retract releases the admission for a later mint.

### Configurable N and one-shot evidence

`EXTERNAL_UNIQUE_BUYERS_TARGET` remains an integer in the existing safe range; 10
is only the default. Runtime validation, reason labels, and reports must use the
effective value rather than hardcode 10.

A new additive report version records, per selected cycle:

- qualification profile, verdict, blockers, reasons, decision cursor and time;
- paper BUY identity, entry cursor and time;
- effective N, distinct external-wallet evidence and progress;
- SELL identity, exit reason/cursor and any quote-wait/recovery;
- entry cost, exit proceeds, fees, gross and net PnL;
- exact logical BUY/SELL counts and final state.

Functional completion means the one-BUY/one-SELL causal cycle completed. Negative
PnL is reported truthfully but does not rewrite the functional result as incomplete.
The historical campaign/provider/profitability report remains compatible and is not
declared validated by this proof.

## Failure behaviour

- Missing, stale, inconsistent, unsupported, or excessive-loss quotes: no BUY.
- Superseded qualification or canonical launch: no BUY; retry only when safe.
- Concurrent mints: at most one receives the active-position admission.
- Replayed BUY/SELL or Nth buyer: no duplicate logical trade.
- SELL quote unavailable: explicit pending state, then idempotent recovery; never a
  fictitious close.
- No eligible launch or no threshold within the bounded window: incomplete report,
  never PASS.

## Compatibility and non-goals

- No change to the default historical profile.
- No second qualification, trading, quote, or execution engine.
- No holder-growth rule, Sybil inference, social collection, wallet history, UI,
  signer, key loading, Mainnet transaction, or real armament.
- Existing creator, kill-switch, and configured executable-take-profit exits remain.
- All monetary values and cursors stay integer/`bigint` at domain boundaries.

## Acceptance evidence

The PR must prove with unit and PostgreSQL integration tests:

- no-social technical evidence qualifies only under the explicit MVP profile;
- quote-backed facts are persisted and the exact report is admitted;
- creator sale, unavailable/incoherent/stale quotes, unsupported assets, excessive
  loss, or supersession produce no BUY;
- a trade between qualification and entry is excluded, while a strictly later trade
  is included after recovery;
- two concurrent mints produce one active MVP position;
- N-1, duplicate wallet, Nth wallet, concurrent replay, pending SELL quote, and
  recovery preserve exactly one BUY and one full SELL;
- the compiled production CLI emits the new one-shot report without `tsx`;
- build, check, lint, docs, backend PostgreSQL tests, frontend tests, and deployment
  contracts remain green.

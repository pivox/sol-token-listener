# Mainnet paper MVP validation design

Date: 2026-08-26
Issue: #49
Status: approved through the standing instruction to select the recommended option

## Objective

Validate `creation-entry-v1` on 50 closed Mainnet paper positions with a durable, reproducible
report. This adds measurement around the existing listener, quote router, strategy, and paper
ledger. It does not add a second trading engine and cannot sign or submit transactions.

## Existing foundation and gaps

The current system already persists deterministic candidates, sessions, BUY/SELL quotes, positions,
venue fees, slippage, price impact, conservative minimum-out fills, bigint PnL, retries, reorgs, and
four-hour retention. `paper:dry-run` produces a bounded technical snapshot but is duration-based,
not resumable, and lacks per-position latency, drawdown, network cost, duplicate detection, provider
usage, and the #49 gate.

## Chosen architecture

```text
existing Mainnet paper runtime
          |
          v
 paper positions/trades/events -----> PaperMvpCollector
          |                                  |
          |                                  v
          +------------------------ paper_mvp_position_samples
                                             |
                                             v
                                  versioned JSON report + gate
```

`npm run paper:mvp` starts the normal application in paper mode and polls one PostgreSQL-backed MVP
run. A unique active run for `creation-entry-v1` is resumed after restart when its immutable target,
quote mint, network-fee model, and provider identity match. A new runner never adopts incompatible
state silently.

## Durable run and retention

Migration 018 adds:

- `paper_mvp_runs`: deterministic run identity, period, target, immutable configuration,
  provider counters, state, verdict, and four-hour terminal retention;
- `paper_mvp_position_samples`: one immutable sample per `(run, position)`, including every latency,
  cost, exit category, and PnL fact required by the report.

The collector snapshots closed positions before the ordinary paper rows expire. This lets a run
span restarts without extending the product-wide four-hour retention rule. Samples and runs are
deleted four hours after the run becomes terminal. Raw chain data and business projections remain
separate.

## CLI and bounds

The command is:

```bash
npm run paper:mvp -- \
  --target-closed=50 \
  --max-duration-seconds=14400 \
  --poll-seconds=5 \
  --network-fee-raw-per-transaction=5000 \
  --report-file=paper-mvp.json
```

The target is bounded to 1–1000, duration to 60–14400 seconds, polling to 1–60 seconds, and network
fee to a canonical non-negative 78-digit integer. The report is created with mode `0600` and never
overwrites an existing file. SIGINT/SIGTERM and timeout finalize an honest non-PASS report after one
last collection.

## Per-position facts

No new timestamps are invented. The collector derives and stores:

- `creationDetectedAt`: `token_launches.detected_at`;
- `entryDecisionAt`: creation paper job `created_at`, before quote acquisition;
- `entryQuoteAt`: persisted BUY quote `observedAtMs`;
- `paperBuyAt`: BUY trade `created_at`;
- `exitTriggerAt`: the triggering `PaperPositionClosed` domain event observation time;
- `exitQuoteAt`: persisted SELL quote `observedAtMs`;
- `paperSellAt`: SELL trade `created_at`.

The sample is rejected as unknown when timestamps are missing or violate their causal order. In
particular, an entry fill is valid only when:

```text
creationDetectedAt <= entryDecisionAt <= entryQuoteAt <= paperBuyAt
```

and an exit only when:

```text
exitTriggerAt <= exitQuoteAt <= paperSellAt
```

All dates are PostgreSQL timestamps or validated integer epoch milliseconds.

## Cost and PnL model

Venue execution remains exactly the existing conservative ledger model. The report records BUY and
SELL `feesRaw`, `slippageBps`, `priceImpactBps`, `amountOutRaw`, and `minimumAmountOutRaw`. MVP net
PnL is recalculated with integers as:

```text
modelNetPnlRaw = sellMinimumAmountOutRaw
  - buyAmountInRaw
  - 2 * networkFeeRawPerTransaction
```

The configured network fee is immutable for the run and currently valid only for the initial SOL
quote allowlist. Multi-quote results remain grouped, but the PASS gate fails closed unless every
sample uses the one configured quote mint.

## Report and gate

`paper-mvp.v1` contains the period, counts, exit categories, gross/model-net PnL, mean net PnL,
win rate basis points, maximum drawdown basis points, venue/network costs, latency mean/p95,
unknown positions, duplicate BUY/SELL counts, and provider usage. Amounts are decimal strings;
rates and counts are integers.

Exit categories map stable reasons as follows:

- `EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED` → `10_UNIQUE_BUYERS`;
- `TAKE_PROFIT_2X_EXECUTABLE` → `2X`;
- creator sell or manual kill → `SAFETY`.

Verdict is `PASS` only when all #49 predicates hold. Missing provider usage or any persistent 429
makes the technical status `DEGRADED` and prevents PASS. Provider credit values are read through a
small `ProviderUsageProbe` port; an unavailable adapter returns explicit unknown evidence rather
than fabricated zero usage.

## Idempotence and reconciliation

Sampling uses the committed paper position ID as its logical key. Repeated polls and restarts use
`ON CONFLICT` equality checks; contradictory immutable facts fail the run. Duplicate logical BUY or
SELL counts are computed from persisted trades even though database uniqueness should keep them at
zero. Retracted positions do not count as closed successes and remain explainable in coverage.

## Safety boundary

The runner imports the ordinary application bootstrap but exposes no wallet, signer, transaction
builder, or `sendTransaction` capability. It requires `EXECUTION_MODE=paper`, the creation strategy,
Mainnet, and transaction submission disabled. A report PASS authorizes only later consideration of
#51; it does not enable live execution or claim long-term profitability.

## Human dependency

The provider-specific credit adapter and its credentials cannot be selected from repository facts.
Until the operator chooses a provider with an authoritative usage API, runs are valid but receive a
truthful `DEGRADED`/non-PASS provider status. No secret is stored in PostgreSQL or the report.


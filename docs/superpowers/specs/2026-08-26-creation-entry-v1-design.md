# `creation-entry-v1` paper strategy design

Date: 2026-08-26  
Issue: #48  
Status: approved through the standing instruction to select the recommended option

## Objective

Add the versioned `creation-entry-v1` strategy without creating another paper engine. A fresh,
canonically qualified Pump.fun launch may open one paper position. The position is then monitored
until the first executable exit among:

1. a safety trigger;
2. a conservative full-position SELL quote worth at least 2x the reconciled entry cost;
3. ten distinct external buyer wallets.

The listener remains observation/paper only. It never loads a wallet, signs a transaction, or
submits a transaction.

## Existing foundation and gaps

The existing pipeline already provides:

- canonical qualification and blocker enforcement;
- deterministic trading candidates;
- fresh BUY and reverse SELL quotes;
- round-trip loss validation with `bigint`;
- durable paper jobs, leases, retries, sessions, positions, and trades;
- atomic/idempotent open and close operations;
- Pump.fun and PumpSwap trade projections;
- reorg reconciliation and four-hour retention.

The current `validated-external-buys` strategy counts trades rather than wallets. It has no
full-position 2x trigger, no direct creator-sell exit, no operational manual kill switch, and no
`creation-entry-v1` configuration contract.

## Chosen architecture

Extend the existing candidate → paper-decision worker → strategy → paper ledger path. Do not add a
second worker, quote router, position repository, or paper ledger.

```text
canonical launch + qualification + quotes
                  |
                  v
        TradingCandidateService
                  |
                  v
         PaperDecisionWorker
                  |
                  v
       CreationEntryV1Strategy
         |       |        |
         |       |        +-- unique buyer projection
         |       +----------- full-position SELL quote
         +------------------- existing PaperTradingEngine
                                  |
                                  v
                         paper positions/trades/events
```

The old `validated-external-buys` identity remains readable for already persisted V1 sessions. New
sessions use `creation-entry-v1`, version 1, and a V2 session payload. Only one strategy can be
enabled in a process.

## Configuration

The strategy is disabled by default. Its public configuration is:

```dotenv
CREATION_STRATEGY_ENABLED=false
CREATION_ENTRY_MAX_AGE_MS=45000
CREATION_ENTRY_MAX_SLOT_LAG=32
EXTERNAL_UNIQUE_BUYERS_TARGET=10
EXTERNAL_MIN_BUY_AMOUNT_RAW=
CREATION_TAKE_PROFIT_MULTIPLIER_BPS=20000
CREATION_MANUAL_KILL_SWITCH=false
```

It reuses the existing explicit paper configuration for entry size, slippage, quote freshness,
minimum confirmation, round-trip loss, retry, and lease settings. Enabling it requires:

- `EXECUTION_MODE=paper`;
- explicit paper entry amount and slippage;
- explicit round-trip loss limit;
- the canonical qualification profile;
- SOL/WSOL in the paper quote allowlist;
- a positive `EXTERNAL_MIN_BUY_AMOUNT_RAW`.

`CREATION_STRATEGY_ENABLED` and the legacy `PAPER_STRATEGY_ENABLED` cannot both be true. Observe mode
cannot create sessions, positions, trades, or fills.

## Entry decision

The existing candidate service remains the only entry projection. For `creation-entry-v1`, it uses
the canonical launch observation time and launch slot, not the later qualification time, for the
entry deadline.

An entry is eligible only when all of the following are true:

- the canonical creation is active and at least at the configured confirmation level;
- the launch is Pump.fun and its quote asset is the initial SOL/WSOL allowlisted asset;
- current qualification is `QUALIFIED` and has no blocker;
- token age is at most `CREATION_ENTRY_MAX_AGE_MS`;
- quote slot lag from the launch and between the BUY/reverse SELL pair is within configured limits;
- both quotes are fresh, coherent, and cover the exact conservative BUY fill;
- the reverse SELL quote exists and the round-trip loss is within the configured limit;
- no creator SELL is active at or before the entry decision;
- no active paper session or position exists for the mint.

An expired launch produces `CREATION_ENTRY_EXPIRED`; other failed mandatory checks produce stable,
explainable candidate reasons. Entry still goes through the existing `PaperTradingEngine`, including
its atomic current-qualification guard and deterministic open command.

## Unique buyer counting

A `PaperStrategySessionV2` stores paired `countedTradeIds` and `countedBuyerWallets`. Wallet strings
are exact Solana base58 identities and are never normalized by case.

A BUY counts only if it:

- belongs to the same mint and quote mint;
- is Pump.fun or canonical PumpSwap;
- is strictly after the entry cursor;
- is active, successful, and at least at the configured confirmation level;
- has a non-null trader different from the creator;
- has `quoteAmountRaw >= EXTERNAL_MIN_BUY_AMOUNT_RAW`;
- has not already contributed that wallet to the session.

There is no execution wallet in V1 paper mode, so there is no signer address to exclude. The paper
actor is represented by `PAPER_SIMULATION`, not by a fabricated wallet.

The first eligible trade per wallet is retained as the evidence for that wallet. Replays do not
increase the count. Reconciliation rebuilds the unique-wallet projection from active trades after
an orphaning event.

## Exit arbitration

The strategy evaluates exit causes in this strict order:

1. `MANUAL_KILL_SWITCH`;
2. `CREATOR_EARLY_SELL`;
3. `TAKE_PROFIT_2X_EXECUTABLE`;
4. `EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED`.

Every close uses a fresh SELL quote for the entire `remainingBaseRaw`. The 2x condition is:

```text
sellQuote.minimumAmountOutRaw
  >= position.quoteCostRaw * CREATION_TAKE_PROFIT_MULTIPLIER_BPS / 10_000
```

The comparison uses integer cross-multiplication to avoid division and rounding ambiguity:

```text
sellQuote.minimumAmountOutRaw * 10_000
  >= position.quoteCostRaw * CREATION_TAKE_PROFIT_MULTIPLIER_BPS
```

`lastPrice * quantity` and JavaScript floating point are forbidden.

If an exit trigger exists but its full SELL quote is missing or stale, the position remains open and
the session becomes `EXIT_PENDING_QUOTE` with `SELL_QUOTE_UNAVAILABLE_OR_STALE`. A later job retries
the quote. It is never marked closed without a committed paper SELL.

The manual kill switch is checked at startup and on every decision. At startup, the repository
re-enqueues active sessions using their latest durable source event so the switch also applies when
no new chain trade arrives.

## State and reason contracts

The existing durable state machine is retained:

```text
BUY_PENDING
  -> PAPER_HOLDING / WAITING_EXTERNAL_BUYS
  -> EXIT_PENDING_QUOTE
  -> SELL_PENDING
  -> PAPER_CLOSED
```

`PAPER_RETRACTED` and `MANUAL_REVIEW` remain terminal reconciliation states. New stable reason codes
are added without reusing qualification reason codes for a different meaning:

- `CREATION_ENTRY_EXPIRED`;
- `CREATION_ENTRY_REJECTED`;
- `EXTERNAL_UNIQUE_BUY_OBSERVED`;
- `EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED`;
- `TAKE_PROFIT_2X_EXECUTABLE`;
- `CREATOR_EARLY_SELL`;
- `MANUAL_KILL_SWITCH`;
- `SELL_QUOTE_UNAVAILABLE_OR_STALE`.

Safety reasons always win over profit or buyer-count reasons when several triggers occur in the
same decision.

## Persistence and migration

Migration 017 is additive and replayable:

- permit V2 paper session payloads and the new reason codes;
- add the strategy identity needed on external-buy evidence;
- backfill that identity from the parent session without deleting or rewriting evidence;
- enforce one `creation-entry-v1` buyer-wallet evidence row per session with a partial unique index;
- retain legacy V1 sessions and duplicate-trade evidence unchanged;
- preserve the four-hour purge contract.

Session V2 payloads contain the unique buyer wallets and the pending/committed exit reason. External
buyer evidence includes the raw quote amount used for the minimum-amount check. Raw chain events stay
separate from these business projections.

The paper ledger commits its deterministic open or close first. Repository completion then persists
the candidate, session, unique-buyer evidence, requested action, and derived domain events in its own
transaction. A staged session plus deterministic ledger reconciliation closes this intentional
transaction boundary after a crash. Database uniqueness and deterministic command hashes prevent
concurrent triggers from producing a second logical BUY or SELL.

## Reorg and retry behavior

- Orphaned creation: retract the entry and session through the existing source reconciliation.
- Orphaned counted BUY: rebuild unique wallets from active trades; retract a close whose only trigger
  no longer exists.
- Orphaned creator SELL: rebuild exit arbitration; a committed close is retracted only through the
  existing explicit reorg path.
- Quote outage: record no close, keep the position open, and retry durably.
- Crash after ledger commit: recover the deterministic open/close without another fill.
- Competing triggers: serialize per job/session and accept only the first committed close command.

## API and observability

Existing `/api/v1/paper-positions`, launch detail, timeline, and SSE contracts remain the public
surface. Their V1 envelopes are unchanged. Additive fields expose:

- strategy id/version;
- unique buyer count and target;
- last exit evaluation/reason;
- pending quote state;
- deterministic paper BUY/SELL events.

Structured logs expose strategy state and reason codes but never URLs containing credentials,
wallet secrets, raw provider responses, or private data.

## Test strategy

Unit tests cover:

- one wallet buying ten times counts once;
- ten distinct eligible wallets trigger one close;
- below-minimum purchases do not count;
- complete conservative SELL at 2x triggers, theoretical/partial 2x does not;
- creator SELL and manual kill switch precede other triggers;
- missing/stale SELL quote leaves the position open;
- all financial comparisons use `bigint`.

Integration tests cover:

- valid fresh creation to exactly one paper BUY;
- replay/crash to no second BUY or SELL;
- stale/orphaned/creator-sold creation to no BUY;
- two concurrent exit triggers to one committed SELL;
- migration 001–017 on an empty database and clean replay;
- V1 session compatibility and V2 unique-wallet persistence;
- orphan reconciliation of entry, buyers, and exit evidence;
- observe mode creating no paper artifacts.

The PR acceptance gate remains `npm run build`, `npm run check`, `npm run lint`, `npm test`, migration
replay, documentation checks, and the existing deployment smoke contract.

## Out of scope

- real execution, wallet loading, signing, or transaction submission;
- Sybil/funder clustering for the ten-wallet trigger;
- automatic threshold calibration;
- the 50-position Mainnet runner and profitability gate from #49;
- canary or micro-live execution from #51;
- a second paper engine or second position repository.

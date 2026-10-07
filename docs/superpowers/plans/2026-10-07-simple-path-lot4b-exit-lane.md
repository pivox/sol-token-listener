# Simple path, lot 4b: exit lane and fast-path report

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**User decisions (2026-10-07, binding):**
1. A stuck SELL gets a **guarded re-exit in this lot** (Task 6).
2. Take-profit stays a **market trigger**: last observed curve trade, SELL `minimumAmountOutRaw = 1` (deviation 4).
3. **After a migration, only the deadline or a revoked envelope exits** (deviation 5).
4. A SELL that **landed with an error and changed nothing but the fee** is a terminal no-effect failure, and the re-exit may retry it. Every other mismatch still blocks (Task 5, deviation 11).

**Goal:**
1. Recovery (H2a) sells an OPEN **envelope** position before its deadline when the first of these is true:
   1. its entry envelope is `REVOKED`;
   2. the creator sold after our entry;
   3. take-profit: the value of the remaining tokens at the latest observed curve price reaches `EXIT_TAKE_PROFIT_BPS` of the quote cost;
   4. at least `EXIT_EXTERNAL_BUYERS_TARGET` distinct external buyers bought at least `EXIT_EXTERNAL_MIN_BUY_RAW` after our entry.
2. The deadline exit (`maximum-holding-exit`) is unchanged. It always runs first in a pass and stays the only exit reason of CANARY positions (the Task 6 re-exit only re-issues a dead SELL).
3. A read-only `fast-path:report` CLI shows the funnel, the latencies, the result per position and the 429 counts (spec «Mesure»).
4. A position stuck `EXIT_PENDING` behind a SELL intent that ended `FAILED` or `EXPIRED` with no possible send in flight gets a new SELL intent, at most 3 times per position (CANARY and envelope positions alike).
5. It is proven, by tests, that `creates-only` already records `migrations` + `market_pools` for a tracked mint that migrates, so the live SELL can route to PumpSwap after a migration.

Nothing is signed or sent by the code added here. Signing stays in H2b.

**Architecture:**
- **One new H2a lane, `exit`, after `deadline`** in `ORDERED_LANES` (`src/executor-live-recovery/runtime.ts:49-53`). The `deadline` lane (`src/executor-live-recovery/lanes.ts:190-203`) and `createNextDeadlineExitIntent` (`src/storage/execution-live.repository.ts:1471-1510`) keep their behaviour.
- **Pure decision** in a new `src/domain/fast-exit.ts` (`decideFastExit`). The repository reads the facts with SQL and passes them in. A fact that cannot be read or decoded makes its conditions undecidable: they are skipped, never an error that reaches the deadline.
- **SELL intent creation** reuses the deadline transaction body. `createDeadlineExitIntentLocked` (`execution-live.repository.ts:5058-5154`) and `findDeadlineIntent` (`:5156-5239`) are parameterised by an exit spec: strategy id, logical command id, whether the deadline must be due, and the lower bound of `requested_at`. The deadline spec reproduces today's values exactly.
- **Same lock order as the deadline scanner** (`:1471-1510`): `pg_advisory_xact_lock(hashtextextended('execution-live-deadline-scan:v1', 51007))`, then `lockWorkerTrackingMints`, then `lockLiveSellPresenceInTransaction`, then `lockGeneration` (51005), then `FOR UPDATE OF position`. No envelope or armament row is written.
- **One live SELL per position** stays structural: a first exit needs the position `OPEN` with `exit_intent_id IS NULL` (`:5141-5146`). The only other write of `exit_intent_id` is the Task 6 re-exit. It replaces a dead intent (`FAILED`/`EXPIRED`, no send possible) under the same locks, and the 066 trigger enforces that guard.
- **No RPC in H2a for exits.** Take-profit uses the latest observed curve trade in `domain_events`. H2b re-quotes at SELL time and protects the amount with its own slippage (`src/executor-simulation/attempt-evaluator.ts:407-413`: `protected = max(intent.minimumAmountOutRaw, computed.minimumAmountOutRaw)`).

**Tech Stack:** TypeScript (tsx, node:test), PostgreSQL 16 (pg).

Spec: `docs/superpowers/specs/2026-10-06-simple-path-design.md` («Lane `exit` (recovery)» 189-211, «Pollers des mints suivis» 80-100, «Configuration» 262-274, «Erreurs» 276-287, «Mesure» 289-299, «Risques connus» 329-340).

**Deviations from the spec (decided while planning):**
1. **No `LiveExitDecided` event.**
   - No event-type migration, no `api_event_stream` CHECK change, no frontend or zod change, and no `domain_events` INSERT grant for H2a.
   - The early SELL uses the BUY intent's `decision_event_id`, exactly as the 4a deadline does (`:5066-5083`, `:5107`).
   - The exit reason is encoded in the intent: `strategy_id='fast-entry-exit-v1'` and `logical_command_id='fast-exit:<REASON>:<position_id>'`. A deadline keeps `maximum-holding-exit` / `maximum-holding:<position_id>`.
   - The reason is durable: purge copies `logical_order_key` (= `logical_command_id`) into `execution_intent_tombstones` (`src/storage/database.ts:714-723`). The PnL is durable in `execution_live_position_ledger`, which is never purged. The report reads both.
   - The API event stream and the `/live` page are unchanged, because no event type is added.
2. **`deadline` is kept and `exit` is added after it, instead of `exit` replacing `deadline`.**
   - In each pass the deadline is evaluated first, in its own transaction. An `exit` failure cannot delay it.
   - Early exits only consider positions whose deadline is **not** due (`exit_deadline_at > now`). When the deadline is due, the reason is `DEADLINE` even if another condition is also true. The spec order (REVOKED first) only changes the label in that case.
3. **Early exits apply only to envelope positions** (`execution_activation_armaments.envelope_id IS NOT NULL`). CANARY positions keep today's deadline-only behaviour.
4. **Take-profit without a quote, and `minimumAmountOutRaw = 1` for every reason.** The spec wanted an RPC SELL quote and the quote's minimum as `minimumAmountOutRaw`.
   - **Estimate:** `remaining_base_raw × last.quoteAmountRaw / last.baseAmountRaw`, where `last` is the latest curve trade after entry that is not ours.
   - **Fires when:** `estimate × 10 000 ≥ quote_cost_raw × EXIT_TAKE_PROFIT_BPS`.
   - **Why the estimate is enough:** on a bonding curve the price only moves through trades. The latest ingested trade is therefore the curve state up to the ingestion lag. That lag is the poller interval (10 s) plus finalization plus inbox processing: about 25-40 s in normal operation, and unbounded if the poller stalls.
   - **Why the minimum is 1:**
     - A protective minimum can make the SELL fail terminally (`MINIMUM_AMOUNT_OUT_VIOLATED`, `attempt-evaluator.ts:411-413`) or expire (`src/storage/execution-intent-expiration.ts:50-54`).
     - The position then stays `EXIT_PENDING` with a dead `exit_intent_id`, so even the deadline can no longer sell it.
     - With `1`, an early SELL has exactly the failure modes of the deadline SELL. H2b still protects the price with `EXECUTOR_SLIPPAGE_BPS` against its fresh quote.
   - **Consequence:** a false take-profit only means an earlier exit, at market minus slippage. It is never a later one.
   - **Not needed:** H2a gets no RPC method, no pump SDK and no new RPC budget.
5. **Curve trades only.** The rules read `BondingCurveTradeObserved` rows in `domain_events`, not `market_trades`.
   - After a migration no curve trade is produced, so conditions 2-4 stop firing and the deadline sells on the pool.
   - **Why:** `market_trades` has no index on `mint` (`migrations/005_pumpswap_market.sql:106-110`), and reading it would need two more grants (`market_trades`, `market_pools`). Take-profit 2× normally fires long before a curve completes.
6. **The rules are reimplemented, not imported.**
   - `earliestCreatorSell` and `canonicalBuys` (`src/application/creation-entry-v1.strategy.ts:620-650`, `:652-715`) are module-private and take the paper reconcile input (session, candidate, paper confirmation). The executor graphs must not depend on the paper application layer.
   - The new pure function mirrors their semantics, with these choices:
     - **confirmation:** `confirmed` or `finalized`;
     - **"after entry":** trade `slot` strictly greater than the BUY's finalized `execution_reconciliation_evidence.observed_slot`. Same-slot trades are ignored, which is conservative;
     - **excluded traders:** the creator (for buyers) and our own wallet;
     - **buyers:** one per wallet.
7. **`market_pools` in creates-only: no new feed** (spec: pool venue via `migrations JOIN market_pools`).
   - The curve poller polls the bonding curve address, which is an account of the migrate instruction. The migrate transaction is therefore enqueued as `PUMPFUN_CURVE_TRADE`.
   - The `pumpswap_observation` stage runs on every observed transaction (`src/application/observed-transaction-pipeline.ts:142-143` → `src/application/pumpswap-observation-pipeline.ts:61-110`), and writes `migrations` and `market_pools`.
   - `selectTrackedCurves` then stops polling that curve (`src/storage/tracked-curve.repository.ts:55-80`).
   - The live SELL router needs exactly that row (`src/executor-simulation/venue-router.ts:62-75`, `src/storage/execution-venue.repository.ts:101-117`).
   - Task 8 proves this with tests. The checkpoint line «creates-only n'alimente pas market_pools» is corrected once the tests pass. If they fail, stop and report: do not build a feed without a new decision.
   - `LISTENER_TRACKED_POOL_POLL_ENABLED` stays optional. It only adds post-migration pool trades, which this lot does not read.
8. **The report is a separate CLI, `fast-path:report`, and it runs on `DATABASE_URL` in a `READ ONLY` transaction.**
   - It does not extend `live:report`, which is an alias of `status` (`src/executor-operations/main.ts:89-92`), and it does not use the operations role: that role would need SELECT on `entry_decisions`, `domain_events`, the ledger and the heartbeats.
   - **429 counts:**
     - listener: the cumulative counters in the latest `listener_heartbeats.payload.rpcHttpEvidence` (written at `src/storage/transaction-inbox.repository.ts:2872`), counted since that process started. No per-request history is persisted;
     - executor: `execution_provider_rate_limit_events` in the window, which has 4 h retention.
   - **Retention:** latencies after «decided» come from armaments and signed artifacts, which are purged 4 h after they become terminal. Run the report within 4 h of a run. PnL and exit reasons are durable.
9. **No feature flag.** `EXIT_*` are optional H2a variables with the spec defaults. Early exits only touch envelope positions, which only exist with `live:auto-arm` (lot 4a).
10. **Migration 066 for the re-exit** (the spec plans no re-exit at all).
    - The position update guard only allows the state pairs of `execution_live_state_transition_allowed` (`migrations/036_execution_live_canary.sql:865-903`). `EXIT_PENDING → EXIT_PENDING` is not one of them, and `EXIT_PENDING → OPEN` is not either. So `exit_intent_id` cannot be replaced without a migration.
    - 066 replaces `guard_execution_live_position_update` (`036:1090-1118`) with a body that is identical except for one extra branch. That branch accepts `EXIT_PENDING → EXIT_PENDING` only when it replaces a dead exit intent with no possible send (Task 6).
    - No other constraint, table or grant changes.

11. **Narrow on-chain SELL failure (user decision 4).** It reuses `NO_EFFECT`/`RECONCILIATION_PROVED_NO_EFFECT`, and the intent ends `FAILED`: no new result, reason code or CHECK. `meta.err` is read but not persisted. Today such a SELL is `MISMATCH`/`RESIDUAL_TOKEN_BALANCE` (`src/domain/execution-reconciliation.ts:192-194`), not `BALANCE_MISMATCH` as first assumed. BUY reconciliation is unchanged.

**Environment:**
- Worktree `/Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile`, branch `feat/exit-lane` (= `origin/main` `3bb355cc`, lot 4a merged).
- Postgres: `TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55432/sol_token_listener_test`. Never use 5432.
- Never run a listener, an RPC, H2a/H2b against a real endpoint, or any real transaction. All RPC is faked in tests.
- One test: `TEST_DATABASE_URL=... npx tsx --test tests/<file>.test.ts`.
- Full suite: `rm -rf dist && npm run build:backend && TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55432/sol_token_listener_test npm run test:backend`. `qualification-projection.repository.test.ts` timeouts are a known flaky case.

**File map:**

| File | Change |
|---|---|
| `src/domain/fast-exit.ts` (new) | reasons, policy, `decideFastExit`, logical command id build/parse |
| `src/storage/execution-live.repository.ts` | exit spec parameter on the deadline body; `createNextEarlyExitIntent` |
| `src/ports/execution-live-repository.ts`, `src/ports/execution-live-recovery-repository.ts` | new method and result type; facade |
| `src/executor-live-recovery/{config,lanes,runtime,logger}.ts` | `EXIT_*`, `exit` lane, `EXIT_FAILED`, lane name `EXIT` |
| `src/executor-live-recovery/database-authority.ts`, `scripts/provision-executor-roles.sql` | recovery SELECT on `domain_events` |
| `migrations/066_live_position_reexit.sql` (new) + registration files | position guard allows replacing a dead exit intent |
| `src/cli/fast-path-report.ts` (new), `package.json` | report |
| `.env.example`, `docs/operations/executor-live-canary.md`, checkpoint | docs |
| Tests | listed per task |

One migration (066, the position update guard, Task 6). No frontend change. No new event type.

---

### Task 1: Domain, `decideFastExit`

**Files:** create `src/domain/fast-exit.ts`, `tests/fast-exit.test.ts`.

```ts
export const FAST_EXIT_STRATEGY_ID = 'fast-entry-exit-v1';
export const FAST_EXIT_REASONS = ['ENVELOPE_REVOKED', 'CREATOR_SOLD', 'TAKE_PROFIT', 'EXTERNAL_BUYERS'] as const;
export type FastExitReason = typeof FAST_EXIT_REASONS[number];
export type ExitReason = FastExitReason | 'DEADLINE';
export interface FastExitPolicy { readonly takeProfitBps: bigint; readonly externalBuyersTarget: number;
  readonly externalMinimumBuyRaw: bigint }
export interface FastExitTrade { readonly eventId: string; readonly kind: 'BUY' | 'SELL';
  readonly trader: string | null; readonly baseAmountRaw: bigint; readonly quoteAmountRaw: bigint;
  readonly slot: bigint; readonly transactionIndex: number; readonly instructionIndex: number;
  readonly innerInstructionIndex: number | null }
export interface FastExitFacts {
  readonly envelopeState: string;          // ACTIVE | EXHAUSTED | REVOKED | EXPIRED
  readonly creator: string | null;         // null = unknown or ambiguous
  readonly walletPublicKey: string;
  readonly remainingBaseRaw: bigint;
  readonly quoteCostRaw: bigint;
  readonly trades: readonly FastExitTrade[] | null;  // null = unreadable; already filtered: slot > entry, WSOL, confirmed|finalized
}
export function decideFastExit(facts: FastExitFacts, policy: FastExitPolicy): FastExitReason | null;
export function fastExitLogicalCommandId(reason: FastExitReason, positionId: string): string; // `fast-exit:${reason}:${positionId}`
export function exitReasonOfLogicalKey(key: string): ExitReason | null;
// 'maximum-holding:<pos>' -> DEADLINE; 'fast-exit:<R>:<pos>' -> R; an optional ':retry-<1..3>'
// suffix (Task 6) is stripped first; else null
export function reExitLogicalCommandId(currentLogicalCommandId: string): string | null;
// root = current without ':retry-<k>'; returns `${root}:retry-${k+1}` (k = 0 without suffix), null when k+1 > 3
```

Rules, evaluated in this order, each guarded on its own:
1. `envelopeState === 'REVOKED'` → `ENVELOPE_REVOKED`.
2. `trades !== null && creator !== null`, and some trade has `kind === 'SELL'` and `trader === creator` → `CREATOR_SOLD`.
3. `trades !== null` and `quoteCostRaw > 0n`. Take `last`, the trade with the greatest cursor `(slot, transactionIndex, instructionIndex, innerInstructionIndex ?? -1, eventId)` whose `trader !== walletPublicKey` and whose `baseAmountRaw > 0n`. Then `TAKE_PROFIT` when `remainingBaseRaw * last.quoteAmountRaw * 10_000n >= quoteCostRaw * policy.takeProfitBps * last.baseAmountRaw`. This is the cross-multiplied form, so there is no division.
4. `trades !== null`. Count the distinct `trader` over trades with `kind === 'BUY'`, `trader !== null`, `trader !== creator` (when the creator is null, exclude nothing for it), `trader !== walletPublicKey` and `quoteAmountRaw >= policy.externalMinimumBuyRaw`. If the count is at least `externalBuyersTarget` → `EXTERNAL_BUYERS`.
5. Otherwise `null`.

`decideFastExit` validates its inputs (frozen exact records, bigints ≥ 0, policy in range). It throws `TypeError` on malformed input. The caller (Task 2) catches the error and treats it as "no early exit".

- [ ] **Step 1: Write failing tests.**
  - One case per rule, plus order: REVOKED wins over creator sell over TP over buyers.
  - `trades: null` → only REVOKED can fire.
  - `creator: null` → no CREATOR_SOLD; buyers still counted.
  - Own-wallet trades are ignored for TP and buyers.
  - The creator's buys are not counted.
  - A wallet that buys twice counts once.
  - A buy below the minimum is not counted.
  - TP boundary: exactly equal fires, one lamport less does not.
  - `last` is chosen by cursor, not by array order.
  - A `last` with `baseAmountRaw = 0` is skipped.
  - `quoteCostRaw = 0` → no TP.
  - `fastExitLogicalCommandId` round-trips through `exitReasonOfLogicalKey`.
  - `'maximum-holding:execution_live_position_…'` → `DEADLINE`; unknown prefixes → null.
  - `reExitLogicalCommandId`: root → `:retry-1`, `:retry-1` → `:retry-2`, `:retry-3` → null; the reason survives the suffix (`fast-exit:TAKE_PROFIT:<pos>:retry-2` → `TAKE_PROFIT`).
- [ ] **Step 2:** Implement. Run the test and `npm run build:backend`.
- [ ] **Step 3: Commit.** `feat(domain): fast exit decision (envelope revoke, creator sell, take-profit, external buyers)`

### Task 2: Storage, exit spec on the deadline body and `createNextEarlyExitIntent`

**Files:**
- `src/storage/execution-live.repository.ts`:
  - `createDeadlineExitIntent` `:1454-1469`;
  - `createNextDeadlineExitIntent` `:1471-1510`;
  - `createDeadlineExitIntentLocked` `:5058-5154`;
  - `findDeadlineIntent` `:5156-5239`.
- `src/ports/execution-live-repository.ts`: `ExecutionDeadlineExitResultV1` `:270-274`, interface `:365`.
- Tests: `tests/execution-live.repository.test.ts`. Reuse `openPositionFixture` (`:3113`), `makePositionDue` (`:3213`), `withTemporarySchema` (`:3369`), and `linkEnvelope` / `insertEnvelope` from `tests/execution-live-sell-reconciliation.test.ts:743-772`. Move those two into `tests/helpers/` if needed.

Changes:
- Add `ExitIntentSpec { strategyId; logicalCommandId; requireDue: boolean; requestedAtLowerBound: 'DEADLINE' | 'OPENED' }`.
  - `createDeadlineExitIntentLocked(client, input, spec)` uses `spec.strategyId` and `spec.logicalCommandId` in the draft (replacing `:5092-5094`).
  - It applies the `NOT_DUE` early return (`:5089-5091`) only when `spec.requireDue`.
  - It selects `position.opened_at` (ms) in addition and adds it to the `exactRow` keys.
  - `findDeadlineIntent` takes the lower bound value: `exitDeadlineAtMs` for the deadline, `openedAtMs` for early exits. It keeps every other check, including TTL 120 000 and `live_reserved`.
- `deadlineSpec(positionId)` = `{ 'maximum-holding-exit', 'maximum-holding:'+positionId, true, 'DEADLINE' }`. Both deadline callers pass it.
- **Every existing deadline test passes unchanged.** If `tests/execution-live-repository-contract.test.ts` pins SQL text, update only the added `opened_at` column.
- New `createNextEarlyExitIntent(policy: FastExitPolicy): Promise<ExecutionEarlyExitResultV1 | null>`, with result `{ payloadVersion: 1; kind: 'CREATED'; reason: FastExitReason; intent: ExecutionIntentV1 }`. In one transaction:
  1. Take the 51007 scan lock and read the clock: the same two statements as `:1473-1479`.
  2. Read the candidates (at most 20):
```sql
SELECT position.position_id,position.generation_id,position.mint,position.wallet_public_key,
  position.remaining_base_raw::TEXT AS remaining_base_raw,position.quote_cost_raw::TEXT AS quote_cost_raw,
  buy.observed_slot::TEXT AS entry_slot,envelope.state AS envelope_state
FROM execution_live_positions position
JOIN execution_activation_armaments armament ON armament.armament_id=position.armament_id
JOIN execution_entry_envelopes envelope ON envelope.envelope_id=armament.envelope_id
JOIN execution_reconciliation_evidence buy
  ON buy.evidence_fingerprint=position.entry_reconciliation_fingerprint AND buy.side='BUY'
WHERE position.state='OPEN' AND position.exit_intent_id IS NULL
  AND position.exit_deadline_at > TIMESTAMPTZ 'epoch'+($1::BIGINT*INTERVAL '1 millisecond')
  AND buy.observed_slot IS NOT NULL
ORDER BY position.opened_at,position.position_id LIMIT 20
```
  3. For each candidate, read its facts (`readFastExitFacts`):
     - **Creator:**
```sql
SELECT DISTINCT payload #>> '{launch,creator}' FROM domain_events
WHERE type='TokenLaunchDetected' AND mint=$1 AND confirmation_status<>'orphaned'
```
       Exactly one non-null value is the creator; any other result gives `null`.
     - **Trades** (the limit is 10 001 rows):
```sql
SELECT event_id,slot::TEXT AS slot,transaction_index,instruction_index,inner_instruction_index,
  payload #>> '{trade,kind}' AS kind, payload #>> '{trade,trader}' AS trader,
  payload #>> '{trade,baseAmountRaw,$solTokenListenerBigInt}' AS base_amount_raw,
  payload #>> '{trade,quoteAmountRaw,$solTokenListenerBigInt}' AS quote_amount_raw,
  payload #>> '{trade,quoteAsset,mint}' AS quote_mint
FROM domain_events
WHERE type='BondingCurveTradeObserved' AND mint=$1
  AND confirmation_status IN ('confirmed','finalized') AND slot > $2::NUMERIC
ORDER BY slot,transaction_index,instruction_index,COALESCE(inner_instruction_index,-1),event_id
LIMIT 10001
```
       Bigints are stored with the `$solTokenListenerBigInt` marker (`src/utils/json.ts:1`, `:19-25`), written through `toJsonValue` (`src/storage/launchpad-event.repository.ts:240`). The query uses the `domain_events_mint_cursor_idx` index (`migrations/002_pumpfun_foundation.sql:93-94`).
     - The trades list is `null` when any of these holds:
       - more than 10 000 rows;
       - a row whose kind is not BUY/SELL;
       - an amount that is not a canonical decimal;
       - a quote mint that is not WSOL;
       - a trader that is not null and is not a canonical public key.
  Steps 2-3 read the facts **before** the mint / SELL-presence / 51005 locks, holding only the 51007 scan lock, and the envelope SELECT is not locked (`FOR UPDATE` would break the 4a lock order, A24). This is harmless: each fact only changes one way while a position is `OPEN` (envelopes leave `ACTIVE` but never return to it; trades are append-only after entry), so a stale read can only delay a reason by one pass. Step 6 re-locks the position and re-checks `OPEN` and `exit_intent_id IS NULL`.
  4. `decideFastExit` runs inside `try/catch`, and an error counts as `null`. The first candidate with a reason continues. If none has one, return `null`.
  5. Take `lockWorkerTrackingMints([mint])`, `lockLiveSellPresenceInTransaction`, then `lockGeneration(generationId)`: the same order as `:1500-1502`.
  6. Call `createDeadlineExitIntentLocked(client, { positionId, observedAtMs, generationId }, { FAST_EXIT_STRATEGY_ID, fastExitLogicalCommandId(reason, positionId), false, 'OPENED' })`. It re-reads the position `FOR UPDATE` and requires `OPEN` and `exit_intent_id IS NULL`. Map `REPLAYED` to `CONFLICT`: the scan only picks positions without an exit intent, so a replay here is a bug.
- [ ] **Step 1: Write failing tests (PG).**
  - **One early-exit case per reason**, each on an envelope-linked position (`linkEnvelope`) with seeded `TokenLaunchDetected` / `BondingCurveTradeObserved` rows. Build each payload with `toJsonValue(...)` (from `src/utils/json.ts`), as the real writer does. Each case checks:
    - intent `strategy_id='fast-entry-exit-v1'` and `logical_command_id='fast-exit:<R>:<pos>'`;
    - `side='SELL'`, `venue_policy='CANONICAL_EXIT'`, `minimum_amount_out_raw=1`, `base_amount_raw=remaining`;
    - `decision_event_id` = the BUY's;
    - `live_reserved=TRUE`, TTL 120 s, and `requested_at ≥ opened_at`;
    - the position is `EXIT_PENDING` with `exit_intent_id` set.
  - **Nothing happens** (the call returns `null` and writes nothing) in each of these cases:
    - a CANARY position (no `envelope_id`) whose trades would trigger every rule;
    - trades at `slot ≤ entry slot`;
    - `orphaned` or `processed` trades;
    - trades by our own wallet;
    - a malformed amount, which makes the trades list null (a REVOKED envelope still exits in that case);
    - a position whose deadline is due: it is left to the deadline scanner.
  - **One SELL per position:**
    - after an early exit, `makePositionDue` + `createNextDeadlineExitIntent()` returns `null`;
    - two concurrent `createNextEarlyExitIntent` create exactly one intent;
    - an early exit racing a due deadline gives exactly one SELL intent.
  - **Deadline unchanged:** the existing deadline tests (`:105-530`) pass unchanged.
- [ ] **Step 2:** Implement. Run `tests/execution-live.repository.test.ts`, `tests/execution-live-repository-contract.test.ts`, `tests/execution-live-sell-reconciliation.test.ts` and the build.
- [ ] **Step 3: Commit.** `feat(live-recovery): early exit intents for envelope positions (revoke, creator sell, take-profit, external buyers)`

### Task 3: Recovery grant on `domain_events` (tested under `SET ROLE`)

**Files:**
- `src/executor-live-recovery/database-authority.ts`: add a table entry after `execution_entry_envelopes` (`:270-275`).
- `scripts/provision-executor-roles.sql`: in the recovery section (`:1134-1299`), after the envelopes grant (`:1207-1212`).
- Tests: `tests/executor-live-recovery-startup.test.ts`, `tests/executor-roles-provisioning.test.ts`, and a role test in `tests/execution-live.repository.test.ts`. Reuse `withProvisionedDatabase` / `roleSource` from `tests/helpers/entry-envelope-fixture.ts:413`, `:454`.

```sql
-- Lot 4b exit lane: read-only access to observed launch and curve trade events of the
-- position's mint. Public chain data; no INSERT/UPDATE/DELETE.
GRANT SELECT (event_id,type,mint,slot,transaction_index,instruction_index,inner_instruction_index,
  confirmation_status,payload)
ON TABLE domain_events TO sol_token_executor_live_recovery;
```
Authority: `table('domain_events', columns('event_id','type','mint','slot','transaction_index','instruction_index','inner_instruction_index','confirmation_status','payload'), columns(), columns())`.

No other recovery grant is needed. Each column read in Task 2 is already granted:
- positions (`:207-256`);
- armaments `armament_id`, `envelope_id` (`:257-269`);
- envelopes `envelope_id`, `state` (`:270-275`);
- reconciliation evidence `evidence_fingerprint`, `side`, `observed_slot` (`:351-424`).

The SELL insert columns are the deadline's. Check that `domain_events` has no RLS and no SELECT trigger: `grep -n "domain_events" migrations/*.sql | grep -i "policy\|row level"` must be empty.

- [ ] **Step 1: Write failing tests.**
  - The provisioning test and the startup authority test match the new grant exactly.
  - **Role test (A14 lesson):** under `SET ROLE sol_token_executor_live_recovery`, with the roles provisioned, `createNextEarlyExitIntent` creates the SELL for a creator-sell fixture. In the same test, `createNextDeadlineExitIntent` still works for another position.
- [ ] **Step 2:** Implement. Run the tests and the build.
- [ ] **Step 3: Commit.** `feat(live-recovery): recovery role reads observed launch and trade events for the exit lane`

### Task 4: H2a `exit` lane and `EXIT_*` configuration

**Files:**
- `src/executor-live-recovery/config.ts`: interface `:4-21`, parse `:39-94`, helpers `:149-163`.
- `src/executor-live-recovery/lanes.ts`:
  - error codes `:35-45`;
  - `LiveRecoveryLanes` `:65-69`;
  - `createLiveRecoveryLanes` `:71-80`;
  - `deadlineLane` `:190-203`, which is left as is.
- `src/executor-live-recovery/runtime.ts`: `ORDERED_LANES` `:49-53`, `SAFE_ERROR_CODES` `:54-61`.
- `src/executor-live-recovery/logger.ts`: `:4`, `:100`.
- `src/ports/execution-live-recovery-repository.ts`: `:29-42`, `:63-78`.
- Tests:
  - `tests/executor-live-recovery-config.test.ts`;
  - `tests/executor-live-recovery-lanes.test.ts`;
  - `tests/executor-live-recovery-runtime.test.ts`, whose lane order assertions are at `:15-26`;
  - `tests/executor-live-recovery-database.test.ts:182-205` (facade key lists);
  - `tests/execution-live-repository-contract.test.ts:70-81` (contract method list);
  - `tests/executor-live-database.test.ts:207-211` (H2b "absent" list: add `createNextEarlyExitIntent`).

Changes:
- **Config:** `exitTakeProfitBps: bigint` (`EXIT_TAKE_PROFIT_BPS`, 10 001..100 000, default 20 000), `exitExternalBuyersTarget: number` (`EXIT_EXTERNAL_BUYERS_TARGET`, 1..1000, default 10) and `exitExternalMinimumBuyRaw: bigint` (`EXIT_EXTERNAL_MIN_BUY_RAW`, a canonical decimal > 0 that fits u64, default 1 000 000).
  - Add an `optionalInteger` helper: absent means the default; present but invalid rejects.
- **Port and facade:** add `createNextEarlyExitIntent`.
- **Lane:**
```ts
async function exitLane(dependencies, signal): Promise<LiveRecoveryLaneResult> {
  assertActive(signal);
  try {
    const result = await dependencies.live.createNextEarlyExitIntent(policyFrom(dependencies.config));
    assertActive(signal);
    return result === null ? 'IDLE' : 'WORKED';
  } catch (error) {
    if (error instanceof LiveRecoveryLaneError) throw error;
    throw laneFailure('EXIT_FAILED');
  }
}
```
- `ORDERED_LANES` gets `['exit', 'EXIT']` **after** `['deadline', 'DEADLINE']`. Add `'EXIT_FAILED'` to `SAFE_ERROR_CODES` and `'EXIT'` to the logger lane names.
- Log one line per created early exit, `executor_live_recovery.exit_decided` with the `reason` field (a new log key accepted by the logger whitelist; value in `FAST_EXIT_REASONS`). No mint, no wallet.
- [ ] **Step 1: Write failing tests.**
  - Config: the defaults; each bound ±1; an absent variable takes its default; `EXIT_EXTERNAL_MIN_BUY_RAW=0` is rejected; a non-decimal is rejected.
  - Lanes: `exit` returns IDLE on `null` and WORKED on a result. A repository error becomes `EXIT_FAILED`, an aborted signal becomes `OPERATION_ABORTED`, and the policy comes from the config.
  - Runtime:
    - order `reconciliation, confirmation, deadline, exit`;
    - a WORKED `deadline` ends the pass before `exit`;
    - an `exit` that throws on every pass still lets `deadline` run first on the next pass, and the error is logged as `lane: 'EXIT'`, `errorCode: 'EXIT_FAILED'`.
  - The facade key lists include `createNextEarlyExitIntent`.
- [ ] **Step 2:** Implement. Run the recovery test files and the build.
- [ ] **Step 3: Commit.** `feat(live-recovery): exit lane after the deadline lane, EXIT_* configuration`

### Task 5: Narrow classification of a SELL that landed but failed on chain (user decision 4)

**Today.** A SELL that lands with a program error (slippage exceeded, etc.) is finalized with `meta.err` set, its fee is charged and every other state change is reverted. Recovery reads it with `readFinalizedWalletDeltas` (`src/executor-live-recovery/rpc-gateway.ts:157-192`). For a SELL that call sets `unexpectedResidualTokenBalanceRaw = base.post` (`:187`), which is the full unsold balance. `classify` (`src/domain/execution-reconciliation.ts:185-219`) therefore returns `MISMATCH`/`RESIDUAL_TOKEN_BALANCE` at its first check (`:192-194`); `BALANCE_MISMATCH` (`:206-210`) is not reached. `commitSellReconciliation` then takes the `!terminal` branch (`src/storage/execution-live.repository.ts:4724-4800`): artifact `AMBIGUOUS`, intent `UNKNOWN_REQUIRES_RECONCILIATION`, position `UNKNOWN`, `unknown_block = TRUE`. MISMATCH evidence can never be resolved (`migrations/034_execution_risk_reconciliation.sql:720-728`), so the position is stuck for good.

**Evidence available to the reconciler.**
- `getTransaction` (`rpc-gateway.ts:242-306`) already requires `meta.err` (`:265-268`) but does not return it.
- It returns `fee`, `preBalances`/`postBalances` (lamports) and `preTokenBalances`/`postTokenBalances`.
- `tokenAmounts` (`:375-398`) sums, over every token account in those maps owned by the wallet for the mint, `pre` and `post`, and `delta = post − pre`.
- `baseDeltaRaw` is that delta. For a WSOL quote, `quoteDeltaRaw = walletLamportDelta + fee` (`:180-182`).

**"Token balance unchanged", exactly:**
- `baseDeltaRaw === 0n`, i.e. the sum of the wallet's token amounts for the mint is the same before and after, across all of its token accounts in the transaction's token-balance maps;
- `quoteDeltaRaw === 0n` and `walletLamportDelta === −feeLamports`, i.e. the only lamport change is the fee;
- `0n < feeLamports ≤ expected.maximumFeeLamports`.

**The new rule** is SELL only and placed **before** the residual check:

```ts
// classify(), first statement
if (expected.side === 'SELL'
  && observed.transactionFailed === true
  && observed.signatureHistory === 'PRESENT' && observed.confirmationStatus === 'FINALIZED'
  && observed.finalizedAtMs !== null && observed.observedSlot !== null
  && observed.transaction !== null && sameTransaction(expected, observed.transaction)
  && observed.baseDeltaRaw === 0n && observed.quoteDeltaRaw === 0n
  && observed.walletLamportDelta === -observed.feeLamports
  && observed.feeLamports > 0n && observed.feeLamports <= expected.maximumFeeLamports) {
  return outcome('NO_EFFECT', 'RECONCILIATION_PROVED_NO_EFFECT');
}
```

Every other combination falls through to today's rules unchanged:
- `meta.err` with any token or lamport change → `MISMATCH`;
- a successful transaction → `MATCHED` or `MISMATCH`;
- BUY → as today.

**Plumbing.** Add `transactionFailed: boolean` (`meta.err !== null`) to:
- the gateway's finalized observation;
- `FinalizedWalletDeltasV1` (`src/ports/execution-reconciliation-gateway.ts:16-26`; `false` when `NOT_FOUND`);
- `OBSERVED_KEYS` (`src/domain/execution-reconciliation.ts:17-22`) and `observedFrom`. `transactionFailed === true` requires `FINALIZED`.
- `src/executor-risk/reconciliation-service.ts:85-98`.

It is **not persisted**:
- The evidence identity and fingerprint are computed from the persisted fields (`assertExecutionReconciliationEvidenceIdentity`), and `classify` is not replayed from the database.
- The persisted row stays distinguishable from a classic NO_EFFECT: `signature_history='PRESENT'`, `confirmation_status='FINALIZED'`, an `observed_transaction_fingerprint`, and `fee_lamports > 0`.

No CHECK changes, because the evidence CHECK accepts `NO_EFFECT`/`RECONCILIATION_PROVED_NO_EFFECT` with `finalized_at` set (`034:713-719`). Update every constructor of the observed object (`grep -rln "unexpectedResidualTokenBalanceRaw:" src tests`). `src/storage/execution-risk.repository.ts` keeps its behaviour: the variant can only come from a SELL, and that path is left as is (verify it does not receive SELL evidence; if it can, it rejects a `PRESENT` NO_EFFECT with CONFLICT).

**Commit path** (`commitSellReconciliation`, `execution-live.repository.ts:4564`). Define `landedNoEffect = evidence.result === 'NO_EFFECT' && evidence.signatureHistory === 'PRESENT'`. When it holds, in the same transaction:
1. **Artifact:** if it is not already `AMBIGUOUS`, move it `ACCEPTED|CONFIRMED → AMBIGUOUS` with `RECONCILIATION_REQUIRED`, reusing the statements at `:4725-4738`. The submission-event CHECK only allows `AMBIGUOUS → RECONCILED` with `RECONCILIATION_PROVED_NO_EFFECT` (`036:1197-1200`); `CONFIRMED → RECONCILED` is reserved for `INTENT_SUCCEEDED`.
2. **Intent:** if it is not already `UNKNOWN_REQUIRES_RECONCILIATION`, move it `SUBMITTED|CONFIRMED|RECONCILING → UNKNOWN_REQUIRES_RECONCILIATION` (`:4739-4755`).
3. **Skip** the position `UNKNOWN` update, `unknown_block = TRUE` and `stopEntriesForSystemEvidence` (`:4767-4800`).
4. **Run the existing NO_EFFECT branch** (`:4803-4880`), with one change: the intent goes `UNKNOWN_REQUIRES_RECONCILIATION → FAILED` (not `RETRY_READY`), with `last_reason_code='RECONCILIATION_PROVED_NO_EFFECT'` and `terminal_at = reconciliation_completed_at = finalized`. That branch already:
   - moves the artifact `AMBIGUOUS → RECONCILED`;
   - moves the position `UNKNOWN → EXIT_PENDING` if a prior UNKNOWN run set it;
   - moves the exit authorization `LOCKED → ACTIVE` with `locked_intent_id=NULL` (`:4823-4829`);
   - recomputes `unknown_block` from unresolved UNKNOWN/MISMATCH evidence;
   - abandons the attempt;
   - resolves prior UNKNOWN evidence (`:4710-4721`).

`purge_after = terminal + 4 h`. Every constraint already allows this:
- `UNKNOWN_REQUIRES_RECONCILIATION → FAILED` with `RECONCILIATION_PROVED_NO_EFFECT` is required by `execution_intent_transitions_reconciliation_proof_check` (`031:385-389`) and allowed by the status/reason CHECKs (`036:146-149`, `:168-171`);
- `FAILED` is terminal, so the H2b claim never takes it again;
- the Task 6 re-exit guard accepts it.

**Why FAILED and not RETRY_READY.** `RETRY_READY` would let H2b re-sign the same intent, with no cap, until its 120 s TTL. `FAILED` is terminal, and the next SELL goes through the guarded, capped, spaced re-exit.

**Grants:** none. Recovery already updates every column used (`database-authority.ts:46-121` intents, `:122-171` artifacts, `:172-191` attempts, exit authorizations, risk state).

**Not counted.** The fee of a failed SELL is in no PnL: neither `execution_live_position_ledger` nor the envelope realized loss counts it. The report adds it (Task 9).

- [ ] **Step 1: Write failing tests.**
  - Domain (`tests/execution-reconciliation.test.ts`):
    - **landed + err, unchanged balance → NO_EFFECT**: SELL, `transactionFailed`, base 0, quote 0, wallet −fee, residual > 0;
    - **landed + err with any token change → MISMATCH**: base −1, or base +1, or wallet −fee−1;
    - **landed + err with a fee above the maximum → MISMATCH**;
    - **landed OK → MATCHED, unchanged**;
    - **a BUY with err → unchanged** (MISMATCH);
    - **`transactionFailed: true` with `NOT_FOUND` → invalid**;
    - every existing case unchanged.
  - Gateway (`tests/executor-live-recovery-rpc.test.ts`): `meta.err` non-null → `transactionFailed: true`; null → false.
  - PG (`tests/execution-live-sell-reconciliation.test.ts`), for a landed-failed SELL whose artifact is `CONFIRMED` (and a second case where it is `ACCEPTED`):
    - after reconciliation the artifact is `RECONCILED`, the intent `FAILED` (terminal), the exit authorization `ACTIVE`, the position `EXIT_PENDING`, `unknown_block = FALSE`, and the evidence is `NO_EFFECT` with `signature_history='PRESENT'`;
    - the submission events are `CONFIRMED→AMBIGUOUS` then `AMBIGUOUS→RECONCILED`;
    - the intent transitions are `CONFIRMED→UNKNOWN_REQUIRES_RECONCILIATION→FAILED`;
    - a prior UNKNOWN run (position UNKNOWN) is resolved the same way;
    - a token change keeps today's MISMATCH effects, including `unknown_block = TRUE`;
    - a landed-OK SELL is MATCHED, unchanged;
    - one case runs under `SET ROLE sol_token_executor_live_recovery`.
- [ ] **Step 2:** Implement. Run the reconciliation, recovery and sell-reconciliation tests and the build.
- [ ] **Step 3: Commit.** `feat(live-recovery): a SELL that landed with an error and moved nothing but the fee is a terminal no-effect failure`

### Task 6: Guarded re-exit of a dead SELL (user decision 1)

**Why it is needed.** `exit_intent_id` is set once (`execution-live.repository.ts:5141-5146`) and nothing in `src/` clears or replaces it. If that SELL intent ends `FAILED` or `EXPIRED`, the position stays `EXIT_PENDING`. The deadline scanner (`:1483`) and the exit lane only pick `OPEN` positions, so no lane sells it again.

Note: the position is `EXIT_PENDING` in this situation, not `OPEN`. The re-exit selects `EXIT_PENDING` positions.

**What the live SELL state machine allows** (verified in the code):

| Exit intent status | Can a send be in flight or unresolved? | Re-exit? |
|---|---|---|
| `PENDING`, `PROCESSING`, `SIMULATED` | No send yet, but H2b may still sign while it holds the lease | no: not terminal |
| `RETRY_READY` | The previous send was proven `NO_EFFECT` (`:4843-4862`) or revoked before submission (`:2214-2224`). H2b retries it itself | no: not terminal |
| `SIGNED_NOT_SUBMITTED`, `SUBMITTED`, `CONFIRMED`, `RECONCILING` | Yes | no |
| `UNKNOWN_REQUIRES_RECONCILIATION` (position `UNKNOWN`, `unknown_block`, `:4767-4790`) | Ambiguous | no: left to the existing reconciliation |
| `SUCCEEDED` | Filled: the position is `CLOSED` | no |
| `FAILED` | A SELL only reaches it before signature: `simulations.complete`, `src/executor-live/fresh-execution.ts:116` → `src/storage/execution-simulation.repository.ts:231`. The other `FAILED` writes (`execution-live.repository.ts:1950`, `:2107`) are BUY-only | **yes**, with the guard below |
| `EXPIRED` | Expiration only takes `PENDING`/`RETRY_READY`/`PROCESSING`/`SIMULATED` whose lease has lapsed (`src/storage/execution-intent-expiration.ts:52-56`). Signed bytes are persisted (`SIGNED_NOT_SUBMITTED`) before any submission, so a send is never in flight. A `RETRY_READY` that expires had its last send proven `NO_EFFECT` | **yes**, with the guard below |
| `CANCELLED` | No SELL path writes it | no: manual |

So an "expired but possibly landed" SELL cannot occur. A possibly landed send keeps its intent in `UNKNOWN_REQUIRES_RECONCILIATION` until reconciliation proves `NO_EFFECT` (→ `RETRY_READY`) or MATCHED (→ `CLOSED`). The re-exit simply waits for that, and the guard below re-checks it.

**Guard: all of these must hold, in the repository and again in the 066 trigger.**
1. The position is `EXIT_PENDING` and `remaining_base_raw > 0` (the trigger also requires `NEW.exit_reconciliation_fingerprint IS NULL`; recovery has no SELECT on that column, and the trigger reads it from the row).
2. The current exit intent `status IN ('FAILED','EXPIRED')`, with `terminal_at IS NOT NULL` and `reconciliation_completed_at IS NOT NULL`.
3. No `execution_signed_transactions` row of that intent has a state outside `('RECONCILED','REVOKED_NO_SEND')`.
4. No `execution_reconciliation_evidence` row of that intent is `MATCHED`, and none is `UNKNOWN`/`MISMATCH` with `resolved_by_evidence_id IS NULL`.
5. The position's `execution_exit_authorizations.state = 'ACTIVE'`. A `LOCKED` authorization means signing or sending may be under way, so the re-exit waits.
6. Repository only: `execution_wallet_risk_state.unknown_block = FALSE` for the generation.
7. Repository only: the cap, `reExitLogicalCommandId(current) !== null` (at most `:retry-3`, so at most 4 SELL intents per position). Capped positions are filtered out of the candidate SQL. A separate read-only query (`listCappedDeadExits`) returns them, and the lane logs `executor_live_recovery.reexit_cap_reached` **once per position per process**: the set of logged ids is created once in `createLaneFactory` (`src/executor-live-recovery/main.ts:115-123`) and passed in, since lanes are rebuilt every pass. Nothing is written; the position is left for manual action (runbook, Task 10).
8. Repository only: the spacing, `old.terminal_at <= now − REEXIT_MIN_SPACING_MS` (30 s).

**Mechanism: replace `exit_intent_id` under the same lock order.**
- The new intent keeps the dead intent's `strategy_id` and reason. Its `logical_command_id` is `reExitLogicalCommandId(current)`, so `<root>:retry-<k>`. The intent id is derived from `strategyId`, `strategyVersion`, `positionId`, `side` and `logicalCommandId` (`src/domain/execution-intent.ts:229-241`), so the new key gives a new id, and the logical order key stays unique (also against `execution_intent_tombstones.logical_order_key UNIQUE`, `migrations/031_execution_intents.sql:224-229`).
- Its other fields are copied from the deadline draft: `CANONICAL_EXIT`, `minimumAmountOutRaw = 1`, `baseAmountRaw = remaining_base_raw`, the BUY's `decision_event_id`, `decision_fingerprint` = the entry fingerprint, `requested_at` = the DB clock, TTL 120 s, `live_reserved = TRUE`.
- New repository method `createNextReExitIntent(): Promise<ExecutionReExitResultV1 | null>`. In one transaction:
  1. take the 51007 scan lock and read the clock (`:1473-1479`);
  2. pick the oldest candidate (`ORDER BY opened_at, position_id LIMIT 1`) with conditions 1 and 3-6 in SQL, and either:
     - **(a)** the exit intent already `FAILED`/`EXPIRED` with `terminal_at <= now − REEXIT_MIN_SPACING_MS` (30 000 ms, a domain constant in `fast-exit.ts`; repository only, the trigger does not need it); or
     - **(b)** the exit intent **expirable now**: status `PENDING`/`RETRY_READY`/`PROCESSING`/`SIMULATED`, `expires_at <= now`, lease lapsed. These are the predicates of `src/storage/execution-intent-expiration.ts:50-56`.

     **Cap filter in the same SQL:** `exit_intent.logical_command_id !~ ':retry-3$'`, so one capped position cannot starve the others.
  3. take `lockWorkerTrackingMints`, `lockLiveSellPresenceInTransaction`, `lockGeneration` (51005);
  4. `SELECT … FOR UPDATE OF position`;
  5. **expire that one intent in place.** `expireExecutionIntentsPreSubmissionInTransaction` only runs from retention (every 60-900 s), so run its expiration statement (`execution-intent-expiration.ts:46-104`) with the extra predicate `AND intent.id=$old`. It moves the intent to `EXPIRED`, writes the transition and abandons the attempt. Recovery already has the grants: intents UPDATE (`database-authority.ts:46-121`), attempts UPDATE `status,completed_at,reason_code` (`:172-191`), transitions INSERT. An intent expired here has `terminal_at = now`, so the spacing rule defers its re-exit to a pass ≥ 30 s later: the transaction **commits the expiry and returns `null`** (expiry happening when nothing else does is the purpose of this step);
  6. re-check the full guard on the locked row, including the spacing;
  7. insert the new intent (the deadline INSERT, `:5125-5139`), read back with `findDeadlineIntent` using `requestedAtLowerBound='OPENED'`;
  8. `UPDATE execution_live_positions SET exit_intent_id=$new, state_revision=$rev+1 WHERE position_id=$1 AND state='EXIT_PENDING' AND exit_intent_id=$old AND state_revision=$rev`, which must return rowCount 1.
- **Scope:** every position, CANARY or envelope. It is the same code path and the same guard, and a CANARY position stuck behind a dead SELL needs it as much.
- **Lane:** a new H2a lane `reexit` (log name `REEXIT`, error `REEXIT_FAILED`). `ORDERED_LANES` becomes `reconciliation, confirmation, deadline, reexit, exit` (`runtime.ts:49-53`). A pass stops at the first lane that throws, so this order keeps the deadline first and the stuck-position repair ahead of the optional early exits.

**Migration 066** (`migrations/066_live_position_reexit.sql`). Register it as 065 was in commit `ffa6198e` (`git show ffa6198e --stat`):
- `src/execution-migrations/live-catalog.ts:73`;
- `scripts/deployment-smoke.mjs:120`;
- `src/executor-live/startup-validator.ts:34,601` and `src/executor-live-recovery/startup-validator.ts:39,265` (`migrationHead`);
- the tests that pin the migration head or list (`grep -rl 065_entry_envelope_auto_arm tests`). Edit only those that pin the head or list.

All statements must be replayable. `CREATE OR REPLACE FUNCTION guard_execution_live_position_update()` copies `036:1090-1118` **verbatim** and changes only the transition check:

```sql
  IF OLD.state='EXIT_PENDING' AND NEW.state='EXIT_PENDING' THEN
    -- Lot 4b re-exit: replace a dead exit intent, nothing else.
    IF OLD.exit_intent_id IS NULL OR NEW.exit_intent_id IS NULL
      OR NOT (OLD.remaining_base_raw > 0)
      OR NEW.exit_intent_id IS NOT DISTINCT FROM OLD.exit_intent_id
      OR NEW.remaining_base_raw IS DISTINCT FROM OLD.remaining_base_raw
      OR NEW.exit_reconciliation_fingerprint IS NOT NULL
      OR NEW.closed_at IS NOT NULL OR NEW.purge_after IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM execution_intents old_exit
        WHERE old_exit.id=OLD.exit_intent_id AND old_exit.status IN ('FAILED','EXPIRED')
          AND old_exit.side='SELL' AND old_exit.position_id=OLD.position_id
          AND old_exit.terminal_at IS NOT NULL AND old_exit.reconciliation_completed_at IS NOT NULL)
      OR NOT EXISTS (SELECT 1 FROM execution_intents new_exit
        WHERE new_exit.id=NEW.exit_intent_id AND new_exit.side='SELL'
          AND new_exit.position_id=NEW.position_id AND new_exit.status='PENDING'
          AND new_exit.live_reserved=TRUE
          AND new_exit.base_amount_raw=NEW.remaining_base_raw
          AND new_exit.minimum_amount_out_raw=1)
      OR EXISTS (SELECT 1 FROM execution_signed_transactions artifact
        WHERE artifact.intent_id=OLD.exit_intent_id
          AND artifact.state NOT IN ('RECONCILED','REVOKED_NO_SEND'))
      OR EXISTS (SELECT 1 FROM execution_reconciliation_evidence evidence
        WHERE evidence.intent_id=OLD.exit_intent_id
          AND (evidence.result='MATCHED' OR (evidence.result IN ('UNKNOWN','MISMATCH')
            AND evidence.resolved_by_evidence_id IS NULL)))
      OR NOT EXISTS (SELECT 1 FROM execution_exit_authorizations exit_auth
        WHERE exit_auth.position_id=NEW.position_id AND exit_auth.state='ACTIVE')
    THEN
      RAISE EXCEPTION 'execution live position re-exit is not permitted' USING ERRCODE='55000';
    END IF;
  ELSIF NOT execution_live_state_transition_allowed('LIVE_POSITION',OLD.state,NEW.state) THEN
    RAISE EXCEPTION 'illegal execution live position state transition' USING ERRCODE='55000';
  END IF;
```

Each condition is written as `IS NULL` / `IS DISTINCT FROM` / `EXISTS`, never as a bare comparison that a NULL would let through (the 4a lesson). The trigger binding (`036:1120-1123`) is re-created identically. `execution_live_state_transition_allowed` is not changed, because other entities use it.

**Grants.** The function is SECURITY INVOKER, so the updating role needs column SELECT on everything it reads. For recovery, which is the only role that takes the new branch, all of these are already granted:
- `execution_intents`: `id`, `status`, `side`, `position_id`, `live_reserved`, `terminal_at`, `reconciliation_completed_at`, `base_amount_raw`, `minimum_amount_out_raw`. Verify each in `database-authority.ts:46-121` and add any that is missing, both there and in the provisioning;
- `execution_signed_transactions`: `intent_id`, `state` (`:122-171`);
- `execution_reconciliation_evidence`: all columns (`:351-424`);
- `execution_exit_authorizations`: `position_id`, `state` (`:276-300`);
- `execution_wallet_risk_state.unknown_block` (`:301-318`), read by the repository.

The live role's position updates never take the branch, but the function body is shared: run the existing live-role tests unchanged. No new UPDATE grant: recovery already updates `exit_intent_id` and `state_revision` (`database-authority.ts:245-256`).

- [ ] **Step 1: Write failing tests** (PG, `tests/execution-live-reexit.test.ts`; the fixtures of Task 2 plus `createSellFixture`).
  1. **Failed SELL → re-exit** (with `terminal_at` at least 30 s in the past; a younger one returns `null`). The exit intent is set `FAILED` by the real `simulations.complete` path (or its SQL equivalent with the triggers on), with no artifact. `createNextReExitIntent` creates `…:retry-1`; the position stays `EXIT_PENDING` with the new `exit_intent_id`; strategy and reason are kept.
  2. **Expired SELL with no fill → re-exit.** Two cases:
     - expired before any attempt;
     - after a proven `NO_EFFECT` the intent is `RETRY_READY`, which is not terminal: `createNextReExitIntent` returns `null`. Once its `expires_at` passes, the in-place expiry (step 5) expires it **with no retention worker running**. The next call ≥ 30 s later creates `:retry-1`; a call earlier than that returns `null` (spacing);
     - a landed-with-error SELL classified by Task 5 (`FAILED`, artifact `RECONCILED`) gives a re-exit ≥ 30 s after its `terminal_at`.
  3. **In flight or unknown → no re-exit.** Each of these returns `null` and writes nothing:
     - the intent in `PENDING`, `PROCESSING` (with a live lease), `RETRY_READY`, `SIGNED_NOT_SUBMITTED`, `SUBMITTED`, `CONFIRMED` or `UNKNOWN_REQUIRES_RECONCILIATION`;
     - the position `UNKNOWN`;
     - an artifact `AMBIGUOUS`, `ACCEPTED` or `SUBMISSION_STARTED`;
     - an unresolved `UNKNOWN` evidence;
     - a `LOCKED` exit authorization;
     - `unknown_block = TRUE`.
     The same states forced through a direct `UPDATE` of `exit_intent_id` are rejected `55000` by the 066 trigger.
  4. **Cap reached → no re-exit.** After `:retry-3` fails, the call returns `null` and writes nothing. `reexit_cap_reached` is logged once for that position across several passes. A second, uncapped dead-exit position is still re-exited: no starvation.
  5. **Exactly one SELL fills.**
     - Two concurrent `createNextReExitIntent` create one intent.
     - A re-exit racing the reconciliation that turns the old intent's `UNKNOWN` into `NO_EFFECT` creates at most one new intent, and only after that commit.
     - End to end (in Task 7): one MATCHED SELL and one ledger row.
  6. **Lapsed-lease fencing.** A `PROCESSING` SELL whose lease lapsed is expired. A later `persistSigned` with the old claim is rejected (lease lost), so no signed artifact can appear for a dead intent.
  7. **Role test.** Under `SET ROLE sol_token_executor_live_recovery`, with the roles provisioned, `createNextReExitIntent` succeeds for case 1. A direct invalid update is rejected `55000`, not `42501`.
  8. **066 migration test** (`tests/live-position-reexit-migration.test.ts`, modelled on `tests/entry-envelope-migration.test.ts`):
     - the function body equals 036's apart from the branch (contract fragments);
     - `OPEN→EXIT_PENDING`, `EXIT_PENDING→CLOSED` and `UNKNOWN→EXIT_PENDING` still pass;
     - `EXIT_PENDING→OPEN` is still rejected;
     - the migration replays.
  9. **Lanes and runtime.** The order is `…, deadline, reexit, exit`; `REEXIT_FAILED` is logged, and the next pass still runs the deadline first.
  10. **Facades.**
      - Add `createNextReExitIntent`, `listCappedDeadExits` and `createNextEarlyExitIntent` to:
        - the recovery facade key lists, `tests/executor-live-recovery-database.test.ts:182-205`;
        - the contract method list, `tests/execution-live-repository-contract.test.ts:70-81`.
      - Add all three to the H2b "absent" list in `tests/executor-live-database.test.ts:207-211`, so the H2b facade cannot reach them.
- [ ] **Step 2:** Implement: the migration and its registration, `createNextReExitIntent` (port and facade), `reExitLogicalCommandId` (Task 1 file), and the lane, logger and runtime changes. Run the new tests, `tests/execution-live.repository.test.ts`, `tests/execution-live-sell-reconciliation.test.ts`, the recovery test files and the build.
- [ ] **Step 3: Commit.** `feat(live-recovery): guarded re-exit of a dead SELL intent, at most 3 per position (066)`

### Task 7: The H2b SELL path accepts an early exit (safety checklist)

**Files:** `tests/fast-exit-safety.test.ts` (new, PG). Reuse the SELL fixtures of `tests/execution-live-sell-reconciliation.test.ts` (`createSellFixture` `:788`), with the SELL intent produced by `createNextEarlyExitIntent` instead of the deadline.

Each case is a test that must hold:
1. An early-exit SELL intent is claimed by H2b's `LIVE_EXECUTE_SELL_SQL` (`src/storage/execution-intent.repository.ts:219-220`, which has no strategy filter). It passes the SELL preparation binding (`execution-live.repository.ts:2770-2805`: `position.exit_intent_id = intent.id`, `EXIT_PENDING`), is reconciled MATCHED, writes the ledger row, and adds the envelope realized loss (4a `ENVELOPE_REALIZED_LOSS_SQL`, `:4549`) exactly as a deadline SELL does.
2. No path creates a second SELL for a position: early then deadline, deadline then early, and two scanners.
3. A CANARY position gets no early exit whatever its trades are. The deadline still applies.
4. A REVOKED envelope exits an OPEN envelope position on the next pass (it closes 4a limit 4: «revoke n'est pas une sortie immédiate»).
5. Nothing in Task 2 writes `execution_entry_envelopes` or `execution_activation_armaments`. Assert the row counts and `updated_at` before and after an early exit.
6. The deadline still sells when every fact is unreadable: malformed launch payload, malformed trades, creator ambiguous.
7. Re-exit end to end: a first SELL fails before signature, the re-exit SELL (`:retry-1`) goes through H2b preparation (the binding at `execution-live.repository.ts:2770-2805` follows the new `exit_intent_id`), is reconciled MATCHED and closes the position. Exactly one ledger row and one MATCHED SELL evidence exist for the position.

- [ ] **Step 1:** Write the tests. They should pass with Tasks 1-6; if one fails, fix the defect, not the test.
- [ ] **Step 2: Commit.** `test(safety): early exit fail-closed checklist`

### Task 8: creates-only records the post-migration venue (proof, no feed)

**Files:**
- `tests/creates-only-migration-venue.test.ts` (new).
- Fixture: `tests/fixtures/pumpswap/migrate-v2-create-pool-mainnet.json`, loaded with `loadMainnetFixture` as in `tests/pumpswap-mainnet-fixtures.test.ts:10-35`.

- [ ] **Step 1: Write the tests.**
  1. **Decoder level.** In the fixture, the decoded migration's `bondingCurve` equals `bondingCurvePda(mint)` (`src/launchpads/pumpfun/official-sdk.ts`) and is one of the transaction's account keys. `getSignaturesForAddress(bondingCurve)` therefore returns the migrate transaction, which the curve poller enqueues as `PUMPFUN_CURVE_TRADE` with `ingestionHintMint = mint`. `assertValidTransactionNotification` accepts it (pattern of `tests/tracked-curve-trade-ingestion.test.ts:16-36`).
  2. **Pipeline level.** Use `ObservedTransactionPipeline` with the real `PumpFunLaunchpadAdapter` decode and a `PumpSwapObservationPipeline` whose pool validator and reserve reader are stubbed (pattern of `tests/pumpswap-observation-pipeline.test.ts:24-63`). Processing the fixture transaction returns `marketMigrationCount = 1` and `marketActivationCount = 1`.
  3. **PG level.** Record that batch with `PostgresMarketObservationRepository`. Then:
     - `PostgresExecutionVenueRepository.findFinalizedCanonicalPumpSwapPool({ mint, quoteMint: WSOL })` returns the pool;
     - `selectTrackedCurves` no longer returns that mint (`src/storage/tracked-curve.repository.ts:56-80`).
- [ ] **Step 2:** If any test fails, stop and report the gap with its evidence. Do not add a feed in this lot.
- [ ] **Step 3: Commit.** `test(listener): creates-only records migrations and market_pools for a migrating tracked mint`

### Task 9: `fast-path:report` CLI

**Files:** create `src/cli/fast-path-report.ts`, `tests/fast-path-report.test.ts`; `package.json` `"fast-path:report": "node dist/src/cli/fast-path-report.js"`.

Model it on `src/cli/paper-dry-run.ts`: injected `Queryable`, pure formatting, a `main` that is only run when the file is the entrypoint. Use `pg.Pool({ connectionString: DATABASE_URL, max: 1 })`, without `loadConfig`. Every read runs in one `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction, followed by `ROLLBACK`.

Options: `--since=<ISO-8601>` (default now − 24 h), `--until=<ISO-8601>` (default now; window ≤ 7 days), `--format=table|json` (default table). Unknown options are rejected.

Output `schemaVersion: 'fast-path-report.v1'`:
- **`funnel`:**
  - `createsObserved`: `domain_events` with `type='TokenLaunchDetected'`, `created_at` in the window (uses `domain_events_resume_idx (created_at, event_id)`, `migrations/002_pumpfun_foundation.sql:95-96`), not orphaned.
  - `decisions`, `rejectedByReason{…}`, `buyIntents` (`entry_decisions` in the window by `observed_at`; `decision='BUY' AND intent_id IS NOT NULL`).
  - `armed`: `execution_activation_armaments.target_intent_id` in those intents.
  - `submitted`: BUY `execution_signed_transactions` with `submitted_at IS NOT NULL`.
  - `confirmed`: `confirmed_at IS NOT NULL`.
- **`latenciesMs`:** for each of `blockToObserved` (`create_block_time→observed_at`), `observedToDecided`, `decidedToArmed` (`armed_at`), `armedToSubmitted` (`submitted_at`) and `submittedToConfirmed` (`confirmed_at`), give `{ count, p50, p90, max }`.
- **`positions`:** positions opened in the window. Closed ones come from `execution_live_position_ledger` (never purged), open ones from `execution_live_positions`. Each gives `{ mint, state, openedAtMs, closedAtMs, holdingMs, exitReason, netLamports, pnlBps }`.
  - `pnlBps = net_lamports × 10 000 / −entry_wallet_lamport_delta`.
  - `failedSellFeesLamports`: the sum of `fee_lamports` of the position's SELL evidence with `result='NO_EFFECT' AND signature_history='PRESENT'` (Task 5). The ledger does not include these fees.
  - `exitReason = exitReasonOfLogicalKey(...)`, read from the SELL intent's `logical_command_id` (`execution_intents` with `side='SELL' AND position_id = <position>`, latest `requested_at`), otherwise from `execution_intent_tombstones` with `(logical_order_key LIKE 'maximum-holding:%' OR logical_order_key LIKE 'fast-exit:%') AND logical_order_key LIKE '%:' || position_id || '%'` (latest `retired_at`), otherwise `UNKNOWN`. Also report `reExits` = the `:retry-k` suffix of that key (0 when absent).
- **`rpc429`:**
  - `listener`: per provider, `{ providerId, attempts, http429Responses, sinceMs: started_at }` from the latest `listener_heartbeats` row's `payload.rpcHttpEvidence`;
  - `executor`: the count of `execution_provider_rate_limit_events` in the window, with the note `retention 4 h`.
- **`retentionNote`:** «armaments and signed artifacts are purged 4 h after terminal; run within 4 h of the run».

The output never contains a signature, a wallet public key, a URL or a key.

- [ ] **Step 1: Write failing tests.**
  - Pure:
    - option parsing (defaults, bounds, unknown option, until < since);
    - percentile helper;
    - `pnlBps` sign and rounding;
    - table output of a fixed snapshot.
  - PG, with seeded entry decisions, armament, signed transaction, ledger row, live position and tombstone:
    - funnel counts and latencies;
    - exit reasons: `TAKE_PROFIT` from a live intent, `DEADLINE` from a tombstone, `UNKNOWN` when neither exists;
    - 429 counts.
  - The seeded signatures, the wallet public key and the database URL do not occur anywhere in the JSON or the table output.
  - The transaction is read-only: a test-only `INSERT` attempted through the same queryable fails with `25006`.
- [ ] **Step 2:** Implement. Run the tests and the build.
- [ ] **Step 3: Commit.** `feat(cli): read-only fast-path report (funnel, latencies, exits, PnL, 429)`

### Task 10: Docs, checkpoint, full suite, PR

- [ ] **`.env.example`:**
  - add `EXIT_TAKE_PROFIT_BPS=20000`, `EXIT_EXTERNAL_BUYERS_TARGET=10` and `EXIT_EXTERNAL_MIN_BUY_RAW=1000000` in the H2a block, with a comment: envelope positions only; the deadline always applies; there is no RPC;
  - in the `LISTENER_INGESTION_SCOPE` comment, note that the curve poller also records migrations and `market_pools` of tracked mints;
  - note that `LISTENER_TRACKED_POOL_POLL_ENABLED` is optional for the exit lane.
- [ ] **`docs/operations/executor-live-canary.md`:** add a section «Lane de sortie et rapport (lot 4b)» after the 4a section (`:956-1033`). It covers:
  - the order of the exit conditions;
  - the exit reasons in `logical_command_id`;
  - `npm run fast-path:report -- --since=…`, to be run within 4 h of a run;
  - the re-exit (Task 6): when it fires, its cap, and the log `executor_live_recovery.reexit_cap_reached`;
  - **manual procedure when the cap is reached or a position stays `UNKNOWN`/`EXIT_PENDING`:**
    1. `live:kill-switch --mode=entry-stop` (auto-arm is already blocked by K=1);
    2. read the position, its SELL intents and artifacts with `live:status` and SQL (`execution_live_positions`, `execution_intents WHERE position_id=…`, `execution_signed_transactions WHERE intent_id IN (…)`);
    3. check the wallet's token balance on chain. If the tokens are still there, sell them by hand from the wallet, outside the bot;
    4. record the incident, and do not resume the envelope until the position is understood. The bot has no path that closes a position without a reconciled SELL.

  In the 4a «Limites connues» list:
  - mark item 4 (revoke is not an immediate exit) as resolved by 4b;
  - add the stranded-exit and pre-pool window points below.
- [ ] **Checkpoint** `docs/superpowers/plans/2026-10-06-simple-path-CHECKPOINT.md`:
  - lot 4b done (PR), with its deviations;
  - correct the «`creates-only` n'alimente pas `market_pools`» open point (Task 8);
  - lot 5 prerequisites: the open questions below.
- [ ] **Full suite green.**
- [ ] **Commit, push, open the PR** (attribution per the session reminder). Wait for CI, merge, update local `main`.

---

## Points where safety is not certain (with recommendation)

1. **Stranded exit (pre-existing; reduced by Task 6).**
   - **Risk:** `exit_intent_id` is set once and never cleared. If the SELL intent then goes `FAILED` or `EXPIRED` (TTL 120 s, `src/storage/execution-intent-expiration.ts:50-54`), the position stays `EXIT_PENDING` and no lane sells it.
   - **Bound:** with K=1 the stuck LOCKED armament also blocks every new buy, so this fails closed for spending, but the tokens stay unsold.
   - **Now:** Task 6 re-issues the SELL for a dead intent with no possible send, at most 3 times. After the cap, and for anything ambiguous, the runbook procedure is manual.
2. **The window between curve completion and the pool row.**
   - **Risk:** once the curve is `complete`, the router requires the canonical pool (`venue-router.ts:62-75`). Until the migrate transaction has been ingested (finalized, curve poller), every SELL fails `VENUE_UNAVAILABLE`, which can strand the position (point 1). This applies to the deadline too.
   - **Bound:** take-profit 2× normally fires long before completion.
   - **Recommendation:** keep `maximum_holding_ms ≤ 300 000`, and watch for `VENUE_UNAVAILABLE` in lot 5.
3. **The take-profit estimate is approximate.**
   - **Risk:** it uses the last trade's average price, ignores our sale's price impact and fees, and lags ingestion. It can overestimate by a few percent, and a stalled poller can make it stale.
   - **Bound:** a wrong take-profit only exits early, at H2b's fresh quote minus `EXECUTOR_SLIPPAGE_BPS`. It never delays the deadline.
4. **Ingestion lag and stalls** delay conditions 2-4. The deadline bounds the holding time in every case.
5. **Wider read surface for H2a.** The recovery role gains SELECT on 9 columns of `domain_events`: public chain data, with no write access. A compromised H2a could read observed events. It cannot change them.
6. **Payload format dependency.** The SQL reads the bigint marker `$solTokenListenerBigInt`. If the writer format changes, the trades list becomes null, and only REVOKED and the deadline still exit. Task 2 seeds rows with `toJsonValue` so the tests break with the writer.
7. **The `TradeEvent` 24-byte suffix (#232)** feeds `quoteAmountRaw` / `baseAmountRaw`. If those octets change the meaning of the amounts, take-profit and the buyer threshold are wrong. The impact is bounded as in point 3.
8. **The report uses `DATABASE_URL`**, usually the owner login, in a `READ ONLY` transaction. It is not a dedicated role. Run it only from the operator's machine.
9. **Re-exit and double sell.**
   - **Guard:** the re-exit accepts only `FAILED`/`EXPIRED` intents whose artifacts are all `RECONCILED` (proven no effect) or `REVOKED_NO_SEND`, with no unresolved evidence, an `ACTIVE` exit authorization and no `unknown_block`. An ambiguous send stays `UNKNOWN_REQUIRES_RECONCILIATION`, which is neither terminal nor expirable (`src/storage/execution-intent-expiration.ts:52`), so no re-exit can start.
   - **Facts:** a SELL never takes a pre-signature lock (`src/executor-live/fresh-execution.ts:84-100`: only the BUY calls `authorizeExactSigning`; the SELL calls `readPreparationBinding`). Its exit authorization only becomes `LOCKED` in `persistSellSigned` (`execution-live.repository.ts:2858`, the UPDATE at `:2920-2925`), in the same transaction that persists the signed bytes and moves the intent to `SIGNED_NOT_SUBMITTED`. A SELL that dies before that has no signed artifact and an `ACTIVE` authorization; after it, the intent can no longer be expired.
   - **Remaining assumptions:**
     - signed SELL bytes produced before persistence, and the bytes passed to the signed `simulateTransaction`, are never broadcast. Only `submission-gateway.ts` calls `sendRawTransaction` (`tests/executor-architecture.test.ts:837-840`), and it reads persisted artifacts;
     - a signer that lost its lease cannot persist late (Task 6 test 6).
10. **The relaxed position trigger (066)** is SECURITY INVOKER and reads intents, artifacts, evidence and the exit authorization. PL/pgSQL only runs those reads inside the new `EXIT_PENDING → EXIT_PENDING` branch, and only recovery takes it; Task 6 tests it under `SET ROLE`, and the existing live-role tests must pass unchanged.
11. **Landed-failed SELL classification (Task 5).**
    - **Risk:** a transaction with `meta.err` whose token and lamport deltas are wrong would be classified NO_EFFECT, and then re-sold.
    - **Bound:** the rule requires all of `meta.err`, base delta 0 summed over every wallet token account of the mint in the transaction's balance maps, a quote delta of 0, a wallet lamport delta of exactly −fee, and a fee within the maximum. A failed Solana transaction reverts every account except the fee payer's fee, so a real change cannot coexist with `meta.err`.
    - **Residual:** a token account of the mint that is absent from the RPC's `pre/postTokenBalances` is invisible. That is the same visibility the MATCHED rule already relies on.
    - **Fees:** each failed SELL costs a fee that is in no PnL. It is bounded by the cap (at most 4 intents) and shown by the report.

## Open questions for the user

None. The three questions of the first version were answered by the user (see «User decisions» at the top).

### Critical Files for Implementation
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile/migrations/036_execution_live_canary.sql (position update guard 1090-1123, transition table 865-903; replaced in new 066)
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile/src/storage/execution-live.repository.ts (NO_EFFECT 4808-4880, deadline scanner 1471-1510, deadline body 5058-5154, findDeadlineIntent 5156-5239)
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile/src/executor-live-recovery/lanes.ts and runtime.ts (ORDERED_LANES 49-53)
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile/src/executor-live-recovery/database-authority.ts with scripts/provision-executor-roles.sql (recovery section 1134-1299)
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile/src/application/creation-entry-v1.strategy.ts (rules mirrored, 620-715)
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile/src/executor-simulation/venue-router.ts and attempt-evaluator.ts (SELL venue and protected amount)

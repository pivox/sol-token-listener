# Simple path, lot 4b: exit lane and fast-path report

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
1. Recovery (H2a) sells an OPEN **envelope** position before its deadline when the first of these is true:
   1. its entry envelope is `REVOKED`;
   2. the creator sold after our entry;
   3. take-profit: the value of the remaining tokens at the latest observed curve price reaches `EXIT_TAKE_PROFIT_BPS` of the quote cost;
   4. at least `EXIT_EXTERNAL_BUYERS_TARGET` distinct external buyers bought at least `EXIT_EXTERNAL_MIN_BUY_RAW` after our entry.
2. The deadline exit (`maximum-holding-exit`) is unchanged. It always runs first in a pass and stays the only exit of CANARY positions.
3. A read-only `fast-path:report` CLI shows the funnel, the latencies, the result per position and the 429 counts (spec «Mesure»).
4. It is proven, by tests, that `creates-only` already records `migrations` + `market_pools` for a tracked mint that migrates, so the live SELL can route to PumpSwap after a migration.

Nothing is signed or sent by the code added here. Signing stays in H2b.

**Architecture:**
- **One new H2a lane, `exit`, after `deadline`** in `ORDERED_LANES` (`src/executor-live-recovery/runtime.ts:49-53`). The `deadline` lane (`src/executor-live-recovery/lanes.ts:190-203`) and `createNextDeadlineExitIntent` (`src/storage/execution-live.repository.ts:1471-1510`) keep their behaviour.
- **Pure decision** in a new `src/domain/fast-exit.ts` (`decideFastExit`). The repository reads the facts with SQL and passes them in. A fact that cannot be read or decoded makes its conditions undecidable: they are skipped, never an error that reaches the deadline.
- **SELL intent creation** reuses the deadline transaction body. `createDeadlineExitIntentLocked` (`execution-live.repository.ts:5058-5154`) and `findDeadlineIntent` (`:5156-5239`) are parameterised by an exit spec: strategy id, logical command id, whether the deadline must be due, and the lower bound of `requested_at`. The deadline spec reproduces today's values exactly.
- **Same lock order as the deadline scanner** (`:1471-1510`): `pg_advisory_xact_lock(hashtextextended('execution-live-deadline-scan:v1', 51007))`, then `lockWorkerTrackingMints`, then `lockLiveSellPresenceInTransaction`, then `lockGeneration` (51005), then `FOR UPDATE OF position`. No envelope or armament row is written.
- **One SELL per position** stays structural: the position must be `OPEN` with `exit_intent_id IS NULL` (`:5141-5146`), and `exit_intent_id` is never cleared anywhere in `src/` or `migrations/`.
- **No RPC in H2a for exits.** Take-profit uses the latest observed curve trade in `domain_events`. H2b re-quotes at SELL time and protects the amount with its own slippage (`src/executor-simulation/attempt-evaluator.ts:407-413`: `protected = max(intent.minimumAmountOutRaw, computed.minimumAmountOutRaw)`).

**Tech Stack:** TypeScript (tsx, node:test), PostgreSQL 16 (pg).

Spec: `docs/superpowers/specs/2026-10-06-simple-path-design.md` («Lane `exit` (recovery)» 189-211, «Pollers des mints suivis» 80-100, «Configuration» 262-274, «Erreurs» 276-287, «Mesure» 289-299, «Risques connus» 329-340).

**Deviations from the spec (decided while planning):**
1. **No `LiveExitDecided` event.**
   - No migration 066, no `api_event_stream` CHECK change, no frontend or zod change, and no `domain_events` INSERT grant for H2a.
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
   - Task 6 proves this with tests. The checkpoint line «creates-only n'alimente pas market_pools» is corrected once the tests pass. If they fail, stop and report: do not build a feed without a new decision.
   - `LISTENER_TRACKED_POOL_POLL_ENABLED` stays optional. It only adds post-migration pool trades, which this lot does not read.
8. **The report is a separate CLI, `fast-path:report`, and it runs on `DATABASE_URL` in a `READ ONLY` transaction.**
   - It does not extend `live:report`, which is an alias of `status` (`src/executor-operations/main.ts:89-92`), and it does not use the operations role: that role would need SELECT on `entry_decisions`, `domain_events`, the ledger and the heartbeats.
   - **429 counts:**
     - listener: the cumulative counters in the latest `listener_heartbeats.payload.rpcHttpEvidence` (written at `src/storage/transaction-inbox.repository.ts:2872`), counted since that process started. No per-request history is persisted;
     - executor: `execution_provider_rate_limit_events` in the window, which has 4 h retention.
   - **Retention:** latencies after «decided» come from armaments and signed artifacts, which are purged 4 h after they become terminal. Run the report within 4 h of a run. PnL and exit reasons are durable.
9. **No feature flag.** `EXIT_*` are optional H2a variables with the spec defaults. Early exits only touch envelope positions, which only exist with `live:auto-arm` (lot 4a).

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
| `src/cli/fast-path-report.ts` (new), `package.json` | report |
| `.env.example`, `docs/operations/executor-live-canary.md`, checkpoint | docs |
| Tests | listed per task |

No migration. No frontend change. No new event type.

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
// 'maximum-holding:<pos>' -> DEADLINE; 'fast-exit:<R>:<pos>' -> R; else null
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
  - `tests/executor-live-recovery-database.test.ts:153` (exact facade keys);
  - `tests/execution-live-repository-contract.test.ts:182-205` (facade key lists).

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

### Task 5: The H2b SELL path accepts an early exit (safety checklist)

**Files:** `tests/fast-exit-safety.test.ts` (new, PG). Reuse the SELL fixtures of `tests/execution-live-sell-reconciliation.test.ts` (`createSellFixture` `:788`), with the SELL intent produced by `createNextEarlyExitIntent` instead of the deadline.

Each case is a test that must hold:
1. An early-exit SELL intent is claimed by H2b's `LIVE_EXECUTE_SELL_SQL` (`src/storage/execution-intent.repository.ts:219-220`, which has no strategy filter). It passes the SELL preparation binding (`execution-live.repository.ts:2770-2805`: `position.exit_intent_id = intent.id`, `EXIT_PENDING`), is reconciled MATCHED, writes the ledger row, and adds the envelope realized loss (4a `ENVELOPE_REALIZED_LOSS_SQL`, `:4549`) exactly as a deadline SELL does.
2. No path creates a second SELL for a position: early then deadline, deadline then early, and two scanners.
3. A CANARY position gets no early exit whatever its trades are. The deadline still applies.
4. A REVOKED envelope exits an OPEN envelope position on the next pass (it closes 4a limit 4: «revoke n'est pas une sortie immédiate»).
5. Nothing in Task 2 writes `execution_entry_envelopes` or `execution_activation_armaments`. Assert the row counts and `updated_at` before and after an early exit.
6. The deadline still sells when every fact is unreadable: malformed launch payload, malformed trades, creator ambiguous.

- [ ] **Step 1:** Write the tests. They should pass with Tasks 1-4; if one fails, fix the defect, not the test.
- [ ] **Step 2: Commit.** `test(safety): early exit fail-closed checklist`

### Task 6: creates-only records the post-migration venue (proof, no feed)

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

### Task 7: `fast-path:report` CLI

**Files:** create `src/cli/fast-path-report.ts`, `tests/fast-path-report.test.ts`; `package.json` `"fast-path:report": "node dist/src/cli/fast-path-report.js"`.

Model it on `src/cli/paper-dry-run.ts`: injected `Queryable`, pure formatting, a `main` that is only run when the file is the entrypoint. Use `pg.Pool({ connectionString: DATABASE_URL, max: 1 })`, without `loadConfig`. Every read runs in one `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction, followed by `ROLLBACK`.

Options: `--since=<ISO-8601>` (default now − 24 h), `--until=<ISO-8601>` (default now; window ≤ 7 days), `--format=table|json` (default table). Unknown options are rejected.

Output `schemaVersion: 'fast-path-report.v1'`:
- **`funnel`:**
  - `createsObserved`: `domain_events` with `type='TokenLaunchDetected'`, `observed_at` in the window, not orphaned.
  - `decisions`, `rejectedByReason{…}`, `buyIntents` (`entry_decisions` in the window by `observed_at`; `decision='BUY' AND intent_id IS NOT NULL`).
  - `armed`: `execution_activation_armaments.target_intent_id` in those intents.
  - `submitted`: BUY `execution_signed_transactions` with `submitted_at IS NOT NULL`.
  - `confirmed`: `confirmed_at IS NOT NULL`.
- **`latenciesMs`:** for each of `blockToObserved` (`create_block_time→observed_at`), `observedToDecided`, `decidedToArmed` (`armed_at`), `armedToSubmitted` (`submitted_at`) and `submittedToConfirmed` (`confirmed_at`), give `{ count, p50, p90, max }`.
- **`positions`:** positions opened in the window. Closed ones come from `execution_live_position_ledger` (never purged), open ones from `execution_live_positions`. Each gives `{ mint, state, openedAtMs, closedAtMs, holdingMs, exitReason, netLamports, pnlBps }`.
  - `pnlBps = net_lamports × 10 000 / −entry_wallet_lamport_delta`.
  - `exitReason = exitReasonOfLogicalKey(...)`, read from the SELL intent's `logical_command_id` (`execution_intents` with `logical_command_id LIKE '%:' || position_id`), otherwise from `execution_intent_tombstones.logical_order_key` with the same suffix, otherwise `UNKNOWN`.
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

### Task 8: Docs, checkpoint, full suite, PR

- [ ] **`.env.example`:**
  - add `EXIT_TAKE_PROFIT_BPS=20000`, `EXIT_EXTERNAL_BUYERS_TARGET=10` and `EXIT_EXTERNAL_MIN_BUY_RAW=1000000` in the H2a block, with a comment: envelope positions only; the deadline always applies; there is no RPC;
  - in the `LISTENER_INGESTION_SCOPE` comment, note that the curve poller also records migrations and `market_pools` of tracked mints;
  - note that `LISTENER_TRACKED_POOL_POLL_ENABLED` is optional for the exit lane.
- [ ] **`docs/operations/executor-live-canary.md`:** add a section «Lane de sortie et rapport (lot 4b)» after the 4a section (`:956-1033`). It covers:
  - the order of the exit conditions;
  - the exit reasons in `logical_command_id`;
  - `npm run fast-path:report -- --since=…`, to be run within 4 h of a run.

  In the 4a «Limites connues» list:
  - mark item 4 (revoke is not an immediate exit) as resolved by 4b;
  - add the stranded-exit and pre-pool window points below.
- [ ] **Checkpoint** `docs/superpowers/plans/2026-10-06-simple-path-CHECKPOINT.md`:
  - lot 4b done (PR), with its deviations;
  - correct the «`creates-only` n'alimente pas `market_pools`» open point (Task 6);
  - lot 5 prerequisites: the open questions below.
- [ ] **Full suite green.**
- [ ] **Commit, push, open the PR** (attribution per the session reminder). Wait for CI, merge, update local `main`.

---

## Points where safety is not certain (with recommendation)

1. **Stranded exit (pre-existing; it also affects the deadline).**
   - **Risk:** `exit_intent_id` is set once and never cleared. If the SELL intent then goes `FAILED` or `EXPIRED` (TTL 120 s, `src/storage/execution-intent-expiration.ts:50-54`), the position stays `EXIT_PENDING` and no lane sells it.
   - **Bound:** with K=1 the stuck LOCKED armament also blocks every new buy, so this fails closed for spending, but the tokens stay unsold.
   - **Recommendation:** this lot does not make it worse (`minimumAmountOutRaw = 1`, deviation 4). Decide before lot 5 whether to add a guarded re-exit (open question 1). Until then the runbook procedure is manual.
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

## Open questions for the user

1. **Re-exit after a failed or expired SELL** (point 1, pre-existing): do it in this lot, in a separate lot before lot 5, or accept a manual procedure for lot 5?
2. **Take-profit semantics:** is a trigger based on the last observed trade, followed by a market SELL protected by H2b slippage, acceptable? The spec's alternative is an RPC quote with a protective minimum, which can strand the position.
3. **After migration** only the deadline (and REVOKED) can exit. Is that acceptable for lot 5, given a holding of ≤ 5 min?

### Critical Files for Implementation
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile/src/storage/execution-live.repository.ts (deadline scanner 1471-1510, deadline body 5058-5154, findDeadlineIntent 5156-5239)
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile/src/executor-live-recovery/lanes.ts and runtime.ts (ORDERED_LANES 49-53)
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile/src/executor-live-recovery/database-authority.ts with scripts/provision-executor-roles.sql (recovery section 1134-1299)
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile/src/application/creation-entry-v1.strategy.ts (rules mirrored, 620-715)
- /Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile/src/executor-simulation/venue-router.ts and attempt-evaluator.ts (SELL venue and protected amount)

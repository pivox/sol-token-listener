# Chemin simple — lot 3 : entrée rapide

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** with `ENTRY_MODE=fast` (which requires `LISTENER_INGESTION_SCOPE=creates-only`), the listener decides BUY or REJECTED once per mint, right after it observes the mint's `create`. A BUY writes three things in one transaction: an `entry_decisions` row, a `FastEntryDecided` domain event, and a BUY execution intent (`fast-entry-v1`, TTL 30 s). Nothing is signed or sent in this lot; the executor side (arm lane) is lot 4.

**Architecture:**
- A `FastEntryService` is given to `ObservedTransactionPipeline` as an optional dependency. It is called after the existing stages, so it is not a pipeline stage: a stage would need a taxonomy migration, and fast entry must never fail the observation. It catches and logs every error.
- For each affected mint, it decides only when the processed signature is the mint's `token_launches.created_signature` and the mint has no `entry_decisions` row yet. Both are DB reads.
- Checks run in this order:
  1. Quote mint is SOL.
  2. The creator has not sold in the create transaction (domain events).
  3. An ACTIVE envelope with capacity exists.
  4. BUY quote, then reverse SELL quote, both through `PumpFunPaperQuoteProvider`.
  5. Round-trip loss is within `RISK_MAX_ROUNDTRIP_LOSS_BPS`.
- The decision rules are a pure function. The write is one repository transaction.

**Tech Stack:** TypeScript (tsx, node:test), PostgreSQL 16 (pg).

Spec: `docs/superpowers/specs/2026-10-06-simple-path-design.md` (« Entrée rapide », « Enveloppe »).

**Deviations from the spec (simplest path, decided while planning):**
1. **The envelope table moves from lot 4 into migration 064.** The fast entry needs it to check capacity and get the per-buy amount (`per_buy_quote_amount_raw`). The qualification `envelope_id` and `scope` columns stay in lot 4 (065), with the envelope CLI, the counters and the lanes. Lot 3 only reads envelopes; the tests insert envelope rows directly.
2. **Plain TEXT columns instead of foreign keys** for `entry_decisions.intent_id` and `entry_decisions.launch_event_id`. With `ON DELETE RESTRICT`, a reference would abort the `execution_intents` and `domain_events` purges, which run as one transaction (`purgeExpiredFoundationData`). `entry_decisions` gets its own `purge_after` (decided_at + 7 days) and its own retention DELETE.
3. **A `FastEntryDecided` domain event is written only for BUY.** It exists for the `execution_intents.decision_event_id` foreign key; rejections stay in `entry_decisions`.
4. **Fixed slippage of `1_000` bps (10%) for `minimumAmountOutRaw`.** It is a constant `FAST_ENTRY_SLIPPAGE_BPS` and not a new env var; the spec lists none.
5. **`UNSUPPORTED_TOKEN_EXTENSION` stays in the reason CHECK but is not produced.** Without RPC it cannot be detected, and the quote provider reports it as `QUOTE_STATE_INCONSISTENT`, which leads to `QUOTE_UNAVAILABLE`.
6. **Known lot 4 work: the executor's lineage check.** `EXECUTION_INTENT_CURRENT_LINEAGE_SQL` requires a paper candidate and a `PaperStrategySessionUpdated` decision event, so it does not yet accept `fast-entry-v1` intents.

**Environment:**
- Worktree `.worktrees/reconcile`, branch `feat/fast-entry` from up-to-date `main`.
- Postgres `127.0.0.1:55432`: `TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55432/sol_token_listener_test`. Never use 5432.
- Never run a listener, an RPC or a buy.
- Full suite: `rm -rf dist && npm run build:backend && TEST_DATABASE_URL=... npm run test:backend`. The timeouts in `qualification-projection.repository.test.ts` are a known flaky case under load.

---

### Task 1: `ENTRY_MODE` configuration

**Files:** `src/config/env.ts`, `tests/config-safety.test.ts`.

- [ ] **Step 1: Write failing tests.**
  - `ENTRY_MODE` defaults to `off`.
  - `ENTRY_MODE=fast` with `LISTENER_INGESTION_SCOPE=creates-only` parses to `entryMode: 'fast'`.
  - `fast` with any other scope throws `ENTRY_MODE=fast requires LISTENER_INGESTION_SCOPE=creates-only.`
  - `dossier` throws `ENTRY_MODE=dossier is not implemented yet.`
  - An unknown value throws `ENTRY_MODE has an unsupported value.`
- [ ] **Step 2: Implement.**
  - `export type EntryMode = 'off' | 'fast' | 'dossier';` and `readonly entryMode: EntryMode;` in `AppConfig`.
  - Parse with `parseClosedLiteral(environment.ENTRY_MODE, 'off', 'ENTRY_MODE', ['off', 'fast', 'dossier'])` after `listenerIngestionScope`, then add the two `throw new Error(...)` checks above.
  - Add `entryMode` to the returned object.
  - Fix every place that builds an `AppConfig` literal by hand (tests and fixtures; `npm run build:backend` lists them) by adding `entryMode: 'off'`.
- [ ] **Step 3: Run the tests and the build.**
- [ ] **Step 4: Commit.** `feat(config): add ENTRY_MODE (off|fast; dossier rejected)`

### Task 2: Migration 064 (entry decisions, envelopes, `FastEntryDecided`)

**Files:**
- Create `migrations/064_fast_entry_decisions.sql` and `tests/fast-entry-migration.test.ts`.
- Modify:
  - `src/domain/events.ts` (`DOMAIN_EVENT_TYPES`)
  - `src/storage/api-event-stream.repository.ts` (only if a per-type switch needs a case)
  - `frontend/src/data/api-schemas.ts` and `frontend/src/data/query-keys.ts`, plus their tests (the event type lists)
  - `src/execution-migrations/live-catalog.ts`, `scripts/deployment-smoke.mjs`, both `startup-validator.ts` (`migrationHead`)
  - every test pinning `063_listener_tracked_curve_checkpoints.sql` as the head (`grep -rl 063_listener_tracked_curve_checkpoints tests src scripts`)
  - `tests/paper-e2e-migration.test.ts` and `tests/api-event-stream-migration.test.ts` (the type-list pins)

- [ ] **Step 1: Write the migration.**

```sql
CREATE TABLE IF NOT EXISTS execution_entry_envelopes (
  envelope_id TEXT PRIMARY KEY CHECK (LENGTH(envelope_id) BETWEEN 1 AND 128),
  generation_id TEXT NOT NULL CHECK (LENGTH(generation_id) BETWEEN 1 AND 128),
  operator_id TEXT NOT NULL CHECK (LENGTH(operator_id) BETWEEN 1 AND 128),
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  per_buy_quote_amount_raw NUMERIC(78,0) NOT NULL CHECK (per_buy_quote_amount_raw > 0),
  max_buys INTEGER NOT NULL CHECK (max_buys > 0),
  max_open_positions INTEGER NOT NULL CHECK (max_open_positions = 1),
  max_total_exposure_raw NUMERIC(78,0) NOT NULL CHECK (max_total_exposure_raw > 0),
  max_realized_loss_raw NUMERIC(78,0) NOT NULL CHECK (max_realized_loss_raw > 0),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','EXHAUSTED','REVOKED','EXPIRED')),
  buys_armed INTEGER NOT NULL DEFAULT 0 CHECK (buys_armed >= 0 AND buys_armed <= max_buys),
  realized_loss_raw NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (realized_loss_raw >= 0),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (valid_until > valid_from AND valid_until <= valid_from + INTERVAL '24 hours'),
  CHECK ((state = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS execution_entry_envelopes_one_active_idx
  ON execution_entry_envelopes (generation_id) WHERE state = 'ACTIVE';

CREATE TABLE IF NOT EXISTS entry_decisions (
  decision_id TEXT PRIMARY KEY CHECK (decision_id ~ '^entry_decision_[0-9a-f]{64}$'),
  mint TEXT NOT NULL UNIQUE,
  launch_event_id TEXT NOT NULL,
  create_slot NUMERIC(78,0) NOT NULL CHECK (create_slot >= 0),
  create_block_time TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  entry_mode TEXT NOT NULL CHECK (entry_mode = 'fast'),
  decision TEXT NOT NULL CHECK (decision IN ('BUY','REJECTED')),
  reason_code TEXT CHECK (reason_code IN ('UNSUPPORTED_QUOTE_MINT','UNSUPPORTED_TOKEN_EXTENSION',
    'CREATOR_ALREADY_SOLD','NO_ENVELOPE_CAPACITY','QUOTE_UNAVAILABLE','ROUND_TRIP_LOSS_EXCEEDED')),
  round_trip_loss_bps INTEGER CHECK (round_trip_loss_bps >= 0),
  buy_quote JSONB,
  reverse_quote JSONB,
  intent_id TEXT,
  envelope_id TEXT,
  purge_after TIMESTAMPTZ NOT NULL,
  CHECK ((decision = 'BUY') = (reason_code IS NULL)),
  CHECK ((decision = 'BUY') = (intent_id IS NOT NULL)),
  CHECK (decision <> 'BUY' OR (envelope_id IS NOT NULL AND buy_quote IS NOT NULL
    AND reverse_quote IS NOT NULL AND round_trip_loss_bps IS NOT NULL)),
  CHECK (purge_after > decided_at)
);
CREATE INDEX IF NOT EXISTS entry_decisions_purge_idx ON entry_decisions (purge_after);
```

Then add `'FastEntryDecided'` to the `api_event_stream` CHECK. Copy the DO block from `migrations/013_paper_e2e.sql:225-275`: drop every CHECK whose definition contains `event_type`, then `ADD CONSTRAINT api_event_stream_event_type_check CHECK (event_type IN (...the 19 types..., 'FastEntryDecided'))`. Take the 19 types verbatim from 013.

Write it so it can be replayed (`IF NOT EXISTS`; the DO block is idempotent), like 060 and 063: the deployment smoke runs migrations twice.

- [ ] **Step 2: Add the event type.** Append `'FastEntryDecided'` to `DOMAIN_EVENT_TYPES` in `src/domain/events.ts`. Update the frontend type lists and their tests the same way.
  - `tests/paper-e2e-migration.test.ts` deep-equals migration 013's list with `DOMAIN_EVENT_TYPES`; change it to compare with `DOMAIN_EVENT_TYPES` minus `FastEntryDecided`.
  - `tests/api-event-stream-migration.test.ts` uses an exclusion set; add the new type to it, or assert that 064 contains it, following the file's pattern.
- [ ] **Step 3: Write the migration test** (`tests/fast-entry-migration.test.ts`, modeled on `tests/transaction-inbox-curve-trade-migration.test.ts`).
  - Contract fragments in the SQL.
  - Under PG:
    - an ACTIVE envelope inserts;
    - a second ACTIVE envelope for the same generation is rejected (`23505`);
    - `max_open_positions = 2` is rejected (`23514`);
    - an envelope longer than 24 h is rejected;
    - REVOKED without `revoked_at` is rejected.
  - `entry_decisions`:
    - a REJECTED row with a reason inserts;
    - BUY without `intent_id` is rejected;
    - REJECTED without a reason is rejected;
    - a second row for the same mint is rejected (`23505`).
  - Inserting a `domain_events` row of type `FastEntryDecided` (copy the minimal insert from an existing migration test) succeeds, and its `api_event_stream` row exists.
- [ ] **Step 4: Register 064.**
  - Catalog sha (`shasum -a 256`).
  - Smoke list.
  - `migrationHead` in both startup validators.
  - Every test pinning 063 as the head or the last applied migration; mirror the 063 commit `6c9e184` (`git show 6c9e184 --stat`).
- [ ] **Step 5: Run the new test, `tests/paper-e2e-migration.test.ts`, `tests/api-event-stream-migration.test.ts`, `tests/domain-contracts.test.ts`, the frontend unit tests (`npm --prefix frontend run test -- --run` or the repo's frontend test script), and the build.**
- [ ] **Step 6: Commit.** `feat(migrations): add entry decisions, entry envelopes and FastEntryDecided (064)`

### Task 3: Pure decision rules

**Files:** create `src/domain/fast-entry.ts` and `tests/fast-entry.test.ts`.

```ts
export const FAST_ENTRY_STRATEGY_ID = 'fast-entry-v1';
export const FAST_ENTRY_SLIPPAGE_BPS = 1_000n;
export const FAST_ENTRY_INTENT_TTL_MS = 30_000;
export const FAST_ENTRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export type FastEntryRejection =
  | 'UNSUPPORTED_QUOTE_MINT' | 'UNSUPPORTED_TOKEN_EXTENSION' | 'CREATOR_ALREADY_SOLD'
  | 'NO_ENVELOPE_CAPACITY' | 'QUOTE_UNAVAILABLE' | 'ROUND_TRIP_LOSS_EXCEEDED';

export interface FastEntryLaunchFacts {
  readonly mint: string;
  readonly quoteMint: string;           // launch.quoteAssets[0].mint
  readonly creatorSoldInCreate: boolean;
}
export interface FastEntryEnvelope { readonly envelopeId: string; readonly perBuyQuoteAmountRaw: bigint; }

/** Checks that need no RPC, in spec order; null means "go quote". */
export function precheckFastEntry(
  launch: FastEntryLaunchFacts, envelope: FastEntryEnvelope | null,
): FastEntryRejection | null;
```

`precheckFastEntry` returns:
- `UNSUPPORTED_QUOTE_MINT` if `quoteMint !== NATIVE_SOL_MINT`. Use the constant the codebase already has (`grep -rn "So11111111111111111111111111111111111111112" src | head`).
- else `CREATOR_ALREADY_SOLD` if `creatorSoldInCreate`;
- else `NO_ENVELOPE_CAPACITY` if `envelope === null`;
- else `null`.

```ts
export function decideFastEntryQuotes(
  buy: PaperExecutionQuote, reverseSell: PaperExecutionQuote, maximumRoundTripLossBps: bigint,
): { readonly decision: 'BUY'; readonly lossBps: bigint } | { readonly decision: 'REJECTED'; readonly reason: 'ROUND_TRIP_LOSS_EXCEEDED' | 'QUOTE_UNAVAILABLE'; readonly lossBps: bigint | null };
```

`decideFastEntryQuotes` uses `calculateRoundTrip` from `src/paper/paper-math.ts`:
- a `PaperTradingError` gives `QUOTE_UNAVAILABLE` with `lossBps: null`;
- `lossBps > maximumRoundTripLossBps` gives `ROUND_TRIP_LOSS_EXCEEDED`;
- otherwise `BUY`.

```ts
export function createEntryDecisionId(mint: string): string; // 'entry_decision_' + sha256(lp(['entry-decision-v1', mint]))
```

Use the same `lengthPrefixedUtf8` helper as `createExecutionIntentId`.

- [ ] **Step 1: Write failing tests.** Cover every precheck branch and the order of precedence, the BUY and both REJECTED quote outcomes (build quotes with the fixtures from `tests/paper-math*.test.ts` if they exist, otherwise literal `PaperExecutionQuote` objects), and a stable id.
- [ ] **Step 2: Implement.** Run the tests and the build.
- [ ] **Step 3: Commit.** `feat(domain): fast entry decision rules`

### Task 4: Fast entry repository (reads + atomic write)

**Files:** create `src/storage/fast-entry.repository.ts` and `tests/fast-entry.repository.test.ts` (PG; skip without `TEST_DATABASE_URL`, temporary schema, `migrateDatabase`).

`PostgresFastEntryRepository(pool)` exposes the following methods.

- `readLaunchForSignature(mint, signature): Promise<FastEntryLaunchContext | null>`.
  - Returns `null` unless `token_launches.mint = mint AND created_signature = signature` and the mint has no `entry_decisions` row.
  - The context includes:
    - `mint`, `quoteMint`, `quoteDecimals`, `quoteTokenProgram` (from `quote_assets->0`);
    - `creator`, `createSlot`, `createBlockTime` (nullable);
    - the launch `TokenLaunchDetected` event (`launchEvent: DomainEvent`), read from `domain_events` with the same join as `listWorkerTrackingMints`, on mint, signature and cursor;
    - `creatorSoldInCreate`: `EXISTS` a non-orphaned `BondingCurveTradeObserved` domain event for the mint with the same signature, `payload->'trade'->>'kind' = 'SELL'` and `payload->'trade'->>'trader' = creator`. Verify the payload path against `src/domain/launchpad-events.ts`; the paper creation check lives in `trading-candidate.service.ts:137-172`.
- `readActiveEnvelope(nowMs): Promise<FastEntryEnvelope | null>`.
  - Selects `state='ACTIVE' AND valid_from <= $now AND valid_until > $now AND buys_armed < max_buys`, ordered by `created_at` then `envelope_id`, limit 1.
- `recordRejection(input)`.
  - Inserts `entry_decisions` (REJECTED, reason, optional loss bps and quotes, `purge_after = decided_at + FAST_ENTRY_RETENTION_MS`) with `ON CONFLICT (mint) DO NOTHING`.
  - Returns `'RECORDED' | 'ALREADY_DECIDED'`.
- `recordBuy(input)`, in one transaction (`BEGIN ISOLATION LEVEL REPEATABLE READ`, then `FOUNDATION_RETENTION_SHARED_FENCE_SQL`, then `lockWorkerTrackingMints(client, [mint])`, following `paper-decision.repository.ts:542-603`):
  1. Abort with `'ALREADY_DECIDED'` (ROLLBACK) if an `entry_decisions` row exists for the mint.
  2. Build the `FastEntryDecided` event.
     - `id = createDeterministicDerivedEventId({ type: 'FastEntryDecided', mint, source: 'fast-entry', program: launchEvent.program, signature: launchEvent.signature, cursor: launchEvent.cursor, qualifier: decisionId })`.
     - `payloadVersion: 1`, `payload: { decisionId, envelopeId, buyQuote, reverseQuote, roundTripLossBps }`, serialized with bigints as strings the way existing payloads do.
     - Confirmation, block time and observed-at come from the launch event.
     - Insert it with the same 16-column INSERT as `insertDomainEventWithRaw` (`paper-decision.repository.ts:1200-1217`), `raw_event_id = NULL`. Export that helper or copy it; prefer exporting.
  3. Build the draft with `createExecutionIntentDraft`:
     - `strategyId: FAST_ENTRY_STRATEGY_ID`, `strategyVersion: 1`;
     - `positionId: 'fast_position_' + decisionId.slice('entry_decision_'.length)`, `candidateId: null`, `logicalCommandId: decisionId`;
     - `side: 'BUY'`, `venuePolicy: 'PUMP_FUN_ONLY'`;
     - quote mint, decimals and token program from the launch;
     - `quoteAmountRaw: buy.amountInRaw`, `baseAmountRaw: null`, `minimumAmountOutRaw: buy.minimumAmountOutRaw`;
     - `decisionEventId: event.id`, `decisionFingerprint: createExecutionDecisionFingerprint(event)`;
     - `requestedAtMs: decidedAtMs`, `expiresAtMs: decidedAtMs + FAST_ENTRY_INTENT_TTL_MS`.

     Call `createExecutionIntentInTransaction(client, draft)`.
  4. Insert the `entry_decisions` BUY row with `intent_id` and `envelope_id`.
  5. COMMIT and return `{ kind: 'RECORDED', intentId }`. On any error, ROLLBACK and rethrow.

Tests (seed `token_launches` + `domain_events` like `tests/transaction-inbox-pool-trade-migration.test.ts` `seedPool`, with a real base58 mint, and envelopes by direct INSERT):
- `readLaunchForSignature`:
  - returns the context for the create signature;
  - returns `null` for another signature or once a decision exists;
  - `creatorSoldInCreate` is true with a creator SELL trade event in the same signature, and false with a creator BUY only.
- `readActiveEnvelope` ignores REVOKED, expired, not-yet-valid and exhausted (`buys_armed = max_buys`) envelopes.
- `recordRejection` twice returns `RECORDED`, then `ALREADY_DECIDED`.
- `recordBuy`:
  - writes the decision, the event (and its `api_event_stream` row) and a PENDING intent with `strategy_id='fast-entry-v1'` and `expires_at - requested_at = 30 s`;
  - a second `recordBuy` for the same mint returns `ALREADY_DECIDED` and writes nothing new.

- [ ] Steps: failing tests, implement, pass, build, then commit `feat(storage): fast entry decision repository`.

### Task 5: `FastEntryService`

**Files:** create `src/application/fast-entry.service.ts` and `tests/fast-entry.service.test.ts` (no DB: fake repository and fake quote provider).

```ts
export interface FastEntryService { onObserved(signature: string, mints: readonly string[]): Promise<void>; }
export class DefaultFastEntryService implements FastEntryService {
  constructor(deps: {
    repository: Pick<PostgresFastEntryRepository, 'readLaunchForSignature' | 'readActiveEnvelope' | 'recordRejection' | 'recordBuy'>;
    quotes: { quote(request: PaperQuoteRequest): Promise<PaperExecutionQuote> };
    maximumRoundTripLossBps: bigint;
    now?: () => number;
    onDecision?: (event: Readonly<{ mint: string; decision: 'BUY' | 'REJECTED'; reason: string | null; lossBps: string | null; durationMs: number }>) => void;
    onError?: (event: Readonly<{ mint: string; errorName: string }>) => void;
  });
}
```

For each mint, sequentially:
1. `launch = readLaunchForSignature(mint, signature)`. If it is `null`, skip: this signature is not the create, or the mint is already decided.
2. `envelope = readActiveEnvelope(now)`. If `precheckFastEntry` returns a reason, call `recordRejection` and stop.
3. BUY quote: `quotes.quote({ mint, quoteAsset: {mint, decimals, tokenProgram}, side: 'BUY', amountInRaw: envelope.perBuyQuoteAmountRaw, slippageBps: FAST_ENTRY_SLIPPAGE_BPS })`. Reverse SELL quote: `side: 'SELL'`, `amountInRaw: buy.minimumAmountOutRaw`, same slippage. Any thrown error records `QUOTE_UNAVAILABLE`, without retry.
4. `decideFastEntryQuotes`. A rejection goes to `recordRejection`; otherwise call `recordBuy`.
5. Call `onDecision`. Catch any error per mint, call `onError`, and continue with the next mint. `onObserved` never rejects.

Tests:
- not-the-create is skipped and writes nothing;
- each precheck reason is recorded without calling quotes;
- a quote error gives `QUOTE_UNAVAILABLE`;
- loss exceeded is rejected;
- a BUY passes the right quote requests (amount = envelope per-buy, reverse SELL amount = `buy.minimumAmountOutRaw`) and calls `recordBuy`;
- a repository throw goes to `onError` and the next mint is still processed;
- `onObserved` resolves.

- [ ] Steps: failing tests, implement, pass, build, then commit `feat(application): fast entry service`.

### Task 6: Pipeline hook and factory wiring

**Files:** `src/application/observed-transaction-pipeline.ts`, `src/application/production-listener-factory.ts`, `tests/observed-transaction-pipeline*.test.ts` (find the pipeline test), `tests/production-listener-factory.test.ts`.

- [ ] **Step 1: Pipeline.** Add a 7th optional constructor parameter `private readonly fastEntry: Pick<FastEntryService, 'onObserved'> | null = null`. At the end of `process`, before building the result:

```ts
    if (this.fastEntry !== null && launchpad.affectedMints.length > 0) {
      // Never a stage: entry must not fail or retry the observation.
      try { await this.fastEntry.onObserved(observed.signature, affectedMintList([], launchpad.affectedMints)); } catch { /* service logs */ }
    }
```

  Test: with a fake `fastEntry`, `onObserved` receives the signature and the launchpad mints, and a throwing `fastEntry` does not make `process` reject.
- [ ] **Step 2: Factory.** When `config.entryMode === 'fast'`, build a `DefaultFastEntryService` and pass it as the 7th pipeline argument:
  - repository `new PostgresFastEntryRepository(databasePool)`;
  - quotes: the existing `PumpFunPaperQuoteProvider(marketRpc)` instance, or a new one on the same `marketRpc`;
  - `maximumRoundTripLossBps: BigInt(config.riskMaxRoundTripLossBps)`;
  - `onDecision`: `logger.info({ event: 'listener.fast_entry_decision', ...e }, 'Décision d'entrée rapide.')`;
  - `onError`: `logger.warn({ event: 'listener.fast_entry_error', ...e }, 'Entrée rapide en erreur.')`.

  Find the `new ObservedTransactionPipeline(` call and pass `null` for the parameters it does not set today. Add a source assertion in `tests/production-listener-factory.test.ts` that the service is built only when `entryMode === 'fast'`.
- [ ] **Step 3: Run the pipeline and factory tests and the build.** Then commit `feat(listener): run the fast entry after create observation`.

### Task 7: Retention for `entry_decisions`

**Files:** `src/storage/database.ts` (`purgeExpiredFoundationData`), its counters type, `tests/deferred-retention.integration.test.ts` (or whichever test asserts the counters object; `grep -rn purgeExpiredFoundationData tests`).

- [ ] **Step 1:** Add `DELETE FROM entry_decisions WHERE purge_after <= statement_timestamp()` to the purge transaction. It has no dependents, so it can go anywhere after the fence. Add an `entryDecisions` counter to the returned object, keeping the existing counter naming. Keep `MAX_RETENTION_COUNTERS` large enough.
- [ ] **Step 2: Test.** An expired row is deleted and counted; a row that has not expired is kept. Update the tests that deep-equal the counters object.
- [ ] **Step 3: Commit.** `feat(retention): purge expired entry decisions`

### Task 8: Docs, full suite, PR

- [ ] Document `ENTRY_MODE` in `.env.example` next to `LISTENER_INGESTION_SCOPE`:
  - `off` by default;
  - `fast` requires `creates-only`;
  - BUY intents are written only when an ACTIVE envelope exists (created by the lot 4 CLI);
  - `dossier` is not implemented.
- [ ] Full suite green.
- [ ] Update `docs/superpowers/plans/2026-10-06-simple-path-CHECKPOINT.md`:
  - lot 3 done (PR);
  - the deviations;
  - the lot 4 needs: the lineage check for `fast-entry-v1`, the envelope CLI and counters, and the `market_pools` gap in `creates-only`.
- [ ] Commit, push, open the PR.
- [ ] Wait for CI to pass, merge, update the local `main`.

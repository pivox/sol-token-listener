# Creation Entry V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the observe-safe `creation-entry-v1` paper strategy with one entry, unique-wallet and executable-2x exits, safety exits, durable replay, and no real transaction capability.

**Architecture:** Extend the existing candidate, paper-decision worker, durable session, quote router, and paper ledger. Introduce a V2 strategy session for unique wallets and exit arbitration while preserving V1 session decoding. Migration 017 adds only backward-compatible persistence constraints and reason codes.

**Tech Stack:** TypeScript strict ESM, Node.js test runner, PostgreSQL 16, `pg`, Solana integer amounts as `bigint`, Pino structured logs.

---

### Task 1: Add the closed creation-strategy configuration contract

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `tests/config-safety.test.ts`

- [ ] **Step 1: Write failing configuration tests**

Add a valid creation configuration and explicit rejection cases:

```ts
const creation = {
  EXECUTION_MODE: 'paper',
  CREATION_STRATEGY_ENABLED: 'true',
  CREATION_ENTRY_MAX_AGE_MS: '45000',
  CREATION_ENTRY_MAX_SLOT_LAG: '32',
  EXTERNAL_UNIQUE_BUYERS_TARGET: '10',
  EXTERNAL_MIN_BUY_AMOUNT_RAW: '1000000',
  CREATION_TAKE_PROFIT_MULTIPLIER_BPS: '20000',
  CREATION_MANUAL_KILL_SWITCH: 'false',
  PAPER_ENTRY_QUOTE_AMOUNT_RAW: '10000000',
  PAPER_SLIPPAGE_BPS: '500',
  QUALIFICATION_PROFILE_PATH: 'config/qualification/pumpfun-v1-unvalidated.json',
  RISK_MAX_ROUNDTRIP_LOSS_BPS: '3000',
};
const parsed = parseConfig(creation);
assert.equal(parsed.creationStrategyEnabled, true);
assert.equal(parsed.paperStrategyId, 'creation-entry-v1');
assert.equal(parsed.externalMinimumBuyAmountRaw, 1_000_000n);
assert.throws(() => parseConfig({ ...creation, EXECUTION_MODE: 'observe' }));
assert.throws(() => parseConfig({ ...creation, PAPER_STRATEGY_ENABLED: 'true' }));
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npx tsx --test --test-name-pattern='creation strategy' tests/config-safety.test.ts`  
Expected: FAIL because the creation fields do not exist.

- [ ] **Step 3: Implement strict parsing**

Add readonly configuration fields and parse canonical booleans, integers, and bigints. Enabling the
creation strategy must set `{ id: 'creation-entry-v1', version: 1 }`, require paper mode, SOL/WSOL in
the existing quote allowlist, explicit entry amount/slippage/round-trip loss, and reject simultaneous
legacy strategy enablement. Keep every new variable closed and bounded.

- [ ] **Step 4: Document safe defaults**

Add the exact variables from the design to `.env.example`; keep both strategy enable flags false and
do not add any wallet, signer, private key, or live-execution variable.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx tsx --test tests/config-safety.test.ts`  
Expected: all configuration tests pass.

```bash
git add src/config/env.ts .env.example tests/config-safety.test.ts
git commit -m "feat: configure creation entry paper strategy (#48)"
```

### Task 2: Define backward-compatible V2 paper session contracts

**Files:**
- Modify: `src/domain/paper-strategy.ts`
- Modify: `src/domain/trading-candidate.ts`
- Modify: `tests/paper-strategy-contracts.test.ts`
- Modify: `tests/trading-candidate-contracts.test.ts`

- [ ] **Step 1: Write failing V2 contract tests**

Cover paired unique-wallet evidence, exact reason codes, deterministic IDs, and malformed payloads:

```ts
const session = createCreationEntrySession({
  candidate,
  state: 'WAITING_EXTERNAL_BUYS',
  reasonCode: 'EXTERNAL_UNIQUE_BUY_OBSERVED',
  positionId: 'paper_position',
  entryCursor: { slot: 10n, transactionIndex: 0, instructionIndex: 1, innerInstructionIndex: null },
  externalBuyTarget: 10,
  externalBuyCount: 1,
  countedTradeIds: ['trade-a'],
  countedBuyerWallets: ['wallet-a'],
  lastCountedCursor: { slot: 10n, transactionIndex: 0, instructionIndex: 2, innerInstructionIndex: null },
  minimumConfirmation: 'confirmed',
  lastQuote: candidate.buyQuote,
  lastError: null,
  pendingExitReason: null,
  createdAtMs: 1_000,
  updatedAtMs: 2_000,
  purgeAfterMs: 14_402_000,
});
assert.equal(session.payloadVersion, 2);
assert.deepEqual(session.countedBuyerWallets, ['wallet-a']);
assert.throws(() => createCreationEntrySession({
  ...input,
  countedTradeIds: ['trade-a', 'trade-b'],
  countedBuyerWallets: ['wallet-a', 'wallet-a'],
  externalBuyCount: 2,
}));
```

- [ ] **Step 2: Run RED**

Run: `npx tsx --test tests/paper-strategy-contracts.test.ts tests/trading-candidate-contracts.test.ts`  
Expected: FAIL because V2 and the creation reasons are undefined.

- [ ] **Step 3: Add explicit V1/V2 unions**

Keep `PaperStrategySessionV1` unchanged. Add `PaperStrategySessionV2` with:

```ts
readonly strategy: Readonly<{ id: 'creation-entry-v1'; version: 1 }>;
readonly countedBuyerWallets: readonly string[];
readonly pendingExitReason: CreationExitReason | null;
readonly payloadVersion: 2;
```

Export `PaperStrategySession = PaperStrategySessionV1 | PaperStrategySessionV2`. Validate equal
lengths for buyer wallets, trade IDs, and `externalBuyCount`, unique wallet values, and stable reason
codes. Use a deterministic close-command qualifier containing the selected exit reason.

- [ ] **Step 4: Extend candidate reasons without weakening qualification**

Add creation entry reasons to the existing closed reason-code union. Keep eligible candidates
dependent on a `QUALIFIED` report with no blockers.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx tsx --test tests/paper-strategy-contracts.test.ts tests/trading-candidate-contracts.test.ts`  
Expected: all pass.

```bash
git add src/domain/paper-strategy.ts src/domain/trading-candidate.ts tests/paper-strategy-contracts.test.ts tests/trading-candidate-contracts.test.ts
git commit -m "feat: define creation strategy session v2 (#48)"
```

### Task 3: Add migration 017 for V2 sessions and unique buyer evidence

**Files:**
- Create: `migrations/017_creation_entry_strategy.sql`
- Modify: `src/storage/paper-decision.repository.ts`
- Modify: `src/storage/database.ts`
- Create: `tests/creation-entry-migration.test.ts`
- Modify: `tests/paper-decision.repository.test.ts`
- Modify: `scripts/deployment-smoke.mjs`
- Modify: `tests/deployment-artifacts.test.ts`
- Modify: `tests/wallet-graph-migration.test.ts`
- Modify: `tests/transaction-inbox-retry-migration.test.ts`
- Modify: `tests/social-persistence-retry-migration.test.ts`
- Modify: `tests/participant-analytics-migration.test.ts`
- Modify: `tests/api-event-stream-migration.test.ts`
- Modify: `tests/transaction-inbox-timestamp-migration.test.ts`
- Modify: `tests/transaction-ingestion-migration.test.ts`

- [ ] **Step 1: Write failing migration and repository tests**

Test migrations 001–017 on an empty schema and replay them. Seed a legacy V1 session plus duplicate
legacy wallet evidence, apply 017, and assert no row is deleted. Persist one V2 session and assert a
second `creation-entry-v1` evidence row for the same `(session_id, trader)` is rejected.

- [ ] **Step 2: Run RED**

Run:

```bash
TEST_DATABASE_URL=postgresql:///solanabot npx tsx --test \
  tests/creation-entry-migration.test.ts tests/paper-decision.repository.test.ts
```

Expected: FAIL because migration 017 and V2 decoding/persistence are absent.

- [ ] **Step 3: Implement the additive migration**

Migration 017 must:

```sql
ALTER TABLE paper_external_buy_events ADD COLUMN IF NOT EXISTS strategy_id TEXT;
UPDATE paper_external_buy_events evidence
SET strategy_id = session.strategy_id
FROM paper_strategy_sessions session
WHERE session.session_id = evidence.session_id AND evidence.strategy_id IS NULL;
ALTER TABLE paper_external_buy_events ALTER COLUMN strategy_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paper_external_buy_events_creation_wallet_idx
  ON paper_external_buy_events(session_id, trader)
  WHERE strategy_id = 'creation-entry-v1' AND trader IS NOT NULL;
```

Replace the affected closed CHECK constraints transactionally so V1 and V2 payload versions and the
new reasons are accepted. Do not drop data or loosen paper-only invariants.

- [ ] **Step 4: Persist and decode the session union**

Update repository serializers to switch strictly on `payloadVersion`. Persist `strategy_id` on new
buyer evidence. An unknown version, malformed V2 wallet list, or inconsistent count must raise the
existing safe repository data error.

- [ ] **Step 5: Update canonical migration contracts**

Append `017_creation_entry_strategy.sql` to the Docker smoke canonical list, update all current-tail
assertions to migration 017, and add a deployment artifact assertion for migration 017.

- [ ] **Step 6: Run GREEN and commit**

Run:

```bash
TEST_DATABASE_URL=postgresql:///solanabot npx tsx --test \
  tests/creation-entry-migration.test.ts tests/paper-decision.repository.test.ts \
  tests/deployment-artifacts.test.ts
```

Expected: all pass with no skipped PostgreSQL test.

```bash
git add migrations/017_creation_entry_strategy.sql src/storage/paper-decision.repository.ts src/storage/database.ts tests scripts/deployment-smoke.mjs
git commit -m "feat: persist creation strategy sessions (#48)"
```

### Task 4: Count distinct eligible buyer wallets

**Files:**
- Create: `src/application/creation-entry-v1.strategy.ts`
- Modify: `src/application/validated-external-buys.strategy.ts`
- Create: `tests/creation-entry-v1.strategy.test.ts`

- [ ] **Step 1: Write failing unique-wallet tests**

Use Pump.fun and PumpSwap fixtures to prove:

```ts
const repeated = Array.from({ length: 10 }, (_, index) =>
  launchBuy(`trade-${index}`, index + 2, 'wallet-a', 2_000_000n));
const result = await strategy.reconcile({ ...input, launchTrades: repeated });
assert.equal(result.session.externalBuyCount, 1);
assert.deepEqual(result.session.countedBuyerWallets, ['wallet-a']);
assert.equal(result.requestedAction, 'NONE');
```

Also cover ten wallets, below-minimum amounts, creator/null traders, pre-entry cursors, wrong quote
mint, orphaned status, and one wallet buying once on each venue.

- [ ] **Step 2: Run RED**

Run: `npx tsx --test tests/creation-entry-v1.strategy.test.ts`  
Expected: FAIL because the creation strategy does not exist.

- [ ] **Step 3: Implement canonical unique-wallet selection**

Extract active Pump.fun/PumpSwap BUYs, sort by chain cursor then ID, and retain only the first eligible
trade per exact trader. Enforce `quoteAmountRaw >= externalMinimumBuyAmountRaw` with `bigint`. Feed the
first unseen wallet into the V2 domain transition and leave the legacy strategy behavior unchanged.

- [ ] **Step 4: Rebuild after orphaning**

Reconciliation must start from an empty V2 buyer projection, replay only active canonical buys, and
produce the same deterministic wallet/trade pairs. A removed wallet must decrement the projection;
the existing retraction path handles a close whose trigger disappeared.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx tsx --test tests/creation-entry-v1.strategy.test.ts tests/validated-external-buys.strategy.test.ts`  
Expected: all new and legacy strategy tests pass.

```bash
git add src/application/creation-entry-v1.strategy.ts src/application/validated-external-buys.strategy.ts tests/creation-entry-v1.strategy.test.ts tests/validated-external-buys.strategy.test.ts
git commit -m "feat: count unique creation buyers (#48)"
```

### Task 5: Implement executable 2x and safety exit arbitration

**Files:**
- Modify: `src/application/creation-entry-v1.strategy.ts`
- Modify: `src/domain/paper-trading.ts`
- Modify: `src/paper/paper-trading-engine.ts`
- Modify: `tests/creation-entry-v1.strategy.test.ts`
- Modify: `tests/paper-trading-engine.test.ts`

- [ ] **Step 1: Write failing exit-priority tests**

Cover a conservative full quote at 2x, a theoretical `amountOutRaw` at 2x with minimum below 2x,
partial quantity, creator SELL, manual kill, quote outage, and two simultaneous triggers. Assert:

```ts
assert.equal(ledger.closeCalls[0]?.sellQuote.amountInRaw, POSITION.remainingBaseRaw);
assert.equal(ledger.closeCalls[0]?.reason, 'CREATOR_EARLY_SELL');
assert.equal(ledger.closeCalls.length, 1);
```

- [ ] **Step 2: Run RED**

Run: `npx tsx --test --test-name-pattern='2x|creator|kill|priority' tests/creation-entry-v1.strategy.test.ts`  
Expected: FAIL because exit arbitration is absent.

- [ ] **Step 3: Add a pure exit selector**

Implement a small pure function returning the first cause in this order: manual kill, active creator
SELL after entry, executable 2x, unique-wallet target. Use:

```ts
const takeProfitReached = sellQuote.minimumAmountOutRaw * 10_000n
  >= position.quoteCostRaw * takeProfitMultiplierBps;
```

Reject a SELL quote whose `amountInRaw !== position.remainingBaseRaw`. Never use `number` for amounts,
fees, multiplier basis points, or PnL.

- [ ] **Step 4: Keep unavailable exits pending**

When a selected exit has no fresh full quote, return `EXIT_PENDING_QUOTE` and
`SELL_QUOTE_UNAVAILABLE_OR_STALE` without calling the ledger. Preserve the selected pending reason so
the retry cannot silently change a safety exit into a profit exit.

- [ ] **Step 5: Keep the ledger idempotent for all reasons**

Allow the new stable close reasons through strict command validation. The existing deterministic
close hash remains the authority; a committed terminal position is returned without a second trade.

- [ ] **Step 6: Run GREEN and commit**

Run: `npx tsx --test tests/creation-entry-v1.strategy.test.ts tests/paper-trading-engine.test.ts`  
Expected: all pass.

```bash
git add src/application/creation-entry-v1.strategy.ts src/domain/paper-trading.ts src/paper/paper-trading-engine.ts tests/creation-entry-v1.strategy.test.ts tests/paper-trading-engine.test.ts
git commit -m "feat: arbitrate creation strategy exits (#48)"
```

### Task 6: Integrate fresh creation eligibility and the manual kill wake-up

**Files:**
- Modify: `src/application/trading-candidate.service.ts`
- Modify: `src/application/paper-decision-worker.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `src/ports/paper-decision-repository.ts`
- Modify: `src/storage/paper-decision.repository.ts`
- Modify: `tests/trading-candidate.service.test.ts`
- Modify: `tests/paper-decision-worker.test.ts`
- Modify: `tests/production-listener-factory.test.ts`
- Modify: `tests/paper-decision.repository.test.ts`

- [ ] **Step 1: Write failing entry tests**

Test a valid fresh creation, replay, stale age, excessive launch/quote slot lag, orphaned creation,
creator sell before entry, missing BUY/reverse quote, unsupported quote mint, active position, and
observe mode. Assert one BUY only for the valid paper case.

- [ ] **Step 2: Run RED**

Run:

```bash
npx tsx --test tests/trading-candidate.service.test.ts \
  tests/paper-decision-worker.test.ts tests/production-listener-factory.test.ts
```

Expected: the creation-specific cases fail.

- [ ] **Step 3: Anchor entry freshness to creation**

Use `snapshot.launch.createdAt.slot` and the original canonical `TokenLaunchDetected` observation time
loaded by the repository. Extend `PaperDecisionSnapshot` with an immutable `launchDetectedAtMs`; do
not derive age from metadata, social, qualification, or the latest trade event.

- [ ] **Step 4: Reject pre-entry creator sells and incoherent quotes**

Scan active launch and market trades through the candidate decision cursor. Emit the stable creation
entry reason and keep the candidate non-eligible. Continue to require canonical qualification with no
blockers and the existing round-trip validation in `PaperTradingEngine.open`.

- [ ] **Step 5: Route one strategy through the existing worker**

Select `CreationEntryV1Strategy` in the production factory when enabled. Pass minimum buy amount,
2x multiplier, and manual-kill state in immutable worker/strategy options. Do not instantiate another
worker, repository, quote router, or ledger.

- [ ] **Step 6: Wake active sessions for a manual kill**

Add `enqueueActiveSessions(nowMs)` to the repository port. Its PostgreSQL implementation inserts one
deterministic pending paper job per active creation session using the session's latest durable source
event and the existing conflict-safe job key. Call it only when the kill switch is true before the
worker begins normal claims.

- [ ] **Step 7: Run GREEN and commit**

Run:

```bash
TEST_DATABASE_URL=postgresql:///solanabot npx tsx --test \
  tests/trading-candidate.service.test.ts tests/paper-decision-worker.test.ts \
  tests/production-listener-factory.test.ts tests/paper-decision.repository.test.ts
```

Expected: all pass with no PostgreSQL skip.

```bash
git add src/application/trading-candidate.service.ts src/application/paper-decision-worker.ts src/application/production-listener-factory.ts src/ports/paper-decision-repository.ts src/storage/paper-decision.repository.ts tests/trading-candidate.service.test.ts tests/paper-decision-worker.test.ts tests/production-listener-factory.test.ts tests/paper-decision.repository.test.ts
git commit -m "feat: run creation entry strategy end to end (#48)"
```

### Task 7: Expose additive API evidence and operator documentation

**Files:**
- Modify: `src/api/contracts.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `src/storage/api-event-stream.repository.ts`
- Modify: `frontend/src/data/api-schemas.ts`
- Modify: `tests/api-projection.repository.test.ts`
- Modify: `tests/api-event-stream.repository.test.ts`
- Modify: `frontend/src/data/api-schemas.test.ts`
- Modify: `README.md`
- Modify: `docs/api/v1.md`
- Modify: `docs/architecture/pumpfun-v1.md`

- [ ] **Step 1: Write failing API schema tests**

Assert additive strategy fields on paper position/timeline/SSE payloads while preserving the V1
envelope and read-only HTTP methods. Reject unknown session payload versions and malformed bigint
strings.

- [ ] **Step 2: Run RED**

Run:

```bash
npx tsx --test tests/api-projection.repository.test.ts tests/api-event-stream.repository.test.ts
npm test --workspace frontend -- --run frontend/src/data/api-schemas.test.ts
```

Expected: creation strategy fields are missing.

- [ ] **Step 3: Add strictly additive projections**

Expose strategy id/version, unique buyer count/target, session state, last/pending exit reason, and
existing paper PnL values. Serialize every raw amount and basis-point value as a canonical decimal
string. Do not expose trader lists on the list endpoint; keep evidence on the mint detail/timeline.

- [ ] **Step 4: Document operation and limitations**

Document the exact paper-only enablement command, entry and exit ordering, unique-wallet limitation
(no Sybil clustering), four-hour retention, quote-outage behavior, and the explicit statement that no
wallet or transaction submission exists.

- [ ] **Step 5: Run GREEN and commit**

Run the commands from Step 2. Expected: all pass.

```bash
git add src/api src/storage/api-projection.repository.ts src/storage/api-event-stream.repository.ts frontend/src/data README.md docs
git commit -m "docs: expose creation strategy evidence (#48)"
```

### Task 8: Verify the complete PR and request review

**Files:**
- Modify only files required by failures caused by this PR.

- [ ] **Step 1: Run formatting and generated-artifact guards**

Run: `git diff --check && npm run docs:check`  
Expected: exit 0.

- [ ] **Step 2: Run compiler and lint gates**

Run: `npm run build && npm run check && npm run lint`  
Expected: exit 0; build packages 17 migrations.

- [ ] **Step 3: Run the full PostgreSQL-backed test suite**

Run: `TEST_DATABASE_URL=postgresql:///solanabot npm test`  
Expected: backend and frontend pass with zero failures and zero skipped PostgreSQL tests.

- [ ] **Step 4: Run the deployment contract**

Run: `npm run deployment:smoke`  
Expected: pass when Docker has sufficient disk. If local Docker reports `No space left on device`,
record that environmental blocker and require the clean GitHub deployment-contract job to pass.

- [ ] **Step 5: Perform a safety source scan**

Run:

```bash
rg -n "sendTransaction|signTransaction|privateKey|secretKey|Keypair" \
  src/application src/domain src/paper src/storage
```

Expected: no new creation-strategy execution path contains any match.

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin feature/issue-48-creation-strategy
gh pr create --base main --head feature/issue-48-creation-strategy \
  --title "feat: add creation-entry-v1 paper strategy (#48)" \
  --body "Summary: creation-entry-v1 reuses the canonical paper pipeline, counts unique wallets, and closes only on an executable full SELL or safety trigger. Safety: observe creates no paper artifacts and no signing/submission path exists. Persistence: migration 017 is additive and replayable. Verification: build/check/lint/tests/deployment contract. Closes #48"
```

The PR body must summarize behavior, safety, migration 017, and exact verification. It must contain
`Closes #48` and request Codex review. Perform at most three correction/review cycles. Merge only when
all GitHub checks pass and no blocking review thread remains.

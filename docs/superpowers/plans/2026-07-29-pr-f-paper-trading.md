# Pump.fun Paper Trading PR F Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construire un ledger paper Pump.fun comptable, atomique, idempotent et strictement dépourvu de transaction Solana.

**Architecture:** Le domaine décrit quotes, positions, trades, commandes et événements immuables. Un moteur pur valide qualification, allowlist et calculs bigint, puis délègue chaque ouverture/fermeture à une unité de travail transactionnelle. Un repository PostgreSQL persiste projection, trade append-only et événement métier dans le même commit.

**Tech Stack:** TypeScript strict ESM, Node.js `crypto`, PostgreSQL/`pg`, `node:test`, calculs financiers `bigint`.

---

### Task 1: Contrats paper et calculs financiers

**Files:**

- Create: `src/domain/paper-trading.ts`
- Create: `src/paper/paper-math.ts`
- Test: `tests/paper-math.test.ts`

- [ ] **Step 1: Write failing quote and round-trip tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateRoundTrip, validatePaperQuote } from '../src/paper/paper-math.js';

void test('calcule une perte aller-retour en bigint avec arrondi plafond', () => {
  const buy = quote('SOL', 'MINT', 100n, 95n, 90n);
  const sell = quote('MINT', 'SOL', 90n, 91n, 89n);
  assert.deepEqual(calculateRoundTrip(buy, sell), {
    quoteCostRaw: 100n,
    baseFilledRaw: 90n,
    returnRaw: 89n,
    lossRaw: 11n,
    lossBps: 1_100n,
  });
});

void test('rejette une quote incohérente', () => {
  assert.throws(
    () => validatePaperQuote(quote('SOL', 'MINT', 100n, 90n, 91n)),
    /minimumAmountOutRaw/u,
  );
});
```

The local `quote` fixture returns every required field: deterministic `id`,
input/output mints, raw amounts, fees, bps, observation time and slot.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test tests/paper-math.test.ts`

Expected: `ERR_MODULE_NOT_FOUND` for `paper-math.js`.

- [ ] **Step 3: Define immutable domain contracts**

```ts
export interface PaperExecutionQuote {
  readonly id: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly amountInRaw: bigint;
  readonly amountOutRaw: bigint;
  readonly minimumAmountOutRaw: bigint;
  readonly feesRaw: bigint;
  readonly slippageBps: bigint;
  readonly priceImpactBps: bigint;
  readonly observedAtMs: number;
  readonly observedSlot: bigint;
}

export type PaperPositionStatus = 'PAPER_HOLDING' | 'PAPER_CLOSED';
export type PaperTradeSide = 'BUY' | 'SELL';

export interface PaperStrategyIdentity {
  readonly id: string;
  readonly version: number;
}

export interface PaperPosition {
  readonly id: string;
  readonly mint: string;
  readonly quoteAsset: QuoteAsset;
  readonly strategy: PaperStrategyIdentity;
  readonly status: PaperPositionStatus;
  readonly baseFilledRaw: bigint;
  readonly remainingBaseRaw: bigint;
  readonly quoteCostRaw: bigint;
  readonly quoteProceedsRaw: bigint | null;
  readonly grossPnlQuoteRaw: bigint | null;
  readonly netPnlQuoteRaw: bigint | null;
  readonly roundTripLossBps: bigint;
  readonly entryTradeId: string;
  readonly exitTradeId: string | null;
  readonly openCommandHash: string;
  readonly closeCommandHash: string | null;
  readonly triggerEventId: string;
  readonly openedAtMs: number;
  readonly closedAtMs: number | null;
  readonly purgeAfterMs: number | null;
  readonly payloadVersion: 1;
}

export interface PaperTrade {
  readonly id: string;
  readonly positionId: string;
  readonly side: PaperTradeSide;
  readonly quote: PaperExecutionQuote;
  readonly fillAmountOutRaw: bigint;
  readonly reason: string;
  readonly createdAtMs: number;
  readonly payloadVersion: 1;
}
```

Add `OpenPaperPositionCommand` with mint, quote asset, strategy, triggering
`DomainEvent`, `QualificationReport`, BUY quote, reverse SELL quote and maximum
round-trip loss bps. Add `ClosePaperPositionCommand` with position ID,
triggering event, SELL quote and stable human reason. Define
`PaperPositionOpenedEventV1` and `PaperPositionClosedEventV1` as
`TypedDomainEvent` payload version 1 carrying the immutable position and trade.
Define these stable errors:

```ts
export type PaperTradingErrorCode =
  | 'PAPER_MODE_DISABLED'
  | 'QUALIFICATION_NOT_ACCEPTED'
  | 'QUALIFICATION_BLOCKED'
  | 'QUOTE_MINT_NOT_ALLOWED'
  | 'QUOTE_INVALID'
  | 'ROUND_TRIP_LOSS_EXCEEDED'
  | 'POSITION_NOT_FOUND'
  | 'POSITION_NOT_OPEN'
  | 'POSITION_CONFLICT';
```

- [ ] **Step 4: Implement validation and bigint math**

```ts
export function calculateLossBps(costRaw: bigint, returnRaw: bigint): bigint {
  if (costRaw <= 0n) throw new PaperTradingValidationError('quoteCostRaw');
  const lossRaw = costRaw > returnRaw ? costRaw - returnRaw : 0n;
  return lossRaw === 0n ? 0n : ((lossRaw * 10_000n) + costRaw - 1n) / costRaw;
}
```

`validatePaperQuote` rejects non-positive inputs/outputs, negative fees, bps
outside `0n..10_000n`, `minimumAmountOutRaw > amountOutRaw`, unsafe dates and
negative slots. `calculateRoundTrip` also requires the reverse quote input to
equal the conservative BUY fill and verifies the mint directions.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npx tsx --test tests/paper-math.test.ts`

Expected: all paper math tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/domain/paper-trading.ts src/paper/paper-math.ts tests/paper-math.test.ts
git commit -m "feat: define paper trading accounting"
```

### Task 2: Moteur paper sûr et idempotent

**Files:**

- Create: `src/ports/paper-trading-repository.ts`
- Create: `src/paper/paper-trading-engine.ts`
- Create: `tests/paper-trading-engine.test.ts`

- [ ] **Step 1: Write failing opening safety tests**

```ts
void test('refuse observe sans écrire', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'observe');
  await assert.rejects(engine.open(openCommand()), hasCode('PAPER_MODE_DISABLED'));
  assert.equal(repository.writeCount, 0);
});

void test('refuse un rapport non qualifié ou bloqué', async () => {
  await assert.rejects(
    makeEngine(new MemoryPaperRepository(), 'paper').open(
      openCommand({ verdict: 'WATCHLISTED' }),
    ),
    hasCode('QUALIFICATION_NOT_ACCEPTED'),
  );
});
```

Add tests for quote mint outside the SOL/WSOL allowlist and round-trip loss
above the command ceiling.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test tests/paper-trading-engine.test.ts`

Expected: missing engine/repository modules.

- [ ] **Step 3: Define the transaction port**

```ts
export interface PaperTradingTransaction {
  findPosition(id: string): Promise<PaperPosition | null>;
  findActivePosition(
    mint: string,
    strategy: PaperStrategyIdentity,
  ): Promise<PaperPosition | null>;
  insertOpened(
    position: PaperPosition,
    trade: PaperTrade,
    event: PaperPositionOpenedEventV1,
  ): Promise<void>;
  updateClosed(
    position: PaperPosition,
    trade: PaperTrade,
    event: PaperPositionClosedEventV1,
  ): Promise<void>;
}

export interface PaperTradingRepository {
  transact<T>(operation: (transaction: PaperTradingTransaction) => Promise<T>): Promise<T>;
}
```

- [ ] **Step 4: Implement deterministic opening**

```ts
public open(command: OpenPaperPositionCommand): Promise<PaperPosition> {
  this.requirePaperMode();
  validateOpenCommand(command, this.config.paperQuoteMintAllowlist);
  const positionId = createPaperPositionId(command);
  return this.repository.transact(async (transaction) => {
    const existing = await transaction.findPosition(positionId);
    if (existing !== null) return reconcileOpenReplay(existing, command);
    const active = await transaction.findActivePosition(command.mint, command.strategy);
    if (active !== null) throw new PaperTradingError('POSITION_CONFLICT');
    const opened = createOpenPosition(positionId, command, this.clock.now());
    await transaction.insertOpened(
      opened.position,
      opened.trade,
      createOpenedEvent(opened.position, opened.trade, command.trigger),
    );
    return opened.position;
  });
}
```

The engine snapshots the command before the first await. Position and trade IDs
use SHA-256 over length-safe JSON tuples. The open-command hash includes the
quotes, qualification report, strategy and trigger ID. A matching replay
returns the stored position; any conflicting payload throws `POSITION_CONFLICT`.

- [ ] **Step 5: Add failing close, PnL and replay tests**

```ts
void test('ferme la quantité détenue et calcule le PnL conservateur', async () => {
  const opened = await engine.open(openCommand());
  const closed = await engine.close(closeCommand(opened.id, 120n, 115n));
  assert.equal(closed.status, 'PAPER_CLOSED');
  assert.equal(closed.netPnlQuoteRaw, 15n);
  assert.equal(closed.remainingBaseRaw, 0n);
  assert.equal(closed.purgeAfterMs, closed.closedAtMs! + 4 * 60 * 60 * 1_000);
});
```

Add one replay test for identical close and one contradiction test proving no
second trade is written.

- [ ] **Step 6: Implement close and immutable events**

Close validates that the SELL quote consumes exactly `remainingBaseRaw`, uses
`minimumAmountOutRaw` as proceeds, computes signed gross/net PnL, sets
`PAPER_CLOSED`, `closedAtMs`, `purgeAfterMs`, and writes
`PaperPositionClosed` in the same transaction.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `npx tsx --test tests/paper-trading-engine.test.ts`

Expected: all paper engine tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/ports/paper-trading-repository.ts src/paper/paper-trading-engine.ts tests/paper-trading-engine.test.ts
git commit -m "feat: simulate idempotent paper positions"
```

### Task 3: Migration PostgreSQL et repository transactionnel

**Files:**

- Create: `migrations/004_paper_trading.sql`
- Create: `src/storage/paper-trading.repository.ts`
- Create: `tests/paper-trading-migration.test.ts`
- Create: `tests/paper-trading.repository.test.ts`
- Modify: `src/storage/database.ts`

- [ ] **Step 1: Write failing migration contract tests**

```ts
for (const table of ['paper_positions', 'paper_trades']) {
  assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'u'));
}
assert.match(sql, /NUMERIC\(78,0\)/u);
assert.match(sql, /UNIQUE.*mint.*strategy_id/isu);
assert.match(sql, /ON DELETE CASCADE/u);
assert.match(sql, /CHECK.*PAPER_HOLDING.*PAPER_CLOSED/isu);
```

Also assert that the migration contains no `private_key`, `sendTransaction`,
`live` mode or transaction payload column.

- [ ] **Step 2: Run migration test and verify RED**

Run: `npx tsx --test tests/paper-trading-migration.test.ts`

Expected: `ENOENT` for migration 004.

- [ ] **Step 3: Create the migration**

`paper_positions` stores deterministic IDs, mint, quote metadata, strategy,
status, command hashes, bigint accounting fields, trigger event IDs, opened /
closed / purge timestamps and versioned JSON evidence.

`paper_trades` stores deterministic ID, position FK with cascade, side, quote
snapshot, conservative fill, fees, bps, reason, timestamps and a unique
`(position_id, side)` constraint.

Use a partial unique index for one `PAPER_HOLDING` row per
`(mint, strategy_id, strategy_version)`.

- [ ] **Step 4: Write failing repository transaction tests**

Use a recording pool/client to assert:

```ts
assert.deepEqual(commands, ['BEGIN', 'SELECT', 'INSERT_POSITION', 'INSERT_TRADE', 'INSERT_EVENT', 'COMMIT']);
```

Force `INSERT_EVENT` to throw and assert `ROLLBACK` occurs without `COMMIT`.
Verify every bigint is passed as a decimal string and every payload through
`toJsonValue`.

- [ ] **Step 5: Implement the PostgreSQL repository**

`PostgresPaperTradingRepository.transact` acquires a client, runs `BEGIN`,
provides a transaction object, commits on success, rolls back on error and
always releases the client.

`findPosition` and `findActivePosition` use `SELECT ... FOR UPDATE`.
`insertOpened` and `updateClosed` write position, trade and `domain_events` in
the required order. Deserialization rejects malformed numeric, status or
payload values instead of coercing them.

- [ ] **Step 6: Extend retention purge**

Add `paperPositions` to the purge result and delete closed positions where
`purge_after <= NOW()`. Trades cascade. The delete occurs before terminal
launch deletion so foreign keys remain consistent.

- [ ] **Step 7: Run focused persistence tests**

Run:

```bash
npx tsx --test tests/paper-trading-migration.test.ts tests/paper-trading.repository.test.ts
```

Expected: all persistence tests pass.

- [ ] **Step 8: Commit**

```bash
git add migrations/004_paper_trading.sql src/storage/paper-trading.repository.ts src/storage/database.ts tests/paper-trading-migration.test.ts tests/paper-trading.repository.test.ts
git commit -m "feat: persist paper positions atomically"
```

### Task 4: Configuration, API contract and safety regression

**Files:**

- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `tests/config-safety.test.ts`
- Modify: `docs/api/v1.md`
- Modify: `docs/architecture/pumpfun-v1.md`
- Create: `tests/paper-trading-safety.test.ts`

- [ ] **Step 1: Write failing retention and allowlist tests**

```ts
const config = parseConfig(base);
assert.equal(config.dataRetentionHours, 4);
assert.deepEqual(config.paperQuoteMintAllowlist, [config.wsolMint]);
assert.throws(
  () => parseConfig({ ...base, PAPER_QUOTE_MINT_ALLOWLIST: 'USDC', EXECUTION_MODE: 'paper' }),
  /SOL\/WSOL/u,
);
```

- [ ] **Step 2: Write the static safety test**

Scan `src/paper`, `src/domain/paper-trading.ts`,
`src/storage/paper-trading.repository.ts` and migration 004. Reject imports or
text matching wallet/signing, `VersionedTransaction`, `sendTransaction`,
`simulateTransaction`, private keys or live execution.

- [ ] **Step 3: Update safe configuration and documentation**

Document in `.env.example` that `PAPER_QUOTE_MINT_ALLOWLIST` defaults to WSOL
and `DATA_RETENTION_HOURS=4`. Document the JSON representation of a paper
position: bigint values are decimal strings, timestamps ISO UTC, quote and
strategy versions explicit, `pnl` null until closed.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm test
npm run build
npm run check
npm run lint
git diff --check
```

Expected: every command exits zero, existing tests do not regress, and no
paper module references wallet/signing/transaction submission.

- [ ] **Step 5: Commit**

```bash
git add .env.example src/config/env.ts tests/config-safety.test.ts tests/paper-trading-safety.test.ts docs/api/v1.md docs/architecture/pumpfun-v1.md
git commit -m "docs: expose safe paper trading contracts"
```

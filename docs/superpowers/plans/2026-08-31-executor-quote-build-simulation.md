# Executor Quote, Build and Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `subagent-driven-development` or `executing-plans`, keep TDD red/green per
> task, and do not exceed three GitHub review cycles.

**Goal:** Deliver #51-D as an independent `simulation-only` executor mode that
quotes Pump.fun/PumpSwap from a causal snapshot, builds and inspects an unsigned
transaction, simulates it without sending, and persists a non-signable proof.

**Architecture:** A closed domain describes quotes, build policies and bounded
simulation evidence. A provider-affine gateway exposes only the RPC methods
needed by one attempt. Venue adapters use the pinned official Pump SDKs but
return plain immutable DTOs. A single atomic PostgreSQL operation fences the
lease, stores the artifact, completes the attempt and terminalizes the
simulation-only intent. The existing #51-C dry-run remains the default.

**Tech stack:** TypeScript strict ESM, Node.js 22, PostgreSQL 16, `node:test`,
`@solana/web3.js` 1.98.4, `@solana/spl-token` 0.4.15, official Pump SDKs,
Pino, SHA-256.

**Normative design:**
`docs/superpowers/specs/2026-08-31-executor-quote-build-simulation-design.md`
version 1.0.4 and parent specification version 1.5.0.

---

## File map

New production files, adjusted only if the tests demonstrate a smaller closed
surface:

- `migrations/033_execution_simulation_artifacts.sql`
- `src/domain/execution-simulation.ts`
- `src/ports/execution-simulation-repository.ts`
- `src/ports/execution-market-gateway.ts`
- `src/ports/execution-simulation-gateway.ts`
- `src/storage/execution-simulation.repository.ts`
- `src/storage/execution-venue.repository.ts`
- `src/executor/simulation-worker.ts`
- `src/executor-simulation/provider-session.ts`
- `src/executor-simulation/venue-router.ts`
- `src/executor-simulation/pumpfun-adapter.ts`
- `src/executor-simulation/pumpswap-adapter.ts`
- `src/executor-simulation/instruction-inspector.ts`
- `src/executor-simulation/solana-simulation-gateway.ts`

Likely modified production files:

- `src/domain/execution-intent.ts`
- `src/ports/execution-intent-repository.ts`
- `src/storage/execution-intent.repository.ts`
- `src/storage/database.ts`
- `src/executor/config.ts`
- `src/executor/main.ts`
- `src/executor/runtime.ts`
- quote helpers under `src/launchpads/pumpfun` and `src/markets/pumpswap`
- `.env.example`, `package.json`, `README.md`
- `docs/architecture/pumpfun-v1.md`, `docs/system-overview.html`

Tests are colocated under `tests/` with explicit `execution-simulation-*`,
`executor-simulation-*` and migration names. Fixtures must be generated from
official pinned SDK results and contain no wallet secret or provider URL.

---

## Task 1: Freeze the versioned domain contract

**Files:**

- Create: `src/domain/execution-simulation.ts`
- Create: `tests/execution-simulation.test.ts`

- [ ] Write failing tests for the closed enums, payload version 1,
  specification 1.5.0, evaluator version 1 and immutable DTO validation.
- [ ] Cover BUY Pump.fun, SELL Pump.fun and SELL PumpSwap artifacts.
- [ ] Cover all `bigint` fields at zero/u64/int64 boundaries and beyond 2^53.
- [ ] Pin deterministic artifact, quote, snapshot, build, message and result
  fingerprint vectors using length-prefixed UTF-8 segments.
- [ ] Reject proxy, accessor, symbol/extra/missing keys, non-frozen nested
  values, uppercase hashes and noncanonical decimals.
- [ ] Model success and failure evidence so impossible stage/status
  combinations cannot be constructed.
- [ ] Add the append-only terminal reason codes
  `EXECUTION_PROVIDER_FAILED`, `EXECUTION_BUILD_FAILED` and
  `EXECUTION_EVIDENCE_INVALID`, and pin the normative internal→terminal
  mapping plus failure-stage nullability matrix.

Run red:

```bash
npx tsx --test tests/execution-simulation.test.ts
```

Implement the smallest pure domain. Do not import Solana or an SDK.

Run green, then:

```bash
npm run check:backend
npm run lint:backend
```

Commit:

```bash
git add src/domain/execution-simulation.ts tests/execution-simulation.test.ts
git commit -m "feat: define simulation-only execution evidence (#51)"
```

## Task 2: Add migration 033 and atomic repository contract

**Files:**

- Create: `migrations/033_execution_simulation_artifacts.sql`
- Create: `src/ports/execution-simulation-repository.ts`
- Create: `src/storage/execution-simulation.repository.ts`
- Create tests for migration, port surface and repository
- Modify migration inventory/deployment tests and `src/storage/database.ts`

- [ ] First test the exact schema from the normative design, enum checks,
  stage-specific nullability matrix, decimal bounds, foreign keys, uniqueness
  and forbidden columns.
- [ ] Extend the closed reason-code constraints of intents, attempts and
  transitions with the three append-only #51-D codes.
- [ ] Test base-empty migration, upgrade from 032, replay twice and downgrade
  assumptions (no destructive rewrite).
- [ ] Define `complete` and `findExact` only; no generic query or arbitrary
  JSON interface.
- [ ] Implement one transaction/statement that fences the intent and STARTED
  attempt, inserts the artifact, completes/abandons the attempt, appends both
  success transitions when applicable, terminalizes and releases the lease.
- [ ] Assert `terminal_at=reconciliation_completed_at=commit_at` and
  `purge_after=commit_at+4h` for every result because no send capability exists.
- [ ] Test loss of ACK, exact recovery, artifact conflict, lease expiry, ABA,
  immutable mismatch and hostile database rows.
- [ ] Extend purge accounting and delete the artifact cohort before attempts
  and intents while preserving the tombstone.

Run red/green:

```bash
npx tsx --test \
  tests/execution-simulation-migration.test.ts \
  tests/execution-simulation-repository-contract.test.ts \
  tests/execution-simulation.repository.test.ts \
  tests/execution-retention.test.ts
```

Commit:

```bash
git add migrations/033_execution_simulation_artifacts.sql src/ports \
  src/storage tests scripts
git commit -m "feat: persist atomic simulation-only outcomes (#51)"
```

## Task 3: Extract reusable causal quote math

**Files:**

- Create or modify a pure Pump.fun quote module under
  `src/launchpads/pumpfun/`
- Modify `src/paper/pumpfun-paper-quote.provider.ts` to delegate
- Modify PumpSwap quote/state helpers only as needed
- Create `tests/execution-quote-math.test.ts`
- Preserve all current paper quote tests

- [ ] Write comparison tests proving the extracted Pump.fun computation is
  byte-for-byte equivalent to current paper quotes.
- [ ] Add a single-snapshot input containing all accounts needed by quote and
  build; require one exact slot.
- [ ] Test dynamic fee tiers, mayhem/cashback state, real/virtual reserves,
  reverse SELL after BUY and insufficient real quote reserves.
- [ ] Test `effectiveQuoteReserves` for PumpSwap buy/sell math even though the
  executor exposes only SELL PumpSwap.
- [ ] Detect SPL Token/Token-2022 and validate the versioned extension
  allowlist without accepting unknown TLV.
- [ ] Keep all financial calculations in bigint/BN and use decimal conversion
  only at the SDK boundary.

Run:

```bash
npx tsx --test \
  tests/pumpfun-paper-quote.provider.test.ts \
  tests/pumpswap-quote.provider.test.ts \
  tests/execution-quote-math.test.ts
```

Commit:

```bash
git add src/launchpads src/markets src/paper tests
git commit -m "refactor: share causal Pump quote calculations (#51)"
```

## Task 4: Implement the provider-affine RPC session

**Files:**

- Create: `src/executor-simulation/provider-session.ts`
- Create: `src/ports/execution-market-gateway.ts`
- Create: `tests/executor-simulation-provider.test.ts`

- [ ] Start with a scripted JSON-RPC server/fetch test, not a live endpoint.
- [ ] Expose only genesis, one contextual multi-account snapshot,
  latest-blockhash-with-context, fee-for-message-with-context and simulation
  operations; all post-snapshot calls carry `minContextSlot`.
- [ ] Pin one positional provider for an attempt; prohibit mid-attempt
  failover and automatic retry.
- [ ] Count every dispatched request and enforce the configured cap.
- [ ] Propagate AbortSignal and enforce a bounded timeout per request.
- [ ] Normalize 429, timeout, transport, malformed JSON and genesis mismatch
  without retaining URL, headers, response body or provider messages.
- [ ] Validate commitment, context slot, canonical integers and bounded base64
  account payloads.

Run:

```bash
npx tsx --test tests/executor-simulation-provider.test.ts
```

Commit:

```bash
git add src/executor-simulation/provider-session.ts \
  src/ports/execution-market-gateway.ts tests/executor-simulation-provider.test.ts
git commit -m "feat: add provider-affine simulation RPC session (#51)"
```

## Task 5: Route venues and build official instruction plans

**Files:**

- Create: `src/storage/execution-venue.repository.ts`
- Create: `src/executor-simulation/venue-router.ts`
- Create: `src/executor-simulation/pumpfun-adapter.ts`
- Create: `src/executor-simulation/pumpswap-adapter.ts`
- Create adapter and venue repository tests

- [ ] Test BUY always routes Pump.fun and fails on complete curve.
- [ ] Test SELL selects active Pump.fun first, then PumpSwap only with a
  durable non-orphaned canonical migration/pool proof.
- [ ] Read all quote/build accounts in one contextual RPC request per venue.
- [ ] Build Pump.fun V2 with exact BN amounts and deterministic recipients
  selected from the on-chain official normal/reserved/buyback lists.
- [ ] Build PumpSwap SELL through SDK 1.19.0 with exact `baseAmountIn` and
  `minQuoteAmountOut`; inspect the recipients randomly selected internally by
  that SDK and require membership in the decoded on-chain lists.
- [ ] Do not use SDK helpers that transform a financial slippage `number`.
- [ ] Permit only the exact terminal WSOL `CloseAccount` and expected
  idempotent ATA instruction produced by PumpSwap 1.19.0; reject every
  `SyncNative`, auxiliary signer or other wrap/unwrap instruction.
- [ ] Test missing user ATA/funds as explicit simulation/build outcomes, never
  as an opportunity to generate a keypair.

Run:

```bash
npx tsx --test \
  tests/execution-venue.repository.test.ts \
  tests/executor-simulation-venue-router.test.ts \
  tests/executor-simulation-pumpfun.test.ts \
  tests/executor-simulation-pumpswap.test.ts
```

Commit:

```bash
git add src/storage/execution-venue.repository.ts src/executor-simulation tests
git commit -m "feat: build Pump execution plans from fresh quotes (#51)"
```

## Task 6: Inspect instructions and simulate an ephemeral v0 transaction

**Files:**

- Create: `src/executor-simulation/instruction-inspector.ts`
- Create: `src/executor-simulation/solana-simulation-gateway.ts`
- Create: `src/executor-simulation/build-receipt.ts`
- Create: `src/ports/execution-simulation-gateway.ts`
- Modify: builders, provider-affine session and execution market gateway port
- Create inspector/gateway/golden fixture tests

- [x] Generate sanitized golden instructions with the pinned official SDKs.
  Store public accounts and bytes only; document the SDK and IDL versions.
- [x] Decode every top-level instruction and validate exact programs,
  discriminators, amount bounds, fee payer, signer and writable metas.
- [x] Allow only expected ATA setup, `extendAccount` when the pool snapshot is
  shorter than the current SDK size, the Pump swap, and the exact terminal
  WSOL close; reject every other maintenance instruction.
- [x] Reject ComputeBudget priority price above zero, ALT, extra signer,
  unexpected writable, program, destination, authority or account.
- [x] Compile a v0 message with no lookup table and an explicit blockhash from
  `getLatestBlockhashAndContext`; assert one required signer matching the
  public executor address and one zeroed 64-byte signature slot.
- [x] Obtain fee estimate and reject absent/oversized values.
- [x] Request only the fee payer and expected token accounts in the simulation
  response; compare them to the causal pre-state and bound fee-payer lamport,
  base-token and quote-token deltas.
- [x] Call only `simulateTransaction` with `sigVerify:false`,
  `replaceRecentBlockhash:false`, `confirmed`, `minContextSlot` and inner
  instructions.
- [x] Bound and normalize error, logs, inner instructions, units and slots.
- [x] Return hashes/evidence only; never return or persist message,
  transaction, instruction bytes or signatures.

Run:

```bash
npx tsx --test \
  tests/instruction-inspector.test.ts \
  tests/executor-simulation-gateway.test.ts \
  tests/executor-simulation-golden.test.ts
```

Commit:

```bash
git add src/executor-simulation src/ports tests/fixtures tests
git commit -m "feat: inspect and simulate unsigned Pump transactions (#51)"
```

## Task 7: Orchestrate the simulation-only worker

**Files:**

- Create: `src/executor/simulation-worker.ts`
- Modify: `src/executor/config.ts`, `main.ts`, `runtime.ts`, logger allowlists
- Modify intent repository only where atomic completion requires it
- Create worker/config/runtime/integration tests

- [ ] Extend config with a discriminated union: existing `dry-run` shape stays
  unchanged; `simulation-only` requires public/RPC/gate values.
- [ ] Continue rejecting every private-key variable in both modes.
- [ ] Claim with `EXECUTE`, transition to PROCESSING, begin or recover the
  current attempt, then invoke quote/build/simulation once per pass.
- [ ] Derive every venue-specific builder input from the exact provider-owned
  `ExecutionAccountSnapshot`, compute its fingerprint internally, bind the
  returned plan to that snapshot object and reject caller-supplied policy or
  fingerprint evidence.
- [ ] Keep the `BuildReceiptAuthority` private to the trusted worker factory;
  issue its one-shot receipt only after that exact derivation and pass the same
  plan/snapshot objects to the simulation gateway.
- [ ] Renew the lease only at specified boundaries; authenticate abort errors
  with both typed code and `AbortSignal.aborted`.
- [ ] Commit success/failure atomically through the new repository.
- [ ] On unknown commit outcome, recover by exact artifact identity without
  repeating RPC.
- [ ] Ensure a recovered PROCESSING/STARTED intent is safe after crash and a
  terminal intent is never reclaimed.
- [ ] Log only event, mode, outcome, stable reason and positional provider.

Run:

```bash
npx tsx --test \
  tests/executor-config.test.ts \
  tests/executor-simulation-worker.test.ts \
  tests/executor-runtime.test.ts \
  tests/executor-main.integration.test.ts
```

Commit:

```bash
git add src/executor src/storage src/ports tests
git commit -m "feat: run terminal simulation-only execution attempts (#51)"
```

## Task 8: Harden the capability boundary

**Files:**

- Modify: `tests/helpers/execution-boundary.ts`
- Modify: `tests/executor-architecture.test.ts`
- Add targeted boundary fixtures/tests if useful

- [ ] Create an exact source/dist allowlist for the new graph.
- [ ] Permit `simulateTransaction` in exactly one audited file and nowhere
  else in the executor graph.
- [ ] Continue rejecting Keypair, Signer, wallets, secrets, sign/send/submit,
  computed acquisition, dynamic import, `src/execution`, paper, listener and
  Raydium.
- [ ] Test aliases, element access, destructuring, optional calls,
  `Reflect`/global escape paths and transitive compiled imports.
- [ ] Assert no serialized message/transaction columns or log keys exist.

Run source and compiled checks:

```bash
npx tsx --test tests/executor-architecture.test.ts
npm run build:backend
npx tsx --test tests/executor-architecture.test.ts
```

Commit:

```bash
git add tests/helpers/execution-boundary.ts tests/executor-architecture.test.ts
git commit -m "test: prove simulation executor cannot sign or send (#51)"
```

## Task 9: Documentation and operator contract

**Files:**

- Modify: `.env.example`, `README.md`, `docs/architecture/pumpfun-v1.md`
- Modify: `docs/system-overview.html`
- Modify docs-check expectations where necessary

- [ ] Document both modes, public-key-only setup, SOL funding for BUY/fees/rent,
  base-token funding for SELL, audited ATA creation/WSOL close and secret
  rejection.
- [ ] State that #49 is skipped/not PASS and #51-E/F/G remain mandatory.
- [ ] State that a successful simulation-only intent is terminal and can never
  be signed later.
- [ ] Explain RPC pinning, genesis, no failover/retry and non-signable artifact.
- [ ] Keep the HTML Bootstrap document consistent and regenerate no unrelated
  content.

Run:

```bash
npm run docs:check
npm run lint:backend
```

Commit:

```bash
git add .env.example README.md docs scripts tests
git commit -m "docs: explain executor simulation-only safety (#51)"
```

## Task 10: Full verification and delivery

- [ ] Inspect `git diff --check`, status and diff against `origin/main`.
- [ ] Start an isolated PostgreSQL database; never use or destroy an unknown
  operator database.
- [ ] Run migrations on empty DB, replay, and upgrade fixture through 032.
- [ ] Run all mandatory commands:

```bash
npm run build
npm run check
npm run lint
npm run docs:check
TEST_DATABASE_URL=postgresql://... npm test
npm run frontend:e2e
```

- [ ] Run an executor compiled integration test against scripted RPC only.
- [ ] Run a secret scan and architecture graph scan on source and `dist`.
- [ ] Request one local independent review and address confirmed issues.
- [ ] Push branch and open a PR referencing #51-D, with explicit safety and
  skipped-#49 statements.
- [ ] Execute exactly three GitHub review requests/correction cycles, never a
  fourth; resolve all blocking threads and keep CI green.
- [ ] Merge only after all checks and threads are clear, then verify merge/head
  ancestry in `origin/main` and update issue #51.

Suggested PR title:

```text
feat: simulate unsigned Pump execution intents (#51)
```

The PR must state that it adds no secret, signer, submission, live mode or
authorization for a real transaction.

# Bounded block payload codec implementation plan

> **For agentic workers:** Use subagent-driven-development task-by-task. One combined spec/quality review cycle for this PR, as requested by the user; fix findings and verify without starting additional review rounds.

**Goal:** Retain complete blocks more efficiently without changing transaction meaning, cache limits or RPC admission.

**Architecture:** A pure Node codec encodes serialized V8 bytes into immutable versioned text and decodes one selected transaction. Snapshot owns the block compression budget; cache lifecycle remains unchanged.

**Tech Stack:** TypeScript strict ESM, node:test, crypto SHA-256, V8, zlib level1; existing PostgreSQL integration gates.

Spec: [v1.0.0](../specs/2026-10-02-bounded-block-payload-codec-design.md), committed `28ba7f1` before implementation. Existing linked worktree `qualification-terminal-attribution`, branch `investigate/block-payload-size`, clean baseline: 69 locator/cache tests pass, zero skips.

## Execution evidence — 2026-10-02

- Task 1 delivered in `ef720c5`: initial RED, expanded 50 expected failures,
  then 54/54 codec tests on host and pinned Node22, backend check/scoped lint.
- Task 2 delivered in `d2efd18`: 4 expected integration failures, then 128/128
  focused tests without skips, backend check/scoped lint; full build passes.
- Task 3 offline proof passes on both runtimes for all 4,220 transactions,
  exact accounting, one fake block fetch per block and 4,217 cache hits.
  Build/check/lint/docs checks pass. Full suite: 4,077 backend PostgreSQL and 169
  frontend tests pass, zero failures/skips. See measurement results v1.1.0.
- Task 4 unique independent combined review completed without blocking findings;
  independently re-ran 54 codec and 74 locator/cache tests. Suggested future
  corrupt-entry injection test is nonblocking; existing codec corruption tests
  and unchanged cache catch/eviction path were inspected. No second review cycle.
  Required CI/merge/post-merge verification remain pending.

## Task 1 — Pure codec, RED then GREEN

Create `src/solana/rpc/block-transaction-payload-codec.ts` and
`tests/block-transaction-payload-codec.test.ts`; do not modify integration yet.

- [ ] Define these API contracts in tests, initially with throwing stubs only:

```ts
export const MAX_COMPRESSED_TRANSACTION_BYTES = 1_048_576;
export const MAX_BLOCK_COMPRESSION_INPUT_BYTES = 33_554_432;
export class BlockTransactionPayloadCodecError extends Error {}
export function encodeBlockTransactionPayload(
  serialized: Uint8Array, remainingCompressionBytes: number,
): Readonly<{ payload: string; compressionInputBytes: number }>;
export function decodeBlockTransactionPayload(payload: string): unknown;
```

`compressionInputBytes` is original byte count if deflate was attempted, otherwise
zero. Reject invalid budget (negative/non-safe-integer/>block limit); no mutable
global budget. Encoding receives bytes from one `serialize(normalized)` call.
Public byte input allows exact boundary tests without a test-only production API.

- [ ] Begin with an executable lossless test and observe its assertion fail:

```ts
const value = { slot: 42n, bytes: new Uint8Array([0, 255]), logs: ['x'.repeat(4096)], error: null };
const encoded = encodeBlockTransactionPayload(serialize(value), MAX_BLOCK_COMPRESSION_INPUT_BYTES);
assert.match(encoded.payload, /^b1:d:/u);
assert.deepEqual(decodeBlockTransactionPayload(encoded.payload), value);
```

- [ ] Add table tests: zero remaining budget => raw; exact budget consumed;
  attempted incompressible payload consumes budget even when raw wins; exact
  1MiB bytes compress, 1MiB+1 remains raw. Use `randomBytes` for incompressible
  bytes; decode only valid serialized objects. Mutation of returned typed arrays
  must not affect the next decode.
- [ ] Add corrupt-envelope tests using actual serialized fixtures: unknown tags,
  noncanonical lengths/base64, invalid hash, truncated deflate, declared size too
  small/large, output exceeding declared bound, over-1MiB compressed declaration,
  and a different valid compressed value under the original hash. Assert only
  fixed `BlockTransactionPayloadCodecError`, no payload or causes in messages.
- [ ] Run `node --import tsx --test tests/block-transaction-payload-codec.test.ts`;
  record expected RED failures before implementing each behavior.
- [ ] Implement tagged format exactly as spec. Validate structural/length limits
  before allocation, canonical base64 by round-trip, inflation output bound,
  decoded length and hash before deserialize. Both raw and compressed tags
  include length/hash. Do not add external packages, RPC, logs or configuration.
- [ ] Repeat codec tests GREEN; run `npm run check:backend` and
  `npx eslint src/solana/rpc/block-transaction-payload-codec.ts tests/block-transaction-payload-codec.test.ts`.
- [ ] Commit only the two owned files after parent inspection.

## Task 2 — Snapshot/cache integration and regressions

Modify `src/solana/rpc/transaction-locator.ts`,
`src/solana/rpc/block-transaction-cache.ts`,
`tests/block-transaction-cache.test.ts`, `tests/transaction-locator.test.ts`.

- [ ] First add failing integration assertions using existing `entry`, `block`,
  `harness` helpers. Populate a deterministic repeated-log block whose baseline
  V8/base64 size is >8MiB, then assert actual default cache retains it and a second
  signature locate performs no second RPC. Compute baseline independently from
  `normalizeTransaction`/V8; do not claim wire size equals baseline retained size.
- [ ] Add exact new accounting assertion:

```ts
assert.equal(snapshot.bytes, 64 + snapshot.transactions.reduce((sum, tx) =>
  sum + Buffer.byteLength(tx.signature, 'utf8') + (tx.payload?.length ?? 0) + 32, 0));
```

  Verify decoded payloads preserve order, fields and confirmation semantics.
  Test exact entry/global boundary and one-byte-under budget (thus overflow),
  incompressible genuine oversize and same-flight callers. Keep old tests enabled.
- [ ] Prove block compression-input exhaustion with enough <=1MiB serialized
  transactions: sum declared original lengths of attempted compressed/raw payloads
  is within 32MiB; later eligible payload remains raw. Include an incompressible
  attempted payload to prove it consumes budget. No injected higher limits.
- [ ] Run focused tests and record RED before modifying source.
- [ ] Integration in snapshot, initially `remaining = MAX_BLOCK_COMPRESSION_INPUT_BYTES`:

```ts
const encoded = encodeBlockTransactionPayload(serialize(normalized), remaining);
remaining -= encoded.compressionInputBytes;
payload = encoded.payload;
```

  Cache decode replaces the current direct deserialize in the existing try/catch:

```ts
normalized = decodeBlockTransactionPayload(selected.payload) as NormalizedTransaction;
```

  Keep error branding/eviction, isolation, duplicate/null handling, metrics,
  lifecycle/epoch/generation, RPC queue and limits unchanged. Remove only imports
  made unused by these substitutions.
- [ ] Run codec/cache/locator suites GREEN, then backend check/scoped lint/diff.
  Existing v1, ALT, malformed unrelated transaction, clear/close, epoch and
  admission tests must still pass; no reset or edits in dirty root main.
- [ ] Commit explicit integration files, no unrelated staging.

## Task 3 — Offline actual-code proof and full gates

- [ ] Build with `npm run build`, run `npm run check`, `npm run lint`,
  `npm run docs:check`. No new dependency or lockfile edits expected.
- [ ] Adapt an outside-Git verification script, not the original measurement
  harness whose interpretation is baseline-format-specific. Read existing
  `/tmp/sol-listener-block-capture-eQcNl1` only, verify manifest size/hash, convert
  with installed Connection fake fetch and use compiled new snapshot/decoder.
  Compare each decoded transaction against independent normalizeTransaction of
  the converted entry at the same index/status. Reject any mismatch or omission.
  No RPC, root env or wallet reads. Capture aggregate sizes, elapsed phases and RSS.
- [ ] Repeat under exact pinned Node22 image, one ephemeral readonly/no-network
  container with 768MiB memory/no swap and one CPU, same restricted mounts as the
  measurement protocol. An OOM/failure is evidence, not permission to raise caps.
- [ ] Check free disk before/during heavy tests; at <=5e9 bytes pause writes and
  safely clean disposable task artifacts only. One disposable PostgreSQL instance
  max; set both test DB URLs for full repository test run so DB/role tests do not
  silently skip. Preserve logs; remove only verified task DB after gates.
- [ ] Run `npm test` and require backend+frontend zero failures/skips. Record exact
  totals and exit statuses. Run integration migration/deployment checks required
  by CI, without changing credentials or real databases.

## Task 4 — One review, CI and delivery

- [ ] Request one independent combined specification/code review over production
  and tests. Fix findings with demonstrated regressions; do not initiate a second
  review cycle. Version any material design amendment before its implementation.
- [ ] Record aggregate actual-code results and limitations in docs/tracking.
  Open one scoped PR linked to #171/#120 (reuse an existing matching issue if one
  exists); include baseline evidence, limits unchanged, test proof and risks.
- [ ] Merge only after required green checks and resolved blocking findings,
  without admin bypass. Verify post-merge CI. Keep full trade goal open.
- [ ] Next: separately resolve measurement-clock/cohort and Pump instruction
  suffix blockers, then run the 15-minute canary. No wallet/arm/trade in this PR.

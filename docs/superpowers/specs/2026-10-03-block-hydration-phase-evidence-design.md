# Block hydration phase evidence — design v1.0.0

Issue: [#218](https://github.com/pivox/sol-token-listener/issues/218).
Base: `main@1bc3f1e96b63e94b7d8d35177f0f06ed7e51f070`.
This is a telemetry-only slice of the [classification capacity design](2026-10-03-classification-throughput-capacity-design.md). It does not raise concurrency, change RPC requests or cache admission, accept the unknown Pump.fun `TradeEvent` suffix (#215), or enable a wallet or transaction.

## Decision and alternatives

The five-minute profiled observe-only probe on the unchanged #222 runtime had zero HTTP 429 but classification pending rose from 240 at T+2 to 1,437 at T+5. A sampled Node 25/macOS CPU profile implicated Solana response validation/base58 decoding as well as local snapshot/compression. Sampling, changing live workload, and profiler overhead prevent a causal throughput conclusion. The existing HTTP sidecar measures time to response headers only.

The Helius operator screenshot shows the Free plan and 122,048 of 1,000,000 credits used. [Helius pricing](https://www.helius.dev/pricing) lists 10 RPC requests/s for Free, but neither source establishes this project's effective overrides, concurrency, or a numeric exit reserve. More RPC lanes therefore remain blocked. Changing the full-block cache to materialize only currently requested signatures could add RPC requests for later cache hits and is also rejected without proof. The selected next step is bounded phase timing at the existing single physical block-fetch boundary.

## Contract and ownership

Add an optional sibling `blockHydrationPhaseEvidence` V1 to the existing listener heartbeat JSONB and `/api/v1/health` projection. Disabled hydration and old heartbeats project as `null`; while hydration is enabled but no physical fetch has started, the optional sidecar is absent and likewise projects as `null`. Malformed stored evidence fails projection closed. The existing exact-shape `blockHydration` V1, `rpcHttpEvidence` V1, `rpcHttpRoleEvidence` V1, and the 19-gate canary manifest/verdict remain unchanged. The sidecar never turns a FAIL or INCONCLUSIVE verdict into PASS.

The immutable, exact-key V1 shape is:

```text
{ version: 1, overflowed: boolean,
  rpc: PhaseCounters,
  snapshot: PhaseCounters }
PhaseCounters = {
  started: nonnegative safe integer,
  completed: nonnegative safe integer,
  failed: nonnegative safe integer,
  inFlight: nonnegative safe integer,
  maxInFlight: nonnegative safe integer,
  settledLatencyBuckets: 10 nonnegative safe integers,
  maxSettledLatencyMs: nonnegative safe integer }
```

The ten fixed duration buckets are `<=50`, `<=100`, `<=250`, `<=500`, `<=1_000`, `<=2_500`, `<=5_000`, `<=10_000`, `<=30_000`, and `>30_000` milliseconds, matching the existing HTTP role sidecar. `started = completed + failed + inFlight` for each phase unless saturation marks `overflowed`; the bucket sum equals `completed + failed` without overflow. The collector saturates counters at `Number.MAX_SAFE_INTEGER`, sets `overflowed`, and never wraps. No provider URL, slot, signature, mint, error message, request/response body, or credential enters this shape.

`rpc` starts immediately before the existing `getBlockTransactions` call and settles when that awaited call returns or throws. It therefore includes HTTP headers, response-body transfer, JSON parsing and Web3.js conversion together; it is **not** body-only time. `snapshot` starts immediately before `snapshotBlockTransactionData` and settles on return or throw; a `null` result is a failure. A separate monotonic `performance.now()` measurement clock avoids changing cache TTL/admission clock semantics. No extra RPC, timeout, timer, queue, concurrency lane, or retained block is created. Telemetry failure must not replace the original locator outcome.

This V1 is an aggregate over the current cache lifetime. A provider failover can mix providers: `epochInvalidations > 0` in the existing hydration metrics makes per-provider interpretation INCONCLUSIVE. The existing provider/role HTTP sidecar remains the source for provider attribution. Header and `rpc` samples cannot be subtracted individually because they are not joined by request ID. A five-minute diagnostic may compare aggregate distributions only, with workload and platform caveats. In-flight response bytes and true peak RSS remain outside this contract and must be evidenced separately before a concurrency change.

## Validation and rollout

RED/GREEN tests cover histogram boundaries, success, RPC rejection, `null` snapshot, in-flight RPC state, saturation, malformed persistence/projection, disabled/old heartbeat, failover caveat, and unchanged cache fetch/retention semantics. The sidecar is frozen and strictly validated at heartbeat acceptance, PostgreSQL storage, and API projection. It is additive and needs no SQL migration.

Build, TypeScript check, lint, docs check, focused and full tests, one external review cycle, and green PR plus post-merge CI precede a short exact-merge observe-only diagnostic. The diagnostic preserves the existing single-lane rate, private aggregate retention and 5 GB disk guard. It is not a 15-minute canary. H2e project-specific capacity, an exit reserve, #215, the full 19-gate canary, H2c, wallet and explicit terminal authorization remain mandatory before any real trade.

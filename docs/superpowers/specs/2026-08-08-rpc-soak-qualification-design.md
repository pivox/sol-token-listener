# RPC soak qualification design

## Purpose

Issue #29 needs a safe way to qualify dedicated Solana HTTP and WebSocket
endpoints before they are used by the continuous Pump.fun listener. Provider
credentials remain deployment secrets. The repository supplies a bounded,
read-only measurement tool and a stable evidence contract; it does not select,
purchase or configure a provider account.

## Boundary

The soak tool is separate from the production listener. It does not open
PostgreSQL, enqueue transactions, fetch transaction bodies, simulate, sign or
submit anything. It reads confirmed slots over HTTP and observes Pump.fun and
PumpSwap log notifications over WebSocket.

```text
SOLANA_HTTP_RPC_URL -> bounded getSlot samples -> HTTP evidence
SOLANA_WS_RPC_URL   -> two read-only onLogs subscriptions -> WS evidence
                                                      \-> rpc-soak.v1 report
```

Production listener behavior and API V1 remain unchanged in this PR.

## Pure runner

`src/solana/rpc/rpc-soak.ts` owns the report contract and aggregation. It
depends on an injected transport, clock and wait function so tests never use
network or wall-clock delays.

Configuration is integer-only:

- duration: 5,000 to 3,600,000 ms;
- interval: 250 to 60,000 ms;
- computed sample count: 2 to 10,000.

The runner subscribes first, samples immediately, waits between samples, then
closes both subscriptions. It records no signatures or endpoint identifiers.
HTTP latencies are non-negative integer milliseconds and percentiles use the
deterministic nearest-rank rule.

The frozen `rpc-soak.v1` report contains:

- configured and observed duration;
- HTTP attempted/succeeded/failed/rate-limited counts;
- min, p50, p95 and max latency;
- first and last confirmed slots as decimal strings;
- WebSocket subscription state;
- total, Pump.fun and PumpSwap observation counts;
- first and last observed slots as decimal strings;
- verdict and stable reason codes.

## Transport adapters

The HTTP adapter sends one JSON-RPC `getSlot` request per sample through
`fetch`. It validates HTTP status and the JSON-RPC envelope without retaining a
response body. HTTP 429 becomes `RPC_RATE_LIMITED`; other transport/status
failures become `RPC_REQUEST_FAILED`; malformed successful responses become
`RPC_RESPONSE_INVALID`.

The WebSocket adapter uses the existing Solana `Connection` and the canonical
Pump.fun/PumpSwap program IDs. Its callback forwards only the program family
and slot. Cleanup removes both listener IDs and fails explicitly if either
unsubscribe fails.

Errors expose only fixed codes and messages. URLs, headers, response bodies,
signatures and provider error text never enter the report or logs.

## Verdict

- `FAIL`: no successful HTTP sample, WebSocket subscription failure or cleanup
  failure;
- `DEGRADED`: partial HTTP failure, any 429, no confirmed-slot progress, or no
  WebSocket observation for one or both programs;
- `PASS`: all HTTP samples succeed, the slot progresses, both subscriptions
  remain active and both programs produce at least one observation.

The CLI exits 0 for `PASS`, 2 for `DEGRADED`, and 1 for `FAIL` or invalid
configuration. A degraded report is still printed as evidence.

## CLI and documentation

`npm run rpc:soak` reads the existing safe RPC variables plus:

- `RPC_SOAK_DURATION_SECONDS` (default 60);
- `RPC_SOAK_INTERVAL_MS` (default 1,000).

The command prints exactly one JSON report to stdout. Human guidance lives in
`docs/operations/rpc-qualification.md` and explains that provider-side quota
dashboards remain authoritative for billing or compute-unit consumption.

## Verification

- red/green unit tests cover bounds, timing, percentiles and verdicts;
- transport tests cover 429, malformed JSON-RPC, redaction, two program
  subscriptions and cleanup;
- CLI configuration tests require no endpoint values in fixtures or output;
- safety tests prove no database, signing or transaction submission import;
- build, generated-IDL check, lint, documentation check and the full
  PostgreSQL test suite pass before review.


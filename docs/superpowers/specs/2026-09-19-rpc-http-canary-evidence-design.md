# RPC HTTP Canary Evidence Design

Version: 1.0.0  
Status: approved for implementation under the standing operator instruction  
Issue: #142, part 1 of #140

## Goal

Make the Mainnet observe-only canary able to prove how many physical Solana
RPC HTTP requests were attempted and how many returned the real HTTP status
`429`. The evidence must remain bounded, durable through the existing listener
heartbeat, redacted, and backward-compatible.

This change measures observation infrastructure only. It does not change RPC
pacing, provider promotion, catch-up admission, transaction construction,
signing, wallet handling, or submission.

## Problem

The listener currently redacts transport failures before they reach health
projections. An absence of `429` in logs therefore cannot prove that no HTTP
429 occurred. Logical failover events are also insufficient: one logical RPC
operation can perform several physical HTTP attempts, and counting at both
layers would double count.

The canary needs evidence from the physical `fetch` boundary, before response
bodies are consumed and before errors are mapped to redacted categories.

## Scope

The collector covers every Solana RPC HTTP read used by the production
observe-only listener:

- the main `SolanaRpcClient` with no fallback;
- every physical attempt made by its HTTP failover transport;
- provider-pinned block hydration;
- provider-pinned catch-up page reads;
- provider-pinned genesis checks;
- provider-pinned finality reads.

The following are deliberately excluded:

- metadata and social HTTP requests, which are not Solana RPC capacity;
- executor readiness, simulation, recovery, and live transports, whose H2e/H2c
  evidence is evaluated separately;
- diagnostic and soak-only transports;
- JSON-RPC error code `429` inside an HTTP `200` response. It remains an RPC
  error but is not an HTTP 429;
- provider billing or private dashboard metrics.

## Considered approaches

### Count logical RPC calls

Rejected. It misses retries and fallback attempts and cannot observe a 429
before redaction.

### Wrap a global fetch once

Rejected. Provider identity is not reliably available at a process-global
boundary, and wrapping both the global fetch and failover would double count.

### Instrument every physical fetch with one shared collector

Selected. The failover loop records its dynamic provider immediately before
each underlying fetch. Mono-provider connections use a small provider-bound
fetch wrapper. No physical fetch is wrapped twice.

## Domain contract

Add a listener-internal `RpcHttpEvidenceRecorder` with only these operations:

```ts
interface RpcHttpEvidenceRecorder {
  recordAttempt(providerId: RpcProviderId): void;
  recordHttp429(providerId: RpcProviderId): void;
  snapshot(configuredProviderIds: readonly RpcProviderId[]): RuntimeRpcHttpEvidenceV1;
}
```

The recorder never receives a URL, request, response, method, body, signature,
mint, header, or error object.

The immutable snapshot is versioned and has fixed cardinality:

```ts
interface RuntimeRpcHttpProviderEvidenceV1 {
  providerId: RpcProviderId;
  configured: boolean;
  attempts: number;
  http429Responses: number;
}

interface RuntimeRpcHttpEvidenceV1 {
  version: 1;
  overflowed: boolean;
  providers: readonly [
    RuntimeRpcHttpProviderEvidenceV1,
    RuntimeRpcHttpProviderEvidenceV1,
    RuntimeRpcHttpProviderEvidenceV1,
    RuntimeRpcHttpProviderEvidenceV1,
  ];
}
```

The entries are always ordered as `primary`, `fallback-1`, `fallback-2`, and
`fallback-3`. Unconfigured providers remain present with `configured=false`
and zero counters. For every configured provider,
`0 <= http429Responses <= attempts`.

Counters use safe JavaScript integers because they are operational counts, not
financial values. They saturate at `Number.MAX_SAFE_INTEGER`; saturation sets
`overflowed=true` permanently. Overflow is incomplete evidence and can never
support a reassuring zero.

The existing heartbeat `startedAt` identifies the listener process interval.
No new UUID, URL-derived identifier, or high-cardinality label is introduced.

## Recording semantics

An attempt is recorded after all local abort/precondition checks and
immediately before invoking the physical fetch. A synchronous throw or network
rejection still counts as an attempt.

An HTTP 429 is recorded immediately after a `Response` is returned and before
body consumption, body cancellation, failover cooldown, SDK parsing, or error
redaction. A body that later blocks or fails cannot erase the 429 evidence.

An abort before fetch records nothing. An abort after a response records the
attempt and records the 429 when applicable.

The failover transport records directly inside its physical-attempt loop. Its
underlying fetch is not wrapped by the mono-provider wrapper. Provider-pinned
and no-fallback connections use the provider-bound wrapper exactly once.

## Wiring

`createProductionListenerRuntime` constructs one recorder after creating the
provider catalogue. The same instance is injected into the main RPC client and
all provider-pinned block, catch-up, genesis, and finality factories.

Factories retain their existing default behavior when no recorder is supplied,
so fixtures and non-production composition remain backward-compatible. Strict
dependency validators continue to reject unexpected fields; instrumentation is
passed through an explicit typed parameter rather than smuggled into hostile
dependency records.

## Persistence and public contract

`RuntimeHeartbeat` gains an optional `rpcHttpEvidence` version-1 snapshot.
`PersistentListenerHeartbeat` obtains a fresh detached snapshot on every write,
and `listener_heartbeats.payload` persists it with the other runtime metrics.

The public `/api/v1/health` heartbeat projection exposes only the fixed fields
defined above. During rolling deployment or when reading a historical
heartbeat, absence is projected as `null` or omitted according to the existing
compatibility convention; it is never synthesized as zero.

The frontend schema accepts both old and new payloads. The diagnostic health
page shows availability, overflow, and the four fixed provider counters. It
does not display endpoint URLs or arbitrary labels.

No PostgreSQL schema migration is needed for this part because heartbeat
metrics are already stored in versioned JSON payloads.

## Canary verdict

The operator captures redacted health snapshots at T0, T+5 minutes, T+15
minutes, and after bounded shutdown. A PASS for the HTTP 429 gate requires:

- the same heartbeat `startedAt` at every sample;
- evidence present at every sample and in the final persisted heartbeat;
- identical configured-provider membership throughout the window;
- `overflowed=false` throughout;
- a strictly positive aggregate attempt delta;
- an aggregate HTTP-429 delta equal to zero.

Any positive 429 delta is FAIL. Overflow, restart, missing evidence, missing
final snapshot, counter regression, provider-membership drift, or an impossible
counter relation is INCONCLUSIVE unless an already observed 429 independently
forces FAIL. A zero-attempt window is INCONCLUSIVE.

The latency gate remains unavailable until #143 adds immutable first-processing
evidence. Therefore #142 alone cannot make the whole canary PASS.

## Errors and security

Instrumentation must never make an RPC request fail. Recorder methods are
owned internal objects with synchronous non-throwing production behavior.
Tests still validate strict inputs and immutable snapshots.

No logs include URLs, API keys, headers, RPC bodies, signatures, mints, or
responses. Public evidence contains only fixed provider IDs and bounded counts.

## Tests

Tests must prove:

- exact four-provider ordering, immutable detached snapshots, configured flags,
  monotonic counters, saturation, overflow, and invalid-provider rejection;
- no-fallback requests record one physical attempt and a real HTTP 429;
- failover records each provider attempt exactly once and does not double count;
- abort before fetch records nothing;
- a 429 is retained when body consumption or cancellation later fails;
- block, catch-up page, genesis, and finality transports share the recorder;
- heartbeat storage snapshots rather than retaining caller-owned data;
- old heartbeat payloads still decode and project evidence as unavailable;
- API and frontend reject extra/high-cardinality fields and expose no secret;
- the runbook classifies zero traffic, restart, overflow, missing final evidence,
  positive 429, and clean monotonic evidence correctly.

## Acceptance

- every in-scope physical Solana RPC fetch is counted exactly once;
- every in-scope real HTTP 429 is counted before redaction;
- no JSON-RPC code or logical failover event is miscounted as HTTP 429;
- heartbeat/API/frontend changes are additive and rolling-deploy compatible;
- evidence stays bounded and secret-free;
- observe and paper behavior is unchanged;
- no wallet, private key, signing, transaction construction, or submission path
  is introduced or enabled.

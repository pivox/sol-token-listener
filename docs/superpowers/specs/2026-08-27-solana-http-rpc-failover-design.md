# Solana HTTP RPC failover design

Date: 2026-08-27
Issue: #56
Version: 1.0.2
Status: approved through the standing instruction to use the recommended option

Revision 1.0.2: only HTTP-success responses update the sticky endpoint;
endpoint fragments are forbidden because they are not transmitted in HTTP
requests.

## Purpose

Issue #56 must keep the Pump.fun observation pipeline usable when one Solana
HTTP RPC endpoint is temporarily rate-limited or unavailable. The change is a
bounded transport fallback, not a provider-selection system and not evidence
that the 50-position Mainnet paper validation in issue #49 has run.

The listener remains strictly `observe` or `paper`. This work adds no wallet,
signer, private key, transaction construction or submission capability.

## Scope and boundary

The production listener currently creates one `@solana/web3.js` `Connection`.
That object serves every HTTP consumer and also owns the independently
configured WebSocket session. Issue #56 changes only the HTTP fetch function
in that existing connection:

```text
web3.js JSON-RPC request
          |
          v
bounded rotating HTTP fetch
  primary -> fallback-1 -> fallback-2 -> fallback-3
          |
          v
existing catch-up, locator, finality, market and health consumers
```

`SOLANA_WS_RPC_URL`, the program subscriber and `rpc:soak` remain
mono-endpoint and behaviorally unchanged. In particular, this PR makes no
claim of lossless WebSocket reconnection. Acknowledged WebSocket sessions,
disconnect health and strict recovery belong to issue #57.

## Approaches considered

### Inject one rotating fetch into the existing Connection — selected

`ConnectionConfig.fetch` is the narrowest shared boundary for production HTTP
traffic. It automatically covers wrapped methods such as `getTransaction` and
`getSlot`, plus direct uses of `rpc.http` for catch-up and market account reads.
It does not alter the WebSocket endpoint.

### Wrap every RPC method behind a new application port — rejected

This would require adapting every current and future `Connection` method and
would easily miss direct `rpc.http` consumers. It is a broader refactor with no
additional V1 safety benefit.

### Route between multiple Connection instances — rejected

Each `Connection` also owns WebSocket state. Selecting among several instances
would couple HTTP failover to subscriptions and create ambiguous connection
lifecycle ownership before issue #57 defines that behavior.

## Configuration contract

The existing `SOLANA_HTTP_RPC_URL` remains mandatory and is the primary
endpoint. A new optional `SOLANA_HTTP_RPC_FALLBACK_URLS` contains a
comma-separated ordered list of at most three fallbacks, for at most four HTTP
endpoints total.

Configuration parsing:

- trims list separators but rejects empty entries;
- accepts only absolute `http:` or `https:` URLs;
- requires all configured endpoints to use the same scheme, which preserves
  web3.js agent behavior and still supports HTTP-only local development;
- canonicalizes and rejects duplicates, including the primary endpoint;
- rejects primary and fallback URL fragments when failover is configured;
- never includes a configured URL in a validation error;
- freezes the resulting ordered endpoint list;
- preserves the existing single-endpoint `Connection` and its web3.js retry
  behavior when the fallback variable is absent.

Endpoint identities are positional and non-secret: `primary`, `fallback-1`,
`fallback-2`, and `fallback-3`. Provider names and URL-derived identifiers are
not accepted or logged.

The transport uses fixed V1 safety bounds rather than adding tuning variables:

- default cooldown after a transient network or gateway failure: 1,000 ms;
- maximum cooldown, including `Retry-After`: 60,000 ms;
- at most one attempt per configured endpoint for one logical request.

`RPC_RETRY_MAX_ATTEMPTS` and `RPC_RETRY_BASE_DELAY_MS` keep their existing
meaning: durable inbox retry policy. They do not configure transport rotation.

## Rotating transport

A focused module owns an ordered immutable endpoint set, an injected fetch,
an injected integer-millisecond clock, and an optional structured-event sink.
Its mutable state is limited to the sticky active endpoint and each endpoint's
cooldown deadline.

For each logical HTTP request:

1. validate that web3.js called the transport for the configured primary URL;
2. start with the most recently healthy endpoint;
3. inspect each eligible endpoint at most once, in circular configured order;
4. forward the original request initialization, including method, headers,
   body and abort signal, without parsing or retaining the JSON-RPC body;
5. return immediately on a non-transient HTTP response, updating the sticky
   endpoint only when the HTTP response is successful;
6. on a transient failure, put that endpoint in cooldown and try the next
   eligible endpoint;
7. if no endpoint remains eligible, throw one fixed typed transport error.

Transient failures are deliberately closed and explicit:

- a network rejection, unless the caller signal is already aborted;
- HTTP `429`;
- HTTP `502`, `503`, or `504`.

HTTP `400`, `401`, `403`, other status codes, and JSON-RPC errors transported
inside HTTP `200` are returned to web3.js without rotation. Only an HTTP-success
response becomes sticky, so an authentication failure does not pin later
requests to that endpoint while HTTP `200` JSON-RPC responses remain healthy.
This prevents a fallback from hiding invalid credentials, malformed requests
or deterministic RPC errors. A `null` application result such as unavailable
archive history is also not a transport failure; existing durable retries
remain authoritative.

When at least one fallback is configured, the transport sets
`disableRetryOnRateLimit: true` on `Connection`. Otherwise web3.js would
perform its own 500/1,000/2,000/4,000 ms retry cycle independently for every
fallback endpoint. With no fallback, no rotating fetch is injected and the
existing web3.js rate-limit retry remains unchanged.

## Cooldown and concurrency

`Retry-After` is accepted as canonical non-negative delta-seconds or an RFC
9110 IMF-fixdate. Its computed delay is clamped to 60 seconds. A past date
produces a zero-millisecond cooldown. Missing or invalid values use the
one-second default. Network and supported 5xx failures also use the default
cooldown.

An aborted caller request fails immediately and does not rotate. When all
endpoints are cooling down, the transport does not sleep inside the request;
it returns the fixed exhaustion error so startup can fail closed or existing
durable jobs can schedule their normal retry.

JavaScript state updates are synchronous between awaits. The first completed
transient response opens the endpoint cooldown before later requests select
their next attempt. Requests already in flight may finish, but every logical
request remains bounded by the endpoint count. No global mutex serializes
unrelated RPC calls.

Discarded transient HTTP responses have their body cancelled on a best-effort
basis without reading or logging it. Cleanup failures do not replace the
transport result and cannot expose provider content.

## Observability and redaction

The module emits frozen structured events through an injected sink:

- `rpc.http_endpoint_degraded` with endpoint ID, fixed reason and cooldown;
- `rpc.http_failover` with source and destination endpoint IDs;
- `rpc.http_endpoints_exhausted` with the bounded attempted count.

Reasons are a stable closed set: `NETWORK`, `RATE_LIMITED`, `BAD_GATEWAY`,
`UNAVAILABLE`, and `GATEWAY_TIMEOUT`. Events contain no URL, hostname, headers,
request body, response body, thrown provider value or API key. Repeated
concurrent failures do not re-emit degradation while the same cooldown is
already active. The production factory maps these records to structured logs;
operational counters are log-derived in V1 from these stable fields. A metrics
backend can aggregate them later without changing this transport.

Public API and PostgreSQL schemas remain unchanged in issue #56.

## Integration

When the parsed list contains a fallback, `SolanaRpcClient` constructs the
rotating fetch and injects it into the one production `Connection`. The
existing primary URL remains the `Connection` endpoint so web3.js request
construction and its HTTP/HTTPS agent selection stay compatible. A list
containing only the primary uses the existing unmodified `Connection` setup.

The following production paths therefore receive the same fallback behavior:

- startup health and heartbeat slot reads;
- Pump.fun/PumpSwap catch-up history;
- transaction and block lookup;
- finality status and root reads;
- Pump.fun/PumpSwap account and reserve reads;
- the slot used to validate paper quote freshness.

The deterministic transaction-locator checks for signature and slot mismatch
remain unchanged and continue to reject inconsistent provider views.

## Testing

Tests use injected fetch, clock and event sink; they perform no network calls
or wall-clock sleeps.

Configuration tests cover:

- absent fallback preserving one endpoint;
- ordered valid fallbacks and exact maximum;
- whitespace, empty entries, duplicates and maximum plus one;
- invalid or mixed protocols;
- forbidden fragments when failover is configured;
- redacted errors and safe `.env.example` placeholders.

Transport tests cover:

- primary success and sticky fallback success;
- network rejection, 429, 502, 503 and 504 rotation;
- no rotation for abort, 400, 401, 403 or HTTP-200 JSON-RPC errors;
- canonical delta and HTTP-date `Retry-After`, invalid values and clamping;
- cooldown expiry, all-endpoint exhaustion and circular ordering;
- request method/header/body/signal preservation;
- bounded concurrent failures without a retry storm;
- response-body cleanup failure containment;
- hostile rejection values and complete URL/content redaction;
- fixed, frozen and deduplicated structured events.

Integration tests verify that `SolanaRpcClient` injects the transport with
web3.js rate-limit retries disabled while its HTTP methods and direct
`rpc.http` consumers remain compatible. Import-boundary tests continue to
prove that production observation code cannot sign or submit transactions.

Before review, `npm run build`, `npm run check`, `npm run lint`,
`npm run docs:check` and the complete PostgreSQL-backed test suite must pass.

## Operational documentation

`.env.example` documents the optional fallback list with empty placeholders.
The RPC operations guide explains ordered failover, supported failure classes,
the positional redacted IDs, cooldown bounds, and the continuing limitation of
the single WebSocket endpoint. It explicitly states that:

- fallback endpoints must be independently provisioned by the operator;
- the repository does not validate provider billing or quota dashboards;
- issue #49 remains unvalidated until an authorized field run exists;
- issue #57 is required before claiming controlled WebSocket failover.

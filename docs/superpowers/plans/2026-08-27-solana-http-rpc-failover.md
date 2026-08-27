# Solana HTTP RPC Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, observable HTTP RPC failover without changing the existing mono-endpoint behavior or any WebSocket path.

**Architecture:** Configuration keeps `SOLANA_HTTP_RPC_URL` as the primary and adds an ordered, validated fallback list. When fallbacks exist, one `Connection` receives a stateful rotating `fetch` that retries each endpoint at most once, applies bounded cooldowns, emits secret-free structured events, and delegates durable retries to the existing inbox. Without fallbacks, `Connection` construction is unchanged.

**Tech Stack:** TypeScript 5 strict ESM, Node.js 22 test runner, `@solana/web3.js` 1.98, Pino structured logging.

**Spec:** `docs/superpowers/specs/2026-08-27-solana-http-rpc-failover-design.md` version 1.0.3.

---

### Task 1: Versioned RPC endpoint configuration

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `tests/config-safety.test.ts`

- [ ] **Step 1: Write failing configuration tests**

Add focused tests asserting that absent/blank fallback configuration produces a frozen empty list, ordered URLs are canonicalized, duplicate or empty entries are rejected, four fallbacks are rejected, mixed HTTP/HTTPS schemes are rejected, and validation errors never disclose configured URLs.

```ts
const config = parseConfig({
  ...base,
  SOLANA_HTTP_RPC_FALLBACK_URLS: 'https://fallback-1.invalid,https://fallback-2.invalid',
});
assert.deepEqual(config.httpRpcFallbackUrls, [
  'https://fallback-1.invalid/',
  'https://fallback-2.invalid/',
]);
assert.equal(Object.isFrozen(config.httpRpcFallbackUrls), true);
```

- [ ] **Step 2: Verify RED**

Run: `node --import tsx --test --test-name-pattern='fallback HTTP RPC' tests/config-safety.test.ts`

Expected: FAIL because `httpRpcFallbackUrls` is not yet part of `AppConfig`.

- [ ] **Step 3: Implement the parser contract**

Add `readonly httpRpcFallbackUrls: readonly string[]` to `AppConfig`. Parse at most three comma-separated absolute HTTP(S) URLs, reject whitespace-only embedded entries, require the primary protocol for every endpoint, canonicalize with `URL#toString`, reject duplicates including the primary, freeze the returned array, and use fixed secret-free error messages. Add the safe optional entry:

```dotenv
SOLANA_HTTP_RPC_FALLBACK_URLS=
```

- [ ] **Step 4: Verify GREEN and regression safety**

Run:

```bash
node --import tsx --test --test-name-pattern='fallback HTTP RPC' tests/config-safety.test.ts
npm run check:backend
```

Expected: selected tests PASS and TypeScript check PASS.

- [ ] **Step 5: Commit**

```bash
git add .env.example src/config/env.ts tests/config-safety.test.ts
git commit -m "feat: validate HTTP RPC fallback endpoints (#56)"
```

### Task 2: Bounded rotating HTTP transport

**Files:**
- Create: `src/solana/rpc/http-failover-transport.ts`
- Create: `tests/http-failover-transport.test.ts`

- [ ] **Step 1: Write failing transport tests**

Define tests around the public factory below. Cover sticky success, network rejection, status 429/502/503/504 rotation, non-retryable 400, HTTP-200 JSON-RPC error pass-through, `Retry-After` delta/date parsing and 60-second clamp, all-endpoints-cooling exhaustion, response-body cancellation, abort pass-through, fixed endpoint identities, frozen event objects, and absence of URL/provider secrets.

```ts
const events: RpcHttpFailoverEvent[] = [];
const rpcFetch = createRpcHttpFailoverFetch({
  endpoints: [
    { id: 'primary', url: 'https://primary.invalid/' },
    { id: 'fallback-1', url: 'https://fallback.invalid/' },
  ],
  fetch: fakeFetch,
  now: () => now,
  onEvent: (event) => events.push(event),
});
```

- [ ] **Step 2: Verify RED**

Run: `node --import tsx --test tests/http-failover-transport.test.ts`

Expected: FAIL because `http-failover-transport.ts` does not exist.

- [ ] **Step 3: Implement the minimal typed transport**

Export the following closed contract:

```ts
export type RpcHttpFailureReason =
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'BAD_GATEWAY'
  | 'UNAVAILABLE'
  | 'GATEWAY_TIMEOUT';

export type RpcHttpEndpointId = 'primary' | `fallback-${1 | 2 | 3}`;

export type RpcHttpFailoverEvent = Readonly<
  | { event: 'rpc.http_endpoint_degraded'; endpointId: RpcHttpEndpointId; reason: RpcHttpFailureReason; cooldownMs: number }
  | { event: 'rpc.http_failover'; fromEndpointId: RpcHttpEndpointId; toEndpointId: RpcHttpEndpointId; reason: RpcHttpFailureReason }
  | { event: 'rpc.http_endpoints_exhausted'; attemptedEndpointIds: readonly RpcHttpEndpointId[] }
>;

export class RpcHttpEndpointsExhaustedError extends Error {
  readonly code = 'RPC_HTTP_ENDPOINTS_EXHAUSTED';
}

export function createRpcHttpFailoverFetch(options: Readonly<{
  endpoints: readonly Readonly<{ id: RpcHttpEndpointId; url: string }>[];
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  onEvent?: (event: RpcHttpFailoverEvent) => void;
}>): typeof globalThis.fetch;
```

Use per-endpoint `cooldownUntil`, a sticky cursor, one attempt per eligible endpoint, a default 1,000 ms cooldown, a 60,000 ms cap, and best-effort `response.body?.cancel()` before discarding transient responses. Rewrite only the request URL; preserve method, headers, body and signal. If `signal.aborted`, propagate the fetch rejection without degrading or rotating.

- [ ] **Step 4: Verify GREEN and quality**

Run:

```bash
node --import tsx --test tests/http-failover-transport.test.ts
npm run check:backend
npm run lint:backend
```

Expected: transport tests, type check and lint PASS.

- [ ] **Step 5: Commit**

```bash
git add src/solana/rpc/http-failover-transport.ts tests/http-failover-transport.test.ts
git commit -m "feat: add bounded HTTP RPC failover transport (#56)"
```

### Task 3: Production connection integration and observability

**Files:**
- Modify: `src/solana/rpc/rpc-client.ts`
- Modify: `src/application/production-listener-factory.ts`
- Create: `tests/rpc-client.test.ts`
- Modify: `tests/production-listener-factory.test.ts`

- [ ] **Step 1: Write failing integration tests**

Test that a config without fallbacks constructs the legacy `Connection` configuration, while a config with fallbacks injects a custom fetch and sets `disableRetryOnRateLimit: true`. Exercise a public RPC call against stubbed fetch endpoints and assert that a transient primary failure succeeds through the fallback. Assert that the production event sink logs event fields but no URL.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --import tsx --test tests/rpc-client.test.ts
node --import tsx --test --test-name-pattern='HTTP RPC failover' tests/production-listener-factory.test.ts
```

Expected: FAIL because `SolanaRpcClient` does not configure failover.

- [ ] **Step 3: Integrate only when a fallback exists**

Keep the primary URL as the `Connection` endpoint. Add an optional dependency object for deterministic tests and construct endpoint IDs positionally. With no fallbacks, use exactly the current configuration object. With fallbacks, inject `createRpcHttpFailoverFetch(...)`, set `disableRetryOnRateLimit: true`, and forward the frozen events to a production callback that emits Pino structured warnings without endpoint URLs.

```ts
const rpc = new SolanaRpcClient(config, {
  onHttpFailoverEvent: (event) => {
    logger.warn(event, 'Bascule du transport HTTP RPC Solana.');
  },
});
```

- [ ] **Step 4: Verify GREEN and existing factory behavior**

Run:

```bash
node --import tsx --test tests/rpc-client.test.ts tests/production-listener-factory.test.ts
npm run check:backend
npm run lint:backend
```

Expected: all selected tests and static checks PASS.

- [ ] **Step 5: Commit**

```bash
git add src/solana/rpc/rpc-client.ts src/application/production-listener-factory.ts tests/rpc-client.test.ts tests/production-listener-factory.test.ts
git commit -m "feat: enable observable production RPC failover (#56)"
```

### Task 4: Operations documentation and complete verification

**Files:**
- Modify: `docs/operations/rpc-qualification.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-27-solana-http-rpc-failover-design.md` only if implementation requires a versioned clarification

- [ ] **Step 1: Add operational contract tests or documentation assertions**

Extend an existing documentation/config test to assert that the repository documents `SOLANA_HTTP_RPC_FALLBACK_URLS`, endpoint ordering, same-scheme restriction, no secret-bearing logs, and that `npm run rpc:soak` still qualifies exactly one provider.

- [ ] **Step 2: Verify RED**

Run the selected documentation/config test and confirm it fails on missing text.

- [ ] **Step 3: Document the shipped behavior**

Document primary/fallback order, the maximum of three fallbacks, retryable failures, cooldown/exhaustion, log-derived observability, unchanged WebSocket behavior, unchanged mono-endpoint behavior, and the distinction between production failover and single-provider soak qualification.

- [ ] **Step 4: Run the full acceptance suite**

Run:

```bash
npm run build
npm run check
npm run lint
npm test
npm run docs:check
git diff --check
```

Expected: every command exits 0; no existing test regresses; no signing or transaction-submission dependency is introduced.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/operations/rpc-qualification.md tests
git commit -m "docs: operate HTTP RPC failover safely (#56)"
```

### Task 5: Pull request, three-cycle review ceiling, and merge

- [ ] **Step 1: Push and open a PR linked to issue #56**

```bash
git push -u origin feature/issue-56-http-rpc-failover
gh pr create --base main --head feature/issue-56-http-rpc-failover --title "feat: add bounded HTTP RPC failover" --body-file /tmp/issue-56-pr-body.md
```

- [ ] **Step 2: Request review and process at most three review cycles**

For each cycle: request Codex review, wait for completion, inspect every thread, fix verified blocking findings with tests first, push, and re-request review. Stop cycling after three rounds and record any non-blocking residue explicitly.

- [ ] **Step 3: Merge only with green CI and no blocking thread**

Use a merge commit, confirm issue #56 closes, then update local remote state. Issue #57 remains separate and unchanged.

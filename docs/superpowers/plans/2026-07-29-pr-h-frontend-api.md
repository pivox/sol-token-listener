# PR H Frontend API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the persisted Pump.fun, paper-trading and PumpSwap projections through a public read-only HTTP V1 API and a durable, resumable SSE feed.

**Architecture:** A small `node:http` interface delegates every read to application ports implemented by PostgreSQL repositories. A PostgreSQL trigger creates an append-only API outbox for every public revision of a domain event; SSE uses a separate monotonic transport cursor so finality updates of one deterministic domain event remain resumable.

**Tech Stack:** TypeScript strict ESM, Node.js 22 `node:http`, PostgreSQL 14+, `pg`, Zod 4, Pino, Node test runner.

---

## File map

### New files

- `migrations/006_api_event_stream.sql` — append-only API outbox, trigger and indexes.
- `src/api/contracts.ts` — public V1 response and projection types.
- `src/api/errors.ts` — stable public error codes and typed error.
- `src/api/cursor.ts` — versioned opaque keyset and SSE cursor codecs.
- `src/ports/api-projection-repository.ts` — projection read port.
- `src/ports/api-event-stream-repository.ts` — durable stream read port.
- `src/storage/api-projection.repository.ts` — bounded PostgreSQL projection queries.
- `src/storage/api-event-stream.repository.ts` — high-water mark and ordered outbox reads.
- `src/interfaces/http/api-response.ts` — safe JSON envelopes and serialization.
- `src/interfaces/http/api-router.ts` — method/path/query validation and route dispatch.
- `src/interfaces/http/sse-session.ts` — backpressure-aware SSE lifecycle.
- `src/interfaces/http/api-server.ts` — `node:http` server and graceful shutdown.
- `tests/api-contracts.test.ts` — API schema and decimal-string contracts.
- `tests/api-cursor.test.ts` — cursor canonicality and bounds.
- `tests/api-event-stream-migration.test.ts` — SQL contract and optional live PostgreSQL test.
- `tests/api-projection.repository.test.ts` — SQL ordering, pagination and decoding.
- `tests/api-event-stream.repository.test.ts` — high-water mark, gaps and ordered batches.
- `tests/api-router.test.ts` — all JSON endpoints and public errors.
- `tests/api-sse.test.ts` — resume, heartbeat, expiration, failure and shutdown.
- `tests/api-safety.test.ts` — read-only boundary and forbidden dependencies.

### Modified files

- `src/config/env.ts` — bounded API settings.
- `.env.example` — safe API defaults.
- `src/storage/database.ts` — outbox purge count.
- `src/app.ts` — API-only composition and graceful shutdown.
- `docs/api/v1.md` — implemented behavior and cursor distinction.
- `docs/architecture/pumpfun-v1.md` — PR H state and remaining inactive listener.
- `README.md` — startup, safety and API links.
- `tests/config-safety.test.ts` — API bounds and defaults.
- `tests/bootstrap-safety.test.ts` — no signing/submission imports.

## Task 1: Public contracts, errors and cursor codecs

**Files:**

- Create: `src/api/contracts.ts`
- Create: `src/api/errors.ts`
- Create: `src/api/cursor.ts`
- Create: `tests/api-contracts.test.ts`
- Create: `tests/api-cursor.test.ts`

- [ ] **Step 1: Write failing contract tests**

Cover:

```ts
assert.deepEqual(decimalStrings({
  slot: 123n,
  nested: { amountRaw: 456n },
}), {
  slot: '123',
  nested: { amountRaw: '456' },
});
assert.throws(() => decimalStrings(Number.MAX_SAFE_INTEGER + 1), /unsafe number/u);
assert.equal(API_ERROR_CODES.includes('EVENT_CURSOR_EXPIRED'), true);
```

The serializer must recursively freeze its result, preserve `null`, strings,
booleans and safe integers, reject non-finite or unsafe numbers, reject
`undefined`, functions, symbols and cyclic values, and serialize every bigint
as an unsigned or signed decimal string.

- [ ] **Step 2: Run the tests and verify the missing-module failure**

Run:

```bash
npx tsx --test tests/api-contracts.test.ts tests/api-cursor.test.ts
```

Expected: FAIL because `src/api/contracts.ts` and `src/api/cursor.ts` do not
exist.

- [ ] **Step 3: Define stable public types**

`src/api/contracts.ts` must export:

```ts
export const API_VERSION = 'v1' as const;
export type ApiAvailability = 'AVAILABLE' | 'NOT_AVAILABLE';

export interface ApiMeta {
  readonly generatedAt: string;
  readonly nextCursor: string | null;
}

export interface ApiSuccess<T> {
  readonly apiVersion: typeof API_VERSION;
  readonly data: T;
  readonly meta: ApiMeta;
}

export interface ApiFailure {
  readonly apiVersion: typeof API_VERSION;
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly correlationId?: string;
  };
}

export interface ApiPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
```

Add explicit V1 types for launch summaries/details, timeline entries,
qualification, unavailable social/holders responses, paper positions, health
and SSE event data. Financial fields use `string`, never `number`.

Define:

```ts
export function toApiJson(value: unknown): ApiJsonValue
```

using an explicit recursive type and cycle detection. Do not use `any` or
`JSON.stringify` as validation.

- [ ] **Step 4: Add typed public errors**

`src/api/errors.ts` must define the exact codes:

```ts
export const API_ERROR_CODES = [
  'ROUTE_NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'INVALID_MINT',
  'INVALID_LIMIT',
  'INVALID_CURSOR',
  'LAUNCH_NOT_FOUND',
  'EVENT_CURSOR_EXPIRED',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
```

`ApiError` carries `code`, `httpStatus`, safe public `message`, optional
`correlationId`, and optional `cause` through `ErrorOptions`. No database error
message is copied into `message`.

- [ ] **Step 5: Implement canonical opaque cursors**

`src/api/cursor.ts` must expose:

```ts
export interface LaunchPagePosition {
  readonly detectedAtMs: number;
  readonly mint: string;
}

export interface PaperPositionPagePosition {
  readonly openedAtMs: number;
  readonly id: string;
}

export function encodeLaunchCursor(position: LaunchPagePosition): string;
export function decodeLaunchCursor(value: string): LaunchPagePosition;
export function encodePaperPositionCursor(position: PaperPositionPagePosition): string;
export function decodePaperPositionCursor(value: string): PaperPositionPagePosition;
export function encodeStreamCursor(sequence: bigint): string;
export function decodeStreamCursor(value: string): bigint;
```

Use Base64URL of canonical JSON arrays with a route-specific prefix and version:

```ts
['launches', 1, detectedAtMs, mint]
['paper_positions', 1, openedAtMs, id]
['events', 1, sequence.toString()]
```

Decode by re-encoding and exact comparison to reject alternate encodings,
padding, whitespace, `-0`, unsafe timestamps, non-positive stream sequences
and cross-route cursors.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npx tsx --test tests/api-contracts.test.ts tests/api-cursor.test.ts
npm run check --silent
npm run lint --silent
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/api/contracts.ts src/api/errors.ts src/api/cursor.ts \
  tests/api-contracts.test.ts tests/api-cursor.test.ts
git commit -m "feat: define public API contracts and cursors"
```

## Task 2: Transactional API event outbox

**Files:**

- Create: `migrations/006_api_event_stream.sql`
- Create: `tests/api-event-stream-migration.test.ts`
- Modify: `src/storage/database.ts`

- [ ] **Step 1: Write the failing migration contract test**

Read migration 006 as text and assert:

```ts
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS api_event_stream',
  'GENERATED ALWAYS AS IDENTITY',
  'AFTER INSERT OR UPDATE ON domain_events',
  'confirmation_status',
  'purge_after',
  'CREATE UNIQUE INDEX',
]) {
  assert.match(sql, new RegExp(fragment, 'u'));
}
assert.doesNotMatch(sql, /FLOAT|DOUBLE PRECISION|REAL/u);
```

When `TEST_DATABASE_URL` exists, create a unique temporary schema, set
`search_path`, run migrations 001–006 twice, insert one domain event, replay it
unchanged, then update its confirmation status to `confirmed`, `finalized` and
`orphaned`. Assert four ordered outbox rows and drop only that schema in
`finally`.

- [ ] **Step 2: Verify failure**

Run:

```bash
npx tsx --test tests/api-event-stream-migration.test.ts
```

Expected: FAIL because migration 006 is absent.

- [ ] **Step 3: Create the replayable outbox migration**

Create:

```sql
CREATE TABLE IF NOT EXISTS api_event_stream (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream_event_id TEXT NOT NULL UNIQUE,
  domain_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  mint TEXT NOT NULL,
  confirmation_status TEXT NOT NULL CHECK (
    confirmation_status IN ('processed','confirmed','finalized','orphaned')
  ),
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  event JSONB NOT NULL,
  emitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purge_after TIMESTAMPTZ NOT NULL
);
```

Add indexes on `(sequence)`, `(mint, sequence)` and `purge_after`.

The outbox deliberately has no foreign key to `domain_events`: its four-hour
transport retention must survive deletion of a parent projection whose own
retention deadline was calculated earlier.

Create `enqueue_api_domain_event_revision()` as a `SECURITY INVOKER`
PL/pgSQL trigger function. Build one JSONB envelope from only:

```text
eventId, type, mint, source, program, signature, slot,
transactionIndex, instructionIndex, innerInstructionIndex,
confirmationStatus, blockchainTime, observedAt, payloadVersion, payload
```

Derive:

```sql
stream_event_id =
  NEW.event_id || ':' || NEW.confirmation_status || ':' ||
  NEW.payload_version::text || ':' || md5(public_event::text)
```

Insert with `ON CONFLICT (stream_event_id) DO NOTHING` and
`purge_after = NOW() + INTERVAL '4 hours'`. Trigger on insert or when one public
field changes. Changes only to `terminal_at` or `purge_after` must not enqueue.

Backfill retained rows using the same envelope and deterministic identity,
ordered by `created_at,event_id`, with `ON CONFLICT DO NOTHING`.

- [ ] **Step 4: Extend retention purge**

Add `apiEventStream` to the return type and delete:

```sql
DELETE FROM api_event_stream WHERE purge_after <= NOW()
```

before deleting `domain_events`.

- [ ] **Step 5: Run migration tests**

Run:

```bash
npx tsx --test tests/api-event-stream-migration.test.ts tests/migration-contract.test.ts
npm run check --silent
npm run lint --silent
```

Expected: PASS. If `TEST_DATABASE_URL` is unset, the live-schema case reports
SKIP while the static contract still passes.

- [ ] **Step 6: Commit**

```bash
git add migrations/006_api_event_stream.sql src/storage/database.ts \
  tests/api-event-stream-migration.test.ts
git commit -m "db: add transactional API event outbox"
```

## Task 3: Projection read port and PostgreSQL repository

**Files:**

- Create: `src/ports/api-projection-repository.ts`
- Create: `src/storage/api-projection.repository.ts`
- Create: `tests/api-projection.repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

Use a typed fake `Queryable` recording SQL and returning explicit rows. Cover:

- launch radar order `detected_at DESC, mint ASC`;
- keyset predicate after a launch cursor;
- `limit + 1` fetch and correct `nextCursor`;
- latest metadata, curve, `QualificationUpdated`, migration, pool and reserves;
- exact mint lookup and missing launch;
- timeline order by `slot, transaction_index, instruction_index,
  COALESCE(inner_instruction_index,-1), event_id`;
- paper order `opened_at DESC, position_id ASC`;
- health without secrets;
- decimal strings retained exactly;
- invalid JSON projection rejected with a typed internal error.

- [ ] **Step 2: Verify missing-module failure**

Run:

```bash
npx tsx --test tests/api-projection.repository.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Define the application port**

`src/ports/api-projection-repository.ts` must expose:

```ts
export interface PageRequest<TCursor> {
  readonly limit: number;
  readonly after: TCursor | null;
}

export interface ApiProjectionRepository {
  listLaunches(request: PageRequest<LaunchPagePosition>): Promise<ApiPage<ApiLaunchSummary>>;
  getLaunch(mint: string): Promise<ApiLaunchDetail | null>;
  listLaunchEvents(mint: string): Promise<readonly ApiTimelineEntry[]>;
  getLaunchRisk(mint: string): Promise<ApiQualification | null>;
  getLaunchSocial(mint: string): Promise<ApiSocialProjection | null>;
  getLaunchHolders(mint: string): Promise<ApiHoldersProjection | null>;
  listPaperPositions(
    request: PageRequest<PaperPositionPagePosition>,
  ): Promise<ApiPage<ApiPaperPosition>>;
  getHealth(): Promise<ApiHealth>;
}
```

Social and holders return `null` only when the launch does not exist; for an
existing launch they return frozen `NOT_AVAILABLE` projections.

- [ ] **Step 4: Implement bounded SQL reads**

`ApiPostgresProjectionRepository` depends on an injected `Queryable`, a clock
and the configured pipeline-state snapshot. Every query is parameterized.

Use lateral joins or small fixed follow-up queries, but never one query per
list item. For launch lists:

1. query at most `limit + 1` launch rows;
2. query related latest projections for all returned mints using `= ANY($1)`;
3. assemble and validate public shapes;
4. remove the extra row and derive the next cursor from the last emitted item.

Use `DISTINCT ON (mint)` with explicit order for latest snapshots. Exclude
`orphaned` rows from current projections but retain them in timelines.

Qualification comes from the latest non-orphaned `domain_events` row whose
`type='QualificationUpdated'`. Do not fall back to legacy
`token_risk_reports`.

All `NUMERIC` values must already be strings from `pg`; reject any unsafe
number instead of coercing it.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx tsx --test tests/api-projection.repository.test.ts tests/api-contracts.test.ts
npm run check --silent
npm run lint --silent
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ports/api-projection-repository.ts \
  src/storage/api-projection.repository.ts tests/api-projection.repository.test.ts
git commit -m "feat: read public API projections"
```

## Task 4: Durable event stream repository

**Files:**

- Create: `src/ports/api-event-stream-repository.ts`
- Create: `src/storage/api-event-stream.repository.ts`
- Create: `tests/api-event-stream.repository.test.ts`

- [ ] **Step 1: Write failing stream repository tests**

Cover:

```text
currentHighWaterMark -> null or greatest sequence
resolveCursor -> retained, expired, future, invalid
readAfter -> sequence ascending, bounded batch
readAfter -> no duplicate when called again with returned sequence
event JSON validation -> reject malformed row
```

Simulate a retained minimum sequence greater than the requested sequence and
assert `EVENT_CURSOR_EXPIRED`, not an empty list.

- [ ] **Step 2: Verify failure**

Run:

```bash
npx tsx --test tests/api-event-stream.repository.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Define stream types and port**

```ts
export interface ApiStreamRevision {
  readonly sequence: bigint;
  readonly streamEventId: string;
  readonly event: ApiDomainEvent;
}

export type StreamCursorResolution =
  | { readonly status: 'CURRENT'; readonly sequence: bigint }
  | { readonly status: 'EXPIRED' }
  | { readonly status: 'FUTURE' };

export interface ApiEventStreamRepository {
  highWaterMark(): Promise<bigint>;
  resolve(sequence: bigint): Promise<StreamCursorResolution>;
  readAfter(sequence: bigint, limit: number): Promise<readonly ApiStreamRevision[]>;
}
```

An empty table has high-water mark `0n`. External SSE cursors remain strictly
positive; `0n` is internal only.

- [ ] **Step 4: Implement PostgreSQL reads**

Use:

```sql
SELECT COALESCE(MAX(sequence),0)::text AS sequence FROM api_event_stream
```

For resolution, compare the requested sequence with current max and query the
exact row. If it is absent and less than or equal to max, classify `EXPIRED`.
This intentionally rejects a deleted gap rather than silently skipping it.

Read:

```sql
SELECT sequence::text, stream_event_id, event
FROM api_event_stream
WHERE sequence > $1
ORDER BY sequence ASC
LIMIT $2
```

Validate every event against domain event types, canonical decimal slot,
confirmation status, safe indexes, timestamps and JSON shape.

- [ ] **Step 5: Run focused tests and commit**

```bash
npx tsx --test tests/api-event-stream.repository.test.ts
npm run check --silent
npm run lint --silent
git add src/ports/api-event-stream-repository.ts \
  src/storage/api-event-stream.repository.ts tests/api-event-stream.repository.test.ts
git commit -m "feat: read resumable API event revisions"
```

## Task 5: JSON response layer and HTTP routes

**Files:**

- Create: `src/interfaces/http/api-response.ts`
- Create: `src/interfaces/http/api-router.ts`
- Create: `tests/api-router.test.ts`

- [ ] **Step 1: Write failing router tests**

Invoke the router with minimal request/response fakes. Cover every route:

```text
GET /api/v1/launches
GET /api/v1/launches/:mint
GET /api/v1/launches/:mint/events
GET /api/v1/launches/:mint/risk
GET /api/v1/launches/:mint/social
GET /api/v1/launches/:mint/holders
GET /api/v1/paper-positions
GET /api/v1/health
```

Also cover `HEAD`, public `OPTIONS`, unknown route, POST/PUT/DELETE refusal,
bad percent encoding, invalid mint, invalid/foreign cursor, invalid limit,
repository not-found and unexpected repository error.

Assert:

- `Content-Type: application/json; charset=utf-8`;
- `Cache-Control: no-store`;
- CORS has `Access-Control-Allow-Origin: *` and no credentials;
- no stack, SQL or injected input appears in an internal-error body;
- `HEAD` has the same status/headers as `GET` and an empty body.

- [ ] **Step 2: Verify failure**

Run:

```bash
npx tsx --test tests/api-router.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement response helpers**

`api-response.ts` exports:

```ts
export function success<T>(
  data: T,
  nowMs: number,
  nextCursor?: string | null,
): ApiSuccess<T>;
export function failure(error: ApiError): ApiFailure;
export function writeJson(
  response: ServerResponse,
  status: number,
  body: ApiSuccess<unknown> | ApiFailure,
  headOnly?: boolean,
): void;
```

Validate timestamps before `toISOString()`. Convert through `toApiJson` before
serialization so native bigint can never reach `JSON.stringify`.

- [ ] **Step 4: Implement strict routing**

`createApiRouter` receives:

```ts
export interface ApiRouterDependencies {
  readonly projections: ApiProjectionRepository;
  readonly now: () => number;
  readonly defaultLimit: number;
  readonly maximumLimit: number;
  readonly correlationId: () => string;
  readonly logError: (context: Readonly<Record<string, unknown>>, error: unknown) => void;
}
```

Parse with `new URL(request.url, 'http://api.invalid')`. Reject non-empty
request bodies by method before reading them. Accept only exact route shapes.
Validate Solana mints as non-empty Base58 strings of 32 decoded bytes using the
existing `bs58` dependency.

Return `LAUNCH_NOT_FOUND` consistently for missing detail, events, risk,
social and holders. `risk.data` may be `null` for an existing launch.

Unexpected errors become `INTERNAL_ERROR` with a generated correlation ID and
are logged structurally.

- [ ] **Step 5: Run route tests and commit**

```bash
npx tsx --test tests/api-router.test.ts tests/api-cursor.test.ts
npm run check --silent
npm run lint --silent
git add src/interfaces/http/api-response.ts src/interfaces/http/api-router.ts \
  tests/api-router.test.ts
git commit -m "feat: expose read-only API routes"
```

## Task 6: Backpressure-aware SSE sessions

**Files:**

- Create: `src/interfaces/http/sse-session.ts`
- Create: `tests/api-sse.test.ts`
- Modify: `src/interfaces/http/api-router.ts`

- [ ] **Step 1: Write failing SSE integration tests**

Start a real local `node:http` server on port `0` with fake repositories and a
controllable clock/timer facade. Cover:

- no cursor begins after the current high-water mark;
- valid `Last-Event-ID` replays strictly after it;
- malformed/future cursor returns `400 INVALID_CURSOR`;
- deleted retained cursor returns `409 EVENT_CURSOR_EXPIRED` before SSE
  headers;
- revisions are emitted in sequence with distinct transport IDs and the same
  deterministic `eventId` when finality changes;
- heartbeat comment is emitted;
- a second poll starts only after the previous one completes;
- `response.write() === false` waits for `drain`;
- client abort cancels timers;
- repository error after headers emits `stream_error` and closes;
- shutdown emits `server_shutdown` and closes every session.

Use timeouts below one second in tests and always abort clients in `finally`.

- [ ] **Step 2: Verify failure**

Run:

```bash
npx tsx --test tests/api-sse.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement the SSE session**

Define:

```ts
export interface SseSessionOptions {
  readonly stream: ApiEventStreamRepository;
  readonly response: ServerResponse;
  readonly startAfter: bigint;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  readonly schedule: typeof setTimeout;
  readonly cancel: typeof clearTimeout;
  readonly onClosed: (session: SseSession) => void;
}
```

`SseSession.start()` writes headers, loops using scheduled single-shot polls,
emits batches in ascending order and updates `lastSequence` only after a
successful write. Escape CR and LF from `event:` names, JSON serialize validated
data only, and split multiline data according to SSE framing.

Implement:

```ts
public async close(reason: 'CLIENT' | 'SERVER' | 'ERROR'): Promise<void>
```

idempotently. Server close writes:

```text
event: server_shutdown
data: {"apiVersion":"v1"}
```

Error close writes:

```text
event: stream_error
data: {"apiVersion":"v1","error":{"code":"DEPENDENCY_UNAVAILABLE"}}
```

- [ ] **Step 4: Route `/api/v1/events`**

Validate `Accept` includes `text/event-stream`. Resolve `Last-Event-ID` before
writing headers. Without it, call `highWaterMark()`. With it, decode and call
`resolve()`.

The router returns a session handle to the server rather than treating the
request as completed JSON.

- [ ] **Step 5: Run focused tests and commit**

```bash
npx tsx --test tests/api-sse.test.ts tests/api-router.test.ts
npm run check --silent
npm run lint --silent
git add src/interfaces/http/sse-session.ts src/interfaces/http/api-router.ts \
  tests/api-sse.test.ts
git commit -m "feat: stream resumable domain events over SSE"
```

## Task 7: API server, configuration and bootstrap

**Files:**

- Create: `src/interfaces/http/api-server.ts`
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `src/app.ts`
- Modify: `tests/config-safety.test.ts`
- Modify: `tests/bootstrap-safety.test.ts`
- Create: `tests/api-safety.test.ts`

- [ ] **Step 1: Write failing configuration and safety tests**

Assert defaults:

```ts
assert.equal(config.apiEnabled, true);
assert.equal(config.apiHost, '127.0.0.1');
assert.equal(config.apiPort, 3000);
assert.equal(config.apiPageLimitDefault, 50);
assert.equal(config.apiPageLimitMaximum, 200);
assert.equal(config.apiSseHeartbeatMs, 15_000);
assert.equal(config.apiSsePollMs, 1_000);
```

Reject invalid booleans, host whitespace/control characters, port outside
1–65535, default greater than maximum, heartbeat outside 1,000–60,000 ms and
poll outside 100–10,000 ms.

Read all new API source files and assert they do not import wallet, transaction
builder, transaction confirmer, trade executor, Solana `Keypair`,
`sendTransaction`, `sendRawTransaction` or `simulateTransaction`.

- [ ] **Step 2: Verify failure**

Run:

```bash
npx tsx --test tests/config-safety.test.ts tests/api-safety.test.ts \
  tests/bootstrap-safety.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Add bounded configuration**

Extend `AppConfig` and `parseConfig` with the seven API values. Add a dedicated
host parser rejecting empty strings, control characters, schemes, slashes and
whitespace. Enforce `default <= maximum`.

Add safe `.env.example` entries:

```dotenv
API_ENABLED=true
API_HOST=127.0.0.1
API_PORT=3000
API_PAGE_LIMIT_DEFAULT=50
API_PAGE_LIMIT_MAX=200
API_SSE_HEARTBEAT_MS=15000
API_SSE_POLL_MS=1000
```

- [ ] **Step 4: Implement the HTTP server owner**

`ApiServer` owns the `http.Server` and a `Set<SseSession>`. It exposes:

```ts
public listen(): Promise<{ readonly host: string; readonly port: number }>;
public close(): Promise<void>;
```

`listen()` rejects a second call. `close()` is idempotent, stops accepting
connections, closes SSE sessions, invokes `closeIdleConnections()` and awaits
the server callback. All request promises have a terminal catch that logs and
closes safely.

- [ ] **Step 5: Compose from `src/app.ts`**

When `apiEnabled`:

1. migrate if configured;
2. construct `ApiPostgresProjectionRepository`;
3. construct `ApiPostgresEventStreamRepository`;
4. construct and listen to `ApiServer`;
5. install one-shot `SIGINT` and `SIGTERM` handlers;
6. log `api.started` with host/port and safety flags;
7. await a shutdown promise;
8. close API, then database.

When disabled, retain the previous initialization log and close the database
without waiting.

Dependency construction must be in exported functions that tests can call
with fake repositories/server/database closers; tests must not open a real
database or port.

- [ ] **Step 6: Run focused tests and commit**

```bash
npx tsx --test tests/config-safety.test.ts tests/api-safety.test.ts \
  tests/bootstrap-safety.test.ts tests/api-router.test.ts tests/api-sse.test.ts
npm run check --silent
npm run lint --silent
git add src/interfaces/http/api-server.ts src/config/env.ts .env.example src/app.ts \
  tests/config-safety.test.ts tests/bootstrap-safety.test.ts tests/api-safety.test.ts
git commit -m "feat: compose the public API runtime"
```

## Task 8: Documentation, review and full verification

**Files:**

- Modify: `docs/api/v1.md`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `README.md`

- [ ] **Step 1: Update public documentation**

Document:

- PR H routes are implemented;
- API is unauthenticated and read-only;
- default bind is loopback and deployment controls public exposure;
- native bigint never appears in JSON;
- SSE `id` is a transport cursor while `data.eventId` is deterministic domain
  identity;
- no-cursor connections start at current high-water mark;
- `409 EVENT_CURSOR_EXPIRED` requires HTTP projection reload;
- social and holders are `NOT_AVAILABLE`;
- listener RPC remains inactive;
- no wallet or live execution exists;
- retention is four hours.

Add curl examples:

```bash
curl http://127.0.0.1:3000/api/v1/health
curl -N -H 'Accept: text/event-stream' \
  http://127.0.0.1:3000/api/v1/events
```

- [ ] **Step 2: Run diff and contract review**

Run:

```bash
rg -n "private.?key|Keypair|sendRawTransaction|sendTransaction|simulateTransaction" \
  src/api src/interfaces/http src/ports/api-* src/storage/api-*
rg -n "\\bnumber\\b" src/api/contracts.ts
git diff --check
```

Expected: no execution path; every intentional `number` is a bounded timestamp,
index, port or configuration value, never a financial amount.

- [ ] **Step 3: Run the complete acceptance suite**

Run:

```bash
npm install
npm run build
npm run check
npm run lint
npm test
git diff --check
git status --short
```

Expected: all commands PASS and only intended PR H files are modified before
the documentation commit.

If `TEST_DATABASE_URL` is set, also run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" \
  npx tsx --test tests/api-event-stream-migration.test.ts
```

If it is not set, record that the static SQL contract passed and the live
empty-database test was skipped. Do not claim live migration verification.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/api/v1.md docs/architecture/pumpfun-v1.md README.md
git commit -m "docs: publish the frontend API contract"
```

- [ ] **Step 5: Request code review**

Use `superpowers:requesting-code-review`. Review specifically:

- outbox atomicity and replay identity;
- cursor expiration and sequence gaps;
- SSE backpressure and cleanup;
- unsafe JSON or bigint coercion;
- SQL keyset ordering;
- public error leakage;
- forbidden live-execution dependencies.

- [ ] **Step 6: Re-run verification after review fixes**

Run fresh:

```bash
npm run build && npm run check && npm run lint && npm test && git diff --check
```

Expected: PASS with a clean worktree.

## PR H acceptance summary

Before push, all of the following must be true:

- eight required JSON routes are implemented;
- `/api/v1/events` is SSE-only and resumable;
- stream transport cursor and deterministic domain event ID are distinct;
- finality revisions are append-only and ordered;
- identical replays do not duplicate stream rows;
- expired and invalid cursors fail explicitly before SSE headers;
- social and holder gaps are explicit, not fabricated;
- PostgreSQL and runtime failures do not leak secrets;
- API methods cannot mutate projections or trigger trading;
- API defaults to loopback and observe remains the execution default;
- shutdown releases servers, sessions, timers and database connections;
- four-hour retention includes the event outbox;
- Raydium CPMM remains untouched as a secondary adapter;
- all existing and new tests pass.

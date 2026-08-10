# Frontend 7/9 — Independent Pump.fun Console Design

Issue: [#41](https://github.com/pivox/sol-token-listener/issues/41)

Date: 2026-08-10

Status: approved for implementation planning

## 1. Objective

Deliver a public, read-only operator console in a new `frontend/` npm workspace.
The console consumes only the existing HTTP/SSE API V1 and makes the current
Pump.fun observation, qualification, public social evidence, participant
analysis, paper trading, and runtime health projections usable without coupling
the browser application to backend implementation modules.

The first screen is a dense launch radar. It lets an operator select a launch
and inspect its explainable verdict without constantly navigating away. Dedicated
routes expose the complete launch record, simulated paper positions, and listener
health.

The console is observational. It does not expose a wallet, secret, signing
operation, transaction builder, write endpoint, or live execution control.

## 2. Decisions

The approved product and technical decisions are:

- the frontend lives in `frontend/` in this repository but has its own package,
  source tree, build output, and deployment artifact;
- it is a Vite single-page application using React, React Router, strict
  TypeScript, Bootstrap, TanStack Query, and Zod;
- the visual direction is a dense two-column console: radar on the left and an
  explainable launch summary on the right;
- the browser consumes only `/api/v1`; it never imports types or code from
  `src/`;
- JSON and SSE payloads are validated at runtime against frontend-owned schemas;
- HTTP projections are canonical; SSE revisions invalidate the relevant cached
  projections instead of becoming a second projection engine in the browser;
- resumable SSE uses `fetch` streaming, not `EventSource`, so a persisted
  `Last-Event-ID` header can be restored after a page reload;
- the application is public and has no authentication in this version;
- Bootstrap provides layout and accessible primitives; no separate design
  system or CSS framework is introduced;
- all frontend financial calculations preserve integer semantics.

## 3. Architecture and dependency boundaries

The repository becomes an npm workspace with the backend root and one child
package:

```text
sol-token-listener/
├── src/                         backend implementation
├── tests/                       backend tests
├── frontend/
│   ├── public/                  replaceable runtime configuration
│   ├── src/
│   │   ├── app/                 composition, routes and global providers
│   │   ├── data/                API schemas, HTTP client and SSE transport
│   │   ├── features/            radar, launch, paper and health features
│   │   ├── components/          shared presentational components
│   │   └── styles/              Bootstrap entry and limited application CSS
│   ├── tests/                   browser-facing integration fixtures/tests
│   ├── package.json
│   └── vite.config.ts
└── package.json                 workspace orchestration
```

Allowed dependency direction:

```text
public API V1 HTTP/SSE
          ↓
frontend/src/data
          ↓
frontend/src/features
          ↓
frontend/src/app
```

Shared presentational components may depend on frontend data value types, but
the data layer never depends on features or routing. No file below `frontend/`
imports `../../src`, generated backend files, PostgreSQL repositories, Solana
SDKs, or listener configuration.

The static deployment artifact is `frontend/dist/`. It can be hosted on a
different origin from the backend. The backend CORS contract remains public and
read-only. Its `OPTIONS` response is extended to allow the `Last-Event-ID`
request header: a cross-origin `fetch` that restores this non-safelisted header
otherwise fails browser preflight before reaching the SSE route.

## 4. Package and command integration

The root package declares `frontend` as an npm workspace. The root lockfile is
the single dependency lock for reproducible repository installs. Backend
dependencies remain root dependencies; browser dependencies belong to the
frontend workspace.

Existing acceptance commands continue to validate the entire repository:

- `npm run build` builds backend then frontend;
- `npm run check` checks generated backend artifacts and both TypeScript
  projects;
- `npm run lint` lints backend then frontend;
- `npm test` runs backend then frontend unit/component tests;
- `npm run frontend:e2e` runs the Playwright smoke journey explicitly.

Backend subcommands are given explicit internal names where necessary so root
orchestration does not recurse into itself. The backend runtime entry points and
production behavior do not change.

## 5. Runtime configuration

The application loads `/config.json` before rendering. Its public schema is:

```json
{
  "apiBaseUrl": "http://127.0.0.1:3000"
}
```

`apiBaseUrl` must be an absolute `http:` or `https:` URL. Credentials, query
parameters, fragments, embedded username/password, `javascript:`, `data:`, and
non-HTTP schemes are rejected. The normalized URL has no trailing slash.

The repository contains a safe local default. A deployment replaces
`frontend/dist/config.json` without rebuilding the JavaScript bundle. No secret
or private endpoint is encoded into compiled assets. Failure to load or validate
configuration renders a bounded fatal configuration screen and starts no API or
SSE request.

## 6. Frontend-owned API contracts

`frontend/src/data/api-schemas.ts` defines Zod schemas for the exact fields used
by the UI. It validates the V1 success envelope, V1 failure envelope, pagination
metadata, launch summaries/details, timeline events, qualifications, social
evidence, holders/clusters, paper positions, health, and SSE event summaries.

The schemas are strict at the envelope and safety-sensitive boundaries. V1 is
additive, so domain object schemas accept unknown additive fields while still
requiring the fields the UI renders. This catches removals, type changes, unsafe
numeric representations, malformed timestamps, invalid discriminators, and
missing union fields without rejecting compatible additions.

Rules for numeric data:

- slot, reserve, token amount, quote amount, liquidity, market cap, PnL, fee,
  and basis-point fields are decimal strings where the API contract uses
  strings;
- decimal integer strings match `^-?[0-9]+$` and are parsed to `bigint` only for
  comparisons or integer formatting;
- scores, counts, decimals, and bounded UI pagination values remain `number`
  only when the public contract declares them as safe numbers;
- the frontend never converts a financial decimal string through `Number`,
  `parseFloat`, or floating-point arithmetic;
- percentages derived from basis points are formatted by integer division and
  remainder, not binary floats.

Contract failures produce a typed `ApiContractError` containing the route and a
bounded issue summary. Raw response bodies are never placed in user-visible
errors or persistent browser storage.

### 6.1 Additive launch-radar summary

The current launch list does not expose qualification or paper progress. Loading
those projections once per row from the browser would create an unbounded N+1
request pattern. `GET /api/v1/launches` is therefore extended additively so each
`ApiLaunchSummary` contains:

- `qualificationSummary`: nullable verdict, three dimension scores, total score,
  blocker codes, and evaluation time;
- `candidate`: the existing nullable public candidate summary;
- `paperStrategy`: the existing nullable public strategy progress summary.

`ApiLaunchDetail` inherits these fields instead of redeclaring candidate and
paper strategy. The PostgreSQL projection repository loads the latest canonical
qualification, candidate, and strategy rows for every mint in a page through
bounded set-based queries inside the existing repeatable-read snapshot. It does
not execute one query per launch. Orphaned/retracted projections are excluded by
the same canonical authority rules used by detail endpoints.

This is an additive V1 contract change. Existing clients may ignore the fields;
the frontend uses them to render radar rows without speculative inference.

## 7. HTTP client and cache policy

`frontend/src/data/api-client.ts` owns all requests. It:

- resolves paths relative to validated `apiBaseUrl`;
- sends `Accept: application/json` for projection requests;
- uses `GET` only;
- enforces a request timeout with `AbortController`;
- caps the JSON response size before parsing;
- validates success and failure envelopes;
- maps public API error codes to a stable frontend error union;
- never retries 400, 404, 405, 406, or 409 blindly;
- allows TanStack Query to retry bounded transient network and 5xx failures.

Query keys are centralized and include the mint and pagination cursor where
applicable. Launch list pages use `useInfiniteQuery`. Client-side filters apply
only to loaded pages and the UI states this explicitly. The operator can load
more retained launches without inventing unsupported server query parameters.

Default cache policy favors honesty over apparent freshness:

- launch radar and paper positions become stale quickly and are refreshed after
  relevant SSE revisions;
- launch detail subresources are invalidated by matching mint and event type;
- health has a short bounded polling fallback even while SSE is connected;
- cached data remains visible with a stale/disconnected badge during temporary
  transport failures;
- a manual refresh action is always available.

## 8. Resumable SSE transport

The backend requires `Accept: text/event-stream` and uses `Last-Event-ID` for
resume. Browser `EventSource` cannot set that header for a newly created stream,
so `frontend/src/data/sse-client.ts` uses `fetch` and incrementally parses the
response body.

The parser supports:

- LF and CRLF line endings;
- `id`, `event`, and multiline `data` fields;
- comment heartbeats;
- blank-line event boundaries;
- UTF-8 chunks split at arbitrary byte positions;
- bounded line, event, and buffered-stream sizes;
- explicit rejection of NUL-containing IDs and malformed JSON data.

The processing sequence for a business frame is transactional from the client
perspective:

1. parse the complete frame;
2. validate its SSE event envelope and domain event summary;
3. map the event type to query keys;
4. request invalidation/refetch for those keys;
5. persist the transport `id` only after the frame was accepted and scheduled.

The cursor is stored in `localStorage` under a key namespaced by the normalized
API origin and API version. `data.eventId` is never stored as a transport cursor.
Repeated domain event IDs remain valid because finality and orphan revisions are
separate outbox frames.

Connection states are `CONNECTING`, `LIVE`, `RECONNECTING`, `RESYNCING`,
`DISCONNECTED`, and `STOPPED`. The top navigation always exposes the state and
age of the last accepted frame.

Retry uses bounded exponential backoff with jitter and resets after a stable
connection. Offline browser state pauses attempts. Visibility restoration may
trigger a refresh when the cached data age exceeds the configured threshold.

On HTTP 409 `EVENT_CURSOR_EXPIRED` or its post-header SSE error frame, the
client:

1. enters `RESYNCING`;
2. removes only the cursor for the current API origin/version;
3. invalidates active HTTP projections;
4. waits for their bounded refetch attempt to settle;
5. reconnects without `Last-Event-ID`, starting from the server high-water mark.

No gap is hidden: the interface states that retained projections were
resynchronized and that events older than server retention are unavailable.

## 9. Routes and screens

### 9.1 `/` — launch radar

The desktop layout has a dense radar table on the left and a selected-launch
summary on the right. On smaller screens they stack in that order.

The radar shows mint/name/symbol, detected time, business status, quote asset,
market-cap/liquidity values when available, qualification state, total score,
active blocker count, curve or strategy progress when exposed, and paper state.
It supports local search by mint/name/symbol and local filters for status,
qualification, blockers, quote asset, and paper state across loaded pages.

The summary panel shows:

- preparation, social authenticity, and on-chain score separately;
- verdict and active blockers before positive score detail;
- curve/market values explicitly labeled as estimates;
- candidate eligibility and external-buy progress;
- latest social and holder coverage states;
- a link to the complete launch route.

A score never visually overrides a blocker. `UNKNOWN`, `NOT_AVAILABLE`, and
partial coverage have distinct neutral warning treatments and are never shown
as success.

### 9.2 `/launches/:mint` — launch detail

The route validates the mint locally before requesting data and provides
shareable nested tabs:

- overview: launch identity, creator, quote asset, token program, reserves,
  candidate and paper strategy;
- timeline: cursor-paginated domain events ordered as returned by the API;
- risk: rule-set identity/fingerprint, three scores, evidence, conditions,
  blockers, thresholds and observed values;
- social: collection coverage, normalized links, redirects and evidence, with
  no claim that presence proves seriousness;
- holders: observed methodology, creator profile, concentration history,
  positions, cluster coverage and bounded cluster members.

Raw event payloads are rendered as escaped structured data only in a collapsed
diagnostic disclosure. They are never injected as HTML.

### 9.3 `/paper` — simulated positions

The positions view paginates open and closed paper positions and exposes entry
venue, session lineage, external-buy progress, entry/exit values, gross/net
estimated PnL, reason codes, and timestamps available in the contract. A
persistent “simulation only” label and explanatory copy prevent confusion with
real positions. No action button suggests execution.

### 9.4 `/health` — technical health

The health screen displays PostgreSQL/API availability, Pump.fun and PumpSwap
pipelines, social and paper-decision workers, heartbeat age, backlog, leases,
retryable/exhausted work, stable error codes, and last-success timestamps. It
does not display RPC URLs, database URLs, internal exception messages, headers,
or secrets.

## 10. Shared presentation rules

Bootstrap supplies grid, tables, navigation, alerts, badges, progress bars, and
accessible focus states. A small application stylesheet defines semantic color
tokens, dense table spacing, sticky radar headers, and responsive split layout.

Semantic rules are stable:

- red is reserved for active blockers, rejected/suspect state, or hard failure;
- amber marks partial, stale, reconnecting, unknown, or manual-review state;
- green requires a positive explicit state and never represents metadata alone;
- orphaned timeline revisions are visibly struck/reconciled rather than silently
  removed from diagnostic context;
- financial and technical estimates carry their units and `estimated` label;
- mint, signature, reason code, and cursor-like identifiers use monospace text
  with accessible copy affordances where safe.

The UI meets keyboard navigation and contrast expectations. Every icon has text
or an accessible label. Motion respects `prefers-reduced-motion`.

## 11. Security and privacy

The frontend contains no secret and no write path. Additional rules are:

- metadata text is rendered through React escaping;
- external URLs must pass a frontend `http:`/`https:` validator before becoming
  anchors and open with `target="_blank" rel="noopener noreferrer"`;
- remote images/videos are not loaded automatically in the radar; the detail
  page uses explicit bounded media behavior to avoid silent tracking fan-out;
- no analytics, advertising script, remote font, or third-party telemetry is
  included;
- error boundaries expose stable explanations and correlation IDs only when the
  API supplies one;
- local storage contains only the API-version/origin-namespaced SSE cursor and
  non-sensitive display preferences;
- a restrictive static-hosting security-header example documents CSP,
  `X-Content-Type-Options`, `Referrer-Policy`, and frame restrictions.

The four-hour backend retention remains authoritative. The browser does not
build a longer-lived local launch archive.

## 12. Error and empty states

Every data region distinguishes:

- initial loading;
- successful empty result;
- `NOT_AVAILABLE` because processing has not produced a projection;
- partial/unknown evidence;
- stale cached data after a transport failure;
- API public error with stable code;
- response contract violation;
- complete API unavailability;
- SSE disconnection/reconnection/resynchronization.

A detail route returning `LAUNCH_NOT_FOUND` renders a stable not-found screen.
An invalid mint is rejected before network access. A route-level error does not
erase working navigation or unrelated cached projections.

## 13. Testing strategy

The frontend uses Vitest, React Testing Library, `user-event`, MSW, jsdom, and
Playwright.

Unit tests cover:

- runtime configuration validation and URL normalization;
- decimal-string and basis-point formatting without floats;
- API success/failure schemas and all discriminated availability states;
- bounded HTTP parsing, timeout, typed errors, and retry classification;
- incremental SSE parsing across chunk/line boundaries and malformed frames;
- cursor namespacing, commit-after-acceptance, reconnect, and expired-cursor
  resynchronization;
- event-to-query invalidation mapping;
- external-link safety and diagnostic JSON escaping.

Component/integration tests cover:

- radar loading, empty, partial, filtered, selected, stale, and paginated states;
- blockers taking visual priority over scores;
- launch detail tabs and `NOT_AVAILABLE` representations;
- simulated paper labels and integer PnL formatting;
- health degradation without leaking endpoints or internal errors;
- connection-state badges and manual refresh behavior;
- responsive stacking semantics and keyboard navigation.

MSW fixtures model the real public envelopes and are owned by `frontend/tests`.
They contain synthetic, non-secret Solana identifiers.

The Playwright smoke journey starts a deterministic mock API/SSE server and
verifies:

1. radar load;
2. SSE-driven refresh;
3. launch detail navigation;
4. paper position rendering;
5. health degradation rendering;
6. reconnect with `Last-Event-ID`;
7. expired cursor resynchronization.

Backend API contract tests continue to protect the server side. A focused router
test proves that CORS preflight advertises `Last-Event-ID` while still allowing
only `GET`, `HEAD`, and `OPTIONS`. Frontend schema fixtures are cross-checked
against representative backend responses so accidental drift fails in CI.

## 14. CI and delivery

A GitHub Actions workflow installs the root workspace lockfile on Node 22 and
runs:

```text
npm run build
npm run check
npm run lint
npm test
npm run frontend:e2e
```

PostgreSQL is provided to backend integration tests through a service container.
Playwright installs only Chromium with its required system dependencies. The
frontend build artifact may be uploaded for inspection, but this PR does not
publish or deploy it to a public host.

The README documents local startup:

1. start PostgreSQL/backend in `observe` or `paper` mode;
2. set the public API URL in `frontend/public/config.json`;
3. run the frontend dev server;
4. open the radar;
5. verify the visible SSE status.

## 15. Implementation boundaries

Included in issue #41:

- workspace scaffolding and repository command integration;
- all four V1 routes and shared navigation;
- frontend-owned V1 schemas and typed client;
- resumable fetch-based SSE transport;
- additive, set-based launch-list summaries for qualification and paper progress;
- additive CORS preflight support for `Last-Event-ID`;
- unit, component, contract, and browser smoke tests;
- CI and operator documentation.

Explicitly excluded:

- new backend routes, database tables, or listener behavior; the only backend
  contract changes are the additive launch-list summaries and
  `Access-Control-Allow-Headers: Last-Event-ID` preflight response required by
  the approved independent console;
- authentication, user accounts, alerts, watchlist persistence, or notification
  delivery;
- wallet connection, real trading, transaction submission, or live mode;
- creator history before token arrival;
- a frontend-owned historical database;
- deployment to a production hostname;
- paid X or Telegram APIs;
- charting libraries, complex candlesticks, or inferred profitability claims.

## 16. Acceptance criteria

The PR is complete when:

1. `npm install` succeeds from an empty checkout using the root lockfile;
2. root build, check, lint, backend tests, frontend tests, and browser smoke tests
   pass;
3. all existing 977 backend tests remain green;
4. `frontend/dist/` is a standalone static artifact and is not committed;
5. the frontend has no import from backend implementation modules;
6. the frontend performs only GET requests to the configured API V1;
7. malformed or unsafe API/config data fails visibly and does not enter caches;
8. decimal financial strings are never converted to JavaScript floating point;
9. SSE reconnects with the last accepted transport cursor and handles cursor
   expiry without silent loss;
10. blockers remain visually independent from all three score dimensions;
11. radar, launch detail, paper positions, and health are keyboard-accessible and
    responsive;
12. no secret, wallet, signing dependency, transaction submission, or live mode
    is introduced;
13. README and frontend documentation explain what the console does and does not
    prove;
14. the backend listener behavior is unchanged;
15. launch radar summaries are loaded with bounded set-based queries and never
    one request or database query per row.

## 17. Known risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Backend additive contracts drift | frontend-owned runtime schemas accept safe additions and reject breaking changes |
| Radar enrichment creates N+1 load | qualification, candidate, and strategy summaries are fetched set-wise for the bounded launch page |
| SSE parser loses or duplicates revisions | incremental parser tests, deterministic cursor commit point, HTTP projections remain canonical |
| Different-origin deployment fails | explicit absolute runtime URL, `Last-Event-ID` preflight allowance, and cross-origin browser smoke fixtures |
| Dense UI hides uncertainty | dedicated unknown/partial/stale states and blocker-first hierarchy |
| Financial display introduces float error | decimal-string validators and bigint-only integer formatting |
| Frontend dependencies expand audit surface | pinned workspace lockfile, dependency audit kept separate as chantier 8/9 |
| E2E suite becomes slow | one deterministic Chromium smoke journey; detailed cases remain in Vitest/MSW |
| Browser cache outlives backend retention | no local launch archive; expired cursor forces canonical HTTP resynchronization |

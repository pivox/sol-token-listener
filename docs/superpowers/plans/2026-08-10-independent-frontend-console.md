# Independent Pump.fun Frontend Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver issue #41 as an autonomous React/Vite workspace that renders the public Pump.fun radar, launch evidence, paper simulations, and listener health from API V1 with resumable SSE.

**Architecture:** Extend the launch-list response with bounded set-based qualification and paper summaries, then keep all browser contracts and behavior inside `frontend/`. HTTP projections remain canonical; a bounded fetch-stream SSE client validates revisions, invalidates precise TanStack Query keys, and commits `Last-Event-ID` only after acceptance.

**Tech Stack:** Node >=22.12, TypeScript 5.8 strict ESM, React 19, Vite 8, React Router 7, TanStack Query 5, Zod 4, Bootstrap 5, Vitest 4, React Testing Library, MSW 2, Playwright 1.62, existing Node/PostgreSQL backend tests.

---

Design reference: `docs/superpowers/specs/2026-08-10-independent-frontend-console-design.md`

Issue: [#41](https://github.com/pivox/sol-token-listener/issues/41)

## File map

### Repository and backend

- `package.json` — root workspace orchestration and full-repository commands.
- `package-lock.json` — one reproducible lock for root and frontend workspace.
- `eslint.config.js` — keep backend lint scope isolated from frontend browser globals.
- `.gitignore` — ignore `frontend/dist`, coverage, Playwright output, and Vite cache.
- `src/api/contracts.ts` — additive qualification/candidate/paper launch summaries.
- `src/storage/api-projection.repository.ts` — set-based radar enrichment inside the existing repeatable-read snapshot.
- `src/interfaces/http/api-router.ts` — allow `Last-Event-ID` in public CORS preflight.
- `tests/api-contracts.test.ts` — compile/runtime examples for the additive contract.
- `tests/api-projection.repository.test.ts` — query count, canonical selection, null state, ordering, and snapshot tests.
- `tests/api-sse.test.ts` — CORS preflight regression.

### Frontend foundations

- `frontend/package.json` — autonomous package scripts and exact dependencies.
- `frontend/tsconfig.json`, `frontend/tsconfig.app.json`, `frontend/tsconfig.node.json` — strict browser and tool projects.
- `frontend/eslint.config.js` — browser/React strict lint policy.
- `frontend/vite.config.ts` — Vite, Vitest, coverage aliases, and dev host.
- `frontend/index.html` — application root and restrictive baseline metadata.
- `frontend/public/config.json` — safe replaceable local runtime API URL.
- `frontend/src/main.tsx` — load runtime configuration before rendering.
- `frontend/src/vite-env.d.ts` — Vite types only.
- `frontend/src/test/setup.ts` — jest-dom and test cleanup.
- `frontend/src/styles/app.css` — semantic colors and dense responsive layout.

### Frontend data layer

- `frontend/src/data/runtime-config.ts` — validate and normalize public runtime config.
- `frontend/src/data/api-schemas.ts` — frontend-owned Zod V1 contracts.
- `frontend/src/data/api-errors.ts` — stable typed public/network/contract errors.
- `frontend/src/data/api-client.ts` — bounded GET-only JSON transport.
- `frontend/src/data/query-keys.ts` — centralized cache identities and SSE invalidation map.
- `frontend/src/data/queries.ts` — typed TanStack Query options/hooks.
- `frontend/src/data/decimal.ts` — bigint-only integer and basis-point formatting.
- `frontend/src/data/sse-parser.ts` — incremental bounded SSE parser.
- `frontend/src/data/sse-cursor-store.ts` — origin/version-namespaced cursor persistence.
- `frontend/src/data/sse-client.ts` — lifecycle, backoff, expiry resync, and status snapshots.
- `frontend/src/data/realtime-provider.tsx` — one application-level stream and visible state.

### Frontend application/features

- `frontend/src/app/app.tsx` — providers, route tree, error boundary, and not-found page.
- `frontend/src/app/app-shell.tsx` — navigation and realtime status.
- `frontend/src/components/async-state.tsx` — loading/empty/error/stale/partial primitives.
- `frontend/src/components/format.tsx` — mint, timestamp, integer, score, and status renderers.
- `frontend/src/components/safe-external-link.tsx` — validated external links.
- `frontend/src/features/radar/radar-page.tsx` — infinite launch list, local filters, split selection.
- `frontend/src/features/radar/radar-table.tsx` — dense accessible table.
- `frontend/src/features/radar/launch-summary-panel.tsx` — blocker-first selected summary.
- `frontend/src/features/launch/launch-page.tsx` — validated mint route and shareable tabs.
- `frontend/src/features/launch/overview-panel.tsx` — identity, curve, candidate, and strategy.
- `frontend/src/features/launch/timeline-panel.tsx` — paginated typed timeline.
- `frontend/src/features/launch/risk-panel.tsx` — dimensions, conditions, evidence, and blockers.
- `frontend/src/features/launch/social-panel.tsx` — public evidence and coverage.
- `frontend/src/features/launch/holders-panel.tsx` — observed positions and clusters.
- `frontend/src/features/paper/paper-page.tsx` — simulated positions and PnL.
- `frontend/src/features/health/health-page.tsx` — bounded technical state without secrets.

### Frontend tests and delivery

- `frontend/src/**/*.test.ts(x)` — colocated unit/component tests.
- `frontend/tests/fixtures/api.ts` — synthetic complete V1 fixtures.
- `frontend/tests/msw/handlers.ts`, `frontend/tests/msw/server.ts` — deterministic API mocks.
- `frontend/tests/e2e/mock-api.mjs` — cross-origin HTTP/SSE mock and test controls.
- `frontend/tests/e2e/operator-console.spec.ts` — browser journey.
- `frontend/playwright.config.ts` — Chromium, preview server, mock API, artifacts on failure.
- `.github/workflows/ci.yml` — Node/PostgreSQL/backend/frontend/Chromium verification.
- `frontend/README.md`, `README.md`, `docs/api/v1.md` — operator and contract documentation.

## Task 1: Add the workspace without weakening backend commands

**Files:**
- Modify: `package.json`
- Modify: `eslint.config.js`
- Modify: `.gitignore`
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/tsconfig.app.json`
- Create: `frontend/tsconfig.node.json`
- Create: `frontend/eslint.config.js`
- Create: `frontend/vite.config.ts`
- Create: `frontend/index.html`
- Create: `frontend/public/config.json`
- Create: `frontend/src/vite-env.d.ts`
- Create: `frontend/src/test/setup.ts`
- Test: `tests/frontend-workspace.test.ts`

- [ ] **Step 1: Write the failing repository workspace test**

Add a Node test that reads both package manifests and asserts the workspace,
exact safe commands, Node floor, no frontend production dependency on Solana,
and ignored build artifacts:

```ts
void test('declares an isolated read-only frontend workspace', async () => {
  const root = await readJson('package.json');
  const frontend = await readJson('frontend/package.json');
  assert.deepEqual(root.workspaces, ['frontend']);
  assert.equal(root.engines.node, '>=22.12.0');
  assert.equal(root.scripts.build, 'npm run build:backend && npm run build --workspace frontend');
  assert.equal(root.scripts.check, 'npm run check:backend && npm run check --workspace frontend');
  assert.equal(root.scripts.lint, 'npm run lint:backend && npm run lint --workspace frontend');
  assert.equal(root.scripts.test, 'npm run test:backend && npm test --workspace frontend');
  assert.equal(frontend.private, true);
  assert.equal(frontend.scripts.test, 'vitest run');
  for (const name of Object.keys(frontend.dependencies as object)) {
    assert.equal(name.includes('solana'), false);
    assert.equal(name.includes('wallet'), false);
  }
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx tsx --test tests/frontend-workspace.test.ts`

Expected: FAIL because `frontend/package.json` and the workspace do not exist.

- [ ] **Step 3: Add exact workspace manifests and strict tool configuration**

Use exact versions captured during planning:

```json
{
  "name": "@pivox/sol-token-listener-frontend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "check": "tsc -b --pretty false",
    "lint": "eslint . --max-warnings=0",
    "test": "vitest run",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@tanstack/react-query": "5.101.4",
    "bootstrap": "5.3.8",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-router-dom": "7.18.2",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@eslint/js": "9.39.5",
    "@playwright/test": "1.62.1",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.3",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "@vitejs/plugin-react": "6.0.5",
    "eslint": "9.39.5",
    "eslint-plugin-react-hooks": "7.1.1",
    "eslint-plugin-react-refresh": "0.5.4",
    "globals": "17.9.0",
    "jsdom": "30.0.1",
    "msw": "2.15.0",
    "typescript": "5.8.3",
    "typescript-eslint": "8.65.0",
    "vite": "8.2.1",
    "vitest": "4.1.10"
  }
}
```

The browser compiler options must include `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noUnusedLocals`,
`noUnusedParameters`, `jsx: react-jsx`, and DOM/ES2022 libraries. Root ESLint
ignores `frontend/**`; frontend ESLint owns TSX/browser globals and enables the
recommended React Hooks and refresh rules.

- [ ] **Step 4: Install once and verify GREEN**

Run:

```bash
npm install
npx tsx --test tests/frontend-workspace.test.ts
npm run check --workspace frontend
npm run lint --workspace frontend
```

Expected: workspace test PASS; empty frontend typecheck/lint PASS; the single
root `package-lock.json` is updated and no nested lockfile exists.

- [ ] **Step 5: Commit the workspace boundary**

```bash
git add package.json package-lock.json eslint.config.js .gitignore frontend tests/frontend-workspace.test.ts
git commit -m "build: add independent frontend workspace (#41)"
```

## Task 2: Fix cross-origin resumable SSE preflight

**Files:**
- Modify: `tests/api-sse.test.ts`
- Modify: `src/interfaces/http/api-router.ts`
- Modify: `docs/api/v1.md`

- [ ] **Step 1: Write the failing preflight test**

Add an `OPTIONS /api/v1/events` request with
`Access-Control-Request-Headers: Last-Event-ID` and assert:

```ts
assert.equal(response.statusCode, 204);
assert.equal(response.headers['access-control-allow-origin'], '*');
assert.equal(response.headers['access-control-allow-methods'], 'GET, HEAD, OPTIONS');
assert.equal(response.headers['access-control-allow-headers'], 'Last-Event-ID');
```

Also assert `POST` remains absent from allow methods.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test --test-name-pattern='preflight.*Last-Event-ID' tests/api-sse.test.ts`

Expected: FAIL because `access-control-allow-headers` is absent.

- [ ] **Step 3: Add the minimal additive header**

Define a stable constant and return it from `writeOptions`:

```ts
const CORS_ALLOWED_HEADERS = 'Last-Event-ID';

function writeOptions(response: ServerResponse): void {
  response.writeHead(204, {
    allow: ALLOW,
    'content-length': 0,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': ALLOW,
    'access-control-allow-headers': CORS_ALLOWED_HEADERS,
  });
  response.end();
}
```

Document why browser `fetch` requires the preflight header.

- [ ] **Step 4: Verify GREEN and no router regression**

Run: `npx tsx --test tests/api-sse.test.ts tests/api-contracts.test.ts`

Expected: all selected backend API tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interfaces/http/api-router.ts tests/api-sse.test.ts docs/api/v1.md
git commit -m "feat: allow resumable SSE across origins (#41)"
```

## Task 3: Add set-based radar summaries to API V1

**Files:**
- Modify: `src/api/contracts.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `tests/api-contracts.test.ts`
- Modify: `tests/api-projection.repository.test.ts`
- Modify: `docs/api/v1.md`

- [ ] **Step 1: Write failing contract tests**

Define the desired additive shape in test data:

```ts
const qualificationSummary: ApiQualificationSummary = {
  verdict: 'WATCHLISTED',
  scores: {
    preparation: { score: 12, maximum: 15 },
    socialAuthenticity: { score: 17, maximum: 25 },
    onchainHealth: { score: 43, maximum: 60 },
    total: { score: 72, maximum: 100 },
  },
  blockerCodes: ['SHARED_FUNDER_CLUSTER'],
  evaluatedAt: '2026-08-10T12:00:00.000Z',
};

const summary: ApiLaunchSummary = {
  ...baseLaunch,
  qualificationSummary,
  candidate: null,
  paperStrategy: null,
};
```

Assert null summaries are explicit and `ApiLaunchDetail` inherits rather than
duplicates candidate/paper fields.

- [ ] **Step 2: Write failing repository tests before changing SQL**

Extend the query harness to return two launch rows and set-based results. Assert:

- one bulk qualification query, one bulk candidate query, and one bulk session
  query for the entire page;
- latest non-orphaned, unsuperseded, unexpired rows win deterministically;
- missing rows produce null fields;
- malformed stored payload causes `ApiProjectionDataError`;
- all enrichment queries run on the same repeatable-read client when `connect`
  exists;
- query count does not increase when the page grows from one to two launches.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npx tsx --test tests/api-contracts.test.ts tests/api-projection.repository.test.ts
```

Expected: FAIL because the contract fields and bulk loader do not exist.

- [ ] **Step 4: Implement the additive contract**

Add:

```ts
export interface ApiQualificationSummary {
  readonly verdict: QualificationVerdict;
  readonly scores: ApiQualificationScores;
  readonly blockerCodes: readonly QualificationReasonCode[];
  readonly evaluatedAt: string;
}

export interface ApiLaunchSummary {
  // existing fields remain unchanged
  readonly qualificationSummary: ApiQualificationSummary | null;
  readonly candidate: ApiTradingCandidate | null;
  readonly paperStrategy: ApiPaperStrategyProgress | null;
}

export interface ApiLaunchDetail extends ApiLaunchSummary {
  // existing detail-only fields; candidate/paperStrategy are inherited
}
```

- [ ] **Step 5: Implement bounded set-based projection loading**

Introduce a `RadarProjection` map and three `DISTINCT ON (mint)` queries using
`mint = ANY($1)`. Qualification rows select canonical `payload` so the existing
`qualification()` validator supplies score maxima and blockers. Candidate and
session queries select the same columns used by `loadPaperDecision`. All three
queries order by the public effective timestamp and stable ID descending.

The assembler must be equivalent to:

```ts
return freeze({
  ...existing,
  qualificationSummary: qualification === null ? null : freeze({
    verdict: qualification.verdict,
    scores: qualification.scores,
    blockerCodes: freeze(qualification.blockers.map(({ code }) => code)),
    evaluatedAt: qualification.evaluatedAt,
  }),
  candidate: radar.candidate,
  paperStrategy: radar.paperStrategy,
});
```

Reuse this radar loader for detail assembly so list and detail cannot disagree.
Keep all queries inside `withSnapshot` when a client is available.

- [ ] **Step 6: Verify GREEN and document compatibility**

Run:

```bash
npx tsx --test tests/api-contracts.test.ts tests/api-projection.repository.test.ts tests/api-sse.test.ts
npm run check:backend
```

Expected: all selected tests and backend typecheck PASS.

- [ ] **Step 7: Commit**

```bash
git add src/api/contracts.ts src/storage/api-projection.repository.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts docs/api/v1.md
git commit -m "feat: expose set-based launch radar summaries (#41)"
```

## Task 4: Bootstrap runtime configuration and safe integer formatting

**Files:**
- Create: `frontend/src/data/runtime-config.ts`
- Create: `frontend/src/data/runtime-config.test.ts`
- Create: `frontend/src/data/decimal.ts`
- Create: `frontend/src/data/decimal.test.ts`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/app/configuration-error.tsx`
- Create: `frontend/src/styles/app.css`

- [ ] **Step 1: Write RED tests for configuration**

Cover a valid absolute HTTP URL, trailing-slash normalization, and rejection of
credentials, query, fragment, non-HTTP schemes, relative values, extra fields,
oversized JSON, non-2xx response, and timeout. Assert no application factory is
called after failure.

The public API is:

```ts
export interface RuntimeConfig { readonly apiBaseUrl: string }
export async function loadRuntimeConfig(
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<RuntimeConfig>;
```

- [ ] **Step 2: Write RED integer-format tests**

Prove signed decimal strings and basis points without `Number`:

```ts
assert.equal(formatInteger('12345678901234567890'), '12 345 678 901 234 567 890');
assert.equal(formatBasisPoints('1234'), '12.34%');
assert.equal(formatBasisPoints('-5'), '-0.05%');
assert.throws(() => formatInteger('1.2'), DecimalFormatError);
```

- [ ] **Step 3: Run tests and verify RED**

Run: `npm test --workspace frontend -- --run runtime-config decimal`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement minimal validated loading and bigint formatting**

Use `z.object({ apiBaseUrl: z.string() }).strict()`, `URL`, bounded text reading,
and explicit `http:`/`https:` checks. Implement formatting from `BigInt(raw)` and
string slicing only; do not call `Number` or `parseFloat` on financial values.

`main.tsx` loads config first, then renders `App`; on failure it renders only
`ConfigurationError` and starts no query/SSE provider.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm test --workspace frontend -- --run runtime-config decimal
npm run check --workspace frontend
npm run lint --workspace frontend
```

Expected: all selected frontend tests PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src frontend/public/config.json
git commit -m "feat: load safe frontend runtime configuration (#41)"
```

## Task 5: Own and validate the API V1 contracts

**Files:**
- Create: `frontend/src/data/api-schemas.ts`
- Create: `frontend/src/data/api-schemas.test.ts`
- Create: `frontend/src/data/api-errors.ts`
- Create: `frontend/tests/fixtures/api.ts`

- [ ] **Step 1: Write failing schema tests from synthetic complete fixtures**

Fixtures must cover:

- success/failure envelopes and opaque cursors;
- launch summary/detail including radar summaries;
- null qualification/candidate/strategy;
- all qualification condition modes/statuses and stable blocker codes;
- social and holders availability unions;
- paper positions including retracted state and negative PnL;
- complete/degraded health;
- every domain SSE event type and orphaned confirmation;
- additive unknown fields accepted inside domain objects;
- unsafe numbers, malformed decimal strings/timestamps, missing discriminated
  fields, and unknown enum values rejected.

Use frontend-owned public constants rather than imports from `src/`:

```ts
export const domainEventTypeSchema = z.enum([
  'TokenLaunchDetected', 'TokenMetadataResolved', 'TokenMetadataFailed',
  'SocialEvidenceCollected', 'CreatorProfileUpdated',
  'HolderDistributionUpdated', 'WalletClusterDetected',
  'BondingCurveTradeObserved', 'BondingCurveStateUpdated',
  'BondingCurveCompleted', 'QualificationUpdated',
  'TradingCandidateUpdated', 'PaperStrategySessionUpdated',
  'PaperExternalBuyCounted', 'PaperPositionOpened',
  'PaperPositionUpdated', 'PaperPositionClosed', 'MigrationObserved',
  'PumpSwapPoolActivated',
]);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test --workspace frontend -- --run api-schemas`

Expected: FAIL because schemas do not exist.

- [ ] **Step 3: Implement schemas in dependency order**

Define primitives first (`isoTimestamp`, canonical mint, decimal integer, safe
integer, JSON payload bounds), then envelopes, shared records, list/detail,
risk/social/holders, paper, health, and SSE. Export inferred types with
`z.infer`, never handwritten duplicates.

Use `.passthrough()` on additive domain objects and `.strict()` on config,
envelopes, and safety-sensitive discriminated wrappers. Add `ApiContractError`
with route, bounded issues, and no raw body.

- [ ] **Step 4: Verify GREEN and frontend/backend fixture compatibility**

Run:

```bash
npm test --workspace frontend -- --run api-schemas
npx tsx --test tests/api-contracts.test.ts
npm run check --workspace frontend
```

Expected: schema and backend contract tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/data frontend/tests/fixtures
git commit -m "feat: validate frontend API V1 contracts (#41)"
```

## Task 6: Build the bounded GET-only HTTP client and query model

**Files:**
- Create: `frontend/src/data/api-client.ts`
- Create: `frontend/src/data/api-client.test.ts`
- Create: `frontend/src/data/query-keys.ts`
- Create: `frontend/src/data/query-keys.test.ts`
- Create: `frontend/src/data/queries.ts`
- Create: `frontend/tests/msw/handlers.ts`
- Create: `frontend/tests/msw/server.ts`

- [ ] **Step 1: Write failing client tests**

Assert GET-only behavior, URL encoding, `Accept: application/json`, timeout,
abort propagation, bounded response bytes, malformed JSON, schema failure,
typed public error mapping, correlation ID preservation, opaque next cursor, and
no retry for deterministic 4xx errors.

Expose explicit methods only:

```ts
export interface ApiClient {
  listLaunches(input: PageInput): Promise<ApiPage<ApiLaunchSummary>>;
  getLaunch(mint: string): Promise<ApiLaunchDetail>;
  listLaunchEvents(mint: string, input: PageInput): Promise<ApiPage<ApiTimelineEntry>>;
  getLaunchRisk(mint: string): Promise<ApiQualification | null>;
  getLaunchSocial(mint: string): Promise<ApiSocial>;
  getLaunchHolders(mint: string): Promise<ApiHolders>;
  listPaperPositions(input: PageInput): Promise<ApiPage<ApiPaperPosition>>;
  getHealth(): Promise<ApiHealth>;
}
```

- [ ] **Step 2: Write failing query-key/invalidation tests**

For every domain event type, assert the exact affected keys. Launch-scoped
events invalidate the radar and the matching mint detail; qualification,
social, holders, paper, and migration events additionally invalidate their
specific projections. Paper events invalidate the paper list. No event can
invalidate a different mint detail.

- [ ] **Step 3: Run tests and verify RED**

Run: `npm test --workspace frontend -- --run api-client query-keys`

Expected: FAIL because client/query modules are missing.

- [ ] **Step 4: Implement transport and TanStack query options**

Read response streams into a byte-bounded buffer before `JSON.parse`; use a
typed `ApiHttpError`, `ApiNetworkError`, and `ApiContractError`. Validate mints
before fetch. Build `infiniteQueryOptions` for launches/timeline/paper and query
options for detail resources/health. Retry transient errors at most twice with a
bounded delay.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm test --workspace frontend -- --run api-client query-keys
npm run check --workspace frontend
npm run lint --workspace frontend
```

Expected: selected frontend tests PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/data frontend/tests/msw
git commit -m "feat: query public projections safely (#41)"
```

## Task 7: Parse SSE incrementally and commit cursors safely

**Files:**
- Create: `frontend/src/data/sse-parser.ts`
- Create: `frontend/src/data/sse-parser.test.ts`
- Create: `frontend/src/data/sse-cursor-store.ts`
- Create: `frontend/src/data/sse-cursor-store.test.ts`

- [ ] **Step 1: Write exhaustive failing parser tests**

Cover LF/CRLF, arbitrary UTF-8 split points, comments, multiline data, unknown
fields, empty data, blank boundaries, final partial frame, NUL in ID, missing
ID/event, oversized line/event/buffer, invalid JSON, and two frames in one chunk.

The parser API stays transport-neutral:

```ts
export interface ParsedSseFrame {
  readonly id: string;
  readonly event: string;
  readonly data: string;
}

export class SseParser {
  push(chunk: Uint8Array): readonly ParsedSseFrame[];
  finish(): readonly ParsedSseFrame[];
}
```

- [ ] **Step 2: Write failing cursor-store tests**

Assert key names include API version and normalized origin, values are bounded,
malformed stored values are deleted, storage exceptions degrade to in-memory
operation, and one origin cannot read another origin's cursor.

- [ ] **Step 3: Run tests and verify RED**

Run: `npm test --workspace frontend -- --run sse-parser sse-cursor-store`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement the bounded parser and cursor store**

Use one `TextDecoder('utf-8', { fatal: true })`, explicit buffer byte accounting,
and immutable returned frames. Never treat `data.eventId` as cursor. The store
accepts only the frame `id` after the caller confirms acceptance.

- [ ] **Step 5: Verify GREEN and fuzz chunk boundaries deterministically**

Run: `npm test --workspace frontend -- --run sse-parser sse-cursor-store`

Expected: all parser/store cases PASS with no warning output.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/data/sse-parser* frontend/src/data/sse-cursor-store*
git commit -m "feat: parse resumable SSE frames safely (#41)"
```

## Task 8: Implement realtime lifecycle, backoff, and expiry resync

**Files:**
- Create: `frontend/src/data/sse-client.ts`
- Create: `frontend/src/data/sse-client.test.ts`
- Create: `frontend/src/data/realtime-provider.tsx`
- Create: `frontend/src/data/realtime-provider.test.tsx`

- [ ] **Step 1: Write failing lifecycle tests with fake time and streams**

Assert:

- request uses `Accept: text/event-stream`;
- saved cursor is sent as `Last-Event-ID`;
- cursor is not saved when schema validation or invalidation fails;
- cursor is saved after accepted invalidation scheduling;
- duplicate domain event IDs with different transport IDs are both accepted;
- 409/error-frame expiry enters `RESYNCING`, clears cursor, invalidates active
  queries, waits for settlement, then reconnects without the header;
- 400/406 becomes visible `DISCONNECTED` without a hot loop;
- network/5xx uses jittered bounded exponential backoff;
- offline pauses and online resumes;
- stop aborts fetch/read/retry and prevents updates after unmount.

Define a snapshot observable by React:

```ts
export type RealtimeState =
  | 'CONNECTING' | 'LIVE' | 'RECONNECTING'
  | 'RESYNCING' | 'DISCONNECTED' | 'STOPPED';

export interface RealtimeSnapshot {
  readonly state: RealtimeState;
  readonly lastEventAt: string | null;
  readonly retryAttempt: number;
  readonly errorCode: string | null;
}
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test --workspace frontend -- --run sse-client realtime-provider`

Expected: FAIL because lifecycle/provider do not exist.

- [ ] **Step 3: Implement one stream per application**

Compose `fetch`, `SseParser`, `apiSseEventSchema`, cursor store, query-key mapper,
and `QueryClient`. Use `useSyncExternalStore` in `RealtimeProvider`; do not open a
stream per component. Keep all scheduled timers and abort controllers owned by
the client instance.

- [ ] **Step 4: Verify GREEN and resource cleanup**

Run:

```bash
npm test --workspace frontend -- --run sse-client realtime-provider
npm run check --workspace frontend
npm run lint --workspace frontend
```

Expected: lifecycle tests PASS; no open-handle warnings.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/data/sse-client* frontend/src/data/realtime-provider*
git commit -m "feat: resume frontend realtime updates explicitly (#41)"
```

## Task 9: Compose the accessible application shell

**Files:**
- Create: `frontend/src/app/app.tsx`
- Create: `frontend/src/app/app.test.tsx`
- Create: `frontend/src/app/app-shell.tsx`
- Create: `frontend/src/app/error-boundary.tsx`
- Create: `frontend/src/components/async-state.tsx`
- Create: `frontend/src/components/format.tsx`
- Create: `frontend/src/components/safe-external-link.tsx`
- Create: `frontend/src/components/safe-external-link.test.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/styles/app.css`

- [ ] **Step 1: Write failing shell and safety tests**

Render with a memory router and assert navigation for Radar, Positions paper,
and Santé; a persistent `Simulation uniquement` label; realtime status with text
not color alone; route error isolation; keyboard-visible navigation; not-found
route; safe `http/https` external anchors; unsafe schemes rendered as text; and
`noopener noreferrer` for new tabs.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test --workspace frontend -- --run app safe-external-link`

Expected: FAIL because the shell/components are missing.

- [ ] **Step 3: Implement providers and route skeletons**

Compose one `QueryClientProvider`, one `RealtimeProvider`, `BrowserRouter`, and
route-level lazy components. Provide placeholders only for routes implemented in
later tasks, but make all navigation and error boundaries real and tested.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test --workspace frontend -- --run app safe-external-link
npm run build --workspace frontend
```

Expected: shell tests and first production build PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app frontend/src/components frontend/src/main.tsx frontend/src/styles/app.css
git commit -m "feat: compose the read-only operator shell (#41)"
```

## Task 10: Build the dense launch radar

**Files:**
- Create: `frontend/src/features/radar/radar-page.tsx`
- Create: `frontend/src/features/radar/radar-page.test.tsx`
- Create: `frontend/src/features/radar/radar-table.tsx`
- Create: `frontend/src/features/radar/launch-summary-panel.tsx`
- Modify: `frontend/src/app/app.tsx`

- [ ] **Step 1: Write failing radar behavior tests**

Use MSW to cover loading, empty, first page, load-more cursor, selected row,
search/filter across loaded rows, disconnected stale cache, null qualification,
active blocker, unknown evidence, candidate expiry, paper progress, and mobile
semantic order. Explicitly assert:

```ts
expect(screen.getByRole('alert', { name: /condition éliminatoire/i })).toBeVisible();
expect(screen.getByText('72 / 100')).toBeVisible();
expect(blocker.compareDocumentPosition(score) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
```

Assert selecting a row does not trigger per-row risk/detail requests; only the
pre-enriched list data populates the quick panel.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test --workspace frontend -- --run radar-page`

Expected: FAIL because radar components are missing.

- [ ] **Step 3: Implement list, local filters, and blocker-first panel**

Use one `useInfiniteQuery`, stable row keys by mint, native table semantics,
`aria-selected`, a load-more button, and a statement that filters cover loaded
retention pages. Preserve selection when a refetch updates the same mint.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test --workspace frontend -- --run radar-page
npm run check --workspace frontend
npm run lint --workspace frontend
```

Expected: radar tests PASS without act/open-handle warnings.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/radar frontend/src/app/app.tsx
git commit -m "feat: render the explainable launch radar (#41)"
```

## Task 11: Build the complete launch detail

**Files:**
- Create: `frontend/src/features/launch/launch-page.tsx`
- Create: `frontend/src/features/launch/launch-page.test.tsx`
- Create: `frontend/src/features/launch/overview-panel.tsx`
- Create: `frontend/src/features/launch/timeline-panel.tsx`
- Create: `frontend/src/features/launch/risk-panel.tsx`
- Create: `frontend/src/features/launch/social-panel.tsx`
- Create: `frontend/src/features/launch/holders-panel.tsx`
- Modify: `frontend/src/app/app.tsx`

- [ ] **Step 1: Write failing route and tab tests**

Cover canonical mint validation before network access, 404, overview, shareable
tab query/path state, paginated timeline, escaped diagnostic payload, all three
scores, blocker priority, condition modes/statuses, social `NOT_AVAILABLE` and
partial coverage, safe links, holders `NOT_AVAILABLE`, creator metrics,
concentration, cluster truncation/coverage, orphaned timeline styling, and
refetch after mint-scoped SSE invalidation.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test --workspace frontend -- --run launch-page`

Expected: FAIL because launch feature components are missing.

- [ ] **Step 3: Implement route orchestration and focused panels**

Each tab owns only its query and rendering. Keep diagnostic JSON in a collapsed
`details` element using escaped `<pre>{JSON.stringify(...)}</pre>`. Render
`UNKNOWN`, `NOT_AVAILABLE`, truncation, and observed-only methodology explicitly.
Never infer wallet history or social authenticity from presence.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test --workspace frontend -- --run launch-page
npm run check --workspace frontend
npm run lint --workspace frontend
```

Expected: launch detail tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/launch frontend/src/app/app.tsx
git commit -m "feat: explain launch evidence and risk (#41)"
```

## Task 12: Build paper positions and technical health

**Files:**
- Create: `frontend/src/features/paper/paper-page.tsx`
- Create: `frontend/src/features/paper/paper-page.test.tsx`
- Create: `frontend/src/features/health/health-page.tsx`
- Create: `frontend/src/features/health/health-page.test.tsx`
- Modify: `frontend/src/app/app.tsx`

- [ ] **Step 1: Write failing paper tests**

Cover empty/paginated positions, holding/closed/retracted states, venue,
lineage, external-buy progress, signed PnL, fees, missing exit values, reason
codes, stale cache, and permanent simulation labeling. Assert no button text or
accessible name contains `buy`, `sell`, `acheter`, or `vendre` as an action.

- [ ] **Step 2: Write failing health tests**

Cover OK/degraded, PostgreSQL unavailable error envelope, every pipeline state,
worker backlog/exhaustion, heartbeat age, missing optional fields, stale data,
manual refresh, and stable last-error codes. Seed fixtures with fake RPC/database
URLs and internal stack messages and assert they never appear in the document.

- [ ] **Step 3: Run tests and verify RED**

Run: `npm test --workspace frontend -- --run paper-page health-page`

Expected: FAIL because both routes are missing.

- [ ] **Step 4: Implement the two read-only pages**

Use infinite query for paper positions and bounded polling plus SSE invalidation
for health. Format raw integers with the decimal module. Present PnL as estimated
simulation and health errors as stable public codes only.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm test --workspace frontend -- --run paper-page health-page
npm run build --workspace frontend
npm run check --workspace frontend
npm run lint --workspace frontend
```

Expected: both feature suites and frontend production build PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/paper frontend/src/features/health frontend/src/app/app.tsx
git commit -m "feat: expose paper simulations and listener health (#41)"
```

## Task 13: Prove the browser journey across origins

**Files:**
- Create: `frontend/tests/e2e/mock-api.mjs`
- Create: `frontend/tests/e2e/operator-console.spec.ts`
- Create: `frontend/playwright.config.ts`
- Modify: `frontend/package.json`

- [ ] **Step 1: Write the Playwright test before the mock control exists**

The test must:

1. open the radar served from `127.0.0.1:4173` while API/SSE uses
   `127.0.0.1:3000`;
2. wait for `LIVE` and initial launch;
3. call the test-only mock control to add a launch and emit an SSE revision;
4. observe radar refresh;
5. navigate to launch risk/social/holders/timeline;
6. navigate to paper and health;
7. force one reconnect and assert the mock received `Last-Event-ID`;
8. force `EVENT_CURSOR_EXPIRED`, observe `RESYNCING`, and verify HTTP refresh
   followed by `LIVE`;
9. assert no write request originated from the browser application.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npx playwright install chromium
npm run e2e --workspace frontend
```

Expected: FAIL because the deterministic mock API/SSE server is absent.

- [ ] **Step 3: Implement the deterministic cross-origin mock**

Use `node:http`, in-memory projections, explicit CORS including
`Last-Event-ID`, SSE clients, and test-control routes bound to loopback. Record
all app requests. Never import backend code or use real Solana identifiers.

Configure Playwright `webServer` entries for the mock on 3000 and Vite preview on
4173, one Chromium project, trace/screenshot on failure, and no retries locally.

- [ ] **Step 4: Verify GREEN twice for determinism**

Run:

```bash
npm run e2e --workspace frontend
npm run e2e --workspace frontend
```

Expected: both runs PASS; no port/open-handle leak remains.

- [ ] **Step 5: Commit**

```bash
git add frontend/tests/e2e frontend/playwright.config.ts frontend/package.json package-lock.json
git commit -m "test: validate the independent operator journey (#41)"
```

## Task 14: Integrate CI, documentation, and full verification

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `frontend/README.md`
- Modify: `README.md`
- Modify: `docs/api/v1.md`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/system-overview.html`
- Modify: `scripts/check-system-overview.ts` if new required references need validation

- [ ] **Step 1: Write/extend documentation contract tests first**

Extend the existing system-overview/document checks to require:

- `frontend/README.md` startup and runtime config;
- explicit read-only/no-wallet/no-profit language;
- the four frontend routes;
- fetch-based SSE and `Last-Event-ID` expiry behavior;
- additive launch radar summary fields;
- separate static deployment and CORS preflight note.

- [ ] **Step 2: Run docs check and verify RED**

Run: `npm run docs:check`

Expected: FAIL because the frontend documentation/reference sections are absent.

- [ ] **Step 3: Add CI and operator documentation**

The workflow uses Node 22.12+ and PostgreSQL, then runs:

```yaml
- run: npm ci
- run: npm run build
- run: npm run check
- run: npm run lint
- run: npm test
  env:
    TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres
- run: npx playwright install --with-deps chromium
- run: npm run frontend:e2e
```

Document local backend/frontend startup, replacement of `config.json`, static
hosting headers, CORS, browser support, simulation-only semantics, four-hour
retention, observable limitations, and no production deployment in this PR.

- [ ] **Step 4: Run the smallest checks, then the complete acceptance suite**

Run:

```bash
npm run docs:check
npm run build
npm run check
npm run lint
TEST_DATABASE_URL='postgresql://haythem.mabrouk@127.0.0.1:5432/postgres' npm test
npm run frontend:e2e
git diff --check
git status --short --branch
```

Expected:

- build/check/lint/docs all exit 0;
- all existing backend tests plus new backend/frontend tests pass;
- Playwright passes;
- no generated artifact, secret, unrelated edit, or untracked file remains.

- [ ] **Step 5: Perform the local review checklist**

Inspect `git diff origin/main...HEAD` for:

- imports crossing `frontend/` → `src/`;
- fetch methods other than GET in production frontend source;
- `Number`, `parseFloat`, or arithmetic applied to financial strings;
- unbounded response/SSE buffers;
- cursor commit before frame acceptance;
- blockers visually hidden by score;
- unsafe URL/HTML rendering;
- N+1 browser or PostgreSQL queries;
- backend listener/runtime behavior changes;
- secrets, real wallets, or live-execution language.

Fix every finding with a focused test before implementation changes.

- [ ] **Step 6: Commit final integration**

```bash
git add .github frontend/README.md README.md docs scripts package.json package-lock.json
git commit -m "docs: operate the independent frontend console (#41)"
```

## Task 15: Push, review up to three rounds, and merge

**Files:** no planned source changes; review fixes remain scoped and test-first.

- [ ] **Step 1: Verify the final branch and push**

```bash
git status --short --branch
git log --oneline origin/main..HEAD
git push -u origin feature/frontend-console-41
```

Expected: clean branch and successful push.

- [ ] **Step 2: Open the PR linked to issue #41**

```bash
gh pr create \
  --title "feat: deliver independent Pump.fun console (#41)" \
  --body $'Closes #41\n\n## Summary\n- add a standalone React/Vite operator console over public API V1/SSE\n- expose set-based launch radar qualification and paper summaries\n- resume cross-origin SSE without silent event loss\n- validate radar, launch evidence, paper simulations and health in Chromium\n\n## Safety\n- read-only GET traffic only\n- no wallet, key, signature, transaction or live mode\n- bigint/string financial rendering\n\n## Verification\n- npm run build\n- npm run check\n- npm run lint\n- npm run docs:check\n- TEST_DATABASE_URL=... npm test\n- npm run frontend:e2e'
```

- [ ] **Step 3: Request posted Codex review**

```bash
FRONTEND_PR_NUMBER=$(gh pr view --json number --jq '.number')
gh pr comment "$FRONTEND_PR_NUMBER" --body '@codex please review this PR. Focus on contract compatibility, CORS/SSE cursor correctness, bounded parsing, React lifecycle cleanup, bigint financial safety, accessibility, N+1 regressions, test gaps, and any path that could imply or enable real execution. Please post review threads or a PR comment.'
```

- [ ] **Step 4: Run at most three correction-review rounds**

For each round: inspect every unresolved thread with GraphQL, reproduce each
actionable issue, add a failing regression test, implement the minimal fix, run
focused and full checks proportionate to the change, push, respond with evidence,
resolve addressed threads, and request one follow-up review. Stop after three
rounds and report blockers rather than merging unresolved risk.

- [ ] **Step 5: Merge only after all gates are clear**

Confirm checks complete, mergeable status, no unresolved blocking threads, and
the full acceptance suite. Then squash-merge, synchronize main, and verify:

```bash
FRONTEND_PR_NUMBER=$(gh pr view --json number --jq '.number')
gh pr merge "$FRONTEND_PR_NUMBER" --squash --delete-branch
git fetch origin
git -C /Users/haythem.mabrouk/workspace/perso/sol-token-listener switch main
git -C /Users/haythem.mabrouk/workspace/perso/sol-token-listener pull --ff-only origin main
gh issue view 41 --json state,url
```

Expected: PR merged, issue #41 closed, local `main` synchronized, and no live
execution capability introduced.

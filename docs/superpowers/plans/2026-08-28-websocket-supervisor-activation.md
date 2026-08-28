# Solana WebSocket Supervisor Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the generation-fenced Pump.fun/PumpSwap WebSocket failover supervisor in production, with dual ACK, exact provider-pinned recovery, promoted-provider finality, degraded paper gating, and fail-closed shutdown.

**Architecture:** A new application-level `WebSocketFailoverSupervisor` acquires the durable PostgreSQL owner before any Solana call, owns one incumbent plus at most one candidate, and promotes only after the native session has both ACKs and a strict two-program scan has durably completed. Existing inbox, strict scanner, provider-pinned adapters, finality passes, and WebSocket health reporter remain the convergence and evidence boundaries; the production runtime replaces only the legacy pre-scan/web3.js subscriber composition. Provider rotation is finite, periodic scans are serialized, finality captures the promoted provider once per pass, and a joint current WebSocket/finality fence suppresses every paper claim and mutation while degraded.

**Tech Stack:** TypeScript strict ESM, Node 22 native `WebSocket`, `@solana/web3.js`, PostgreSQL/`pg`, Node test runner via `tsx --test`, bigint-safe domain boundaries, Docker Compose, React/API health contract already delivered by issue #62.

---

## File structure

- `src/domain/solana-genesis-hash.ts` — one canonical base58/32-byte validator shared by configuration and pinned catch-up.
- `src/config/env.ts` — required `SOLANA_EXPECTED_GENESIS_HASH` when the listener is enabled.
- `src/solana/rpc/rpc-provider-catalog.ts` — strict primary HTTP/WS pairing even without fallbacks.
- `src/solana/rpc/provider-pinned-catch-up-source.ts` — reuse the shared genesis validator.
- `src/application/strict-catch-up-scanner.ts` — cooperative abort fences and non-enumerable exact-frontier evidence.
- `src/application/strict-catch-up-coordinator.ts` — one coalesced abort-aware scan.
- `src/application/promoted-provider-selector.ts` — promoted provider identity and immutable provider-pinned finality pass selection.
- `src/application/websocket-failover-supervisor.ts` — owner/session generations, ACK/recovery/promotion, rotation, periodic frontier and shutdown.
- `src/application/listener-runtime.ts` — supervisor-first start and supervisor-first stop.
- `src/application/production-listener-factory.ts` — concrete provider/session/scanner/health/finality composition.
- `src/application/paper-decision-worker.ts` — readiness predicate before any paper claim or active-session mutation.
- `tests/websocket-failover-supervisor.test.ts` — deterministic unit lifecycle, rotation, overlap, timers and cleanup.
- `tests/websocket-failover-supervisor.integration.test.ts` — real PostgreSQL owner, inbox, health, checkpoint and crash/fault matrix.
- Existing focused tests, deployment artifacts and operational documents are modified only where named below.

Do not delete `CatchUpScanner`, `StartupScanner`, `SolanaProgramSubscriber`, or their tests. They remain diagnostic/secondary components; only production composition stops using them.

---

### Task 1: Explicit genesis configuration and strict paired catalog

**Files:**
- Create: `src/domain/solana-genesis-hash.ts`
- Create: `tests/solana-genesis-hash.test.ts`
- Modify: `src/config/env.ts:15-111,154-245`
- Modify: `src/solana/rpc/provider-pinned-catch-up-source.ts:1-176`
- Modify: `src/solana/rpc/rpc-provider-catalog.ts:22-102`
- Modify: `tests/config-safety.test.ts`
- Modify: `tests/provider-pinned-catch-up-source.test.ts`
- Modify: `tests/rpc-provider-catalog.test.ts`

- [ ] **Step 1: Write the failing genesis and configuration tests (RED)**

Add a focused domain test with canonical and hostile cases:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  canonicalSolanaGenesisHash,
  requireSolanaGenesisHash,
  SolanaGenesisHashError,
} from '../src/domain/solana-genesis-hash.js';

const canonical = bs58.encode(Buffer.alloc(32, 7));

void test('accepts only canonical base58 values that decode to exactly 32 bytes', () => {
  assert.equal(canonicalSolanaGenesisHash(canonical), true);
  for (const value of ['', ` ${canonical}`, `${canonical} `, '0'.repeat(32),
    bs58.encode(Buffer.alloc(31, 7)), bs58.encode(Buffer.alloc(33, 7))]) {
    assert.equal(canonicalSolanaGenesisHash(value), false);
  }
});

void test('requires the expected genesis only for an enabled listener', () => {
  assert.equal(requireSolanaGenesisHash(canonical, true), canonical);
  assert.equal(requireSolanaGenesisHash(undefined, false), null);
  assert.throws(
    () => requireSolanaGenesisHash(undefined, true),
    (error: unknown) => error instanceof SolanaGenesisHashError
      && error.field === 'SOLANA_EXPECTED_GENESIS_HASH'
      && !String(error).includes(canonical),
  );
});
```

In `tests/config-safety.test.ts`, add exact assertions:

```ts
const expectedGenesis = bs58.encode(Buffer.alloc(32, 9));
assert.equal(parseConfig({
  SOLANA_HTTP_RPC_URL: 'https://rpc.invalid',
  SOLANA_WS_RPC_URL: 'wss://rpc.invalid',
  SOLANA_EXPECTED_GENESIS_HASH: expectedGenesis,
}).expectedGenesisHash, expectedGenesis);
assert.equal(parseConfig({
  SOLANA_HTTP_RPC_URL: 'https://rpc.invalid',
  SOLANA_WS_RPC_URL: 'wss://rpc.invalid',
  LISTENER_ENABLED: 'false',
}).expectedGenesisHash, null);
assert.throws(() => parseConfig({
  SOLANA_HTTP_RPC_URL: 'https://secret.invalid/rpc?key=secret',
  SOLANA_WS_RPC_URL: 'wss://secret.invalid/rpc?key=secret',
}), (error: unknown) => {
  assert.match(String(error), /SOLANA_EXPECTED_GENESIS_HASH/u);
  assert.doesNotMatch(String(error), /secret\.invalid|key=|rpc\?/u);
  return true;
});
```

In `tests/rpc-provider-catalog.test.ts`, add primary-only strict-pair cases for `https:/wss:` and `http:/ws:`, and reject `https:/ws:`, `http:/wss:` and fragments even when both fallback lists are empty.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx tsx --test tests/solana-genesis-hash.test.ts tests/config-safety.test.ts \
  tests/provider-pinned-catch-up-source.test.ts tests/rpc-provider-catalog.test.ts
```

Expected: FAIL because `solana-genesis-hash.ts` and `AppConfig.expectedGenesisHash` do not exist, and the current primary-only catalog accepts mixed schemes/fragments.

- [ ] **Step 3: Add the shared canonical genesis boundary (GREEN)**

Create `src/domain/solana-genesis-hash.ts` exactly as a redacted domain boundary:

```ts
import bs58 from 'bs58';

const BASE58_TEXT = /^[1-9A-HJ-NP-Za-km-z]+$/u;

export class SolanaGenesisHashError extends TypeError {
  public readonly field = 'SOLANA_EXPECTED_GENESIS_HASH' as const;

  public constructor() {
    super('SOLANA_EXPECTED_GENESIS_HASH is invalid.');
    this.name = 'SolanaGenesisHashError';
    Object.freeze(this);
  }
}

export function canonicalSolanaGenesisHash(value: unknown): value is string {
  if (typeof value !== 'string'
    || value.length < 32
    || value.length > 44
    || !BASE58_TEXT.test(value)) return false;
  try {
    const decoded = bs58.decode(value);
    return decoded.byteLength === 32 && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
}

export function requireSolanaGenesisHash(
  value: string | undefined,
  listenerEnabled: boolean,
): string | null {
  if (!listenerEnabled && (value === undefined || value === '')) return null;
  if (!canonicalSolanaGenesisHash(value)) throw new SolanaGenesisHashError();
  return value;
}
```

Parse `listenerEnabled` before constructing the `AppConfig`, add
`readonly expectedGenesisHash: string | null`, and assign:

```ts
const listenerEnabled = parseBoolean(environment.LISTENER_ENABLED, true, 'LISTENER_ENABLED');
const expectedGenesisHash = requireSolanaGenesisHash(
  environment.SOLANA_EXPECTED_GENESIS_HASH,
  listenerEnabled,
);
```

Then return the captured `listenerEnabled` and `expectedGenesisHash` values. Import and use `canonicalSolanaGenesisHash` inside `provider-pinned-catch-up-source.ts`; remove its duplicate regex/length/decoder implementation without changing its fixed error reasons.

- [ ] **Step 4: Make every primary provider pair strict (GREEN)**

Replace the catalog's conditional primary validation with the same strict rule used by fallbacks:

```ts
if (httpFallbacks.length > 3
  || websocketFallbacks.length > 3
  || (websocketFallbacks.length > 0 && websocketFallbacks.length !== httpFallbacks.length)
  || !validStrictPair(config.httpRpcUrl, config.wsRpcUrl)
  || !uniqueUrls([config.httpRpcUrl, ...httpFallbacks])
  || !uniqueUrls([config.wsRpcUrl, ...websocketFallbacks])) {
  throw invalidCatalog();
}
```

`validStrictPair` must continue to reject fragments and require `https:/wss:` or `http:/ws:`. Never include either URL in an error.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run the Step 2 command again.

Expected: PASS; config errors contain only `SOLANA_EXPECTED_GENESIS_HASH`, and primary-only invalid pairs are rejected.

- [ ] **Step 6: Commit the configuration boundary**

```bash
git add src/domain/solana-genesis-hash.ts src/config/env.ts \
  src/solana/rpc/provider-pinned-catch-up-source.ts \
  src/solana/rpc/rpc-provider-catalog.ts tests/solana-genesis-hash.test.ts \
  tests/config-safety.test.ts tests/provider-pinned-catch-up-source.test.ts \
  tests/rpc-provider-catalog.test.ts
git commit -m "feat: require websocket recovery genesis hash (#63)"
```

---

### Task 2: Abort-aware strict scanner and exact-frontier proof

**Files:**
- Modify: `src/application/strict-catch-up-scanner.ts:31-488`
- Modify: `src/application/strict-catch-up-coordinator.ts:1-50`
- Modify: `tests/strict-catch-up-scanner.test.ts`
- Modify: `tests/strict-catch-up-coordinator.test.ts`

- [ ] **Step 1: Write failing abort and frontier tests (RED)**

Add tests proving abort before a scan makes no call, abort after a page makes no enqueue, abort after an enqueue makes no CAS, and abort after the first CAS prevents the second CAS. Use a deferred fake at each awaited boundary and assert the next durable call is absent.

Add a same-frontier test that exposes no raw signatures through enumeration or JSON:

```ts
const frontier = Object.freeze({
  launchpad: Object.freeze({ key: 'launchpad' as const, slot: 10n, signature: 'launch-secret', updatedAtMs: 1 }),
  market: Object.freeze({ key: 'market' as const, slot: 11n, signature: 'market-secret', updatedAtMs: 1 }),
});
const first = new StrictCatchUpWindowExceededError('primary', 'launchpad', frontier);
const equal = new StrictCatchUpWindowExceededError('fallback-1', 'market', frontier);
const different = new StrictCatchUpWindowExceededError('fallback-2', 'market', Object.freeze({
  ...frontier,
  market: Object.freeze({ ...frontier.market, signature: 'different-secret' }),
}));

assert.equal(first.sameFrontier(equal), true);
assert.equal(first.sameFrontier(different), false);
assert.deepEqual(Object.keys(first), ['code', 'stage', 'retryable', 'providerId', 'checkpointKey']);
assert.doesNotMatch(JSON.stringify(first), /launch-secret|market-secret/u);
```

For the coordinator, prove concurrent `run(signal)` calls share one promise, and the first run's signal is the sole signal passed to the scanner.

- [ ] **Step 2: Run the strict tests and verify RED**

```bash
npx tsx --test tests/strict-catch-up-scanner.test.ts \
  tests/strict-catch-up-coordinator.test.ts
```

Expected: FAIL because `scan`/`run` do not accept `AbortSignal`, there is no abort error, and window errors cannot compare both captured frontiers.

- [ ] **Step 3: Add immutable private frontier evidence (GREEN)**

Keep frontier material outside the enumerable error object:

```ts
const WINDOW_FRONTIERS = new WeakMap<StrictCatchUpWindowExceededError, StrictCatchUpBoundaries>();

export class StrictCatchUpAbortedError extends Error {
  public constructor() {
    super('Strict catch-up scan was aborted.');
    this.name = 'StrictCatchUpAbortedError';
    Object.freeze(this);
  }
}

export class StrictCatchUpWindowExceededError extends Error {
  public readonly code = 'CATCH_UP_WINDOW_EXCEEDED' as const;
  public readonly stage = 'window' as const;
  public readonly retryable = false;

  public constructor(
    public readonly providerId: RpcProviderId,
    public readonly checkpointKey: ProcessingCheckpointKey,
    frontier: StrictCatchUpBoundaries,
  ) {
    super('Strict catch-up scan window was exceeded.');
    this.name = 'StrictCatchUpWindowExceededError';
    WINDOW_FRONTIERS.set(this, snapshotBoundaries(frontier));
    Object.freeze(this);
  }

  public sameFrontier(other: StrictCatchUpWindowExceededError): boolean {
    const left = WINDOW_FRONTIERS.get(this);
    const right = WINDOW_FRONTIERS.get(other);
    return left !== undefined && right !== undefined
      && sameCheckpoint(left.launchpad, right.launchpad)
      && sameCheckpoint(left.market, right.market);
  }
}

function sameCheckpoint(left: ProcessingCheckpoint | null, right: ProcessingCheckpoint | null): boolean {
  return left === null || right === null
    ? left === right
    : left.key === right.key && left.slot === right.slot && left.signature === right.signature;
}
```

`snapshotBoundaries` must clone and freeze both checkpoints, including `null`, and must never expose the clone. Throw the window error with the two checkpoints captured before pagination, not with a later re-read.

- [ ] **Step 4: Fence every asynchronous boundary with one signal (GREEN)**

Use one fixed helper before and after each awaited checkpoint read, source page, enqueue, failure write, failure resolution and checkpoint CAS:

```ts
function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new StrictCatchUpAbortedError();
}

private async awaited<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  assertNotAborted(signal);
  const value = await operation();
  assertNotAborted(signal);
  return value;
}
```

Change the scanner signature to require the signal and route every existing
await through `this.awaited(signal, operation)`. Change the coordinator public
method with this complete coalescing body:

```ts
export interface StrictCatchUpScannerPort {
  scan(signal: AbortSignal): Promise<StrictCatchUpScanResult>;
}

public run(signal: AbortSignal): Promise<StrictCatchUpScanResult> {
  if (this.inFlight !== null) return this.inFlight;

  const deferred = deferredStrictCatchUpScan();
  const run = deferred.promise;
  this.inFlight = run;
  void run.then(
    () => { this.clear(run); },
    () => { this.clear(run); },
  );
  try {
    deferred.resolve(this.scanner.scan(signal));
  } catch (error) {
    deferred.reject(error);
  }
  return run;
}
```

When an abort occurs after a completed first CAS, do not attempt to undo it; the next strict scan safely captures that new boundary and replays the other program through the inbox.

- [ ] **Step 5: Run the strict tests and verify GREEN**

Run the Step 2 command.

Expected: PASS, including the no-write-after-abort assertions and non-enumerable exact-frontier evidence.

- [ ] **Step 6: Commit cooperative strict recovery**

```bash
git add src/application/strict-catch-up-scanner.ts \
  src/application/strict-catch-up-coordinator.ts \
  tests/strict-catch-up-scanner.test.ts tests/strict-catch-up-coordinator.test.ts
git commit -m "feat: fence strict catch-up cancellation (#63)"
```

---

### Task 3: Promoted provider selector and provider-affine finality source

**Files:**
- Create: `src/application/promoted-provider-selector.ts`
- Create: `tests/promoted-provider-selector.test.ts`

- [ ] **Step 1: Write the failing selector tests (RED)**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { FinalityProviderPass } from '../src/ports/finality-provider-pass.js';
import {
  PromotedProviderSelector,
  PromotedProviderUnavailableError,
} from '../src/application/promoted-provider-selector.js';

function pass(providerId: FinalityProviderPass['providerId']): FinalityProviderPass {
  return Object.freeze({
    providerId,
    getHistoryStatuses: async () => Object.freeze([]),
    getFinalizedSlot: async () => 0n,
    getFinalizedBlockSignatures: async () => Object.freeze([]),
  });
}

void test('captures one immutable promoted finality pass per openPass call', () => {
  const primary = pass('primary');
  const fallback = pass('fallback-1');
  const selector = new PromotedProviderSelector([primary, fallback]);
  assert.equal(selector.activeProviderId(), null);
  assert.throws(() => selector.openPass(), PromotedProviderUnavailableError);
  selector.promote('primary');
  const captured = selector.openPass();
  selector.promote('fallback-1');
  assert.equal(captured, primary);
  assert.equal(selector.openPass(), fallback);
});

void test('rejects missing, duplicate, and unsupported pass identities', () => {
  assert.throws(() => new PromotedProviderSelector([]), TypeError);
  assert.throws(() => new PromotedProviderSelector([pass('primary'), pass('primary')]), TypeError);
});
```

- [ ] **Step 2: Run the selector test and verify RED**

```bash
npx tsx --test tests/promoted-provider-selector.test.ts
```

Expected: FAIL because `promoted-provider-selector.ts` does not exist.

- [ ] **Step 3: Implement the selector as the finality pass source (GREEN)**

```ts
import type { RpcProviderId } from '../domain/rpc-provider.js';
import type {
  FinalityProviderPass,
  FinalityProviderPassSource,
} from '../ports/finality-provider-pass.js';

export class PromotedProviderUnavailableError extends Error {
  public constructor() {
    super('Promoted RPC provider is unavailable.');
    this.name = 'PromotedProviderUnavailableError';
    Object.freeze(this);
  }
}

export class PromotedProviderSelector implements FinalityProviderPassSource {
  private readonly passes: ReadonlyMap<RpcProviderId, FinalityProviderPass>;
  private promoted: RpcProviderId | null = null;

  public constructor(values: readonly FinalityProviderPass[]) {
    const entries = values.map((value) => [value.providerId, value] as const);
    if (entries.length === 0 || new Set(entries.map(([id]) => id)).size !== entries.length) {
      throw new TypeError('Provider-pinned finality passes are invalid.');
    }
    this.passes = new Map(entries);
  }

  public promote(providerId: RpcProviderId): void {
    if (!this.passes.has(providerId)) throw new TypeError('Promoted RPC provider is invalid.');
    this.promoted = providerId;
  }

  public clear(providerId: RpcProviderId): void {
    if (this.promoted === providerId) this.promoted = null;
  }

  public activeProviderId(): RpcProviderId | null {
    return this.promoted;
  }

  public openPass(): FinalityProviderPass {
    const providerId = this.promoted;
    const selected = providerId === null ? undefined : this.passes.get(providerId);
    if (selected === undefined) throw new PromotedProviderUnavailableError();
    return selected;
  }
}
```

The returned pass is already immutable and provider-pinned; later promotion changes only future `openPass()` calls.

- [ ] **Step 4: Run selector and finality regression tests**

```bash
npx tsx --test tests/promoted-provider-selector.test.ts \
  tests/provider-pinned-finality-source.test.ts tests/finality-reconciler.test.ts
```

Expected: PASS; existing same-provider orphan proof behavior is unchanged.

- [ ] **Step 5: Commit the promoted-provider boundary**

```bash
git add src/application/promoted-provider-selector.ts \
  tests/promoted-provider-selector.test.ts
git commit -m "feat: select finality from promoted provider (#63)"
```

---

### Task 4: Supervisor core owner, dual-ACK recovery and promotion

**Files:**
- Create: `src/application/websocket-failover-supervisor.ts`
- Create: `tests/websocket-failover-supervisor.test.ts`

- [ ] **Step 1: Write failing owner/start/dual-ACK/promotion tests (RED)**

Build fakes for the catalog, health repository, reporter, native session opener, strict scanner, promoted selector, scheduler and clock. The first test must assert this exact observable ordering:

```ts
assert.deepEqual(calls, [
  'health.beginOwner:primary',
  'reporter.startTouch:1',
  'health.transition:WAITING_FOR_ACKS',
  'scheduler.recovery:0',
]);
assert.equal(supervisor.state(), 'STARTING');
assert.equal(supervisor.activeProviderId(), null);
assert.equal(calls.some((call) => call.startsWith('session.open')), false);
```

After firing the scheduled recovery callback, keep the session open promise pending after the first ACK and prove the first program notification still invokes:

```ts
await reporter.observe(Object.freeze({
  signature: '1'.repeat(64),
  slot: 41n,
  source: 'WEBSOCKET',
  programIds: Object.freeze([PUMP_PROGRAM_ID]),
  confirmationStatus: 'confirmed',
  observedAtMs: 1_000,
}), 1n, 1n);
```

Resolve dual ACK, then resolve the strict scan, and assert exact durable order:

```ts
assert.deepEqual(phases, [
  'WAITING_FOR_ACKS', 'ACKNOWLEDGED', 'RECOVERING', 'RUNNING',
]);
assert.deepEqual(calls.slice(-3), [
  'strict.scan:primary', 'selector.promote:primary', 'periodic.arm:30000',
]);
assert.equal(supervisor.state(), 'RUNNING');
assert.equal(supervisor.activeProviderId(), 'primary');
```

Add RED tests for owner failure, initial transition failure and scheduler failure; each `start()` rejects before any socket or strict HTTP call.

- [ ] **Step 2: Run the supervisor test and verify RED**

```bash
npx tsx --test tests/websocket-failover-supervisor.test.ts \
  --test-name-pattern='owner|dual ACK|promotion|initial scheduling'
```

Expected: FAIL because the supervisor module does not exist.

- [ ] **Step 3: Define narrow ports, fixed bounds and public contract (GREEN)**

The new file must export these complete contracts and no infrastructure imports:

```ts
export const WEBSOCKET_FRONTIER_INTERVAL_MS = 30_000;
export const WEBSOCKET_BACKOFF_BASE_MS = 1_000;
export const WEBSOCKET_BACKOFF_CAP_MS = 60_000;

export interface WebSocketFailoverScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface WebSocketFailoverSupervisorOptions {
  readonly now: () => number;
  readonly random: () => number;
  readonly scheduler: WebSocketFailoverScheduler;
}

export interface WebSocketFailoverSupervisorDependencies {
  readonly providers: RpcProviderCatalog;
  readonly health: Pick<WebSocketHealthRepository, 'beginOwner'>;
  readonly reporter: PersistentWebSocketHealthReporter;
  readonly promoted: PromotedProviderSelector;
  readonly openSession: typeof openWsProgramSession;
  readonly runStrictScan: (
    providerId: RpcProviderId,
    signal: AbortSignal,
  ) => Promise<StrictCatchUpScanResult>;
}

export class WebSocketFailoverSupervisorError extends Error {
  public constructor(public readonly stage:
    | 'owner' | 'transition' | 'schedule' | 'cleanup') {
    super('WebSocket failover supervisor operation failed.');
    this.name = 'WebSocketFailoverSupervisorError';
    Object.freeze(this);
  }
}
```

Validate the exact own-data option fields, callable dependencies, catalog IDs, `random()` in `[0,1)`, and `now()` as a nonnegative safe integer. Errors must not retain a caught object, URL, signature or genesis hash.

- [ ] **Step 4: Implement owner-first asynchronous start (GREEN)**

Use idempotent `startPromise`, `closePromise`, `permanentlyClosed`, one `loopHandle`, one `loopPromise`, one incumbent and one candidate. The startup body must be structurally equivalent to:

```ts
private async performStart(): Promise<void> {
  let snapshot: WebSocketHealthSnapshot;
  try {
    snapshot = await this.dependencies.health.beginOwner({ candidateProviderId: 'primary' });
  } catch {
    throw new WebSocketFailoverSupervisorError('owner');
  }
  this.snapshot = snapshot;
  this.ownerGeneration = snapshot.ownerGeneration;
  this.dependencies.reporter.startTouch(snapshot);
  this.snapshot = await this.transition({
    phase: 'WAITING_FOR_ACKS',
    providerId: null,
    activeSessionGeneration: null,
    candidateProviderId: snapshot.candidateProviderId,
    candidateSessionGeneration: snapshot.candidateSessionGeneration,
    acknowledged: false,
    disconnectReasonCode: null,
    recoveryStatus: 'REQUIRED',
    recoveryReasonCode: snapshot.recovery.reasonCode ?? 'STARTUP',
  });
  this.currentState = 'STARTING';
  this.scheduleRecovery(0);
}
```

`transition` always derives `ownerGeneration` and `expectedRevision` from the latest captured snapshot and replaces that snapshot only after reporter persistence succeeds.

- [ ] **Step 5: Implement one candidate attempt and the promotion linearization point (GREEN)**

Snapshot `ownerGeneration`, provider ID and candidate session generation into the callback closure. Map only the two allowlisted families:

```ts
private notification(
  value: WsProgramNotification,
  ownerGeneration: bigint,
  sessionGeneration: bigint,
): Promise<void> {
  const programId = value.program === 'pumpfun' ? PUMP_PROGRAM_ID : PUMPSWAP_PROGRAM_ID;
  const notification: TransactionNotification = Object.freeze({
    signature: value.signature,
    slot: value.slot,
    source: 'WEBSOCKET',
    programIds: Object.freeze([programId]),
    confirmationStatus: 'confirmed',
    observedAtMs: this.readNow(),
  });
  return this.dependencies.reporter.observe(
    notification,
    ownerGeneration,
    sessionGeneration,
  );
}
```

Immediately after `openSession` resolves, store the candidate record and attach
its single completion handler before persisting or starting the strict scan.
That handler uses the serialized candidate record described in Task 5, so a
completion can invalidate or queue against the promotion fence. Then persist
`ACKNOWLEDGED`, then `RECOVERING/IN_PROGRESS`, and run exactly one strict scan
with the candidate abort signal. Promotion is:

```ts
this.snapshot = await this.transition({
  phase: 'RUNNING',
  providerId,
  activeSessionGeneration: sessionGeneration,
  candidateProviderId: null,
  candidateSessionGeneration: null,
  acknowledged: true,
  disconnectReasonCode: null,
  recoveryStatus: 'RECOVERED',
  recoveryReasonCode: recoveryReason,
});
this.incumbent = Object.freeze({ providerId, sessionGeneration, session });
this.candidate = null;
this.failedCycleCount = 0;
this.currentState = 'RUNNING';
this.dependencies.promoted.promote(providerId);
this.armPeriodicFrontier();
```

The durable `RUNNING` transition must occur before `promote`. The already
attached completion handler must compare both the session object and generation
against the serialized candidate/incumbent role before invalidating or
degrading; promotion must never attach a second handler.

- [ ] **Step 6: Run the focused supervisor tests and verify GREEN**

Run the Step 2 command.

Expected: PASS; `start()` resolves after scheduling, not after network recovery, and `RUNNING` appears only after dual ACK plus strict scan.

- [ ] **Step 7: Commit the supervisor core**

```bash
git add src/application/websocket-failover-supervisor.ts \
  tests/websocket-failover-supervisor.test.ts
git commit -m "feat: add websocket supervisor promotion core (#63)"
```

---

### Task 5: Rotation, equal-jitter backoff, periodic frontier and fail-closed stop

**Files:**
- Modify: `src/application/websocket-failover-supervisor.ts`
- Modify: `tests/websocket-failover-supervisor.test.ts`

- [ ] **Step 1: Write the failing recovery/rotation/backoff tests (RED)**

Add deterministic cases for:

- session setup timeout, partial ACK, protocol, remote close and observer rejection;
- exactly one setup and, only after ACK, one scan per provider per cycle;
- order after promoted `fallback-1`: `fallback-2`, `fallback-3`, `primary`, `fallback-1`;
- transient 429/network/CAS conflict followed by one equal-jitter delay;
- mixed transient/window-exceeded cycle remains `DEGRADED`;
- all providers returning the same exact frontier becomes `UNRECOVERABLE` and schedules nothing;
- differing frontiers remain `DEGRADED` and back off.

Use fixed random values and assert the formula exactly:

```ts
assert.equal(equalJitterDelay(0, 0), 500);
assert.equal(equalJitterDelay(0, 0.999), 999);
assert.equal(equalJitterDelay(1, 0), 1_000);
assert.equal(equalJitterDelay(20, 0), 30_000);
assert.equal(equalJitterDelay(20, 0.999), 59_970);
```

Add periodic tests proving a timer is armed only after promotion, rearms only after the scan settles, receives no trigger from notifications, and a periodic failure degrades once and coalesces into one recovery loop.

Add candidate completion races at three exact boundaries:

- completion processed before the local promotion fence aborts the scan and forbids `RUNNING`;
- completion delivered after the fence but while the durable transition is pending is queued;
- a successful transition makes that queued completion degrade the new active session, while a rejected transition leaves and closes an invalid candidate without publishing a provider.

For unanimous `UNRECOVERABLE`, assert the last candidate is closed and removed,
a live incumbent alone may remain observable, a completed incumbent is removed,
and no recovery, backoff or periodic timer survives.

Add shutdown race tests during setup, backoff, strict scan, periodic scan, incumbent/candidate overlap and session observer drain. Assert one reporter `stop(cleanup)`, idempotent `close()`, no active timers, no post-close transition, and `DEGRADED` on cleanup failure.

- [ ] **Step 2: Run the recovery tests and verify RED**

```bash
npx tsx --test tests/websocket-failover-supervisor.test.ts \
  --test-name-pattern='rotation|backoff|frontier|unrecoverable|shutdown|stale'
```

Expected: FAIL because finite cycles, equal jitter, periodic scanning and full shutdown are not implemented.

- [ ] **Step 3: Implement finite provider cycles and exact unrecoverable classification (GREEN)**

Export and use this pure delay helper:

```ts
export function equalJitterDelay(failedCycleCount: number, random: number): number {
  if (!Number.isSafeInteger(failedCycleCount) || failedCycleCount < 0
    || typeof random !== 'number' || !Number.isFinite(random)
    || random < 0 || random >= 1) {
    throw new TypeError('WebSocket recovery backoff input is invalid.');
  }
  const exponentialCap = Math.min(
    WEBSOCKET_BACKOFF_CAP_MS,
    WEBSOCKET_BACKOFF_BASE_MS * (2 ** Math.min(failedCycleCount, 30)),
  );
  return Math.floor(exponentialCap / 2 + random * exponentialCap / 2);
}
```

Capture the frontier error from every provider attempt. Mark a cycle unrecoverable only when the result count equals `providers.ids.length`, every result is `StrictCatchUpWindowExceededError`, and every result satisfies `first.sameFrontier(result)`. Abort and shutdown errors do not enter this evidence array.

On transient exhaustion, compute one delay from the zero-based number of
previous failed cycles, then increment `failedCycleCount`, persist/retain
`DEGRADED`, and arm exactly one next-cycle callback. Never retry inside a
provider attempt.

- [ ] **Step 4: Implement active-session failure and periodic serialization (GREEN)**

Use one recovery-loop gate and one periodic handle. The periodic callback captures the active provider and generation, runs one strict scan, and only keeps `RUNNING` if that same generation remains active when it settles. Failure calls one `requestRecovery` operation:

```ts
private requestRecovery(reason: WebSocketRecoveryReasonCode): void {
  if (this.permanentlyClosed || this.unrecoverable) return;
  this.pendingRecoveryReason = reason;
  if (this.loopPromise !== null || this.loopHandle !== null) return;
  this.currentState = 'DEGRADED';
  this.scheduleRecovery(0);
}

private armPeriodicFrontier(): void {
  if (this.permanentlyClosed || this.currentState !== 'RUNNING'
    || this.periodicHandle !== null) return;
  this.periodicHandle = this.options.scheduler.schedule(() => {
    this.periodicHandle = null;
    void this.runPeriodicFrontier();
  }, WEBSOCKET_FRONTIER_INTERVAL_MS);
}
```

When incumbent failure is confirmed, clear the selector for that exact provider, persist `DEGRADED` immediately with the session completion reason, retain the incumbent for bounded cleanup, and rotate starting after the last promoted provider.

Use one serialized candidate record with a local `promotionFenced` flag and a
queued completion. Set the fence synchronously immediately before invoking the
durable `RUNNING` transition. If the transition resolves, publish the provider
and process the queued completion as an active-session failure; if it rejects,
never publish the provider and process the completion as candidate invalidation.

- [ ] **Step 5: Implement reporter-owned shutdown (GREEN)**

`close()` sets the permanent fence before awaiting anything, cancels recovery/periodic handles, aborts setup and strict-scan controllers, then delegates the durable lifecycle to the reporter:

```ts
private async performClose(): Promise<void> {
  this.currentState = 'STOPPING';
  this.cancelTimers();
  this.candidateAbort?.abort();
  this.scanAbort?.abort();
  const closingProvider = this.dependencies.promoted.activeProviderId();
  if (closingProvider !== null) this.dependencies.promoted.clear(closingProvider);
  try {
    await this.dependencies.reporter.stop(async () => {
      const sessions = [this.candidate?.session, this.incumbent?.session]
        .filter((value): value is WsProgramSession => value !== undefined);
      await Promise.all(sessions.map(async (session) => session.close(cleanupSignal)));
      const loop = this.loopPromise;
      if (loop !== null) await loop;
    });
    this.currentState = 'STOPPED';
  } catch {
    this.currentState = 'DEGRADED';
    throw new WebSocketFailoverSupervisorError('cleanup');
  }
}
```

Here `cleanupSignal` is the reporter-supplied bounded cleanup signal derived
from the existing listener shutdown limit; the implementation must not create
an unbounded waiter. All late `.then`/completion callbacks check
`permanentlyClosed` plus session generation before scheduling or transitioning.

- [ ] **Step 6: Run the recovery tests and verify GREEN**

Run the Step 2 command, then:

```bash
npx tsx --test tests/ws-program-session.test.ts \
  tests/websocket-health-reporter.test.ts tests/websocket-failover-supervisor.test.ts
```

Expected: PASS; no timer or socket listener remains after any tested close path.

- [ ] **Step 7: Commit bounded recovery and shutdown**

```bash
git add src/application/websocket-failover-supervisor.ts \
  tests/websocket-failover-supervisor.test.ts
git commit -m "feat: supervise websocket recovery lifecycle (#63)"
```

---

### Task 6: Runtime/factory activation and paper readiness gate

**Files:**
- Modify: `src/application/listener-runtime.ts:5-399`
- Modify: `src/application/production-listener-factory.ts:1-321,691-719`
- Modify: `src/application/paper-decision-worker.ts:34-183,814-825`
- Modify: `tests/listener-runtime.test.ts`
- Modify: `tests/production-listener-factory.test.ts`
- Modify: `tests/paper-decision-worker.test.ts`
- Modify: `tests/bootstrap-safety.test.ts`

- [ ] **Step 1: Write failing runtime-order and rollback tests (RED)**

Replace legacy dependency expectations with the active order:

```ts
assert.deepEqual(calls, [
  'supervisor.start',
  'worker.start',
  'reconciler.start',
  'paperWorker.start',
  'socialWorker.start',
  'heartbeat.start',
]);
```

For shutdown, require the supervisor to finish before any consumer drain begins:

```ts
assert.deepEqual(calls, [
  'supervisor.close:start',
  'supervisor.close:done',
  'paperWorker.close',
  'socialWorker.close',
  'reconciler.close',
  'worker.close',
  'heartbeat.stop:STOPPED',
]);
```

Add rollback tests for worker, finality, paper, social and heartbeat startup failures; only resources that completed start are closed, supervisor always closes first, and all errors remain fixed/redacted.

- [ ] **Step 2: Write failing paper readiness tests (RED)**

Inject a mutable readiness function into the worker options. In paper mode while false, fire both `runOnce()` and the scheduled poll and assert:

```ts
assert.deepEqual(await worker.runOnce(), { kind: 'idle' });
assert.equal(repository.claimCalls, 0);
assert.equal(repository.enqueueActiveSessionsCalls, 0);
assert.equal(repository.mutationCalls, 0);
```

Switch readiness to true without restarting the worker, fire the next scheduled poll, and assert one claim occurs. Add a table-driven race that flips readiness to false while `loadSnapshot`, quote, strategy preparation, stage, completion and position reconciliation are deferred. At every boundary, assert only retry/lease bookkeeping occurs and no new decision, session, trade or position mutation is written. In observe mode, readiness false must not block ordinary projection-job claiming, but existing `paperEnabled` checks must still prevent paper actions.

- [ ] **Step 3: Run runtime/factory/paper tests and verify RED**

```bash
npx tsx --test tests/listener-runtime.test.ts \
  tests/production-listener-factory.test.ts tests/paper-decision-worker.test.ts \
  tests/bootstrap-safety.test.ts
```

Expected: FAIL because runtime still owns HTTP/scanner/subscriber ordering, factory keeps issue-63 modules inactive, and the paper worker has no readiness predicate.

- [ ] **Step 4: Replace legacy runtime dependencies with the supervisor (GREEN)**

Use this runtime dependency shape:

```ts
interface RuntimeSupervisor extends RuntimeComponent {
  activeProviderId(): RpcProviderId | null;
}

export interface ListenerRuntimeDependencies {
  readonly supervisor: RuntimeSupervisor;
  readonly worker: RuntimeComponent;
  readonly paperWorker: RuntimeComponent;
  readonly socialWorker: RuntimeComponent;
  readonly reconciler: RuntimeComponent;
  readonly heartbeat: RuntimeHeartbeat;
}
```

Remove `rpc`, `scanner`, and `subscriber` from the active runtime
start/close/state paths. Start supervisor first. On every normal or rollback
close, use one global deadline and await each stage sequentially in this exact
order: supervisor, paper worker, social worker, finality reconciler, inbox
worker, heartbeat. A later stage starts only after the previous stage settles or
consumes its bounded share of that same deadline. Aggregate fixed stage-specific
close/timeout failures without raw causes. Update `ListenerRuntimeFailureStage`
and tests accordingly.

Chain projection state is healthy only when supervisor, worker, reconciler and heartbeat all return `RUNNING`; `STARTING` supervisor state degrades the chain projection without relabeling paper or social components.

- [ ] **Step 5: Gate paper before claim (GREEN)**

Add an exact function option and validate it as an own callable field:

```ts
export interface PaperDecisionWorkerOptions {
  readonly executionMode: 'observe' | 'paper';
  readonly paperStrategyEnabled: boolean;
  readonly quoteMintAllowlist: readonly string[];
  readonly entryQuoteAmountRaw: bigint;
  readonly slippageBps: bigint;
  readonly externalBuyTarget: number;
  readonly minimumConfirmation: 'confirmed' | 'finalized';
  readonly maximumRoundTripLossBps: bigint;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly renewalIntervalMs: number;
  readonly shutdownTimeoutMs: number;
  readonly manualKillSwitch: boolean;
  readonly isReady: () => boolean;
}

private paperReady(): boolean {
  if (this.options.executionMode !== 'paper' || !this.options.paperStrategyEnabled) return true;
  try {
    return this.options.isReady() === true;
  } catch {
    this.currentState = 'DEGRADED';
    return false;
  }
}
```

Call `paperReady()` at the start of `performRunOnce`, before `enqueueActiveSessions`, clock reads, or `repository.claim`. Return frozen `{ kind:'idle' }` while not ready. The scheduled loop remains armed and self-resumes naturally.

After a job is claimed, call the same fence after every awaited external
operation and immediately before `stageDecision`, `complete`, strategy
open/recover/reconcile calls, paper trade/position writes and manual-kill wake.
If it becomes false, route the claimed job through the existing bounded
retryable bookkeeping path with no decision payload or paper action. Do not
weaken the existing inbox/finality transaction fences.

- [ ] **Step 6: Compose all concrete production dependencies (GREEN)**

In `createProductionListenerRuntime`:

1. Narrow the active-listener configuration before constructing adapters:
   capture `config.expectedGenesisHash`, reject `null` with the existing fixed
   configuration error, and retain the resulting local `string`. This guard is
   synchronous and precedes catalog construction, PostgreSQL and every Solana
   call. Create the provider catalog only after it succeeds.
2. Create one `PostgresTransactionInboxRepository` shared by live WS and strict scans.
3. Create one `PostgresWebSocketHealthRepository` and one `PersistentWebSocketHealthReporter` with a five-second touch and listener shutdown timeout.
4. Preconstruct one `StrictCatchUpScanner` plus `StrictCatchUpCoordinator` per
   catalog ID using `createProviderPinnedCatchUpSource(providers, id,
   'confirmed', expectedGenesisHash)` where the local value is already narrowed
   to `string`.
5. Preconstruct one `createProviderPinnedFinalityPass(providers, id)` per ID and construct `PromotedProviderSelector`.
6. Construct `WebSocketFailoverSupervisor`; its endpoint resolver returns only `{id,url: providers.resolve(id).websocketUrl}` to `openWsProgramSession`.
7. Extend `RecurringFinalityReconciler` with a current `readyProviderId()` that
   is set only after a successful run whose promoted provider is unchanged,
   and cleared before every attempt, failure or provider-unavailable result.
   The isolated default remains `FAIL_START`; production selects
   `DEGRADED_RETRY` in both modes.
8. Inject a joint paper predicate requiring supervisor `RUNNING`, a non-null
   selected provider, reconciler `RUNNING`, and
   `reconciler.readyProviderId() === selector.activeProviderId()`.
9. Pass the promoted selector directly as `FinalityProviderPassSource`.
10. Feed `() => supervisor.state()` into both generic heartbeat chain-state
    slots; keep `lastWebsocketSlot` and `lastSignature` null because dedicated
    health owns that evidence.

The production source must no longer import or construct `CatchUpScanner`, `StartupScanner`, `SolanaCatchUpSource`, or `SolanaProgramSubscriber`. It may retain their source files.

- [ ] **Step 7: Invert the issue-63 bootstrap guards (GREEN)**

Replace “inactive until issue 63” source assertions with positive imports/construction for:

```ts
openWsProgramSession
StrictCatchUpScanner
StrictCatchUpCoordinator
createProviderPinnedCatchUpSource
PersistentWebSocketHealthReporter
PostgresWebSocketHealthRepository
WebSocketFailoverSupervisor
PromotedProviderSelector
```

Keep the complete production import-graph rejection for `src/execution`, wallet, `Keypair`, signer, `sendTransaction`, `sendRawTransaction`, transaction builder and simulation submission.

- [ ] **Step 8: Run runtime/factory/paper tests and verify GREEN**

Run the Step 3 command.

Expected: PASS; composition itself opens neither PostgreSQL nor network resources, owner acquisition occurs only in `supervisor.start`, paper remains scheduled but cannot claim outside `RUNNING`, and no execution capability enters the graph.

- [ ] **Step 9: Commit production activation**

```bash
git add src/application/listener-runtime.ts \
  src/application/production-listener-factory.ts \
  src/application/paper-decision-worker.ts tests/listener-runtime.test.ts \
  tests/production-listener-factory.test.ts tests/paper-decision-worker.test.ts \
  tests/bootstrap-safety.test.ts
git commit -m "feat: activate websocket supervisor runtime (#63)"
```

---

### Task 7: PostgreSQL integration and crash/fault matrix

**Files:**
- Create: `tests/websocket-failover-supervisor.integration.test.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify: `tests/api-projection.repository.test.ts`
- Modify: `tests/deployment-healthcheck.test.ts`

- [ ] **Step 1: Write the failing real-database owner and overlap matrix (RED)**

Use the existing temporary-schema helpers and `TEST_DATABASE_URL`. Apply migrations, construct real `PostgresTransactionInboxRepository`, `PostgresWebSocketHealthRepository`, and `PersistentWebSocketHealthReporter`, with fake WS/session and pinned strict sources only.

Prove this sequence with real rows:

```ts
const health = await healthRepository.read();
assert.equal(health.supervision, 'ACTIVE');
assert.equal(health.phase, 'RUNNING');
assert.equal(health.providerId, 'fallback-1');
assert.equal(health.candidateProviderId, null);
assert.equal(health.recovery.status, 'RECOVERED');

const stored = await readInbox(signature);
assert.equal(stored.observed_slot, '42');
assert.deepEqual(stored.discovery_sources, ['CATCH_UP', 'WEBSOCKET']);
assert.deepEqual(stored.program_ids.sort(), [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort());
```

The same signature must be delivered by incumbent WS, candidate WS and HTTP catch-up with the same slot. A mismatched slot must still fail with the existing immutable identity conflict.

- [ ] **Step 2: Add crash/restart tests at every durable boundary (RED)**

Parameterize process loss after `CONNECTING`, `WAITING_FOR_ACKS`, `ACKNOWLEDGED`, `RECOVERING`, after some enqueues, after launchpad CAS, after both CAS operations, and after `RUNNING` before incumbent close. Age the WebSocket heartbeat past 30 seconds, begin a new owner, and assert:

```ts
assert.equal(restarted.ownerGeneration, previous.ownerGeneration + 1n);
assert.equal(restarted.phase, 'CONNECTING');
assert.equal(restarted.recovery.status, 'REQUIRED');
assert.equal(restarted.recovery.reasonCode, 'UNEXPECTED_RESTART');
```

Run a fresh dual-ACK plus exact scan and prove no live-edge checkpoint rebaseline and no duplicate inbox identity.

- [ ] **Step 3: Add the full provider fault matrix (RED)**

Cover partial ACK, setup timeout, disconnect, protocol failure, enqueue failure, HTTP 429, malformed page, multi-page recovery, CAS conflict, abort after each awaited boundary, unanimous equal frontier, unequal frontier and cleanup failure. For every transient case assert:

```ts
assert.equal((await healthRepository.read()).phase, 'DEGRADED');
assert.equal(await unresolvedStrictFailureCount(), expectedUnresolvedCount);
assert.equal(await currentCheckpoint('launchpad'), expectedLaunchpadCheckpoint);
assert.equal(await currentCheckpoint('market'), expectedMarketCheckpoint);
```

For unanimous equal frontier assert `UNRECOVERABLE/FAILED/CATCH_UP_WINDOW_EXCEEDED`, no next timer and unchanged checkpoints. For a mixed cycle assert `DEGRADED`, one bounded backoff timer and no `UNRECOVERABLE` claim.

- [ ] **Step 4: Run integration tests and verify RED, then fix only integration defects (GREEN)**

```bash
TEST_DATABASE_URL='postgresql:///postgres?host=/tmp' npx tsx --test \
  tests/websocket-failover-supervisor.integration.test.ts \
  tests/transaction-inbox.repository.test.ts \
  tests/websocket-health.repository.test.ts \
  tests/strict-catch-up-scanner.test.ts \
  tests/api-projection.repository.test.ts \
  tests/deployment-healthcheck.test.ts
```

Expected RED: at least the new integration test fails before final race fixes. Apply minimal changes to the supervisor/reporter wiring until the command passes. Do not weaken existing SQL generation, revision, session or inbox identity checks.

- [ ] **Step 5: Prove active public and deployment health**

For a fresh `RUNNING/RECOVERED` WebSocket snapshot and generic heartbeat, assert aggregate `OK`. Assert `DEGRADED` for every non-running detailed phase, stale WebSocket heartbeat, unresolved strict failure, failed cleanup and `UNRECOVERABLE`. Run the same envelopes through `checkDeploymentHealth(..., { requireOk: true })` and require rejection unless aggregate status is `OK`.

- [ ] **Step 6: Commit the durable fault matrix**

```bash
git add tests/websocket-failover-supervisor.integration.test.ts \
  tests/transaction-inbox.repository.test.ts \
  tests/api-projection.repository.test.ts tests/deployment-healthcheck.test.ts \
  src/application/websocket-failover-supervisor.ts
git commit -m "test: prove websocket failover crash safety (#63)"
```

---

### Task 8: Deployment, operations, safety and full verification

**Files:**
- Modify: `.env.example`
- Modify: `deploy/env.example`
- Modify: `deploy/compose.yaml`
- Modify: `deploy/compose.smoke.yaml`
- Modify: `tests/deployment-artifacts.test.ts`
- Modify: `scripts/deployment-smoke.mjs`
- Modify: `README.md`
- Modify: `docs/api/v1.md`
- Modify: `docs/system-overview.html`
- Modify: `docs/operations/deployment.md`
- Modify: `docs/operations/rpc-qualification.md`
- Modify: `tests/bootstrap-safety.test.ts`

- [ ] **Step 1: Write failing deployment and documentation assertions (RED)**

Require `deploy/compose.yaml` to pass the operator-supplied value only to `app`:

```yaml
  SOLANA_EXPECTED_GENESIS_HASH: ${SOLANA_EXPECTED_GENESIS_HASH:-}
```

Require `.env.example` and `deploy/env.example` to contain a blank value, never a fake valid hash. Require the smoke deployment to set `LISTENER_ENABLED=false` when no verified genesis is supplied. Assert migration and retention services receive no Solana variables.

Documentation tests must reject “inactive until #63” and require these exact concepts: dual ACK, 30-second strict frontier, positional provider IDs, bounded 1–60-second equal jitter, `UNRECOVERABLE`, `SOLANA_EXPECTED_GENESIS_HASH`, clean rollback, observe/paper only, and no automatic legacy fallback.

- [ ] **Step 2: Run deployment/docs tests and verify RED**

```bash
npx tsx --test tests/deployment-artifacts.test.ts tests/bootstrap-safety.test.ts \
  tests/deployment-healthcheck.test.ts
npm run docs:check
```

Expected: FAIL because the required genesis deployment variable is absent and documentation still describes supervision as inactive.

- [ ] **Step 3: Update safe examples and Compose wiring (GREEN)**

Add:

```dotenv
# Required when LISTENER_ENABLED=true. Obtain and independently verify the
# canonical 32-byte base58 genesis hash for the intended Solana cluster.
SOLANA_EXPECTED_GENESIS_HASH=
```

Keep `EXECUTION_MODE=observe` hard-coded in the reference deployment. Do not add wallet, key, signing, simulation or submission variables. The app service receives paired HTTP/WS URLs and the expected genesis; migration and retention services remain database-only.

- [ ] **Step 4: Publish the active operational contract and rollback (GREEN)**

Update README, API docs, system overview, deployment guide and RPC runbook with this exact safe operational sequence:

```bash
npm run rpc:check
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d migrate
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d app frontend retention
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T app \
  node dist/scripts/deployment-healthcheck.js --require-ok
```

Document that operators obtain `getGenesisHash` independently from the intended cluster and compare more than one trusted source before setting the value; do not print a supplied hash in application logs.

Document rollback as a clean stop followed by deployment of the previous immutable image:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml stop app
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d app
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T app \
  node dist/scripts/deployment-healthcheck.js --require-ok
```

State explicitly that rollback never switches to `SolanaProgramSubscriber` inside the same process and never changes `EXECUTION_MODE` beyond `observe`/`paper`.

- [ ] **Step 5: Run focused safety and operational verification**

```bash
npx tsx --test tests/config-safety.test.ts tests/rpc-provider-catalog.test.ts \
  tests/production-listener-factory.test.ts tests/bootstrap-safety.test.ts \
  tests/deployment-artifacts.test.ts tests/deployment-healthcheck.test.ts
npm run docs:check
```

Expected: PASS; the production import graph contains no wallet/signer/builder/submission capability, all examples are redacted, and active health is required by `--require-ok`.

- [ ] **Step 6: Run the complete verification matrix**

Run in this order and stop on the first failure:

```bash
npm run check
npm run lint
npm run docs:check
npm run build
TEST_DATABASE_URL='postgresql:///postgres?host=/tmp' npm run test:backend
npm test --workspace frontend
npm run frontend:e2e
npm audit --omit=dev --audit-level=critical
```

Expected: every command exits 0 and no critical production vulnerability is
reported. Record the pre-existing moderate/high dependency findings separately
without expanding this runtime PR into an unrelated dependency upgrade. Do not
claim PostgreSQL or browser verification if the corresponding dependency is
unavailable.

- [ ] **Step 7: Inspect the final production import graph and diff**

```bash
git diff --check
git status --short
rg -n "Keypair|sendRawTransaction|sendTransaction|signTransaction|simulateTransaction|execution/wallet|transaction-builder" \
  src/app.ts src/application/production-listener-factory.ts \
  src/application/websocket-failover-supervisor.ts \
  src/application/promoted-provider-selector.ts
rg -n "inactive until #63|inactive.*#63|jusqu.*#63" README.md docs src tests
```

Expected: `git diff --check` is silent; the first `rg` is silent for the production graph; the second `rg` matches only historical versioned specs/plans that intentionally describe delivery boundaries, never current operational documentation or active tests.

- [ ] **Step 8: Commit operational activation**

```bash
git add .env.example deploy/env.example deploy/compose.yaml deploy/compose.smoke.yaml \
  tests/deployment-artifacts.test.ts scripts/deployment-smoke.mjs README.md \
  docs/api/v1.md docs/system-overview.html docs/operations/deployment.md \
  docs/operations/rpc-qualification.md tests/bootstrap-safety.test.ts
git commit -m "docs: operate websocket failover safely (#63)"
```

---

## Final implementation review

- [ ] Confirm `beginOwner` is the first action in `supervisor.start()` and no constructor opens PostgreSQL or a Solana resource.
- [ ] Confirm native session resolution, not socket open or one ACK, is the only path to `ACKNOWLEDGED`.
- [ ] Confirm `RUNNING` is durably persisted after strict scan and before promoted-provider publication.
- [ ] Confirm a provider receives no more than one setup plus one strict scan per cycle.
- [ ] Confirm only unanimous `sameFrontier` window errors create `UNRECOVERABLE`.
- [ ] Confirm every scanner await is fenced before and after with the same `AbortSignal`.
- [ ] Confirm periodic scans are one-at-a-time, timer-driven only, and capture one provider.
- [ ] Confirm finality `openPass()` captures one immutable pass, retries pre-promotion in paper and observe, and clears current readiness on every failure/provider change.
- [ ] Confirm joint WS/finality paper readiness is checked before claim, after awaited work and immediately before every durable paper mutation.
- [ ] Confirm shutdown closes the supervisor before workers, cannot restart recovery, and preserves failed cleanup evidence.
- [ ] Confirm legacy scanner/subscriber files remain available but are absent from production composition.
- [ ] Confirm public health exposes positional IDs/fixed reasons only and no URL/hash/signature/frame/error object.
- [ ] Confirm the full production import graph contains no signing, simulation submission or transaction submission capability.

Plan complete and saved to `docs/superpowers/plans/2026-08-28-websocket-supervisor-activation.md`. Execute it with `superpowers:subagent-driven-development` (recommended) for one fresh worker and two-stage review per task, or with `superpowers:executing-plans` for checkpointed inline batches.

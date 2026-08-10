# Public Social Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect durable, bounded and explainable public website/X/Telegram evidence for every Pump.fun launch and expose the canonical result through API V1 and SSE without blocking Solana ingestion.

**Architecture:** `TokenLaunchDetected` atomically enqueues a PostgreSQL enrichment job. A separate lease-based worker resolves metadata through a shared SSRF-safe HTTP client, derives conservative social evidence, and atomically persists source observations, projections and a derived domain event. API V1 reads only the latest non-orphaned collection; chain finality reconciles every derived row and SSE revision.

**Tech Stack:** TypeScript 5.8 strict ESM, Node.js 22 test runner, PostgreSQL/`pg`, `parse5` 8.0.1, `tldts` 7.4.10, existing HTTP/SSE API and structured Pino logging.

---

## File map

New focused modules:

- `src/domain/social-evidence.ts` — immutable domain types, enums, validation,
  deterministic IDs and collection summaries;
- `src/ports/public-http-client.ts` — bounded HTTP request/response contract;
- `src/metadata/bounded-public-http.client.ts` — DNS-pinned SSRF-safe transport;
- `src/ports/social-verification-provider.ts` — provider input/output contract;
- `src/social/social-url-normalizer.ts` — website/X/Telegram canonicalization;
- `src/social/public-content-evidence.ts` — bounded HTML/plain-text extraction;
- `src/social/public-social-verification.provider.ts` — conservative evidence
  orchestration;
- `src/social/social-qualification-observations.ts` — pure evidence-to-signal
  mapping with unknown represented by omission;
- `src/ports/social-evidence-repository.ts` — durable job and completion port;
- `src/storage/social-evidence.repository.ts` — PostgreSQL jobs, collections,
  evidence and derived events;
- `src/application/social-enrichment-worker.ts` — polling, leases, retry and
  shutdown lifecycle;
- `migrations/012_public_social_evidence.sql` — replayable schema and backfill.

Existing modules changed only at their boundary:

- `HttpMetadataProvider` consumes the shared HTTP port;
- `PostgresLaunchpadEventRepository` enqueues and reconciles social work inside
  the existing launch transaction;
- API contracts/repository expose `AVAILABLE` social collections;
- listener runtime/factory starts and stops the independent social worker;
- configuration, heartbeat, docs and copy-migration checks include the new
  safe capability.

---

### Task 1: Define immutable social domain contracts

**Files:**
- Create: `src/domain/social-evidence.ts`
- Modify: `src/domain/pumpfun-observation.ts`
- Create: `src/ports/social-verification-provider.ts`
- Test: `tests/social-evidence-contracts.test.ts`

- [ ] **Step 1: Write the failing contract tests**

Create tests that demand stable enum order, exact frozen snapshots, Base58 mint
boundaries, deterministic replay IDs, changed-input IDs, canonical ordering,
bounded strings/counts and hostile getter/prototype rejection.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOCIAL_COLLECTION_STATUSES,
  SOCIAL_EVIDENCE_OUTCOMES,
  SOCIAL_EVIDENCE_TYPES,
  SOCIAL_LINK_KINDS,
  createSocialCollection,
  socialCollectionId,
} from '../src/domain/social-evidence.js';

void test('publishes stable social enums and deterministic frozen collections', () => {
  assert.deepEqual(SOCIAL_LINK_KINDS, ['WEBSITE', 'X', 'TELEGRAM']);
  assert.deepEqual(SOCIAL_COLLECTION_STATUSES, ['COMPLETE', 'PARTIAL', 'FAILED']);
  assert.deepEqual(SOCIAL_EVIDENCE_OUTCOMES, ['CONFIRMED', 'REJECTED', 'UNKNOWN']);
  assert.deepEqual(SOCIAL_EVIDENCE_TYPES, [
    'URL_SYNTAX_VALID', 'URL_SYNTAX_INVALID', 'URL_REACHABLE',
    'CROSS_LINK_CONFIRMED', 'MINT_PUBLISHED', 'ACCOUNT_TOO_RECENT',
    'DOMAIN_MISMATCH', 'CONTENT_UNAVAILABLE', 'VERIFICATION_UNKNOWN',
  ]);
  const input = validCollectionInput();
  const first = createSocialCollection(input);
  const replay = createSocialCollection(structuredClone(input));
  assert.deepEqual(replay, first);
  assert.equal(first.id, socialCollectionId(input));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.links), true);
  assert.equal(Object.isFrozen(first.evidence), true);
});

void test('rejects mutable, foreign, duplicate and unbounded evidence', () => {
  assert.throws(() => createSocialCollection(mutableCollectionInput()), TypeError);
  assert.throws(() => createSocialCollection(foreignMintEvidenceInput()), TypeError);
  assert.throws(() => createSocialCollection(duplicateEvidenceInput()), TypeError);
  assert.throws(() => createSocialCollection(oversizedReasonInput()), RangeError);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx tsx --test tests/social-evidence-contracts.test.ts
```

Expected: module-not-found failure for `src/domain/social-evidence.ts`.

- [ ] **Step 3: Implement the minimal strict domain surface**

Export these exact values and shapes; validators must snapshot only own data
properties, reject accessors/symbols/non-plain prototypes, cap individual text
at 2,048 UTF-8 bytes, arrays at 64 items and total JSON at 256 KiB.

```ts
export const SOCIAL_LINK_KINDS = Object.freeze(['WEBSITE', 'X', 'TELEGRAM'] as const);
export const SOCIAL_COLLECTION_STATUSES = Object.freeze(['COMPLETE', 'PARTIAL', 'FAILED'] as const);
export const SOCIAL_EVIDENCE_OUTCOMES = Object.freeze(['CONFIRMED', 'REJECTED', 'UNKNOWN'] as const);
export const SOCIAL_EVIDENCE_TYPES = Object.freeze([
  'URL_SYNTAX_VALID', 'URL_SYNTAX_INVALID', 'URL_REACHABLE',
  'CROSS_LINK_CONFIRMED', 'MINT_PUBLISHED', 'ACCOUNT_TOO_RECENT',
  'DOMAIN_MISMATCH', 'CONTENT_UNAVAILABLE', 'VERIFICATION_UNKNOWN',
] as const);

export type SocialLinkKind = (typeof SOCIAL_LINK_KINDS)[number];
export type SocialCollectionStatus = (typeof SOCIAL_COLLECTION_STATUSES)[number];
export type SocialEvidenceOutcome = (typeof SOCIAL_EVIDENCE_OUTCOMES)[number];
export type SocialEvidenceType = (typeof SOCIAL_EVIDENCE_TYPES)[number];

export interface SocialLinkV1 {
  readonly id: string;
  readonly mint: string;
  readonly metadataSnapshotId: string;
  readonly kind: SocialLinkKind;
  readonly declaredValueSha256: string;
  readonly syntaxStatus: 'VALID' | 'INVALID';
  readonly canonicalUrl: string | null;
  readonly invalidReason: string | null;
  readonly observedAtMs: number;
}

export interface SocialHttpObservationV1 {
  readonly id: string;
  readonly linkId: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly finalCanonicalUrl: string | null;
  readonly httpStatus: number | null;
  readonly redirectCount: number;
  readonly contentSha256: string | null;
  readonly failureReason: string | null;
  readonly observedAtMs: number;
}

export interface SocialVerificationEvidenceV1 {
  readonly id: string;
  readonly mint: string;
  readonly linkId: string | null;
  readonly observationId: string | null;
  readonly type: SocialEvidenceType;
  readonly outcome: SocialEvidenceOutcome;
  readonly subjectKind: SocialLinkKind | null;
  readonly relatedKind: SocialLinkKind | null;
  readonly reasonCode: string;
  readonly observedAtMs: number;
}

export interface SocialEvidenceCollectionInputV1 {
  readonly mint: string;
  readonly sourceLaunchEventId: string;
  readonly metadataSnapshotId: string;
  readonly status: SocialCollectionStatus;
  readonly links: readonly SocialLinkV1[];
  readonly observations: readonly SocialHttpObservationV1[];
  readonly evidence: readonly SocialVerificationEvidenceV1[];
  readonly observedAtMs: number;
}

export interface SocialEvidenceCollectionV1 {
  readonly id: string;
  readonly inputFingerprint: string;
  readonly mint: string;
  readonly sourceLaunchEventId: string;
  readonly metadataSnapshotId: string;
  readonly status: SocialCollectionStatus;
  readonly links: readonly SocialLinkV1[];
  readonly observations: readonly SocialHttpObservationV1[];
  readonly evidence: readonly SocialVerificationEvidenceV1[];
  readonly observedAtMs: number;
  readonly payloadVersion: 1;
}

export function createSocialCollection(
  input: SocialEvidenceCollectionInputV1,
): SocialEvidenceCollectionV1;

export function socialCollectionId(
  input: Pick<SocialEvidenceCollectionInputV1, 'mint' | 'sourceLaunchEventId' |
    'metadataSnapshotId' | 'links' | 'observations' | 'evidence'>,
): string;

export function socialMetadataSnapshotId(input: Readonly<{
  sourceLaunchEventId: string;
  snapshot: TokenMetadataSnapshot;
}>): string;

export function createFailedSocialCollection(input: Readonly<{
  mint: string;
  sourceLaunchEventId: string;
  metadataSnapshot: TokenMetadataSnapshot;
}>): SocialEvidenceCollectionV1;
```

`socialMetadataSnapshotId` hashes the source event, URI, payload version and
canonical resolution payload. It excludes `fetchedAtMs`, so retrying identical
content produces the same ID; changed normalized content produces a new ID.
`createFailedSocialCollection` requires a failed metadata resolution, returns
status `FAILED`, no links/observations, and one bounded
`VERIFICATION_UNKNOWN` item tied to `METADATA_UNAVAILABLE`.

The provider port must be:

```ts
export interface SocialVerificationProvider {
  collect(input: Readonly<{
    mint: string;
    sourceLaunchEventId: string;
    metadataSnapshot: TokenMetadataSnapshot;
  }>): Promise<Readonly<{
    metadataSnapshot: TokenMetadataSnapshot;
    collection: SocialEvidenceCollectionV1;
  }>>;
}
```

The provider receives the in-memory raw metadata resolution, normalizes links,
rebuilds a safe metadata snapshot, computes its deterministic ID, and then
builds link/evidence/collection IDs. This order avoids a metadata-ID/link-ID
cycle and guarantees the returned snapshot and collection agree.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx tsx --test tests/social-evidence-contracts.test.ts
```

Expected: all contract tests pass with zero warnings.

- [ ] **Step 5: Commit the domain contracts**

```bash
git add src/domain/social-evidence.ts src/domain/pumpfun-observation.ts src/ports/social-verification-provider.ts tests/social-evidence-contracts.test.ts
git commit -m "feat: define public social evidence contracts (#37)"
```

---

### Task 2: Extract a shared bounded public HTTP client

**Files:**
- Create: `src/ports/public-http-client.ts`
- Create: `src/metadata/bounded-public-http.client.ts`
- Modify: `src/domain/pumpfun-observation.ts`
- Modify: `src/metadata/http-metadata.provider.ts`
- Modify: `src/ports/metadata-provider.ts`
- Create: `tests/bounded-public-http.client.test.ts`
- Modify: `tests/http-metadata.provider.test.ts`

- [ ] **Step 1: Write failing transport and compatibility tests**

Test every public/private IPv4 and IPv6 range already covered by metadata tests,
plus multicast, documentation ranges, IPv4-mapped IPv6, mixed public/private
DNS answers, rebinding between redirects, credential URLs, manual redirect
limits, timeout, `content-length`, streamed overflow, invalid UTF-8, content
type, identity encoding and redacted typed failures. Keep a golden metadata
resolution test proving no public behavior changes.

```ts
void test('pins one validated public address and validates every redirect hop', async () => {
  const resolver = sequenceResolver([
    ['93.184.216.34'],
    ['127.0.0.1'],
  ]);
  const transport = new CapturingTransport([
    redirect('https://next.example/private'),
  ]);
  const client = new BoundedPublicHttpClient(transport.request, resolver, options());
  const result = await client.get('https://public.example/start', ['text/html']);
  assert.deepEqual(result, {
    status: 'FAILED', reason: 'UNSAFE_DESTINATION', retryable: false,
  });
  assert.deepEqual(transport.connectedAddresses, ['93.184.216.34']);
});

void test('does not expose URL, body, DNS answer or header in typed errors', async () => {
  const secret = 'https://user:secret@example.test/private';
  const error = await captureFailure(secret);
  assert.doesNotMatch(JSON.stringify(error), /secret|private|93\.184/iu);
});
```

- [ ] **Step 2: Run both focused files and verify RED**

Run:

```bash
npx tsx --test tests/bounded-public-http.client.test.ts tests/http-metadata.provider.test.ts
```

Expected: missing public HTTP module; existing metadata tests still describe the
compatibility target.

- [ ] **Step 3: Implement the port and DNS-pinned client**

Use the exact contract below. `body` exists only in the in-memory success
result and is never accepted by persistence types.

```ts
export type PublicHttpFailureReason =
  | 'URL_INVALID' | 'SCHEME_UNSUPPORTED' | 'UNSAFE_DESTINATION'
  | 'DNS_FAILED' | 'TIMEOUT' | 'NETWORK_FAILED' | 'REDIRECT_INVALID'
  | 'REDIRECT_LIMIT_EXCEEDED' | 'HTTP_STATUS_INVALID'
  | 'CONTENT_TYPE_UNSUPPORTED' | 'CONTENT_TOO_LARGE' | 'UTF8_INVALID';

export type PublicHttpResult =
  | Readonly<{
      status: 'SUCCEEDED';
      finalUrl: string;
      httpStatus: number;
      contentType: string;
      redirectCount: number;
      body: Uint8Array;
    }>
  | Readonly<{
      status: 'FAILED';
      reason: PublicHttpFailureReason;
      retryable: boolean;
    }>;

export interface PublicHttpClient {
  get(url: string, acceptedContentTypes: readonly string[]): Promise<PublicHttpResult>;
}

export interface BoundedPublicHttpClientOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly maxConcurrency: number;
  readonly maxPerHostConcurrency: 1;
}
```

The implementation must use `node:http`/`node:https`, `dns.promises.lookup`, a
custom pinned `lookup`, `Accept-Encoding: identity`, `redirect: manual`
semantics, an abort timer, bounded streaming and no proxy/environment credential.
Extract the existing IP predicate and strengthen it; do not call global
`fetch`, which would reconnect after validation. Add tests proving global
concurrency never exceeds `maxConcurrency` and two requests to the same host
are serialized even when requests to different hosts overlap.

- [ ] **Step 4: Refactor metadata resolution onto the port**

Keep `MetadataProvider.resolve(uri)` unchanged. Inject `PublicHttpClient`, call
`get(uri, ['application/json', 'text/json'])`, decode exactly once, normalize
the same fields, and map transport failure reasons to existing
`MetadataFailureReason` without leaking URLs. Add `retryable: boolean` to the
`FAILED` branch of `MetadataResolution`; transport timeout/DNS/network,
408/425/429 and 5xx are true, while syntax, unsafe destination, 4xx, content
type/size and JSON validation are false. Existing success payloads are
unchanged.

```ts
export class HttpMetadataProvider implements MetadataProvider {
  public constructor(private readonly http: PublicHttpClient) {}

  public readonly resolve = async (uri: string): Promise<MetadataResolution> => {
    const response = await this.http.get(uri, ['application/json', 'text/json']);
    if (response.status === 'FAILED') return metadataFailure(response.reason);
    return parseMetadata(response.body);
  };
}
```

- [ ] **Step 5: Run transport and metadata tests and verify GREEN**

Run:

```bash
npx tsx --test tests/bounded-public-http.client.test.ts tests/http-metadata.provider.test.ts
```

Expected: all tests pass; the metadata golden output is unchanged.

- [ ] **Step 6: Commit the shared transport**

```bash
git add src/ports/public-http-client.ts src/metadata/bounded-public-http.client.ts src/domain/pumpfun-observation.ts src/metadata/http-metadata.provider.ts src/ports/metadata-provider.ts tests/bounded-public-http.client.test.ts tests/http-metadata.provider.test.ts
git commit -m "feat: share bounded public HTTP transport (#37)"
```

---

### Task 3: Normalize social URLs and derive conservative evidence

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/social/social-url-normalizer.ts`
- Create: `src/social/public-content-evidence.ts`
- Create: `src/social/public-social-verification.provider.ts`
- Create: `src/social/social-qualification-observations.ts`
- Create: `tests/social-url-normalizer.test.ts`
- Create: `tests/public-content-evidence.test.ts`
- Create: `tests/public-social-verification.provider.test.ts`
- Create: `tests/social-qualification-observations.test.ts`
- Modify: `tests/dependency-safety.test.ts`

- [ ] **Step 1: Write failing table-driven URL tests**

Include canonical website URLs, default ports, fragments, credentials, Unicode
hosts, overlong URLs, X/twitter aliases and reserved routes, Telegram aliases,
phone/invite/private/bot/service links and hostile URL-like objects.

```ts
const accepted = [
  ['X', 'https://twitter.com/Project_1', 'https://x.com/project_1'],
  ['TELEGRAM', 'https://Project_1.t.me/', 'https://t.me/project_1'],
  ['TELEGRAM', 'https://telegram.me/Project_1', 'https://t.me/project_1'],
  ['WEBSITE', 'https://Example.COM:443/project#team', 'https://example.com/project'],
] as const;

for (const [kind, input, canonicalUrl] of accepted) {
  void test(`canonicalizes ${kind} ${input}`, () => {
    assert.deepEqual(normalizeSocialUrl(kind, input), {
      status: 'VALID', declaredValueSha256: sha256(input), canonicalUrl,
    });
  });
}

const rejected = [
  ['X', 'https://x.com/home'],
  ['X', 'https://x.com/project/status/1'],
  ['TELEGRAM', 'https://t.me/+invite'],
  ['TELEGRAM', 'https://t.me/c/123/4'],
  ['WEBSITE', 'https://user:password@example.com'],
] as const;
```

- [ ] **Step 2: Verify URL tests fail before implementation**

Run:

```bash
npx tsx --test tests/social-url-normalizer.test.ts
```

Expected: missing normalizer module.

- [ ] **Step 3: Pin HTML/public-suffix dependencies and implement normalizers**

Run:

```bash
npm install --save-exact parse5@8.0.1 tldts@7.4.10
```

Implement this exact boundary:

```ts
export type SocialUrlNormalization =
  | Readonly<{
      status: 'VALID';
      declaredValueSha256: string;
      canonicalUrl: string;
    }>
  | Readonly<{
      status: 'INVALID';
      declaredValueSha256: string;
      reason: SocialUrlInvalidReason;
    }>;

export const SOCIAL_URL_INVALID_REASONS = Object.freeze([
  'VALUE_MISSING', 'VALUE_NOT_TEXT', 'URL_INVALID', 'URL_TOO_LONG',
  'SCHEME_UNSUPPORTED', 'CREDENTIALS_FORBIDDEN', 'HOST_UNSUPPORTED',
  'PROFILE_PATH_UNSUPPORTED',
] as const);
export type SocialUrlInvalidReason =
  (typeof SOCIAL_URL_INVALID_REASONS)[number];

export function normalizeSocialUrl(
  kind: SocialLinkKind,
  declaredUrl: unknown,
): SocialUrlNormalization;

export function sameRegistrableDomain(left: string, right: string): boolean;

export function sanitizeMetadataForPersistence(
  metadata: PublicTokenMetadata,
  links: readonly SocialLinkV1[],
): PublicTokenMetadata;
```

Use `tldts.getDomain` with private suffixes disabled. If either host has no
registrable domain, equality is true only for identical normalized hostnames.
Never infer a match from suffix string comparison such as `evil-example.com`.
`sanitizeMetadataForPersistence` copies non-social metadata fields and replaces
website/X/Telegram strings with their canonical valid URL or `null`; tests must
prove raw invalid strings are absent from the serialized result.

- [ ] **Step 4: Write and run failing content extraction tests**

Demand visible mint matches, Base58 boundary rejection, anchor/meta URL
canonicalization, script/style/template exclusion, malformed HTML tolerance,
plain text, deterministic content hashes and node/text caps.

```ts
void test('extracts only visible exact mint and canonical public links', () => {
  const evidence = inspectPublicContent({
    contentType: 'text/html',
    body: encoder.encode(`<html><head><meta property="og:description" content="${MINT}"></head>
      <body><a href="https://twitter.com/Project_1">X</a>
      <script>${OTHER_MINT}</script></body></html>`),
    mint: MINT,
  });
  assert.equal(evidence.exactMintPublished, true);
  assert.deepEqual(evidence.canonicalLinks, ['https://x.com/project_1']);
  assert.equal(evidence.visibleText.includes(OTHER_MINT), false);
});
```

Run:

```bash
npx tsx --test tests/public-content-evidence.test.ts
```

Expected: missing content-evidence module.

- [ ] **Step 5: Implement bounded HTML/plain-text inspection**

Parse HTML with `parse5.parse`, walk at most 10,000 nodes, collect at most 64
canonical links, cap derived visible text at 256 KiB, skip `script`, `style` and
`template`, and return no excerpt:

```ts
export interface PublicContentFacts {
  readonly contentSha256: string;
  readonly exactMintPublished: boolean;
  readonly canonicalLinks: readonly string[];
}

export function inspectPublicContent(input: Readonly<{
  contentType: 'text/html' | 'text/plain';
  body: Uint8Array;
  mint: string;
}>): PublicContentFacts;
```

- [ ] **Step 6: Write failing provider tests**

Cover no declared links, invalid links, 2xx reachability, permanent 4xx,
retryable 429/5xx, cross-domain redirects, exact mint, directional cross-links,
login/JavaScript shells as unknown, inaccessible content, stable ordering,
`COMPLETE/PARTIAL/FAILED`, body disposal and one request per canonical link.

```ts
void test('records directional links without inventing the reverse direction', async () => {
  const { collection: result } = await providerWithPages({
    'https://project.example/': html('<a href="https://x.com/project">X</a>'),
    'https://x.com/project': html('<p>Public profile unavailable</p>'),
  }).collect(validProviderInput());
  assertEvidence(result, 'CROSS_LINK_CONFIRMED', 'WEBSITE', 'X', 'CONFIRMED');
  assertEvidence(result, 'CROSS_LINK_CONFIRMED', 'X', 'WEBSITE', 'UNKNOWN');
  assert.equal(result.status, 'PARTIAL');
});
```

- [ ] **Step 7: Implement the provider and verify all social unit tests**

The provider must normalize first, fetch only valid unique canonical URLs, map
one transport result to one `SocialHttpObservationV1`, then derive evidence
without catch-all booleans. `ACCOUNT_TOO_RECENT` is always `UNKNOWN` with reason
`AUTHORITATIVE_SOURCE_UNAVAILABLE` in this PR.

Run:

```bash
npx tsx --test tests/social-url-normalizer.test.ts tests/public-content-evidence.test.ts tests/public-social-verification.provider.test.ts tests/dependency-safety.test.ts
```

Expected: all tests pass and dependency safety recognizes only the two pinned
runtime additions.

- [ ] **Step 8: Commit social verification**

Before committing, add the pure qualification-boundary test and adapter. The
adapter may emit only facts directly supported by the collection; omission
means unknown and `false` is never synthesized from unavailable content.

```ts
export interface SocialQualificationObservations {
  readonly signals: Readonly<Partial<Record<
    'linksReachable' | 'socialCrossLinkConfirmed',
    boolean
  >>>;
  readonly upstreamConditions: readonly QualificationUpstreamCondition[];
}

export function toSocialQualificationObservations(
  collection: SocialEvidenceCollectionV1,
): SocialQualificationObservations;
```

Test bidirectional cross-link confirmation, conclusive rejection, partial/
unknown omission, exact-mint confirmation mapping
`MINT_SOCIAL_MISMATCH=false`, and the permanent omission of
`IMPERSONATION_SUSPECTED` in this PR. Then run:

```bash
npx tsx --test tests/social-qualification-observations.test.ts
```

Expected: all mapping tests pass without invoking `QualificationEngine` or
changing any configured mode.

```bash
git add package.json package-lock.json src/social tests/social-url-normalizer.test.ts tests/public-content-evidence.test.ts tests/public-social-verification.provider.test.ts tests/social-qualification-observations.test.ts tests/dependency-safety.test.ts
git commit -m "feat: derive conservative public social evidence (#37)"
```

---

### Task 4: Add replayable social persistence and atomic enqueue

**Files:**
- Create: `migrations/012_public_social_evidence.sql`
- Create: `src/ports/social-evidence-repository.ts`
- Create: `src/storage/social-evidence.repository.ts`
- Modify: `src/storage/launchpad-event.repository.ts`
- Create: `tests/social-evidence-migration.test.ts`
- Create: `tests/social-evidence.repository.test.ts`
- Modify: `tests/launchpad-event.repository.test.ts`
- Modify: `tests/copy-migrations.test.ts`
- Modify: `tests/migration-contract.test.ts`

- [ ] **Step 1: Write failing migration tests**

Require all five tables, enum/check constraints, FKs, claim/current/purge
indexes, four-hour equality, raw-content column absence, existing-row backfill,
empty-schema application and clean replay. Inspect `information_schema.columns`
to reject `body`, `html`, `headers`, `cookies`, `ip_address` and `dns_answers`.

```ts
void test('creates safe replayable public social storage without raw content', async () => {
  await withMigratedSchema(async (pool) => {
    for (const table of [
      'social_enrichment_jobs', 'social_evidence_collections',
      'social_http_observations', 'social_links',
      'social_verification_evidence',
    ]) assert.equal(await relationExists(pool, table), true);
    const columns = await socialColumnNames(pool);
    assert.equal(columns.some((name) => /body|html|header|cookie|ip|dns/iu.test(name)), false);
    await migrateDatabase({ pool });
  });
});
```

- [ ] **Step 2: Run migration tests and verify RED**

Run:

```bash
TEST_DATABASE_URL='postgresql://haythem.mabrouk@127.0.0.1:5432/postgres' npx tsx --test tests/social-evidence-migration.test.ts tests/copy-migrations.test.ts tests/migration-contract.test.ts
```

Expected: migration 012 and tables are absent.

- [ ] **Step 3: Implement migration 012**

Create exact status checks from Task 1, `NUMERIC(78,0)` for chain slots, safe
integer bounds for attempts/counts, source event/raw event FKs, immutable
fingerprints, lease invariants, `purge_after = terminal_at + INTERVAL '4 hours'`
and partial indexes:

```sql
ALTER TABLE token_metadata_snapshots
  ADD COLUMN IF NOT EXISTS source_launch_event_id TEXT
    REFERENCES domain_events(event_id);

ALTER TABLE token_metadata_snapshots
  ADD COLUMN IF NOT EXISTS failure_retryable BOOLEAN;

CREATE UNIQUE INDEX IF NOT EXISTS token_metadata_snapshots_source_idx
  ON token_metadata_snapshots(source_launch_event_id, payload_hash)
  WHERE source_launch_event_id IS NOT NULL;
```

Existing metadata rows keep `source_launch_event_id = NULL` and
`failure_retryable = NULL`; the migration does not fabricate lineage or retry
semantics. Every new social job completion supplies both fields consistently.

```sql
CREATE TABLE IF NOT EXISTS social_enrichment_jobs (
  job_id TEXT PRIMARY KEY,
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  source_launch_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  source_raw_event_id TEXT REFERENCES raw_chain_events(event_id),
  metadata_uri TEXT,
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING','PROCESSING','RETRYABLE_FAILED','COMPLETED','CANCELLED'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  attempts_in_cycle INTEGER NOT NULL DEFAULT 0
    CHECK (attempts_in_cycle BETWEEN 0 AND 100 AND attempts_in_cycle <= attempts),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  base_delay_ms INTEGER NOT NULL CHECK (base_delay_ms BETWEEN 1 AND 60000),
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code TEXT,
  retry_exhausted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  UNIQUE (mint, source_launch_event_id),
  CHECK ((terminal_at IS NULL AND purge_after IS NULL)
    OR purge_after = terminal_at + INTERVAL '4 hours')
);
```

Complete the collection/observation/link/evidence tables described by the spec;
do not store an arbitrary JSON body as a substitute for checked columns.

- [ ] **Step 4: Write failing atomic enqueue tests**

Prove launch + job commit together, missing `parameters.uri` yields a nullable
URI job, duplicate launch replay does not duplicate work, conflicting source
identity rolls back, orphaned launch cancels work and finalized replay advances
source status without changing job identity.

```ts
void test('persists launch and social job atomically without fetching HTTP', async () => {
  const result = await repository.record(batchWithUri('https://meta.example/token.json'));
  assert.equal(result.events[0]?.outcome, 'created');
  const job = await loadSocialJob(pool, MINT);
  assert.equal(job?.metadata_uri, 'https://meta.example/token.json');
  assert.equal(job?.status, 'PENDING');
  assert.equal(httpCalls, 0);
});
```

- [ ] **Step 5: Define repository job operations and implement enqueue**

```ts
export interface SocialEvidenceRepository {
  claim(options: Readonly<{ leaseMs: number; nowMs: number }>): Promise<ClaimedSocialJob | null>;
  renew(jobId: string, leaseToken: string, leaseMs: number, nowMs: number): Promise<boolean>;
  complete(job: ClaimedSocialJob, result: SocialJobResult): Promise<void>;
  fail(job: ClaimedSocialJob, failure: SocialJobFailure): Promise<void>;
  counts(): Promise<SocialJobCounts>;
}

export interface ClaimedSocialJob {
  readonly id: string;
  readonly mint: string;
  readonly sourceLaunchEventId: string;
  readonly metadataUri: string | null;
  readonly attempts: number;
  readonly attemptsInCycle: number;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
}

export type SocialJobResult =
  | Readonly<{
      status: 'RESOLVED';
      metadataSnapshot: TokenMetadataSnapshot;
      collection: SocialEvidenceCollectionV1;
    }>
  | Readonly<{
      status: 'METADATA_FAILED';
      metadataSnapshot: TokenMetadataSnapshot;
      collection: SocialEvidenceCollectionV1;
    }>;

export interface SocialJobFailure {
  readonly code: 'HTTP_TRANSIENT' | 'PROVIDER_UNAVAILABLE' | 'LEASE_EXPIRED';
  readonly retryable: boolean;
  readonly observedAtMs: number;
}

export interface SocialJobCounts {
  readonly pending: number;
  readonly processing: number;
  readonly retryableFailed: number;
  readonly exhausted: number;
}
```

Pass the source raw/domain IDs into `writeLaunch`, read only the own data
property `parameters.uri`, and insert the job in the same repeatable-read
transaction. `ON CONFLICT` accepts only the exact immutable fingerprint.

- [ ] **Step 6: Verify migrations and enqueue GREEN**

Run:

```bash
TEST_DATABASE_URL='postgresql://haythem.mabrouk@127.0.0.1:5432/postgres' npx tsx --test tests/social-evidence-migration.test.ts tests/launchpad-event.repository.test.ts tests/copy-migrations.test.ts tests/migration-contract.test.ts
```

Expected: all tests pass, including empty schema and replay.

- [ ] **Step 7: Commit persistence foundation**

```bash
git add migrations/012_public_social_evidence.sql src/ports/social-evidence-repository.ts src/storage/social-evidence.repository.ts src/storage/launchpad-event.repository.ts tests/social-evidence-migration.test.ts tests/social-evidence.repository.test.ts tests/launchpad-event.repository.test.ts tests/copy-migrations.test.ts tests/migration-contract.test.ts
git commit -m "feat: persist durable social enrichment jobs (#37)"
```

---

### Task 5: Complete jobs atomically and reconcile finality

**Files:**
- Modify: `src/domain/events.ts`
- Modify: `src/domain/social-evidence.ts`
- Modify: `src/storage/social-evidence.repository.ts`
- Modify: `src/storage/launchpad-event.repository.ts`
- Modify: `tests/social-evidence.repository.test.ts`
- Modify: `tests/launchpad-event.repository.test.ts`
- Modify: `tests/api-event-stream.repository.test.ts`
- Modify: `tests/api-event-stream-migration.test.ts`

- [ ] **Step 1: Write failing live completion tests**

Cover `SKIP LOCKED`, concurrent claim exclusion, expired lease reclaim, renewal,
stale-token completion rejection, transient scheduling, exact exhaustion,
permanent failure collection, statement-by-statement rollback, replay, conflict,
event payload bounds and SSE outbox insertion.

```ts
void test('atomically completes one leased job with projections and event', async () => {
  const job = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
  assert.ok(job);
  await repository.complete(job, successfulJobResult());
  assert.deepEqual(await tableCounts(pool), {
    collections: 1, observations: 3, links: 3, evidence: 12,
    socialEvents: 1, sseRevisions: 1,
  });
  assert.equal((await loadJob(pool, job.id)).status, 'COMPLETED');
});

void test('rolls back every projection when event insertion fails', async () => {
  const job = await claimedJob(pool);
  await breakSocialEventConstraint(pool);
  await assert.rejects(repository.complete(job, successfulJobResult()));
  assert.deepEqual(await tableCounts(pool), zeroCompletionCounts());
  assert.equal((await loadJob(pool, job.id)).status, 'PROCESSING');
});
```

- [ ] **Step 2: Verify completion tests RED**

Run:

```bash
TEST_DATABASE_URL='postgresql://haythem.mabrouk@127.0.0.1:5432/postgres' npx tsx --test tests/social-evidence.repository.test.ts tests/api-event-stream.repository.test.ts tests/api-event-stream-migration.test.ts
```

Expected: claim/completion behavior or social event persistence is missing.

- [ ] **Step 3: Implement transactional completion and derived event ID**

Add a deterministic ID function with a qualifier while retaining the complete
chain envelope:

```ts
export function createDeterministicDerivedEventId(input: Readonly<{
  type: DomainEventType;
  mint: string;
  source: string;
  program: string;
  signature: string;
  cursor: ChainCursor;
  qualifier: string;
}>): string;
```

`SocialEvidenceCollected` uses `source='public_social'`, the launch program,
signature/cursor/blockchain time, source raw event FK, current launch
confirmation and `qualifier=inputFingerprint`. Persist safe source observations
first, then business rows, domain event, outbox trigger result and job status in
one transaction guarded by mint advisory lock and lease token.

- [ ] **Step 4: Write failing finality/orphan tests**

Require processed→confirmed→finalized changes on the same social event ID,
one SSE revision per advance, duplicate finality no-op, processed→orphaned job
cancellation, in-flight completion rejection, current API exclusion and exact
four-hour purge timestamps.

```ts
void test('orphans derived evidence and rejects an in-flight completion', async () => {
  const job = await repository.claim({ leaseMs: 10_000, nowMs: NOW });
  assert.ok(job);
  await launchRepository.record(orphanedReplayBatch());
  await assert.rejects(
    repository.complete(job, successfulJobResult()),
    SocialJobLeaseLostError,
  );
  assert.equal((await loadJob(pool, job.id)).status, 'CANCELLED');
  assert.equal((await loadSocialEvent(pool)).confirmation_status, 'orphaned');
  assert.equal(await currentSocialCollection(pool, MINT), null);
});
```

- [ ] **Step 5: Implement source-finality reconciliation**

Within the existing launch repository transaction, lock social rows by
`source_launch_event_id`. Advance derived event confirmation using the existing
confirmation lattice. On orphan, cancel active jobs, terminalize every child
row and update derived domain events to `orphaned`; let the existing outbox
trigger record the revision. Never reactivate rows tied to an old source event.

- [ ] **Step 6: Verify completion/finality GREEN**

Run:

```bash
TEST_DATABASE_URL='postgresql://haythem.mabrouk@127.0.0.1:5432/postgres' npx tsx --test tests/social-evidence.repository.test.ts tests/launchpad-event.repository.test.ts tests/api-event-stream.repository.test.ts tests/api-event-stream-migration.test.ts
```

Expected: all claim, completion, replay, finality, orphan and SSE tests pass.

- [ ] **Step 7: Commit atomic completion and finality**

```bash
git add src/domain/events.ts src/domain/social-evidence.ts src/storage/social-evidence.repository.ts src/storage/launchpad-event.repository.ts tests/social-evidence.repository.test.ts tests/launchpad-event.repository.test.ts tests/api-event-stream.repository.test.ts tests/api-event-stream-migration.test.ts
git commit -m "feat: reconcile social evidence finality (#37)"
```

---

### Task 6: Add the independent enrichment worker

**Files:**
- Create: `src/application/social-enrichment-worker.ts`
- Create: `tests/social-enrichment-worker.test.ts`
- Modify: `src/domain/transaction-ingestion.ts`

- [ ] **Step 1: Write failing worker lifecycle tests**

Cover start idempotence, claim→metadata→social→complete, missing/invalid URI,
metadata permanent failure, retryable transport error, lease renewal, lease loss,
provider throw redaction, no partial completion, idle polling, bounded shutdown,
timeout degradation, no timer after close and no Solana pipeline dependency.

```ts
void test('enriches outside the Solana transaction path and completes once', async () => {
  const repository = new ScriptedSocialRepository([claimedJob(), null]);
  const worker = new SocialEnrichmentWorker(
    repository,
    metadataProvider(resolvedMetadata()),
    socialProvider(successfulProviderResult()),
    workerOptions(),
    scheduler,
  );
  await worker.start();
  await scheduler.runNext();
  assert.equal(repository.completions.length, 1);
  assert.equal(repository.failures.length, 0);
  assert.equal(worker.state, 'RUNNING');
});

void test('stops claiming before bounded shutdown waits for in-flight work', async () => {
  const pending = deferred<Readonly<{
    metadataSnapshot: TokenMetadataSnapshot;
    collection: SocialEvidenceCollectionV1;
  }>>();
  const worker = workerWithPendingProvider(pending.promise);
  await worker.start();
  const closing = worker.close();
  assert.equal(worker.state, 'STOPPING');
  pending.resolve(successfulProviderResult());
  await closing;
  assert.equal(worker.state, 'STOPPED');
});
```

- [ ] **Step 2: Run worker test and verify RED**

Run:

```bash
npx tsx --test tests/social-enrichment-worker.test.ts
```

Expected: missing worker module.

- [ ] **Step 3: Implement worker state machine**

```ts
export interface SocialEnrichmentWorkerOptions {
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly renewalIntervalMs: number;
  readonly shutdownTimeoutMs: number;
}

export class SocialEnrichmentWorker {
  public readonly state: ListenerRuntimeState;
  public start(): Promise<void>;
  public close(): Promise<void>;
}
```

Snapshot job/provider results at trust boundaries. Resolve metadata once per
attempt; for a resolved snapshot call social collection once and verify the
provider's safe metadata snapshot ID equals the collection's
`metadataSnapshotId` before repository completion. A metadata failure uses the
domain failed-collection factory and never invokes the social provider. Pass
retryability only through typed failures. A thrown provider error becomes
`PROVIDER_UNAVAILABLE` without message/URL. Schedule the next poll only after
the current claim settles, so concurrency is one at the job layer; HTTP retains
its independent bounded link concurrency.

- [ ] **Step 4: Verify worker GREEN**

Run:

```bash
npx tsx --test tests/social-enrichment-worker.test.ts tests/social-evidence-contracts.test.ts tests/public-social-verification.provider.test.ts
```

Expected: all lifecycle and provider tests pass.

- [ ] **Step 5: Commit the worker**

```bash
git add src/application/social-enrichment-worker.ts src/domain/transaction-ingestion.ts tests/social-enrichment-worker.test.ts
git commit -m "feat: process social enrichment jobs independently (#37)"
```

---

### Task 7: Expose canonical social evidence through API V1

**Files:**
- Modify: `src/api/contracts.ts`
- Modify: `src/ports/api-projection-repository.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `tests/api-contracts.test.ts`
- Modify: `tests/api-projection.repository.test.ts`
- Modify: `tests/api-router.test.ts`
- Modify: `tests/api-sse.test.ts`

- [ ] **Step 1: Write failing API contract/projection tests**

Require the additive union, all collection statuses, decimal chain values,
stable link/evidence order, explicit totals/truncation, latest non-orphaned
collection, no result before completion, failed metadata as `AVAILABLE/FAILED`,
launch detail equality with `/social`, malformed-row failure and SSE payload
bounds.

```ts
const available: ApiSocial = {
  status: 'AVAILABLE',
  collectionStatus: 'PARTIAL',
  collectionId: 'social_collection_a',
  metadataSnapshotId: 'pumpfun_metadata_a',
  observedAt: '2026-08-10T12:00:00.000Z',
  linkCount: 3,
  linksTruncated: false,
  links: [apiWebsiteLink(), apiXLink(), apiTelegramLink()],
  evidenceCount: 9,
  evidenceTruncated: false,
  evidence: apiEvidence(),
  coverage: {
    declaredLinkCount: 3, inspectedLinkCount: 2,
    confirmedEvidenceCount: 4, rejectedEvidenceCount: 1,
    unknownEvidenceCount: 4,
  },
};
```

- [ ] **Step 2: Run API tests and verify RED**

Run:

```bash
npx tsx --test tests/api-contracts.test.ts tests/api-projection.repository.test.ts tests/api-router.test.ts tests/api-sse.test.ts
```

Expected: `ApiSocial` accepts only `NOT_AVAILABLE` and repository returns the
placeholder.

- [ ] **Step 3: Implement the additive API union and strict projection**

```ts
export type ApiSocial = ApiSocialUnavailable | ApiSocialAvailable;

export interface ApiSocialUnavailable {
  readonly status: 'NOT_AVAILABLE';
  readonly links: readonly [];
  readonly evidence: readonly [];
}

export interface ApiSocialAvailable {
  readonly status: 'AVAILABLE';
  readonly collectionStatus: SocialCollectionStatus;
  readonly collectionId: string;
  readonly metadataSnapshotId: string;
  readonly observedAt: string;
  readonly linkCount: number;
  readonly linksTruncated: boolean;
  readonly links: readonly ApiSocialLink[];
  readonly evidenceCount: number;
  readonly evidenceTruncated: boolean;
  readonly evidence: readonly ApiSocialEvidence[];
  readonly coverage: ApiSocialCoverage;
}

export interface ApiSocialLink {
  readonly id: string;
  readonly kind: SocialLinkKind;
  readonly declaredValueSha256: string;
  readonly syntaxStatus: 'VALID' | 'INVALID';
  readonly canonicalUrl: string | null;
  readonly invalidReason: string | null;
  readonly observedAt: string;
}

export interface ApiSocialEvidence {
  readonly id: string;
  readonly type: SocialEvidenceType;
  readonly outcome: SocialEvidenceOutcome;
  readonly subjectKind: SocialLinkKind | null;
  readonly relatedKind: SocialLinkKind | null;
  readonly subjectUrl: string | null;
  readonly finalUrl: string | null;
  readonly httpStatus: number | null;
  readonly redirectCount: number;
  readonly contentSha256: string | null;
  readonly reasonCode: string;
  readonly observedAt: string;
}

export interface ApiSocialCoverage {
  readonly declaredLinkCount: number;
  readonly inspectedLinkCount: number;
  readonly confirmedEvidenceCount: number;
  readonly rejectedEvidenceCount: number;
  readonly unknownEvidenceCount: number;
}
```

Query one current collection joined to a non-retracted launch and non-orphaned
derived event. Fetch links/evidence with fixed limits (64 each), validate every
column and freeze recursively. Do not expose original response bodies, DNS or
job errors. Keep the route read-only and queryless.

- [ ] **Step 4: Verify API/SSE GREEN**

Run:

```bash
TEST_DATABASE_URL='postgresql://haythem.mabrouk@127.0.0.1:5432/postgres' npx tsx --test tests/api-contracts.test.ts tests/api-projection.repository.test.ts tests/api-router.test.ts tests/api-sse.test.ts tests/api-event-stream.repository.test.ts
```

Expected: both placeholder and available projections pass; SSE remains
resumable and emits the bounded social event.

- [ ] **Step 5: Commit API projection**

```bash
git add src/api/contracts.ts src/ports/api-projection-repository.ts src/storage/api-projection.repository.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts tests/api-router.test.ts tests/api-sse.test.ts
git commit -m "feat: expose social evidence in API v1 (#37)"
```

---

### Task 8: Compose safe configuration, runtime lifecycle and health

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `src/application/listener-runtime.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `src/ports/listener-runtime.ts`
- Modify: `src/domain/transaction-ingestion.ts`
- Modify: `src/api/contracts.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `src/app.ts`
- Modify: `tests/config-safety.test.ts`
- Modify: `tests/listener-runtime.test.ts`
- Modify: `tests/production-listener-factory.test.ts`
- Modify: `tests/bootstrap-safety.test.ts`
- Modify: `tests/api-contracts.test.ts`
- Modify: `tests/api-projection.repository.test.ts`
- Modify: `tests/paper-trading-safety.test.ts`

- [ ] **Step 1: Write failing configuration tests**

Require canonical decimal integers and bounds for:

```text
SOCIAL_HTTP_TIMEOUT_MS=5000             (100..30000)
SOCIAL_HTTP_MAX_BYTES=262144            (1024..1048576)
SOCIAL_HTTP_MAX_REDIRECTS=3             (0..10)
SOCIAL_HTTP_CONCURRENCY=2               (1..8)
SOCIAL_WORKER_POLL_MS=1000              (100..60000)
SOCIAL_WORKER_LEASE_SECONDS=30          (5..300)
SOCIAL_RETRY_MAX_ATTEMPTS=3             (1..10)
SOCIAL_RETRY_BASE_DELAY_MS=1000         (100..60000)
```

Test minimum/maximum acceptance; leading zero, sign, whitespace, exponent,
maximum-plus-one and unknown execution mode rejection. Assert configuration
errors/logs contain no configured URL or environment dump.

- [ ] **Step 2: Verify configuration RED**

Run:

```bash
npx tsx --test tests/config-safety.test.ts
```

Expected: new fields are missing.

- [ ] **Step 3: Implement strict non-secret configuration**

Add exact `AppConfig` fields and `parseCanonicalBoundedInteger`. `.env.example`
contains only safe defaults above and no X/Telegram token, cookie, proxy or
wallet secret.

- [ ] **Step 4: Write failing runtime/composition/health tests**

Require startup order `rpc→scan→subscriber→scan→transaction worker→social
worker→reconciler→heartbeat`, reverse bounded shutdown, rollback after each
social start failure, independent social degradation, `pipeline.social`, job
counts, no URLs in health and unchanged execution boundary.

```ts
void test('social degradation does not relabel chain pipelines', () => {
  const runtime = runningRuntime({ social: 'DEGRADED' });
  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true,
    pumpfun: 'RUNNING',
    pumpswap: 'RUNNING',
    social: 'DEGRADED',
  });
});

void test('production composition has no signer or submission path', async () => {
  await assertNoExecutionBoundaryImports([
    'src/application/social-enrichment-worker.ts',
    'src/storage/social-evidence.repository.ts',
    'src/social/public-social-verification.provider.ts',
  ]);
});
```

- [ ] **Step 5: Compose repository, providers and worker**

Create one `BoundedPublicHttpClient` from validated options, inject it into
metadata/social providers, create `PostgresSocialEvidenceRepository`, and add
the worker as an explicit `SolanaListenerRuntime` resource. The transaction
worker only enqueues through the launch repository transaction; it never imports
the HTTP client/provider.

Health extends the existing state without making a social failure return HTTP
503 while PostgreSQL remains available:

```ts
export interface ApiProjectionPipelineState {
  readonly httpAvailable: boolean;
  readonly pumpfun: ApiHealth['pipeline']['pumpfun'];
  readonly pumpswap: ApiHealth['pipeline']['pumpswap'];
  readonly social: ApiHealth['pipeline']['social'];
}
```

Add a separate bounded count projection so transaction and social backlogs are
never conflated:

```ts
export interface ApiSocialJobHealth {
  readonly pendingCount: number;
  readonly leasedCount: number;
  readonly retryableFailedCount: number;
  readonly exhaustedCount: number;
}

export interface ApiPipelineHealth {
  readonly pumpfun: 'IDLE' | 'RUNNING' | 'DEGRADED' | 'STOPPED';
  readonly pumpswap: 'IDLE' | 'RUNNING' | 'DEGRADED' | 'STOPPED';
  readonly social: 'IDLE' | 'RUNNING' | 'DEGRADED' | 'STOPPED';
}
```

`ApiHealth` gains `socialJobs: ApiSocialJobHealth`. Validate each count as a
non-negative safe integer and never include job URLs or error text.

- [ ] **Step 6: Verify configuration/runtime/health GREEN**

Run:

```bash
npx tsx --test tests/config-safety.test.ts tests/listener-runtime.test.ts tests/production-listener-factory.test.ts tests/bootstrap-safety.test.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts tests/paper-trading-safety.test.ts
```

Expected: all focused tests pass; no live execution import or secret field is
introduced.

- [ ] **Step 7: Commit composition**

```bash
git add src/config/env.ts .env.example src/application/listener-runtime.ts src/application/production-listener-factory.ts src/ports/listener-runtime.ts src/domain/transaction-ingestion.ts src/api/contracts.ts src/storage/api-projection.repository.ts src/app.ts tests/config-safety.test.ts tests/listener-runtime.test.ts tests/production-listener-factory.test.ts tests/bootstrap-safety.test.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts tests/paper-trading-safety.test.ts
git commit -m "feat: compose passive social enrichment runtime (#37)"
```

---

### Task 9: Purge, documentation and complete acceptance verification

**Files:**
- Modify: `src/storage/database.ts`
- Modify: `tests/storage-foundation.test.ts`
- Modify: `tests/social-evidence-migration.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/api/v1.md`
- Modify: `docs/system-overview.html`
- Modify: `scripts/check-system-overview.ts`
- Modify: `tests/config-safety.test.ts`

- [ ] **Step 1: Write failing retention and documentation verifier tests**

Require child-first purge of evidence→links/observations→collections→jobs,
terminal equality at four hours, non-terminal preservation, orphan preservation
until deadline, no raw-content columns and documentation of `AVAILABLE`, unknown
semantics, no paid APIs and no legitimacy/profit claim.

```ts
void test('purges every terminal social row child-first after four hours', async () => {
  await insertTerminalSocialGraph(pool, hoursAgo(4));
  await purgeExpiredData(pool);
  assert.deepEqual(await tableCounts(pool), zeroSocialCounts());
});

void test('keeps a social graph one millisecond before its deadline', async () => {
  await insertTerminalSocialGraph(pool, Date.now() - 4 * 3_600_000 + 1);
  await purgeExpiredData(pool);
  assert.equal((await tableCounts(pool)).collections, 1);
});
```

- [ ] **Step 2: Verify retention/docs tests RED**

Run:

```bash
TEST_DATABASE_URL='postgresql://haythem.mabrouk@127.0.0.1:5432/postgres' npx tsx --test tests/storage-foundation.test.ts tests/social-evidence-migration.test.ts tests/config-safety.test.ts
npm run docs:check
```

Expected: purge and overview verifier do not yet cover social storage/runtime.

- [ ] **Step 3: Implement purge and documentation**

Delete only rows whose own `purge_after <= statement_timestamp()`, in FK-safe
order. Update README, architecture, API and Bootstrap HTML with the actual
worker/data flow, collection statuses, conservative unknown semantics, public
sources and four-hour retention. State explicitly that metadata/social signals
do not prove seriousness, sellability or profit.

- [ ] **Step 4: Run focused retention and docs verification GREEN**

Run:

```bash
TEST_DATABASE_URL='postgresql://haythem.mabrouk@127.0.0.1:5432/postgres' npx tsx --test tests/storage-foundation.test.ts tests/social-evidence-migration.test.ts tests/config-safety.test.ts
npm run docs:check
```

Expected: focused tests and HTML verifier pass.

- [ ] **Step 5: Audit the complete diff against the specification**

Run:

```bash
git diff --check origin/main
git status --short
git diff --stat origin/main
rg -n "private key|secret key|sendTransaction|signTransaction|EXECUTION_MODE=live" src migrations .env.example docs tests
```

Expected: no whitespace errors, only issue #37 files, and no new live/signing
path. Inspect every spec acceptance criterion and record its proving test in the
PR body.

- [ ] **Step 6: Run fresh complete acceptance verification**

Run each command separately so an early success cannot hide a later failure:

```bash
npm install
npm run build
npm run check
npm run lint
npm run docs:check
TEST_DATABASE_URL='postgresql://haythem.mabrouk@127.0.0.1:5432/postgres' npm test
```

Expected: every command exits zero; PostgreSQL suite has zero failures and zero
skips; build packages migrations 001–012; no existing test regresses. Record
the dependency audit count without running an automatic breaking fix.

- [ ] **Step 7: Commit final documentation and verification changes**

```bash
git add src/storage/database.ts tests/storage-foundation.test.ts tests/social-evidence-migration.test.ts README.md docs/architecture/pumpfun-v1.md docs/api/v1.md docs/system-overview.html scripts/check-system-overview.ts tests/config-safety.test.ts
git commit -m "docs: document public social evidence operation (#37)"
```

---

## Specification coverage audit

| Design requirement | Proving task |
| --- | --- |
| Immutable links/evidence, stable reason types and deterministic IDs | Task 1 |
| SSRF, DNS pinning, redirects, timeout, bytes and concurrency | Task 2 |
| Website/X/Telegram normalization and no raw invalid value retention | Task 3 |
| Conservative mint/cross-link/unknown facts and qualification adapter | Task 3 |
| Durable job, replayable schema and atomic launch enqueue | Task 4 |
| Lease/retry/exhaustion, atomic completion and raw/business separation | Tasks 4–6 |
| Processed/confirmed/finalized/orphaned reconciliation and SSE revisions | Task 5 |
| Worker restart/shutdown independent of Solana ingestion | Task 6 |
| Additive API V1 `NOT_AVAILABLE | AVAILABLE` projection | Task 7 |
| Safe observe/paper composition, health and no execution imports | Task 8 |
| Four-hour retention, documentation and full acceptance commands | Task 9 |

No design requirement remains without an implementation task or a proving
test. Paid/authenticated APIs, browser rendering, account history,
qualification composition and real execution remain explicitly outside issue
#37.

---

## Pull request and review gate

After Task 9:

1. perform a whole-branch correctness/security review against the design;
2. fix every Critical or Important local finding with a regression test;
3. push `feature/public-social-evidence-37` and open one PR closing #37;
4. request a posted GitHub Codex review focused on SSRF/DNS rebinding,
   finality/orphaning, leases/retries, privacy, API compatibility and missing
   tests;
5. perform at most three correction/review cycles;
6. reply inline and resolve only technically addressed threads;
7. rerun full acceptance verification after the final change;
8. merge only with clean merge state, no pending checks and no unresolved
   blocking thread;
9. synchronize `main` and remove only the owned issue #37 worktree.

Do not request a fourth review cycle. If a blocking issue remains after cycle
three, leave the PR open and report it rather than bypassing the gate.

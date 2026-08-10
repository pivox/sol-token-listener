# Public Social Evidence Design

**Status:** approved for planning by the continuing nine-PR delivery mandate  
**Issue:** [#37](https://github.com/pivox/sol-token-listener/issues/37)  
**Date:** 2026-08-10

## Objective

Resolve the public metadata attached to each Pump.fun creation, verify the
declared website, X and Telegram links with bounded public HTTP observations,
persist auditable facts, and expose the latest immutable result through API V1
and SSE.

This work adds preparation and social-authenticity evidence. It never treats a
picture, description or social account as proof that a token is serious. It
does not change the qualification verdict or open a paper position by itself.

## Current state and problem

The repository already contains:

- an SSRF-aware `HttpMetadataProvider` that can normalize a public metadata
  JSON document;
- `token_metadata_snapshots` persistence;
- the stable `SocialEvidenceCollected` event name;
- the public `/api/v1/launches/:mint/social` route.

None of those pieces is composed into the production listener. There is no
durable metadata job, social provider, social persistence or social event. The
API therefore returns the honest placeholder:

```json
{ "status": "NOT_AVAILABLE", "links": [], "evidence": [] }
```

Performing remote HTTP calls in the Solana transaction worker would couple RPC
ingestion to arbitrary website latency and would make transaction retries
repeat external fetches. Social enrichment must therefore have its own durable
boundary.

## Considered approaches

### 1. Fetch inside the Solana transaction pipeline

This is the smallest amount of wiring, but a slow or unavailable website would
hold an inbox lease and degrade Pump.fun ingestion. It also conflates chain
replay with off-chain observation. Rejected.

### 2. Durable enrichment worker

A launch transaction atomically creates or refreshes one metadata/social job.
A separate worker claims jobs with leases, performs bounded HTTP observations,
and records one immutable result atomically. Chain ingestion never waits for
the public web. Selected.

### 3. Browser rendering or paid platform APIs

This can observe more dynamic content and account history, but requires a much
larger security boundary, credentials or paid APIs, rate-limit management and
non-deterministic browser behavior. Deferred behind provider ports.

## Scope

### Included

- durable metadata and social jobs created from `TokenLaunchDetected`;
- metadata JSON resolution and immutable snapshot persistence;
- canonical website, X and Telegram link normalization;
- bounded public HTTP reachability checks;
- redirect-domain, cross-link and exact-mint evidence when observable;
- explicit unknown/unavailable evidence when it is not observable;
- deterministic `SocialEvidenceCollected` events tied to the source launch;
- API V1 projection and SSE publication;
- additive runtime health for the enrichment worker;
- four-hour terminal retention;
- unit, PostgreSQL integration, runtime safety and migration tests.

### Excluded

- X, Telegram or other paid/authenticated APIs;
- login, cookies, JavaScript execution or a headless browser;
- account-age claims without an authoritative public observation;
- follower counts, engagement scoring or sentiment analysis;
- historical creator or wallet searches;
- changing qualification modes, weights, thresholds or verdicts;
- composing qualification or paper trading into production;
- any wallet, signing, transaction building or transaction submission.

## Trust model

All metadata and web content is untrusted. The public HTTP layer must:

1. accept only `http:` and `https:` URLs without credentials;
2. resolve every hop and reject loopback, link-local, private, carrier-grade
   NAT, multicast, unspecified and IPv4-mapped IPv6 destinations;
3. pin the selected public address in the outbound request so DNS cannot be
   rebound between validation and connection;
4. follow redirects manually with a configured maximum;
5. apply per-request timeout, maximum response bytes and maximum redirect
   count;
6. request identity encoding and never persist response headers;
7. accept metadata only as bounded UTF-8 JSON, and social content only as
   bounded UTF-8 `text/html` or `text/plain`;
8. use bounded global concurrency and at most one in-flight request per host;
9. discard every response body immediately after deriving facts.

The common network implementation becomes a reusable
`BoundedPublicHttpClient`. `HttpMetadataProvider` and
`PublicSocialVerificationProvider` consume that port rather than duplicating
DNS and redirect security.

No raw HTML, JSON source text, cookies, authorization data, IP addresses, DNS
answers or arbitrary response headers are persisted or logged. Logs contain
only stable job identifiers, mint, provider stage, typed result code and
bounded counters. URLs are not included in error logs.

Bounded HTML is parsed with a pinned HTML5 parser. Evidence extraction visits
visible text, anchors and relevant metadata fields while excluding script,
style and template bodies. Plain text is inspected directly. This conservative
surface avoids treating opaque application bundles as project statements.
Effective registrable domains are computed with a pinned,
public-suffix-aware library. Both dependencies are included in the dependency
audit and are not allowed to make network calls.

## URL normalization

Normalization is deterministic and happens before a request.

### Website

- accept credential-free `http:` or `https:` URLs;
- lowercase the host, remove the fragment and remove a default port;
- retain path and query because they may identify the project page;
- normalize an empty path to `/`;
- reject URLs above the configured byte bound.

Redirect consistency compares effective registrable domains using a maintained
public-suffix implementation. A same-site host change such as
`project.example` to `www.project.example` is not a mismatch. A different
registrable domain produces `DOMAIN_MISMATCH`; reachability remains a separate
fact and does not erase the redirect evidence.

### X

- accept `x.com/<handle>` and the legacy `twitter.com/<handle>` aliases;
- accept only a single profile path segment containing ASCII letters, digits
  or underscore, with a maximum of 15 characters;
- reject service routes, post/status URLs, share URLs, query-driven actions and
  credentials;
- canonicalize to `https://x.com/<lowercase-handle>` without query or fragment.

The handle-in-profile-URL relationship and the character/length limits follow
X's public help documentation:
<https://help.x.com/en/managing-your-account/change-x-handle>.

### Telegram

- accept public username forms `t.me/<username>`,
  `<username>.t.me`, `telegram.me/<username>` and `telegram.dog/<username>`;
- reject phone links, invite links, private message links, bot actions and
  Telegram service routes;
- canonicalize to `https://t.me/<lowercase-username>` without query or
  fragment.

These forms follow Telegram's official link documentation:
<https://core.telegram.org/api/links>. Only public username destinations are
in scope even though Telegram supports many other deep-link forms.

## Domain contracts

### Links

`SocialLinkKind` is `WEBSITE | X | TELEGRAM`. A normalized link contains:

- deterministic `id` derived from mint, metadata snapshot and kind;
- mint and metadata snapshot ID;
- kind;
- SHA-256 of the declared value;
- canonical URL when syntax is valid;
- syntax status `VALID | INVALID`;
- optional typed invalid reason;
- observation timestamp.

The untrusted declared string is never persisted or returned by the API. For a
valid link, the canonical URL is the only retained URL. For an invalid link,
only its SHA-256 and typed reason remain, so an embedded credential or query
token cannot leak through storage, logs or API responses.

The metadata object persisted in `token_metadata_snapshots` is rebuilt after
link normalization: `websiteUrl`, `twitterUrl` and `telegramUrl` contain only
their canonical valid value or `null`. The provider's raw declared strings
exist only in memory until that rebuild and are then discarded.

Only one link per kind comes from the current normalized metadata schema. The
model remains a list so later providers can add verified alternatives without
changing API V1.

### Evidence

Stable evidence types are:

| Type | Meaning |
| --- | --- |
| `URL_SYNTAX_VALID` | The declared link has a supported canonical form. |
| `URL_SYNTAX_INVALID` | The declared value is not a supported link. |
| `URL_REACHABLE` | The final bounded HTTP response is 2xx. |
| `CROSS_LINK_CONFIRMED` | One observed public page contains the exact canonical target link. |
| `MINT_PUBLISHED` | The observed public content contains the exact launch mint. |
| `ACCOUNT_TOO_RECENT` | Reserved for a later authoritative provider; not inferred in this PR. |
| `DOMAIN_MISMATCH` | A website redirect crosses effective registrable domains. |
| `CONTENT_UNAVAILABLE` | Content could not be safely retrieved or inspected. |
| `VERIFICATION_UNKNOWN` | The requested claim cannot be established from available public facts. |

Every evidence item contains:

- deterministic ID;
- mint, collection ID and link ID when applicable;
- type and outcome `CONFIRMED | REJECTED | UNKNOWN`;
- subject kind and optional related kind;
- canonical subject URL or `null`;
- final canonical URL or `null`;
- HTTP status or `null`;
- redirect count;
- SHA-256 of the inspected decoded content or `null`;
- a bounded stable reason code;
- observation time.

It never contains an extracted page excerpt. HTTP status and redirect count are
ordinary bounded integers; no financial value is introduced.

Collection status is `COMPLETE | PARTIAL | FAILED`:

- `COMPLETE` means every declared link reached a permanent bounded observation;
- `PARTIAL` means at least one link exhausted a transient observation or its
  public content remained uninspectable;
- `FAILED` means metadata itself could not be resolved, so no declared social
  set could be established.

These statuses describe collection coverage, not project authenticity.

### Exact matches

The launch mint is matched case-sensitively as its exact Base58 string. A match
embedded inside a longer Base58 token is rejected. URL cross-links compare
canonical URLs, not loose substrings or display text.

Evidence is directional. Website-to-X and X-to-website confirmations are two
separate facts. The future `socialCrossLinkConfirmed` qualification signal may
be true only when the configured required directions are confirmed; this PR
does not change that policy.

If X or Telegram serves a login wall, JavaScript shell, robots denial, rate
limit, unsupported content type or otherwise unavailable body, the provider
records `CONTENT_UNAVAILABLE` and the relevant `VERIFICATION_UNKNOWN` facts.
It must not infer absence of the mint, account age, impersonation or missing
cross-links.

## Durable collection flow

```text
TokenLaunchDetected persisted
  -> upsert one social_enrichment_job from parameters.uri
  -> Solana transaction commits and continues
  -> social worker claims with SKIP LOCKED + lease
  -> resolve metadata JSON
  -> normalize website / X / Telegram links
  -> perform bounded public observations
  -> derive immutable evidence in memory
  -> transactionally persist metadata + collection + links + evidence
  -> write SocialEvidenceCollected + SSE outbox revision
  -> mark job COMPLETED
```

The metadata URI is copied from the immutable launch event payload, not parsed
again from a raw transaction. Missing or invalid URI is a permanent completed
result with a failed metadata snapshot and explicit unavailable evidence.

### Jobs and retries

Job states are `PENDING | PROCESSING | RETRYABLE_FAILED | COMPLETED | CANCELLED`.
Each job stores total attempts, attempts in the current cycle, immutable retry
policy, lease token/expiry, next attempt, typed error code and terminal/purge
timestamps. Defaults are configurable and bounded. Exponential backoff uses
integer milliseconds and a hard maximum. Retry exhaustion becomes a completed
unavailable collection rather than an infinite backlog.

Retryable failures are transport timeout, transient DNS failure, HTTP 408, 425,
429 and 5xx. Invalid URL, unsupported content, unsafe destination, permanent
4xx and bounded-content violations are permanent observations. A retry reruns
the whole immutable collection; partially derived facts are never published.

A lease-expired `PROCESSING` job can be reclaimed. Completion uses the lease
token and expected attempt count, so a stale worker cannot overwrite a newer
result. Replays return the existing collection when its immutable input
fingerprint matches and reject contradictory content.

## Finality and orphaning

The job and collection retain `source_launch_event_id` and the exact source
chain cursor. The social domain event references the same raw launch event and
inherits its signature, cursor, blockchain time and current confirmation
status.

When launch finality advances, every derived social event and projection is
advanced idempotently. When the launch becomes `orphaned`:

- unclaimed work is cancelled;
- in-flight completion is rejected after the launch row is locked and checked;
- completed collections remain retained only as orphaned audit data;
- the social domain event is revised to `orphaned` for SSE reconciliation;
- API current projections exclude the orphaned result;
- terminal and purge timestamps are set to four hours.

A recreated canonical launch can enqueue a new job tied to its new immutable
source event. Old orphaned evidence is never silently reactivated.

## Persistence

Migration `012_public_social_evidence.sql` adds:

- `social_enrichment_jobs` — durable claim, retry, lease and source identity;
- `social_evidence_collections` — immutable aggregate and coverage counts;
- `social_http_observations` — safe source facts (URL identity, HTTP outcome,
  redirect count and content hash), never response content;
- `social_links` — normalized declared links;
- `social_verification_evidence` — fact-level evidence without raw content.

`token_metadata_snapshots` remains the authority for normalized metadata. It
gains source-event identity and a uniqueness constraint suitable for durable
replay without rewriting historical snapshots.

All new tables reference `token_launches` with cascade deletion, use exact
checks for status enums and bounds, index claim/current/purge paths, and set
`purge_after = terminal_at + interval '4 hours'`. The migration must apply on
an empty database, migrate existing rows without fabricating evidence, and
replay cleanly.

Business links/evidence stay separate from `social_http_observations`. The
retained source observation is limited to URL identity, HTTP result, redirect
count and content hash; response content is never a database field. Evidence
rows reference the observation that supports them when one exists.

## Event contract

`SocialEvidenceCollected` payload version 1 contains only bounded aggregates:

- collection ID and metadata snapshot ID;
- link count;
- confirmed, rejected and unknown evidence counts;
- booleans for exact mint observed and bidirectional cross-link observed;
- collection status and input fingerprint.

Full links and evidence are read from the social API projection, not duplicated
into the event. A dedicated derived-event ID function hashes the source launch
identity plus the collection input fingerprint while preserving the source
signature and cursor in the public envelope. Replay of identical input produces
the same ID. Fetch time is excluded from identity: only a changed normalized
metadata/content fingerprint produces a new collection and event.

The event is inserted atomically with the collection and the existing API
event-stream trigger publishes its revision. Confirmation changes reuse the
same domain event ID and create resumable SSE revisions.

## Public API V1

`ApiSocial` becomes an additive discriminated union.

Before a canonical collection exists:

```json
{ "status": "NOT_AVAILABLE", "links": [], "evidence": [] }
```

After a completed canonical collection:

```json
{
  "status": "AVAILABLE",
  "collectionStatus": "COMPLETE",
  "collectionId": "social_collection_...",
  "metadataSnapshotId": "pumpfun_metadata_...",
  "observedAt": "2026-08-10T12:00:00.000Z",
  "links": [],
  "evidence": [],
  "coverage": {
    "declaredLinkCount": 0,
    "inspectedLinkCount": 0,
    "confirmedEvidenceCount": 0,
    "rejectedEvidenceCount": 0,
    "unknownEvidenceCount": 1
  }
}
```

Links and evidence use stable enums and bounded fields. Arrays are ordered by
link kind and evidence type/ID and have explicit total/truncated fields if the
stored count exceeds API limits. API code validates database rows fail-closed;
malformed persisted JSON becomes an internal dependency error, never a partial
fabricated response.

`AVAILABLE` is returned for all three collection statuses. A metadata failure
therefore exposes `collectionStatus: "FAILED"` with explicit evidence instead
of reverting to `NOT_AVAILABLE`. The latter means only that no canonical
collection has completed yet.

Launch detail embeds the same immutable social projection returned by the
dedicated route. Existing clients continue to handle `NOT_AVAILABLE`; the new
`AVAILABLE` branch is additive under the documented API V1 policy.

## Runtime composition and health

The production factory composes the enrichment repository, shared public HTTP
client, metadata provider, social provider and worker. Runtime startup starts
the social worker only after PostgreSQL and the initial Solana scan are ready.
Shutdown stops claims, waits within the existing bounded shutdown deadline and
releases no external credential because none exists.

Health adds an additive `pipeline.social` state and bounded backlog/lease/
exhausted counts. It exposes no URLs. A social outage degrades the social
pipeline but does not stop or relabel Pump.fun/PumpSwap chain ingestion. A
database outage retains the existing HTTP 503 behavior.

Configuration adds bounded non-secret values for timeout, response bytes,
redirects, concurrency, poll interval, lease duration, retry attempts and
backoff. There is no token, cookie, proxy credential or platform API key.

## Qualification boundary

The collection exposes a pure adapter that maps evidence to normalized
qualification observations. It may confirm only facts directly proven by the
collection. Unknown/unavailable evidence maps to `null`, not `false`.

The production qualification pipeline is not composed in this PR. The bundled
calibration remains `UNVALIDATED_RULE_SET`; social mismatch and impersonation
conditions remain `REPORT_ONLY`. No social result can open a paper position or
cancel an enforced on-chain blocker.

## Testing strategy

Implementation follows red-green-refactor. No unit test performs a real public
network request.

### Unit tests

- website, X and Telegram canonicalization and rejection tables;
- exact mint boundary matching and canonical cross-link matching;
- redirect-domain comparison with public suffixes;
- public/private IPv4 and IPv6 resolution, DNS rebinding and redirect hops;
- timeout, byte, content-type, UTF-8 and redirect limits;
- reachability, mismatch, unknown and unavailable evidence derivation;
- deterministic IDs, fingerprints, ordering, freezing and hostile-object
  boundaries;
- retry classification, exponential integer backoff and exhaustion;
- worker lease loss, cancellation and shutdown.

### PostgreSQL integration tests

- migration 001–012 on an empty schema and clean replay;
- atomic enqueue with launch creation;
- concurrent `SKIP LOCKED` claims and expired-lease recovery;
- atomic collection/event/job completion and rollback on every statement;
- exact idempotent replay and contradictory replay rejection;
- processed→confirmed→finalized and processed→orphaned reconciliation;
- API latest-canonical projection, deterministic ordering and four-hour purge;
- SSE insertion and finality revision without silent event loss.

### Composition and safety tests

- production observe/paper bootstrap contains no wallet, signer or execution
  dependency;
- Solana inbox processing completes without waiting for social HTTP;
- social failures degrade only `pipeline.social`;
- configuration rejects unsafe/unbounded values and redacts errors;
- API remains public read-only and no new mutation route appears;
- execution-boundary import graph remains unchanged.

## Acceptance criteria

- a Pump.fun creation with a metadata URI durably schedules enrichment without
  blocking its chain transaction;
- resolved metadata and public social facts survive restart and replay;
- initial creation URLs for website, X and Telegram are normalized and exposed;
- exact mint and cross-links are confirmed only from bounded observable public
  content;
- inaccessible or dynamic pages produce explicit unknown evidence;
- orphaned launches disappear from current social projections and emit an
  orphan reconciliation revision;
- no raw social content or secret is persisted or logged;
- terminal data is eligible for purge exactly four hours later;
- `npm install`, build, check, lint, docs check and the full PostgreSQL test
  suite pass;
- migrations apply and replay on a blank database;
- execution remains limited to `observe` and `paper`, with no real transaction
  path added.

## Documentation updates

The implementation updates:

- `README.md` with the real social capability and its limitations;
- `docs/architecture/pumpfun-v1.md` with the durable enrichment flow;
- `docs/api/v1.md` with the `AVAILABLE` social contract;
- `docs/system-overview.html` and its verifier;
- `.env.example` with safe non-secret social worker defaults.

The documentation must state that public metadata and social links are only
preparation/authenticity signals, not profit, sellability or legitimacy
guarantees.

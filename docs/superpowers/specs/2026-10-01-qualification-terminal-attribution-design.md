# Qualification terminal attribution — v1.0.0

Issue #205, capacity investigation #171. Recommended-choice approval applies.

## Evidence and scope

Canary `1bbf839` exported 181 qualification failures without diagnostic provenance
(149 first attempts, 28 second, 4 third). This does not prove serialization,
missing launches, or any other underlying cause. The repository intentionally
redacts underlying errors; preserve that boundary while retaining fixed labels.

Use the existing trusted terminal attribution mechanism. Do not introduce logs,
metrics, RPC calls, retries, schema fields, or a new diagnostic framework.
Alternative raw SQL/error logging risks disclosure; guessing retries masks the
cause. A shutdown-only summary would lose the existing attempt/context linkage.

## Closed diagnostic vocabulary

- QUALIFICATION_CONNECT_FAILED
- QUALIFICATION_POSTGRES_SERIALIZATION (40001 at actual query boundary only)
- QUALIFICATION_POSTGRES_DEADLOCK (40P01 at actual query boundary only)
- QUALIFICATION_DATA_INVALID
- QUALIFICATION_LAUNCH_MISSING
- QUALIFICATION_REBUILD_UNKNOWN
- QUALIFICATION_PERSISTENCE_UNKNOWN
- QUALIFICATION_CLEANUP_FAILED

All use causeKind=null and pumpWire=null, qualification stage and unchanged
origin/retryability. Do not register a pipeline origin: origins affect retries.
Unknown errors in callbacks must never be identified as SQL errors by inspecting
arbitrary `code` properties. SQLSTATE inspection occurs only on database query
rejections, rejects proxies/accessors, and cannot replace the original error.

## Attribution precedence and propagation

Retain diagnostic provenance through repository redaction and the existing
pipeline wrapper to the worker/export. If a primary failure exists, it wins over
cleanup failures; cleanup-only failure receives CLEANUP_FAILED. A more specific
trusted label wins over a generic boundary fallback. Registration failures must
not affect business behavior. Missing canonical launch is labeled where created;
rebuild unknown is labeled only around the synchronous rebuilder invocation.
Connection and persistence unknown refer to their actual repository boundaries.
Data-invalid labels cover existing typed invalid-data outcomes without exposing
their messages or changing error class, identity guarantees, or cause redaction.

## Persistence and compatibility

Add migration 059 extending only the attribution diagnostic allowlists and their
stage compatibility constraints. Never edit migrations 057/058. Preserve old
rows and all old allowed combinations; reject unknown codes and wrong stages.
Verify empty database, upgrade from 058 with existing evidence, and replay/drift
behavior using established migration conventions. Artifact version remains v1:
closed enum addition only, no shape changes. Update relevant validators/tests.

## Invariants and tests

No changes to retries, failure aggregation count/order, advisory locks, transaction
isolation, rollback/unlock/release, finality, gates, decoding, retention, or quote
allowlist. Existing public error messages remain redacted. No wallet or signing.

Inject failures through real repository/service methods: connect, query40001,
query40P01, unknown query, malformed canonical data, missing launch, rebuilder,
rollback/unlock/release, primary plus cleanup, hostile code getter/proxy, and
callback spoofed SQLSTATE. Assert exact fixed attribution plus unchanged outcome.
Test pipeline/worker/export propagation, runtime enum validation, migration
roundtrip and existing tests. Two review cycles maximum, full CI before merge.

# Complete-block payload measurement — v1.0.0

## Scope and authority

Capacity investigation for #171/#120, after #209/#210 at `1d836d9`.
This is an evidence-gathering experiment, not a production codec change or a
new collector service. Standing user direction selects recommended technical
options without an additional approval round. No transaction, wallet, signer,
database, listener process or dependency upgrade belongs to this experiment.
Wait for the #210 post-merge CI to pass before any Mainnet request.

The last canary reported 746 oversize bypasses in 1,007 fetches at T+15. These
are physical fetch counts, not distinct blocks or their size distribution.
The existing representation is 64 bytes per block plus signature UTF-8 length,
base64 V8 normalized payload length and 32 bytes per transaction. Its accounting
is not a measurement of provider wire bytes, heap or RSS.

## Alternatives and decision

1. Recommended: capture at most three complete, finalized historical blocks,
   then compare representations offline using the existing normalization path.
2. Partial transaction fixtures alone are cheaper, but omit logs/keys/balances
   and cannot establish real-block size or production performance.
3. Another fifteen-minute canary now would combine admission, representation,
   decoder and measurement issues before the payload hypothesis is measured.

No compression format is selected for production by this document. Compare the
current representation with per-transaction raw-deflate level 1 plus base64 as a
lossless candidate; retain original payloads when compression would increase size.
Do not remove any normalized field or enlarge cache/RPC/worker limits.

## Bounded capture

Use the existing installed Solana Connection client and a guarded HTTP fetch
wrapper, so transaction versions and messages are transformed as in production.
Allow only one `getGenesisHash` and one finalized full `getBlock` per fixed slot:
452406477, 452406478 and 452406531. Two slots come from existing finalized
decoder evidence; the preceding slot broadens this small sample without scanning.
No substitution, retries, WebSocket subscription or extra discovery calls.
At most four physical RPC requests, one at a time, at least one second apart.
Reject a genesis other than the canonical Mainnet genesis before block requests.
Use `maxSupportedTransactionVersion=1`, `transactionDetails=full`, `rewards=false`.

Read the already-authorized RPC setting privately; keep credentials only in
memory and never print or persist the endpoint, headers or upstream error body.
Reuse the previously approved Helius devnet-to-mainnet hostname mapping only;
reject unsupported source hosts/protocols. Disable Connection rate-limit retries.
Every response is bounded to 32 MiB and 30 seconds including body consumption.
Reject redirects, non-success HTTP/RPC results, malformed responses and null blocks
with fixed redacted error codes. Stop the experiment on the first failure/429;
never expand the request budget to replace a missing sample.

Store complete public RPC responses and a manifest outside Git in a fresh 0700
directory, files 0600, at most 96 MiB of raw block JSON. Preserve exact bytes and
SHA-256 provenance. No secret or environment snapshot is stored. Retain useful
evidence during investigation; once no longer needed, purge after four hours per
the user retention rule. Check disk before capture and each block: at <=5 GB free,
suspend writes and apply the existing safe-cleanup protocol before resuming.

## Offline comparison and validity

Feed captured responses through the same Connection conversion (offline fetch)
and `snapshotBlockTransactionData`, not a replacement normalization schema.
For each block report raw bytes, transaction count, version distribution,
cacheable/duplicate/malformed outcome, existing retained bytes, candidate bytes,
largest transaction payload, and normalization/codec elapsed time. Compare exact
normalized values after decompression/deserialization, including bigint and
instruction byte arrays; reject any mismatch. Report compression round-trip
time separately from the baseline. Record Node/V8/platform, per-block process
RSS/heap and measured peak RSS; sampled endpoints alone are not a peak guarantee.

Run blocks sequentially and release intermediate graphs between blocks. A
compressed retained cap does not bound expansion or transient memory; any later
codec design must explicitly bound decoded lengths and test corruption, expansion,
immutability, generation/epoch/close, single-flight and exact 8/64 MiB boundaries.
Local Node 25 measurements are exploratory, not production Node 22 evidence.
If a production-runtime comparison cannot be made, report that limitation rather
than claiming production latency/RSS. Three historical blocks cannot establish a
population distribution, sustained capacity, or a future canary PASS.

## Acceptance and next decision

Before network access, test the request budget, genesis gate, no-retry behavior,
response cap/timeout, fixed errors and offline replay using fake fetches. No
production code is modified. Commit this design before the one-off harness.
Record exact successes/failures and measured values; do not extrapolate the
earlier 75.4% savings from partial fixtures to full blocks. Decide on a narrowly
scoped codec implementation only after these results, in a separate versioned
design amendment. All canary gates, including genuine oversize, remain unchanged.

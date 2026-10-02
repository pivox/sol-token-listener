# Complete-block payload measurement results — v1.0.0

## Provenance and scope

Investigation for #171/#120 following #210, production tree `1d836d9`.
Protocol: [measurement design v1.0.1](2026-10-02-block-payload-measurement-design.md).
Capture began 2026-10-02T01:43:40.372Z, after post-merge CI run
`36950821058` completed successfully. Four physical requests succeeded:
canonical Mainnet genesis, then exactly three fixed finalized full blocks.
No retries, replacement samples, wallet, database, listener or transaction.

The outside-Git harness passed 41 offline tests, zero failures/skips, and syntax
checks. Parent inspected the harness and repeated verification before capture.
Capture permissions were verified: directory 0700, files 0600. Analysis checked
raw lengths and SHA-256 hashes before parsing. Raw blocks total 22,009,331 bytes.
Provider credentials and error bodies were not printed or persisted.

| Slot | Raw response bytes | SHA-256 |
| --- | ---: | --- |
| 452406477 | 7,666,794 | `007c098bcff0f8ed2f029cfb92901c785d760d0a251eb362c4fdc8d7132f5e01` |
| 452406478 | 7,164,386 | `2a6efb3b15214393a078c152cdff3376e92360994359167160f1c776e6328327` |
| 452406531 | 7,178,151 | `f02dd370718a6bd7e255ec535f4b9eba7e638d2224a47a2ccab7ae69d95a7a5d` |

## Representation result under production Node

Offline replay used the installed Connection conversion and the unchanged
`snapshotBlockTransactionData` implementation. Candidate encoding is independent
raw-deflate level 1 per transaction plus base64, retaining original text if
compression would enlarge it. Each candidate was inflated with an original-size
output bound, compared byte-for-byte, then deserialized and deep-compared.

| Slot | Transactions (legacy / v0 / v1) | Current retained bytes | Candidate retained bytes | Largest original V8 payload bytes |
| --- | --- | ---: | ---: | ---: |
| 452406477 | 1,332 (729 / 323 / 280) | 12,639,405 | 3,620,321 | 34,189 |
| 452406478 | 1,443 (813 / 343 / 287) | 11,726,491 | 3,490,867 | 33,276 |
| 452406531 | 1,445 (850 / 252 / 343) | 12,005,258 | 3,629,118 | 46,924 |

All 4,220 transactions passed exact round-trip checks. All blocks were cacheable
apart from size: no duplicate signature, invalid block or malformed payload.
Every payload shrank; fallback was exercised by an incompressible offline test,
not by these samples. Each current representation exceeds 8,388,608 bytes; each
candidate is below that unchanged entry limit. The global limit remains
67,108,864 bytes. Candidate accounting includes existing signature/entry overhead,
but **excludes undecided future codec-format overhead**.

## Runtime and memory observations

Production-runtime comparison used Node 22.22.0 / V8 12.4.254.21-node.33,
Linux arm64, exact Dockerfile image digest
`sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94`.
One ephemeral container: network disabled, read-only filesystem/mounts, one CPU,
768 MiB memory, swap disabled, capabilities dropped. Only the isolated worktree,
harness and public captures were mounted; no root environment, wallet, common
Git directory or Docker socket. Exit status 0; container removed automatically.

| Slot | Offline conversion ms | Normalization ms | Compression ms | Inflation ms | Codec round-trip ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 452406477 | 748.77 | 290.21 | 99.14 | 19.15 | 145.43 |
| 452406478 | 648.08 | 266.11 | 51.47 | 15.66 | 90.15 |
| 452406531 | 621.75 | 304.08 | 62.82 | 15.60 | 100.41 |

Single sequential run; no explicit GC. Conversion includes offline JSON envelope
rebinding, parsing and Connection conversion, not provider latency. Round-trip
includes compression, inflation, deserialization and assertions. These are not
steady-state latency percentiles or isolated CPU benchmarks.

Process-lifetime peak RSS was 231,272,448 bytes (Node resourceUsage maxRSS KiB
converted to bytes). This is the measurement process, **not listener RSS**, not
container-wide memory, and not an estimate of decoded memory from retained bytes.
The earlier exploratory Node 25.9.0/macOS arm64 run reached 519,815,168 bytes and
candidate sizes 3,624,961 / 3,495,675 / 3,633,586 bytes. Different runtime/platform
results are not a controlled comparison; compression bytes may differ by runtime.

## Decision and remaining proof

The complete-block evidence supports designing a lossless per-transaction codec.
It does not yet justify shipping one. Before production code, version a design
covering exact format overhead/accounting, decoded-length bounds, corruption,
immutability, oversized bypass, one-transaction decode rather than whole-block
expansion, cache lifecycle/epoch/close and existing single-flight/admission rules.
Do not increase cache limits, workers, request rate or relax any canary gate.

Three selected historical blocks do not establish a population distribution,
sustained throughput or a canary PASS. Synchronous compression can delay the event
loop; representative stress tests and the full 15-minute canary remain required.
Measurement-clock/cohort issues and current Pump instruction suffix evidence are
separate unresolved items. H2e, H2c and explicit transaction authorization remain
required; this experiment does not validate a first trade.

Raw captures and full aggregate reports remain outside Git, located by the local
tracking file. Preserve them while useful; once unneeded, apply the user's
four-hour retention rule. Disk was approximately 10.97 GB free after measurement;
the <=5 GB pause/safe-cleanup guard remains in effect.

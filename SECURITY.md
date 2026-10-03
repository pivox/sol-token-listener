# Security policy

## Reporting

Report suspected vulnerabilities through a private GitHub security advisory.
Do not publish secrets, private keys, RPC credentials or database URLs in a
public issue.

## Runtime boundary

The listener's default `EXECUTION_MODE=observe` and paper path do not load a
wallet, sign or submit a Solana transaction. A separately isolated live executor
exists in this repository; its presence does not make listener observation a
live mode. Real-wallet use requires the operator-only readiness, risk and
arming gates documented in the canary runbook. This policy is not an approval
to arm or submit a transaction.

## Audit interpretation

The npm audit report propagates each leaf advisory through every affected
parent package. The count of affected package records is therefore not the
count of independent vulnerabilities. On 2026-10-03,
`npm audit --omit=dev --json` on `main@2346f0d` reported 15 affected
production records: eight high and seven moderate. They trace to five
independent leaf advisories across
`bigint-buffer`, `uuid`, `stream-json` and two `toml` findings. This is not an
audit-clean result; a package-level severity is not by itself a demonstrated
reachable exploit in this application.

The unused `@raydium-io/raydium-sdk-v2` direct dependency was removed while the
repository's Raydium CPMM adapter remains. Compatible maintenance releases for
PostgreSQL and TypeScript tooling were applied independently. The compatible
development-only fixes for `brace-expansion` and `js-yaml` were applied within
their parent ranges, without an override, and the declared and CI-tested Node
floor was corrected from 22.12.0 to 22.13.0. None of these changes remediates
the current production leaf advisories.

## Tracked upstream advisories

Last reviewed: 2026-10-03. Review again before any real-wallet use, no later
than 2026-10-17, or sooner when a dependency below publishes a new release.

| Advisory | Dependency path | Status |
| --- | --- | --- |
| [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) | `@solana/spl-token` → `@solana/buffer-layout-utils` → `bigint-buffer@1.1.5` | No patched upstream release exists. Do not replace it with an unreviewed fork. |
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | `@solana/web3.js@1.99.0` → `jayson@4.3.0` → `uuid@8.3.2` | `jayson` uses UUID v4, while the advisory affects destination buffers in UUID v3/v5/v6. A forced incompatible override is not accepted. |
| [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x) | `@solana/web3.js@1.99.0` → `jayson@4.3.0` → `stream-json@1.9.1` | The advisory concerns selected depth-sensitive filters; Web3.js imports Jayson's browser client, which parses responses with native `JSON.parse`, not these filters. Jayson 5 removes this dependency but is outside Web3.js's declared range. This is source-level reachability evidence, not a proof of no risk. |
| [GHSA-v5mp-jgw5-2x6j](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j) | Direct `@pump-fun/pump-sdk@1.36.0` **and** direct `@pump-fun/pump-swap-sdk@1.19.0` each retain `@coral-xyz/anchor@0.31.1` → `toml@3.0.0` | Prototype-pollution fix requires `toml@4.1.2`, outside Anchor's declared `^3.0.0`. The identified parse sink reads local `Anchor.toml` through Anchor workspace access; no application call or untrusted-input route was found. |
| [GHSA-82x6-q7mm-w9cf](https://github.com/advisories/GHSA-82x6-q7mm-w9cf) | Both direct Pump SDK/PumpSwap paths above → Anchor/TOML | Recursion fix requires `toml@4.2.0`, likewise outside Anchor's range. Keep runtime workspace/config files operator-controlled; do not claim an upstream-compatible fix exists. |

This review inspected the installed import/call paths and found no demonstrated
route from RPC results, token metadata or executor intent data to Anchor's
workspace TOML parser or the affected `stream-json` filters. It did not prove
all future SDK paths unreachable. The `bigint-buffer` advisory remains a
separate potential denial-of-service concern around decoded byte input; its
runtime exploitability was not resolved by this review. Re-evaluate these
limits against the exact lockfile and deployed configuration before the
first real-wallet canary.

These alerts are reassessed whenever Pump.fun, SPL Token, Web3.js or their
transitive dependencies are upgraded, or when an upstream patched release
becomes available. npm currently proposes incompatible historical downgrades
of the official SDK and Solana packages. `npm audit fix --force`, npm
`overrides`, incompatible downgrades, and unreviewed forks are not approved
remediations. The first real-wallet canary additionally requires an explicit
operator decision on the remaining production risks; this document alone is
not that decision.

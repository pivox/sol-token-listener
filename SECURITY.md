# Security policy

## Reporting

Report suspected vulnerabilities through a private GitHub security advisory.
Do not publish secrets, private keys, RPC credentials or database URLs in a
public issue.

## Runtime boundary

Pump.fun V1 supports observation and paper trading only. It has no wallet,
signing or Solana transaction-submission path.

## Audit interpretation

The npm audit report propagates each leaf advisory through every affected
parent package. The count of affected package records is therefore not the
count of independent vulnerabilities. On 2026-08-11, both `npm audit --json`
and `npm audit --omit=dev --json` contained 13 affected records: six high and
seven moderate. Those records trace back to the two independent production
leaf advisories below, in `bigint-buffer@1.1.5` and `uuid@8.3.2` through
`jayson@4.3.0`. This is not an audit-clean result.

The unused `@raydium-io/raydium-sdk-v2` direct dependency was removed while the
repository's Raydium CPMM adapter remains. Compatible maintenance releases for
PostgreSQL and TypeScript tooling were applied independently. The compatible
development-only fixes for `brace-expansion` and `js-yaml` were applied within
their parent ranges, without an override, and the declared and CI-tested Node
floor was corrected from 22.12.0 to 22.13.0. None of these changes remediates
the two production leaf advisories.

## Tracked upstream advisories

Last reviewed: 2026-08-11. Review again no later than 2026-09-11, or sooner
when any dependency in the paths below publishes a new release.

| Advisory | Dependency path | Status |
| --- | --- | --- |
| [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) | `@solana/spl-token` → `@solana/buffer-layout-utils` → `bigint-buffer@1.1.5` | No patched upstream release exists. Do not replace it with an unreviewed fork. |
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | `@solana/web3.js@1.98.4` → `jayson@4.3.0` → `uuid@8.3.2` | `jayson` uses UUID v4, while the advisory affects destination buffers in UUID v3/v5/v6. A forced incompatible override is not accepted. |

These alerts are reassessed whenever Pump.fun, SPL Token, Web3.js or their
transitive dependencies are upgraded, or when an upstream patched release
becomes available. npm currently proposes incompatible historical downgrades
of the official SDK and Solana packages. `npm audit fix --force`, npm
`overrides`, incompatible downgrades, and unreviewed forks are not approved
remediations.

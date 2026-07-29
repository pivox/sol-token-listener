# Security policy

## Reporting

Report suspected vulnerabilities through a private GitHub security advisory.
Do not publish secrets, private keys, RPC credentials or database URLs in a
public issue.

## Runtime boundary

Pump.fun V1 supports observation and paper trading only. It has no wallet,
signing or Solana transaction-submission path.

## Tracked upstream advisories

Last reviewed: 2026-07-29. Review again no later than 2026-08-29, or sooner
when any dependency in the paths below publishes a new release.

| Advisory | Dependency path | Status |
| --- | --- | --- |
| [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) | `@solana/spl-token` → `@solana/buffer-layout-utils` → `bigint-buffer@1.1.5` | No patched upstream release exists. Do not replace it with an unreviewed fork. |
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | `@solana/web3.js@1.98.4` → `jayson@4.3.0` → `uuid@8.3.2` | `jayson` uses UUID v4, while the advisory affects destination buffers in UUID v3/v5/v6. A forced incompatible override is not accepted. |

These alerts are reassessed whenever Pump.fun, Raydium, SPL Token, Web3.js or
their transitive dependencies are upgraded, or when an upstream patched
release becomes available. `npm audit --force` is not an approved remediation
because it currently proposes incompatible package downgrades.

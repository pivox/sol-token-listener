# Safe dependency security update

Date: 2026-07-29

## Context

The production dependency audit reports three underlying advisories:

- `bn.js` versions from `5.0.0` through `5.2.2` can enter an infinite loop;
- `bigint-buffer` through its latest release `1.1.5` can crash while converting
  an oversized value;
- `uuid` before `11.1.1` has an insufficient destination-buffer bound check in
  selected UUID variants.

The installed `bn.js@5.2.2` has a compatible patched release. The other two
alerts are upstream constraints:

- `@solana/buffer-layout-utils@0.3.0` requires `bigint-buffer@^1.1.5`, for
  which no patched release exists;
- `@solana/web3.js@1.98.4` requires `jayson@4.3.0`, which in turn requires
  `uuid@^8.3.2`. The current Solana, Pump.fun and Raydium SDK graph is based on
  Web3.js v1.

`npm audit --force` proposes incompatible downgrades rather than a safe fix.

## Decision

Apply only the compatible remediation:

1. pin the direct `bn.js` dependency to `5.2.5`;
2. regenerate `package-lock.json` without force or dependency overrides;
3. add a dependency contract test that rejects every locked `bn.js` release
   below the patched `5.2.3` boundary;
4. add `SECURITY.md` describing the remaining upstream advisories, their
   dependency paths, the absence of a patched compatible release, and the
   conditions that trigger reassessment.

The repository must not claim that `npm audit` is clean while upstream alerts
remain.

## Rejected alternatives

### Force `uuid@11`

An npm override would violate `jayson`'s declared `uuid@^8.3.2` contract.
Runtime compatibility is not an adequate substitute for an upstream-supported
dependency graph.

### Patch or fork `bigint-buffer`

Maintaining a private cryptographic/binary dependency fork would introduce a
larger security and supply-chain obligation than this repository can justify.

### Migrate to Solana Web3.js v2

This is a separate architectural migration affecting the official Pump.fun
SDK, Raydium adapter, transaction normalization and fixtures. It cannot be
treated as an audit-only patch.

## Verification

The change follows a red-green dependency contract:

1. add the lockfile test and confirm it fails against `bn.js@5.2.2`;
2. update the dependency and lockfile;
3. confirm the contract passes and `npm ls bn.js` resolves no vulnerable v5
   copy;
4. run build, generated-code checks, lint and the full test suite, including
   the PostgreSQL migration test when the local test database is available;
5. run `npm audit --omit=dev` and record the exact remaining upstream alerts.

## Acceptance criteria

- every installed `bn.js` v5 copy is at least `5.2.3`;
- no npm override, forced install or Solana SDK downgrade is introduced;
- existing Pump.fun, PumpSwap and Raydium tests do not regress;
- the remaining audit output is documented honestly;
- the update is delivered in a separate reviewable pull request.

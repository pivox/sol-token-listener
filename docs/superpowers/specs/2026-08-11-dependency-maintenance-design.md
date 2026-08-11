# Bounded dependency maintenance design

## 1. Context

The repository now contains a Node.js backend and a frontend workspace under one
version 3 npm lockfile. A clean install on Node 22 or newer currently reports 16
affected package records: nine high and seven moderate. Production-only audit
output reports 14 affected records, but those records propagate from two known
leaf advisories in the Solana Web3.js v1 dependency graph:

- `bigint-buffer@1.1.5`, reached through SPL Token;
- `uuid@8.3.2`, reached through `jayson@4.3.0` and Web3.js v1.

The npm automatic fixes propose incompatible SDK downgrades. They are not valid
remediations for a listener whose Pump.fun and PumpSwap decoding and quoting
depend on the current official SDK contracts.

The audit also found one direct production dependency,
`@raydium-io/raydium-sdk-v2`, with no import in source, tests, scripts, or the
retained Raydium CPMM adapter. Removing this unused package does not remove or
alter the adapter.

Issue #43 is the eighth of the nine persisted delivery slices. Deployment
artifacts remain exclusively in slice nine.

## 2. Decision

Use a bounded maintenance change instead of a Solana dependency migration.
The pull request will:

1. remove the unused Raydium SDK package while retaining every Raydium adapter
   source file and test;
2. update only compatible maintenance dependencies with published patch or
   minor releases:
   - `pg` from `8.22.0` to `8.23.0`;
   - `tsx` from `4.23.1` to `4.23.12`;
   - `@types/pg` from `8.15.0` to `8.21.0`;
   - `@types/bn.js` from `5.1.6` to `5.2.0`;
   - root and frontend `typescript-eslint` from `8.65.0` to `8.67.0`;
3. leave Pump.fun, PumpSwap, SPL Token, Web3.js, TypeScript, ESLint, Node types,
   IDLs, and runtime application behavior unchanged;
4. strengthen dependency contract tests for manifest/lock agreement, forbidden
   overrides, exact high-impact SDK pins, the absent unused Raydium SDK, and the
   official SDK bridge export shapes;
5. update `SECURITY.md` with the current audit date, distinction between leaf
   causes and propagated package records, and explicit deferred decisions.

No `npm audit fix`, `--force`, override, fork, downgrade, or broad update command
is permitted. The lockfile must be regenerated only by targeted npm commands.

## 3. Dependency boundaries

The official Pump packages remain behind their existing `createRequire`
bridges:

- `src/launchpads/pumpfun/official-sdk.ts`;
- `src/markets/pumpswap/official-sdk.ts`.

Their package metadata still exposes an ambiguous ESM import condition on
supported Node versions. Direct named ESM imports are therefore forbidden until
upstream packaging changes and a separate compatibility review proves the new
path.

The following production pins remain exact:

- `@pump-fun/pump-sdk@1.36.0`;
- `@pump-fun/pump-swap-sdk@1.19.0`;
- `@solana/spl-token@0.4.15`;
- `@solana/web3.js@1.98.4`;
- `bn.js@5.2.5`;
- `parse5@8.0.1`;
- `tldts@7.4.10`.

The frontend remains free of Solana, wallet, signing, and transaction-submission
dependencies. The backend remains observe/paper only.

## 4. Security evidence and residual risk

`SECURITY.md` must report both audit views without claiming that the repository
is vulnerability-free:

- full workspace: 16 propagated records at the start of the change;
- production-only: 14 propagated records at the start of the change;
- two underlying unresolved leaf advisories.

After removing the unused Raydium SDK and regenerating the lockfile, the exact
counts must be measured again and recorded from fresh output. Counts are
evidence, not a test invariant, because the npm advisory service can change
without a repository commit.

The Web3.js v1/SPL/Pump dependency graph is accepted temporarily because no
compatible patched upstream path is available. A migration to another Solana
stack requires its own architecture slice, official SDK compatibility proof,
IDL regeneration checks, normalized fixture replay, and mainnet validation.

## 5. Tests

The dependency contract will use the checked-in manifest and lockfile as data.
It will verify:

- lockfile version 3 and root workspace pin agreement;
- absence of root `overrides`;
- absence of `@raydium-io/raydium-sdk-v2` from the direct manifest and lock;
- exact Pump, PumpSwap, SPL Token, Web3.js, `bn.js`, `parse5`, and `tldts`
  versions;
- every locked `bn.js` v5 copy contains the infinite-loop fix;
- required Pump and PumpSwap bridge exports load as the expected runtime types.

Existing Raydium CPMM tests remain mandatory. Generated Pump.fun and PumpSwap
IDL checks must remain byte-for-byte clean.

Validation includes:

```text
npm ci
npm run build
npm run check
npm run lint
npm test
npm run docs:check
npm run frontend:e2e
```

The backend suite must also run against an empty real PostgreSQL database so all
migrations and gated integration tests execute without skips.

## 6. Explicitly deferred work

The following belongs to the ninth slice and must not enter this pull request:

- Docker images, Compose or orchestrator manifests;
- database provisioning, backup, restore, migration jobs, or rollback policy;
- ingress, TLS, CORS deployment policy, SSE proxy configuration, or readiness;
- frontend runtime configuration injection and static hosting;
- mainnet RPC selection and production dry-run operation.

Major updates to TypeScript, ESLint, Node type definitions, Solana Web3.js, SPL
Token, Pump SDKs, or their transitive graph are also deferred.

## 7. Acceptance criteria

- A clean install is reproducible from the single workspace lockfile.
- Only the dependency versions listed in this design change.
- The unused Raydium SDK is absent, while the Raydium CPMM adapter and tests are
  unchanged and operational.
- Official Pump SDK bridges work on the supported Node baseline.
- No override, forced fix, incompatible downgrade, wallet, signer, transaction
  submission, or live execution path is introduced.
- Residual advisories and deferred decisions are documented accurately.
- Build, check, lint, documentation, unit, PostgreSQL integration, migration,
  and browser tests pass.
- GitHub review is limited to three correction/review cycles.

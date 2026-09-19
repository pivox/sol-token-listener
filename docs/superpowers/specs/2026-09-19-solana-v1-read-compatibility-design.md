# Solana V1 Read Compatibility Design

Version: 1.0.0 — 2026-09-19 — issue #139.

## Goal and status

Restore the observe-only Pump.fun listener on Mainnet blocks that contain Solana
transaction version 1. The change affects read and reconciliation paths only. It
does not construct, sign or submit a transaction, load a wallet, enable an
executor, or change the `observe`/`paper` execution-mode contract.

The post-#138 canary reproduced the failure on a public Mainnet block. The RPC
returned JSON-RPC error `-32015` when the client requested maximum version `0`.
Requesting maximum version `1` made the RPC return the block, after which the
installed `@solana/web3.js` 1.98.4 rejected `transactions[*].version = 1` in its
response validator. This is a protocol-compatibility failure, not a provider
affinity, cache pacing, admission or wallet failure.

## Decision

Upgrade the official `@solana/web3.js` dependency from 1.98.4 to 1.99.0 and use
one exported read-compatibility constant with value `1` at every existing
transaction-returning RPC boundary.

This is preferred over two alternatives:

- adding `@solana/kit` only for block hydration would introduce a second RPC and
  transaction representation into the current listener;
- parsing raw JSON-RPC responses locally would duplicate the official SDK's v1
  validation and increase the trusted parsing surface.

Version 1.99.0 is intentionally a read-only bridge for this project. No code in
this change constructs or sends a v1 transaction. A future migration of live
transaction construction to Kit remains a separate decision.

## Compatibility boundary

Create `src/solana/rpc/transaction-version.ts` with the canonical exported
literal:

```ts
export const MAX_SUPPORTED_TRANSACTION_VERSION = 1 as const;
```

Use it in all current transaction-returning read paths:

- `TransactionFetcher.getTransaction`;
- `SolanaRpcClient.getTransaction`;
- `SolanaRpcClient.getBlockTransactions`;
- provider-pinned block hydration `Connection.getBlock`;
- executor recovery's finalized `getTransaction` request.

The provider-pinned block interface must accept the numeric literal `1`. Its
deadline, combined abort signal, fixed provider ID, redacted errors and cache
contract remain unchanged. Transaction submission configuration is untouched.

## Normalization

The official SDK remains responsible for decoding legacy, v0 and v1 messages.
The existing normalization boundary continues to emit the source transaction
version as `"legacy" | number`, account keys, signers, compiled outer and inner
instructions, token balances, lamport balances, fees, logs and errors.

Tests must prove that the upgraded SDK can read the v1 block shape that 1.98.4
rejected and that the normalized cursor and deterministic event inputs remain
unchanged for existing legacy/v0 fixtures. Unsupported future transaction
versions remain fail-closed at the SDK/RPC boundary.

## Errors and observability

This PR does not broaden public errors. Provider-pinned read failures remain the
fixed `BLOCK_UNAVAILABLE` category and worker reads remain fixed retryable
locator failures. URLs, API keys, block bodies and signatures are not logged.

The canary evidence must record only the public slot, response status/category,
accepted transaction versions and aggregate transaction count. The separate
known gap for exhaustive HTTP 429 and first-processing latency metrics is not
mixed into this compatibility PR.

## Tests

TDD coverage must include:

- every existing RPC mock now receives `maxSupportedTransactionVersion: 1`;
- the provider-pinned adapter preserves confirmed/finalized mapping,
  cancellation and deadlines while requesting version 1;
- `TransactionFetcher` requests version 1;
- executor recovery requests version 1 without changing signing/submission;
- the upgraded SDK accepts a sanitized v1 RPC response or an equivalent
  official v1 read fixture;
- legacy and v0 normalization regressions remain green;
- dependency lockfile contains the exact approved SDK version.

Verification is proportional to the shared dependency blast radius:

```bash
npm run build
npm run check
npm run lint
npm run docs:check
TEST_DATABASE_URL=postgresql://... npm test
```

After merge and green post-merge CI, a fresh observe-only database replays the
Mainnet canary. No H2e, H2c, wallet preparation, funding, armament or real order
is allowed before that canary passes.

## Acceptance

- the reproduced Mainnet v1 block is readable through the production
  provider-pinned adapter;
- catch-up hydration no longer fails solely because a block contains v1;
- all read boundaries advertise maximum version 1 consistently;
- no write/sign/send behavior changes;
- all automated gates pass and the dry-run remains a separate post-merge
  operation.

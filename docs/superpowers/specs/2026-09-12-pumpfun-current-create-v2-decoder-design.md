# Current Pump.fun `create_v2` decoder design

## Status and scope

Specification version: `pumpfun-current-create-v2-decoder.v1`.

This change updates only the observe-side Pump.fun decoder. It adds no wallet,
signing, transaction submission, paper-entry, or live-execution capability.
Legacy `create` remains supported. Persistence and quarantine changes that
would require a database migration are deferred to a separate follow-up.

## Schema authority

The decoder is generated from the official
`pump-fun/pump-public-docs` repository at immutable revision
`f216b6724c6ede79d7cef9ce210b741f7e17e93b`. The vendored `idl/pump.json`
must have SHA-256
`ffe966c42f1af41652ee753fe2f1e3f7cd4077d7e6f49faf3138959c8b56064b`.
PumpSwap remains pinned independently to its already audited revision; the
manifest records an immutable revision per artifact instead of implying that
both snapshots came from the same upstream commit.

## Exact `create_v2` data contract

The five required arguments are decoded first: `name`, `symbol`, `uri`,
`creator`, and `is_mayhem_mode`. Only these exact optional suffix sizes are
accepted:

| Suffix bytes | Meaning |
| ---: | --- |
| 0 | cashback `false`, creator fee `0`, holder reward `false` |
| 1 | `is_cashback_enabled` |
| 9 | cashback plus `creator_fee_bps: u64` |
| 10 | cashback, creator fee, and `is_holder_reward` |

Every other size fails with `PUMP_BORSH_INVALID`; bytes are never accepted as
an unknown generic extension. Financial values remain `bigint`.

`create_v2` accepts exactly 0, 3, or 4 remaining accounts. The first three are
the quote mint, quote bonding-curve token account, and quote token program. A
fourth account is accepted only when it equals the Pump PDA derived from the
single seed `quote-control`. Partial and extra layouts fail closed.

## Creation evidence

`CreateEvent` has a historical base followed by the official append-only
`creator_fee_bps: u64` and `is_holder_reward: bool` fields. Exact suffix sizes
0, 8, and 9 decode respectively to defaults, creator fee only, and both
fields. Other suffix sizes fail closed. The decoded creation keeps
`requestedCreator` (instruction argument) distinct from `effectiveCreator`
(event fee-routing creator). Equality is required for regular coins and is
not required for holder-reward coins.

The launch projection retains `creator` as the effective fee-routing creator
for database compatibility and records the requested creator, effective
creator, creator-fee basis points, and holder-reward flag in immutable launch
parameters.

## Evidence and tests

Sanitized finalized Mainnet fixtures use the existing
`solana-mainnet-fixture.v1` contract. They cover a current creation followed by
its initial buy and a four-remaining-account quote-control creation. Unit tests
cover every accepted suffix and remaining-account count, the derived PDA,
legacy `create`, creator semantics, and strict rejection of unknown bytes or
accounts. All tests are offline and contain public chain data only.

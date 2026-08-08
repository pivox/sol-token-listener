# Current mainnet decoder evidence design

## Purpose

Issue #31 closes the evidence gap around the Pump.fun and PumpSwap decoders.
The implementation already pins official IDLs and has three Pump.fun mainnet
fixtures, but it has no machine-readable upstream attestation, no versioned
sanitization contract, and no committed PumpSwap mainnet transaction.

This PR changes evidence and tooling only. Decoder behavior remains unchanged
unless an official or finalized-mainnet fixture proves a narrowly scoped bug.

## Authoritative source

The sole schema authority is
`pump-fun/pump-public-docs@9c82f61cb711b044a17f770ab8ce9f9bdf78f333`.
That revision was verified as the repository `main` HEAD on 2026-08-08. The
committed `pump.json` and `pump_amm.json` bytes remain checksum-pinned; no
discriminator, account layout, instruction or event definition comes from a
third-party project.

A machine-readable manifest beside the snapshots records:

- schema version;
- official repository and immutable revision URL;
- verification date;
- upstream path, local path and SHA-256 for each IDL;
- required instruction and event families exercised by the product.

Offline tests recompute every checksum and compare the manifest to the
generated TypeScript constants.

## Sanitized mainnet fixture contract

`solana-mainnet-fixture.v1` means minimized public chain evidence, not
anonymized chain data. Signatures, slots, public keys and instruction bytes are
public and must remain byte-exact for decoder provenance and account/event
consistency checks. Replacing them would turn a mainnet proof into a synthetic
fixture.

The capture retains only:

- family (`pumpfun` or `pumpswap`);
- finalized provenance and capture timestamp;
- normalized instructions and their complete outer/inner cursor;
- normalized token balances needed for token-program and quote resolution;
- fee, compute-unit, version, finality and sanitized transaction error fields.

It excludes:

- RPC HTTP/WebSocket URLs, headers and provider messages;
- raw RPC response bodies;
- log messages;
- full account-key and signer arrays;
- global pre/post lamport balance arrays;
- wallet secrets (which the command never accepts).

Every fixture is immutable: capture uses exclusive file creation and refuses
an existing name. The loader rejects unknown/missing keys, non-canonical
integers and timestamps, provenance mismatch, invalid collection shapes and an
unexpected family before decoding.

## Evidence set

The existing Pump.fun evidence remains:

- `create_v2` followed by its initial buy in one transaction;
- CPI `sell` with its real stack height;
- CPI multi-quote `buy_exact_quote_in_v2`.

New finalized PumpSwap evidence covers:

- a Pump `migrate_v2` transaction with its canonical PumpSwap `create_pool`;
- a current PumpSwap `sell` transaction.

The fixtures are captured from public finalized Solana RPC data. Tests run
entirely offline and assert event/action names, canonical cursor pairing,
program identity, quote asset resolution and migration-to-pool matching.

## Capture boundary

`npm run fixture:capture -- <family> <signature> <transactionIndex> <name>` is
an explicit operator command. It is never imported by the listener or API.
It uses the standard `SOLANA_HTTP_RPC_URL`, derives a WebSocket URL only for
the existing RPC configuration shape, fetches one finalized transaction,
normalizes it and writes one new file under the selected family directory.

The command prints only the family and output filename. It never prints the
endpoint, signature, raw transaction or provider error. Capturing data does
not itself approve it: review and offline decoder assertions are mandatory.

## Acceptance

- official manifest and snapshots agree byte-for-byte;
- all five mainnet fixtures parse under one strict versioned contract;
- existing Pump.fun assertions remain green;
- PumpSwap migration/create-pool and sell evidence decode offline;
- source safety checks reject secrets, raw logs and live execution imports;
- build, check, lint, all tests, docs check and diff check pass;
- production listener, API, database schema and execution mode are unchanged.

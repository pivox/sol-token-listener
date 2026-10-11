# Independent JitoSOL bot review — 2026-10-11

Review scope: `src/jitosol/{rpc-gateway,jupiter,stake-pool,engine,journal,cli,runtime-config,main,types,config,market,bounded-fetch}.ts`, the focused tests, and the captured public unsigned Jupiter fixture. This review concerns disabled software delivery, not permission to fund or execute it. No user wallet, secret, signed live transaction, or broadcast was used by the reviewer.

Final assessment: no unresolved blocking finding for disabled delivery after the fixes below. Independent final verification passed 139 focused tests and focused ESLint. Funded execution and profitability remain unvalidated.

## Findings sent to the implementing agent

### P1 — preserve the redemption floor through withdrawal preparation and execution

The reviewed implementation used the legacy `WithdrawStake` discriminator 10 in `stake-pool.ts:261`, without an on-chain output floor. `rpc-gateway.ts:198` rebuilt the withdrawal quote from current pool state, and its simulation check at `rpc-gateway.ts:259` compared principal only with that new quote. A restart or epoch/fee change after the buy could therefore result in signing a withdrawal below the original economic threshold; a change between simulation and execution could likewise lower the redeemed principal.

The [pinned SPL source](https://github.com/solana-program/stake-pool/blob/8abfd17428728bc4c1ce181c238a3357bab82ad5/program/src/instruction.rs) contains `WithdrawStakeWithSlippage`, discriminator 24, with the same 13 accounts and two little-endian u64 fields: token input and minimum lamports out. The stake-adapter agent independently confirmed that the deployed mainnet program dispatches this variant: an unsigned, zero-account simulation at slot 455609391 logged `Instruction: WithdrawStakeWithSlippage` and then `NotEnoughAccountKeys`; truncated and unknown discriminators failed deserialization. A second unsigned simulation using actual pool/source accounts and an impossible minimum failed with the expected slippage error before token burn, at slot 455610017. The durable evidence is [guarded-withdraw-mainnet.json](../../../tests/fixtures/jitosol/guarded-withdraw-mainnet.json).

Required resolution: reject a fresh withdrawal plan below `requiredRedemptionLamports(config)`, encode an on-chain minimum at least equal to that threshold, retain the signed intent for receipt verification, and test both degraded current redemption and below-minimum finalized receipt data. The original threshold is reconstructible because the journal fingerprint binds every economic configuration input; a new position field is unnecessary. If the threshold no longer holds, retaining the user's JitoSOL and requiring recovery is preferable to silently weakening it.

Status: resolved and independently rechecked. `stake-pool.ts:263` now encodes discriminator 24 and the exact current plan minimum. `rpc-gateway.ts:202` rejects plans below the original configuration threshold before signing, persists the exact minimum, and verifies finalized stake principal at `rpc-gateway.ts:536`. `engine.ts:122` also rejects a prepared withdrawal below the original threshold. Regression tests cover the wire layout, original floor on resume, degraded current conversion, and a receipt below the signed minimum.

### P2 — public observation rejects a valid zero-denominator SPL fee

`market.ts:30` passed the pool withdrawal-fee denominator directly to `redemptionLamports()`, which rejected zero in `config.ts:67`. SPL represents a disabled fee with a zero denominator; `stake-pool.ts:177` already supports this, and `rpc-gateway.ts:166` normalizes it. Consequently public `observe` could fail for a valid zero-fee pool while executable observation accepted the same state.

Required resolution: normalize this representation consistently and add a zero-fee regression. This is not a blocker for the captured current pool state.

Status: resolved and independently rechecked. `redemptionLamports()` now applies SPL's zero-denominator fee semantics centrally. Gateway observation preserves the original denominator. The regression includes canonical 0/0, 1/0, and entry evaluation with a zero fee.

### Reliability limitation — transient polling failures become durable operator halts

At the reviewed `rpc-gateway.ts:318`, the general polling catch returned `unknown` for transport timeouts and temporary RPC failures as well as inconsistent receipts. The engine durably halts on `unknown`; its separate retry-on-thrown-poll-error path therefore did not see these transient failures. This protects against replacement transactions, but an ordinary RPC outage can stop the lifecycle while the wallet holds JitoSOL or stake. Either distinguish retryable reads from inconsistent evidence or explicitly retain and document this conservative operator-recovery behavior. This was reported as a limitation, not an unsafe-spend defect.

Status: resolved and independently rechecked. Polling RPC calls now classify read failures separately and throw the sanitized `poll_rpc_unavailable` error, so the engine retains the same pending transaction and retries later. Wrong cluster, invalid wire, and structurally inconsistent receipts still return `unknown`. The regression verifies that a temporary failure can be followed by successful reconciliation.

## Checks completed

- Independent final focused run: `npm run jitosol:test` — 139 passed, zero failed, exit 0. This includes the fixes above, Agave account tombstones, and the full real-engine/real-gateway/file-journal cycle against fake RPC state with restart and cooldown beyond 72 hours.
- Independent final lint: `npx eslint src/jitosol tests/jitosol-*.test.ts --max-warnings=0` — exit 0.
- Reviewed disabled CLI, engine and gateway guards before signer/network mutation; explicit configuration enablement plus `--live` is required by the CLI.
- Reviewed durable signed-byte persistence before send, identical-byte restart/rebroadcast, finalized receipt identity matching, single-writer journal locking, configuration binding, STOP checks around asynchronous persistence, and no replacement after uncertain outcomes.
- Reviewed exact 3 SOL input, conservative Jupiter minimum, direct-route account validation, local compute/fee policy, rejection of other signers and unrelated wallet token/stake accounts, and the actual captured unsigned Jupiter response.
- Reviewed deterministic stake destination, wallet staker/withdrawer authority, active-source capacity, funded-rent separation, actual purchased-token delta withdrawal, and full-claim simulation rather than elapsed-time claims.
- The gateway agent found and fixed Agave's zero-lamport simulation tombstone representation during this review. The reviewer inspected the new buy/claim regression and confirmed it passes in the final suite.
- Independently compiled the exact captured Jupiter response with both local gateway compute-budget instructions, without lookup-table compaction: 841 wire bytes, one required signer, all signatures zero. No network or signing was used for this check.

## Validation limits

Mocked lifecycle tests and captured unsigned protocol data do not establish a funded mainnet cycle, current opportunity frequency, or profitability. Buy and withdrawal are separate transactions; even a guarded withdrawal cannot guarantee that its threshold remains attainable after a completed buy. A halted position remains an operator responsibility. Claim timing depends on actual chain state, and the 72-hour carry assumption does not promise a 72-hour unlock. Token-account rent remains an owned but illiquid balance until that account is closed separately.

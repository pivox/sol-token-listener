# JitoSOL bot implementation plan

Goal: deliver the complete disabled bot and reproducible validation before 17:00 Paris, 2026-10-11.
Architecture: isolated TypeScript CLI with persistent one-position state and explicit gateway ports; public observation remains separate from live execution.
Tech stack: existing Node22/TypeScript, web3.js, SPL Token; no new paid service or production daemon.

- [x] Isolate branch feat/jitosol-discount-bot; install locked dependencies; verify existing hardened signer tests and baseline typecheck.
- [x] Agent engine: failing tests, strict config/types, atomic private journal/exclusive lock, state-machine lifecycle and restart/expiry controls. Gate disabled before all ports.
- [x] Agent stake: primary-source ABI verification, archived byte fixture tests, validator/capacity checks, deterministic account withdrawal, deactivate and simulated-ready claim builders.
- [x] Agent Jupiter: strict quote, fixed mints, integer sizes and limits, validated unsigned route instructions, timeout/redirection and transaction-account checks.
- [x] Agent gateway: test injected RPC/signer before wiring; unsigned simulation and fee/debit checks before signing, durable prepared messages, raw-byte broadcast and finalized receipt parsing.
- [x] Root CLI/docs/config: explicit future live opt-in, disabled template, offline status and read-only observe, stop handling, package scripts, clear activation and recovery guide.
- [x] Integrate each module; test full synthetic delayed-unstake lifecycle and crash boundaries; typecheck and lint touched files; broaden tests where integration warrants.
- [x] Fresh independent review of specification, financial/protocol implementation and signing/broadcast gates; fix findings and rerun affected checks.
- [x] Close current 30-minute research run; immutable report and no remaining research process. Build release; verify disabled CLI with network and signing ports denied.
- [ ] Commit reviewed implementation and integrate locally if clean; deliver exact code/report paths, test evidence and limits before17:00, bot disabled and no real funds engaged.

Review-driven changes: guarded `WithdrawStakeWithSlippage` with a durable original economic floor; STOP and quote-expiry rechecks after journal fsync; zero-lamport simulation tombstones; SPL zero-denominator fee semantics; retryable RPC reads distinguished from inconsistent receipts. See the independent reviews in `../reviews/`.

# JitoSOL discount bot, delivered disabled

User-approved scope on11October2026: executable JitoSOL/SOL discount bot, disabled, delivery before17:00 Europe/Paris. This authorizes implementation and tests, not funded execution, production deployment, new subscriptions, or service startup.

## Behavior
A standalone TypeScript CLI observes SOL→JitoSOL quotes and current SPL stake-pool state. A3SOL candidate must retain at least0.009SOL modeled surplus after protocol withdrawal, a0.001SOL network envelope and illustrative72h6.5% staking carry. A second fresh quote at least10seconds later must still qualify; entry uses that second quote. Current executable withdrawal capacity is checked before entry. Return and availability are uncertain; this software must never report strategy profitability as validated.

When explicitly configured and invoked for live execution by the operator in the future, the bot buys JitoSOL, withdraws the received balance into a deterministic user-owned stake account, deactivates it, waits until an actual claim instruction can succeed, and withdraws SOL. It uses one position at a time and starts no further position beyond the configured cycle/loss/fee caps. Disabled configuration and absent live opt-in must return before signer loading or network actions. The shipped configuration is disabled, with no wallet/key/RPC credentials installed.

## Boundaries
No Pump.fun worker, listener, ENTRY_STOP, Compose service, database or Vault is changed. No wallet is discovered or generated for the user. Runtime optionally uses an explicitly supplied keypair file with the repository’s existing hardened loader. Only deterministic create-with-seed stake accounts are used, avoiding extra stake keypair storage. Signed transaction bytes are private durable state and never logged.

## Lifecycle and recovery
One journal with atomic private writes and an exclusive process lock records the wallet, configuration, position and pending action. Every signed transaction, signature and last-valid blockheight is durable before broadcasting. A restarted process queries the same signature and may resend only identical bytes while still valid; it never invents a new buy or withdrawal while outcome is uncertain. Expired/unknown/failing transactions halt entry and retain evidence for recovery. Finalized on-chain effects supply actual token receipts and paid fees. Claim readiness is checked against stake authority/state and a successful unsigned claim simulation, not a fixed time heuristic.

Withdrawal encodes a minimum SOL principal in `WithdrawStakeWithSlippage`, at least equal to the original economic floor recovered from the fingerprinted configuration. The signed minimum is persisted and checked against finalized receipt balances. If the pool rate or fee has degraded below that floor after purchase, the position remains in JitoSOL and halts for operator reconciliation. Transport failures during receipt reads retain pending state for retry without permitting a replacement or an uncertain rebroadcast.

## Modules
- config/types/engine/journal: financial accounting, pure lifecycle decisions, persistence and runtime gates.
- stake-pool: verified SPL decoding, validator capacity selection, withdrawal/deactivation/claim instruction builders.
- jupiter: fixed mint quotes, bounded API calls and validated unsigned swap instructions.
- gateway: RPC reads, transaction simulation, locally set compute budget, fee limits, hardened signing, identical-byte broadcast, finalized reconciliation.
- CLI: status, read-only observation, bounded run; disabled default and explicit future live invocation.
- research scripts: separate read-only measurement and immutable offline report; no profitability promotion into live permission.

## Validation
TDD for financial arithmetic and protocol wire instructions; deterministic fake-port lifecycle tests including restart boundaries; invalid quote/program/signer rejection; source account and stake authority checks; mainnet read-only data as optional recorded fixtures. Typecheck, focused tests, lint and independent review precede delivery. No real funded end-to-end test is performed. Document that limitation, all required operator configuration and exact activation/stop/recovery commands. Deliver code in the repository, runnable build and evidence before17:00 today; preserve unrelated work.

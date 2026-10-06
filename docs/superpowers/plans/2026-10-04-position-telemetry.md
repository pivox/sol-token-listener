# Position telemetry implementation plan

Goal: measure the existing microtrade strategy without changing its economics or submitting transactions.

Architecture: a separate, read-only collector tails existing runner evidence and captures PostgreSQL participant/market/graph projections. A durable versioned input journal drives a pure causal reducer and an offline report. No dependency from the trading process to the collector. No additional Solana RPC. Existing quotes are reused; missing metadata is explicit, never inferred from later state.

The user specification supplies the design constraints and authorizes implementation. Work proceeds inline in the current workspace, preserving existing edits and historical evidence.

- [x] Test and implement pure position snapshots: exact bigint financial arithmetic, finalized external activity, separate wallet/cluster identities, creator activity, momentum, observed extrema, as-of availability, orphan exclusion.
- [x] Test and implement durable append-only evidence: stable IDs, restart recovery, truncated-tail handling, revisions rather than rewrites.
- [x] Test and implement r7 log normalization, PostgreSQL read-only bounded capture and independent CLI. Keep historical runner decision code unchanged.
- [x] Test and implement offline WIN/LOSS statistics and explicitly labelled counterfactuals, including missing populations and early closed positions.
- [x] Document formulas, limitations, paper verification and exact operator commands. Run focused tests, repository test/check/lint/build gates. Do not execute live runner.

Financial convention: entry economic cost = BUY payer balance decrease minus recoverable token account rent (already includes venue and network BUY fees). Gross = quoted SELL proceeds minus (entry economic cost minus BUY network fee). Net executable = conservative SELL minimum minus entry economic cost minus existing SELL network reserve. Realized = final payer balance minus initial payer balance plus retained token rent. No duplicate venue fee deduction. SOL/USDT conversion is secondary, fixed at the persisted BUY price.

Causality: data availability is capture time for mutable DB state; runner observations use their persisted event timestamp. Every snapshot uses only data available at or before its target. Latest quote older than 10 seconds is unavailable. Historical imports cannot manufacture historical DB projections. Snapshot gaps and closed positions remain unavailable. Reorg evidence invalidates affected populations; original observations remain append-only and reconciled reports exclude invalidated data without adding future positive evidence.

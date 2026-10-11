# JitoSOL observation evidence review — 2026-10-11

Independent, offline review of `docs/jitosol-observation-2026-10-11.md`, the observation claims in `docs/jitosol-bot.md`, and the archived `observation-20261011T090532Z` evidence. This review does not assess the bot implementation or validate a funded trading cycle.

**Findings:** no critical, important, or minor discrepancies identified in the reviewed observation claims.

Verification performed directly against the archived files:

- Rebuilt `report.json` identically after preserving its generation timestamp, and reproduced `report-fr.md` exactly. All source-file manifests and the report hashes in `closure-verification.json` match.
- Verified SHA256 hashes and byte counts for all 70 responses, plus their request hashes. Paired every quote/RPC response with its capture and replayed the recorded assessment: 35 primary captures, 34 calculable, 25 passing freshness checks. No secondary captures occurred.
- Confirmed the only recorded RPC methods are public reads: `getAccountInfo`, `getEpochInfo`, and `getStakeMinimumDelegation`. The single incomplete capture is cycle 11 of the final session. Its eight other rejected points have unproven route freshness.
- Independently recomputed integer fees and redemption values. Carry is `ceil(3,000,000,000 × 0.065 × 72 / (365 × 24)) = 1,602,740` lamports, with the 1,000,000-lamport network budget deducted once. Every calculable optimistic redemption is negative before network costs. In the final session, that deficit is 1,112,853–1,113,564 lamports; minimum-output surplus after budget and carry is −6,715,189 to −6,714,479 lamports.
- The archived API minimum exceeds the conservative slippage floor by one JitoSOL atomic unit in every calculable capture, consistent with the documented distinction between research and bot calculations.
- Confirmed the final sample window is 11:19:27.783545–11:48:28.132206 Europe/Paris, an observed span of 1,740.349 seconds. Consecutive starts are 59.965–60.001 seconds apart. The 24-hour plan is explicitly classified as stopped after two samples; the final session has 30 samples over approximately 29 minutes.
- Recomputed each session's protocol-ratio benchmark. It is correctly distinguished from executable PnL. All three recorded collector PIDs are absent at review time.

The documents preserve the necessary limits: correlated samples are not independent trades; gaps and sampling cadence can miss opportunities; no opportunity frequency, annualized strategy return, or twelve-month performance is inferred. SHA256 establishes archived-byte integrity, not provider truth. Exit availability, actual costs, and a funded mainnet cycle remain unvalidated. The operator manual explicitly states that no real purchase or funded unstaking was performed for this delivery.

No network calls, new captures, key access, or fund movement were performed for this review. Existing test results were not relied upon for the evidence checks above, and the test suite was not rerun.

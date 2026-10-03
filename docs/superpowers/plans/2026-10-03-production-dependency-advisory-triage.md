# Production dependency advisory triage — plan v1.0.0

Issue: #223. Design: `../specs/2026-10-03-production-dependency-advisory-triage-design.md` v1.0.0.

1. Reproduce production audit and package paths on the exact merged base.
   Verify five leaf advisories and avoid treating 15 propagated records as 15
   independent vulnerabilities.
2. Check primary advisories and installed import/call paths for TOML and
   stream-json. Preserve uncertainty for bigint-buffer; do not infer safety
   from absence of an observed exploit.
3. Update `SECURITY.md` with the current date, precise listener/executor
   authority boundary, leaf table, reachability limitations, compatible-fix
   status and operator risk-decision requirement before real-wallet use.
4. Run docs-check, diff-check and relevant repository checks. Review the
   documentation once, open one PR, request one external Codex review cycle,
   address actionable feedback, require green CI and merge.

This plan makes no wallet, signing, transaction, RPC or deployment call.

# Deployment smoke safe phase diagnostics

Contract revision: 1.0.1

Issue: #197

Status: implemented and locally reviewed; integration smoke validation pending.

## Evidence and scope

The main run 36909503089 failed with `TypeError(validation)` while PR run
36907578527 passed with the identical Git tree. The formatter maps every
unrecognized message to `validation`; native fetch and body-stream failures
therefore cannot be distinguished from contract failures. This is not evidence
of a specific transport failure or a flaky test.

## Contract

Keep the same smoke assertions, timeouts, cleanup, success output, and retry
behavior. Attach diagnostic metadata to thrown objects through a private
WeakMap without replacing errors. Annotate fixed phase names at the smoke
steps and fixed operations at HTTP headers, bounded body, and SSE body reads.
An outer phase can fill missing metadata, but cannot replace an inner operation
or overwrite the primary error during cleanup.

The standalone signal-fault-probe entrypoint follows the same attribution
contract for both SIGTERM and SIGKILL: primary failures carry `SIGNAL_PROBE`,
and collected cleanup failures carry `CLEANUP`, including aggregate members.
The controlled SIGKILL failure remains a failure; the successful SIGTERM path
remains successful when cleanup succeeds.

The existing bounded failure summary gains only allowlisted phase, operation,
and transport-code values. Transport codes are read from an error or its direct
cause; unrecognized values produce no raw output. Error names must also be
allowlisted in this public summary. Unknown thrown values remain redacted.
No raw messages, stacks, URLs, environment values, response bodies or command
output are emitted. Aggregate depth/count and the 1,024-byte line bound remain.

## Acceptance

VM tests execute real smoke functions with injected fetch/body/SSE failures,
without importing its executable entrypoint or starting Docker/network work.
They prove exact phase/operation/cause output, original error identity,
aggregation and cleanup attribution, allowlist fallback, malicious-value
redaction, bounded output, and unchanged success/assertion behavior.

Use focused diagnostics and smoke-artifact tests, syntax, TypeScript and lint
checks. The delegated implementation does not run the full DB suite or Docker
smoke; the coordinator owns PR delivery and integration smoke verification.

# Fresh live-edge bootstrap design

Status: approved for implementation
Version: 1
Issue: #120
Scope: listener catch-up bootstrap only; no wallet, signer, submission, decoder,
block-cache, schema, or executor change

## Incident and objective

The Mainnet observe-only canary showed that the active production graph parses
`LISTENER_CATCH_UP_POLICY` but always constructs `StrictCatchUpScanner` without
that policy. A fresh database therefore enqueues the whole first signature page
as historical work. That contradicts the V1 product boundary: observe launches
from listener arrival, not before it.

This change makes the configured policy effective in the active scanner. It is
a necessary bootstrap correction, but it is not sufficient to pass the
15-minute Mainnet backlog/RSS gate: catch-up after a checkpoint exists remains
strict and needs a separate admission/classification improvement.

## Selected contract

`StrictCatchUpScanner` accepts the closed policy `live-edge | strict`, defaulting
to `strict` for existing direct callers.

When all three conditions hold for one program:

1. policy is `live-edge`;
2. the persisted checkpoint is absent;
3. no durable strict run is active;

the scanner reads and validates exactly the first bounded page, enqueues none of
its signatures, and compare-and-swaps `null` to the newest signature. An empty
valid page leaves the checkpoint absent and resolves prior null-frontier failure
evidence as today.

Every other case preserves the strict resumable protocol. In particular, a
non-null checkpoint is recovered losslessly even under `live-edge`, and a
matching active strict run is always resumed rather than rebased.

## Lossless subscription handshake

Production prepares the initial `live-edge` frontier before opening the first
WebSocket session. It then opens and acknowledges the subscriptions and runs the
normal strict scan from that persisted frontier before publishing `RUNNING`.
The second scan therefore covers every signature produced between the baseline
read and the subscription acknowledgement. Its enqueues also make concurrent
WebSocket observations idempotent: a failed WebSocket write cannot be skipped
past by the baseline checkpoint. A process failure after the first CAS and
before subscription is recovered from the same durable frontier on restart.

## Result and failure semantics

For a non-empty live-edge bootstrap, `discoveredCount` reports validated rows,
`enqueuedCount` is zero, `checkpointCasCount` is one, and `pageCount` is one.
Checkpoint CAS failure remains the existing redacted retryable
`checkpoint-cas` error. The scanner does not create catch-up-gap evidence for a
null frontier because no previously observed interval is abandoned.

Production passes `config.listenerCatchUpPolicy` to every provider-pinned
scanner. No setting can activate signing, wallet loading, simulation submission,
or transaction execution.

## Verification

Tests prove:

- fresh `live-edge` validates one page, advances the null checkpoint, and
  enqueues zero historical signatures;
- fresh `strict` retains the existing one-page enqueue behavior;
- `live-edge` with a checkpoint remains strict and lossless;
- `live-edge` resumes an active strict run;
- malformed policies fail closed;
- the production factory wires the parsed policy;
- the initial frontier completes before the first WebSocket is opened, followed
  by the ordinary post-acknowledgement strict scan;
- build, check, lint, backend/frontend tests, and documentation checks pass.

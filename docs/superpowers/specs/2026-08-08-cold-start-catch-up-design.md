# Cold-start catch-up and subscription gap design

## Problem

A fresh database has no program checkpoints. Both Pump.fun programs return
full signature pages, so the bounded scanner cannot reach historical
exhaustion and raises `CATCH_UP_WINDOW_EXCEEDED`. The listener therefore cannot
start on a fresh installation. In addition, the current order scans before the
WebSocket subscription, leaving a small unobserved interval.

## Approved behavior

For each program without a checkpoint, the first scan treats exactly one newest
page as the baseline window. It enqueues that page oldest-to-newest and stores
its newest signature as the checkpoint. It does not attempt to walk back to
genesis because the product observes from token arrival rather than historical
launches.

Startup becomes:

```text
RPC health -> baseline catch-up -> WebSocket subscribe -> gap-closing catch-up
           -> worker -> finality reconciler -> heartbeat -> API
```

The second scan starts after both subscriptions are active and reads until the
new checkpoint. Signatures seen by both paths converge through the existing
inbox identity and remain idempotent. Existing-checkpoint scans retain the
current bounded-window error when the checkpoint is not reached.

## Failure and cleanup

- A baseline page is fully enqueued before its checkpoint is stored.
- A failure in either scan keeps startup fatal and redacted.
- If the second scan fails, startup rollback closes the subscriber.
- Checkpoint or enqueue partial failures retain their current replay-safe
  semantics.
- No submission, signer, paper trade, or live execution path is introduced.

## Verification

- cold start with full pages succeeds and consumes one page per program;
- existing checkpoint outside the configured window still fails;
- the second scan occurs after `subscriber.start` and before `worker.start`;
- an event returned by the second scan and WebSocket remains one inbox item;
- second-scan failure closes the subscriber and leaves later components idle;
- the public-RPC observe dry run reaches a running `/api/v1/health` state.

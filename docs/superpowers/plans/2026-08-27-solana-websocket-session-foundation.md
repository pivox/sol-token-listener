# Solana acknowledged WebSocket session foundation implementation plan

**Goal:** Deliver issue #59 as an inactive, fully tested foundation: paired
HTTP/WS provider configuration plus a native Pump.fun/PumpSwap WebSocket
session that resolves only after both server acknowledgements.

**Architecture:** A shared positional provider catalog validates and freezes
the configured HTTP/WS pairs. A focused native-WebSocket JSON-RPC session owns
subscription protocol state and exposes only redacted lifecycle results. The
existing production `SolanaProgramSubscriber` remains wired and behaviorally
unchanged until issue #63.

**Tech stack:** TypeScript strict ESM, Node 22 native WebSocket, Node test
runner, existing Pump.fun/PumpSwap constants, no new runtime dependency.

## Task 1: Versioned design and paired provider contract

Files:

- `docs/superpowers/specs/2026-08-27-solana-websocket-failover-design.md`
- `src/config/env.ts`
- `src/solana/rpc/rpc-provider-catalog.ts`
- `tests/config-safety.test.ts`
- `tests/rpc-provider-catalog.test.ts`

Steps:

1. Add failing tests for absent fallbacks, HTTP-only fallback compatibility,
   valid 1–3 pairs, WS-present cardinality, protocol compatibility, blanks,
   fragments, canonical duplicates and hostile secret-bearing values.
2. Add `wsRpcFallbackUrls` to `AppConfig` and parse it with errors that name
   only configuration fields.
3. Extract or add a frozen provider-pair projection with positional IDs shared
   by later transport work. An absent WS fallback list preserves the HTTP-only
   behavior from issue #56.
4. Run the focused configuration tests and typecheck.

## Task 2: Native acknowledged program-log session

Files:

- `src/solana/rpc/ws-program-session.ts`
- `tests/ws-program-session.test.ts`

Steps:

1. Write fake-WebSocket tests for open, requests, ACK order, partial ACK,
   timeout, RPC error, malformed/oversized frames, duplicate IDs and abort.
2. Define the injectable WebSocket/factory boundary, positional endpoint and
   frozen notification/session contracts without `any`.
3. Implement strict JSON-RPC parsing and resolve `open()` only after the two
   unique canonical subscriptions are acknowledged.
4. Forward a validated successful notification from the first mapped
   subscription before the second ACK through an async durable callback;
   reject invalid signatures/slots, ignore failed transactions, and turn
   unknown active subscriptions or callback rejection into protocol failure.
5. Track in-flight callbacks, expose one redacted completion result and ensure
   error/close races settle once.

## Task 3: Bounded unsubscribe and lifecycle cleanup

Files:

- `src/solana/rpc/ws-program-session.ts`
- `tests/ws-program-session.test.ts`

Steps:

1. Add failing tests for every acknowledged subscription's unsubscribe reply,
   false/malformed replies, partial setup cleanup, cleanup timeout, abort,
   concurrent close and listener/timer/in-flight callback drain.
2. Implement idempotent close with bounded unsubscribe of acknowledged IDs
   only and forced local close.
3. Confirm that raw socket errors, close reasons, frames and endpoint URLs
   never escape through errors or public session state.

## Task 4: Safe examples, operations docs and integration guard

Files:

- `.env.example`
- `deploy/env.example`
- `docs/operations/rpc-qualification.md`
- `tests/deployment-artifacts.test.ts`
- `tests/production-listener-factory.test.ts`

Steps:

1. Document the ordered WS fallback list and positional pairing with invalid
   placeholder hosts only.
2. Assert that production still instantiates the existing subscriber and does
   not yet instantiate the new session.
3. State explicitly that #59 does not provide operational WS failover and that
   #63 is required for activation.

## Task 5: Verification, review and merge

1. Run focused tests after every red-green-refactor slice.
2. Run `npm run build`, `npm run check`, `npm run lint`, `npm run docs:check`
   and the complete PostgreSQL-backed `npm test` suite.
3. Inspect the diff for secrets, unsafe imports, signing/submission terms and
   unintended production wiring.
4. Commit, push and open one PR closing #59.
5. Request GitHub Codex review, address blocking findings and repeat for at
   most three correction/review cycles.
6. Merge only with green CI and no unresolved blocking review thread, then
   update local `main` and continue with #60.

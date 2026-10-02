# Complete-block payload measurement execution plan

> **For agentic workers:** Use subagent-driven-development for the offline harness and tests; the parent alone runs authorized network capture. One review cycle maximum, no production implementation in this experiment.

**Goal:** Obtain complete-block evidence before choosing an oversize representation fix.

**Architecture:** A one-off, outside-Git harness wraps the installed Connection fetch with a closed request budget, persists bounded public responses, then replays them offline through the existing snapshot function. The listener, dependencies and database remain unchanged.

**Tech Stack:** Existing Node/tsx, Solana web3.js, node:test, V8 serializer, zlib, fs/statfs, fixed-code errors.

Specification: `docs/superpowers/specs/2026-10-02-block-payload-measurement-design.md` v1.0.0, commit `7b72a2e`.

## Task 1 — Offline guards, RED before capture code

Files outside Git:
- `/tmp/sol-listener-block-measurement.mjs`: exported pure transport/analysis helpers and explicit CLI entry point.
- `/tmp/sol-listener-block-measurement.test.mjs`: fake-fetch tests; never read `.env` or use network.

- [ ] Define `createGuardedFetch(options)` returning a fetch-compatible function. Options inject `fetchImpl`, `sleep`, `timeoutMs`, `maximumBytes` and `onResponse`. Default production limits remain 1000 ms separation, 30000 ms timeout, 32 MiB body and four requests; injection only permits smaller limits for offline tests. Hard-coded slots and genesis are not injectable on the CLI.
- [ ] Define `measureBlock(block, slot, rawBytes)` using `snapshotBlockTransactionData` and returning aggregate numbers/flags only, never a transaction/signature dump.
- [ ] Import the helpers into tests and demonstrate RED with these minimal cases before implementation:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuardedFetch, measureBlock } from './sol-listener-block-measurement.mjs';

const endpoint = 'https://mainnet.helius-rpc.com/?api-key=FAKE_ONLY';
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const request = (method, params = []) => ({
  method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
});
const blockParams = slot => [slot, {
  commitment: 'finalized', transactionDetails: 'full',
  maxSupportedTransactionVersion: 1, rewards: false,
}];

test('a block cannot precede verified genesis', async () => {
  let calls = 0;
  const guarded = createGuardedFetch({
    fetchImpl: async () => { calls++; return new Response('{}'); },
    sleep: async () => {},
  });
  await assert.rejects(guarded(endpoint, request('getBlock', blockParams(452406478))));
  assert.equal(calls, 0);
});

test('HTTP failure stops, redacts and never retries', async () => {
  let calls = 0;
  const guarded = createGuardedFetch({
    fetchImpl: async () => { calls++; return new Response('SECRET', { status: 429 }); },
    sleep: async () => {},
  });
  await assert.rejects(guarded(endpoint, request('getGenesisHash')), error => {
    assert.doesNotMatch(String(error), /SECRET|api-key|FAKE_ONLY/);
    return true;
  });
  await assert.rejects(guarded(endpoint, request('getGenesisHash')));
  assert.equal(calls, 1);
});
```

- [ ] Add a successful four-request transcript with exact slot/options validation and one-second spacing assertions; fifth request, repeated slot, unsupported method, wrong genesis, parallel request and redirect all reject without extra network access.
- [ ] Cover body oversize with streamed chunks (not only Content-Length), header/body timeout with a never-settling fake, malformed JSON, RPC error carrying a fake secret, null block, wrong protocol/host, and poisoned transport after first failure. No test may actually contact a provider.
- [ ] Run `node --test /tmp/sol-listener-block-measurement.test.mjs`; record the RED result in tracking.

## Task 2 — Minimal one-off implementation and GREEN

- [ ] Implement the tested transport as a finite sequence: genesis then the three fixed slots in order. Validate request method/options before I/O; consume each attempt once. Use `redirect: 'error'`, an AbortController, and a timeout race that includes streamed body consumption. Always clear timers; cancel bounded streams on failure without an unbounded cleanup wait. A failure permanently closes the transport. Never retain upstream errors as causes or print them.
- [ ] Validate successful JSON-RPC envelopes before calling `onResponse({ method, slot, bytes })`; preserve exact response bytes. Return a fresh Response containing the same bytes and only the JSON content type, so Connection performs its normal message/version transformation. Connection must use `disableRetryOnRateLimit: true` and this injected fetch.
- [ ] Implement `capture` CLI: verify disk for repository and artifact filesystem before directory creation and every block; reject <=5e9 available bytes. Read only the existing authorized RPC setting privately, validate/map only the documented Helius hostname. Create fresh 0700 directory and 0600 files with exclusive creation, SHA-256 and public manifest. Never load database or wallet modules. Catch errors at the CLI boundary and print only a whitelisted fixed code. Do not execute it yet.
- [ ] Implement `analyze DIRECTORY` CLI with network impossible: use a fake fetch returning each recorded response to Connection, then the exact existing snapshot function. Process blocks sequentially; verify size/hash before parsing. Keep complete captures outside Git, only aggregate reports are suitable for documentation.
- [ ] For every normalized payload compare V8 bytes against raw-deflate level 1, retaining the original when compression grows it. Inflate with `maxOutputLength` equal to original length, assert byte equality and deserialized deep equality. Report candidate encoded bytes separately from any undecided future format overhead. Count real null/malformed/duplicate payloads without dropping them to manufacture cacheability.
- [ ] Measure conversion, normalization, compression and inflation separately with performance.now; record Node/V8/platform, process memoryUsage and resourceUsage maxRSS with documented platform units. Do not call endpoint samples a peak. Release per-block graphs; optional explicit GC must be declared in results. The host Node25 run is exploratory unless repeated under production Node22.
- [ ] Add lossless offline payload tests with bigint, instruction Uint8Array, logs, null/error fields, incompressible bytes and an invalid block; keep signature lists out of reported output. Re-run all guard/codec tests GREEN and `node --check` on both files. Parent reads the harness and test output before capture; no formal second review loop is added.

## Task 3 — Capture only after post-merge CI success

- [ ] Confirm `gh run view 36950821058 --json status,conclusion` is completed/success on merge `1d836d9`; otherwise keep capture blocked.
- [ ] Confirm disk >5 GB and zero other Mainnet listener/canary activity. No Docker or database is needed for capture.
- [ ] Run `node /tmp/sol-listener-block-measurement.mjs capture` once. A failure stops the fixed experiment; do not silently rerun or replace slots. Record successful request count and the fixed failure code if incomplete.
- [ ] Verify 0700/0600 modes, public manifest hashes and total raw data <=96 MiB. Never display environment contents or provider response error bodies.
- [ ] Run `node /tmp/sol-listener-block-measurement.mjs analyze <exact-returned-directory>` offline; save aggregate output with runtime and sample limitations.

## Task 4 — Decision and handoff

- [ ] Compare measured current bytes with 8 MiB/entry and 64 MiB/global, not an increased limit. Separate physical repeated fetches from these distinct sample blocks.
- [ ] If results support a candidate, amend the design before any production codec code; otherwise document the rejected hypothesis and the concrete missing evidence. Do not claim that three blocks establish sustained capacity.
- [ ] Commit only design/plan/aggregate evidence, never captures, harness credentials or tracking. Keep useful captures until investigation no longer needs them; then schedule the existing four-hour retention policy. Do not create a new service or general telemetry project.
- [ ] Update authoritative tracking with paths, counts, runtime, resource status and next step. The full trade goal and all canary/H2e/H2c/manual authorization requirements stay unchanged.

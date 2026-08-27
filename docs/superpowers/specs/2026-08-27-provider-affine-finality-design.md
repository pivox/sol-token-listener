# Provider-affine Solana finality design

Date: 2026-08-27
Issue: #61
Parent issue: #57
Version: 1.0.0
Status: approved through the standing instruction to use the recommended option

## Purpose

The listener must never retract a transaction by combining an absent status
from one Solana RPC provider, a finalized root from another provider, and
missing archive data from either one. Issue #61 makes every finality decision
provider-affine and requires positive canonical block evidence before an
`orphaned` revision can be enqueued.

This work remains strictly `observe` or `paper`. It adds no wallet, signer,
private key, transaction construction, submission, live execution or profit
claim. It does not run the Mainnet 50-position validation from issue #49.

## Audited baseline

The active `FinalityReconciler` batches `getSignatureStatuses` and
`getSlot('finalized')` through `SolanaRpcClient`. That client owns a request
level failover transport, so the two concurrent requests can complete against
different endpoints. The reconciler currently declares `orphaned` after only
three missing statuses and a strictly higher finalized root. It does not read
the canonical block.

The inbox persists only `missing_finality_polls`. It cannot distinguish three
misses from one provider from misses accumulated across a provider switch.
`recordFinalityPoll` and `enqueueRevision` are separate transactions, and the
latter has no proof precondition. A second reconciler can therefore reset or
replace the missing-status evidence after the first poll commits but before
the first reconciler enqueues `orphaned`.

The existing `SolanaRpcClient.getBlockSignatures` implementation calls the
generic web3.js `getBlock` parser with `transactionDetails: 'signatures'`.
`@solana/web3.js` 1.98.4 expects the dedicated `getBlockSignatures` response
path for this representation. Issue #61 uses and tests that dedicated method.

## Considered approaches

### Selected: provider-pinned pass capability

At the beginning of `runOnce`, the application captures one immutable
`FinalityProviderPass`. The pass exposes a positional provider ID and the
three reads needed by the algorithm. Its adapter owns one `Connection` built
from one exact HTTP URL and never imports or invokes the request-level
failover transport.

This makes affinity structural, keeps finality policy in the application
layer, and lets #63 select the active promoted provider without changing the
proof algorithm.

### Rejected: one monolithic evidence RPC

A single adapter method could materialize statuses, root, thresholds and all
block proofs. It would make mixing difficult, but it would also move threshold
policy, candidate selection and proof budgets into the Solana transport. That
coupling makes testing and later policy changes unnecessarily expensive.

### Rejected: endpoint lease in the shared failover transport

The existing transport could expose a multi-request lease around its sticky
endpoint. This would couple finality to shared mutable failover state and make
concurrent ordinary RPC calls, aborts and endpoint promotion harder to reason
about. It also risks regressing the already delivered HTTP failover behavior
from issue #56.

## Boundaries and contracts

The application owns two narrow contracts:

```ts
export interface FinalityProviderPass {
  readonly providerId: RpcProviderId;
  getHistoryStatuses(signatures: readonly string[]): Promise<unknown>;
  getFinalizedSlot(): Promise<unknown>;
  getFinalizedBlockSignatures(slot: bigint): Promise<unknown>;
}

export interface FinalityProviderPassSource {
  openPass(): unknown;
}
```

`openPass` is called exactly once after a non-empty candidate page is read.
The reconciler snapshots and validates the returned capability without
invoking getters or accepting mutable identity. A provider change can affect
only the next pass.

The Solana adapter is constructed from the paired provider catalog and an
explicit positional provider ID. It resolves the provider once, creates one
HTTP `Connection` with `disableRetryOnRateLimit: true`, and returns fixed,
redacted errors. It does not expose a URL, hostname, header, query, remote
message, response body or error cause.

Issue #61 wires production finality to a fixed `primary` pass. It intentionally
degrades when that provider cannot answer instead of using the general RPC
fallback. Issue #63 will supply the provider promoted by the WebSocket
supervisor. The supervisor's strict recovery validates the expected genesis
hash before promotion, so #61 does not introduce a second deployment setting
or weaken the explicit genesis requirement defined for #63.

## Durable model and migration 027

Migration `027_listener_provider_affine_finality.sql` adds one nullable column
to `chain_transaction_inbox`:

```sql
last_missing_finality_provider_id TEXT
```

The allowed durable states are:

```text
missing_finality_polls = 0  <=> last_missing_finality_provider_id IS NULL
missing_finality_polls > 0  =>  provider is primary or fallback-1..3
```

Existing positive counters have no trustworthy provenance because they may
already combine request-level failover responses. The migration resets only
rows with a positive counter and a null provider to `0/NULL`. This is a
fail-closed invalidation of unsafe evidence, not deletion of a transaction or
projection. Replaying migration 027 leaves new valid sequences untouched.

No new index is added. The existing partial finality index already supports
candidate selection, while indexing a field updated on each poll would add
write churn without serving a query.

The domain contracts become:

```ts
export interface FinalityCandidate {
  readonly signature: string;
  readonly slot: bigint;
  readonly confirmationStatus: 'processed' | 'confirmed';
  readonly missingFinalityPolls: number;
  readonly lastMissingFinalityProviderId: RpcProviderId | null;
  readonly processedAtMs: number;
}

export interface FinalityPollObservation {
  readonly signature: string;
  readonly confirmationStatus: 'processed' | 'confirmed' | null;
  readonly providerId: RpcProviderId;
  readonly expectedMissingFinalityPolls: number;
  readonly expectedLastMissingFinalityProviderId: RpcProviderId | null;
  readonly observedAtMs: number;
}
```

`FinalityRevision` becomes a discriminated union. The `finalized` branch keeps
its existing shape. The `orphaned` branch also carries the exact expected
pre-terminal confirmation status, missing counter and last missing provider.
These fields are internal evidence preconditions and are not added to public
API responses.

Every inbox write that clears `missing_finality_polls` also clears
`last_missing_finality_provider_id` in the same statement.

## Poll transitions and compare-and-swap

`recordFinalityPoll` locks the signature row and compares both expected fields.
The provider is part of the CAS to prevent an ABA where two providers each
produce the same numeric count.

```text
missing + same provider       -> count + 1, same provider
missing + different provider  -> count 1, current pass provider
processed/confirmed present   -> count 0, provider null
```

An observed `processed` status never regresses a durable `confirmed` status.
The existing behavior where a polled `processed -> confirmed` promotion does
not replay projections remains unchanged; that adjacent behavior is outside
issue #61.

Before a real transition to `orphaned`, `enqueueRevision` locks the row and
requires all of the following to remain exact:

- processing status is `PROCESSED`;
- target confirmation is the expected `processed` or `confirmed` value;
- missing counter equals the post-poll counter;
- last missing provider equals the current pass provider.

A status observation, provider switch, competing poll or competing revision
invalidates the proof and returns the existing fixed finality conflict. A
reconciler failure then leaves the component `DEGRADED` until a later pass
builds fresh evidence.

Idempotent replay remains valid. If the first orphan enqueue committed but its
response was lost, a repeated identical revision is a no-op when the row is
already `PENDING/orphaned` or terminal `PROCESSED/orphaned`, even though its
proof fields were cleared by the successful first transition.

## Reconciliation algorithm

For each non-empty bounded candidate page:

1. Open and snapshot exactly one provider pass.
2. Batch all history status reads with `searchTransactionHistory: true` and
   read exactly one finalized root through the same pass.
3. Reject the whole evidence set before mutation when array shape, slot or
   finality is contradictory.
4. Enqueue an explicit `finalized` status through the existing durable replay
   path.
5. Record every `processed`, `confirmed` or missing observation with the pass
   provider and exact expected provider/count CAS.
6. Consider only returned missing candidates whose same-provider count has
   reached the configured threshold and whose slot is strictly below the
   same-provider finalized root.
7. Group eligible candidates by slot. Read each finalized block at most once,
   in deterministic slot order, for at most sixteen unique slots per pass.
8. Validate the complete block signature set before enqueuing any orphan
   revisions for that slot.
9. If every eligible signature is absent, enqueue each orphan revision with
   its exact durable proof precondition.

The official `getSignatureStatuses` contract accepts at most 256 signatures,
so `MAX_FINALITY_RECONCILE_LIMIT` becomes 256. The current production page of
100 remains valid. At most sixteen unique block calls occur per pass; further
eligible slots are deferred, not dropped. Their durable polls remain and they
are reconsidered on a later pass. Candidates from the same slot share one
block response.

Block reads are sequential to avoid a burst of identical RPC methods. There
is no immediate retry inside the pass. The recurring scheduler supplies the
next bounded retry.

## Canonical block proof

The pinned adapter calls the dedicated web3.js
`Connection.getBlockSignatures(slot, 'finalized')`, which maps to the official
Solana `getBlock` RPC with `transactionDetails: 'signatures'` and no rewards.
It returns only a bounded, immutable signature list to the application.

Only this result proves orphaning:

```text
status is null from provider P
AND same-provider missing threshold is reached
AND finalizedRoot(P) > transaction slot
AND finalized block for the exact slot is available from P
AND the block does not contain the transaction signature
```

The following never prove orphaning:

- `getTransaction` returns null;
- finalized root is equal to the transaction slot;
- `getBlock` or `getBlockSignatures` returns null or rejects;
- the provider reports a skipped, unavailable or pruned block;
- the signature array is malformed, sparse, oversized or duplicated;
- the status and available block contradict each other.

When a missing status is followed by a block containing the signature, the
reconciler raises a fixed `finality-contradiction`. Missing, pruned or otherwise
unavailable block evidence raises a fixed `block` stage. Both paths fail
closed, enqueue no orphan for that slot and leave the recurring component
`DEGRADED` until a coherent pass succeeds.

No `getFirstAvailableBlock` or `minimumLedgerSlot` call is made on the nominal
path. Those calls add quota but cannot strengthen a positive canonical block
proof.

The implementation follows the official Solana contracts for
[`getSignatureStatuses`](https://solana.com/docs/rpc/http/getsignaturestatuses),
[`getSlot`](https://solana.com/docs/rpc/http/getslot), and
[`getBlock`](https://solana.com/docs/rpc/http/getblock).

## Crash and concurrency semantics

- Crash before a poll commit writes no new evidence.
- Crash after a missing poll but before block proof leaves the provider/count
  durable; the next same-provider pass may continue, while another provider
  starts again at one.
- Crash after block proof but before orphan enqueue writes no revision; the
  next pass must obtain a fresh root and block proof.
- Crash after orphan enqueue is handled by the existing durable `PENDING`
  worker replay.
- A lost database response is safe because orphan replay is idempotent.
- Two process replicas may duplicate RPC reads, but exact provider/count/status
  preconditions prevent a stale pass from mixing or overwriting evidence.
- A finalized/orphaned terminal contradiction remains rejected by the
  existing monotonic confirmation domain.

No process-local proof cache survives a pass or restart. Only the positional
provider behind consecutive misses is durable.

## Error handling and redaction

The reconciler retains fixed stage errors and adds `pass` and `block` stages.
It never attaches a cause. Provider adapter failures expose only a fixed
reason and positional provider ID. Structured logs and public projections
must not contain endpoints or raw RPC data.

An empty candidate page opens no pass and performs no RPC work. Malformed
dependencies, hostile arrays, proxies, accessors, invalid provider IDs,
unsafe slots and unsafe integer limits fail before durable mutation.

## Production activation boundary

Unlike the inactive strict catch-up foundation delivered by #60, finality is
already active in production. Issue #61 therefore replaces only its unsafe
source with a primary-pinned pass. The legacy WebSocket subscriber, startup
scanner, heartbeat schema and supervisor behavior remain unchanged.

Issue #63 will provide the active promoted provider to `openPass`. It must not
reintroduce the general request-level failover client at this boundary. Until
then, primary finality unavailability is visible as `DEGRADED` and never causes
cross-provider orphaning.

## Migration and rollout

Migration 027 is additive and replayable on a database at migration 026 or on
an empty database. Because old binaries do not write the new provider column,
the rollout must stop old listener replicas before applying 027 and starting
the new binary. If an old replica remains, the new constraint rejects its
unsafe positive counter write and therefore fails closed.

All migration manifests, deployment smoke lists and tests that assert the last
migration must advance from 026 to 027. No existing transaction, event,
projection or terminal retention row is deleted.

## Test matrix

### Domain and unit tests

- frozen provider-aware candidates, observations and revision union;
- count/provider correlation and invalid positional IDs;
- same-provider increments and provider-switch reset to one;
- exact expected provider/count CAS and ABA rejection;
- status present resets count/provider without status regression;
- status/root/block calls use one captured provider pass;
- finalized status, equal root, higher root and mismatched slots;
- one block read per slot and sixteen-slot deferral;
- signature absent, signature present contradiction and malformed arrays;
- unavailable/pruned/null block degrades without orphan revision;
- stale orphan proof rejected after status reset or provider switch;
- empty page performs no RPC work;
- 256 candidates accepted and larger limits rejected.

### Provider adapter tests

- catalog resolved once and one RPC instance created;
- status, root and every block use that exact instance;
- no failover transport import or fallback request;
- exact `getSignatureStatuses`, finalized slot and dedicated finalized block
  signature calls;
- fixed redacted failures for 429, network, malformed and hostile responses;
- immutable bounded signature lists.

### PostgreSQL and recovery tests

- migration 027 on empty schema and after migration 026;
- legacy positive counter reset and direct migration replay;
- SQL correlation constraint and allowed provider IDs;
- same-provider increment, switch reset and provider-aware CAS conflict;
- conditional orphan enqueue with stale count, provider and status variants;
- response-lost idempotent replay;
- crash/restart after each poll/proof/revision boundary;
- finalized and orphaned worker replay remains idempotent;
- every counter reset path clears the provider;
- full migration runner replay reports no new migration on its second run.

### Delivery gates

- `npm install` from the committed lockfile;
- `npm run build`;
- `npm run check`;
- `npm run lint`;
- `npm run docs:check`;
- `npm test` with live PostgreSQL coverage;
- migration 027 replay on a fresh database;
- no wallet, signer, submission or live execution capability;
- GitHub CI green and no blocking review thread after at most three cycles.

## Non-goals

- Activating the acknowledged WebSocket supervisor; this is issue #63.
- Extending public heartbeat/API/frontend health; this is issue #62.
- Retrying a failed provider inside one finality pass.
- Quorum or majority voting across providers.
- Persisting raw blocks, URLs or provider responses.
- Changing confirmed projection replay behavior.
- Running Mainnet paper validation issue #49.

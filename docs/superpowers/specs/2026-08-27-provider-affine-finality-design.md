# Provider-affine Solana finality design

Date: 2026-08-27
Issue: #61
Parent issue: #57
Version: 1.0.5
Status: approved through the standing instruction to use the recommended option

Revision 1.0.5 closes the replay-to-paper race. Paper claim, snapshot,
materialization and position opening require every relevant raw source through
the decision cursor to have a processed, confirmation-aligned inbox replay.
The transactional guards are bounded and hold inbox share locks through paper
commit. A genuine confirmed-to-finalized revision may saturate an already
maximum evidence version without overflowing PostgreSQL `BIGINT`.

Revision 1.0.4 makes the initial finality pass a runtime activation barrier.
The paper worker cannot start, schedule immediate work or persist simulated
effects until the reconciler's initial coherent pass succeeds.

Revision 1.0.3 prevents permanent-block starvation by continuing sequential
slot proofs after a block-stage failure, rotates bounded pages by durable poll
attempt time, and permits startup retry only in observe mode. Paper startup
fails closed so simulation cannot continue without an initial finality pass.

Revision 1.0.2 bounds evidence versions to signed PostgreSQL `BIGINT` and
requires the reconciler to reject a repository result unless its version is
exactly the prior version plus one.

Revision 1.0.1 adds a monotone durable finality-evidence generation. Exact
provider/count/status checks alone permit an ABA where those visible values
leave and later return to the same tuple, so every evidence mutation now
invalidates all earlier orphan proofs permanently.

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

Migration `027_listener_provider_affine_finality.sql` adds two columns to
`chain_transaction_inbox`:

```sql
last_missing_finality_provider_id TEXT
finality_evidence_version BIGINT NOT NULL DEFAULT 0
```

The allowed durable states are:

```text
missing_finality_polls = 0  <=> last_missing_finality_provider_id IS NULL
missing_finality_polls > 0  =>  provider is primary or fallback-1..3
finality_evidence_version >= 0
```

The maximum version is `9_223_372_036_854_775_807`, the positive signed
PostgreSQL `BIGINT` limit. Domain validation rejects values outside this range.
Reaching the limit fails closed instead of wrapping or accepting another poll.

Existing positive counters have no trustworthy provenance because they may
already combine request-level failover responses. The migration resets only
rows with a positive counter and a null provider to `0/NULL`. This is a
fail-closed invalidation of unsafe evidence, not deletion of a transaction or
projection. Replaying migration 027 leaves new valid sequences untouched.

Migration 027 replayably replaces `chain_transaction_inbox_finality_idx` with
the same partial predicate and key `(updated_at, observed_slot, signature)`.
`listForFinality` uses that exact order. Every successful poll advances
`updated_at` to the greatest of its current value, the supplied `observedAt`
and PostgreSQL `clock_timestamp()`. Database time prevents an application
clock behind the database from leaving a permanently failing candidate at the
front of every bounded page; the polled row rotates behind older attempts.

The domain contracts become:

```ts
export interface FinalityCandidate {
  readonly signature: string;
  readonly slot: bigint;
  readonly confirmationStatus: 'processed' | 'confirmed';
  readonly missingFinalityPolls: number;
  readonly lastMissingFinalityProviderId: RpcProviderId | null;
  readonly finalityEvidenceVersion: bigint;
  readonly processedAtMs: number;
}

export interface FinalityPollObservation {
  readonly signature: string;
  readonly confirmationStatus: 'processed' | 'confirmed' | null;
  readonly providerId: RpcProviderId;
  readonly expectedMissingFinalityPolls: number;
  readonly expectedLastMissingFinalityProviderId: RpcProviderId | null;
  readonly expectedFinalityEvidenceVersion: bigint;
  readonly observedAtMs: number;
}
```

`FinalityRevision` becomes a discriminated union. The `finalized` branch keeps
its existing shape. The `orphaned` branch also carries the exact expected
pre-terminal confirmation status, missing counter, last missing provider and
post-poll evidence version. These fields are internal evidence preconditions
and are not added to public API responses.

Every inbox write that records a poll, accepts another durable notification,
clears or replaces missing evidence, or enqueues a terminal revision increments
`finality_evidence_version` in the same statement. An existing-row notification
also clears the missing sequence because it is fresh evidence that the
transaction exists. Every write that clears `missing_finality_polls` also
clears `last_missing_finality_provider_id`.

## Poll transitions and compare-and-swap

`recordFinalityPoll` locks the signature row and compares the expected count,
provider and evidence version. The provider prevents confusing simultaneous
same-count observations; the monotone version prevents a true ABA where a
later sequence returns to the same visible provider/count tuple.

```text
missing + same provider       -> count + 1, same provider
missing + different provider  -> count 1, current pass provider
processed/confirmed present   -> count 0, provider null
every successful transition   -> evidence version + 1
```

The reconciler treats repository output as hostile. After every poll it
requires the returned version to equal the candidate version plus exactly one,
in addition to the existing identity, status, provider and counter checks.
An unchanged, regressive, skipped or overflowing version is a fixed poll-stage
failure and cannot reach block proof or revision enqueue.

An observed `processed` status never regresses a durable `confirmed` status.
The existing behavior where a polled `processed -> confirmed` promotion does
not replay projections remains unchanged; that adjacent behavior is outside
issue #61.

Before a real transition to `orphaned`, `enqueueRevision` locks the row and
requires all of the following to remain exact:

- processing status is `PROCESSED`;
- target confirmation is the expected `processed` or `confirmed` value;
- missing counter equals the post-poll counter;
- last missing provider equals the current pass provider;
- evidence version equals the post-poll monotone version.

A status observation, provider switch, competing poll, duplicate durable
notification or competing revision increments the version and permanently
invalidates the proof. Repeating the same visible provider/count/status tuple
does not restore an old version. A stale enqueue returns the existing fixed
finality conflict, and the reconciler remains `DEGRADED` until a later pass
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
   provider and exact expected provider/count/version CAS.
6. Consider only returned missing candidates whose same-provider count has
   reached the configured threshold and whose slot is strictly below the
   same-provider finalized root.
7. Group eligible candidates by slot. Read each finalized block at most once,
   in deterministic slot order, for at most sixteen unique slots per pass.
8. For null, rejected or malformed block evidence, remember the first fixed
   `block` failure, enqueue no orphan for that slot, and continue sequentially
   with later slots inside the same sixteen-slot budget.
9. For every valid block, validate the complete signature set before enqueuing
   any orphan revisions for that slot. If every eligible signature is absent,
   enqueue each orphan revision with its exact durable proof precondition.
10. After the slot loop, throw the remembered first `block` failure so the
    recurring component remains `DEGRADED`. A later `finality-contradiction`
    or `revision` failure may still abort immediately.

The official `getSignatureStatuses` contract accepts at most 256 signatures,
so `MAX_FINALITY_RECONCILE_LIMIT` becomes 256. The current production page of
100 remains valid. At most sixteen unique block calls occur per pass; further
eligible slots are deferred, not dropped. Their durable polls remain and they
are reconsidered on a later pass. Candidates from the same slot share one
block response.

Block reads are sequential to avoid a burst of identical RPC methods. A bad
slot is never absence evidence and never orphaned, but it cannot prevent valid
later slots from receiving durable revisions. There is no immediate retry
inside the pass. In observe mode the recurring scheduler supplies the next
bounded retry.

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
unavailable block evidence records a fixed `block` stage. The reconciler
continues later slots sequentially, then throws the first recorded block
failure after the bounded loop. The affected slot remains nonterminal while
valid earlier and later slots may commit orphan revisions. A contradiction may
retain immediate failure. Every path fails closed for the affected slot and
leaves the recurring component `DEGRADED` until a coherent pass succeeds.

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
- Two process replicas may duplicate RPC reads, but exact
  provider/count/status/version preconditions prevent a stale pass from
  mixing or overwriting evidence.
- A provider/count tuple may repeat after any number of switches or resets,
  but its strictly greater evidence version can never satisfy an old proof.
- A finalized/orphaned terminal contradiction remains rejected by the
  existing monotonic confirmation domain.

No process-local proof cache survives a pass or restart. The positional
provider behind consecutive misses and its monotone evidence generation are
durable.

## Paper replay barrier

Paper decisions must never consume raw projections while a finality revision
is waiting for inbox replay. For a paper source, the relevant set is the
mandatory `source_raw_event_id` plus every non-orphaned raw row for the same
mint whose full cursor `(slot, transaction_index, instruction_index,
COALESCE(inner_instruction_index, -1))` is not later than the source cursor.
Confirmed rows remain eligible; the barrier does not require global
finalization.

Claim uses a fail-fast predicate: every relevant signature must already have
an inbox row with `processing_status = 'PROCESSED'` and
`target_confirmation_status` exactly equal to the raw confirmation status.
Missing, `PENDING`, `PROCESSING`, `FAILED` or misaligned inbox state prevents
election. Claim is only an optimization, not the safety guarantee.

The reusable transactional barrier reads at most 4,097 relevant raw rows and
fails closed above 4,096. It then locks the distinct inbox signatures in
lexical order with a separate `FOR SHARE` query and revalidates presence,
processing state and confirmation alignment. Paper snapshot and every decision
materialization call this barrier while holding the qualification transaction
lock. `PaperTradingEngine.open` repeats it after validating the exact current
qualification and holds the share locks until the position transaction
commits. Therefore finality wins first and paper retries, or paper wins first
and `enqueueRevision` waits; the later replay can then retract the paper
lineage. Barrier failures are fixed and redacted and become bounded retryable
paper failures, never terminal decisions.

At `MAX_FINALITY_EVIDENCE_VERSION`, missing polls and orphan proofs remain
rejected without mutation. A real `PROCESSED/confirmed` to
`PENDING/finalized` transition is still permitted: its SQL `CASE` increments
only below the maximum and otherwise preserves the maximum. Replay and the
terminal finalized idempotence path keep that saturated value unchanged; no
`LEAST(version + 1, max)` expression may evaluate an overflowing addition.

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
then, primary finality unavailability never causes cross-provider orphaning.
`RecurringFinalityReconciler` defaults to
`initialFailureMode: 'FAIL_START'`. Production selects `DEGRADED_RETRY` only
for `executionMode === 'observe'`: the first failure resolves startup in
`DEGRADED`, schedules exactly one normal interval, and a successful fresh pass
restores `RUNNING`. Paper mode selects `FAIL_START`: the first failure is
rethrown and no interval is scheduled. The listener starts the reconciler
after the inbox worker but before the paper and social workers, so paper cannot
schedule its immediate run while initial finality is pending. On initial
failure the paper worker was never started and therefore needs no compensating
close; only earlier subscriber/inbox resources are rolled back. In observe
mode, `DEGRADED_RETRY` resolves the initial call before later workers start, so
observe keeps its retry behavior. Scheduled failures after a successful start
remain `DEGRADED` and retry on the next normal interval.

## Migration and rollout

Migration 027 is replayable on a database at migration 026 or on an empty
database. It adds the evidence columns and replaces the partial finality index
before the new binary starts. Because old binaries do not write the new
provider column, the rollout must stop old listener replicas before applying
027 and starting the new binary. If an old replica remains, the new constraint
rejects its unsafe positive counter write and therefore fails closed.

All migration manifests, deployment smoke lists and tests that assert the last
migration must advance from 026 to 027. No existing transaction, event,
projection or terminal retention row is deleted.

## Test matrix

### Domain and unit tests

- frozen provider-aware candidates, evidence versions, observations and
  revision union;
- count/provider correlation and invalid positional IDs;
- same-provider increments and provider-switch reset to one;
- exact expected provider/count/version CAS and true ABA rejection after a
  switch away and back to the same tuple;
- hostile repository poll results with unchanged, regressive, skipped or
  overflowing evidence versions;
- status present resets count/provider without status regression;
- status/root/block calls use one captured provider pass;
- finalized status, equal root, higher root and mismatched slots;
- one block read per slot and sixteen-slot deferral;
- a bad middle block leaves that slot nonterminal, permits valid later slot
  revisions, and produces the fixed block failure after the loop;
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
- finality index definition uses `(updated_at, observed_slot, signature)` and
  direct migration replay preserves it;
- polling the first row of a page advances it with database time and exposes a
  previously out-of-page candidate on the next bounded read;
- legacy positive counter reset and direct migration replay;
- SQL correlation constraint and allowed provider IDs;
- same-provider increment, switch reset and provider-aware CAS conflict;
- conditional orphan enqueue with stale count, provider, status and evidence
  version variants;
- response-lost idempotent replay;
- crash/restart after each poll/proof/revision boundary;
- finalized and orphaned worker replay remains idempotent;
- every counter reset path clears the provider;
- full migration runner replay reports no new migration on its second run;
- observe startup degradation schedules one fresh pass and can recover;
- initial finality pending prevents `paperWorker.start`, then success releases
  paper activation;
- default/paper startup rejects without a schedule, never starts or closes the
  paper worker, and rolls back only resources started before finality.

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

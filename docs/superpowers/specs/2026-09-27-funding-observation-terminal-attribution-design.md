# Funding Observation Terminal Attribution

Date: 2026-09-27

Issue: #185

Status: approved for implementation

Contract revision: 1.0.0

## Context

The exact Mainnet observe-only probe on `main@ca65ffb` retained
`ObservedPipelineFailure.v1.funding_observation.UNKNOWN` failures until the
configured fifth attempt. The current durable error correctly remains
retryable, but its terminal evidence cannot distinguish the trusted
`validate`, `extract`, and `record` boundaries of
`WalletEvidenceObservationService`.

An empty or unavailable funding result is already normal data. An exception at
one of these boundaries is not equivalent to missing evidence. This change
attributes the boundary only. It does not infer the underlying business,
provider, data, or persistence cause.

## Decision

Extend the existing exact-identity terminal-attribution sidecar with three
stable diagnostic codes:

- `FUNDING_OBSERVATION_VALIDATE`;
- `FUNDING_OBSERVATION_EXTRACT`;
- `FUNDING_OBSERVATION_RECORD`.

Each code uses `causeKind: null` and `pumpWire: null`. The public
`WalletEvidenceObservationError` constructor remains untrusted. Only the
service's private boundary factory may register one of these diagnostics on the
exact wrapper identity it has just created.

The factory must preserve `error.cause === cause` and must not read the cause's
name, message, code, prototype, properties, proxy traps, or cause chain. A
lookalike object, clone, subclass, proxy, revoked proxy, or directly constructed
`WalletEvidenceObservationError` carries no authority.

## Preserved runtime contract

The observed-pipeline durable failure remains exactly:

```text
code       = PIPELINE_STAGE_FAILED
errorName  = ObservedPipelineFailure.v1.funding_observation.UNKNOWN
retryable  = true
```

Consequently this change does not alter retry count, delay, exhaustion,
qualification, wallet graph behavior, or transaction-inbox outcome. The
existing sidecar propagation copies the trusted diagnostic to the frozen
failure, and the existing worker adds the transaction locator before recording
the attempt.

Successful extraction, an empty buy set, `NO_EVIDENCE`, and `UNAVAILABLE`
results remain successful data paths and create no terminal attribution.

## Persistence and versioning

Migration `058_transaction_inbox_funding_attribution.sql` extends only the
closed diagnostic-code constraint installed by migration 057. It must:

- upgrade an exact 057 definition atomically;
- be replayable as a no-op against its own exact definition;
- fail closed with SQLSTATE `23514` on absent, duplicated, or drifted state;
- preserve all columns, indexes, rows, grants, retention, and journal behavior.

Migration 057 is immutable. Tests that exercise 057 replay must stop at 057;
new tests then apply and replay 058. The execution migration catalog and every
deployment head assertion move to 058.

`TerminalAttributionV1` and `mainnet-terminal-attribution.v1` keep revision 1:
their shape is unchanged and their closed vocabulary gains three values. Older
readers reject the new values rather than producing a false pass.

## Security and failure semantics

- No error text, raw cause, RPC URL, header, credential, or private data is
  persisted or serialized.
- Only exact identities registered at the trusted boundary are accepted.
- Journal insertion remains contained by the existing savepoint and incomplete
  marker. A code/schema rollout mismatch remains visible and fail-closed.
- The canary continues to fail on exhausted retries. Attribution completeness
  cannot turn a terminal operational failure into success.
- No wallet, signer, transaction submission, scheduler, RPC pacing, retry, or
  execution-mode change belongs to this issue.

## Probe and causal follow-up

After merge and green post-merge CI, run a short Mainnet observe-only probe and
capture the existing owner-only terminal-attribution artifact. Group the
funding occurrences by the three new codes. A separate causal issue or PR may
change validation, extraction, or persistence only after the probe identifies
the boundary and a local reproduction proves the concrete cause.

## Acceptance

- all three boundaries have exact-identity and hostile-object tests;
- durable failure and retryability are byte-for-byte unchanged;
- all three diagnostics persist and appear in deterministic capture output;
- migration 058 installs, upgrades, replays, and rejects drift correctly;
- canary tests preserve exhaustion and fail-closed behavior;
- focused PostgreSQL tests, build, check, lint, and docs pass;
- at most two review cycles and no Mainnet RPC, wallet, signer, or order during
  implementation.

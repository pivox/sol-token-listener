# Event-attested opaque Pump instruction suffixes — v1.0.0

## Scope and authority

Issue213 follows the capacity/evidence fixes of120/140. Standing user approval
covers recommended technical design decisions, versioned before code. One
combined delivery review. Observation only: no signer, construction, execution,
fee model, RPC policy, finality policy or paper quote allowlist changes.

Two existing normalized Mainnet fixtures contain finalized, successful Pump
instructions rejected by the current strict Borsh decoder:

- create_v2 at slot452406478 / transaction78:105 total bytes, required-prefix
  remainder exactly0001. One CreateEvent and an initial BUY in the same transaction.
- sell at slot452406531 / transaction460:26 total bytes, required-prefix
  remainder exactly0100. One matching Sell TradeEvent.

Use fixture provenance and a content digest in the fixture documentation; no new
RPC capture is needed. Do not rewrite historical canary evidence.

Committed normalized fixture integrity (SHA-256 of the exact JSON bytes):

- `tests/fixtures/pumpfun/create-v2-opaque-holder-mainnet.json`:
  `54bec0d729caf29089d4d5e5d34b05a79484eb16e7f3b2b24952d45695d2a449`.
- `tests/fixtures/pumpfun/sell-opaque-volume-mainnet.json`:
  `a4c29ca77e89a533411b38a56b9dc1e97570db10abf86cb6d7381e4f95870ed6`.

Official IDL inspected at pump-fun/pump-public-docs commit
e0687ae9b7e064a0f54efc7297c65eecfbba3a8f (2026-09-12): create_v2 declares
optional cashback, creator_fee_bps and holder_reward; sell declares two u64s.
Official HOLDER_REWARDS_README states that trade instructions do not change.
The official SDK2.0.0 emits the full ten-byte creation suffix. These authorities
do not establish a standalone interpretation of either observed two-byte suffix.

Sources:
- https://github.com/pump-fun/pump-public-docs/blob/e0687ae9b7e064a0f54efc7297c65eecfbba3a8f/idl/pump.json
- https://github.com/pump-fun/pump-public-docs/blob/main/docs/HOLDER_REWARDS_README.md

An offline experiment inserting eight zero bytes before the final creation byte,
or removing the sell suffix, passes remaining transaction checks. This is only
diagnostic evidence. Production must neither rewrite bytes nor claim those
synthetic instructions were observed.

## Alternatives and decision

1. Recommended: transaction-only, event-attested opaque compatibility for two
   exact observed profiles. Retain the official decoder and all existing checks.
2. Globally permit two-byte suffixes: rejected; it invents wire semantics and
   accepts unproven variants without transaction evidence.
3. Keep quarantining until an official standalone layout is published: safest
   parser-only policy but loses already authenticated observations indefinitely.
   It remains the behavior for every form outside these two bounded profiles.

## Candidate boundary

Keep decodePumpInstruction strict: the original fixtures continue to fail when
decoded as standalone instructions. Introduce a separately typed transaction
candidate, not an already decoded/accepted instruction.

Candidates are recognized only after the official discriminator, unchanged
required-prefix reader and existing account mapping succeed. Exact profiles:

- CREATE_V2_OPAQUE_0001_V1: create_v2, remainder exactly00 01.
- SELL_OPAQUE_0100_V1: sell, remainder exactly01 00.

Required args remain genuinely decoded values: five required creation fields or
the two sell u64s. Do not add cashback, holder_reward, creator_fee_bps or
track_volume args from an event. Preserve the original instruction reference,
bytes, program, accounts and cursor. No generic truncation or trailing-byte skip.
Failure of any other field must not be caught and converted into compatibility.

Transaction decoding uses the current ordered actions/events, stack checks,
unique-event pairing, consumed-event tracking and orphan detection. Candidates
cannot escape as accepted output before event validation. Failed transactions
retain existing empty-result behavior. Processed/confirmed/finalized semantics
remain unchanged; fixture finalization is provenance, not a new decode gate.

## Evidence validation

For both profiles, enforce existing Pump program, Anchor event tag/discriminator,
same action scope and direct-child stack depth, and exactly one matching event.
Additionally require the candidate action event_authority account and the
single CPI authority account to equal the canonical Pump event-authority PDA.
Derive its seed from the official IDL constant __event_authority. Both captured
examples satisfy this check. This new profile-specific check must not be
described as an existing global invariant or proof of normalized signer flags.

Creation retains existing metadata, mint, bonding curve, user, mayhem,
token-program, quote/quote-control and holder-rewards creator-PDA checks.
Its profile also requires the observed event tuple cashback=false,
holderReward=true and effective creatorFeeBps=0. These are event constraints,
not a universal interpretation of0001 or a hard-coded runtime fee schedule.
The requested creator still comes from the actual required instruction prefix;
effective creator and fees still come from the verified event.

Sell retains existing mint, user, direction, token-program and quote checks.
Its profile additionally requires event ix_name exactly sell, trackVolume=false,
and event tokenAmount equal to the decoded amount. The current global validator
does not compare this amount; this is an additional compatibility bound.
Do not infer output net of fees or sellability from this check. min_sol_output
stays decoded and preserved without a new speculative fee/net-output formula.

## Output and provenance

Keep public domain event identities and payloads unchanged. The internal decoded
instruction can carry an optional immutable wireEvidence describing the profile
and paired CPI cursor, clearly distinguishing event-attested opaque compatibility
from normal IDL decoding. Required-prefix-only args are not defaulted options.
Creation output already sources creatorFeeBps/isHolderReward from its event;
keep that contract. No observation/event data is manufactured from the suffix.

The catch-up classifier and launchpad adapter already call transaction decoding;
exercise both consumers without introducing a classifier-only bypass. Existing
multi-quote observation resolves the captured custom quote using TOKEN_2022
balance metadata with6 decimals. SOL/WSOL remains the paper execution allowlist.

## Rejection and tests

Version both normalized fixtures without modifying their chain contents. Preserve
their exact raw bytes and provenance, add digests and the interpretation limits.
TDD tests cover:

1. Strict standalone rejection and full transaction acceptance of both originals.
2. One creation plus initial BUY and one SELL with correct cursors/idempotent IDs.
3. Opaque provenance, original bytes and absent invented optional args.
4. Different/truncated/extended suffixes and malformed required prefixes rejected.
5. Missing, duplicate, ambiguous, orphaned and wrong-scope CPI evidence rejected.
6. Wrong event-authority PDA/account count, program, metadata, user, mint, holder
   PDA, modes, effective fee, trade side/name/amount and quote metadata rejected.
7. Existing official and historical forms unchanged, including inner instructions
   and multiple actions; no new finality restriction or transaction-delta reuse.
8. Classifier/adapter consume the same validated transaction; non-SOL observation
   does not become paper eligibility.
9. Attribution and quarantine still expose typed failures for unsupported forms.

Run targeted tests, build/check/lint/docs and full PostgreSQL-backed suite before
delivery; one combined independent review and green exact-head CI before merge.
The old Mainnet canary remains FAIL. New decoder tests are not capacity evidence;
a fresh bounded observe-only canary and every later readiness gate remain due.

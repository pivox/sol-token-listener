# Configurable Pump.fun Qualification Calibration Design

## Scope

This change introduces one strict, versioned Pump.fun V1 calibration profile.
It configures score weights, required score evidence, blocker enforcement, holder
and wallet-cluster thresholds, and the maximum estimated round-trip loss. It
does not connect qualification to the observation runtime, fetch new chain or
social data, open a paper position, add a public mutation, or change the
secondary Raydium risk path.

The profile remains explicitly `UNVALIDATED_RULE_SET`. Values are hypotheses to
measure during observe and paper dry runs, not claims of safety, sellability, or
profitability.

## Existing boundaries retained

- `QualificationEngine` remains a pure, side-effect-free score and verdict
  engine.
- A blocker remains independent from score. An enforced blocker always yields
  `REJECTED`, including when the score is 100.
- `src/domain/qualification-reasons.ts` remains the stable reason-code registry.
- Existing `RISK_*` settings and `src/security/` continue to serve the legacy
  Raydium diagnostic path. They are not silently reused as Pump.fun policy.
- `EXECUTION_MODE` remains limited to `observe` and `paper`; no profile can
  enable signing, transaction submission, or live execution.

## Configuration source and authority

The repository contains a default profile at
`config/qualification/pumpfun-v1-unvalidated.json`. The application loads that
file unless `QUALIFICATION_PROFILE_PATH` selects another local JSON file.
Profiles are never downloaded over HTTP and are read once during startup.

`QUALIFICATION_MIN_SCORE` remains a backward-compatible optional override. The
override is applied to the validated snapshot before its fingerprint is
computed, so the effective runtime profile is still identifiable. No other
per-field environment override is introduced. `QUALIFICATION_RULE_SET_STATUS`,
when present, must equal `UNVALIDATED_RULE_SET`; another value is rejected.

The effective profile contains:

- `schemaVersion`, fixed to `1`;
- a non-empty bounded `id`;
- a positive safe-integer `version`;
- `status`, fixed to `UNVALIDATED_RULE_SET`;
- `minimumTotalScore`, from 0 through 100;
- the three exact dimension maxima, 15, 25, and 60;
- score rules;
- one policy entry for every stable blocker reason code;
- a lowercase SHA-256 fingerprint of its canonical validated snapshot.

The JSON file is bounded to 64 KiB. Parsing accepts only exact plain JSON
objects and dense arrays, rejects unknown or duplicate semantic fields, and
uses typed redacted errors. Error output never includes file content, an
absolute path, an RPC endpoint, or environment values.

## Score model

Score rules retain the existing fields:

- stable signal key;
- dimension;
- non-negative safe-integer weight;
- `required` flag;
- bounded human message.

Signals may occur only once. Rule weights must total exactly 15 for
`preparation`, 25 for `socialAuthenticity`, and 60 for `onchainHealth`.
Unknown evidence contributes zero points. A required rule that is not
`SATISFIED` prevents `QUALIFIED`, but it does not invent a blocker.

The initial score distribution remains behavior-compatible:

- `imageValid`: preparation 15, required;
- `socialCrossLinkConfirmed`: social authenticity 25, required;
- `creatorHasNotSold`: on-chain health 20, required;
- `reverseQuoteAvailable`: on-chain health 20, optional;
- `externalBuyersObserved`: on-chain health 20, optional.

The remaining registered signals stay available to future profiles but cannot
be added with a total that violates a dimension maximum.

## Blocker policies

Every stable reason code has one policy mode:

- `DISABLED`: the condition is documented but neither evaluated nor enforced;
- `REPORT_ONLY`: observed values and a triggered result are reported, but never
  added to `blockers`;
- `ENFORCED`: a triggered condition is added to `blockers` and forces
  `REJECTED`.

Changing a mode changes the effective profile fingerprint and versioned report.
No score or required-evidence rule can override an `ENFORCED` condition.

The default profile keeps current externally supplied critical reason codes
enforced, except that history-dependent and not-yet-calibrated policies are
explicitly non-enforcing:

- `CREATOR_REPEAT_DUMPER` is `DISABLED`, because V1 does not load creator
  history;
- social mismatch and impersonation policies are `REPORT_ONLY` until public
  social evidence is implemented;
- `METADATA_FETCH_FAILED` is `REPORT_ONLY`, because metadata is a preparation
  signal and its absence cannot alone establish an on-chain critical risk;
- holder and related-wallet cluster policies are `REPORT_ONLY` for dry-run
  calibration;
- all other stable safety reason codes are `ENFORCED` when their upstream
  evidence explicitly triggers them.

An unknown condition is never converted into a trigger. Missing evidence stays
`UNKNOWN`; required score evidence then keeps the verdict at `WATCHLISTED`.

## Numeric calibration facts

A new pure calibration evaluator accepts an immutable facts object. Financial
and concentration facts use `bigint` basis points in the domain. JSON profile
thresholds are validated safe integers from 0 through 10,000 and converted to
`bigint` before comparison.

Supported V1 facts are:

- top 1, top 5, and top 10 observed-holder concentration;
- maximum observed related-wallet cluster concentration;
- maximum shared-funder count in an observed cluster;
- whether a buy simulation succeeded when one was attempted;
- whether a reverse sell quote is available;
- estimated round-trip loss;
- explicit reason codes already produced by trusted upstream analyzers.

The holder policy has three nullable maxima. A non-null observed value above
any configured maximum triggers `HOLDER_CONCENTRATION_EXCEEDED`. Null thresholds
collect measurements but produce `NOT_CONFIGURED`, never a blocker.

The cluster policy has a nullable maximum concentration and a positive
shared-funder threshold. Exceeding the configured concentration triggers
`RELATED_WALLET_CLUSTER_EXCEEDED`; reaching the configured funder threshold
triggers `SHARED_FUNDER_CLUSTER`. The default concentration maximum is null and
both policies are `REPORT_ONLY`, so PR 4 cannot change a production verdict from
cluster evidence.

The round-trip policy uses `maximumLossBps = 3000`, preserving the existing
non-validated operational hypothesis. Loss strictly greater than the maximum
triggers `ROUND_TRIP_LOSS_EXCEEDED`; equality passes. An unavailable reverse
quote triggers `SELL_QUOTE_UNAVAILABLE`. Missing quote or loss evidence stays
unknown instead of claiming sellability.

Buy simulation, reverse quote, and round-trip loss remain separate conditions.
Passing one never implies that another passed.

## Explainable output

The engine report adds the effective profile fingerprint and a frozen
`conditions` array. Each condition contains:

- stable reason code;
- configured mode;
- status: `PASSED`, `TRIGGERED`, `UNKNOWN`, `NOT_CONFIGURED`, or `DISABLED`;
- observed integer values, serialized as decimal strings at JSON boundaries;
- configured thresholds, also serialized as decimal strings;
- a bounded human message.

Only triggered `ENFORCED` conditions appear in `blockers`. Triggered
`REPORT_ONLY` conditions remain visible in `conditions`. The report snapshots
all effective values; mutating the source object or changing a file later cannot
alter an existing report.

The API change is additive. `GET /api/v1/launches/:mint/risk` continues to read
old retained `QualificationUpdated` payloads that lack `fingerprint` or
`conditions`; it exposes conservative empty/unknown compatibility values for
those payloads. New reports expose the additional fields. No SQL migration is
needed because qualification payloads are retained as versioned JSONB domain
events.

## Loading and application startup

The loader validates and freezes the complete profile before database, listener,
or API startup. A malformed profile fails startup with a fixed typed error. The
foundation log includes only profile id, version, status, and fingerprint; it
never logs the selected path or raw JSON.

`createQualificationEngine` receives the effective profile rather than building
hard-coded rules internally. Importing the engine module performs no profile or
filesystem load. Unit fixtures can explicitly call the lazy default-profile
factory, which uses the same validated bundled profile and prevents two
divergent defaults.

The production observation pipeline remains unchanged in this PR. Runtime
assembly and persistence of live `QualificationUpdated` events belong to the
later end-to-end qualification/paper-validation work.

## Build and packaging

The default JSON profile is copied into the build output with deterministic
bytes. A build check fails if the bundled source profile is missing, malformed,
or differs from the generated/copied artifact. Running from TypeScript sources
and from `dist` resolves the same default profile contents.

## Testing

Tests cover:

- strict parsing, size limits, exact keys, integer bounds, duplicate rules, and
  complete reason-code coverage;
- exact 15/25/60 score totals and backward-compatible initial verdicts;
- stable canonical fingerprints across key-order changes and different
  fingerprints for effective overrides;
- deep immutable snapshots and hostile/mutable input rejection;
- `DISABLED`, `REPORT_ONLY`, and `ENFORCED` behavior;
- blocker priority over a 100 score;
- holder top 1/5/10 boundary equality and exceedance;
- cluster concentration and shared-funder boundaries;
- reverse quote and round-trip separation, including exact 3,000 bps;
- unknown and not-configured evidence without false safety claims;
- backward-compatible API projection of old payloads and additive new payloads;
- startup failure redaction and safe structured foundation logs;
- source/build profile parity and absence of signing or submission imports;
- all existing Raydium, Pump.fun, PumpSwap, API, paper, retry, migration, and
  PostgreSQL tests.

## Acceptance criteria

- One effective Pump.fun profile is identifiable by id, version, status, and
  fingerprint.
- Invalid configuration fails before network or database startup.
- Scores remain separate from blockers and preserve exact 15/25/60 maxima.
- Dry-run holder and cluster observations cannot reject a token by default.
- Enforced sell-quote and round-trip triggers cannot be compensated by score.
- Every comparison uses integer or `bigint` values; no JavaScript financial
  float is introduced.
- Existing Raydium configuration and behavior do not change.
- Observe mode remains the default and no real transaction path is added.
- `npm run build`, `npm run check`, `npm run lint`, `npm run docs:check`, and the
  complete PostgreSQL-backed test suite pass.

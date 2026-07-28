# PR A — Foundation Design

## Objective

Turn the incomplete merged Raydium skeleton into a deterministic, strict TypeScript
foundation that can be extended with Pump.fun without enabling real execution.
PR A does not decode Pump.fun transactions and does not change Raydium decoding
semantics.

## Product decisions

- The only V1 execution modes are `observe` and `paper`; `observe` is the default.
- No private key is accepted or required.
- Observation is multi-quote. Paper trading is initially restricted to SOL through
  a quote-mint allowlist.
- Creator history before launch detection is out of scope.
- Social verification V1 only uses public evidence and returns
  `VERIFICATION_UNKNOWN` when evidence cannot be collected.
- Data becomes eligible for deletion after the tracked launch is terminal and no
  paper position remains open. It is retained for four additional hours.
- The future HTTP/SSE API is public and read-only.
- Qualification thresholds are versioned and configurable. The first rule set is
  explicitly marked `UNVALIDATED_RULE_SET`.

## Boundaries

The domain owns source-independent values and ports. Concrete programs live behind
adapters:

```text
domain <- ports <- application <- adapters
                              <- interfaces
bootstrap imports all concrete adapters
```

`LaunchpadAdapter` handles pre-migration launch activity and curve state.
`MarketAdapter` handles post-migration pools and quotes. Pump.fun, PumpSwap, and
Raydium implementations may not import one another.

## PR A scope

PR A restores:

- a lockfile, strict TypeScript, linting, test and migration commands;
- safe environment parsing with `observe` as the default;
- source-independent chain cursors, amounts, launch and market contracts;
- the missing types and support modules required by the existing Raydium fixtures;
- PostgreSQL migration execution with transactional, repeatable migrations;
- an observation-only bootstrap that never loads a signer;
- architecture and safety documentation.

The existing Raydium decoder, classifier, risk checks, fixtures, and diagnostic
dashboard remain in the repository. Legacy transaction-building code may compile
but is not reachable from the V1 bootstrap.

## Persistence

`001_initial.sql` remains replayable to preserve the merged schema. PR A adds
foundation tables for raw/domain events, state transitions, and retention
eligibility without deleting legacy Raydium tables. Financial integers use
`NUMERIC(78,0)`.

## Safety invariant

No code reachable from `src/app.ts` imports a signer, transaction confirmer, or
send-transaction gateway. A boundary test enforces this invariant. Paper code may
construct or quote an unsigned transaction for simulation, but may never sign or
submit it.

## Verification

The branch is acceptable only when:

```text
npm install
npm run build
npm run check
npm run lint
npm test
npm run db:migrate (against an empty PostgreSQL database)
```

The unit suite must not require a private key, a paid API, or an external RPC.

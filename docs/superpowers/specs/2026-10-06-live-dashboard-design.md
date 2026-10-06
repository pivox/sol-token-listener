# Live dashboard — design

Date: 2026-10-06
Status: approved in conversation, pending written review

## Problem

The operator console (`frontend/`) only shows paper positions. Live trading (executor-live and
executor-live-recovery) keeps its state in `execution_*` tables that the public API deliberately cannot
read (`sol_token_public_api` has no grant; see `2026-08-30-executor-v1-design.md` §13-14: a future operator
surface must be authenticated and separate). In addition:

- closed `execution_live_positions` rows and their `execution_reconciliation_evidence` are purged 4 h after
  close, so there is no durable history or realized PnL;
- `execution_wallet_snapshots` is only written by readiness and arming, never while trading, so it is not a
  current balance.

The operator wants one page with the wallet balance, open positions, realized and unrealized PnL, and the
history of closed positions.

## Goal

A read-only `/live` console page fed by a separate, token-authenticated operator API process, plus a durable
ledger of closed live positions written by the recovery runtime when it closes a position. Simplest path that
reuses existing machinery.

Non-goals: Docker Compose service / nginx proxy for the operator API (run by hand for now), backfilling
positions already purged, SSE, any write route, the config page (separate design; it will reuse the operator
token mechanism).

## Backend

### 1. Durable ledger — migration `061_execution_live_position_ledger.sql`

Table `execution_live_position_ledger`, append-only, never purged, rows immutable (trigger in the style of
the other `execution_*` tables):

| Column | Content |
|---|---|
| `position_id` TEXT PK | `execution_live_positions.position_id` (no FK: the position row is purged) |
| `wallet_public_key`, `mint` | from the position |
| `opened_at`, `closed_at` | from the position |
| `base_amount_raw` | tokens bought |
| `entry_wallet_lamport_delta` | BUY `execution_reconciliation_evidence.wallet_lamport_delta` (negative) |
| `exit_wallet_lamport_delta` | SELL evidence `wallet_lamport_delta` (positive, or negative if the sell cost more than it returned) |
| `net_lamports` | `entry + exit` (CHECK enforces the sum) |
| `entry_signature`, `exit_signature` | evidence signatures, for explorer links |
| `recorded_at` | insert time |

`wallet_lamport_delta` is the fee payer's native balance change computed from the finalized transaction
(fees and rent included), so `net_lamports` is the real SOL result of the round trip.

Writer: `commitSellReconciliation` (`src/storage/execution-live.repository.ts`) inserts the row in the same
transaction that sets the position `CLOSED`, reading the BUY evidence through
`execution_live_positions.entry_reconciliation_fingerprint` and the SELL evidence it has just written. Both
evidence rows exist at that point (holding time ≤ 15 min, evidence purge 4 h after finalization). The insert is
idempotent on `position_id` (`ON CONFLICT DO NOTHING`) so a replayed reconciliation cannot fail. No executor
computation changes.

### 2. Database privileges — `scripts/provision-executor-roles.sql`

- `sol_token_executor_live_recovery`: `INSERT` on the ledger.
- `sol_token_operator_reader`: `SELECT` on the ledger; column-level `SELECT` on `execution_live_positions`
  (`position_id, wallet_public_key, mint, quote_mint, quote_cost_raw, base_amount_raw, remaining_base_raw,
  fee_lamports, opened_at, exit_deadline_at, state, closed_at`); `SELECT` on `bonding_curve_snapshots`,
  `market_pools`, `market_reserve_snapshots`.
- Nothing new for `sol_token_public_api`, `sol_token_listener_writer` or any other role; the ledger is added to
  the existing REVOKE lists for them. Existing role tests keep passing; new assertions cover the new grants.

### 3. Operator API process — `src/operator-api/`

New entrypoint `src/operator-api/main.ts`, scripts `operator:api:dev` / `operator:api:start`.

Environment (validated at start, process exits on error):

| Variable | Rule |
|---|---|
| `OPERATOR_API_DATABASE_URL` | login member only of `sol_token_operator_reader` |
| `OPERATOR_API_TOKEN` | ≥ 32 characters |
| `OPERATOR_API_HOST` / `OPERATOR_API_PORT` | default `127.0.0.1` / `3100` |
| `OPERATOR_API_ALLOWED_ORIGIN` | exact console origin for CORS, e.g. `http://127.0.0.1:4173` |
| `SOLANA_HTTP_RPC_URL` | used only for `getBalance` |

No keypair, live-mode, arming or write-capable variable is read. This is an eighth environment boundary
("operator console": operator reader + HTTP RPC), documented in `docs/operations/executor-live-canary.md`.

HTTP rules: only `GET` and `OPTIONS`; `Host` must be `OPERATOR_API_HOST:OPERATOR_API_PORT` (DNS rebinding);
`Authorization: Bearer <token>` compared with `timingSafeEqual` on every `GET` (401 otherwise); CORS headers
only for `OPERATOR_API_ALLOWED_ORIGIN`, allowing the `Authorization` header; JSON envelope identical to the
public API (`apiVersion`, `meta.generatedAt`, `meta.nextCursor`, `data`).

Single route `GET /operator/v1/live/overview?limit=&cursor=`:

| Field | Source |
|---|---|
| `wallet` | `wallet_public_key` of the active (`retired_at IS NULL`) `execution_wallet_generations` row; `availability: NOT_AVAILABLE` when there is none |
| `balance` | `{ lamports, observedAt }` from `getBalance(wallet)`, cached 15 s in memory, single-flight; on RPC failure the last known value, else `null` |
| `open[]` | positions in state `OPEN`, `EXIT_PENDING` or `UNKNOWN` for that wallet |
| `history[]` | ledger rows for that wallet, newest `closed_at` first; next page cursor in `meta.nextCursor` |
| `totals` | `realizedLamports` (sum of ledger `net_lamports`), `unrealizedLamports` (sum of non-null open values), `openCount`, `positionsWithoutPnl` (open positions without a spot price) |

Each open position: `positionId`, `mint`, `state`, `openedAt`,
`exitDeadlineAt`, `remainingRaw`, `costLamports` (`quote_cost_raw + fee_lamports`), `spotValueLamports`,
`unrealizedLamports` (`spot value − cost`).

Each closed position: `positionId`, `mint`, `openedAt`, `closedAt`, `entrySignature`,
`exitSignature`, `realizedLamports` (`net_lamports`).

Spot price, in raw quote per raw base, computed with `bigint` and rounded down: latest non-orphaned PumpSwap
reserve snapshot of a pool of the mint (`effective_quote_reserves_raw / base_reserves_raw`) when one exists,
otherwise the latest bonding curve **virtual** reserves. It is an indicative mid price (no slippage, no fees);
`null` when no market data exists. All amounts are decimal strings.

Architecture tests: the operator API import graph cannot reach `src/executor-live*`, `src/execution/`, keypair
loading or any `INSERT/UPDATE/DELETE` SQL; it serves no method other than GET/OPTIONS.

## Frontend

- `public/config.json` gains optional `operatorApiBaseUrl` (absolute HTTP(S) URL, same validation rules as
  `apiBaseUrl`). Without it `/live` shows "Surface opérateur non configurée".
- New route `/live`, link "Live" in the shell between "Radar" and "Positions paper". The shell badge becomes
  route-dependent: "Simulation" elsewhere, "Live · lecture seule" on `/live`.
- `/live` asks once for the operator token and keeps it in `sessionStorage` (cleared when the tab closes), with
  a "Oublier le token" button; a 401 clears it and shows the prompt again with an error.
- A small `operator-client.ts` (same request/size/timeout handling as `api-client.ts`, plus the
  `Authorization` header), a Zod schema, and one TanStack infinite query (`refetchInterval: 15_000`): KPIs and
  open positions from the first page, history from every page.
- Page: KPI row (balance with observation time, realized PnL, unrealized PnL "indicatif, prix spot", open
  count), open positions table (token link to `/launches/:mint`, state, remaining, cost, spot value,
  unrealized SOL and %, exit deadline), history table (opened, closed, realized PnL, Solscan links for both
  signatures), "Charger plus". Lamports formatted as SOL with `bigint`, never `number`.

## Error handling

| Case | Behaviour |
|---|---|
| No `operatorApiBaseUrl` | "Surface opérateur non configurée" |
| No token / 401 | token prompt (with "Token refusé" after a 401) |
| No active wallet generation | "Aucun wallet live actif" |
| RPC balance failure | last value with its age, or "indisponible"; rest of the page unaffected |
| No spot price | PnL cells "non disponible"; totals show "N positions exclues" |
| Network / contract error | existing `ErrorState` |

## Testing

Backend:
- Migration: ledger table, immutability trigger, `net_lamports` check (Postgres tests with `TEST_DATABASE_URL`).
- `commitSellReconciliation`: closing a position writes exactly one ledger row with both deltas and signatures;
  replay does not duplicate it (Postgres test).
- Provisioning: new grants present; ledger revoked from public API / listener roles; recovery role has
  INSERT only.
- Operator API: token, Host, CORS and method checks; NOT_AVAILABLE without active generation; balance cache;
  PnL and spot assembly with a fake `Queryable`; history cursor; architecture boundary test.

Frontend (Vitest + MSW):
- Operator client (header, 401 mapping), schema, page states (not configured, token prompt, 401, nominal,
  no wallet, unknown balance/spot, "Charger plus"), shell link and badge.

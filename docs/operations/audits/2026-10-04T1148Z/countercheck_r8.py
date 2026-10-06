#!/usr/bin/env python3
"""Offline, read-only countercheck of r8 from original canary JSONL files.

No RPC, database, environment file, wallet, or first-pass analysis module is read.
Amounts remain integer lamports; USD conversion uses Decimal only for reporting.
"""

from __future__ import annotations

import json
from collections import Counter
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "evidence" / "2026-10-04-mainnet-microtrade-r8"
LAMPORTS = 1_000_000_000


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    for line_no, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_no}: malformed JSON: {exc}") from exc
    return rows


def analyze(root: Path = ROOT) -> dict:
    trades = []
    all_events = Counter()
    canary_log_comparisons = []
    discovered = []
    for wave_dir in sorted(root.glob("wave-*")):
        wave = int(wave_dir.name.split("-")[1])
        sniff = wave_dir / "sniff.jsonl"
        if sniff.exists():
            discovered.extend(r["mint"] for r in read_jsonl(sniff) if r.get("event") == "pumpfun_create")
        source = wave_dir / "canary.jsonl"
        if not source.exists():
            continue
        rows = read_jsonl(source)
        all_events.update(r.get("event", "<missing>") for r in rows)
        runner = wave_dir / "canary-runner.log"
        if runner.exists():
            # The process log contains a non-JSON startup line; compare its
            # parseable event records with the clean original canary file.
            runner_rows = []
            for line in runner.read_text().splitlines():
                try:
                    runner_rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            canary_log_comparisons.append({
                "wave": wave,
                "original_rows": len(rows),
                "runner_json_rows": len(runner_rows),
                "identical_json_records": rows == runner_rows,
            })
        get = lambda name: next((r for r in rows if r.get("event") == name), None)
        pre = get("preflight")
        buy = get("buy_confirmed")
        sell = get("sell_confirmed")
        opened = get("position_open")
        quote = get("sell_quote")
        result = get("sell_result")
        complete = get("complete")
        if not all((pre, buy, sell, opened, quote, result, complete)):
            trades.append({"wave": wave, "incomplete": True, "events": dict(Counter(r.get("event") for r in rows))})
            continue
        buy_delta = int(buy["walletBalanceAfterLamports"]) - int(buy["walletBalanceBeforeLamports"])
        sell_delta = int(sell["walletBalanceAfterLamports"]) - int(sell["walletBalanceBeforeLamports"])
        # Position contribution, before any assumption about the closing ATA rent.
        cash_trade_delta = buy_delta + sell_delta
        rent_at_open = int(opened["tokenAccountRentLamports"])
        fee_total = int(buy["feeLamports"]) + int(sell["feeLamports"])
        quote_gap = sell_delta + int(sell["feeLamports"]) - int(quote["expectedLamports"])
        rate = Decimal(str(pre["krakenSolUsdt"]))
        native_with_open_rent = cash_trade_delta + rent_at_open
        buy_economic_cost = int(opened["buyEconomicCostLamports"])
        progress = [r for r in rows if r.get("event") == "price_progress"]
        # Rebuild the logged net estimate from raw whole-position sell quote,
        # recorded economic BUY cost, and the configured 50,000-lamport reserve.
        net_marks = [(int(r["expectedSellQuoteLamports"]) - buy_economic_cost - 50_000, int(r["elapsedSeconds"])) for r in progress]
        first_positive = next((elapsed for amount, elapsed in net_marks if amount >= 0), None)
        first_target = next((r for r in rows if r.get("event") == "profit_target_reached"), None)
        trades.append({
            "wave": wave,
            "mint": pre["mint"],
            "buy_signature": buy["signature"],
            "sell_signature": sell["signature"],
            "buy_slot": buy.get("slot"),
            "sell_slot": sell.get("slot"),
            "wallet_buy_delta_lamports": buy_delta,
            "wallet_sell_delta_lamports": sell_delta,
            "cash_trade_delta_lamports": cash_trade_delta,
            "rent_observed_at_open_lamports": rent_at_open,
            "pnl_assuming_rent_persists_lamports": native_with_open_rent,
            "meta_fee_fields_sum_lamports_included_in_wallet_deltas": fee_total,
            "sell_quote_lamports": int(quote["expectedLamports"]),
            "sell_quote_to_wallet_gap_lamports": quote_gap,
            "remaining_token_raw_reported": result["remainingTokenRaw"],
            "exit_reason": complete["exitReason"],
            "rate_sol_usdt_from_preflight": str(rate),
            "pnl_usdt_if_open_rent_persists": str(Decimal(native_with_open_rent) / LAMPORTS * rate),
            "first_progress_elapsed_seconds": next((r.get("elapsedSeconds") for r in rows if r.get("event") == "price_progress"), None),
            "progress_count": sum(r.get("event") == "price_progress" for r in rows),
            "profit_trigger_count": sum(r.get("event") == "profit_target_reached" for r in rows),
            "first_observed_net_mark_lamports": net_marks[0][0] if net_marks else None,
            "minimum_observed_net_mark_lamports": min((x[0] for x in net_marks), default=None),
            "minimum_observed_elapsed_seconds": min(net_marks, default=(None, None))[1] if net_marks else None,
            "maximum_observed_net_mark_lamports": max((x[0] for x in net_marks), default=None),
            "maximum_observed_elapsed_seconds": max(net_marks, key=lambda x: x[0])[1] if net_marks else None,
            "first_observation_at_or_above_net_breakeven_seconds": first_positive,
            "first_profit_target_event_local_time": first_target.get("at") if first_target else None,
            "first_profit_target_quote_lamports": int(first_target["expectedSellQuoteLamports"]) if first_target else None,
            "first_profit_target_required_lamports": int(first_target["requiredSellQuoteLamports"]) if first_target else None,
        })

    status = json.loads((root / "status.json").read_text())
    completed = [t for t in trades if not t.get("incomplete")]
    first_preflight = read_jsonl(root / "wave-001/canary.jsonl")[0]
    cash_delta_session = int(status["walletLamports"]) - int(first_preflight["initialWalletLamports"])
    open_rents = sum(t["rent_observed_at_open_lamports"] for t in completed)
    tx_fees = sum(t["meta_fee_fields_sum_lamports_included_in_wallet_deltas"] for t in completed)
    per_trade_cash = sum(t["cash_trade_delta_lamports"] for t in completed)
    per_trade_native = sum(t["pnl_assuming_rent_persists_lamports"] for t in completed)
    status_usdt = Decimal(str(status["estimatedEconomicPnlUsdt"]))
    weighted_entry_usdt = sum((Decimal(t["pnl_usdt_if_open_rent_persists"]) for t in completed), Decimal(0))
    # Session's independent implementation reads each ATA after sale. The status
    # PnL can be inverted approximately to infer the post-sale rent actually used.
    inferred_end_rent = None
    if status_usdt == weighted_entry_usdt:
        inferred_end_rent = open_rents
    return {
        "wave_dirs_with_canary": len(completed),
        "events": dict(all_events),
        "canary_vs_runner_log": canary_log_comparisons,
        "creates_count": len(discovered),
        "unique_create_mints": len(set(discovered)),
        "duplicate_create_rows": len(discovered) - len(set(discovered)),
        "status": {key: status.get(key) for key in ("waves", "observed", "buys", "sells", "failed", "estimatedEconomicPnlUsdt", "walletLamports", "lastError")},
        "wallet_start_lamports": int(first_preflight["initialWalletLamports"]),
        "wallet_end_lamports": int(status["walletLamports"]),
        "wallet_cash_delta_lamports": cash_delta_session,
        "sum_per_trade_cash_deltas_lamports": per_trade_cash,
        "sum_open_ata_rents_lamports": open_rents,
        "sum_transaction_fee_fields_lamports_already_inside_balance_deltas": tx_fees,
        "native_result_if_open_rent_persists_lamports": cash_delta_session + open_rents,
        "position_sum_if_open_rent_persists_lamports": per_trade_native,
        "cash_ledger_vs_trade_cash_sum_gap_lamports": cash_delta_session - per_trade_cash,
        "status_pnl_matches_entry_rate_conversion_exactly": status_usdt == weighted_entry_usdt,
        "status_pnl_usdt_as_decimal": str(status_usdt),
        "sum_trade_pnl_usdt_using_open_rent": str(weighted_entry_usdt),
        "inferred_ending_rent_only_if_status_round_trip_matches": inferred_end_rent,
        "trades": completed,
    }


if __name__ == "__main__":
    print(json.dumps(analyze(), indent=2, ensure_ascii=False))

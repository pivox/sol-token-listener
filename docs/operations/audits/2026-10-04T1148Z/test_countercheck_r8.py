import unittest
from decimal import Decimal

from countercheck_r8 import analyze


class IndependentRawEvidenceTests(unittest.TestCase):
    def test_original_canary_files_match_runner_copies(self):
        result = analyze()
        self.assertEqual(len(result["canary_vs_runner_log"]), 6)
        self.assertTrue(all(x["identical_json_records"] for x in result["canary_vs_runner_log"]))

    def test_session_wallet_delta_is_independently_rebuilt_from_original_files(self):
        result = analyze()
        self.assertEqual(result["creates_count"], 135)
        self.assertEqual(result["unique_create_mints"], 135)
        self.assertEqual(result["wallet_cash_delta_lamports"], -17_922_159)
        self.assertEqual(result["sum_per_trade_cash_deltas_lamports"], -17_922_159)

    def test_fees_are_reported_as_included_in_wallet_deltas_and_not_subtracted_twice(self):
        result = analyze()
        self.assertEqual(result["sum_transaction_fee_fields_lamports_already_inside_balance_deltas"], 540_000)
        # This is a label/invariant: cash delta is raw pre/post wallet change.
        # Adding a separate fee deduction would change this independent amount.
        self.assertEqual(result["native_result_if_open_rent_persists_lamports"], -8_839_119)

    def test_status_result_is_consistent_with_session_post_sale_ata_reconciliation(self):
        result = analyze()
        self.assertTrue(result["status_pnl_matches_entry_rate_conversion_exactly"])
        self.assertEqual(result["inferred_ending_rent_only_if_status_round_trip_matches"], 9_083_040)
        self.assertEqual(result["position_sum_if_open_rent_persists_lamports"], -8_839_119)

    def test_2uc_sell_quote_gap_is_preserved_as_unknown_source(self):
        result = analyze()
        trade = next(t for t in result["trades"] if t["wave"] == 4)
        self.assertEqual(trade["sell_quote_to_wallet_gap_lamports"], 629_160)
        self.assertEqual(trade["remaining_token_raw_reported"], "0")

    def test_independent_whole_position_net_marks_match_the_claimed_initial_losses(self):
        result = analyze()
        self.assertTrue(all(t["first_observed_net_mark_lamports"] < 0 for t in result["trades"]))
        self.assertEqual(sum(t["first_observed_net_mark_lamports"] for t in result["trades"]), -3_312_170)
        self.assertEqual(sum(t["first_observation_at_or_above_net_breakeven_seconds"] is not None for t in result["trades"]), 1)
        winner = next(t for t in result["trades"] if t["wave"] == 3)
        self.assertEqual(winner["first_observation_at_or_above_net_breakeven_seconds"], 16)
        self.assertGreater(winner["first_profit_target_quote_lamports"], winner["first_profit_target_required_lamports"])


if __name__ == "__main__":
    unittest.main()

"""Tests for explainable hybrid ranking after strict filters."""

import unittest

from dishly_retrieval.models import SearchRequest
from dishly_retrieval.ranking import (
    calculate_structured_score,
    numeric_range_score,
    rank_recipes,
)
from tests.helpers import make_recipe


class RankingTests(unittest.TestCase):
    """Prove ranking is approximate, stable, and cuisine-first."""

    def test_numeric_ranges_reward_inside_and_decay_outside(self) -> None:
        self.assertEqual(numeric_range_score(50, 40, 60), 1.0)
        self.assertEqual(numeric_range_score(20, 40, None), 0.5)
        self.assertEqual(numeric_range_score(100, None, 50), 0.5)
        self.assertIsNone(numeric_range_score(None, 40, 60))
        self.assertIsNone(numeric_range_score(50, None, None))

    def test_structured_score_explains_matches(self) -> None:
        recipe = make_recipe("1", cuisine="thai", protein_grams=50, calories=500)
        request = SearchRequest(
            raw_query="Thai dinner with 50g protein",
            preferred_cuisines=("thai",),
            preferred_meal_type="dinner",
            min_protein_g=45,
            max_protein_g=55,
            max_calories=600,
        )
        score, cuisine_tier, reasons = calculate_structured_score(recipe, request)
        self.assertEqual(score, 1.0)
        self.assertEqual(cuisine_tier, 1.0)
        self.assertIn("Thai cuisine match", reasons)
        self.assertIn("Meets protein target", reasons)

    def test_requested_cuisine_outranks_unrelated_high_semantic_score(self) -> None:
        thai = make_recipe("1", cuisine="thai")
        italian = make_recipe("2", cuisine="italian")
        request = SearchRequest(raw_query="Thai dinner", preferred_cuisines=("thai",))
        ranked = rank_recipes([italian, thai], request, {"1": 0.1, "2": 1.0})
        self.assertEqual(ranked[0].recipe, thai)

    def test_semantic_score_breaks_ties_with_match_reason(self) -> None:
        first = make_recipe("1")
        second = make_recipe("2")
        request = SearchRequest(raw_query="tomato dinner")
        ranked = rank_recipes([first, second], request, {"1": 0.7, "2": 0.2})
        self.assertEqual(ranked[0].recipe.id, "1")
        self.assertIn("Strong semantic match", ranked[0].score.reasons)

    def test_scores_are_clamped_and_ties_are_stable(self) -> None:
        first = make_recipe("1")
        second = make_recipe("2")
        ranked = rank_recipes(
            [first, second], SearchRequest(raw_query="dinner"), {"1": -4, "2": -4}
        )
        self.assertEqual([item.recipe.id for item in ranked], ["1", "2"])
        self.assertEqual(ranked[0].score.semantic, 0.0)

    def test_unknown_nutrition_earns_no_false_bonus(self) -> None:
        recipe = make_recipe("1", protein_grams=None)
        request = SearchRequest(raw_query="50g protein", min_protein_g=50)
        score, _tier, reasons = calculate_structured_score(recipe, request)
        self.assertEqual(score, 0.0)
        self.assertNotIn("Meets protein target", reasons)


if __name__ == "__main__":
    unittest.main()

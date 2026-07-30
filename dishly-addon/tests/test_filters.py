"""Behaviour tests for strict safety and category filtering."""

import unittest

from dishly_retrieval.allergens import (
    detect_allergens,
    detect_non_vegan_ingredients,
    ingredient_contains_term,
    normalize_allergen,
)
from dishly_retrieval.filters import filter_eligible_recipes, filter_exact_candidates
from dishly_retrieval.models import SearchRequest
from tests.helpers import make_recipe


class EligibilityTests(unittest.TestCase):
    """Prove hard rules run before approximate ranking."""

    def test_allergen_aliases_and_word_boundaries(self) -> None:
        self.assertEqual(normalize_allergen("Tree Nuts"), "tree_nut")
        self.assertEqual(normalize_allergen("Peanuts"), "peanut")
        self.assertTrue(ingredient_contains_term("2 tbsp peanut butter", "peanut"))
        self.assertFalse(ingredient_contains_term("1 cup coconut milk", "nut"))

    def test_detects_ingredient_allergens_even_when_not_declared(self) -> None:
        detected = detect_allergens(("tofu", "tahini", "whole wheat bread"))
        self.assertEqual(detected, frozenset({"soy", "sesame", "gluten"}))

    def test_detects_non_vegan_evidence(self) -> None:
        detected = detect_non_vegan_ingredients(("1 tbsp honey", "2 eggs"))
        self.assertEqual(detected, frozenset({"honey", "egg"}))

    def test_plant_milks_and_nut_butters_are_not_misclassified_as_dairy(self) -> None:
        ingredients = ("1 cup almond milk", "2 tablespoons peanut butter")
        self.assertEqual(detect_allergens(ingredients), frozenset({"tree_nut", "peanut"}))
        self.assertEqual(detect_non_vegan_ingredients(ingredients), frozenset())

    def test_allergy_and_custom_ingredient_are_never_relaxed(self) -> None:
        peanut = make_recipe("1", ingredients=("peanut butter",), allergens=("peanut",))
        mushroom = make_recipe("2", ingredients=("mushrooms",))
        safe = make_recipe("3")
        request = SearchRequest(
            raw_query="dinner without peanuts or mushrooms",
            excluded_allergens=frozenset({"peanuts"}),
            excluded_ingredients=frozenset({"mushroom"}),
        )
        self.assertEqual(filter_eligible_recipes([peanut, mushroom, safe], request), [safe])

    def test_vegan_and_swipe_are_hard_filters(self) -> None:
        vegan = make_recipe("1", vegan=True)
        meat = make_recipe("2", vegan=False)
        request = SearchRequest(
            raw_query="vegan dinner",
            require_vegan=True,
            excluded_recipe_ids=frozenset({"1"}),
        )
        self.assertEqual(filter_eligible_recipes([vegan, meat], request), [])

    def test_exact_mode_requires_requested_cuisine_and_meal(self) -> None:
        thai_dinner = make_recipe("1", cuisine="thai", meal_type="dinner")
        thai_breakfast = make_recipe("2", cuisine="thai", meal_type="breakfast")
        italian_dinner = make_recipe("3", cuisine="italian", meal_type="dinner")
        request = SearchRequest(
            raw_query="Thai dinner",
            preferred_cuisines=("thai",),
            preferred_meal_type="dinner",
        )
        self.assertEqual(
            filter_exact_candidates([thai_dinner, thai_breakfast, italian_dinner], request),
            [thai_dinner],
        )

    def test_broad_asian_request_accepts_specific_asian_cuisines(self) -> None:
        recipes = [make_recipe("1", cuisine="japanese"), make_recipe("2", cuisine="french")]
        request = SearchRequest(raw_query="Asian food", preferred_cuisines=("asian",))
        self.assertEqual(filter_exact_candidates(recipes, request), [recipes[0]])


if __name__ == "__main__":
    unittest.main()

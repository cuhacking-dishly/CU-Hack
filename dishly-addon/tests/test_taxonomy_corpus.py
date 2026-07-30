"""Tests for cuisine taxonomy and deterministic embedding documents."""

import unittest

from dishly_retrieval.corpus import build_recipe_document, corpus_checksum
from dishly_retrieval.taxonomy import (
    best_cuisine_match,
    canonical_meal_type,
    cuisine_match_strength,
    meal_type_matches,
)
from tests.helpers import make_recipe


class TaxonomyAndCorpusTests(unittest.TestCase):
    def test_cuisine_alias_groups_and_unrelated_values(self) -> None:
        self.assertEqual(cuisine_match_strength("Thai", "thai"), 1.0)
        self.assertEqual(cuisine_match_strength("Japanese", "Asian"), 0.8)
        self.assertGreater(cuisine_match_strength("Tex-Mex", "Mexican"), 0)
        self.assertEqual(cuisine_match_strength("French", "Asian"), 0.0)
        self.assertEqual(best_cuisine_match("Thai", ()), 1.0)

    def test_meal_aliases_are_canonical(self) -> None:
        self.assertEqual(canonical_meal_type("Main Course"), "dinner")
        self.assertTrue(meal_type_matches("breakfast", "brunch"))
        self.assertFalse(meal_type_matches("dessert", "dinner"))

    def test_embedding_document_contains_retrieval_fields(self) -> None:
        document = build_recipe_document(make_recipe(cuisine="thai", vegan=True))
        self.assertIn("cuisine: thai", document)
        self.assertIn("vegan: yes", document)
        self.assertIn("ingredients:", document)

    def test_checksum_changes_with_semantic_content_but_is_stable(self) -> None:
        original = [make_recipe("1")]
        changed = [make_recipe("1", description="A different semantic description")]
        self.assertEqual(corpus_checksum(original), corpus_checksum(original))
        self.assertNotEqual(corpus_checksum(original), corpus_checksum(changed))


if __name__ == "__main__":
    unittest.main()

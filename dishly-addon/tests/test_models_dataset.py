"""Validation tests for immutable requests and the approved corpus format."""

import json
import tempfile
import unittest
from pathlib import Path

from dishly_retrieval.dataset import (
    DatasetValidationError,
    canonicalize_url,
    is_public_http_url,
    load_recipes,
    save_recipes,
    validate_and_build_recipe,
)
from dishly_retrieval.models import SearchRequest
from tests.helpers import make_recipe, make_record


class SearchRequestTests(unittest.TestCase):
    def test_semantic_query_prefers_parsed_soft_query(self) -> None:
        request = SearchRequest(raw_query="raw dinner", query="  Asian high protein ")
        self.assertEqual(request.semantic_query, "Asian high protein")

    def test_invalid_limits_ranges_and_query_are_rejected(self) -> None:
        invalid_arguments = (
            {"raw_query": ""},
            {"raw_query": "dinner", "limit": 0},
            {"raw_query": "dinner", "offset": -1},
            {"raw_query": "dinner", "match_mode": "loose"},
            {"raw_query": "dinner", "min_calories": 500, "max_calories": 400},
            {"raw_query": "dinner", "min_protein_g": float("nan")},
            {"raw_query": "dinner", "max_time_minutes": -1},
        )
        for arguments in invalid_arguments:
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                SearchRequest(**arguments)  # type: ignore[arg-type]

    def test_public_recipe_contract_contains_traceability(self) -> None:
        public = make_recipe().to_public_dict(
            match_mode="exact", match_score=0.75, match_reasons=("Italian cuisine match",)
        )
        self.assertEqual(public["sourceUrl"], "https://example.com/recipes/1")
        self.assertEqual(public["nutritionBasis"], "per serving")
        self.assertEqual(public["matchMode"], "exact")
        self.assertEqual(public["matchReasons"], ["Italian cuisine match"])


class DatasetTests(unittest.TestCase):
    def test_valid_record_builds_immutable_recipe(self) -> None:
        recipe = validate_and_build_recipe(make_record(), 1)
        self.assertEqual(recipe.ingredients, ("1 cup tomatoes", "1 tablespoon olive oil"))

    def test_rejects_unverified_small_or_private_images(self) -> None:
        cases = [
            {"image_quality_verified": False},
            {"image_width": 499},
            {"image_url": "http://127.0.0.1/image.jpg"},
        ]
        for overrides in cases:
            record = make_record()
            record.update(overrides)
            with self.subTest(overrides=overrides), self.assertRaises(DatasetValidationError):
                validate_and_build_recipe(record, 1)

    def test_rejects_invalid_field_shapes_and_values(self) -> None:
        cases = [
            {"id": "01"},
            {"id": "9007199254740992"},
            {"title": " "},
            {"vegan": "yes"},
            {"image_quality_verified": "yes"},
            {"ingredients": []},
            {"allergens": "none"},
            {"protein_grams": -1},
            {"time_minutes": 2.5},
            {"image_width": None},
            {"source_verified_at": "17-07-2026"},
            {"nutrition_basis": "sometimes"},
        ]
        for overrides in cases:
            record = make_record()
            record.update(overrides)
            with self.subTest(overrides=overrides), self.assertRaises(DatasetValidationError):
                validate_and_build_recipe(record, 1)

    def test_rejects_missing_allergen_declaration(self) -> None:
        record = make_record(ingredients=("2 tablespoons peanut butter",))
        with self.assertRaisesRegex(DatasetValidationError, "omit ingredient evidence"):
            validate_and_build_recipe(record, 1)

    def test_rejects_false_vegan_classification(self) -> None:
        record = make_record(
            vegan=True,
            ingredients=("1 tablespoon honey",),
        )
        with self.assertRaisesRegex(DatasetValidationError, "marked vegan"):
            validate_and_build_recipe(record, 1)

    def test_load_rejects_duplicate_ids_and_sources(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recipes.json"
            first = make_record("1")
            second = make_record("1", source_url="https://example.com/another")
            path.write_text(
                json.dumps({"schema_version": 1, "recipes": [first, second]}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(DatasetValidationError, "Duplicate recipe id"):
                load_recipes(path)

            second["id"] = "2"
            second["source_url"] = first["source_url"] + "/"
            path.write_text(
                json.dumps({"schema_version": 1, "recipes": [first, second]}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(DatasetValidationError, "Duplicate recipe source"):
                load_recipes(path)

    def test_save_and_load_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recipes.json"
            recipes = [make_recipe("1"), make_recipe("2")]
            save_recipes(path, recipes)
            self.assertEqual(load_recipes(path), recipes)

    def test_invalid_document_errors_are_actionable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recipes.json"
            with self.assertRaisesRegex(DatasetValidationError, "not found"):
                load_recipes(path)
            path.write_text("{", encoding="utf-8")
            with self.assertRaisesRegex(DatasetValidationError, "not valid JSON"):
                load_recipes(path)
            path.write_text(json.dumps({"schema_version": 99, "recipes": []}), encoding="utf-8")
            with self.assertRaisesRegex(DatasetValidationError, "schema_version"):
                load_recipes(path)
            path.write_text(json.dumps({"schema_version": 1, "recipes": []}), encoding="utf-8")
            with self.assertRaisesRegex(DatasetValidationError, "non-empty"):
                load_recipes(path)
            path.write_text(json.dumps({"schema_version": 1, "recipes": ["bad"]}), encoding="utf-8")
            with self.assertRaisesRegex(DatasetValidationError, "JSON object"):
                load_recipes(path)

    def test_public_url_and_canonicalization_guards(self) -> None:
        self.assertTrue(is_public_http_url("https://example.com/recipe"))
        self.assertFalse(is_public_http_url("file:///recipe"))
        self.assertFalse(is_public_http_url("https://user:pass@example.com/recipe"))
        self.assertFalse(is_public_http_url("http://10.0.0.1/recipe"))
        self.assertEqual(
            canonicalize_url("HTTPS://EXAMPLE.COM/recipe/#fragment"),
            "https://example.com/recipe",
        )


if __name__ == "__main__":
    unittest.main()

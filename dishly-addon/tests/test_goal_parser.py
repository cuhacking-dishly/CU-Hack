"""Unit tests for local structured parsing and its hard-safety overlay."""

import json
import unittest
from unittest.mock import Mock, patch

import httpx
import ollama

from dishly_retrieval.goal_parser import (
    GoalParserError,
    OllamaGoalParser,
    ParsedGoal,
    apply_explicit_constraints,
    extract_explicit_exclusions,
)


def make_parser(response_document: dict[str, object] | None = None) -> OllamaGoalParser:
    """Create a parser whose Ollama transport never leaves the test process."""

    parser = OllamaGoalParser(
        host="http://127.0.0.1:11434",
        model="qwen3:4b-instruct",
        connect_timeout_seconds=1,
        read_timeout_seconds=10,
    )
    parser._client = Mock()  # type: ignore[assignment]
    parser._client.chat.return_value = {  # type: ignore[attr-defined]
        "message": {"content": json.dumps(response_document or {})}
    }
    return parser


class ExplicitConstraintTests(unittest.TestCase):
    def test_user_example_recovers_allergy_vegan_and_numeric_language(self) -> None:
        result = apply_explicit_constraints(
            "Vegan Asian food for dinner with 50g of protein and no peanuts",
            {"cuisines": ["asian"], "mealType": "main course"},
        )
        self.assertEqual(result["diet"], "vegan")
        self.assertEqual(result["cuisines"], ["asian"])
        self.assertEqual(result["mealType"], "main course")
        self.assertEqual(result["minProtein_g"], 50)
        self.assertIn("peanuts", result["excludeIngredients"])
        self.assertIn("peanut", result["intolerances"])

    def test_arbitrary_exclusions_are_deduplicated_without_eating_following_intent(self) -> None:
        text = "Dinner without mushrooms and olives, under 40 minutes; avoid mushrooms"
        self.assertEqual(extract_explicit_exclusions(text), ["mushrooms", "olives"])
        result = apply_explicit_constraints(text, {"excludeIngredients": ["Mushrooms"]})
        self.assertEqual(result["excludeIngredients"], ["Mushrooms", "olives"])
        self.assertEqual(result["maxReadyTime"], 40)

    def test_no_more_than_is_numeric_not_an_ingredient_exclusion(self) -> None:
        text = "Italian dinner with no more than 550 calories"
        self.assertEqual(extract_explicit_exclusions(text), [])

    def test_ungrounded_zeroes_and_schema_leaking_query_are_removed(self) -> None:
        result = apply_explicit_constraints(
            "Vegan Italian lunch under 30 minutes",
            {
                "query": "lunch','cuisines':['italian']",
                "minCalories": 0,
                "minProtein_g": 0,
                "maxReadyTime": 30,
            },
        )
        self.assertNotIn("query", result)
        self.assertNotIn("minCalories", result)
        self.assertNotIn("minProtein_g", result)
        self.assertEqual(result["maxReadyTime"], 30)

    def test_supported_allergen_aliases_are_canonicalized(self) -> None:
        result = apply_explicit_constraints(
            "I am allergic to tree nuts and shrimp but want Thai dinner",
            {"cuisines": ["thai"]},
        )
        self.assertEqual(result["intolerances"], ["tree nut", "shellfish"])


class OllamaGoalParserTests(unittest.TestCase):
    def test_structured_chat_is_bounded_and_validated(self) -> None:
        parser = make_parser(
            {
                "query": "spicy noodles",
                "cuisines": ["asian"],
                "mealType": "main course",
                "intolerances": [],
                "excludeIngredients": [],
            }
        )
        result = parser.parse("Asian spicy noodles for dinner")

        self.assertEqual(result["cuisines"], ["asian"])
        call = parser._client.chat.call_args  # type: ignore[attr-defined]
        self.assertEqual(call.kwargs["model"], "qwen3:4b-instruct")
        self.assertEqual(call.kwargs["format"], ParsedGoal.model_json_schema())
        self.assertEqual(call.kwargs["options"]["temperature"], 0)
        self.assertFalse(call.kwargs["think"])
        self.assertFalse(call.kwargs["stream"])

    def test_invalid_or_empty_model_output_is_rejected(self) -> None:
        parser = make_parser({"diet": "invented"})
        with self.assertRaisesRegex(GoalParserError, "invalid structured"):
            parser.parse("food")

        parser._client.chat.return_value = {"message": {"content": ""}}  # type: ignore[attr-defined]
        with self.assertRaisesRegex(GoalParserError, "empty"):
            parser.parse("food")

    def test_transient_failures_retry_then_succeed(self) -> None:
        parser = make_parser({"diet": "vegan"})
        parser._client.chat.side_effect = [  # type: ignore[attr-defined]
            ollama.ResponseError("busy", status_code=503),
            {"message": {"content": '{"diet":"vegan"}'}},
        ]
        with patch("dishly_retrieval.goal_parser.time.sleep") as sleep:
            self.assertEqual(parser.parse("vegan")["diet"], "vegan")
        sleep.assert_called_once_with(0.25)

    def test_timeout_becomes_stable_retryable_error(self) -> None:
        parser = make_parser()
        parser._client.chat.side_effect = httpx.ReadTimeout("slow")  # type: ignore[attr-defined]
        with (
            patch("dishly_retrieval.goal_parser.time.sleep"),
            self.assertRaises(GoalParserError) as caught,
        ):
            parser.parse("dinner")
        self.assertEqual(caught.exception.code, "OLLAMA_TIMEOUT")
        self.assertTrue(caught.exception.retryable)
        self.assertEqual(parser._client.chat.call_count, 3)  # type: ignore[attr-defined]

    def test_model_digest_and_status_distinguish_ready_missing_and_offline(self) -> None:
        parser = make_parser()
        parser._client.list.return_value = {  # type: ignore[attr-defined]
            "models": [
                {"model": "qwen3:4b-instruct", "digest": "abc123"},
            ]
        }
        self.assertEqual(parser.model_digest(), "abc123")
        self.assertEqual(parser.status().state, "ready")

        parser._client.list.return_value = {"models": []}  # type: ignore[attr-defined]
        self.assertEqual(parser.status().state, "model_missing")

        parser._client.list.side_effect = httpx.ConnectError("offline")  # type: ignore[attr-defined]
        self.assertEqual(parser.status().state, "offline")


if __name__ == "__main__":
    unittest.main()

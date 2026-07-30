"""End-to-end domain and private-HTTP tests with no network dependency."""

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

from dishly_retrieval.api import SearchPayload, create_app
from dishly_retrieval.config import Settings
from dishly_retrieval.embeddings import EmbeddingIndex, EmbeddingServiceError
from dishly_retrieval.goal_parser import ParserStatus
from dishly_retrieval.models import SearchRequest
from dishly_retrieval.retrieval import NO_MATCH_MESSAGE, RetrievalEngine, lexical_similarity
from tests.helpers import make_recipe


class FakeEmbedder:
    model = "embeddinggemma"
    expected_dimension = 2

    def model_digest(self) -> str:
        return "digest"

    def embed(self, _texts: list[str]) -> list[list[float]]:
        return [[1.0, 0.0]]

    def close(self) -> None:
        return None

    def status(self, *, probe: bool = False):
        from dishly_retrieval.embeddings import OllamaStatus

        _ = probe
        return OllamaStatus("model_available", "0.12.0", self.model, "digest", None, "ok")


class FakeGoalParser:
    """Local parser double used to keep private-HTTP tests deterministic."""

    model = "qwen3:4b-instruct"

    def parse(self, _text: str) -> dict[str, object]:
        return {"diet": "vegan", "cuisines": ["asian"]}

    def status(self) -> ParserStatus:
        return ParserStatus("ready", self.model, "parser-digest", "ready")

    def close(self) -> None:
        return None


class RetrievalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.thai = make_recipe("1", cuisine="thai", vegan=True)
        self.italian = make_recipe("2", cuisine="italian", vegan=True)
        self.meat = make_recipe("3", cuisine="thai", vegan=False)

    def test_exact_empty_offers_closest_without_relaxing_safety(self) -> None:
        engine = RetrievalEngine([self.thai, self.italian, self.meat])
        response = engine.search(
            SearchRequest(
                raw_query="French vegan dinner",
                preferred_cuisines=("french",),
                require_vegan=True,
            )
        )
        self.assertEqual(response.recipes, ())
        self.assertTrue(response.can_show_closest)
        self.assertEqual(response.message, NO_MATCH_MESSAGE)

        closest = engine.search(
            SearchRequest(
                raw_query="French vegan dinner",
                preferred_cuisines=("french",),
                require_vegan=True,
                match_mode="closest",
            )
        )
        self.assertEqual({item.recipe.id for item in closest.recipes}, {"1", "2"})
        self.assertNotIn("3", {item.recipe.id for item in closest.recipes})

    def test_no_strict_candidates_does_not_offer_unsafe_fallback(self) -> None:
        response = RetrievalEngine([self.meat]).search(
            SearchRequest(raw_query="vegan", require_vegan=True)
        )
        self.assertFalse(response.can_show_closest)

    def test_lexical_fallback_ranks_and_pages(self) -> None:
        engine = RetrievalEngine([self.thai, self.italian])
        response = engine.search(SearchRequest(raw_query="tomato dinner", limit=1))
        self.assertEqual(len(response.recipes), 1)
        self.assertEqual(response.total_candidates, 2)
        self.assertEqual(response.semantic_provider, "lexical")
        self.assertGreater(lexical_similarity("tomato", "tomato pasta"), 0)
        self.assertEqual(lexical_similarity("", "tomato pasta"), 0)

    def test_compatible_index_uses_ollama_vectors(self) -> None:
        recipes = [self.thai, self.italian]
        from dishly_retrieval.corpus import corpus_checksum

        index = EmbeddingIndex(
            model="embeddinggemma",
            model_digest="digest",
            dimension=2,
            corpus_checksum=corpus_checksum(recipes),
            recipe_ids=("1", "2"),
            vectors=np.asarray([[1, 0], [0, 1]], dtype=np.float32),
        )
        response = RetrievalEngine(
            recipes, embedder=FakeEmbedder(), index=index  # type: ignore[arg-type]
        ).search(SearchRequest(raw_query="Thai dinner"))
        self.assertEqual(response.semantic_provider, "ollama:embeddinggemma")
        self.assertEqual(response.recipes[0].recipe.id, "1")

    def test_get_recipe_and_swipe_exclusion(self) -> None:
        engine = RetrievalEngine([self.thai, self.italian])
        self.assertEqual(engine.get_recipe("1"), self.thai)
        self.assertIsNone(engine.get_recipe("99"))
        response = engine.search(
            SearchRequest(raw_query="dinner", excluded_recipe_ids=frozenset({"1"}))
        )
        self.assertEqual([item.recipe.id for item in response.recipes], ["2"])

    def test_engine_guards_duplicates_and_unconfigured_index_builds(self) -> None:
        duplicate = replace(self.thai, source_url="https://example.com/duplicate")
        with self.assertRaisesRegex(ValueError, "unique"):
            RetrievalEngine([self.thai, duplicate])
        with self.assertRaisesRegex(EmbeddingServiceError, "configuration"):
            RetrievalEngine([self.thai]).build_index()

    def test_build_index_persists_and_readiness_validates_digest(self) -> None:
        from dishly_retrieval.corpus import corpus_checksum

        class BuildEmbedder(FakeEmbedder):
            def embed(self, texts: list[str]) -> list[list[float]]:
                return [[1.0, 0.0] for _text in texts]

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "index.json"
            engine = RetrievalEngine(
                [self.thai],
                embedder=BuildEmbedder(),  # type: ignore[arg-type]
                index_path=path,
            )
            index = engine.build_index()
            self.assertTrue(path.exists())
            self.assertEqual(index.corpus_checksum, corpus_checksum([self.thai]))
            readiness = engine.readiness()
            self.assertTrue(readiness["indexReady"])
            self.assertEqual(readiness["ollama"]["state"], "model_available")  # type: ignore[index]
            engine.close()

    def test_from_settings_loads_corpus_and_ignores_missing_index(self) -> None:
        from dishly_retrieval.dataset import save_recipes

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "recipes.json"
            save_recipes(data, [self.thai])
            settings = Settings(data_path=data, index_path=root / "missing-index.json")
            with patch("dishly_retrieval.retrieval.OllamaEmbeddingClient") as embedder:
                engine = RetrievalEngine.from_settings(settings)
            self.assertEqual(engine.get_recipe("1"), self.thai)
            embedder.assert_called_once()


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = RetrievalEngine([make_recipe("1", cuisine="thai", vegan=True)])
        settings = Settings(
            data_path=Path("unused.json"),
            index_path=Path("unused-index.json"),
        )
        self.client = TestClient(
            create_app(
                settings=settings,
                engine=self.engine,
                goal_parser=FakeGoalParser(),  # type: ignore[arg-type]
            )
        )

    def test_health_ready_search_and_detail_contracts(self) -> None:
        self.assertEqual(self.client.get("/health").status_code, 200)
        ready = self.client.get("/ready")
        self.assertEqual(ready.status_code, 200)
        self.assertEqual(ready.json()["recipeCount"], 1)
        self.assertEqual(ready.json()["parser"]["state"], "ready")

        parsed = self.client.post("/v1/parse-goal", json={"text": "Asian vegan dinner"})
        self.assertEqual(parsed.status_code, 200)
        self.assertEqual(parsed.json()["parsedFilter"]["diet"], "vegan")
        self.assertEqual(parsed.json()["parserProvider"], "ollama:qwen3:4b-instruct")

        search = self.client.post(
            "/v1/search",
            json={
                "raw_query": "Asian vegan dinner",
                "preferred_cuisines": ["asian"],
                "diet": "vegan",
                "limit": 10,
            },
        )
        self.assertEqual(search.status_code, 200)
        self.assertEqual(search.json()["recipes"][0]["id"], "1")
        detail = self.client.get("/v1/recipes/1")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["sourceName"], "Example Kitchen")

    def test_private_service_token_protects_every_non_health_route(self) -> None:
        token = "a-production-strength-service-token"
        settings = Settings(
            data_path=Path("unused.json"),
            index_path=Path("unused-index.json"),
            service_token=token,
        )
        client = TestClient(
            create_app(
                settings=settings,
                engine=self.engine,
                goal_parser=FakeGoalParser(),  # type: ignore[arg-type]
            )
        )

        self.assertEqual(client.get("/health").status_code, 200)
        self.assertEqual(client.get("/ready").status_code, 401)
        self.assertEqual(
            client.get("/ready", headers={"Authorization": "Basic wrong"}).status_code,
            401,
        )
        self.assertEqual(
            client.get("/ready", headers={"Authorization": "Bearer wrong"}).status_code,
            401,
        )
        authorized = {"Authorization": f"Bearer {token}"}
        self.assertEqual(client.get("/ready", headers=authorized).status_code, 200)
        self.assertEqual(
            client.post(
                "/v1/search",
                headers=authorized,
                json={"raw_query": "vegan dinner"},
            ).status_code,
            200,
        )

    def test_contract_rejects_extra_fields_bad_ranges_and_ids(self) -> None:
        cases = [
            {"raw_query": "dinner", "unknown": True},
            {"raw_query": "dinner", "min_calories": 700, "max_calories": 500},
            {"raw_query": "dinner", "excluded_recipe_ids": ["01"]},
        ]
        for body in cases:
            with self.subTest(body=body):
                self.assertEqual(self.client.post("/v1/search", json=body).status_code, 422)

    def test_transport_normalizes_collections_and_vegan_diet(self) -> None:
        payload = SearchPayload(
            raw_query="  vegan noodles  ",
            query=" noodles ",
            preferred_cuisines=[" thai "],
            preferred_meal_type=" dinner ",
            diet=" Vegan ",
            excluded_allergens=[" peanut ", "peanut"],
            excluded_ingredients=[" mushroom "],
            excluded_recipe_ids=["1", "1"],
        )
        request = payload.to_domain()
        self.assertEqual(request.raw_query, "vegan noodles")
        self.assertEqual(request.preferred_cuisines, ("thai",))
        self.assertEqual(request.preferred_meal_type, "dinner")
        self.assertTrue(request.require_vegan)
        self.assertEqual(request.excluded_allergens, frozenset({"peanut"}))
        self.assertEqual(request.excluded_recipe_ids, frozenset({"1"}))

        nullable_query = SearchPayload(raw_query="dinner", query=None).to_domain()
        self.assertEqual(nullable_query.query, "")
        self.assertEqual(nullable_query.semantic_query, "dinner")

    def test_detail_returns_safe_400_and_404(self) -> None:
        self.assertEqual(self.client.get("/v1/recipes/not-a-number").status_code, 400)
        self.assertEqual(self.client.get("/v1/recipes/999").status_code, 404)

    def test_missing_corpus_reports_not_ready(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(
                data_path=Path(directory) / "missing.json",
                index_path=Path(directory) / "index.json",
            )
            client = TestClient(create_app(settings=settings))
            response = client.get("/ready")
            self.assertEqual(response.status_code, 503)
            self.assertFalse(response.json()["ok"])

    def test_engine_failures_are_translated_to_service_unavailable(self) -> None:
        class FailingEngine:
            def readiness(self):
                return {"ok": False}

            def search(self, _request):
                from dishly_retrieval.dataset import DatasetValidationError

                raise DatasetValidationError("corpus changed")

            def get_recipe(self, _recipe_id):
                raise OSError("disk unavailable")

            def close(self):
                return None

        client = TestClient(
            create_app(
                settings=Settings(data_path=Path("unused"), index_path=Path("unused")),
                engine=FailingEngine(),  # type: ignore[arg-type]
                goal_parser=FakeGoalParser(),  # type: ignore[arg-type]
            )
        )
        self.assertEqual(client.get("/ready").status_code, 503)
        self.assertEqual(
            client.post("/v1/search", json={"raw_query": "dinner"}).status_code,
            503,
        )
        self.assertEqual(client.get("/v1/recipes/1").status_code, 503)


if __name__ == "__main__":
    unittest.main()

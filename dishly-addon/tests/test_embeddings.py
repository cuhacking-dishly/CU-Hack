"""Offline tests for vector integrity, cache identity, and Ollama adaptation."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import httpx
import numpy as np
import ollama

from dishly_retrieval.embeddings import (
    EmbeddingIndex,
    EmbeddingServiceError,
    OllamaEmbeddingClient,
    _model_names_match,
    _version_tuple,
)
from tests.helpers import make_recipe


class FakeEmbeddingClient:
    model = "embeddinggemma"
    expected_dimension = 2

    def model_digest(self) -> str:
        return "sha256:test"

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[1.0, float(index + 1)] for index, _text in enumerate(texts)]


class EmbeddingIndexTests(unittest.TestCase):
    def test_build_save_load_compatibility_and_similarity(self) -> None:
        recipes = [make_recipe("1"), make_recipe("2")]
        index = EmbeddingIndex.build(recipes, FakeEmbeddingClient())  # type: ignore[arg-type]
        self.assertTrue(
            index.is_compatible(
                recipes,
                model="embeddinggemma",
                model_digest="sha256:test",
                expected_dimension=2,
            )
        )
        scores = index.similarities([1.0, 1.0])
        self.assertAlmostEqual(scores["1"], 1.0)
        self.assertGreaterEqual(scores["2"], 0.0)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "index.json"
            index.save(path)
            loaded = EmbeddingIndex.load(path)
            self.assertEqual(loaded.recipe_ids, ("1", "2"))
            np.testing.assert_allclose(loaded.vectors, index.vectors)

    def test_stale_or_invalid_index_is_rejected(self) -> None:
        recipes = [make_recipe("1")]
        index = EmbeddingIndex.build(recipes, FakeEmbeddingClient())  # type: ignore[arg-type]
        self.assertFalse(
            index.is_compatible(
                recipes,
                model="different",
                model_digest="sha256:test",
                expected_dimension=2,
            )
        )
        with self.assertRaisesRegex(EmbeddingServiceError, "invalid dimension"):
            index.similarities([1.0])
        with self.assertRaisesRegex(EmbeddingServiceError, "zero vector"):
            index.similarities([0.0, 0.0])

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "index.json"
            with self.assertRaisesRegex(EmbeddingServiceError, "not found"):
                EmbeddingIndex.load(path)
            path.write_text(json.dumps({"schema_version": 1}), encoding="utf-8")
            with self.assertRaisesRegex(EmbeddingServiceError, "invalid structure"):
                EmbeddingIndex.load(path)
            path.write_text("{", encoding="utf-8")
            with self.assertRaisesRegex(EmbeddingServiceError, "not valid JSON"):
                EmbeddingIndex.load(path)


class OllamaClientTests(unittest.TestCase):
    def setUp(self) -> None:
        patcher = patch("dishly_retrieval.embeddings.ollama.Client")
        self.addCleanup(patcher.stop)
        self.client_factory = patcher.start()
        self.transport = Mock()
        self.client_factory.return_value = self.transport
        self.client = OllamaEmbeddingClient(
            host="http://127.0.0.1:11434",
            model="embeddinggemma",
            expected_dimension=3,
            connect_timeout_seconds=1,
            read_timeout_seconds=10,
            batch_size=2,
        )

    def test_batches_and_validates_embed_responses(self) -> None:
        self.transport.embed.side_effect = [
            {"embeddings": [[1, 0, 0], [0, 1, 0]]},
            SimpleNamespace(embeddings=[[0, 0, 1]]),
        ]
        vectors = self.client.embed(["one", "two", "three"])
        self.assertEqual(len(vectors), 3)
        self.assertEqual(self.transport.embed.call_count, 2)
        self.assertFalse(self.transport.embed.call_args.kwargs["truncate"])

    def test_invalid_input_and_vectors_are_rejected(self) -> None:
        with self.assertRaisesRegex(EmbeddingServiceError, "non-empty"):
            self.client.embed([])
        self.transport.embed.return_value = {"embeddings": [[1, 2]]}
        with self.assertRaisesRegex(EmbeddingServiceError, "3 values"):
            self.client.embed(["one"])
        self.transport.embed.return_value = {"embeddings": []}
        with self.assertRaisesRegex(EmbeddingServiceError, "wrong number"):
            self.client.embed(["one"])

    def test_transient_errors_retry_and_missing_model_is_typed(self) -> None:
        self.transport.embed.side_effect = [
            ollama.ResponseError("busy", 503),
            {"embeddings": [[1, 0, 0]]},
        ]
        with patch("dishly_retrieval.embeddings.time.sleep") as sleep:
            self.assertEqual(self.client.embed(["one"]), [[1.0, 0.0, 0.0]])
        sleep.assert_called_once()

        self.transport.embed.side_effect = ollama.ResponseError("missing", 404)
        with self.assertRaises(EmbeddingServiceError) as context:
            self.client.embed(["one"])
        self.assertEqual(context.exception.code, "OLLAMA_MODEL_MISSING")

    def test_model_digest_accepts_latest_alias(self) -> None:
        self.transport.list.return_value = {
            "models": [{"model": "embeddinggemma:latest", "digest": "digest-1"}]
        }
        self.assertEqual(self.client.model_digest(), "digest-1")
        self.transport.list.return_value = {"models": []}
        with self.assertRaisesRegex(EmbeddingServiceError, "not installed"):
            self.client.model_digest()

    def test_helpers_handle_model_names_and_versions(self) -> None:
        self.assertTrue(_model_names_match("embeddinggemma:latest", "embeddinggemma"))
        self.assertEqual(_version_tuple("0.11.10-rc1"), (0, 11, 10))

    def test_close_releases_transport(self) -> None:
        self.client.close()
        self.transport.close.assert_called_once()

    def test_status_reports_offline_version_model_and_ready_stages(self) -> None:
        http_context = MagicMock()
        http_client = http_context.__enter__.return_value
        with patch("dishly_retrieval.embeddings.httpx.Client", return_value=http_context):
            http_client.get.side_effect = httpx.ConnectError("offline")
            self.assertEqual(self.client.status().state, "offline")

            response = Mock()
            response.json.return_value = {"version": "0.11.0"}
            http_client.get.side_effect = None
            http_client.get.return_value = response
            self.assertEqual(self.client.status().state, "server_available")

            response.json.return_value = {"version": "0.12.0"}
            self.transport.list.return_value = {
                "models": [{"model": "embeddinggemma", "digest": "digest"}]
            }
            self.assertEqual(self.client.status().state, "model_available")

            self.transport.embed.return_value = {"embeddings": [[1, 0, 0]]}
            ready = self.client.status(probe=True)
            self.assertEqual(ready.state, "ready")
            self.assertEqual(ready.dimension, 3)


if __name__ == "__main__":
    unittest.main()

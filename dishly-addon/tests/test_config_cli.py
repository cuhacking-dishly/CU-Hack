"""Tests for safe environment parsing and every operator CLI command."""

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from dishly_retrieval.cli import main
from dishly_retrieval.config import Settings
from dishly_retrieval.dataset import DatasetValidationError
from tests.helpers import make_recipe


class SettingsTests(unittest.TestCase):
    def test_defaults_are_local_and_safe(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings.from_environment()
        self.assertEqual(settings.service_host, "127.0.0.1")
        self.assertIsNone(settings.service_token)
        self.assertEqual(settings.ollama_host, "http://127.0.0.1:11434")
        self.assertFalse(settings.auto_build_index)

    def test_environment_overrides_are_typed(self) -> None:
        environment = {
            "DISHLY_SERVICE_PORT": "8123",
            "DISHLY_EMBEDDING_BATCH_SIZE": "8",
            "DISHLY_AUTO_BUILD_INDEX": "yes",
            "DISHLY_SERVICE_TOKEN": "x" * 32,
            "OLLAMA_READ_TIMEOUT_SECONDS": "42.5",
        }
        with patch.dict(os.environ, environment, clear=True):
            settings = Settings.from_environment()
        self.assertEqual(settings.service_port, 8123)
        self.assertEqual(settings.embedding_batch_size, 8)
        self.assertTrue(settings.auto_build_index)
        self.assertEqual(settings.service_token, "x" * 32)
        self.assertEqual(settings.ollama_read_timeout_seconds, 42.5)

    def test_invalid_environment_is_rejected(self) -> None:
        invalid_values = (
            {"DISHLY_SERVICE_PORT": "nope"},
            {"DISHLY_SERVICE_PORT": "99999"},
            {"DISHLY_AUTO_BUILD_INDEX": "maybe"},
            {"OLLAMA_READ_TIMEOUT_SECONDS": "zero"},
            {"OLLAMA_HOST": "not-a-url"},
            {"OLLAMA_HOST": "https://user:pass@example.com"},
            {"OLLAMA_MODEL": " "},
            {"DISHLY_SERVICE_TOKEN": "too-short"},
        )
        for environment in invalid_values:
            with self.subTest(environment=environment), patch.dict(
                os.environ, environment, clear=True
            ), self.assertRaises(ValueError):
                Settings.from_environment()


class CliTests(unittest.TestCase):
    def invoke(self, arguments: list[str]) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main(arguments)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_validate_and_ingest_commands(self) -> None:
        with patch("dishly_retrieval.cli.load_recipes", return_value=[make_recipe()]):
            code, output, _error = self.invoke(["validate"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)["recipes"], 1)

        with tempfile.TemporaryDirectory() as directory, patch(
            "dishly_retrieval.cli.build_approved_corpus", return_value=[make_recipe()]
        ) as build:
            root = Path(directory)
            code, output, _error = self.invoke(
                [
                    "--data", str(root / "recipes.json"), "ingest",
                    "--seeds", str(root / "seeds.json"),
                    "--report", str(root / "report.json"),
                ]
            )
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(output)["ok"])
        build.assert_called_once()

    def test_status_build_index_and_search_commands_close_engine(self) -> None:
        engine = Mock()
        engine.readiness.return_value = {"ok": True}
        engine.build_index.return_value = SimpleNamespace(
            model="embeddinggemma",
            model_digest="digest",
            dimension=768,
            recipe_ids=("1",),
        )
        engine.search.return_value.to_api_dict.return_value = {"recipes": []}
        with patch("dishly_retrieval.cli.RetrievalEngine.from_settings", return_value=engine):
            self.assertEqual(self.invoke(["status"])[0], 0)
            self.assertEqual(self.invoke(["build-index"])[0], 0)
            code, output, _error = self.invoke(
                [
                    "search", "Asian vegan dinner", "--cuisine", "asian",
                    "--meal", "dinner", "--allergen", "peanut",
                    "--exclude-ingredient", "mushroom", "--vegan", "--closest",
                    "--limit", "5",
                ]
            )
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output), {"recipes": []})
        request = engine.search.call_args.args[0]
        self.assertTrue(request.require_vegan)
        self.assertEqual(request.match_mode, "closest")
        self.assertGreaterEqual(engine.close.call_count, 3)

    def test_serve_delegates_to_uvicorn(self) -> None:
        with patch("dishly_retrieval.cli.uvicorn.run") as run:
            code, _output, _error = self.invoke(["serve", "--host", "127.0.0.1", "--port", "8123"])
        self.assertEqual(code, 0)
        run.assert_called_once_with(
            "dishly_retrieval.api:app", host="127.0.0.1", port=8123, reload=False
        )

    def test_operational_errors_return_nonzero_without_traceback(self) -> None:
        with patch(
            "dishly_retrieval.cli.load_recipes",
            side_effect=DatasetValidationError("bad corpus"),
        ):
            code, _output, error = self.invoke(["validate"])
        self.assertEqual(code, 1)
        self.assertIn("bad corpus", error)


if __name__ == "__main__":
    unittest.main()

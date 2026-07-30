"""Offline tests for bounded source auditing and all-or-nothing ingestion."""

import json
import socket
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock, patch

import httpx
from PIL import Image

from dishly_retrieval.ingestion import (
    IngestionError,
    build_approved_corpus,
    build_recipe_from_seed,
    load_source_seeds,
)
from dishly_retrieval.source_audit import (
    AuditedSource,
    SafeSourceClient,
    SourceAuditError,
    _charset_from_content_type,
    _read_bounded,
    _validate_public_destination,
    audit_recipe_source,
)
from dishly_retrieval.source_extraction import (
    ExtractedRecipeMetadata,
    ImageCandidate,
    RecipeExtractionError,
)


def recipe_page(*image_urls: str) -> str:
    """Return fictional Schema.org HTML with caller-controlled image choices."""

    return f"""
    <script type="application/ld+json">{{
      "@type": "Recipe",
      "name": "Publisher Bowl",
      "recipeIngredient": ["1 cup chickpeas", "1 lemon"],
      "image": {json.dumps(list(image_urls))},
      "publisher": {{"name": "Publisher Kitchen"}},
      "totalTime": "PT30M",
      "recipeYield": "4 servings",
      "nutrition": {{"proteinContent": "20 g", "calories": "450 kcal"}}
    }}</script>
    """


def audited_source() -> AuditedSource:
    metadata = ExtractedRecipeMetadata(
        title="Publisher Bowl",
        ingredients=("1 cup chickpeas", "1 lemon"),
        source_url="https://example.com/bowl",
        image_candidates=(ImageCandidate("https://images.example.com/bowl.jpg", 1200, 800),),
        source_name="Publisher Kitchen",
        cuisine="Mediterranean",
        description="Publisher description",
        protein_grams=20,
        calories=450,
        carbs_grams=50,
        fat_grams=10,
        time_minutes=30,
        servings=4,
    )
    return AuditedSource(metadata, metadata.image_candidates[0].url, 1200, 800, "JPEG")


class SourceAuditTests(unittest.TestCase):
    def test_audit_tries_images_until_one_passes(self) -> None:
        client = Mock()
        client.fetch_html.return_value = (
            recipe_page("https://images.example.com/bad.jpg", "https://images.example.com/good.jpg"),
            "https://example.com/bowl",
        )
        client.inspect_image.side_effect = [
            SourceAuditError("too small"),
            (1200, 800, "JPEG"),
        ]
        audited = audit_recipe_source("https://example.com/bowl", client)
        self.assertEqual(audited.image_url, "https://images.example.com/good.jpg")

    def test_audit_rejects_recipe_without_a_working_image(self) -> None:
        client = Mock()
        client.fetch_html.return_value = (recipe_page(), "https://example.com/bowl")
        with self.assertRaisesRegex(SourceAuditError, "does not provide"):
            audit_recipe_source("https://example.com/bowl", client)

    def test_image_decoder_enforces_content_type_and_dimensions(self) -> None:
        client = SafeSourceClient()
        self.addCleanup(client.close)
        client._fetch = Mock(return_value=(b"not image", "https://example.com", "text/plain"))  # type: ignore[method-assign]
        with self.assertRaisesRegex(SourceAuditError, "returned text/plain"):
            client.inspect_image("https://example.com/image")

        image_bytes = BytesIO()
        Image.new("RGB", (900, 600), "red").save(image_bytes, format="PNG")
        client._fetch = Mock(  # type: ignore[method-assign]
            return_value=(image_bytes.getvalue(), "https://example.com/image", "image/png")
        )
        self.assertEqual(client.inspect_image("https://example.com/image"), (900, 600, "PNG"))

        small = BytesIO()
        Image.new("RGB", (100, 100), "red").save(small, format="PNG")
        client._fetch = Mock(  # type: ignore[method-assign]
            return_value=(small.getvalue(), "https://example.com/image", "image/png")
        )
        with self.assertRaisesRegex(SourceAuditError, "minimum"):
            client.inspect_image("https://example.com/image")

    def test_fetch_follows_bounded_redirect_and_reads_html(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/start":
                return httpx.Response(302, headers={"location": "/final"})
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                content=b"<html>ok</html>",
            )

        client = SafeSourceClient()
        client._client.close()
        client._client = httpx.Client(
            transport=httpx.MockTransport(handler),
            follow_redirects=False,
        )
        self.addCleanup(client.close)
        with patch("dishly_retrieval.source_audit.socket.getaddrinfo", return_value=[
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))
        ]):
            html, final_url = client.fetch_html("https://example.com/start")
        self.assertEqual(html, "<html>ok</html>")
        self.assertEqual(final_url, "https://example.com/final")

    def test_destination_and_size_helpers_reject_unsafe_inputs(self) -> None:
        with self.assertRaisesRegex(SourceAuditError, "public"):
            _validate_public_destination("http://127.0.0.1/private")
        with patch(
            "dishly_retrieval.source_audit.socket.getaddrinfo",
            side_effect=socket.gaierror,
        ), self.assertRaisesRegex(SourceAuditError, "resolved"):
            _validate_public_destination("https://example.invalid")
        with self.assertRaisesRegex(SourceAuditError, "size limit"):
            _read_bounded(iter((b"123", b"456")), 5)
        self.assertEqual(_read_bounded(iter((b"12", b"34")), 5), b"1234")
        self.assertEqual(_charset_from_content_type("text/html; charset=iso-8859-1"), "iso-8859-1")
        self.assertEqual(_charset_from_content_type("text/html"), "utf-8")


class IngestionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.seed = {
            "id": "1",
            "source_url": "https://example.com/bowl",
            "cuisine": "mediterranean",
            "meal_type": "dinner",
            "vegan": True,
            "allergens": [],
            "description": "A reviewed Mediterranean chickpea bowl.",
            "protein_grams": 18,
            "calories": 440,
        }

    def test_build_recipe_prefers_publisher_fields_and_derives_evidence(self) -> None:
        with patch(
            "dishly_retrieval.ingestion.audit_recipe_source", return_value=audited_source()
        ):
            recipe = build_recipe_from_seed(self.seed, 1, Mock())
        self.assertEqual(recipe.title, "Publisher Bowl")
        self.assertEqual(recipe.protein_grams, 20)
        self.assertEqual(recipe.source_url, "https://example.com/bowl")
        self.assertTrue(recipe.image_quality_verified)

    def test_corpus_write_is_atomic_and_reported(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            seeds = root / "seeds.json"
            output = root / "recipes.json"
            report = root / "report.json"
            seeds.write_text(
                json.dumps({"schema_version": 1, "sources": [self.seed]}),
                encoding="utf-8",
            )
            with patch(
                "dishly_retrieval.ingestion.audit_recipe_source",
                return_value=audited_source(),
            ):
                recipes = build_approved_corpus(seeds, output, report)
            self.assertEqual(len(recipes), 1)
            self.assertTrue(json.loads(report.read_text(encoding="utf-8"))["ok"])
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["schema_version"], 1)

    def test_failure_report_does_not_replace_existing_corpus(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            seeds = root / "seeds.json"
            output = root / "recipes.json"
            report = root / "report.json"
            seeds.write_text(
                json.dumps({"schema_version": 1, "sources": [self.seed]}),
                encoding="utf-8",
            )
            output.write_text("existing", encoding="utf-8")
            with patch(
                "dishly_retrieval.ingestion.audit_recipe_source",
                side_effect=SourceAuditError("blocked"),
            ), self.assertRaisesRegex(IngestionError, "not replaced"):
                build_approved_corpus(seeds, output, report)
            self.assertEqual(output.read_text(encoding="utf-8"), "existing")
            self.assertFalse(json.loads(report.read_text(encoding="utf-8"))["ok"])

    def test_parser_failure_is_collected_instead_of_aborting_audit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            seeds = root / "seeds.json"
            output = root / "recipes.json"
            report = root / "report.json"
            seeds.write_text(
                json.dumps({"schema_version": 1, "sources": [self.seed]}),
                encoding="utf-8",
            )
            with patch(
                "dishly_retrieval.ingestion.audit_recipe_source",
                side_effect=RecipeExtractionError("missing JSON-LD"),
            ), self.assertRaises(IngestionError):
                build_approved_corpus(seeds, output, report)
            failure = json.loads(report.read_text(encoding="utf-8"))["failures"][0]
            self.assertEqual(failure["error"], "missing JSON-LD")

    def test_seed_loader_rejects_bad_schema_and_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "seeds.json"
            path.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(IngestionError, "schema_version"):
                load_source_seeds(path)
            path.write_text(
                json.dumps({"schema_version": 1, "sources": [self.seed, self.seed]}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(IngestionError, "unique"):
                load_source_seeds(path)


if __name__ == "__main__":
    unittest.main()

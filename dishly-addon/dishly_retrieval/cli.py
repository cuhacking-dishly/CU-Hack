"""Operational command line for corpus validation, indexing, search, and serving."""

import argparse
import json
import sys
from pathlib import Path

import uvicorn

from .config import Settings
from .dataset import DatasetValidationError, load_recipes
from .embeddings import EmbeddingServiceError
from .ingestion import IngestionError, build_approved_corpus
from .models import SearchRequest
from .retrieval import RetrievalEngine


def build_parser() -> argparse.ArgumentParser:
    """Describe every supported operator command in one discoverable interface."""

    parser = argparse.ArgumentParser(prog="dishly-retrieval")
    parser.add_argument("--data", type=Path, help="Override the approved corpus path")
    parser.add_argument("--index", type=Path, help="Override the embedding index path")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("validate", help="Validate and summarize the approved corpus")
    subparsers.add_parser("status", help="Show corpus, index, and Ollama readiness")
    subparsers.add_parser("build-index", help="Embed the complete corpus using Ollama")

    ingest = subparsers.add_parser(
        "ingest",
        help="Audit every publisher source and atomically build the approved corpus",
    )
    ingest.add_argument(
        "--seeds",
        type=Path,
        default=Settings().data_path.parent / "source_seeds.json",
    )
    ingest.add_argument(
        "--report",
        type=Path,
        default=Settings().data_path.parent / "source_audit_report.json",
    )

    search = subparsers.add_parser("search", help="Run one local retrieval query")
    search.add_argument("query")
    search.add_argument("--cuisine", action="append", default=[])
    search.add_argument("--meal")
    search.add_argument("--allergen", action="append", default=[])
    search.add_argument("--exclude-ingredient", action="append", default=[])
    search.add_argument("--vegan", action="store_true")
    search.add_argument("--closest", action="store_true")
    search.add_argument("--limit", type=int, default=10)

    serve = subparsers.add_parser("serve", help="Run the private local HTTP service")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)
    return parser


def main(arguments: list[str] | None = None) -> int:
    """Execute one command and return an ordinary process exit code."""

    parser = build_parser()
    args = parser.parse_args(arguments)

    try:
        settings = _settings_with_path_overrides(Settings.from_environment(), args)
        if args.command == "validate":
            recipes = load_recipes(settings.data_path)
            print(json.dumps({"ok": True, "recipes": len(recipes)}, indent=2))
            return 0
        if args.command == "serve":
            uvicorn.run(
                "dishly_retrieval.api:app",
                host=args.host or settings.service_host,
                port=args.port or settings.service_port,
                reload=False,
            )
            return 0
        if args.command == "ingest":
            recipes = build_approved_corpus(args.seeds, settings.data_path, args.report)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "recipes": len(recipes),
                        "dataPath": str(settings.data_path),
                        "reportPath": str(args.report),
                    },
                    indent=2,
                )
            )
            return 0

        engine = RetrievalEngine.from_settings(settings)
        try:
            if args.command == "status":
                print(json.dumps(engine.readiness(), indent=2))
                return 0
            if args.command == "build-index":
                index = engine.build_index()
                print(
                    json.dumps(
                        {
                            "ok": True,
                            "model": index.model,
                            "modelDigest": index.model_digest,
                            "dimension": index.dimension,
                            "recipes": len(index.recipe_ids),
                            "path": str(settings.index_path),
                        },
                        indent=2,
                    )
                )
                return 0
            if args.command == "search":
                request = SearchRequest(
                    raw_query=args.query,
                    preferred_cuisines=tuple(args.cuisine),
                    preferred_meal_type=args.meal,
                    require_vegan=args.vegan,
                    excluded_allergens=frozenset(args.allergen),
                    excluded_ingredients=frozenset(args.exclude_ingredient),
                    limit=args.limit,
                    match_mode="closest" if args.closest else "exact",
                )
                print(json.dumps(engine.search(request).to_api_dict(), indent=2))
                return 0
        finally:
            engine.close()
    except (DatasetValidationError, EmbeddingServiceError, IngestionError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    parser.error(f"unknown command: {args.command}")
    return 2


def _settings_with_path_overrides(settings: Settings, args: argparse.Namespace) -> Settings:
    """Return a new immutable settings object with optional CLI paths."""

    return Settings(
        data_path=args.data or settings.data_path,
        index_path=args.index or settings.index_path,
        ollama_host=settings.ollama_host,
        ollama_model=settings.ollama_model,
        ollama_expected_dimension=settings.ollama_expected_dimension,
        ollama_connect_timeout_seconds=settings.ollama_connect_timeout_seconds,
        ollama_read_timeout_seconds=settings.ollama_read_timeout_seconds,
        embedding_batch_size=settings.embedding_batch_size,
        service_host=settings.service_host,
        service_port=settings.service_port,
        auto_build_index=settings.auto_build_index,
    )

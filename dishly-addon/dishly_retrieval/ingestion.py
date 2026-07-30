"""Turn curated source seeds into an all-or-nothing approved local corpus."""

import json
from datetime import date
from pathlib import Path
from typing import Any

from .allergens import detect_allergens, normalize_allergen
from .dataset import (
    CORPUS_SCHEMA_VERSION,
    DatasetValidationError,
    recipe_to_record,
    validate_and_build_recipe,
)
from .models import Recipe
from .source_audit import SafeSourceClient, SourceAuditError, audit_recipe_source
from .source_extraction import RecipeExtractionError


class IngestionError(RuntimeError):
    """The complete source set could not safely become an approved corpus."""


def build_approved_corpus(
    seed_path: Path,
    output_path: Path,
    report_path: Path,
) -> list[Recipe]:
    """Audit every source and write output only when every record passes."""

    seeds = load_source_seeds(seed_path)
    recipes: list[Recipe] = []
    failures: list[dict[str, str]] = []
    with SafeSourceClient() as client:
        for position, seed in enumerate(seeds, start=1):
            try:
                recipes.append(build_recipe_from_seed(seed, position, client))
            except (
                SourceAuditError,
                RecipeExtractionError,
                DatasetValidationError,
                KeyError,
                TypeError,
            ) as error:
                failures.append(
                    {
                        "position": str(position),
                        "source_url": str(seed.get("source_url", "")),
                        "error": str(error),
                    }
                )

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(
            {
                "ok": not failures,
                "seed_count": len(seeds),
                "approved_count": len(recipes),
                "failures": failures,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    if failures:
        raise IngestionError(
            f"Corpus was not replaced: {len(failures)} of {len(seeds)} sources failed. "
            f"See {report_path}."
        )

    document = {
        "schema_version": CORPUS_SCHEMA_VERSION,
        "recipes": [recipe_to_record(recipe) for recipe in recipes],
    }
    temporary_path = output_path.with_suffix(f"{output_path.suffix}.tmp")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(output_path)
    return recipes


def load_source_seeds(path: Path) -> list[dict[str, Any]]:
    """Load the manually reviewed classifications attached to publisher URLs."""

    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as error:
        raise IngestionError(f"Source seed file could not be loaded: {path}") from error
    if not isinstance(document, dict) or document.get("schema_version") != 1:
        raise IngestionError("Source seed file needs schema_version 1.")
    seeds = document.get("sources")
    if (
        not isinstance(seeds, list)
        or not seeds
        or not all(isinstance(seed, dict) for seed in seeds)
    ):
        raise IngestionError("Source seed file needs a non-empty sources array.")
    urls = [seed.get("source_url") for seed in seeds]
    if len(set(urls)) != len(urls):
        raise IngestionError("Source seed URLs must be unique.")
    return seeds


def build_recipe_from_seed(
    seed: dict[str, Any],
    position: int,
    client: SafeSourceClient,
) -> Recipe:
    """Combine exact publisher fields with manually reviewed classifications."""

    audited = audit_recipe_source(str(seed["source_url"]), client)
    metadata = audited.metadata
    detected_allergens = detect_allergens(metadata.ingredients)
    declared_allergens = {
        normalize_allergen(value)
        for value in seed.get("allergens", [])
        if isinstance(value, str)
    }
    allergens = tuple(sorted(declared_allergens | set(detected_allergens)))
    has_nutrition = any(
        value is not None
        for value in (
            metadata.protein_grams,
            metadata.calories,
            metadata.carbs_grams,
            metadata.fat_grams,
        )
    )

    record: dict[str, Any] = {
        "id": str(seed["id"]),
        "title": metadata.title,
        "cuisine": str(seed["cuisine"]),
        "meal_type": str(seed["meal_type"]),
        "protein_grams": _prefer_source(metadata.protein_grams, seed.get("protein_grams")),
        "calories": _prefer_source(metadata.calories, seed.get("calories")),
        "carbs_grams": _prefer_source(metadata.carbs_grams, seed.get("carbs_grams")),
        "fat_grams": _prefer_source(metadata.fat_grams, seed.get("fat_grams")),
        "time_minutes": metadata.time_minutes or seed.get("time_minutes"),
        "servings": metadata.servings,
        "vegan": seed["vegan"],
        "allergens": list(allergens),
        "allergen_evidence": [
            f"ingredient-derived:{allergen}"
            for allergen in sorted(detected_allergens)
        ],
        "ingredients": list(metadata.ingredients),
        # Dishly links to the publisher for copyrighted instructions.
        "instructions": [],
        "description": str(seed["description"]),
        "source_url": metadata.source_url,
        "image_url": audited.image_url,
        "source_name": metadata.source_name,
        "source_verified_at": date.today().isoformat(),
        "image_width": audited.image_width,
        "image_height": audited.image_height,
        "image_quality_verified": True,
        "nutrition_basis": "per serving" if has_nutrition and metadata.servings else "unknown",
    }
    return validate_and_build_recipe(record, position)


def _prefer_source(source_value: Any, reviewed_fallback: Any) -> Any:
    return source_value if source_value is not None else reviewed_fallback

"""Deterministic recipe documents and checksums for vector cache identity."""

import hashlib
import json

from .models import Recipe

DOCUMENT_SCHEMA_VERSION = 1


def build_recipe_document(recipe: Recipe) -> str:
    """Construct the exact text embedded for semantic retrieval."""

    return "\n".join(
        (
            f"title: {recipe.title}",
            f"cuisine: {recipe.cuisine}",
            f"meal: {recipe.meal_type}",
            f"vegan: {'yes' if recipe.vegan else 'no'}",
            f"description: {recipe.description}",
            f"ingredients: {'; '.join(recipe.ingredients)}",
        )
    )


def corpus_checksum(recipes: list[Recipe] | tuple[Recipe, ...]) -> str:
    """Hash IDs and embedding documents so stale vectors are never reused."""

    payload = {
        "document_schema_version": DOCUMENT_SCHEMA_VERSION,
        "documents": [
            {"id": recipe.id, "text": build_recipe_document(recipe)}
            for recipe in recipes
        ],
    }
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

"""Schema-versioned loading and validation for Dishly's approved corpus."""

import ipaddress
import json
import math
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

from .allergens import detect_allergens, detect_non_vegan_ingredients, normalize_allergen
from .models import Recipe

CORPUS_SCHEMA_VERSION = 1
MAX_JAVASCRIPT_SAFE_INTEGER = 9_007_199_254_740_991
MIN_IMAGE_SHORT_SIDE = 500
MIN_IMAGE_PIXELS = 400_000
ALLOWED_NUTRITION_BASES = {"per serving", "per recipe", "unknown"}


class DatasetValidationError(ValueError):
    """Explain why corpus data is not safe or complete enough to serve."""


def load_recipes(path: Path) -> list[Recipe]:
    """Load a complete approved corpus, rejecting partial or ambiguous data."""

    try:
        raw_document = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise DatasetValidationError(f"Recipe data file was not found: {path}") from error
    except json.JSONDecodeError as error:
        raise DatasetValidationError(
            f"Recipe data is not valid JSON at line {error.lineno}, column {error.colno}."
        ) from error

    if not isinstance(raw_document, dict):
        raise DatasetValidationError("Recipe data must be a JSON object.")
    if raw_document.get("schema_version") != CORPUS_SCHEMA_VERSION:
        raise DatasetValidationError(
            f"Recipe data needs schema_version {CORPUS_SCHEMA_VERSION}."
        )

    raw_recipes = raw_document.get("recipes")
    if not isinstance(raw_recipes, list) or not raw_recipes:
        raise DatasetValidationError("Recipe data must contain a non-empty recipes array.")

    recipes: list[Recipe] = []
    seen_ids: set[str] = set()
    seen_sources: set[str] = set()
    for position, raw_recipe in enumerate(raw_recipes, start=1):
        if not isinstance(raw_recipe, dict):
            raise DatasetValidationError(f"Recipe {position} must be a JSON object.")
        recipe = validate_and_build_recipe(raw_recipe, position)

        if recipe.id in seen_ids:
            raise DatasetValidationError(f"Duplicate recipe id: {recipe.id}")
        canonical_source = canonicalize_url(recipe.source_url)
        if canonical_source in seen_sources:
            raise DatasetValidationError(f"Duplicate recipe source URL: {recipe.source_url}")

        seen_ids.add(recipe.id)
        seen_sources.add(canonical_source)
        recipes.append(recipe)

    return recipes


def validate_and_build_recipe(record: dict[str, Any], position: int) -> Recipe:
    """Validate one raw JSON object and convert it to an immutable Recipe."""

    required_text = (
        "id",
        "title",
        "cuisine",
        "meal_type",
        "description",
        "source_url",
        "image_url",
        "source_name",
        "source_verified_at",
        "nutrition_basis",
    )
    values: dict[str, Any] = {}
    for field_name in required_text:
        value = record.get(field_name)
        if not isinstance(value, str) or not value.strip():
            raise DatasetValidationError(
                f"Recipe {position} needs a non-empty {field_name} string."
            )
        values[field_name] = value.strip()

    recipe_id = values["id"]
    if not recipe_id.isascii() or not recipe_id.isdecimal() or recipe_id.startswith("0"):
        raise DatasetValidationError(
            f"Recipe {position} needs a canonical positive numeric id."
        )
    if int(recipe_id) > MAX_JAVASCRIPT_SAFE_INTEGER:
        raise DatasetValidationError(f"Recipe {position} id exceeds JavaScript's safe range.")

    if type(record.get("vegan")) is not bool:
        raise DatasetValidationError(f"Recipe {position} needs vegan to be true or false.")
    if type(record.get("image_quality_verified")) is not bool:
        raise DatasetValidationError(
            f"Recipe {position} needs image_quality_verified to be true or false."
        )
    if not record["image_quality_verified"]:
        raise DatasetValidationError(
            f"Recipe {position} image must be quality-verified before approval."
        )

    allergens = _required_string_tuple(record, "allergens", position, allow_empty=True)
    ingredients = _required_string_tuple(record, "ingredients", position, allow_empty=False)
    instructions = _required_string_tuple(record, "instructions", position, allow_empty=True)
    evidence = _required_string_tuple(record, "allergen_evidence", position, allow_empty=True)

    numeric_values = {
        name: _optional_number(record.get(name), name, position)
        for name in ("protein_grams", "calories", "carbs_grams", "fat_grams", "servings")
    }
    time_minutes = _optional_integer(record.get("time_minutes"), "time_minutes", position)
    image_width = _optional_integer(record.get("image_width"), "image_width", position)
    image_height = _optional_integer(record.get("image_height"), "image_height", position)
    if image_width is None or image_height is None:
        raise DatasetValidationError(f"Recipe {position} needs verified image dimensions.")
    if not image_meets_quality_threshold(image_width, image_height):
        raise DatasetValidationError(
            f"Recipe {position} image is below the {MIN_IMAGE_SHORT_SIDE}px short-side "
            f"and {MIN_IMAGE_PIXELS:,}-pixel quality threshold."
        )

    if not is_public_http_url(values["source_url"]):
        raise DatasetValidationError(f"Recipe {position} has an unsafe source_url.")
    if not is_public_http_url(values["image_url"]):
        raise DatasetValidationError(f"Recipe {position} has an unsafe image_url.")

    try:
        date.fromisoformat(values["source_verified_at"])
    except ValueError as error:
        raise DatasetValidationError(
            f"Recipe {position} source_verified_at must be YYYY-MM-DD."
        ) from error

    if values["nutrition_basis"] not in ALLOWED_NUTRITION_BASES:
        raise DatasetValidationError(
            f"Recipe {position} nutrition_basis must be per serving, per recipe, or unknown."
        )

    normalized_declared = {normalize_allergen(value) for value in allergens}
    ingredient_detected = set(detect_allergens(ingredients))
    missing_declarations = ingredient_detected - normalized_declared
    if missing_declarations:
        missing = ", ".join(sorted(missing_declarations))
        raise DatasetValidationError(
            f"Recipe {position} allergen declarations omit ingredient evidence: {missing}."
        )
    non_vegan_evidence = detect_non_vegan_ingredients(ingredients)
    if record["vegan"] and non_vegan_evidence:
        evidence_text = ", ".join(sorted(non_vegan_evidence))
        raise DatasetValidationError(
            f"Recipe {position} is marked vegan but contains animal-derived ingredients: "
            f"{evidence_text}."
        )

    return Recipe(
        id=recipe_id,
        title=values["title"],
        cuisine=values["cuisine"],
        meal_type=values["meal_type"],
        vegan=record["vegan"],
        allergens=tuple(sorted(normalized_declared)),
        ingredients=ingredients,
        description=values["description"],
        source_url=values["source_url"],
        image_url=values["image_url"],
        source_name=values["source_name"],
        protein_grams=numeric_values["protein_grams"],
        calories=numeric_values["calories"],
        carbs_grams=numeric_values["carbs_grams"],
        fat_grams=numeric_values["fat_grams"],
        time_minutes=time_minutes,
        servings=numeric_values["servings"],
        instructions=instructions,
        allergen_evidence=evidence,
        source_verified_at=values["source_verified_at"],
        image_width=image_width,
        image_height=image_height,
        image_quality_verified=True,
        nutrition_basis=values["nutrition_basis"],
    )


def save_recipes(path: Path, recipes: list[Recipe]) -> None:
    """Atomically persist a validated corpus document."""

    document = {
        "schema_version": CORPUS_SCHEMA_VERSION,
        "recipes": [recipe_to_record(recipe) for recipe in recipes],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(f"{path.suffix}.tmp")
    temporary_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(path)


def recipe_to_record(recipe: Recipe) -> dict[str, Any]:
    """Serialize an immutable Recipe using the approved corpus field names."""

    return {
        "id": recipe.id,
        "title": recipe.title,
        "cuisine": recipe.cuisine,
        "meal_type": recipe.meal_type,
        "protein_grams": recipe.protein_grams,
        "calories": recipe.calories,
        "carbs_grams": recipe.carbs_grams,
        "fat_grams": recipe.fat_grams,
        "time_minutes": recipe.time_minutes,
        "servings": recipe.servings,
        "vegan": recipe.vegan,
        "allergens": list(recipe.allergens),
        "allergen_evidence": list(recipe.allergen_evidence),
        "ingredients": list(recipe.ingredients),
        "instructions": list(recipe.instructions),
        "description": recipe.description,
        "source_url": recipe.source_url,
        "image_url": recipe.image_url,
        "source_name": recipe.source_name,
        "source_verified_at": recipe.source_verified_at,
        "image_width": recipe.image_width,
        "image_height": recipe.image_height,
        "image_quality_verified": recipe.image_quality_verified,
        "nutrition_basis": recipe.nutrition_basis,
    }


def canonicalize_url(value: str) -> str:
    """Canonicalize a URL for duplicate detection without changing stored attribution."""

    parsed = urlparse(value)
    path = parsed.path.rstrip("/") or "/"
    return urlunparse(
        (parsed.scheme.lower(), parsed.netloc.lower(), path, "", parsed.query, "")
    )


def is_public_http_url(value: str) -> bool:
    """Reject credentials, localhost, and literal private-network destinations."""

    parsed = urlparse(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        return False

    hostname = parsed.hostname.lower().rstrip(".")
    if hostname == "localhost" or hostname.endswith((".localhost", ".local")):
        return False
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return True
    return not (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


def image_meets_quality_threshold(width: int, height: int) -> bool:
    """Accept sharp landscape, square, or portrait food photography equally."""

    return min(width, height) >= MIN_IMAGE_SHORT_SIDE and width * height >= MIN_IMAGE_PIXELS


def _required_string_tuple(
    record: dict[str, Any],
    field_name: str,
    position: int,
    *,
    allow_empty: bool,
) -> tuple[str, ...]:
    value = record.get(field_name)
    if not isinstance(value, list):
        raise DatasetValidationError(f"Recipe {position} needs {field_name} to be a list.")
    if not allow_empty and not value:
        raise DatasetValidationError(f"Recipe {position} needs at least one {field_name} value.")
    if not all(isinstance(item, str) and item.strip() for item in value):
        raise DatasetValidationError(f"Recipe {position} has an invalid {field_name} value.")
    return tuple(item.strip() for item in value)


def _optional_number(value: Any, field_name: str, position: int) -> float | None:
    if value is None:
        return None
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not math.isfinite(value)
        or value < 0
    ):
        raise DatasetValidationError(
            f"Recipe {position} needs {field_name} to be a non-negative finite number or null."
        )
    return float(value)


def _optional_integer(value: Any, field_name: str, position: int) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise DatasetValidationError(
            f"Recipe {position} needs {field_name} to be a non-negative integer or null."
        )
    return value

"""Canonical cuisine and meal labels used by exact and closest retrieval."""

import re

NON_ALPHANUMERIC = re.compile(r"[^a-z0-9]+")


CUISINE_ALIASES = {
    "tex mex": "mexican",
    "southwestern": "mexican",
    "cajun inspired": "cajun",
    "north african": "north african",
    "middle eastern": "middle eastern",
}


CUISINE_GROUPS = {
    "asian": {
        "asian",
        "chinese",
        "indian",
        "indonesian",
        "japanese",
        "korean",
        "malaysian",
        "filipino",
        "singaporean",
        "thai",
        "vietnamese",
    },
    "latin american": {
        "latin american",
        "mexican",
        "brazilian",
        "caribbean",
        "cuban",
    },
    "mediterranean": {
        "mediterranean",
        "greek",
        "italian",
        "spanish",
        "middle eastern",
        "north african",
        "moroccan",
    },
    "european": {
        "european",
        "british",
        "french",
        "german",
        "greek",
        "irish",
        "italian",
        "spanish",
    },
}


MEAL_ALIASES = {
    "main course": "dinner",
    "main dish": "dinner",
    "supper": "dinner",
    "brunch": "breakfast",
    "morning meal": "breakfast",
    "sweet": "dessert",
}


def normalize_label(value: str) -> str:
    """Normalize punctuation, spacing, and casing for deterministic comparisons."""

    return " ".join(NON_ALPHANUMERIC.sub(" ", value.lower()).split())


def canonical_meal_type(value: str) -> str:
    """Map frontend/local-parser meal labels to the corpus taxonomy."""

    normalized = normalize_label(value)
    return MEAL_ALIASES.get(normalized, normalized)


def _base_cuisine(value: str) -> str:
    """Remove source qualifiers while preserving the cuisine identity."""

    normalized = normalize_label(value)
    for suffix in (" inspired", " style"):
        if normalized.endswith(suffix):
            normalized = normalized[: -len(suffix)].strip()
    normalized = CUISINE_ALIASES.get(normalized, normalized)
    return normalized


def cuisine_match_strength(recipe_cuisine: str, requested_cuisine: str) -> float:
    """Return a 0-to-1 cuisine relevance tier, including broad cuisine groups."""

    recipe_base = _base_cuisine(recipe_cuisine)
    requested_base = _base_cuisine(requested_cuisine)

    if recipe_base == requested_base:
        return 1.0

    # Fusion labels retain both cuisine words, so either explicit side can match.
    recipe_parts = {
        _base_cuisine(part)
        for part in re.split(r"\bfusion\b|/|&", recipe_base)
        if part.strip()
    }
    if requested_base in recipe_parts:
        return 0.95

    requested_group = CUISINE_GROUPS.get(requested_base)
    if requested_group and any(part in requested_group for part in recipe_parts | {recipe_base}):
        return 0.8

    recipe_group = CUISINE_GROUPS.get(recipe_base)
    if recipe_group and requested_base in recipe_group:
        return 0.75

    return 0.0


def best_cuisine_match(recipe_cuisine: str, requested_cuisines: tuple[str, ...]) -> float:
    """Return the recipe's strongest match against any requested alternative."""

    if not requested_cuisines:
        return 1.0
    return max(
        cuisine_match_strength(recipe_cuisine, requested)
        for requested in requested_cuisines
    )


def meal_type_matches(recipe_meal_type: str, requested_meal_type: str | None) -> bool:
    """Return whether a recipe belongs to the requested meal category."""

    if requested_meal_type is None:
        return True
    return canonical_meal_type(recipe_meal_type) == canonical_meal_type(requested_meal_type)

"""Immutable domain models shared by ingestion, retrieval, API, and tests."""

import math
from dataclasses import dataclass, field
from typing import Literal

MatchMode = Literal["exact", "closest"]


@dataclass(frozen=True, slots=True)
class Recipe:
    """One reviewed, traceable publisher recipe in Dishly's local corpus.

    Lists are represented as tuples so a loaded recipe cannot mutate after its
    embedding is cached. Unknown source values remain ``None`` rather than zero.
    """

    id: str
    title: str
    cuisine: str
    meal_type: str
    vegan: bool
    allergens: tuple[str, ...]
    ingredients: tuple[str, ...]
    description: str
    source_url: str
    image_url: str
    source_name: str
    protein_grams: float | None = None
    calories: float | None = None
    carbs_grams: float | None = None
    fat_grams: float | None = None
    time_minutes: int | None = None
    servings: float | None = None
    instructions: tuple[str, ...] = ()
    allergen_evidence: tuple[str, ...] = ()
    source_verified_at: str = ""
    image_width: int | None = None
    image_height: int | None = None
    image_quality_verified: bool = False
    nutrition_basis: str = "unknown"

    def to_public_dict(
        self,
        *,
        match_mode: MatchMode | None = None,
        match_score: float | None = None,
        match_reasons: tuple[str, ...] = (),
    ) -> dict[str, object]:
        """Map the domain model to the existing React recipe-card contract."""

        result: dict[str, object] = {
            "id": self.id,
            "title": self.title,
            "image": self.image_url,
            "readyInMinutes": self.time_minutes,
            "servings": self.servings,
            "calories": self.calories,
            "macros": {
                "protein_g": self.protein_grams,
                "carbs_g": self.carbs_grams,
                "fat_g": self.fat_grams,
            },
            "diets": ["vegan"] if self.vegan else [],
            "ingredients": list(self.ingredients),
            "instructions": list(self.instructions),
            "sourceName": self.source_name,
            "sourceUrl": self.source_url,
            "cuisine": self.cuisine,
            "mealType": self.meal_type,
            "vegan": self.vegan,
            "allergens": list(self.allergens),
            "description": self.description,
            "nutritionBasis": self.nutrition_basis,
        }
        if match_mode is not None:
            result["matchMode"] = match_mode
            result["matchScore"] = match_score
            result["matchReasons"] = list(match_reasons)
        return result


@dataclass(frozen=True, slots=True)
class SearchRequest:
    """One validated retrieval request produced from the saved local goal."""

    raw_query: str
    query: str = ""
    excluded_allergens: frozenset[str] = field(default_factory=frozenset)
    excluded_ingredients: frozenset[str] = field(default_factory=frozenset)
    preferred_cuisines: tuple[str, ...] = ()
    preferred_meal_type: str | None = None
    diet: str | None = None
    require_vegan: bool = False
    min_calories: float | None = None
    max_calories: float | None = None
    min_protein_g: float | None = None
    max_protein_g: float | None = None
    min_carbs_g: float | None = None
    max_carbs_g: float | None = None
    max_time_minutes: int | None = None
    excluded_recipe_ids: frozenset[str] = field(default_factory=frozenset)
    limit: int = 10
    offset: int = 0
    match_mode: MatchMode = "exact"

    def __post_init__(self) -> None:
        """Reject invalid requests before safety filtering or vector work begins."""

        if not isinstance(self.raw_query, str) or not self.raw_query.strip():
            raise ValueError("raw_query must be a non-empty string")
        if len(self.raw_query) > 1000:
            raise ValueError("raw_query must be 1000 characters or fewer")
        if self.match_mode not in {"exact", "closest"}:
            raise ValueError("match_mode must be exact or closest")
        if (
            not isinstance(self.limit, int)
            or isinstance(self.limit, bool)
            or not 1 <= self.limit <= 20
        ):
            raise ValueError("limit must be an integer between 1 and 20")
        if not isinstance(self.offset, int) or isinstance(self.offset, bool) or self.offset < 0:
            raise ValueError("offset must be a non-negative integer")

        for field_name in (
            "min_calories",
            "max_calories",
            "min_protein_g",
            "max_protein_g",
            "min_carbs_g",
            "max_carbs_g",
        ):
            value = getattr(self, field_name)
            if value is not None and (
                isinstance(value, bool)
                or not isinstance(value, int | float)
                or not math.isfinite(value)
                or value < 0
            ):
                raise ValueError(f"{field_name} must be a non-negative finite number or null")

        if self.max_time_minutes is not None and (
            isinstance(self.max_time_minutes, bool)
            or not isinstance(self.max_time_minutes, int)
            or self.max_time_minutes < 0
        ):
            raise ValueError("max_time_minutes must be a non-negative integer or null")

        for minimum_name, maximum_name in (
            ("min_calories", "max_calories"),
            ("min_protein_g", "max_protein_g"),
            ("min_carbs_g", "max_carbs_g"),
        ):
            minimum = getattr(self, minimum_name)
            maximum = getattr(self, maximum_name)
            if minimum is not None and maximum is not None and minimum > maximum:
                raise ValueError(f"{minimum_name} cannot exceed {maximum_name}")

    @property
    def semantic_query(self) -> str:
        """Use the parser's soft query when present, otherwise retain natural language."""

        return self.query.strip() or self.raw_query.strip()


@dataclass(frozen=True, slots=True)
class ScoreBreakdown:
    """Auditable components used to order one strictly eligible recipe."""

    semantic: float
    structured: float
    total: float
    cuisine_tier: float
    reasons: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ScoredRecipe:
    """One eligible recipe and its deterministic hybrid score."""

    recipe: Recipe
    score: ScoreBreakdown


@dataclass(frozen=True, slots=True)
class SearchResponse:
    """Complete engine response used by the private Python HTTP service."""

    recipes: tuple[ScoredRecipe, ...]
    match_mode: MatchMode
    can_show_closest: bool
    message: str | None
    total_candidates: int
    semantic_provider: str

    def to_api_dict(self) -> dict[str, object]:
        """Serialize the response while preserving the existing card DTO."""

        return {
            "recipes": [
                scored.recipe.to_public_dict(
                    match_mode=self.match_mode,
                    match_score=round(scored.score.total, 6),
                    match_reasons=scored.score.reasons,
                )
                for scored in self.recipes
            ],
            "match_mode": self.match_mode,
            "can_show_closest": self.can_show_closest,
            "message": self.message,
            "total_candidates": self.total_candidates,
            "semantic_provider": self.semantic_provider,
        }

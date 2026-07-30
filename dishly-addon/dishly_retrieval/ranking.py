"""Explainable structured and semantic ranking for strictly eligible recipes."""

from .models import Recipe, ScoreBreakdown, ScoredRecipe, SearchRequest
from .taxonomy import best_cuisine_match, meal_type_matches

CUISINE_WEIGHT = 4.0
MEAL_WEIGHT = 2.0
PROTEIN_WEIGHT = 3.0
CALORIE_WEIGHT = 2.0
CARB_WEIGHT = 1.5
TIME_WEIGHT = 1.0
SEMANTIC_WEIGHT = 0.60
STRUCTURED_WEIGHT = 0.40


def numeric_range_score(
    actual: float | int | None,
    minimum: float | int | None,
    maximum: float | int | None,
) -> float | None:
    """Score a known value against a requested range without making it strict.

    Values inside the range score 1. Faster/lower values satisfy a maximum
    fully. Unknown values return ``None`` and never masquerade as zero.
    """

    if actual is None or (minimum is None and maximum is None):
        return None
    actual_value = float(actual)
    if minimum is not None and actual_value < float(minimum):
        minimum_value = max(float(minimum), 1.0)
        return max(0.0, actual_value / minimum_value)
    if maximum is not None and actual_value > float(maximum):
        return max(0.0, float(maximum) / max(actual_value, 1.0))
    return 1.0


def calculate_structured_score(
    recipe: Recipe,
    request: SearchRequest,
) -> tuple[float, float, tuple[str, ...]]:
    """Return normalized structured relevance, cuisine tier, and explanations."""

    weighted_total = 0.0
    available_weight = 0.0
    reasons: list[str] = []

    cuisine_tier = best_cuisine_match(recipe.cuisine, request.preferred_cuisines)
    if request.preferred_cuisines:
        available_weight += CUISINE_WEIGHT
        weighted_total += cuisine_tier * CUISINE_WEIGHT
        if cuisine_tier > 0:
            reasons.append(f"{recipe.cuisine.title()} cuisine match")

    if request.preferred_meal_type is not None:
        available_weight += MEAL_WEIGHT
        if meal_type_matches(recipe.meal_type, request.preferred_meal_type):
            weighted_total += MEAL_WEIGHT
            reasons.append(f"{recipe.meal_type.title()} match")

    components = (
        (
            recipe.protein_grams,
            request.min_protein_g,
            request.max_protein_g,
            PROTEIN_WEIGHT,
            "protein",
        ),
        (
            recipe.calories,
            request.min_calories,
            request.max_calories,
            CALORIE_WEIGHT,
            "calorie",
        ),
        (
            recipe.carbs_grams,
            request.min_carbs_g,
            request.max_carbs_g,
            CARB_WEIGHT,
            "carbohydrate",
        ),
        (
            recipe.time_minutes,
            None,
            request.max_time_minutes,
            TIME_WEIGHT,
            "time",
        ),
    )
    for actual, minimum, maximum, weight, label in components:
        if minimum is None and maximum is None:
            continue
        available_weight += weight
        component_score = numeric_range_score(actual, minimum, maximum)
        if component_score is None:
            continue
        weighted_total += component_score * weight
        if component_score >= 0.999:
            reasons.append(f"Meets {label} target")
        elif component_score >= 0.7:
            reasons.append(f"Near {label} target")

    structured = weighted_total / available_weight if available_weight else 0.0
    return structured, cuisine_tier, tuple(reasons)


def rank_recipes(
    recipes: list[Recipe],
    request: SearchRequest,
    semantic_scores: dict[str, float] | None = None,
) -> list[ScoredRecipe]:
    """Rank eligible candidates with cuisine tier before weighted hybrid score."""

    semantic_scores = semantic_scores or {}
    scored: list[tuple[int, ScoredRecipe]] = []
    for original_position, recipe in enumerate(recipes):
        structured, cuisine_tier, reasons = calculate_structured_score(recipe, request)
        semantic = min(1.0, max(0.0, float(semantic_scores.get(recipe.id, 0.0))))
        total = semantic * SEMANTIC_WEIGHT + structured * STRUCTURED_WEIGHT
        if semantic >= 0.65:
            reasons = (*reasons, "Strong semantic match")
        elif semantic >= 0.4:
            reasons = (*reasons, "Related to your request")

        scored.append(
            (
                original_position,
                ScoredRecipe(
                    recipe=recipe,
                    score=ScoreBreakdown(
                        semantic=semantic,
                        structured=structured,
                        total=total,
                        cuisine_tier=cuisine_tier,
                        reasons=reasons,
                    ),
                ),
            )
        )

    # Cuisine is intentionally a tier: an unrelated cuisine cannot buy its way
    # above a requested cuisine through nutrition points alone.
    scored.sort(
        key=lambda item: (
            -item[1].score.cuisine_tier,
            -item[1].score.total,
            item[0],
        )
    )
    return [item[1] for item in scored]

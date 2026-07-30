"""Hard eligibility and exact-category filtering for the retrieval pipeline."""

from .allergens import normalize_allergen, recipe_matches_exclusion
from .models import Recipe, SearchRequest
from .taxonomy import best_cuisine_match, meal_type_matches


def filter_eligible_recipes(
    recipes: list[Recipe] | tuple[Recipe, ...],
    request: SearchRequest,
) -> list[Recipe]:
    """Apply every non-negotiable rule before any recipe is embedded or ranked.

    Allergy/ingredient exclusions and a requested vegan diet are used unchanged
    in exact and closest modes. Swiped IDs are scoped by Express to this goal.
    """

    eligible: list[Recipe] = []
    for recipe in recipes:
        if recipe.id in request.excluded_recipe_ids:
            continue
        if request.require_vegan and not recipe.vegan:
            continue
        if recipe_matches_exclusion(
            recipe.allergens,
            recipe.ingredients,
            request.excluded_allergens,
            request.excluded_ingredients,
        ):
            continue
        eligible.append(recipe)
    return eligible


def filter_exact_candidates(
    strictly_eligible: list[Recipe],
    request: SearchRequest,
) -> list[Recipe]:
    """Keep strong cuisine and meal matches for the initial exact-mode deck."""

    return [
        recipe
        for recipe in strictly_eligible
        if best_cuisine_match(recipe.cuisine, request.preferred_cuisines) > 0
        and meal_type_matches(recipe.meal_type, request.preferred_meal_type)
    ]


__all__ = [
    "filter_eligible_recipes",
    "filter_exact_candidates",
    "normalize_allergen",
]

"""Small, valid test objects shared by the retrieval test suite."""

from dataclasses import replace
from typing import Any

from dishly_retrieval.models import Recipe


def make_recipe(recipe_id: str = "1", **overrides: Any) -> Recipe:
    """Create an immutable fictional recipe; no test data enters production."""

    recipe = Recipe(
        id=recipe_id,
        title=f"Test Recipe {recipe_id}",
        cuisine="italian",
        meal_type="dinner",
        vegan=False,
        allergens=(),
        ingredients=("1 cup tomatoes", "1 tablespoon olive oil"),
        description="A bright tomato dinner for retrieval tests.",
        source_url=f"https://example.com/recipes/{recipe_id}",
        image_url=f"https://images.example.com/{recipe_id}.jpg",
        source_name="Example Kitchen",
        protein_grams=30.0,
        calories=500.0,
        carbs_grams=45.0,
        fat_grams=20.0,
        time_minutes=30,
        servings=4.0,
        source_verified_at="2026-07-17",
        image_width=1200,
        image_height=800,
        image_quality_verified=True,
        nutrition_basis="per serving",
    )
    return replace(recipe, **overrides)


def make_record(recipe_id: str = "1", **overrides: Any) -> dict[str, Any]:
    """Create the JSON shape used by corpus validation tests."""

    recipe = make_recipe(recipe_id, **overrides)
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

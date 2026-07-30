"""Tests for extracting reviewable metadata from publisher JSON-LD.

The HTML strings are deliberately small, fictional Schema.org examples. They
test our parser without requesting or copying any real publisher page.
"""

import unittest

from dishly_retrieval.source_extraction import (
    RecipeExtractionError,
    extract_number_from_mapping,
    extract_recipe_metadata,
    parse_iso_duration,
    parse_positive_integer,
    parse_servings,
    promote_publisher_image_size,
    strip_cdn_resize_parameters,
)

FULL_RECIPE_PAGE = """
<html><head>
  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Recipe",
      "name": "Lemon Lentil Bowl",
      "recipeIngredient": ["1 cup lentils", "1 lemon"],
      "image": ["https://images.example.com/lentil-bowl.jpg"],
      "recipeCuisine": "Mediterranean",
      "description": "A bright test-only bowl.",
      "publisher": {"name": "Example Kitchen"},
      "totalTime": "PT1H15M",
      "nutrition": {"proteinContent": "24 g", "calories": "480 kcal"}
    }
  </script>
</head></html>
"""


class SourceExtractionTests(unittest.TestCase):
    """Prove publisher metadata is extracted without becoming trusted data yet."""

    def test_extracts_reviewable_metadata_from_a_recipe_object(self) -> None:
        """Schema.org fields should arrive intact for the curator to review."""

        metadata = extract_recipe_metadata(
            FULL_RECIPE_PAGE,
            "https://example.com/lemon-lentil-bowl",
        )

        self.assertEqual(metadata.title, "Lemon Lentil Bowl")
        self.assertEqual(metadata.ingredients, ("1 cup lentils", "1 lemon"))
        self.assertEqual(metadata.image_url, "https://images.example.com/lentil-bowl.jpg")
        self.assertEqual(metadata.source_name, "Example Kitchen")
        self.assertEqual(metadata.cuisine, "Mediterranean")
        self.assertEqual(metadata.protein_grams, 24.0)
        self.assertEqual(metadata.calories, 480.0)
        self.assertEqual(metadata.time_minutes, 75)

    def test_finds_a_recipe_inside_an_at_graph_container(self) -> None:
        """Pages with organization metadata and a recipe graph still work."""

        page = """
        <script type="application/ld+json">
          {"@graph": [
            {"@type": "Organization", "name": "Example Kitchen"},
            {"@type": "Recipe", "name": "Graph Soup",
             "recipeIngredient": ["water"]}
          ]}
        </script>
        """

        metadata = extract_recipe_metadata(page, "https://example.com/graph-soup")

        self.assertEqual(metadata.title, "Graph Soup")
        self.assertEqual(metadata.source_name, "example.com")

    def test_missing_required_ingredients_rejects_the_source(self) -> None:
        """Dishly cannot show a recipe card whose source omits ingredients."""

        page = """
        <script type="application/ld+json">
          {"@type": "Recipe", "name": "Incomplete Recipe"}
        </script>
        """

        with self.assertRaisesRegex(RecipeExtractionError, "recipeIngredient"):
            extract_recipe_metadata(page, "https://example.com/incomplete")

    def test_iso_duration_parser_converts_hours_and_minutes(self) -> None:
        """Publisher duration syntax becomes the integer minutes Dishly stores."""

        self.assertEqual(parse_iso_duration("PT1H15M"), 75)
        self.assertEqual(parse_iso_duration("PT45M"), 45)
        self.assertEqual(parse_iso_duration("P1DT2H3M"), 1563)
        self.assertIsNone(parse_iso_duration(None))
        self.assertIsNone(parse_iso_duration("PT"))
        self.assertIsNone(parse_iso_duration("about an hour"))

    def test_common_publisher_shapes_are_normalized_without_guessing(self) -> None:
        """Exercise the small parsers used across inconsistent Recipe JSON-LD."""

        page = """
        <script type="application/ld+json">
          {"@type": "https://schema.org/Recipe", "name": "Publisher Curry",
           "url": "https://example.com/curry/", "recipeIngredient": ["tofu"],
           "recipeCuisine": ["Thai", "Asian"],
           "author": [{"name": "Example Author"}],
           "recipeYield": [false, "Serves 4"],
           "image": [{"url": "/curry.jpg?width=300", "width": "900", "height": 700}],
           "nutrition": {"proteinContent": 20, "fatContent": false}}
        </script>
        """
        metadata = extract_recipe_metadata(page, "https://example.com/curry")
        self.assertEqual(metadata.cuisine, "Thai, Asian")
        self.assertEqual(metadata.source_name, "Example Author")
        self.assertEqual(metadata.servings, 4.0)
        self.assertEqual(metadata.protein_grams, 20.0)
        self.assertIsNone(metadata.fat_grams)
        self.assertEqual(metadata.image_url, "https://example.com/curry.jpg?width=300")
        self.assertIn(
            "https://example.com/curry.jpg",
            {candidate.url for candidate in metadata.image_candidates},
        )

        self.assertEqual(parse_servings([False, -1, "makes 6 bowls"]), 6.0)
        self.assertIsNone(parse_servings([False, "unknown"]))
        self.assertEqual(parse_positive_integer(8), 8)
        self.assertEqual(parse_positive_integer("12"), 12)
        self.assertIsNone(parse_positive_integer(True))
        self.assertIsNone(extract_number_from_mapping([], "calories"))
        self.assertIsNone(extract_number_from_mapping({"calories": "unknown"}, "calories"))

    def test_cdn_image_helpers_change_only_known_resize_parameters(self) -> None:
        original = "https://images.example.com/dish.jpg?width=300&token=abc"
        self.assertEqual(
            strip_cdn_resize_parameters(original),
            "https://images.example.com/dish.jpg?token=abc",
        )
        bbc = "https://images.immediate.co.uk/dish.jpg?resize=300,200&quality=90"
        self.assertIn("resize=1100%2C1000", promote_publisher_image_size(bbc))
        self.assertEqual(promote_publisher_image_size(original), original)

    def test_invalid_url_and_missing_recipe_are_rejected(self) -> None:
        with self.assertRaisesRegex(RecipeExtractionError, "public"):
            extract_recipe_metadata(FULL_RECIPE_PAGE, "http://127.0.0.1/recipe")
        with self.assertRaisesRegex(RecipeExtractionError, "No Schema"):
            extract_recipe_metadata(
                '<script type="application/ld+json">not-json</script>',
                "https://example.com/missing",
            )

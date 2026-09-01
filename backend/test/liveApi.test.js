const assert = require("node:assert/strict");
const test = require("node:test");

require("dotenv").config();

const { parseGoal } = require("../src/services/geminiService");
const { getRecipeById, searchRecipes } = require("../src/services/spoonacularService");

const liveEnabled =
  process.env.npm_lifecycle_event === "test:live" || process.env.RUN_LIVE_API_TESTS === "1";

test(
  "live Gemini parsing and Spoonacular search/detail integration",
  { skip: liveEnabled ? false : "run with npm run test:live" },
  async () => {
    assert.ok(
      String(process.env.GEMINI_API_KEY || "").trim(),
      "GEMINI_API_KEY is required for npm run test:live"
    );
    assert.ok(
      String(process.env.SPOONACULAR_API_KEY || "").trim(),
      "SPOONACULAR_API_KEY is required for npm run test:live"
    );

    const parsedFilter = await parseGoal(
      "vegan dinner under 600 calories, at least 20 grams of protein, ready within 45 minutes"
    );
    assert.equal(parsedFilter.diet, "vegan");
    for (const field of ["maxCalories", "minProtein_g", "maxReadyTime"]) {
      if (parsedFilter[field] !== undefined) {
        assert.ok(Number.isInteger(parsedFilter[field]), `${field} must be an integer when present`);
      }
    }
    assert.ok(
      ["maxCalories", "minProtein_g", "maxReadyTime", "query", "mealType"].some(
        (field) => parsedFilter[field] !== undefined,
      ),
      "Gemini should return at least one useful search constraint in addition to diet",
    );

    const recipes = await searchRecipes(parsedFilter, { limit: 2, offset: 0 });
    assert.ok(Array.isArray(recipes));
    assert.ok(recipes.length <= 2);

    if (recipes.length > 0) {
      const detail = await getRecipeById(recipes[0].id);
      assert.equal(detail.id, recipes[0].id);
      assert.ok(detail.title);
    }
  }
);

const assert = require("node:assert/strict");
const test = require("node:test");

require("dotenv").config();

const liveEnabled =
  process.env.npm_lifecycle_event === "test:live" || process.env.RUN_LIVE_API_TESTS === "1";
if (liveEnabled) process.env.NODE_ENV = "production";

const { parseGoal } = require("../src/services/geminiService");
const { getRecipeById, searchRecipes } = require("../src/services/spoonacularService");

const requestedIterations = Number(process.env.LIVE_API_ITERATIONS || 1);
const liveIterations =
  Number.isInteger(requestedIterations) && requestedIterations >= 1 && requestedIterations <= 5
    ? requestedIterations
    : 1;
const scenarios = [
  "vegan dinner under 600 calories, at least 20 grams of protein, ready within 45 minutes",
  "Italian dinner ready within 60 minutes",
  "Japanese dessert without peanuts",
];

test(
  "live Gemini parsing and Spoonacular search/detail integration",
  { skip: liveEnabled ? false : "run with npm run test:live" },
  async (context) => {
    assert.ok(
      String(process.env.GEMINI_API_KEY || "").trim(),
      "GEMINI_API_KEY is required for npm run test:live"
    );
    assert.ok(
      String(process.env.SPOONACULAR_API_KEY || "").trim(),
      "SPOONACULAR_API_KEY is required for npm run test:live"
    );

    for (let index = 0; index < liveIterations; index += 1) {
      const prompt = scenarios[index % scenarios.length];
      await context.test(`provider round ${index + 1}: ${prompt}`, async () => {
        const parsedFilter = await parseGoal(prompt);
        assert.ok(
          Object.keys(parsedFilter).length > 0,
          "Gemini should return at least one useful search constraint"
        );
        if (index === 0) assert.equal(parsedFilter.diet, "vegan");

        for (const field of ["maxCalories", "minProtein_g", "maxReadyTime"]) {
          if (parsedFilter[field] !== undefined) {
            assert.ok(
              Number.isInteger(parsedFilter[field]),
              `${field} must be an integer when present`
            );
          }
        }

        const recipes = await searchRecipes(parsedFilter, { limit: 2, offset: 0 });
        assert.ok(Array.isArray(recipes));
        assert.ok(recipes.length > 0 && recipes.length <= 2, "Spoonacular should return a recipe");

        const detail = await getRecipeById(recipes[0].id);
        assert.equal(detail.id, recipes[0].id);
        assert.ok(detail.title);
      });
    }
  }
);

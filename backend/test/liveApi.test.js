const assert = require("node:assert/strict");
const test = require("node:test");

require("dotenv").config();

const {
  checkRetrievalReadiness,
  getRecipeById,
  parseGoal,
  searchRecipePage,
} = require("../src/services/retrievalService");

const liveEnabled =
  ["test:live", "test:local"].includes(process.env.npm_lifecycle_event) ||
  process.env.RUN_LIVE_API_TESTS === "1";

test(
  "live local Ollama parsing and retrieval search/detail integration",
  { skip: liveEnabled ? false : "run with npm run test:live" },
  async () => {
    assert.ok(
      String(process.env.RETRIEVAL_SERVICE_URL || "").trim(),
      "RETRIEVAL_SERVICE_URL is required for npm run test:live"
    );
    assert.equal(
      await checkRetrievalReadiness(),
      true,
      "The private retrieval service must be ready for npm run test:live"
    );

    const rawText =
      "vegan dinner under 600 calories, at least 20 grams of protein, ready within 45 minutes";
    const parsedFilter = await parseGoal(rawText);
    assert.equal(parsedFilter.diet, "vegan");
    assert.ok(Number.isInteger(parsedFilter.maxCalories));
    assert.ok(Number.isInteger(parsedFilter.minProtein_g));
    assert.ok(Number.isInteger(parsedFilter.maxReadyTime));

    const page = await searchRecipePage(
      { rawText, parsedFilter },
      { limit: 2, offset: 0, matchMode: "exact", excludedRecipeIds: [] }
    );
    assert.ok(Array.isArray(page.recipes));
    assert.ok(page.recipes.length <= 2);
    assert.equal(page.match.mode, "exact");

    if (page.recipes.length > 0) {
      const detail = await getRecipeById(page.recipes[0].id);
      assert.equal(detail.id, page.recipes[0].id);
      assert.ok(detail.title);
    }
  }
);

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ALLOWED_CUISINES,
  ALLOWED_DIETS,
  ALLOWED_INTOLERANCES,
  ALLOWED_MEAL_TYPES,
  FILTER_LIMITS,
  GOAL_FILTER_FIELDS,
  GOAL_FILTER_JSON_SCHEMA,
  GoalFilterValidationError,
  normalizeGoalFilter,
} = require("../src/services/goalFilter");

test("normalizeGoalFilter canonicalizes supported fields without mutating input", () => {
  const input = {
    query: "  cozy   noodles  ",
    maxCalories: 650,
    minProtein_g: 30,
    diet: "  Low   FODMAP ",
    cuisines: ["  Japanese ", "Italian", "japanese"],
    mealType: " Main   Course ",
    maxReadyTime: 45,
    excludeIngredients: [
      " Peanuts ",
      "peanuts",
      "  green   onions  ",
      "",
      42,
      "x".repeat(81),
    ],
    intolerances: [" Peanut ", "peanut", "Tree   Nut"],
    unexpected: true,
  };

  assert.deepEqual(normalizeGoalFilter(input), {
    query: "cozy noodles",
    maxCalories: 650,
    minProtein_g: 30,
    diet: "low fodmap",
    cuisines: ["japanese", "italian"],
    mealType: "main course",
    maxReadyTime: 45,
    excludeIngredients: ["Peanuts", "green onions"],
    intolerances: ["peanut", "tree nut"],
  });
  assert.equal(input.diet, "  Low   FODMAP ");
  assert.equal(input.excludeIngredients.length, 6);
});

test("non-strict normalization strips invalid roots, values, and unknown fields", () => {
  assert.deepEqual(normalizeGoalFilter(null), {});
  assert.deepEqual(normalizeGoalFilter([]), {});
  assert.deepEqual(normalizeGoalFilter("vegan"), {});
  assert.deepEqual(
    normalizeGoalFilter({
      maxCalories: "500",
      minProtein_g: -1,
      maxReadyTime: 3.5,
      diet: "carnivore",
      cuisines: ["martian"],
      mealType: "lunch",
      intolerances: "peanut",
      excludeIngredients: "peanuts",
      query: " ",
    }),
    {}
  );
});

test("non-strict ingredient normalization deduplicates and enforces the item cap", () => {
  const ingredients = Array.from({ length: 30 }, (_, index) => ` ingredient ${index} `);
  ingredients.splice(1, 0, "INGREDIENT 0");

  const normalized = normalizeGoalFilter({ excludeIngredients: ingredients });
  assert.equal(normalized.excludeIngredients.length, FILTER_LIMITS.excludeIngredients.maxItems);
  assert.deepEqual(normalized.excludeIngredients.slice(0, 2), ["ingredient 0", "ingredient 1"]);
});

test("strict normalization returns canonical valid data", () => {
  assert.deepEqual(
    normalizeGoalFilter(
      {
        query: " ramen ",
        maxCalories: 1,
        minProtein_g: 0,
        diet: " Vegan ",
        cuisines: [" Japanese ", "Italian", "japanese"],
        mealType: " Dessert ",
        maxReadyTime: 1440,
        excludeIngredients: [" soy ", "SOY"],
        intolerances: [" Peanut ", "PEANUT", "Tree Nut"],
      },
      { strict: true }
    ),
      {
        query: "ramen",
      maxCalories: 1,
      minProtein_g: 0,
        diet: "vegan",
        cuisines: ["japanese", "italian"],
        mealType: "dessert",
      maxReadyTime: 1440,
        excludeIngredients: ["soy"],
        intolerances: ["peanut", "tree nut"],
    }
  );
  assert.deepEqual(normalizeGoalFilter(undefined, { strict: true }), {});
});

test("nutrition ranges are validated as coherent per-serving bounds", () => {
  assert.deepEqual(
    normalizeGoalFilter({
      minCalories: 425,
      maxCalories: 575,
      minProtein_g: 34,
      maxProtein_g: 46,
      minCarbs_g: 51,
      maxCarbs_g: 69,
    }, { strict: true }),
    {
      minCalories: 425,
      maxCalories: 575,
      minProtein_g: 34,
      maxProtein_g: 46,
      minCarbs_g: 51,
      maxCarbs_g: 69,
    }
  );

  assert.deepEqual(
    normalizeGoalFilter({ minCarbs_g: 80, maxCarbs_g: 40 }),
    {}
  );
  assert.throws(
    () => normalizeGoalFilter({ minProtein_g: 50, maxProtein_g: 20 }, { strict: true }),
    (error) => error.details.some((detail) => detail.includes("minProtein_g must not exceed maxProtein_g"))
  );
});

test("culture alternatives, meal type, allergy, and semantic-query values are bounded and strict", () => {
  assert.deepEqual(
    normalizeGoalFilter({
      query: "  hot   noodle soup  ",
      cuisines: ["Vietnamese", "Italian", "vietnamese"],
      mealType: "Breakfast",
      intolerances: ["Dairy", "dairy", "Shellfish"],
    }),
    {
      query: "hot noodle soup",
      cuisines: ["vietnamese", "italian"],
      mealType: "breakfast",
      intolerances: ["dairy", "shellfish"],
    }
  );

  assert.deepEqual(
    normalizeGoalFilter({
      query: "x".repeat(FILTER_LIMITS.query.maxLength + 1),
      cuisines: ["not a cuisine"],
      mealType: "lunch",
      intolerances: ["not an intolerance"],
    }),
    {}
  );
  assert.deepEqual(normalizeGoalFilter({ cuisines: [] }), {});
  assert.throws(
    () => normalizeGoalFilter({ cuisines: ["not a cuisine"] }, { strict: true }),
    (error) => error.details.some((detail) => detail.includes("cuisines"))
  );
});

test("strict normalization throws a safe, actionable validation error", () => {
  assert.throws(
    () =>
      normalizeGoalFilter(
        {
          maxCalories: 0,
          minProtein_g: 501,
          maxReadyTime: Infinity,
          diet: "anything",
          excludeIngredients: [null, ""],
          extra: "field",
        },
        { strict: true }
      ),
    (error) => {
      assert.ok(error instanceof GoalFilterValidationError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "INVALID_GOAL_FILTER");
      assert.equal(error.publicMessage, "Invalid goal filter");
      assert.equal(error.retryable, false);
      assert.ok(error.details.some((detail) => detail.includes("maxCalories")));
      assert.ok(error.details.some((detail) => detail.includes("extra")));
      assert.doesNotMatch(error.message, /Infinity|anything/);
      return true;
    }
  );
});

test("strict normalization rejects invalid roots and oversized ingredient arrays", () => {
  assert.throws(
    () => normalizeGoalFilter(null, { strict: true }),
    (error) => error.code === "INVALID_GOAL_FILTER" && error.details[0] === "filter must be an object"
  );

  assert.throws(
    () =>
      normalizeGoalFilter(
        {
          excludeIngredients: Array.from(
            { length: FILTER_LIMITS.excludeIngredients.maxItems + 1 },
            (_, index) => `item-${index}`
          ),
        },
        { strict: true }
      ),
    (error) => error.details.some((detail) => detail.includes("no more than 20"))
  );
});

test("the Gemini response schema matches the canonical filter contract", () => {
  assert.deepEqual(Object.keys(GOAL_FILTER_JSON_SCHEMA.properties), GOAL_FILTER_FIELDS);
  assert.equal(GOAL_FILTER_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(GOAL_FILTER_JSON_SCHEMA.properties.diet.enum, ALLOWED_DIETS);
  assert.deepEqual(GOAL_FILTER_JSON_SCHEMA.properties.cuisines.items.enum, ALLOWED_CUISINES);
  assert.equal(
    GOAL_FILTER_JSON_SCHEMA.properties.cuisines.maxItems,
    FILTER_LIMITS.cuisines.maxItems
  );
  assert.deepEqual(GOAL_FILTER_JSON_SCHEMA.properties.mealType.enum, ALLOWED_MEAL_TYPES);
  assert.deepEqual(GOAL_FILTER_JSON_SCHEMA.properties.intolerances.items.enum, ALLOWED_INTOLERANCES);
  assert.equal(
    GOAL_FILTER_JSON_SCHEMA.properties.excludeIngredients.maxItems,
    FILTER_LIMITS.excludeIngredients.maxItems
  );
  assert.equal(
    GOAL_FILTER_JSON_SCHEMA.properties.maxCalories.maximum,
    FILTER_LIMITS.maxCalories.max
  );
});

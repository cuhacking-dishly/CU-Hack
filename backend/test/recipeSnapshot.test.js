const assert = require("node:assert/strict");
const test = require("node:test");
const {
  sanitizeCollection,
  sanitizeNotes,
  sanitizeRating,
  sanitizeRecipeList,
  sanitizeRecipeSnapshot,
} = require("../src/services/recipeSnapshot");

function recipe(overrides = {}) {
  return {
    id: 101,
    title: "  Test bowl  ",
    image: "https://example.com/image.jpg",
    readyInMinutes: 20,
    servings: 2,
    calories: 450,
    macros: { protein_g: 22, carbs_g: 50, fat_g: 10 },
    diets: [" vegan ", 5, ""],
    ingredients: [" quinoa ", "avocado"],
    instructions: [" Cook. "],
    sourceName: " Test Kitchen ",
    sourceUrl: "https://example.com/recipe",
    ...overrides,
  };
}

test("recipe snapshots are bounded, canonical, and safe for durable storage", () => {
  assert.deepEqual(sanitizeRecipeSnapshot(recipe()), {
    id: "101",
    title: "Test bowl",
    image: "https://example.com/image.jpg",
    readyInMinutes: 20,
    servings: 2,
    calories: 450,
    macros: { protein_g: 22, carbs_g: 50, fat_g: 10 },
    diets: ["vegan"],
    ingredients: ["quinoa", "avocado"],
    instructions: ["Cook."],
    sourceName: "Test Kitchen",
    sourceUrl: "https://example.com/recipe",
  });

  const degraded = sanitizeRecipeSnapshot(recipe({
    image: "javascript:alert(1)", sourceUrl: "not a URL", macros: [],
    readyInMinutes: -1, servings: Infinity, calories: "bad", diets: null,
    ingredients: ["x".repeat(600)], instructions: {}, sourceName: 7,
  }));
  assert.equal(degraded.image, "");
  assert.equal(degraded.sourceUrl, "");
  assert.deepEqual(degraded.macros, { protein_g: null, carbs_g: null, fat_g: null });
  assert.equal(degraded.readyInMinutes, null);
  assert.deepEqual(degraded.ingredients, ["x".repeat(500)]);
  assert.deepEqual(degraded.instructions, []);
  assert.equal(degraded.sourceName, "");
});

test("recipe snapshots reject malformed required fields and excessive imports", () => {
  for (const value of [null, [], "recipe"]) {
    assert.throws(() => sanitizeRecipeSnapshot(value), /recipe is required/);
  }
  for (const value of ["0", "-1", "abc"]) {
    assert.throws(() => sanitizeRecipeSnapshot(recipe({ id: value })), /positive integer/);
  }
  assert.throws(() => sanitizeRecipeSnapshot(recipe({ title: " " })), /recipe.title is required/);
  assert.throws(() => sanitizeRecipeSnapshot(recipe({ title: "x".repeat(201) })), /at most 200/);
  assert.throws(() => sanitizeRecipeSnapshot(recipe({ id: {} })), /recipe.id is required/);
  assert.throws(() => sanitizeRecipeList({}), /recipes must be an array/);
  assert.throws(() => sanitizeRecipeList(Array(201).fill(recipe())), /at most 200/);
  assert.deepEqual(sanitizeRecipeList([recipe(), recipe(), recipe({ id: 102 })]).map((item) => item.id), ["101", "102"]);
});

test("notes, ratings, and collections enforce their public contracts", () => {
  assert.equal(sanitizeNotes(null), "");
  assert.equal(sanitizeNotes("  delicious  "), "delicious");
  assert.throws(() => sanitizeNotes(5), /must be text/);
  assert.throws(() => sanitizeNotes("x".repeat(2001)), /at most 2000/);
  assert.equal(sanitizeRating(null), null);
  assert.equal(sanitizeRating(""), null);
  assert.equal(sanitizeRating("5"), 5);
  for (const value of [0, 6, 1.5, "bad"]) assert.throws(() => sanitizeRating(value), /1 to 5/);
  assert.deepEqual(sanitizeCollection({ name: " Weeknight ", description: " Fast " }), { name: "Weeknight", description: "Fast" });
  assert.throws(() => sanitizeCollection(null), /collection is required/);
  assert.throws(() => sanitizeCollection({ name: "x".repeat(81) }), /at most 80/);
});

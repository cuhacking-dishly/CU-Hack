const assert = require("node:assert/strict");
const test = require("node:test");

const {
  addSwipe,
  clearStore,
  getGoal,
  getSwipes,
  setGoal,
} = require("../src/store/memoryStore");

test.beforeEach(clearStore);
test.afterEach(clearStore);

test("memory store saves, replaces, and isolates goals by user", () => {
  setGoal("user-a", "high protein", { minProtein_g: 30 });
  setGoal("user-b", "vegan", { diet: "vegan" });

  const firstGoal = getGoal("user-a");
  assert.equal(firstGoal.rawText, "high protein");
  assert.deepEqual(firstGoal.parsedFilter, { minProtein_g: 30 });
  assert.match(firstGoal.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(getGoal("missing"), null);

  setGoal("user-a", "quick", { maxReadyTime: 20 });
  assert.equal(getGoal("user-a").rawText, "quick");
  assert.deepEqual(getGoal("user-a").parsedFilter, { maxReadyTime: 20 });
  assert.equal(getGoal("user-b").rawText, "vegan");
});

test("memory store clones goal values on write and read", () => {
  const parsedFilter = { diet: "vegan", excludeIngredients: ["peanuts"] };
  setGoal("user-a", "vegan without peanuts", parsedFilter);

  parsedFilter.diet = "paleo";
  parsedFilter.excludeIngredients.push("soy");
  assert.deepEqual(getGoal("user-a").parsedFilter, {
    diet: "vegan",
    excludeIngredients: ["peanuts"],
  });

  const returnedGoal = getGoal("user-a");
  returnedGoal.rawText = "mutated";
  returnedGoal.parsedFilter.excludeIngredients.push("tree nuts");

  assert.deepEqual(getGoal("user-a"), {
    rawText: "vegan without peanuts",
    parsedFilter: { diet: "vegan", excludeIngredients: ["peanuts"] },
    updatedAt: getGoal("user-a").updatedAt,
  });
});

test("memory store records isolated swipe histories and clones returned entries", () => {
  addSwipe("user-a", "101", "right");
  addSwipe("user-b", "202", "left");
  addSwipe("user-a", "303", "left");

  const userASwipes = getSwipes("user-a");
  assert.deepEqual(
    userASwipes.map(({ userId, recipeId, direction }) => ({ userId, recipeId, direction })),
    [
      { userId: "user-a", recipeId: "101", direction: "right" },
      { userId: "user-a", recipeId: "303", direction: "left" },
    ]
  );
  assert.match(userASwipes[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(getSwipes("missing").length, 0);

  userASwipes[0].direction = "left";
  assert.equal(getSwipes("user-a")[0].direction, "right");
  assert.deepEqual(
    getSwipes("user-b").map(({ recipeId, direction }) => ({ recipeId, direction })),
    [{ recipeId: "202", direction: "left" }]
  );
});

test("memory store caps retained swipe history per user", () => {
  for (let index = 0; index < 1005; index += 1) {
    addSwipe("user-a", String(index), "right");
  }

  const swipes = getSwipes("user-a");
  assert.equal(swipes.length, 1000);
  assert.equal(swipes[0].recipeId, "5");
  assert.equal(swipes.at(-1).recipeId, "1004");
});

test("clearStore removes all goals and swipes", () => {
  setGoal("user-a", "vegan", { diet: "vegan" });
  addSwipe("user-a", "101", "right");

  clearStore();

  assert.equal(getGoal("user-a"), null);
  assert.deepEqual(getSwipes("user-a"), []);
});

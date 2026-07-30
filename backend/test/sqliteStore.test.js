const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_SWIPES_PER_USER,
  MIGRATION_SQL,
  createSqliteStore,
  normalizeDatabasePath,
} = require("../src/store/sqliteStore");

let temporaryDirectory;
let databasePath;

test.beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dishly-sqlite-"));
  databasePath = path.join(temporaryDirectory, "nested", "dishly.sqlite");
});

test.afterEach(() => {
  fs.rmSync(temporaryDirectory, { force: true, recursive: true });
});

test("SQLite store initializes a durable WAL database and reports readiness", async () => {
  const store = createSqliteStore({ databasePath });
  await store.initialize();

  assert.equal(await store.checkReadiness(), true);
  assert.equal(fs.statSync(databasePath).isFile(), true);
  assert.match(MIGRATION_SQL, /CREATE TABLE IF NOT EXISTS dishly_goals/);

  await store.close();
  await store.close();
  await assert.rejects(store.checkReadiness(), /SQLite store is closed/);
});

test("SQLite store saves, replaces, isolates, and durably versions goals", async () => {
  const timestamps = [1_752_758_400_000, 1_752_758_400_000];
  const store = createSqliteStore({
    databasePath,
    now: () => timestamps.shift(),
  });
  const filter = { diet: "vegan", excludeIngredients: ["peanuts"] };

  await store.setGoal("user-a", "vegan dinner", filter);
  filter.diet = "paleo";
  const first = await store.getGoal("user-a");
  assert.deepEqual(first.parsedFilter, {
    diet: "vegan",
    excludeIngredients: ["peanuts"],
  });

  first.parsedFilter.excludeIngredients.push("soy");
  assert.deepEqual((await store.getGoal("user-a")).parsedFilter.excludeIngredients, ["peanuts"]);
  const firstVersion = first.updatedAt;

  await store.setGoal("user-a", "quick dinner", { maxReadyTime: 20 });
  const second = await store.getGoal("user-a");
  assert.equal(Date.parse(second.updatedAt), Date.parse(firstVersion) + 1);
  assert.equal(second.rawText, "quick dinner");
  assert.equal(await store.getGoal("missing"), null);
  await store.close();

  const reopened = createSqliteStore({ databasePath });
  assert.deepEqual(await reopened.getGoal("user-a"), second);
  await reopened.close();
});

test("SQLite store records ordered swipes, goal versions, and survives restart", async () => {
  let timestamp = 1_752_758_400_000;
  const store = createSqliteStore({
    databasePath,
    now: () => timestamp++,
  });
  await store.addSwipe("user-a", "101", "right", "2026-07-29T11:59:00.000Z");
  await store.addSwipe("user-b", "202", "left");
  await store.addSwipe("user-a", "303", "left");

  assert.deepEqual(await store.getSwipes("user-a"), [
    {
      userId: "user-a",
      recipeId: "101",
      direction: "right",
      timestamp: "2025-07-17T13:20:00.000Z",
      goalUpdatedAt: "2026-07-29T11:59:00.000Z",
    },
    {
      userId: "user-a",
      recipeId: "303",
      direction: "left",
      timestamp: "2025-07-17T13:20:00.002Z",
    },
  ]);
  assert.equal((await store.getSwipes("user-b"))[0].recipeId, "202");
  assert.deepEqual(await store.getSwipes("missing"), []);
  await store.close();

  const reopened = createSqliteStore({ databasePath });
  assert.equal((await reopened.getSwipes("user-a")).length, 2);
  await reopened.close();
});

test("SQLite store caps each user's swipe history without affecting other users", async () => {
  let timestamp = 1_752_758_400_000;
  const store = createSqliteStore({
    databasePath,
    now: () => timestamp++,
  });
  await store.addSwipe("user-b", "other", "right");
  for (let index = 0; index < MAX_SWIPES_PER_USER + 5; index += 1) {
    await store.addSwipe("user-a", String(index), "right");
  }

  const swipes = await store.getSwipes("user-a");
  assert.equal(swipes.length, MAX_SWIPES_PER_USER);
  assert.equal(swipes[0].recipeId, "5");
  assert.equal(swipes.at(-1).recipeId, String(MAX_SWIPES_PER_USER + 4));
  assert.equal((await store.getSwipes("user-b"))[0].recipeId, "other");
  await store.close();
});

test("SQLite writes roll back atomically and clearStore removes persisted state", async () => {
  const store = createSqliteStore({ databasePath });
  await assert.rejects(
    store.addSwipe("user-a", "101", "sideways"),
    /CHECK constraint failed/
  );
  assert.deepEqual(await store.getSwipes("user-a"), []);

  await store.setGoal("user-a", "vegan", { diet: "vegan" });
  await store.addSwipe("user-a", "101", "right");
  await store.clearStore();
  assert.equal(await store.getGoal("user-a"), null);
  assert.deepEqual(await store.getSwipes("user-a"), []);
  await store.close();
});

test("SQLite path validation accepts memory and resolves file paths", () => {
  assert.throws(() => normalizeDatabasePath(" "), /SQLITE_DATABASE_PATH is required/);
  assert.equal(normalizeDatabasePath(":memory:"), ":memory:");
  assert.equal(normalizeDatabasePath(databasePath), path.resolve(databasePath));
});

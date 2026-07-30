const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_SWIPES_PER_USER,
  createPool,
  createPostgresStore,
} = require("../src/store/postgresStore");

function fakePool(results = []) {
  const calls = [];
  let resultIndex = 0;
  return {
    calls,
    ended: false,
    async query(text, values) {
      calls.push({ text, values });
      const result = results[resultIndex];
      resultIndex += 1;
      return result || { rows: [] };
    },
    async end() {
      this.ended = true;
    },
  };
}

test("PostgreSQL store migrates, reports readiness, and closes its pool", async () => {
  const pool = fakePool([{ rows: [] }, { rows: [{ ready: 1 }] }]);
  const store = createPostgresStore({
    pool,
    migrationSql: "CREATE TABLE test_table (id INTEGER)",
  });

  await store.initialize();
  assert.equal(await store.checkReadiness(), true);
  await store.close();

  assert.equal(pool.calls[0].text, "CREATE TABLE test_table (id INTEGER)");
  assert.equal(pool.calls[1].text, "SELECT 1 AS ready");
  assert.equal(pool.ended, true);
});

test("PostgreSQL store returns false for an unexpected readiness row", async () => {
  const store = createPostgresStore({
    pool: fakePool([{ rows: [] }]),
    migrationSql: "",
  });
  assert.equal(await store.checkReadiness(), false);
});

test("PostgreSQL store saves and reads goals with JSON isolation", async () => {
  const updatedAt = new Date("2026-07-29T12:00:00.000Z");
  const pool = fakePool([
    { rows: [] },
    {
      rows: [{
        raw_text: "vegan dinner",
        parsed_filter: { diet: "vegan" },
        updated_at: updatedAt,
      }],
    },
    { rows: [] },
  ]);
  const store = createPostgresStore({ pool, migrationSql: "" });

  await store.setGoal("user-a", "vegan dinner", { diet: "vegan" });
  const goal = await store.getGoal("user-a");
  assert.deepEqual(goal, {
    rawText: "vegan dinner",
    parsedFilter: { diet: "vegan" },
    updatedAt: updatedAt.toISOString(),
  });
  goal.parsedFilter.diet = "changed";
  assert.equal((await store.getGoal("missing")), null);

  assert.match(pool.calls[0].text, /ON CONFLICT/);
  assert.deepEqual(pool.calls[0].values, [
    "user-a",
    "vegan dinner",
    JSON.stringify({ diet: "vegan" }),
  ]);
  assert.deepEqual(pool.calls[1].values, ["user-a"]);
});

test("PostgreSQL store records, reads, and caps swipe history", async () => {
  const pool = fakePool([
    { rows: [] },
    {
      rows: [
        {
          user_id: "user-a",
          recipe_id: "101",
          direction: "right",
          swiped_at: "2026-07-29T12:00:00.000Z",
          goal_updated_at: "2026-07-29T11:59:00.000Z",
        },
        {
          user_id: "user-a",
          recipe_id: "202",
          direction: "left",
          swiped_at: new Date("2026-07-29T12:01:00.000Z"),
          goal_updated_at: null,
        },
      ],
    },
    { rows: [] },
  ]);
  const store = createPostgresStore({ pool, migrationSql: "" });

  await store.addSwipe(
    "user-a",
    "101",
    "right",
    "2026-07-29T11:59:00.000Z"
  );
  assert.deepEqual(await store.getSwipes("user-a"), [
    {
      userId: "user-a",
      recipeId: "101",
      direction: "right",
      timestamp: "2026-07-29T12:00:00.000Z",
      goalUpdatedAt: "2026-07-29T11:59:00.000Z",
    },
    {
      userId: "user-a",
      recipeId: "202",
      direction: "left",
      timestamp: "2026-07-29T12:01:00.000Z",
    },
  ]);
  await store.clearStore();

  assert.match(pool.calls[0].text, /OFFSET \$5/);
  assert.deepEqual(pool.calls[0].values, [
    "user-a",
    "101",
    "right",
    "2026-07-29T11:59:00.000Z",
    MAX_SWIPES_PER_USER,
  ]);
  assert.match(pool.calls[2].text, /TRUNCATE TABLE/);
});

test("PostgreSQL pool configuration rejects a missing URL and accepts a URL", async () => {
  assert.throws(() => createPool(" "), /DATABASE_URL is required/);
  const pool = createPool("postgresql://localhost:5432/dishly");
  assert.equal(typeof pool.query, "function");
  await pool.end();
});

test("default migration SQL is loaded from the checked-in migration", async () => {
  const pool = fakePool([{ rows: [] }]);
  const store = createPostgresStore({ pool });
  await store.initialize();
  assert.match(pool.calls[0].text, /CREATE TABLE IF NOT EXISTS dishly_goals/);
});

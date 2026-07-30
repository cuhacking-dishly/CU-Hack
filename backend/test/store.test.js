const assert = require("node:assert/strict");
const test = require("node:test");

const indexPath = require.resolve("../src/store");
const postgresPath = require.resolve("../src/store/postgresStore");
const sqlitePath = require.resolve("../src/store/sqliteStore");
const memoryStore = require("../src/store/memoryStore");

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalSqliteDatabasePath = process.env.SQLITE_DATABASE_PATH;
const originalRequirePersistentStore = process.env.REQUIRE_PERSISTENT_STORE;

function restoreEnvironment() {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalSqliteDatabasePath === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = originalSqliteDatabasePath;
  if (originalRequirePersistentStore === undefined) {
    delete process.env.REQUIRE_PERSISTENT_STORE;
  } else {
    process.env.REQUIRE_PERSISTENT_STORE = originalRequirePersistentStore;
  }
}

function loadStore() {
  delete require.cache[indexPath];
  return require(indexPath);
}

test.beforeEach(() => {
  memoryStore.clearStore();
  delete process.env.DATABASE_URL;
  delete process.env.SQLITE_DATABASE_PATH;
  delete process.env.REQUIRE_PERSISTENT_STORE;
  delete require.cache[indexPath];
  delete require.cache[postgresPath];
  delete require.cache[sqlitePath];
});

test.afterEach(() => {
  memoryStore.clearStore();
  delete require.cache[indexPath];
  delete require.cache[postgresPath];
  delete require.cache[sqlitePath];
  restoreEnvironment();
});

test("store uses the in-memory adapter for local development", async () => {
  const store = loadStore();
  assert.equal(store.getStoreMode(), "memory");
  await store.initializeStore();
  assert.equal(await store.checkStoreReadiness(), true);

  await store.setGoal("local", "vegan", { diet: "vegan" });
  const goal = await store.getGoal("local");
  await store.addSwipe("local", "101", "right", goal.updatedAt);
  assert.equal((await store.getSwipes("local"))[0].recipeId, "101");
  await store.closeStore();
  store.resetStoreForTests();
});

test("store fails readiness when production requires persistence without a database", async () => {
  for (const value of ["true", "1", "YES", "on"]) {
    process.env.REQUIRE_PERSISTENT_STORE = value;
    assert.equal(await loadStore().checkStoreReadiness(), false);
  }
  process.env.REQUIRE_PERSISTENT_STORE = "false";
  assert.equal(await loadStore().checkStoreReadiness(), true);
});

test("store delegates to SQLite and can close and recreate the adapter", async () => {
  process.env.SQLITE_DATABASE_PATH = "C:\\private\\dishly.sqlite";
  const calls = [];
  const adapter = {
    initialize: async () => calls.push("initialize"),
    checkReadiness: async () => true,
    setGoal: async (...args) => calls.push(["setGoal", ...args]),
    getGoal: async (...args) => {
      calls.push(["getGoal", ...args]);
      return { rawText: "goal" };
    },
    addSwipe: async (...args) => calls.push(["addSwipe", ...args]),
    getSwipes: async (...args) => {
      calls.push(["getSwipes", ...args]);
      return [];
    },
    close: async () => calls.push("close"),
  };
  let creations = 0;
  require.cache[sqlitePath] = {
    id: sqlitePath,
    filename: sqlitePath,
    loaded: true,
    exports: {
      createSqliteStore() {
        creations += 1;
        return adapter;
      },
    },
  };

  const store = loadStore();
  assert.equal(store.getStoreMode(), "sqlite");
  await store.initializeStore();
  assert.equal(await store.checkStoreReadiness(), true);
  await store.setGoal("user", "goal", {});
  assert.deepEqual(await store.getGoal("user"), { rawText: "goal" });
  await store.addSwipe("user", "101", "left");
  assert.deepEqual(await store.getSwipes("user"), []);
  await store.closeStore();
  await store.initializeStore();

  assert.equal(creations, 2);
  assert.deepEqual(calls.slice(0, 7), [
    "initialize",
    ["setGoal", "user", "goal", {}],
    ["getGoal", "user"],
    ["addSwipe", "user", "101", "left"],
    ["getSwipes", "user"],
    "close",
    "initialize",
  ]);
});

test("PostgreSQL takes precedence when both persistent adapters are configured", () => {
  process.env.DATABASE_URL = "postgresql://private.test/dishly";
  process.env.SQLITE_DATABASE_PATH = "C:\\private\\dishly.sqlite";
  assert.equal(loadStore().getStoreMode(), "postgres");
});

test("store delegates to PostgreSQL and can close and recreate the adapter", async () => {
  process.env.DATABASE_URL = "postgresql://private.test/dishly";
  const calls = [];
  const adapter = {
    initialize: async () => calls.push("initialize"),
    checkReadiness: async () => true,
    setGoal: async (...args) => calls.push(["setGoal", ...args]),
    getGoal: async (...args) => {
      calls.push(["getGoal", ...args]);
      return { rawText: "goal" };
    },
    addSwipe: async (...args) => calls.push(["addSwipe", ...args]),
    getSwipes: async (...args) => {
      calls.push(["getSwipes", ...args]);
      return [];
    },
    close: async () => calls.push("close"),
  };
  let creations = 0;
  require.cache[postgresPath] = {
    id: postgresPath,
    filename: postgresPath,
    loaded: true,
    exports: {
      createPostgresStore() {
        creations += 1;
        return adapter;
      },
    },
  };

  const store = loadStore();
  assert.equal(store.getStoreMode(), "postgres");
  await store.initializeStore();
  assert.equal(await store.checkStoreReadiness(), true);
  await store.setGoal("user", "goal", {});
  assert.deepEqual(await store.getGoal("user"), { rawText: "goal" });
  await store.addSwipe("user", "101", "left");
  assert.deepEqual(await store.getSwipes("user"), []);
  await store.closeStore();
  await store.initializeStore();

  assert.equal(creations, 2);
  assert.deepEqual(calls.slice(0, 7), [
    "initialize",
    ["setGoal", "user", "goal", {}],
    ["getGoal", "user"],
    ["addSwipe", "user", "101", "left"],
    ["getSwipes", "user"],
    "close",
    "initialize",
  ]);
});

test("store readiness converts database errors to a false readiness result", async () => {
  process.env.DATABASE_URL = "postgresql://private.test/dishly";
  require.cache[postgresPath] = {
    id: postgresPath,
    filename: postgresPath,
    loaded: true,
    exports: {
      createPostgresStore: () => ({
        checkReadiness: async () => {
          throw new Error("database unavailable");
        },
      }),
    },
  };
  assert.equal(await loadStore().checkStoreReadiness(), false);
});

test("store readiness converts SQLite errors to a false readiness result", async () => {
  process.env.SQLITE_DATABASE_PATH = "C:\\private\\dishly.sqlite";
  require.cache[sqlitePath] = {
    id: sqlitePath,
    filename: sqlitePath,
    loaded: true,
    exports: {
      createSqliteStore: () => ({
        checkReadiness: async () => {
          throw new Error("database unavailable");
        },
      }),
    },
  };
  assert.equal(await loadStore().checkStoreReadiness(), false);
});

const memoryStore = require("./memoryStore");

let postgresStore;
let sqliteStore;

function hasDatabaseUrl() {
  return typeof process.env.DATABASE_URL === "string"
    && process.env.DATABASE_URL.trim() !== "";
}

function hasSqliteDatabasePath() {
  return typeof process.env.SQLITE_DATABASE_PATH === "string"
    && process.env.SQLITE_DATABASE_PATH.trim() !== "";
}

function requiresPersistentStore() {
  return /^(1|true|yes|on)$/i.test(
    String(process.env.REQUIRE_PERSISTENT_STORE || "").trim()
  );
}

function getStore() {
  if (hasDatabaseUrl()) {
    if (!postgresStore) {
      const { createPostgresStore } = require("./postgresStore");
      postgresStore = createPostgresStore();
    }
    return postgresStore;
  }
  if (hasSqliteDatabasePath()) {
    if (!sqliteStore) {
      const { createSqliteStore } = require("./sqliteStore");
      sqliteStore = createSqliteStore();
    }
    return sqliteStore;
  }
  return memoryStore;
}

async function initializeStore() {
  const store = getStore();
  if (typeof store.initialize === "function") await store.initialize();
}

async function checkStoreReadiness() {
  if (!hasDatabaseUrl() && !hasSqliteDatabasePath()) return !requiresPersistentStore();
  try {
    return await getStore().checkReadiness();
  } catch {
    return false;
  }
}

async function closeStore() {
  if (postgresStore) {
    await postgresStore.close();
    postgresStore = undefined;
  }
  if (sqliteStore) {
    await sqliteStore.close();
    sqliteStore = undefined;
  }
}

async function setGoal(...args) {
  return getStore().setGoal(...args);
}

async function getGoal(...args) {
  return getStore().getGoal(...args);
}

async function addSwipe(...args) {
  return getStore().addSwipe(...args);
}

async function getSwipes(...args) {
  return getStore().getSwipes(...args);
}

function getStoreMode() {
  if (hasDatabaseUrl()) return "postgres";
  if (hasSqliteDatabasePath()) return "sqlite";
  return "memory";
}

function resetStoreForTests() {
  postgresStore = undefined;
  sqliteStore = undefined;
}

module.exports = {
  addSwipe,
  checkStoreReadiness,
  closeStore,
  getGoal,
  getStoreMode,
  getSwipes,
  initializeStore,
  resetStoreForTests,
  setGoal,
};

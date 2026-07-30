const memoryStore = require("./memoryStore");

let postgresStore;

function hasDatabaseUrl() {
  return typeof process.env.DATABASE_URL === "string"
    && process.env.DATABASE_URL.trim() !== "";
}

function requiresPersistentStore() {
  return /^(1|true|yes|on)$/i.test(
    String(process.env.REQUIRE_PERSISTENT_STORE || "").trim()
  );
}

function getStore() {
  if (!hasDatabaseUrl()) return memoryStore;
  if (!postgresStore) {
    const { createPostgresStore } = require("./postgresStore");
    postgresStore = createPostgresStore();
  }
  return postgresStore;
}

async function initializeStore() {
  const store = getStore();
  if (typeof store.initialize === "function") await store.initialize();
}

async function checkStoreReadiness() {
  if (!hasDatabaseUrl()) return !requiresPersistentStore();
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
  return hasDatabaseUrl() ? "postgres" : "memory";
}

function resetStoreForTests() {
  postgresStore = undefined;
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

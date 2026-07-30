const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const MAX_SWIPES_PER_USER = 1000;

const MIGRATION_SQL = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS dishly_goals (
    user_id TEXT PRIMARY KEY,
    raw_text TEXT NOT NULL,
    parsed_filter TEXT NOT NULL CHECK (json_valid(parsed_filter)),
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS dishly_swipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    recipe_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('left', 'right')),
    swiped_at INTEGER NOT NULL,
    goal_updated_at TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS dishly_swipes_user_id_id
    ON dishly_swipes (user_id, id);
`;

function normalizeDatabasePath(databasePath = process.env.SQLITE_DATABASE_PATH) {
  if (typeof databasePath !== "string" || databasePath.trim() === "") {
    throw new Error("SQLITE_DATABASE_PATH is required for SQLite storage");
  }
  const normalized = databasePath.trim();
  return normalized === ":memory:" ? normalized : path.resolve(normalized);
}

function createDatabase(databasePath) {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  return new DatabaseSync(databasePath);
}

function toIsoString(milliseconds) {
  return new Date(Number(milliseconds)).toISOString();
}

function parseFilter(value) {
  const parsed = JSON.parse(value);
  return structuredClone(parsed);
}

function createSqliteStore({
  databasePath = process.env.SQLITE_DATABASE_PATH,
  database,
  now = Date.now,
} = {}) {
  const normalizedPath = database ? null : normalizeDatabasePath(databasePath);
  const db = database || createDatabase(normalizedPath);
  let closed = false;
  let initialized = false;

  function requireOpen() {
    if (closed) throw new Error("SQLite store is closed");
  }

  function initialize() {
    requireOpen();
    if (!initialized) {
      db.exec(MIGRATION_SQL);
      initialized = true;
    }
  }

  function withWriteTransaction(callback) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original write error if SQLite already rolled back.
      }
      throw error;
    }
  }

  return {
    async initialize() {
      initialize();
    },

    async checkReadiness() {
      initialize();
      return db.prepare("SELECT 1 AS ready").get()?.ready === 1;
    },

    async setGoal(userId, rawText, parsedFilter) {
      initialize();
      const updatedAt = now();
      db.prepare(
        `INSERT INTO dishly_goals (user_id, raw_text, parsed_filter, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           raw_text = excluded.raw_text,
           parsed_filter = excluded.parsed_filter,
           updated_at = CASE
             WHEN dishly_goals.updated_at >= excluded.updated_at
             THEN dishly_goals.updated_at + 1
             ELSE excluded.updated_at
           END`
      ).run(userId, rawText, JSON.stringify(parsedFilter), updatedAt);
    },

    async getGoal(userId) {
      initialize();
      const row = db.prepare(
        `SELECT raw_text, parsed_filter, updated_at
         FROM dishly_goals
         WHERE user_id = ?`
      ).get(userId);
      if (!row) return null;
      return {
        rawText: row.raw_text,
        parsedFilter: parseFilter(row.parsed_filter),
        updatedAt: toIsoString(row.updated_at),
      };
    },

    async addSwipe(userId, recipeId, direction, goalUpdatedAt) {
      initialize();
      withWriteTransaction(() => {
        db.prepare(
          `INSERT INTO dishly_swipes
             (user_id, recipe_id, direction, swiped_at, goal_updated_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(userId, recipeId, direction, now(), goalUpdatedAt || null);
        db.prepare(
          `DELETE FROM dishly_swipes
           WHERE id IN (
             SELECT id
             FROM dishly_swipes
             WHERE user_id = ?
             ORDER BY id DESC
             LIMIT -1 OFFSET ?
           )`
        ).run(userId, MAX_SWIPES_PER_USER);
      });
    },

    async getSwipes(userId) {
      initialize();
      return db.prepare(
        `SELECT user_id, recipe_id, direction, swiped_at, goal_updated_at
         FROM dishly_swipes
         WHERE user_id = ?
         ORDER BY id ASC`
      ).all(userId).map((row) => {
        const swipe = {
          userId: row.user_id,
          recipeId: row.recipe_id,
          direction: row.direction,
          timestamp: toIsoString(row.swiped_at),
        };
        if (row.goal_updated_at) swipe.goalUpdatedAt = row.goal_updated_at;
        return swipe;
      });
    },

    async clearStore() {
      initialize();
      withWriteTransaction(() => {
        db.exec("DELETE FROM dishly_swipes; DELETE FROM dishly_goals;");
      });
    },

    async close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },
  };
}

module.exports = {
  MAX_SWIPES_PER_USER,
  MIGRATION_SQL,
  createSqliteStore,
  normalizeDatabasePath,
};

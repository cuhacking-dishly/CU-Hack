const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const MAX_SWIPES_PER_USER = 1000;
const MIGRATION_PATH = path.join(__dirname, "migrations", "001_initial.sql");

function clone(value) {
  return structuredClone(value);
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function createPool(databaseUrl = process.env.DATABASE_URL) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required for PostgreSQL storage");
  }

  return new Pool({
    connectionString: databaseUrl.trim(),
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

function createPostgresStore({ pool = createPool(), migrationSql } = {}) {
  const schemaSql = migrationSql ?? fs.readFileSync(MIGRATION_PATH, "utf8");

  return {
    async initialize() {
      await pool.query(schemaSql);
    },

    async checkReadiness() {
      const result = await pool.query("SELECT 1 AS ready");
      return result.rows[0]?.ready === 1;
    },

    async setGoal(userId, rawText, parsedFilter) {
      await pool.query(
        `INSERT INTO dishly_goals (user_id, raw_text, parsed_filter, updated_at)
         VALUES ($1, $2, $3::jsonb, clock_timestamp())
         ON CONFLICT (user_id) DO UPDATE SET
           raw_text = EXCLUDED.raw_text,
           parsed_filter = EXCLUDED.parsed_filter,
           updated_at = CASE
             WHEN dishly_goals.updated_at >= clock_timestamp()
             THEN dishly_goals.updated_at + INTERVAL '1 millisecond'
             ELSE clock_timestamp()
           END`,
        [userId, rawText, JSON.stringify(parsedFilter)]
      );
    },

    async getGoal(userId) {
      const result = await pool.query(
        `SELECT raw_text, parsed_filter, updated_at
         FROM dishly_goals
         WHERE user_id = $1`,
        [userId]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        rawText: row.raw_text,
        parsedFilter: clone(row.parsed_filter),
        updatedAt: normalizeTimestamp(row.updated_at),
      };
    },

    async addSwipe(userId, recipeId, direction, goalUpdatedAt) {
      await pool.query(
        `WITH inserted AS (
           INSERT INTO dishly_swipes
             (user_id, recipe_id, direction, goal_updated_at)
           VALUES ($1, $2, $3, $4)
           RETURNING id
         )
         DELETE FROM dishly_swipes
         WHERE id IN (
           SELECT id
           FROM dishly_swipes
           WHERE user_id = $1
           ORDER BY id DESC
           OFFSET $5
         )`,
        [userId, recipeId, direction, goalUpdatedAt || null, MAX_SWIPES_PER_USER]
      );
    },

    async getSwipes(userId) {
      const result = await pool.query(
        `SELECT user_id, recipe_id, direction, swiped_at, goal_updated_at
         FROM dishly_swipes
         WHERE user_id = $1
         ORDER BY id ASC`,
        [userId]
      );
      return result.rows.map((row) => {
        const swipe = {
          userId: row.user_id,
          recipeId: row.recipe_id,
          direction: row.direction,
          timestamp: normalizeTimestamp(row.swiped_at),
        };
        if (row.goal_updated_at) {
          swipe.goalUpdatedAt = normalizeTimestamp(row.goal_updated_at);
        }
        return swipe;
      });
    },

    async clearStore() {
      await pool.query("TRUNCATE TABLE dishly_swipes, dishly_goals RESTART IDENTITY");
    },

    async close() {
      await pool.end();
    },
  };
}

module.exports = {
  MAX_SWIPES_PER_USER,
  createPool,
  createPostgresStore,
};

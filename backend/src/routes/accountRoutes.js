const express = require("express");
const {
  authenticateRequest,
  databaseRequest,
  deleteAccount,
  getPublicAccountConfig,
} = require("../services/accountService");
const {
  sanitizeCollection,
  sanitizeNotes,
  sanitizeRating,
  sanitizeRecipeList,
  sanitizeRecipeSnapshot,
} = require("../services/recipeSnapshot");
const { asyncRoute, createHttpError, parseIntegerQuery, requireSingleQueryValue } = require("./routeUtils");

const router = express.Router();

router.get("/auth/config", (_req, res) => res.json(getPublicAccountConfig()));

router.get("/me", protectedRoute(async (req, res) => {
  const { user } = req.account;
  res.json({
    id: user.id,
    email: typeof user.email === "string" ? user.email : "",
    displayName: getDisplayName(user),
    avatarUrl: safeHttpUrl(user.user_metadata?.avatar_url),
  });
}));

router.get(
  "/saved-recipes",
  protectedRoute(async (req, res) => {
    const limit = parseIntegerQuery(requireSingleQueryValue(req.query, "limit"), {
      field: "limit", min: 1, max: 100, defaultValue: 100,
    });
    const offset = parseIntegerQuery(requireSingleQueryValue(req.query, "offset"), {
      field: "offset", min: 0, max: 10000, defaultValue: 0,
    });
    const query = new URLSearchParams({
      select: "id,provider_recipe_id,recipe_snapshot,personal_notes,rating,created_at,updated_at",
      order: "created_at.desc",
      limit: String(limit),
      offset: String(offset),
    });
    const rows = await databaseRequest(req.account, "saved_recipes", { query: query.toString() });
    res.json({ recipes: rows.map(toSavedRecipe), pagination: { limit, offset, count: rows.length } });
  }),
);

router.put(
  "/saved-recipes/:recipeId",
  protectedRoute(async (req, res) => {
    const recipe = sanitizeRecipeSnapshot(req.body?.recipe);
    if (recipe.id !== req.params.recipeId) throw createHttpError(400, "recipe ID does not match the URL");
    const rows = await databaseRequest(req.account, "saved_recipes", {
      method: "POST",
      query: "on_conflict=user_id,provider,provider_recipe_id",
      prefer: "resolution=merge-duplicates,return=representation",
      body: {
        user_id: req.account.user.id,
        provider: "spoonacular",
        provider_recipe_id: recipe.id,
        recipe_snapshot: recipe,
      },
    });
    res.json(toSavedRecipe(rows[0]));
  }),
);

router.post(
  "/saved-recipes/import",
  protectedRoute(async (req, res) => {
    const recipes = sanitizeRecipeList(req.body?.recipes);
    if (recipes.length === 0) return res.json({ imported: 0 });
    await databaseRequest(req.account, "saved_recipes", {
      method: "POST",
      query: "on_conflict=user_id,provider,provider_recipe_id",
      prefer: "resolution=ignore-duplicates,return=minimal",
      body: recipes.map((recipe) => ({
        user_id: req.account.user.id,
        provider: "spoonacular",
        provider_recipe_id: recipe.id,
        recipe_snapshot: recipe,
      })),
    });
    res.json({ imported: recipes.length });
  }),
);

router.patch(
  "/saved-recipes/:recipeId",
  protectedRoute(async (req, res) => {
    const body = {};
    if (Object.hasOwn(req.body || {}, "notes")) body.personal_notes = sanitizeNotes(req.body.notes);
    if (Object.hasOwn(req.body || {}, "rating")) body.rating = sanitizeRating(req.body.rating);
    if (Object.keys(body).length === 0) throw createHttpError(400, "notes or rating is required");
    const query = new URLSearchParams({
      provider: "eq.spoonacular",
      provider_recipe_id: `eq.${requireRecipeId(req.params.recipeId)}`,
      select: "id,provider_recipe_id,recipe_snapshot,personal_notes,rating,created_at,updated_at",
    });
    const rows = await databaseRequest(req.account, "saved_recipes", {
      method: "PATCH", query: query.toString(), prefer: "return=representation", body,
    });
    if (!rows.length) throw createHttpError(404, "Saved recipe not found");
    res.json(toSavedRecipe(rows[0]));
  }),
);

router.delete(
  "/saved-recipes/:recipeId",
  protectedRoute(async (req, res) => {
    const query = new URLSearchParams({
      provider: "eq.spoonacular",
      provider_recipe_id: `eq.${requireRecipeId(req.params.recipeId)}`,
    });
    await databaseRequest(req.account, "saved_recipes", { method: "DELETE", query: query.toString() });
    res.status(204).end();
  }),
);

router.get(
  "/collections",
  protectedRoute(async (req, res) => {
    const query = new URLSearchParams({ select: "id,name,description,created_at,updated_at", order: "name.asc" });
    res.json({ collections: await databaseRequest(req.account, "collections", { query: query.toString() }) });
  }),
);

router.post(
  "/collections",
  protectedRoute(async (req, res) => {
    const collection = sanitizeCollection(req.body);
    const rows = await databaseRequest(req.account, "collections", {
      method: "POST", prefer: "return=representation", body: { ...collection, user_id: req.account.user.id },
    });
    res.status(201).json(rows[0]);
  }),
);

router.patch(
  "/collections/:id",
  protectedRoute(async (req, res) => {
    const collection = sanitizeCollection(req.body);
    const rows = await databaseRequest(req.account, "collections", {
      method: "PATCH", query: `id=eq.${requireUuid(req.params.id)}&select=id,name,description,created_at,updated_at`,
      prefer: "return=representation", body: collection,
    });
    if (!rows.length) throw createHttpError(404, "Collection not found");
    res.json(rows[0]);
  }),
);

router.delete(
  "/collections/:id",
  protectedRoute(async (req, res) => {
    await databaseRequest(req.account, "collections", { method: "DELETE", query: `id=eq.${requireUuid(req.params.id)}` });
    res.status(204).end();
  }),
);

router.put(
  "/collections/:id/recipes/:recipeId",
  protectedRoute(async (req, res) => {
    const collectionId = requireUuid(req.params.id);
    const providerRecipeId = requireRecipeId(req.params.recipeId);
    const savedRows = await databaseRequest(req.account, "saved_recipes", {
      query: new URLSearchParams({ select: "id", provider: "eq.spoonacular", provider_recipe_id: `eq.${providerRecipeId}`, limit: "1" }).toString(),
    });
    if (!savedRows.length) throw createHttpError(404, "Save the recipe before adding it to a collection");
    await databaseRequest(req.account, "collection_recipes", {
      method: "POST", query: "on_conflict=collection_id,saved_recipe_id", prefer: "resolution=ignore-duplicates,return=minimal",
      body: { user_id: req.account.user.id, collection_id: collectionId, saved_recipe_id: savedRows[0].id },
    });
    res.status(204).end();
  }),
);

router.delete(
  "/collections/:id/recipes/:recipeId",
  protectedRoute(async (req, res) => {
    const savedRows = await databaseRequest(req.account, "saved_recipes", {
      query: new URLSearchParams({ select: "id", provider: "eq.spoonacular", provider_recipe_id: `eq.${requireRecipeId(req.params.recipeId)}`, limit: "1" }).toString(),
    });
    if (savedRows.length) {
      await databaseRequest(req.account, "collection_recipes", {
        method: "DELETE", query: `collection_id=eq.${requireUuid(req.params.id)}&saved_recipe_id=eq.${savedRows[0].id}`,
      });
    }
    res.status(204).end();
  }),
);

router.get(
  "/account/export",
  protectedRoute(async (req, res) => {
    const [recipes, collections, memberships] = await Promise.all([
      databaseRequest(req.account, "saved_recipes", { query: "select=provider_recipe_id,recipe_snapshot,personal_notes,rating,created_at,updated_at&order=created_at.asc" }),
      databaseRequest(req.account, "collections", { query: "select=id,name,description,created_at,updated_at&order=created_at.asc" }),
      databaseRequest(req.account, "collection_recipes", { query: "select=collection_id,saved_recipe_id,added_at&order=added_at.asc" }),
    ]);
    res.set("Content-Disposition", "attachment; filename=\"dishly-data.json\"");
    res.json({ exportedAt: new Date().toISOString(), account: { id: req.account.user.id, email: req.account.user.email || "" }, recipes, collections, memberships });
  }),
);

router.delete(
  "/account",
  protectedRoute(async (req, res) => {
    if (req.body?.confirmation !== "DELETE") throw createHttpError(400, "Type DELETE to confirm account deletion");
    await deleteAccount(req.account);
    res.status(204).end();
  }),
);

function toSavedRecipe(row) {
  return {
    ...row.recipe_snapshot,
    savedId: row.id,
    notes: row.personal_notes || "",
    rating: row.rating ?? null,
    savedAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function protectedRoute(handler) {
  return asyncRoute(async (req, res, next) => {
    req.account = await authenticateRequest(req);
    return handler(req, res, next);
  });
}

function getDisplayName(user) {
  for (const value of [user.user_metadata?.full_name, user.user_metadata?.name, user.email?.split("@")[0]]) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 100);
  }
  return "Dishly cook";
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch { return ""; }
}

function requireRecipeId(value) {
  if (!/^[1-9]\d{0,31}$/.test(String(value || ""))) throw createHttpError(400, "recipeId must be a positive integer");
  return String(value);
}

function requireUuid(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""))) {
    throw createHttpError(400, "collection ID must be a UUID");
  }
  return String(value).toLowerCase();
}

module.exports = router;

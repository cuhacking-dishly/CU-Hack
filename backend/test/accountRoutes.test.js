const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

const routePath = require.resolve("../src/routes/accountRoutes");
const servicePath = require.resolve("../src/services/accountService");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const COLLECTION_ID = "22222222-2222-4222-8222-222222222222";
const SAVED_ID = "33333333-3333-4333-8333-333333333333";

function recipe(id = "101") {
  return { id, title: "Test Bowl", image: "https://example.com/bowl.jpg", readyInMinutes: 20, servings: 2, calories: 450, macros: {}, diets: [], ingredients: [], instructions: [], sourceName: "Kitchen", sourceUrl: "https://example.com/recipe" };
}

function savedRow(id = "101") {
  return { id: SAVED_ID, provider_recipe_id: id, recipe_snapshot: recipe(id), personal_notes: "note", rating: 4, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" };
}

function createApp({ databaseRequest, authenticateRequest, deleteAccount, publicConfig } = {}) {
  delete require.cache[routePath];
  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: {
      authenticateRequest: authenticateRequest || (async () => ({ token: "token", user: { id: USER_ID, email: "cook@example.com", user_metadata: { full_name: "Dishly Cook", avatar_url: "https://example.com/avatar.jpg" } } })),
      databaseRequest: databaseRequest || (async (_auth, table, options = {}) => {
        const query = String(options.query || "");
        if (table === "saved_recipes") {
          if (query.includes("select=id") && !query.includes("recipe_snapshot")) return [{ id: SAVED_ID }];
          if (options.method === "DELETE") return null;
          return [savedRow()];
        }
        if (table === "collections") {
          if (options.method === "DELETE") return null;
          return [{ id: COLLECTION_ID, name: "Weeknight", description: "Fast" }];
        }
        if (table === "collection_recipes") return options.method === "GET" || !options.method ? [{ collection_id: COLLECTION_ID, saved_recipe_id: SAVED_ID }] : null;
        return [];
      }),
      deleteAccount: deleteAccount || (async () => {}),
      getPublicAccountConfig: () => publicConfig || ({ enabled: true, url: "https://project.supabase.co", publishableKey: "public" }),
    },
  };
  const router = require(routePath);
  const app = express();
  app.set("json escape", true);
  app.use(express.json());
  app.use("/api", router);
  app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.publicMessage || "Unexpected server error" }));
  return app;
}

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function request(base, path, { method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: "Bearer token", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

test.afterEach(() => {
  delete require.cache[routePath];
  delete require.cache[servicePath];
});

test("account routes implement the complete signed-in recipe library contract", async () => {
  const calls = [];
  const app = createApp({
    databaseRequest: async (auth, table, options = {}) => {
      calls.push({ auth, table, options });
      const query = String(options.query || "");
      if (table === "saved_recipes") {
        if (query.includes("select=id") && !query.includes("recipe_snapshot")) return [{ id: SAVED_ID }];
        if (options.method === "DELETE") return null;
        return [savedRow(options.body?.provider_recipe_id || "101")];
      }
      if (table === "collections") {
        if (options.method === "DELETE") return null;
        return [{ id: COLLECTION_ID, name: options.body?.name || "Weeknight", description: options.body?.description || "Fast" }];
      }
      if (table === "collection_recipes") return options.method ? null : [{ collection_id: COLLECTION_ID, saved_recipe_id: SAVED_ID }];
      return [];
    },
  });

  await withServer(app, async (base) => {
    assert.deepEqual((await request(base, "/api/auth/config")).body, { enabled: true, url: "https://project.supabase.co", publishableKey: "public" });
    assert.deepEqual((await request(base, "/api/me")).body, { id: USER_ID, email: "cook@example.com", displayName: "Dishly Cook", avatarUrl: "https://example.com/avatar.jpg" });

    const list = await request(base, "/api/saved-recipes?limit=20&offset=5");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.pagination, { limit: 20, offset: 5, count: 1 });
    assert.equal(list.body.recipes[0].notes, "note");
    assert.equal(list.body.recipes[0].rating, 4);

    assert.equal((await request(base, "/api/saved-recipes/101", { method: "PUT", body: { recipe: recipe() } })).status, 200);
    assert.deepEqual((await request(base, "/api/saved-recipes/import", { method: "POST", body: { recipes: [] } })).body, { imported: 0 });
    assert.deepEqual((await request(base, "/api/saved-recipes/import", { method: "POST", body: { recipes: [recipe(), recipe("102")] } })).body, { imported: 2 });
    assert.equal((await request(base, "/api/saved-recipes/101", { method: "PATCH", body: { notes: "new", rating: 5 } })).status, 200);
    assert.equal((await request(base, "/api/saved-recipes/101", { method: "DELETE" })).status, 204);

    assert.equal((await request(base, "/api/collections")).body.collections[0].name, "Weeknight");
    assert.equal((await request(base, "/api/collections", { method: "POST", body: { name: "New", description: "" } })).status, 201);
    assert.equal((await request(base, `/api/collections/${COLLECTION_ID}`, { method: "PATCH", body: { name: "Edited", description: "Better" } })).status, 200);
    assert.equal((await request(base, `/api/collections/${COLLECTION_ID}`, { method: "DELETE" })).status, 204);
    assert.equal((await request(base, `/api/collections/${COLLECTION_ID}/recipes/101`, { method: "PUT" })).status, 204);
    assert.equal((await request(base, `/api/collections/${COLLECTION_ID}/recipes/101`, { method: "DELETE" })).status, 204);

    const exported = await request(base, "/api/account/export");
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition"), /dishly-data.json/);
    assert.equal(exported.body.account.id, USER_ID);
    assert.match(exported.body.exportedAt, /^\d{4}-/);
    assert.equal((await request(base, "/api/account", { method: "DELETE", body: { confirmation: "DELETE" } })).status, 204);
  });

  assert.ok(calls.some((call) => call.options.prefer === "resolution=merge-duplicates,return=representation"));
  assert.ok(calls.some((call) => call.table === "collection_recipes" && call.options.method === "POST"));
});

test("account routes reject invalid input and return stable not-found results", async () => {
  const app = createApp({ databaseRequest: async (_auth, table, options = {}) => {
    if (table === "saved_recipes" && String(options.query).includes("select=id")) return [];
    if (options.method === "PATCH") return [];
    return [];
  }});
  await withServer(app, async (base) => {
    const cases = [
      ["/api/saved-recipes?limit=0", "GET", undefined, 400],
      ["/api/saved-recipes/102", "PUT", { recipe: recipe("101") }, 400],
      ["/api/saved-recipes/bad", "PATCH", { notes: "x" }, 400],
      ["/api/saved-recipes/101", "PATCH", {}, 400],
      ["/api/saved-recipes/101", "PATCH", { notes: "x" }, 404],
      ["/api/collections/bad", "PATCH", { name: "x" }, 400],
      [`/api/collections/${COLLECTION_ID}`, "PATCH", { name: "x" }, 404],
      [`/api/collections/${COLLECTION_ID}/recipes/101`, "PUT", undefined, 404],
      ["/api/account", "DELETE", { confirmation: "no" }, 400],
    ];
    for (const [path, method, body, status] of cases) assert.equal((await request(base, path, { method, body })).status, status, path);
    assert.equal((await request(base, `/api/collections/${COLLECTION_ID}/recipes/101`, { method: "DELETE" })).status, 204);
  });
});

test("account identity fallbacks are safe and authentication failures are preserved", async () => {
  const app = createApp({ authenticateRequest: async () => ({ token: "token", user: { id: USER_ID, email: "fallback@example.com", user_metadata: { avatar_url: "javascript:bad" } } }) });
  await withServer(app, async (base) => {
    assert.deepEqual((await request(base, "/api/me")).body, { id: USER_ID, email: "fallback@example.com", displayName: "fallback", avatarUrl: "" });
  });

  const anonymousMetadata = createApp({ authenticateRequest: async () => ({ token: "token", user: { id: USER_ID, user_metadata: {} } }) });
  await withServer(anonymousMetadata, async (base) => {
    assert.equal((await request(base, "/api/me")).body.displayName, "Dishly cook");
  });

  const denied = createApp({ authenticateRequest: async () => { const error = new Error("denied"); error.statusCode = 401; error.publicMessage = "Sign in is required"; throw error; } });
  await withServer(denied, async (base) => assert.equal((await request(base, "/api/me")).status, 401));
});

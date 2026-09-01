const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const http = require("node:http");
const test = require("node:test");

const serverPath = require.resolve("../src/server");
const goalRoutesPath = require.resolve("../src/routes/goalRoutes");
const recipeRoutesPath = require.resolve("../src/routes/recipeRoutes");
const swipeRoutesPath = require.resolve("../src/routes/swipeRoutes");
const routeUtilsPath = require.resolve("../src/routes/routeUtils");
const geminiServicePath = require.resolve("../src/services/geminiService");
const goalFilterPath = require.resolve("../src/services/goalFilter");
const spoonacularServicePath = require.resolve("../src/services/spoonacularService");
const memoryStorePath = require.resolve("../src/store/memoryStore");

const managedEnvironmentKeys = [
  "CORS_ORIGINS",
  "GEMINI_API_KEY",
  "PORT",
  "SPOONACULAR_API_KEY",
];
const originalEnvironment = Object.fromEntries(
  managedEnvironmentKeys.map((key) => [key, process.env[key]])
);

function clearAppModules() {
  for (const modulePath of [
    serverPath,
    goalRoutesPath,
    recipeRoutesPath,
    swipeRoutesPath,
    routeUtilsPath,
    geminiServicePath,
    goalFilterPath,
    spoonacularServicePath,
    memoryStorePath,
  ]) {
    delete require.cache[modulePath];
  }
}

function restoreEnvironment() {
  for (const key of managedEnvironmentKeys) {
    if (originalEnvironment[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnvironment[key];
    }
  }
}

function mockModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function recipeFixture(id = "101", overrides = {}) {
  return {
    id,
    title: "Vegan Demo",
    image: "https://example.com/vegan.jpg",
    readyInMinutes: 20,
    servings: 2,
    calories: 450,
    macros: { protein_g: 22, carbs_g: 50, fat_g: 10 },
    diets: ["vegan"],
    ingredients: ["1 cup quinoa", "1 avocado"],
    instructions: ["Cook the quinoa.", "Top with avocado."],
    sourceName: "Example Kitchen",
    sourceUrl: "https://example.com/vegan-demo",
    ...overrides,
  };
}

function loadApp({
  parseGoal = async () => ({}),
  searchRecipes = async () => [recipeFixture()],
  searchRecipePage,
  getRecipeById = async (id) => recipeFixture(id),
} = {}) {
  clearAppModules();
  mockModule(geminiServicePath, { parseGoal });
  mockModule(spoonacularServicePath, {
    getRecipeById,
    searchRecipePage:
      searchRecipePage ||
      (async (filter, pagination) => ({
        recipes: await searchRecipes(filter, pagination),
        hasMore: false,
      })),
    searchRecipes,
  });
  return require("../src/server");
}

async function withTestServer(app, callback) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const raw = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const body = raw && contentType.includes("application/json") ? JSON.parse(raw) : raw || null;

  return { status: response.status, body, raw, headers: response.headers };
}

function postJson(baseUrl, path, body) {
  return request(baseUrl, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function assertResponse(actual, status, body) {
  assert.equal(actual.status, status);
  assert.deepEqual(actual.body, body);
}

test.beforeEach(() => {
  process.env.CORS_ORIGINS = "*";
});

test.afterEach(() => {
  clearAppModules();
  restoreEnvironment();
});

test("API routes expose the complete frontend contract and persist swipes", async () => {
  const searchCalls = [];
  const app = loadApp({
    parseGoal: async (text) => {
      assert.equal(text, "vegan, quick");
      return { diet: "vegan", maxReadyTime: 30 };
    },
    searchRecipes: async (filter, pagination) => {
      searchCalls.push({ filter, pagination });
      return [recipeFixture("101")];
    },
    getRecipeById: async (id) => recipeFixture(id, { title: "Recipe Detail" }),
  });

  await withTestServer(app, async (baseUrl) => {
    const parsed = await postJson(baseUrl, "/api/parse-goal", { text: "  vegan, quick  " });
    assertResponse(parsed, 200, {
      parsedFilter: { diet: "vegan", maxReadyTime: 30 },
    });

    assertResponse(
      await postJson(baseUrl, "/api/goal", {
        userId: "  demo-user-1  ",
        rawText: "  vegan, under 500 calories  ",
        parsedFilter: {
          query: "  ramen  ",
          diet: " Vegan ",
          cuisines: [" Japanese ", "Italian", "japanese"],
          mealType: " Main Course ",
          maxCalories: 500,
          intolerances: [" Peanut ", "peanut", "Shellfish"],
          excludeIngredients: [" peanuts ", "PEANUTS"],
        },
      }),
      200,
      { success: true }
    );

    const savedGoal = await request(baseUrl, "/api/goal/current?userId=demo-user-1");
    assert.equal(savedGoal.status, 200);
    assert.equal(savedGoal.headers.get("cache-control"), "no-store");
    assert.equal(savedGoal.body.rawText, "vegan, under 500 calories");
    assert.deepEqual(savedGoal.body.parsedFilter, {
      query: "ramen",
      maxCalories: 500,
      diet: "vegan",
      cuisines: ["japanese", "italian"],
      mealType: "main course",
      intolerances: ["peanut", "shellfish"],
      excludeIngredients: ["peanuts"],
    });
    assert.match(savedGoal.body.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    const recipes = await request(
      baseUrl,
      "/api/recipes?userId=demo-user-1&limit=2&offset=20"
    );
    assertResponse(recipes, 200, {
      recipes: [recipeFixture("101")],
      pagination: { limit: 2, offset: 20, count: 1, hasMore: false },
    });
    assert.deepEqual(searchCalls, [
      {
        filter: {
          query: "ramen",
          maxCalories: 500,
          diet: "vegan",
          cuisines: ["japanese", "italian"],
          mealType: "main course",
          intolerances: ["peanut", "shellfish"],
          excludeIngredients: ["peanuts"],
        },
        pagination: { limit: 2, offset: 20 },
      },
    ]);

    assertResponse(await request(baseUrl, "/api/recipes/12345"), 200, {
      ...recipeFixture("12345"),
      title: "Recipe Detail",
    });

    assertResponse(
      await postJson(baseUrl, "/api/swipe", {
        userId: " demo-user-1 ",
        recipeId: " 12345 ",
        direction: " right ",
      }),
      200,
      { success: true }
    );

    const { getSwipes } = require(memoryStorePath);
    assert.deepEqual(
      getSwipes("demo-user-1").map(({ userId, recipeId, direction }) => ({
        userId,
        recipeId,
        direction,
      })),
      [{ userId: "demo-user-1", recipeId: "12345", direction: "right" }]
    );

    assertResponse(await request(baseUrl, "/api/goal/current?userId=missing"), 200, null);
  });
});

test("health, readiness, cache headers, and framework headers are deterministic", async () => {
  process.env.CORS_ORIGINS = "*";
  process.env.GEMINI_API_KEY = " ";
  process.env.PORT = "invalid-only-when-imported";
  process.env.SPOONACULAR_API_KEY = " ";
  const app = loadApp();

  await withTestServer(app, async (baseUrl) => {
    const health = await request(baseUrl, "/api/health", {
      headers: { Origin: "https://any-origin.test" },
    });
    assertResponse(health, 200, { ok: true });
    assert.equal(health.headers.get("access-control-allow-origin"), "*");
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.equal(health.headers.get("x-powered-by"), null);

    const unavailable = await request(baseUrl, "/api/ready");
    assertResponse(unavailable, 503, {
      ok: false,
      services: { gemini: false, spoonacular: false },
    });

    process.env.GEMINI_API_KEY = "gemini-secret";
    process.env.SPOONACULAR_API_KEY = "spoonacular-secret";
    const ready = await request(baseUrl, "/api/ready");
    assertResponse(ready, 200, {
      ok: true,
      services: { gemini: true, spoonacular: true },
    });
    assert.doesNotMatch(ready.raw, /secret/);
  });
});

test("goal parsing sanitizes model output and goal saving rejects invalid filters", async () => {
  const app = loadApp({
    parseGoal: async () => ({
      maxCalories: "500",
      diet: " Vegan ",
      query: " ramen ",
      cuisines: [" Japanese ", "Italian", "japanese"],
      mealType: " Dessert ",
      intolerances: [" Peanut ", "peanut", "Shellfish"],
      excludeIngredients: [" peanuts ", "PEANUTS", 42, ""],
      unsupported: true,
    }),
  });

  await withTestServer(app, async (baseUrl) => {
    assertResponse(await postJson(baseUrl, "/api/parse-goal", { text: "vegan" }), 200, {
      parsedFilter: {
        query: "ramen",
        diet: "vegan",
        cuisines: ["japanese", "italian"],
        mealType: "dessert",
        intolerances: ["peanut", "shellfish"],
        excludeIngredients: ["peanuts"],
      },
    });

    const invalidFilters = [
      null,
      [],
      { unsupported: true },
      { maxCalories: 0 },
      { maxCalories: "500" },
      { minProtein_g: -1 },
      { maxReadyTime: 1441 },
      { diet: "carnivore" },
      { query: "" },
      { cuisine: "japanese" },
      { cuisines: ["martian"] },
      { mealType: "lunch" },
      { intolerances: ["made up allergen"] },
      { excludeIngredients: Array.from({ length: 21 }, (_, index) => `item-${index}`) },
      { excludeIngredients: [""] },
    ];

    for (const parsedFilter of invalidFilters) {
      assertResponse(
        await postJson(baseUrl, "/api/goal", {
          userId: "demo-user",
          rawText: "valid text",
          parsedFilter,
        }),
        400,
        { error: "Invalid goal filter" }
      );
    }

    assertResponse(
      await postJson(baseUrl, "/api/goal", {
        userId: "demo-user",
        rawText: "anything",
      }),
      200,
      { success: true }
    );
  });
});

test("body, query, identifier, direction, and pagination validation reject bad input", async () => {
  let parseCalls = 0;
  let searchCalls = 0;
  let detailCalls = 0;
  const app = loadApp({
    parseGoal: async () => {
      parseCalls += 1;
      return {};
    },
    searchRecipes: async () => {
      searchCalls += 1;
      return [];
    },
    getRecipeById: async () => {
      detailCalls += 1;
      return recipeFixture();
    },
  });

  await withTestServer(app, async (baseUrl) => {
    for (const body of [{}, { text: " " }, { text: 123 }]) {
      assertResponse(await postJson(baseUrl, "/api/parse-goal", body), 400, {
        error: "text is required",
      });
    }
    assertResponse(
      await postJson(baseUrl, "/api/parse-goal", { text: "x".repeat(1001) }),
      400,
      { error: "text must be at most 1000 characters" }
    );
    assert.equal(parseCalls, 0);

    for (const body of [
      {},
      { userId: "user" },
      { userId: " ", rawText: "goal" },
      { userId: "user", rawText: 123 },
    ]) {
      assertResponse(await postJson(baseUrl, "/api/goal", body), 400, {
        error: "userId and rawText are required",
      });
    }
    assertResponse(
      await postJson(baseUrl, "/api/goal", {
        userId: "u".repeat(129),
        rawText: "goal",
      }),
      400,
      { error: "userId must be at most 128 characters" }
    );
    assertResponse(
      await postJson(baseUrl, "/api/goal", {
        userId: "user",
        rawText: "g".repeat(1001),
      }),
      400,
      { error: "rawText must be at most 1000 characters" }
    );

    for (const path of [
      "/api/goal/current",
      "/api/goal/current?userId=",
      "/api/recipes",
      "/api/recipes?userId=",
    ]) {
      assertResponse(await request(baseUrl, path), 400, { error: "userId is required" });
    }
    for (const path of [
      "/api/goal/current?userId=a&userId=b",
      "/api/recipes?userId=a&userId=b",
    ]) {
      assertResponse(await request(baseUrl, path), 400, {
        error: "userId must be provided once",
      });
    }

    const invalidPagination = [
      ["limit", "0", "limit must be an integer between 1 and 20"],
      ["limit", "21", "limit must be an integer between 1 and 20"],
      ["limit", "1.5", "limit must be an integer between 1 and 20"],
      ["limit", "abc", "limit must be an integer between 1 and 20"],
      ["offset", "-1", "offset must be an integer between 0 and 900"],
      ["offset", "901", "offset must be an integer between 0 and 900"],
      ["offset", "1.5", "offset must be an integer between 0 and 900"],
    ];
    for (const [field, value, message] of invalidPagination) {
      assertResponse(
        await request(baseUrl, `/api/recipes?userId=user&${field}=${value}`),
        400,
        { error: message }
      );
    }
    assertResponse(
      await request(baseUrl, "/api/recipes?userId=user&limit=1&limit=2"),
      400,
      { error: "limit must be provided once" }
    );
    assertResponse(
      await request(baseUrl, "/api/recipes?userId=user&offset=1&offset=2"),
      400,
      { error: "offset must be provided once" }
    );
    assert.equal(searchCalls, 0);

    for (const [id, message] of [
      ["abc", "id must be a positive integer"],
      ["0", "id must be a positive integer"],
      ["-1", "id must be a positive integer"],
      ["0001", "id must be a positive integer"],
      ["9007199254740992", "id must be a positive integer"],
      ["1".repeat(33), "id must be at most 32 characters"],
    ]) {
      assertResponse(await request(baseUrl, `/api/recipes/${id}`), 400, {
        error: message,
      });
    }
    assert.equal(detailCalls, 0);

    assertResponse(
      await postJson(baseUrl, "/api/swipe", { direction: "right" }),
      400,
      { error: "userId and recipeId are required" }
    );
    assertResponse(
      await postJson(baseUrl, "/api/swipe", {
        userId: "user",
        recipeId: "0001",
        direction: "right",
      }),
      400,
      { error: "recipeId must be a positive integer" }
    );
    assertResponse(
      await postJson(baseUrl, "/api/swipe", {
        userId: "u".repeat(129),
        recipeId: "101",
        direction: "right",
      }),
      400,
      { error: "userId must be at most 128 characters" }
    );
    assertResponse(
      await postJson(baseUrl, "/api/swipe", {
        userId: "user",
        recipeId: "101",
        direction: "sideways",
      }),
      400,
      { error: "direction must be left or right" }
    );
  });
});

test("recipe pagination defaults are passed to the provider and returned to clients", async () => {
  const calls = [];
  const app = loadApp({
    searchRecipes: async (filter, pagination) => {
      calls.push({ filter, pagination });
      return [];
    },
  });

  await withTestServer(app, async (baseUrl) => {
    assertResponse(await request(baseUrl, "/api/recipes?userId=new-user"), 200, {
      recipes: [],
      pagination: { limit: 10, offset: 0, count: 0, hasMore: false },
    });
    assert.deepEqual(calls, [{ filter: {}, pagination: { limit: 10, offset: 0 } }]);
  });
});

test("recipe pagination preserves provider continuation independently of normalized count", async () => {
  const app = loadApp({
    searchRecipePage: async () => ({ recipes: [recipeFixture("101")], hasMore: true }),
  });

  await withTestServer(app, async (baseUrl) => {
    assertResponse(await request(baseUrl, "/api/recipes?userId=user&limit=10&offset=20"), 200, {
      recipes: [recipeFixture("101")],
      pagination: { limit: 10, offset: 20, count: 1, hasMore: true },
    });
  });
});

test("central error handling preserves typed public errors and redacts internal failures", async () => {
  const geminiSecret = "gemini sensitive/key?value";
  const encodedGeminiSecret = encodeURIComponent(geminiSecret);
  const queryEncodedGeminiSecret = new URLSearchParams({ value: geminiSecret })
    .toString()
    .slice("value=".length);
  process.env.GEMINI_API_KEY = `  ${geminiSecret}  `;
  process.env.SPOONACULAR_API_KEY = "  spoonacular-sensitive-key  ";
  const typedError = Object.assign(
    new Error(`Recipe provider request failed for ${encodedGeminiSecret}`, {
      cause: new Error(
        `provider status 429 for spoonacular-sensitive-key and ${queryEncodedGeminiSecret}`
      ),
    }),
    {
      statusCode: 503,
      publicMessage: "Recipe service is temporarily unavailable",
      code: `SPOONACULAR_RATE_LIMITED:${geminiSecret}`,
      retryable: true,
    }
  );
  const app = loadApp({
    parseGoal: async () => {
      throw new Error("Gemini SDK secret failure");
    },
    searchRecipes: async () => {
      throw typedError;
    },
    getRecipeById: async () => {
      throw new Error("Spoonacular raw secret failure");
    },
  });
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args);

  try {
    await withTestServer(app, async (baseUrl) => {
      const search = await request(baseUrl, "/api/recipes?userId=user");
      assertResponse(search, 503, { error: "Recipe service is temporarily unavailable" });
      assert.doesNotMatch(search.raw, /provider status|sensitive-key/);

      const detail = await request(baseUrl, "/api/recipes/101");
      assertResponse(detail, 500, { error: "Unexpected server error" });
      assert.doesNotMatch(detail.raw, /Spoonacular raw/);

      const parse = await postJson(baseUrl, "/api/parse-goal", { text: "vegan" });
      assertResponse(parse, 500, { error: "Unexpected server error" });
      assert.doesNotMatch(parse.raw, /Gemini SDK/);
    });
  } finally {
    console.error = originalConsoleError;
  }

  const serializedLogs = JSON.stringify(logged);
  assert.match(serializedLogs, /provider status 429/);
  assert.match(serializedLogs, /SPOONACULAR_RATE_LIMITED:\[REDACTED\]/);
  assert.match(serializedLogs, /"retryable":true/);
  assert.match(serializedLogs, /\[REDACTED\]/);
  assert.doesNotMatch(serializedLogs, /spoonacular-sensitive-key/);
  assert.equal(serializedLogs.includes(geminiSecret), false);
  assert.equal(serializedLogs.includes(encodedGeminiSecret), false);
  assert.equal(serializedLogs.includes(queryEncodedGeminiSecret), false);
  assert.match(serializedLogs, /Spoonacular raw secret failure/);
  assert.match(serializedLogs, /Gemini SDK secret failure/);
});

test("malformed and oversized bodies plus unknown routes return stable JSON errors", async () => {
  const app = loadApp();

  await withTestServer(app, async (baseUrl) => {
    assertResponse(
      await request(baseUrl, "/api/goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      400,
      { error: "Invalid JSON body" }
    );

    assertResponse(
      await request(baseUrl, "/api/parse-goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(1024 * 1024) }),
      }),
      413,
      { error: "Request body is too large" }
    );

    const missing = await request(baseUrl, "/api/not-real");
    assertResponse(missing, 404, { error: "Route not found" });
    assert.match(missing.headers.get("content-type"), /^application\/json/);
    assert.equal(missing.headers.get("cache-control"), "no-store");

    assertResponse(
      await request(baseUrl, "/api/goal", { method: "PUT" }),
      404,
      { error: "Route not found" }
    );
  });
});

test("CORS supports explicit allowlists, no-Origin requests, preflight, and wildcard mode", async () => {
  process.env.CORS_ORIGINS = "https://allowed.test, https://second.test";
  let app = loadApp();

  await withTestServer(app, async (baseUrl) => {
    const allowed = await request(baseUrl, "/api/health", {
      headers: { Origin: "https://allowed.test" },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://allowed.test");
    assert.match(allowed.headers.get("vary"), /Origin/);

    const noOrigin = await request(baseUrl, "/api/health");
    assert.equal(noOrigin.status, 200);

    const denied = await request(baseUrl, "/api/health", {
      headers: { Origin: "https://denied.test" },
    });
    assertResponse(denied, 403, { error: "Origin not allowed by CORS" });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    assert.equal(denied.headers.get("cache-control"), "no-store");

    const preflight = await request(baseUrl, "/api/goal", {
      method: "OPTIONS",
      headers: {
        Origin: "https://second.test",
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://second.test");
    assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);

    assertResponse(
      await request(baseUrl, "/api/goal", {
        method: "OPTIONS",
        headers: {
          Origin: "https://denied.test",
          "Access-Control-Request-Method": "POST",
        },
      }),
      403,
      { error: "Origin not allowed by CORS" }
    );
  });

  process.env.CORS_ORIGINS = "*";
  app = loadApp();
  await withTestServer(app, async (baseUrl) => {
    const wildcard = await request(baseUrl, "/api/health", {
      headers: { Origin: "https://anything.test" },
    });
    assert.equal(wildcard.status, 200);
    assert.equal(wildcard.headers.get("access-control-allow-origin"), "*");
  });
});

test("Express JSON escaping protects responses containing third-party markup", async () => {
  const app = loadApp({
    getRecipeById: async (id) => recipeFixture(id, { title: "<script>&" }),
  });

  await withTestServer(app, async (baseUrl) => {
    const response = await request(baseUrl, "/api/recipes/101");
    assert.equal(response.status, 200);
    assert.equal(response.body.title, "<script>&");
    assert.match(response.raw, /\\u003cscript\\u003e\\u0026/);
    assert.doesNotMatch(response.raw, /<script>/);
  });
});

test("direct startup rejects an invalid PORT before listening", () => {
  const result = spawnSync(process.execPath, [serverPath], {
    cwd: require("node:path").join(__dirname, ".."),
    env: { ...process.env, PORT: "70000" },
    encoding: "utf8",
    timeout: 5000,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PORT must be an integer between 1 and 65535/);
});

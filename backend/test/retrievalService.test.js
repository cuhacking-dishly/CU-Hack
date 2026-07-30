const assert = require("node:assert/strict");
const test = require("node:test");

const servicePath = require.resolve("../src/services/retrievalService");
const originalFetch = global.fetch;
const originalEnvironment = {
  GOAL_PARSER_TIMEOUT_MS: process.env.GOAL_PARSER_TIMEOUT_MS,
  RETRIEVAL_SERVICE_HOSTPORT: process.env.RETRIEVAL_SERVICE_HOSTPORT,
  RETRIEVAL_SERVICE_TOKEN: process.env.RETRIEVAL_SERVICE_TOKEN,
  RETRIEVAL_SERVICE_URL: process.env.RETRIEVAL_SERVICE_URL,
  RETRIEVAL_TIMEOUT_MS: process.env.RETRIEVAL_TIMEOUT_MS,
};

function loadService() {
  delete require.cache[servicePath];
  return require("../src/services/retrievalService");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recipeFixture(overrides = {}) {
  return {
    id: "101",
    title: "Lemon Lentil Bowl",
    image: "https://images.example.com/lentils.jpg",
    readyInMinutes: 25,
    servings: 2,
    calories: 480,
    macros: { protein_g: 24, carbs_g: 64, fat_g: 12 },
    diets: ["vegan"],
    ingredients: ["1 cup lentils", "1 lemon"],
    instructions: ["Cook the lentils.", "Finish with lemon."],
    sourceName: "Example Kitchen",
    sourceUrl: "https://example.com/lemon-lentil-bowl",
    ...overrides,
  };
}

function searchEnvelope(recipes = [recipeFixture()], overrides = {}) {
  return {
    recipes,
    match_mode: "exact",
    can_show_closest: false,
    message: null,
    total_candidates: recipes.length,
    semantic_provider: "ollama:embeddinggemma",
    ...overrides,
  };
}

function restoreEnvironment() {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test.beforeEach(() => {
  process.env.RETRIEVAL_SERVICE_URL = "http://retrieval.test";
  delete process.env.RETRIEVAL_SERVICE_HOSTPORT;
  delete process.env.RETRIEVAL_SERVICE_TOKEN;
  delete process.env.RETRIEVAL_TIMEOUT_MS;
  delete process.env.GOAL_PARSER_TIMEOUT_MS;
});

test.afterEach(() => {
  global.fetch = originalFetch;
  restoreEnvironment();
  delete require.cache[servicePath];
});

test("search maps the complete saved goal losslessly and normalizes match metadata", async (t) => {
  process.env.RETRIEVAL_SERVICE_URL = "http://retrieval.test/internal/";
  process.env.RETRIEVAL_SERVICE_TOKEN = "private-service-token";
  process.env.RETRIEVAL_TIMEOUT_MS = "3200";
  const controller = new AbortController();
  let capturedTimeout;
  t.mock.method(AbortSignal, "timeout", (timeout) => {
    capturedTimeout = timeout;
    return controller.signal;
  });

  let requestedUrl;
  let requestedOptions;
  global.fetch = async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return jsonResponse(
      searchEnvelope(
        [
          recipeFixture({
            matchScore: 8.75,
            matchReasons: [" Japanese cuisine ", "Near protein target"],
            matchMode: "exact",
          }),
        ],
        { total_candidates: 25, can_show_closest: true, message: "  Strong matches  " }
      )
    );
  };

  const { searchRecipePage } = loadService();
  const page = await searchRecipePage(
    {
      rawText: "  vegan ramen with no peanuts  ",
      parsedFilter: {
        query: " ramen ",
        minCalories: 400,
        maxCalories: 600,
        minProtein_g: 25,
        maxProtein_g: 45,
        minCarbs_g: 30,
        maxCarbs_g: 80,
        diet: " Vegan ",
        cuisines: [" Japanese ", "Italian"],
        mealType: " Main Course ",
        maxReadyTime: 30,
        intolerances: [" Peanut ", "Shellfish"],
        excludeIngredients: [" peanuts ", "strawberries"],
      },
    },
    {
      limit: 10,
      offset: 10,
      matchMode: "exact",
      excludedRecipeIds: new Set(["201", "202", "201"]),
    }
  );

  assert.equal(requestedUrl, "http://retrieval.test/internal/v1/search");
  assert.equal(requestedOptions.method, "POST");
  assert.deepEqual(requestedOptions.headers, {
    Accept: "application/json",
    Authorization: "Bearer private-service-token",
    "Content-Type": "application/json",
  });
  assert.equal(requestedOptions.signal, controller.signal);
  assert.equal(capturedTimeout, 3200);
  assert.deepEqual(JSON.parse(requestedOptions.body), {
    raw_query: "vegan ramen with no peanuts",
    query: "ramen",
    preferred_cuisines: ["japanese", "italian"],
    preferred_meal_type: "main course",
    diet: "vegan",
    require_vegan: true,
    excluded_allergens: ["peanut", "shellfish"],
    excluded_ingredients: ["peanuts", "strawberries"],
    min_calories: 400,
    max_calories: 600,
    min_protein_g: 25,
    max_protein_g: 45,
    min_carbs_g: 30,
    max_carbs_g: 80,
    max_time_minutes: 30,
    excluded_recipe_ids: ["201", "202"],
    limit: 10,
    offset: 10,
    match_mode: "exact",
  });

  assert.deepEqual(page, {
    recipes: [
      {
        ...recipeFixture(),
        image: "https://images.example.com/lentils.jpg",
        sourceUrl: "https://example.com/lemon-lentil-bowl",
        match: {
          mode: "exact",
          score: 8.75,
          reasons: ["Japanese cuisine", "Near protein target"],
        },
      },
    ],
    pagination: { limit: 10, offset: 10, count: 1, hasMore: true },
    match: {
      mode: "exact",
      canShowClosest: true,
      message: "Strong matches",
      totalCandidates: 25,
      semanticProvider: "ollama:embeddinggemma",
    },
  });
});

test("private host:port configuration is converted to an internal HTTP URL", async () => {
  delete process.env.RETRIEVAL_SERVICE_URL;
  process.env.RETRIEVAL_SERVICE_HOSTPORT = "dishly-retrieval.internal:8000";
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = url;
    return jsonResponse(searchEnvelope());
  };

  await loadService().searchRecipePage();
  assert.equal(requestedUrl, "http://dishly-retrieval.internal:8000/v1/search");
});

test("goal parsing uses the local Ollama endpoint, its cold-start timeout, and strict schema", async (t) => {
  process.env.GOAL_PARSER_TIMEOUT_MS = "240000";
  let timeout;
  let request;
  t.mock.method(AbortSignal, "timeout", (value) => {
    timeout = value;
    return new AbortController().signal;
  });
  global.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse({
      parsedFilter: {
        cuisines: [" Asian "],
        mealType: " Main Course ",
        minProtein_g: 50,
        intolerances: [" Peanut "],
        excludeIngredients: [" peanuts "],
      },
      parserProvider: "ollama:qwen3:4b-instruct",
    });
  };

  const { parseGoal } = loadService();
  assert.deepEqual(await parseGoal("Asian dinner with 50g protein and no peanuts"), {
    minProtein_g: 50,
    cuisines: ["asian"],
    mealType: "main course",
    intolerances: ["peanut"],
    excludeIngredients: ["peanuts"],
  });
  assert.equal(request.url, "http://retrieval.test/v1/parse-goal");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), {
    text: "Asian dinner with 50g protein and no peanuts",
  });
  assert.equal(timeout, 240000);

  for (const invalid of [
    {},
    { parsedFilter: {}, parserProvider: "cloud:external" },
    { parsedFilter: { unsupported: true }, parserProvider: "ollama:qwen3" },
  ]) {
    global.fetch = async () => jsonResponse(invalid);
    await assert.rejects(() => parseGoal("dinner"), (error) => {
      assert.equal(error.code, "RETRIEVAL_INVALID_RESPONSE");
      return true;
    });
  }
});

test("search preserves decimal publisher nutrition and serving precision", async () => {
  const sourceValues = recipeFixture({
    servings: 2.5,
    calories: 238.79,
    macros: { protein_g: 12.2, carbs_g: 37.84, fat_g: 5.86 },
  });
  global.fetch = async () => jsonResponse(searchEnvelope([sourceValues]));

  const { searchRecipePage } = loadService();
  const page = await searchRecipePage();

  assert.equal(page.recipes[0].servings, 2.5);
  assert.equal(page.recipes[0].calories, 238.79);
  assert.deepEqual(page.recipes[0].macros, {
    protein_g: 12.2,
    carbs_g: 37.84,
    fat_g: 5.86,
  });
});

test("search supports an unconstrained no-match page and the recipes compatibility helper", async () => {
  const responses = [
    searchEnvelope([], {
      can_show_closest: true,
      message: "No exact matches",
      total_candidates: 0,
      semantic_provider: "structured-only",
    }),
    searchEnvelope([recipeFixture()]),
  ];
  const bodies = [];
  global.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return jsonResponse(responses.shift());
  };

  const { searchRecipePage, searchRecipes } = loadService();
  const page = await searchRecipePage();
  assert.deepEqual(page, {
    recipes: [],
    pagination: { limit: 10, offset: 0, count: 0, hasMore: false },
    match: {
      mode: "exact",
      canShowClosest: true,
      message: "No exact matches",
      totalCandidates: 0,
      semanticProvider: "structured-only",
    },
  });
  assert.deepEqual(await searchRecipes(), [recipeFixture()]);
  assert.deepEqual(bodies[0], {
    raw_query: "",
    query: null,
    preferred_cuisines: [],
    preferred_meal_type: null,
    diet: null,
    require_vegan: false,
    excluded_allergens: [],
    excluded_ingredients: [],
    min_calories: null,
    max_calories: null,
    min_protein_g: null,
    max_protein_g: null,
    min_carbs_g: null,
    max_carbs_g: null,
    max_time_minutes: null,
    excluded_recipe_ids: [],
    limit: 10,
    offset: 0,
    match_mode: "exact",
  });
});

test("closest searches require the private service to honor the requested mode", async () => {
  global.fetch = async () => jsonResponse(searchEnvelope([], { match_mode: "closest" }));
  const { searchRecipePage } = loadService();
  const page = await searchRecipePage(null, { matchMode: "closest" });
  assert.equal(page.match.mode, "closest");

  global.fetch = async () => jsonResponse(searchEnvelope());
  await assert.rejects(
    () => searchRecipePage(null, { matchMode: "closest" }),
    (error) => {
      assert.equal(error.code, "RETRIEVAL_INVALID_RESPONSE");
      assert.equal(error.statusCode, 502);
      return true;
    }
  );
});

test("search validates its goal, pagination, mode, and exclusions before fetching", async () => {
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse(searchEnvelope());
  };
  const { searchRecipePage } = loadService();

  const invalidCalls = [
    () => searchRecipePage([]),
    () => searchRecipePage({ rawText: 42 }),
    () => searchRecipePage({ rawText: "x".repeat(1001) }),
    () => searchRecipePage({ parsedFilter: null }),
    () => searchRecipePage({ parsedFilter: { unsupported: true } }),
    () => searchRecipePage(null, null),
    () => searchRecipePage(null, { limit: 0 }),
    () => searchRecipePage(null, { limit: 21 }),
    () => searchRecipePage(null, { offset: -1 }),
    () => searchRecipePage(null, { offset: 901 }),
    () => searchRecipePage(null, { matchMode: "relaxed" }),
    () => searchRecipePage(null, { excludedRecipeIds: "101" }),
    () => searchRecipePage(null, { excludedRecipeIds: ["01"] }),
    () => searchRecipePage(null, { excludedRecipeIds: Array(1001).fill("1") }),
  ];

  for (const call of invalidCalls) {
    await assert.rejects(call, (error) => {
      assert.equal(error.statusCode, 400);
      return true;
    });
  }
  assert.equal(fetchCalls, 0);
});

test("search rejects malformed envelopes and unsafe or incomplete recipe DTOs", async (t) => {
  const { searchRecipePage } = loadService();
  const invalidEnvelopes = [
    null,
    [],
    {},
    { ...searchEnvelope(), recipes: {} },
    { ...searchEnvelope(), recipes: Array(11).fill(recipeFixture()) },
    { ...searchEnvelope(), match_mode: "maybe" },
    { ...searchEnvelope(), can_show_closest: "yes" },
    { ...searchEnvelope(), message: 42 },
    { ...searchEnvelope(), message: "x".repeat(501) },
    { ...searchEnvelope(), total_candidates: -1 },
    { ...searchEnvelope(), total_candidates: 1.5 },
    { ...searchEnvelope(), total_candidates: 0 },
    { ...searchEnvelope(), semantic_provider: " " },
    { ...searchEnvelope(), semantic_provider: "x".repeat(201) },
    searchEnvelope([recipeFixture(), recipeFixture()]),
    searchEnvelope([recipeFixture({ id: "01" })]),
    searchEnvelope([recipeFixture({ title: " " })]),
    searchEnvelope([recipeFixture({ image: "javascript:alert(1)" })]),
    searchEnvelope([recipeFixture({ image: "not a URL" })]),
    searchEnvelope([recipeFixture({ sourceUrl: "https://user:pass@example.com/recipe" })]),
    searchEnvelope([recipeFixture({ readyInMinutes: -1 })]),
    searchEnvelope([recipeFixture({ servings: -1.5 })]),
    searchEnvelope([recipeFixture({ calories: "238.79" })]),
    searchEnvelope([recipeFixture({ macros: null })]),
    searchEnvelope([recipeFixture({ macros: { protein_g: -1, carbs_g: 1, fat_g: 1 } })]),
    searchEnvelope([recipeFixture({ diets: [null] })]),
    searchEnvelope([recipeFixture({ ingredients: "lentils" })]),
    searchEnvelope([recipeFixture({ instructions: [""] })]),
    searchEnvelope([recipeFixture({ sourceName: 42 })]),
    searchEnvelope([recipeFixture({ matchMode: "relaxed" })]),
    searchEnvelope([recipeFixture({ matchMode: "closest" })]),
    searchEnvelope([recipeFixture({ matchReasons: [null] })]),
  ];

  for (const invalidEnvelope of invalidEnvelopes) {
    await t.test(JSON.stringify(invalidEnvelope)?.slice(0, 70) || String(invalidEnvelope), async () => {
      global.fetch = async () => jsonResponse(invalidEnvelope);
      await assert.rejects(() => searchRecipePage(), (error) => {
        assert.equal(error.code, "RETRIEVAL_INVALID_RESPONSE");
        assert.equal(error.publicMessage, "Recipe retrieval service returned an invalid response");
        return true;
      });
    });
  }
});

test("search rejects recipes that violate vegan or same-goal exclusion invariants", async () => {
  const { searchRecipePage } = loadService();
  global.fetch = async () => jsonResponse(searchEnvelope([recipeFixture({ diets: [] })]));
  await assert.rejects(
    () => searchRecipePage({ rawText: "vegan", parsedFilter: { diet: "vegan" } }),
    (error) => error.code === "RETRIEVAL_INVALID_RESPONSE"
  );

  global.fetch = async () => jsonResponse(searchEnvelope());
  await assert.rejects(
    () => searchRecipePage(null, { excludedRecipeIds: ["101"] }),
    (error) => error.code === "RETRIEVAL_INVALID_RESPONSE"
  );
});

test("detail validates ids, calls the encoded private route, and returns a stable DTO", async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse(recipeFixture({ image: "", sourceUrl: "" }));
  };

  const { getRecipeById } = loadService();
  assert.deepEqual(await getRecipeById("101"), recipeFixture({ image: "", sourceUrl: "" }));
  assert.equal(request.url, "http://retrieval.test/v1/recipes/101");
  assert.equal(request.options.method, "GET");
  assert.deepEqual(request.options.headers, { Accept: "application/json" });

  for (const id of ["", "0", "01", "-1", "9007199254740992", 101]) {
    await assert.rejects(() => getRecipeById(id), (error) => {
      assert.equal(error.code, "INVALID_RECIPE_ID");
      assert.equal(error.statusCode, 400);
      return true;
    });
  }
});

test("detail maps private 404s and malformed recipe payloads safely", async () => {
  const { getRecipeById } = loadService();
  global.fetch = async () => jsonResponse({ error: "missing internal row" }, 404);
  await assert.rejects(() => getRecipeById("101"), (error) => {
    assert.equal(error.code, "RECIPE_NOT_FOUND");
    assert.equal(error.statusCode, 404);
    assert.equal(error.publicMessage, "Recipe not found");
    return true;
  });

  global.fetch = async () => jsonResponse({ recipe: recipeFixture() });
  await assert.rejects(() => getRecipeById("101"), /invalid response/i);
});

test("configuration, network, upstream, timeout, and parsing failures have safe typed errors", async (t) => {
  const { searchRecipePage } = loadService();

  for (const url of ["", "not a URL", "file:///recipes", "http://user:pass@host", "http://host?x=1", "http://host#x"] ) {
    process.env.RETRIEVAL_SERVICE_URL = url;
    await assert.rejects(() => searchRecipePage(), (error) => {
      assert.equal(error.code, "RETRIEVAL_NOT_CONFIGURED");
      assert.equal(error.statusCode, 503);
      assert.doesNotMatch(error.publicMessage, /host|user|URL/i);
      return true;
    });
  }

  process.env.RETRIEVAL_SERVICE_URL = "http://retrieval.test";
  global.fetch = async () => {
    throw new Error("connect ECONNREFUSED private-host");
  };
  await assert.rejects(() => searchRecipePage(), (error) => {
    assert.equal(error.code, "RETRIEVAL_UPSTREAM_ERROR");
    assert.equal(error.statusCode, 502);
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.publicMessage, /private-host/);
    return true;
  });

  global.fetch = async () => {
    throw Object.assign(new Error("socket closed"), { code: "ETIMEDOUT" });
  };
  await assert.rejects(
    () => searchRecipePage(),
    (error) => error.code === "RETRIEVAL_TIMEOUT" && error.statusCode === 504
  );

  const timeoutController = new AbortController();
  timeoutController.abort(new DOMException("deadline", "TimeoutError"));
  t.mock.method(AbortSignal, "timeout", () => timeoutController.signal);
  global.fetch = async () => {
    throw new DOMException("deadline private-host", "AbortError");
  };
  await assert.rejects(() => searchRecipePage(), (error) => {
    assert.equal(error.code, "RETRIEVAL_TIMEOUT");
    assert.equal(error.statusCode, 504);
    return true;
  });
});

test("private HTTP failures, body failures, invalid JSON, and oversized JSON are isolated", async (t) => {
  const { searchRecipePage } = loadService();

  for (const [status, expectedCode, expectedStatus] of [
    [400, "RETRIEVAL_UPSTREAM_ERROR", 502],
    [429, "RETRIEVAL_UPSTREAM_ERROR", 502],
    [500, "RETRIEVAL_UPSTREAM_ERROR", 502],
    [503, "RETRIEVAL_NOT_READY", 503],
    [504, "RETRIEVAL_TIMEOUT", 504],
  ]) {
    global.fetch = async () => new Response("private implementation detail", { status });
    await assert.rejects(() => searchRecipePage(), (error) => {
      assert.equal(error.code, expectedCode);
      assert.equal(error.statusCode, expectedStatus);
      assert.doesNotMatch(error.publicMessage, /implementation detail/);
      return true;
    });
  }

  global.fetch = async () => new Response("not json", { status: 200 });
  await assert.rejects(() => searchRecipePage(), /invalid response/i);

  global.fetch = async () => new Response("", { status: 200 });
  await assert.rejects(() => searchRecipePage(), /invalid response/i);

  global.fetch = async () => new Response(`{"padding":"${"x".repeat(5_000_001)}"}`, { status: 200 });
  await assert.rejects(() => searchRecipePage(), /invalid response/i);

  global.fetch = async () => ({ ok: true, status: 200 });
  await assert.rejects(() => searchRecipePage(), /invalid response/i);

  global.fetch = async () => null;
  await assert.rejects(() => searchRecipePage(), /invalid response/i);

  const readController = new AbortController();
  readController.abort();
  t.mock.method(AbortSignal, "timeout", () => readController.signal);
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => {
      throw new DOMException("body deadline", "TimeoutError");
    },
  });
  await assert.rejects(() => searchRecipePage(), (error) => error.code === "RETRIEVAL_TIMEOUT");
});

test("health and readiness probes use their private endpoints and fail closed", async () => {
  const requestedPaths = [];
  global.fetch = async (url) => {
    requestedPaths.push(new URL(url).pathname);
    if (url.endsWith("/health")) return jsonResponse({ ok: true });
    return jsonResponse({ ok: false });
  };

  const { checkRetrievalHealth, checkRetrievalReadiness } = loadService();
  assert.equal(await checkRetrievalHealth(), true);
  assert.equal(await checkRetrievalReadiness(), false);
  assert.deepEqual(requestedPaths, ["/health", "/ready"]);

  global.fetch = async () => {
    throw new Error("offline");
  };
  assert.equal(await checkRetrievalHealth(), false);
  delete process.env.RETRIEVAL_SERVICE_URL;
  assert.equal(await checkRetrievalReadiness(), false);
});

test("invalid timeout configuration falls back to the documented deadline", async (t) => {
  process.env.RETRIEVAL_TIMEOUT_MS = "not-an-integer";
  let timeout;
  t.mock.method(AbortSignal, "timeout", (value) => {
    timeout = value;
    return new AbortController().signal;
  });
  global.fetch = async () => jsonResponse(searchEnvelope());

  const { DEFAULT_RETRIEVAL_TIMEOUT_MS, searchRecipePage } = loadService();
  await searchRecipePage();
  assert.equal(timeout, DEFAULT_RETRIEVAL_TIMEOUT_MS);
});

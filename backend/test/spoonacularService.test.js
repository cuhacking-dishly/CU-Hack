const assert = require("node:assert/strict");
const test = require("node:test");

const originalFetch = global.fetch;
const servicePath = require.resolve("../src/services/spoonacularService");

function loadService() {
  delete require.cache[servicePath];
  return require("../src/services/spoonacularService");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test.afterEach(() => {
  delete process.env.SPOONACULAR_API_KEY;
  delete process.env.SPOONACULAR_TIMEOUT_MS;
  global.fetch = originalFetch;
  delete require.cache[servicePath];
});

test("searchRecipes sends canonical filters, pagination, enrichment, and a deadline", async (t) => {
  process.env.SPOONACULAR_API_KEY = "  spoon-key  ";
  process.env.SPOONACULAR_TIMEOUT_MS = "3000";
  const controller = new AbortController();
  let capturedTimeout;
  t.mock.method(AbortSignal, "timeout", (timeout) => {
    capturedTimeout = timeout;
    return controller.signal;
  });

  let requestedUrl;
  let requestedOptions;
  global.fetch = async (url, options) => {
    requestedUrl = new URL(url);
    requestedOptions = options;
    return jsonResponse({
      results: [
        {
          id: 123,
          title: " Vegan Bowl ",
          image: "https://example.com/image.jpg",
          readyInMinutes: "25.4",
          servings: 2.2,
          diets: [" vegan ", "VEGAN", null],
          sourceName: " Example Kitchen ",
          sourceUrl: " https://example.com/recipe ",
          extendedIngredients: [
            { original: " 1 cup quinoa " },
            { originalName: "grilled chicken" },
            { name: " lemon " },
            { original: "1 cup quinoa" },
          ],
          analyzedInstructions: [
            {
              steps: [
                { number: 1, step: " Cook the quinoa. " },
                { number: 2, step: "Top with chicken & lemon." },
              ],
            },
          ],
          nutrition: {
            nutrients: [
              { name: "Calories", amount: 499.7, unit: "kcal" },
              { name: "Protein", amount: 31.2, unit: "g" },
              { name: "Carbohydrates", amount: 45.5, unit: "g" },
              { name: "Fat", amount: 12.1, unit: "g" },
            ],
          },
        },
        {
          id: "124",
          title: "Minimal Recipe",
          image: "javascript:alert(1)",
          sourceUrl: "not a URL",
        },
        null,
        { id: 125, title: "   " },
      ],
    });
  };

  const { searchRecipes } = loadService();
  const recipes = await searchRecipes(
    {
      query: "  cozy ramen  ",
      cuisines: [" Japanese ", "Italian", "japanese"],
      mealType: " Main Course ",
      minCalories: 425,
      maxCalories: 500,
      minProtein_g: 30,
      maxProtein_g: 45,
      minCarbs_g: 40,
      maxCarbs_g: 60,
      maxReadyTime: 3.5,
      diet: " Vegan ",
      intolerances: [" Peanut ", "SHELLFISH", "peanut"],
      excludeIngredients: [" peanuts ", "PEANUTS", null, "shellfish"],
    },
    { limit: 7, offset: 20 }
  );

  assert.equal(requestedUrl.origin, "https://api.spoonacular.com");
  assert.equal(requestedUrl.pathname, "/recipes/complexSearch");
  assert.equal(requestedUrl.searchParams.get("apiKey"), "spoon-key");
  assert.equal(requestedUrl.searchParams.get("number"), "7");
  assert.equal(requestedUrl.searchParams.get("offset"), "20");
  assert.equal(requestedUrl.searchParams.get("addRecipeInformation"), "true");
  assert.equal(requestedUrl.searchParams.get("addRecipeInstructions"), "true");
  assert.equal(requestedUrl.searchParams.get("addRecipeNutrition"), "true");
  assert.equal(requestedUrl.searchParams.get("fillIngredients"), "true");
  assert.equal(requestedUrl.searchParams.get("instructionsRequired"), "true");
  assert.equal(requestedUrl.searchParams.get("sort"), "popularity");
  assert.equal(requestedUrl.searchParams.get("sortDirection"), "desc");
  assert.equal(requestedUrl.searchParams.get("query"), "cozy ramen");
  assert.equal(requestedUrl.searchParams.get("cuisine"), "japanese,italian");
  assert.equal(requestedUrl.searchParams.get("type"), "main course");
  assert.equal(requestedUrl.searchParams.get("minCalories"), "425");
  assert.equal(requestedUrl.searchParams.get("maxCalories"), "500");
  assert.equal(requestedUrl.searchParams.get("minProtein"), "30");
  assert.equal(requestedUrl.searchParams.get("maxProtein"), "45");
  assert.equal(requestedUrl.searchParams.get("minCarbs"), "40");
  assert.equal(requestedUrl.searchParams.get("maxCarbs"), "60");
  assert.equal(requestedUrl.searchParams.get("diet"), "vegan");
  assert.equal(requestedUrl.searchParams.get("intolerances"), "peanut,shellfish");
  assert.equal(requestedUrl.searchParams.get("excludeIngredients"), "peanuts,shellfish");
  assert.equal(requestedUrl.searchParams.has("maxReadyTime"), false);
  assert.deepEqual(requestedOptions.headers, { Accept: "application/json" });
  assert.equal(requestedOptions.signal, controller.signal);
  assert.equal(capturedTimeout, 3000);

  assert.deepEqual(recipes, [
    {
      id: "123",
      title: "Vegan Bowl",
      image: "https://example.com/image.jpg",
      readyInMinutes: 25,
      servings: 2,
      calories: 500,
      macros: { protein_g: 31, carbs_g: 46, fat_g: 12 },
      diets: ["vegan"],
      ingredients: ["1 cup quinoa", "grilled chicken", "lemon"],
      instructions: ["Cook the quinoa.", "Top with chicken & lemon."],
      sourceName: "Example Kitchen",
      sourceUrl: "https://example.com/recipe",
    },
    {
      id: "124",
      title: "Minimal Recipe",
      image: "",
      readyInMinutes: null,
      servings: null,
      calories: null,
      macros: { protein_g: null, carbs_g: null, fat_g: null },
      diets: [],
      ingredients: [],
      instructions: [],
      sourceName: "",
      sourceUrl: "",
    },
  ]);
});

test("searchRecipes uses safe defaults and compatibility aliases", async (t) => {
  process.env.SPOONACULAR_API_KEY = "spoon-key";
  process.env.SPOONACULAR_TIMEOUT_MS = "invalid";
  let capturedTimeout;
  t.mock.method(AbortSignal, "timeout", (timeout) => {
    capturedTimeout = timeout;
    return new AbortController().signal;
  });
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = new URL(url);
    return jsonResponse({ results: [] });
  };

  const service = loadService();
  assert.equal(service.fetchRecipesForGoal, service.searchRecipes);
  assert.equal(service.fetchRecipeById, service.getRecipeById);
  assert.equal(service.getFallbackRecipeById("1"), null);
  assert.deepEqual(await service.searchRecipes(), []);
  assert.equal(requestedUrl.searchParams.get("number"), "10");
  assert.equal(requestedUrl.searchParams.get("offset"), "0");
  assert.equal(capturedTimeout, 8000);
});

test("searchRecipes never returns more rows than the requested limit", async () => {
  process.env.SPOONACULAR_API_KEY = "spoon-key";
  global.fetch = async () =>
    jsonResponse({
      results: Array.from({ length: 5 }, (_, index) => ({
        id: index + 1,
        title: `Recipe ${index + 1}`,
      })),
    });
  const { searchRecipePage } = loadService();

  const page = await searchRecipePage({}, { limit: 2, offset: 0 });

  assert.deepEqual(
    page.recipes.map((recipe) => recipe.id),
    ["1", "2"]
  );
  assert.equal(page.hasMore, true);
});

test("searchRecipePage prioritizes image-backed, highly scored recipes within a provider page", async () => {
  process.env.SPOONACULAR_API_KEY = "spoon-key";
  global.fetch = async () =>
    jsonResponse({
      results: [
        { id: 1, title: "No image despite a score", spoonacularScore: 99, aggregateLikes: 1_000 },
        {
          id: 2,
          title: "Good image, lower score",
          image: "https://img.spoonacular.com/recipes/2-312x231.jpg",
          spoonacularScore: 62,
          aggregateLikes: 2_000,
        },
        {
          id: 3,
          title: "Exceptional image-backed recipe",
          image: "https://img.spoonacular.com/recipes/3-312x231.jpg",
          spoonacularScore: 91,
          aggregateLikes: 400,
          healthScore: 70,
          veryPopular: true,
        },
      ],
    });

  const { searchRecipePage } = loadService();
  const page = await searchRecipePage({}, { limit: 3, offset: 0 });

  assert.deepEqual(page.recipes.map((recipe) => recipe.id), ["3", "2", "1"]);
  assert.match(page.recipes[0].image, /3-556x370/);
});

test("searchRecipePage derives continuation from provider totals, raw rows, and offset bounds", async () => {
  process.env.SPOONACULAR_API_KEY = "spoon-key";
  let payload;
  global.fetch = async () => jsonResponse(payload);
  const { searchRecipePage } = loadService();

  const cases = [
    { limit: 2, offset: 0, rawCount: 2, totalResults: 3, expected: true },
    { limit: 2, offset: 2, rawCount: 1, totalResults: 3, expected: false },
    { limit: 2, offset: 10, rawCount: 2, totalResults: "100", expected: true },
    { limit: 2, offset: 10, rawCount: 1, totalResults: "100", expected: false },
    { limit: 1, offset: 899, rawCount: 1, totalResults: 901, expected: true },
    { limit: 1, offset: 900, rawCount: 1, totalResults: 1000, expected: false },
  ];

  for (const testCase of cases) {
    payload = {
      results: Array.from({ length: testCase.rawCount }, (_, index) => ({
        id: testCase.offset + index + 1,
        title: `Recipe ${testCase.offset + index + 1}`,
      })),
      totalResults: testCase.totalResults,
    };

    const page = await searchRecipePage({}, testCase);
    assert.equal(page.recipes.length, Math.min(testCase.rawCount, testCase.limit));
    assert.equal(page.hasMore, testCase.expected);
  }
});

test("searchRecipes validates pagination bounds before calling the provider", async () => {
  process.env.SPOONACULAR_API_KEY = "spoon-key";
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({ results: [] });
  };
  const { searchRecipes } = loadService();

  for (const options of [
    null,
    [],
    { limit: 0 },
    { limit: 21 },
    { limit: "10" },
    { offset: -1 },
    { offset: 901 },
    { offset: 1.5 },
  ]) {
    await assert.rejects(() => searchRecipes({}, options), (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "INVALID_SEARCH_OPTIONS");
      assert.equal(error.publicMessage, "Invalid recipe search options");
      return true;
    });
  }
  assert.equal(fetchCalls, 0);
});

test("getRecipeById validates and canonicalizes numeric ids", async () => {
  process.env.SPOONACULAR_API_KEY = "spoon-key";
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = new URL(url);
    return jsonResponse({ id: 456, title: "Chicken Plate" });
  };
  const { getRecipeById } = loadService();

  assert.deepEqual(await getRecipeById("456"), {
    id: "456",
    title: "Chicken Plate",
    image: "",
    readyInMinutes: null,
    servings: null,
    calories: null,
    macros: { protein_g: null, carbs_g: null, fat_g: null },
    diets: [],
    ingredients: [],
    instructions: [],
    sourceName: "",
    sourceUrl: "",
  });
  assert.equal(requestedUrl.pathname, "/recipes/456/information");
  assert.equal(requestedUrl.searchParams.get("apiKey"), "spoon-key");
  assert.equal(requestedUrl.searchParams.get("includeNutrition"), "true");

  for (const id of [undefined, null, "", "abc", "0", -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => getRecipeById(id), (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "INVALID_RECIPE_ID");
      assert.equal(error.publicMessage, "Recipe id must be a positive integer");
      return true;
    });
  }
});

test("recipe URLs allow only absolute HTTP(S) values without credentials", () => {
  const { normalizeRecipe } = loadService();
  assert.deepEqual(
    normalizeRecipe({
      id: 1,
      title: "Safe links",
      image: "http://images.example.com/a.jpg",
      sourceUrl: "https://user:password@example.com/recipe",
      spoonacularSourceUrl: "https://spoonacular.com/recipes/safe-links-1",
    }),
    {
      id: "1",
      title: "Safe links",
      image: "http://images.example.com/a.jpg",
      readyInMinutes: null,
      servings: null,
      calories: null,
      macros: { protein_g: null, carbs_g: null, fat_g: null },
      diets: [],
      ingredients: [],
      instructions: [],
      sourceName: "",
      sourceUrl: "https://spoonacular.com/recipes/safe-links-1",
    }
  );
  assert.equal(normalizeRecipe({ id: 2, title: "Bad", image: "data:text/html,hello" }).image, "");
});

test("recipe normalization extracts safe inline recipe text and upgrades provider thumbnails", () => {
  const { normalizeRecipe } = loadService();

  assert.deepEqual(
    normalizeRecipe({
      id: 716429,
      title: "Pasta Bowl",
      image: "https://img.spoonacular.com/recipes/716429-312x231.jpg",
      sourceName: "Full Belly Sisters",
      extendedIngredients: [
        { original: "<b>1 cup</b> pasta" },
        { original: "1 cup pasta" },
        { name: "scallions &amp; garlic" },
      ],
      instructions: "<ol><li>Boil pasta.</li><li>Mix with scallions &amp; garlic.</li></ol>",
    }),
    {
      id: "716429",
      title: "Pasta Bowl",
      image: "https://img.spoonacular.com/recipes/716429-556x370.jpg",
      readyInMinutes: null,
      servings: null,
      calories: null,
      macros: { protein_g: null, carbs_g: null, fat_g: null },
      diets: [],
      ingredients: ["1 cup pasta", "scallions & garlic"],
      instructions: ["Boil pasta.", "Mix with scallions & garlic."],
      sourceName: "Full Belly Sisters",
      sourceUrl: "",
    }
  );
});

test("missing Spoonacular configuration returns a safe 503", async () => {
  process.env.SPOONACULAR_API_KEY = "   ";
  const { searchRecipes } = loadService();

  await assert.rejects(() => searchRecipes({}), (error) => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "SPOONACULAR_NOT_CONFIGURED");
    assert.equal(error.publicMessage, "Recipe service is not configured");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("provider errors expose stable public metadata and cap private response detail", async () => {
  process.env.SPOONACULAR_API_KEY = "spoon-key";
  const privateBody = `quota-token-${"x".repeat(1500)}-must-not-appear`;
  global.fetch = async () => new Response(privateBody, { status: 402 });
  const { searchRecipes } = loadService();

  await assert.rejects(() => searchRecipes({}), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, "SPOONACULAR_UPSTREAM_ERROR");
    assert.equal(error.publicMessage, "Recipe service is temporarily unavailable");
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /quota-token|must-not-appear/);
    assert.match(error.cause.message, /quota-token/);
    assert.doesNotMatch(error.cause.message, /must-not-appear/);
    assert.ok(error.cause.message.length < 1100);
    return true;
  });
});

test("detail 404 maps to a public recipe-not-found error", async () => {
  process.env.SPOONACULAR_API_KEY = "spoon-key";
  global.fetch = async () => new Response("provider secret", { status: 404 });
  const { getRecipeById } = loadService();

  await assert.rejects(() => getRecipeById("123"), (error) => {
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "RECIPE_NOT_FOUND");
    assert.equal(error.publicMessage, "Recipe not found");
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /provider secret/);
    assert.match(error.cause.message, /provider secret/);
    return true;
  });
});

test("network failures map to a safe retryable 502", async () => {
  process.env.SPOONACULAR_API_KEY = "spoon-key";
  const networkError = new Error("connect ECONNRESET api.spoonacular.com");
  global.fetch = async () => {
    throw networkError;
  };
  const { searchRecipes } = loadService();

  await assert.rejects(() => searchRecipes({}), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, "SPOONACULAR_UPSTREAM_ERROR");
    assert.equal(error.retryable, true);
    assert.equal(error.cause, networkError);
    assert.doesNotMatch(error.message, /ECONNRESET|spoonacular/);
    return true;
  });
});

test("fetch cancellation, body-read cancellation, and JSON-read cancellation map to 504", async (t) => {
  process.env.SPOONACULAR_API_KEY = "spoon-key";
  const { searchRecipes } = loadService();

  await t.test("fetch", async (t) => {
    process.env.SPOONACULAR_API_KEY = "spoon-key";
    const controller = new AbortController();
    t.mock.method(AbortSignal, "timeout", () => {
      queueMicrotask(() => controller.abort(new DOMException("deadline", "TimeoutError")));
      return controller.signal;
    });
    global.fetch = (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    await assert.rejects(() => searchRecipes({}), (error) => error.code === "SPOONACULAR_TIMEOUT");
  });

  await t.test("response body", async (t) => {
    process.env.SPOONACULAR_API_KEY = "spoon-key";
    const controller = new AbortController();
    controller.abort(new DOMException("deadline", "TimeoutError"));
    t.mock.method(AbortSignal, "timeout", () => controller.signal);
    global.fetch = async () => ({
      ok: false,
      status: 500,
      async text() {
        throw new Error("body cancelled");
      },
    });
    await assert.rejects(() => searchRecipes({}), (error) => error.code === "SPOONACULAR_TIMEOUT");
  });

  await t.test("response JSON", async (t) => {
    process.env.SPOONACULAR_API_KEY = "spoon-key";
    const controller = new AbortController();
    controller.abort(new DOMException("deadline", "TimeoutError"));
    t.mock.method(AbortSignal, "timeout", () => controller.signal);
    global.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new Error("JSON cancelled");
      },
    });
    await assert.rejects(() => searchRecipes({}), (error) => {
      assert.equal(error.statusCode, 504);
      assert.equal(error.code, "SPOONACULAR_TIMEOUT");
      assert.equal(error.publicMessage, "Recipe service timed out");
      assert.equal(error.retryable, true);
      return true;
    });
  });
});

test("invalid JSON and malformed successful payloads map to a safe 502", async (t) => {
  process.env.SPOONACULAR_API_KEY = "spoon-key";
  const { searchRecipes } = loadService();

  global.fetch = async () => new Response("not JSON", { status: 200 });
  await assert.rejects(() => searchRecipes({}), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, "SPOONACULAR_INVALID_RESPONSE");
    assert.equal(error.publicMessage, "Recipe service returned an invalid response");
    assert.doesNotMatch(error.message, /not JSON/);
    return true;
  });

  for (const payload of [null, [], {}, { results: {} }]) {
    await t.test(JSON.stringify(payload), async () => {
      process.env.SPOONACULAR_API_KEY = "spoon-key";
      global.fetch = async () => jsonResponse(payload);
      await assert.rejects(
        () => searchRecipes({}),
        (error) => error.statusCode === 502 && error.code === "SPOONACULAR_INVALID_RESPONSE"
      );
    });
  }
});

test("malformed detail payloads reject instead of emitting an unstable DTO", async () => {
  process.env.SPOONACULAR_API_KEY = "spoon-key";
  global.fetch = async () => jsonResponse({ id: 123, title: "   " });
  const { getRecipeById } = loadService();

  await assert.rejects(() => getRecipeById("123"), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, "SPOONACULAR_INVALID_RESPONSE");
    return true;
  });
});

test("a malformed fetch response object is treated as an invalid upstream response", async () => {
  process.env.SPOONACULAR_API_KEY = "spoon-key";
  global.fetch = async () => ({ status: 200, json: async () => ({ results: [] }) });
  const { searchRecipes } = loadService();

  await assert.rejects(
    () => searchRecipes({}),
    (error) => error.statusCode === 502 && error.code === "SPOONACULAR_INVALID_RESPONSE"
  );
});

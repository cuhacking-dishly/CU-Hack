import { expect, test } from "@playwright/test";

const API_PATTERN = "http://localhost:3000/api/**";
const CORS_HEADERS = {
  "access-control-allow-origin": "http://localhost:5173",
  "access-control-allow-headers": "Accept, Content-Type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const ALPHA_RECIPE = {
  id: "1001",
  title: "Lemon Chicken Bowl",
  image: "http://localhost:5173/fixtures/alpha.png",
  readyInMinutes: 25,
  servings: 2,
  calories: 480,
  macros: { protein_g: 38, carbs_g: 42, fat_g: 14 },
  diets: ["gluten free"],
  ingredients: ["1 cup quinoa", "1 lemon"],
  instructions: ["Cook the quinoa.", "Top with lemon chicken."],
  sourceName: "Example Kitchen",
  sourceUrl: "https://recipes.example/lemon-chicken",
};

const BETA_RECIPE = {
  id: "9002",
  title: "Ginger Tofu Plate",
  image: "http://localhost:5173/fixtures/beta.png",
  readyInMinutes: 20,
  servings: 1,
  calories: 510,
  macros: { protein_g: 31, carbs_g: 55, fat_g: 18 },
  diets: ["vegan"],
  ingredients: ["8 oz tofu", "1 tbsp ginger"],
  instructions: ["Sear the tofu.", "Add ginger sauce."],
  sourceName: "Example Kitchen",
  sourceUrl: "https://recipes.example/ginger-tofu",
};

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function fulfillJson(route, data, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: CORS_HEADERS,
    body: JSON.stringify(data),
  });
}

async function installImageFixtures(page) {
  await page.route("**/fixtures/alpha.png", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG }),
  );
  await page.route("**/fixtures/beta.png", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG }),
  );
}

async function installApiFixtures(
  page,
  {
    recipes = [ALPHA_RECIPE, BETA_RECIPE],
    details = new Map([
      [ALPHA_RECIPE.id, ALPHA_RECIPE],
      [BETA_RECIPE.id, BETA_RECIPE],
    ]),
    goal = {
      rawText: "high protein, quick meals",
      parsedFilter: { maxReadyTime: 30, minProtein_g: 30 },
      updatedAt: "2026-07-11T16:00:00.000Z",
    },
    parsedFilter = { diet: "vegan", maxReadyTime: 30, minProtein_g: 30 },
  } = {},
) {
  const observed = {
    apiCalls: [],
    parsedGoals: [],
    savedGoals: [],
    swipes: [],
    detailIds: [],
    recipeQueries: [],
  };

  await page.route(API_PATTERN, async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    if (method === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }

    observed.apiCalls.push(`${method} ${path}`);

    if (method === "POST" && path === "/api/parse-goal") {
      const payload = request.postDataJSON();
      observed.parsedGoals.push(payload);
      await fulfillJson(route, {
        parsedFilter,
      });
      return;
    }

    if (method === "POST" && path === "/api/goal") {
      const payload = request.postDataJSON();
      observed.savedGoals.push(payload);
      await fulfillJson(route, { success: true });
      return;
    }

    if (method === "GET" && path === "/api/goal/current") {
      await fulfillJson(route, goal);
      return;
    }

    if (method === "GET" && path === "/api/recipes") {
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      observed.recipeQueries.push({
        userId: url.searchParams.get("userId"),
        limit,
        offset,
      });
      await fulfillJson(route, {
        recipes,
        pagination: { limit, offset, count: recipes.length, hasMore: false },
      });
      return;
    }

    if (method === "GET" && path.startsWith("/api/recipes/")) {
      const id = decodeURIComponent(path.slice("/api/recipes/".length));
      observed.detailIds.push(id);
      const detail = details.get(id);
      await fulfillJson(route, detail || { error: "Recipe not found" }, detail ? 200 : 404);
      return;
    }

    if (method === "POST" && path === "/api/swipe") {
      observed.swipes.push(request.postDataJSON());
      await fulfillJson(route, { success: true });
      return;
    }

    await fulfillJson(route, { error: `Unhandled fixture request: ${method} ${path}` }, 500);
  });

  return observed;
}

async function expectNoHorizontalOverflow(page) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        viewportWidth: window.innerWidth,
      })),
    )
    .toEqual(
      expect.objectContaining({
        documentWidth: page.viewportSize().width,
        bodyWidth: page.viewportSize().width,
        viewportWidth: page.viewportSize().width,
      }),
    );
}

test.beforeEach(async ({ page }) => {
  await installImageFixtures(page);
});

test("completes goal entry, opens the exact liked card, and renders its full nutrition", async ({
  page,
}) => {
  const observed = await installApiFixtures(page);

  await page.goto("/");
  await expect(page).toHaveTitle("dishly");
  await expect(page.getByRole("link", { name: "Dishly home" })).toBeVisible();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/images/dishly-icon.png");
  expect(observed.apiCalls).toEqual([]);

  await page.getByRole("textbox", { name: "Your food goal" }).fill("vegan, high protein, under 30 minutes");
  await page.getByRole("button", { name: "Start swiping" }).click();

  await expect(page).toHaveURL(/\/deck$/);
  await expect(page.getByRole("status")).toContainText("Match 1: Lemon Chicken Bowl");
  const activeCard = page.locator(".recipe-card-active");
  await expect(activeCard.getByRole("heading", { name: ALPHA_RECIPE.title })).toBeVisible();
  await expect(activeCard.getByRole("img", { name: ALPHA_RECIPE.title })).toHaveAttribute(
    "src",
    ALPHA_RECIPE.image,
  );

  await expect(page.getByRole("heading", { name: "Ingredients" })).toBeVisible();
  await expect(page.getByText("Top with lemon chicken.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Source: Example Kitchen" })).toHaveAttribute(
    "href",
    ALPHA_RECIPE.sourceUrl,
  );

  await page.getByRole("button", { name: "Like recipe" }).click();

  await expect(page).toHaveURL(/\/deck$/);
  await expect(page.getByRole("status")).toContainText("Match 2: Ginger Tofu Plate");
  await expect(page.getByLabel("Nutrition per serving")).toBeVisible();

  expect(observed.parsedGoals).toEqual([
    { text: "vegan, high protein, under 30 minutes" },
  ]);
  expect(observed.savedGoals).toEqual([
    {
      userId: "demo-user-1",
      rawText: "vegan, high protein, under 30 minutes",
      parsedFilter: { diet: "vegan", maxReadyTime: 30, minProtein_g: 30 },
    },
  ]);
  expect(observed.swipes).toEqual([
    { userId: "demo-user-1", recipeId: "1001", direction: "right" },
  ]);
  expect(observed.detailIds).toEqual([]);
  expect(observed.recipeQueries).toEqual([
    { userId: "demo-user-1", limit: 10, offset: 0 },
  ]);

  expect(observed.recipeQueries).toHaveLength(1);

  await page.reload();
  await expect(page.getByRole("status")).toContainText("Match 2: Ginger Tofu Plate");
  expect(observed.recipeQueries).toHaveLength(1);
});

test("builds a deck from nutrition targets without requiring a typed goal", async ({ page }) => {
  const observed = await installApiFixtures(page);

  await page.goto("/");
  await expect
    .poll(async () => {
      const [heroLogoBounds, heroSearchBounds] = await Promise.all([
        page.locator(".goal-entry-hero-brand").boundingBox(),
        page.locator(".goal-entry-row").boundingBox(),
      ]);

      return Boolean(
        heroLogoBounds &&
          heroSearchBounds &&
          Math.abs(heroLogoBounds.x - heroSearchBounds.x) <= 1 &&
          heroLogoBounds.y + heroLogoBounds.height < heroSearchBounds.y,
      );
    })
    .toBe(true);
  await expect(page.locator(".goal-entry-hero-brand img")).toHaveAttribute(
    "src",
    "/images/dishly-logo-hero.png",
  );
  const logoCornerAlpha = await page.evaluate(async () => {
    const image = document.querySelector(".goal-entry-hero-brand img");
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);

    return [
      context.getImageData(0, 0, 1, 1).data[3],
      context.getImageData(canvas.width - 1, 0, 1, 1).data[3],
      context.getImageData(0, canvas.height - 1, 1, 1).data[3],
      context.getImageData(canvas.width - 1, canvas.height - 1, 1, 1).data[3],
    ];
  });
  expect(logoCornerAlpha).toEqual([0, 0, 0, 0]);
  const closedPanelBounds = await page.locator(".goal-entry-panel").boundingBox();
  expect(closedPanelBounds).not.toBeNull();
  await page.getByRole("button", { name: "Open recipe filters" }).click();
  await expect(page.getByText("Per serving, matched within ±20%.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Quick Dinner" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mediterranean" })).toHaveCount(0);
  await expect
    .poll(async () => {
      const [rowBounds, filterBounds] = await Promise.all([
        page.locator(".goal-entry-row").boundingBox(),
        page.locator(".nutrition-filter").boundingBox(),
      ]);

      return Boolean(
        rowBounds &&
          filterBounds &&
          Math.abs(filterBounds.x - rowBounds.x) <= 1 &&
          Math.abs(filterBounds.width - rowBounds.width) <= 1,
      );
    })
    .toBe(true);
  await expect
    .poll(async () => (await page.locator(".goal-entry-panel").boundingBox())?.y ?? Number.POSITIVE_INFINITY)
    .toBeLessThan(closedPanelBounds.y - 10);
  const openFilterBounds = await page.locator(".nutrition-filter").boundingBox();
  expect(openFilterBounds).not.toBeNull();
  expect(openFilterBounds.y + openFilterBounds.height).toBeLessThanOrEqual(page.viewportSize().height);
  const filterScrollState = await page.locator(".nutrition-filter").evaluate((panel) => ({
    clientHeight: panel.clientHeight,
    overflowY: getComputedStyle(panel).overflowY,
    scrollHeight: panel.scrollHeight,
    scrollbarWidth: getComputedStyle(panel).scrollbarWidth,
  }));
  expect(filterScrollState).toMatchObject({ overflowY: "auto", scrollbarWidth: "thin" });
  expect(filterScrollState.scrollHeight).toBeGreaterThan(filterScrollState.clientHeight);
  const nutritionFocusStyle = await page.getByRole("spinbutton", { name: "Protein" }).evaluate((input) => {
    input.focus();
    return {
      inputBoxShadow: getComputedStyle(input).boxShadow,
      controlBackground: getComputedStyle(input.parentElement).backgroundColor,
    };
  });
  expect(nutritionFocusStyle.inputBoxShadow).toBe("none");
  expect(nutritionFocusStyle.controlBackground).not.toMatch(/rgb\(255,\s*250,\s*240\)/);
  await page.getByRole("spinbutton", { name: "Calories" }).fill("500");
  await page.getByRole("spinbutton", { name: "Protein" }).fill("40");
  await expect(page.getByRole("button", { name: "Start swiping" })).toBeEnabled();
  await page.getByRole("button", { name: "Start swiping" }).click();

  await expect(page).toHaveURL(/\/deck$/);
  expect(observed.parsedGoals).toEqual([]);
  expect(observed.savedGoals).toEqual([
    {
      userId: "demo-user-1",
      rawText: "Recipes around 500 calories, 40g protein per serving",
      parsedFilter: {
        minCalories: 400,
        maxCalories: 600,
        minProtein_g: 32,
        maxProtein_g: 48,
      },
    },
  ]);
});

test("interprets multiple cultures and a non-listed allergy before building a deck", async ({ page }) => {
  const parsedFilter = {
    cuisines: ["chinese", "italian"],
    intolerances: ["peanut"],
    excludeIngredients: ["peanut", "strawberries", "alpha-gal"],
  };
  const observed = await installApiFixtures(page, { parsedFilter });

  await page.goto("/");
  await page.getByRole("button", { name: "Open recipe filters" }).click();
  await page.getByLabel("Culture / cuisine").fill("Chinese or Italian");
  await page.getByLabel("Allergies / ingredients to avoid").fill("peanut, strawberries, alpha-gal");
  await page.getByRole("radio", { name: "Lunch & dinner" }).click();
  await page.getByRole("button", { name: "Start swiping" }).click();

  await expect(page).toHaveURL(/\/deck$/);
  expect(observed.parsedGoals).toEqual([
    {
      text:
        "Cuisine or culture preference: Chinese or Italian.\nAllergies or ingredients to avoid: peanut, strawberries, alpha-gal.",
    },
  ]);
  expect(observed.savedGoals).toEqual([
    {
      userId: "demo-user-1",
      rawText:
        "Cuisine or culture preference: Chinese or Italian.\nAllergies or ingredients to avoid: peanut, strawberries, alpha-gal.",
      parsedFilter: {
        cuisines: ["chinese", "italian"],
        mealType: "main course",
        intolerances: ["peanut"],
        excludeIngredients: ["peanut", "strawberries", "alpha-gal"],
      },
    },
  ]);
});

test("keeps the reliable deck controls inside a 1366 by 768 laptop viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installApiFixtures(page);
  await page.goto("/deck");
  await expect(page.getByRole("status")).toContainText("Match 1");

  const actionsBox = await page.locator(".deck-actions").boundingBox();
  expect(actionsBox).not.toBeNull();
  expect(actionsBox.y).toBeGreaterThanOrEqual(0);
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(768);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("returns to the active deck after opening change goal", async ({ page }) => {
  await installApiFixtures(page);
  await page.goto("/deck");
  await expect(page.getByRole("status")).toContainText("Match 1: Lemon Chicken Bowl");

  await page.getByRole("button", { name: "Change goal" }).click();
  await expect(page.getByRole("button", { name: "Back to deck" })).toBeVisible();
  await page.getByRole("button", { name: "Back to deck" }).click();

  await expect(page).toHaveURL(/\/deck$/);
  await expect(page.getByRole("status")).toContainText("Match 1: Lemon Chicken Bowl");
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test(`prevents horizontal overflow and contains large stats at ${viewport.width}px`, async ({
    page,
  }) => {
    const layoutRecipe = {
      ...ALPHA_RECIPE,
      id: "7001",
      title: "AnExtraordinarilyLongUnbrokenRecipeTitleThatMustNeverEscapeTheViewport",
      calories: 987654321,
      macros: { protein_g: 123456789, carbs_g: 876543210, fat_g: 456789012 },
      diets: ["AnExtraordinarilyLongUnbrokenDietLabelThatMustWrap"],
    };
    await page.setViewportSize(viewport);
    await installApiFixtures(page, {
      recipes: [layoutRecipe],
      details: new Map([[layoutRecipe.id, layoutRecipe]]),
    });

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Dishly home" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Open recipe filters" }).click();
    await page.locator(".nutrition-filter").evaluate((panel) => {
      panel.scrollTop = panel.scrollHeight;
    });
    await expect(page.getByRole("button", { name: "One-Pot" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto("/deck");
    await expect(page.getByRole("status")).toContainText("Match 1");
    await expectNoHorizontalOverflow(page);

    await page.goto("/recipe/7001");
    await expect(page.getByRole("heading", { name: layoutRecipe.title, level: 1 })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const containment = await page.locator(".recipe-detail-stat").evaluateAll((stats) =>
      stats.map((stat) => {
        const reading = stat.querySelector("strong");
        const statBounds = stat.getBoundingClientRect();
        const readingBounds = reading.getBoundingClientRect();
        return {
          containedLeft: readingBounds.left >= statBounds.left - 1,
          containedRight: readingBounds.right <= statBounds.right + 1,
          noInternalOverflow: stat.scrollWidth <= stat.clientWidth,
        };
      }),
    );
    expect(containment).toHaveLength(4);
    expect(containment).toEqual(
      Array.from({ length: 4 }, () => ({
        containedLeft: true,
        containedRight: true,
        noInternalOverflow: true,
      })),
    );

    await page.goto("/definitely-not-a-real-route");
    await expect(page.getByRole("heading", { name: "This page is not on the menu" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}

test("honors reduced motion while retaining swipe behavior", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installApiFixtures(page);
  await page.goto("/deck");
  await expect(page.getByRole("status")).toContainText("Match 1");

  const motionState = await page.evaluate(() => {
    const workspace = document.querySelector(".deck-workspace");
    const action = document.querySelector(".deck-actions button");
    const parseDurations = (value) =>
      value.split(",").map((duration) => {
        const normalized = duration.trim();
        return normalized.endsWith("ms")
          ? Number.parseFloat(normalized) / 1000
          : Number.parseFloat(normalized);
      });

    return {
      mediaMatches: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      animationDurations: parseDurations(getComputedStyle(workspace).animationDuration),
      transitionDurations: parseDurations(getComputedStyle(action).transitionDuration),
    };
  });
  expect(motionState.mediaMatches).toBe(true);
  expect(Math.max(...motionState.animationDurations)).toBeLessThanOrEqual(0.001);
  expect(Math.max(...motionState.transitionDurations)).toBeLessThanOrEqual(0.001);

  await page.getByRole("button", { name: "Skip recipe" }).click();
  await expect(page.getByRole("status")).toContainText("Match 2: Ginger Tofu Plate");
});

test("shows accessible fallbacks when deck and detail images fail", async ({ page }) => {
  const brokenRecipe = {
    ...ALPHA_RECIPE,
    id: "8001",
    title: "Broken Image Bowl",
    image: "http://localhost:5173/fixtures/broken.png",
  };
  await page.route("**/fixtures/broken.png", (route) => route.fulfill({ status: 404 }));
  await installApiFixtures(page, {
    recipes: [brokenRecipe],
    details: new Map([[brokenRecipe.id, brokenRecipe]]),
  });

  await page.goto("/deck");
  await expect(
    page.getByRole("img", { name: "Broken Image Bowl image unavailable" }),
  ).toContainText("Recipe image unavailable");

  await page.goto("/recipe/8001");
  await expect(
    page.getByRole("img", { name: "Broken Image Bowl image unavailable" }),
  ).toContainText("Recipe image unavailable");
});

test("renders a useful wildcard route and returns to goal entry", async ({ page }) => {
  await page.goto("/this-route-does-not-exist");

  await expect(page).toHaveTitle("dishly");
  await expect(page.getByRole("heading", { name: "This page is not on the menu" })).toBeVisible();
  await page.getByRole("link", { name: "Go to goal entry" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Dishly home" })).toBeVisible();
});

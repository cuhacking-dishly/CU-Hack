import { expect, test } from "@playwright/test";

const API_ORIGIN = `http://localhost:${process.env.FULLSTACK_BACKEND_PORT || "3000"}`;
const API_PREFIX = `${API_ORIGIN}/api`;
const OBSERVATION_URL = `${API_ORIGIN}/__recipe_match_fullstack__/state`;
const USER_ID = "demo-user-1";
const GOAL_TEXT = "vegan, high protein, no peanuts, under 600 calories and 30 minutes";
const EXPECTED_FILTER = {
  maxCalories: 600,
  minProtein_g: 30,
  diet: "vegan",
  maxReadyTime: 30,
  excludeIngredients: ["peanuts"],
};

function fixtureTitle(sequence) {
  return `Fixture Match ${String(sequence).padStart(2, "0")}`;
}

async function readFixtureState(request) {
  const response = await request.get(OBSERVATION_URL);
  expect(response.ok()).toBe(true);
  return response.json();
}

test("runs the complete browser flow through the real Express API", async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });

  const browserApiCalls = [];
  const recipePageResponses = [];

  page.on("request", (browserRequest) => {
    if (!browserRequest.url().startsWith(API_PREFIX) || browserRequest.method() === "OPTIONS") {
      return;
    }

    const url = new URL(browserRequest.url());
    browserApiCalls.push({
      method: browserRequest.method(),
      pathname: url.pathname,
      searchParams: Object.fromEntries(url.searchParams),
    });
  });

  page.on("response", (response) => {
    const url = new URL(response.url());
    if (response.request().method() === "GET" && url.pathname === "/api/recipes") {
      recipePageResponses.push(response.json());
    }
  });

  await page.goto("/");
  await expect(page.getByRole("link", { name: "Dishly home" })).toBeVisible();
  expect(browserApiCalls).toEqual([]);

  await page.getByRole("textbox", { name: "Your food goal" }).fill(GOAL_TEXT);
  await page.getByRole("button", { name: "Start swiping" }).click();

  await expect(page).toHaveURL(/\/deck$/);
  await expect(page.getByRole("status")).toContainText(`Match 1: ${fixtureTitle(1)}`);

  expect(browserApiCalls.slice(0, 4).map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([
    "POST /api/parse-goal",
    "POST /api/goal",
    "GET /api/goal/current",
    "GET /api/recipes",
  ]);
  expect(browserApiCalls[2].searchParams).toEqual({ userId: USER_ID });
  expect(browserApiCalls[3].searchParams).toEqual({
    limit: "10",
    offset: "0",
    userId: USER_ID,
  });

  const initialState = await readFixtureState(request);
  expect(initialState.providerCalls.parseGoal).toEqual([GOAL_TEXT]);
  expect(initialState.goal).toMatchObject({
    rawText: GOAL_TEXT,
    parsedFilter: EXPECTED_FILTER,
  });
  expect(initialState.goal.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(initialState.providerCalls.searchRecipes).toEqual([
    { filter: EXPECTED_FILTER, options: { limit: 10, offset: 0 } },
  ]);

  await expect.poll(() => recipePageResponses.length).toBe(1);
  const firstPage = await recipePageResponses[0];
  expect(firstPage.pagination).toEqual({
    limit: 10,
    offset: 0,
    count: 10,
    hasMore: true,
  });
  expect(firstPage.recipes).toHaveLength(10);
  expect(firstPage.recipes[0]).toMatchObject({
    id: "41001",
    title: fixtureTitle(1),
    macros: { protein_g: 31, carbs_g: 41, fat_g: 11 },
  });

  for (let sequence = 1; sequence <= 10; sequence += 1) {
    await expect(page.getByRole("status")).toContainText(
      `Match ${sequence}: ${fixtureTitle(sequence)}`,
    );
    await page.getByRole("button", { name: "Skip recipe" }).click();
    await expect(page.getByRole("status")).toContainText(
      `Match ${sequence + 1}: ${fixtureTitle(sequence + 1)}`,
    );
  }

  await expect.poll(async () => (await readFixtureState(request)).swipes.length).toBe(10);
  const afterSkips = await readFixtureState(request);
  expect(afterSkips.swipes.map(({ recipeId, direction }) => ({ recipeId, direction }))).toEqual(
    Array.from({ length: 10 }, (_unused, index) => ({
      recipeId: String(41001 + index),
      direction: "left",
    })),
  );
  expect(afterSkips.providerCalls.searchRecipes).toEqual([
    { filter: EXPECTED_FILTER, options: { limit: 10, offset: 0 } },
    { filter: EXPECTED_FILTER, options: { limit: 10, offset: 10 } },
  ]);

  await expect.poll(() => recipePageResponses.length).toBe(2);
  const secondPage = await recipePageResponses[1];
  expect(secondPage.pagination).toEqual({
    limit: 10,
    offset: 10,
    count: 2,
    hasMore: false,
  });
  expect(secondPage.recipes.map(({ id }) => id)).toEqual(["41011", "41012"]);

  await expect(page.getByText("Prep fixture match 11.")).toBeVisible();
  await page.getByRole("button", { name: "Like recipe" }).click();
  await expect(page).toHaveURL(/\/deck$/);
  await expect(page.getByRole("status")).toContainText(`Match 12: ${fixtureTitle(12)}`);
  await expect(page.getByLabel("Nutrition per serving")).toBeVisible();

  await expect.poll(async () => (await readFixtureState(request)).swipes.length).toBe(11);
  let acceptedState = await readFixtureState(request);
  expect(acceptedState.swipes.at(-1)).toMatchObject({
    userId: USER_ID,
    recipeId: "41011",
    direction: "right",
  });
  expect(acceptedState.providerCalls.getRecipeById).toEqual([]);

  await page.goto("/recipe/41011");
  await expect(page.getByRole("heading", { name: fixtureTitle(11), level: 1 })).toBeVisible();
  await expect(page.getByText("Serve fixture match 11.")).toBeVisible();
  await expect.poll(async () => {
    const state = await readFixtureState(request);
    return state.providerCalls.getRecipeById;
  }).toEqual(["41011"]);

  await page.getByRole("link", { name: "Keep swiping" }).click();
  await expect(page).toHaveURL(/\/deck$/);
  await expect(page.getByRole("status")).toContainText(`Match 12: ${fixtureTitle(12)}`);

  acceptedState = await readFixtureState(request);
  expect(acceptedState.providerCalls.searchRecipes).toHaveLength(2);
  expect(
    browserApiCalls.some(
      ({ method, pathname }) => method === "GET" && pathname === "/api/recipes/41011",
    ),
  ).toBe(true);
});

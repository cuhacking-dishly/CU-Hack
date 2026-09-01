import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  addRecipeToCollection,
  API_TIMEOUT_MS,
  createCollection,
  deleteAccount,
  exportAccountData,
  getAuthConfig,
  getCollections,
  getCurrentGoal,
  getApiErrorMessage,
  getRecipeById,
  getRecipes,
  getSavedRecipes,
  getMe,
  importCloudRecipes,
  logSwipe,
  parseGoal,
  removeCloudRecipe,
  saveCloudRecipe,
  saveGoal,
  updateCloudRecipe,
} from "./client.js";
import { server } from "../test/server.js";

const API_URL = "http://localhost:3000/api";
const requestConfig = {
  headers: { "X-Request-Id": "frontend-test" },
};
const recipe = {
  id: "12345",
  title: "Test bowl",
  image: "https://images.example/test-bowl.jpg",
  readyInMinutes: 25,
  servings: 2,
  calories: 480,
  macros: { protein_g: 38, carbs_g: 42, fat_g: 14 },
  diets: ["vegan"],
  sourceUrl: "https://recipes.example/test-bowl",
};

describe("API client", () => {
  it("allows the backend's provider deadline to complete before timing out", () => {
    expect(API_TIMEOUT_MS).toBe(100_000);
  });

  it.each([
    [{ response: { data: { error: "  Provider   timed out  " } } }, "Fallback", "Provider timed out"],
    [{ response: { data: { error: "" } } }, "Fallback", "Fallback"],
    [{ response: { data: { error: 42 } } }, "Fallback", "Fallback"],
    [{ response: { data: { error: "x".repeat(201) } } }, "Fallback", "Fallback"],
    [new Error("network failed"), "Fallback", "Fallback"],
  ])("normalizes bounded API errors and otherwise returns the fallback", (error, fallback, expected) => {
    expect(getApiErrorMessage(error, fallback)).toBe(expected);
  });

  it("posts goal text to the parser and forwards request config", async () => {
    let requestDetails;

    server.use(
      http.post(`${API_URL}/parse-goal`, async ({ request }) => {
        const url = new URL(request.url);
        requestDetails = {
          body: await request.json(),
          header: request.headers.get("x-request-id"),
          origin: url.origin,
          pathname: url.pathname,
        };

        return HttpResponse.json({
          parsedFilter: { diet: "vegan", maxReadyTime: 30, minProtein_g: 30 },
        });
      }),
    );

    await expect(
      parseGoal("vegan and quick", requestConfig),
    ).resolves.toEqual({
      parsedFilter: { diet: "vegan", maxReadyTime: 30, minProtein_g: 30 },
    });
    expect(requestDetails).toEqual({
      body: { text: "vegan and quick" },
      header: "frontend-test",
      origin: "http://localhost:3000",
      pathname: "/api/parse-goal",
    });
  });

  it("posts the complete saved-goal body and returns response data", async () => {
    let requestDetails;
    const parsedFilter = {
      diet: "vegan",
      excludeIngredients: ["peanuts"],
      maxReadyTime: 20,
    };

    server.use(
      http.post(`${API_URL}/goal`, async ({ request }) => {
        requestDetails = {
          body: await request.json(),
          header: request.headers.get("x-request-id"),
        };

        return HttpResponse.json({ success: true });
      }),
    );

    await expect(
      saveGoal(
        "demo-user-1",
        "vegan, no peanuts, under 20 minutes",
        parsedFilter,
        requestConfig,
      ),
    ).resolves.toEqual({ success: true });
    expect(requestDetails).toEqual({
      body: {
        userId: "demo-user-1",
        rawText: "vegan, no peanuts, under 20 minutes",
        parsedFilter,
      },
      header: "frontend-test",
    });
  });

  it("gets the current goal with encoded, merged query parameters", async () => {
    let requestDetails;

    server.use(
      http.get(`${API_URL}/goal/current`, ({ request }) => {
        const url = new URL(request.url);
        requestDetails = {
          header: request.headers.get("x-request-id"),
          userId: url.searchParams.get("userId"),
        };

        return HttpResponse.json({
          rawText: "high protein",
          parsedFilter: { minProtein_g: 30 },
          updatedAt: "2026-07-11T16:00:00.000Z",
        });
      }),
    );

    await expect(
      getCurrentGoal("demo user/1", {
        ...requestConfig,
        params: { userId: "stale-user" },
      }),
    ).resolves.toEqual({
      rawText: "high protein",
      parsedFilter: { minProtein_g: 30 },
      updatedAt: "2026-07-11T16:00:00.000Z",
    });
    expect(requestDetails).toEqual({
      header: "frontend-test",
      userId: "demo user/1",
    });
  });

  it("gets recipes with the user id while preserving caller query config", async () => {
    let requestDetails;
    const response = {
      recipes: [recipe],
      pagination: { limit: 10, offset: 20, count: 1, hasMore: true },
    };

    server.use(
      http.get(`${API_URL}/recipes`, ({ request }) => {
        const url = new URL(request.url);
        requestDetails = {
          header: request.headers.get("x-request-id"),
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset"),
          userId: url.searchParams.get("userId"),
        };

        return HttpResponse.json(response);
      }),
    );

    await expect(
      getRecipes("demo-user-1", {
        ...requestConfig,
        params: { limit: 10, offset: 20 },
      }),
    ).resolves.toEqual(response);
    expect(requestDetails).toEqual({
      header: "frontend-test",
      limit: "10",
      offset: "20",
      userId: "demo-user-1",
    });
  });

  it("encodes a recipe id and forwards config to the detail request", async () => {
    let requestDetails;
    const arbitraryRecipe = { ...recipe, id: "meal/42 ?" };

    server.use(
      http.get(`${API_URL}/recipes/*`, ({ request }) => {
        const url = new URL(request.url);
        requestDetails = {
          header: request.headers.get("x-request-id"),
          pathname: url.pathname,
          source: url.searchParams.get("source"),
        };

        return HttpResponse.json(arbitraryRecipe);
      }),
    );

    await expect(
      getRecipeById("meal/42 ?", {
        ...requestConfig,
        params: { source: "deck" },
      }),
    ).resolves.toEqual(arbitraryRecipe);
    expect(requestDetails).toEqual({
      header: "frontend-test",
      pathname: "/api/recipes/meal%2F42%20%3F",
      source: "deck",
    });
  });

  it("posts all swipe fields and forwards request config", async () => {
    let requestDetails;

    server.use(
      http.post(`${API_URL}/swipe`, async ({ request }) => {
        requestDetails = {
          body: await request.json(),
          header: request.headers.get("x-request-id"),
        };

        return HttpResponse.json({ success: true });
      }),
    );

    await expect(
      logSwipe("demo-user-1", "9002", "right", requestConfig),
    ).resolves.toEqual({ success: true });
    expect(requestDetails).toEqual({
      body: {
        userId: "demo-user-1",
        recipeId: "9002",
        direction: "right",
      },
      header: "frontend-test",
    });
  });

  it("implements authenticated recipe, collection, export, and account requests", async () => {
    const calls = [];
    server.use(
      http.get(`${API_URL}/auth/config`, () => HttpResponse.json({ enabled: true })),
      http.get(`${API_URL}/me`, ({ request }) => { calls.push(["me", request.headers.get("authorization")]); return HttpResponse.json({ id: "u1" }); }),
      http.get(`${API_URL}/saved-recipes`, ({ request }) => { calls.push(["list", request.headers.get("authorization")]); return HttpResponse.json({ recipes: [recipe] }); }),
      http.put(`${API_URL}/saved-recipes/:id`, async ({ request, params }) => { calls.push(["save", params.id, await request.json()]); return HttpResponse.json(recipe); }),
      http.post(`${API_URL}/saved-recipes/import`, async ({ request }) => { calls.push(["import", await request.json()]); return HttpResponse.json({ imported: 1 }); }),
      http.patch(`${API_URL}/saved-recipes/:id`, async ({ request }) => { calls.push(["update", await request.json()]); return HttpResponse.json({ ...recipe, notes: "great" }); }),
      http.delete(`${API_URL}/saved-recipes/:id`, ({ params }) => { calls.push(["remove", params.id]); return new HttpResponse(null, { status: 204 }); }),
      http.get(`${API_URL}/collections`, () => HttpResponse.json({ collections: [] })),
      http.post(`${API_URL}/collections`, async ({ request }) => HttpResponse.json({ id: "c1", ...(await request.json()) }, { status: 201 })),
      http.put(`${API_URL}/collections/:collectionId/recipes/:recipeId`, ({ params }) => { calls.push(["collect", params.collectionId, params.recipeId]); return new HttpResponse(null, { status: 204 }); }),
      http.get(`${API_URL}/account/export`, ({ request }) => { calls.push(["export", request.headers.get("authorization")]); return new HttpResponse("{}", { headers: { "Content-Type": "application/json" } }); }),
      http.delete(`${API_URL}/account`, async ({ request }) => { calls.push(["delete-account", await request.json()]); return new HttpResponse(null, { status: 204 }); }),
    );

    await expect(getAuthConfig()).resolves.toEqual({ enabled: true });
    await expect(getMe("token")).resolves.toEqual({ id: "u1" });
    await expect(getSavedRecipes("token")).resolves.toEqual({ recipes: [recipe] });
    await expect(saveCloudRecipe("token", recipe)).resolves.toEqual(recipe);
    await expect(importCloudRecipes("token", [recipe])).resolves.toEqual({ imported: 1 });
    await expect(updateCloudRecipe("token", recipe.id, { notes: "great" })).resolves.toMatchObject({ notes: "great" });
    await removeCloudRecipe("token", recipe.id);
    await expect(getCollections("token")).resolves.toEqual({ collections: [] });
    await expect(createCollection("token", { name: "Dinner" })).resolves.toMatchObject({ id: "c1", name: "Dinner" });
    await addRecipeToCollection("token", "c1", recipe.id);
    await expect(exportAccountData("token")).resolves.toBeInstanceOf(Blob);
    await deleteAccount("token");

    expect(calls).toContainEqual(["me", "Bearer token"]);
    expect(calls).toContainEqual(["save", recipe.id, { recipe }]);
    expect(calls).toContainEqual(["import", { recipes: [recipe] }]);
    expect(calls).toContainEqual(["update", { notes: "great" }]);
    expect(calls).toContainEqual(["collect", "c1", recipe.id]);
    expect(calls).toContainEqual(["delete-account", { confirmation: "DELETE" }]);
  });

  it("fails client-side before protected requests when no access token is supplied", async () => {
    await expect(getMe(" ")).rejects.toThrow("An access token is required");
    await expect(getMe(null)).rejects.toThrow("An access token is required");
  });

  it.each([
    [
      "parseGoal",
      http.post(`${API_URL}/parse-goal`, () =>
        HttpResponse.json({ error: "parse failed" }, { status: 502 }),
      ),
      () => parseGoal("anything"),
      "parse failed",
      502,
    ],
    [
      "saveGoal",
      http.post(`${API_URL}/goal`, () =>
        HttpResponse.json({ error: "save failed" }, { status: 400 }),
      ),
      () => saveGoal("user", "anything", {}),
      "save failed",
      400,
    ],
    [
      "getCurrentGoal",
      http.get(`${API_URL}/goal/current`, () =>
        HttpResponse.json({ error: "goal failed" }, { status: 400 }),
      ),
      () => getCurrentGoal("user"),
      "goal failed",
      400,
    ],
    [
      "getRecipes",
      http.get(`${API_URL}/recipes`, () =>
        HttpResponse.json({ error: "recipes failed" }, { status: 502 }),
      ),
      () => getRecipes("user"),
      "recipes failed",
      502,
    ],
    [
      "getRecipeById",
      http.get(`${API_URL}/recipes/99999`, () =>
        HttpResponse.json({ error: "detail failed" }, { status: 404 }),
      ),
      () => getRecipeById("99999"),
      "detail failed",
      404,
    ],
    [
      "logSwipe",
      http.post(`${API_URL}/swipe`, () =>
        HttpResponse.json({ error: "swipe failed" }, { status: 400 }),
      ),
      () => logSwipe("user", "12345", "left"),
      "swipe failed",
      400,
    ],
  ])("propagates %s failures with the backend response intact", async (
    _name,
    handler,
    makeRequest,
    message,
    status,
  ) => {
    server.use(handler);

    await expect(makeRequest()).rejects.toMatchObject({
      response: {
        data: { error: message },
        status,
      },
    });
  });
});

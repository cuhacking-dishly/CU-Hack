import axios from "axios";

const DEFAULT_API_BASE_URL = "http://localhost:3000/api";
export const API_TIMEOUT_MS = 100_000;

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
const baseURL = (configuredBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, "");

const client = axios.create({
  baseURL,
  timeout: API_TIMEOUT_MS,
  headers: { Accept: "application/json" },
});

export function getApiErrorMessage(error, fallback) {
  const backendMessage = error?.response?.data?.error;

  if (typeof backendMessage !== "string") {
    return fallback;
  }

  const normalizedMessage = backendMessage.replace(/\s+/g, " ").trim();

  return normalizedMessage && normalizedMessage.length <= 200 ? normalizedMessage : fallback;
}

export async function parseGoal(text, config = {}) {
  const response = await client.post("/parse-goal", { text }, config);
  return response.data;
}

export async function saveGoal(userId, rawText, parsedFilter, config = {}) {
  const response = await client.post(
    "/goal",
    { userId, rawText, parsedFilter },
    config,
  );
  return response.data;
}

export async function getCurrentGoal(userId, config = {}) {
  const response = await client.get("/goal/current", {
    ...config,
    params: { ...config.params, userId },
  });
  return response.data;
}

export async function getRecipes(userId, config = {}) {
  const response = await client.get("/recipes", {
    ...config,
    params: { ...config.params, userId },
  });
  return response.data;
}

export async function getRecipeById(id, config = {}) {
  const response = await client.get(`/recipes/${encodeURIComponent(id)}`, config);
  return response.data;
}

export async function logSwipe(userId, recipeId, direction, config = {}) {
  const response = await client.post(
    "/swipe",
    { userId, recipeId, direction },
    config,
  );
  return response.data;
}

export async function getAuthConfig(config = {}) {
  const response = await client.get("/auth/config", config);
  return response.data;
}

export async function getMe(accessToken, config = {}) {
  const response = await client.get("/me", withAccessToken(accessToken, config));
  return response.data;
}

export async function getSavedRecipes(accessToken, config = {}) {
  const response = await client.get("/saved-recipes", withAccessToken(accessToken, config));
  return response.data;
}

export async function saveCloudRecipe(accessToken, recipe, config = {}) {
  const response = await client.put(
    `/saved-recipes/${encodeURIComponent(recipe.id)}`,
    { recipe },
    withAccessToken(accessToken, config),
  );
  return response.data;
}

export async function importCloudRecipes(accessToken, recipes, config = {}) {
  const response = await client.post(
    "/saved-recipes/import",
    { recipes },
    withAccessToken(accessToken, config),
  );
  return response.data;
}

export async function updateCloudRecipe(accessToken, recipeId, changes, config = {}) {
  const response = await client.patch(
    `/saved-recipes/${encodeURIComponent(recipeId)}`,
    changes,
    withAccessToken(accessToken, config),
  );
  return response.data;
}

export async function removeCloudRecipe(accessToken, recipeId, config = {}) {
  await client.delete(
    `/saved-recipes/${encodeURIComponent(recipeId)}`,
    withAccessToken(accessToken, config),
  );
}

export async function getCollections(accessToken, config = {}) {
  const response = await client.get("/collections", withAccessToken(accessToken, config));
  return response.data;
}

export async function createCollection(accessToken, collection, config = {}) {
  const response = await client.post(
    "/collections",
    collection,
    withAccessToken(accessToken, config),
  );
  return response.data;
}

export async function addRecipeToCollection(accessToken, collectionId, recipeId, config = {}) {
  await client.put(
    `/collections/${encodeURIComponent(collectionId)}/recipes/${encodeURIComponent(recipeId)}`,
    null,
    withAccessToken(accessToken, config),
  );
}

export async function exportAccountData(accessToken, config = {}) {
  const response = await client.get(
    "/account/export",
    withAccessToken(accessToken, { ...config, responseType: "blob" }),
  );
  return response.data;
}

export async function deleteAccount(accessToken, config = {}) {
  await client.delete("/account", withAccessToken(accessToken, {
    ...config,
    data: { confirmation: "DELETE" },
  }));
}

function withAccessToken(accessToken, config = {}) {
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error("An access token is required");
  }
  return {
    ...config,
    headers: {
      ...config.headers,
      Authorization: `Bearer ${accessToken.trim()}`,
    },
  };
}

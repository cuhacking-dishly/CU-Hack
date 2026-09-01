import axios from "axios";

const DEFAULT_API_BASE_URL = "http://localhost:3000/api";
export const API_TIMEOUT_MS = 35_000;

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

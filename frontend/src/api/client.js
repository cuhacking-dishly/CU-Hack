import axios from "axios";
import { EXACT_MATCH_MODE, isRecipeMatchMode } from "../utils/recipeMatch.js";

const DEFAULT_API_BASE_URL = import.meta.env.PROD ? "/api" : "http://localhost:3000/api";
export const API_TIMEOUT_MS = 35_000;
// A cold 4B model can take substantially longer on an ARM board. Only parsing
// receives this longer deadline; ordinary recipe/API requests stay at 35s.
export const GOAL_PARSE_TIMEOUT_MS = 190_000;

export function resolveApiBaseUrl({
  configuredBaseUrl,
  configuredOrigin,
  defaultBaseUrl = DEFAULT_API_BASE_URL,
} = {}) {
  const normalizedBaseUrl = configuredBaseUrl?.trim();
  const normalizedOrigin = configuredOrigin?.trim();
  const originBaseUrl = normalizedOrigin
    ? `${normalizedOrigin.replace(/\/+$/, "")}/api`
    : "";
  return (normalizedBaseUrl || originBaseUrl || defaultBaseUrl).replace(/\/+$/, "");
}

const baseURL = resolveApiBaseUrl({
  configuredBaseUrl: import.meta.env.VITE_API_BASE_URL,
  configuredOrigin: import.meta.env.VITE_API_ORIGIN,
});

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
  const response = await client.post("/parse-goal", { text }, {
    timeout: GOAL_PARSE_TIMEOUT_MS,
    ...config,
  });
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
  const { matchMode = EXACT_MATCH_MODE, ...requestConfig } = config;
  if (!isRecipeMatchMode(matchMode)) {
    throw new TypeError("matchMode must be exact or closest");
  }

  const response = await client.get("/recipes", {
    ...requestConfig,
    params: { ...requestConfig.params, userId, matchMode },
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

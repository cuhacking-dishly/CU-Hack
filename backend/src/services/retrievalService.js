const { normalizeGoalFilter } = require("./goalFilter");

const DEFAULT_RETRIEVAL_TIMEOUT_MS = 8000;
// A cold language model on Raspberry Pi can take much longer than a vector
// lookup. Keep a separate bounded timeout so recipe calls remain responsive.
const DEFAULT_GOAL_PARSER_TIMEOUT_MS = 180000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120000;
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 20;
const MAX_SEARCH_OFFSET = 900;
const MAX_EXCLUDED_RECIPE_IDS = 1000;
const MAX_ERROR_BODY_LENGTH = 1000;
const MAX_SUCCESS_BODY_LENGTH = 5_000_000;
const MATCH_MODES = new Set(["exact", "closest"]);

class RetrievalServiceError extends Error {
  constructor({ code, statusCode, publicMessage, retryable = false, cause }) {
    super(publicMessage, cause === undefined ? undefined : { cause });
    this.name = "RetrievalServiceError";
    this.code = code;
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
    this.retryable = retryable;
  }
}

function readBoundedInteger(name, fallback, min, max) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") return fallback;

  const value = Number(rawValue);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function getRetrievalConfig() {
  const configuredUrl = String(process.env.RETRIEVAL_SERVICE_URL || "").trim();
  const configuredHostport = String(process.env.RETRIEVAL_SERVICE_HOSTPORT || "").trim();
  const rawUrl = configuredUrl || (configuredHostport ? `http://${configuredHostport}` : "");
  const serviceToken = String(process.env.RETRIEVAL_SERVICE_TOKEN || "").trim();
  if (!rawUrl) {
    throw new RetrievalServiceError({
      code: "RETRIEVAL_NOT_CONFIGURED",
      statusCode: 503,
      publicMessage: "Recipe retrieval service is not configured",
    });
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch (cause) {
    throw new RetrievalServiceError({
      code: "RETRIEVAL_NOT_CONFIGURED",
      statusCode: 503,
      publicMessage: "Recipe retrieval service is not configured",
      cause,
    });
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RetrievalServiceError({
      code: "RETRIEVAL_NOT_CONFIGURED",
      statusCode: 503,
      publicMessage: "Recipe retrieval service is not configured",
      cause: new Error("RETRIEVAL_SERVICE_URL must be an HTTP(S) URL without credentials, query, or fragment"),
    });
  }

  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    timeoutMs: readBoundedInteger(
      "RETRIEVAL_TIMEOUT_MS",
      DEFAULT_RETRIEVAL_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    ),
    parserTimeoutMs: readBoundedInteger(
      "GOAL_PARSER_TIMEOUT_MS",
      DEFAULT_GOAL_PARSER_TIMEOUT_MS,
      1000,
      600000
    ),
    serviceToken,
  };
}

function isTimeoutError(error, signal, depth = 0) {
  if (signal?.aborted) return true;
  if (!error || depth > 3) return false;
  if (["AbortError", "TimeoutError"].includes(error.name)) return true;
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(error.code)) {
    return true;
  }
  if (/timed?\s*out|timeout/i.test(String(error.message || ""))) return true;
  return isTimeoutError(error.cause, signal, depth + 1);
}

function compactProviderBody(body) {
  return String(body || "").replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_BODY_LENGTH);
}

function invalidResponseError(label, cause) {
  return new RetrievalServiceError({
    code: "RETRIEVAL_INVALID_RESPONSE",
    statusCode: 502,
    publicMessage: "Recipe retrieval service returned an invalid response",
    retryable: true,
    cause: cause || new Error(`${label} returned an invalid response`),
  });
}

function timeoutError(cause) {
  return new RetrievalServiceError({
    code: "RETRIEVAL_TIMEOUT",
    statusCode: 504,
    publicMessage: "Recipe retrieval service timed out",
    retryable: true,
    cause,
  });
}

function httpFailureError(label, response, body, { notFoundIs404 }) {
  const detail = compactProviderBody(body);
  const cause = new Error(
    `${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`
  );

  if (notFoundIs404 && response.status === 404) {
    return new RetrievalServiceError({
      code: "RECIPE_NOT_FOUND",
      statusCode: 404,
      publicMessage: "Recipe not found",
      cause,
    });
  }

  if (response.status === 503) {
    return new RetrievalServiceError({
      code: "RETRIEVAL_NOT_READY",
      statusCode: 503,
      publicMessage: "Recipe retrieval service is not ready",
      retryable: true,
      cause,
    });
  }

  if (response.status === 504) return timeoutError(cause);

  return new RetrievalServiceError({
    code: "RETRIEVAL_UPSTREAM_ERROR",
    statusCode: 502,
    publicMessage: "Recipe retrieval service is temporarily unavailable",
    retryable: response.status === 429 || response.status >= 500,
    cause,
  });
}

async function fetchJsonOrThrow(
  path,
  { method = "GET", body, label, notFoundIs404 = false, timeoutMsOverride } = {}
) {
  const { baseUrl, serviceToken, timeoutMs } = getRetrievalConfig();
  const signal = AbortSignal.timeout(timeoutMsOverride ?? timeoutMs);
  const headers = { Accept: "application/json" };
  if (serviceToken) headers.Authorization = `Bearer ${serviceToken}`;
  const options = { method, headers, signal };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, options);
  } catch (cause) {
    if (isTimeoutError(cause, signal)) throw timeoutError(cause);
    throw new RetrievalServiceError({
      code: "RETRIEVAL_UPSTREAM_ERROR",
      statusCode: 502,
      publicMessage: "Recipe retrieval service is temporarily unavailable",
      retryable: true,
      cause,
    });
  }

  if (!response || typeof response.ok !== "boolean" || !Number.isInteger(response.status)) {
    throw invalidResponseError(label || "Recipe retrieval request");
  }

  let rawBody;
  try {
    rawBody = await response.text();
  } catch (cause) {
    if (isTimeoutError(cause, signal)) throw timeoutError(cause);
    throw invalidResponseError(label || "Recipe retrieval request", cause);
  }

  if (!response.ok) {
    throw httpFailureError(label || "Recipe retrieval request", response, rawBody, {
      notFoundIs404,
    });
  }

  if (!rawBody || rawBody.length > MAX_SUCCESS_BODY_LENGTH) {
    throw invalidResponseError(label || "Recipe retrieval request");
  }

  try {
    return JSON.parse(rawBody);
  } catch (cause) {
    throw invalidResponseError(label || "Recipe retrieval request", cause);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRecipeId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[1-9]\d*$/.test(id)) return null;
  const numericId = Number(id);
  return Number.isSafeInteger(numericId) && String(numericId) === id ? id : null;
}

function normalizeOptionalNonNegativeInteger(value) {
  return value === null || (Number.isInteger(value) && value >= 0) ? value : undefined;
}

// Publisher nutrition and yield values can legitimately contain decimals.
// Preserve that source precision; only time and identifiers require integers.
function normalizeOptionalNonNegativeNumber(value) {
  return value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
    ? value
    : undefined;
}

function normalizeHttpUrl(value) {
  if (value === "") return "";
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch (_error) {
    return null;
  }
}

function normalizeStringList(value, { maxItems, maxItemLength }) {
  if (!Array.isArray(value) || value.length > maxItems) return null;

  const normalized = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") return null;
    const text = candidate.trim();
    if (!text || text.length > maxItemLength) return null;
    normalized.push(text);
  }
  return normalized;
}

function normalizeRecipe(item, { defaultMatchMode } = {}) {
  if (!isPlainObject(item)) return null;

  const id = normalizeRecipeId(item.id);
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const image = normalizeHttpUrl(item.image);
  const sourceUrl = normalizeHttpUrl(item.sourceUrl);
  const readyInMinutes = normalizeOptionalNonNegativeInteger(item.readyInMinutes);
  const servings = normalizeOptionalNonNegativeNumber(item.servings);
  const calories = normalizeOptionalNonNegativeNumber(item.calories);
  const sourceName = typeof item.sourceName === "string" ? item.sourceName.trim() : null;
  const diets = normalizeStringList(item.diets, { maxItems: 30, maxItemLength: 80 });
  const ingredients = normalizeStringList(item.ingredients, { maxItems: 100, maxItemLength: 500 });
  const instructions = normalizeStringList(item.instructions, { maxItems: 100, maxItemLength: 1000 });

  if (
    !id ||
    !title ||
    title.length > 500 ||
    image === null ||
    sourceUrl === null ||
    readyInMinutes === undefined ||
    servings === undefined ||
    calories === undefined ||
    sourceName === null ||
    sourceName.length > 300 ||
    diets === null ||
    ingredients === null ||
    instructions === null ||
    !isPlainObject(item.macros)
  ) {
    return null;
  }

  const protein = normalizeOptionalNonNegativeNumber(item.macros.protein_g);
  const carbs = normalizeOptionalNonNegativeNumber(item.macros.carbs_g);
  const fat = normalizeOptionalNonNegativeNumber(item.macros.fat_g);
  if (protein === undefined || carbs === undefined || fat === undefined) return null;

  const recipe = {
    id,
    title,
    image,
    readyInMinutes,
    servings,
    calories,
    macros: { protein_g: protein, carbs_g: carbs, fat_g: fat },
    diets,
    ingredients,
    instructions,
    sourceName,
    sourceUrl,
  };

  const hasMatchMetadata = ["matchScore", "matchReasons", "matchMode"].some((field) =>
    Object.prototype.hasOwnProperty.call(item, field)
  );
  if (!hasMatchMetadata) return recipe;

  const mode = item.matchMode === undefined ? defaultMatchMode : item.matchMode;
  const score = item.matchScore === undefined || item.matchScore === null ? null : item.matchScore;
  const reasons = item.matchReasons === undefined
    ? []
    : normalizeStringList(item.matchReasons, { maxItems: 20, maxItemLength: 300 });
  if (
    !MATCH_MODES.has(mode) ||
    (defaultMatchMode !== undefined && mode !== defaultMatchMode) ||
    (score !== null && (typeof score !== "number" || !Number.isFinite(score))) ||
    reasons === null
  ) {
    return null;
  }

  recipe.match = { mode, score, reasons };
  return recipe;
}

function normalizeSearchOptions(options = {}) {
  if (!isPlainObject(options)) {
    throw new RetrievalServiceError({
      code: "INVALID_SEARCH_OPTIONS",
      statusCode: 400,
      publicMessage: "Invalid recipe search options",
    });
  }

  const limit = options.limit === undefined ? 10 : options.limit;
  const offset = options.offset === undefined ? 0 : options.offset;
  const matchMode = options.matchMode === undefined ? "exact" : options.matchMode;
  if (
    !Number.isInteger(limit) ||
    limit < MIN_SEARCH_LIMIT ||
    limit > MAX_SEARCH_LIMIT ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > MAX_SEARCH_OFFSET ||
    !MATCH_MODES.has(matchMode)
  ) {
    throw new RetrievalServiceError({
      code: "INVALID_SEARCH_OPTIONS",
      statusCode: 400,
      publicMessage: "Invalid recipe search options",
    });
  }

  const rawExcludedIds = options.excludedRecipeIds === undefined
    ? []
    : options.excludedRecipeIds instanceof Set
      ? [...options.excludedRecipeIds]
      : options.excludedRecipeIds;
  if (!Array.isArray(rawExcludedIds) || rawExcludedIds.length > MAX_EXCLUDED_RECIPE_IDS) {
    throw new RetrievalServiceError({
      code: "INVALID_SEARCH_OPTIONS",
      statusCode: 400,
      publicMessage: "Invalid recipe search options",
    });
  }

  const excludedRecipeIds = [];
  const seenIds = new Set();
  for (const value of rawExcludedIds) {
    const id = normalizeRecipeId(value);
    if (!id) {
      throw new RetrievalServiceError({
        code: "INVALID_SEARCH_OPTIONS",
        statusCode: 400,
        publicMessage: "Invalid recipe search options",
      });
    }
    if (!seenIds.has(id)) {
      seenIds.add(id);
      excludedRecipeIds.push(id);
    }
  }

  return { limit, offset, matchMode, excludedRecipeIds };
}

function normalizeGoal(goal) {
  if (goal === null || goal === undefined) return { rawText: "", parsedFilter: {} };
  if (!isPlainObject(goal)) {
    throw new RetrievalServiceError({
      code: "INVALID_SEARCH_GOAL",
      statusCode: 400,
      publicMessage: "Invalid recipe search goal",
    });
  }

  const rawText = goal.rawText === undefined ? "" : goal.rawText;
  if (typeof rawText !== "string" || rawText.length > 1000) {
    throw new RetrievalServiceError({
      code: "INVALID_SEARCH_GOAL",
      statusCode: 400,
      publicMessage: "Invalid recipe search goal",
    });
  }

  try {
    return {
      rawText: rawText.trim(),
      parsedFilter: normalizeGoalFilter(
        goal.parsedFilter === undefined ? {} : goal.parsedFilter,
        { strict: true }
      ),
    };
  } catch (cause) {
    throw new RetrievalServiceError({
      code: "INVALID_SEARCH_GOAL",
      statusCode: 400,
      publicMessage: "Invalid recipe search goal",
      cause,
    });
  }
}

async function parseGoal(text) {
  const { parserTimeoutMs } = getRetrievalConfig();
  const data = await fetchJsonOrThrow("/v1/parse-goal", {
    method: "POST",
    body: { text },
    label: "Local Ollama goal parser",
    timeoutMsOverride: parserTimeoutMs,
  });
  if (
    !isPlainObject(data) ||
    !isPlainObject(data.parsedFilter) ||
    typeof data.parserProvider !== "string" ||
    !data.parserProvider.startsWith("ollama:")
  ) {
    throw invalidResponseError("Local Ollama goal parser");
  }
  try {
    return normalizeGoalFilter(data.parsedFilter, { strict: true });
  } catch (cause) {
    throw invalidResponseError("Local Ollama goal parser", cause);
  }
}

function buildSearchRequest(goal, options) {
  const normalizedGoal = normalizeGoal(goal);
  const normalizedOptions = normalizeSearchOptions(options);
  const filter = normalizedGoal.parsedFilter;

  return {
    request: {
      raw_query: normalizedGoal.rawText,
      query: filter.query ?? null,
      preferred_cuisines: filter.cuisines || [],
      preferred_meal_type: filter.mealType ?? null,
      diet: filter.diet ?? null,
      require_vegan: filter.diet === "vegan",
      excluded_allergens: filter.intolerances || [],
      excluded_ingredients: filter.excludeIngredients || [],
      min_calories: filter.minCalories ?? null,
      max_calories: filter.maxCalories ?? null,
      min_protein_g: filter.minProtein_g ?? null,
      max_protein_g: filter.maxProtein_g ?? null,
      min_carbs_g: filter.minCarbs_g ?? null,
      max_carbs_g: filter.maxCarbs_g ?? null,
      max_time_minutes: filter.maxReadyTime ?? null,
      excluded_recipe_ids: normalizedOptions.excludedRecipeIds,
      limit: normalizedOptions.limit,
      offset: normalizedOptions.offset,
      match_mode: normalizedOptions.matchMode,
    },
    options: normalizedOptions,
  };
}

function normalizeSearchResponse(data, options, request) {
  if (!isPlainObject(data)) throw invalidResponseError("Recipe retrieval search");

  const {
    recipes: rawRecipes,
    match_mode: matchMode,
    can_show_closest: canShowClosest,
    message,
    total_candidates: totalCandidates,
    semantic_provider: semanticProvider,
  } = data;
  if (
    !Array.isArray(rawRecipes) ||
    rawRecipes.length > options.limit ||
    !MATCH_MODES.has(matchMode) ||
    matchMode !== options.matchMode ||
    typeof canShowClosest !== "boolean" ||
    !(message === null || (typeof message === "string" && message.trim().length <= 500)) ||
    !Number.isInteger(totalCandidates) ||
    totalCandidates < 0 ||
    totalCandidates < rawRecipes.length ||
    typeof semanticProvider !== "string" ||
    !semanticProvider.trim() ||
    semanticProvider.trim().length > 200
  ) {
    throw invalidResponseError("Recipe retrieval search");
  }

  const recipes = [];
  const seenIds = new Set();
  for (const item of rawRecipes) {
    const recipe = normalizeRecipe(item, { defaultMatchMode: matchMode });
    if (!recipe || seenIds.has(recipe.id)) {
      throw invalidResponseError("Recipe retrieval search");
    }
    if (
      request.excluded_recipe_ids.includes(recipe.id) ||
      (request.require_vegan &&
        !recipe.diets.some((diet) => diet.toLowerCase() === "vegan"))
    ) {
      throw invalidResponseError("Recipe retrieval search");
    }
    seenIds.add(recipe.id);
    recipes.push(recipe);
  }

  const nextOffset = options.offset + options.limit;
  return {
    recipes,
    pagination: {
      limit: options.limit,
      offset: options.offset,
      count: recipes.length,
      hasMore: nextOffset <= MAX_SEARCH_OFFSET && nextOffset < totalCandidates,
    },
    match: {
      mode: matchMode,
      canShowClosest,
      message: message === null ? null : message.trim(),
      totalCandidates,
      semanticProvider: semanticProvider.trim(),
    },
  };
}

async function searchRecipePage(goal = null, options = {}) {
  const { request, options: normalizedOptions } = buildSearchRequest(goal, options);
  const data = await fetchJsonOrThrow("/v1/search", {
    method: "POST",
    body: request,
    label: "Recipe retrieval search",
  });
  return normalizeSearchResponse(data, normalizedOptions, request);
}

async function searchRecipes(goal = null, options = {}) {
  return (await searchRecipePage(goal, options)).recipes;
}

async function getRecipeById(id) {
  const recipeId = normalizeRecipeId(id);
  if (!recipeId) {
    throw new RetrievalServiceError({
      code: "INVALID_RECIPE_ID",
      statusCode: 400,
      publicMessage: "Recipe id must be a positive integer",
    });
  }

  const data = await fetchJsonOrThrow(`/v1/recipes/${encodeURIComponent(recipeId)}`, {
    label: "Recipe retrieval detail",
    notFoundIs404: true,
  });
  const recipe = normalizeRecipe(data);
  if (!recipe) throw invalidResponseError("Recipe retrieval detail");
  return recipe;
}

async function checkProbe(path, label) {
  try {
    const data = await fetchJsonOrThrow(path, { label });
    return isPlainObject(data) && data.ok === true;
  } catch (_error) {
    return false;
  }
}

function checkRetrievalHealth() {
  return checkProbe("/health", "Recipe retrieval health check");
}

function checkRetrievalReadiness() {
  return checkProbe("/ready", "Recipe retrieval readiness check");
}

module.exports = {
  DEFAULT_GOAL_PARSER_TIMEOUT_MS,
  DEFAULT_RETRIEVAL_TIMEOUT_MS,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_OFFSET,
  RetrievalServiceError,
  buildSearchRequest,
  checkRetrievalHealth,
  checkRetrievalReadiness,
  getRecipeById,
  normalizeRecipe,
  parseGoal,
  searchRecipePage,
  searchRecipes,
};

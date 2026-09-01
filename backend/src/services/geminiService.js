const { GoogleGenAI } = require("@google/genai");

const { FILTER_LIMITS, GOAL_FILTER_JSON_SCHEMA, normalizeGoalFilter } = require("./goalFilter");

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_GEMINI_FALLBACK_MODELS = ["gemini-3.6-flash"];
const DEFAULT_GEMINI_TIMEOUT_MS = 90000;
const PRODUCTION_GEMINI_TIMEOUT_MS = 90000;
const DEFAULT_GEMINI_RETRY_ATTEMPTS = 2;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120000;
const MIN_RETRY_ATTEMPTS = 1;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_GOAL_TEXT_LENGTH = 1000;
const MAX_FALLBACK_MODELS = 2;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const RETRYABLE_HTTP_STATUS_CODES = [408, 500, 502, 503, 504];
const FALLBACK_HTTP_STATUS_CODES = [404, 408, 429, 500, 502, 503, 504];

const SYSTEM_INSTRUCTION = [
  "Convert a food-related goal into a recipe search filter.",
  "First interpret the user's whole message semantically, including indirect or conversational phrasing, before classifying each constraint. Do not return that reasoning.",
  "Return only fields that the user clearly implies. An unconstrained goal must return an empty object.",
  "Use query for a specific dish, ingredient, flavor, or style the person is craving; do not repeat broad diet, cuisine, meal, allergy, time, or nutrition constraints in query unless an unsupported culture needs a natural-language query.",
  "maxReadyTime is measured in minutes. Calories, protein, and carbohydrates use per-serving values; protein and carbohydrate fields are measured in grams.",
  "Map diet intent to the closest value allowed by the response schema; omit diet when none fits.",
  "Map one or more requested food cultures to cuisines. Correct clear spelling variants, recognize indirect culture language such as 'take me to Tokyo' as Japanese, and map a more specific culture to its closest supported broad cuisine when clear. Preserve explicit alternatives: 'Chinese or Italian' must return both cuisines, not choose one.",
  "Map breakfast, brunch, and morning food to mealType breakfast; lunch, dinner, supper, hearty, or main meals to mealType main course; and sweets, after-dinner treats, or desserts to mealType dessert.",
  "Treat allergies as hard constraints. Add every matching supported intolerances value and explicit ingredient exclusions; for a non-standard allergy, exclude every clear recipe ingredient it requires avoiding. Never claim the results are medically safe or complete—users must still verify ingredient labels and cross-contact risk.",
  "Examples:",
  'Input: "cutting carbs, high protein, something quick"',
  'Output: {"maxCarbs_g": 50, "minProtein_g": 30, "maxReadyTime": 30}',
  'Input: "vegan, no peanuts, under 600 calories"',
  'Output: {"diet": "vegan", "excludeIngredients": ["peanuts"], "maxCalories": 600}',
  'Input: "just something tasty"',
  "Output: {}",
  'Input: "keto, dinner in under an hour"',
  'Output: {"diet": "ketogenic", "mealType": "main course", "maxReadyTime": 60}',
  'Input: "I want something cozy from Japan for dessert, but I am allergic to peanuts"',
  'Output: {"query": "cozy", "cuisines": ["japanese"], "mealType": "dessert", "intolerances": ["peanut"], "excludeIngredients": ["peanuts"]}',
  'Input: "Chinese or Italian, but I cannot eat strawberries"',
  'Output: {"cuisines": ["chinese", "italian"], "excludeIngredients": ["strawberries"]}',
].join("\n");

class GeminiServiceError extends Error {
  constructor({ code, statusCode, publicMessage, retryable = false, cause }) {
    super(publicMessage, cause === undefined ? undefined : { cause });
    this.name = "GeminiServiceError";
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

function readFallbackModels(primaryModel) {
  const rawValue = process.env.GEMINI_FALLBACK_MODELS;
  const candidates =
    rawValue === undefined ? DEFAULT_GEMINI_FALLBACK_MODELS : rawValue.split(",");

  return [
    ...new Set(
      candidates
        .map((candidate) => candidate.trim())
        .filter((candidate) => MODEL_ID_PATTERN.test(candidate) && candidate !== primaryModel)
    ),
  ].slice(0, MAX_FALLBACK_MODELS);
}

function getGeminiConfig() {
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    throw new GeminiServiceError({
      code: "GEMINI_NOT_CONFIGURED",
      statusCode: 503,
      publicMessage: "Goal parsing service is not configured",
    });
  }

  const configuredTimeoutMs = readBoundedInteger(
    "GEMINI_TIMEOUT_MS",
    DEFAULT_GEMINI_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );

  const model = String(process.env.GEMINI_MODEL || "").trim() || DEFAULT_GEMINI_MODEL;

  return {
    apiKey,
    models: [model, ...readFallbackModels(model)],
    retryAttempts: readBoundedInteger(
      "GEMINI_RETRY_ATTEMPTS",
      DEFAULT_GEMINI_RETRY_ATTEMPTS,
      MIN_RETRY_ATTEMPTS,
      MAX_RETRY_ATTEMPTS
    ),
    timeoutMs:
      process.env.NODE_ENV === "production"
        ? Math.max(configuredTimeoutMs, PRODUCTION_GEMINI_TIMEOUT_MS)
        : configuredTimeoutMs,
  };
}

function normalizeGoalText(rawText) {
  if (typeof rawText !== "string" || rawText.trim() === "") {
    throw new GeminiServiceError({
      code: "INVALID_GOAL_TEXT",
      statusCode: 400,
      publicMessage: "Goal text is required",
    });
  }

  const text = rawText.trim();
  if (text.length > MAX_GOAL_TEXT_LENGTH) {
    throw new GeminiServiceError({
      code: "INVALID_GOAL_TEXT",
      statusCode: 400,
      publicMessage: `Goal text must be ${MAX_GOAL_TEXT_LENGTH} characters or fewer`,
    });
  }

  return text;
}

function stripMarkdownFences(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function isTimeoutError(error, depth = 0) {
  if (!error || depth > 3) return false;
  if (["AbortError", "TimeoutError"].includes(error.name)) return true;
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(error.code)) {
    return true;
  }
  if ([408, 504].includes(error.status)) return true;
  if (/timed?\s*out|timeout/i.test(String(error.message || ""))) return true;
  return isTimeoutError(error.cause, depth + 1);
}

function getErrorStatus(error, depth = 0) {
  if (!error || depth > 3) return null;
  const status = Number(error.status ?? error.statusCode);
  if (Number.isInteger(status)) return status;
  return getErrorStatus(error.cause, depth + 1);
}

function shouldTryFallback(error) {
  if (error instanceof GeminiServiceError) return error.code === "GEMINI_INVALID_RESPONSE";
  const status = getErrorStatus(error);
  return status === null || FALLBACK_HTTP_STATUS_CODES.includes(status);
}

function boundedExplicitInteger(rawValue, field, direction) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return null;

  const integer = direction === "minimum" ? Math.ceil(value) : Math.floor(value);
  const { min, max } = FILTER_LIMITS[field];
  return integer >= min && integer <= max ? integer : null;
}

function firstCapturedNumber(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function addExplicitRange(constraints, text, { minimum, maximum, patterns }) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const lower = boundedExplicitInteger(match[1], minimum, "minimum");
    const upper = boundedExplicitInteger(match[2], maximum, "maximum");
    if (lower !== null && upper !== null && lower <= upper) {
      constraints[minimum] = lower;
      constraints[maximum] = upper;
    }
    return;
  }
}

function addExplicitBound(constraints, text, { field, direction, patterns }) {
  const rawValue = firstCapturedNumber(text, patterns);
  if (rawValue === null) return;

  const value = boundedExplicitInteger(rawValue, field, direction);
  if (value !== null) constraints[field] = value;
}

function extractExplicitNumericConstraints(text) {
  const constraints = {};

  addExplicitRange(constraints, text, {
    minimum: "minCalories",
    maximum: "maxCalories",
    patterns: [
      /\bbetween\s+(\d+(?:\.\d+)?)\s*(?:kcal|calories?|cals?)?\s+(?:and|to)\s+(\d+(?:\.\d+)?)\s*(?:kcal|calories?|cals?)\b/i,
      /\b(\d+(?:\.\d+)?)\s*(?:kcal|calories?|cals?)?\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:kcal|calories?|cals?)\b/i,
    ],
  });
  addExplicitBound(constraints, text, {
    field: "maxCalories",
    direction: "maximum",
    patterns: [
      /\b(?:under|below|less than|at most|no more than|up to|max(?:imum)?(?: of)?)\s+(\d+(?:\.\d+)?)\s*(?:kcal|calories?|cals?)\b/i,
      /\b(\d+(?:\.\d+)?)\s*(?:kcal|calories?|cals?)\s*(?:or less|maximum|max)\b/i,
    ],
  });
  addExplicitBound(constraints, text, {
    field: "minCalories",
    direction: "minimum",
    patterns: [
      /\b(?:at least|no less than|minimum(?: of)?|min(?:imum)?(?: of)?|(?<!no\s)more than|over)\s+(\d+(?:\.\d+)?)\s*(?:kcal|calories?|cals?)\b/i,
      /\b(\d+(?:\.\d+)?)\s*(?:kcal|calories?|cals?)\s*(?:or more|minimum|min)\b/i,
    ],
  });

  for (const nutrient of [
    { label: "protein", minimum: "minProtein_g", maximum: "maxProtein_g" },
    { label: "(?:carbs?|carbohydrates?)", minimum: "minCarbs_g", maximum: "maxCarbs_g" },
  ]) {
    const quantity = `(\\d+(?:\\.\\d+)?)\\s*(?:g|grams?)\\s*(?:of\\s+)?${nutrient.label}`;
    addExplicitBound(constraints, text, {
      field: nutrient.maximum,
      direction: "maximum",
      patterns: [
        new RegExp(
          `\\b(?:under|below|less than|at most|no more than|up to|max(?:imum)?(?: of)?)\\s+${quantity}\\b`,
          "i"
        ),
        new RegExp(`\\b${quantity}\\s*(?:or less|maximum|max)\\b`, "i"),
      ],
    });
    addExplicitBound(constraints, text, {
      field: nutrient.minimum,
      direction: "minimum",
      patterns: [
        new RegExp(
          `\\b(?:at least|no less than|minimum(?: of)?|min(?:imum)?(?: of)?|(?<!no\\s)more than|over)\\s+${quantity}\\b`,
          "i"
        ),
        new RegExp(`\\b${quantity}\\s*(?:or more|minimum|min)\\b`, "i"),
      ],
    });
  }

  const timeMatch = text.match(
    /\b(?:ready\s+)?(?:in\s+)?(?:under|within|in|less than|at most|no more than|up to|max(?:imum)?(?: of)?)\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b/i
  );
  if (timeMatch) {
    const amount = Number(timeMatch[1]);
    const minutes = /^(?:hours?|hrs?)$/i.test(timeMatch[2]) ? amount * 60 : amount;
    const value = boundedExplicitInteger(minutes, "maxReadyTime", "maximum");
    if (value !== null) constraints.maxReadyTime = value;
  } else if (
    /\b(?:ready\s+)?(?:in\s+)?(?:under|within|in|less than|at most|no more than|up to)\s+(?:an?|one)\s+hours?\b/i.test(
      text
    )
  ) {
    constraints.maxReadyTime = 60;
  }

  return constraints;
}

function applyExplicitNumericConstraints(filter, text) {
  const explicit = extractExplicitNumericConstraints(text);
  const merged = { ...filter, ...explicit };

  for (const [minimum, maximum] of [
    ["minCalories", "maxCalories"],
    ["minProtein_g", "maxProtein_g"],
    ["minCarbs_g", "maxCarbs_g"],
  ]) {
    if (merged[minimum] === undefined || merged[maximum] === undefined) continue;
    if (merged[minimum] <= merged[maximum]) continue;

    if (explicit[minimum] !== undefined && explicit[maximum] === undefined) delete merged[maximum];
    else if (explicit[maximum] !== undefined && explicit[minimum] === undefined) delete merged[minimum];
  }

  return normalizeGoalFilter(merged);
}

function normalizeGeminiResponse(response, text) {
  const responseText = stripMarkdownFences(response?.text);
  if (!responseText) {
    throw new GeminiServiceError({
      code: "GEMINI_INVALID_RESPONSE",
      statusCode: 502,
      publicMessage: "Goal parsing service returned an invalid response",
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (cause) {
    throw new GeminiServiceError({
      code: "GEMINI_INVALID_RESPONSE",
      statusCode: 502,
      publicMessage: "Goal parsing service returned an invalid response",
      cause,
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GeminiServiceError({
      code: "GEMINI_INVALID_RESPONSE",
      statusCode: 502,
      publicMessage: "Goal parsing service returned an invalid response",
    });
  }

  return applyExplicitNumericConstraints(normalizeGoalFilter(parsed), text);
}

async function parseGoal(rawText) {
  const text = normalizeGoalText(rawText);
  const { apiKey, models, retryAttempts, timeoutMs } = getGeminiConfig();
  const abortSignal = AbortSignal.timeout(timeoutMs);
  let lastError;

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: timeoutMs,
      retryOptions: {
        attempts: retryAttempts,
        initialDelay: 1,
        maxDelay: 8,
        expBase: 2,
        jitter: 1,
        httpStatusCodes: RETRYABLE_HTTP_STATUS_CODES,
      },
    },
  });

  for (let index = 0; index < models.length; index += 1) {
    try {
      const response = await ai.models.generateContent({
        model: models[index],
        contents: text,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseJsonSchema: GOAL_FILTER_JSON_SCHEMA,
          thinkingConfig: { thinkingLevel: "MINIMAL" },
          maxOutputTokens: 512,
          abortSignal,
        },
      });
      return normalizeGeminiResponse(response, text);
    } catch (error) {
      lastError = error;
      const hasFallback = index + 1 < models.length;
      if (abortSignal.aborted || !hasFallback || !shouldTryFallback(error)) break;
    }
  }

  if (lastError instanceof GeminiServiceError) throw lastError;
  if (abortSignal.aborted || isTimeoutError(lastError)) {
    throw new GeminiServiceError({
      code: "GEMINI_TIMEOUT",
      statusCode: 504,
      publicMessage: "Goal parsing service timed out",
      retryable: true,
      cause: lastError,
    });
  }

  throw new GeminiServiceError({
    code: "GEMINI_UPSTREAM_ERROR",
    statusCode: 502,
    publicMessage: "Goal parsing service is temporarily unavailable",
    retryable: true,
    cause: lastError,
  });
}

module.exports = {
  DEFAULT_GEMINI_FALLBACK_MODELS,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_RETRY_ATTEMPTS,
  DEFAULT_GEMINI_TIMEOUT_MS,
  PRODUCTION_GEMINI_TIMEOUT_MS,
  GeminiServiceError,
  parseGoal,
  parseGoalWithGemini: parseGoal,
};

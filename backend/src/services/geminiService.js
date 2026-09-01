const { GoogleGenAI } = require("@google/genai");

const { GOAL_FILTER_JSON_SCHEMA, normalizeGoalFilter } = require("./goalFilter");

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const DEFAULT_GEMINI_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120000;
const MAX_GOAL_TEXT_LENGTH = 1000;

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

function getGeminiConfig() {
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    throw new GeminiServiceError({
      code: "GEMINI_NOT_CONFIGURED",
      statusCode: 503,
      publicMessage: "Goal parsing service is not configured",
    });
  }

  return {
    apiKey,
    model: String(process.env.GEMINI_MODEL || "").trim() || DEFAULT_GEMINI_MODEL,
    timeoutMs: readBoundedInteger(
      "GEMINI_TIMEOUT_MS",
      DEFAULT_GEMINI_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    ),
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

async function parseGoal(rawText) {
  const text = normalizeGoalText(rawText);
  const { apiKey, model, timeoutMs } = getGeminiConfig();
  const abortSignal = AbortSignal.timeout(timeoutMs);

  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: timeoutMs } });
    const response = await ai.models.generateContent({
      model,
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

    return normalizeGoalFilter(parsed);
  } catch (error) {
    if (error instanceof GeminiServiceError) throw error;
    if (abortSignal.aborted || isTimeoutError(error)) {
      throw new GeminiServiceError({
        code: "GEMINI_TIMEOUT",
        statusCode: 504,
        publicMessage: "Goal parsing service timed out",
        retryable: true,
        cause: error,
      });
    }

    throw new GeminiServiceError({
      code: "GEMINI_UPSTREAM_ERROR",
      statusCode: 502,
      publicMessage: "Goal parsing service is temporarily unavailable",
      retryable: true,
      cause: error,
    });
  }
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TIMEOUT_MS,
  GeminiServiceError,
  parseGoal,
  parseGoalWithGemini: parseGoal,
};

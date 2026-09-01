const ALLOWED_DIETS = Object.freeze([
  "gluten free",
  "ketogenic",
  "vegetarian",
  "lacto-vegetarian",
  "ovo-vegetarian",
  "vegan",
  "pescetarian",
  "paleo",
  "primal",
  "low fodmap",
  "whole30",
]);

// Keep these values aligned with Spoonacular's documented complex-search
// vocabulary. We intentionally store the provider's canonical, lower-case
// values so a saved goal is stable regardless of how the UI or model phrases it.
const ALLOWED_CUISINES = Object.freeze([
  "african",
  "asian",
  "american",
  "british",
  "cajun",
  "caribbean",
  "chinese",
  "eastern european",
  "european",
  "french",
  "german",
  "greek",
  "indian",
  "irish",
  "italian",
  "japanese",
  "jewish",
  "korean",
  "latin american",
  "mediterranean",
  "mexican",
  "middle eastern",
  "nordic",
  "southern",
  "spanish",
  "thai",
  "vietnamese",
]);

const ALLOWED_MEAL_TYPES = Object.freeze(["breakfast", "main course", "dessert"]);

const ALLOWED_INTOLERANCES = Object.freeze([
  "dairy",
  "egg",
  "gluten",
  "grain",
  "peanut",
  "seafood",
  "sesame",
  "shellfish",
  "soy",
  "sulfite",
  "tree nut",
  "wheat",
]);

const GOAL_FILTER_FIELDS = Object.freeze([
  "query",
  "minCalories",
  "maxCalories",
  "minProtein_g",
  "maxProtein_g",
  "minCarbs_g",
  "maxCarbs_g",
  "diet",
  "cuisines",
  "mealType",
  "maxReadyTime",
  "intolerances",
  "excludeIngredients",
]);

const FILTER_LIMITS = Object.freeze({
  query: Object.freeze({ maxLength: 160 }),
  minCalories: Object.freeze({ min: 0, max: 10000 }),
  maxCalories: Object.freeze({ min: 1, max: 10000 }),
  minProtein_g: Object.freeze({ min: 0, max: 500 }),
  maxProtein_g: Object.freeze({ min: 0, max: 500 }),
  minCarbs_g: Object.freeze({ min: 0, max: 1000 }),
  maxCarbs_g: Object.freeze({ min: 0, max: 1000 }),
  maxReadyTime: Object.freeze({ min: 1, max: 1440 }),
  cuisines: Object.freeze({ maxItems: ALLOWED_CUISINES.length }),
  intolerances: Object.freeze({ maxItems: ALLOWED_INTOLERANCES.length }),
  excludeIngredients: Object.freeze({ maxItems: 20, maxItemLength: 80 }),
});

const GOAL_FILTER_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: FILTER_LIMITS.query.maxLength,
    },
    minCalories: {
      type: "integer",
      minimum: FILTER_LIMITS.minCalories.min,
      maximum: FILTER_LIMITS.minCalories.max,
    },
    maxCalories: {
      type: "integer",
      minimum: FILTER_LIMITS.maxCalories.min,
      maximum: FILTER_LIMITS.maxCalories.max,
    },
    minProtein_g: {
      type: "integer",
      minimum: FILTER_LIMITS.minProtein_g.min,
      maximum: FILTER_LIMITS.minProtein_g.max,
    },
    maxProtein_g: {
      type: "integer",
      minimum: FILTER_LIMITS.maxProtein_g.min,
      maximum: FILTER_LIMITS.maxProtein_g.max,
    },
    minCarbs_g: {
      type: "integer",
      minimum: FILTER_LIMITS.minCarbs_g.min,
      maximum: FILTER_LIMITS.minCarbs_g.max,
    },
    maxCarbs_g: {
      type: "integer",
      minimum: FILTER_LIMITS.maxCarbs_g.min,
      maximum: FILTER_LIMITS.maxCarbs_g.max,
    },
    diet: { type: "string", enum: [...ALLOWED_DIETS] },
    cuisines: {
      type: "array",
      minItems: 1,
      maxItems: FILTER_LIMITS.cuisines.maxItems,
      items: { type: "string", enum: [...ALLOWED_CUISINES] },
    },
    mealType: { type: "string", enum: [...ALLOWED_MEAL_TYPES] },
    maxReadyTime: {
      type: "integer",
      minimum: FILTER_LIMITS.maxReadyTime.min,
      maximum: FILTER_LIMITS.maxReadyTime.max,
    },
    intolerances: {
      type: "array",
      maxItems: FILTER_LIMITS.intolerances.maxItems,
      items: { type: "string", enum: [...ALLOWED_INTOLERANCES] },
    },
    excludeIngredients: {
      type: "array",
      maxItems: FILTER_LIMITS.excludeIngredients.maxItems,
      items: { type: "string" },
    },
  },
  propertyOrdering: [...GOAL_FILTER_FIELDS],
});

class GoalFilterValidationError extends Error {
  constructor(details) {
    super("Invalid goal filter");
    this.name = "GoalFilterValidationError";
    this.statusCode = 400;
    this.code = "INVALID_GOAL_FILTER";
    this.publicMessage = "Invalid goal filter";
    this.retryable = false;
    this.details = Array.isArray(details) ? details : [String(details)];
  }
}

function normalizeWhitespace(value) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeEnum(value, allowedValues) {
  if (typeof value !== "string") return null;

  const normalized = normalizeWhitespace(value).toLowerCase();
  return allowedValues.includes(normalized) ? normalized : null;
}

function normalizeEnumList(value, { field, allowedValues, maxItems, addError, strict }) {
  if (!Array.isArray(value)) {
    addError(`${field} must be an array of supported values`);
    return [];
  }

  if (value.length > maxItems) {
    addError(`${field} must contain no more than ${maxItems} items`);
  }

  const normalized = [];
  const seen = new Set();
  const candidates = value.slice(0, strict ? maxItems : maxItems * 5);
  for (const candidate of candidates) {
    if (normalized.length >= maxItems) break;

    const item = normalizeEnum(candidate, allowedValues);
    if (!item) {
      addError(`${field} entries must be supported values`);
      continue;
    }
    if (seen.has(item)) continue;

    seen.add(item);
    normalized.push(item);
  }

  return normalized;
}

function normalizeGoalFilter(value, { strict = false } = {}) {
  if (value === undefined) return {};

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (strict) throw new GoalFilterValidationError(["filter must be an object"]);
    return {};
  }

  const normalized = {};
  const errors = [];
  const allowedFields = new Set(GOAL_FILTER_FIELDS);
  const addError = (message) => {
    if (errors.length < 10) errors.push(message);
  };

  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) addError(`${field} is not a supported filter field`);
  }

  for (const field of [
    "minCalories",
    "maxCalories",
    "minProtein_g",
    "maxProtein_g",
    "minCarbs_g",
    "maxCarbs_g",
    "maxReadyTime",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;

    const candidate = value[field];
    const { min, max } = FILTER_LIMITS[field];
    if (
      typeof candidate !== "number" ||
      !Number.isFinite(candidate) ||
      !Number.isInteger(candidate) ||
      candidate < min ||
      candidate > max
    ) {
      addError(`${field} must be an integer between ${min} and ${max}`);
      continue;
    }

    normalized[field] = candidate;
  }

  if (Object.prototype.hasOwnProperty.call(value, "query")) {
    if (typeof value.query !== "string") {
      addError("query must be a nonblank string");
    } else {
      const query = normalizeWhitespace(value.query);
      if (!query || query.length > FILTER_LIMITS.query.maxLength) {
        addError(`query must be between 1 and ${FILTER_LIMITS.query.maxLength} characters`);
      } else {
        normalized.query = query;
      }
    }
  }

  for (const [minimum, maximum] of [
    ["minCalories", "maxCalories"],
    ["minProtein_g", "maxProtein_g"],
    ["minCarbs_g", "maxCarbs_g"],
  ]) {
    if (normalized[minimum] === undefined || normalized[maximum] === undefined) continue;
    if (normalized[minimum] <= normalized[maximum]) continue;

    addError(`${minimum} must not exceed ${maximum}`);
    delete normalized[minimum];
    delete normalized[maximum];
  }

  if (Object.prototype.hasOwnProperty.call(value, "diet")) {
    if (typeof value.diet !== "string") {
      addError("diet must be a supported string value");
    } else {
      const diet = normalizeWhitespace(value.diet).toLowerCase();
      if (!ALLOWED_DIETS.includes(diet)) {
        addError("diet must be a supported string value");
      } else {
        normalized.diet = diet;
      }
    }
  }

  for (const [field, allowedValues] of [["mealType", ALLOWED_MEAL_TYPES]]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;

    const normalizedValue = normalizeEnum(value[field], allowedValues);
    if (!normalizedValue) {
      addError(`${field} must be a supported string value`);
    } else {
      normalized[field] = normalizedValue;
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, "cuisines")) {
    if (!Array.isArray(value.cuisines) || value.cuisines.length === 0) {
      addError("cuisines must contain at least one supported value");
    }
    const cuisines = normalizeEnumList(value.cuisines, {
      field: "cuisines",
      allowedValues: ALLOWED_CUISINES,
      maxItems: FILTER_LIMITS.cuisines.maxItems,
      addError,
      strict,
    });
    if (cuisines.length > 0) normalized.cuisines = cuisines;
  }

  if (Object.prototype.hasOwnProperty.call(value, "intolerances")) {
    const intolerances = normalizeEnumList(value.intolerances, {
      field: "intolerances",
      allowedValues: ALLOWED_INTOLERANCES,
      maxItems: FILTER_LIMITS.intolerances.maxItems,
      addError,
      strict,
    });
    if (intolerances.length > 0) normalized.intolerances = intolerances;
  }

  if (Object.prototype.hasOwnProperty.call(value, "excludeIngredients")) {
    if (!Array.isArray(value.excludeIngredients)) {
      addError("excludeIngredients must be an array of ingredient names");
    } else {
      const { maxItems, maxItemLength } = FILTER_LIMITS.excludeIngredients;
      if (value.excludeIngredients.length > maxItems) {
        addError(`excludeIngredients must contain no more than ${maxItems} items`);
      }

      const ingredients = [];
      const seen = new Set();
      const candidates = value.excludeIngredients.slice(0, strict ? maxItems : maxItems * 5);
      for (const candidate of candidates) {
        if (ingredients.length >= maxItems) break;

        if (typeof candidate !== "string") {
          addError("excludeIngredients entries must be strings");
          continue;
        }

        const ingredient = normalizeWhitespace(candidate);
        if (!ingredient || ingredient.length > maxItemLength) {
          addError(
            `excludeIngredients entries must be between 1 and ${maxItemLength} characters`
          );
          continue;
        }

        const dedupeKey = ingredient.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        ingredients.push(ingredient);
      }

      if (ingredients.length > 0) normalized.excludeIngredients = ingredients;
    }
  }

  if (strict && errors.length > 0) throw new GoalFilterValidationError(errors);
  return normalized;
}

module.exports = {
  ALLOWED_CUISINES,
  ALLOWED_DIETS,
  ALLOWED_INTOLERANCES,
  ALLOWED_MEAL_TYPES,
  FILTER_LIMITS,
  GOAL_FILTER_FIELDS,
  GOAL_FILTER_JSON_SCHEMA,
  GoalFilterValidationError,
  normalizeGoalFilter,
};

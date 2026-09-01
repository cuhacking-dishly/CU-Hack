const { createHttpError } = require("../routes/routeUtils");

const TEXT_LIMITS = {
  title: 200,
  image: 2000,
  sourceName: 200,
  sourceUrl: 2000,
};

function sanitizeRecipeSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createHttpError(400, "recipe is required");
  }
  const id = boundedText(value.id, 32, "recipe.id");
  if (!/^[1-9]\d*$/.test(id)) throw createHttpError(400, "recipe.id must be a positive integer");

  return {
    id,
    title: boundedText(value.title, TEXT_LIMITS.title, "recipe.title"),
    image: optionalUrl(value.image),
    readyInMinutes: optionalNumber(value.readyInMinutes, 0, 10080),
    servings: optionalNumber(value.servings, 0, 1000),
    calories: optionalNumber(value.calories, 0, 100000),
    macros: sanitizeMacros(value.macros),
    diets: textList(value.diets, 20, 80),
    ingredients: textList(value.ingredients, 100, 500),
    instructions: textList(value.instructions, 100, 1000),
    sourceName: optionalText(value.sourceName, TEXT_LIMITS.sourceName),
    sourceUrl: optionalUrl(value.sourceUrl),
  };
}

function sanitizeRecipeList(value) {
  if (!Array.isArray(value) || value.length > 200) {
    throw createHttpError(400, "recipes must be an array with at most 200 items");
  }
  const seen = new Set();
  return value.map(sanitizeRecipeSnapshot).filter((recipe) => {
    if (seen.has(recipe.id)) return false;
    seen.add(recipe.id);
    return true;
  });
}

function sanitizeNotes(value) {
  if (value == null) return "";
  if (typeof value !== "string") throw createHttpError(400, "notes must be text");
  const notes = value.trim();
  if (notes.length > 2000) throw createHttpError(400, "notes must be at most 2000 characters");
  return notes;
}

function sanitizeRating(value) {
  if (value == null || value === "") return null;
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw createHttpError(400, "rating must be an integer from 1 to 5");
  }
  return rating;
}

function sanitizeCollection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createHttpError(400, "collection is required");
  }
  return {
    name: boundedText(value.name, 80, "name"),
    description: optionalText(value.description, 500),
  };
}

function boundedText(value, max, field) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw createHttpError(400, `${field} is required`);
  }
  const result = String(value).trim();
  if (!result) throw createHttpError(400, `${field} is required`);
  if (result.length > max) throw createHttpError(400, `${field} must be at most ${max} characters`);
  return result;
}

function optionalText(value, max) {
  if (value == null) return "";
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function optionalUrl(value) {
  const candidate = optionalText(value, 2000);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function optionalNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function sanitizeMacros(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    protein_g: optionalNumber(source.protein_g, 0, 10000),
    carbs_g: optionalNumber(source.carbs_g, 0, 10000),
    fat_g: optionalNumber(source.fat_g, 0, 10000),
  };
}

function textList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, maxItems)
    .map((item) => item.trim().slice(0, maxLength));
}

module.exports = {
  sanitizeCollection,
  sanitizeNotes,
  sanitizeRating,
  sanitizeRecipeList,
  sanitizeRecipeSnapshot,
};

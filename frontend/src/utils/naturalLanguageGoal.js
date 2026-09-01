export const MAX_AUXILIARY_FILTER_LENGTH = 240;
export const MAX_PARSED_GOAL_LENGTH = 1000;

export const MEAL_CATEGORY_OPTIONS = Object.freeze([
  Object.freeze({ value: "", label: "Any meal" }),
  Object.freeze({ value: "breakfast", label: "Breakfast" }),
  Object.freeze({ value: "main course", label: "Lunch & dinner" }),
  Object.freeze({ value: "dessert", label: "Dessert" }),
]);

function normalizeText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/** Returns whether one of the free-form filters needs LLM interpretation. */
export function hasNaturalLanguageFilterInput({ cultureText, allergyText } = {}) {
  return Boolean(normalizeText(cultureText) || normalizeText(allergyText));
}

/** Applies the one explicit meal category after the LLM interprets free-form text. */
export function applyMealType(parsedFilter, mealType) {
  const baseFilter =
    parsedFilter && typeof parsedFilter === "object" && !Array.isArray(parsedFilter)
      ? parsedFilter
      : {};
  const selectedMealType = MEAL_CATEGORY_OPTIONS.some((option) => option.value === mealType)
    ? mealType
    : "";

  if (!selectedMealType) return baseFilter;

  const filter = { ...baseFilter };
  if (selectedMealType) filter.mealType = selectedMealType;
  return filter;
}

/** Writes a complete, category-labelled natural-language request for Gemini. */
export function createNaturalLanguageGoalText({ goalText, cultureText, allergyText } = {}) {
  const craving = normalizeText(goalText);
  const culture = normalizeText(cultureText);
  const allergies = normalizeText(allergyText);
  const parts = [];

  if (craving) parts.push(craving);
  if (culture) parts.push(`Cuisine or culture preference: ${culture}.`);
  if (allergies) parts.push(`Allergies or ingredients to avoid: ${allergies}.`);

  const text = parts.join("\n");
  if (text.length > MAX_PARSED_GOAL_LENGTH) {
    return {
      error: `Your craving and filter details must fit within ${MAX_PARSED_GOAL_LENGTH} characters together.`,
      text: "",
    };
  }

  return { error: "", text };
}

/** Creates a readable saved-goal label when the user chooses only a meal category. */
export function createMealTypeGoalText(mealType) {
  const option = MEAL_CATEGORY_OPTIONS.find((candidate) => candidate.value === mealType);
  return option?.value ? `Recipes: ${option.label}` : "";
}

const TARGETS = Object.freeze({
  calories: Object.freeze({ min: 1, max: 10_000 }),
  protein: Object.freeze({ min: 0, max: 500 }),
  carbs: Object.freeze({ min: 0, max: 1_000 }),
});

const TARGET_TOLERANCE = 0.2;

function normalizeTarget(value, limits) {
  if (value === "" || value === undefined || value === null) return null;

  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue < limits.min || numericValue > limits.max) {
    return undefined;
  }

  return numericValue;
}

function targetRange(value, { min, max }) {
  const lowerBound = Math.max(min, Math.floor(value * (1 - TARGET_TOLERANCE)));
  const upperBound = Math.min(max, Math.ceil(value * (1 + TARGET_TOLERANCE)));
  return [lowerBound, upperBound];
}

export function hasNutritionTargetInput(targets) {
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) return false;

  return ["calories", "protein", "carbs"].some((key) => {
    const value = targets[key];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
}

/** Creates the persisted raw-goal label when a user uses filters without free text. */
export function createNutritionGoalText(targets) {
  const values = targets && typeof targets === "object" && !Array.isArray(targets) ? targets : {};
  const calories = normalizeTarget(values.calories, TARGETS.calories);
  const protein = normalizeTarget(values.protein, TARGETS.protein);
  const carbs = normalizeTarget(values.carbs, TARGETS.carbs);
  const parts = [];

  if (calories !== null && calories !== undefined) parts.push(`${calories} calories`);
  if (protein !== null && protein !== undefined) parts.push(`${protein}g protein`);
  if (carbs !== null && carbs !== undefined) parts.push(`${carbs}g carbs`);

  return parts.length > 0 ? `Recipes around ${parts.join(", ")} per serving` : "";
}

/**
 * Converts the optional landing-page nutrition targets into Spoonacular's
 * bounded range filters. A blank control intentionally leaves the parsed goal
 * untouched; a completed control asks for recipes within 20% of that target.
 */
export function applyNutritionTargets(parsedFilter, targets) {
  const baseFilter =
    parsedFilter && typeof parsedFilter === "object" && !Array.isArray(parsedFilter)
      ? parsedFilter
      : {};
  const values = targets && typeof targets === "object" && !Array.isArray(targets) ? targets : {};
  const calories = normalizeTarget(values.calories, TARGETS.calories);
  const protein = normalizeTarget(values.protein, TARGETS.protein);
  const carbs = normalizeTarget(values.carbs, TARGETS.carbs);

  if ([calories, protein, carbs].includes(undefined)) {
    return { filter: baseFilter, error: "Enter whole-number nutrition targets within the shown ranges." };
  }

  if (calories === null && protein === null && carbs === null) {
    return { filter: baseFilter, error: "" };
  }

  const filter = { ...baseFilter };

  if (calories !== null) {
    const [minCalories, maxCalories] = targetRange(calories, TARGETS.calories);
    filter.minCalories = minCalories;
    filter.maxCalories = maxCalories;
  }

  if (protein !== null) {
    const [minProtein_g, maxProtein_g] = targetRange(protein, TARGETS.protein);
    filter.minProtein_g = minProtein_g;
    filter.maxProtein_g = maxProtein_g;
  }

  if (carbs !== null) {
    const [minCarbs_g, maxCarbs_g] = targetRange(carbs, TARGETS.carbs);
    filter.minCarbs_g = minCarbs_g;
    filter.maxCarbs_g = maxCarbs_g;
  }

  return { filter, error: "" };
}

export { TARGETS, TARGET_TOLERANCE };

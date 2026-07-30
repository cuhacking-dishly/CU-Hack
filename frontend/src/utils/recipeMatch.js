/** Shared validation for the retrieval metadata returned with every recipe page. */

export const EXACT_MATCH_MODE = "exact";
export const CLOSEST_MATCH_MODE = "closest";

const MATCH_MODES = new Set([EXACT_MATCH_MODE, CLOSEST_MATCH_MODE]);
const MAX_MATCH_MESSAGE_LENGTH = 400;
const MAX_PROVIDER_LENGTH = 120;
const MAX_MATCH_REASONS = 6;
const MAX_MATCH_REASON_LENGTH = 180;

export function isRecipeMatchMode(value) {
  return typeof value === "string" && MATCH_MODES.has(value);
}

export function createDefaultRecipeMatch(mode = EXACT_MATCH_MODE) {
  if (!isRecipeMatchMode(mode)) {
    throw new TypeError("Recipe match mode must be exact or closest");
  }

  return {
    mode,
    canShowClosest: false,
    message: null,
    semanticProvider: "unknown",
  };
}

function normalizeBoundedText(value, maxLength) {
  if (typeof value !== "string") return null;

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

/**
 * Validates API/session match metadata without trusting arbitrary response text.
 *
 * A missing object can be interpreted as the requested mode for compatibility
 * with an older cached deck. A present but malformed object is always rejected.
 */
export function normalizeRecipeMatch(
  value,
  { expectedMode = null, allowMissing = false } = {},
) {
  if (value === undefined) {
    if (!allowMissing) return null;
    return createDefaultRecipeMatch(expectedMode || EXACT_MATCH_MODE);
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;

  const { mode, canShowClosest, message, semanticProvider } = value;
  if (
    !isRecipeMatchMode(mode) ||
    (expectedMode !== null && mode !== expectedMode) ||
    typeof canShowClosest !== "boolean" ||
    (message !== null && normalizeBoundedText(message, MAX_MATCH_MESSAGE_LENGTH) === null) ||
    normalizeBoundedText(semanticProvider, MAX_PROVIDER_LENGTH) === null
  ) {
    return null;
  }

  return {
    mode,
    // A closest deck cannot recursively offer another closest-deck search.
    canShowClosest: mode === EXACT_MATCH_MODE && canShowClosest,
    message:
      message === null ? null : normalizeBoundedText(message, MAX_MATCH_MESSAGE_LENGTH),
    semanticProvider: normalizeBoundedText(semanticProvider, MAX_PROVIDER_LENGTH),
  };
}

/** Returns a small, safe, de-duplicated list suitable for a recipe card. */
export function normalizeMatchReasons(value) {
  if (!Array.isArray(value)) return [];

  const reasons = [];
  const seen = new Set();

  // Bound work even if an upstream response contains an unexpectedly huge list.
  for (const candidate of value.slice(0, MAX_MATCH_REASONS * 4)) {
    const reason = normalizeBoundedText(candidate, MAX_MATCH_REASON_LENGTH);
    if (!reason) continue;

    const dedupeKey = reason.toLocaleLowerCase();
    if (seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    reasons.push(reason);
    if (reasons.length === MAX_MATCH_REASONS) break;
  }

  return reasons;
}

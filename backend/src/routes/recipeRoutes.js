const express = require("express");

const { getRecipeById, searchRecipePage } = require("../services/retrievalService");
const { getGoal, getSwipes } = require("../store");
const {
  USER_ID_MAX_LENGTH,
  asyncRoute,
  createHttpError,
  parseIntegerQuery,
  requireBoundedString,
  requirePositiveRecipeId,
  requireSingleQueryValue,
} = require("./routeUtils");

const router = express.Router();

function parseMatchMode(value) {
  if (value === undefined) return "exact";

  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized !== "exact" && normalized !== "closest") {
    throw createHttpError(400, "matchMode must be exact or closest");
  }

  return normalized;
}

router.get(
  "/recipes",
  asyncRoute(async (req, res) => {
    const userId = requireBoundedString(requireSingleQueryValue(req.query, "userId"), {
      field: "userId",
      maxLength: USER_ID_MAX_LENGTH,
    });
    const limit = parseIntegerQuery(requireSingleQueryValue(req.query, "limit"), {
      field: "limit",
      min: 1,
      max: 20,
      defaultValue: 10,
    });
    const offset = parseIntegerQuery(requireSingleQueryValue(req.query, "offset"), {
      field: "offset",
      min: 0,
      max: 900,
      defaultValue: 0,
    });
    const matchMode = parseMatchMode(requireSingleQueryValue(req.query, "matchMode"));
    const goal = await getGoal(userId);
    const excludedRecipeIds = goal
      ? (await getSwipes(userId))
          .filter((swipe) => swipe.goalUpdatedAt === goal.updatedAt)
          .map((swipe) => swipe.recipeId)
      : [];
    const page = await searchRecipePage(goal, {
      limit,
      offset,
      matchMode,
      excludedRecipeIds,
    });
    return res.json(page);
  })
);

router.get(
  "/recipes/:id",
  asyncRoute(async (req, res) => {
    const id = requirePositiveRecipeId(req.params.id, "id");
    return res.json(await getRecipeById(id));
  })
);

module.exports = router;

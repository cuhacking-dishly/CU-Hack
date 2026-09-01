const express = require("express");

const { getRecipeById, searchRecipePage } = require("../services/spoonacularService");
const { getGoal } = require("../store/memoryStore");
const {
  USER_ID_MAX_LENGTH,
  asyncRoute,
  parseIntegerQuery,
  requireBoundedString,
  requirePositiveRecipeId,
  requireSingleQueryValue,
} = require("./routeUtils");

const router = express.Router();

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
    const goal = getGoal(userId);
    const { recipes, hasMore } = await searchRecipePage(goal?.parsedFilter || {}, {
      limit,
      offset,
    });

    return res.json({
      recipes,
      pagination: { limit, offset, count: recipes.length, hasMore },
    });
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

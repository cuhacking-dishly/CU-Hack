const express = require("express");

const { addSwipe, getGoal } = require("../store");
const {
  USER_ID_MAX_LENGTH,
  asyncRoute,
  createHttpError,
  requireBoundedString,
  requirePositiveRecipeId,
} = require("./routeUtils");

const router = express.Router();

function isMissingString(value) {
  return typeof value !== "string" || value.trim() === "";
}

router.post(
  "/swipe",
  asyncRoute(async (req, res) => {
    const { userId, recipeId, direction } = req.body || {};

    if (isMissingString(userId) || isMissingString(recipeId)) {
      throw createHttpError(400, "userId and recipeId are required");
    }

    const normalizedUserId = requireBoundedString(userId, {
      field: "userId",
      maxLength: USER_ID_MAX_LENGTH,
    });
    const normalizedRecipeId = requirePositiveRecipeId(recipeId);
    const normalizedDirection = typeof direction === "string" ? direction.trim() : "";
    if (normalizedDirection !== "left" && normalizedDirection !== "right") {
      throw createHttpError(400, "direction must be left or right");
    }

    const goal = await getGoal(normalizedUserId);
    await addSwipe(
      normalizedUserId,
      normalizedRecipeId,
      normalizedDirection,
      goal?.updatedAt
    );
    return res.json({ success: true });
  })
);

module.exports = router;

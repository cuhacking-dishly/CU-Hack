const express = require("express");

const { parseGoal } = require("../services/geminiService");
const { normalizeGoalFilter } = require("../services/goalFilter");
const { getGoal, setGoal } = require("../store/memoryStore");
const {
  GOAL_TEXT_MAX_LENGTH,
  USER_ID_MAX_LENGTH,
  asyncRoute,
  createHttpError,
  requireBoundedString,
  requireSingleQueryValue,
} = require("./routeUtils");

const router = express.Router();

function isMissingString(value) {
  return typeof value !== "string" || value.trim() === "";
}

router.post(
  "/parse-goal",
  asyncRoute(async (req, res) => {
    const text = requireBoundedString(req.body?.text, {
      field: "text",
      maxLength: GOAL_TEXT_MAX_LENGTH,
    });
    const parsedFilter = normalizeGoalFilter(await parseGoal(text), { strict: false });
    return res.json({ parsedFilter });
  })
);

router.post(
  "/goal",
  asyncRoute((req, res) => {
    const { userId, rawText } = req.body || {};
    if (isMissingString(userId) || isMissingString(rawText)) {
      throw createHttpError(400, "userId and rawText are required");
    }

    const normalizedUserId = requireBoundedString(userId, {
      field: "userId",
      maxLength: USER_ID_MAX_LENGTH,
    });
    const normalizedRawText = requireBoundedString(rawText, {
      field: "rawText",
      maxLength: GOAL_TEXT_MAX_LENGTH,
    });
    const parsedFilter = normalizeGoalFilter(req.body?.parsedFilter, { strict: true });

    setGoal(normalizedUserId, normalizedRawText, parsedFilter);
    return res.json({ success: true });
  })
);

router.get(
  "/goal/current",
  asyncRoute((req, res) => {
    const userId = requireBoundedString(requireSingleQueryValue(req.query, "userId"), {
      field: "userId",
      maxLength: USER_ID_MAX_LENGTH,
    });
    return res.json(getGoal(userId));
  })
);

module.exports = router;

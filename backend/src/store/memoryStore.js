const goals = new Map();
const swipesByUser = new Map();
const MAX_SWIPES_PER_USER = 1000;

function clone(value) {
  return structuredClone(value);
}

function nextGoalVersion(userId) {
  const previousTimestamp = Date.parse(goals.get(userId)?.updatedAt || "");
  const now = Date.now();
  const timestamp = Number.isFinite(previousTimestamp) && now <= previousTimestamp
    ? previousTimestamp + 1
    : now;
  return new Date(timestamp).toISOString();
}

function setGoal(userId, rawText, parsedFilter) {
  goals.set(userId, {
    rawText,
    parsedFilter: clone(parsedFilter),
    updatedAt: nextGoalVersion(userId),
  });
}

function getGoal(userId) {
  const goal = goals.get(userId);
  return goal ? clone(goal) : null;
}

function addSwipe(userId, recipeId, direction, goalUpdatedAt) {
  const userSwipes = swipesByUser.get(userId) || [];
  const swipe = {
    userId,
    recipeId,
    direction,
    timestamp: new Date().toISOString(),
  };
  if (typeof goalUpdatedAt === "string" && goalUpdatedAt.trim() !== "") {
    swipe.goalUpdatedAt = goalUpdatedAt.trim();
  }
  userSwipes.push(swipe);

  if (userSwipes.length > MAX_SWIPES_PER_USER) {
    userSwipes.splice(0, userSwipes.length - MAX_SWIPES_PER_USER);
  }
  swipesByUser.set(userId, userSwipes);
}

function getSwipes(userId) {
  return clone(swipesByUser.get(userId) || []);
}

function clearStore() {
  goals.clear();
  swipesByUser.clear();
}

module.exports = { addSwipe, clearStore, getGoal, getSwipes, setGoal };

const goals = new Map();
const swipesByUser = new Map();
const MAX_SWIPES_PER_USER = 1000;

function clone(value) {
  return structuredClone(value);
}

function setGoal(userId, rawText, parsedFilter) {
  goals.set(userId, {
    rawText,
    parsedFilter: clone(parsedFilter),
    updatedAt: new Date().toISOString(),
  });
}

function getGoal(userId) {
  const goal = goals.get(userId);
  return goal ? clone(goal) : null;
}

function addSwipe(userId, recipeId, direction) {
  const userSwipes = swipesByUser.get(userId) || [];
  userSwipes.push({
    userId,
    recipeId,
    direction,
    timestamp: new Date().toISOString(),
  });

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

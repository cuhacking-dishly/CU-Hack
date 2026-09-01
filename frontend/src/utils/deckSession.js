import { isUsableRecipe } from "./recipe.js";

const STORAGE_PREFIX = "recipe-match:deck:v1:";
const MAX_NEXT_OFFSET = 920;
const memorySnapshots = new Map();
const memoryFallbackKeys = new Set();

function getUserPrefix(userId) {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}:`;
}

function getStorageKey(userId, goalUpdatedAt) {
  return `${getUserPrefix(userId)}${encodeURIComponent(goalUpdatedAt)}`;
}

function hasValidIdentity(userId, goalUpdatedAt) {
  return (
    typeof userId === "string" &&
    userId.trim() !== "" &&
    typeof goalUpdatedAt === "string" &&
    goalUpdatedAt.trim() !== ""
  );
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const { recipes, currentIndex, nextOffset, hasMore } = value;
  const recipeIds = Array.isArray(recipes) ? recipes.map((recipe) => recipe?.id) : [];
  if (
    !Array.isArray(recipes) ||
    !recipes.every(isUsableRecipe) ||
    new Set(recipeIds).size !== recipeIds.length ||
    !Number.isInteger(currentIndex) ||
    currentIndex < 0 ||
    currentIndex > recipes.length ||
    !Number.isInteger(nextOffset) ||
    nextOffset < 0 ||
    nextOffset > MAX_NEXT_OFFSET ||
    typeof hasMore !== "boolean"
  ) {
    return null;
  }

  return { recipes, currentIndex, nextOffset, hasMore };
}

function cloneSnapshot(snapshot) {
  try {
    return structuredClone(snapshot);
  } catch {
    return null;
  }
}

function readMemorySnapshot(key) {
  const snapshot = normalizeSnapshot(memorySnapshots.get(key));
  return snapshot ? cloneSnapshot(snapshot) : null;
}

function rememberSnapshot(key, snapshot, { fallback = false } = {}) {
  const clonedSnapshot = cloneSnapshot(snapshot);
  if (!clonedSnapshot) {
    return false;
  }

  memorySnapshots.set(key, clonedSnapshot);
  if (fallback) {
    memoryFallbackKeys.add(key);
  } else {
    memoryFallbackKeys.delete(key);
  }
  return true;
}

function clearMemorySnapshots(prefix) {
  for (const key of memorySnapshots.keys()) {
    if (key.startsWith(prefix)) {
      memorySnapshots.delete(key);
      memoryFallbackKeys.delete(key);
    }
  }
  for (const key of memoryFallbackKeys) {
    if (key.startsWith(prefix)) {
      memoryFallbackKeys.delete(key);
    }
  }
}

export function readDeckSession(userId, goalUpdatedAt) {
  if (!hasValidIdentity(userId, goalUpdatedAt)) {
    return null;
  }

  const key = getStorageKey(userId, goalUpdatedAt);

  try {
    const rawValue = window.sessionStorage.getItem(key);
    if (rawValue == null) {
      if (memoryFallbackKeys.has(key)) {
        return readMemorySnapshot(key);
      }

      memorySnapshots.delete(key);
      return null;
    }

    const snapshot = normalizeSnapshot(JSON.parse(rawValue));
    if (!snapshot) {
      window.sessionStorage.removeItem(key);
      const memorySnapshot = readMemorySnapshot(key);
      if (memorySnapshot) {
        memoryFallbackKeys.add(key);
      }
      return memorySnapshot;
    }
    rememberSnapshot(key, snapshot);
    return cloneSnapshot(snapshot);
  } catch {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // Storage can be unavailable or blocked.
    }
    const memorySnapshot = readMemorySnapshot(key);
    if (memorySnapshot) {
      memoryFallbackKeys.add(key);
    }
    return memorySnapshot;
  }
}

export function writeDeckSession(userId, goalUpdatedAt, snapshot) {
  if (!hasValidIdentity(userId, goalUpdatedAt)) {
    return false;
  }

  const normalizedSnapshot = normalizeSnapshot(snapshot);
  if (!normalizedSnapshot) {
    return false;
  }

  const key = getStorageKey(userId, goalUpdatedAt);
  if (!rememberSnapshot(key, normalizedSnapshot, { fallback: true })) {
    return false;
  }

  try {
    window.sessionStorage.setItem(
      key,
      JSON.stringify(normalizedSnapshot),
    );
    memoryFallbackKeys.delete(key);
    return true;
  } catch {
    return false;
  }
}

export function clearDeckSessions(userId) {
  if (typeof userId !== "string" || !userId.trim()) {
    return false;
  }

  const prefix = getUserPrefix(userId);
  clearMemorySnapshots(prefix);

  try {
    const keysToRemove = [];

    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(prefix)) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => window.sessionStorage.removeItem(key));
    return true;
  } catch {
    return false;
  }
}

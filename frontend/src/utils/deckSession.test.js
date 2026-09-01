import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDeckSessions,
  readDeckSession,
  writeDeckSession,
} from "./deckSession.js";

const USER_ID = "demo-user-1";
const GOAL_VERSION = "2026-07-11T16:00:00.000Z";
const RECIPE = {
  id: "12345",
  title: "Vegan Bowl",
  image: "https://images.example/vegan-bowl.jpg",
  readyInMinutes: 25,
  servings: 2,
  calories: 480,
  macros: { protein_g: 38, carbs_g: 42, fat_g: 14 },
  diets: ["vegan"],
  sourceUrl: "https://recipes.example/vegan-bowl",
};
const SNAPSHOT = {
  recipes: [RECIPE],
  currentIndex: 0,
  nextOffset: 10,
  hasMore: true,
};

describe("deck session storage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearDeckSessions(USER_ID);
    clearDeckSessions("another-user");
    window.sessionStorage.clear();
  });

  it("round-trips a validated snapshot by user and goal version", () => {
    expect(writeDeckSession(USER_ID, GOAL_VERSION, SNAPSHOT)).toBe(true);
    expect(readDeckSession(USER_ID, GOAL_VERSION)).toEqual(SNAPSHOT);
    expect(readDeckSession(USER_ID, "2026-07-11T17:00:00.000Z")).toBeNull();
  });

  it.each([
    null,
    [],
    {},
    { ...SNAPSHOT, recipes: [{ id: "not-numeric" }] },
    { ...SNAPSHOT, recipes: [RECIPE, RECIPE] },
    { ...SNAPSHOT, currentIndex: 2 },
    { ...SNAPSHOT, nextOffset: -1 },
    { ...SNAPSHOT, hasMore: "yes" },
  ])("rejects a malformed snapshot without throwing: %j", (snapshot) => {
    expect(writeDeckSession(USER_ID, GOAL_VERSION, snapshot)).toBe(false);
  });

  it("removes corrupt JSON and safely returns no cache", () => {
    const key = "recipe-match:deck:v1:demo-user-1:2026-07-11T16%3A00%3A00.000Z";
    window.sessionStorage.setItem(key, "{not json");

    expect(readDeckSession(USER_ID, GOAL_VERSION)).toBeNull();
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it("uses the runtime snapshot when persisted JSON becomes corrupt", () => {
    const key = "recipe-match:deck:v1:demo-user-1:2026-07-11T16%3A00%3A00.000Z";
    writeDeckSession(USER_ID, GOAL_VERSION, SNAPSHOT);
    window.sessionStorage.setItem(key, "{not json");

    expect(readDeckSession(USER_ID, GOAL_VERSION)).toEqual(SNAPSHOT);
    expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(readDeckSession(USER_ID, GOAL_VERSION)).toEqual(SNAPSHOT);
  });

  it("clears every goal version for only the selected user", () => {
    writeDeckSession(USER_ID, GOAL_VERSION, SNAPSHOT);
    writeDeckSession(USER_ID, "2026-07-12T16:00:00.000Z", SNAPSHOT);
    writeDeckSession("another-user", GOAL_VERSION, SNAPSHOT);

    expect(clearDeckSessions(USER_ID)).toBe(true);
    expect(readDeckSession(USER_ID, GOAL_VERSION)).toBeNull();
    expect(readDeckSession(USER_ID, "2026-07-12T16:00:00.000Z")).toBeNull();
    expect(readDeckSession("another-user", GOAL_VERSION)).toEqual(SNAPSHOT);
  });

  it("writes, reads, and clears the memory fallback when storage methods throw", () => {
    window.sessionStorage.setItem("unrelated", "value");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(writeDeckSession(USER_ID, GOAL_VERSION, SNAPSHOT)).toBe(false);
    expect(readDeckSession(USER_ID, GOAL_VERSION)).toEqual(SNAPSHOT);
    expect(clearDeckSessions(USER_ID)).toBe(false);

    vi.restoreAllMocks();
    expect(readDeckSession(USER_ID, GOAL_VERSION)).toBeNull();
  });

  it("handles unavailable storage enumeration while clearing", () => {
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    window.sessionStorage.setItem("unrelated", "value");

    expect(clearDeckSessions(USER_ID)).toBe(false);
  });

  it("rejects missing cache identities", () => {
    expect(readDeckSession("", GOAL_VERSION)).toBeNull();
    expect(writeDeckSession(USER_ID, "", SNAPSHOT)).toBe(false);
    expect(clearDeckSessions(" ")).toBe(false);
  });
});

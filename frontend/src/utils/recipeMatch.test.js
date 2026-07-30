import { describe, expect, it } from "vitest";
import {
  CLOSEST_MATCH_MODE,
  createDefaultRecipeMatch,
  EXACT_MATCH_MODE,
  isRecipeMatchMode,
  normalizeMatchReasons,
  normalizeRecipeMatch,
} from "./recipeMatch.js";

describe("recipe match metadata", () => {
  it("recognizes only the two public retrieval modes", () => {
    expect(isRecipeMatchMode(EXACT_MATCH_MODE)).toBe(true);
    expect(isRecipeMatchMode(CLOSEST_MATCH_MODE)).toBe(true);
    expect(isRecipeMatchMode("approximate")).toBe(false);
    expect(() => createDefaultRecipeMatch("approximate")).toThrow(TypeError);
  });

  it("normalizes a valid exact-match response", () => {
    expect(normalizeRecipeMatch({
      mode: "exact",
      canShowClosest: true,
      message: "  No   exact results. ",
      semanticProvider: " ollama ",
    }, { expectedMode: "exact" })).toEqual({
      mode: "exact",
      canShowClosest: true,
      message: "No exact results.",
      semanticProvider: "ollama",
    });
  });

  it("prevents closest responses from recursively offering closest results", () => {
    expect(normalizeRecipeMatch({
      mode: "closest",
      canShowClosest: true,
      message: null,
      semanticProvider: "ollama",
    })).toEqual({
      mode: "closest",
      canShowClosest: false,
      message: null,
      semanticProvider: "ollama",
    });
  });

  it("allows an intentional compatibility fallback but rejects malformed metadata", () => {
    expect(normalizeRecipeMatch(undefined, {
      expectedMode: "closest",
      allowMissing: true,
    })).toEqual(createDefaultRecipeMatch("closest"));
    expect(normalizeRecipeMatch(null, { allowMissing: true })).toBeNull();
    expect(normalizeRecipeMatch({
      mode: "closest",
      canShowClosest: false,
      message: null,
      semanticProvider: "ollama",
    }, { expectedMode: "exact" })).toBeNull();
    expect(normalizeRecipeMatch({
      mode: "exact",
      canShowClosest: "yes",
      message: null,
      semanticProvider: "ollama",
    })).toBeNull();
  });

  it("bounds, cleans, and de-duplicates optional card reasons", () => {
    expect(normalizeMatchReasons([
      "  Thai   cuisine ",
      "thai cuisine",
      "Near the protein target",
      null,
      "x".repeat(181),
    ])).toEqual(["Thai cuisine", "Near the protein target"]);

    expect(normalizeMatchReasons(
      Array.from({ length: 20 }, (_unused, index) => `Reason ${index}`),
    )).toHaveLength(6);
    expect(normalizeMatchReasons("not a list")).toEqual([]);
  });
});

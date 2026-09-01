import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDeckSessions,
  readDeckSession,
  writeDeckSession,
} from "../utils/deckSession.js";
import { clearLikedRecipes, getLikedRecipes } from "../utils/likedRecipes.js";
import SwipeDeckPage from "./SwipeDeckPage.jsx";

const apiMocks = vi.hoisted(() => ({
  getCurrentGoal: vi.fn(),
  getRecipes: vi.fn(),
  logSwipe: vi.fn(),
}));

const motionMocks = vi.hoisted(() => ({
  animate: vi.fn(),
  prefersReducedMotion: vi.fn(() => false),
}));

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

const DEMO_RECIPE_MATCH = expect.objectContaining({ id: "1697679" });

vi.mock("../api/client.js", () => ({
  getApiErrorMessage(error, fallback) {
    const message = error?.response?.data?.error;
    return typeof message === "string" && message.trim() ? message.trim() : fallback;
  },
  getCurrentGoal: apiMocks.getCurrentGoal,
  getRecipes: apiMocks.getRecipes,
  logSwipe: apiMocks.logSwipe,
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useNavigate: () => routerMocks.navigate,
  };
});

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal();
  const React = await import("react");

  // Motion-only props that must never reach a real DOM node.
  const MOTION_PROPS = new Set([
    "initial",
    "animate",
    "exit",
    "transition",
    "variants",
    "custom",
    "style",
    "layout",
    "layoutId",
    "layoutScroll",
    "layoutDependency",
    "drag",
    "dragConstraints",
    "dragElastic",
    "dragMomentum",
    "dragTransition",
    "dragSnapToOrigin",
    "dragPropagation",
    "whileHover",
    "whileTap",
    "whileFocus",
    "whileDrag",
    "whileInView",
    "viewport",
    "onViewportEnter",
    "onViewportLeave",
    "onAnimationStart",
    "onAnimationComplete",
    "onUpdate",
    "onDrag",
    "onDragStart",
    "transformTemplate",
  ]);

  // A generic motion.<tag> factory: renders the underlying element with only
  // DOM-safe props, so the redesigned deck can use any motion primitive.
  const motion = new Proxy(
    {},
    {
      get(_target, tag) {
        return React.forwardRef(function MockMotion(props, ref) {
          const domProps = {};
          for (const key of Object.keys(props)) {
            if (key === "children" || MOTION_PROPS.has(key)) continue;
            domProps[key] = props[key];
          }
          return React.createElement(
            typeof tag === "string" ? tag : "div",
            { ref, ...domProps },
            props.children,
          );
        });
      },
    },
  );

  function AnimatePresence({ children }) {
    return React.createElement(React.Fragment, null, children);
  }

  function useMotionValue(initialValue) {
    const valueRef = React.useRef(initialValue);
    const motionValueRef = React.useRef(null);

    if (!motionValueRef.current) {
      motionValueRef.current = {
        get: () => valueRef.current,
        set: (nextValue) => {
          valueRef.current = nextValue;
        },
        on: () => () => {},
      };
    }

    return motionValueRef.current;
  }

  return {
    ...actual,
    animate: motionMocks.animate,
    motion,
    AnimatePresence,
    useMotionValue,
    useReducedMotion: motionMocks.prefersReducedMotion,
    useTransform: (value) => value,
  };
});

const GOAL_UPDATED_AT = "2026-07-11T16:00:00.000Z";
const CURRENT_GOAL = {
  rawText: "high protein",
  parsedFilter: { minProtein_g: 30 },
  updatedAt: GOAL_UPDATED_AT,
};

const FIRST_RECIPE = {
  id: "1001",
  title: "Lemon Chicken Bowl",
  image: "https://images.example/alpha.jpg",
  readyInMinutes: 25,
  servings: 2,
  calories: 480,
  macros: { protein_g: 38, carbs_g: 42, fat_g: 14 },
  diets: ["gluten free"],
  ingredients: ["1 cup quinoa", "1 lemon"],
  instructions: ["Cook the quinoa.", "Top with lemon chicken."],
  sourceName: "Example Kitchen",
  sourceUrl: "https://recipes.example/lemon-chicken",
};

const SECOND_RECIPE = {
  id: "9002",
  title: "Ginger Tofu Plate",
  image: "https://images.example/beta.jpg",
  readyInMinutes: 20,
  servings: 1,
  calories: 510,
  macros: { protein_g: 31, carbs_g: 55, fat_g: 18 },
  diets: ["vegan"],
  ingredients: ["8 oz tofu", "1 tbsp ginger"],
  instructions: ["Sear the tofu.", "Add ginger sauce."],
  sourceName: "Example Kitchen",
  sourceUrl: "https://recipes.example/ginger-tofu",
};

const THIRD_RECIPE = {
  ...SECOND_RECIPE,
  id: "9003",
  title: "Sesame Tempeh Plate",
};

function recipePage(recipes, { limit = 10, offset = 0, hasMore = false } = {}) {
  return {
    recipes,
    pagination: { limit, offset, count: recipes.length, hasMore },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function renderDeck() {
  return render(
    <MemoryRouter initialEntries={["/deck"]}>
      <SwipeDeckPage />
    </MemoryRouter>,
  );
}

async function renderLoadedDeck(recipes = [FIRST_RECIPE, SECOND_RECIPE], options) {
  apiMocks.getRecipes.mockResolvedValue(recipePage(recipes, options));
  const result = renderDeck();
  const progress = await screen.findByRole("status");
  expect(progress).toHaveTextContent(`Match 1: ${recipes[0].title}`);
  return result;
}

describe("SwipeDeckPage", () => {
  beforeEach(() => {
    clearDeckSessions("demo-user-1");
    clearLikedRecipes("demo-user-1");
    window.sessionStorage.clear();
    apiMocks.getCurrentGoal.mockReset();
    apiMocks.getRecipes.mockReset();
    apiMocks.logSwipe.mockReset();
    routerMocks.navigate.mockReset();
    motionMocks.animate.mockReset();
    motionMocks.prefersReducedMotion.mockReset();

    apiMocks.getCurrentGoal.mockResolvedValue(CURRENT_GOAL);
    apiMocks.getRecipes.mockResolvedValue(recipePage([FIRST_RECIPE, SECOND_RECIPE]));
    apiMocks.logSwipe.mockResolvedValue({ success: true });
    motionMocks.animate.mockResolvedValue(undefined);
    motionMocks.prefersReducedMotion.mockReturnValue(false);
  });

  it("redirects direct deck access when no saved goal exists", async () => {
    apiMocks.getCurrentGoal.mockResolvedValue(null);

    renderDeck();

    expect(screen.getByRole("heading", { name: "Building your deck" })).toBeInTheDocument();
    await waitFor(() => {
      expect(routerMocks.navigate).toHaveBeenCalledWith("/", { replace: true });
    });
    expect(apiMocks.getRecipes).not.toHaveBeenCalled();
  });

  it("requests the first page explicitly and keeps only canonical recipe ids", async () => {
    apiMocks.getRecipes.mockResolvedValue(
      recipePage([null, {}, { id: 9002, title: "Numeric id" }, { id: "alpha" }, FIRST_RECIPE]),
    );

    renderDeck();

    expect(await screen.findByRole("status")).toHaveTextContent("Match 1: Lemon Chicken Bowl");
    expect(apiMocks.getRecipes).toHaveBeenCalledWith(
      "demo-user-1",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        params: { limit: 10, offset: 0 },
      }),
    );
    expect(screen.queryByText("Numeric id")).not.toBeInTheDocument();
  });

  it("shows load errors and retries the complete goal guard and first page", async () => {
    const user = userEvent.setup();
    apiMocks.getCurrentGoal
      .mockRejectedValueOnce({ response: { data: { error: "Recipe service is warming up." } } })
      .mockResolvedValueOnce(CURRENT_GOAL);
    apiMocks.getRecipes.mockResolvedValue(recipePage([FIRST_RECIPE]));

    renderDeck();

    expect(await screen.findByRole("alert")).toHaveTextContent("Recipe service is warming up.");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Match 1: Lemon Chicken Bowl");
    expect(apiMocks.getCurrentGoal).toHaveBeenCalledTimes(2);
    expect(apiMocks.getRecipes).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed pagination as a deck load failure", async () => {
    apiMocks.getRecipes.mockResolvedValue({
      recipes: [FIRST_RECIPE],
      pagination: { limit: 10, offset: 0, count: 1 },
    });

    renderDeck();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't load your recipe deck. Please try again.",
    );
  });

  it("renders an honest empty state without inventing cards", async () => {
    apiMocks.getRecipes.mockResolvedValue(recipePage([]));

    renderDeck();

    expect(await screen.findByRole("heading", { name: "Try a different goal" })).toBeVisible();
    expect(screen.getByText(/No usable recipes were found for this goal/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Like recipe" })).not.toBeInTheDocument();
  });

  it("waits for left-swipe acknowledgement before advancing and persists progress", async () => {
    const user = userEvent.setup();
    const swipeResponse = deferred();
    apiMocks.logSwipe.mockReturnValue(swipeResponse.promise);
    await renderLoadedDeck();

    await user.click(screen.getByRole("button", { name: "Skip recipe" }));

    expect(screen.getByRole("status")).toHaveTextContent("Match 1: Lemon Chicken Bowl");
    expect(screen.getByText("Saving your swipe...")).toBeVisible();
    expect(screen.getByRole("button", { name: "Like recipe" })).toBeDisabled();
    expect(apiMocks.logSwipe).toHaveBeenCalledWith(
      "demo-user-1",
      "1001",
      "left",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await act(async () => swipeResponse.resolve({ success: true }));

    expect(await screen.findByRole("status")).toHaveTextContent("Match 2: Ginger Tofu Plate");
    expect(readDeckSession("demo-user-1", GOAL_UPDATED_AT)).toMatchObject({ currentIndex: 1 });
  });

  it("keeps a failed left swipe on the same card and supports retry", async () => {
    const user = userEvent.setup();
    apiMocks.logSwipe
      .mockRejectedValueOnce({ response: { data: { error: "Swipe could not be saved." } } })
      .mockResolvedValueOnce({ success: true });
    await renderLoadedDeck();

    await user.click(screen.getByRole("button", { name: "Skip recipe" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Swipe could not be saved.");
    expect(screen.getByRole("status")).toHaveTextContent("Match 1: Lemon Chicken Bowl");
    await waitFor(() => expect(screen.getByRole("button", { name: "Skip recipe" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Skip recipe" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Match 2: Ginger Tofu Plate");
    expect(apiMocks.logSwipe).toHaveBeenCalledTimes(2);
  });

  it("persists a right swipe before advancing to the next inline recipe", async () => {
    const user = userEvent.setup();
    const swipeResponse = deferred();
    apiMocks.logSwipe.mockReturnValue(swipeResponse.promise);
    await renderLoadedDeck();

    await user.click(screen.getByRole("button", { name: "Like recipe" }));

    expect(routerMocks.navigate).not.toHaveBeenCalled();
    await act(async () => swipeResponse.resolve({ success: true }));

    expect(await screen.findByRole("status")).toHaveTextContent("Match 2: Ginger Tofu Plate");
    expect(routerMocks.navigate).not.toHaveBeenCalled();
    expect(readDeckSession("demo-user-1", GOAL_UPDATED_AT)).toMatchObject({ currentIndex: 1 });
    expect(getLikedRecipes("demo-user-1")).toEqual([FIRST_RECIPE, DEMO_RECIPE_MATCH]);
  });

  it("does not save a left-swiped (skipped) recipe as liked", async () => {
    const user = userEvent.setup();
    await renderLoadedDeck();

    await user.click(screen.getByRole("button", { name: "Skip recipe" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Match 2: Ginger Tofu Plate");
    expect(getLikedRecipes("demo-user-1")).toEqual([DEMO_RECIPE_MATCH]);
  });

  it("navigates to the liked recipes page from the deck header", async () => {
    const user = userEvent.setup();
    await renderLoadedDeck();

    expect(screen.getByRole("link", { name: "Dishly home" })).toHaveAttribute("href", "/");
    expect(document.querySelector(".deck-brand img")).toHaveAttribute(
      "src",
      "/images/dishly-logo-hero.png",
    );

    await user.click(screen.getByRole("button", { name: "Liked recipes" }));

    expect(routerMocks.navigate).toHaveBeenCalledWith("/liked");
  });

  it("keeps swipe controls focused without rendering an instructional footer", async () => {
    await renderLoadedDeck();

    expect(screen.queryByText("Drag the card, tap a button, or press")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip recipe" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Like recipe" })).toBeVisible();
  });

  it("keeps actions locked through a failed right swipe's return animation", async () => {
    const user = userEvent.setup();
    const returnAnimation = deferred();
    motionMocks.animate
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(returnAnimation.promise);
    apiMocks.logSwipe.mockRejectedValueOnce({
      response: { data: { error: "Swipe could not be saved." } },
    });
    await renderLoadedDeck();

    await user.click(screen.getByRole("button", { name: "Like recipe" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Swipe could not be saved.");
    expect(screen.getByRole("button", { name: "Like recipe" })).toBeDisabled();
    expect(readDeckSession("demo-user-1", GOAL_UPDATED_AT)).toMatchObject({ currentIndex: 0 });

    await act(async () => returnAnimation.resolve());
    await waitFor(() => expect(screen.getByRole("button", { name: "Like recipe" })).toBeEnabled());
    expect(routerMocks.navigate).not.toHaveBeenCalled();
  });

  it("aborts a pending swipe and never advances or navigates after unmount", async () => {
    const user = userEvent.setup();
    const swipeResponse = deferred();
    apiMocks.logSwipe.mockReturnValue(swipeResponse.promise);
    const { unmount } = await renderLoadedDeck();

    await user.click(screen.getByRole("button", { name: "Like recipe" }));
    await waitFor(() => expect(apiMocks.logSwipe).toHaveBeenCalledTimes(1));
    const requestConfig = apiMocks.logSwipe.mock.calls[0][3];

    unmount();
    expect(requestConfig.signal.aborted).toBe(true);
    await act(async () => swipeResponse.resolve({ success: true }));
    expect(routerMocks.navigate).not.toHaveBeenCalled();
    expect(readDeckSession("demo-user-1", GOAL_UPDATED_AT)).toMatchObject({ currentIndex: 0 });
  });

  it("restores a matching cached deck without another recipe request", async () => {
    writeDeckSession("demo-user-1", GOAL_UPDATED_AT, {
      recipes: [FIRST_RECIPE, SECOND_RECIPE],
      currentIndex: 1,
      nextOffset: 10,
      hasMore: false,
    });

    renderDeck();

    expect(await screen.findByRole("status")).toHaveTextContent("Match 2: Ginger Tofu Plate");
    expect(apiMocks.getCurrentGoal).toHaveBeenCalledTimes(1);
    expect(apiMocks.getRecipes).not.toHaveBeenCalled();
  });

  it("resumes after a remount from memory when session storage rejects writes", async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const firstView = await renderLoadedDeck();
    expect(apiMocks.getRecipes).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Skip recipe" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Match 2: Ginger Tofu Plate");
    firstView.unmount();

    renderDeck();

    expect(await screen.findByRole("status")).toHaveTextContent("Match 2: Ginger Tofu Plate");
    expect(apiMocks.getCurrentGoal).toHaveBeenCalledTimes(2);
    expect(apiMocks.getRecipes).toHaveBeenCalledTimes(1);
  });

  it("ignores an old goal version's cache and fetches a fresh first page", async () => {
    writeDeckSession("demo-user-1", "2026-07-10T16:00:00.000Z", {
      recipes: [THIRD_RECIPE],
      currentIndex: 0,
      nextOffset: 10,
      hasMore: false,
    });
    apiMocks.getRecipes.mockResolvedValue(recipePage([FIRST_RECIPE]));

    renderDeck();

    expect(await screen.findByRole("status")).toHaveTextContent("Match 1: Lemon Chicken Bowl");
    expect(apiMocks.getRecipes).toHaveBeenCalledTimes(1);
  });

  it("recovers from corrupt cached JSON by fetching the provider page", async () => {
    const key = "recipe-match:deck:v1:demo-user-1:2026-07-11T16%3A00%3A00.000Z";
    window.sessionStorage.setItem(key, "{bad json");
    apiMocks.getRecipes.mockResolvedValue(recipePage([FIRST_RECIPE]));

    renderDeck();

    expect(await screen.findByRole("status")).toHaveTextContent("Match 1: Lemon Chicken Bowl");
    expect(apiMocks.getRecipes).toHaveBeenCalledTimes(1);
  });

  it("prefetches, advances by offset plus limit, and deduplicates appended ids", async () => {
    const user = userEvent.setup();
    apiMocks.getRecipes
      .mockResolvedValueOnce(recipePage([FIRST_RECIPE, SECOND_RECIPE], { hasMore: true }))
      .mockResolvedValueOnce(
        recipePage([SECOND_RECIPE, THIRD_RECIPE], { offset: 10, hasMore: false }),
      );

    renderDeck();

    expect(await screen.findByRole("status")).toHaveTextContent("Match 1: Lemon Chicken Bowl");
    await waitFor(() => expect(apiMocks.getRecipes).toHaveBeenCalledTimes(2));
    expect(apiMocks.getRecipes.mock.calls[1][1]).toEqual(
      expect.objectContaining({ params: { limit: 10, offset: 10 } }),
    );

    await user.click(screen.getByRole("button", { name: "Skip recipe" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Match 2: Ginger Tofu Plate");
    await user.click(screen.getByRole("button", { name: "Skip recipe" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Match 3: Sesame Tempeh Plate");
  });

  it("surfaces a background pagination error and retries the same offset", async () => {
    const user = userEvent.setup();
    apiMocks.getRecipes
      .mockResolvedValueOnce(
        recipePage([FIRST_RECIPE, SECOND_RECIPE, THIRD_RECIPE], { hasMore: true }),
      )
      .mockRejectedValueOnce({ response: { data: { error: "More matches timed out." } } })
      .mockResolvedValueOnce(recipePage([], { offset: 10, hasMore: false }));

    renderDeck();
    await screen.findByRole("status");
    await user.click(screen.getByRole("button", { name: "Skip recipe" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("More matches timed out.");
    await user.click(screen.getByRole("button", { name: "Retry more matches" }));
    await waitFor(() => expect(apiMocks.getRecipes).toHaveBeenCalledTimes(3));
    expect(apiMocks.getRecipes.mock.calls.slice(1).map(([, config]) => config.params.offset)).toEqual([
      10,
      10,
    ]);
  });

  it("shows loading-more and then truthful end-of-deck states", async () => {
    const user = userEvent.setup();
    const nextPage = deferred();
    apiMocks.getRecipes
      .mockResolvedValueOnce(recipePage([FIRST_RECIPE], { hasMore: true }))
      .mockReturnValueOnce(nextPage.promise);

    renderDeck();
    await screen.findByRole("status");
    await waitFor(() => expect(apiMocks.getRecipes).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Skip recipe" }));

    expect(await screen.findByRole("heading", { name: "Finding more matches" })).toBeVisible();
    await act(async () => nextPage.resolve(recipePage([], { offset: 10, hasMore: false })));
    expect(
      await screen.findByRole("heading", { name: "You've reached the end of this deck" }),
    ).toBeVisible();
  });

  it("retries pagination from the terminal error state", async () => {
    const user = userEvent.setup();
    apiMocks.getRecipes
      .mockResolvedValueOnce(recipePage([FIRST_RECIPE], { hasMore: true }))
      .mockRejectedValueOnce({ response: { data: { error: "Next page unavailable." } } })
      .mockResolvedValueOnce(recipePage([SECOND_RECIPE], { offset: 10, hasMore: false }));

    renderDeck();
    await screen.findByRole("status");
    await waitFor(() => expect(apiMocks.getRecipes).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Skip recipe" }));

    expect(
      await screen.findByRole("heading", { name: "Couldn't load more matches" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Match 2: Ginger Tofu Plate");
  });

  it("replaces unsafe and broken card images with accessible fallbacks", async () => {
    const unsafeView = await renderLoadedDeck([
      { ...FIRST_RECIPE, image: "javascript:alert(1)" },
    ]);
    expect(
      screen.getByRole("img", { name: "Lemon Chicken Bowl image unavailable" }),
    ).toBeVisible();
    unsafeView.unmount();

    window.sessionStorage.clear();
    apiMocks.getRecipes.mockResolvedValue(recipePage([FIRST_RECIPE]));
    const { unmount } = renderDeck();
    const image = await screen.findByRole("img", { name: "Lemon Chicken Bowl" });
    fireEvent.error(image);
    expect(
      screen.getByRole("img", { name: "Lemon Chicken Bowl image unavailable" }),
    ).toHaveTextContent("Recipe image unavailable");
    unmount();
  });

  it("labels nutrition per serving and rejects non-finite readings", async () => {
    const malformedNutritionRecipe = {
      ...FIRST_RECIPE,
      readyInMinutes: Number.POSITIVE_INFINITY,
      servings: 1,
      calories: Number.POSITIVE_INFINITY,
      macros: { protein_g: -4, carbs_g: Number.NaN, fat_g: 0 },
    };
    await renderLoadedDeck([malformedNutritionRecipe]);

    const nutrition = screen.getByLabelText("Nutrition per serving");
    expect(within(nutrition).getByText("Calories N/A")).toBeVisible();
    expect(within(nutrition).getByText("N/A protein")).toBeVisible();
    expect(within(nutrition).getByText("N/A carbs / 0g fat")).toBeVisible();
    expect(screen.getByText(/Time N\/A/)).toHaveTextContent("1 serving");
  });

  it("renders inline recipe ingredients, instructions, and source attribution", async () => {
    await renderLoadedDeck([FIRST_RECIPE]);

    expect(screen.getByRole("heading", { name: "Ingredients" })).toBeVisible();
    expect(screen.getByText("1 cup quinoa")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Instructions" })).toBeVisible();
    expect(screen.getByText("Top with lemon chicken.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Source: Example Kitchen" })).toHaveAttribute(
      "href",
      "https://recipes.example/lemon-chicken",
    );
  });

  it("uses immediate reduced-motion changes while preserving acknowledged swipes", async () => {
    const user = userEvent.setup();
    motionMocks.prefersReducedMotion.mockReturnValue(true);
    await renderLoadedDeck();

    await user.click(screen.getByRole("button", { name: "Skip recipe" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Match 2: Ginger Tofu Plate");
    expect(motionMocks.animate).not.toHaveBeenCalled();
  });

  it("likes the current recipe with the ArrowRight shortcut", async () => {
    await renderLoadedDeck();

    fireEvent.keyDown(window, { key: "ArrowRight" });

    expect(await screen.findByRole("status")).toHaveTextContent("Match 2: Ginger Tofu Plate");
    expect(getLikedRecipes("demo-user-1")).toEqual([FIRST_RECIPE, DEMO_RECIPE_MATCH]);
    expect(apiMocks.logSwipe).toHaveBeenCalledWith(
      "demo-user-1",
      "1001",
      "right",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("skips the current recipe with the ArrowLeft shortcut without liking it", async () => {
    await renderLoadedDeck();

    fireEvent.keyDown(window, { key: "ArrowLeft" });

    expect(await screen.findByRole("status")).toHaveTextContent("Match 2: Ginger Tofu Plate");
    expect(getLikedRecipes("demo-user-1")).toEqual([DEMO_RECIPE_MATCH]);
  });

  it("ignores arrow shortcuts with modifier keys or while typing in a field", async () => {
    await renderLoadedDeck();

    fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", metaKey: true });
    fireEvent.keyDown(window, { key: "ArrowUp" });

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    input.remove();

    expect(screen.getByRole("status")).toHaveTextContent("Match 1: Lemon Chicken Bowl");
    expect(apiMocks.logSwipe).not.toHaveBeenCalled();
  });
});

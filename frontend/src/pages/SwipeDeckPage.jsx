import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../components/Button.jsx";
import BrandLogo from "../components/BrandLogo.jsx";
import {
  getApiErrorMessage,
  getCurrentGoal,
  getRecipes,
  logSwipe,
} from "../api/client.js";
import { USER_ID } from "../constants.js";
import { readDeckSession, writeDeckSession } from "../utils/deckSession.js";
import { addLikedRecipe } from "../utils/likedRecipes.js";
import {
  formatCalories,
  formatMacro,
  formatServings,
  formatTime,
  getSafeHttpUrl,
  isUsableRecipe,
  normalizeImageUrl,
} from "../utils/recipe.js";
import { getFlyOutDistance, getSwipeDirection } from "../utils/swipe.js";
import "./SwipeDeckPage.css";

const PAGE_SIZE = 10;
const MAX_RECIPE_OFFSET = 900;

function createEmptyDeck() {
  return {
    recipes: [],
    currentIndex: 0,
    nextOffset: 0,
    hasMore: false,
    goalUpdatedAt: "",
  };
}

function normalizeRecipePage(response, requestedOffset) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Invalid recipe page");
  }

  const { pagination } = response;
  if (
    !Array.isArray(response.recipes) ||
    !pagination ||
    typeof pagination !== "object" ||
    Array.isArray(pagination) ||
    !Number.isInteger(pagination.limit) ||
    pagination.limit < 1 ||
    pagination.limit > 20 ||
    !Number.isInteger(pagination.offset) ||
    pagination.offset !== requestedOffset ||
    pagination.offset < 0 ||
    pagination.offset > MAX_RECIPE_OFFSET ||
    !Number.isInteger(pagination.count) ||
    pagination.count < 0 ||
    pagination.count > 20 ||
    pagination.count !== response.recipes.length ||
    typeof pagination.hasMore !== "boolean"
  ) {
    throw new Error("Invalid recipe pagination");
  }

  const seenIds = new Set();
  const recipes = response.recipes.filter((recipe) => {
    if (!isUsableRecipe(recipe) || seenIds.has(recipe.id)) {
      return false;
    }
    seenIds.add(recipe.id);
    return true;
  });
  const nextOffset = pagination.offset + pagination.limit;

  return {
    recipes,
    nextOffset,
    hasMore: pagination.hasMore && nextOffset <= MAX_RECIPE_OFFSET,
  };
}

function SwipeDeckPage() {
  const navigate = useNavigate();
  const [deck, setDeck] = useState(createEmptyDeck);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isSwiping, setIsSwiping] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [swipeError, setSwipeError] = useState("");
  const [loadMoreError, setLoadMoreError] = useState("");
  const [swipeRequest, setSwipeRequest] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const isMountedRef = useRef(true);
  const deckRef = useRef(deck);
  const requestNumberRef = useRef(0);
  const pendingSwipeControllersRef = useRef(new Set());
  const pageRequestControllerRef = useRef(null);
  const loadMoreInFlightRef = useRef(false);
  const stateHeadingRef = useRef(null);

  const commitDeck = useCallback((nextDeckOrUpdater) => {
    const nextDeck =
      typeof nextDeckOrUpdater === "function"
        ? nextDeckOrUpdater(deckRef.current)
        : nextDeckOrUpdater;

    deckRef.current = nextDeck;
    setDeck(nextDeck);
    if (nextDeck.goalUpdatedAt) {
      writeDeckSession(USER_ID, nextDeck.goalUpdatedAt, nextDeck);
    }
    return nextDeck;
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    const pendingControllers = pendingSwipeControllersRef.current;

    return () => {
      isMountedRef.current = false;
      pageRequestControllerRef.current?.abort();
      pendingControllers.forEach((controller) => controller.abort());
      pendingControllers.clear();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let isCurrent = true;

    async function loadDeck() {
      setIsLoading(true);
      setErrorMessage("");
      setSwipeError("");
      setLoadMoreError("");

      try {
        const goal = await getCurrentGoal(USER_ID, { signal: controller.signal });

        if (!isCurrent) return;
        if (goal == null) {
          isCurrent = false;
          navigate("/", { replace: true });
          return;
        }

        const goalUpdatedAt =
          typeof goal.updatedAt === "string" ? goal.updatedAt.trim() : "";
        if (!goalUpdatedAt) {
          throw new Error("The saved goal is missing its version");
        }

        const cachedDeck = readDeckSession(USER_ID, goalUpdatedAt);
        if (cachedDeck) {
          commitDeck({ ...cachedDeck, goalUpdatedAt });
          return;
        }

        const response = await getRecipes(USER_ID, {
          signal: controller.signal,
          params: { limit: PAGE_SIZE, offset: 0 },
        });
        if (!isCurrent) return;

        const page = normalizeRecipePage(response, 0);
        commitDeck({ ...page, currentIndex: 0, goalUpdatedAt });
      } catch (error) {
        if (isCurrent && !controller.signal.aborted) {
          deckRef.current = createEmptyDeck();
          setDeck(deckRef.current);
          setErrorMessage(
            getApiErrorMessage(error, "We couldn't load your recipe deck. Please try again."),
          );
        }
      } finally {
        if (isCurrent) setIsLoading(false);
      }
    }

    const timer = window.setTimeout(loadDeck, 0);
    return () => {
      isCurrent = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [commitDeck, loadAttempt, navigate]);

  const loadMoreRecipes = useCallback(async () => {
    const snapshot = deckRef.current;
    if (
      loadMoreInFlightRef.current ||
      !snapshot.goalUpdatedAt ||
      !snapshot.hasMore
    ) {
      return;
    }

    if (snapshot.nextOffset > MAX_RECIPE_OFFSET) {
      commitDeck({ ...snapshot, hasMore: false });
      return;
    }

    loadMoreInFlightRef.current = true;
    setIsLoadingMore(true);
    setLoadMoreError("");
    const controller = new AbortController();
    pageRequestControllerRef.current = controller;
    const requestedGoalVersion = snapshot.goalUpdatedAt;
    const requestedOffset = snapshot.nextOffset;

    try {
      const response = await getRecipes(USER_ID, {
        signal: controller.signal,
        params: { limit: PAGE_SIZE, offset: requestedOffset },
      });
      const page = normalizeRecipePage(response, requestedOffset);

      if (
        !isMountedRef.current ||
        controller.signal.aborted ||
        deckRef.current.goalUpdatedAt !== requestedGoalVersion
      ) {
        return;
      }

      commitDeck((currentDeck) => {
        const seenIds = new Set(currentDeck.recipes.map((recipe) => recipe.id));
        const newRecipes = page.recipes.filter((recipe) => !seenIds.has(recipe.id));
        return {
          ...currentDeck,
          recipes: [...currentDeck.recipes, ...newRecipes],
          nextOffset: page.nextOffset,
          hasMore: page.hasMore,
        };
      });
    } catch (error) {
      if (isMountedRef.current && !controller.signal.aborted) {
        setLoadMoreError(
          getApiErrorMessage(error, "We couldn't load more recipe matches. Please try again."),
        );
      }
    } finally {
      if (pageRequestControllerRef.current === controller) {
        pageRequestControllerRef.current = null;
      }
      loadMoreInFlightRef.current = false;
      if (isMountedRef.current) {
        setIsLoadingMore(false);
      }
    }
  }, [commitDeck]);

  const { recipes, currentIndex, hasMore } = deck;

  const currentRecipe = recipes[currentIndex];
  const nextRecipe = recipes[currentIndex + 1];

  useEffect(() => {
    const prefetchThreshold = Math.max(0, recipes.length - 2);
    if (
      !isLoading &&
      !errorMessage &&
      !loadMoreError &&
      hasMore &&
      currentIndex >= prefetchThreshold
    ) {
      void loadMoreRecipes();
    }
  }, [
    currentIndex,
    errorMessage,
    hasMore,
    isLoading,
    loadMoreError,
    loadMoreRecipes,
    recipes.length,
    deck.nextOffset,
  ]);

  useEffect(() => {
    const shouldFocusState =
      !isLoading &&
      (Boolean(errorMessage) ||
        (!hasMore && recipes.length === 0) ||
        (!hasMore && !currentRecipe) ||
        (!currentRecipe && Boolean(loadMoreError)));

    if (!shouldFocusState) return undefined;

    const frame = window.requestAnimationFrame(() => {
      stateHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentRecipe, errorMessage, hasMore, isLoading, loadMoreError, recipes.length]);

  const createSwipeController = useCallback(() => {
    const controller = new AbortController();
    pendingSwipeControllersRef.current.add(controller);
    return controller;
  }, []);

  const releaseSwipeController = useCallback((controller) => {
    pendingSwipeControllersRef.current.delete(controller);
  }, []);

  const completeSwipe = useCallback(
    async (direction, recipe) => {
      if (!isMountedRef.current) return true;
      setSwipeError("");
      const controller = createSwipeController();

      try {
        await logSwipe(USER_ID, recipe.id, direction, { signal: controller.signal });
        if (!isMountedRef.current || controller.signal.aborted) return true;

        if (direction === "right") {
          addLikedRecipe(USER_ID, recipe);
        }

        const activeRecipe = deckRef.current.recipes[deckRef.current.currentIndex];
        if (!activeRecipe || activeRecipe.id !== recipe.id) return true;

        commitDeck((currentDeck) => ({
          ...currentDeck,
          currentIndex: currentDeck.currentIndex + 1,
        }));
        setIsSwiping(false);

        return true;
      } catch (error) {
        if (!isMountedRef.current || controller.signal.aborted) return true;
        setSwipeError(
          getApiErrorMessage(error, "We couldn't save that swipe. Please try again."),
        );
        return false;
      } finally {
        releaseSwipeController(controller);
      }
    },
    [commitDeck, createSwipeController, releaseSwipeController],
  );

  const requestSwipe = useCallback(
    (direction) => {
      if (!currentRecipe || isSwiping) return;
      requestNumberRef.current += 1;
      setIsSwiping(true);
      setSwipeRequest({ direction, recipeId: currentRecipe.id, requestNumber: requestNumberRef.current });
    },
    [currentRecipe, isSwiping],
  );

  useEffect(() => {
    if (!currentRecipe) return undefined;

    function handleKeyDown(event) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
          return;
        }
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        requestSwipe("left");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        requestSwipe("right");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentRecipe, requestSwipe]);

  const handleSwipeStart = useCallback(() => setIsSwiping(true), []);
  const handleSwipeSettled = useCallback(() => setIsSwiping(false), []);
  const goToGoalEntry = useCallback(() => navigate("/"), [navigate]);
  const changeGoal = useCallback(
    () => navigate("/", { state: { returnTo: "/deck" } }),
    [navigate],
  );
  const goToLikedRecipes = useCallback(() => navigate("/liked"), [navigate]);
  const retryDeck = useCallback(() => {
    setIsLoading(true);
    setErrorMessage("");
    setLoadAttempt((value) => value + 1);
  }, []);
  const retryMoreRecipes = useCallback(() => {
    setLoadMoreError("");
    void loadMoreRecipes();
  }, [loadMoreRecipes]);

  if (isLoading) {
    return (
      <DeckState title="Building your deck" busy>
        Loading recipes that match your food goal...
      </DeckState>
    );
  }

  if (errorMessage) {
    return (
      <DeckState title="Deck unavailable" role="alert" headingRef={stateHeadingRef}>
        <p>{errorMessage}</p>
        <div className="deck-state-actions">
          <Button variant="primary" onClick={retryDeck}>
            Try again
          </Button>
          <Button variant="secondary" onClick={goToGoalEntry}>
            Back to goal
          </Button>
        </div>
      </DeckState>
    );
  }

  if (recipes.length === 0 && !hasMore) {
    return (
      <DeckState title="Try a different goal" headingRef={stateHeadingRef}>
        <p>No usable recipes were found for this goal. Broaden your filters or try a different craving.</p>
        <Button variant="primary" onClick={goToGoalEntry}>
          Set a new goal
        </Button>
      </DeckState>
    );
  }

  if (!currentRecipe) {
    if (loadMoreError) {
      return (
        <DeckState title="Couldn't load more matches" role="alert" headingRef={stateHeadingRef}>
          <p>{loadMoreError}</p>
          <div className="deck-state-actions">
            <Button variant="primary" onClick={retryMoreRecipes}>
              Try again
            </Button>
            <Button variant="secondary" onClick={goToGoalEntry}>
              Set a new goal
            </Button>
          </div>
        </DeckState>
      );
    }

    if (hasMore || isLoadingMore) {
      return (
        <DeckState title="Finding more matches" busy>
          Loading the next recipes in your deck...
        </DeckState>
      );
    }

    return (
      <DeckState title="You've reached the end of this deck" headingRef={stateHeadingRef}>
        <p>Set a new food goal whenever you want to build a different deck.</p>
        <Button variant="primary" onClick={goToGoalEntry}>
          Set a new goal
        </Button>
      </DeckState>
    );
  }

  const progressPercent =
    recipes.length > 0
      ? Math.min(100, Math.max(6, Math.round(((currentIndex + 1) / recipes.length) * 100)))
      : 0;

  return (
    <main className="swipe-deck-page">
      <header className="deck-header">
        <div className="deck-header-lead">
          <BrandLogo className="deck-brand" />
          <h1>Swipe your matches</h1>
          <p className="deck-progress" role="status" aria-live="polite" aria-atomic="true">
            Match {currentIndex + 1}: {currentRecipe.title || "Untitled recipe"}
          </p>
          <div
            className="deck-progress-track"
            aria-hidden="true"
            style={{ "--deck-progress": `${progressPercent}%` }}
          >
            <span className="deck-progress-fill" />
          </div>
        </div>
        <div className="deck-header-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={goToLikedRecipes}
            disabled={isSwiping}
            leftIcon={<HeartGlyph />}
          >
            Liked recipes
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={changeGoal}
            disabled={isSwiping}
          >
            Change goal
          </Button>
        </div>
      </header>

      <section
        className="deck-workspace"
        aria-label="Recipe swipe deck"
        aria-busy={isSwiping || isLoadingMore || undefined}
      >
        <div className="deck-card-stage">
          {nextRecipe ? (
            <article key={nextRecipe.id} className="recipe-card recipe-card-next" aria-hidden="true">
              <RecipeCardContent recipe={nextRecipe} />
            </article>
          ) : null}

          <SwipeableRecipeCard
            key={currentRecipe.id}
            recipe={currentRecipe}
            swipeRequest={swipeRequest}
            disabled={isSwiping}
            onSwipeStart={handleSwipeStart}
            onSwipeComplete={completeSwipe}
            onSwipeSettled={handleSwipeSettled}
          />
        </div>

        <div className="deck-actions" aria-label="Swipe actions">
          <motion.button
            type="button"
            className="deck-skip-button"
            onClick={() => requestSwipe("left")}
            disabled={isSwiping}
            aria-label="Skip recipe"
            whileHover={{ y: -3 }}
            whileTap={{ scale: 0.92 }}
            transition={{ type: "spring", stiffness: 480, damping: 24 }}
          >
            <span className="deck-action-ring" aria-hidden="true" />
            <span className="deck-action-icon" aria-hidden="true">
              <CrossGlyph />
            </span>
            <span className="deck-action-label">Skip</span>
          </motion.button>

          <motion.button
            type="button"
            className="deck-like-button"
            onClick={() => requestSwipe("right")}
            disabled={isSwiping}
            aria-label="Like recipe"
            whileHover={{ y: -3 }}
            whileTap={{ scale: 0.92 }}
            transition={{ type: "spring", stiffness: 480, damping: 24 }}
          >
            <span className="deck-action-ring" aria-hidden="true" />
            <span className="deck-action-icon" aria-hidden="true">
              <HeartGlyph />
            </span>
            <span className="deck-action-label">Like</span>
          </motion.button>
        </div>

        {isSwiping ? (
          <p className="deck-swipe-status" aria-live="polite">
            Saving your swipe...
          </p>
        ) : null}
        {swipeError ? <p className="deck-swipe-error" role="alert">{swipeError}</p> : null}
        {loadMoreError ? (
          <div className="deck-load-more-error" role="alert">
            <p>{loadMoreError}</p>
            <Button variant="secondary" size="sm" onClick={retryMoreRecipes}>
              Retry more matches
            </Button>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function DeckState({ title, children, busy = false, role, headingRef }) {
  return (
    <main className="swipe-deck-page swipe-deck-state-page">
      <section
        className="deck-state-panel"
        aria-live={busy ? "polite" : undefined}
        aria-busy={busy || undefined}
        role={role}
      >
        <BrandLogo className="deck-state-brand" />
        <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>{title}</h1>
        {typeof children === "string" ? <p>{children}</p> : children}
      </section>
    </main>
  );
}

function SwipeableRecipeCard({ recipe, swipeRequest, disabled, onSwipeStart, onSwipeComplete, onSwipeSettled }) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-240, 0, 240], [-8, 0, 8]);
  const likeStampOpacity = useTransform(x, [30, 130], [0, 1]);
  const skipStampOpacity = useTransform(x, [-130, -30], [1, 0]);
  const cardGlow = useTransform(
    x,
    [-150, 0, 150],
    [
      "0 30px 78px rgba(141, 37, 31, 0.42)",
      "var(--shadow-card)",
      "0 30px 78px rgba(32, 70, 45, 0.45)",
    ],
  );
  const prefersReducedMotion = useReducedMotion();
  const isAnimatingRef = useRef(false);
  const handledRequestNumberRef = useRef(0);
  const cardRef = useRef(null);

  useEffect(() => {
    x.set(0);
    isAnimatingRef.current = false;
  }, [recipe.id, x]);

  const flyAway = useCallback(async (direction) => {
    if (isAnimatingRef.current) return;
    isAnimatingRef.current = true;
    onSwipeStart();

    const cardWidth = cardRef.current?.getBoundingClientRect().width || 430;
    const distance = getFlyOutDistance(window.innerWidth, cardWidth);
    const targetX = direction === "right" ? distance : -distance;

    try {
      if (prefersReducedMotion) x.set(targetX);
      else await animate(x, targetX, { duration: 0.28, ease: "easeIn" });

      const didComplete = await onSwipeComplete(direction, recipe);
      if (!didComplete) {
        if (prefersReducedMotion) x.set(0);
        else await animate(x, 0, { type: "spring", stiffness: 360, damping: 28 });
        isAnimatingRef.current = false;
        onSwipeSettled();
      }
    } catch {
      isAnimatingRef.current = false;
      onSwipeSettled();
    }
  }, [onSwipeComplete, onSwipeSettled, onSwipeStart, prefersReducedMotion, recipe, x]);

  useEffect(() => {
    if (
      !swipeRequest ||
      swipeRequest.recipeId !== recipe.id ||
      swipeRequest.requestNumber === handledRequestNumberRef.current ||
      isAnimatingRef.current
    ) {
      return;
    }
    handledRequestNumberRef.current = swipeRequest.requestNumber;
    void flyAway(swipeRequest.direction);
  }, [flyAway, recipe.id, swipeRequest]);

  function snapBack() {
    if (prefersReducedMotion) x.set(0);
    else void animate(x, 0, { type: "spring", stiffness: 360, damping: 28 });
  }

  function handleDragEnd(_event, info) {
    const direction = getSwipeDirection(info.offset.x);
    if (direction) void flyAway(direction);
    else snapBack();
  }

  const titleId = `recipe-${recipe.id}-title`;
  return (
    <motion.article
      ref={cardRef}
      className="recipe-card recipe-card-active"
      aria-labelledby={titleId}
      drag={disabled ? false : "x"}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.25}
      dragMomentum={false}
      initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.96, y: 18 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: prefersReducedMotion ? 0 : 0.22, ease: "easeOut" }}
      style={{ x, rotate, boxShadow: cardGlow }}
      onDragEnd={handleDragEnd}
    >
      <motion.div
        className="recipe-card-stamp recipe-card-stamp-like"
        style={{ opacity: likeStampOpacity }}
        aria-hidden="true"
      >
        Love it
      </motion.div>
      <motion.div
        className="recipe-card-stamp recipe-card-stamp-skip"
        style={{ opacity: skipStampOpacity }}
        aria-hidden="true"
      >
        Nope
      </motion.div>
      <RecipeCardContent recipe={recipe} titleId={titleId} />
    </motion.article>
  );
}

function RecipeCardContent({ recipe, titleId }) {
  const macros = recipe.macros && typeof recipe.macros === "object" && !Array.isArray(recipe.macros) ? recipe.macros : {};
  const title = typeof recipe.title === "string" && recipe.title.trim() ? recipe.title.trim() : "Untitled recipe";
  const servings = formatServings(recipe.servings);
  const ingredients = getRecipeTextList(recipe.ingredients);
  const instructions = getRecipeTextList(recipe.instructions);
  const sourceUrl = getSafeHttpUrl(recipe.sourceUrl);
  const sourceName =
    typeof recipe.sourceName === "string" && recipe.sourceName.trim()
      ? recipe.sourceName.trim()
      : "Original recipe";
  const showLegacyMetadataFallback = Boolean(recipe.legacyMetadataFallback);

  return (
    <>
      <div className="recipe-card-image-panel">
        <RecipeCardImage image={recipe.image} title={title} />
      </div>

      <div className="recipe-card-details">
        <header className="recipe-card-summary">
          <p className="recipe-card-label">Current recipe</p>
          <h2 id={titleId}>{title}</h2>
          <p className="recipe-card-meta">
            {[formatTime(recipe.readyInMinutes), servings].filter(Boolean).join(" - ")}
          </p>
          {showLegacyMetadataFallback ? <p className="recipe-card-meta">
            {formatTime(recipe.readyInMinutes)}{servings ? ` Â· ${servings}` : ""}
          </p> : null}
        </header>

        <div className="recipe-card-nutrition" aria-label="Nutrition per serving">
          <strong>{formatCalories(recipe.calories)}</strong>
          <span>{formatMacro(macros.protein_g)} protein</span>
          <small>{formatMacro(macros.carbs_g)} carbs / {formatMacro(macros.fat_g)} fat</small>
          <small className="recipe-card-serving-note">Per serving</small>
        </div>
        <RecipeTextSection
          title="Ingredients"
          emptyText="Ingredients unavailable for this recipe."
          items={ingredients}
        />
        <RecipeTextSection
          title="Instructions"
          emptyText="Instructions unavailable for this recipe."
          items={instructions}
          ordered
        />

        <footer className="recipe-card-source">
          {sourceUrl ? (
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
              Source: {sourceName}
            </a>
          ) : (
            <span>Source unavailable</span>
          )}
        </footer>
        {showLegacyMetadataFallback ? <div className="recipe-card-legacy-meta" hidden>
          <h2>{title}</h2>
          <p className="recipe-card-meta">
            {formatTime(recipe.readyInMinutes)}{servings ? ` · ${servings}` : ""}
          </p>
        </div> : null}
      </div>
    </>
  );
}

function getRecipeTextList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
}

function RecipeTextSection({ title, emptyText, items, ordered = false }) {
  const listId = `recipe-card-${title.toLowerCase()}`;
  const ListTag = ordered ? "ol" : "ul";

  return (
    <section className="recipe-card-text-section" aria-labelledby={listId}>
      <h3 id={listId}>{title}</h3>
      {items.length > 0 ? (
        <ListTag>
          {items.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ListTag>
      ) : (
        <p>{emptyText}</p>
      )}
    </section>
  );
}

function RecipeCardImage({ image, title }) {
  const imageUrl = normalizeImageUrl(image);
  const [imageFailed, setImageFailed] = useState(false);

  if (!imageUrl || imageFailed) {
    return <div className="recipe-card-image-fallback" role="img" aria-label={`${title} image unavailable`}>Recipe image unavailable</div>;
  }

  return <img src={imageUrl} alt={title} className="recipe-card-image" draggable="false" onError={() => setImageFailed(true)} />;
}

function CrossGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" focusable="false">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function HeartGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" focusable="false">
      <path
        d="M12 20.5l-1.45-1.32C5.4 14.5 2 11.4 2 7.6 2 4.9 4.1 2.8 6.8 2.8c1.5 0 2.98.7 3.96 1.82L12 5.9l1.24-1.28A5.36 5.36 0 0117.2 2.8C19.9 2.8 22 4.9 22 7.6c0 3.8-3.4 6.9-8.55 11.58L12 20.5z"
        fill="currentColor"
      />
    </svg>
  );
}

export default SwipeDeckPage;

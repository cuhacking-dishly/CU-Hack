import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { getRecipeById } from "../api/client.js";
import Button from "../components/Button.jsx";
import BrandLogo from "../components/BrandLogo.jsx";
import { getSafeHttpUrl, isUsableRecipe, normalizeRecipeId } from "../utils/recipe.js";
import "./RecipeDetailPage.css";

// Shared scroll-reveal preset. Sections enter from the side once as they enter view.
const REVEAL = {
  initial: { opacity: 0, x: 30 },
  whileInView: { opacity: 1, x: 0 },
  viewport: { once: true, amount: 0.2 },
  transition: { duration: 0.55, ease: [0.16, 1, 0.3, 1] },
};

// Named variants for staggered children (diet chips, nutrition stat cards).
const STAGGER_CONTAINER = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
};

const STAGGER_ITEM = {
  hidden: { opacity: 0, x: 14 },
  show: { opacity: 1, x: 0, transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] } },
};

// Stat cards fade only — no transform. A transformed element establishes a
// containing block that makes Chromium count the (intentionally huge) number in
// `scrollWidth`, which the giant-number containment e2e guards against.
const STAT_FADE = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
};

const MAX_PUBLIC_ERROR_LENGTH = 200;

const NUTRITION_STATS = [
  { key: "calories", label: "Calories", unit: "kcal", tone: "coral" },
  { key: "protein_g", label: "Protein", unit: "g", tone: "green" },
  { key: "carbs_g", label: "Carbs", unit: "g", tone: "gold" },
  { key: "fat_g", label: "Fat", unit: "g", tone: "blue" },
];

function getPublicErrorMessage(error) {
  const serverMessage = error?.response?.data?.error;

  if (typeof serverMessage === "string") {
    const normalizedMessage = serverMessage.replace(/\s+/g, " ").trim();

    if (normalizedMessage && normalizedMessage.length <= MAX_PUBLIC_ERROR_LENGTH) {
      return normalizedMessage;
    }
  }

  return "We couldn't load this recipe. Please try again.";
}

function getNutritionReading(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "N/A";
  }

  return Math.round(value).toString();
}

function getMetadata(recipe) {
  const items = [];

  if (
    typeof recipe.readyInMinutes === "number" &&
    Number.isFinite(recipe.readyInMinutes) &&
    recipe.readyInMinutes >= 0
  ) {
    items.push(`${Math.round(recipe.readyInMinutes)} min`);
  }

  if (typeof recipe.servings === "number" && Number.isFinite(recipe.servings)) {
    const servings = Math.round(recipe.servings);

    if (servings > 0) {
      items.push(`${servings} ${servings === 1 ? "serving" : "servings"}`);
    }
  }

  return items.join(" - ");
}

function formatDietLabel(value) {
  return value
    .toLocaleLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toLocaleUpperCase())
    .replace(/\bFodmap\b/g, "FODMAP");
}

function getDietLabels(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const labels = [];

  for (const candidate of value) {
    if (typeof candidate !== "string") {
      continue;
    }

    const diet = candidate.trim();
    const key = diet.toLocaleLowerCase();

    if (!diet || seen.has(key)) {
      continue;
    }

    seen.add(key);
    labels.push(formatDietLabel(diet));
  }

  return labels;
}

function getRecipeTextList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
}

function getRouteStateRecipe(state, recipeId) {
  const candidate = state?.recipe;
  return isUsableRecipe(candidate) && candidate.id === recipeId ? candidate : null;
}

function RecipeDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const recipeId = normalizeRecipeId(id);
  const routeStateRecipe = getRouteStateRecipe(location.state, recipeId);
  const [recipe, setRecipe] = useState(routeStateRecipe);
  const [isLoading, setIsLoading] = useState(!routeStateRecipe);
  const [errorMessage, setErrorMessage] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const errorHeadingRef = useRef(null);

  useEffect(() => {
    let isCurrentRequest = true;
    const controller = new AbortController();
    let requestTimer;

    setIsLoading(true);
    setErrorMessage("");
    setRecipe(null);

    if (!recipeId) {
      setErrorMessage(id ? "This recipe link is invalid." : "This recipe link is incomplete.");
      setIsLoading(false);

      return () => {
        isCurrentRequest = false;
        controller.abort();
      };
    }

    if (routeStateRecipe) {
      setRecipe(routeStateRecipe);
      setIsLoading(false);
      return () => {
        isCurrentRequest = false;
        controller.abort();
      };
    }

    async function loadRecipe() {
      try {
        const response = await getRecipeById(recipeId, { signal: controller.signal });
        const isRecipe =
          isUsableRecipe(response) && normalizeRecipeId(response.id) === recipeId;

        if (!isCurrentRequest) {
          return;
        }

        if (!isRecipe) {
          setErrorMessage("The recipe service returned incomplete details. Please try again.");
          return;
        }

        setRecipe(response);
      } catch (error) {
        if (isCurrentRequest && !controller.signal.aborted) {
          setErrorMessage(getPublicErrorMessage(error));
        }
      } finally {
        if (isCurrentRequest) {
          setIsLoading(false);
        }
      }
    }

    // Strict Mode cleans up its first effect before this task starts, avoiding a duplicate request.
    requestTimer = window.setTimeout(() => {
      void loadRecipe();
    }, 0);

    return () => {
      isCurrentRequest = false;
      window.clearTimeout(requestTimer);
      controller.abort();
    };
  }, [id, location.state, recipeId, retryCount, routeStateRecipe]);

  useEffect(() => {
    if (isLoading || !errorMessage) return undefined;

    const frame = window.requestAnimationFrame(() => {
      errorHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [errorMessage, isLoading]);

  function retryRecipe() {
    setIsLoading(true);
    setErrorMessage("");
    setRetryCount((count) => count + 1);
  }

  if (isLoading) {
    return (
      <main className="recipe-detail-page recipe-detail-state-page" aria-busy="true">
        <section
          className="recipe-detail-state"
          role="status"
          aria-live="polite"
          aria-labelledby="recipe-loading-title"
        >
          <p className="recipe-detail-eyebrow">Dishly</p>
          <h1 id="recipe-loading-title">Loading your recipe</h1>
          <p>Getting the full nutrition details ready...</p>
        </section>
      </main>
    );
  }

  if (errorMessage || !recipe) {
    return (
      <main className="recipe-detail-page recipe-detail-state-page">
        <section
          className="recipe-detail-state"
          role="alert"
          aria-labelledby="recipe-error-title"
        >
          <p className="recipe-detail-eyebrow">Recipe unavailable</p>
          <h1 id="recipe-error-title" ref={errorHeadingRef} tabIndex="-1">
            Couldn't load this recipe
          </h1>
          <p>{errorMessage || "This recipe is unavailable."}</p>
          <div className="recipe-detail-state-actions">
            {recipeId ? (
              <Button className="recipe-detail-retry-button" onClick={retryRecipe}>
                Try again
              </Button>
            ) : null}
            <Link className="recipe-detail-secondary-link" to="/deck">
              <span aria-hidden="true">&larr;</span>
              Back to the deck
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return <LoadedRecipe recipe={recipe} />;
}

function LoadedRecipe({ recipe }) {
  const headingRef = useRef(null);
  const title =
    typeof recipe.title === "string" && recipe.title.trim()
      ? recipe.title.trim()
      : "Untitled recipe";
  const metadata = getMetadata(recipe);
  const diets = getDietLabels(recipe.diets);
  const sourceUrl = getSafeHttpUrl(recipe.sourceUrl);
  const sourceName =
    typeof recipe.sourceName === "string" && recipe.sourceName.trim()
      ? recipe.sourceName.trim()
      : "Original recipe";
  const ingredients = getRecipeTextList(recipe.ingredients);
  const instructions = getRecipeTextList(recipe.instructions);
  const macros = recipe.macros && typeof recipe.macros === "object" ? recipe.macros : {};
  const nutrition = {
    calories: recipe.calories,
    protein_g: macros.protein_g,
    carbs_g: macros.carbs_g,
    fat_g: macros.fat_g,
  };

  useEffect(() => {
    document.title = "dishly";
    headingRef.current?.focus({ preventScroll: true });
  }, [title]);

  return (
    <main className="recipe-detail-page">
      <div className="recipe-detail-shell">
        <motion.nav
          className="recipe-detail-nav"
          aria-label="Recipe navigation"
          initial={{ opacity: 0, x: -28 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <Link className="recipe-detail-back-link" to="/deck">
            <span aria-hidden="true">&larr;</span>
            Keep swiping
          </Link>
          <BrandLogo className="recipe-detail-brand" />
        </motion.nav>

        <article className="recipe-detail-article">
          <RecipeHeroImage key={`${recipe.id}-${recipe.image || "no-image"}`} image={recipe.image} title={title} />

          <div className="recipe-detail-content">
            <motion.header className="recipe-detail-header" {...REVEAL}>
              <p className="recipe-detail-eyebrow">Your recipe match</p>
              <h1 ref={headingRef} tabIndex="-1">
                {title}
              </h1>

              {metadata ? <p className="recipe-detail-metadata">{metadata}</p> : null}

              {diets.length > 0 ? (
                <motion.ul
                  className="recipe-detail-diets"
                  aria-label="Recipe diets"
                  variants={STAGGER_CONTAINER}
                  initial="hidden"
                  whileInView="show"
                  viewport={{ once: true, amount: 0.4 }}
                >
                  {diets.map((diet) => (
                    <motion.li key={diet} variants={STAGGER_ITEM}>
                      {diet}
                    </motion.li>
                  ))}
                </motion.ul>
              ) : null}
            </motion.header>

            <motion.section
              className="recipe-detail-nutrition"
              aria-labelledby="nutrition-title"
              aria-describedby="nutrition-serving-note"
              {...REVEAL}
            >
              <div className="recipe-detail-nutrition-heading">
                <p id="nutrition-serving-note">Nutrition per serving</p>
                <h2 id="nutrition-title">The numbers behind your match</h2>
              </div>

              <motion.dl
                className="recipe-detail-nutrition-grid"
                variants={STAGGER_CONTAINER}
                initial="hidden"
                whileInView="show"
                viewport={{ once: true, amount: 0.3 }}
              >
                {NUTRITION_STATS.map((stat) => {
                  const reading = getNutritionReading(nutrition[stat.key]);

                  return (
                    <motion.div
                      className={`recipe-detail-stat recipe-detail-stat-${stat.tone}`}
                      key={stat.key}
                      variants={STAT_FADE}
                    >
                      <dt>{stat.label}</dt>
                      <dd>
                        <strong>{reading}</strong>
                        {reading !== "N/A" ? <span>{stat.unit}</span> : null}
                      </dd>
                    </motion.div>
                  );
                })}
              </motion.dl>
            </motion.section>

            <motion.div className="recipe-detail-written-recipe" {...REVEAL}>
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
            </motion.div>

            <motion.footer className="recipe-detail-actions" {...REVEAL}>
              {sourceUrl ? (
                <a
                  className="recipe-detail-source-link"
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Source: ${sourceName}. Opens in a new tab.`}
                >
                  Source: {sourceName}
                  <span aria-hidden="true">↗</span>
                </a>
              ) : (
                <p className="recipe-detail-source-unavailable">Source unavailable.</p>
              )}

              <Link className="recipe-detail-secondary-link" to="/deck">
                Back to recipe deck
              </Link>
            </motion.footer>
          </div>
        </article>
      </div>
    </main>
  );
}

function RecipeTextSection({ title, emptyText, items, ordered = false }) {
  const sectionId = `recipe-detail-${title.toLowerCase()}`;
  const ListTag = ordered ? "ol" : "ul";

  return (
    <section className="recipe-detail-text-section" aria-labelledby={sectionId}>
      <h2 id={sectionId}>{title}</h2>
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

function RecipeHeroImage({ image, title }) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = getSafeHttpUrl(image);

  if (!imageUrl || imageFailed) {
    return (
      <div
        className="recipe-detail-image-fallback"
        role="img"
        aria-label={`${title} image unavailable`}
      >
        <span>Recipe image unavailable</span>
      </div>
    );
  }

  return (
    <img
      className="recipe-detail-image"
      src={imageUrl}
      alt={title}
      decoding="async"
      fetchPriority="high"
      onError={() => setImageFailed(true)}
    />
  );
}

export default RecipeDetailPage;

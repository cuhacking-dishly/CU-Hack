import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { parseGoal, saveGoal } from "../api/client.js";
import BrandLogo from "../components/BrandLogo.jsx";
import { USER_ID } from "../constants.js";
import { clearDeckSessions } from "../utils/deckSession.js";
import {
  applyNutritionTargets,
  createNutritionGoalText,
  hasNutritionTargetInput,
} from "../utils/nutritionFilters.js";
import {
  applyMealType,
  createMealTypeGoalText,
  createNaturalLanguageGoalText,
  hasNaturalLanguageFilterInput,
  MAX_AUXILIARY_FILTER_LENGTH,
  MEAL_CATEGORY_OPTIONS,
} from "../utils/naturalLanguageGoal.js";
import "./GoalEntryPage.css";

const MAX_GOAL_LENGTH = 1000;
const MAX_PUBLIC_ERROR_LENGTH = 200;
const QUICK_OPTIONS = [
  "Quick Dinner",
  "High Protein",
  "Plant-Based",
  "Under 30 Minutes",
  "Low Carb",
  "Comfort Food",
  "Family-Friendly",
  "Meal Prep",
  "One-Pot",
];
const EASE_OUT = [0.16, 1, 0.3, 1];

const heroVariants = {
  hidden: {},
  visible: {
    transition: { delayChildren: 0.08, staggerChildren: 0.075 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, x: -28 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.62, ease: EASE_OUT },
  },
};

const rightItemVariants = {
  hidden: { opacity: 0, x: 28 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.58, ease: EASE_OUT },
  },
};

const dropdownVariants = {
  hidden: { opacity: 0, scale: 0.96, x: 14, filter: "blur(6px)" },
  visible: {
    opacity: 1,
    scale: 1,
    x: 0,
    filter: "blur(0px)",
    transition: { duration: 0.28, ease: EASE_OUT, when: "beforeChildren", staggerChildren: 0.045 },
  },
  exit: {
    opacity: 0,
    scale: 0.97,
    x: 10,
    filter: "blur(4px)",
    transition: { duration: 0.18, ease: "easeIn" },
  },
};

const dropdownItemVariants = {
  hidden: { opacity: 0, x: 12 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.24, ease: EASE_OUT } },
};

function getPublicErrorMessage(error) {
  const serverMessage = error?.response?.data?.error;

  if (typeof serverMessage === "string") {
    const normalizedMessage = serverMessage.replace(/\s+/g, " ").trim();

    if (normalizedMessage && normalizedMessage.length <= MAX_PUBLIC_ERROR_LENGTH) {
      return normalizedMessage;
    }
  }

  return "We couldn't create your recipe matches. Please try again.";
}

function GoalEntryPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const prefersReducedMotion = useReducedMotion();
  const [goalText, setGoalText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [nutritionTargets, setNutritionTargets] = useState({
    calories: "",
    protein: "",
    carbs: "",
  });
  const [cultureText, setCultureText] = useState("");
  const [allergyText, setAllergyText] = useState("");
  const [mealType, setMealType] = useState("");
  const isSubmittingRef = useRef(false);
  const isMountedRef = useRef(true);
  const submissionControllerRef = useRef(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      submissionControllerRef.current?.abort();
    };
  }, []);

  const trimmedGoal = goalText.trim();
  const hasNutritionInput = hasNutritionTargetInput(nutritionTargets);
  const hasNaturalLanguageFilters = hasNaturalLanguageFilterInput({ cultureText, allergyText });
  const canSubmit =
    (trimmedGoal.length > 0 || hasNutritionInput || hasNaturalLanguageFilters || mealType) && !isSubmitting;

  useEffect(() => {
    if (!isFilterOpen) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape") setIsFilterOpen(false);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFilterOpen]);

  async function handleSubmit(event) {
    event.preventDefault();

    if ((!trimmedGoal && !hasNutritionInput && !hasNaturalLanguageFilters && !mealType) || isSubmittingRef.current) {
      return;
    }

    const preliminaryNutritionFilter = applyNutritionTargets({}, nutritionTargets);
    if (preliminaryNutritionFilter.error) {
      setErrorMessage(preliminaryNutritionFilter.error);
      return;
    }
    const naturalGoal = createNaturalLanguageGoalText({ goalText, cultureText, allergyText });
    if (naturalGoal.error) {
      setErrorMessage(naturalGoal.error);
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setErrorMessage("");
    const controller = new AbortController();
    submissionControllerRef.current = controller;

    try {
      let parsedFilter = {};
      const rawText =
        naturalGoal.text ||
        [createNutritionGoalText(nutritionTargets), createMealTypeGoalText(mealType)]
          .filter(Boolean)
          .join(" · ");

      if (!rawText) {
        throw new Error("The nutrition targets did not produce a valid goal.");
      }

      if (naturalGoal.text) {
        const parsedGoal = await parseGoal(naturalGoal.text, { signal: controller.signal });
        parsedFilter = parsedGoal?.parsedFilter;

        if (!parsedFilter || typeof parsedFilter !== "object" || Array.isArray(parsedFilter)) {
          throw new Error("The goal parser returned an invalid response.");
        }
      }

      const nutritionFilter = applyNutritionTargets(parsedFilter, nutritionTargets);
      const filter = applyMealType(nutritionFilter.filter, mealType);
      await saveGoal(USER_ID, rawText, filter, { signal: controller.signal });
      if (isMountedRef.current && !controller.signal.aborted) {
        clearDeckSessions(USER_ID);
        navigate("/deck");
      }
    } catch (error) {
      if (isMountedRef.current && !controller.signal.aborted) {
        setErrorMessage(getPublicErrorMessage(error));
        setIsSubmitting(false);
      }
    } finally {
      if (submissionControllerRef.current === controller) submissionControllerRef.current = null;
      isSubmittingRef.current = false;
    }
  }

  function handleGoalChange(event) {
    setGoalText(event.target.value.slice(0, MAX_GOAL_LENGTH));

    if (errorMessage) {
      setErrorMessage("");
    }
  }

  function handleNutritionTargetChange(event) {
    const { name, value } = event.target;
    setNutritionTargets((currentTargets) => ({ ...currentTargets, [name]: value }));

    if (errorMessage) {
      setErrorMessage("");
    }
  }

  function handleCultureChange(event) {
    setCultureText(event.target.value.slice(0, MAX_AUXILIARY_FILTER_LENGTH));
    if (errorMessage) setErrorMessage("");
  }

  function handleMealTypeChange(selectedMealType) {
    setMealType(selectedMealType);
    if (errorMessage) setErrorMessage("");
  }

  function handleAllergyChange(event) {
    setAllergyText(event.target.value.slice(0, MAX_AUXILIARY_FILTER_LENGTH));
    if (errorMessage) setErrorMessage("");
  }

  const describedBy = [
    isSubmitting ? "goal-entry-status" : null,
    errorMessage ? "goal-entry-error" : null,
  ]
    .filter(Boolean)
    .join(" ");
  const returnToDeck = location.state?.returnTo === "/deck";

  function choosePrompt(prompt) {
    if (isSubmitting) return;
    setGoalText(prompt);
    setErrorMessage("");
    setIsFilterOpen(false);
  }

  return (
    <motion.main
      className="goal-entry-page"
      initial="hidden"
      animate="visible"
      variants={heroVariants}
    >
      <div className="goal-entry-backdrop" aria-hidden="true" />
      <div className="goal-entry-scrim" aria-hidden="true" />

      <header className="goal-entry-header">
        {returnToDeck ? (
          <motion.button
            className="goal-entry-return"
            type="button"
            onClick={() => navigate("/deck")}
            variants={rightItemVariants}
            whileHover={prefersReducedMotion ? undefined : { y: -2 }}
            whileTap={prefersReducedMotion ? undefined : { scale: 0.96 }}
          >
            <BackArrow />
            <span>Back to deck</span>
          </motion.button>
        ) : null}
      </header>

      <motion.section
        className={isFilterOpen ? "goal-entry-panel is-filter-open" : "goal-entry-panel"}
        aria-labelledby="goal-entry-title"
        variants={heroVariants}
      >
        <h1 className="sr-only" id="goal-entry-title">Dishly recipe search</h1>
        <motion.div className="goal-entry-logo-lockup" variants={itemVariants}>
          <BrandLogo className="goal-entry-hero-brand" src="/images/dishly-logo-hero.png" />
        </motion.div>
        <motion.form className="goal-entry-form" noValidate onSubmit={handleSubmit} variants={itemVariants}>
          <div className="goal-entry-label-row">
            <label htmlFor="goal-input">Your food goal</label>
          </div>
          <div className="goal-entry-search-cluster">
            <motion.div
              className="goal-entry-row"
              animate={isSubmitting ? "submitting" : "ready"}
              variants={{ ready: { scale: 1 }, submitting: { scale: 0.99 } }}
              transition={{ type: "spring", stiffness: 360, damping: 30 }}
            >
              <SearchGlyph />
              <input
                id="goal-input"
                type="text"
                value={goalText}
                onChange={handleGoalChange}
                placeholder="What are you craving?"
                maxLength={MAX_GOAL_LENGTH}
                autoComplete="off"
                disabled={isSubmitting}
                aria-describedby={describedBy || undefined}
                aria-invalid={errorMessage ? "true" : undefined}
              />
              <motion.button
                className={isFilterOpen ? "goal-entry-filter-toggle is-open" : "goal-entry-filter-toggle"}
                type="button"
                onClick={() => setIsFilterOpen((isOpen) => !isOpen)}
                disabled={isSubmitting}
                aria-expanded={isFilterOpen}
                aria-controls="recipe-filter-panel"
                aria-label={isFilterOpen ? "Close recipe filters" : "Open recipe filters"}
                whileHover={!isSubmitting && !prefersReducedMotion ? { y: -2, rotate: 4 } : undefined}
                whileTap={!isSubmitting && !prefersReducedMotion ? { scale: 0.92 } : undefined}
                transition={{ type: "spring", stiffness: 480, damping: 26 }}
              >
                <TuneGlyph />
              </motion.button>
              <motion.button
                className="goal-entry-submit"
                type="submit"
                disabled={!canSubmit}
                aria-busy={isSubmitting}
                aria-label={isSubmitting ? "Finding matches..." : "Start swiping"}
                whileHover={canSubmit && !prefersReducedMotion ? { y: -2, scale: 1.03 } : undefined}
                whileTap={canSubmit && !prefersReducedMotion ? { scale: 0.93 } : undefined}
                transition={{ type: "spring", stiffness: 440, damping: 25 }}
              >
                {isSubmitting ? <LoadingGlyph /> : <ArrowGlyph />}
                <span className="sr-only">{isSubmitting ? "Finding matches..." : "Start swiping"}</span>
              </motion.button>
            </motion.div>

            <AnimatePresence>
              {isFilterOpen ? (
                <motion.section
                  className="nutrition-filter"
                  id="recipe-filter-panel"
                  aria-label="Recipe preferences, nutrition targets, and quick recipe picks"
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  variants={dropdownVariants}
                >
                  <motion.div className="preference-filter-section" variants={dropdownItemVariants}>
                    <div className="nutrition-filter-heading">
                      <div>
                        <p>Recipe preferences</p>
                        <span>Describe a culture or allergy in your own words; we’ll interpret it before searching.</span>
                      </div>
                      <span className="nutrition-filter-badge">Optional</span>
                    </div>

                    <div className="natural-language-filter-inputs">
                      <label className="natural-language-filter-input" htmlFor="culture-filter">
                        <span>Culture / cuisine</span>
                        <input
                          id="culture-filter"
                          type="text"
                          value={cultureText}
                          onChange={handleCultureChange}
                          placeholder="e.g. Chinese or Italian"
                          maxLength={MAX_AUXILIARY_FILTER_LENGTH}
                          disabled={isSubmitting}
                          aria-describedby="natural-language-filter-help"
                        />
                      </label>
                    </div>

                    <div className="natural-language-filter-inputs">
                      <label className="natural-language-filter-input" htmlFor="allergy-filter">
                        <span>Allergies / ingredients to avoid</span>
                        <input
                          id="allergy-filter"
                          type="text"
                          value={allergyText}
                          onChange={handleAllergyChange}
                          placeholder="e.g. strawberries, alpha-gal"
                          maxLength={MAX_AUXILIARY_FILTER_LENGTH}
                          disabled={isSubmitting}
                          aria-describedby="natural-language-filter-help"
                        />
                      </label>
                    </div>

                    <p className="natural-language-filter-help" id="natural-language-filter-help">
                      Name multiple cultures and any allergy or ingredient—we’ll interpret them into recipe filters and exclusions.
                    </p>
                    <p className="allergy-verification-note">
                      Always check each recipe’s ingredient labels and cross-contact information before eating.
                    </p>

                    <fieldset className="meal-type-filter" disabled={isSubmitting}>
                      <legend>Meal type</legend>
                      <div role="radiogroup" aria-label="Meal type">
                        {MEAL_CATEGORY_OPTIONS.map(({ value, label }) => {
                          const selected = mealType === value;
                          return (
                            <button
                              key={value || "any"}
                              className={selected ? "is-selected" : ""}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              onClick={() => handleMealTypeChange(value)}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </fieldset>
                  </motion.div>

                  <motion.div className="nutrition-filter-heading" variants={dropdownItemVariants}>
                    <div>
                      <p>Nutrition targets</p>
                      <span id="nutrition-filter-help">Per serving, matched within ±20%.</span>
                    </div>
                    <span className="nutrition-filter-badge">Optional</span>
                  </motion.div>
                  <motion.div className="nutrition-filter-inputs" variants={dropdownItemVariants}>
                    <NutritionTargetInput
                      id="nutrition-calories"
                      label="Calories"
                      name="calories"
                      value={nutritionTargets.calories}
                      onChange={handleNutritionTargetChange}
                      max="10000"
                      suffix="kcal"
                      disabled={isSubmitting}
                    />
                    <NutritionTargetInput
                      id="nutrition-protein"
                      label="Protein"
                      name="protein"
                      value={nutritionTargets.protein}
                      onChange={handleNutritionTargetChange}
                      max="500"
                      suffix="g"
                      disabled={isSubmitting}
                    />
                    <NutritionTargetInput
                      id="nutrition-carbs"
                      label="Carbs"
                      name="carbs"
                      value={nutritionTargets.carbs}
                      onChange={handleNutritionTargetChange}
                      max="1000"
                      suffix="g"
                      disabled={isSubmitting}
                    />
                  </motion.div>
                  <motion.div className="goal-entry-prompts" variants={dropdownItemVariants}>
                    <p>Quick picks</p>
                    <div aria-label="Recipe goal examples">
                      {QUICK_OPTIONS.map((prompt) => (
                        <motion.button
                          key={prompt}
                          type="button"
                          onClick={() => choosePrompt(prompt)}
                          disabled={isSubmitting}
                          whileHover={prefersReducedMotion ? undefined : { y: -2, scale: 1.02 }}
                          whileTap={prefersReducedMotion ? undefined : { scale: 0.96 }}
                          transition={{ type: "spring", stiffness: 520, damping: 28 }}
                        >
                          {prompt}
                        </motion.button>
                      ))}
                    </div>
                  </motion.div>
                </motion.section>
              ) : null}
            </AnimatePresence>
          </div>

          {isSubmitting ? (
            <p className="goal-entry-status" id="goal-entry-status" role="status">
              {trimmedGoal || hasNaturalLanguageFilters
                ? "Interpreting your craving and tuning your recipe feed..."
                : "Saving your recipe filters and tuning your recipe feed..."}
            </p>
          ) : null}

          {errorMessage ? (
            <p className="goal-entry-error" id="goal-entry-error" role="alert">
              {errorMessage}
            </p>
          ) : null}
        </motion.form>
      </motion.section>

    </motion.main>
  );
}

function NutritionTargetInput({ id, label, name, value, onChange, max, suffix, disabled }) {
  return (
    <label className="nutrition-filter-input" htmlFor={id}>
      <span>{label}</span>
      <span className="nutrition-filter-control">
        <input
          id={id}
          name={name}
          type="number"
          min="0"
          max={max}
          step="1"
          inputMode="numeric"
          value={value}
          onChange={onChange}
          disabled={disabled}
          aria-label={label}
          aria-describedby="nutrition-filter-help"
        />
        <span aria-hidden="true">{suffix}</span>
      </span>
    </label>
  );
}

function SearchGlyph() {
  return (
    <svg className="goal-entry-search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="10.8" cy="10.8" r="5.7" />
      <path d="m15.2 15.2 4.2 4.2" />
    </svg>
  );
}

function ArrowGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

function BackArrow() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M19 12H5m6-6-6 6 6 6" />
    </svg>
  );
}

function TuneGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 7h10M18 7h2M4 17h3M11 17h9M14 4v6M7 14v6" />
    </svg>
  );
}

function LoadingGlyph() {
  return <span className="goal-entry-loader" aria-hidden="true" />;
}

export { GoalEntryPage };
export default GoalEntryPage;

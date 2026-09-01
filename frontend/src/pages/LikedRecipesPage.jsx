import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Button from "../components/Button.jsx";
import BrandLogo from "../components/BrandLogo.jsx";
import { USER_ID } from "../constants.js";
import { getLikedRecipes } from "../utils/likedRecipes.js";
import {
  formatCaloriesForPeople,
  formatServings,
  formatTime,
  normalizeImageUrl,
} from "../utils/recipe.js";
import "./LikedRecipesPage.css";

function LikedRecipesPage() {
  const navigate = useNavigate();
  const likedRecipes = getLikedRecipes(USER_ID);
  const headingRef = useRef(null);
  const [people, setPeople] = useState(1);
  const selectedPeople = Number.isInteger(people) && people > 0 ? people : 1;

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const goToDeck = () => navigate("/deck");

  function handlePeopleChange(event) {
    if (event.target.value === "") {
      setPeople("");
      return;
    }

    const nextPeople = Number(event.target.value);
    setPeople(Number.isInteger(nextPeople) && nextPeople > 0 ? Math.min(nextPeople, 99) : 1);
  }

  return (
    <main className="liked-recipes-page">
      <header className="liked-header">
        <div className="liked-header-lead">
          <BrandLogo className="liked-brand" />
          <h1 ref={headingRef} tabIndex={-1}>
            Liked Recipes
          </h1>
        </div>
        <div className="liked-header-actions">
          {likedRecipes.length > 0 ? (
            <label className="liked-people-filter">
              <span>People</span>
              <input
                type="number"
                min="1"
                max="99"
                step="1"
                inputMode="numeric"
                value={people}
                onChange={handlePeopleChange}
                aria-label="Number of people"
              />
            </label>
          ) : null}
          <Button variant="secondary" size="sm" onClick={goToDeck} leftIcon={<BackGlyph />}>
            Back to deck
          </Button>
        </div>
      </header>

      {likedRecipes.length === 0 ? (
        <section className="liked-empty-state">
          <div className="liked-empty-emblem" aria-hidden="true">
            <HeartGlyph />
          </div>
          <p>Swipe right on a recipe you like and it'll show up here.</p>
          <Button variant="primary" size="lg" onClick={goToDeck}>
            Start swiping
          </Button>
        </section>
      ) : (
        <section className="liked-grid" aria-label="Liked recipes">
          {likedRecipes.map((recipe, index) => (
            <LikedRecipeCard key={recipe.id} recipe={recipe} index={index} people={selectedPeople} />
          ))}
        </section>
      )}
    </main>
  );
}

function LikedRecipeCard({ recipe, index, people }) {
  const title = typeof recipe.title === "string" && recipe.title.trim() ? recipe.title.trim() : "Untitled recipe";
  const servings = formatServings(recipe.servings);
  const meta = [formatTime(recipe.readyInMinutes), servings].filter(Boolean).join(" - ");
  const calories = formatCaloriesForPeople(recipe.calories, recipe.servings, people);
  const peopleLabel = `${people} ${people === 1 ? "person" : "people"}`;

  return (
    <div className={`liked-card-entry liked-card-entry--${index % 2 === 0 ? "left" : "right"}`}>
      <Link
      className="liked-card"
      to={`/recipe/${encodeURIComponent(recipe.id)}`}
      state={{ recipe }}
      >
        <div className="liked-card-image-wrap">
          <LikedRecipeImage image={recipe.image} title={title} />
          <span className="liked-card-shine" aria-hidden="true" />
        </div>
        <div className="liked-card-body">
          <h2>{title}</h2>
          <p className="liked-card-meta">{meta}</p>
          <p className="liked-card-calories">
            {calories === "Calories N/A" ? calories : `${calories} for ${peopleLabel}`}
          </p>
        </div>
      </Link>
    </div>
  );
}

function BackGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" focusable="false">
      <path
        d="M14 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
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

function LikedRecipeImage({ image, title }) {
  const imageUrl = normalizeImageUrl(image);
  const [imageFailed, setImageFailed] = useState(false);

  if (!imageUrl || imageFailed) {
    return (
      <div className="liked-card-image-fallback" role="img" aria-label={`${title} image unavailable`}>
        Image unavailable
      </div>
    );
  }

  return (
    <img
      src={imageUrl}
      alt={title}
      className="liked-card-image"
      loading="lazy"
      onError={() => setImageFailed(true)}
    />
  );
}

export default LikedRecipesPage;

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  addRecipeToCollection,
  createCollection,
  getApiErrorMessage,
  getCollections,
  getSavedRecipes,
  removeCloudRecipe,
  updateCloudRecipe,
} from "../api/client.js";
import { useAuth } from "../auth/AuthContext.jsx";
import Button from "../components/Button.jsx";
import BrandLogo from "../components/BrandLogo.jsx";
import { USER_ID } from "../constants.js";
import { getLikedRecipes } from "../utils/likedRecipes.js";
import { formatCaloriesForPeople, formatServings, formatTime, normalizeImageUrl } from "../utils/recipe.js";
import "./LikedRecipesPage.css";

function LikedRecipesPage() {
  const navigate = useNavigate();
  const auth = useAuth();
  const headingRef = useRef(null);
  const [recipes, setRecipes] = useState(() => getLikedRecipes(USER_ID));
  const [collections, setCollections] = useState([]);
  const [people, setPeople] = useState(1);
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(Boolean(auth.accessToken));
  const [error, setError] = useState("");
  const selectedPeople = Number.isInteger(people) && people > 0 ? people : 1;

  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    if (!auth.accessToken) {
      // Switching from an external session back to guest mode restores the local library.
      // oxlint-disable-next-line react/set-state-in-effect
      setRecipes(getLikedRecipes(USER_ID));
      setCollections([]);
      setIsLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setIsLoading(true);
    setError("");
    Promise.all([
      getSavedRecipes(auth.accessToken, { signal: controller.signal }),
      getCollections(auth.accessToken, { signal: controller.signal }),
    ])
      .then(([saved, collectionResult]) => {
        setRecipes(Array.isArray(saved?.recipes) ? saved.recipes : []);
        setCollections(Array.isArray(collectionResult?.collections) ? collectionResult.collections : []);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(getApiErrorMessage(requestError, "We couldn't load your synced recipes."));
      })
      .finally(() => { if (!controller.signal.aborted) setIsLoading(false); });
    return () => controller.abort();
  }, [
    auth.accessToken,
    // A completed guest import is a deliberate cloud-library refresh trigger.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
    auth.migrationStatus,
  ]);

  const visibleRecipes = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return recipes;
    return recipes.filter((recipe) => [recipe.title, recipe.notes, ...(recipe.diets || [])]
      .some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(normalized)));
  }, [query, recipes]);

  function handlePeopleChange(event) {
    if (event.target.value === "") { setPeople(""); return; }
    const nextPeople = Number(event.target.value);
    setPeople(Number.isInteger(nextPeople) && nextPeople > 0 ? Math.min(nextPeople, 99) : 1);
  }

  async function updateRecipe(recipeId, changes) {
    const updated = await updateCloudRecipe(auth.accessToken, recipeId, changes);
    setRecipes((current) => current.map((recipe) => recipe.id === recipeId ? updated : recipe));
  }

  async function removeRecipe(recipeId) {
    await removeCloudRecipe(auth.accessToken, recipeId);
    setRecipes((current) => current.filter((recipe) => recipe.id !== recipeId));
  }

  async function addToCollection(collectionId, recipeId) {
    await addRecipeToCollection(auth.accessToken, collectionId, recipeId);
  }

  async function makeCollection(value) {
    const collection = await createCollection(auth.accessToken, { name: value, description: "" });
    setCollections((current) => [...current, collection].sort((a, b) => a.name.localeCompare(b.name)));
  }

  return (
    <main className="liked-recipes-page">
      <header className="liked-header">
        <div className="liked-header-lead">
          <BrandLogo className="liked-brand" />
          <h1 ref={headingRef} tabIndex={-1}>{auth.user ? "Saved Recipes" : "Liked Recipes"}</h1>
          {auth.user ? <p className="liked-sync-label">Synced privately to your account</p> : null}
        </div>
        <div className="liked-header-actions">
          {recipes.length > 0 ? (
            <label className="liked-people-filter"><span>People</span><input type="number" min="1" max="99" step="1" inputMode="numeric" value={people} onChange={handlePeopleChange} aria-label="Number of people" /></label>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => navigate("/deck")} leftIcon={<BackGlyph />}>Back to deck</Button>
        </div>
      </header>

      {auth.user && recipes.length > 0 ? (
        <section className="liked-library-tools" aria-label="Recipe library tools">
          <label><span>Search your recipes</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, diet, or note" /></label>
          <NewCollectionForm onCreate={makeCollection} />
        </section>
      ) : null}

      {isLoading ? <LibraryState busy>Loading your private recipe library…</LibraryState> : null}
      {error ? <LibraryState role="alert">{error}</LibraryState> : null}
      {!isLoading && !error && recipes.length === 0 ? (
        <section className="liked-empty-state">
          <div className="liked-empty-emblem" aria-hidden="true"><HeartGlyph /></div>
          <p>Swipe right on a recipe you like and it'll show up here.</p>
          <Button variant="primary" size="lg" onClick={() => navigate("/deck")}>Start swiping</Button>
        </section>
      ) : null}
      {!isLoading && !error && recipes.length > 0 ? (
        visibleRecipes.length ? (
          <section className="liked-grid" aria-label="Liked recipes">
            {visibleRecipes.map((recipe, index) => (
              <LikedRecipeCard key={recipe.id} recipe={recipe} index={index} people={selectedPeople} signedIn={Boolean(auth.user)} collections={collections} onUpdate={updateRecipe} onRemove={removeRecipe} onAddToCollection={addToCollection} />
            ))}
          </section>
        ) : <LibraryState>No saved recipes match “{query.trim()}”.</LibraryState>
      ) : null}
    </main>
  );
}

function LikedRecipeCard({ recipe, index, people, signedIn, collections, onUpdate, onRemove, onAddToCollection }) {
  const title = typeof recipe.title === "string" && recipe.title.trim() ? recipe.title.trim() : "Untitled recipe";
  const servings = formatServings(recipe.servings);
  const meta = [formatTime(recipe.readyInMinutes), servings].filter(Boolean).join(" - ");
  const calories = formatCaloriesForPeople(recipe.calories, recipe.servings, people);
  const peopleLabel = `${people} ${people === 1 ? "person" : "people"}`;
  const [notes, setNotes] = useState(recipe.notes || "");
  const [rating, setRating] = useState(recipe.rating || "");
  const [collectionId, setCollectionId] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(action, success) {
    setBusy(true); setStatus("");
    try { await action(); setStatus(success); }
    catch (error) { setStatus(getApiErrorMessage(error, "Couldn't update this recipe.")); }
    finally { setBusy(false); }
  }

  return (
    <article className={`liked-card-entry liked-card-entry--${index % 2 === 0 ? "left" : "right"}`}>
      <div className="liked-card-shell">
        <Link className="liked-card" to={`/recipe/${encodeURIComponent(recipe.id)}`} state={{ recipe }}>
          <div className="liked-card-image-wrap"><LikedRecipeImage image={recipe.image} title={title} /><span className="liked-card-shine" aria-hidden="true" /></div>
          <div className="liked-card-body"><h2>{title}</h2><p className="liked-card-meta">{meta}</p><p className="liked-card-calories">{calories === "Calories N/A" ? calories : `${calories} for ${peopleLabel}`}</p></div>
        </Link>
        {signedIn ? (
          <div className="liked-card-controls">
            <label><span>My rating</span><select value={rating} onChange={(event) => setRating(event.target.value)}><option value="">Not rated</option>{[1,2,3,4,5].map((value) => <option key={value} value={value}>{value} star{value === 1 ? "" : "s"}</option>)}</select></label>
            <label><span>Private notes</span><textarea maxLength="2000" rows="2" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="What would you change next time?" /></label>
            <button type="button" disabled={busy} onClick={() => run(() => onUpdate(recipe.id, { notes, rating: rating || null }), "Saved")}>Save notes</button>
            {collections.length ? <label><span>Add to collection</span><select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}><option value="">Choose…</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></label> : null}
            {collectionId ? <button type="button" disabled={busy} onClick={() => run(() => onAddToCollection(collectionId, recipe.id), "Added to collection")}>Add</button> : null}
            <button type="button" className="liked-remove-button" disabled={busy} onClick={() => run(() => onRemove(recipe.id), "Removed")}>Remove</button>
            {status ? <p role="status">{status}</p> : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function NewCollectionForm({ onCreate }) {
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  async function submit(event) {
    event.preventDefault(); setStatus("");
    try { await onCreate(name.trim()); setName(""); setStatus("Collection created"); }
    catch (error) { setStatus(getApiErrorMessage(error, "Couldn't create the collection.")); }
  }
  return <form className="liked-new-collection" onSubmit={submit}><label><span>New collection</span><input required maxLength="80" value={name} onChange={(event) => setName(event.target.value)} placeholder="Weeknight favourites" /></label><button type="submit">Create</button>{status ? <small role="status">{status}</small> : null}</form>;
}

function LibraryState({ children, busy, role }) { return <section className="liked-library-state" aria-busy={busy || undefined} role={role}>{children}</section>; }
function BackGlyph() { return <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" focusable="false"><path d="M14 6l-6 6 6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function HeartGlyph() { return <svg viewBox="0 0 24 24" width="1em" height="1em" focusable="false"><path d="M12 20.5l-1.45-1.32C5.4 14.5 2 11.4 2 7.6 2 4.9 4.1 2.8 6.8 2.8c1.5 0 2.98.7 3.96 1.82L12 5.9l1.24-1.28A5.36 5.36 0 0117.2 2.8C19.9 2.8 22 4.9 22 7.6c0 3.8-3.4 6.9-8.55 11.58L12 20.5z" fill="currentColor" /></svg>; }
function LikedRecipeImage({ image, title }) {
  const imageUrl = normalizeImageUrl(image);
  const [imageFailed, setImageFailed] = useState(false);
  if (!imageUrl || imageFailed) return <div className="liked-card-image-fallback" role="img" aria-label={`${title} image unavailable`}>Image unavailable</div>;
  return <img src={imageUrl} alt={title} className="liked-card-image" loading="lazy" onError={() => setImageFailed(true)} />;
}

export default LikedRecipesPage;

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { USER_ID } from "../constants.js";
import { addLikedRecipe, clearLikedRecipes } from "../utils/likedRecipes.js";
import LikedRecipesPage from "./LikedRecipesPage.jsx";

const RECIPE_A = {
  id: "1001",
  title: "Lemon Chicken Bowl",
  image: "https://images.example/alpha.jpg",
  readyInMinutes: 25,
  servings: 2,
  calories: 480,
  macros: { protein_g: 38, carbs_g: 42, fat_g: 14 },
};

const RECIPE_B = {
  id: "9002",
  title: "Ginger Tofu Plate",
  image: "https://images.example/beta.jpg",
  readyInMinutes: 20,
  servings: 1,
  calories: 510,
  macros: { protein_g: 31, carbs_g: 55, fat_g: 18 },
};

function renderLikedPage() {
  return render(
    <MemoryRouter initialEntries={["/liked"]}>
      <Routes>
        <Route path="/liked" element={<LikedRecipesPage />} />
        <Route path="/deck" element={<h1>Deck destination</h1>} />
        <Route path="/recipe/:id" element={<h1>Recipe detail destination</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("LikedRecipesPage", () => {
  beforeEach(() => {
    clearLikedRecipes(USER_ID);
    window.sessionStorage.clear();
  });

  it("shows the seeded demo favourite when nothing else is liked", () => {
    renderLikedPage();

    expect(screen.getByRole("heading", { name: "Liked Recipes" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dishly home" })).toHaveAttribute("href", "/");
    expect(document.querySelector(".liked-brand img")).toHaveAttribute(
      "src",
      "/images/dishly-logo-hero.png",
    );
    expect(screen.queryByText(/you've liked this session/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /5-minute Ricotta Garlic Herb Dip/ })).toHaveAttribute(
      "href",
      "/recipe/1697679",
    );
  });

  it("lists liked recipes newest-first with their nutrition summary", () => {
    addLikedRecipe(USER_ID, RECIPE_A);
    addLikedRecipe(USER_ID, RECIPE_B);

    renderLikedPage();

    const links = within(screen.getByRole("region", { name: "Liked recipes" })).getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveTextContent("Ginger Tofu Plate");
    expect(links[1]).toHaveTextContent("Lemon Chicken Bowl");
    expect(links[2]).toHaveTextContent("5-minute Ricotta Garlic Herb Dip");
    expect(links[0]).toHaveAttribute("href", "/recipe/9002");
    expect(screen.getByText("510 kcal for 1 person")).toBeVisible();
    expect(screen.getByText("240 kcal for 1 person")).toBeVisible();
  });

  it("scales calorie totals for the selected number of people", async () => {
    const user = userEvent.setup();
    addLikedRecipe(USER_ID, RECIPE_A);

    renderLikedPage();

    const peopleInput = screen.getByRole("spinbutton", { name: "Number of people" });
    await user.clear(peopleInput);
    await user.type(peopleInput, "2");

    expect(screen.getByText("480 kcal for 2 people")).toBeVisible();
  });

  it("links each card to its recipe detail page with route state for an instant render", async () => {
    const user = userEvent.setup();
    addLikedRecipe(USER_ID, RECIPE_A);

    renderLikedPage();
    await user.click(screen.getByRole("link", { name: /Lemon Chicken Bowl/ }));

    expect(screen.getByRole("heading", { name: "Recipe detail destination" })).toBeInTheDocument();
  });

  it("falls back to an accessible image placeholder when the image fails to load", () => {
    addLikedRecipe(USER_ID, { ...RECIPE_A, image: "javascript:alert(1)" });

    renderLikedPage();

    expect(
      screen.getByRole("img", { name: "Lemon Chicken Bowl image unavailable" }),
    ).toBeVisible();
  });

  it("replaces a broken image with the fallback on error", () => {
    addLikedRecipe(USER_ID, RECIPE_A);

    renderLikedPage();
    const image = screen.getByRole("img", { name: "Lemon Chicken Bowl" });
    fireEvent.error(image);

    expect(
      screen.getByRole("img", { name: "Lemon Chicken Bowl image unavailable" }),
    ).toBeVisible();
  });

  it("navigates back to the deck from the header button", async () => {
    const user = userEvent.setup();
    addLikedRecipe(USER_ID, RECIPE_A);

    renderLikedPage();
    await user.click(screen.getByRole("button", { name: "Back to deck" }));

    expect(screen.getByRole("heading", { name: "Deck destination" })).toBeInTheDocument();
  });
});

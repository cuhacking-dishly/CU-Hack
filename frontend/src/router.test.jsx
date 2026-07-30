import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BrowserRouter,
  Link,
  MemoryRouter,
  Route,
  Routes,
  destinationToPath,
  matchRoute,
  useLocation,
  useNavigate,
  useParams,
} from "./router.jsx";

function LocationSummary() {
  const location = useLocation();
  return (
    <output>
      {location.pathname}|{location.search}|{location.hash}|{location.state?.source || "none"}
    </output>
  );
}

function RecipeDestination() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <h1>Recipe {id}</h1>
      <p>{location.state?.title || "No state"}</p>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </>
  );
}

describe("Dishly router", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("matches exact, parameterized, decoded, trailing-slash, and wildcard paths", () => {
    expect(matchRoute("/", "/")).toEqual({});
    expect(matchRoute("/deck", "/deck/")).toEqual({});
    expect(matchRoute("/recipe/:id", "/recipe/soup%20bowl")).toEqual({ id: "soup bowl" });
    expect(matchRoute("/recipe/:id", "/recipe")).toBeNull();
    expect(matchRoute("/liked", "/deck")).toBeNull();
    expect(matchRoute("*", "/anything/here")).toEqual({});
    expect(matchRoute("relative", "/relative")).toBeNull();
  });

  it("converts only same-origin HTTP destinations into safe app paths", () => {
    expect(destinationToPath("/deck?mode=exact#card")).toBe("/deck?mode=exact#card");
    expect(destinationToPath({ pathname: "/liked", search: "?page=2" })).toBe(
      "/liked?page=2",
    );
    expect(destinationToPath(`${window.location.origin}/recipe/1`)).toBe("/recipe/1");
    expect(destinationToPath("https://attacker.example/steal")).toBe("/");
    expect(destinationToPath("//attacker.example/steal")).toBe("/");
    expect(destinationToPath("javascript:alert(1)")).toBe("/");
    expect(destinationToPath("/deck\\attacker.example")).toBe("/");
  });

  it("supports memory history, route state, params, links, and back navigation", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter
        initialEntries={[{ pathname: "/", search: "?from=test", hash: "#start", state: { source: "seed" } }]}
      >
        <LocationSummary />
        <Routes>
          <Route
            path="/"
            element={
              <Link to="/recipe/chili%20bowl" state={{ title: "Chili bowl" }}>
                Open recipe
              </Link>
            }
          />
          <Route path="/recipe/:id" element={<RecipeDestination />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("/|?from=test|#start|seed")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Open recipe" }));
    expect(screen.getByRole("heading", { name: "Recipe chili bowl" })).toBeInTheDocument();
    expect(screen.getByText("Chili bowl")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("link", { name: "Open recipe" })).toBeInTheDocument();
  });

  it("updates browser history and reacts to popstate without a document reload", async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Link to="/deck" state={{ source: "home" }}>Open deck</Link>} />
          <Route path="/deck" element={<LocationSummary />} />
          <Route path="/liked" element={<h1>Liked recipes</h1>} />
        </Routes>
      </BrowserRouter>,
    );

    await user.click(screen.getByRole("link", { name: "Open deck" }));
    expect(window.location.pathname).toBe("/deck");
    expect(screen.getByText("/deck|||home")).toBeInTheDocument();

    act(() => {
      window.history.replaceState(null, "", "/liked");
      fireEvent.popState(window);
    });
    expect(screen.getByRole("heading", { name: "Liked recipes" })).toBeInTheDocument();
  });

  it("preserves native link behavior for modified clicks and custom handlers", () => {
    let calls = 0;
    render(
      <MemoryRouter>
        <Link
          to="/deck"
          onClick={(event) => {
            calls += 1;
            event.preventDefault();
          }}
        >
          Open deck
        </Link>
        <LocationSummary />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open deck" }), { ctrlKey: true });
    expect(calls).toBe(1);
    expect(screen.getByText("/|||none")).toBeInTheDocument();
  });
});

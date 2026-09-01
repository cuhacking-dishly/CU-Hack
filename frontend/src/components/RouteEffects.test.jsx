import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import RouteEffects from "./RouteEffects.jsx";

function renderEffects(path, { includeHeading = true } = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RouteEffects />
      <main>{includeHeading ? <h1>Current page</h1> : <p>No heading</p>}</main>
    </MemoryRouter>,
  );
}

describe("RouteEffects", () => {
  it.each([
    ["/", "dishly"],
    ["/deck", "dishly"],
    ["/liked", "dishly"],
    ["/recipe/abc-123", "dishly"],
    ["/not-a-real-page", "dishly"],
  ])("sets the document title for %s", (path, expectedTitle) => {
    renderEffects(path);

    expect(document.title).toBe(expectedTitle);
  });

  it("resets scroll position on navigation", () => {
    renderEffects("/deck");

    expect(window.scrollTo).toHaveBeenCalledOnce();
    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 0,
      left: 0,
      behavior: "auto",
    });
  });

  it("makes the page heading programmatically focusable and focuses it", async () => {
    renderEffects("/recipe/42");
    const heading = screen.getByRole("heading", { name: "Current page" });

    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute("tabindex", "-1");
  });

  it("does not fail when a route has no main heading", async () => {
    renderEffects("/missing", { includeHeading: false });

    await waitFor(() => {
      expect(document.title).toBe("dishly");
    });
    expect(screen.getByText("No heading")).toBeInTheDocument();
  });
});

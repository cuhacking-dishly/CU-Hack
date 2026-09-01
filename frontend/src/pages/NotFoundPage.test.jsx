import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import NotFoundPage from "./NotFoundPage.jsx";

describe("NotFoundPage", () => {
  it("explains the invalid route and provides a working return link", () => {
    render(
      <MemoryRouter initialEntries={["/missing"]}>
        <NotFoundPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "This page is not on the menu" })).toBeInTheDocument();
    expect(screen.getByText(/link may be outdated/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to goal entry" })).toHaveAttribute("href", "/");
  });
});

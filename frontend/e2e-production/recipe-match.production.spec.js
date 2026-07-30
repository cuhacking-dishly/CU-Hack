import { expect, test } from "@playwright/test";

const GOAL_TEXT = "Asian dinner with at least 30g protein and no peanuts";

test("serves and completes the production-shaped same-origin journey", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });

  const directRoutes = ["/", "/deck", "/liked", "/recipe/51001"];
  for (const route of directRoutes) {
    const response = await request.get(route, {
      headers: { Accept: "text/html" },
    });
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain('<div id="root">');
    expect(response.headers()["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  }

  const readiness = await request.get("/api/ready");
  expect(readiness.ok()).toBe(true);
  await expect(readiness.json()).resolves.toEqual({
    ok: true,
    services: { retrieval: true, storage: true },
  });

  const apiRequests = [];
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (url.pathname.startsWith("/api/")) {
      apiRequests.push({
        method: browserRequest.method(),
        origin: url.origin,
        path: url.pathname,
      });
    }
  });

  await page.goto("/");
  const goal = page.getByRole("textbox", { name: "Your food goal" });
  await goal.fill(GOAL_TEXT);
  await goal.press("Tab");
  await expect(
    page.getByRole("button", { name: "Open recipe filters" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  const startButton = page.getByRole("button", { name: "Start swiping" });
  await expect(startButton).toBeFocused();
  await startButton.press("Enter");

  await expect(page).toHaveURL(/\/deck$/);
  await expect(page.getByRole("status")).toContainText(
    "Match 1: Sesame-Free Ginger Tofu Bowl",
  );
  await page.getByRole("button", { name: "Like recipe" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Match 2: Citrus Chicken Rice Bowl",
  );

  await page.getByRole("button", { name: "Liked recipes" }).click();
  await expect(page).toHaveURL(/\/liked$/);
  await expect(
    page.getByRole("link", { name: /Sesame-Free Ginger Tofu Bowl/ }),
  ).toBeVisible();
  await page.getByRole("link", { name: /Sesame-Free Ginger Tofu Bowl/ }).click();
  await expect(page).toHaveURL(/\/recipe\/51001$/);
  await expect(
    page.getByRole("heading", { name: "Sesame-Free Ginger Tofu Bowl", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Press and roast the tofu.")).toBeVisible();
  await page.evaluate(() => {
    window.history.replaceState(null, "", window.location.href);
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Sesame-Free Ginger Tofu Bowl", level: 1 }),
  ).toBeVisible();
  await expect.poll(() =>
    apiRequests.some(
      ({ method, path }) => method === "GET" && path === "/api/recipes/51001",
    )
  ).toBe(true);

  expect(apiRequests.length).toBeGreaterThanOrEqual(5);
  expect(apiRequests.every(({ origin }) => origin === new URL(page.url()).origin)).toBe(true);
  expect(apiRequests.map(({ method, path }) => `${method} ${path}`)).toEqual(
    expect.arrayContaining([
      "POST /api/parse-goal",
      "POST /api/goal",
      "GET /api/goal/current",
      "GET /api/recipes",
      "POST /api/swipe",
      "GET /api/recipes/51001",
    ]),
  );
});

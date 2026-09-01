# Dishly Frontend

Recipe Match turns a natural-language food goal into a swipeable recipe deck. The interface keeps calories, protein, carbohydrates, and fat visible while the user decides, acknowledges every completed swipe through the backend, and opens the exact accepted recipe on a detail page.

This directory contains the React frontend only. Recipe parsing, saved goals, recipe-provider requests, and API keys belong to the backend.

## Requirements

- Node.js 24 or newer
- npm 11 (the repository records the tested package-manager version)
- The Recipe Match backend running at `http://localhost:3000`

On Windows PowerShell, use `npm.cmd` instead of `npm` so execution policy does not block `npm.ps1`.

## Local development

From `frontend/`:

```powershell
npm.cmd ci
npm.cmd run dev
```

Open `http://localhost:5173`. Vite uses that port in strict mode because the backend's local CORS allowlist expects that exact origin. If the port is occupied, Vite exits instead of silently starting on a CORS-blocked port.

The frontend calls `http://localhost:3000/api` by default. A different backend can be selected with a non-secret Vite environment value:

```dotenv
VITE_API_BASE_URL=http://localhost:3000/api
```

Every `VITE_` value is embedded in browser code. Never place Gemini, Spoonacular, ElevenLabs, or other secrets in a frontend environment file.

## Commands

| Command | Purpose |
| --- | --- |
| `npm.cmd run dev` | Start the fixed-port Vite development server. |
| `npm.cmd run build` | Create the production bundle in `dist/`. |
| `npm.cmd run preview` | Serve the production bundle at `http://localhost:5173`. |
| `npm.cmd run lint` | Run Oxlint across the frontend. |
| `npm.cmd run test` | Run the Vitest unit/component suite once. |
| `npm.cmd run test:watch` | Run Vitest in watch mode. |
| `npm.cmd run test:coverage` | Run Vitest and enforce coverage thresholds. |
| `npm.cmd run test:e2e` | Run the mocked-API Playwright browser suite. |
| `npm.cmd run test:e2e:fullstack` | Run Playwright through the real Express routes with deterministic provider boundaries. |
| `npm.cmd run test:all` | Run lint, coverage, production build, and browser regressions. |

The browser suite uses the Microsoft Edge installation already present on the demo laptop. In a clean CI environment, install Edge with Playwright before running `test:e2e`.

## Application flow

| Route | Screen | Behavior |
| --- | --- | --- |
| `/` | Goal entry | Captures a typed craving or filter-only goal. Its full-width, search-attached Recipe filters popover turns calorie, protein, and carbohydrate entries into a ±20% per-serving range; accepts free-form culture and allergy language, and offers Breakfast/Lunch & dinner/Dessert. Culture/allergy text is interpreted by Gemini, including multiple culture alternatives and non-standard ingredient allergies. Loading this route does not make an API request. |
| `/deck` | Swipe deck | Requires a saved goal, restores this tab's current deck when possible, and fetches additional recipe pages as needed. |
| `/recipe/:id` | Recipe detail | Reuses the exact accepted Recipe DTO during in-app navigation; direct links fetch that numeric recipe ID. |

The demo user is fixed as `demo-user-1` in `src/constants.js`. There is no authentication. Deck state is cached in `sessionStorage` for the current browser tab under the demo user and the saved goal's `updatedAt` value. A successful new goal clears older deck snapshots. With working session storage, returning from an accepted recipe or refreshing `/deck` resumes at the next unreviewed card without repeating the recipe search. If browser storage is blocked, full, or corrupt, a runtime memory fallback still preserves in-app detail-to-deck returns; a full page refresh then rebuilds the deck because browser persistence was unavailable.

Recipe IDs are canonical positive JavaScript-safe integer strings, matching Spoonacular and the backend contract. Both left and right actions wait for `POST /swipe` to succeed before progress is advanced. A failed swipe returns the same card and can be retried.

The deck requests `10` recipes at a time with explicit `limit` and `offset` values, advances by the returned `offset + limit`, and deduplicates IDs across pages. It uses `pagination.hasMore` to prefetch another page near the end. Since the API does not expose a provider-wide total, the interface announces `Match N` and describes only the end of the current deck rather than claiming the user has seen every possible provider match.

## Testing strategy

- Vitest and Testing Library cover the API boundary, route behavior, goal submission, swipe state machine, failure recovery, recipe detail, accessibility semantics, and formatting helpers.
- MSW intercepts the real Axios requests only inside tests. It is a development dependency and creates no production fallback or mock-data path.
- The standard Playwright browser suite runs against Microsoft Edge and a real Vite server, but deliberately intercepts `/api` with contract-faithful fixtures. It covers browser flow, responsive layout at laptop, 390px, and 320px viewports, and reduced-motion behavior; it is not a frontend-to-Express test.
- The separate full-stack browser check starts the actual Express routes with deterministic test-only Gemini and Spoonacular boundaries. It sends the production Axios client across the real CORS boundary and verifies goal storage, pagination, swipe storage, exact detail navigation, and deck resume without using provider quota.
- `test:coverage` enforces 85% statements, lines, and functions plus 80% branches across production JavaScript.

The full-stack suite defaults to ports `3000` and `5173`. If either belongs to
an already-running local app, run it on isolated ports without stopping that app:

```powershell
$env:FULLSTACK_BACKEND_PORT=3100
$env:FULLSTACK_FRONTEND_PORT=5174
npm.cmd run test:e2e:fullstack
```

## Backend contract

All network access is centralized in `src/api/client.js` and uses the backend `/api` routes:

- `POST /parse-goal`
- `POST /goal`
- `GET /goal/current?userId=...`
- `GET /recipes?userId=...&limit=10&offset=...`
- `GET /recipes/:id`
- `POST /swipe`

Recipe pages include `{ recipes, pagination: { limit, offset, count, hasMore } }`. `count` describes the current normalized page, while `hasMore` controls whether the deck should request another page. API helpers return `response.data`, accept an optional Axios request config for cancellation, and let failures propagate to page-level error handling. Their 35-second client timeout is deliberately longer than the backend's 30-second Gemini deadline. The frontend never calls Gemini, Spoonacular, or another recipe provider directly.

The nutrition target inputs are optional and use whole numbers. Each entered
target searches a per-serving range ±20% around that value; blank controls leave
the natural-language filter unchanged. Culture and allergy fields are free-form:
people can ask for “Chinese or Italian” and Gemini preserves both as OR cuisine
alternatives, or name any allergy/ingredient (including one outside Spoonacular’s
standard intolerance list) for an explicit exclusion. The meal control maps
Breakfast, Lunch & dinner, and Dessert to provider recipe types. A culture or
allergy entry deliberately invokes Gemini even with no typed craving, while a
meal-only or nutrition-only search remains instant and parser-free. Gemini first
interprets conversational intent and then categorizes craving, culture, meal,
allergy, diet, time, and nutrition constraints. The fixed-height filters panel
uses a subtle thin scroll indicator so every option remains reachable without
growing below the screen. Quick picks live inside that panel. The backend ranks
the resulting page for image availability and recipe quality before the swipe
deck renders it.

Allergy filtering narrows recipe results but cannot certify that a recipe is safe
to eat or account for cross-contact, substitutions, or incomplete provider data.
The interface reminds people to inspect ingredient labels before eating.

## Project structure

```text
src/
  api/client.js              Backend API boundary
  components/Button.*         Shared motion-powered button (variants + sizes)
  components/RouteEffects.* Route title, focus, and scroll management
  pages/GoalEntryPage.*      Goal capture and save flow
  pages/SwipeDeckPage.*      Recipe deck and swipe behavior
  pages/RecipeDetailPage.*   Selected recipe and nutrition detail
  pages/LikedRecipesPage.*   Session-liked recipe grid
  test/                      Shared Vitest and MSW setup
  utils/                     Tested formatting and swipe geometry
  App.jsx                    Route table and route-level behavior
  constants.js               Demo user identifier
  index.css                  Shared tokens, motion keyframes, global styles
e2e/                         Edge-backed browser regressions
```

Because the app uses `BrowserRouter`, a production web host must rewrite direct requests such as `/deck` and `/recipe/12345` to `index.html`.

## UI & motion system

The design tokens, the shared `Button` component, the alpha-transparent Dishly
logo and tab icon, the swipe-deck controls, and
the scroll-reveal micro-animations on the recipe pages are documented in
[`DESIGN.md`](./DESIGN.md). It also records the load-bearing test constraints
(`toBeVisible` vs. `opacity`, `transform` vs. `scrollWidth`, the 1366×768 deck
budget, the Framer mock, and the `IntersectionObserver` stub) — read it before
changing styles or animations.

## Pre-demo verification

1. With ports `3000` and `5173` free, run `npm.cmd run test:all` to lint, enforce coverage, build, and execute mocked browser regressions.
2. Run `npm.cmd run test:e2e:fullstack` to verify the browser, Axios, CORS, Express routes, and in-memory store together.
3. Start the provider-backed backend on port `3000` with its keys configured server-side.
4. Start the frontend and submit a representative goal from `/`.
5. Confirm the deck loads, an acknowledged left swipe advances, and an acknowledged right swipe opens the same recipe that was accepted.
6. Confirm the detail page shows per-serving calories and macros and returning to the deck resumes at the next match.
7. Check the flow at a laptop-sized viewport and near `390px` wide with no horizontal overflow.

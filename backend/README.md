# Recipe Match Backend

Node/Express API for Recipe Match. It turns a natural-language food goal into a validated filter with Gemini, searches Spoonacular, normalizes recipe and nutrition data for the frontend, and records goals and swipes in memory.

The API has no database and no authentication. All goals and swipes are process-local demo data and are erased whenever the server restarts.

## Requirements

- Node.js 20 or newer
- npm
- A Gemini API key for goal parsing
- A Spoonacular API key for recipe search and detail

The automated test suite does not require API keys or network access. Live validation does.

## Setup

Install exactly the dependency versions in `package-lock.json`:

```bash
cd backend
npm ci
```

Create a local environment file.

PowerShell:

```powershell
Copy-Item .env.example .env
```

POSIX shell:

```bash
cp .env.example .env
```

Put real provider keys in `.env`. Never put keys in `.env.example`, frontend environment variables, source code, or commits.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PORT` | No | `3000` | HTTP port, integer `1..65535`. Invalid values stop startup. |
| `GEMINI_API_KEY` | For goal parsing | None | Server-side Gemini API key. |
| `GEMINI_MODEL` | No | `gemini-3.5-flash` | Gemini model used for structured goal parsing. |
| `GEMINI_TIMEOUT_MS` | No | `30000` | Gemini timeout in milliseconds. Valid range `100..120000`; invalid values use the default. |
| `SPOONACULAR_API_KEY` | For recipes | None | Server-side Spoonacular API key. |
| `SPOONACULAR_TIMEOUT_MS` | No | `8000` | Spoonacular timeout in milliseconds. Valid range `100..120000`; invalid values use the default. |
| `CORS_ORIGINS` | No | Permissive | Comma-separated exact browser origins. Blank, unset, or any `*` allows every origin. |

The checked-in example allows a Vite frontend at `http://localhost:5173`. Add other exact frontend origins as a comma-separated list, without paths or trailing slashes.

Goal parsing uses Gemini's `MINIMAL` thinking level because this request is a small, schema-constrained classification task. The backend does not set sampling temperature, following the current Gemini 3.5 generation guidance.

## Commands

Run these commands from `backend/`.

| Command | Purpose |
| --- | --- |
| `npm start` | Start the API normally. |
| `npm run dev` | Start with Node watch mode. |
| `npm test` | Run deterministic unit and HTTP contract tests with mocked providers. |
| `npm run test:coverage` | Run the automated suite with coverage reporting and thresholds. |
| `npm run test:live` | Opt in to real Gemini and Spoonacular validation using `.env` keys. This consumes provider quota. |

The default base URL is `http://localhost:3000/api`.

## API Conventions

- Send request bodies as `application/json`.
- All responses, including errors and unknown routes, are JSON.
- Successful requests return `200 OK`.
- Strings are trimmed before use. `userId` is a caller-supplied demo identifier, not an authenticated identity.
- Repeated scalar query parameters, such as two `userId` values, are rejected.
- Request bodies are limited to 1 MiB.
- Every `/api` response sets `Cache-Control: no-store`; frontend code should keep its own deliberate state rather than relying on HTTP caching.
- There are no fallback or made-up recipes. Missing provider configuration is an explicit `503` error.

Every route failure uses one stable envelope:

```json
{
  "error": "Human-readable error message"
}
```

Frontend code should branch on the HTTP status, not the exact message text.
The readiness resource is the one exception: when it is not ready, it returns its
documented readiness shape with status `503` rather than an error envelope.

| Status | Meaning |
| --- | --- |
| `400` | Invalid body, query, path parameter, filter, or JSON syntax. |
| `403` | Browser origin is not allowed by `CORS_ORIGINS`. |
| `404` | Recipe or API route was not found. |
| `413` | JSON request body is larger than 1 MiB. |
| `500` | Unexpected backend failure. Internal details are not returned. |
| `502` | A provider failed or returned an invalid payload. |
| `503` | A required provider key is missing, or readiness checks fail. |
| `504` | A provider exceeded its configured timeout. |

## Data Contracts

### Goal filter

All properties are optional. An unconstrained goal is `{}`. Extra properties are rejected when saving a goal.

```json
{
  "query": "cozy ramen",
  "maxCalories": 600,
  "minProtein_g": 30,
  "diet": "vegan",
  "cuisines": ["japanese", "italian"],
  "mealType": "main course",
  "maxReadyTime": 30,
  "intolerances": ["peanut", "shellfish"],
  "excludeIngredients": ["peanuts", "shellfish"]
}
```

| Property | Contract |
| --- | --- |
| `maxCalories` | Integer `1..10000`. |
| `minProtein_g` | Integer `0..500`. |
| `diet` | `gluten free`, `ketogenic`, `vegetarian`, `lacto-vegetarian`, `ovo-vegetarian`, `vegan`, `pescetarian`, `paleo`, `primal`, `low fodmap`, or `whole30`. |
| `query` | A specific craving such as a dish, ingredient, flavor, or style; nonblank string up to 160 characters. |
| `cuisines` | One or more Spoonacular cultures, interpreted as OR alternatives: African, Asian, American, British, Cajun, Caribbean, Chinese, Eastern European, European, French, German, Greek, Indian, Irish, Italian, Japanese, Jewish, Korean, Latin American, Mediterranean, Mexican, Middle Eastern, Nordic, Southern, Spanish, Thai, or Vietnamese. Values are stored in lowercase, so “Chinese or Italian” searches both cultures. |
| `mealType` | `breakfast`, `main course` (the app’s Lunch & dinner choice), or `dessert`. |
| `maxReadyTime` | Integer minutes `1..1440`. |
| `intolerances` | Up to the supported allergy categories: `dairy`, `egg`, `gluten`, `grain`, `peanut`, `seafood`, `sesame`, `shellfish`, `soy`, `sulfite`, `tree nut`, and `wheat`. Duplicate values are removed. |
| `excludeIngredients` | At most 20 nonblank strings, each at most 80 characters. Duplicate names are removed case-insensitively. |

Gemini first interprets the whole natural-language request, then independently classifies its craving, culture, meal, diet, allergy, time, and nutrition constraints into this schema. Culture and allergy entries are intentionally free-form: “Chinese or Italian” becomes two OR cuisines, while a non-standard allergy such as strawberry or alpha-gal is interpreted into explicit ingredient exclusions. Obvious spelling variants are normalized and a specific culture can map to its closest supported broad cuisine. For example, “take me to Tokyo for a sweet treat; I’m allergic to peanuts” becomes a Japanese dessert filter with the peanut intolerance and an explicit peanut exclusion. Unsupported or invalid model-produced fields are dropped. A client-provided `parsedFilter` on `POST /api/goal` is validated strictly and returns `400` if invalid.

Allergy filtering narrows provider results; it does not certify a recipe as medically safe or account for cross-contact, substitutions, or incomplete provider data. People must inspect the final ingredient list and labels before eating.

When searching, `query`, `cuisines`, `mealType`, `intolerances`, and `excludeIngredients` are all passed to Spoonacular’s Complex Search endpoint. Multiple cuisines are sent as OR alternatives. `intolerances` uses the provider’s ontology-aware safety filter; `excludeIngredients` remains available for any named ingredient outside that limited allergy vocabulary. The two are deliberately complementary for safety.

### Goal

```json
{
  "rawText": "cozy Japanese dessert, no peanuts, under 600 calories",
  "parsedFilter": {
    "query": "cozy",
    "maxCalories": 600,
    "cuisines": ["japanese", "italian"],
    "mealType": "dessert",
    "intolerances": ["peanut"],
    "excludeIngredients": ["peanuts"]
  },
  "updatedAt": "2026-07-11T16:00:00.000Z"
}
```

There is at most one current goal per `userId`; saving another replaces it. `updatedAt` is an RFC 3339 UTC timestamp.

### Recipe

```json
{
  "id": "12345",
  "title": "Vegan Protein Bowl",
  "image": "https://example.com/recipe.jpg",
  "readyInMinutes": 25,
  "servings": 2,
  "calories": 498,
  "macros": {
    "protein_g": 31,
    "carbs_g": 46,
    "fat_g": 12
  },
  "diets": ["vegan"],
  "sourceUrl": "https://example.com/recipe"
}
```

Nutrition values are rounded and represent one serving. Unknown numeric provider values are `null`, not zero. Image and instruction links are retained only when they are absolute HTTP(S) URLs without credentials. When the original `sourceUrl` is missing or unsafe, a safe `spoonacularSourceUrl` is used as the instructions link. Missing `image` and `sourceUrl` values are empty strings, and missing `diets` is an empty array. The detail route intentionally returns the same stable shape as search results.

### Swipe

The accepted swipe values are:

```json
{
  "userId": "demo-user-1",
  "recipeId": "12345",
  "direction": "right"
}
```

`direction` is exactly `left` or `right` after trimming. `recipeId` is a canonical positive JavaScript-safe integer string with no leading zeroes. The in-memory record also receives a server-generated `timestamp`; at most the latest 1,000 swipes are retained per user. No route exposes swipe history.

## Endpoints

### `GET /api/health`

Process liveness only. It does not check keys or contact providers.

```json
{
  "ok": true
}
```

Always returns `200` while the process can serve requests.

### `GET /api/ready`

Configuration readiness. It checks that both provider keys are nonblank, but does not make provider network requests.

Ready response, status `200`:

```json
{
  "ok": true,
  "services": {
    "gemini": true,
    "spoonacular": true
  }
}
```

If either key is absent, the same shape is returned with the relevant value and `ok` set to `false`, with status `503`.

### `POST /api/parse-goal`

Parse natural language through Gemini. `text` is required, nonblank, and at most 1,000 characters.

Request:

```json
{
  "text": "cozy Japanese dessert, no peanuts, under 600 calories"
}
```

Success:

```json
{
  "parsedFilter": {
    "query": "cozy",
    "maxCalories": 600,
    "cuisines": ["japanese", "italian"],
    "mealType": "dessert",
    "intolerances": ["peanut"],
    "excludeIngredients": ["peanuts"]
  }
}
```

Returns `503` without `GEMINI_API_KEY`, `502` for provider or response failures, and `504` on timeout.

### `POST /api/goal`

Save or replace the current in-memory goal for one user. `userId` is required and at most 128 characters. `rawText` is required and at most 1,000 characters. `parsedFilter` may be omitted, in which case it becomes `{}`.

Nutrition filter fields are all per serving: `minCalories`/`maxCalories`,
`minProtein_g`/`maxProtein_g`, and `minCarbs_g`/`maxCarbs_g`. When both bounds
for a nutrient are present, the minimum must not exceed the maximum.

Request:

```json
{
  "userId": "demo-user-1",
  "rawText": "cozy Japanese dessert, no peanuts, under 600 calories",
  "parsedFilter": {
    "query": "cozy",
    "maxCalories": 600,
    "cuisines": ["japanese", "italian"],
    "mealType": "dessert",
    "intolerances": ["peanut"],
    "excludeIngredients": ["peanuts"]
  }
}
```

Success:

```json
{
  "success": true
}
```

### `GET /api/goal/current?userId=demo-user-1`

Returns the current goal object. `userId` is required, must be provided once, and is limited to 128 characters. Returns JSON `null` with status `200` when the user has no saved goal.

### `GET /api/recipes?userId=demo-user-1&limit=10&offset=0`

Search Spoonacular using the user's saved filter. If the user has no saved goal, the search is unfiltered.

Query parameters:

| Name | Required | Contract |
| --- | --- | --- |
| `userId` | Yes | One nonblank string, at most 128 characters. |
| `limit` | No | Integer `1..20`; default `10`. |
| `offset` | No | Integer `0..900`; default `0`. |

Success:

```json
{
  "recipes": [],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "count": 0,
    "hasMore": false
  }
}
```

`count` is the number of normalized recipes in this page, not a total result count. `hasMore` is the continuation signal clients should use: it uses Spoonacular's `totalResults` when valid and otherwise conservatively treats a full raw provider page as potentially having another page. It is always `false` when another request would exceed the supported maximum offset. Request the next page only when `hasMore` is `true`, using `offset + limit`; advancing by `count` could repeat raw results when invalid provider rows were removed.

Recipe search and detail responses are not cached by this process. Clients should retain deliberate in-session deck state so route changes do not repeat provider calls unnecessarily.

Search requests require recipe instructions and ask Spoonacular for descending
popularity. Within each provider page, normalized recipes are ranked so
image-backed recipes lead, then Spoonacular score, aggregate likes, health
score, popularity flag, and available instructions break ties. This keeps the
deck focused on complete, appealing recipes without making extra provider calls.

Returns `503` without `SPOONACULAR_API_KEY`, `502` for provider or response failures, and `504` on timeout.

### `GET /api/recipes/:id`

Returns one Recipe directly. `id` must be a canonical positive JavaScript-safe integer without leading zeroes. A missing provider recipe returns `404`; provider/configuration failures use the same `502`/`503`/`504` mapping as search.

### `POST /api/swipe`

Record one in-memory swipe. `userId` is required and at most 128 characters. `recipeId`
must be a canonical positive JavaScript-safe integer string without leading zeroes, and `direction` must be `left` or
`right` after trimming.

Request:

```json
{
  "userId": "demo-user-1",
  "recipeId": "12345",
  "direction": "right"
}
```

Success:

```json
{
  "success": true
}
```

## Frontend Integration

Configure one frontend environment variable, for example:

```env
VITE_API_BASE_URL=http://localhost:3000/api
```

Do not expose either provider key to the frontend. A small fetch wrapper should enforce timeouts, parse both success and error JSON, and preserve the HTTP status:

```js
const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:3000/api"
).replace(/\/$/, "");

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiFetch(path, options = {}) {
  const { timeoutMs = 15000, ...requestOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(requestOptions.headers);
  headers.set("Accept", "application/json");
  if (requestOptions.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...requestOptions,
      headers,
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = null;

    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      throw new ApiError("Backend returned invalid JSON", response.status);
    }

    if (!response.ok) {
      throw new ApiError(payload?.error || `Request failed (${response.status})`, response.status);
    }

    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ApiError("Backend request timed out", 0);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
```

Example recipe page request:

```js
const query = new URLSearchParams({
  userId: "demo-user-1",
  limit: "10",
  offset: "0",
});
const page = await apiFetch(`/recipes?${query}`);
```

For expected provider errors, show a retry action for `502` and `504`, configuration guidance for `503` during development, and validation feedback for `400`. A browser may surface a denied CORS request as a network error because it cannot read a response without an allow-origin header.

## CORS

`CORS_ORIGINS` is a comma-separated allowlist of exact origins:

```env
CORS_ORIGINS=http://localhost:5173,https://recipes.example.com
```

- Allowed browser origins receive the matching `Access-Control-Allow-Origin` header.
- Requests without an `Origin` header, including curl and server-to-server calls, are allowed.
- Unlisted browser requests and preflights are denied with status `403`.
- Blank, unset, or `*` configuration is permissive and should be used only when that is intentional.
- Cookie credentials are not enabled; this API has no login/session support.

## Automated Testing

```bash
npm test
npm run test:coverage
```

Tests use Node's built-in test runner and local mocks for Gemini and Spoonacular. They must remain deterministic, make no billable calls, and work without network access or API keys. The normal suite discovers the live-test file but explicitly skips its provider calls.

## Live Validation

Live validation is separate and opt-in because it contacts both providers and consumes quota. It loads `backend/.env` and calls the service functions directly; a running HTTP server is not required. Put both valid keys in `.env`, then run:

```bash
npm run test:live
```

The command fails clearly if either key is missing. It is never silently treated as a successful live check.

Real provider calls cannot be verified without valid keys. A successful mocked suite proves request construction and normalization, not provider credentials, quota, account permissions, or current upstream availability.

### PowerShell smoke flow

Start the server in one terminal:

```powershell
npm start
```

Run from another terminal:

```powershell
curl.exe --fail-with-body -sS http://localhost:3000/api/ready
curl.exe --fail-with-body -sS -X POST http://localhost:3000/api/parse-goal -H "Content-Type: application/json" -d '{\"text\":\"vegan, no peanuts, under 600 calories\"}'
curl.exe --fail-with-body -sS -X POST http://localhost:3000/api/goal -H "Content-Type: application/json" -d '{\"userId\":\"demo-user-1\",\"rawText\":\"vegan, no peanuts, under 600 calories\",\"parsedFilter\":{\"diet\":\"vegan\",\"excludeIngredients\":[\"peanuts\"],\"maxCalories\":600}}'
curl.exe --fail-with-body -sS "http://localhost:3000/api/goal/current?userId=demo-user-1"
curl.exe --fail-with-body -sS "http://localhost:3000/api/recipes?userId=demo-user-1&limit=10&offset=0"
curl.exe --fail-with-body -sS http://localhost:3000/api/recipes/12345
curl.exe --fail-with-body -sS -X POST http://localhost:3000/api/swipe -H "Content-Type: application/json" -d '{\"userId\":\"demo-user-1\",\"recipeId\":\"12345\",\"direction\":\"right\"}'
```

Replace `12345` with an ID returned by the search response before testing detail or swipe.

### POSIX smoke flow

Start the server in one terminal:

```bash
npm start
```

Run from another terminal:

```bash
curl --fail-with-body -sS http://localhost:3000/api/ready
curl --fail-with-body -sS -X POST http://localhost:3000/api/parse-goal -H 'Content-Type: application/json' -d '{"text":"vegan, no peanuts, under 600 calories"}'
curl --fail-with-body -sS -X POST http://localhost:3000/api/goal -H 'Content-Type: application/json' -d '{"userId":"demo-user-1","rawText":"vegan, no peanuts, under 600 calories","parsedFilter":{"diet":"vegan","excludeIngredients":["peanuts"],"maxCalories":600}}'
curl --fail-with-body -sS 'http://localhost:3000/api/goal/current?userId=demo-user-1'
curl --fail-with-body -sS 'http://localhost:3000/api/recipes?userId=demo-user-1&limit=10&offset=0'
curl --fail-with-body -sS http://localhost:3000/api/recipes/12345
curl --fail-with-body -sS -X POST http://localhost:3000/api/swipe -H 'Content-Type: application/json' -d '{"userId":"demo-user-1","recipeId":"12345","direction":"right"}'
```

## OpenAPI

The complete OpenAPI 3.1 contract is in [`openapi.yaml`](./openapi.yaml). Keep it synchronized with route validation and response tests whenever the API changes.

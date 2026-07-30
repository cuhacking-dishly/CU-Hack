# Dishly Express API

Express is Dishly's public application boundary. It validates browser input,
stores the current goal and swipe history, calls the private local Python service,
and validates every response before returning it to React.

Natural-language parsing and recipe retrieval use the same private service. The
backend contains no hosted-model SDK, API key, or fallback.

## Setup

From the repository root:

```powershell
Copy-Item backend/.env.example backend/.env
npm.cmd run setup
npm.cmd run dev
```

Configuration:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Public Express port. |
| `CORS_ORIGINS` | all origins | Comma-separated browser origins; use an explicit value outside development. |
| `RETRIEVAL_SERVICE_URL` | required by `npm start`; supplied as `http://127.0.0.1:8000` by `npm run dev` | Private Python base URL. |
| `RETRIEVAL_SERVICE_HOSTPORT` | unset | Private-network `host:port`; used only when the URL is unset. |
| `RETRIEVAL_SERVICE_TOKEN` | unset | Bearer token shared with Python when retrieval crosses a trust boundary. |
| `RETRIEVAL_TIMEOUT_MS` | `8000` | Search/detail/readiness deadline, bounded to `100..120000`. |
| `GOAL_PARSER_TIMEOUT_MS` | `180000` | Cold local-language-model deadline, bounded to `1000..600000`. |
| `DATABASE_URL` | unset | Enables persistent PostgreSQL goals and swipes. |
| `SQLITE_DATABASE_PATH` | unset | Enables durable local SQLite goals and swipes when PostgreSQL is absent. |
| `FRONTEND_DIST_PATH` | unset | Serves a built React SPA and direct-route fallback from this directory. |
| `HOST` | `0.0.0.0` | Listen address; zero-cost production sets `127.0.0.1` behind Funnel. |
| `REQUIRE_PERSISTENT_STORE` | `false` | When true, `/ready` fails unless PostgreSQL or SQLite is configured and reachable. |

The browser must never call `RETRIEVAL_SERVICE_URL` directly. In a Pi deployment,
bind Python to loopback and expose only Nginx/Express. Cross-host deployments
must configure the same random token on Express and Python.

## Request flow

1. `POST /api/parse-goal` sends bounded text to Python `/v1/parse-goal`.
2. Python calls local Ollama with a JSON schema, validates the output, and overlays
   explicit constraints from the original text.
3. Express validates the returned filter again with `normalizeGoalFilter`.
4. `POST /api/goal` saves the filter and a monotonic goal version in the selected
   memory, SQLite, or PostgreSQL repository.
5. `GET /api/recipes` sends the saved goal plus same-goal swipe exclusions to
   local hybrid retrieval.
6. Express validates recipe IDs, URLs, publisher fields, nutrition, match metadata,
   paging, vegan invariants, and excluded IDs before returning data to React.

## Goal-filter contract

```js
{
  query,
  minCalories, maxCalories,
  minProtein_g, maxProtein_g,
  minCarbs_g, maxCarbs_g,
  diet,
  cuisines,
  mealType,
  maxReadyTime,
  intolerances,
  excludeIngredients
}
```

All fields are optional. Enumerations and numeric ranges live in
`src/services/goalFilter.js`. The model does not get to expand that contract.
`diet: "vegan"` becomes a hard retrieval requirement. An explicit custom exclusion
such as `no strawberries` is stored in `excludeIngredients` and hard-filtered
against exact publisher ingredients.

## Public endpoints

| Method/path | Result |
| --- | --- |
| `GET /api/health` | Process liveness only. |
| `GET /api/ready` | `200` only when Python reports corpus and local parser ready. |
| `POST /api/parse-goal` | `{ parsedFilter }` from local Ollama plus safety overlay. |
| `POST /api/goal` | Validate and save a goal for one user. |
| `GET /api/goal/current?userId=...` | Current saved goal or `null`. |
| `GET /api/recipes?userId=...&limit=10&offset=0&matchMode=exact` | Ranked recipe page. |
| `GET /api/recipes/:id` | Reviewed recipe detail. |
| `POST /api/swipe` | Save a left/right swipe against the current goal version. |

The complete machine-readable contract is [openapi.yaml](./openapi.yaml).

## Exact and closest behavior

Exact mode enforces accurate cuisine and meal candidates after safety filtering.
If it is empty but safe candidates remain, the API returns the copy
`You cooked too hard! No available recipes match your request.` and authorizes the
closest-results button. Closest can relax cuisine, meal, nutrition, and time; it
cannot relax allergies, ingredient exclusions, requested vegan, or same-search
swipe exclusions.

## Errors

| Status | Meaning |
| --- | --- |
| `400` | Invalid body, query, identifier, filter, or paging. |
| `404` | Recipe/API route not found. |
| `413` | JSON body exceeds 1 MiB. |
| `502` | Private service returned an invalid/unavailable response. |
| `503` | Private service, corpus, Ollama, or required model is not ready. |
| `504` | Configured private-service deadline elapsed. |

Internal error details and configured infrastructure values are not returned to
the browser. API responses use `Cache-Control: no-store` and escaped JSON.

## Tests

```powershell
npm.cmd --prefix backend test
npm.cmd --prefix backend run test:coverage
```

The normal suite is deterministic and mocks the private HTTP boundary. It also
tests PostgreSQL through a deterministic pool boundary and SQLite against real
temporary WAL databases, including restart persistence and transaction rollback. The live
suite is local and non-billable: start retrieval, set `RETRIEVAL_SERVICE_URL`, then
run `npm.cmd --prefix backend run test:live`. It executes a real Ollama parse,
retrieval search, and detail lookup.

Run `npm.cmd --prefix backend run db:migrate` with `DATABASE_URL` set to apply the
idempotent production schema. Full production wiring, acceptance checks, and
rollback steps are in [`../docs/PRODUCTION_DEPLOYMENT.md`](../docs/PRODUCTION_DEPLOYMENT.md).

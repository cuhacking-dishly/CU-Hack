# Production deployment

Dishly has three runtime boundaries and one datastore:

```text
browser
  -> static React frontend
  -> public Express API
       -> PostgreSQL
       -> private FastAPI retrieval service
            -> co-located Ollama
            -> reviewed corpus + digest-bound vector index
```

The checked-in `render.yaml` is a complete Render Blueprint for that topology.
The frontend can instead run on Vercel without changing the API or RAG services.

## Cost and capacity

The 4B parser model, embedding model, Ollama runtime, Python service, and vector
index do not fit on free/serverless compute. The Blueprint deliberately uses a
paid private service with a persistent disk for retrieval and a persistent
PostgreSQL plan. Render shows the current price before creating resources.
Review and approve that price in the dashboard; never assume a free deployment.

If an 8 GB Raspberry Pi or another persistent host is already available, use the
existing Pi deployment instead and host only the frontend/API in the cloud. Set
`RETRIEVAL_SERVICE_URL` to an authenticated private tunnel or VPN address and set
the same random token on both sides. Do not expose Ollama itself.

## Option A: one Render Blueprint

1. Push the intended commit to a Git provider Render can access.
2. In Render, create a **Blueprint** from the repository. Render detects
   `render.yaml`.
3. Review the paid retrieval and PostgreSQL resources, then create the Blueprint.
4. The first retrieval boot downloads about 3 GB of models and builds the vector
   index. The persistent disk makes subsequent boots much faster.
5. Wait for:
   - `dishly-retrieval` to pass Render's private-service TCP probe (its
     authenticated diagnostics remain available to `dishly-api`);
   - `dishly-api` health at `/api/ready`;
   - `dishly-web` deployment completion.
6. Run the production verifier:

```powershell
node scripts/verify-production.mjs `
  --api https://YOUR-API.onrender.com/api `
  --frontend https://YOUR-WEB.onrender.com `
  --origin https://YOUR-WEB.onrender.com
```

The Blueprint wires these values without exposing them to the browser:

- PostgreSQL `connectionString` -> `DATABASE_URL`
- retrieval private `host:port` -> `RETRIEVAL_SERVICE_HOSTPORT`
- generated `DISHLY_SERVICE_TOKEN` -> Express `RETRIEVAL_SERVICE_TOKEN`
- frontend public URL -> `CORS_ORIGINS`
- API public URL -> build-time `VITE_API_ORIGIN`

## Option B: Vercel frontend and Render API/RAG

Deploy the Render Blueprint first. It includes a Render static frontend because
that makes the Blueprint independently deployable. A Vercel frontend can replace
it afterward:

1. Import the repository into Vercel.
2. Set **Root Directory** to `frontend`.
3. Use build command `npm run build` and output directory `dist`.
4. Set `VITE_API_ORIGIN=https://YOUR-API.onrender.com`.
5. Deploy. `frontend/vercel.json` provides SPA rewrites and response hardening.
6. In the Render API service, replace `CORS_ORIGINS` with the exact Vercel
   production origin. Add explicit preview origins only when a preview must call
   production; do not use `*`.
7. Redeploy the API and rerun the verifier with the Vercel URL.

`VITE_API_ORIGIN` is public by design. It contains only the Express origin and
the frontend appends `/api`. Never create frontend variables for PostgreSQL,
retrieval, Ollama, or service-token values.

## Runtime configuration

### Express

| Variable | Production requirement |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. |
| `REQUIRE_PERSISTENT_STORE` | `true`; readiness fails when the database is absent. |
| `RETRIEVAL_SERVICE_HOSTPORT` | Private host and port when both services are on Render. |
| `RETRIEVAL_SERVICE_URL` | Alternative absolute HTTP(S) URL for a Pi/VPS/tunnel. |
| `RETRIEVAL_SERVICE_TOKEN` | Same 32+ character secret as Python. |
| `CORS_ORIGINS` | Exact comma-separated browser origins. Never `*` in production. |
| `RETRIEVAL_TIMEOUT_MS` | Search/readiness deadline. |
| `GOAL_PARSER_TIMEOUT_MS` | Cold-model parsing deadline. |

`RETRIEVAL_SERVICE_URL` takes precedence over `RETRIEVAL_SERVICE_HOSTPORT`.

### Retrieval

| Variable | Production requirement |
| --- | --- |
| `DISHLY_SERVICE_TOKEN` | Random 32+ character bearer token. |
| `DISHLY_SERVICE_HOST` | `0.0.0.0` in a container; loopback on a co-located Pi. |
| `DISHLY_SERVICE_PORT` | `8000` in the Blueprint. |
| `OLLAMA_HOST` | Loopback URL for the co-located Ollama server. |
| `OLLAMA_MODELS` | Persistent-disk model directory. |
| `DISHLY_INDEX_PATH` | Persistent-disk vector-index path. |
| `OLLAMA_MAX_LOADED_MODELS` | `2`, so the parser and embedding model can remain resident. |
| `OLLAMA_NUM_PARALLEL` | `1`, bounding peak memory on the 8 GB retrieval instance. |

`/health` remains unauthenticated for container diagnostics. `/ready`, `/docs`,
and every `/v1/*` route require the bearer token whenever
`DISHLY_SERVICE_TOKEN` is configured.

## Database behavior and migrations

`backend/src/store/migrations/001_initial.sql` creates:

- one current goal per user;
- ordered swipe history with the associated goal version;
- bounded retention of 1,000 swipes per user.

Render runs `npm run db:migrate` before each API deploy. The migration is
idempotent and additive. Local development continues to use the in-memory store
when `DATABASE_URL` is absent.

## Acceptance and operational checks

The production verifier proves:

- liveness, retrieval readiness, and storage readiness;
- exact production CORS;
- real qwen3 parsing and deterministic peanut recovery;
- `ollama:embeddinggemma` vector retrieval;
- publisher image/source provenance;
- goal round-trip and swipe exclusion persistence;
- detail lookup;
- frontend SPA direct-route rewrites;
- absence of private configuration markers in browser bundles.

Also inspect the browser manually at desktop and mobile widths and run the
repository verification matrix before deploying:

```powershell
npm.cmd run verify
npm.cmd run test:local-rag
```

## Troubleshooting

- **API readiness says retrieval false:** inspect the retrieval logs for model
  pull, index compatibility, disk capacity, or an incorrect token/hostport.
- **API readiness says storage false:** verify `DATABASE_URL`, run
  `npm run db:migrate`, and check PostgreSQL connectivity.
- **Browser reports CORS:** compare the browser's exact origin—including scheme
  and preview hostname—with `CORS_ORIGINS`, then redeploy Express.
- **First deployment times out:** model download/index setup can exceed ordinary
  web cold starts. Retrieval needs persistent always-on compute.
- **Parser times out after readiness succeeds:** increase both Python
  `OLLAMA_PARSER_TIMEOUT_SECONDS` and Express `GOAL_PARSER_TIMEOUT_MS`; keep the
  frontend parse deadline slightly larger than Express.
- **Render container restarts while loading qwen3:** the selected instance lacks
  memory. Move to an instance with more RAM; do not remove the parser or silently
  fall back to generated recipes.

## Rollback

1. Use Render's service rollback for `dishly-api`, `dishly-web`, and
   `dishly-retrieval`.
2. The initial database migration is backward-compatible with the previous
   memory implementation and does not delete data.
3. Before any future destructive migration, take a PostgreSQL backup and ship a
   tested down migration.
4. If rolling the frontend back independently, preserve the deployed API origin
   and CORS allowlist.
5. After rollback, rerun `scripts/verify-production.mjs` against the live URLs.

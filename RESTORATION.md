# Dishly restoration record

## Restored release

The public Dishly application was restored on 2026-08-31 to the last complete
pre-RAG release, Git commit `7ba5192` (`Add render.yaml for backend deployment`).
That release uses the original production architecture:

```text
React/Vite frontend -> Express API -> Gemini goal parsing
                                  -> Spoonacular recipe search and detail
```

The rollback was committed as a normal revert rather than a force-push. This
keeps all later history recoverable and gives connected hosting services a new
`main` commit to deploy.

The later local-RAG implementation is preserved separately at commit `4bd9110`
and in the local `Modified Dishly` archive. Do not delete that archive until the
RAG project has its own remote and deployment plan.

## Required production configuration

The backend requires these server-only environment variables:

- `GEMINI_API_KEY`
- `SPOONACULAR_API_KEY`
- `CORS_ORIGINS=https://dishly.brandonjameschoi.com`

Optional provider settings are documented in `backend/.env.example`. Never put
provider keys in `frontend/.env` or any `VITE_*` variable because Vite embeds
those values in browser assets.

The frontend must receive exactly one public API setting at build time:

```dotenv
VITE_API_BASE_URL=https://<public-backend-host>/api
```

The Vercel project root must remain `frontend`. Its committed `vercel.json`
rewrites all paths to `index.html`; without that rule, refreshing `/deck`,
`/liked`, or `/recipe/:id` returns a platform 404 instead of loading the SPA.

Production enforces a 90-second Gemini deadline and a 100-second browser API
deadline. Dishly uses `gemini-3.5-flash-lite` for this lightweight structured
classification and falls back to `gemini-3.6-flash` on capacity, quota,
retired-model, network, or invalid-output failures. Each model gets at most two
attempts for transient `408`/`5xx` failures with exponential backoff and jitter;
`429` advances without repeatedly spending the same model's quota. The owned
deadline covers the whole model chain. Keep the browser deadline longer than
the provider deadline so a slow provider response is reported accurately
instead of becoming a generic client timeout.

After Gemini parsing, Dishly deterministically preserves explicit numeric
calorie, protein, carbohydrate, and preparation-time limits from the user's
text. Recipe results are checked again after Spoonacular normalization; a
recipe outside a saved numeric bound, or missing the value needed to verify
that bound, is not placed in the deck.

Render builds with `npm ci`, waits for `/api/ready`, and deploys `main` only
after the GitHub quality gate passes. That gate performs locked installs,
production dependency audits, backend and frontend coverage, linting, a
production build, mocked-browser regression tests, and a deterministic
browser-to-Express integration test on Linux Chromium.

## Release verification

From the repository root on Windows:

```powershell
npm.cmd ci
npm.cmd run setup
npm.cmd run verify
npm.cmd --prefix backend run test:live
```

For a release stability pass, run the live test from `backend` with
`LIVE_API_ITERATIONS=3`. This performs three complete Gemini parse →
Spoonacular search → recipe detail rounds under production timeout and retry
semantics.

If port 3000 or 5173 is already used by another project, the deterministic
full-stack browser test supports isolated ports:

```powershell
$env:FULLSTACK_BACKEND_PORT = "3101"
$env:FULLSTACK_FRONTEND_PORT = "5174"
npm.cmd run test:fullstack
```

The live provider test intentionally consumes a small amount of Gemini and
Spoonacular quota. A successful public smoke test must cover the whole user
journey: submit a goal, receive a swipe deck, open a recipe, and confirm its
publisher source link.

## Deployment safety rule

Do not merge a provider-architecture replacement into `main` until every new
runtime service is deployed, configured, healthy, and exercised from a preview
frontend. In particular, a backend that requires `RETRIEVAL_SERVICE_URL` must
not replace the Gemini/Spoonacular backend while the retrieval service is
absent. That partial rollout caused the 2026-08-31 production failure.

## Recovery references

- Original working tree: `7ba5192`
- RAG version before restoration: `4bd9110`
- Restoration commit: `7deaf36`
- Public URL: <https://dishly.brandonjameschoi.com/>
- Canonical remote: <https://github.com/cuhacking-dishly/CU-Hack>

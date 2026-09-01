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

## Release verification

From the repository root on Windows:

```powershell
npm.cmd ci
npm.cmd run setup
npm.cmd run verify
npm.cmd --prefix backend run test:live
```

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


# Zero-cost production deployment

Dishly's supported production deployment costs $0 and keeps the complete local
RAG architecture:

```text
public browser
  -> Tailscale Funnel HTTPS (*.ts.net)
       -> Express on 127.0.0.1:3000
            |-> built React SPA
            |-> durable local SQLite
            `-> token-protected FastAPI on 127.0.0.1:8000
                  -> Ollama on 127.0.0.1:11434
                       |-> qwen3:4b-instruct
                       `-> embeddinggemma
                  -> reviewed corpus + digest-bound vector index
```

There is no Render, Vercel, hosted database, hosted AI API, credit card, trial,
or metered cloud resource in this topology. Tailscale Funnel is available on the
free Personal plan. The tradeoff is physical: this Windows machine must stay
powered on, connected to the internet, and awake.

Ollama and FastAPI are never exposed directly. Funnel publishes only the
loopback Express gateway. Express serves the frontend and API on the same origin,
uses an exact CORS allowlist, applies a restrictive CSP and security headers, and
shares a generated 256-bit bearer token with FastAPI.

## Prerequisites

- Windows 10/11 x64
- Node.js 24+ and npm 11+
- Ollama for Windows
- Tailscale 1.38.3+ on a free Personal tailnet
- about 5 GB free for models, dependencies, indexes, logs, and state
- a machine power policy that does not sleep while hosting

Python does not need to be installed globally when `uv` is available. The setup
script can install a project-local Python 3.12 runtime under `.runtime/`.

## One-time Tailscale authorization

Open an elevated PowerShell and connect the device:

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" up `
  --unattended `
  --hostname=dishly
```

Open the one-time URL it prints, sign in to the intended free Tailscale account,
and authorize the device. Funnel requires MagicDNS and HTTPS; the first
`production:start` run enables the narrowly scoped Funnel capability if the
tailnet asks for it.

This authorization is the only external account action. Review the OAuth and
Funnel permission screens before accepting them. Neither action creates a paid
resource.

## First deployment

Run from an elevated PowerShell in the repository root:

```powershell
npm.cmd run production:start
```

The command is transactional:

1. installs exact lockfile dependencies;
2. creates or repairs the local Python environment;
3. starts Ollama and ensures both pinned models exist;
4. validates all reviewed recipes and builds the vector index;
5. builds the React production bundle with same-origin `/api`;
6. creates a private 256-bit retrieval token under `.dishly/`;
7. starts token-protected FastAPI on loopback;
8. starts Express/React on loopback with required SQLite persistence;
9. waits for dependency readiness;
10. runs the real qwen3/embeddinggemma production verifier locally;
11. starts Tailscale Funnel in background mode;
12. runs the same verifier against the public HTTPS URL.

If any step fails, processes started by that attempt are stopped and no success
record is written. The error and service logs remain available for diagnosis.

For a fast restart after dependencies/models are already installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/start-free-production.ps1 `
  -SkipSetup
```

For a production-shaped local run that creates no public tunnel:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/start-free-production.ps1 `
  -LocalOnly
```

## Runtime files

All generated production state is ignored by Git:

| Path | Purpose |
| --- | --- |
| `.dishly/state/dishly.sqlite` | Durable goals and swipe history. |
| `.dishly/retrieval-token` | Private Express/FastAPI bearer token. |
| `.dishly/logs/` | Separate stdout/stderr logs for both services. |
| `.dishly/deployment.json` | Public URL, local ports, PIDs, and paths; no secret. |
| `dishly-addon/data/embeddings.json` | Generated corpus/model-bound vector index. |
| `.runtime/python/` | Optional uv-managed Python runtime. |
| `.cache/uv/` | Project-local uv package cache. |

SQLite uses WAL mode, a 5-second busy timeout, strict tables, atomic swipe
retention, and a hard limit of the newest 1,000 swipes per user. A new goal gets
a monotonically increasing version even if the system clock does not advance.
PostgreSQL remains supported through `DATABASE_URL`, which takes precedence over
SQLite, but it is not required by the zero-cost deployment.

## Status, logs, and shutdown

```powershell
npm.cmd run production:status
Get-Content .dishly\logs\backend.stderr.log -Tail 100
Get-Content .dishly\logs\retrieval.stderr.log -Tail 100
npm.cmd run production:stop
```

`production:stop` removes the public Funnel and stops both app processes while
preserving SQLite, the vector index, the token, and logs. Use
`scripts/stop-free-production.ps1 -KeepFunnel` only during a short controlled
restart; a Funnel with no healthy local gateway returns an upstream error.

Tailscale Funnel status is independently visible with:

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" funnel status
```

## Acceptance checks

The machine verifier proves:

- public liveness and dependency readiness;
- exact production CORS;
- a real qwen3 goal parse plus deterministic peanut-safety recovery;
- `ollama:embeddinggemma` vector retrieval from the generated index;
- reviewed publisher recipe provenance;
- durable goal round-trip and swipe exclusion;
- detail lookup and SPA direct routes;
- absence of database, retrieval URL, and token markers in browser bundles.

Run it again at any time:

```powershell
$deployment = Get-Content .dishly\deployment.json | ConvertFrom-Json
node scripts/verify-production.mjs `
  --api $deployment.api `
  --frontend $deployment.origin `
  --origin $deployment.origin
```

The deterministic release gate adds Python/backend/frontend coverage, lint,
OpenAPI/deployment schema checks, the exact Linux container build, mocked browser
journeys, real Express full-stack behavior, and production-shaped same-origin
journeys at desktop and mobile widths:

```powershell
npm.cmd run verify
npm.cmd run test:local-rag
```

## Backup and restore

Stop Dishly before copying SQLite so the database and WAL are a consistent set:

```powershell
npm.cmd run production:stop
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force ".dishly\backups\$stamp" | Out-Null
Copy-Item ".dishly\state\dishly.sqlite*" ".dishly\backups\$stamp\"
```

Restore only while Dishly is stopped:

```powershell
Copy-Item ".dishly\backups\BACKUP-STAMP\dishly.sqlite*" `
  ".dishly\state\" `
  -Force
npm.cmd run production:start
```

The retrieval token is not data and can be regenerated by deleting it while the
services are stopped. Never commit `.dishly/`.

## Upgrade and rollback

Before an upgrade, record the currently deployed commit and take a SQLite backup.
Then stop, update the repository, and run the complete start command so lockfiles,
the Python package, corpus, index, and frontend are rebuilt together.

To roll back:

1. stop production;
2. restore the previously deployed Git commit in a clean worktree;
3. restore the matching SQLite backup only if a future migration requires it;
4. run `npm.cmd run production:start`;
5. rerun the public verifier and browser smoke.

The current SQLite schema is additive and created idempotently. The existing
PostgreSQL migration remains backward-compatible.

## Troubleshooting

- **Tailscale reports `NeedsLogin`:** rerun the elevated `tailscale up` command
  and finish its one-time browser authorization.
- **Tailscale CLI says access denied:** run production commands from an elevated
  PowerShell. Do not weaken filesystem or service ACLs.
- **Funnel asks to enable access:** approve only the Funnel capability for this
  tailnet; Dishly never needs an exit node, subnet routes, SSH, or public Ollama.
- **Retrieval readiness is false:** inspect retrieval stderr, confirm Ollama is
  listening on `127.0.0.1:11434`, then run
  `dishly-addon\.venv\Scripts\python.exe -m dishly_retrieval status`.
- **Storage readiness is false:** confirm `.dishly/state/` is writable and no
  other program has locked/deleted the SQLite files.
- **Public URL is offline after sleep/reboot:** disable sleep while plugged in
  and rerun `production:start`. Tailscale's Funnel mapping persists, but the
  Dishly processes must be running.
- **Parser is slow on first request:** qwen3 may be cold. The configured Python,
  Express, and browser deadlines deliberately allow up to several minutes.
- **Port 3000 or 8000 is occupied:** stop the conflicting process or use
  `-Port`/`-RetrievalPort`; the status file records non-default values.

## Paid provider files

`render.yaml`, `frontend/vercel.json`, and the portable retrieval Dockerfile are
retained for portability and CI validation. The Render Blueprint explicitly
contains paid resources and is not part of the supported zero-cost deployment.
Do not create it unless the owner later gives separate, explicit billing
authorization.

# Dishly Recipe Match

Dishly Recipe Match is a full-stack recipe-discovery app. Describe what you want to eat, refine the nutrition or dietary filters, then browse a swipeable recipe deck. The Express backend uses Gemini to interpret goals and Spoonacular to find recipes; the React frontend displays and saves each swipe.

This guide is the complete starting point for a fresh clone.

## Quick start (Windows PowerShell)

### 1. Prerequisites

- [Node.js 24 or later](https://nodejs.org/) (includes npm)
- npm 11 or later
- A Gemini API key and a Spoonacular API key to use the live app
- Microsoft Edge only if you intend to run the Playwright browser tests

Confirm Node and npm are available:

```powershell
node --version
npm.cmd --version
```

### 2. Clone and install

```powershell
git clone https://github.com/Jeffrey-dai17/CU-Hack.git
cd CU-Hack
npm.cmd ci
npm.cmd run setup
```

`npm.cmd ci` installs the root development runner, and `npm.cmd run setup` installs the locked backend and frontend dependencies. Use `npm.cmd` in PowerShell to avoid the Windows execution-policy issue that can block `npm.ps1`.

### 3. Add your provider keys

Copy the safe template; it is intentionally committed without secrets:

```powershell
Copy-Item backend/.env.example backend/.env
notepad backend/.env
```

Add your values to these lines in `backend/.env`:

```dotenv
GEMINI_API_KEY=your_gemini_key
SPOONACULAR_API_KEY=your_spoonacular_key
```

Keep `backend/.env` private. It is ignored by Git and must never be committed. Do not put provider keys in `frontend/.env` or any `VITE_*` variable: Vite embeds those variables in browser code.

### 4. Start the app

```powershell
npm.cmd run dev
```

Open [http://localhost:5173](http://localhost:5173). The frontend runs on port 5173 and the API runs on [http://localhost:3000/api](http://localhost:3000/api). Press `Ctrl+C` in the terminal to stop both processes.

To confirm the backend is running, open [http://localhost:3000/api/health](http://localhost:3000/api/health). [http://localhost:3000/api/ready](http://localhost:3000/api/ready) returns `200` only after both provider keys are configured.

## macOS and Linux

Use the same sequence, replacing `npm.cmd` with `npm` and the PowerShell copy command with:

```bash
cp backend/.env.example backend/.env
```

## Useful commands

Run these from the repository root.

| Command | What it does |
| --- | --- |
| `npm.cmd run dev` | Starts backend and frontend together for development. |
| `npm.cmd run verify` | Runs all deterministic tests, linting, coverage, build, and browser checks. No API keys or provider quota are needed. |
| `npm.cmd run test:fullstack` | Runs the browser-to-Express integration test with deterministic provider boundaries. |
| `npm.cmd --prefix backend run test:live` | Calls the real Gemini and Spoonacular services. Requires keys and consumes provider quota. |
| `npm.cmd --prefix frontend run build` | Creates the production frontend bundle. |

## First-run troubleshooting

| Symptom | What to do |
| --- | --- |
| `npm` is blocked in PowerShell | Use `npm.cmd`, as shown above. |
| `node` is not recognized or is older than 24 | Install the current Node.js LTS release, reopen the terminal, and rerun the install commands. |
| The page loads but recipe requests fail with `503` | Check that `backend/.env` exists, both keys are filled in, and restart `npm.cmd run dev`. |
| A port is already in use | Stop the other service using port `3000` or `5173`, then start again. The frontend intentionally keeps port `5173` so the backend CORS configuration matches. |
| Browser requests are blocked by CORS | Keep the default frontend URL, or add the exact frontend origin to `CORS_ORIGINS` in `backend/.env` and restart the backend. |
| `npm.cmd run test:fullstack` cannot find Edge | Install Microsoft Edge, or run the unit and API test commands separately. |

## Project layout

```text
backend/        Express API, provider integrations, API tests, and .env template
frontend/       React/Vite interface, component tests, and Playwright tests
backend/openapi.yaml  Complete API contract
```

The backend keeps goals and swipe history in memory for this hackathon demo. Restarting it clears that data. It has no authentication and is not configured as a persistent production service.

## More detail

- [Backend README](./backend/README.md): API endpoints, configuration, error handling, test commands, and OpenAPI contract.
- [Frontend README](./frontend/README.md): UI behavior, frontend tests, responsive behavior, and deployment routing requirement.
- [Frontend design notes](./frontend/DESIGN.md): shared visual components and motion-system constraints.

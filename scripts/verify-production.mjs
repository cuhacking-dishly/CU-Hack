import { pathToFileURL } from "node:url";

const DEFAULT_GOAL = "Asian food for dinner with 50g of protein and no peanuts";
const MAX_BODY_BYTES = 5_000_000;

export function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (!["--api", "--frontend", "--origin"].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!options.api) throw new Error("--api is required");
  return options;
}

export function normalizeHttpUrl(value, label) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials`);
  }
  return url.toString().replace(/\/+$/, "");
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function readBoundedBody(response, label) {
  const body = await response.text();
  assertCondition(body.length <= MAX_BODY_BYTES, `${label} returned an oversized body`);
  return body;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(310_000),
  });
  const raw = await readBoundedBody(response, url);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`${url} did not return JSON`);
  }
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${body.error || body.detail || "error"}`);
  }
  return { body, response };
}

async function postJson(url, body, options = {}) {
  return requestJson(url, {
    ...options,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

async function verifyFrontend(frontendUrl) {
  const routeChecks = ["/", "/deck", "/liked", "/recipe/1"];
  let indexHtml;
  for (const pathname of routeChecks) {
    const response = await fetch(`${frontendUrl}${pathname}`, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await readBoundedBody(response, `${frontendUrl}${pathname}`);
    assertCondition(response.ok, `Frontend route ${pathname} returned HTTP ${response.status}`);
    assertCondition(/<div\s+id=["']root["']/.test(body), `Frontend route ${pathname} missed the app shell`);
    if (pathname === "/") indexHtml = body;
  }

  const scripts = [...indexHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/g)]
    .map((match) => new URL(match[1], `${frontendUrl}/`).toString());
  assertCondition(scripts.length > 0, "Frontend HTML did not reference an application bundle");
  const forbidden = [
    "RETRIEVAL_SERVICE_URL",
    "RETRIEVAL_SERVICE_TOKEN",
    "DISHLY_SERVICE_TOKEN",
    "DATABASE_URL",
  ];
  for (const scriptUrl of scripts.slice(0, 10)) {
    const response = await fetch(scriptUrl, { signal: AbortSignal.timeout(30_000) });
    const source = await readBoundedBody(response, scriptUrl);
    assertCondition(response.ok, `Frontend bundle returned HTTP ${response.status}`);
    for (const marker of forbidden) {
      assertCondition(!source.includes(marker), `Frontend bundle exposed private marker ${marker}`);
    }
  }
  return { directRoutes: routeChecks.length, bundlesScanned: scripts.length };
}

export async function runProductionSmoke({ api, frontend, origin }) {
  const apiBase = normalizeHttpUrl(api, "API URL");
  const frontendBase = frontend ? normalizeHttpUrl(frontend, "Frontend URL") : null;
  const browserOrigin = normalizeHttpUrl(origin || frontendBase || "https://dishly-smoke.invalid", "Origin");
  const userId = `production-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const health = await requestJson(`${apiBase}/health`, {
    headers: { Origin: browserOrigin },
  });
  assertCondition(health.body.ok === true, "API health did not report ok");
  assertCondition(
    health.response.headers.get("access-control-allow-origin") === browserOrigin,
    "Production CORS did not echo the allowed browser origin"
  );

  const readiness = (await requestJson(`${apiBase}/ready`)).body;
  assertCondition(readiness.ok === true, "API readiness did not report ok");
  assertCondition(readiness.services?.retrieval === true, "Retrieval readiness failed");
  assertCondition(readiness.services?.storage === true, "Storage readiness failed");

  const parsed = (await postJson(`${apiBase}/parse-goal`, { text: DEFAULT_GOAL })).body;
  assertCondition(parsed.parsedFilter?.cuisines?.includes("asian"), "Parser lost Asian cuisine");
  assertCondition(parsed.parsedFilter?.intolerances?.includes("peanut"), "Parser lost peanut safety");

  await postJson(`${apiBase}/goal`, {
    userId,
    rawText: DEFAULT_GOAL,
    parsedFilter: parsed.parsedFilter,
  });
  const goal = (await requestJson(
    `${apiBase}/goal/current?userId=${encodeURIComponent(userId)}`
  )).body;
  assertCondition(goal?.rawText === DEFAULT_GOAL, "Saved goal did not round-trip");
  assertCondition(typeof goal.updatedAt === "string", "Saved goal has no persistent version");

  const recipePage = (await requestJson(
    `${apiBase}/recipes?userId=${encodeURIComponent(userId)}&limit=10&offset=0&matchMode=exact`
  )).body;
  assertCondition(recipePage.match?.semanticProvider === "ollama:embeddinggemma", "Vector RAG was not used");
  assertCondition(recipePage.recipes?.length > 0, "Production retrieval returned no reviewed recipes");
  const selected = recipePage.recipes[0];
  assertCondition(selected.sourceUrl && selected.image, "Recipe lost publisher provenance");

  const detail = (await requestJson(`${apiBase}/recipes/${encodeURIComponent(selected.id)}`)).body;
  assertCondition(detail.id === selected.id, "Recipe detail did not match the selected card");
  await postJson(`${apiBase}/swipe`, {
    userId,
    recipeId: selected.id,
    direction: "right",
  });
  const afterSwipe = (await requestJson(
    `${apiBase}/recipes?userId=${encodeURIComponent(userId)}&limit=10&offset=0&matchMode=exact`
  )).body;
  assertCondition(
    !afterSwipe.recipes.some((recipe) => recipe.id === selected.id),
    "Persisted swipe did not exclude the reviewed recipe"
  );

  const frontendResult = frontendBase ? await verifyFrontend(frontendBase) : null;
  return {
    ok: true,
    api: apiBase,
    frontend: frontendBase,
    userId,
    recipeId: selected.id,
    semanticProvider: recipePage.match.semanticProvider,
    parserChecks: {
      asian: true,
      peanutSafety: true,
    },
    storage: "ready and swipe exclusion verified",
    frontendChecks: frontendResult,
  };
}

async function main() {
  const result = await runProductionSmoke(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Production smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}

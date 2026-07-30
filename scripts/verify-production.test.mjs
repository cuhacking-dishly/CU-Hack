import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  normalizeHttpUrl,
  parseArguments,
  runProductionSmoke,
} from "./verify-production.mjs";

test("production verifier validates arguments and URLs", () => {
  assert.deepEqual(parseArguments(["--api", "https://api.test/api"]), {
    api: "https://api.test/api",
  });
  assert.throws(() => parseArguments([]), /--api is required/);
  assert.throws(() => parseArguments(["--unknown", "x"]), /Unknown argument/);
  assert.throws(() => parseArguments(["--api"]), /requires a value/);
  assert.equal(normalizeHttpUrl("https://example.test///", "URL"), "https://example.test");
  assert.throws(() => normalizeHttpUrl("file:///tmp/test", "URL"), /HTTP/);
  assert.throws(() => normalizeHttpUrl("https://user:pass@example.test", "URL"), /credentials/);
});

test("production verifier exercises API, CORS, RAG metadata, persistence, and SPA routes", async () => {
  let swiped = false;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const json = (status, body, headers = {}) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        ...headers,
      });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/health") {
      json(200, { ok: true }, {
        "Access-Control-Allow-Origin": request.headers.origin,
      });
    } else if (url.pathname === "/api/ready") {
      json(200, { ok: true, services: { retrieval: true, storage: true } });
    } else if (url.pathname === "/api/parse-goal") {
      json(200, {
        parsedFilter: {
          cuisines: ["asian"],
          intolerances: ["peanut"],
          excludeIngredients: ["peanuts"],
        },
      });
    } else if (url.pathname === "/api/goal" || url.pathname === "/api/swipe") {
      if (url.pathname === "/api/swipe") swiped = true;
      json(200, { success: true });
    } else if (url.pathname === "/api/goal/current") {
      json(200, {
        rawText: "Asian food for dinner with 50g of protein and no peanuts",
        parsedFilter: {},
        updatedAt: "2026-07-29T12:00:00.000Z",
      });
    } else if (url.pathname === "/api/recipes") {
      const recipe = {
        id: "101",
        title: "Publisher Recipe",
        image: "https://images.example/recipe.jpg",
        sourceUrl: "https://publisher.example/recipe",
      };
      json(200, {
        recipes: swiped ? [] : [recipe],
        pagination: { limit: 10, offset: 0, count: swiped ? 0 : 1, hasMore: false },
        match: { semanticProvider: "ollama:embeddinggemma" },
      });
    } else if (url.pathname === "/api/recipes/101") {
      json(200, {
        id: "101",
        image: "https://images.example/recipe.jpg",
        sourceUrl: "https://publisher.example/recipe",
      });
    } else if (url.pathname === "/assets/app.js") {
      response.writeHead(200, { "Content-Type": "application/javascript" });
      response.end("console.log('dishly');");
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<div id="root"></div><script src="/assets/app.js"></script>');
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await runProductionSmoke({
      api: `${base}/api`,
      frontend: base,
      origin: base,
    });
    assert.equal(result.ok, true);
    assert.equal(result.semanticProvider, "ollama:embeddinggemma");
    assert.deepEqual(result.frontendChecks, {
      directRoutes: 4,
      bundlesScanned: 1,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

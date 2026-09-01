const assert = require("node:assert/strict");
const http = require("node:http");

const requestedPort = Number(process.env.FULLSTACK_BACKEND_PORT);
const PORT = Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535
  ? requestedPort
  : 3000;
const HOST = "localhost";
const USER_ID = "demo-user-1";
const OBSERVATION_PATH = "/__recipe_match_fullstack__/state";
const EXPECTED_FILTER = {
  maxCalories: 600,
  minProtein_g: 30,
  diet: "vegan",
  maxReadyTime: 30,
  excludeIngredients: ["peanuts"],
};

const serverPath = require.resolve("../src/server");
const geminiServicePath = require.resolve("../src/services/geminiService");
const spoonacularServicePath = require.resolve("../src/services/spoonacularService");
const memoryStorePath = require.resolve("../src/store/memoryStore");
const dotenvPath = require.resolve("dotenv");

const providerCalls = {
  parseGoal: [],
  searchRecipes: [],
  getRecipeById: [],
};

const recipes = Array.from({ length: 12 }, (_unused, index) => {
  const sequence = index + 1;
  const id = String(41000 + sequence);

  return {
    id,
    title: `Fixture Match ${String(sequence).padStart(2, "0")}`,
    image: "",
    readyInMinutes: 14 + sequence,
    servings: sequence % 2 === 0 ? 2 : 1,
    calories: 400 + sequence,
    macros: {
      protein_g: 30 + sequence,
      carbs_g: 40 + sequence,
      fat_g: 10 + sequence,
    },
    diets: ["vegan"],
    ingredients: [`Ingredient ${sequence}A`, `Ingredient ${sequence}B`],
    instructions: [`Prep fixture match ${sequence}.`, `Serve fixture match ${sequence}.`],
    sourceName: "Fixture Kitchen",
    sourceUrl: `https://recipes.example/full-stack/${id}`,
  };
});
const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));

function installModuleStub(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

// The deterministic launcher must never load a developer's backend/.env file.
// Production startup still uses the real dotenv module from backend/src/server.js.
installModuleStub(dotenvPath, { config: () => ({ parsed: {} }) });

async function parseGoal(text) {
  providerCalls.parseGoal.push(text);
  return structuredClone(EXPECTED_FILTER);
}

async function searchRecipePage(filter, options) {
  assert.deepEqual(filter, EXPECTED_FILTER);
  providerCalls.searchRecipes.push({
    filter: structuredClone(filter),
    options: structuredClone(options),
  });

  const pageRecipes = recipes.slice(options.offset, options.offset + options.limit);
  return {
    recipes: structuredClone(pageRecipes),
    hasMore: options.offset + options.limit < recipes.length,
  };
}

async function searchRecipes(filter, options) {
  return (await searchRecipePage(filter, options)).recipes;
}

async function getRecipeById(id) {
  providerCalls.getRecipeById.push(id);
  const recipe = recipesById.get(String(id));
  assert.ok(recipe, `Unexpected deterministic recipe id: ${id}`);
  return structuredClone(recipe);
}

installModuleStub(geminiServicePath, { parseGoal });
installModuleStub(spoonacularServicePath, {
  getRecipeById,
  searchRecipePage,
  searchRecipes,
});

process.env.CORS_ORIGINS = process.env.FULLSTACK_FRONTEND_ORIGIN || "http://localhost:5173";

const app = require(serverPath);
const { clearStore, getGoal, getSwipes } = require(memoryStorePath);
clearStore();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === "GET" && url.pathname === OBSERVATION_PATH) {
    const body = JSON.stringify({
      goal: getGoal(USER_ID),
      swipes: getSwipes(USER_ID),
      providerCalls: structuredClone(providerCalls),
    });
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  app(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Deterministic full-stack backend listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

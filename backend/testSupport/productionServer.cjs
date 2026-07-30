const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const requestedPort = Number(process.env.PRODUCTION_TEST_PORT);
const PORT = Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535
  ? requestedPort
  : 3010;
const HOST = "127.0.0.1";
const repositoryDirectory = path.resolve(__dirname, "..", "..");
const frontendDistribution = path.join(repositoryDirectory, "frontend", "dist");
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dishly-production-e2e-"));

const serverPath = require.resolve("../src/server");
const retrievalServicePath = require.resolve("../src/services/retrievalService");
const dotenvPath = require.resolve("dotenv");

const parsedFilter = {
  cuisines: ["asian"],
  minProtein_g: 30,
  intolerances: ["peanut"],
};
const recipes = [
  {
    id: "51001",
    title: "Sesame-Free Ginger Tofu Bowl",
    image: "https://images.example.test/ginger-tofu.jpg",
    readyInMinutes: 25,
    servings: 2,
    calories: 520,
    macros: { protein_g: 34, carbs_g: 61, fat_g: 17 },
    diets: ["vegan"],
    ingredients: ["14 oz firm tofu", "2 cups brown rice", "1 tbsp fresh ginger"],
    instructions: ["Press and roast the tofu.", "Serve over rice with ginger sauce."],
    sourceName: "Reviewed Fixture Kitchen",
    sourceUrl: "https://recipes.example.test/ginger-tofu",
  },
  {
    id: "51002",
    title: "Citrus Chicken Rice Bowl",
    image: "https://images.example.test/citrus-chicken.jpg",
    readyInMinutes: 30,
    servings: 2,
    calories: 560,
    macros: { protein_g: 47, carbs_g: 58, fat_g: 14 },
    diets: ["gluten free"],
    ingredients: ["12 oz chicken breast", "2 cups rice", "1 orange"],
    instructions: ["Sear the chicken.", "Glaze with orange and serve over rice."],
    sourceName: "Reviewed Fixture Kitchen",
    sourceUrl: "https://recipes.example.test/citrus-chicken",
  },
];
const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));

function installModuleStub(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

installModuleStub(dotenvPath, { config: () => ({ parsed: {} }) });
installModuleStub(retrievalServicePath, {
  checkRetrievalReadiness: async () => true,
  parseGoal: async () => structuredClone(parsedFilter),
  searchRecipePage: async (_goal, options) => {
    const excluded = new Set(options.excludedRecipeIds || []);
    const eligible = recipes.filter((recipe) => !excluded.has(recipe.id));
    const page = eligible.slice(options.offset, options.offset + options.limit);
    return {
      recipes: structuredClone(page),
      pagination: {
        limit: options.limit,
        offset: options.offset,
        count: page.length,
        hasMore: options.offset + options.limit < eligible.length,
      },
      match: {
        mode: options.matchMode,
        canShowClosest: false,
        message: null,
        totalCandidates: eligible.length,
        semanticProvider: "ollama:embeddinggemma",
      },
    };
  },
  getRecipeById: async (id) => {
    const recipe = recipesById.get(String(id));
    if (!recipe) {
      const error = new Error("Recipe not found");
      error.statusCode = 404;
      error.publicMessage = "Recipe not found";
      throw error;
    }
    return structuredClone(recipe);
  },
});

process.env.CORS_ORIGINS = `http://${HOST}:${PORT}`;
process.env.FRONTEND_DIST_PATH = frontendDistribution;
process.env.NODE_ENV = "production";
process.env.REQUIRE_PERSISTENT_STORE = "true";
process.env.SQLITE_DATABASE_PATH = path.join(temporaryDirectory, "dishly.sqlite");
delete process.env.DATABASE_URL;

const app = require(serverPath);
const { closeStore, initializeStore } = require("../src/store");
const server = http.createServer(app);

initializeStore()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`Production-shaped Dishly server listening on http://${HOST}:${PORT}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await closeStore();
  fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

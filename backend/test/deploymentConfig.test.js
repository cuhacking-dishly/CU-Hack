const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const repositoryDirectory = path.resolve(__dirname, "../..");

test("Render deploys the locked backend only after checks and readiness pass", async () => {
  const renderConfig = await readFile(path.join(repositoryDirectory, "render.yaml"), "utf8");

  assert.match(
    renderConfig,
    /^# yaml-language-server: \$schema=https:\/\/render\.com\/schema\/render\.yaml\.json/m
  );
  assert.match(renderConfig, /^\s+buildCommand: npm ci$/m);
  assert.match(renderConfig, /^\s+healthCheckPath: \/api\/ready$/m);
  assert.match(renderConfig, /^\s+autoDeployTrigger: checksPass$/m);
  assert.match(renderConfig, /^\s+value: "https:\/\/dishly\.brandonjameschoi\.com"$/m);
  assert.match(renderConfig, /^\s+- key: GEMINI_MODEL\r?\n\s+value: gemini-3\.5-flash-lite$/m);
  assert.match(
    renderConfig,
    /^\s+- key: GEMINI_FALLBACK_MODELS\r?\n\s+value: gemini-3\.6-flash$/m
  );
  assert.match(renderConfig, /^\s+- key: GEMINI_RETRY_ATTEMPTS\r?\n\s+value: 2$/m);
  assert.doesNotMatch(renderConfig, /your-frontend-url|REPLACE THIS/i);
});

test("GitHub Actions runs the complete deterministic gate on portable Chromium", async () => {
  const workflow = await readFile(
    path.join(repositoryDirectory, ".github/workflows/quality-gate.yml"),
    "utf8"
  );

  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run setup/);
  assert.match(workflow, /playwright install chromium --with-deps/);
  assert.match(workflow, /PLAYWRIGHT_CHANNEL: chromium/);
  assert.match(workflow, /npm run verify/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
});

test("Playwright starts the development server on Windows and Linux", async () => {
  const playwrightConfig = await readFile(
    path.join(repositoryDirectory, "frontend/playwright.config.js"),
    "utf8"
  );

  assert.match(playwrightConfig, /process\.platform === "win32" \? "npm\.cmd" : "npm"/);
  assert.match(playwrightConfig, /command: `\$\{npmCommand\} run dev`/);
  assert.doesNotMatch(playwrightConfig, /command: "npm\.cmd run dev"/);
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const frontendDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const requestedBackendPort = Number(process.env.FULLSTACK_BACKEND_PORT);
const backendPort =
  Number.isInteger(requestedBackendPort) && requestedBackendPort >= 1 && requestedBackendPort <= 65535
    ? requestedBackendPort
    : 3000;
const requestedFrontendPort = Number(process.env.FULLSTACK_FRONTEND_PORT);
const frontendPort =
  Number.isInteger(requestedFrontendPort) && requestedFrontendPort >= 1 && requestedFrontendPort <= 65535
    ? requestedFrontendPort
    : 5173;
const backendOrigin = `http://localhost:${backendPort}`;
const frontendOrigin = `http://localhost:${frontendPort}`;

export default defineConfig({
  testDir: "./e2e-fullstack",
  outputDir: "./test-results/fullstack",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: frontendOrigin,
    browserName: "chromium",
    channel: "msedge",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "node backend/testSupport/fullStackServer.cjs",
      cwd: repositoryDirectory,
      env: {
        FULLSTACK_BACKEND_PORT: String(backendPort),
        FULLSTACK_FRONTEND_ORIGIN: frontendOrigin,
      },
      url: `${backendOrigin}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `${npmCommand} run dev -- --port ${frontendPort} --strictPort`,
      cwd: frontendDirectory,
      env: { VITE_API_BASE_URL: `${backendOrigin}/api` },
      url: frontendOrigin,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});

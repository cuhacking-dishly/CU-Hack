import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const repositoryDirectory = fileURLToPath(new URL("..", import.meta.url));
const requestedBrowserChannel = process.env.PLAYWRIGHT_CHANNEL?.trim();
const browserChannel =
  requestedBrowserChannel || (process.platform === "win32" ? "msedge" : undefined);
const requestedPort = Number(process.env.PRODUCTION_TEST_PORT);
const port =
  Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535
    ? requestedPort
    : 3010;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e-production",
  outputDir: "./test-results/production",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: origin,
    browserName: "chromium",
    ...(browserChannel ? { channel: browserChannel } : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-production",
      use: { viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile-production",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    command: "node backend/testSupport/productionServer.cjs",
    cwd: repositoryDirectory,
    env: { PRODUCTION_TEST_PORT: String(port) },
    url: `${origin}/api/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

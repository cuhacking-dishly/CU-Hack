import { defineConfig } from "@playwright/test";

const requestedBrowserChannel = process.env.PLAYWRIGHT_CHANNEL?.trim();
const browserChannel =
  requestedBrowserChannel === "chromium" ? undefined : requestedBrowserChannel || "msedge";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5173",
    browserName: "chromium",
    ...(browserChannel ? { channel: browserChannel } : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm.cmd run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});

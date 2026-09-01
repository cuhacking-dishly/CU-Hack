import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const config = JSON.parse(
  await readFile(resolve(process.cwd(), "vercel.json"), "utf8"),
);

describe("Vercel deployment configuration", () => {
  it("builds the Vite app and rewrites every client route to the SPA entry point", () => {
    expect(config).toMatchObject({
      framework: "vite",
      buildCommand: "npm run build",
      outputDirectory: "dist",
    });
    expect(config.rewrites).toContainEqual({
      source: "/(.*)",
      destination: "/index.html",
    });
  });

  it("keeps immutable assets cached and applies baseline browser security headers", () => {
    const assetHeaders = config.headers.find(({ source }) => source === "/assets/(.*)");
    expect(assetHeaders?.headers).toContainEqual({
      key: "Cache-Control",
      value: "public, max-age=31536000, immutable",
    });

    const applicationHeaders = config.headers.find(({ source }) => source === "/(.*)");
    expect(applicationHeaders?.headers).toEqual(
      expect.arrayContaining([
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ]),
    );
  });
});

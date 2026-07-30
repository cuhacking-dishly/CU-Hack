const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const goalRoutes = require("./routes/goalRoutes");
const recipeRoutes = require("./routes/recipeRoutes");
const swipeRoutes = require("./routes/swipeRoutes");
const { createHttpError } = require("./routes/routeUtils");
const { checkRetrievalReadiness } = require("./services/retrievalService");
const {
  checkStoreReadiness,
  closeStore,
  initializeStore,
} = require("./store");

const app = express();

app.disable("x-powered-by");
app.set("json escape", true);
app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self' data:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data: https:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  if (process.env.NODE_ENV === "production") {
    res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use(createCorsMiddleware());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/ready", async (_req, res, next) => {
  let retrieval;
  let storage;
  try {
    [retrieval, storage] = await Promise.all([
      checkRetrievalReadiness(),
      checkStoreReadiness(),
    ]);
  } catch (error) {
    return next(error);
  }

  const services = {
    retrieval,
    storage,
  };
  const ok = Object.values(services).every(Boolean);

  return res.status(ok ? 200 : 503).json({ ok, services });
});

app.use("/api", goalRoutes);
app.use("/api", recipeRoutes);
app.use("/api", swipeRoutes);

const frontend = resolveFrontendDistribution();
if (frontend) {
  app.use(express.static(frontend.directory, {
    etag: true,
    index: false,
    setHeaders(res, filePath) {
      const relativePath = path.relative(frontend.directory, filePath);
      if (relativePath.split(path.sep)[0] === "assets") {
        res.set("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.set("Cache-Control", "public, max-age=3600");
      }
    },
  }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/") || path.extname(req.path)) return next();
    res.set("Cache-Control", "no-cache");
    return res.sendFile(frontend.indexPath);
  });
}

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const { statusCode, publicMessage } = normalizeError(error);
  if (statusCode >= 500) {
    const diagnostic = {
      method: req.method,
      path: req.path,
      statusCode,
      message: redactConfiguredSecrets(error?.message || String(error)),
    };
    if (typeof error?.code === "string") {
      diagnostic.code = redactConfiguredSecrets(error.code);
    }
    if (typeof error?.retryable === "boolean") diagnostic.retryable = error.retryable;
    if (error?.cause?.message) {
      diagnostic.cause = redactConfiguredSecrets(error.cause.message);
    }
    console.error("HTTP request failed", diagnostic);
  }

  return res.status(statusCode).json({ error: publicMessage });
});

async function startServer() {
  const port = parsePort(process.env.PORT);
  const host = parseHost(process.env.HOST);
  await initializeStore();
  const server = app.listen(port, host, () => {
    console.log(`Backend listening on http://${host}:${port}`);
  });
  const shutdown = async () => {
    server.close(async () => {
      await closeStore();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Backend startup failed", {
      message: redactConfiguredSecrets(error?.message || String(error)),
    });
    process.exitCode = 1;
  });
}

module.exports = app;
module.exports.startServer = startServer;

function createCorsMiddleware() {
  const configuredOrigins = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configuredOrigins.length === 0 || configuredOrigins.includes("*")) {
    return cors();
  }

  const allowedOrigins = new Set(configuredOrigins);
  return cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }

      return callback(createHttpError(403, "Origin not allowed by CORS"));
    },
  });
}

function normalizeError(error) {
  if (error?.type === "entity.parse.failed") {
    return { statusCode: 400, publicMessage: "Invalid JSON body" };
  }

  if (error?.type === "entity.too.large") {
    return { statusCode: 413, publicMessage: "Request body is too large" };
  }

  const candidate = Number(error?.statusCode ?? error?.status);
  const statusCode =
    Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  const hasPublicMessage =
    typeof error?.publicMessage === "string" && error.publicMessage.trim() !== "";

  return {
    statusCode,
    publicMessage: hasPublicMessage ? error.publicMessage : "Unexpected server error",
  };
}

function redactConfiguredSecrets(value) {
  let redacted = String(value);
  for (const name of [
    "DATABASE_URL",
    "RETRIEVAL_SERVICE_HOSTPORT",
    "RETRIEVAL_SERVICE_TOKEN",
    "RETRIEVAL_SERVICE_URL",
  ]) {
    const secret = process.env[name];
    if (typeof secret === "string" && secret.trim() !== "") {
      const rawVariants = [secret, secret.trim()];
      const variants = [
        ...new Set(
          rawVariants.flatMap((variant) => [
            variant,
            encodeURIComponent(variant.toWellFormed()),
            new URLSearchParams({ value: variant }).toString().slice("value=".length),
          ])
        ),
      ]
        .filter(Boolean)
        .sort((left, right) => right.length - left.length);
      for (const variant of variants) {
        redacted = redacted.split(variant).join("[REDACTED]");
      }
    }
  }
  return redacted;
}

function parsePort(value) {
  const normalized = value === undefined || value === "" ? "3000" : String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}

function parseHost(value) {
  const normalized = value === undefined || value === "" ? "0.0.0.0" : String(value).trim();
  if (
    normalized === ""
    || normalized.length > 253
    || /[\s/?#\\]/.test(normalized)
  ) {
    throw new Error("HOST must be a valid hostname or IP address");
  }
  return normalized;
}

function resolveFrontendDistribution(value = process.env.FRONTEND_DIST_PATH) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const directory = path.resolve(value.trim());
  const indexPath = path.join(directory, "index.html");
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`FRONTEND_DIST_PATH is not a directory: ${directory}`);
  }
  if (!fs.statSync(indexPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`FRONTEND_DIST_PATH does not contain index.html: ${directory}`);
  }
  return { directory, indexPath };
}

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const goalRoutes = require("./routes/goalRoutes");
const recipeRoutes = require("./routes/recipeRoutes");
const swipeRoutes = require("./routes/swipeRoutes");
const { createHttpError } = require("./routes/routeUtils");

const app = express();

app.disable("x-powered-by");
app.set("json escape", true);
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use(createCorsMiddleware());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/ready", (_req, res) => {
  const services = {
    gemini: hasNonblankEnvironmentValue("GEMINI_API_KEY"),
    spoonacular: hasNonblankEnvironmentValue("SPOONACULAR_API_KEY"),
  };
  const ok = services.gemini && services.spoonacular;

  res.status(ok ? 200 : 503).json({ ok, services });
});

app.use("/api", goalRoutes);
app.use("/api", recipeRoutes);
app.use("/api", swipeRoutes);

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

if (require.main === module) {
  const port = parsePort(process.env.PORT);
  app.listen(port, () => {
    console.log(`Backend listening on http://localhost:${port}`);
  });
}

module.exports = app;

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

function hasNonblankEnvironmentValue(name) {
  return typeof process.env[name] === "string" && process.env[name].trim() !== "";
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
  for (const name of ["GEMINI_API_KEY", "SPOONACULAR_API_KEY"]) {
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

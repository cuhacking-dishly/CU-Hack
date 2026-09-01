const { createHttpError } = require("../routes/routeUtils");

const DEFAULT_TIMEOUT_MS = 10_000;

function getAccountConfig() {
  const url = cleanUrl(process.env.SUPABASE_URL);
  const publishableKey = cleanValue(process.env.SUPABASE_PUBLISHABLE_KEY);
  return {
    enabled: Boolean(url && publishableKey),
    url,
    publishableKey,
  };
}

function getPublicAccountConfig() {
  const config = getAccountConfig();
  return config.enabled
    ? { enabled: true, url: config.url, publishableKey: config.publishableKey }
    : { enabled: false };
}

async function authenticateRequest(req) {
  const config = requireAccountConfig();
  const authorization = String(req.get("authorization") || "").trim();
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match) throw createHttpError(401, "Sign in is required");

  const response = await supabaseFetch(`${config.url}/auth/v1/user`, {
    headers: {
      apikey: config.publishableKey,
      Authorization: `Bearer ${match[1]}`,
    },
  });
  if (!response.ok) throw createHttpError(401, "Your session is invalid or expired");

  const user = await readJson(response);
  if (!user || typeof user.id !== "string" || !user.id) {
    throw createHttpError(401, "Your session is invalid or expired");
  }
  return { token: match[1], user };
}

async function databaseRequest(auth, table, { method = "GET", query = "", body, prefer } = {}) {
  const config = requireAccountConfig();
  const headers = {
    apikey: config.publishableKey,
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;

  const response = await supabaseFetch(
    `${config.url}/rest/v1/${encodeURIComponent(table)}${query ? `?${query}` : ""}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
  );
  if (!response.ok) {
    const details = await readErrorDetails(response);
    const error = createHttpError(
      response.status === 409 ? 409 : 502,
      response.status === 409 ? "That item already exists" : "Recipe library is temporarily unavailable",
      `Supabase REST ${method} ${table} failed (${response.status}): ${safeDetails(details)}`,
    );
    throw error;
  }
  if (response.status === 204) return null;
  return readJson(response);
}

async function readErrorDetails(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function deleteAccount(auth) {
  const config = requireAccountConfig();
  const secretKey = cleanValue(process.env.SUPABASE_SECRET_KEY);
  if (!secretKey) {
    throw createHttpError(503, "Account deletion is not configured yet");
  }
  const response = await supabaseFetch(`${config.url}/auth/v1/admin/users/${encodeURIComponent(auth.user.id)}`, {
    method: "DELETE",
    headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` },
  });
  if (!response.ok) {
    throw createHttpError(502, "We couldn't delete the account. Please try again");
  }
}

function requireAccountConfig() {
  const config = getAccountConfig();
  if (!config.enabled) throw createHttpError(503, "Optional accounts are not configured yet");
  return config;
}

async function supabaseFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw createHttpError(502, "Account service is temporarily unavailable", error?.message);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw createHttpError(502, "Account service returned an invalid response");
  }
}

function cleanValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanUrl(value) {
  const candidate = cleanValue(value).replace(/\/+$/, "");
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? parsed.toString().replace(/\/$/, "") : "";
  } catch {
    return "";
  }
}

function safeDetails(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  return text.slice(0, 500).replace(/[\r\n]+/g, " ");
}

module.exports = {
  authenticateRequest,
  databaseRequest,
  deleteAccount,
  getAccountConfig,
  getPublicAccountConfig,
};

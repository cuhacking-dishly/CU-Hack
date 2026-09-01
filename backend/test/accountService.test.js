const assert = require("node:assert/strict");
const test = require("node:test");
const service = require("../src/services/accountService");

const originalFetch = global.fetch;
const originalEnvironment = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
};

test.afterEach(() => {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function configure() {
  process.env.SUPABASE_URL = " https://project.supabase.co/// ";
  process.env.SUPABASE_PUBLISHABLE_KEY = " public-key ";
}

function requestWithAuthorization(value = "Bearer good-token") {
  return { get: (name) => name === "authorization" ? value : "" };
}

test("account config exposes only public, valid HTTPS configuration", () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  assert.deepEqual(service.getPublicAccountConfig(), { enabled: false });
  process.env.SUPABASE_URL = "http://insecure.test";
  process.env.SUPABASE_PUBLISHABLE_KEY = "key";
  assert.equal(service.getAccountConfig().enabled, false);
  process.env.SUPABASE_URL = "not a url";
  assert.equal(service.getAccountConfig().url, "");
  configure();
  assert.deepEqual(service.getPublicAccountConfig(), { enabled: true, url: "https://project.supabase.co", publishableKey: "public-key" });
});

test("authentication verifies bearer sessions against Supabase Auth", async () => {
  configure();
  global.fetch = async (url, options) => {
    assert.equal(url, "https://project.supabase.co/auth/v1/user");
    assert.equal(options.headers.Authorization, "Bearer good-token");
    return new Response(JSON.stringify({ id: "user-1", email: "cook@example.com" }), { status: 200 });
  };
  await assert.doesNotReject(async () => {
    const result = await service.authenticateRequest(requestWithAuthorization());
    assert.equal(result.user.id, "user-1");
    assert.equal(result.token, "good-token");
  });
  await assert.rejects(service.authenticateRequest(requestWithAuthorization("Basic bad")), /Sign in is required/);
  global.fetch = async () => new Response("{}", { status: 401 });
  await assert.rejects(service.authenticateRequest(requestWithAuthorization()), /invalid or expired/);
  global.fetch = async () => new Response("{}", { status: 200 });
  await assert.rejects(service.authenticateRequest(requestWithAuthorization()), /invalid or expired/);
});

test("database requests forward the user token and normalize upstream outcomes", async () => {
  configure();
  const auth = { token: "token", user: { id: "user-1" } };
  global.fetch = async (url, options) => {
    assert.match(url, /rest\/v1\/saved_recipes\?select=/);
    assert.equal(options.headers.Authorization, "Bearer token");
    assert.equal(options.headers.Prefer, "return=representation");
    assert.equal(options.body, JSON.stringify({ hello: "world" }));
    return new Response(JSON.stringify([{ id: "saved" }]), { status: 200 });
  };
  assert.deepEqual(await service.databaseRequest(auth, "saved_recipes", { method: "POST", query: "select=id", body: { hello: "world" }, prefer: "return=representation" }), [{ id: "saved" }]);
  global.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await service.databaseRequest(auth, "saved_recipes", { method: "DELETE" }), null);
  global.fetch = async () => new Response(JSON.stringify({ message: "duplicate" }), { status: 409 });
  await assert.rejects(
    service.databaseRequest(auth, "saved_recipes"),
    (error) => error.publicMessage === "That item already exists" && error.statusCode === 409,
  );
  global.fetch = async () => new Response("upstream details", { status: 500 });
  await assert.rejects(
    service.databaseRequest(auth, "saved_recipes"),
    (error) => error.publicMessage === "Recipe library is temporarily unavailable",
  );
  global.fetch = async () => new Response("not json", { status: 200 });
  await assert.rejects(service.databaseRequest(auth, "saved_recipes"), /invalid response/);
  global.fetch = async () => { throw new Error("offline"); };
  await assert.rejects(
    service.databaseRequest(auth, "saved_recipes"),
    (error) => error.publicMessage === "Account service is temporarily unavailable",
  );
});

test("account deletion requires the server-only secret and targets exactly the authenticated user", async () => {
  configure();
  const auth = { token: "token", user: { id: "user/1" } };
  delete process.env.SUPABASE_SECRET_KEY;
  await assert.rejects(service.deleteAccount(auth), /not configured/);
  process.env.SUPABASE_SECRET_KEY = " secret ";
  global.fetch = async (url, options) => {
    assert.match(url, /admin\/users\/user%2F1$/);
    assert.equal(options.headers.Authorization, "Bearer secret");
    return new Response(null, { status: 204 });
  };
  await service.deleteAccount(auth);
  global.fetch = async () => new Response("{}", { status: 500 });
  await assert.rejects(service.deleteAccount(auth), /couldn't delete/);
});

test("missing account configuration fails closed", async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  await assert.rejects(service.authenticateRequest(requestWithAuthorization()), /not configured/);
});

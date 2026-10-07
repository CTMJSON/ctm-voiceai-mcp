import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "voiceai-auth-test-"));
process.env.XDG_CONFIG_HOME = root;
process.env.XDG_DATA_HOME = root;
process.env.CTM_VOICEAI_ENV_FILE = path.join(root, "absent.env");
process.env.CTM_OAUTH_CLIENT_ID = "fixture-public-client";
process.env.CTM_VOICEAI_OPEN_BROWSER = "0";
const { loadConfig, paths } = await import("../dist/config.js");
const { buildAuthorizeUrl, exchangeCode, getAccessToken, tokenState, clearTokens, startLogin, waitForLogin, OAUTH } = await import("../dist/oauth.js");
const { resolveAuthHeader, verifyAuth } = await import("../dist/local-auth.js");
const { fetchVoiceBots, fetchCallsPage } = await import("../dist/ctm.js");
const originalFetch = globalThis.fetch;
let requests;
let config;
const tokenBody = (extra = {}) => ({
  access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer",
  expires_in: 3600, scopes: "profile activity reports", ...extra
});
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" }
});
async function begin() {
  const result = await buildAuthorizeUrl(config);
  const url = new URL(result.authorize_url);
  const callback = new URL(config.redirectUri);
  callback.searchParams.set("code", "fixture-code");
  callback.searchParams.set("state", url.searchParams.get("state"));
  return { result, url, callback };
}
async function login() {
  const { callback } = await begin();
  await exchangeCode(config, callback.href);
}
async function expire() {
  const stored = JSON.parse(await fs.readFile(paths().tokensFile, "utf8"));
  stored.expires_at = Date.now() - 1;
  await fs.writeFile(paths().tokensFile, JSON.stringify(stored));
}
beforeEach(async () => {
  await clearTokens();
  config = await loadConfig();
  requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    assert.equal(String(url), OAUTH.tokenUrl, "unexpected network request");
    return response(tokenBody());
  };
});
after(async () => {
  await clearTokens();
  globalThis.fetch = originalFetch;
  await fs.rm(root, { recursive: true, force: true });
});

test("S256, state, form-body exchange, private files and no verifier disclosure", async () => {
  const { url, callback, result } = await begin();
  const pending = JSON.parse(await fs.readFile(paths().pkceFile, "utf8"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(pending.verifier).digest("base64url"));
  assert.equal(url.searchParams.get("state"), pending.state);
  assert.match(pending.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(result).includes(pending.verifier));
  if (process.platform !== "win32") assert.equal((await fs.stat(paths().pkceFile)).mode & 0o777, 0o600);
  await exchangeCode(config, callback.href);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, OAUTH.tokenUrl);
  assert.equal(requests[0].options.redirect, "error");
  const form = new URLSearchParams(requests[0].options.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code_verifier"), pending.verifier);
  assert.equal(form.get("redirect_uri"), config.redirectUri);
  assert.equal(await getAccessToken({ clientId: config.clientId }), "fixture-access");
  assert.equal((await tokenState(config.clientId)).scope, "profile activity reports");
  if (process.platform !== "win32") assert.equal((await fs.stat(paths().tokensFile)).mode & 0o777, 0o600);
});

test("wrong or missing state, redirect mismatch and duplicate state fail before exchange", async () => {
  for (const mutate of [
    url => url.searchParams.delete("state"),
    url => url.searchParams.set("state", "wrong"),
    url => { url.pathname = "/wrong"; },
    url => { url.hostname = "localhost"; },
    url => url.searchParams.append("state", url.searchParams.get("state"))
  ]) {
    const { callback } = await begin();
    mutate(callback);
    await assert.rejects(exchangeCode(config, callback.href), { code: "OAUTH_STATE" });
  }
  assert.equal(requests.length, 0);
});

test("expired login and changed client reject without exchange", async () => {
  const { callback } = await begin();
  await assert.rejects(exchangeCode({ ...config, clientId: "other-client" }, callback.href), { code: "OAUTH_SESSION" });
  const pending = JSON.parse(await fs.readFile(paths().pkceFile, "utf8"));
  pending.expires_at = Date.now() - 1;
  await fs.writeFile(paths().pkceFile, JSON.stringify(pending));
  await assert.rejects(exchangeCode(config, callback.href), { code: "OAUTH_SESSION" });
  assert.equal(requests.length, 0);
});

test("denial consumes session without returning provider-supplied text", async () => {
  const { callback } = await begin();
  callback.searchParams.set("error", "access_denied");
  callback.searchParams.set("error_description", "fixture-sensitive-value");
  await assert.rejects(exchangeCode(config, callback.href), error => error.code === "OAUTH_DENIED" && !error.message.includes("fixture-sensitive-value"));
  await assert.rejects(exchangeCode(config, callback.href), { code: "OAUTH_SESSION" });
  assert.equal(requests.length, 0);
});

test("duplicate or missing codes are rejected", async () => {
  for (const mutate of [url => url.searchParams.delete("code"), url => url.searchParams.append("code", "second")]) {
    const { callback } = await begin();
    mutate(callback);
    await assert.rejects(exchangeCode(config, callback.href), { code: "OAUTH_CALLBACK" });
  }
  assert.equal(requests.length, 0);
});

test("replayed and concurrent callback can exchange only once", async () => {
  const { callback } = await begin();
  const results = await Promise.allSettled([exchangeCode(config, callback.href), exchangeCode(config, callback.href)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(requests.length, 1);
});

test("OAuth failures do not leak bodies or retry consumed codes", async () => {
  const { callback } = await begin();
  globalThis.fetch = async () => response({ error: "invalid_grant", access_token: "fixture-sensitive-value" }, 400);
  await assert.rejects(exchangeCode(config, callback.href), error => error.code === "OAUTH_REJECTED" && !error.message.includes("fixture-sensitive-value"));
  await assert.rejects(exchangeCode(config, callback.href), { code: "OAUTH_SESSION" });
  assert.equal((await tokenState(config.clientId)).logged_in, false);
});

test("invalid successful token payload is rejected", async () => {
  for (const body of [{}, tokenBody({ token_type: "Basic" }), tokenBody({ expires_in: 0 }), tokenBody({ access_token: "" })]) {
    const { callback } = await begin();
    globalThis.fetch = async () => response(body);
    await assert.rejects(exchangeCode(config, callback.href), { code: "OAUTH_RESPONSE" });
  }
});

test("OAuth network failures remain safe", async () => {
  const { callback } = await begin();
  globalThis.fetch = async () => { throw new Error("fixture-sensitive-value"); };
  await assert.rejects(exchangeCode(config, callback.href), error => error.code === "OAUTH_NETWORK" && !error.message.includes("fixture-sensitive-value"));
});

test("missing credentials never use legacy Basic configuration or environment", async () => {
  process.env.CTM_BASIC_AUTH = "fixture-legacy";
  process.env.CTM_BEARER_TOKEN = "fixture-ambient";
  try {
    const loaded = await loadConfig();
    assert.ok(!("basicAuth" in loaded));
    await assert.rejects(resolveAuthHeader({ ...loaded, basicAuth: "fixture-legacy" }), { code: "NO_AUTH" });
    assert.equal(requests.length, 0);
  } finally {
    delete process.env.CTM_BASIC_AUTH;
    delete process.env.CTM_BEARER_TOKEN;
  }
});

test("missing public client configuration and unsafe redirects fail before login", async () => {
  await assert.rejects(buildAuthorizeUrl({ ...config, clientId: "" }), { code: "OAUTH_CONFIG" });
  for (const redirectUri of ["http://example.com/callback", "https://example.com/callback?q=1", "https://user@example.com/callback"]) {
    await assert.rejects(buildAuthorizeUrl({ ...config, redirectUri }), { code: "OAUTH_CONFIG" });
  }
});

test("legacy stored tokens and another client's tokens are not reused", async () => {
  await fs.mkdir(paths().configDir, { recursive: true });
  await fs.writeFile(paths().tokensFile, JSON.stringify(tokenBody()));
  assert.equal(await getAccessToken({ clientId: config.clientId }), null);
  await login();
  assert.equal(await getAccessToken({ clientId: "other-client" }), null);
});

test("expired token without refresh fails closed and reports logged out", async () => {
  await login();
  await expire();
  const stored = JSON.parse(await fs.readFile(paths().tokensFile, "utf8"));
  stored.refresh_token = null;
  await fs.writeFile(paths().tokensFile, JSON.stringify(stored));
  assert.equal((await tokenState(config.clientId)).logged_in, false);
  await assert.rejects(resolveAuthHeader(config), { code: "NO_AUTH" });
});

test("concurrent calls refresh once and preserve rotated credentials", async () => {
  await login();
  await expire();
  requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    await new Promise(resolve => setTimeout(resolve, 20));
    return response(tokenBody({ access_token: "fixture-new-access", refresh_token: "fixture-new-refresh" }));
  };
  const values = await Promise.all(Array.from({ length: 8 }, () => getAccessToken({ clientId: config.clientId })));
  assert.deepEqual(new Set(values), new Set(["fixture-new-access"]));
  assert.equal(requests.length, 1);
  assert.equal(new URLSearchParams(requests[0].options.body).get("grant_type"), "refresh_token");
  const stored = JSON.parse(await fs.readFile(paths().tokensFile, "utf8"));
  assert.equal(stored.refresh_token, "fixture-new-refresh");
});

test("failed refresh never falls back and clears rejected credentials", async () => {
  await login();
  await expire();
  globalThis.fetch = async () => response({ error: "invalid_grant" }, 400);
  await assert.rejects(resolveAuthHeader({ ...config, basicAuth: "fixture-legacy" }), { code: "OAUTH_REJECTED" });
  assert.equal((await tokenState(config.clientId)).logged_in, false);
});

test("rate limit keeps credentials for later retry without using expired access token", async () => {
  await login();
  await expire();
  globalThis.fetch = async () => response({}, 429);
  await assert.rejects(getAccessToken({ clientId: config.clientId }), { code: "OAUTH_RATE_LIMIT" });
  assert.ok(JSON.parse(await fs.readFile(paths().tokensFile, "utf8")).refresh_token);
});

test("logout queued during refresh removes newly refreshed tokens", async () => {
  await login();
  await expire();
  await Promise.all([getAccessToken({ clientId: config.clientId }), clearTokens()]);
  assert.equal((await tokenState(config.clientId)).logged_in, false);
});

test("CTM 401 is distinct from account-level 403 and never leaks upstream body", async () => {
  await login();
  for (const [status, code] of [[401, "NO_AUTH"], [403, "FORBIDDEN"]]) {
    globalThis.fetch = async () => response({ message: "fixture-sensitive-value" }, status);
    await assert.rejects(verifyAuth(config, "1"), error => error.code === code && !error.message.includes("fixture-sensitive-value"));
  }
});

test("API schemas reject malformed data, normalize ids and block external pagination", async () => {
  globalThis.fetch = async () => response({ calls: "invalid" });
  await assert.rejects(fetchCallsPage("1", "Bearer fixture"), { code: "API_RESPONSE" });
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    return response({ voice_bots: [{ id: 2, name: " Test " }], next_page: "https://example.com/capture" });
  };
  await assert.rejects(fetchVoiceBots("1", "Bearer fixture"), { code: "API_RESPONSE" });
  assert.equal(count, 1);
  globalThis.fetch = async () => response({ voice_bots: [{ id: 2, name: " Test " }] });
  assert.equal((await fetchVoiceBots("1", "Bearer fixture"))[0].id, "2");
  await assert.rejects(fetchCallsPage("../other", "Bearer fixture"), { code: "NO_ACCOUNT" });
});

test("automatic loopback callback completes login, and closes listener", async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  config = { ...config, redirectUri: `http://127.0.0.1:${port}/oauth/callback`, openBrowser: false };
  const started = await startLogin(config);
  assert.equal(started.browser_opened, false);
  const callback = new URL(config.redirectUri);
  callback.searchParams.set("code", "fixture-code");
  callback.searchParams.set("state", new URL(started.authorize_url).searchParams.get("state"));
  const result = await originalFetch(callback, { headers: { Connection: "close" } });
  assert.equal(result.status, 200);
  assert.match(await result.text(), /complete/);
  assert.equal((await waitForLogin(config, 0)).status, "authorized");
});


test("separate local processes serialize refresh against the shared token store", async () => {
  await login();
  await expire();
  const countFile = path.join(root, "refresh-count");
  const moduleUrl = new URL("../dist/oauth.js", import.meta.url).href;
  const script = String.raw`
    import { appendFile } from "node:fs/promises";
    import { getAccessToken } from ${JSON.stringify(moduleUrl)};
    globalThis.fetch = async () => {
      await appendFile(${JSON.stringify(countFile)}, "refresh\n");
      await new Promise(resolve => setTimeout(resolve, 100));
      return new Response(JSON.stringify(${JSON.stringify(tokenBody({ access_token: "fixture-new-access" }))}));
    };
    const value = await getAccessToken({ clientId: "fixture-public-client" });
    if (value !== "fixture-new-access") process.exitCode = 1;
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: process.env, stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([run(), run()]);
  assert.equal(await fs.readFile(countFile, "utf8"), "refresh\n");
});

test("starting another sign-in removes the previous identity until callback succeeds", async () => {
  await login();
  await begin();
  assert.equal((await tokenState(config.clientId)).logged_in, false);
});

test("loopback callback rejects wrong state and still accepts the valid callback", async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  config = { ...config, redirectUri: `http://127.0.0.1:${port}/oauth/callback`, openBrowser: false };
  const started = await startLogin(config);
  const callback = new URL(config.redirectUri);
  callback.searchParams.set("code", "fixture-code");
  callback.searchParams.set("state", "wrong");
  const invalid = await originalFetch(callback, { headers: { Connection: "close" } });
  assert.equal(invalid.status, 400);
  await invalid.text();
  assert.equal(requests.length, 0);
  callback.searchParams.set("state", new URL(started.authorize_url).searchParams.get("state"));
  const valid = await originalFetch(callback, { headers: { Connection: "close" } });
  assert.equal(valid.status, 200);
  await valid.text();
});

test("uncertain refresh outcome requires new login rather than replaying the old refresh token", async () => {
  await login();
  await expire();
  let count = 0;
  globalThis.fetch = async () => { count++; throw new Error("connection lost after token rotation"); };
  await assert.rejects(resolveAuthHeader(config), { code: "OAUTH_NETWORK" });
  await assert.rejects(resolveAuthHeader(config), { code: "NO_AUTH" });
  assert.equal(count, 1);
});


test("account-bound OAuth cannot silently substitute another requested account", async () => {
  globalThis.fetch = async () => response(tokenBody({ account_id: "111111" }));
  await login();
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Must not reach CTM"); };
  await assert.rejects(verifyAuth(config, "222222"), e => e.code === "ACCOUNT_MISMATCH");
  await expire();
  await assert.rejects(verifyAuth(config, "222222"), e => e.code === "ACCOUNT_MISMATCH");
  assert.equal(calls, 0, "reject before API calls or token refresh");
  assert.equal((await tokenState(config.clientId)).account_id, "111111");
});

test("refresh cannot switch the account of an in-flight request", async () => {
  globalThis.fetch = async () => response(tokenBody({ account_id: "111111" }));
  await login(); await expire();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response(tokenBody({ account_id: "222222" })); };
  await assert.rejects(verifyAuth(config, "111111"), e => e.code === "ACCOUNT_MISMATCH");
  assert.equal(calls, 1, "only the refresh endpoint was called");
  assert.equal((await tokenState(config.clientId)).logged_in, false);
});

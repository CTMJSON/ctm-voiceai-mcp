import { promises as fs } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import { paths, type Config } from "./config.js";
import { nowIso, readJson, sleep, writeJson, openInBrowser } from "./util.js";
import { AppError } from "./errors.js";

export const OAUTH = {
  authorizeUrl: "https://app.calltrackingmetrics.com/oauth2/authorize",
  tokenUrl: "https://api.calltrackingmetrics.com/oauth2/token"
};
const LOGIN_TTL_MS = 10 * 60 * 1000;
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().refine(v => v.toLowerCase() === "bearer"),
  expires_in: z.coerce.number().positive().finite(),
  account_id: z.union([z.string(), z.number()]).nullable().optional(),
  scope: z.string().optional(),
  scopes: z.string().optional()
});
const storedSchema = z.object({
  auth_method: z.literal("pkce"), client_id: z.string().min(1),
  access_token: z.string().min(1), refresh_token: z.string().nullable(),
  token_type: z.literal("Bearer"), account_id: z.union([z.string(), z.number()]).nullable(),
  scope: z.string().nullable(), expires_at: z.number().finite(), obtained_at: z.string()
});
const sessionSchema = z.object({
  client_id: z.string(), redirect_uri: z.string(), scope: z.string(),
  state: z.string(), verifier: z.string(), expires_at: z.number()
});
type Tokens = z.infer<typeof storedSchema>;
type Session = z.infer<typeof sessionSchema>;

// Serialize in-process work and use an exclusive directory for other local MCP processes.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const locked = async () => {
    await fs.mkdir(paths().configDir, { recursive: true, mode: 0o700 });
    const lock = paths().configDir + "/auth.lock";
    const deadline = Date.now() + 35000;
    while (true) {
      try { await fs.mkdir(lock); break; }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new AppError(
          "Another local process is updating authentication. Retry later. After a crash, stop all instances before removing auth.lock from the config directory.",
          "OAUTH_BUSY"
        );
        await sleep(50);
      }
    }
    try { return await fn(); }
    finally { await fs.rmdir(lock); }
  };
  const next = queue.then(locked, locked);
  queue = next.catch(() => {});
  return next;
}
let callbackServer: Server | undefined;
let callbackTimer: ReturnType<typeof setTimeout> | undefined;

function closeCallback() {
  if (callbackTimer) clearTimeout(callbackTimer);
  callbackTimer = undefined;
  callbackServer?.close();
  callbackServer = undefined;
}

function requireClient(clientId: string) {
  if (!clientId.trim()) throw new AppError(
    "Configure CTM_OAUTH_CLIENT_ID for a public CTM OAuth client with the registered redirect URI.",
    "OAUTH_CONFIG"
  );
}

function redirectUrl(uri: string): URL {
  let url: URL;
  try { url = new URL(uri); }
  catch { throw new AppError("Invalid OAuth redirect URI.", "OAUTH_CONFIG"); }
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))) {
    throw new AppError("Use an HTTPS redirect URI or an HTTP 127.0.0.1 loopback URI without query or fragment.", "OAUTH_CONFIG");
  }
  return url;
}

async function postToken(params: Record<string, string>) {
  let response: Response;
  try {
    response = await fetch(OAUTH.tokenUrl, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(30000)
    });
  } catch {
    throw new AppError("CTM OAuth request failed or timed out. Retry sign-in if the outcome is unknown.", "OAUTH_NETWORK");
  }
  // Error bodies may contain credentials or arbitrary upstream text. Never return them.
  if (!response.ok) throw new AppError(
    response.status === 429 ? "CTM OAuth is rate limited. Try again later." :
      "CTM OAuth rejected the request. Check the public client registration or sign in again.",
    response.status === 429 ? "OAUTH_RATE_LIMIT" : "OAUTH_REJECTED", response.status
  );
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new AppError("CTM OAuth returned invalid JSON.", "OAUTH_RESPONSE"); }
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) throw new AppError("CTM OAuth returned an invalid token response.", "OAUTH_RESPONSE");
  return parsed.data;
}

function toTokens(payload: z.infer<typeof tokenResponseSchema>, clientId: string, prior?: Tokens): Tokens {
  return {
    auth_method: "pkce", client_id: clientId, access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? prior?.refresh_token ?? null, token_type: "Bearer",
    account_id: payload.account_id ?? prior?.account_id ?? null,
    scope: payload.scope ?? payload.scopes ?? prior?.scope ?? null,
    expires_at: Date.now() + payload.expires_in * 1000, obtained_at: prior?.obtained_at ?? nowIso()
  };
}

async function loadTokens(clientId: string): Promise<Tokens | null> {
  const result = storedSchema.safeParse(await readJson(paths().tokensFile));
  return result.success && result.data.client_id === clientId ? result.data : null;
}

async function loadSession(): Promise<Session | null> {
  const result = sessionSchema.safeParse(await readJson(paths().pkceFile));
  return result.success ? result.data : null;
}

function authorizeUrl(session: Session) {
  const params = new URLSearchParams({
    client_id: session.client_id, redirect_uri: session.redirect_uri,
    response_type: "code", scope: session.scope, state: session.state,
    code_challenge: createHash("sha256").update(session.verifier).digest("base64url"),
    code_challenge_method: "S256"
  });
  return `${OAUTH.authorizeUrl}?${params}`;
}

async function newSession(config: Config) {
  requireClient(config.clientId);
  redirectUrl(config.redirectUri);
  const session: Session = {
    client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scope,
    state: randomBytes(32).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"), expires_at: Date.now() + LOGIN_TTL_MS
  };
  await writeJson(paths().pkceFile, session);
  await fs.rm(paths().tokensFile, { force: true });
  return session;
}

/** Manual callback flow, for a registered HTTPS callback or headless local use. */
export function buildAuthorizeUrl(config: Config) {
  return exclusive(async () => {
    closeCallback();
    const session = await newSession(config);
    return { authorize_url: authorizeUrl(session), expires_in: LOGIN_TTL_MS / 1000 };
  });
}

/** Validate the full callback, including state and exact redirect, before sending a code. */
export function exchangeCode(config: Config, callbackUrl: string) {
  return exclusive(async () => {
    const session = await loadSession();
    if (!session || session.expires_at <= Date.now()) {
      await fs.rm(paths().pkceFile, { force: true });
      closeCallback();
      throw new AppError("No pending login or login expired. Start sign-in again.", "OAUTH_SESSION");
    }
    if (session.client_id !== config.clientId || session.redirect_uri !== config.redirectUri) {
      throw new AppError("OAuth configuration changed. Start sign-in again.", "OAUTH_SESSION");
    }
    let callback: URL;
    try { callback = new URL(callbackUrl); }
    catch { throw new AppError("Invalid callback URL.", "OAUTH_CALLBACK"); }
    const target = redirectUrl(session.redirect_uri);
    const state = callback.searchParams.get("state") ?? "";
    const expected = Buffer.from(session.state);
    const actual = Buffer.from(state);
    if (callback.origin !== target.origin || callback.pathname !== target.pathname ||
        callback.username || callback.password || callback.hash ||
        callback.searchParams.getAll("state").length !== 1 ||
        actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new AppError("OAuth callback or state does not match the pending login.", "OAUTH_STATE");
    }
    // Consume before token exchange: uncertain outcomes cannot replay this authorization.
    await fs.rm(paths().pkceFile, { force: true });
    closeCallback();
    if (callback.searchParams.has("error") || callback.searchParams.get("access") === "denied") {
      throw new AppError("CTM authorization was denied. Start sign-in again when ready.", "OAUTH_DENIED");
    }
    const codes = callback.searchParams.getAll("code");
    if (codes.length !== 1 || !codes[0]) throw new AppError("Callback is missing a single authorization code.", "OAUTH_CALLBACK");
    const payload = await postToken({
      grant_type: "authorization_code", client_id: session.client_id, redirect_uri: session.redirect_uri,
      code: codes[0], code_verifier: session.verifier
    });
    await writeJson(paths().tokensFile, toTokens(payload, config.clientId));
  });
}

export async function startLogin(config: Config) {
  return exclusive(async () => {
    requireClient(config.clientId);
    const target = redirectUrl(config.redirectUri);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
      throw new AppError("Automatic login needs an HTTP 127.0.0.1 redirect. Use auth_url and auth_exchange for a registered HTTPS callback.", "OAUTH_CONFIG");
    }
    const pending = await loadSession();
    if (callbackServer && pending && pending.expires_at > Date.now() &&
        pending.client_id === config.clientId && pending.redirect_uri === config.redirectUri) {
      return { status: "authorization_pending", authorize_url: authorizeUrl(pending), browser_opened: false };
    }
    closeCallback();
    const server = createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Security-Policy", "default-src 'none'");
      const requestUrl = req.url ?? "";
      if (req.method !== "GET" || req.headers.host !== target.host ||
          !requestUrl.startsWith(target.pathname + "?")) {
        res.writeHead(404).end("Not found.");
        return;
      }
      void exchangeCode(config, target.origin + requestUrl).then(() => {
        res.end("CTM sign-in complete. Return to your MCP client.");
      }, (error: unknown) => {
        res.writeHead(400).end(error instanceof AppError ? error.message : "Sign-in failed.");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new AppError("Cannot bind the OAuth callback port. Check for another local MCP instance.", "OAUTH_LISTENER")));
      server.listen(Number(target.port) || 80, "127.0.0.1", resolve);
    });
    callbackServer = server;
    server.unref();
    let session: Session;
    try { session = await newSession(config); }
    catch (error) { closeCallback(); throw error; }
    callbackTimer = setTimeout(closeCallback, LOGIN_TTL_MS);
    callbackTimer.unref();
    const url = authorizeUrl(session);
    return {
      status: "authorization_pending", authorize_url: url, expires_in: LOGIN_TTL_MS / 1000,
      browser_opened: config.openBrowser && openInBrowser(url)
    };
  });
}

export async function waitForLogin(config: Config, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  do {
    const state = await tokenState(config.clientId);
    if (state.logged_in) return { status: "authorized", auth: state };
    if (Date.now() >= deadline) break;
    await sleep(250);
  } while (true);
  return { status: "authorization_pending" };
}

/** Refresh once per process; never fall back to expired tokens or another auth scheme. */
export function getAccessToken({ clientId, forceRefresh = false, minValidityMs = 60000 }: {
  clientId: string; forceRefresh?: boolean; minValidityMs?: number
}) {
  return exclusive(async () => {
    requireClient(clientId);
    const tokens = await loadTokens(clientId);
    if (!tokens) return null;
    if (!forceRefresh && tokens.expires_at - Date.now() > minValidityMs) return tokens.access_token;
    if (!tokens.refresh_token) return null;
    try {
      const payload = await postToken({
        client_id: clientId, grant_type: "refresh_token", refresh_token: tokens.refresh_token
      });
      const refreshed = toTokens(payload, clientId, tokens);
      await writeJson(paths().tokensFile, refreshed);
      return refreshed.access_token;
    } catch (error) {
      // A timeout/malformed response may follow a successful refresh-token rotation.
      // Do not automatically replay that refresh token. Only an explicit throttle
      // response is retained for a later retry.
      if (!(error instanceof AppError && error.code === "OAUTH_RATE_LIMIT")) {
        await fs.rm(paths().tokensFile, { force: true });
      }
      throw error;
    }
  });
}

export async function tokenState(clientId: string) {
  const tokens = await loadTokens(clientId);
  if (!tokens) return { logged_in: false as const };
  const remaining = Math.round((tokens.expires_at - Date.now()) / 1000);
  return {
    logged_in: remaining > 0, account_id: tokens.account_id, scope: tokens.scope,
    expires_in_seconds: remaining, expires_at: new Date(tokens.expires_at).toISOString(),
    has_refresh_token: Boolean(tokens.refresh_token)
  };
}

/** Local disconnect only. Server-side revocation is not implied. */
export function clearTokens() {
  return exclusive(async () => {
    closeCallback();
    for (const file of [paths().tokensFile, paths().pkceFile, paths().deviceFile]) {
      await fs.rm(file, { force: true });
    }
  });
}

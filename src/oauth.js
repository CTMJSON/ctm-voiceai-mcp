import { promises as fs } from "node:fs";
import { paths } from "./config.js";
import { nowIso, readJson, sleep, writeJson, exists } from "./util.js";

export const OAUTH = {
  authorizeUrl: "https://app.calltrackingmetrics.com/oauth2/authorize",
  deviceTokenUrl: "https://api.calltrackingmetrics.com/oauth2/device_token",
  tokenUrl: "https://api.calltrackingmetrics.com/oauth2/token"
};

async function postForm(url, params, { query = null, timeoutMs = 30000 } = {}) {
  const target = query ? `${url}?${new URLSearchParams(query).toString()}` : url;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal
    });
    const text = await response.text();
    let json = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    // The device poll returns HTTP 400 with error=authorization_pending until the
    // user authorizes, and error=slow_down if we poll too fast. Both are expected.
    const nonFatal = json.error === "authorization_pending" || json.error === "slow_down";
    if (!response.ok && !json.error) {
      const detail = json.message || json.description || json.raw || response.statusText;
      throw new Error(`OAuth ${url} failed with ${response.status}: ${detail}`);
    }
    if (!response.ok && json.error && !json.access_token && !nonFatal) {
      const err = new Error(`OAuth ${url} error: ${json.error} ${json.reason || ""}`.trim());
      err.oauthError = json.error;
      throw err;
    }
    return { status: response.status, json };
  } finally {
    clearTimeout(timeout);
  }
}

export function buildAuthorizeUrl({ clientId, redirectUri, scope, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scope || "profile activity reports"
  });
  if (state) params.set("state", state);
  return `${OAUTH.authorizeUrl}?${params.toString()}`;
}

function toStoredTokens(payload, clientId) {
  const expiresIn = Number(payload.expires_in) || 0;
  return {
    client_id: clientId,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || null,
    token_type: payload.token_type || "Bearer",
    account_id: payload.account_id ?? null,
    scope: payload.scope || null,
    expires_at: Date.now() + expiresIn * 1000,
    obtained_at: nowIso()
  };
}

export async function saveTokens(tokens) {
  await writeJson(paths().tokensFile, tokens);
  return tokens;
}

export async function loadTokens() {
  return readJson(paths().tokensFile, null);
}

export async function clearTokens() {
  for (const file of [paths().tokensFile, paths().deviceFile]) {
    if (await exists(file)) await fs.rm(file, { force: true });
  }
}

export async function clearDeviceSession() {
  const file = paths().deviceFile;
  if (await exists(file)) await fs.rm(file, { force: true });
}

export async function startDeviceFlow(clientId) {
  const { json } = await postForm(OAUTH.deviceTokenUrl, { client_id: clientId });
  if (!json.device_code || !json.user_code) {
    throw new Error(`Device flow did not return a device_code: ${JSON.stringify(json)}`);
  }
  const session = { ...json, client_id: clientId, started_at: nowIso() };
  await writeJson(paths().deviceFile, session);
  return session;
}

export async function loadDeviceSession() {
  return readJson(paths().deviceFile, null);
}

export async function pollDeviceFlow(clientId) {
  const session = await loadDeviceSession();
  if (!session?.device_code) return { status: "no_session" };

  if (session.expires_in && session.started_at) {
    const elapsed = (Date.now() - Date.parse(session.started_at)) / 1000;
    if (elapsed > Number(session.expires_in) + 5) {
      return { status: "expired", detail: "The user code expired. Start a new login." };
    }
  }

  const { json } = await postForm(OAUTH.tokenUrl, {
    client_id: clientId,
    device_code: session.device_code,
    grant_type: "device_code"
  });

  if (json.access_token) {
    const tokens = await saveTokens(toStoredTokens(json, clientId));
    await fs.rm(paths().deviceFile, { force: true });
    return { status: "authorized", tokens };
  }
  if (json.error === "authorization_pending") {
    return { status: "pending", interval: Number(json.interval) || session.interval || 5 };
  }
  if (json.error === "slow_down") {
    return { status: "pending", interval: (Number(session.interval) || 5) + 5 };
  }
  return { status: json.error || "unknown", detail: json.reason || JSON.stringify(json) };
}

export async function waitForDeviceFlow(clientId, { maxSeconds = 180 } = {}) {
  const deadline = Date.now() + maxSeconds * 1000;
  let interval = 5;
  let last = { status: "pending" };
  while (Date.now() < deadline) {
    last = await pollDeviceFlow(clientId);
    if (last.status === "authorized" || last.status === "expired" || last.status === "no_session") return last;
    interval = last.interval || interval;
    await sleep(Math.min(interval, 10) * 1000);
  }
  return { ...last, status: last.status === "authorized" ? "authorized" : "timeout" };
}

export async function exchangeCode({ clientId, code, redirectUri }) {
  const { json } = await postForm(
    OAUTH.tokenUrl,
    {},
    { query: { client_id: clientId, redirect_uri: redirectUri, code } }
  );
  if (!json.access_token) {
    throw new Error(`Code exchange did not return an access_token: ${JSON.stringify(json)}`);
  }
  return saveTokens(toStoredTokens(json, clientId));
}

export async function refreshTokens(clientId) {
  const tokens = await loadTokens();
  if (!tokens?.refresh_token) return null;
  const { json } = await postForm(OAUTH.tokenUrl, {
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token
  });
  if (!json.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(json)}`);
  }
  const merged = toStoredTokens(json, clientId);
  if (!merged.refresh_token) merged.refresh_token = tokens.refresh_token;
  return saveTokens(merged);
}

/** Returns a valid access token, refreshing if needed. Null when not logged in. */
export async function getAccessToken({ clientId, forceRefresh = false, minValidityMs = 60000 } = {}) {
  const tokens = await loadTokens();
  if (!tokens?.access_token) return null;
  const stillValid = tokens.expires_at && tokens.expires_at - Date.now() > minValidityMs;
  if (stillValid && !forceRefresh) return tokens.access_token;
  if (!tokens.refresh_token) return forceRefresh ? null : tokens.access_token;
  const refreshed = await refreshTokens(clientId);
  return refreshed?.access_token || null;
}

export async function tokenState() {
  const tokens = await loadTokens();
  if (!tokens?.access_token) {
    return { logged_in: false };
  }
  const expiresInSeconds = tokens.expires_at ? Math.round((tokens.expires_at - Date.now()) / 1000) : null;
  return {
    logged_in: true,
    account_id: tokens.account_id,
    scope: tokens.scope,
    token_type: tokens.token_type,
    obtained_at: tokens.obtained_at,
    expires_at: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null,
    expires_in_seconds: expiresInSeconds,
    has_refresh_token: Boolean(tokens.refresh_token)
  };
}

export async function tokenFileExists() {
  return exists(paths().tokensFile);
}
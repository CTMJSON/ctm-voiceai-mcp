import { getAccessToken } from "./oauth.js";

const API_BASE = "https://api.calltrackingmetrics.com/api/v1";

function normalizeBot(raw) {
  return {
    id: raw.id,
    name: (raw.name || "").trim(),
    description: (raw.description || "").trim(),
    instructions: (raw.instructions || "").trim(),
    play_message: (raw.play_message || "").trim(),
    classifier_enabled: raw.classifier_enabled ?? null
  };
}

/** Prefer an OAuth bearer token; fall back to configured basic auth. */
export async function resolveAuthHeader(config) {
  const token = await getAccessToken({ clientId: config.clientId }).catch(() => null);
  if (token) return { header: `Bearer ${token}`, mode: "oauth" };
  if (config.basicAuth) {
    const value = config.basicAuth.replace(/^Basic\s+/i, "");
    return { header: `Basic ${value}`, mode: "basic" };
  }
  const err = new Error(
    "No CTM credentials. Run the ctm_voiceai_auth_login tool (OAuth device flow), or set CTM_BASIC_AUTH in ~/.config/ctm-voiceai/config.env."
  );
  err.code = "NO_AUTH";
  throw err;
}

async function getJson(url, authHeader, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Authorization: authHeader, Accept: "application/json" },
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
    if (!response.ok) {
      const detail = json.error || json.message || json.raw || response.statusText;
      const err = new Error(`CTM API ${response.status}: ${detail}`);
      err.status = response.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve credentials and make a lightweight call so we fail fast (and clearly)
 * when the CTM login is missing or expired, instead of midway through a run.
 */
export async function verifyAuth(config, accountId) {
  const auth = await resolveAuthHeader(config);
  if (!accountId) {
    const err = new Error("A CTM account id is required to verify the login.");
    err.code = "NO_ACCOUNT";
    throw err;
  }
  const url = `${API_BASE}/accounts/${accountId}/calls?per_page=1`;
  try {
    await getJson(url, auth.header, { timeoutMs: 15000 });
    return auth;
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      const e = new Error(
        `CTM rejected the login (HTTP ${err.status}). Your CTM session is missing or expired. `
          + "Run the ctm_voiceai_auth_login tool to sign in again."
      );
      e.code = "NO_AUTH";
      throw e;
    }
    throw err;
  }
}

export async function fetchVoiceBots(accountId, authHeader, { perPage = 100 } = {}) {
  let url = `${API_BASE}/accounts/${accountId}/voice_bots?per_page=${perPage}&page=1`;
  const bots = [];
  let page = 0;
  while (url) {
    page += 1;
    const data = await getJson(url, authHeader);
    const list = Array.isArray(data.voice_bots) ? data.voice_bots : [];
    for (const raw of list) bots.push(normalizeBot(raw));
    url = data.next_page || null;
    if (page > 50) break;
  }
  return bots;
}

/** Pull transcript text out of the various shapes the CTM API can return. */
export function extractTranscript(raw) {
  for (const key of ["transcription_text", "transcription", "transcript", "transcript_text"]) {
    const val = raw[key];
    if (typeof val === "string" && val.trim()) return val.trim();
    if (val && typeof val === "object") {
      for (const sub of ["text", "transcript", "full_text", "content"]) {
        if (typeof val[sub] === "string" && val[sub].trim()) return val[sub].trim();
      }
    }
  }
  const segments = raw.transcription_segments;
  if (Array.isArray(segments)) {
    const joined = segments
      .filter((s) => s && typeof s === "object")
      .map((s) => String(s.text || s.content || "").trim())
      .filter(Boolean)
      .join(" ");
    if (joined) return joined;
  }
  return "";
}

/** Normalize a CTM call record into the compact shape the analysis uses. */
export function normalizeCall(raw) {
  return {
    id: raw.id,
    occurred_at: raw.called_at || raw.occurred_at || raw.created_at || raw.started_at || null,
    direction: raw.direction || null,
    summary: raw.summary || "",
    transcript: extractTranscript(raw)
  };
}

/**
 * One GET against the CTM calls endpoint, returning a page of activities with
 * transcriptions.
 */
export async function fetchCallsPage(accountId, authHeader, {
  page = 1,
  perPage = 25,
  since,
  until,
  direction,
  hasTranscription = true
} = {}) {
  const params = new URLSearchParams();
  params.set("per_page", String(perPage));
  params.set("page", String(page));
  params.set("format", "json");
  params.set("call_status", "answered");
  if (hasTranscription) params.set("has_transcription", "1");
  if (direction && direction !== "none") params.set("direction", direction);
  if (since) params.set("since", since);
  if (until) params.set("until", until);

  const url = `${API_BASE}/accounts/${accountId}/calls?${params.toString()}`;
  const data = await getJson(url, authHeader, { timeoutMs: 60000 });
  const rawCalls = Array.isArray(data.calls) ? data.calls : [];
  const calls = rawCalls.map(normalizeCall).filter((c) => c.transcript);
  return {
    page,
    per_page: perPage,
    returned: rawCalls.length,
    with_transcript: calls.length,
    total: data.total_entries ?? data.total ?? null,
    total_pages: data.total_pages ?? null,
    has_more: Boolean(data.next_page),
    next_page: data.next_page ? page + 1 : null,
    calls
  };
}

export function selectBots(bots, selectors) {
  if (!selectors || selectors.length === 0) return bots.filter((b) => b.instructions);
  const chosen = [];
  const seen = new Set();
  for (const selector of selectors) {
    const needle = String(selector).trim().toLowerCase();
    const matches = bots.filter(
      (b) => String(b.id).toLowerCase() === needle || (b.name || "").toLowerCase().includes(needle)
    );
    if (matches.length === 0) {
      const available = bots.map((b) => `${b.name || "(unnamed)"} [${b.id}]`).join(", ") || "none";
      throw new Error(`No VoiceAI agent matched '${selector}'. Available: ${available}`);
    }
    for (const b of matches) {
      if (!seen.has(b.id)) {
        seen.add(b.id);
        chosen.push(b);
      }
    }
  }
  return chosen;
}

export const _internals = { normalizeBot, API_BASE };
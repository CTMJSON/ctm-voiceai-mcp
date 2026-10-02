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
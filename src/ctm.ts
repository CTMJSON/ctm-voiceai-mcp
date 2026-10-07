import { z } from "zod";
import { AppError } from "./errors.js";

const idSchema = z.union([z.string(), z.number()]);
const botSchema = z.object({
  id: idSchema.transform(String),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  instructions: z.string().nullable().optional(),
  play_message: z.string().nullable().optional(),
  classifier_enabled: z.boolean().nullable().optional()
});
const callSchema = z.object({
  id: idSchema,
  called_at: z.string().nullable().optional(), occurred_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(), started_at: z.string().nullable().optional(),
  direction: z.string().nullable().optional(), summary: z.string().nullable().optional()
}).passthrough();
const pagination = {
  next_page: z.union([z.string(), z.literal(false)]).nullable().optional(),
  total_entries: z.number().nonnegative().nullable().optional(),
  total: z.number().nonnegative().nullable().optional(),
  total_pages: z.number().int().nonnegative().nullable().optional()
};
const botsResponseSchema = z.object({ voice_bots: z.array(botSchema), ...pagination });
type RawCall = z.infer<typeof callSchema>;
export type CallOptions = {
  page?: number; perPage?: number; since?: string; until?: string;
  direction?: string; hasTranscription?: boolean;
};
function accountSegment(accountId: string) {
  if (!/^[0-9]+$/.test(accountId)) throw new AppError("A numeric CTM account id is required.", "NO_ACCOUNT");
  return accountId;
}


const API_BASE = "https://api.calltrackingmetrics.com/api/v1";

function normalizeBot(raw: z.infer<typeof botSchema>) {
  return {
    id: raw.id,
    name: (raw.name || "").trim(),
    description: (raw.description || "").trim(),
    instructions: (raw.instructions || "").trim(),
    play_message: (raw.play_message || "").trim(),
    classifier_enabled: raw.classifier_enabled ?? null
  };
}

export async function getJson(url: string, authHeader: string, { timeoutMs = 60000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
  // CTM pagination is untrusted input; never forward credentials to another origin.
  const target = new URL(url, API_BASE + "/");
  if (target.origin !== new URL(API_BASE).origin || target.username || target.password ||
      !target.pathname.startsWith("/api/v1/")) {
    throw new AppError("CTM returned an invalid pagination URL.", "API_RESPONSE");
  }
  let response: Response;
  try {
    response = await fetch(target, {
      headers: { Authorization: authHeader, Accept: "application/json" },
      redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    });
  } catch { throw new AppError("CTM request failed or timed out.", "API_NETWORK"); }
  if (!response.ok) throw new AppError(`CTM API request failed (HTTP ${response.status}).`, "API_ERROR", response.status);
  try { return await response.json(); }
  catch { throw new AppError("CTM returned invalid JSON.", "API_RESPONSE"); }
}

function parseResponse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("CTM returned an unexpected response shape.", "API_RESPONSE");
  return parsed.data;
}

export async function fetchVoiceBots(accountId: string, authHeader: string, { perPage = 100, signal }: { perPage?: number; signal?: AbortSignal } = {}) {
  let url: string | null = `${API_BASE}/accounts/${accountSegment(accountId)}/voice_bots?per_page=${perPage}&page=1`;
  const bots = [];
  let page = 0;
  while (url) {
    page += 1;
    const data: z.infer<typeof botsResponseSchema> = parseResponse(botsResponseSchema, await getJson(url, authHeader, { signal }));
    const list = Array.isArray(data.voice_bots) ? data.voice_bots : [];
    for (const raw of list) bots.push(normalizeBot(raw));
    url = data.next_page || null;
    if (page >= 50 && url) throw new AppError("VoiceAI pagination exceeded the safety limit; results would be incomplete.", "API_PAGINATION");
  }
  return bots;
}

/** Pull transcript text out of the various shapes the CTM API can return. */
export function extractTranscript(raw: Record<string, unknown>) {
  for (const key of ["transcription_text", "transcription", "transcript", "transcript_text"]) {
    const val = raw[key];
    if (typeof val === "string" && val.trim()) return val.trim();
    if (val && typeof val === "object") {
      for (const sub of ["text", "transcript", "full_text", "content"]) {
        const field = (val as Record<string, unknown>)[sub];
        if (typeof field === "string" && field.trim()) return field.trim();
      }
    }
  }
  const segments = raw.transcription_segments;
  if (Array.isArray(segments)) {
    const items: unknown[] = segments;
    const joined = items.flatMap((segment) => {
      if (!segment || typeof segment !== "object") return [];
      const value = segment as Record<string, unknown>;
      const text = value.text ?? value.content;
      return typeof text === "string" && text.trim() ? [text.trim()] : [];
    }).join(" ");
    if (joined) return joined;
  }
  return "";
}

/** Normalize a CTM call record into the compact shape the analysis uses. */
export function normalizeCall(raw: RawCall) {
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
export async function fetchCallsPage(accountId: string, authHeader: string, {
  page = 1,
  perPage = 25,
  since,
  until,
  direction,
  hasTranscription = true
}: CallOptions = {}) {
  const params = new URLSearchParams();
  params.set("per_page", String(perPage));
  params.set("page", String(page));
  params.set("format", "json");
  params.set("call_status", "answered");
  if (hasTranscription) params.set("has_transcription", "1");
  if (direction && direction !== "none") params.set("direction", direction);
  if (since) params.set("since", since);
  if (until) params.set("until", until);

  const url = `${API_BASE}/accounts/${accountSegment(accountId)}/calls?${params.toString()}`;
  const data = parseResponse(z.object({ calls: z.array(callSchema), ...pagination }), await getJson(url, authHeader, { timeoutMs: 60000 }));
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

export function selectBots(bots: ReturnType<typeof normalizeBot>[], selectors: string[]) {
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
      throw new AppError(`No VoiceAI agent matched '${selector}'. Available: ${available}`, "BOT_NOT_FOUND");
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

export type VoiceBot = ReturnType<typeof normalizeBot>;
export type CallsPage = Awaited<ReturnType<typeof fetchCallsPage>>;

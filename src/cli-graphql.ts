import { readFile, stat } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { AppError } from "./errors.js";
import type { Config } from "./config.js";
import type { VoiceBot } from "./ctm.js";

const ENDPOINT = "https://app.ctm.com/graphql";
const LOGIN = "Run ctm auth login in Terminal, then retry. This mode only uses the CLI browser-login session.";
const sessionSchema = z.object({ graphql_token: z.string().min(1), graphql_token_expires_at: z.string(), graphql_token_endpoint: z.literal(ENDPOINT) });
const accountIdSchema = z.string().regex(/^[1-9][0-9]*$/).max(20);
const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const id = z.union([z.string(),z.number()]).transform(String);
const botSchema = z.object({ legacyId: id, name: z.string().nullable(), description: z.string().nullable(), instructions: z.string().nullable(), playMessage: z.string().nullable(), classifierEnabled: z.boolean().nullable() });
const callSchema = z.object({ legacyId: id, direction: z.string().nullable(), occurredAt: z.string(), status: z.string().nullable(), transcription: z.string().nullable(), summary: z.string().nullable() });

/** Local-only adapter. Never reads api_token, CTM_API_TOKEN, or the MCP OAuth store. */
export class CliGraphql {
  constructor(private readonly config: Pick<Config,"cliConfigFile">, private readonly request: typeof fetch = fetch) {}
  private async session() {
    let raw: unknown;
    try {
      if ((await stat(this.config.cliConfigFile)).size > 65536) throw new Error("oversized");
      raw = parse(await readFile(this.config.cliConfigFile, "utf8"), { maxAliasCount: 0 });
    } catch { throw new AppError(LOGIN, "CLI_LOGIN_REQUIRED", 401); }
    const parsed = sessionSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(LOGIN, "CLI_LOGIN_REQUIRED", 401);
    const token = parsed.data.graphql_token.replace(/^Bearer\s+/i, "");
    const expires = Date.parse(parsed.data.graphql_token_expires_at);
    if (!/^JWTGQL[A-Za-z0-9._-]+$/.test(token) || !Number.isFinite(expires) || expires <= Date.now() + 5000) throw new AppError(LOGIN, "CLI_LOGIN_REQUIRED", 401);
    return { token, expires };
  }
  async status() {
    try { const session = await this.session(); return { logged_in: true, auth_mode: "cli", expires_at: new Date(session.expires).toISOString(), live_access_verified: false }; }
    catch (error) { if (!(error instanceof AppError)) throw error; return { logged_in: false, auth_mode: "cli", message: error.message }; }
  }
  private async query(document: string, variables: Record<string,unknown>) {
    const session = await this.session();
    let response: Response;
    try {
      response = await this.request(ENDPOINT, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: document, variables }) });
    } catch { throw new AppError("CTM GraphQL request failed or timed out. Retry the read later.", "API_NETWORK", 502); }
    if (response.status === 401) throw new AppError(LOGIN, "CLI_LOGIN_REQUIRED", 401);
    if (!response.ok) throw new AppError(`CTM GraphQL request failed (HTTP ${response.status}).`, "API_ERROR", response.status);
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new AppError("CTM GraphQL returned invalid JSON.", "API_RESPONSE", 502); }
    const result = z.object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() }).safeParse(raw);
    // Never return partial data or provider error text, which may contain customer information.
    if (!result.success) throw new AppError("CTM GraphQL returned an unexpected response.", "API_RESPONSE", 502);
    if (result.data.errors?.length) throw new AppError("CTM rejected the GraphQL query. Check login, account permissions, and server schema support.", "GRAPHQL_ERROR", 403);
    if (session.expires <= Date.now()) throw new AppError(LOGIN, "CLI_LOGIN_REQUIRED", 401);
    return result.data.data;
  }
  private account<T>(data: unknown, accountId: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>) {
    const envelope = z.object({ account: z.object({ legacyId: id }).passthrough().nullable() }).safeParse(data);
    if (!envelope.success) throw new AppError("CTM account response could not be verified.", "API_RESPONSE", 502);
    if (!envelope.data.account) throw new AppError("Account unavailable for this CLI user.", "FORBIDDEN", 403);
    if (envelope.data.account.legacyId !== accountId) throw new AppError("CTM returned a different account. No data was released.", "ACCOUNT_MISMATCH", 403);
    const value = schema.safeParse(envelope.data.account);
    if (!value.success) throw new AppError("CTM GraphQL returned an unexpected data shape.", "API_RESPONSE", 502);
    return value.data;
  }
  async bots(accountId: string): Promise<VoiceBot[]> {
    accountIdSchema.parse(accountId);
    const bots: VoiceBot[] = [], seen = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 50; page++) {
      const data = await this.query(`query VoiceAiAgents($account: ID!, $after: String) { account(id: $account) { legacyId voiceBots(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { legacyId name description instructions playMessage classifierEnabled } } } }`, { account: accountId, after });
      const value = this.account(data, accountId, z.object({ voiceBots: z.object({ pageInfo: pageInfoSchema, nodes: z.array(botSchema) }) })).voiceBots;
      for (const b of value.nodes) bots.push({ id: b.legacyId, name: b.name ?? "", description: b.description ?? "", instructions: b.instructions ?? "", play_message: b.playMessage ?? "", classifier_enabled: b.classifierEnabled });
      if (!value.pageInfo.hasNextPage) return bots;
      const next = value.pageInfo.endCursor;
      if (!next || seen.has(next)) throw new AppError("VoiceAI pagination did not advance.", "API_PAGINATION", 502);
      seen.add(next); after = next;
    }
    throw new AppError("VoiceAI pagination exceeded the safety limit.", "API_PAGINATION", 502);
  }
  async calls(accountId: string, options: { after?: string; perPage?: number; since?: string; until?: string; direction?: string; hasTranscription?: boolean } = {}) {
    accountIdSchema.parse(accountId);
    const first = Math.max(10, Math.min(options.perPage ?? 50, 100));
    const startAt = dateBound(options.since, false), endAt = dateBound(options.until, true);
    if (startAt && endAt && startAt > endAt) throw new AppError("since must not be later than until.", "INVALID_DATES", 400);
    const data = await this.query(`query VoiceAiCalls($account: ID!, $first: Int!, $after: String, $startAt: Instant, $endAt: Instant) { account(id: $account) { legacyId activities(first: $first, after: $after, kinds: [PHONE_CALL], startAt: $startAt, endAt: $endAt, order: OCCURRED_AT, sortMode: DESC) { pageInfo { hasNextPage endCursor } nodes { legacyId direction occurredAt ... on PhoneCall { status transcription summary } } } } }`, { account: accountId, first, after: options.after ?? null, startAt, endAt });
    const value = this.account(data, accountId, z.object({ activities: z.object({ pageInfo: pageInfoSchema, nodes: z.array(callSchema) }) })).activities;
    if (value.pageInfo.hasNextPage && (!value.pageInfo.endCursor || value.pageInfo.endCursor === options.after)) throw new AppError("Call pagination did not advance.", "API_PAGINATION", 502);
    const direction = options.direction ?? "inbound";
    const matching = value.nodes.filter(c => direction === "none" || c.direction?.toLowerCase() === direction);
    const calls = matching.filter(c => options.hasTranscription === false || c.transcription?.trim()).map(c => ({ id: c.legacyId, occurred_at: c.occurredAt, direction: c.direction?.toLowerCase() ?? null, status: c.status, summary: c.summary ?? "", transcript: c.transcription ?? "" }));
    return { per_page: first, returned: value.nodes.length, matching_direction: matching.length,
      with_transcript: calls.filter(c => c.transcript.trim()).length, has_more: value.pageInfo.hasNextPage,
      next_cursor: value.pageInfo.hasNextPage ? value.pageInfo.endCursor : null, total: null, total_pages: null,
      filters: { since_utc: startAt, until_utc: endAt, direction, has_transcription: options.hasTranscription !== false, status: "all" },
      calls };
  }
}
function dateBound(value: string | undefined, end: boolean): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError("Dates must use YYYY-MM-DD; CLI mode interprets them in UTC.", "INVALID_DATES", 400);
  const parsed = new Date(value + (end ? "T23:59:59.999Z" : "T00:00:00.000Z"));
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== value) throw new AppError("Invalid calendar date.", "INVALID_DATES", 400);
  return parsed.toISOString();
}

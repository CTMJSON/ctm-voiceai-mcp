#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { configuredSummary, loadConfig } from "./config.js";
import { safeJson, mask } from "./util.js";
import { buildAuthorizeUrl, clearTokens, exchangeCode, startLogin, tokenState, waitForLogin } from "./oauth.js";
import { AppError } from "./errors.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fetchCallsPage, fetchVoiceBots, selectBots } from "./ctm.js";
import { CliGraphql } from "./cli-graphql.js";
import { resolveAuthHeader, verifyAuth } from "./local-auth.js";
import { listRuns, runStatus, writeReport } from "./engine.js";

const config = await loadConfig();
const cli = new CliGraphql(config);
const DEFAULT_TARGET_CALLS = 500;
const server = new McpServer({ name: "ctm-voiceai", version: "0.3.1" });

function toolResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : safeJson(value) }],
    isError
  };
}

function safeTool<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      return toolResult(await fn(args));
    } catch (err) {
      return toolResult(
        {
          error: err instanceof AppError ? err.message : "The operation failed. Check the local configuration and try again.",
          code: err instanceof AppError ? err.code : "INTERNAL_ERROR",
          hint:
            err instanceof AppError && err.code === "NO_AUTH"
              ? (config.authMode === "cli" ? "Run ctm auth login in Terminal." : "Run ctm_voiceai_auth_login to start the OAuth2 PKCE login.")
              : undefined
        },
        true
      );
    }
  };
}

function authSummary(state: Awaited<ReturnType<typeof tokenState>>) {
  if (!state.logged_in) {
    return {
      logged_in: false,
      message: "Not logged in. Call ctm_voiceai_auth_login to start the PKCE login."
    };
  }
  return {
    logged_in: true,
    account_id: state.account_id,
    scope: state.scope,
    expires_in_seconds: state.expires_in_seconds,
    expires_at: state.expires_at,
    has_refresh_token: state.has_refresh_token
  };
}

// ---------------------------------------------------------------------------
// Configuration / auth
// ---------------------------------------------------------------------------

server.registerTool(
  "ctm_voiceai_configured",
  {
    title: "VoiceAI MCP Configuration",
    description:
      "Shows configured CTM VoiceAI settings: OAuth client id, login state, the report renderer path, and where analysis runs are written. Never reveals secrets.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  },
  safeTool(async () => {
    const state = config.authMode === "cli" ? null : await tokenState(config.clientId);
    return {
      ...configuredSummary(config),
      client_id_masked: mask(config.clientId),
      auth: state ? authSummary(state) : await cli.status()
    };
  })
);

server.registerTool(
  "ctm_voiceai_auth_login",
  {
    title: config.authMode === "cli" ? "CTM CLI Login Instructions" : "CTM OAuth Login (PKCE)",
    description: config.authMode === "cli" ? "Returns Terminal sign-in instructions for the shared CTM CLI session. Does not start OAuth app registration." : "Start browser sign-in using S256 PKCE and a local callback. Requires a configured public OAuth client and registered loopback redirect. Call auth_status after approving.",
    inputSchema: { wait_seconds: z.number().int().min(0).max(600).optional() },
    annotations: { openWorldHint: true }
  },
  safeTool(async ({ wait_seconds = 0 }) => {
    if (config.authMode === "cli") return { status: "external_login_required", message: "Run ctm auth login in Terminal. Approve read-only access, then call auth_status. No OAuth app registration is needed in CLI mode." };
    const started = await startLogin(config);
    return wait_seconds > 0 ? { ...started, ...await waitForLogin(config, wait_seconds) } : started;
  })
);

server.registerTool(
  "ctm_voiceai_auth_status",
  {
    title: "CTM Login Status",
    description: "Reports expiry of the selected local CLI or OAuth session. Does not verify live CTM access.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  },
  safeTool(async () => config.authMode === "cli" ? cli.status() : authSummary(await tokenState(config.clientId)))
);

server.registerTool(
  "ctm_voiceai_auth_logout",
  {
    title: "CTM OAuth Local Logout",
    description: "Deletes local tokens and pending login. Does not revoke the grant at CTM.",
    inputSchema: {},
    annotations: { destructiveHint: true }
  },
  safeTool(async () => { requireOAuthMode(); await clearTokens(); return { status: "logged_out", server_revoked: false }; })
);

server.registerTool(
  "ctm_voiceai_auth_url",
  {
    title: "CTM OAuth PKCE URL",
    description: "Starts a manual PKCE login with the configured public client and registered redirect URI. The verifier stays local. Complete using auth_exchange with the full callback URL.",
    inputSchema: {},
    annotations: { openWorldHint: true }
  },
  safeTool(async () => { requireOAuthMode(); return buildAuthorizeUrl(config); })
);

server.registerTool(
  "ctm_voiceai_auth_exchange",
  {
    title: "CTM OAuth PKCE Callback",
    description: "Completes a pending manual login. Validates callback URI and state before exchanging the code with the locally stored PKCE verifier. Never pass an access token.",
    inputSchema: { callback_url: z.string().url().describe("Complete registered callback URL including code and state.") },
    annotations: { openWorldHint: true }
  },
  safeTool(async ({ callback_url }) => {
    requireOAuthMode();
    await exchangeCode(config, callback_url);
    return { status: "authorized", auth: authSummary(await tokenState(config.clientId)) };
  })
);

// ---------------------------------------------------------------------------
// VoiceAI agents
// ---------------------------------------------------------------------------

function requireOAuthMode() {
  if (config.authMode === "cli") throw new AppError("CLI login is managed in Terminal with ctm auth login. This tool does not alter the shared CLI session.", "CLI_AUTH_EXTERNAL");
}
async function authHeader(accountId: string) {
  // When we know the account, make a lightweight verified call so an expired or
  // missing login fails fast with a clear, actionable message.
  if (accountId) return verifyAuth(config, accountId);
  const { header, mode } = await resolveAuthHeader(config);
  return { header, mode };
}

server.registerTool(
  "ctm_voiceai_get_voice_bots",
  {
    title: "Get VoiceAI Agents And Instructions",
    description:
      "Step 2 of the review flow: returns the account's VoiceAI agents and their full current instructions. Optionally filter to one agent by id or name substring. The assistant compares these instructions against the transcripts from ctm_voiceai_get_calls.",
    inputSchema: {
      account_id: z.string().describe("CTM sub-account id."),
      voice_bot: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Optional agent id or name substring. Default: every agent that has instructions.")
    },
    annotations: { readOnlyHint: true }
  },
  safeTool(async ({ account_id, voice_bot }) => {
    const auth = config.authMode === "cli" ? null : await authHeader(account_id);
    const bots = auth ? await fetchVoiceBots(account_id, auth.header) : await cli.bots(account_id);
    const selectors = typeof voice_bot === "string" ? [voice_bot] : voice_bot ?? [];
    const selected = selectors.length ? selectBots(bots, selectors) : bots.filter((b) => b.instructions);
    return {
      account_id,
      auth_mode: auth?.mode ?? "cli",
      count: selected.length,
      voice_bots: selected.map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description,
        play_message: b.play_message,
        instructions: b.instructions
      }))
    };
  })
);

// ---------------------------------------------------------------------------
// Calls and reporting
// ---------------------------------------------------------------------------

server.registerTool(
  "ctm_voiceai_get_calls",
  {
    title: "Get Call Activities And Transcriptions",
    description:
      "Read call transcripts for analysis. CLI mode uses sequential after/next_cursor pagination over phone-call history, filters direction/transcript availability locally, and scans all statuses. Continue through empty pages while has_more=true. OAuth REST mode uses numbered pages of answered calls. Return actual reviewed coverage; workers are optional. Dates in CLI mode are UTC.",
    inputSchema: {
      account_id: z.string().describe("CTM sub-account id."),
      after: z.string().max(8192).optional().describe("CLI mode only: next_cursor from the previous response. Keep account and filters unchanged."),
      page: z.number().int().min(1).optional().describe("Page number, starting at 1. Default 1."),
      per_page: z.number().int().min(1).max(100).optional().describe("Calls per page. Default 25; keep it small so the transcripts fit in context."),
      target_calls: z.number().int().min(0).optional().describe("How many calls the whole review should cover. The plan sizes the batch fan-out to this. Default 500. Use 0 for every available call."),
      since: z.string().optional().describe("Start date YYYY-MM-DD."),
      until: z.string().optional().describe("End date YYYY-MM-DD."),
      direction: z.enum(["inbound", "outbound", "none"]).optional().describe("Default inbound."),
      max_transcript_chars: z.number().int().min(200).max(20000).optional().describe("Truncate each transcript to this many characters. Default 4000."),
      has_transcription: z.boolean().optional().describe("Only calls with a transcription. Default true.")
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  safeTool(async (args) => {
    if (config.authMode === "cli") {
      if (args.page && args.page !== 1) throw new AppError("CLI mode uses after/next_cursor, not page numbers.", "CURSOR_REQUIRED");
      const page = await cli.calls(args.account_id, { after: args.after, perPage: args.per_page, since: args.since, until: args.until, direction: args.direction, hasTranscription: args.has_transcription });
      const max = args.max_transcript_chars ?? 4000;
      return { account_id: args.account_id, auth_mode: "cli", pagination: "cursor", ...page,
        calls: page.calls.map(c => ({ ...c, transcript: c.transcript.slice(0, max), transcript_truncated: c.transcript.length > max })),
        plan: { target_calls: args.target_calls ?? DEFAULT_TARGET_CALLS, instruction: "Process sequentially using after=next_cursor with the same account and filters. Continue through empty pages while has_more=true until the requested number of usable calls is analyzed or history is exhausted. returned counts scanned calls; with_transcript counts available transcripts on this page. Do not claim planned coverage as completed. GraphQL scans all call statuses and returns only text permitted by your user permissions." } };
    }
    if (args.after) throw new AppError("OAuth REST mode uses page numbers, not cursors.", "INVALID_PAGINATION");
    const auth = await authHeader(args.account_id);
    const perPage = args.per_page ?? 25;
    const page = await fetchCallsPage(args.account_id, auth.header, {
      page: args.page ?? 1,
      perPage,
      since: args.since,
      until: args.until,
      direction: args.direction || "inbound",
      hasTranscription: args.has_transcription ?? true
    });
    const maxChars = args.max_transcript_chars ?? 4000;
    const calls = page.calls.map((c) => ({
      ...c,
      transcript: c.transcript.length > maxChars ? `${c.transcript.slice(0, maxChars)}...` : c.transcript
    }));

    // Build the parallel coverage plan so the assistant fans out instead of
    // stopping after the one page it happened to fetch.
    const totalCalls = page.total ?? page.returned;
    const target = args.target_calls ?? DEFAULT_TARGET_CALLS;
    const wanted = target > 0 ? Math.min(target, totalCalls) : totalCalls;
    let batchCount = Math.max(1, Math.ceil(wanted / perPage));
    if (page.total_pages) batchCount = Math.min(batchCount, page.total_pages);
    const batches = Array.from({ length: batchCount }, (_, i) => ({
      batch: i + 1,
      page: i + 1,
      per_page: perPage,
      approx_calls: Math.max(0, Math.min(perPage, wanted - i * perPage))
    }));
    const plan = {
      target_calls: target,
      covered_calls: batches.reduce((sum, b) => sum + b.approx_calls, 0),
      total_calls: totalCalls,
      total_pages: page.total_pages,
      batch_count: batches.length,
      batches,
      instruction:
        "Dispatch one subagent per batch in parallel (cap ~5-6 concurrent). Do not stop until every batch is analyzed."
    };

    return {
      account_id: args.account_id,
      auth_mode: auth.mode,
      page: page.page,
      per_page: page.per_page,
      returned: page.returned,
      with_transcript: page.with_transcript,
      total: page.total,
      total_pages: page.total_pages,
      has_more: page.has_more,
      next_page: page.next_page,
      plan,
      calls
    };
  })
);

server.registerTool(
  "ctm_voiceai_write_report",
  {
    title: "Write Report And Open HTML",
    description:
      "Step 6 of the review flow: takes the analysis the assistant produced, writes it to files, renders the self-contained HTML report, and opens it in the browser. Pass the canonical topics, an optional per-call table, the reviewed agents with their current instructions, the recommendations Markdown, and the suggested fully rewritten prompt.",
    inputSchema: {
      account_id: z.string().describe("CTM sub-account id."),
      call_context: z
        .object({ call_count: z.number().optional() })
        .optional()
        .describe("Optional context, e.g. { call_count: 500 }."),
      topics: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            call_count: z.number().optional(),
            voice_ai_suitability: z.enum(["High", "Medium", "Low"]).optional(),
            rationale: z.string().optional(),
            example_call_ids: z.array(z.union([z.number(), z.string()])).optional()
          })
        )
        .describe("Canonical topics synthesized from the calls."),
      call_rows: z
        .array(
          z.object({
            id: z.union([z.number(), z.string()]).optional(),
            occurred_at: z.string().optional(),
            topic: z.string().optional(),
            voice_ai_suitable: z.string().optional(),
            description: z.string().optional(),
            reasoning: z.string().optional()
          })
        )
        .optional()
        .describe("Optional per-call extraction rows."),
      bots: z
        .array(z.object({ id: z.string().optional(), name: z.string().optional(), instructions: z.string().optional() }))
        .optional()
        .describe("The reviewed agents and their current instructions."),
      recommendations: z
        .array(
          z.object({
            id: z.string().optional(),
            name: z.string().optional(),
            markdown: z.string().describe("The Recommended Prompt Updates Markdown for this agent.")
          })
        )
        .optional(),
      rewrites: z
        .array(
          z.object({
            id: z.string().optional(),
            name: z.string().optional(),
            text: z.string().describe("The full rewritten agent prompt for this agent.")
          })
        )
        .optional(),
      open: z.boolean().optional().describe("Open the report in the browser. Default true."),
      out_dir: z.string().optional()
    },
    annotations: { openWorldHint: true, destructiveHint: false }
  },
  safeTool(async (args) => {
    const artifacts = {
      account_id: args.account_id,
      call_count: args.call_context?.call_count ?? args.topics.reduce((sum, t) => sum + (t.call_count || 0), 0),
      topics: args.topics || [],
      call_rows: args.call_rows || [],
      bots: args.bots || [],
      recommendations: args.recommendations || [],
      rewrites: args.rewrites || [],
      generated_instructions: ""
    };
    const record = await writeReport(config, {
      accountId: args.account_id,
      artifacts,
      open: args.open ?? config.openReport,
      outDir: args.out_dir
    });
    return {
      run_id: record.run_id,
      status: record.status,
      run_dir: record.run_dir,
      html_opened: record.status === "complete" && (args.open ?? config.openReport),
      files: record.files,
      error: record.error || null
    };
  })
);

server.registerTool(
  "ctm_voiceai_run_status",
  {
    title: "VoiceAI Run Status",
    description:
      "Returns the status of an analysis run (running/complete/error), its output file paths, and the tail of the log when still running or failed. When complete, read recommended_prompt_updates to see the recommendations.",
    inputSchema: {
      run_id: z.string().describe("Run id returned by ctm_voiceai_write_report."),
      out_dir: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  },
  safeTool(async ({ run_id, out_dir }) => runStatus(config, run_id, out_dir))
);

server.registerTool(
  "ctm_voiceai_list_runs",
  {
    title: "List VoiceAI Runs",
    description: "Lists recent VoiceAI analysis runs, newest first.",
    inputSchema: {
      out_dir: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional()
    },
    annotations: { readOnlyHint: true }
  },
  safeTool(async ({ out_dir, limit }) => ({ runs: await listRuns(config, out_dir, { limit: limit || 20 }) }))
);

const transport = new StdioServerTransport();
await server.connect(transport);

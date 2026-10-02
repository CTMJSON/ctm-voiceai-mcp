#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { configuredSummary, loadConfig } from "./config.js";
import { safeJson, mask, openInBrowser } from "./util.js";
import {
  buildAuthorizeUrl,
  clearDeviceSession,
  clearTokens,
  exchangeCode,
  loadDeviceSession,
  pollDeviceFlow,
  startDeviceFlow,
  tokenState,
  waitForDeviceFlow
} from "./oauth.js";
import { fetchCallsPage, fetchVoiceBots, resolveAuthHeader, selectBots, verifyAuth } from "./ctm.js";
import { listRuns, loadRun, runStatus, writeReport } from "./engine.js";

const config = await loadConfig();
const DEFAULT_TARGET_CALLS = 500;
const server = new McpServer({ name: "ctm-voiceai", version: "0.1.0" });

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : safeJson(value) }],
    isError
  };
}

function safeTool(fn) {
  return async (args) => {
    try {
      return toolResult(await fn(args));
    } catch (err) {
      return toolResult(
        {
          error: err.message,
          code: err.code || null,
          stack: process.env.CTM_VOICEAI_DEBUG ? err.stack : undefined,
          hint:
            err.code === "NO_AUTH"
              ? "Run ctm_voiceai_auth_login to start the OAuth2 device flow."
              : undefined
        },
        true
      );
    }
  };
}

function authSummary(state) {
  if (!state.logged_in) {
    return {
      logged_in: false,
      message: "Not logged in. Call ctm_voiceai_auth_login to start the device flow."
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
    const state = await tokenState();
    return {
      ...configuredSummary(config),
      client_id_masked: mask(config.clientId),
      auth: authSummary(state)
    };
  })
);

server.registerTool(
  "ctm_voiceai_auth_login",
  {
    title: "CTM OAuth Login (Device Flow)",
    description:
      "Logs in to CTM with OAuth2 device flow. First call returns a user_code and verification_uri; the user visits the URL and enters the code. Call again (or pass wait_seconds) to finish and store tokens. No API key needed.",
    inputSchema: {
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(600)
        .optional()
        .describe("Seconds to poll for authorization after starting. 0 returns immediately with the code.")
    },
    annotations: { openWorldHint: true }
  },
  safeTool(async ({ wait_seconds = 0 }) => {
    let session = await loadDeviceSession();
    const isNew = !session;
    let browserOpened = false;

    if (!session) {
      session = await startDeviceFlow(config.clientId);
      if (config.openBrowser) browserOpened = openInBrowser(session.verification_uri);
    }

    const display = {
      user_code: session.user_code,
      verification_uri: session.verification_uri,
      expires_in: session.expires_in,
      instruction: `Go to ${session.verification_uri} and enter this code: ${session.user_code}`
    };

    if (!wait_seconds && isNew) {
      return {
        status: "device_code_issued",
        browser_opened: browserOpened,
        ...display,
        next: "Authorize in the browser, then call ctm_voiceai_auth_login again to finish."
      };
    }

    const result =
      wait_seconds > 0
        ? await waitForDeviceFlow(config.clientId, { maxSeconds: wait_seconds })
        : await pollDeviceFlow(config.clientId);

    if (result.status === "authorized") {
      return { status: "authorized", auth: authSummary(await tokenState()) };
    }
    if (result.status === "pending") {
      if (!browserOpened && config.openBrowser) browserOpened = openInBrowser(session.verification_uri);
      return {
        status: "pending",
        browser_opened: browserOpened,
        ...display,
        next: "Not authorized yet. Enter the code above in the browser, then call ctm_voiceai_auth_login again."
      };
    }
    // expired / denied / no_session: clear the stale session so the next call starts fresh.
    await clearDeviceSession();
    return {
      status: result.status,
      detail: result.detail || null,
      ...display,
      next: "That code is no longer valid. Call ctm_voiceai_auth_login again for a fresh code."
    };
  })
);

server.registerTool(
  "ctm_voiceai_auth_status",
  {
    title: "CTM OAuth Status",
    description: "Reports whether CTM OAuth tokens are stored, their expiry, scope, and account id.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  },
  safeTool(async () => authSummary(await tokenState()))
);

server.registerTool(
  "ctm_voiceai_auth_logout",
  {
    title: "CTM OAuth Logout",
    description: "Deletes stored CTM OAuth tokens and any pending device-flow session.",
    inputSchema: {},
    annotations: { destructiveHint: true }
  },
  safeTool(async () => {
    await clearTokens();
    return { status: "logged_out" };
  })
);

server.registerTool(
  "ctm_voiceai_auth_url",
  {
    title: "CTM OAuth Web Flow URL",
    description:
      "Builds the OAuth2 authorization URL for the web flow. Open it in a browser; CTM redirects to your redirect_uri with a ?code=. Then call ctm_voiceai_auth_exchange with that code.",
    inputSchema: {
      redirect_uri: z.string().describe("The registered redirect URI for the OAuth app."),
      scope: z.string().optional().describe("Defaults to the configured scope."),
      state: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  },
  safeTool(async ({ redirect_uri, scope, state }) => ({
    authorize_url: buildAuthorizeUrl({
      clientId: config.clientId,
      redirectUri: redirect_uri,
      scope: scope || config.scope,
      state
    })
  }))
);

server.registerTool(
  "ctm_voiceai_auth_exchange",
  {
    title: "CTM OAuth Exchange Code",
    description: "Exchanges a web-flow authorization code for CTM OAuth tokens and stores them.",
    inputSchema: {
      code: z.string().describe("The code query parameter CTM redirected back with."),
      redirect_uri: z.string().describe("Must match the redirect_uri used to authorize.")
    },
    annotations: { openWorldHint: true }
  },
  safeTool(async ({ code, redirect_uri }) => {
    await exchangeCode({ clientId: config.clientId, code, redirectUri: redirect_uri });
    return { status: "authorized", auth: authSummary(await tokenState()) };
  })
);

// ---------------------------------------------------------------------------
// VoiceAI agents
// ---------------------------------------------------------------------------

async function authHeader(accountId) {
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
    const auth = await authHeader(account_id);
    const bots = await fetchVoiceBots(account_id, auth.header);
    const selectors = [].concat(voice_bot || []);
    const selected = selectors.length ? selectBots(bots, selectors) : bots.filter((b) => b.instructions);
    return {
      account_id,
      auth_mode: auth.mode,
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
      "Step 3 of the review flow: one GET against the CTM calls endpoint returning a page of answered calls with transcriptions. The response includes a `plan` describing the full parallel coverage: total_pages and an array of `batches` covering `target_calls` (default 500). Dispatch one subagent per batch; each subagent calls this tool with that batch's page and per_page. Returns id, date, summary and transcript (truncated to max_transcript_chars) for each call.",
    inputSchema: {
      account_id: z.string().describe("CTM sub-account id."),
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
      open: args.open ?? true,
      outDir: args.out_dir
    });
    return {
      run_id: record.run_id,
      status: record.status,
      run_dir: record.run_dir,
      html_opened: record.status === "complete" && (args.open ?? true),
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
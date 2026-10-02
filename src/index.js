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
import { fetchVoiceBots, resolveAuthHeader, selectBots, verifyAuth } from "./ctm.js";
import { listRuns, loadRun, readRunArtifacts, readTopics, runStatus, startAnalyze, startRecommend, summarizeTopicsFile } from "./engine.js";
import { clientSupportsSampling, startSamplingBridge } from "./llmBridge.js";

const config = await loadConfig();
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

/** Open a sampling bridge so the analysis runs on the MCP host model. */
async function llmBridgeFor() {
  const sampling = clientSupportsSampling(server);
  if (!sampling) {
    throw new Error(
      "This MCP client does not advertise MCP sampling support, and the analysis "
        + "runs on the host model via sampling. Use an MCP client that supports "
        + "sampling (e.g. Claude Desktop with sampling enabled)."
    );
  }
  const bridge = await startSamplingBridge(server);
  return { bridge };
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
      "Shows configured CTM VoiceAI settings: OAuth client id, login state, sampling support, the Python engine path, and where analysis runs are written. Never reveals secrets.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  },
  safeTool(async () => {
    const state = await tokenState();
    return {
      ...configuredSummary(config),
      client_id_masked: mask(config.clientId),
      sampling_supported: clientSupportsSampling(server),
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
  "ctm_voiceai_list_voice_bots",
  {
    title: "List VoiceAI Agents",
    description:
      "Lists the CTM VoiceAI agents configured on an account, with instruction length so you can see which have prompts. Uses OAuth if logged in, otherwise basic auth. Orientation only: this is not a review. To review an agent's prompt, run ctm_voiceai_analyze first so the feedback is grounded in the calls.",
    inputSchema: { account_id: z.string().describe("CTM sub-account id.") },
    annotations: { readOnlyHint: true }
  },
  safeTool(async ({ account_id }) => {
    const auth = await authHeader(account_id);
    const bots = await fetchVoiceBots(account_id, auth.header);
    return {
      account_id,
      auth_mode: auth.mode,
      count: bots.length,
      voice_bots: bots.map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description,
        instructions_chars: b.instructions.length,
        has_instructions: Boolean(b.instructions),
        play_message: b.play_message
      }))
    };
  })
);

server.registerTool(
  "ctm_voiceai_get_voice_bot",
  {
    title: "Get VoiceAI Agent",
    description:
      "Returns one VoiceAI agent's full current instructions (matched by id or name substring). Orientation only: do NOT write prompt feedback from this alone. Run ctm_voiceai_analyze first, which analyzes the account's calls and then compares them against these instructions.",
    inputSchema: {
      account_id: z.string().describe("CTM sub-account id."),
      bot_id: z.string().optional().describe("Exact agent id."),
      name: z.string().optional().describe("Name substring, if id is not known.")
    },
    annotations: { readOnlyHint: true }
  },
  safeTool(async ({ account_id, bot_id, name }) => {
    const auth = await authHeader(account_id);
    const bots = await fetchVoiceBots(account_id, auth.header);
    const selector = bot_id || name;
    const selected = selector
      ? selectBots(bots, [selector])
      : bots.filter((b) => b.instructions);
    if (selected.length === 0) throw new Error("No matching VoiceAI agent with instructions found.");
    return {
      account_id,
      auth_mode: auth.mode,
      count: selected.length,
      voice_bots: selected.map((b) => ({
        id: b.id,
        name: b.name,
        play_message: b.play_message,
        instructions: b.instructions
      }))
    };
  })
);

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const analyzeSchema = {
  account_id: z.string().describe("CTM sub-account id to analyze."),
  target: z.number().int().min(1).max(2000).optional().describe("Transcribed calls to analyze. Default 500."),
  since: z.string().optional().describe("Start date YYYY-MM-DD."),
  until: z.string().optional().describe("End date YYYY-MM-DD."),
  direction: z.enum(["inbound", "outbound", "none"]).optional().describe("Default inbound."),
  batch_size: z
    .number()
    .int()
    .min(10)
    .max(200)
    .optional()
    .describe(
      "Max calls per extraction batch (default 100, aligned with the CTM page size). Batches are also bounded by total transcript size so they never overflow the model context. Each batch is one host-model sampling request, so larger batches mean fewer requests."
    ),
  voice_bot: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("VoiceAI agent id or name substring to review. Default: all agents with instructions."),
  out_dir: z.string().optional().describe("Override the output directory for this run."),
  skip_bot_instructions: z
    .boolean()
    .optional()
    .describe("Skip generating brand-new bot instructions (pass 3). Default true."),
  wait: z
    .boolean()
    .optional()
    .describe("If true (default), wait for completion and return the topic list and full recommendations inline. Set false to return immediately with a run_id.")
};

server.registerTool(
  "ctm_voiceai_analyze",
  {
    title: "Analyze Calls, Then Review Agent Prompt (run this first)",
    description:
      "The correct entry point for reviewing a VoiceAI agent: fetches the account's transcribed calls, extracts and synthesizes caller topics FIRST, then compares those topics against the account's current agent instructions and writes recommended prompt updates plus HTML/CSV topic reports. Always use this before giving any prompt feedback, so the feedback is grounded in the calls. When complete, the result includes the topic list, the full recommendations, and a suggested fully rewritten prompt (suggested_rewrite_markdown), so present them in one reply (call topics first, then recommendations, then the rewritten prompt) without asking whether to show them or making the user open files. Waits for completion by default. Returns a run id as well; poll ctm_voiceai_run_status if needed.",
    inputSchema: analyzeSchema,
    annotations: { openWorldHint: true }
  },
  safeTool(async (args) => {
    // Fail fast with a clear, actionable message when the CTM login is missing or expired.
    await verifyAuth(config, args.account_id);
    const { bridge } = await llmBridgeFor();
    let result;
    try {
      const skipBotInstructions = args.skip_bot_instructions ?? true;
      const { runId, record, pending } = await startAnalyze(config, {
        accountId: args.account_id,
        target: args.target ?? 500,
        since: args.since,
        until: args.until,
        direction: args.direction || "inbound",
        batchSize: args.batch_size,
        voiceBot: args.voice_bot,
        outDir: args.out_dir,
        skipBotInstructions,
        llmBridge: bridge,
        wait: args.wait ?? true
      });
      result = {
        run_id: runId,
        status: record.status,
        pending: Boolean(pending),
        run_dir: record.run_dir,
        auth_mode: record.auth_mode,
        llm_backend: "sampling",
        message: pending
          ? "Run started. Poll ctm_voiceai_run_status with this run_id."
          : `Run finished with status ${record.status}.`,
        files: record.files
      };
      if (!pending && record.status === "complete") {
        Object.assign(result, await readRunArtifacts(record));
        if (record.files?.pass2_cache) {
          result.call_context = { ...(result.call_context || {}), topics_file: record.files.pass2_cache };
        }
      }
    } catch (err) {
      if (bridge) await bridge.close().catch(() => {});
      throw err;
    }
    return result;
  })
);

server.registerTool(
  "ctm_voiceai_recommend_updates",
  {
    title: "Re-run Prompt Review From a Prior Call Analysis",
    description:
      "ADVANCED / re-run only. Regenerates prompt recommendations using the call topics already captured by a completed ctm_voiceai_analyze run (identified by run_id). Use this only after the agent prompt changed and you want a fresh comparison against the SAME call analysis; it does NOT fetch calls. For a first review, call ctm_voiceai_analyze instead. Errors if the run has no call-topic analysis. Returns the recommendations inline on completion, plus a suggested fully rewritten prompt (suggested_rewrite_markdown).",
    inputSchema: {
      run_id: z
        .string()
        .describe("run_id from a COMPLETED ctm_voiceai_analyze run. Its call topics and captured agent prompt are reused."),
      account_id: z.string().optional().describe("Defaults to the account of the referenced run."),
      voice_bot: z.union([z.string(), z.array(z.string())]).optional(),
      out_dir: z.string().optional(),
      wait: z.boolean().optional().describe("If true (default), wait and return the recommendations inline. Set false to return a run_id immediately."),
      topics_file: z.string().optional().describe("Advanced override. Must be a pass2 topics JSON from a call analysis."),
      bots_file: z.string().optional().describe("Advanced override. Must be a voice_bots JSON.")
    },
    annotations: { openWorldHint: true }
  },
  safeTool(async (args) => {
    let topicsFile = args.topics_file || null;
    let botsFile = args.bots_file || null;
    let accountId = args.account_id || null;
    let sourceRun = null;

    if (args.run_id) {
      const { state } = await loadRun(config, args.run_id, args.out_dir);
      if (!state) throw new Error(`Run ${args.run_id} not found. Run ctm_voiceai_analyze first.`);
      if (state.mode !== "analyze") {
        throw new Error(
          `Run ${args.run_id} is a '${state.mode}' run with no call analysis. Run ctm_voiceai_analyze first.`
        );
      }
      if (state.status !== "complete") {
        throw new Error(`Run ${args.run_id} is ${state.status}. Wait for it to complete, then retry.`);
      }
      topicsFile = topicsFile || state.files?.pass2_cache;
      botsFile = botsFile || state.files?.voice_bots;
      accountId = accountId || state.account_id;
      sourceRun = args.run_id;
    }

    if (!topicsFile || !botsFile) {
      throw new Error(
        "Prompt review needs call context first. Run ctm_voiceai_analyze for the account, then pass its run_id here (or provide both topics_file and bots_file)."
      );
    }

    const ctx = await summarizeTopicsFile(topicsFile);
    if (!ctx || !ctx.topic_count) {
      throw new Error(
        `No call topics found in ${topicsFile}. Run ctm_voiceai_analyze to analyze the calls before reviewing the prompt.`
      );
    }
    const resolvedAccount = accountId || "unknown";

    const { bridge } = await llmBridgeFor();
    let result;
    try {
      const { runId, record, pending } = await startRecommend(config, {
        accountId: resolvedAccount,
        topicsFile,
        botsFile,
        voiceBot: args.voice_bot,
        outDir: args.out_dir,
        llmBridge: bridge,
        wait: args.wait ?? true
      });
      result = {
        run_id: runId,
        status: record.status,
        pending: Boolean(pending),
        run_dir: record.run_dir,
        llm_backend: "sampling",
        call_context: { ...ctx, topics_file: topicsFile, source_run_id: sourceRun },
        message: pending ? "Run started. Poll ctm_voiceai_run_status." : `Run finished with status ${record.status}.`,
        files: record.files
      };
      if (!pending && record.status === "complete") {
        Object.assign(result, await readRunArtifacts(record));
        result.topics = await readTopics(topicsFile);
        result.call_context = {
          ...(result.call_context || {}),
          topics_file: topicsFile,
          source_run_id: sourceRun
        };
      }
    } catch (err) {
      if (bridge) await bridge.close().catch(() => {});
      throw err;
    }
    return result;
  })
);

server.registerTool(
  "ctm_voiceai_run_status",
  {
    title: "VoiceAI Run Status",
    description:
      "Returns the status of an analysis run (running/complete/error), its output file paths, and the tail of the log when still running or failed. When complete, read recommended_prompt_updates to see the recommendations.",
    inputSchema: {
      run_id: z.string().describe("Run id returned by ctm_voiceai_analyze or ctm_voiceai_recommend_updates."),
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
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir, exists, nowIso, openInBrowser, readJson, readText, tailFile, writeJson } from "./util.js";
import { getAccessToken } from "./oauth.js";

const activeRuns = new Map();

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function newRunId(accountId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${safeSegment(accountId)}-${stamp}`;
}

export function runDirFor(config, accountId, outDir, runId) {
  return path.join(outDir || config.outDir, runId || newRunId(accountId));
}

export function runFiles(runDir) {
  return {
    run_state: path.join(runDir, "run.json"),
    log: path.join(runDir, "run.log"),
    pass1_cache: path.join(runDir, "pass1_cache.json"),
    pass2_cache: path.join(runDir, "pass2_cache.json"),
    voice_bots: path.join(runDir, "voice_bots.json"),
    html: path.join(runDir, "voiceai_topic_analysis.html"),
    csv: path.join(runDir, "voiceai_topic_analysis.csv"),
    bot_instructions: path.join(runDir, "voiceai_bot_instructions.md"),
    recommendations: path.join(runDir, "recommended_prompt_updates.md")
  };
}

function analyzeArgs(config, opts, files) {
  const args = [
    config.enginePath,
    "--account-id", String(opts.accountId),
    "--target", String(opts.target ?? 500),
    "--save-pass1", files.pass1_cache,
    "--save-pass2", files.pass2_cache,
    "--save-voice-bots", files.voice_bots,
    "--out", files.html,
    "--csv-out", files.csv,
    "--recommendations-out", files.recommendations
  ];
  if (opts.since) args.push("--since", String(opts.since));
  if (opts.until) args.push("--until", String(opts.until));
  if (opts.direction) args.push("--direction", String(opts.direction));
  if (opts.batchSize) args.push("--batch-size", String(opts.batchSize));
  if (!opts.skipBotInstructions) args.push("--bot-instructions-out", files.bot_instructions);
  else args.push("--skip-bot-instructions");
  for (const v of [].concat(opts.voiceBot || [])) args.push("--voice-bot", String(v));
  return args;
}

function recommendArgs(config, opts, files) {
  const args = [
    config.enginePath,
    "--account-id", String(opts.accountId),
    "--pass2-cache", opts.topicsFile,
    "--voice-bots-cache", opts.botsFile,
    "--skip-bot-instructions",
    "--out", files.html,
    "--csv-out", files.csv,
    "--recommendations-out", files.recommendations
  ];
  // Reuse the source run's per-call extractions so the report keeps the call-level section.
  if (opts.topicsFile) args.push("--pass1-cache", path.join(path.dirname(opts.topicsFile), "pass1_cache.json"));
  for (const v of [].concat(opts.voiceBot || [])) args.push("--voice-bot", String(v));
  return args;
}

async function engineEnv(config, { preferBasic = false, llmBridge = null } = {}) {
  const env = { ...process.env, PYTHONUNBUFFERED: "1" };
  // The analysis always runs on the MCP host model via the sampling bridge.
  if (llmBridge) {
    env.CTM_VOICEAI_LLM_BRIDGE = llmBridge.url;
    env.CTM_VOICEAI_LLM_BRIDGE_TOKEN = llmBridge.token;
  }

  const bearer = preferBasic ? null : await getAccessToken({ clientId: config.clientId }).catch(() => null);
  if (bearer) {
    env.CTM_BEARER_TOKEN = bearer;
    delete env.CTM_BASIC_AUTH;
  } else if (config.basicAuth) {
    env.CTM_BASIC_AUTH = config.basicAuth;
    delete env.CTM_BEARER_TOKEN;
  }
  return env;
}

function launch({ config, engineArgs, env, runDir, meta, llmBridge = null }) {
  const files = runFiles(runDir);
  const child = spawn(config.pythonBin, engineArgs, {
    cwd: runDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  fs.open(files.log, "a")
    .then((handle) => {
      child.stdout.on("data", (chunk) => handle.write(chunk));
      child.stderr.on("data", (chunk) => handle.write(chunk));
    })
    .catch(() => {});

  const record = {
    run_id: meta.runId,
    account_id: meta.accountId,
    mode: meta.mode,
    status: "running",
    created_at: nowIso(),
    started_at: nowIso(),
    finished_at: null,
    pid: child.pid,
    exit_code: null,
    run_dir: runDir,
    engine_args: engineArgs.slice(1),
    auth_mode: env.CTM_BEARER_TOKEN ? "oauth" : env.CTM_BASIC_AUTH ? "basic" : "none",
    llm_backend: "sampling",
    error: null,
    files
  };

  const done = new Promise((resolve) => {
    const finalize = async (status, error) => {
      record.status = status;
      if (error && !record.error) record.error = error;
      record.finished_at = nowIso();
      for (const key of ["pass2_cache", "voice_bots", "html", "csv", "bot_instructions", "recommendations"]) {
        record.files[key] = (await exists(files[key])) ? files[key] : null;
      }
      await writeJson(files.run_state, record).catch(() => {});
      activeRuns.delete(meta.runId);
      if (llmBridge) await llmBridge.close().catch(() => {});
      if (status === "complete" && config.openReport && record.files.html) {
        openInBrowser(pathToFileURL(record.files.html).href);
      }
      resolve(record);
    };

    child.on("error", (err) =>
      finalize("error", `Failed to start ${config.pythonBin}: ${err.message}`)
    );
    child.on("exit", (code) => {
      record.exit_code = code;
      if (code === 0) return finalize("complete", null);
      return finalize("error", `Engine exited with code ${code}. See run.log.`);
    });
  });

  activeRuns.set(meta.runId, { child, done, runDir });
  writeJson(files.run_state, record).catch(() => {});
  return { record, done };
}

async function launchRun(config, {
  accountId,
  outDir,
  mode,
  engineArgsFactory,
  preferBasic,
  wait,
  llmBridge = null
}) {
  const runId = newRunId(accountId);
  const runDir = runDirFor(config, accountId, outDir, runId);
  await ensureDir(runDir);
  const files = runFiles(runDir);
  const engineArgs = engineArgsFactory(files);
  const env = await engineEnv(config, { preferBasic, llmBridge });
  const { record, done } = launch({
    config,
    engineArgs,
    env,
    runDir,
    meta: { runId, accountId, mode },
    llmBridge
  });

  if (wait) {
    return { record: await done, runId, runDir };
  }
  done.catch(() => {});
  return { record, runId, runDir, pending: true };
}

export function startAnalyze(config, opts) {
  return launchRun(config, {
    accountId: opts.accountId,
    outDir: opts.outDir,
    mode: "analyze",
    preferBasic: false,
    wait: opts.wait,
    llmBridge: opts.llmBridge || null,
    engineArgsFactory: (files) => analyzeArgs(config, opts, files)
  });
}

export function startRecommend(config, opts) {
  // Pass 4 reads cached topics + cached bots, so no CTM token is required.
  return launchRun(config, {
    accountId: opts.accountId,
    outDir: opts.outDir,
    mode: "recommend",
    preferBasic: true,
    wait: opts.wait,
    llmBridge: opts.llmBridge || null,
    engineArgsFactory: (files) => recommendArgs(config, opts, files)
  });
}

export async function loadRun(config, runId, outDir) {
  const runDir = path.join(outDir || config.outDir, runId);
  const state = await readJson(runFiles(runDir).run_state, null);
  return { runDir, state };
}

export async function listRuns(config, outDir, { limit = 20 } = {}) {
  const base = outDir || config.outDir;
  let entries = [];
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries.filter((e) => e.isDirectory()).slice(-limit)) {
    const state = await readJson(runFiles(path.join(base, entry.name)).run_state, null);
    if (state) runs.push(state);
  }
  return runs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function runStatus(config, runId, outDir) {
  const { runDir, state } = await loadRun(config, runId, outDir);
  if (!state) return { run_id: runId, status: "unknown", run_dir: runDir };
  const live = activeRuns.get(runId);
  const result = { ...state, alive: Boolean(live && state.status === "running") };
  if (result.status === "running" || result.status === "error") {
    result.log_tail = await tailFile(runFiles(runDir).log, 30);
  }
  if (result.status === "complete") {
    Object.assign(result, await readRunArtifacts(result));
  } else if (result.files?.pass2_cache) {
    result.call_context = await summarizeTopicsFile(result.files.pass2_cache);
  }
  return result;
}

/** Read a pass2 topics cache and return just the context summary. */
export async function summarizeTopicsFile(file) {
  const data = await readJson(file, null);
  if (!data) return null;
  if (Array.isArray(data)) return { call_count: null, topic_count: data.length };
  const topics = Array.isArray(data.topics) ? data.topics : [];
  return { call_count: data.call_count ?? null, topic_count: topics.length };
}

/** Read a pass2 topics cache into a compact, presentable topic list. */
export async function readTopics(file) {
  const data = await readJson(file, null);
  if (!data || Array.isArray(data)) return [];
  const topics = Array.isArray(data.topics) ? data.topics : [];
  return topics.map((t) => ({
    name: t.name,
    call_count: t.call_count,
    voice_ai_suitability: t.voice_ai_suitability,
    description: t.description
  }));
}

/**
 * Collect the human-readable results of a completed run so a single tool call can
 * return everything the agent needs to present (no extra round-trips).
 */
export async function readRunArtifacts(state, { maxRecommendationChars = 200000 } = {}) {
  const out = {};
  if (state?.files?.pass2_cache) {
    const data = await readJson(state.files.pass2_cache, null);
    if (data && !Array.isArray(data)) {
      const topics = Array.isArray(data.topics) ? data.topics : [];
      out.call_context = { call_count: data.call_count ?? null, topic_count: topics.length };
      out.topics = await readTopics(state.files.pass2_cache);
    }
  }
  if (state?.files?.recommendations) {
    const text = await readText(state.files.recommendations, "");
    if (text) {
      out.recommendations_markdown =
        text.length > maxRecommendationChars ? `${text.slice(0, maxRecommendationChars)}\n\n[truncated]` : text;
    }
  }
  return out;
}
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { ensureDir, exists, nowIso, readJson, tailFile, writeJson } from "./util.js";
import type { Config } from "./config.js";
import { runSchema, type Artifacts, type RunRecord } from "./types.js";
import { AppError } from "./errors.js";
import { sanitizeArtifacts } from "./sanitize.js";

function safeSegment(value: string) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function newRunId(accountId: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${safeSegment(accountId)}-${stamp}`;
}

export function runDirFor(config: Config, accountId: string, outDir?: string, runId?: string) {
  return path.join(outDir || config.outDir, runId || newRunId(accountId));
}

export function runFiles(runDir: string) {
  return {
    run_state: path.join(runDir, "run.json"),
    log: path.join(runDir, "run.log"),
    artifacts: path.join(runDir, "analysis_artifacts.json"),
    html: path.join(runDir, "voiceai_topic_analysis.html"),
    csv: path.join(runDir, "voiceai_topic_analysis.csv"),
    recommendations: path.join(runDir, "recommended_prompt_updates.md"),
    rewrite: path.join(runDir, "suggested_prompt_rewrite.md")
  };
}

function topicsCsv(topics: Artifacts["topics"] = []) {
  const columns = ["name", "description", "call_count", "voice_ai_suitability", "rationale", "example_call_ids"] as const;
  const esc = (value: unknown) => {
    const text = Array.isArray(value) ? value.join(";") : value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(",")];
  for (const topic of topics) {
    lines.push(columns.map((column) => esc(topic[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function recommendationsMarkdown(artifacts: Artifacts) {
  const recs = artifacts.recommendations || [];
  if (!recs.length) return "";
  const header = `# Voice AI Prompt Recommendations - Account ${artifacts.account_id}\n\n`;
  return header + recs.map((r) => `## Agent: ${r.name || r.id || "agent"}\n\n${r.markdown || ""}`).join("\n\n");
}

function rewriteMarkdown(artifacts: Artifacts) {
  const rewrites = artifacts.rewrites || [];
  if (!rewrites.length) return "";
  const header = `# Suggested Rewritten Prompt - Account ${artifacts.account_id}\n\n`;
  return header + rewrites.map((r) => `## Agent: ${r.name || r.id || "agent"}\n\n${r.text || ""}`).join("\n\n");
}

/**
 * Persist an agent-produced analysis and render the HTML report.
 * The analysis itself is done by the assistant; this only writes files and renders.
 */
export async function writeReport(config: Config, { accountId, artifacts, open = config.openReport, outDir }: { accountId: string; artifacts: Artifacts; open?: boolean; outDir?: string }) {
  const runId = newRunId(accountId || "account");
  const runDir = runDirFor(config, accountId, outDir, runId);
  await ensureDir(runDir);
  const files = runFiles(runDir);

  const record: RunRecord = {
    run_id: runId,
    account_id: accountId || null,
    mode: "report",
    status: "running",
    created_at: nowIso(),
    finished_at: null,
    run_dir: runDir,
    files: {}
  };

  const payload = sanitizeArtifacts({ ...artifacts, account_id: artifacts.account_id || accountId });
  await writeJson(files.artifacts, payload);
  const recs = recommendationsMarkdown(payload);
  if (recs) await fs.writeFile(files.recommendations, recs, "utf8");
  const rewrite = rewriteMarkdown(payload);
  if (rewrite) await fs.writeFile(files.rewrite, rewrite, "utf8");
  await fs.writeFile(files.csv, topicsCsv(payload.topics || []), "utf8");

  const args = [config.renderPath, "--artifacts", files.artifacts, "--out", files.html];
  const env = { ...process.env, PYTHONUNBUFFERED: "1", CTM_VOICEAI_OPEN_REPORT: open ? "1" : "0" };
  const child = spawn(config.pythonBin, args, { cwd: runDir, env, stdio: ["ignore", "pipe", "pipe"] });

  const logChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => logChunks.push(chunk));
  child.stderr.on("data", (chunk) => logChunks.push(chunk));

  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("exit", (code) => resolve(code ?? -1));
  });

  await fs.writeFile(files.log, Buffer.concat(logChunks).toString("utf8"), "utf8").catch(() => {});

  for (const key of ["artifacts", "html", "csv", "recommendations", "rewrite"] as const) {
    record.files[key] = (await exists(files[key])) ? files[key] : null;
  }
  record.status = exitCode === 0 && record.files.html ? "complete" : "error";
  record.exit_code = exitCode;
  record.finished_at = nowIso();
  if (record.status === "error") {
    record.error = `Report renderer exited with code ${exitCode}. See run.log.`;
  }
  await writeJson(files.run_state, record).catch(() => {});
  return record;
}

export async function loadRun(config: Config, runId: string, outDir?: string) {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(runId)) throw new AppError("Invalid run id.", "INVALID_RUN");
  const runDir = path.join(outDir || config.outDir, runId);
  const parsed = runSchema.safeParse(await readJson(runFiles(runDir).run_state));
  const state = parsed.success ? parsed.data : null;
  return { runDir, state };
}

export async function listRuns(config: Config, outDir?: string, { limit = 20 } = {}) {
  const base = outDir || config.outDir;
  let entries = [];
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries.filter((e) => e.isDirectory()).slice(-limit)) {
    const parsed = runSchema.safeParse(await readJson(runFiles(path.join(base, entry.name)).run_state));
    if (parsed.success) runs.push(parsed.data);
  }
  return runs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function runStatus(config: Config, runId: string, outDir?: string) {
  const { runDir, state } = await loadRun(config, runId, outDir);
  if (!state) return { run_id: runId, status: "unknown", run_dir: runDir };
  const result: RunRecord & { log_tail?: string } = { ...state };
  if (result.status === "error") {
    result.log_tail = await tailFile(runFiles(runDir).log, 30);
  }
  return result;
}

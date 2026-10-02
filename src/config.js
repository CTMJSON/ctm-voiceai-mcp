import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exists, parseEnvFile, readText } from "./util.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(here, "..");
export const ENGINE_PATH = path.join(PACKAGE_ROOT, "engine", "ctm_voiceai_topic_analysis.py");

const DEFAULT_CLIENT_ID = "ROB1_WEfKqNL3HHwBG5FsniXDz_E2WYw_5J_L9LDuuQ";
const DEFAULT_SCOPE = "profile activity reports";

function extraEnvFile() {
  return process.env.CTM_VOICEAI_ENV_FILE || "";
}

function configDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "ctm-voiceai");
}

function dataDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "ctm-voiceai");
}

export function paths() {
  const cfg = configDir();
  return {
    configDir: cfg,
    configFile: path.join(cfg, "config.env"),
    tokensFile: path.join(cfg, "tokens.json"),
    deviceFile: path.join(cfg, "device.json"),
    runsDir: process.env.CTM_VOICEAI_OUT_DIR || path.join(dataDir(), "runs")
  };
}

/** Load config: process.env wins over ~/.config/ctm-voiceai/config.env, then any CTM_VOICEAI_ENV_FILE. */
export async function loadConfig() {
  const p = paths();
  let fileEnv = {};
  if (await exists(p.configFile)) {
    fileEnv = parseEnvFile(await readText(p.configFile, ""));
  }
  let extraEnv = {};
  const extra = extraEnvFile();
  if (extra && (await exists(extra))) {
    extraEnv = parseEnvFile(await readText(extra, ""));
  }

  const get = (key) => process.env[key] || fileEnv[key] || extraEnv[key] || "";

  return {
    paths: p,
    clientId: get("CTM_OAUTH_CLIENT_ID") || DEFAULT_CLIENT_ID,
    scope: get("CTM_OAUTH_SCOPE") || DEFAULT_SCOPE,
    basicAuth: get("CTM_BASIC_AUTH"),
    pythonBin: get("PYTHON_BIN") || "python3",
    enginePath: ENGINE_PATH,
    outDir: get("CTM_VOICEAI_OUT_DIR") || p.runsDir,
    openBrowser: !["0", "false", "no", "off"].includes((get("CTM_VOICEAI_OPEN_BROWSER") || "true").toLowerCase()),
    openReport: !["0", "false", "no", "off"].includes((get("CTM_VOICEAI_OPEN_REPORT") || "true").toLowerCase()),
    extraEnvFile: extraEnvFile()
  };
}

export function configuredSummary(config) {
  const clientId = config.clientId;
  return {
    client_id: clientId,
    auth_priority: ["oauth bearer (CTM_BEARER_TOKEN / stored OAuth token)", "basic auth (CTM_BASIC_AUTH)"],
    analysis_backend: "mcp-sampling (runs on the MCP host model)",
    open_browser_on_login: config.openBrowser,
    open_report_when_done: config.openReport,
    python_bin: config.pythonBin,
    engine_path: config.enginePath,
    config_file: config.paths.configFile,
    extra_env_file: config.extraEnvFile || null,
    runs_dir: config.outDir
  };
}
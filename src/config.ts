import os from "node:os";
import { AppError } from "./errors.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exists, parseEnvFile, readText } from "./util.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(here, "..");
export const RENDER_PATH = path.join(PACKAGE_ROOT, "engine", "render_report.py");


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
    pkceFile: path.join(cfg, "pkce.json"),
    runsDir: process.env.CTM_VOICEAI_OUT_DIR || path.join(dataDir(), "runs")
  };
}

/** Load config: process.env wins over ~/.config/ctm-voiceai/config.env, then any CTM_VOICEAI_ENV_FILE. */
export async function loadConfig() {
  const p = paths();
  let fileEnv: Record<string, string> = {};
  if (await exists(p.configFile)) {
    fileEnv = parseEnvFile(await readText(p.configFile, ""));
  }
  let extraEnv: Record<string, string> = {};
  const extra = extraEnvFile();
  if (extra && (await exists(extra))) {
    extraEnv = parseEnvFile(await readText(extra, ""));
  }

  const get = (key: string) => process.env[key] || fileEnv[key] || extraEnv[key] || "";

  const mode = get("CTM_VOICEAI_AUTH_MODE") || "oauth";
  if (mode !== "oauth" && mode !== "cli") throw new AppError("CTM_VOICEAI_AUTH_MODE must be oauth or cli.", "CONFIG");
  return {
    authMode: mode,
    cliConfigFile: get("CTM_VOICEAI_CLI_CONFIG") || path.join(os.homedir(), ".ctm.yml"),
    paths: p,
    clientId: get("CTM_OAUTH_CLIENT_ID"),
    scope: get("CTM_OAUTH_SCOPE") || DEFAULT_SCOPE,
    redirectUri: get("CTM_OAUTH_REDIRECT_URI") || "http://127.0.0.1:8765/oauth/callback",
    pythonBin: get("PYTHON_BIN") || "python3",
    renderPath: RENDER_PATH,
    outDir: get("CTM_VOICEAI_OUT_DIR") || p.runsDir,
    openBrowser: !["0", "false", "no", "off"].includes((get("CTM_VOICEAI_OPEN_BROWSER") || "true").toLowerCase()),
    openReport: !["0", "false", "no", "off"].includes((get("CTM_VOICEAI_OPEN_REPORT") || "true").toLowerCase()),
    extraEnvFile: extraEnvFile()
  };
}

export function configuredSummary(config: Config) {
  const clientId = config.clientId;
  return {
    client_id: clientId,
    auth_mode: config.authMode,
    auth_priority: [config.authMode === "cli" ? "CTM CLI browser-login GraphQL token only" : "stored OAuth bearer token (authorization code + S256 PKCE)"],
    analysis_backend: "assistant-driven: the MCP host assistant performs the analysis (no LLM API or key)",
    open_browser_on_login: config.openBrowser,
    open_report_when_done: config.openReport,
    python_bin: config.pythonBin,
    renderer_path: config.renderPath,
    config_file: config.paths.configFile,
    extra_env_file: config.extraEnvFile || null,
    runs_dir: config.outDir
  };
}
export type Config = Awaited<ReturnType<typeof loadConfig>>;

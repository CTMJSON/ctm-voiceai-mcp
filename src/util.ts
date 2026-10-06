import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso() {
  return new Date().toISOString();
}

export function mask(value: string | undefined, keep = 6) {
  if (!value || typeof value !== "string") return null;
  if (value.length <= keep * 2) return `${value.slice(0, 2)}...`;
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function readJson(file: string, fallback: unknown = null): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, value: unknown) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export async function readText(file: string, fallback = "") {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return fallback;
  }
}

export async function tailFile(file: string, maxLines = 40) {
  const text = await readText(file, "");
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  return lines.slice(-maxLines).join("\n");
}

export async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort open a URL in the OS default browser. Never throws. */
export function openInBrowser(url: string) {
  try {
    const opts = { stdio: "ignore" as const, detached: true };
    if (process.platform === "darwin") {
      spawn("open", [url], opts).on("error", () => {}).unref();
      return true;
    }
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], opts).on("error", () => {}).unref();
      return true;
    }
    spawn("xdg-open", [url], opts).on("error", () => {}).unref();
    return true;
  } catch {
    return false;
  }
}

/** Parse a simple KEY:value or KEY=value env file. Does not export. */
export function parseEnvFile(text: string) {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.includes("=") ? "=" : line.includes(":") ? ":" : null;
    if (!sep) continue;
    const idx = line.indexOf(sep);
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) out[key] = value;
  }
  return out;
}

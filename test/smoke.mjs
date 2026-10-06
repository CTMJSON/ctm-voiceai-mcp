#!/usr/bin/env node
// Minimal stdio smoke test: initialize, list tools, and call two read-only tools.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "index.js");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "voiceai-smoke-"));
const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, XDG_CONFIG_HOME: testRoot, XDG_DATA_HOME: testRoot,
    CTM_VOICEAI_ENV_FILE: path.join(testRoot, "absent.env"), CTM_OAUTH_CLIENT_ID: "fixture-public-client",
    CTM_VOICEAI_OPEN_BROWSER: "0" }
});
process.on("exit", () => { child.kill("SIGTERM"); fs.rmSync(testRoot, { recursive: true, force: true }); });

let buffer = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0.0.1" }
});
assert.equal(init.result?.serverInfo?.name, "ctm-voiceai", "server name");
notify("notifications/initialized", {});

const list = await rpc("tools/list", {});
const names = list.result.tools.map((t) => t.name);
for (const expected of [
  "ctm_voiceai_configured",
  "ctm_voiceai_auth_login",
  "ctm_voiceai_get_voice_bots",
  "ctm_voiceai_get_calls",
  "ctm_voiceai_write_report",
  "ctm_voiceai_run_status",
  "ctm_voiceai_list_runs"
]) {
  assert.ok(names.includes(expected), `missing tool ${expected}`);
}

const configured = await rpc("tools/call", { name: "ctm_voiceai_configured", arguments: {} });
assert.ok(!configured.result.isError, "configured call should not error");
const payload = JSON.parse(configured.result.content[0].text);
assert.ok(payload.client_id_masked, "client id present");
assert.ok(payload.auth, "auth block present");

const authRequired = await rpc("tools/call", { name: "ctm_voiceai_get_calls", arguments: { account_id: "1" } });
assert.equal(authRequired.result.isError, true);
assert.equal(JSON.parse(authRequired.result.content[0].text).code, "NO_AUTH");
console.log(`OK - ${names.length} tools registered`);
console.log(`configured.auth.logged_in = ${payload.auth.logged_in}`);
console.log(`configured.analysis_backend = ${payload.analysis_backend}`);

child.kill("SIGTERM");
process.exit(0);
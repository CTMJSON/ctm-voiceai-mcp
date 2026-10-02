#!/usr/bin/env node
// Minimal stdio smoke test: initialize, list tools, and call two read-only tools.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "src", "index.js");

const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });

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
  "ctm_voiceai_list_voice_bots",
  "ctm_voiceai_analyze",
  "ctm_voiceai_recommend_updates",
  "ctm_voiceai_run_status"
]) {
  assert.ok(names.includes(expected), `missing tool ${expected}`);
}

const configured = await rpc("tools/call", { name: "ctm_voiceai_configured", arguments: {} });
assert.ok(!configured.result.isError, "configured call should not error");
const payload = JSON.parse(configured.result.content[0].text);
assert.ok(payload.client_id_masked, "client id present");
assert.ok(payload.auth, "auth block present");

console.log(`OK - ${names.length} tools registered`);
console.log(`configured.logged_in = ${payload.auth.logged_in}`);
console.log(`configured.openai_key_present = ${payload.openai_key_present}`);

child.kill("SIGTERM");
process.exit(0);
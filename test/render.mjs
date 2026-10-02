#!/usr/bin/env node
// Validates the assistant-driven report path: the MCP server writes the
// analysis artifacts, renders the HTML report, and reports the output files.
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "src", "index.js");

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    CTM_VOICEAI_ENV_FILE: "/nonexistent-voiceai-env",
    CTM_VOICEAI_OPEN_REPORT: "0"
  }
});

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
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
const notify = (method, params) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "render-test", version: "0.0.1" }
});
assert.equal(init.result?.serverInfo?.name, "ctm-voiceai");
notify("notifications/initialized", {});

const outDir = path.join(os.tmpdir(), `ctm-voiceai-render-${Date.now()}`);

const call = await rpc("tools/call", {
  name: "ctm_voiceai_write_report",
  arguments: {
    account_id: "test-account",
    call_context: { call_count: 3 },
    topics: [
      {
        name: "Booking a service",
        description: "Caller wants to schedule an appointment.",
        call_count: 2,
        voice_ai_suitability: "High",
        rationale: "Simple and scriptable end to end.",
        example_call_ids: [1, 2]
      },
      {
        name: "Billing question",
        description: "Caller asks about an invoice.",
        call_count: 1,
        voice_ai_suitability: "Medium",
        rationale: "Best triaged by a bot, finished by a human.",
        example_call_ids: [3]
      }
    ],
    call_rows: [
      {
        id: 1,
        occurred_at: "2026-01-02T10:00:00Z",
        topic: "Booking a service",
        voice_ai_suitable: "yes",
        description: "Wanted an appointment.",
        reasoning: "Simple request."
      }
    ],
    bots: [
      { id: "bot-1", name: "Example Agent", instructions: "You are the example receptionist." }
    ],
    recommendations: [
      {
        id: "bot-1",
        name: "Example Agent",
        markdown: "# Recommended Prompt Updates\n\n## Coverage Map\n| Topic | Fit |\n|---|---|\n| Booking | Partial |\n\n```\nWhen the caller wants to book, collect the date and time.\n```"
      }
    ],
    rewrites: [
      { id: "bot-1", name: "Example Agent", text: "You are the rewritten receptionist. Route booking calls." }
    ],
    open: false,
    out_dir: outDir
  }
});

assert.ok(!call.result.isError, `tool errored: ${call.result.content[0].text}`);
const result = JSON.parse(call.result.content[0].text);
assert.equal(result.status, "complete", `report status: ${result.status}`);
assert.ok(result.files.html && fs.existsSync(result.files.html), "HTML report written");
assert.ok(result.files.recommendations && fs.existsSync(result.files.recommendations), "recommendations written");
assert.ok(result.files.rewrite && fs.existsSync(result.files.rewrite), "rewrite written");
assert.ok(result.files.csv && fs.existsSync(result.files.csv), "csv written");

const html = fs.readFileSync(result.files.html, "utf8");
for (const marker of ['id="topics"', 'id="calls"', 'id="current"', 'id="recommendations"', 'id="rewrite"', "Copy rewritten prompt"]) {
  assert.ok(html.includes(marker), `HTML missing ${marker}`);
}
assert.equal(result.html_opened, false, "browser open disabled for the test");

console.log("OK - write_report rendered the HTML report and wrote all files");
console.log(`topics: ${result.files.html ? "html present" : "missing"} | run: ${result.run_id}`);

child.kill("SIGTERM");
process.exit(0);
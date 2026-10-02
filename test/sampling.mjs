#!/usr/bin/env node
// Validates the MCP sampling path: the test client advertises sampling and
// answers createMessage, so the engine runs entirely on the host model.
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
let samplingCalls = 0;

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
    // Server -> client request (sampling)
    if (msg.method === "sampling/createMessage" && msg.id !== undefined) {
      samplingCalls += 1;
      const reply = {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          role: "assistant",
          model: "test-sampler",
          stopReason: "endTurn",
          content: {
            type: "text",
            text: "# Recommended Prompt Updates\n\n(sampled by the host model)"
          }
        }
      };
      child.stdin.write(`${JSON.stringify(reply)}\n`);
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
  capabilities: { sampling: {} },
  clientInfo: { name: "sampling-test", version: "0.0.1" }
});
assert.equal(init.result?.serverInfo?.name, "ctm-voiceai");
notify("notifications/initialized", {});

const configured = await rpc("tools/call", { name: "ctm_voiceai_configured", arguments: {} });
const cfg = JSON.parse(configured.result.content[0].text);
assert.equal(cfg.sampling_supported, true, "client sampling capability detected");

// Build a fake completed call-analysis run so recommend_updates has call context.
const outDir = path.join(os.tmpdir(), `ctm-voiceai-sampling-${Date.now()}`);
const runId = "test-account-test-run";
const runDir = path.join(outDir, runId);
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(
  path.join(runDir, "pass2_cache.json"),
  JSON.stringify({
    call_count: 3,
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
    ]
  })
);
fs.writeFileSync(
  path.join(runDir, "voice_bots.json"),
  JSON.stringify({
    voice_bots: [
      {
        id: "bot-1",
        name: "Example Agent",
        instructions: "You are the example receptionist. Greet the caller and route requests."
      }
    ]
  })
);
fs.writeFileSync(
  path.join(runDir, "run.json"),
  JSON.stringify({
    run_id: runId,
    account_id: "test-account",
    mode: "analyze",
    status: "complete",
    files: {
      pass2_cache: path.join(runDir, "pass2_cache.json"),
      voice_bots: path.join(runDir, "voice_bots.json")
    }
  })
);

// Guard: no call context -> refuse (this must not reach the LLM).
const guard = await rpc("tools/call", {
  name: "ctm_voiceai_recommend_updates",
  arguments: { run_id: "does-not-exist", out_dir: outDir }
});
assert.equal(guard.result.isError, true, "recommend_updates must require real call context");

const call = await rpc("tools/call", {
  name: "ctm_voiceai_recommend_updates",
  arguments: { run_id: runId, out_dir: outDir, wait: true }
});
const result = JSON.parse(call.result.content[0].text);
assert.ok(!call.result.isError, `tool errored: ${call.result.content[0].text}`);
assert.equal(result.status, "complete", `run status: ${result.status}`);
assert.equal(result.llm_backend, "sampling", "should have used sampling");
assert.ok(result.files.recommendations, "recommendations file written");
assert.ok(result.call_context?.topic_count > 0, "call context attached");
assert.ok(
  typeof result.recommendations_markdown === "string" && result.recommendations_markdown.length > 0,
  "recommendations returned inline"
);
assert.ok(
  typeof result.suggested_rewrite_markdown === "string" && result.suggested_rewrite_markdown.length > 0,
  "suggested rewritten prompt returned inline"
);
assert.ok(Array.isArray(result.topics) && result.topics.length > 0, "topics returned inline");
assert.ok(samplingCalls >= 2, "client received createMessage requests (recommendations + rewrite)");

console.log(`OK - sampling backend ran pass 4 with ${samplingCalls} createMessage call(s)`);
console.log(`call_context: ${result.call_context.topic_count} topics / ${result.call_context.call_count} calls`);
console.log(`recommendations: ${result.files.recommendations}`);

child.kill("SIGTERM");
process.exit(0);
import http from "node:http";
import crypto from "node:crypto";

/**
 * Start a loopback HTTP bridge that lets the Python engine run LLM completions
 * on whatever model the MCP host is using, via MCP sampling
 * (`sampling/createMessage`). The engine posts prompts here; we relay them to
 * the client and return the text.
 *
 * Only bound to 127.0.0.1 and protected by a per-run random token.
 */
export async function startSamplingBridge(mcpServer, { maxTokensCap = 16000 } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  let closed = false;

  const httpServer = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/complete")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (req.headers["x-bridge-token"] !== token) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }

    const maxTokens = Math.min(Number(payload.max_output_tokens) || 4000, maxTokensCap);
    try {
      const result = await mcpServer.server.createMessage({
        messages: [
          {
            role: "user",
            content: { type: "text", text: String(payload.prompt || "") }
          }
        ],
        systemPrompt: "You are a precise call center analyst.",
        maxTokens,
        modelPreferences: {
          hints: [{ name: "claude" }, { name: "gpt" }],
          intelligencePriority: 0.8,
          speedPriority: 0.2
        }
      });
      const text = result?.content?.type === "text" ? result.content.text : "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `sampling failed: ${err?.message || String(err)}` }));
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const { port } = httpServer.address();

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => httpServer.close(resolve));
    }
  };
}

/** True when the connected MCP client advertises sampling support. */
export function clientSupportsSampling(mcpServer) {
  const caps = mcpServer.server.getClientCapabilities();
  return Boolean(caps?.sampling);
}
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AppError } from "../errors.js";
import type { VerifyCaller } from "./identity.js";
import { HostedOAuth } from "./oauth.js";
import { createHostedMcp, authorizedReport, publicError, type Services } from "./tools.js";
import { formats, renderReport, reportCsp, reportFormats, type ReportFormat } from "./render.js";

type HttpOptions = Services & { verify: VerifyCaller; oauth: HostedOAuth; issuer: string; dev: boolean };
const escape = (value: string) => value.replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]!));
const statePattern = /^[A-Za-z0-9_-]{43}$/;
function cookie(req: IncomingMessage, name: string) {
  const values = (req.headers.cookie ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(name + "="));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : "";
}
function single(url: URL, key: string) {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || !values[0] || values[0].length > 4096) throw new AppError("Invalid OAuth callback.", "OAUTH_STATE", 400);
  return values[0];
}
async function jsonBody(req: IncomingMessage) {
  if (!req.headers["content-type"]?.split(";")[0]?.trim().match(/^application\/json$/i)) throw new AppError("JSON content type required.", "INVALID_REQUEST", 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 2 * 1024 * 1024) throw new AppError("Request exceeds 2 MiB.", "TOO_LARGE", 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new AppError("Invalid JSON.", "INVALID_REQUEST", 400); }
}

export function createHostedHttp(options: HttpOptions) {
  const origin = new URL(options.publicUrl).origin;
  const sessionName = options.dev ? "voiceai-session" : "__Host-voiceai-session";
  const stateName = options.dev ? "voiceai-login" : "__Host-voiceai-login";
  const setCookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${options.dev ? "" : "; Secure"}`;
  const metadata = options.publicUrl + "/.well-known/oauth-protected-resource/mcp";
  let active = 0;
  // Per-process backstop. Public deployments also need an ingress distributed rate limit.
  const windows = new Map<string, { count: number; until: number }>();
  const rateLimit = (key: string, max: number) => {
    const now = Date.now();
    for (const [id, value] of windows) if (value.until <= now) windows.delete(id);
    let window = windows.get(key);
    if (!window) {
      if (windows.size >= 10000) throw new AppError("Server is busy. Try later.", "RATE_LIMIT", 429);
      window = { count: 0, until: now + 60000 }; windows.set(key, window);
    }
    if (++window.count > max) throw new AppError("Too many requests. Try later.", "RATE_LIMIT", 429);
  };
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 10000 }, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (!options.dev) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const redirect = (url: string) => { res.writeHead(303, { Location: url }); res.end(); };
    const html = (body: string) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>CTM VoiceAI connection</title><body><main>${body}</main></body></html>`); };
    const bearer = async () => {
      const header = req.headers.authorization;
      if (!header || !/^Bearer [^\s,]+$/i.test(header)) throw new AppError("A valid bearer token is required.", "UNAUTHORIZED", 401);
      return options.verify(header.slice(7));
    };
    const browser = async () => {
      const id = cookie(req, sessionName);
      if (!statePattern.test(id)) throw new AppError("Sign in at /connect first.", "UNAUTHORIZED", 401);
      return { id, caller: await options.oauth.browserCaller(id) };
    };
    const post = () => {
      if (req.method !== "POST") throw new AppError("POST required.", "METHOD_NOT_ALLOWED", 405);
      if (req.headers.origin !== origin) throw new AppError("Same-origin form submission required.", "FORBIDDEN", 403);
    };
    const get = () => { if (req.method !== "GET") throw new AppError("GET required.", "METHOD_NOT_ALLOWED", 405); };
    let counted = false;
    void (async () => {
      if (active >= 64) throw new AppError("Server is busy. Try later.", "RATE_LIMIT", 429);
      active++; counted = true;
      res.once("close", () => { if (counted) { active--; counted = false; } });
      const url = new URL(req.url ?? "/", origin);
      if (url.origin !== origin || req.headers.host !== new URL(origin).host) throw new AppError("Unrecognized host.", "FORBIDDEN", 403);
      if (req.headers.origin && req.headers.origin !== origin) throw new AppError("Origin is not allowed.", "FORBIDDEN", 403);
      if (url.pathname === "/health" && req.method === "GET") return json(200, { status: "ok" });
      rateLimit("ip:" + (req.socket.remoteAddress ?? "unknown"), 240);
      if (["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(url.pathname)) {
        get(); return json(200, { resource: options.publicUrl + "/mcp", authorization_servers: [options.issuer], scopes_supported: ["ctm-voiceai:use"], bearer_methods_supported: ["header"] });
      }
      if (url.pathname === "/mcp") {
        const caller = await bearer();
        rateLimit("user:" + caller.owner, 120);
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST"); throw new AppError("Stateless MCP supports POST only.", "METHOD_NOT_ALLOWED", 405);
        }
        const body = await jsonBody(req);
        const mcp = createHostedMcp(caller, options);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        let closed = false;
        const close = () => { if (!closed) { closed = true; void mcp.close().catch(() => {}); } };
        res.once("close", close);
        try { await mcp.connect(transport); await transport.handleRequest(req, res, body); }
        finally { close(); }
        return;
      }
      if (url.pathname === "/connect/login") {
        get(); const login = await options.oauth.beginLogin();
        res.setHeader("Set-Cookie", setCookie(stateName, login.state, 600));
        return redirect(login.url);
      }
      if (url.pathname === "/oidc/callback") {
        get(); const state = single(url, "state");
        if (!statePattern.test(state)) throw new AppError("Invalid login state.", "OAUTH_STATE", 400);
        const id = await options.oauth.finishLogin(state, cookie(req, stateName), single(url, "code"));
        res.setHeader("Set-Cookie", [setCookie(sessionName, id, 3600), setCookie(stateName, "", 0)]);
        return redirect("/connect");
      }
      if (url.pathname === "/connect") {
        get();
        try {
          const { caller } = await browser();
          return html(`<h1>CTM VoiceAI connection</h1><p>Signed in as ${escape(caller.subject)}.</p><p>Connect your own CTM OAuth grant. Approve manage access to read VoiceAI configuration.</p><form method="post" action="/connect/ctm"><button>Connect or reconnect CTM</button></form><form method="post" action="/connect/disconnect"><button>Remove stored CTM grant</button></form><form method="post" action="/connect/logout"><button>Sign out</button></form>`);
        } catch (error) {
          if (!(error instanceof AppError && error.status === 401)) throw error;
          return html('<h1>CTM VoiceAI connection</h1><p>Sign in with the same identity you use in your MCP client.</p><a href="/connect/login">Sign in</a>');
        }
      }
      if (url.pathname === "/connect/ctm") {
        post(); const { caller, id } = await browser(); return redirect(await options.oauth.beginCtm(caller, id));
      }
      if (url.pathname === "/ctm/callback") {
        get(); const { caller, id } = await browser(); const state = single(url, "state");
        if (!statePattern.test(state)) throw new AppError("Invalid CTM state.", "OAUTH_STATE", 400);
        await options.oauth.finishCtm(caller, id, state, single(url, "code"));
        return html('<h1>CTM connected</h1><p>You can now use the VoiceAI tools with this identity.</p><a href="/connect">Connection settings</a>');
      }
      if (url.pathname === "/connect/disconnect") {
        post(); const { caller } = await browser(); await options.oauth.disconnect(caller); return redirect("/connect");
      }
      if (url.pathname === "/connect/logout") {
        post(); const { id } = await browser(); await options.oauth.logoutBrowser(id);
        res.setHeader("Set-Cookie", setCookie(sessionName, "", 0)); return redirect("/connect");
      }
      const reportRoute = /^\/reports\/([0-9a-f-]{36})\/([a-z]+)$/.exec(url.pathname);
      if (reportRoute && reportFormats.includes(reportRoute[2] as ReportFormat)) {
        get(); const caller = req.headers.authorization ? await bearer() : (await browser()).caller;
        const report = await authorizedReport(caller, options, reportRoute[1]!);
        const format = reportRoute[2] as ReportFormat;
        res.setHeader("Content-Security-Policy", reportCsp);
        res.writeHead(200, { "Content-Type": formats[format].mimeType + "; charset=utf-8", "Content-Disposition": `attachment; filename="${formats[format].filename}"` });
        res.end(renderReport(report.artifacts, format)); return;
      }
      throw new AppError("Not found.", "NOT_FOUND", 404);
    })().catch(error => {
      if (res.headersSent) { res.end(); return; }
      const status = error instanceof AppError ? error.status ?? 500 : 500;
      if (status === 401) res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadata}"`);
      if (status === 429) res.setHeader("Retry-After", "60");
      json(status, publicError(error));
    });
  });
  server.setTimeout(120000, socket => socket.destroy());
  return server;
}

import { createHash } from "node:crypto";
import type { Artifacts } from "../types.js";

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, ch => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[ch]!));
const copyScript = 'document.querySelectorAll("[data-copy]").forEach(b=>b.addEventListener("click",()=>{navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent).then(()=>{b.textContent="Copied";}).catch(()=>{b.textContent="Select text to copy";});}));';
const scriptHash = createHash("sha256").update(copyScript).digest("base64");
export const reportCsp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
export const reportFormats = ["html","json","csv","recommendations","rewrite"] as const;
export type ReportFormat = typeof reportFormats[number];
export const formats: Record<ReportFormat,{mimeType:string;filename:string}> = {
  html: { mimeType:"text/html",filename:"voiceai_topic_analysis.html" },
  json: { mimeType:"application/json",filename:"analysis_artifacts.json" },
  csv: { mimeType:"text/csv",filename:"voiceai_topic_analysis.csv" },
  recommendations: { mimeType:"text/markdown",filename:"recommended_prompt_updates.md" },
  rewrite: { mimeType:"text/markdown",filename:"suggested_prompt_rewrite.md" }
};
/** In-memory output only. All model/customer prose is escaped; no remote assets or subprocesses. */
export function renderReport(a: Artifacts, format: ReportFormat): string {
  if (format === "json") return JSON.stringify(a,null,2);
  if (format === "recommendations") return a.recommendations.map(r => `## ${r.name || r.id || "Agent"}\n\n${r.markdown}`).join("\n\n");
  if (format === "rewrite") return a.rewrites.map(r => `## ${r.name || r.id || "Agent"}\n\n${r.text}`).join("\n\n");
  if (format === "csv") {
    const cols = ["name","description","call_count","voice_ai_suitability","rationale"] as const;
    const cell = (value: unknown) => {
      let text = String(value ?? "");
      if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g,'""') + '"';
    };
    return [cols.join(","), ...a.topics.map(t => cols.map(c => cell(t[c])).join(","))].join("\r\n");
  }
  const rows = a.topics.map(t => `<tr><td>${escape(t.name)}</td><td>${escape(t.call_count)}</td><td>${escape(t.voice_ai_suitability)}</td><td>${escape(t.description)}<p>${escape(t.rationale)}</p></td></tr>`).join("");
  const blocks = (items: {name?:string;id?:string;text:string}[], prefix: string) => items.map((item,i) => `<article><h3>${escape(item.name || item.id || "Agent")}</h3><button data-copy="${prefix}-${i}">Copy text</button><pre id="${prefix}-${i}">${escape(item.text)}</pre></article>`).join("") || "<p>No content supplied.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(reportCsp)}"><title>VoiceAI Prompt Review</title>
<style>body{margin:0;background:#f5f7fa;color:#162534;font:16px/1.55 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:32px}h1{font-size:32px}h2{color:#126c67}section{background:white;border:1px solid #dce7e6;border-radius:16px;padding:24px;margin:24px 0}nav{display:flex;gap:18px;flex-wrap:wrap}a{color:#126c67}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px;border-bottom:1px solid #e3e8ed;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#132637;color:#edf6f6;padding:20px;border-radius:10px}button{background:#126c67;color:white;border:0;border-radius:6px;padding:8px 14px;cursor:pointer}.table{overflow-x:auto}.meta{color:#536575}</style></head><body><main><h1>VoiceAI Prompt Review</h1><p class="meta">Account ${escape(a.account_id)} · ${escape(a.call_count ?? a.call_rows.length)} analyzed calls</p>
<nav><a href="#topics">Topics</a><a href="#calls">Calls</a><a href="#current">Current prompts</a><a href="#recommendations">Recommendations</a><a href="#rewrite">Rewritten prompts</a></nav>
<section id="topics"><h2>Topic analysis</h2><div class="table"><table><thead><tr><th>Topic</th><th>Calls</th><th>VoiceAI fit</th><th>Evidence and rationale</th></tr></thead><tbody>${rows}</tbody></table></div></section>
<section id="calls"><h2>Call analysis</h2>${a.call_rows.map(c=>`<article><h3>Call ${escape(c.id)} — ${escape(c.topic)}</h3><p>${escape(c.description)}</p><p>${escape(c.reasoning)}</p></article>`).join("") || "<p>No per-call rows supplied.</p>"}</section>
<section id="current"><h2>Current agent prompts</h2>${blocks(a.bots.map(b=>({...b,text:b.instructions || ""})),"current")}</section>
<section id="recommendations"><h2>Recommended prompt updates</h2>${blocks(a.recommendations.map(r=>({...r,text:r.markdown})),"rec")}</section>
<section id="rewrite"><h2>Suggested rewritten prompts</h2>${blocks(a.rewrites,"rewrite")}</section><p class="meta">Recommendations require human review. Coverage reflects supplied analysis; no live agent was changed.</p></main><script>${copyScript}</script></body></html>`;
}

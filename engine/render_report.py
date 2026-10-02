#!/usr/bin/env python3
"""Render a Voice AI analysis report from an artifacts JSON file.

This renderer is used by the CTM VoiceAI MCP server. The analysis itself is
performed by the MCP host assistant; this script only turns the analysis
artifacts into a self-contained HTML report and opens it in the browser.

Usage:
    python3 render_report.py --artifacts artifacts.json --out report.html
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("ctm_voiceai_render")


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )


CTM_APP_CALL_URL = (
    "https://app.calltrackingmetrics.com/calls"
    "#callNav=caller_profile&callId={id}"
)

_SUITABILITY_COLOR = {"High": "#0f766e", "Medium": "#b45309", "Low": "#b91c1c"}
_BADGE_COLOR = {
    "High": "#0f766e",
    "Medium": "#b45309",
    "Low": "#b91c1c",
    "yes": "#0f766e",
    "partial": "#b45309",
    "no": "#b91c1c",
}

_HTML_STYLE = """
:root { --ink:#111827; --muted:#6b7280; --accent:#0f766e; --paper:#fff; --bg:#f7f8fb; --stroke:rgba(15,118,110,0.15); --code-bg:#0f172a; }
*,*::before,*::after { box-sizing:border-box }
html { scroll-behavior:smooth }
body { margin:0; background:var(--bg); font-family:"Work Sans",system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:var(--ink); line-height:1.5 }
.container { max-width:1100px; margin:0 auto; padding:28px 20px 64px }
.header h1 { margin:0 0 4px; font-size:26px }
.meta { color:var(--muted); font-size:13px }
.stats { display:flex; gap:12px; flex-wrap:wrap; margin:16px 0 6px }
.stat { background:var(--paper); border:1px solid var(--stroke); border-radius:12px; padding:12px 16px; min-width:120px }
.stat .n { font-size:22px; font-weight:700 }
.stat .l { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em }
nav.toc { position:sticky; top:0; z-index:5; background:rgba(247,248,251,0.94); backdrop-filter:blur(6px); border-bottom:1px solid var(--stroke); margin:14px -20px 22px; padding:10px 20px; display:flex; gap:16px; flex-wrap:wrap; font-size:13px }
nav.toc a { color:var(--accent); text-decoration:none; font-weight:600 }
section.card { background:var(--paper); border:1px solid var(--stroke); border-radius:14px; box-shadow:0 10px 22px rgba(17,24,39,0.06); padding:20px; margin-bottom:22px }
section.card > h2 { margin:0 0 4px; font-size:20px }
section.card > .sub { color:var(--muted); font-size:13px; margin-bottom:14px }
.card h3 { margin:20px 0 6px; font-size:16px }
.badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:600; color:#fff; white-space:nowrap }
.count { font-weight:600 }
.small { font-size:12px; color:var(--muted) }
.table-wrap { overflow:auto }
.table { width:100%; border-collapse:collapse; font-size:14px; min-width:820px }
.table th, .table td { padding:9px 12px; border-bottom:1px solid rgba(15,118,110,0.12); vertical-align:top; text-align:left }
.table th { color:#0f172a; background:rgba(15,118,110,0.06) }
.calllinks a { margin-right:6px; color:var(--accent); text-decoration:none }
details { border:1px solid var(--stroke); border-radius:10px; padding:10px 14px; margin-top:12px; background:#fbfdfd }
details > summary { cursor:pointer; font-weight:600; color:#0f172a }
.codeblock { position:relative; margin:14px 0 }
.codeblock pre { background:var(--code-bg); color:#e5e7eb; padding:18px 14px 16px; border-radius:10px; overflow:auto; font-size:12.5px; line-height:1.55; margin:0 }
.codeblock code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre }
.copybtn { position:absolute; top:8px; right:8px; background:rgba(255,255,255,0.14); color:#fff; border:1px solid rgba(255,255,255,0.25); border-radius:7px; font-size:11px; padding:4px 9px; cursor:pointer }
.copybtn:hover { background:rgba(255,255,255,0.28) }
.copybtn.full { position:static; background:var(--accent); border:none; margin:6px 0 10px; padding:6px 12px; font-size:12px }
.fullsrc { position:absolute; left:-9999px; top:auto; width:1px; height:1px; opacity:0 }
.md-table-wrap { overflow:auto; margin:12px 0 }
.md-table { width:100%; border-collapse:collapse; font-size:13.5px; min-width:620px }
.md-table th, .md-table td { padding:8px 10px; border:1px solid rgba(15,118,110,0.16); text-align:left; vertical-align:top }
.md-table th { background:rgba(15,118,110,0.08) }
.md-body h1 { font-size:20px; margin:18px 0 8px }
.md-body h2 { font-size:17px; margin:20px 0 8px; padding-bottom:4px; border-bottom:1px solid var(--stroke) }
.md-body h3 { font-size:15px; margin:14px 0 6px }
.md-body p { margin:8px 0 }
.md-body ul, .md-body ol { margin:8px 0 8px 22px; padding:0 }
.md-body li { margin:4px 0 }
.md-body code { background:rgba(15,118,110,0.10); padding:1px 5px; border-radius:5px; font-size:12.5px }
.md-body hr { border:none; border-top:1px solid var(--stroke); margin:18px 0 }
footer { color:var(--muted); font-size:12px; margin-top:24px }
"""

_HTML_SCRIPT = """
function flash(btn, text){ var old=btn.getAttribute('data-label')||btn.textContent; btn.textContent=text; setTimeout(function(){ btn.textContent=old; }, 1500); }
function fallbackCopy(text, btn){ var ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.left='-9999px'; document.body.appendChild(ta); ta.focus(); ta.select(); try{ document.execCommand('copy'); }catch(e){} document.body.removeChild(ta); flash(btn,'Copied!'); }
function doCopy(text, btn){ if(navigator.clipboard && window.isSecureContext){ navigator.clipboard.writeText(text).then(function(){ flash(btn,'Copied!'); }, function(){ fallbackCopy(text, btn); }); } else { fallbackCopy(text, btn); } }
function copyCode(btn){ var code=btn.parentElement.querySelector('code'); if(code){ doCopy(code.innerText, btn); } }
function copyTextarea(btn){ var ta=btn.parentElement.querySelector('textarea.fullsrc'); if(ta){ doCopy(ta.value, btn); } }
"""


def _escape(text: Any) -> str:
    from html import escape

    return escape("" if text is None else str(text))


def _inline_md(text: str) -> str:
    text = _escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"`([^`]+?)`", r"<code>\1</code>", text)
    return text


def _code_block(code: str, label: str = "Copy") -> str:
    return (
        '<div class="codeblock">'
        f'<button class="copybtn" data-label="{_escape(label)}" onclick="copyCode(this)">{_escape(label)}</button>'
        f"<pre><code>{_escape(code)}</code></pre>"
        "</div>"
    )


def _full_copy(raw: str, label: str = "Copy full prompt") -> str:
    return (
        f'<button class="copybtn full" data-label="{_escape(label)}" onclick="copyTextarea(this)">{_escape(label)}</button>'
        f'<textarea class="fullsrc">{_escape(raw)}</textarea>'
    )


def _split_row(line: str) -> list[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in line.split("|")]


def _md_table_html(header: list[str], rows: list[list[str]]) -> str:
    th = "".join(f"<th>{_inline_md(c)}</th>" for c in header)
    body = "".join(
        "<tr>" + "".join(f"<td>{_inline_md(c)}</td>" for c in row) + "</tr>" for row in rows
    )
    return (
        '<div class="md-table-wrap"><table class="md-table"><thead><tr>'
        f"{th}</tr></thead><tbody>{body}</tbody></table></div>"
    )


def markdown_to_html(md: str, heading_offset: int = 0) -> str:
    """Render the subset of Markdown that the prompt-review pass produces."""
    lines = (md or "").split("\n")
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        s = lines[i].strip()
        if s.startswith("```"):
            i += 1
            buf: list[str] = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            out.append(_code_block("\n".join(buf)))
            continue
        if s.startswith("|") and i + 1 < n and set(lines[i + 1].strip()) <= set("|-: "):
            header = _split_row(s)
            i += 2
            rows: list[list[str]] = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append(_split_row(lines[i]))
                i += 1
            out.append(_md_table_html(header, rows))
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", s)
        if m:
            lvl = min(len(m.group(1)) + heading_offset, 6)
            out.append(f"<h{lvl}>{_inline_md(m.group(2))}</h{lvl}>")
            i += 1
            continue
        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", s):
            out.append("<hr>")
            i += 1
            continue
        if re.match(r"^([-*]|\d+\.)\s+", s):
            ordered = bool(re.match(r"^\d+\.\s+", s))
            items: list[str] = []
            while i < n and re.match(r"^([-*]|\d+\.)\s+", lines[i].strip()):
                item = re.sub(r"^([-*]|\d+\.)\s+", "", lines[i].strip())
                items.append(f"<li>{_inline_md(item)}</li>")
                i += 1
            tag = "ol" if ordered else "ul"
            out.append(f"<{tag}>" + "".join(items) + f"</{tag}>")
            continue
        if not s:
            i += 1
            continue
        buf = [s]
        i += 1
        while i < n and lines[i].strip() and not re.match(
            r"^(#{1,6}\s|[-*]\s|\d+\.\s|\||```)", lines[i].strip()
        ):
            buf.append(lines[i].strip())
            i += 1
        out.append(f"<p>{_inline_md(' '.join(buf))}</p>")
    return "\n".join(out)


def _fit_badge(value: str) -> str:
    color = _BADGE_COLOR.get(value, "#6b7280")
    return f'<span class="badge" style="background:{color}">{_escape(value)}</span>'


def _topic_table(topics: list[dict]) -> str:
    rows = []
    for t in topics:
        links = " ".join(
            f'<a href="{_escape(CTM_APP_CALL_URL.format(id=cid))}" target="_blank" rel="noopener">{_escape(str(cid))}</a>'
            for cid in t.get("example_call_ids", [])[:5]
        )
        rows.append(
            "<tr>"
            f'<td><strong>{_escape(t.get("name", ""))}</strong></td>'
            f'<td>{_escape(t.get("description", ""))}</td>'
            f'<td class="count">{_escape(t.get("call_count", 0))}</td>'
            f'<td>{_fit_badge(t.get("voice_ai_suitability", ""))}</td>'
            f'<td>{_escape(t.get("rationale", ""))}</td>'
            f'<td class="calllinks">{links}</td>'
            "</tr>"
        )
    return (
        '<div class="table-wrap"><table class="table"><thead><tr>'
        "<th>Topic</th><th>Description</th><th>Calls</th><th>Voice AI fit</th>"
        "<th>Rationale</th><th>Example calls</th>"
        "</tr></thead><tbody>" + "".join(rows) + "</tbody></table></div>"
    )


def _call_table(call_rows: list[dict]) -> str:
    rows = []
    for c in call_rows:
        cid = c.get("id")
        link = (
            f'<a href="{_escape(CTM_APP_CALL_URL.format(id=cid))}" target="_blank" rel="noopener">{_escape(str(cid))}</a>'
            if cid is not None
            else ""
        )
        rows.append(
            "<tr>"
            f"<td>{link}</td>"
            f'<td class="small">{_escape(str(c.get("occurred_at", ""))[:19])}</td>'
            f'<td>{_escape(c.get("topic", ""))}</td>'
            f'<td>{_fit_badge(c.get("voice_ai_suitable", ""))}</td>'
            f'<td>{_escape(c.get("description", ""))}</td>'
            f'<td>{_escape(c.get("reasoning", ""))}</td>'
            "</tr>"
        )
    return (
        '<div class="table-wrap"><table class="table"><thead><tr>'
        "<th>Call</th><th>Date</th><th>Extracted topic</th><th>Fit</th>"
        "<th>What happened</th><th>Why</th>"
        "</tr></thead><tbody>" + "".join(rows) + "</tbody></table></div>"
    )


def _stat(n: Any, label: str) -> str:
    return f'<div class="stat"><div class="n">{_escape(n)}</div><div class="l">{_escape(label)}</div></div>'


def _open_in_browser(path: Path) -> None:
    """Best-effort open a file in the OS default browser. Never raises."""
    import subprocess

    try:
        url = path.resolve().as_uri()
        if sys.platform == "darwin":
            subprocess.Popen(["open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys.platform.startswith("win"):
            os.startfile(url)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        log.info("Opened %s in the default browser", path)
    except Exception as exc:  # noqa: BLE001 - opening the report is best-effort
        log.warning("Could not open the report in a browser: %s", exc)


def build_html(artifacts: dict, output_path: Path) -> None:
    """Render the full analysis report: topics, calls, current prompt, and recommendations."""
    account_id = artifacts.get("account_id")
    topics = artifacts.get("topics", []) or []
    call_rows = artifacts.get("call_rows", []) or []
    recommendations = artifacts.get("recommendations", []) or []
    rewrites = artifacts.get("rewrites", []) or []
    bots = artifacts.get("bots", []) or []
    generated = artifacts.get("generated_instructions") or ""
    call_count = artifacts.get("call_count", 0)
    high = sum(1 for t in topics if t.get("voice_ai_suitability") == "High")
    date = time.strftime("%Y-%m-%d %H:%M:%S")

    toc = ['<a href="#topics">Topic analysis</a>']
    if call_rows:
        toc.append('<a href="#calls">Call analysis</a>')
    if bots:
        toc.append('<a href="#current">Current agent prompt</a>')
    if recommendations:
        toc.append('<a href="#recommendations">Recommended updates</a>')
    if rewrites:
        toc.append('<a href="#rewrite">Suggested rewritten prompt</a>')
    if generated:
        toc.append('<a href="#generated">Generated instructions</a>')

    meta = f"Account {_escape(account_id)} &middot; Generated {_escape(date)} &middot; {_escape(call_count)} calls &middot; {len(topics)} topics"
    if bots:
        meta += f" &middot; {len(bots)} agent(s) reviewed"

    stats = '<div class="stats">' + _stat(call_count, "Calls analyzed") + _stat(len(topics), "Canonical topics")
    stats += _stat(high, "High AI fit")
    if recommendations:
        stats += _stat(len(recommendations), "Agents reviewed")
    stats += "</div>"

    parts: list[str] = []
    parts.append(
        '<div class="header" id="top"><h1>Voice AI Analysis</h1>'
        f'<div class="meta">{meta}</div></div>'
    )
    parts.append('<nav class="toc">' + " ".join(toc) + "</nav>")
    parts.append(stats)
    parts.append(
        '<section class="card" id="topics"><h2>Topic analysis</h2>'
        '<div class="sub">Canonical caller topics ranked by volume, with voice-AI suitability. '
        "Each topic links to example calls in CTM.</div>"
        + _topic_table(topics)
        + "</section>"
    )

    if call_rows:
        parts.append(
            '<section class="card" id="calls"><h2>Call analysis</h2>'
            f'<div class="sub">Per-call topic extraction across {len(call_rows)} transcribed calls.</div>'
            f"<details><summary>Show all {len(call_rows)} calls</summary>"
            + _call_table(call_rows)
            + "</details></section>"
        )

    if bots:
        blocks = []
        for b in bots:
            instructions = b.get("instructions", "")
            blocks.append(
                '<div class="botprompt">'
                f'<h3>{_escape(b.get("name") or b.get("id"))}</h3>'
                + _full_copy(instructions, "Copy current prompt")
                + f'<details><summary>View current instructions ({len(instructions)} chars)</summary>'
                '<div class="codeblock"><pre><code>' + _escape(instructions) + "</code></pre></div>"
                "</details></div>"
            )
        parts.append(
            '<section class="card" id="current"><h2>Current agent prompt</h2>'
            '<div class="sub">The live VoiceAI instructions the recommendations are compared against.</div>'
            + "".join(blocks)
            + "</section>"
        )

    if recommendations:
        blocks = []
        for r in recommendations:
            prefix = ""
            if len(recommendations) > 1:
                prefix = f'<h3>{_escape(r.get("name") or r.get("id"))}</h3>'
            blocks.append(
                '<div class="botrec">' + prefix + '<div class="md-body">'
                + markdown_to_html(r.get("markdown", ""), heading_offset=1)
                + "</div></div>"
            )
        parts.append(
            '<section class="card" id="recommendations"><h2>Recommended prompt updates</h2>'
            '<div class="sub">Paste-ready changes grounded in the call topics above. '
            "Use the Copy button on each prompt block.</div>"
            + "".join(blocks)
            + "</section>"
        )

    if rewrites:
        blocks = []
        for r in rewrites:
            prefix = ""
            if len(rewrites) > 1:
                prefix = f'<h3>{_escape(r.get("name") or r.get("id"))}</h3>'
            blocks.append(
                '<div class="botrewrite">' + prefix
                + _code_block(r.get("text", ""), "Copy rewritten prompt")
                + "</div>"
            )
        parts.append(
            '<section class="card" id="rewrite"><h2>Suggested rewritten prompt</h2>'
            '<div class="sub">A complete, self-contained rewrite of the current agent prompt that '
            "incorporates all of the recommended changes above. Paste it over the current "
            "instructions, or use it as a starting point.</div>"
            + "".join(blocks)
            + "</section>"
        )

    if generated:
        parts.append(
            '<section class="card" id="generated"><h2>Generated bot instructions (proposed full rewrite)</h2>'
            '<div class="sub">A complete configuration-ready document. Copy the whole thing or individual blocks.</div>'
            + _full_copy(generated, "Copy full document")
            + '<div class="md-body">'
            + markdown_to_html(generated, heading_offset=1)
            + "</div></section>"
        )

    parts.append(
        "<footer>Generated from CTM call transcripts via two-pass LLM analysis plus live agent "
        "prompt comparison. Review before sharing externally.</footer>"
    )

    html = (
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
        f"<title>Voice AI Analysis - Account {_escape(str(account_id))}</title>\n"
        "<link href=\"https://fonts.googleapis.com/css2?family=Work+Sans:wght@300;400;500;600;700&display=swap\" rel=\"stylesheet\">\n"
        "<style>" + _HTML_STYLE + "</style>\n</head>\n<body>\n"
        '<div class="container">' + "".join(parts) + "</div>\n"
        "<script>" + _HTML_SCRIPT + "</script>\n</body>\n</html>\n"
    )
    output_path.write_text(html, encoding="utf-8")
    log.info(
        "Wrote full report (%d topics, %d calls, %d recommendation agent(s)) to %s",
        len(topics),
        len(call_rows),
        len(recommendations),
        output_path,
    )


def main() -> None:
    _setup_logging()
    p = argparse.ArgumentParser(description="Render a Voice AI analysis report from an artifacts JSON file.")
    p.add_argument("--artifacts", required=True, metavar="JSON", help="Artifacts JSON written by the MCP server")
    p.add_argument("--out", required=True, metavar="HTML", help="Output HTML path")
    p.add_argument("--no-open", action="store_true", help="Do not open the report in a browser")
    args = p.parse_args()

    artifacts = json.loads(Path(args.artifacts).read_text(encoding="utf-8"))
    build_html(artifacts, Path(args.out))

    open_setting = os.environ.get("CTM_VOICEAI_OPEN_REPORT", "1").strip().lower()
    if not args.no_open and open_setting not in ("0", "false", "no", "off"):
        _open_in_browser(Path(args.out))


if __name__ == "__main__":
    main()

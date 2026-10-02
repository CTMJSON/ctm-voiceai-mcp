# CTM VoiceAI MCP

> **Custom development, not an official CallTrackingMetrics product.**
> Built and maintained by Jason Smith. For support, questions, or feedback,
> email **jason.smith@ctm.com**.

An MCP server (and Claude/Codex/pi skill) that reviews a CallTrackingMetrics
(CTM) account's **real call transcripts** against its **live VoiceAI agent
instructions** and produces prioritized, paste-ready prompt updates plus a fully
rewritten prompt, rendered as a self-contained HTML report.

Highlights:

- **No API keys at all.** Login is CTM OAuth2 (device flow), and the analysis is
  performed by your MCP assistant itself - there is no external LLM call and no
  model API key.
- **Data + renderer only.** The server authenticates with CTM, fetches the
  agents and the call transcripts, and renders the final report. Your assistant
  does the thinking.
- **Read-only.** It never changes a live agent. Recommendations are proposals for
  a human to review and apply.
- Works with any MCP-capable client: Claude Desktop, Claude Code, Codex, pi, or a
  local LLM agent.

## The flow

1. **Authenticate** with CTM via OAuth device flow (`ctm_voiceai_auth_login`).
2. **Get the VoiceAI agents and their instructions** (`ctm_voiceai_get_voice_bots`).
3. **Get the call activities and transcriptions** (`ctm_voiceai_get_calls`). A probe
   call reports `total_pages`, then the assistant **fans the pages out to parallel
   subagents** so large call volumes are analyzed concurrently instead of serially.
4. **The subagents compare** the transcripts against the instructions, call by call,
   and return compact per-call JSON.
5. **Your assistant merges the batches** and writes the recommendations, including a
   full rewrite.
6. **Write the report** (`ctm_voiceai_write_report`), which saves the files, renders
   the HTML report, and opens it in your browser.

## What the HTML report contains

1. **Topic analysis** - canonical caller topics ranked by volume, with a
   High/Medium/Low voice-AI suitability rating and example calls.
2. **Call analysis** - the per-call extraction behind those topics.
3. **Current agent prompt** - the live instructions being reviewed.
4. **Recommended prompt updates** - a Coverage Map plus prioritized,
   copy-paste-ready prompt snippets.
5. **Suggested rewritten prompt** - a complete, self-contained rewrite with a Copy
   button.

## Requirements

- **Node.js 20+**
- **Python 3.9+** (standard library only; used for HTML rendering)
- Any MCP-capable client

## Quick start

### 1. Get the code

```bash
git clone https://github.com/CTMJSON/ctm-voiceai-mcp.git
cd ctm-voiceai-mcp
npm install
```

### 2. Register it with your MCP client

**Claude Code** (one command):

```bash
claude mcp add ctmVoiceAI --scope user -- node "$(pwd)/src/index.js"
```

**Claude Desktop** - add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ctmVoiceAI": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/ctm-voiceai-mcp/src/index.js"]
    }
  }
}
```

**Codex** - add this to `~/.codex/config.toml`:

```toml
[mcp_servers.ctmVoiceAI]
command = "node"
args = ["/ABSOLUTE/PATH/TO/ctm-voiceai-mcp/src/index.js"]
```

**Other MCP clients** - use the same stdio command:
`node /ABSOLUTE/PATH/TO/ctm-voiceai-mcp/src/index.js`.

### 3. Run it

Ask your assistant:

> Review the VoiceAI agent for account **&lt;account id&gt;**: analyze the calls,
> compare them to the current agent prompt, recommend updates, and open the report.

The assistant walks the six steps above. It logs in to CTM if needed (you enter a
short code in the browser), pulls the agents and transcripts, does the analysis,
and finally writes and opens the HTML report.

## Tools

| Tool | Step | Purpose |
|------|------|---------|
| `ctm_voiceai_configured` | - | Config + login status (never reveals secrets) |
| `ctm_voiceai_auth_login` | 1 | Start or resume the device-flow login |
| `ctm_voiceai_auth_status` | 1 | Token state and expiry |
| `ctm_voiceai_auth_logout` | 1 | Delete stored tokens |
| `ctm_voiceai_auth_url` | 1 | Build a web-flow authorize URL |
| `ctm_voiceai_auth_exchange` | 1 | Exchange a web-flow code for tokens |
| `ctm_voiceai_get_voice_bots` | 2 | Get agents and their full current instructions |
| `ctm_voiceai_get_calls` | 3 | One page of answered calls with transcriptions |
| `ctm_voiceai_write_report` | 6 | Write files, render the HTML report, open it |
| `ctm_voiceai_run_status` | - | Read a prior report's metadata |
| `ctm_voiceai_list_runs` | - | List recent reports |

Authentication is per-user: the server ships with a shared, public CTM OAuth
client id (not a secret), but each user signs in with their own CTM login and only
sees accounts that login can access.

## Configuration (optional)

The defaults work out of the box. To change them, create
`~/.config/ctm-voiceai/config.env`:

```ini
# Optional tuning
CTM_VOICEAI_OPEN_REPORT=1        # 0 disables auto-opening the HTML report
CTM_VOICEAI_OUT_DIR=/custom/runs/dir
PYTHON_BIN=python3
```

Precedence: process environment, then `~/.config/ctm-voiceai/config.env`, then
any file named by `CTM_VOICEAI_ENV_FILE`. **Never commit** `config.env` or the
stored tokens.

## Output

Report runs are written to `~/.local/share/ctm-voiceai/runs/<account>-<timestamp>/`:

```
voiceai_topic_analysis.html     the full report (opens automatically)
recommended_prompt_updates.md   the recommendations as Markdown
suggested_prompt_rewrite.md     the full rewritten agent prompt
analysis_artifacts.json         the raw analysis passed to the renderer
voiceai_topic_analysis.csv      ranked topics
run.json / run.log              run metadata and renderer log
```

## Troubleshooting

- **"NO_AUTH"** - run `ctm_voiceai_auth_login` to sign in.
- **Login code expired** - device codes expire after about 25 minutes; just run
  `ctm_voiceai_auth_login` again for a new one.
- **Report did not open** - set `CTM_VOICEAI_OPEN_REPORT=1` (default) or open the
  `voiceai_topic_analysis.html` path returned by `ctm_voiceai_write_report`.
- **Thin analysis** - accounts with few transcribed calls produce thin results.
  Check the reported call count before drawing conclusions.

## Scope

Read-only against CTM (calls and voice-bot configuration). It never changes a live
agent. No data leaves your machine except the analysis you explicitly write into
the report - there is no external LLM call.

## Support and feedback

This is a custom development, not an official CallTrackingMetrics product.
Questions, bugs, feature requests, and feedback are welcome:
**jason.smith@ctm.com**.
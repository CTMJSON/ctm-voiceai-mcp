# CTM VoiceAI MCP

> **Custom development, not an official CallTrackingMetrics product.**
> Built and maintained by Jason Smith. For support, questions, or feedback,
> email **jason.smith@ctm.com**.

An MCP server (and Claude/Codex/pi skill) that reviews a CallTrackingMetrics
(CTM) account's **real call transcripts**, finds the caller topics a VoiceAI
agent should handle, compares them against the account's **current live VoiceAI
agent prompt**, and writes prioritized, paste-ready **recommended prompt
updates** - all in one HTML report.

Highlights:

- **No API key.** Login is CTM OAuth2 (device flow). You sign in with your own
  CTM credentials, and you only see the accounts your login can access.
- **No OpenAI key needed.** The analysis runs on the model your MCP client is
  already using, via MCP sampling.
- Works with any MCP-capable client: Claude Desktop, Claude Code, Codex, pi, or
  a local LLM agent.
- **Read-only.** It never changes a live agent. Recommendations are proposals
  for a human to review and apply.

## What it produces

For a given CTM account id, one run produces:

1. **Topic analysis** - the recurring caller topics, ranked by volume, each with
   a High/Medium/Low voice-AI suitability rating and example calls.
2. **Call analysis** - the per-call topic extraction behind those topics.
3. **Recommended prompt updates** - a Coverage Map of what the current agent
   prompt handles well, partially, or not at all, plus prioritized,
   copy-paste-ready prompt snippets.

Everything lands in a single self-contained HTML report that opens in your
browser automatically when the run finishes.

## Requirements

- **Node.js 20+**
- **Python 3.9+** with the `requests` package
  (`python3 -m pip install requests`)
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

### 3. Log in to CTM (once)

In your client, ask it to run the `ctm_voiceai_auth_login` tool. It returns a
short **code** and a **URL**:

1. Open <https://app.calltrackingmetrics.com/accesscode>.
2. Enter the code.
3. Run `ctm_voiceai_auth_login` again (or wait) to finish.

That is it. The server ships with a shared, public CTM OAuth **client id** (not
a secret), so every user uses the same app. Authentication is still per-user:
you must sign in with a valid CTM login, and you only get access to the accounts
that login can see.

### 4. Run an analysis

Ask your client something like:

> Analyze the VoiceAI instructions and calls for account **&lt;account id&gt;**
> and recommend updates.

The agent calls `ctm_voiceai_analyze`, which fetches the calls, builds the
topics, compares them to the live agent prompt, and returns the results inline.
The full HTML report opens in your browser when the run completes.

## Tools

| Tool | Purpose |
|------|---------|
| `ctm_voiceai_configured` | Config + login status (never reveals secrets) |
| `ctm_voiceai_auth_login` | Start or resume the device-flow login |
| `ctm_voiceai_auth_status` | Token state and expiry |
| `ctm_voiceai_auth_logout` | Delete stored tokens |
| `ctm_voiceai_auth_url` | Build a web-flow authorize URL |
| `ctm_voiceai_auth_exchange` | Exchange a web-flow code for tokens |
| `ctm_voiceai_list_voice_bots` | List VoiceAI agents on an account |
| `ctm_voiceai_get_voice_bot` | Fetch one agent's full current prompt |
| `ctm_voiceai_analyze` | **Start here.** Analyze calls, then review the prompt |
| `ctm_voiceai_recommend_updates` | Re-run the prompt review from a prior `analyze` run |
| `ctm_voiceai_run_status` | Poll a running job |
| `ctm_voiceai_list_runs` | List recent runs |

`ctm_voiceai_analyze` waits for completion by default and returns the topics and
the full recommendations **inline**, so a single call gives your agent everything
to present in one reply. For very long runs, pass `wait: false` and poll
`ctm_voiceai_run_status`.

Prompt feedback is always grounded in the call analysis: `ctm_voiceai_analyze`
analyzes the calls first and its output leads with the call-topic Coverage Map.
`ctm_voiceai_recommend_updates` is only a cheap re-run shortcut and requires a
`run_id` from a completed `analyze` run.

## Configuration (optional)

The defaults work out of the box. To change them, create
`~/.config/ctm-voiceai/config.env`:

```ini
# Force a specific LLM backend: auto (default) | sampling | openai
CTM_VOICEAI_LLM=auto

# Optional: only needed if your MCP client does NOT support MCP sampling
# OPENAI_API_KEY=sk-...

# Optional tuning
CTM_VOICEAI_MODEL=gpt-5.4-mini
CTM_VOICEAI_OPEN_REPORT=1        # 0 disables auto-opening the HTML report
CTM_VOICEAI_OUT_DIR=/custom/runs/dir
PYTHON_BIN=python3
```

Precedence: process environment, then `~/.config/ctm-voiceai/config.env`, then
any file named by `CTM_VOICEAI_ENV_FILE`. **Never commit** `config.env` or the
stored tokens.

### Which model runs the analysis

An MCP server is a separate process and cannot directly call your client's model,
so it uses **MCP sampling**: when your client supports it, the server asks the
client to run each completion. `auto` (the default) uses sampling when available
and falls back to OpenAI only if you set `OPENAI_API_KEY`. Use `sampling` to
require the host model, or `openai` to force the OpenAI API.

## Output

Runs are written to `~/.local/share/ctm-voiceai/runs/<account>-<timestamp>/`:

```
voiceai_topic_analysis.html     the full report (opens automatically)
recommended_prompt_updates.md   the recommendations as Markdown
voiceai_topic_analysis.csv      ranked topics
pass2_cache.json                canonical topics (re-run input)
voice_bots.json                 captured current agent prompts
pass1_cache.json                per-call topic extractions
run.json / run.log              job state and engine log
```

## Troubleshooting

- **"No LLM available"** - your client does not support MCP sampling and no
  `OPENAI_API_KEY` is set. Add a key, or use a sampling-capable client.
- **"NO_AUTH" from a bot tool** - run `ctm_voiceai_auth_login` first.
- **Login code expired** - device codes expire after about 25 minutes; just run
  `ctm_voiceai_auth_login` again for a new one.
- **Thin analysis** - accounts with few transcribed calls produce thin results.
  Check the reported call count before drawing conclusions.
- **Want a fresh comparison after editing a prompt?** Use
  `ctm_voiceai_recommend_updates` with the `run_id` of the prior `analyze` run;
  it reuses the cached call topics and captured prompt.

## Scope

Read-only against CTM (calls and voice-bot configuration). It never changes a
live agent. All analysis happens locally; only the call topics and the current
agent instructions are sent to the model.

## Support and feedback

This is a custom development, not an official CallTrackingMetrics product.
Questions, bugs, feature requests, and feedback are welcome:
**jason.smith@ctm.com**.
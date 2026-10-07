# CTM VoiceAI MCP

> **Custom development, not an official CallTrackingMetrics product.**
> Built and maintained by Jason Smith. For support, questions, or feedback,
> email **jason.smith@ctm.com**.

An MCP server (and Claude/Codex/pi skill) that reviews a CallTrackingMetrics
(CTM) account's **real call transcripts** against its **live VoiceAI agent
instructions** and produces prioritized, paste-ready prompt updates plus a fully
rewritten prompt, rendered as a self-contained HTML report.

Highlights:

- **No API keys at all.** Login is CTM OAuth2 authorization code with S256 PKCE, and the analysis is
  performed by your MCP assistant itself - there is no external LLM call and no
  model API key.
- **Data + renderer only.** The server authenticates with CTM, fetches the
  agents and the call transcripts, and renders the final report. Your assistant
  does the thinking.
- **Read-only.** It never changes a live agent. Recommendations are proposals for
  a human to review and apply.
- **PII-scrubbed output.** Before anything is written or rendered, the server
  redacts emails, phone numbers, and detected caller/person names (2-3 word proper
  names) in the analysis prose, while preserving Markdown structure and the
  customer's own agent prompt.
- Works with any MCP-capable client: Claude Desktop, Claude Code, Codex, pi, or a
  local LLM agent.

## Local CTM CLI login mode

Set `CTM_VOICEAI_AUTH_MODE=cli` to use your `ctm auth login` GraphQL session with the local stdio server. This mode verifies the returned account ID and uses sequential cursor pagination for transcripts. See [local CLI setup](docs/LOCAL-CLI.md). It has no Basic-auth fallback and does not change the hosted server.

## Hosted template (Stage 2)

For multi-user Streamable HTTP, see [the hosted setup and engineering handoff](docs/HOSTED.md).
It includes a free local Keycloak + PostgreSQL + Node container setup, verified JWT callers,
per-user encrypted CTM OAuth grants, private reports, and cross-user isolation tests.
Hosted authentication happens in a browser connection page, with no auth tools or local Python/file output.
The Compose configuration is for local development; production deployment requires engineering configuration.

The remainder of this README describes the existing **local stdio** mode.

## The flow

1. **Authenticate** with CTM via OAuth PKCE (`ctm_voiceai_auth_login`).
2. **Get the VoiceAI agents and their instructions** (`ctm_voiceai_get_voice_bots`).
3. **Get the call activities and transcriptions** (`ctm_voiceai_get_calls`). The
   response includes a `plan` sized to a **default target of 500 calls** (set
   `target_calls` to override, `0` for all), and the assistant **dispatches one
   parallel subagent per batch** so large call volumes are analyzed concurrently
   instead of serially.
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
npm ci
npm run typecheck
npm test
```

### 2. Configure a public OAuth client

Ask your CTM administrator/engineering team to provision or confirm a **public**
OAuth client that supports authorization-code + S256 PKCE, refresh tokens, and
these scopes: `profile activity reports`. Register this exact callback:

```text
http://127.0.0.1:8765/oauth/callback
```

Create `~/.config/ctm-voiceai/config.env`:

```ini
CTM_OAUTH_CLIENT_ID=<your-public-client-id>
CTM_OAUTH_REDIRECT_URI=http://127.0.0.1:8765/oauth/callback
CTM_OAUTH_SCOPE=profile activity reports
```

The client ID is public; no client secret belongs in this local application.
There is no bundled client ID and no Basic-auth or ambient bearer-token fallback.
The former device-flow client is not assumed to be a public PKCE client.

### 3. Register it with your MCP client

**Claude Code** (one command):

```bash
claude mcp add ctmVoiceAI --scope user -- node "$(pwd)/dist/index.js"
```

**Claude Desktop** - add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ctmVoiceAI": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/ctm-voiceai-mcp/dist/index.js"]
    }
  }
}
```

**Codex** - add this to `~/.codex/config.toml`:

```toml
[mcp_servers.ctmVoiceAI]
command = "node"
args = ["/ABSOLUTE/PATH/TO/ctm-voiceai-mcp/dist/index.js"]
```

**Other MCP clients** - use the same stdio command:
`node /ABSOLUTE/PATH/TO/ctm-voiceai-mcp/dist/index.js`.

### 4. Run it

Ask your assistant:

> Review the VoiceAI agent for account **&lt;account id&gt;**: analyze the calls,
> compare them to the current agent prompt, recommend updates, and open the report.

The assistant starts `ctm_voiceai_auth_login`. Approve access in your browser;
the loopback callback completes sign-in without sending an authorization code
through the assistant. Check `ctm_voiceai_auth_status`, then run the review.

For a headless/manual flow, `ctm_voiceai_auth_url` creates a pending PKCE login
using the configured redirect URI. Pass the **full callback URL**, including
`code` and `state`, to `ctm_voiceai_auth_exchange` as `callback_url`. The verifier
stays local. Prefer the automatic loopback flow when available.

## Tools

| Tool | Step | Purpose |
|------|------|---------|
| `ctm_voiceai_configured` | - | Config + login status (never reveals secrets) |
| `ctm_voiceai_auth_login` | 1 | Start browser sign-in with a loopback PKCE callback |
| `ctm_voiceai_auth_status` | 1 | Token state and expiry |
| `ctm_voiceai_auth_logout` | 1 | Delete local tokens and pending login (not server-side revocation) |
| `ctm_voiceai_auth_url` | 1 | Start a manual PKCE login |
| `ctm_voiceai_auth_exchange` | 1 | Validate a complete callback URL and exchange with PKCE |
| `ctm_voiceai_get_voice_bots` | 2 | Get agents and their full current instructions |
| `ctm_voiceai_get_calls` | 3 | One page of answered calls with transcriptions |
| `ctm_voiceai_write_report` | 6 | Write files, render the HTML report, open it |
| `ctm_voiceai_run_status` | - | Read a prior report's metadata |
| `ctm_voiceai_list_runs` | - | List recent reports |

Authentication uses the local user's CTM login and its CTM account permissions.
This is still a local stdio server, not a hosted multi-user service. Each OS user
has a private token store. Local processes sharing a config directory serialize
token refresh and login mutations with `auth.lock`. They share one CTM identity;
use separate `XDG_CONFIG_HOME` directories for independent identities.

## Additional configuration

After configuring the public OAuth client above, optional settings go in
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
- **Refresh outcome unknown** - a timeout or invalid refresh response clears local
  credentials to avoid replaying a potentially rotated refresh token. Sign in again.
- **Login expired** - pending PKCE logins expire after 10 minutes. Start login again.
- **OAUTH_CONFIG** - configure a public client and registered redirect URI.
- **FORBIDDEN** - the CTM user lacks access to the requested account/operation;
  signing in again with the same permissions will not fix it.
- **OAUTH_BUSY** - another process is updating authentication. Retry later.
  After a crash, stop all instances using that config directory before deleting
  its `auth.lock` directory. Do not remove a live process's lock.
- **Callback port busy** - close the other listener or configure another registered
  loopback port. Keep the client running while approving the login.
- **Report did not open** - set `CTM_VOICEAI_OPEN_REPORT=1` (default) or open the
  `voiceai_topic_analysis.html` path returned by `ctm_voiceai_write_report`.
- **Thin analysis** - accounts with few transcribed calls produce thin results.
  Check the reported call count before drawing conclusions.

## Scope

Read-only against CTM (calls and voice-bot configuration). It never changes a live
agent. The server makes no direct external LLM call. It returns transcripts and agent
instructions to your MCP client, which may send them to its configured model
provider. Report redaction happens after analysis and is heuristic; it is not a
guarantee that sensitive data has been removed.

## Support and feedback

This is a custom development, not an official CallTrackingMetrics product.
Questions, bugs, feature requests, and feedback are welcome:
**jason.smith@ctm.com**.

## Upgrading from 0.1.0

- Source is now strict TypeScript; `npm ci` builds `dist/` through the prepare
  script. Update existing MCP registrations from `src/index.js` to `dist/index.js`.
- Remove legacy Basic-auth settings. They are ignored and never used.
- Configure a public PKCE client and sign in again. Legacy device-flow token
  files are not reused. Starting a new login clears the previous local token.
- `auth_login` no longer returns a device code. `auth_url` uses configured
  settings and generates state; `auth_exchange` now requires `callback_url`
  instead of a bare code and redirect URI.
- Auth tools remain available for this local stage. Streamable HTTP, hosted
  identity, and remote report storage are a separate migration.

## Development and validation

`npm run typecheck` checks strict TypeScript. `npm test` builds and runs mocked
OAuth/API tests, local callback integration, stdio smoke tests, sanitizer checks,
and the Python HTML rendering test. Tests use temporary config directories and
never require real credentials.

Before customer use, validate the configured public client, registered redirect,
consent scopes, token refresh, and an account-scoped read against the intended CTM
deployment. Mocked tests do not establish live OAuth compatibility.

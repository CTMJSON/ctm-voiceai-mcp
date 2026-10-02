---
name: ctm-voiceai-prompt-review
description: Analyze a CallTrackingMetrics (CTM) account's real phone call transcripts, compare them against the account's live VoiceAI agent instructions, and produce prioritized, paste-ready prompt updates plus a fully rewritten prompt and a self-contained HTML report. Uses CTM OAuth2 login. The assistant performs the analysis itself, so no external LLM or API key is used. Use when asked to review, QA, or improve a CTM VoiceAI agent or bot prompt.
license: Custom development - contact jason.smith@ctm.com for support
compatibility: Requires the ctmVoiceAI MCP server (this project) and Python 3.9+ for the HTML renderer. Login uses CTM OAuth2 (device flow) so no CTM API key is required. No model API key is used; the assistant does the analysis.
---

# CTM VoiceAI Prompt Review

Reviews an account's **actual transcribed calls** against its **live VoiceAI agent
instructions**, then writes recommendations and a full rewritten prompt into a
self-contained HTML report.

The MCP server only moves data: it authenticates with CTM, fetches the agents and
the call transcripts, and renders the final report. **You (the assistant) do the
analysis.** There is no external LLM call.

## The flow

Follow these steps in order.

### 1. Authenticate with CTM (OAuth)

Check first with `ctm_voiceai_auth_status`. If not logged in, run
`ctm_voiceai_auth_login`. It returns a `user_code` and `verification_uri`; tell
the user to open <https://app.calltrackingmetrics.com/accesscode> and enter the
code, then call `ctm_voiceai_auth_login` again (or pass `wait_seconds`) to finish.
Tokens are stored and refreshed automatically.

### 2. Get the VoiceAI agents and their instructions

`ctm_voiceai_get_voice_bots(account_id="<id>")` returns every agent that has
instructions, with the full current prompt text. Optionally pass `voice_bot` (id
or name substring) to focus on one agent.

### 3. Plan the call batches

First make one probe call: `ctm_voiceai_get_calls(account_id="<id>", page=1, per_page=25, direction="inbound")`.
It returns `total`, `total_pages`, `has_more`, and the first page of calls.

### 4. Dispatch parallel subagents to assess the calls (default)

**By default, fan the work out to multiple subagents in parallel.** Do not analyze
every call yourself in one long serial pass. Use the host's subagent/Task tool to
launch one subagent per page (or per two pages when `total_pages` is small), all in
a single message so they run concurrently.

Suggested sizing:

- One subagent per page of 25 calls.
- Cap concurrency at about 5-6 subagents per wave; if `total_pages` is larger,
  dispatch in waves until every page is covered.
- If `total_pages` is 1-2, a single subagent (or doing it inline) is fine.

Give **every subagent the same shared context**, then let each analyze its own page:

- the account id
- the reviewed agent's name and **full current instructions, verbatim**
- its assigned page number(s) and `per_page`
- the exact JSON shape to return

Instruct each subagent to:

1. Call `ctm_voiceai_get_calls` for its assigned page(s).
2. For each call, extract `id`, `occurred_at`, `topic` (short label),
   `description` (one line on the caller's need), `voice_ai_suitable` (`yes`,
   `partial`, or `no`), and `reasoning` (why: scriptable, needs an integration,
   needs a human).
3. Compare each call against the current instructions: already covered well,
   partially covered, or not covered.
4. Return **only compact JSON**, no prose:

   ```json
   {
     "page": 1,
     "calls": [
       {"id": 0, "occurred_at": "", "topic": "", "description": "", "voice_ai_suitable": "yes", "reasoning": "", "covered": "good|partial|none"}
     ],
     "topics": [{"name": "", "call_count": 0, "voice_ai_suitability": "High|Medium|Low", "rationale": ""}],
     "notes": "anything notable across this batch"
   }
   ```

Subagents must report from the transcripts only. They must not invent
capabilities, integrations, or caller needs, and must not use em dashes.

If subagents cannot reach the MCP server, fall back: fetch each page yourself and
pass the transcripts to the subagent inline in the Task prompt. Parallel dispatch
is still the goal.

### 5. Merge and make recommendations

Collect the per-page JSON from every subagent and merge:

- De-duplicate near-identical topics and sum their `call_count`.
- Rank canonical topics by call volume.
- Build the per-call rows from the union of the subagents' `calls`.

Then write:
- **Recommended Prompt Updates** Markdown per agent, with these sections:
  - `# Recommended Prompt Updates` (one short intro paragraph)
  - `## Coverage Map` - a table: Observed topic | Calls | Voice AI fit | Current
    coverage (Good/Partial/None) | Gap. Cover every topic.
  - `## Priority Changes` - highest-impact updates by call volume. For each: a bold
    heading, the topics and call counts, why it matters, and a fenced code block of
    PASTE-READY prompt text in the same voice as the current instructions.
  - `## Secondary Changes` - lower-volume topics, shorter.
  - `## What To Preserve` - mechanics in the current prompt that must not regress.
  - `## Integration Dependencies` - flag anything that only works with live
    calendar/dispatch/order/CRM access, and the capture-and-confirm fallback.
- **A suggested fully rewritten prompt**: one complete, self-contained rewrite of
  the agent's instructions that folds in every change and can be pasted as-is.

Ground everything in the observed topics. Do not invent capabilities,
integrations, or caller needs. Do not use em dashes.

### 6. Write the report and open it

`ctm_voiceai_write_report(...)` writes the files, renders the HTML report, and
opens it in the browser. Pass:

- `account_id`
- `call_context: { call_count }` (the number of calls analyzed)
- `topics` (the canonical topic list)
- `call_rows` (optional per-call extractions: `id`, `occurred_at`, `topic`,
  `voice_ai_suitable`, `description`, `reasoning`)
- `bots` (the reviewed agents with their current `instructions`)
- `recommendations` (`[{ id, name, markdown }]`)
- `rewrites` (`[{ id, name, text }]`)

It returns `run_dir` and the written `files` (HTML, recommendations Markdown,
rewrite Markdown, artifacts JSON, CSV).

## Notes

- Reads are safe and read-only. It never changes a live agent.
- Redact names, phone numbers, emails, and account numbers from anything you
  write into the report.
- Accounts with few transcribed calls produce thin analyses. Report the call
  count so the user can judge the sample.
- If a user asks to "analyze the instructions and calls", run the whole flow
  end to end and present the call topics first, then the recommendations, then
  the rewritten prompt.

See [README.md](README.md) for installation and configuration.
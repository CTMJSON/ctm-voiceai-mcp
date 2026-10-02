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

### 3. Get the call activities and transcriptions

`ctm_voiceai_get_calls(account_id="<id>", page=1, per_page=25, direction="inbound")`
performs one GET and returns a page of answered calls with transcriptions
(`id`, `occurred_at`, `summary`, `transcript`). It also returns `has_more` and
`next_page`.

Page through the calls until `has_more` is false. Keep `per_page` small enough
that the transcripts fit comfortably in context (25-40 is a good range).

### 4. Compare the transcripts against the instructions

Process one page at a time. For each call, extract:

- **topic**: a short label for what the caller wanted.
- **description**: one line on the caller's need.
- **voice_ai_suitable**: `yes`, `partial`, or `no`.
- **reasoning**: why (scriptable, needs an integration, needs a human, etc.).

Then compare that against the agent instructions: which topics are already
covered well, partially, or not at all.

### 5. Assess and make recommendations

Accumulate the per-call extractions across all pages, then synthesize:

- **Canonical topics** ranked by call volume, merging near-duplicates, each with
  `name`, `description`, `call_count`, `voice_ai_suitability` (`High`/`Medium`/`Low`),
  `rationale`, and up to 5 `example_call_ids`.
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
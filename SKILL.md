---
name: ctm-voiceai-prompt-review
description: Analyze a CallTrackingMetrics (CTM) account's real phone call transcripts to find the caller topics a VoiceAI agent should handle, then compare those topics against the account's current live VoiceAI agent instructions and produce a prioritized, paste-ready list of recommended prompt updates. Use when asked to review, QA, or improve a CTM VoiceAI agent or bot prompt, to find what a voice AI should handle, or to decide whether a bot's prompt matches the customer's actual call mix.
license: Custom development - contact jason.smith@ctm.com for support
compatibility: Requires the ctmVoiceAI MCP server (this project) and the Python engine it bundles (Python 3.9+, `requests`). Analysis runs on the host model via MCP sampling. Login uses CTM OAuth2 (device flow) so no CTM API key is required.
---

# CTM VoiceAI Prompt Review

Analyzes an account's **actual transcribed calls**, clusters them into canonical
caller topics with a voice-AI suitability rating, fetches the account's **current
live VoiceAI agent instructions**, and writes **Recommended Prompt Updates** that
map observed topics to concrete prompt changes.

This runs through the `ctmVoiceAI` MCP server. All work happens locally; only the
call topics and the current agent instructions are sent to the LLM for analysis.

## Rule: call analysis first, always

Prompt feedback MUST be grounded in the account's call topics. Follow this order
and do not skip or reorder it:

1. **Run `ctm_voiceai_analyze` first** for the account. It verifies the CTM login,
   fetches and analyzes the calls, builds canonical topics, and only then compares
   them to the agent prompt.
2. **Wait for it to complete** (`ctm_voiceai_run_status` until `complete`), then
   read `recommended_prompt_updates.md`.
3. **Present the call topics / coverage map before any prompt recommendations.**
   The deliverable already starts with a Coverage Map; keep that order in your reply.

Do NOT give prompt feedback from `ctm_voiceai_get_voice_bot` or
`ctm_voiceai_list_voice_bots` alone, and do NOT call `ctm_voiceai_recommend_updates`
for a first review. That tool only re-runs the comparison against call topics from a
prior `ctm_voiceai_analyze` run and will error without one.

If a user asks to "analyze the instructions and calls", the single correct action is
`ctm_voiceai_analyze`. Do not analyze the prompt separately first.

## Auth: OAuth2 device flow (no API key)

Tokens are stored at `~/.config/ctm-voiceai/tokens.json` and refreshed automatically.
Do this once per session if not already logged in:

1. `ctm_voiceai_auth_status` - check first.
2. `ctm_voiceai_auth_login` - returns a `user_code` and `verification_uri`.
   Tell the user to open `https://app.calltrackingmetrics.com/accesscode` and
   enter the code, then call `ctm_voiceai_auth_login` again (or pass
   `wait_seconds`) to finish. This is the OAuth app, not an API key.
3. `ctm_voiceai_configured` - confirms login, sampling support, and paths.

There is also a web flow: `ctm_voiceai_auth_url` builds the authorize URL, and
`ctm_voiceai_auth_exchange` swaps the returned `?code=` for tokens.

If OAuth is not set up yet, the server also honors `CTM_BASIC_AUTH` as a fallback.

## Which model runs the analysis

By default the analysis passes run on **the model this MCP client is using**, via
MCP sampling: the server asks the client to run each completion. No API key is
needed. `ctm_voiceai_configured` reports `sampling_supported`.

The client must support MCP sampling. If it does not, the analysis tools return a
clear error; there is no separate model or API key to configure. Each extraction
batch is one host-model request, so the client may ask to approve them. Batches
default to 100 calls (aligned with the CTM page size) and are additionally
bounded by total transcript size so they never overflow the model context; raise
`batch_size` on `ctm_voiceai_analyze` to send even fewer, larger requests.

## Typical run

```
ctm_voiceai_analyze(account_id="<account_id>")
```

One call does everything and (by default) waits for completion. The result contains
`call_context`, the `topics` list, `recommendations_markdown`, and
`suggested_rewrite_markdown`. **Present all of it in a single reply** - the call
topics / coverage first, then the recommended updates, finishing with the
suggested rewritten prompt. Do not just return file paths, do not ask "would you
like me to show the recommendations?", and do not make the user open the files.
The HTML/CSV paths are available if they want them, but the answer should be in
your message.

If a run is started with `wait: false`, poll `ctm_voiceai_run_status`; the final
poll also returns the topics and `recommendations_markdown`.

### Re-running after a prompt edit

When the agent prompt changes and you want a fresh comparison against the **same**
call analysis, pass the prior run's `run_id` (it reuses that run's cached call
topics and captured prompt). The result contains the recommendations inline.

```
ctm_voiceai_recommend_updates(run_id="<run_id from a prior analyze>")
```

## Outputs

A run writes to `~/.local/share/ctm-voiceai/runs/<account>-<timestamp>/`:

| File | What it is |
|------|------------|
| `recommended_prompt_updates.md` | The deliverable: coverage map + prioritized updates |
| `suggested_prompt_rewrite.md` | A complete, paste-ready rewrite of the current agent prompt |
| `voiceai_topic_analysis.html` | The full self-contained report: topic analysis, per-call analysis, current agent prompt, paste-ready recommended updates, and a suggested fully rewritten prompt with Copy buttons. This is the artifact to hand the customer. It opens automatically in the browser when the run finishes (disable with `CTM_VOICEAI_OPEN_REPORT=0`). |
| `voiceai_topic_analysis.csv` | Canonical topics, call counts, suitabilities |
| `pass2_cache.json` | Canonical topics (input to re-runs) |
| `voice_bots.json` | The current agent instructions captured from CTM |
| `pass1_cache.json` | Per-call topic extractions |
| `voiceai_bot_instructions.md` | Optional brand-new instructions (only if not skipped) |
```

## Inspecting agents

- `ctm_voiceai_list_voice_bots(account_id="<account_id>")` - names, ids, instruction sizes.
- `ctm_voiceai_get_voice_bot(account_id="<account_id>", name="<agent name>")` - read a prompt.

These are for orientation only. Reading a prompt is NOT a review; always run
`ctm_voiceai_analyze` before giving any feedback on an agent's instructions.
Accounts usually have one bot; agency accounts can have many, so `voice_bot` on the
analysis tools selects by id or name substring and defaults to all agents with prompts.

## Reading the results

- **Suitability** is `High` / `Medium` / `Low`. `High` means the observed calls are
  simple and scriptable; `Medium` means a bot can triage but a human must finish;
  `Low` means human judgement is needed (complaints, disputes, account work).
- **Coverage** in the recommendations table is `Good` / `Partial` / `None` against
  the current prompt. Lead with the largest `None`/`Partial` gaps.
- Recommendations include paste-ready prompt snippets. They are proposals; present
  them for human review before anyone pastes them into a live agent.
- Treat `Integration Dependencies` as a warning: topics rated High (booking, status,
  order changes) are only High if the bot has live calendar/order/dispatch access.
  Without it, the prompt must capture-and-confirm and let the team finalise.

## Scope boundary (be honest)

- Uses **transcripts CTM has transcribed**. If an account has few transcribed calls,
  say so rather than over-reading the sample.
- Skips generating brand-new bot instructions by default; the goal is reviewing the
  existing agent. Pass `skip_bot_instructions=false` to also draft fresh instructions.
- The analysis model is whatever the MCP client provides (via MCP sampling). The
  skill itself can be driven by any MCP-capable agent that supports sampling.

See [README.md](README.md) for installation, registration, and configuration.
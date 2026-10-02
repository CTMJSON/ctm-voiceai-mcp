#!/usr/bin/env python3
"""
ctm_voiceai_topic_analysis.py

Pull recent CTM call activity for an account, chunk the transcripts into
batches, and use an LLM in two passes to identify recurring caller topics
that a voice AI agent could plausibly handle end-to-end.

Pass 1 (per batch): extract a short topic label + one-line description +
a voice-AI suitability signal for each transcribed call.

Pass 2 (synthesis): cluster the per-call topics gathered across every batch
into a ranked list of canonical topics, each with call volume, an example
call, and a High/Medium/Low voice-AI suitability rating with rationale.

Outputs a self-contained HTML report plus a CSV of the ranked topics.

Usage:
    python3 ctm_voiceai_topic_analysis.py --account-id <your_account_id> --target 500

Credentials are read from ~/.config/ctm-voiceai/config.env (key:value per
line) unless overridden by CTM_BASIC_AUTH / CTM_BEARER_TOKEN env vars.

When CTM_BEARER_TOKEN is set in the environment (as the MCP server does after
an OAuth2 login), it takes precedence and requests are sent with
`Authorization: Bearer <token>` instead of basic auth.
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import requests

CTM_API_TEMPLATE = "https://api.calltrackingmetrics.com/api/v1/accounts/{account_id}/calls"
CTM_APP_CALL_URL = (
    "https://app.calltrackingmetrics.com/calls"
    "#callNav=caller_profile&callId={id}"
)
CTM_VOICEBOTS_TEMPLATE = "https://api.calltrackingmetrics.com/api/v1/accounts/{account_id}/voice_bots"

DEFAULT_ENV_FILE = Path(
    os.environ.get("CTM_VOICEAI_ENV_FILE")
    or (Path.home() / ".config" / "ctm-voiceai" / "config.env")
)
DEFAULT_AUTH_KEY = "CTM_BASIC_AUTH"
DEFAULT_TARGET = 500
DEFAULT_PER_PAGE = 100
DEFAULT_BATCH_SIZE = 100
# Safety cap on the total transcript characters per LLM request. A batch stops
# growing at this size even if the call count has not been reached, so larger
# batches never overflow the host model's context window.
DEFAULT_MAX_BATCH_CHARS = 300000
DEFAULT_MAX_TRANSCRIPT_CHARS = 4000

EMAIL_RE = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")
PHONE_RE = re.compile(r"\+?\d[\d\-.\s()]{6,}\d")
NAME_STOPWORDS = frozenset(
    ["CTM", "CRM", "API", "AI", "IVR", "SMS", "MMS", "PSTN", "DID",
     "Salesforce", "Zoom", "RingCentral", "CallTrackingMetrics", "Medicaid",
     "UnitedHealthcare"]
)
PLACEHOLDER_NAMES = [
    "Jon Doe", "Jane Doe", "Alex Johnson", "Maria Garcia",
    "Chris Lee", "Taylor Brown", "Sam Patel", "Jordan Kim",
]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Credential loading
# ---------------------------------------------------------------------------


def load_env_file(env_path: Path) -> dict[str, str]:
    if not env_path.exists():
        return {}
    data: dict[str, str] = {}
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, val = line.partition(":")
        data[key.strip()] = val.strip().strip('"').strip("'")
    return data


def get_ctm_auth(env: dict[str, str], auth_key: str) -> str:
    if bearer := os.environ.get("CTM_BEARER_TOKEN"):
        return f"Bearer {bearer.strip()}"
    if explicit := os.environ.get("CTM_BASIC_AUTH"):
        return explicit if explicit.lower().startswith("basic ") else f"Basic {explicit}"
    token = env.get(auth_key)
    if not token:
        raise SystemExit(f"'{auth_key}' not found in env file and CTM_BASIC_AUTH not set.")
    return f"Basic {token}"


def require_llm() -> None:
    if not (os.environ.get("CTM_VOICEAI_LLM_BRIDGE") or _http_llm_configured()):
        raise SystemExit(
            "No LLM available. Either use an MCP client that supports MCP sampling, "
            "or configure an OpenAI-compatible endpoint with "
            "CTM_VOICEAI_LLM_BASE_URL and CTM_VOICEAI_LLM_MODEL (and "
            "CTM_VOICEAI_LLM_API_KEY if the endpoint needs one)."
        )


# ---------------------------------------------------------------------------
# LLM transport: MCP sampling bridge, or an OpenAI-compatible HTTP endpoint
# ---------------------------------------------------------------------------


def _bridge_url() -> str | None:
    return os.environ.get("CTM_VOICEAI_LLM_BRIDGE") or None


def _http_llm_configured() -> bool:
    return bool(os.environ.get("CTM_VOICEAI_LLM_BASE_URL") and os.environ.get("CTM_VOICEAI_LLM_MODEL"))


def complete_via_http(prompt: str, max_output_tokens: int, timeout: int = 600) -> str:
    """Run a completion against an OpenAI-compatible chat completions endpoint."""
    base = os.environ.get("CTM_VOICEAI_LLM_BASE_URL", "").rstrip("/")
    model = os.environ.get("CTM_VOICEAI_LLM_MODEL", "")
    api_key = os.environ.get("CTM_VOICEAI_LLM_API_KEY", "")
    url = base + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a precise call center analyst."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_output_tokens,
    }
    resp = None
    for attempt in range(4):
        try:
            resp = requests.post(url, headers=headers, json=body, timeout=timeout)
            break
        except requests.RequestException as exc:
            if attempt == 3:
                raise
            log.warning("LLM request failed (%s) - retrying", exc)
            time.sleep(2 ** attempt)
    if resp is None:
        raise SystemExit("LLM request failed with no response.")
    if resp.status_code >= 400:
        raise SystemExit(f"LLM API error {resp.status_code}: {resp.text[:800]}")
    data = resp.json()
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise SystemExit(f"LLM response had no message content: {json.dumps(data)[:800]}")
    if not content:
        raise SystemExit("LLM returned no text.")
    return content


def complete_via_llm(prompt: str, max_output_tokens: int, timeout: int = 600) -> str:
    """Use the sampling bridge when available, otherwise an OpenAI-compatible endpoint."""
    if _bridge_url():
        return complete_via_bridge(prompt, max_output_tokens, timeout)
    if _http_llm_configured():
        return complete_via_http(prompt, max_output_tokens, timeout)
    require_llm()
    raise SystemExit("No LLM available.")


def complete_via_bridge(prompt: str, max_output_tokens: int, timeout: int = 600) -> str:
    """Ask the MCP host (via its sampling bridge) to run this completion."""
    bridge = _bridge_url()
    token = os.environ.get("CTM_VOICEAI_LLM_BRIDGE_TOKEN", "")
    resp = requests.post(
        bridge.rstrip("/") + "/complete",
        headers={"X-Bridge-Token": token, "Content-Type": "application/json"},
        json={"prompt": prompt, "max_output_tokens": max_output_tokens},
        timeout=timeout,
    )
    if resp.status_code >= 400:
        raise SystemExit(f"LLM sampling bridge error {resp.status_code}: {resp.text[:800]}")
    text = resp.json().get("text", "")
    if not text:
        raise SystemExit("LLM sampling bridge returned no text.")
    return text


def parse_json_response(text: str) -> dict:
    """Parse JSON from a model reply, tolerating code fences and surrounding prose."""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z0-9_]*\s*", "", stripped)
        stripped = re.sub(r"```\s*$", "", stripped).strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        start, end = stripped.find("{"), stripped.rfind("}")
        if start != -1 and end > start:
            return json.loads(stripped[start : end + 1])
        raise


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------


def redact_text(text: str) -> str:
    if not text:
        return text
    text = EMAIL_RE.sub("[REDACTED_EMAIL]", text)
    text = PHONE_RE.sub("[REDACTED_PHONE]", text)
    return text


def _is_name_token(token: str) -> bool:
    if not token or token in NAME_STOPWORDS or token.isupper():
        return False
    return token[0].isupper() and token[1:].islower()


def sanitize_names(text: str) -> str:
    """Replace detected two- or three-word proper names with placeholder names."""
    if not text:
        return text
    mapping: dict[str, str] = {}
    counter = 0

    def replace_match(m: re.Match) -> str:
        nonlocal counter
        tokens = [t for t in m.groups() if t]
        if not all(_is_name_token(t) for t in tokens):
            return m.group(0)
        full = m.group(0)
        if full not in mapping:
            mapping[full] = PLACEHOLDER_NAMES[counter % len(PLACEHOLDER_NAMES)]
            counter += 1
        return mapping[full]

    pattern = re.compile(r"\b([A-Z][a-z]+)\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?\b")
    return pattern.sub(replace_match, text)


# ---------------------------------------------------------------------------
# CTM API: fetching calls
# ---------------------------------------------------------------------------


def _extract_transcript(raw: dict) -> str:
    for key in ("transcription_text", "transcription", "transcript", "transcript_text"):
        val = raw.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
        if isinstance(val, dict):
            for sub_key in ("text", "transcript", "full_text", "content"):
                sub = val.get(sub_key)
                if isinstance(sub, str) and sub.strip():
                    return sub.strip()
    segments = raw.get("transcription_segments")
    if isinstance(segments, list):
        parts = [seg.get("text") or seg.get("content", "") for seg in segments if isinstance(seg, dict)]
        joined = " ".join(p.strip() for p in parts if p.strip())
        if joined:
            return joined
    return ""


def _normalize_call(raw: dict) -> dict:
    return {
        "id": raw.get("id"),
        "occurred_at": raw.get("called_at") or raw.get("occurred_at") or raw.get("created_at") or raw.get("started_at"),
        "summary": raw.get("summary") or "",
        "transcript": _extract_transcript(raw),
    }


def fetch_calls(
    account_id: str,
    basic_auth: str,
    target: int,
    per_page: int,
    since: str | None,
    until: str | None,
    direction: str | None = None,
) -> list[dict]:
    session = requests.Session()
    session.headers.update({"Authorization": basic_auth, "Accept": "application/json"})

    url = CTM_API_TEMPLATE.format(account_id=account_id)
    params: dict | None = {
        "per_page": per_page,
        "has_transcription": 1,
        "call_status": "answered",
        "format": "json",
        "page": 1,
    }
    if direction:
        params["direction"] = direction
    if since:
        params["since"] = since
    if until:
        params["until"] = until

    collected: list[dict] = []
    page = 0
    while len(collected) < target:
        page += 1
        log.info("GET %s params=%s", url, params or "(embedded)")
        for attempt in range(4):
            try:
                resp = session.get(url, params=params, timeout=60)
                break
            except requests.RequestException as exc:
                if attempt == 3:
                    raise
                log.warning("Request failed (%s) — retrying", exc)
                time.sleep(2 ** attempt)

        if resp.status_code == 429:
            log.warning("Rate limited — sleeping 2s")
            time.sleep(2)
            continue
        if resp.status_code >= 400:
            raise SystemExit(f"CTM API error {resp.status_code}: {resp.text[:800]}")

        data = resp.json()
        page_calls = data.get("calls") if isinstance(data, dict) else None
        if not isinstance(page_calls, list):
            log.error("Could not find 'calls' list in response: %s", json.dumps(data, indent=2)[:800])
            break

        log.info("  -> %d calls on page %d (have %d/%d)", len(page_calls), page, len(collected), target)
        for raw_call in page_calls:
            if not isinstance(raw_call, dict):
                continue
            norm = _normalize_call(raw_call)
            if norm["transcript"]:
                collected.append(norm)
            if len(collected) >= target:
                break

        if len(collected) >= target:
            break

        next_page = data.get("next_page")
        if not next_page:
            log.info("No further pagination — stopping at %d calls.", len(collected))
            break
        url, params = next_page, None
        time.sleep(0.12)

    return collected[:target]


# ---------------------------------------------------------------------------
# CTM API: fetching VoiceAI agents
# ---------------------------------------------------------------------------


def _normalize_bot(raw: dict) -> dict:
    return {
        "id": raw.get("id"),
        "name": (raw.get("name") or "").strip(),
        "description": (raw.get("description") or "").strip(),
        "instructions": (raw.get("instructions") or "").strip(),
        "play_message": (raw.get("play_message") or "").strip(),
    }


def fetch_voice_bots(account_id: str, basic_auth: str, per_page: int = 100) -> list[dict]:
    """Fetch all VoiceAI agents for an account, following next_page pagination."""
    session = requests.Session()
    session.headers.update({"Authorization": basic_auth, "Accept": "application/json"})

    url = CTM_VOICEBOTS_TEMPLATE.format(account_id=account_id)
    params: dict | None = {"per_page": per_page, "page": 1}
    bots: list[dict] = []
    page = 0
    while url:
        page += 1
        log.info("GET %s", url)
        resp = None
        for attempt in range(4):
            try:
                resp = session.get(url, params=params, timeout=60)
                break
            except requests.RequestException as exc:
                if attempt == 3:
                    raise
                log.warning("Request failed (%s) - retrying", exc)
                time.sleep(2 ** attempt)

        if resp.status_code == 429:
            log.warning("Rate limited - sleeping 2s")
            time.sleep(2)
            continue
        if resp.status_code >= 400:
            raise SystemExit(f"CTM voice_bots API error {resp.status_code}: {resp.text[:800]}")

        data = resp.json()
        page_bots = data.get("voice_bots") if isinstance(data, dict) else None
        if not isinstance(page_bots, list):
            log.error("Could not find 'voice_bots' list in response: %s", json.dumps(data, indent=2)[:800])
            break
        for raw in page_bots:
            if isinstance(raw, dict):
                bots.append(_normalize_bot(raw))
        url = data.get("next_page")
        params = None
        if url:
            time.sleep(0.12)

    log.info("Fetched %d VoiceAI agent(s) from account %s", len(bots), account_id)
    return bots


def select_voice_bots(bots: list[dict], selectors: list[str] | None) -> list[dict]:
    """Select bots by exact id or case-insensitive name substring; default all with instructions."""
    if not selectors:
        return [b for b in bots if b.get("instructions")]

    chosen: list[dict] = []
    seen: set = set()
    for selector in selectors:
        needle = selector.strip().lower()
        matches = [
            b for b in bots
            if str(b.get("id", "")).lower() == needle or needle in (b.get("name") or "").lower()
        ]
        if not matches:
            available = ", ".join(f"{b.get('name') or '(unnamed)'} [{b.get('id')}]" for b in bots) or "none"
            raise SystemExit(f"No VoiceAI agent matched '{selector}'. Available: {available}")
        for b in matches:
            if b.get("id") not in seen:
                seen.add(b.get("id"))
                chosen.append(b)
    return chosen


# ---------------------------------------------------------------------------
# Pass 1: per-batch topic extraction
# ---------------------------------------------------------------------------

PASS1_PROMPT = """\
You are analyzing customer phone call transcripts for a company evaluating \
where a voice AI agent (an automated phone bot) could handle calls instead \
of a human.

You will receive a JSON array of calls, each with: id, occurred_at, summary, \
transcript.

For each call, identify:
- topic: a short (2-5 word) label for what the caller wanted, e.g. \
  "appointment scheduling", "billing dispute", "order status check", \
  "password reset". Use consistent, reusable labels across calls when the \
  underlying need is the same.
- description: one sentence describing what happened on this specific call.
- voice_ai_suitable: "yes" if a voice AI agent could plausibly handle this \
  entire interaction without human escalation (simple, scriptable, \
  transactional, doesn't require judgment/empathy/complex troubleshooting); \
  "partial" if a voice AI could handle part of it (e.g. intake/triage) but \
  would need to hand off; "no" if it requires human judgment, complex \
  problem-solving, sensitive/emotional handling, or highly custom account \
  work.
- reasoning: one short phrase for why (e.g. "simple scheduling lookup" or \
  "requires escalation to billing specialist").

Skip calls that are pure noise (dead air, wrong number, no discernible \
purpose) by omitting them from the output.

Return JSON matching the provided schema exactly.
"""

_PASS1_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "topic": {"type": "string"},
                    "description": {"type": "string"},
                    "voice_ai_suitable": {"type": "string", "enum": ["yes", "partial", "no"]},
                    "reasoning": {"type": "string"},
                },
                "required": ["id", "topic", "description", "voice_ai_suitable", "reasoning"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


def _truncate(text: str | None, max_chars: int) -> str:
    if not text:
        return ""
    text = text.strip()
    return text if len(text) <= max_chars else text[:max_chars].rstrip() + "..."


def call_llm_json(prompt: str, data_payload: Any, schema: dict, timeout: int = 180) -> dict:
    """Ask the MCP host model (via its sampling bridge) for JSON matching schema."""
    composed = (
        prompt
        + "\n\nDATA_JSON = "
        + json.dumps(data_payload, ensure_ascii=False)
        + "\n\nReturn ONLY valid JSON (no prose, no code fences) that matches this JSON schema:\n"
        + json.dumps(schema)
    )
    try:
        return parse_json_response(complete_via_llm(composed, 8000))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Sampled output is not valid JSON: {exc}") from exc


def _iter_batches(items: list[dict], batch_size: int, max_batch_chars: int):
    """Group items into large batches, bounded by call count and total transcript size."""
    batch: list[dict] = []
    chars = 0
    for item in items:
        tlen = len(item.get("transcript") or "")
        if batch and (len(batch) >= batch_size or chars + tlen > max_batch_chars):
            yield batch
            batch, chars = [], 0
        batch.append(item)
        chars += tlen
    if batch:
        yield batch


def run_pass1(
    records: list[dict], batch_size: int, max_transcript_chars: int, max_batch_chars: int = DEFAULT_MAX_BATCH_CHARS
) -> list[dict]:
    payload = [
        {
            "id": r["id"],
            "occurred_at": r.get("occurred_at"),
            "summary": _truncate(r.get("summary"), 500),
            "transcript": _truncate(r.get("transcript"), max_transcript_chars),
        }
        for r in records
    ]
    occurred_lookup = {r["id"]: r.get("occurred_at", "") for r in records}

    batches = list(_iter_batches(payload, batch_size, max_batch_chars))
    results: list[dict] = []
    done = 0
    for idx, batch in enumerate(batches, 1):
        first = done + 1
        done += len(batch)
        log.info("Pass 1: batch %d/%d (%d-%d of %d calls)", idx, len(batches), first, done, len(payload))
        parsed = call_llm_json(PASS1_PROMPT, batch, _PASS1_SCHEMA)
        for item in parsed.get("items", []):
            item["occurred_at"] = occurred_lookup.get(item.get("id"), "")
            results.append(item)
    return results


# ---------------------------------------------------------------------------
# Pass 2: synthesis / clustering
# ---------------------------------------------------------------------------

PASS2_PROMPT = """\
You will receive a JSON array of per-call topic extractions from customer \
phone calls, each with: id, occurred_at, topic, description, \
voice_ai_suitable ("yes"/"partial"/"no"), reasoning.

Cluster these into a ranked list of CANONICAL topics — merge near-duplicate \
labels (e.g. "schedule appointment" and "book appointment slot" are the \
same canonical topic). For each canonical topic produce:

- name: a clear, short canonical topic name.
- description: 1-2 sentences describing the caller need this topic covers.
- call_count: how many of the input calls belong to this topic.
- example_call_ids: up to 5 call ids that best represent this topic.
- voice_ai_suitability: "High", "Medium", or "Low" — your overall judgment \
  of whether a voice AI agent could handle this topic end-to-end across \
  most occurrences (weigh the individual voice_ai_suitable signals, but use \
  your own judgment on the aggregate).
- rationale: 1-2 sentences justifying the suitability rating, and if \
  Medium/Low, note what would need to be true (e.g. integration, \
  escalation path) for a voice AI to handle more of it.

Sort the output list by call_count descending. Only include topics with at \
least 2 calls; roll any topic with a single call into an "Other" bucket if \
one is needed, or omit it.

Return JSON matching the provided schema exactly.
"""

_PASS2_SCHEMA = {
    "type": "object",
    "properties": {
        "topics": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "call_count": {"type": "integer"},
                    "example_call_ids": {"type": "array", "items": {"type": "integer"}},
                    "voice_ai_suitability": {"type": "string", "enum": ["High", "Medium", "Low"]},
                    "rationale": {"type": "string"},
                },
                "required": [
                    "name", "description", "call_count", "example_call_ids",
                    "voice_ai_suitability", "rationale",
                ],
                "additionalProperties": False,
            },
        }
    },
    "required": ["topics"],
    "additionalProperties": False,
}


def call_llm_text(prompt: str, max_output_tokens: int = 6000) -> str:
    return complete_via_llm(prompt, max_output_tokens)


# ---------------------------------------------------------------------------
# Pass 3: VoiceAI bot configuration instructions
# ---------------------------------------------------------------------------

PASS3_PROMPT = """\
You are configuring a CTM VoiceAI inbound voice assistant for a specific \
company. You will receive the company's canonical caller topics from a \
two-pass analysis of their real phone call transcripts, each with a name, \
description, call_count, and a voice_ai_suitability rating (High / Medium / \
Low) plus a rationale.

Write a complete, configuration-ready VoiceAI bot instructions document for \
this company. The document is what a CTM Professional Services consultant \
would paste into the VoiceAI agent configuration and use to configure the \
bot's behavior. Tailor everything to THIS company's observed call mix — do \
not write generic boilerplate.

Produce the document in Markdown with EXACTLY these sections:

# VoiceAI Agent Instructions
A complete system prompt / agent instructions ready to paste into the CTM \
VoiceAI agent builder. Must include: agent identity & role, primary purpose, \
tone & behavior guidelines, an opening greeting script, and explicit \
routing rules that map each observed topic to one of three behaviors:
- handle_end_to_end (topics rated High that are simple/scriptable)
- triage_then_escalate (topics rated Medium/partial — bot gathers the \
  request and transfers to a human)
- escalate_directly (topics rated Low that need human judgment immediately)
For each topic list the specific intents/phrases the bot should recognize, \
what data to capture, and when to transfer. Include transfer script language, \
a general escalation guardrail ("when in doubt, transfer to a human"), and \
clear do-not-do boundaries.

# Bot Configuration Notes
Concrete setup values for the CTM VoiceAI configuration: suggested agent \
name, greeting/opening message, the routing decisions per topic (as a \
table), fields/dispositions to write back to the call record, suggested \
transfer target, and any follow-up message logic.

# Suggested Dispositions
A list of call dispositions to configure, mapped to the observed topics.

# Risks And Validation
Anything that could go wrong if this bot were launched as configured, and \
validation steps to run before going live.

# Evidence
A short summary of the underlying call data this is based on (account id, \
number of calls analyzed, topic counts), without any phone numbers, emails, \
or names.

Use the company's own observed topics and rationale as the source of truth. \
Do not invent capabilities or integrations not implied by the data.

TOPICS_JSON = {topics_json}
"""


def run_pass3(topics: list[dict], account_id: str, call_count: int) -> str:
    payload = [
        {
            "name": t.get("name", ""),
            "description": t.get("description", ""),
            "call_count": t.get("call_count", 0),
            "voice_ai_suitability": t.get("voice_ai_suitability", ""),
            "rationale": t.get("rationale", ""),
        }
        for t in topics
    ]
    context = {"account_id": account_id, "call_count": call_count, "topics": payload}
    log.info("Pass 3: generating VoiceAI bot configuration instructions")
    prompt = PASS3_PROMPT.format(topics_json=json.dumps(context, ensure_ascii=False, indent=2))
    return call_llm_text(prompt, max_output_tokens=6500)


# ---------------------------------------------------------------------------
# Pass 4: recommended updates to an existing VoiceAI agent prompt
# ---------------------------------------------------------------------------

PASS4_PROMPT = """\
You are a CTM Professional Services consultant reviewing a live VoiceAI \
inbound agent configuration for one specific account. You have two inputs:

1. A two-pass topic analysis of the account's real phone call transcripts: \
canonical caller topics, each with a name, description, call_count, and a \
voice_ai_suitability rating (High / Medium / Low) plus rationale.
2. The agent's CURRENT instructions as configured live.

Produce a Markdown "Recommended Prompt Updates" document that compares the \
current instructions against the observed call mix and tells the consultant \
exactly what to change. Tailor everything to THIS account's topics. Do not \
write generic advice and do not invent caller needs, products, integrations \
or capabilities that are not present in the input.

Use EXACTLY this structure:

# Recommended Prompt Updates
One short paragraph naming the account, the number of calls analyzed, the \
number of observed topics (use the provided topic_count, do not recount), and \
the current agent name.

## Coverage Map
A Markdown table with columns: Observed topic | Calls | Voice AI fit | \
Current coverage (Good / Partial / None) | Gap. Cover EVERY topic in the input. \
Be honest when a topic is not handled at all.

## Priority Changes
The highest-impact updates, ordered by expected call volume. For each: a \
bold heading naming the update; the topic(s) and call counts it addresses; \
why it matters; and a fenced code block containing PASTE-READY prompt text \
(the intents and phrases to recognize, what to capture, what to say, and how \
to route), written in the same style and voice as the current instructions.

## Secondary Changes
Lower-volume topics worth covering, in the same format but shorter.

## What To Preserve
A bullet list of the mechanics in the current instructions that are correct \
and must not be regressed (for example inline saves, one question per turn, \
read-back, escalation guardrails, forwarded-call caller-ID handling).

## Integration Dependencies
Explicitly flag any recommendation that only works if the agent has live \
access to a calendar, dispatch, order, pricing or CRM system. State the \
capture-and-confirm fallback the bot must use if that access does not exist. \
Never assume an integration exists.

Rules:
- Only reference topics present in the input data.
- Do not use em dashes. Use hyphens or restructure the sentence.
- If the current instructions already cover a topic well, say so rather than \
inventing changes.

ACCOUNT_JSON = {account_json}

CURRENT_INSTRUCTIONS = {instructions}
"""


def run_pass4(
    topics: list[dict], account_id: str, call_count: int, bot: dict
) -> str:
    account_json = {
        "account_id": account_id,
        "call_count": call_count,
        "topic_count": len(topics),
        "bot_name": bot.get("name", ""),
        "topics": [
            {
                "name": t.get("name", ""),
                "description": t.get("description", ""),
                "call_count": t.get("call_count", 0),
                "voice_ai_suitability": t.get("voice_ai_suitability", ""),
                "rationale": t.get("rationale", ""),
            }
            for t in topics
        ],
    }
    log.info("Pass 4: reviewing current instructions for agent '%s'", bot.get("name") or bot.get("id"))
    prompt = PASS4_PROMPT.format(
        account_json=json.dumps(account_json, ensure_ascii=False, indent=2),
        instructions=bot.get("instructions", ""),
    )
    return call_llm_text(prompt, max_output_tokens=8000)


# ---------------------------------------------------------------------------
# Pass 5: suggested fully rewritten prompt
# ---------------------------------------------------------------------------

PASS5_PROMPT = """\
You are a CTM Professional Services consultant. Rewrite a live VoiceAI agent's \
instructions into one complete, ready-to-paste prompt that incorporates every \
recommended change.

You are given:
1. The account's canonical caller topics from real phone call transcripts \
(name, description, call_count, voice_ai_suitability, rationale).
2. The agent's CURRENT live instructions.
3. A "Recommended Prompt Updates" document describing coverage gaps and \
prioritized changes.

Produce ONLY the rewritten prompt. Output rules:
- Output the prompt text by itself. No preamble, no explanation, no commentary, \
and no surrounding markdown headings or code fences.
- Keep the current instructions' voice, structure and formatting where they \
already work; change only what the recommendations require.
- Cover EVERY observed topic: the intents/phrases to recognize, what to \
capture, what to say, and how to route (handle end-to-end, triage then \
escalate, or escalate directly) consistent with each topic's suitability.
- Preserve the escalation/guardrail behavior and anything the current prompt \
already does well.
- The result must be self-contained: a consultant can paste it over the current \
instructions unchanged.
- Do not use em dashes. Do not include names, phone numbers, emails, account \
numbers, or any other PII.

CURRENT_INSTRUCTIONS:
{instructions}

TOPICS_JSON:
{topics_json}

RECOMMENDATIONS:
{recommendations}
"""


def _strip_code_fences(text: str) -> str:
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9_]*\s*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)
    return text.strip()


def run_pass5(
    topics: list[dict], account_id: str, call_count: int, bot: dict, recommendations: str
) -> str:
    topics_json = {
        "account_id": account_id,
        "call_count": call_count,
        "topic_count": len(topics),
        "bot_name": bot.get("name", ""),
        "topics": [
            {
                "name": t.get("name", ""),
                "description": t.get("description", ""),
                "call_count": t.get("call_count", 0),
                "voice_ai_suitability": t.get("voice_ai_suitability", ""),
                "rationale": t.get("rationale", ""),
            }
            for t in topics
        ],
    }
    log.info(
        "Pass 5: drafting a full rewritten prompt for agent '%s'",
        bot.get("name") or bot.get("id"),
    )
    prompt = PASS5_PROMPT.format(
        instructions=bot.get("instructions", ""),
        topics_json=json.dumps(topics_json, ensure_ascii=False, indent=2),
        recommendations=recommendations,
    )
    return _strip_code_fences(call_llm_text(prompt, max_output_tokens=8000))


def run_pass2(pass1_items: list[dict]) -> list[dict]:
    payload = [
        {
            "id": item["id"],
            "occurred_at": item.get("occurred_at", ""),
            "topic": item.get("topic", ""),
            "description": item.get("description", ""),
            "voice_ai_suitable": item.get("voice_ai_suitable", ""),
            "reasoning": item.get("reasoning", ""),
        }
        for item in pass1_items
    ]
    log.info("Pass 2: synthesizing %d call-topic extractions into canonical topics", len(payload))
    parsed = call_llm_json(PASS2_PROMPT, payload, _PASS2_SCHEMA)
    topics = parsed.get("topics", [])
    topics.sort(key=lambda t: t.get("call_count", 0), reverse=True)
    return topics


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

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

def build_csv(topics: list[dict], output_path: Path) -> None:
    fieldnames = ["name", "description", "call_count", "voice_ai_suitability", "rationale", "example_call_ids"]
    with output_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for t in topics:
            row = dict(t)
            row["example_call_ids"] = ";".join(str(c) for c in t.get("example_call_ids", []))
            writer.writerow({k: row.get(k, "") for k in fieldnames})
    log.info("Wrote CSV to %s", output_path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    p = argparse.ArgumentParser(description="Identify voice-AI-suitable call topics from CTM activity.")
    p.add_argument("--account-id", required=True, help="CTM sub-account id to analyze")
    p.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    p.add_argument("--auth-key", default=DEFAULT_AUTH_KEY, help="Env/config key holding the CTM basic-auth token")
    p.add_argument("--target", type=int, default=DEFAULT_TARGET, help="Number of transcribed calls to analyze")
    p.add_argument("--per-page", type=int, default=DEFAULT_PER_PAGE)
    p.add_argument("--since", metavar="YYYY-MM-DD")
    p.add_argument("--until", metavar="YYYY-MM-DD")
    p.add_argument("--direction", default="inbound", choices=["inbound", "outbound", "none"], help="Filter by call direction (default inbound; 'none' = no filter)")
    p.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="Max calls per LLM extraction batch (default 100); batches also stop at --max-batch-chars")
    p.add_argument("--max-batch-chars", type=int, default=DEFAULT_MAX_BATCH_CHARS, help="Max total transcript characters per LLM batch (default 300000)")
    p.add_argument("--max-transcript-chars", type=int, default=DEFAULT_MAX_TRANSCRIPT_CHARS)
    p.add_argument("--input", metavar="FILE", help="Use a local JSON file of calls instead of the CTM API")
    p.add_argument("--pass1-cache", metavar="FILE", help="Skip pass 1 and load per-call topics from this JSON file")
    p.add_argument("--save-pass1", metavar="FILE", help="Save per-call topic extractions (pass 1 output) to this JSON file")
    p.add_argument("--pass2-cache", metavar="FILE", help="Skip passes 1-2 and load canonical topics from this JSON file")
    p.add_argument("--save-pass2", metavar="FILE", help="Save canonical topics (pass 2 output) to this JSON file")
    p.add_argument("--out", default="voiceai_topic_analysis.html")
    p.add_argument("--csv-out", default="voiceai_topic_analysis.csv")
    p.add_argument("--bot-instructions-out", default="voiceai_bot_instructions.md")
    p.add_argument("--skip-bot-instructions", action="store_true", help="Skip pass 3 (new bot instructions)")
    p.add_argument(
        "--voice-bot", action="append", metavar="ID_OR_NAME",
        help="VoiceAI agent to review; repeatable. Matches exact id or name substring. Default: all agents with instructions.",
    )
    p.add_argument("--voice-bots-cache", metavar="FILE", help="Load saved VoiceAI agents JSON instead of calling the API")
    p.add_argument("--save-voice-bots", metavar="FILE", help="Save fetched VoiceAI agents (id/name/instructions) to this JSON file")
    p.add_argument("--skip-recommendations", action="store_true", help="Skip pass 4 (recommended prompt updates)")
    p.add_argument("--recommendations-out", metavar="FILE", help="Output path for pass 4 recommendations Markdown")
    p.add_argument("--rewrite-out", metavar="FILE", help="Output path for the pass 5 suggested rewritten prompt")
    args = p.parse_args()

    env = load_env_file(args.env_file)
    require_llm()
    basic_auth: str | None = None
    pass1_items: list[dict] = []

    if args.pass2_cache:
        cached = json.loads(Path(args.pass2_cache).read_text(encoding="utf-8"))
        if isinstance(cached, dict):
            topics = cached.get("topics", [])
            call_count = cached.get("call_count", 0)
        else:
            topics = cached
            call_count = sum(t.get("call_count", 0) for t in topics)
        log.info("Loaded %d cached canonical topics from %s", len(topics), args.pass2_cache)
        if args.pass1_cache:
            pass1_path = Path(args.pass1_cache)
            if pass1_path.exists():
                pass1_items = json.loads(pass1_path.read_text(encoding="utf-8"))
                log.info("Loaded %d cached pass-1 topic extractions from %s", len(pass1_items), args.pass1_cache)
    else:
        if args.pass1_cache:
            pass1_items = json.loads(Path(args.pass1_cache).read_text(encoding="utf-8"))
            call_count = len({item["id"] for item in pass1_items})
            log.info("Loaded %d cached pass-1 topic extractions from %s", len(pass1_items), args.pass1_cache)
        else:
            if args.input:
                records = json.loads(Path(args.input).read_text(encoding="utf-8"))
                log.info("Loaded %d records from %s", len(records), args.input)
            else:
                basic_auth = get_ctm_auth(env, args.auth_key)
                direction = None if args.direction == "none" else args.direction
                records = fetch_calls(
                    account_id=args.account_id,
                    basic_auth=basic_auth,
                    target=args.target,
                    per_page=args.per_page,
                    since=args.since,
                    until=args.until,
                    direction=direction,
                )
                log.info("Fetched %d transcribed calls from CTM API (account %s)", len(records), args.account_id)

            if not records:
                raise SystemExit("No transcribed calls found for the given window.")

            call_count = len(records)
            pass1_items = run_pass1(records, args.batch_size, args.max_transcript_chars, args.max_batch_chars)
            log.info("Pass 1 produced %d call-topic extractions", len(pass1_items))

            if args.save_pass1:
                Path(args.save_pass1).write_text(json.dumps(pass1_items, indent=2), encoding="utf-8")
                log.info("Saved pass-1 output to %s", args.save_pass1)

        if not pass1_items:
            raise SystemExit("Pass 1 produced no usable topic extractions.")

        topics = run_pass2(pass1_items)
        log.info("Pass 2 produced %d canonical topics", len(topics))

        if args.save_pass2:
            Path(args.save_pass2).write_text(
                json.dumps({"call_count": call_count, "topics": topics}, indent=2), encoding="utf-8"
            )
            log.info("Saved pass-2 output to %s", args.save_pass2)

    for t in topics:
        t["description"] = sanitize_names(redact_text(t.get("description", "")))
        t["rationale"] = sanitize_names(redact_text(t.get("rationale", "")))

    # Pass 3: generate a complete configuration-ready instructions document.
    generated_instructions = ""
    if not args.skip_bot_instructions:
        generated_instructions = redact_text(
            run_pass3(topics, args.account_id, call_count)
        )
        Path(args.bot_instructions_out).write_text(generated_instructions, encoding="utf-8")
        log.info("Wrote VoiceAI bot instructions to %s", args.bot_instructions_out)

    # Pass 4: compare the observed topics against each agent's current live prompt.
    recommendations: list[dict] = []
    rewrites: list[dict] = []
    selected_bots: list[dict] = []
    if not args.skip_recommendations:
        if args.voice_bots_cache:
            cached_bots = json.loads(Path(args.voice_bots_cache).read_text(encoding="utf-8"))
            raw_bots = cached_bots.get("voice_bots", cached_bots) if isinstance(cached_bots, dict) else cached_bots
            bots = [_normalize_bot(b) for b in raw_bots if isinstance(b, dict)]
            log.info("Loaded %d VoiceAI agent(s) from %s", len(bots), args.voice_bots_cache)
        else:
            auth = basic_auth or get_ctm_auth(env, args.auth_key)
            bots = fetch_voice_bots(args.account_id, auth, args.per_page)

        if args.save_voice_bots:
            Path(args.save_voice_bots).write_text(json.dumps({"voice_bots": bots}, indent=2), encoding="utf-8")
            log.info("Saved %d VoiceAI agent(s) to %s", len(bots), args.save_voice_bots)

        selected = select_voice_bots(bots, args.voice_bot)
        if not selected:
            log.warning("No VoiceAI agents with instructions found - skipping pass 4.")
        else:
            selected_bots = selected
            sections: list[str] = []
            for bot in selected:
                recs = run_pass4(topics, args.account_id, call_count, bot)
                # Only redact contact patterns; do NOT run sanitize_names here, it would
                # rewrite Title Case Markdown headings (e.g. "Coverage Map") into names.
                recs = redact_text(recs)
                recommendations.append({"id": bot.get("id"), "name": bot.get("name"), "markdown": recs})
                sections.append(
                    f"\n\n<!-- voice_bot id={bot.get('id')} name={bot.get('name')!r} -->\n\n{recs}"
                )
                # Pass 5: a complete, paste-ready rewrite of the agent's prompt.
                rewrite = redact_text(run_pass5(topics, args.account_id, call_count, bot, recs))
                rewrites.append({"id": bot.get("id"), "name": bot.get("name"), "text": rewrite})
            header = (
                f"# Voice AI Prompt Recommendations - Account {args.account_id}\n\n"
                f"Generated {time.strftime('%Y-%m-%d %H:%M:%S')} from {call_count} analyzed calls. "
                f"Agents reviewed: {len(selected)}.\n"
            )
            rec_out = Path(
                args.recommendations_out or f"voiceai_prompt_recommendations_{args.account_id}.md"
            )
            rec_out.write_text(header + "".join(sections), encoding="utf-8")
            log.info("Wrote prompt recommendations for %d agent(s) to %s", len(selected), rec_out)

            if rewrites and args.rewrite_out:
                rw_header = (
                    f"# Suggested Rewritten Prompt - Account {args.account_id}\n\n"
                    f"Generated {time.strftime('%Y-%m-%d %H:%M:%S')} from {call_count} analyzed calls. "
                    f"Agents rewritten: {len(rewrites)}.\n"
                )
                rw_sections = [
                    f"\n\n<!-- voice_bot id={r.get('id')} name={r.get('name')!r} -->\n\n{r.get('text', '')}"
                    for r in rewrites
                ]
                Path(args.rewrite_out).write_text(rw_header + "".join(rw_sections), encoding="utf-8")
                log.info("Wrote suggested rewritten prompt(s) to %s", args.rewrite_out)

    # Build the full report last so it can include the topic, call and prompt analysis.
    call_rows = [
        {
            "id": it.get("id"),
            "occurred_at": it.get("occurred_at", ""),
            "topic": it.get("topic", ""),
            "voice_ai_suitable": it.get("voice_ai_suitable", ""),
            "description": sanitize_names(redact_text(it.get("description", ""))),
            "reasoning": sanitize_names(redact_text(it.get("reasoning", ""))),
        }
        for it in pass1_items
    ]
    artifacts = {
        "account_id": args.account_id,
        "call_count": call_count,
        "topics": topics,
        "call_rows": call_rows,
        "bots": [
            {"id": b.get("id"), "name": b.get("name"), "instructions": b.get("instructions", "")}
            for b in selected_bots
        ],
        "recommendations": recommendations,
        "rewrites": rewrites,
        "generated_instructions": generated_instructions,
    }
    build_html(artifacts, Path(args.out))
    build_csv(topics, Path(args.csv_out))

    # Pop the report in the browser (set CTM_VOICEAI_OPEN_REPORT=0 to disable).
    if os.environ.get("CTM_VOICEAI_OPEN_REPORT", "1").strip().lower() not in ("0", "false", "no", "off"):
        _open_in_browser(Path(args.out))


if __name__ == "__main__":
    main()

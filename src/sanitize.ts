import { artifactsSchema, type Artifacts } from "./types.js";
// PII scrubbing for the report. Mirrors the original engine's redaction:
// emails and phone numbers are redacted, and 2-3 word proper names are replaced
// with placeholders. Markdown structure (headings, tables, bold labels, code)
// is protected so report vocabulary like "Existing Customer Warranty" survives.

const EMAIL_RE = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;
const PHONE_RE = /\+?\d[\d\-.\s()]{6,}\d/g;

const NAME_STOPWORDS = new Set([
  // Acronyms / vendors
  "CTM", "CRM", "API", "AI", "IVR", "SMS", "MMS", "PSTN", "DID",
  "Salesforce", "Zoom", "RingCentral", "CallTrackingMetrics",
  "Medicaid", "UnitedHealthcare",
  // Report / topic vocabulary that looks like a name but is not
  "Coverage", "Map", "Priority", "Changes", "Secondary", "Preserve",
  "Integration", "Dependencies", "Recommended", "Prompt", "Prompts",
  "Updates", "Current", "Agent", "Agents", "Existing", "Customer",
  "Customers", "New", "Warranty", "Dispute", "Voice", "Why", "What",
  "When", "How", "This", "That", "Note", "Notes", "Overview", "Summary",
  "Gap", "Good", "Partial", "None", "High", "Medium", "Low", "Calls",
  "Call", "Topics", "Topic", "Change", "Section", "Sections", "Schedule",
  "Scheduling", "Booking", "Billing", "Service", "Services", "Quote",
  "Quotes", "Support", "Account", "Accounts", "Sales", "Repair", "Repairs",
  "Install", "Installation", "Emergency", "General", "Inquiry", "Inquiries",
  "Question", "Questions", "Request", "Requests", "Follow", "Callback",
  "Cancellation", "Reschedule", "Availability", "Pricing", "Payment",
  "Parts", "Order", "Orders", "Status", "Dispatch", "Routing", "Transfer",
  // Common verbs / nouns that start instruction sentences and get glued to names
  "Help", "Greet", "Route", "Collect", "Provide", "Ensure", "Ask", "Tell",
  "Offer", "Handle", "Confirm", "Capture", "Update", "Escalate", "Review",
  "Check", "Recommend", "Suggest", "Connect", "Reach", "Contact", "Speak",
  "Talk", "Hold", "Wait", "Message", "Voicemail", "Caller", "Callers",
  "Information", "Details", "Address", "Date", "Time", "Name", "Email",
  "Phone", "Appointment", "Team", "Member", "Office", "Location", "Hours",
  "Note", "Check", "Book", "Cancel", "Reschedule", "Greeting", "Opening",
  "Closing", "Tone", "Goal", "Behavior", "Constraint", "Exception", "Rule"
]);

const PLACEHOLDER_NAMES = [
  "Jon Doe", "Jane Doe", "Alex Johnson", "Maria Garcia",
  "Chris Lee", "Taylor Brown", "Sam Patel", "Jordan Kim"
];

export function redactText(text: string): string;
export function redactText(text: string | undefined): string | undefined;
export function redactText(text: string | undefined) {
  if (!text || typeof text !== "string") return text;
  return text.replace(EMAIL_RE, "[REDACTED_EMAIL]").replace(PHONE_RE, "[REDACTED_PHONE]");
}

function isNameToken(token: string) {
  if (!token || NAME_STOPWORDS.has(token) || token === token.toUpperCase()) return false;
  return token[0] === token[0].toUpperCase() && token[0] !== token[0].toLowerCase()
    && token.slice(1) === token.slice(1).toLowerCase();
}

const NAME_RE = /\b([A-Z][a-z]+)\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?\b/g;

export function makeNameState() {
  return { map: new Map<string, string>(), counter: 0 };
}

/** Replace detected two- or three-word proper names with placeholder names. */
export function sanitizeNames(text: string, state?: NameState): string;
export function sanitizeNames(text: string | undefined, state?: NameState): string | undefined;
export function sanitizeNames(text: string | undefined, state = makeNameState()) {
  if (!text || typeof text !== "string") return text;
  return text.replace(NAME_RE, (match: string, a: string, b: string, c: string | undefined) => {
    const tokens = [a, b, c].filter((v): v is string => Boolean(v));
    // Prefer the longest run of name-like tokens; skip any run containing a
    // stopword so topic phrases like "Existing Customer Warranty" survive.
    for (let n = tokens.length; n >= 2; n--) {
      const window = tokens.slice(0, n);
      if (window.every(isNameToken)) {
        const full = window.join(" ");
        if (!state.map.has(full)) {
          state.map.set(full, PLACEHOLDER_NAMES[state.counter % PLACEHOLDER_NAMES.length]);
          state.counter += 1;
        }
        const rest = tokens.slice(n).join(" ");
        return rest ? `${state.map.get(full)} ${rest}` : state.map.get(full) ?? full;
      }
    }
    return match;
  });
}

function sanitizeLine(line: string, state: NameState) {
  // Protect Markdown headings and table separator rows entirely.
  if (/^\s{0,3}#{1,6}\s/.test(line)) return redactText(line);
  if (/^\s*\|?\s*:?-{2,}/.test(line)) return redactText(line);

  const spans: string[] = [];
  const stash = (value: string) => {
    spans.push(value);
    return `\u0000${spans.length - 1}\u0000`;
  };

  // Protect bold labels like "**Existing Customer Warranty (1 call)**" or
  // "**Note:**", and inline code spans, from name detection.
  let protectedLine = line.replace(/\*\*[^*\n]*\*\*/g, (m) =>
    m.includes("(") || /:\*\*$/.test(m) ? stash(m) : m
  );
  protectedLine = protectedLine.replace(/`[^`\n]*`/g, (m) => stash(m));

  let out = sanitizeNames(redactText(protectedLine), state);
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
  return out;
}

/** Sanitize a Markdown blob: protect fenced code blocks and per-line structure. */
export function sanitizeMarkdown(text: string, state?: NameState): string;
export function sanitizeMarkdown(text: string | undefined, state?: NameState): string | undefined;
export function sanitizeMarkdown(text: string | undefined, state = makeNameState()) {
  if (!text || typeof text !== "string") return text;
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part) => {
      if (part.startsWith("```")) return redactText(part);
      return part.split("\n").map((line) => sanitizeLine(line, state)).join("\n");
    })
    .join("");
}

/** Sanitize every free-text field of an analysis artifact object. */
export function sanitizeArtifacts(input: unknown): Artifacts {
  const artifacts = artifactsSchema.parse(input);
  const state = makeNameState();
  const scrub = (value: string | undefined) => sanitizeNames(redactText(value), state);
  const markdown = (value: string) => sanitizeMarkdown(value, state);

  const topics = (artifacts.topics || []).map((t) => ({
    ...t,
    name: sanitizeNames(redactText(t.name), state),
    description: scrub(t.description),
    rationale: scrub(t.rationale)
  }));

  const callRows = (artifacts.call_rows || []).map((r) => ({
    ...r,
    description: scrub(r.description),
    reasoning: scrub(r.reasoning)
  }));

  const recommendations = (artifacts.recommendations || []).map((r) => ({
    ...r,
    markdown: markdown(r.markdown)
  }));

  const rewrites = (artifacts.rewrites || []).map((r) => ({
    ...r,
    // Prompts legitimately use Title Case; only redact emails/phones here.
    text: redactText(r.text)
  }));

  const bots = (artifacts.bots || []).map((b) => ({
    ...b,
    instructions: redactText(b.instructions)
  }));

  return {
    ...artifacts,
    topics,
    call_rows: callRows,
    recommendations,
    rewrites,
    bots,
    generated_instructions: redactText(artifacts.generated_instructions || "")
  };
}

export const _internals = { isNameToken, NAME_STOPWORDS, PLACEHOLDER_NAMES };
type NameState = ReturnType<typeof makeNameState>;

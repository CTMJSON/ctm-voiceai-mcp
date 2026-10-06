#!/usr/bin/env node
// Unit checks for PII scrubbing: names are replaced, emails/phones redacted, and
// Markdown report structure is preserved.
import assert from "node:assert";
import { redactText, sanitizeNames, sanitizeMarkdown, sanitizeArtifacts } from "../dist/sanitize.js";

// Emails and phones.
const contact = redactText("Reach jane.caller@example.com or 555-123-4567 today.");
assert.ok(!contact.includes("jane.caller@example.com"), "email redacted");
assert.ok(contact.includes("[REDACTED_EMAIL]"), "email placeholder");
assert.ok(contact.includes("[REDACTED_PHONE]"), "phone placeholder");

// A caller name in prose is replaced with a placeholder.
const prose = sanitizeNames("Why: Janet Wills' call reveals conflicting information from prior techs.");
assert.ok(!prose.includes("Janet Wills"), "caller name removed");
assert.ok(!/\bWills\b/.test(prose), "surname removed");
assert.ok(/Jon Doe|Jane Doe|Alex Johnson|Maria Garcia|Chris Lee|Taylor Brown|Sam Patel|Jordan Kim/.test(prose), "placeholder used");

// Report vocabulary and Markdown structure survive.
const heading = sanitizeMarkdown("## Coverage Map\n\n### Priority Changes");
assert.ok(heading.includes("Coverage Map"), "heading preserved");
assert.ok(heading.includes("Priority Changes"), "heading preserved");

const label = sanitizeMarkdown("**Existing Customer Warranty/Dispute (1 call, Low suitability)**");
assert.ok(label.includes("Existing Customer Warranty/Dispute"), "bold topic label preserved");

const table = sanitizeMarkdown("| Observed Topic | Calls | Voice AI Fit |\n|---|---|---|\n| Booking | 3 | High |");
assert.ok(table.includes("Observed Topic"), "table header preserved");
assert.ok(table.includes("Booking"), "table cell preserved");

// Same name maps to the same placeholder across the whole report.
const artifacts = sanitizeArtifacts({
  account_id: "test",
  topics: [{ name: "Warranty dispute", description: "Janet Wills called about a warranty.", rationale: "Janet Wills is upset." }],
  call_rows: [{ id: 1, description: "Janet Wills called", reasoning: "Janet Wills needs a manager" }],
  recommendations: [{ name: "Agent", markdown: "**Existing Customer Warranty/Dispute (1 call)**\n\nWhy: Janet Wills' call reveals conflict.\n\n```\nGreet the caller.\n```" }],
  rewrites: [{ name: "Agent", text: "You are a receptionist. Greet and help the caller." }],
  bots: [{ name: "Agent", instructions: "You are a receptionist." }]
});
const blob = JSON.stringify(artifacts);
assert.ok(!blob.includes("Janet Wills"), "name gone from every field");
assert.ok(artifacts.recommendations[0].markdown.includes("Existing Customer Warranty/Dispute"), "topic label intact");
assert.ok(artifacts.recommendations[0].markdown.includes("```"), "fenced code intact");
assert.ok(artifacts.bots[0].instructions === "You are a receptionist.", "agent instructions untouched");

const placeholders = new Set(blob.match(/Jon Doe|Jane Doe|Alex Johnson|Maria Garcia|Chris Lee|Taylor Brown|Sam Patel|Jordan Kim/g) || []);
assert.equal(placeholders.size, 1, "one consistent placeholder for the same name");

console.log("OK - sanitizer redacts names/emails/phones and preserves Markdown");
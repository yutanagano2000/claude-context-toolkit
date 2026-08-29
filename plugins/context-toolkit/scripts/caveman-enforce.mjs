#!/usr/bin/env node
/**
 * Stop hook: refuse to end a turn whose final reply drifted out of caveman ultra.
 *
 * The UserPromptSubmit reminder asks for the style and nothing checks that it was applied, so a long
 * session drifts back into full prose one paragraph at a time and no one notices until the tokens are
 * already spent. This reads the reply that is about to be delivered and sends it back when it carries
 * the markers the style forbids, quoting them so the next attempt is a rewrite rather than a guess.
 *
 * BOUNDED, NOT SINGLE. One refusal was walked straight past by a reply that did not change, so each
 * distinct reply may be sent back up to MAX_OBJECTIONS times. The count lives in the marker file and
 * is keyed by the reply text, so a rewrite starts its own budget and only an unchanged reply spends
 * the old one. Unbounded refusal is deliberately not the design: that is a session which can never
 * finish a turn, which is a worse failure than a verbose answer.
 *
 * The stop_hook_active flag is NOT an early exit here. It is set on every stop after the first block,
 * so honouring it would cap this at exactly one refusal and make the budget above unreachable. The
 * marker count is what keeps the session recoverable instead.
 *
 * Fails open everywhere. A malformed transcript, an unreadable marker directory or an unexpected
 * payload shape ends the turn normally — style enforcement is not worth wedging a session over.
 */

import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Phrases the style forbids outright. Each is quoted back when it is found. */
const FILLER = [
  // English filler and pleasantries
  "certainly", "of course", "happy to help", "i'd be happy",
  "basically", "essentially", "simply put", "in order to",
  "it's worth noting", "it is worth noting", "as you can see",
  // Japanese pleasantries and hedging
  "もちろん", "承知しました", "かしこまりました", "喜んで",
  "〜だと思います", "と思われます", "ご参考までに", "いかがでしょうか",
];

/** Decorative characters the style bans for costing a token and saving none. */
const DECORATION = ["→", "⇒", "✅", "❌", "🎉", "🚀", "💡", "⚠️"];

/** How many distinct markers are tolerated before the reply is sent back. */
const THRESHOLD = 2;

/**
 * How many times one reply may be sent back before the turn is allowed to end.
 *
 * Not one, which a single stubborn reply walked straight past, and not unbounded, which is a session
 * that can never finish a turn. Three refusals is enough for a rewrite to land and still leaves the
 * session recoverable when the checker and the model disagree about a word.
 */
const MAX_OBJECTIONS = 3;

function readPayload() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/** The text of the last assistant message in the transcript, or null. */
function lastAssistantText(transcriptPath) {
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text.trim()) return text;
  }
  return null;
}

/**
 * Code and quoted errors are exempt.
 *
 * The style preserves them verbatim, so a fenced block containing the word "basically" is not drift
 * and must not be counted as it. Stripping them before the scan is what keeps this from punishing a
 * correct reply for the contents of a file it quoted.
 */
function withoutCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

function findMarkers(text) {
  const prose = withoutCode(text);
  const lowered = prose.toLowerCase();
  const found = [];
  for (const phrase of FILLER) {
    if (lowered.includes(phrase.toLowerCase())) found.push(phrase);
  }
  for (const glyph of DECORATION) {
    if (prose.includes(glyph)) found.push(glyph);
  }
  return found;
}

/** True while this exact reply still has objections left, false once they are spent. */
function claimObjection(sessionId, text) {
  const digest = createHash("sha256")
    .update(`${sessionId ?? "unknown"}\n${text}`)
    .digest("hex")
    .slice(0, 32);
  const directory = join(tmpdir(), "context-toolkit-caveman");
  try {
    mkdirSync(directory, { recursive: true });
    const marker = join(directory, `${digest}.seen`);
    let spent = 0;
    if (existsSync(marker)) {
      spent = Number.parseInt(readFileSync(marker, "utf8").trim(), 10);
      if (!Number.isFinite(spent)) spent = 0;
    }
    if (spent >= MAX_OBJECTIONS) return false;
    writeFileSync(marker, String(spent + 1));
    return true;
  } catch {
    return false;
  }
}

const payload = readPayload();
if (!payload?.transcript_path) process.exit(0);

const reply = lastAssistantText(payload.transcript_path);
if (!reply) process.exit(0);

const markers = findMarkers(reply);
if (markers.length < THRESHOLD) process.exit(0);
if (!claimObjection(payload.session_id, reply)) process.exit(0);

const quoted = markers.map((marker) => `"${marker}"`).join(", ");
process.stderr.write(
  `context-toolkit: this reply drifted out of caveman ultra. Forbidden markers found: ${quoted}. ` +
    `Rewrite the reply in caveman ultra — drop filler, pleasantries and hedging, drop decorative ` +
    `arrows and emoji, keep every technical fact, code block, API name and error string verbatim. ` +
    `Auto-Clarity still applies: security warnings, irreversible-action confirmations and multi-step ` +
    `sequences may use plain prose where compression would risk a misread.\n`,
);
process.exit(2);

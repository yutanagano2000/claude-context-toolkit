#!/usr/bin/env node
/**
 * Stop hook: refuse to end a turn whose final reply drifted out of caveman ultra.
 *
 * The UserPromptSubmit reminder asks for the style and nothing checks that it was applied, so a long
 * session drifts back into full prose one paragraph at a time and no one notices until the tokens are
 * already spent. This reads the reply that is about to be delivered and blocks once when it carries
 * the markers the style forbids, quoting them so the next attempt is a rewrite rather than a guess.
 *
 * Blocks AT MOST ONCE per reply. A hook that kept refusing would be a session that cannot finish a
 * turn, which is a worse failure than a verbose answer: the marker file records what was already
 * objected to, and a second stop on the same reply is allowed through.
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

/** True the first time this exact reply is objected to, false every time after. */
function claimFirstObjection(sessionId, text) {
  const digest = createHash("sha256")
    .update(`${sessionId ?? "unknown"}\n${text}`)
    .digest("hex")
    .slice(0, 32);
  const directory = join(tmpdir(), "context-toolkit-caveman");
  try {
    mkdirSync(directory, { recursive: true });
    const marker = join(directory, `${digest}.seen`);
    if (existsSync(marker)) return false;
    writeFileSync(marker, "");
    return true;
  } catch {
    return false;
  }
}

const payload = readPayload();
if (!payload?.transcript_path) process.exit(0);
// Already inside a blocked stop; objecting again is how a session wedges.
if (payload.stop_hook_active) process.exit(0);

const reply = lastAssistantText(payload.transcript_path);
if (!reply) process.exit(0);

const markers = findMarkers(reply);
if (markers.length < THRESHOLD) process.exit(0);
if (!claimFirstObjection(payload.session_id, reply)) process.exit(0);

const quoted = markers.map((marker) => `"${marker}"`).join(", ");
process.stderr.write(
  `context-toolkit: this reply drifted out of caveman ultra. Forbidden markers found: ${quoted}. ` +
    `Rewrite the reply in caveman ultra — drop filler, pleasantries and hedging, drop decorative ` +
    `arrows and emoji, keep every technical fact, code block, API name and error string verbatim. ` +
    `Auto-Clarity still applies: security warnings, irreversible-action confirmations and multi-step ` +
    `sequences may use plain prose where compression would risk a misread.\n`,
);
process.exit(2);

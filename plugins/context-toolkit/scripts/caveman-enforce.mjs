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
 * Code and short quotations are exempt.
 *
 * The style preserves code verbatim, so a fenced block containing a filler word is not drift and must
 * not be counted as it. Quotation is the same distinction one level up: a reply that NAMES a forbidden
 * word — listing what the checker looks for, or telling somebody which phrase to stop using — is
 * discussing the word rather than drifting into it, and this refused exactly that reply until the
 * quote forms below were added.
 *
 * Only SHORT quotations are stripped, and only within one line. An unbounded quote exemption is a
 * hiding place: a paragraph of prose wrapped in quotation marks would pass unread. A run long enough
 * to hide drift in is longer than a phrase anybody quotes to name it.
 */
const QUOTE_LIMIT = 60;

function withoutCode(text) {
  const short = (open, close) =>
    new RegExp(`${open}[^${close}\\n]{1,${QUOTE_LIMIT}}${close}`, "g");
  return (
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`\n]*`/g, " ")
      // Japanese corner brackets, then straight and curly double quotes.
      .replace(short("「", "」"), " ")
      .replace(short("『", "』"), " ")
      .replace(short('"', '"'), " ")
      .replace(short("“", "”"), " ")
  );
}

/**
 * The prose of a reply: no code, no quotations, no tables, no list markers, no headings.
 *
 * Tables and lists are dropped because the style permits them and they are not sentences — measuring
 * sentence length across a table row produces a number that means nothing. What is left is the part
 * of a reply that is actually written in paragraphs, which is the part that drifts.
 */
function proseOf(text) {
  return (
    withoutCode(text)
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("|")) return "";
        if (trimmed.startsWith("#")) return "";
        if (/^[-*]\s/.test(trimmed)) return "";
        if (/^\d+\.\s/.test(trimmed)) return "";
        return line;
      })
      // Blanked rather than dropped. Dropping a line closes the gap above it, so a run of short
      // separate lines fuses into one block and is then measured as a single long paragraph — which
      // is how this refused a correctly terse reply until the difference was made.
      .join("\n")
  );
}

/**
 * Verbosity is structural, not lexical.
 *
 * The word list catches a reply that says a forbidden phrase. It says nothing about a reply written
 * entirely in correct, complete, unremarkable sentences that are three times longer than they need to
 * be — which is the drift that actually happens on a long session, and which this checker missed
 * every time until this function existed.
 *
 * Two independent signals, both measured only over paragraph prose. Sentence length is the primary
 * one: caveman ultra is fragments, and a mean sentence running past this is prose by definition.
 * Paragraph density is the second: several long sentences in one block is the shape of an
 * explanation, where the style wants a statement.
 *
 * Thresholds are deliberately loose. A false refusal costs a whole turn and teaches nothing, while a
 * missed one costs some tokens, so this only fires on a reply that is unambiguously written out.
 */
/**
 * Mean sentence length that counts as written-out prose, per script.
 *
 * Two numbers because a character is not a constant amount of meaning. A CJK sentence carries the
 * same content in noticeably fewer characters than the English one, so a single threshold either
 * lets drifted Japanese through or refuses ordinary English. Measured on real replies from a session
 * that drifted: the Japanese ran a mean of 86 and the English 124, against compliant replies that
 * produced no counted sentences at all.
 */
const MEAN_SENTENCE_CHARS = { cjk: 80, latin: 110 };
const LONG_PARAGRAPH_SENTENCES = 4;
const MIN_SENTENCES_TO_JUDGE = 4;

/**
 * Sentence boundaries, which are not the same mark in both scripts.
 *
 * A CJK full stop always ends a sentence. A Latin full stop only does when whitespace follows: without
 * that condition `config.ts` and `server/src/index.ts` split one Japanese sentence into four
 * fragments, every fragment fell under the minimum length, and a plainly written-out reply measured
 * as terse.
 */
const SENTENCE_SPLIT = /(?<=[。！？])\s*|(?<=[.!?])\s+/;

/** Is this reply mostly CJK? Decides which mean threshold applies. */
function isCjk(text) {
  const cjk = (text.match(/[぀-ヿ㐀-䶿一-鿿]/g) ?? [])
    .length;
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk > letters;
}

/**
 * Below this, a run of text is a fragment rather than a sentence.
 *
 * The style is made of fragments, so counting them as sentences measures compliance and reports it as
 * drift. Only runs long enough to be written-out prose are counted, in the mean and in the paragraph
 * density alike.
 */
const SENTENCE_CHARS = 40;

const sentencesIn = (block) =>
  block
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= SENTENCE_CHARS);

function structuralMarkers(text) {
  const prose = proseOf(text);
  if (!prose.trim()) return [];

  const sentences = sentencesIn(prose);

  // Too little written-out prose to judge. A reply that is mostly fragments, table and code is
  // already terse, and a mean taken over one or two sentences says nothing.
  if (sentences.length < MIN_SENTENCES_TO_JUDGE) return [];

  const found = [];

  const limit = isCjk(prose)
    ? MEAN_SENTENCE_CHARS.cjk
    : MEAN_SENTENCE_CHARS.latin;
  const mean =
    sentences.reduce((total, sentence) => total + sentence.length, 0) /
    sentences.length;
  if (mean > limit) {
    found.push(`mean sentence length ${Math.round(mean)} chars, over ${limit}`);
  }

  const longest = prose
    .split(/\n\s*\n/)
    .map((paragraph) => sentencesIn(paragraph).length)
    .reduce((most, count) => Math.max(most, count), 0);
  if (longest >= LONG_PARAGRAPH_SENTENCES) {
    found.push(`a paragraph of ${longest} written-out sentences`);
  }

  return found;
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

/*
 * Two independent grounds for refusal, checked separately on purpose.
 *
 * A reply drifts in one of two ways and they do not co-occur: it says a forbidden phrase, or it is
 * written out in full sentences that contain no forbidden phrase at all. Summing them behind one
 * threshold would mean a reply needed a word AND a shape to be caught, and the shape-only reply — the
 * one that actually happens on a long session — would keep passing.
 */
const lexical = findMarkers(reply);
const structural = structuralMarkers(reply);
const refuse = lexical.length >= THRESHOLD || structural.length > 0;
if (!refuse) process.exit(0);
if (!claimObjection(payload.session_id, reply)) process.exit(0);

const reasons = [];
if (lexical.length >= THRESHOLD) {
  reasons.push(
    `forbidden markers ${lexical.map((marker) => `"${marker}"`).join(", ")}`,
  );
}
if (structural.length > 0) {
  reasons.push(`written-out prose (${structural.join("; ")})`);
}

process.stderr.write(
  `context-toolkit: this reply drifted out of caveman ultra — ${reasons.join(" and ")}. ` +
    `Rewrite it in caveman ultra: fragments over sentences, one statement per line, drop filler, ` +
    `pleasantries and hedging, drop decorative arrows and emoji. Keep every technical fact, code ` +
    `block, API name and error string verbatim, and keep the same content — this is a compression, ` +
    `not a cut. Auto-Clarity still applies: security warnings, irreversible-action confirmations and ` +
    `multi-step sequences may use plain prose where compression would risk a misread.\n`,
);
process.exit(2);

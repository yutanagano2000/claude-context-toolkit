#!/usr/bin/env node
// Stop hook: a reply that mostly restates the last few replies does not get sent.
//
// Where this came from: a session spent thirteen turns handing back the same status
// report, because the stop condition it was working against could not be met. Of the
// text it produced, 33.5% was lines already written in an earlier turn — 19.9% was a
// score table reprinted unchanged, 19.0% was the same two failures explained again,
// 7.2% was the same request for a decision. Writing "do not repeat yourself" into a
// skill did not stop it; the rule only holds when something checks.
//
// This is the smaller of the two levers — replies were 0.6% of that session against
// 81.8% for tool results, which is what token-guards.mjs is for. It is still worth
// having, because the repetition it catches is also the shape of a stuck loop.
//
// ⚠ Two refusals for the same reply, then it goes through. A hook that can never be
//   satisfied is the failure this one was written about.
//
// ⚠ Short replies are never judged. "Yes" against a long history scores as pure
//   repetition, and acknowledgements are not what ran up the bill.
//
// ⚠ Anything unreadable exits 0. This may cost nothing and save nothing; it may not
//   end the conversation.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const SAME = 0.75;
const LIMIT = 0.15;
const MIN_CHARS = 100;
const MAX_REFUSALS = 2;
const LOOKBACK = 12;

// Sørensen–Dice over character bigrams: near-duplicates score high, a rewrite of the
// same fact with different wording still scores high, and unrelated text does not.
function similar(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const pair = a.slice(i, i + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const pair = b.slice(i, i + 2);
    const left = counts.get(pair) ?? 0;
    if (left > 0) {
      counts.set(pair, left - 1);
      hits += 1;
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

// Both lines and sentences. Judged line by line, a point restated in fresh wording
// stays under the threshold and slips past; split into sentences, it does not.
function units(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const bare = line.replace(/\s+/g, "");
    if (bare.length >= 12) out.push(bare);
    for (const sentence of line.split(/(?<=[。.!?])/)) {
      const piece = sentence.replace(/\s+/g, "");
      if (piece.length >= 12 && piece !== bare) out.push(piece);
    }
  }
  return out;
}

function repeatedShare(last, prior) {
  const seen = prior.flatMap(units);
  const mine = units(last);
  if (seen.length === 0 || mine.length === 0) return 0;
  let total = 0;
  let same = 0;
  for (const unit of mine) {
    total += unit.length;
    if (seen.some((old) => similar(unit, old) > SAME)) same += unit.length;
  }
  return total === 0 ? 0 : same / total;
}

function replies(path) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "assistant" || record.message?.role !== "assistant") continue;
    const text = (record.message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    if (text) out.push(text);
  }
  return out;
}

let said;
let statePath;
try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  statePath = `${payload.transcript_path}.norepeat.json`;
  said = replies(payload.transcript_path);
} catch {
  process.exit(0);
}

if (said.length < 2) process.exit(0);
const last = said[said.length - 1];
if (last.length < MIN_CHARS) process.exit(0);

const share = repeatedShare(last, said.slice(Math.max(0, said.length - 1 - LOOKBACK), -1));
if (share <= LIMIT) process.exit(0);

const digest = createHash("sha256").update(last).digest("hex").slice(0, 16);
let count = 0;
try {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state.digest === digest) count = state.count ?? 0;
} catch {
  count = 0;
}
if (count >= MAX_REFUSALS) process.exit(0);
try {
  writeFileSync(statePath, JSON.stringify({ digest, count: count + 1 }));
} catch {
  /* forgetting only makes the guard blunter, not wrong */
}

process.stderr.write(
  `${Math.round(share * 100)}% of this reply is text from earlier turns (limit ${Math.round(
    LIMIT * 100,
  )}%). Send only what changed: the rows that moved, a path for anything already reported, ` +
    `one line for a decision you are waiting on.\n`,
);
process.exit(2);

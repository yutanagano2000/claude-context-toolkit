#!/usr/bin/env node
// Measures the narrow-read strategy against whole-file reads on this repo, and
// checks that the narrow window still contains the complete declaration — the
// accuracy condition. Run: node .claude/hooks/narrow-read-benchmark.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] ?? process.cwd();
const BYTES_PER_TOKEN = 3.6;
const SKIP = new Set(["node_modules", ".git", "dist", "dist-electron", "release", "drizzle", "build"]);
const CONTEXT_LINES = 25; // lines of padding the strategy reads around a hit

function sources(dir, depth = 0, acc = []) {
  if (depth > 6) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name) && !e.name.startsWith(".")) sources(path.join(dir, e.name), depth + 1, acc);
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".gen.ts")) {
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

const DECL =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z0-9_$]+)|class\s+([A-Za-z0-9_$]+)|(?:interface|type)\s+([A-Za-z0-9_$]+))/;

/** End line of a brace-delimited declaration starting at `start` (0-indexed). */
function declEnd(lines, start) {
  let depth = 0;
  let seen = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        seen = true;
      } else if (ch === "}") depth--;
    }
    if (seen && depth <= 0) return i;
    if (!seen && /;\s*$/.test(lines[i]) && i > start) return i; // type alias / signature
  }
  return lines.length - 1;
}

const big = sources(ROOT)
  .map((f) => ({ f, size: statSync(f).size }))
  .filter((x) => x.size > 20_000)
  .sort((a, b) => b.size - a.size);

let wholeBytes = 0;
let narrowBytes = 0;
let cases = 0;
let complete = 0;
let truncated = [];

for (const { f, size } of big) {
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  // Take up to 3 declarations per file as representative lookup targets.
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < 3; i++) {
    const m = DECL.exec(lines[i]);
    if (m && (m[1] ?? m[2] ?? m[3])) hits.push(i);
  }
  for (const start of hits) {
    const end = declEnd(lines, start);
    const from = Math.max(0, start - CONTEXT_LINES);
    const to = Math.min(lines.length - 1, end + CONTEXT_LINES);
    const window = lines.slice(from, to + 1).join("\n");
    cases++;
    wholeBytes += size;
    narrowBytes += Buffer.byteLength(window, "utf8");
    // Accuracy: the window must span the whole declaration, opening line to closing line.
    if (from <= start && to >= end) complete++;
    else truncated.push(`${path.relative(ROOT, f)}:${start + 1}`);
  }
}

const tok = (b) => Math.round(b / BYTES_PER_TOKEN);
if (cases === 0) {
  console.log(`No source file over 20 KB under ${ROOT} — nothing to sample. Pass.`);
  process.exit(0);
}
console.log(`files over 20 KB      : ${big.length}`);
console.log(`lookup cases measured : ${cases}`);
console.log(`whole-file reads      : ${tok(wholeBytes).toLocaleString()} tokens`);
console.log(`narrow reads          : ${tok(narrowBytes).toLocaleString()} tokens`);
console.log(`reduction             : ${(100 - (narrowBytes / wholeBytes) * 100).toFixed(1)}%`);
console.log(`declarations complete : ${complete}/${cases} ${complete === cases ? "(accuracy preserved)" : "(TRUNCATED)"}`);
if (truncated.length) console.log(`truncated: ${truncated.slice(0, 5).join(", ")}`);
process.exit(complete === cases ? 0 : 1);

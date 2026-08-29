#!/usr/bin/env node
// PreToolUse(Read) guard: a whole-file Read of a large source file costs tens of
// thousands of tokens and buries the part that matters. When one is about to
// happen, this hook returns a symbol outline with line numbers so the read can be
// narrowed to `offset`/`limit` without losing fidelity on the code being changed.
//
// Advisory only — it never blocks. Wired up from .claude/settings.local.json.

import { readFileSync, statSync } from "node:fs";

const THRESHOLD_BYTES = 20_000;
const MAX_SYMBOLS = 40;
const BYTES_PER_TOKEN = 3.6;

const SYMBOL_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z0-9_$]+)/,
  /^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function|\([^)]*\)\s*(?::[^=]+)?=>|<)/,
  /^\s*(?:export\s+)?(?:async\s+)?def\s+([A-Za-z0-9_]+)/,
  /^\s*(?:export\s+)?class\s+([A-Za-z0-9_]+)\s*[:(]/,
];

function outline(text) {
  const lines = text.split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    for (const re of SYMBOL_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        found.push(`${i + 1}: ${m[1]}`);
        break;
      }
    }
    if (found.length >= MAX_SYMBOLS) break;
  }
  return { found, total: lines.length };
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const input = payload.tool_input ?? {};
const filePath = input.file_path;
if (payload.tool_name !== "Read" || !filePath) process.exit(0);
if (input.offset != null || input.limit != null) process.exit(0);
if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|swift|kt|sql|md|json|ya?ml)$/i.test(filePath)) process.exit(0);

let size;
try {
  const st = statSync(filePath);
  if (!st.isFile()) process.exit(0);
  size = st.size;
} catch {
  process.exit(0);
}
if (size <= THRESHOLD_BYTES) process.exit(0);

const approxTokens = Math.round(size / BYTES_PER_TOKEN);
let body = `Whole-file Read of ${filePath} — ${(size / 1024).toFixed(0)} KB, roughly ${approxTokens.toLocaleString()} tokens.`;

try {
  const { found, total } = outline(readFileSync(filePath, "utf8"));
  body += ` ${total} lines.`;
  if (found.length) {
    body +=
      `\nTop-level symbols (line: name)${found.length >= MAX_SYMBOLS ? `, first ${MAX_SYMBOLS}` : ""}:\n` +
      found.join("\n");
  }
} catch {
  /* outline is best-effort */
}

body +=
  `\nIf you need one region, Grep -n for the anchor and Read with offset/limit around it — include the whole enclosing declaration. ` +
  `Read the file whole when you genuinely need all of it (rewriting it, or auditing every line).`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: body,
    },
  }),
);
process.exit(0);

#!/usr/bin/env node
// PreToolUse guard for the three ways a turn quietly gets expensive.
//
// Measured on one 3.82M-token session (o200k_base): tool results were 81.8% of it,
// `Read` was 97.2% of those, and images were 97.2% of the Reads — 3,037,845 tokens
// spent looking at pictures at full size. The remaining levers were far smaller but
// still real: rewriting an existing file whole cost 92,510 where the same work done
// with `Edit` cost 8,944, and piping long scripts into Bash cost 88,338.
//
// So three rules, each one aimed at a number that was actually paid:
//   - an image whose pixel count is over the limit, when a thumbnail would do
//   - a whole-file Read of something large with no offset/limit
//   - a whole-file Write over an existing file, and a long heredoc into a shell
//
// `read-size-guard.mjs` already answers the second case for source files by
// returning a symbol outline instead of blocking, so this hook leaves those alone
// and only speaks up for the kinds it does not cover.
//
// ⚠ A guard that never relents is its own outage. The same request is refused twice
//   and then allowed, so a deliberate read is never impossible — only inconvenient.
//
// ⚠ Never fail closed. Anything unreadable, unparseable or unexpected exits 0: this
//   hook is allowed to cost nothing and save nothing, but never to stop the work.

import { createHash } from "node:crypto";
import { mkdirSync, openSync, readFileSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Roughly 1200x1000. A 1500x1060 screenshot measured close to 50,000 tokens; the
// same picture at 1100px on its long side is under 10,000 and still readable.
const MAX_PIXELS = 1_200_000;

// Anything past this, read whole, lands in the conversation whole.
const MAX_BYTES = 20_000;

// Rewriting a file smaller than this costs less than the round trip of an Edit.
const MAX_REWRITE_BYTES = 2_000;

// A script longer than this belongs in a file or in ctx_execute, not in an argument.
const MAX_INLINE_SCRIPT = 2_000;

const MAX_REFUSALS = 2;

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

// Kinds read-size-guard.mjs already handles by returning an outline.
const OUTLINED_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|swift|kt|sql|md|json|ya?ml)$/i;

// Dimensions from the file header alone. Node ships no image decoder, and pulling
// one in for a number that sits in the first few dozen bytes would be a dependency
// every machine then has to have.
function dimensions(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(64_000);
    const got = readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, got);

    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") {
      return buf.readUInt32BE(16) * buf.readUInt32BE(20);
    }
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buf[i + 1];
        // SOF0..SOF15, minus the four that are not frame headers.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return buf.readUInt16BE(i + 7) * buf.readUInt16BE(i + 5);
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
    if (buf.length > 10 && buf.toString("ascii", 0, 3) === "GIF") {
      return buf.readUInt16LE(6) * buf.readUInt16LE(8);
    }
    if (buf.length > 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      return Math.abs(buf.readInt32LE(18)) * Math.abs(buf.readInt32LE(22));
    }
    if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const kind = buf.toString("ascii", 12, 16);
      if (kind === "VP8X") return (1 + buf.readUIntLE(24, 3)) * (1 + buf.readUIntLE(27, 3));
      if (kind === "VP8 ") return buf.readUInt16LE(26) * buf.readUInt16LE(28);
      if (kind === "VP8L") {
        const bits = buf.readUInt32LE(21);
        return ((bits & 0x3fff) + 1) * (((bits >> 14) & 0x3fff) + 1);
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

function sizeOf(path) {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function reason(tool, input) {
  const filePath = input.file_path;

  if (tool === "Write" && filePath) {
    const size = sizeOf(filePath);
    if (size === null || size <= MAX_REWRITE_BYTES) return null;
    return (
      `This file already holds ${size.toLocaleString()} bytes, and a whole-file Write puts all of it ` +
      `in the conversation — measured at 92,510 tokens for that habit against 8,944 for the same work ` +
      `done with Edit. Edit the part that changes. Call the same Write again to overwrite anyway.`
    );
  }

  if (tool === "Bash" || tool === "PowerShell") {
    const command = input.command ?? "";
    if (command.length <= MAX_INLINE_SCRIPT) return null;
    if (!command.includes("<<") && !command.includes(" -c ")) return null;
    return (
      `The script inlined here is ${command.length.toLocaleString()} characters and both it and its ` +
      `output land in the conversation. If it derives an answer, run it through ctx_execute; if it ` +
      `edits a file, use Edit. Call the same command again to run it here anyway.`
    );
  }

  if (tool !== "Read" || !filePath) return null;
  if (input.offset != null || input.limit != null) return null;

  if (IMAGE_RE.test(filePath)) {
    const px = dimensions(filePath);
    if (px === null || px <= MAX_PIXELS) return null;
    return (
      `That image is ${px.toLocaleString()} pixels; read whole it costs tens of thousands of tokens ` +
      `(limit ${MAX_PIXELS.toLocaleString()}). Shrink it first and read the small one:\n` +
      `  python -c "from PIL import Image; Image.MAX_IMAGE_PIXELS=None; im=Image.open(r'${filePath}'); ` +
      `im.thumbnail((1100,1100)); im.save(r'${filePath}.small.jpg', quality=85)"\n` +
      `For one region, crop before shrinking. Call the same Read again to read it at full size anyway.`
    );
  }

  // read-size-guard.mjs already outlines these kinds; leave them to it.
  if (OUTLINED_RE.test(filePath)) return null;
  const size = sizeOf(filePath);
  if (size === null || size <= MAX_BYTES) return null;
  return (
    `That file is ${size.toLocaleString()} bytes and reading it whole keeps all of it in the ` +
    `conversation (limit ${MAX_BYTES.toLocaleString()}). Grep -n for the anchor and Read with ` +
    `offset/limit around it. Call the same Read again to read it whole anyway.`
  );
}

function refusals(key) {
  const dir = process.env.TOKEN_GUARDS_STATE_DIR || join(tmpdir(), "context-toolkit-guards");
  const file = join(dir, `${key}.json`);
  let count = 0;
  try {
    count = JSON.parse(readFileSync(file, "utf8")).count ?? 0;
  } catch {
    count = 0;
  }
  return {
    count,
    bump() {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, JSON.stringify({ count: count + 1 }));
      } catch {
        /* a guard that cannot remember still guards, just less politely */
      }
    },
  };
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

let why = null;
try {
  why = reason(payload.tool_name ?? "", payload.tool_input ?? {});
} catch {
  process.exit(0);
}
if (!why) process.exit(0);

const key = createHash("sha256")
  .update(JSON.stringify([payload.tool_name, payload.tool_input]))
  .digest("hex")
  .slice(0, 16);
const state = refusals(key);
if (state.count >= MAX_REFUSALS) process.exit(0);
state.bump();

process.stderr.write(`${why}\n`);
process.exit(2);

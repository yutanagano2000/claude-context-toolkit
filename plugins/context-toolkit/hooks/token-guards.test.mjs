// Cases for token-guards.mjs. Run: node hooks/token-guards.test.mjs
//
// The guard has to be judged in both directions. A hook that blocks everything
// passes a one-sided suite, and a hook that blocks nothing passes the other half,
// so every rule here has a matching case that must still go through.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./token-guards.mjs", import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), "token-guards-"));
let failed = 0;

function run(payload) {
  try {
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, TOKEN_GUARDS_STATE_DIR: DIR },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

function check(name, got, want) {
  if (got === want) {
    console.log(`ok   ${name}`);
  } else {
    console.log(`NG   ${name} (exit ${got}, expected ${want})`);
    failed = 1;
  }
}

// A PNG large enough to cost real tokens, and one that is not. Only the IHDR
// header is read, so the pixel data can stay a stub.
function png(name, width, height) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  const path = join(DIR, name);
  writeFileSync(
    path,
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ihdr]),
  );
  return path;
}

const bigPng = png("big.png", 3000, 2000);
const smallPng = png("small.png", 800, 600);
const bigFile = join(DIR, "big.rs");
writeFileSync(bigFile, "// a line\n".repeat(4000));
const smallFile = join(DIR, "small.rs");
writeFileSync(smallFile, "// a line\n".repeat(4));

const read = (input) => run({ tool_name: "Read", tool_input: input });
const write = (input) => run({ tool_name: "Write", tool_input: input });
const bash = (command) => run({ tool_name: "Bash", tool_input: { command } });

check("blocks a large image", read({ file_path: bigPng }), 2);
check("lets a small image through", read({ file_path: smallPng }), 0);
check("lets a narrowed read through", read({ file_path: bigPng, limit: 50 }), 0);
check("ignores a missing file", read({ file_path: join(DIR, "nope.png") }), 0);

check("blocks rewriting a large file", write({ file_path: bigFile, content: "x" }), 2);
check("lets a new file through", write({ file_path: join(DIR, "new.rs"), content: "x" }), 0);
check("lets a small rewrite through", write({ file_path: smallFile, content: "x" }), 0);

check("blocks a long heredoc", bash(`python - <<PY\n# ${"a".repeat(2500)}\nPY`), 2);
check("lets a short heredoc through", bash("python - <<PY\nprint(1)\nPY"), 0);
check("ignores an ordinary command", bash("ls -la"), 0);

// A guard that never gives up would replace the cost it was written to remove
// with a wall nothing gets past.
read({ file_path: bigPng });
check("gives up after two refusals", read({ file_path: bigPng }), 0);

rmSync(DIR, { recursive: true, force: true });
process.exit(failed);

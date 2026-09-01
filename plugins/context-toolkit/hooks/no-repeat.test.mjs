// Cases for no-repeat.mjs. Run: node hooks/no-repeat.test.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./no-repeat.mjs", import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), "no-repeat-"));
let failed = 0;

function transcript(name, replies) {
  const path = join(DIR, name);
  writeFileSync(
    path,
    replies
      .map((text) =>
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text }] },
        }),
      )
      .join("\n") + "\n",
  );
  return path;
}

function run(path) {
  try {
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify({ transcript_path: path }),
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

// Long enough to be judged: the guard ignores short replies, because "yes" repeated
// is not the thing that ran up the bill.
const REPORT =
  "Re-scored the table. Pixel size is green at 9925x7017. The ring is green at 99.53m. " +
  "The outline is red at 5.88m against a 3m tolerance. The 地番 match is red at 88.5% " +
  "against a 95% line. The judge script still exits 1. Nothing further to try; your call.";
const FRESH =
  "Picked the rose-coloured boundary up as an area rather than a line. The panel grid sits " +
  "within 2m of the edge, so depth cannot separate them. Measuring the colour threshold next.";

check("blocks a reply that only repeats", run(transcript("same.jsonl", [REPORT, REPORT])), 2);
check("lets a new reply through", run(transcript("fresh.jsonl", [REPORT, FRESH])), 0);
check("lets the first reply through", run(transcript("first.jsonl", [REPORT])), 0);
check(
  "ignores a short reply",
  run(transcript("short.jsonl", [REPORT, "Done."])),
  0,
);

// Refusing forever would be the same failure this hook exists to prevent.
const loop = transcript("loop.jsonl", [REPORT, REPORT]);
run(loop);
run(loop);
check("gives up after two refusals", run(loop), 0);

rmSync(DIR, { recursive: true, force: true });
process.exit(failed);

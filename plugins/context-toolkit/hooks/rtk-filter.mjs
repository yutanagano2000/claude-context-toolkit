#!/usr/bin/env node
/**
 * The rtk bash filter, installed in two places without ever running twice.
 *
 * WHY TWO PLACES. Every other part of this toolkit is installed both in the plugin's own hooks and in
 * the user's `settings.json`, so that disabling the plugin does not silently remove it. rtk was the
 * exception: it lived only in the plugin, and turning the plugin off took the single largest source
 * of token savings with it and said nothing.
 *
 * WHY THAT WAS LEFT ALONE UNTIL NOW. `rtk hook claude` REWRITES the command it is given. Two copies
 * firing on one call would hand the second copy a command the first had already rewritten, which is
 * not a filter applied twice — it is a filter applied to its own output, and what comes out the far
 * side is not the command anybody asked for.
 *
 * HOW BOTH CAN EXIST. This wrapper claims a per-call lease before delegating to rtk. The claim is a
 * file named for a hash of the command and the session, created with the exclusive flag: whichever
 * copy gets there first does the rewrite, and the other passes stdin through untouched. Neither copy
 * has to know the other exists, which is what makes the plugin and the settings entry independent.
 *
 * FAILS OPEN, AS A PASS-THROUGH. No rtk, no temp directory, a crash: stdin reaches stdout unchanged
 * and the command runs as written. A filter that cannot filter must not be a filter that blocks.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const raw = (() => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
})();

/** Hand the payload back unchanged and stop. The command runs exactly as it was written. */
function passThrough() {
  process.stdout.write(raw);
  process.exit(0);
}

if (!raw.trim()) passThrough();

/**
 * Claim the right to rewrite this one call.
 *
 * Keyed on the payload itself rather than on a session id, because the same session legitimately runs
 * the same command twice and both should be filtered — what must not happen is two hooks filtering
 * ONE call. Two identical calls in the same millisecond would collide here and the second would pass
 * through unfiltered, which costs tokens and breaks nothing.
 */
function claim() {
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  const directory = join(tmpdir(), "context-toolkit-rtk");
  try {
    mkdirSync(directory, { recursive: true });
    // wx: create, or fail because somebody else already did.
    closeSync(openSync(join(directory, `${digest}.claim`), "wx"));
    return true;
  } catch {
    return false;
  }
}

if (!claim()) passThrough();

const result = spawnSync(
  "rtk",
  ["hook", "claude", "--ultra-compact", "--skip-env"],
  { input: raw, encoding: "utf8", timeout: 10_000, shell: false },
);

// A missing binary, a non-zero exit, or nothing on stdout all mean the same thing here: this machine
// cannot filter, so it must not mangle.
if (result.error || result.status !== 0 || !result.stdout) passThrough();

process.stdout.write(result.stdout);
process.exit(0);

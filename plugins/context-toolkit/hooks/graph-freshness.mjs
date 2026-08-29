#!/usr/bin/env node
/**
 * Keep the code-review-graph pointing at the commit that is actually checked out.
 *
 * THE GAP THIS CLOSES. The `PostToolUse` hook beside this one updates the graph after an Edit or a
 * Write, which covers a session that types code. It does not cover a session that MOVES code: a
 * `git merge`, `checkout`, `pull`, `rebase` or `switch` can replace hundreds of files without a
 * single Edit, and the graph goes on answering from the tree that was there before. That failure is
 * silent and expensive in the direction that matters — the answers still look like answers, they are
 * just about a commit nobody has any more.
 *
 * TWO ENTRY POINTS, one script. `session` compares the graph's stored commit against HEAD once at
 * startup, which catches every branch change made while no session was running. `bash` reads the
 * command a session just ran and updates when it was one of the tree-moving ones. Together they mean
 * the graph is stale only for the length of one tool call.
 *
 * ALWAYS INCREMENTAL. `update` re-parses changed files and leaves the rest, so the common case after
 * a merge is a second or two. A full `build` is minutes and is never what a hook should start.
 *
 * FAILS OPEN, AND QUIETLY. No graph, no repository, no binary, an update that errors: every one of
 * them ends at exit 0 with the tool call untouched. A stale graph is a cost; a hook that blocks a
 * session is an outage.
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Commands that can replace the working tree without any Edit or Write. */
const TREE_MOVING = /\bgit\s+(checkout|switch|merge|pull|rebase|reset|cherry-pick|stash)\b/;

const mode = process.argv[2] === "session" ? "session" : "bash";

function readPayload() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/** Run a command for its output, or null if it fails for any reason. */
function output(file, args, cwd) {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * When the most recently modified tracked file was written, or null if that cannot be established.
 *
 * Tracked only, from `git ls-files`, so a node_modules install or a build directory does not read as
 * a source change and start an update that finds nothing. Capped, because a repository with tens of
 * thousands of files would spend longer being measured than being updated — and a repository that
 * large has almost certainly touched one of the first few thousand anyway.
 */
function newestTrackedFile(root) {
  const listed = output("git", ["ls-files", "-z"], root);
  if (!listed) return null;
  const paths = listed.split("\0").filter(Boolean).slice(0, 4000);
  let newest = 0;
  for (const relative of paths) {
    try {
      const at = statSync(join(root, relative)).mtimeMs;
      if (at > newest) newest = at;
    } catch {
      // Deleted between listing and stat, or unreadable. Neither is a reason to stop.
    }
  }
  return newest === 0 ? null : newest;
}

const payload = readPayload();
const cwd = payload?.cwd ?? process.cwd();

const root = output("git", ["rev-parse", "--show-toplevel"], cwd);
if (!root) process.exit(0);

if (mode === "bash") {
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || !TREE_MOVING.test(command)) process.exit(0);
} else {
  /*
   * Only when the working tree has moved since the graph last read it.
   *
   * NOT `Built at commit`, which is the obvious-looking field and the wrong one: `build` stamps it
   * and `update` does not, so a graph kept current by incremental updates goes on reporting the
   * commit it was first built at forever. Comparing HEAD against it means every session finds a
   * mismatch that no amount of updating can clear, and runs an update that reports zero files.
   *
   * `Last updated` against the newest tracked file is the honest comparison: it asks whether
   * anything has changed on disk since the graph last looked, which is the actual question.
   */
  const status = output("code-review-graph", ["status", "--repo", root], root);
  if (!status) process.exit(0);
  const stamp = status.match(/Last updated:\s*(\S+)/)?.[1];
  // "never", or no graph at all. An update on nothing is a no-op that prints a hint.
  if (!stamp || stamp === "never") process.exit(0);

  const updatedAt = Date.parse(stamp);
  if (!Number.isFinite(updatedAt)) process.exit(0);

  const newest = newestTrackedFile(root);
  if (newest !== null && newest <= updatedAt) process.exit(0);
}

/*
 * Detached, and not waited for.
 *
 * A merge that touched five hundred files takes longer than a hook should hold a session open, and
 * the result is wanted by the NEXT question rather than by this tool call. Unref'd so the session
 * can exit without it, with output discarded because nothing reads it.
 */
try {
  const child = spawn(
    "code-review-graph",
    ["update", "--skip-flows", "--repo", root],
    { cwd: root, detached: true, stdio: "ignore", shell: false },
  );
  child.unref();
} catch {
  // No binary on this machine. Nothing to do and nothing to say.
}

process.exit(0);

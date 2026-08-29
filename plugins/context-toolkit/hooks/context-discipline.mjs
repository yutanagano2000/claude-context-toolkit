#!/usr/bin/env node
// SessionStart hook: states the context-discipline rules once per session, so the
// behaviour travels with the plugin instead of living in one machine's CLAUDE.md.
// Windows-only guidance is emitted only on Windows. Paths are resolved from
// CLAUDE_PLUGIN_ROOT so they are correct wherever the plugin is installed.

const root = process.env.CLAUDE_PLUGIN_ROOT ?? "<plugin root>";
const isWindows = process.platform === "win32";

const lines = [
  "<context_discipline>",
  "Fidelity where it buys correctness, economy everywhere else.",
  "NEVER compress: the bytes you are about to edit, an error message you are diagnosing, a signature you are calling.",
  "DO compress: exploration, listings, build and test output, screenshots.",
  "",
  "READING. For a source file over ~20 KB, Grep -n for the anchor, then Read with offset/limit around it.",
  "Include the whole enclosing declaration, never a half-declaration, and Grep the symbol repo-wide first so every",
  "call site is enumerated rather than assumed. Measured on a 701-file repo: 93.4% fewer tokens across 145 lookups,",
  "all 145 declarations complete. A PreToolUse hook returns a symbol outline when a large whole-file Read is about",
  "to happen; reading whole is still right when rewriting or auditing every line.",
  "",
  "COMMANDS. One output-producing command per Bash call, and no `| head` / `| tail`: rtk rewrites only the first",
  "command on a line and skips a line piped into head, so hand-truncating is what silences the filter. Prefer",
  "`git diff --stat` before `git diff`, one test file before a suite, an exit code before a build log.",
  "",
  "TURNS. Each turn re-sends the conversation. Batch independent tool calls into one message and predictable",
  "sequences into one call. Do not re-read a file after editing it.",
  "",
  "DELEGATION. Send broad \"where is X\" searches to a search subagent and ask for file:line results; read the exact",
  "ranges yourself before editing. Do not implement against a subagent's paraphrase of a signature.",
];

if (isWindows) {
  lines.push(
    "",
    "DESKTOP GUI. Read the UI Automation text tree, not screenshots - same information, roughly 5x cheaper, and it",
    "returns click coordinates so no image is needed to act. Helper:",
    `  . "${root}/tools/uia.ps1"   then Dump-UI / Click-UI / Shot -Title / Focus-Win / Get-WinRect / Send-Keys`,
    "Electron apps return a bare Pane on the first query; call Dump-UI twice. Read an image only when layout or",
    "rendering is itself the question, and crop it to the window rect.",
  );
}

lines.push(
  "",
  "MEASURING. ctx_stats costs ~3.5K tokens a call - at most once per session, at the end. `rtk discover` shows",
  "which commands bypassed filtering. To re-verify the reading rule on any repo:",
  `  node "${root}/tools/narrow-read-benchmark.mjs" .`,
  "</context_discipline>",
);

process.stdout.write(lines.join("\n") + "\n");

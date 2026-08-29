---
description: Verify on this machine that the context-discipline pieces work — narrow-read reduction, its accuracy check, the large-Read outline hook, and the UIA helper
allowed-tools: [Bash, Read]
---

Check that this machine's install actually reduces tokens without losing fidelity, and report a short checklist.

1. Run the narrow-read benchmark against the current repository:
   `node "${CLAUDE_PLUGIN_ROOT}/tools/narrow-read-benchmark.mjs" .`
   Report its `reduction` and `declarations complete` lines verbatim. It exits
   non-zero if any sampled declaration was truncated — that is the accuracy
   condition, so a non-zero exit is a failure, not a warning.
2. Exercise the large-Read outline hook on the biggest source file in the repo:
   pipe `{"tool_name":"Read","tool_input":{"file_path":"<that file>"}}` into
   `node "${CLAUDE_PLUGIN_ROOT}/hooks/read-size-guard.mjs"` and confirm it
   returns `hookSpecificOutput.additionalContext` with a symbol list. Report the
   file's whole-read token estimate against the outline's size.
3. Confirm the SessionStart rules render:
   `node "${CLAUDE_PLUGIN_ROOT}/hooks/context-discipline.mjs"` — it should print
   a `<context_discipline>` block, with the desktop-GUI section present only on
   Windows.
4. On Windows only, confirm the UIA helper loads:
   `. "${CLAUDE_PLUGIN_ROOT}/tools/uia.ps1"` then `Get-Command Dump-UI` in
   PowerShell.
5. If a repository has no source file over 20 KB, say so — the benchmark has
   nothing to sample and that is a pass, not a failure.

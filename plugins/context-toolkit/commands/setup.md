---
description: Install/verify the binaries this plugin's hooks depend on (rtk, code-review-graph) and add context-mode from its own marketplace
allowed-tools: [Bash, Read]
---

Run the setup script for this plugin and report a short checklist of what is
now installed vs. still missing.

1. Detect OS. On Windows without a POSIX shell available, run
   `${CLAUDE_PLUGIN_ROOT}/scripts/install.ps1` via PowerShell; otherwise run
   `${CLAUDE_PLUGIN_ROOT}/scripts/install.sh` via bash.
2. Show the script's `[OK]` / `[FAIL]` / `[SKIP]` lines to the user verbatim —
   do not paraphrase them.
3. For any `[FAIL]`, tell the user the exact manual command from the script's
   output.
4. Report whether `node` is on PATH. The context-discipline SessionStart hook
   and the large-Read symbol outline are plain Node scripts; without `node`
   both degrade to no-ops and the rest of the plugin still works.
5. Do not install anything beyond what the script does, and do not touch
   `~/.claude/settings.json` or `~/.claude/CLAUDE.md` — the plugin's own
   hooks/skills are enough once the binaries above exist.

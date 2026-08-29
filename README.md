# claude-context-toolkit

Personal Claude Code marketplace. Bundles `caveman` (terse output style) and
the hooks for `rtk` (bash-output filter) and `code-review-graph` (incremental
review graph) into one plugin: `context-toolkit`.

`context-mode` is **not** bundled — it is already its own plugin
(`mksglu/context-mode`) and is added as a normal marketplace dependency
instead of being vendored here.

## Install on a new machine

```
/plugin marketplace add <your-github-user>/claude-context-toolkit
/plugin install context-toolkit@claude-context-toolkit
/context-toolkit:setup
```

`setup` installs the underlying binaries (`rtk` via cargo, `code-review-graph`
via pip) if missing, and adds/installs `context-mode` from its own
marketplace. Re-running it is safe — it only installs what's missing.

## What's in `context-toolkit`

| Piece | Mechanism | Effect |
|---|---|---|
| `skills/caveman` | Skill | Ultra-terse output style |
| PreToolUse (Bash) | Hook | Pipes bash output through `rtk hook claude` if `rtk` is installed, else passes through unchanged |
| PostToolUse (Edit\|Write) | Hook | `code-review-graph update --skip-flows` if installed, else no-op |
| SessionStart | Hook | `code-review-graph status` if installed, else no-op |
| UserPromptSubmit | Hook | Reminds the model to keep caveman at ultra intensity every turn |

Every hook checks `command -v <tool>` first, so a machine missing a
dependency degrades to a no-op instead of breaking tool calls.

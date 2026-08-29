# context-toolkit

See the marketplace root README for install steps. This file documents the
estimated token-reduction impact of running all four tools together, since a
true on/off A/B run on the same session isn't practical.

## Estimated token reduction (modeled, not measured)

Each tool's own documented figure targets a different slice of a session's
tokens:

| Tool | Axis | Documented figure | Source |
|---|---|---|---|
| caveman (ultra) | assistant's own output tokens | ~65% cut | skill description |
| rtk | Bash tool-call output | up to ~90% cut | RTK.md / `rtk gain` |
| context-mode | Read/Grep/WebFetch/MCP tool output | ~98% cut | plugin manifest |
| code-review-graph | file content re-read during review/navigation | large but unmeasured here (no `--verify` run) | tool's own "Token Savings panel" |

These are self-reported, not independently verified against a tokenizer in
this repo. Treat the figures below as an order-of-magnitude estimate, not a
benchmark result.

### Blended estimate

Rough split of a typical agentic coding session's total tokens:

- ~15% fixed overhead (system prompt, tool schemas) — untouched by any of these
- ~50% tool-output tokens fed back into context — this is what rtk /
  context-mode / code-review-graph target, on non-overlapping tool types
  (Bash vs. Read/Grep/fetch vs. review-graph lookups)
- ~20% assistant reply tokens — this is what caveman targets
- ~15% quoted code/diffs — preserved verbatim by all four tools, untouched

Applying each tool's figure only to its own slice:

- Tool-output slice (50% of session): weighted by roughly 30% Bash / 50%
  Read-Grep-fetch / 20% review-graph, reduced by ~90% / ~98% / ~85%
  respectively → that 50%-of-session slice shrinks to roughly 7% of its
  original size, i.e. **saves ~46 percentage points of total session
  tokens** (less, around ~38 points, in sessions where code-review-graph
  never fires — most sessions outside active PR review).
- Assistant-output slice (20% of session) cut ~65% → **saves ~13 percentage
  points**.

**Net estimate: roughly 45-60% fewer total session tokens with all four
active vs. none, ~50% as a representative midpoint.** The range depends on
how review-heavy the session is and how much of the tool-output volume is
Bash vs. file/search output.

### Caveats

- No actual toggle-off run was performed — the user's own read was that
  disabling all four and re-running the same session for comparison isn't
  practical, so this is arithmetic over each tool's own claimed figure, not
  a measurement.
- The three context-side tools (rtk, context-mode, code-review-graph) are
  assumed non-overlapping because each intercepts a different tool type
  (Bash vs. Read/Grep/WebFetch/MCP vs. graph lookups) rather than stacking
  on the same call.
- caveman's figure applies to output tokens only; it does not reduce input
  context.
- For a real number, run `rtk gain`, `ctx_stats`, and
  `code-review-graph update --verify` (needs `pip install tiktoken`) after a
  representative session and sum their reported savings.

## Measured: the context-discipline layer

Unlike the table above, these numbers came from running the code in this
plugin against a real 701-file TypeScript monorepo on 2026-08-29. Reproduce
them anywhere with `/context-toolkit:verify`.

### Narrow reads instead of whole-file reads

`tools/narrow-read-benchmark.mjs` samples up to three declarations in every
source file over 20 KB, then compares reading the whole file against reading a
window around the declaration:

```
files over 20 KB      : 54
lookup cases measured : 145
whole-file reads      : 1,484,225 tokens
narrow reads          :    97,678 tokens
reduction             : 93.4%
declarations complete : 145/145 (accuracy preserved)
```

The last line is the point. The benchmark checks by brace balance that each
window spans the declaration from its opening line to its closing brace, and
exits non-zero if any window truncated one. Reduction without that check would
be worthless — a smaller read that cuts a function in half costs more later
than it saves now.

### Symbol outline instead of a whole-file read

`hooks/read-size-guard.mjs` fires on `PreToolUse(Read)`. For a 129 KB file it
returned a 40-symbol outline with line numbers:

| | tokens |
|---|---|
| whole-file `Read` | 36,729 |
| outline from the hook | 834 |

It never blocks: reading a file whole is still correct when rewriting or
auditing every line. Overhead measured at 67-75 ms, and files under 20 KB are
skipped after a `stat`.

### UI Automation instead of screenshots

`tools/uia.ps1` (Windows) reads the accessibility tree instead of pixels:

| | tokens |
|---|---|
| full-screen PNG read (3840x1080) | ~1,500, no click coordinates |
| window-rect crop | ~400 |
| `Dump-UI` text tree | ~300, with element names and centre coordinates |

A click-then-verify round trip fell from about 3,000 tokens to about 250.
Electron apps return a bare `Pane` on the first query — Chromium enables its
accessibility tree only once it detects an AT client — so call `Dump-UI` twice.

### A correction worth carrying

`rtk` rewrites only the **first** command on a Bash line, and does not rewrite
a line piped into `head`. Verified with `rtk hook check`:

```
ls -la                             -> rtk ls -la
cd /tmp && ls -la                  -> cd /tmp && rtk ls -la
ls -la && echo x && ls sr | head   -> only the first ls is rewritten
cd sr && grep -rln "foo" . | head  -> No rewrite
```

So hand-truncating with `head`/`tail` is what silences the filter. On one
sample `rtk discover` found only 3 of 112 Bash calls (2.7%) had actually been
routed. Use `rtk read f.log --tail-lines 20` rather than `tail -20 f.log`.

## Requirements

`node` on `PATH` for the context-discipline SessionStart hook and the
large-Read outline; without it both degrade to no-ops and everything else in
the plugin still works. `tools/uia.ps1` is Windows-only.

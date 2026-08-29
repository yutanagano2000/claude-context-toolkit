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

#!/usr/bin/env bash
# context-toolkit setup: installs the binaries the bundled hooks call, and
# adds context-mode from its own marketplace. Safe to re-run.
set -u

ok()   { echo "[OK]   $1"; }
skip() { echo "[SKIP] $1"; }
fail() { echo "[FAIL] $1"; }

echo "== rtk (bash output filter) =="
if command -v rtk >/dev/null 2>&1; then
  ok "rtk already installed: $(rtk --version 2>&1)"
elif command -v cargo >/dev/null 2>&1; then
  cargo install rtk && ok "rtk installed via cargo" || fail "cargo install rtk failed"
else
  fail "no cargo found. Install Rust (https://rustup.rs) then: cargo install rtk"
fi

echo "== code-review-graph (incremental review graph) =="
if command -v code-review-graph >/dev/null 2>&1; then
  ok "code-review-graph already installed: $(code-review-graph --version 2>&1)"
elif command -v pip >/dev/null 2>&1; then
  pip install --user code-review-graph && ok "code-review-graph installed via pip" || fail "pip install code-review-graph failed"
else
  fail "no pip found. Install Python 3 then: pip install code-review-graph"
fi

echo "== context-mode (separate plugin, not bundled here) =="
if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace add mksglu/context-mode 2>&1
  claude plugin install context-mode@context-mode 2>&1
  ok "requested context-mode install via claude CLI"
else
  skip "claude CLI not on PATH here. On the target machine, inside Claude Code run:"
  echo "         /plugin marketplace add mksglu/context-mode"
  echo "         /plugin install context-mode@context-mode"
fi

echo "== caveman (terse output skill) =="
ok "bundled in this plugin (skills/caveman) — no separate install needed"
ok "the UserPromptSubmit hook nudges it to ultra intensity every turn while this plugin is enabled"

echo
echo "Done. Restart Claude Code (or start a new session) so hooks/skills register."

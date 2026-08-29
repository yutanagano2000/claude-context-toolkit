# context-toolkit setup (PowerShell). Installs the binaries the bundled hooks call,
# and adds context-mode from its own marketplace. Safe to re-run.

function Test-Cmd($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host "== rtk (bash output filter) =="
if (Test-Cmd rtk) {
    Write-Host "[OK]   rtk already installed: $(rtk --version)"
} elseif (Test-Cmd cargo) {
    cargo install rtk
    Write-Host "[OK]   rtk installed via cargo"
} else {
    Write-Host "[FAIL] no cargo found. Install Rust (https://rustup.rs) then: cargo install rtk"
}

Write-Host "== code-review-graph (incremental review graph) =="
if (Test-Cmd code-review-graph) {
    Write-Host "[OK]   code-review-graph already installed: $(code-review-graph --version)"
} elseif (Test-Cmd pip) {
    pip install --user code-review-graph
    Write-Host "[OK]   code-review-graph installed via pip"
} else {
    Write-Host "[FAIL] no pip found. Install Python 3 then: pip install code-review-graph"
}

Write-Host "== context-mode (separate plugin, not bundled here) =="
if (Test-Cmd claude) {
    claude plugin marketplace add mksglu/context-mode
    claude plugin install context-mode@context-mode
    Write-Host "[OK]   requested context-mode install via claude CLI"
} else {
    Write-Host "[SKIP] claude CLI not on PATH here. On the target machine, inside Claude Code run:"
    Write-Host "         /plugin marketplace add mksglu/context-mode"
    Write-Host "         /plugin install context-mode@context-mode"
}

Write-Host "== caveman (terse output skill) =="
Write-Host "[OK]   bundled in this plugin (skills/caveman) - no separate install needed"
Write-Host "[OK]   the UserPromptSubmit hook nudges it to ultra intensity every turn while this plugin is enabled"

Write-Host ""
Write-Host "Done. Restart Claude Code (or start a new session) so hooks/skills register."

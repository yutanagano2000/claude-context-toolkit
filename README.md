# claude-context-toolkit

Personal Claude Code marketplace. One plugin, `context-toolkit`, bundling two
layers that are only useful together:

- **Workflow skills** — `a-plus-plus` (the goal compiler) and the three skills
  its generated goal text names by hand, plus `config-gc`.
- **Context layer** — `caveman` (terse output style) and the hooks for `rtk`
  (bash-output filter) and `code-review-graph` (incremental review graph),
  plus the context-discipline hooks.

They ship as one plugin because `a-plus-plus` is written against this context
layer: its 【トークン規律】 section omits the rules the `context-discipline`
SessionStart hook injects. Installed separately, those rules go missing.

`context-mode` is **not** bundled — it is already its own plugin
(`mksglu/context-mode`) and is added as a normal marketplace dependency
instead of being vendored here.

## Install on a new machine

```
/plugin marketplace add yutanagano2000/claude-context-toolkit
/plugin install context-toolkit@claude-context-toolkit
/context-toolkit:setup
```

`setup` installs the underlying binaries (`rtk` via cargo, `code-review-graph`
via pip) if missing, and adds/installs `context-mode` from its own
marketplace. Re-running it is safe — it only installs what's missing.

Enabling the plugin for your Claude account also carries it into Claude Code
on the web / cloud sessions, where the skills work as-is and the hooks whose
binaries are absent degrade to no-ops (see **Cloud sessions** below).

## Skills

| Skill | 役割 | 出所 |
|---|---|---|
| `a-plus-plus` | 実装依頼を、機械判定可能なゴールと境界条件を持つ停止条件付きミッションへ変換し `/goal` に渡す | 自作 |
| `tdd-workflow` | RED → GREEN → REFACTOR の8段。カバレッジ 80%+、証拠レポートの生成 | [ECC](https://github.com/affaan-m/ECC) (MIT) |
| `rust-testing` | Rust のテストパターン（ユニット・結合・async・プロパティベース・モック・カバレッジ） | [ECC](https://github.com/affaan-m/ECC) (MIT) |
| `santa-method` | 独立した2レビュアーが並列に検証し、両方 PASS するまで出荷しない収束ループ | [ECC](https://github.com/affaan-m/ECC) (MIT) |
| `config-gc` | `~/.claude` の棚卸し。重複・孤児・陳腐化した設定を1件ずつ承認して削除 | [ECC](https://github.com/affaan-m/ECC) (MIT) |
| `caveman` | Ultra-terse output style | 自作 |

`a-plus-plus` が組み立てるゴール文は `tdd-workflow` / `rust-testing` /
`santa-method` を名指しで参照する。この4つは分離しないこと。`config-gc` と
`caveman` は独立していて、単体でも動く。

### `a-plus-plus` の前提

| 前提 | 欠けたときに失われるもの |
|---|---|
| `/goal` コマンド | 発動そのもの。手動でゴール文を渡せば代用可 |
| このプラグインの `context-discipline` フック | **読み込み規律**。ゴール文の【トークン規律】は SessionStart フックが注入される前提で重複分を省いてある。フックが無い環境では `skills/a-plus-plus/references/token-discipline.md` の全文をゴール文へ書き戻すこと |
| Rust ツールチェイン | `cargo test` / `cargo clippy` / `cargo fmt` を使う指標 |

ゴール文のテンプレート固定部は約 3,700 文字、上限は 4,000 文字。可変部は約
300 文字。収まらないときは固定部ではなく上限そのものを見直すこと。停止条件を
削ると、それは停止しないループになる。

`a-plus-plus` のゴール文と `references/rust.md` には Person-Pro /
Salesmachines の実装を手本とした具体例（`salesmachines_guard`、
`tool_binaries`、`toolbox/src/tiles.rs` 等）が含まれる。これらは
**手本であって実在を前提とした指示ではない**。別のリポジトリで使う場合は
同等の仕組みに読み替えること。読み替えずに渡すと、存在しないファイルを探しに行く。

## Hooks

| Piece | Mechanism | Effect |
|---|---|---|
| PreToolUse (Bash) | Hook | Pipes bash output through `rtk hook claude` if `rtk` is installed, else passes through unchanged |
| PreToolUse (Read) | Hook | Symbol outline instead of a whole-file Read over 20 KB |
| PreToolUse (Read\|Write\|Bash) | Hook | Token guards for oversized images, whole-file rewrites, inlined scripts |
| PostToolUse (Edit\|Write) | Hook | `code-review-graph update --skip-flows` if installed, else no-op |
| SessionStart | Hook | context-discipline rules, caveman self-heal, `code-review-graph status` if installed |
| UserPromptSubmit | Hook | Reminds the model to keep caveman at ultra intensity every turn |
| Stop | Hook | caveman enforcement and a guard against replies that restate earlier turns |

Every hook checks `command -v <tool>` first, so a machine missing a
dependency degrades to a no-op instead of breaking tool calls.

## Cloud sessions

In Claude Code on the web the container is a fresh clone with no `~/.claude`
state from your machine, so nothing installed by hand locally is present.
What survives is what the account carries: enable this plugin for your Claude
account and the skills arrive in every cloud session.

`rtk` (cargo) and `code-review-graph` (pip) are **not** installed in those
containers, so the hooks that call them no-op there by design. `node` is
present, so the context-discipline and read-size-guard hooks do run.

## Updating

1. Edit here, never in `~/.claude/plugins/`
2. Commit and push
3. On each machine, `/plugin update context-toolkit@claude-context-toolkit`

## License

MIT (see `LICENSE`). `tdd-workflow` / `rust-testing` / `santa-method` /
`config-gc` are from [ECC](https://github.com/affaan-m/ECC) (MIT License,
© affaan-m) and are included as-is; see `LICENSE-THIRD-PARTY`.

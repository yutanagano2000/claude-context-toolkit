# Rust の活かし方（Person-Pro / Salesmachines の実装が手本）

性能・並行・データ整合が要る層は Rust を第一候補にし、既にこのコードベースで効いている型を真似る。抽象論を書かず、下の実物と同じ形にすること。

  判別子つき union）。実行時 if を1本足して済ませない
- **型で縛れない「畳んだ形が戻ること」は build.rs の門番で落とす。**
  `salesmachines_guard::deny(&["src".as_ref(), "tests".as_ref()])` の形
  （`apps/salesmachines/native/crates/guard/`）。テストにしないのが要点 —
  テストは走らせた人にしか見えないが、build.rs なら違反 1 つで `cargo build` が落ちる。
  5つ目の同型 trait を書いても cargo build も clippy も通ってしまった実例が根拠。
  規則は層ごとに分ける（native 用と toolbox 用で一覧が別）。
  例外（`allowed_in`）は理由なしに足さない — 1 行足すたび門番は「動いて見えて
  守っていない」ものに近づく。**一覧は減らさず増える**のが値打ち
- ハング・無限ループ・無応答は機械的な上限で封じる: 全 I/O とサブプロセスに
  明示タイムアウト、リトライは回数上限つき定数バックオフ表、ループに脱出条件のアサート
- 再発防止をフック・CI に固定する（pre-push で触った workspace の lint+typecheck、
  CI で同じものを再実行）。フックを迂回する（--no-verify 等）のは禁じ手
- 配布物は内容ハッシュで縛る（Person-Pro の `tool_binaries`: sha256 を計算して
  R2 に上げ、checksum が変わることがキャッシュ無効化になる）。
  実ケースで検証していないビルドは「検証済み」ではない
- 直した内容は「症状」ではなく「その症状を機械が二度と通さない仕組み」で報告する

【Rust の活かし方（Salesmachines / Person-Pro の実装が手本）】
性能・並行・データ整合が要る層は Rust を第一候補にし、既にこのコードベースで
効いている型を真似る。抽象論を書かず、下の実物と同じ形にすること:

- 速度は「棚（shelf）で 2 度引かない」形で取る。`toolbox/src/tiles.rs` が手本:
  同じタイルを筆ごとに引き直して 200 筆で 28MB・1 回 430ms だったのを、
  プロセス内の棚に畳んだ。呼ぶ側は 1 行も変えない。棚には上限を持たせる
  （`const KEEP: usize = 64` — 青天井は city 掃引で数百 MB になる）。
  失敗は憶えない（切断 1 回が後続全件に伝染する）。404 は答えなので憶える
- 速度の主張は実測で出す。「142ms/141KB のタイル」「割付 50ms のうち 49ms が
  ほどき直し」のように before/after の数値を書く。推測での最適化は禁止
- 並列は `std::thread::scope`（`toolbox/src/upstream.rs:561`）＋ `mpsc::channel`
  で書く。`Arc<Mutex<_>>` を素で持ち回らない（`shell::relay::Relay` に
  `try_lock` の作法を 1 か所へ畳んである）。同一資源への同時要求は
  single-flight（`single::Flight`）で 1 本にまとめる
- 型で事故を表現不能にする。実在の畳み方をそのまま使う:
  鍵は `String` でなく `agent_loop::key::Key`（`derive(Debug)` のままで漏れない）、
  HTTP は `(status, bytes)` の生タプルでなく `http::Response`（`ok()`/`status()`/`body()`）、
  成功判定は数の比較でなく `Response::ok()`、
  ファイル書き込みは自前パスでなく `shell::downloads::Downloads::resolve()` の
  `Destination` 経由（自前 `std::fs::write` は「ダウンロードに入れました」と言いながら
  cwd に落とす事故を実際に起こした）
- ハングは機械的上限で封じる。ureq には必ず `timeout_read`（既定 60〜120秒を明示）、
  リトライは `BACKOFF` 定数表で回数上限つき（`upstream.rs:157`）
- 外に出す口は 1 か所に絞る。生の上流アクセス・デコードは棚の中だけに置き、
  棚の外から呼ばせない（迂回できなければ N+1 は起きない）
- 型で縛れない残りは build.rs の門番で落とす（下の【機械強制】参照）


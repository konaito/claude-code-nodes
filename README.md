# Claude Code Nodes（ccn）

ccn.fybe.jp の中身。各機械で動くノードが、その機械の Claude Code セッションを HTTP と SSE で開放する。ノードは Cloudflare Tunnel と Access でつながり、どのノードも同じコードで動く。

- https://ccn.fybe.jp を開くと、つながっているパソコン、セッション、会話の3列が出る。画面から文を送り、権限に答え、中断と停止ができる。
- 別の Claude Code からは CLI の `ccn` で子セッションを立てて動かす。使い方は `skills/ccn/SKILL.md` にある。
- 設計は `docs/superpowers/specs/`、計画は `docs/superpowers/plans/`、試験と移行の記録は `docs/results/`、運用の手順は `docs/runbooks/` にある。
- 2026-11-11 に cc-web（cc.fybe.jp）から改名した。旧の名前（`cc-<name>` のトンネル、`x-cc-*` のヘッダ、`/install/cc.tar.gz`、`~/.config/cc`）も移行の間は受ける。手順は `docs/runbooks/2026-11-11-ccn-rename.md`。

## 機械を足す

足す側の機械（cf にログイン済み）で参加トークンを作る。

```bash
ccn node add <name>       # トンネル ccn-<name> と DNS を作り、参加トークンを1つ出す
```

新しい機械で入口のインストーラを動かし、聞かれたらトークンを貼る。

```bash
curl -fsSL https://ccn.fybe.jp/install | sh
```

インストーラは bun と cloudflared を入れ、アプリを `~/.local/share/ccn/app` に置いて `~/.local/bin/ccn` からリンクし、macOS では LaunchAgent、Linux では systemd --user でノードとトンネルを常駐させる。Claude Code のログインは機械ごとに人が行う。

```bash
ccn doctor                # claude の版、常駐、手元と外からの API、claude のログインを確かめる
ccn update                # 入口から最新の束を取り直して入れ替え、ノードを再起動する
ccn update --from <checkout>   # 入口ではなく手元の checkout から入れる（入口のノード自身を更新するとき）
ccn update --entry https://ccn.fybe.jp   # 入口を差し替えて設定に書いてから更新する
ccn uninstall             # 常駐を止め、アプリと ccn.json を消す
ccn node remove <name> [--legacy]   # トンネルと DNS を消す（--legacy は改名前の cc-<name>）
ccn node migrate <name> [--rename]  # 改名前のノードに ccn-<name> のホスト名を足す（--rename はトンネル名も変える）
```

## 開発

```bash
bun install
bun test                                   # Cloudflare も claude も使わない試験
bunx tsc --noEmit -p .
CC_LIVE=1 bun test test/live.test.ts       # 本物の claude を使う試験。VM で回す
```

手元で別のノードを立てるときは、`CCN_CONFIG` で別の ccn.json（別のポート）を渡して `bun run src/cli/ccn.ts serve` を動かす。旧の `CC_CONFIG` も読む。

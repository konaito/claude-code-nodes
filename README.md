# Claude Code Nodes（ccn）

ccn.fybe.jp の中身。各機械で動くノードが、その機械の Claude Code セッションを HTTP と SSE で開放する。ノードは Cloudflare Tunnel と Access でつながり、どのノードも同じコードで動く。

- https://ccn.fybe.jp を開くと、つながっているパソコン、セッション、会話の3列が出る。画面から文を送り、権限に答え、中断と停止ができる。「新しく」ではノードと場所だけを選んで開き、1通目は会話の入力欄で打つ。場所を空にすると受け口に開く。
- 各ノードには受け口（`~/.local/share/ccn/lobby`）がある。受け口のセッションは、届いた依頼から行き先のディレクトリを探してそこに子を立て、返事に `子: <ノード名>/<sessionId>` の行を書く。受け口の CLAUDE.md と `.claude/settings.json`（受け口が承認なしで使える ccn の命令と roots の下の読み取り、承認があっても読ませない秘密の置き場）はノードが起動のたびに書き直す。足したい決まりは同じディレクトリの `CLAUDE.local.md` に、足したい許可は `.claude/settings.local.json` に書く。
- 別の Claude Code からは CLI の `ccn` で子セッションを立てて動かす。使い方は `skills/ccn/SKILL.md` にある。
- どのノードも `/mcp` で MCP サーバー（Streamable HTTP、状態なし）を出す。ツールは HTTP の API と同じ操作（ノード一覧、セッション一覧、詳細、場所の一覧、作る、送る、待って読む、権限の応答、中断、停止）で、別のノードへは中継を通す。
- どのノードも `/skill.md` で、製品の説明と MCP でのつなぎ方を Agent Skills の形で配る。認証は要らない。本文の正本は `skills/claude-code-nodes/SKILL.md`。
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

## MCP でつなぐ

ノードのある機械では、手元のノードにつなぐ。秘密は要らず、別の機械のセッションはツールの `peer` で操作する。port は `ccn.json` の `port`。

```bash
claude mcp add --transport http --scope user ccn http://127.0.0.1:4322/mcp
```

外から（サービストークンか、Access の Managed OAuth で）つなぐ方法は `https://ccn.fybe.jp/skill.md` にある。本番に入れる手順は `docs/runbooks/2026-11-11-mcp-skill-md.md`。

## 開発

```bash
bun install
bun test                                   # Cloudflare も claude も使わない試験
bunx tsc --noEmit -p .
CC_LIVE=1 bun test test/live.test.ts       # 本物の claude を使う試験。VM で回す
```

手元で別のノードを立てるときは、`CCN_CONFIG` で別の ccn.json（別のポート）を渡して `bun run src/cli/ccn.ts serve` を動かす。旧の `CC_CONFIG` も読む。

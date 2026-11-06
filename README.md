# cc-web

cc.fybe.jp の中身。各機械で動くノードが、その機械の Claude Code セッションを HTTP と SSE で開放する。ノードは Cloudflare Tunnel と Access でつながり、どのノードも同じコードで動く。

- https://cc.fybe.jp を開くと、つながっているパソコン、セッション、会話の3列が出る。画面から文を送り、権限に答え、中断と停止ができる。
- 別の Claude Code からは CLI の `cc` で子セッションを立てて動かす。使い方は `skills/session-inbox/SKILL.md` にある。
- 設計は `docs/superpowers/specs/`、計画は `docs/superpowers/plans/`、試験と移行の記録は `docs/results/` にある。

## 機械を足す

足す側の機械（cf にログイン済み）で参加トークンを作る。

```bash
cc node add <name>       # トンネル cc-<name> と DNS を作り、参加トークンを1つ出す
```

新しい機械で入口のインストーラを動かし、聞かれたらトークンを貼る。

```bash
curl -fsSL https://cc.fybe.jp/install | sh
```

インストーラは bun と cloudflared を入れ、アプリを `~/.local/share/cc/app` に置き、macOS では LaunchAgent、Linux では systemd --user でノードとトンネルを常駐させる。Claude Code のログインは機械ごとに人が行う。

```bash
cc doctor                # claude の版、常駐、手元と外からの API、claude のログインを確かめる
cc update                # 入口から最新の束を取り直して入れ替え、ノードを再起動する
cc uninstall             # 常駐を止め、アプリと cc.json を消す
cc node remove <name>    # トンネルと DNS を消す
```

## 開発

```bash
bun install
bun test                                   # Cloudflare も claude も使わない試験
bunx tsc --noEmit -p .
CC_LIVE=1 bun test test/live.test.ts       # 本物の claude を使う試験。VM で回す
```

手元で別のノードを立てるときは、`CC_CONFIG` で別の cc.json（別のポート）を渡して `bun run src/cli/cc.ts serve` を動かす。

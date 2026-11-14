# Claude Code Nodes（ccn）

ccn は、機械ごとに常駐するノードで Claude Code のセッションを扱うためのソフトウェアである。ノードは、その機械の Claude Code のセッションを一覧にし、新しく立て、文を送り、権限の確認に答え、中断し、止める。操作の口は HTTP と SSE、MCP、CLI の `ccn` の3つで、ブラウザで開く画面も付いている。

ノードは1台でも動く。Cloudflare Tunnel と Access で複数の機械のノードをつなぐと、別の機械のセッションも同じ口で扱える。

## できること

- 画面（`http://127.0.0.1:<port>/`）で、機械、セッション、会話の3列を見る。画面から文を送り、権限の確認に答え、中断と停止ができる。
- 別の Claude Code から、CLI の `ccn` か MCP で子のセッションを立てて動かす。子が孫を立てるところまで扱い、それより深い作成は断る。
- 端末（PTY）の中で対話の `claude` を動かし、その画面を HTTP で読み書きする。
- `ccn teleport` で、セッションを会話と git の作業ツリーごと別の機械へ移す。

## 必要なもの

- macOS か Linux
- [bun](https://bun.sh)
- Claude Code（`claude` コマンド）。ログインを済ませておく。作者が試した版は 2.1.318 で、`ccn doctor` は版が違うと知らせる。
- 複数の機械をつなぐときだけ、Cloudflare のアカウント（Tunnel と Access）と、Cloudflare の `cf` CLI

## 1台で動かす

```bash
git clone https://github.com/konaito/claude-code-nodes.git
cd claude-code-nodes
bun install
bun run src/cli/ccn.ts serve
```

ノードは `127.0.0.1:4322` で待ち、ブラウザで `http://127.0.0.1:4322/` を開くと画面が出る。設定ファイルが無ければ、名前はホスト名、ポートは 4322、セッションを立てられる場所（roots）はホームになる。

設定を変えるときは `~/.config/ccn/ccn.json` を作る。

```json
{
  "name": "my-mac",
  "port": 4322,
  "roots": ["/Users/me"]
}
```

Cloudflare Access の値（`teamDomain` と `aud`）が設定に無いノードは、認証をしない。ノードは `127.0.0.1` でしか待たないので、同じ機械のプログラムだけが呼べる。

CLI はリポジトリの `bin/ccn` を使う。`~/.local/bin` にリンクを置くと、どこからでも `ccn` で呼べる。

```bash
ln -s "$PWD/bin/ccn" ~/.local/bin/ccn
ccn peers     # つながっているノード
ccn ls        # セッションの一覧
ccn --help    # ほかの命令
```

Claude Code から MCP で使うときは、手元のノードを登録する。ポートは `ccn.json` の `port` に合わせる。

```bash
claude mcp add --transport http --scope user ccn http://127.0.0.1:4322/mcp
```

## Claude Town との関係

[Claude Town](https://github.com/konaito/ClaudeTown) は、Claude Code のセッションをキャラが働く町として見せるデスクトップアプリである。Claude Town はセッションの一覧、会話、端末、権限の確認を、手元の ccn のノードから読む。ポートは `~/.config/ccn/ccn.json` の `port` から読むので、Claude Town を使うときはこのファイルを作っておく。

## 複数の機械をつなぐ

つなぐには、Cloudflare のゾーン（ドメイン）と Zero Trust の組織が要る。ノードは Cloudflare Tunnel で外に出し、Cloudflare Access が人とノードを認証する。

1台目の機械（`cf` にログイン済み）で、Access のアプリとノード用のサービストークンを作る。

```bash
ccn setup --hosts 'ccn-*.example.com,ccn.example.com' \
  --email you@example.com --domain ccn.example.com --zone example.com \
  --team-domain <team>.cloudflareaccess.com --account-id <Cloudflare のアカウント ID>
```

機械を足すときは、参加トークンを作ってから、新しい機械で入口のインストーラを動かす。

```bash
ccn node add <name>                              # トンネル ccn-<name> と DNS を作り、参加トークンを1つ出す
curl -fsSL https://ccn.example.com/install | sh  # 新しい機械で。聞かれたら参加トークンを貼る
```

インストーラは bun と cloudflared を入れ、アプリを `~/.local/share/ccn/app` に置いて `~/.local/bin/ccn` からリンクする。ノードとトンネルは、macOS では LaunchAgent、Linux では systemd --user で常駐する。Claude Code のログインは、機械ごとに人が行う。

```bash
ccn doctor                     # claude の版、常駐、手元と外からの API、claude のログインを確かめる
ccn update                     # 入口から最新の束を取り直して入れ替え、ノードを再起動する
ccn update --from <checkout>   # 入口ではなく手元の checkout から入れる（入口のノード自身を更新するとき）
ccn uninstall                  # 常駐を止め、アプリと ccn.json を消す
ccn node remove <name>         # トンネルと DNS を消す
```

外から MCP でつなぐ方法（サービストークンか、Access の Managed OAuth）は、各ノードの `/skill.md` にある。本文の正本は `skills/claude-code-nodes/SKILL.md`。

## 仕組み

- どのノードも同じコードで動き、ノードごとの役割は無い。入口は、入口のホスト名の CNAME が指しているノードである。
- ノードはデータを保存しない。会話の正本は Claude Code の jsonl（Agent SDK で読む）、仲間の一覧は Cloudflare のトンネルの一覧、画面の状態はブラウザの localStorage にある。
- 各ノードには受け口（`~/.local/share/ccn/lobby`）がある。受け口のセッションは、届いた依頼から行き先のディレクトリを探してそこに子を立て、返事に `子: <ノード名>/<sessionId>` の行を書く。受け口の CLAUDE.md と `.claude/settings.json` は、ノードが起動のたびに書き直す。足したい決まりは同じディレクトリの `CLAUDE.local.md` に、足したい許可は `.claude/settings.local.json` に書く。
- 別の Claude Code から `ccn` で子を扱う手順は `skills/ccn/SKILL.md` にある。`ccn install` と `ccn update` は、このスキルを `~/.agents/skills/ccn` にリンクする。
- 設計は `docs/superpowers/specs/`、計画は `docs/superpowers/plans/`、試験と移行の記録は `docs/results/`、運用の手順は `docs/runbooks/` にある。設計の正本は `docs/superpowers/specs/2026-11-06-cc-protocol-design.md`。

## 作者の運用

作者は `ccn.fybe.jp` を入口にして、数台の機械（konaito-pro、incertotech、vm など）で ccn を動かしている。`docs/results/` と `docs/runbooks/` の記録は、この環境での試験と移行のものである。

- 2026-11-11 に cc-web（cc.fybe.jp）から改名した。旧の名前（`cc-<name>` のトンネル、`x-cc-*` のヘッダ、`/install/cc.tar.gz`、`~/.config/cc`）も、移行の間は受ける。手順は `docs/runbooks/2026-11-11-ccn-rename.md`。
- `ccn update --entry <url>` は、入口を差し替えて設定に書いてから更新する。`ccn node remove <name> --legacy` は改名前の `cc-<name>` を消し、`ccn node migrate <name> [--rename]` は改名前のノードに `ccn-<name>` のホスト名を足す。
- 本番に MCP を入れる手順は `docs/runbooks/2026-11-11-mcp-skill-md.md` にある。

## 開発

```bash
bun install
bun test                                   # Cloudflare も claude も使わない試験
bunx tsc --noEmit -p .                     # 型検査
CC_LIVE=1 bun test test/live.test.ts       # 本物の claude を使う試験。VM で回す
```

手元で別のノードを立てるときは、`CCN_CONFIG` で別の ccn.json（別のポート）を渡して `bun run src/cli/ccn.ts serve` を動かす。旧の `CC_CONFIG` も読む。

## ライセンス

MIT。`LICENSE` にある。

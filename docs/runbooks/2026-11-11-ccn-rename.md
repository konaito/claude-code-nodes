# cc から ccn（Claude Code Nodes）へ移す手順

2026-11-11。コードの改名（PR3）がマージされた後に、Cloudflare、3台の機械、入口、GitHub、CLAUDE.md を移す手順をまとめる。PR3 のコードは移行の間、新旧の名前を両方受ける。

## 方針

- トンネルは作り直さず、`cf tunnels edit --name` で名前だけを変える。トンネルの id とトークンは変わらないので、機械の cloudflared は止めなくてよい。
- Access アプリ `cc` と `cc-install` は、`ccn setup` が新しい名前と新旧のホスト名で上書きする。aud は変わらない。
- サービストークン `cc-node` は名前を変えずに使い続ける。全ノードが同じ secret を持っているので、作り直すと全部の機械に配り直しになる。
- 以上で、各機械の `ccn.json` の aud、サービストークン、トンネルトークンは今のまま使える。`ccn update` が運ぶのはコードと置き場の移動だけになる。
- 足す作業（新のホスト名、Access のホスト名）を先に済ませ、消す作業（トンネルの改名、旧のホスト名の片付け）は全部の機械を更新した後にする。旧のコードの登録簿は `cc-` で始まるトンネルしか読まないため。

## 0. 前提

- PR1〜PR3 が main にマージされている。
- `konaito-pro` の `~/Documents/cc-web` を main にして pull してある。今の checkout は `fix/cli-name-ccn`（マージ済み）なので切り替える。
- 移行の操作は、機械の端末か SSH から行う。ノードが立てたセッション（`ccn new` の子や、画面から立てたもの）の中で `ccn update` を実行すると、旧の常駐を外したときに自分も止まり、新の常駐が入らない。

## 1. konaito-pro を更新する

```bash
cd ~/Documents/cc-web && git switch main && git pull
ccn update --from ~/Documents/cc-web   # 1回目。旧のコードが動き、新しいコードを旧の置き場に入れ、旧の常駐で再起動する
ccn update --from ~/Documents/cc-web   # 2回目。新しいコードが動き、置き場、スキル、child.md、常駐を移す
ccn doctor
```

1回目の後、ノードは新しいコードで動くが、設定は旧の `~/.config/cc/cc.json` を読む（新の設定が無いときの読み替え）。2回目で次のことが起きる。

- `~/.config/cc` を `~/.config/ccn` に移し、`cc.json` を `ccn.json` にする。`tunnel.token` と `sends.json` も移る。
- アプリを `~/.local/share/ccn/app` に置き、`~/.local/bin/ccn` をそこへ向ける。
- スキル `ccn` を `~/.agents/skills/ccn` と `~/.claude/skills/ccn` にリンクし、child.md を `~/.config/ccn/child.md` に置く。旧の `session-inbox` のリンクを消す。
- `~/.config/session-inbox/` を `~/.config/ccn/legacy-session-inbox-<日付>/` に退避してから消す。
- 旧の常駐（`jp.fybe.cc.node`、`jp.fybe.cc.tunnel`）を外し、新の常駐（`jp.fybe.ccn.node`、`jp.fybe.ccn.tunnel`）を入れる。
- 最後に `~/.local/share/cc` を消す。

確かめること。

- `ccn doctor` が全部 ok。
- `launchctl print gui/$(id -u)/jp.fybe.ccn.node` が running で、`launchctl print gui/$(id -u)/jp.fybe.cc.node` が見つからない。
- `lsof -i :4323 -sTCP:LISTEN` が bun 1つだけ。

この時点で `~/.config/session-inbox/child.md` が無くなり、CLAUDE.md の `@~/.config/session-inbox/child.md` が読めなくなる。手順7をすぐ続けるか、手順7の書き換えだけを先に済ませておく。

## 2. Cloudflare に新の名前を足す（消さない）

konaito-pro（cf にログイン済み）で行う。

```bash
ccn setup --hosts 'ccn-*.fybe.jp,ccn.fybe.jp,cc-*.fybe.jp,cc.fybe.jp'
```

- Access アプリ `cc` を `ccn` に、`cc-install` を `ccn-install` に改名し、4つのホスト名を持たせる。出力の aud が `~/.config/ccn/ccn.json` の aud と同じであることを確かめる。違えば、作り直されているので止めて調べる。
- サービストークンは `cc-node` のまま使う（出力に `サービストークン cc-node` と出る）。
- 方針の中身（ceo@fybe.jp の email と、サービストークンの non_identity）は `ccn setup` が全文で送る。ダッシュボードで足した方針があれば消えるので、先に `cf zero-trust access applications list` で今の中身を控える。

ノードごとに新のホスト名を足す。

```bash
ccn node migrate konaito-pro
ccn node migrate incertotech
ccn node migrate vm
```

それぞれのトンネル（まだ `cc-<name>`）の ingress に `ccn-<name>.fybe.jp` を足し、DNS の CNAME を作る。旧の `cc-<name>.fybe.jp` は残る。vm が落ちていても、トンネルの設定と DNS は Cloudflare の側なので足せる。

確かめること。

- `curl -s -o /dev/null -w '%{http_code}\n' https://ccn-incertotech.fybe.jp/install` が 200（Bypass が効いている）。
- `curl -s -o /dev/null -w '%{http_code}\n' https://ccn-incertotech.fybe.jp/api/host` が 302 か 403（Access が守っている）。
- `ccn ls` で3台（vm は落ちていれば inactive）が出る。

## 3. incertotech と vm を更新する

それぞれの機械の端末か SSH で行う。入口（cc.fybe.jp）はまだ旧のコードで新しい束を配らないので、konaito-pro のノードから束を取る。

```bash
SRC=$(mktemp -d)
curl -fsSL https://ccn-konaito-pro.fybe.jp/install/ccn.tar.gz | tar xz -C "$SRC"
ccn update --from "$SRC"   # 1回目（旧のコード）
ccn update --from "$SRC"   # 2回目（新しいコードが移す）
ccn doctor
rm -rf "$SRC"
```

vm は立ち上がってから行う。incertotech は入口なので、更新している間は cc.fybe.jp の画面が数秒止まる。

## 4. トンネルを改名し、入口を ccn.fybe.jp にする

3台とも更新してから行う。vm が長く落ちたままなら、vm 以外を先に進めてよい。vm の旧のコードは改名したトンネルを登録簿に出さなくなるが、vm 自身のノードは動く。

```bash
ccn node migrate konaito-pro --rename
ccn node migrate incertotech --rename
ccn node migrate vm --rename
ccn entry incertotech --host ccn.fybe.jp
```

`ccn entry` は incertotech のトンネルの ingress に `ccn.fybe.jp` を足し、CNAME を向ける。`cc.fybe.jp` の ingress と CNAME は残る。

各機械で、設定の入口を新しくする。

```bash
ccn update --entry https://ccn.fybe.jp
```

確かめること。

- `ccn peers` の URL が `https://ccn-<name>.fybe.jp` になる。
- https://ccn.fybe.jp を開くと、見出しが Claude Code Nodes の画面が出る。localStorage はオリジンごとなので、選んでいたノードや下書きは ccn.fybe.jp では引き継がれない。

## 5. 旧のホスト名はしばらく残す

`cc-<name>.fybe.jp` と `cc.fybe.jp` は、旧のブックマークや手元の古い設定のために残す。片付けるときは次のとおり。

```bash
ccn node remove <name> --legacy   # cc-<name>.fybe.jp の DNS だけを消す。トンネルは消さない
ccn setup --hosts 'ccn-*.fybe.jp,ccn.fybe.jp'
```

`cc.fybe.jp` の CNAME と ingress は `cf` で消す（`ccn` には命令が無い）。

## 6. GitHub の repo と手元のディレクトリを改名する

```bash
gh repo rename claude-code-nodes -R konaito/cc-web
cd ~/Documents && mv cc-web claude-code-nodes
cd claude-code-nodes && git remote set-url origin https://github.com/konaito/claude-code-nodes.git && git worktree repair
```

- worktree（`~/Documents/cc-web-ccn` など）は、`git worktree repair` で本体の場所を直すか、消してから作り直す。
- Claude Code のプロジェクトのメモリは作業ディレクトリのパスで分かれている（`~/.cam/profiles/<profile>/projects/-Users-konaito-Documents-cc-web/`）。新しいパスのディレクトリへ移すか、残すかを決める。

## 7. CLAUDE.md と hook を書き換える

対象は `~/.claude/CLAUDE.md` と `~/.cam/profiles/{agent,ceo,coo,cto,shared}/CLAUDE.md` の6つと、`~/.claude/hooks/specter-delegate-guard.py`。

- `@~/.config/session-inbox/child.md` を `@~/.config/ccn/child.md` にする。
- スキル名の `session-inbox`、`/session-inbox` を `ccn`、`/ccn` にする。「委譲」節の「session-inbox（別の機械の子）」も同じ。
- hook が `session-inbox` の名前で判定していれば `ccn` も通すようにする。

手順1で `~/.config/session-inbox` が消えてから、この書き換えまでの間は child.md が読み込まれない。手順1の直後に行う。

## 戻し方

- 2回目の `ccn update` の途中で止まったら、もう一度 `ccn update --from <同じ束>` を実行する。移行の各段は、済んだものを飛ばす。
- 新の常駐が立たないときは、ログ `~/.local/share/ccn/log/node.log` を見る。旧の常駐に戻すには、旧のコードの checkout（`git switch` で PR3 より前）から `ccn install --from <checkout>` を参加トークン付きで実行する。参加トークンは konaito-pro で `ccn node token <name> --to <file>` で出し直せる。
- `~/.config/session-inbox` は `~/.config/ccn/legacy-session-inbox-<日付>/` にある。

## 未確認のこと

- `cf tunnels edit --name` で改名しても、動いている cloudflared の接続が切れないこと。`cf tunnels edit --help` に「名前か secret を変える」とあるのは確かめたが、実際に改名はしていない。
- `ccn setup` の Access アプリの上書きで aud が変わらないこと。Cloudflare の update は同じ id のアプリを書き換えるので変わらない見込みだが、実際には確かめていない。
- `ccn-*.fybe.jp/install` の Bypass が、各ノードの `/install/ccn.tar.gz` にも効くこと。手順2の curl で確かめる。
- launchd の bootout が、ノードの子プロセス（ノードが立てた claude）まで止めること。止まる前提で、端末か SSH から実行するように書いた。
- CLAUDE.md の `@` で読む先のファイルが無いとき、Claude Code が黙って飛ばすこと。

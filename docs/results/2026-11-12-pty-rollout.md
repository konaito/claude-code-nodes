# PTY の Driver の版を本番の3台に配った記録（2026-11-12）

PR #19（d5bd37f）の版を、konaito-pro、incertotech、vm の3台に配った。作業は konaito-pro の Specter のペイン（ccn-rollout-2）から行った。このペインはノードが立てたセッションではなく、端末のセッションである。本人は同日に、ccn 経由と親 meta-fc の端末の2回、3台の更新を承認した。

## 結果のまとめ

| 確かめたこと | konaito-pro | incertotech | vm |
| --- | --- | --- | --- |
| 更新前の中身 | 5a1b160（`0ff8d8397e95`） | 5a1b160 | 5a1b160 |
| 更新後の中身 | d5bd37f（`4922768cd196`） | d5bd37f | d5bd37f |
| `ccn doctor` | claude 2.1.322 の ng だけ（前と同じ） | claude 2.1.319 の ng だけ（前と同じ） | 全部 ok |
| 常駐の bun と `Bun.Terminal` | 1.3.11、ある | 1.3.14、ある | 1.4.4、ある |
| `GET /api/sessions` | 200、100件 | 200、51件 | 200、32件 |
| `ccn peers` | 3台とも healthy | 同左 | 同左 |
| MCP の initialize と tools/list | 200。ツール10個、`create_session` に `terminal` がある | 同左 | 同左 |
| `terminal: true` の作成 | 201、`kind: "pty"`、`capabilities.terminal` が true | 同左 | 同左 |
| 端末の SSE（直と中継） | どちらも `size`、`replay` の順 | 同左 | 同左 |
| DELETE の後 | 204。GET は 404、一覧に無い、プロセスも無い | 同左 | 同左 |
| 再起動で消えたセッション | 1件（606ea878、待機中で0通） | 0件 | 0件 |

## 更新の前に記録したこと

- 中身の値は前回と同じ計算で出した。`src`、`skills`、`bin`、`package.json`、`bun.lock` の各ファイルの sha256 をまとめた値で、`._` で始まるファイルは除く。5a1b160 と e725a26 を `git archive` で取り出すと、前回の記録と同じ `0ff8d8397e95` と `6f6d3af9a1d3` になった。d5bd37f は `4922768cd196` になる。
- 3台の `~/.local/share/ccn/app` の値は、どれも `0ff8d8397e95` だった。
- `ccn peers` では、3台とも healthy だった。
- `ccn doctor` は、konaito-pro と incertotech が claude の版の ng だけで、vm は全部 ok だった。
- PR #19 は `Bun.Terminal` を使う。常駐と同じ `~/.bun/bin/bun` で `typeof Bun.Terminal` を見ると、3台とも `function` だった。
- PR #19 は依存に `@xterm/headless` と `@xterm/addon-serialize` を足した。`ccn update` は新しい置き場で `bun install --frozen-lockfile --production` を実行するので、手で入れる手順は無い。

### 再起動で止まるセッション

`ccn ls --peer <台>` で、exited 以外の行を見た。

- konaito-pro では、ノードのセッションが1件あった。`606ea878`（node、idle、cwd は `~/Documents/meta`、parent は `local`、20:42:42 作成）である。`GET /api/sessions/<id>` では `awaitingFirst: true`、usage は0、メッセージは0通だった。claude はまだ起動していない。ノードの台帳はメモリにあるので、再起動でこのセッションは消える。親 meta-fc に1行で伝えてから更新した。
- konaito-pro の terminal の行（人が端末で開いたセッション）は、ノードの子ではない。更新の後も全部が一覧に残った。
- incertotech と vm には、生きているセッションが無かった。
- 更新前に、konaito-pro と incertotech のノードの子に `claude --output-format stream-json` のプロセスが数秒だけ出ていた。数秒後には無くなっていた。どのセッションのものかは確かめていない。

### incertotech の止まったスレッド（更新前）

ノード（pid 1199）を `sample` で2秒見た。`__openat_nocancel` で止まったスレッドは、前回と同じ Thread_8717426 の1本だった。スレッドは全部で17本だった。前回の「止まったスレッドがノードの終わりまで残るか」は、残っていた。

## 更新

前回と同じ順番で、3台を `ccn update --from` で更新した。入口は incertotech である。

| 台 | 時刻 | 入れた元 | 束の値の確認 |
| --- | --- | --- | --- |
| konaito-pro | 20:50:13〜20:50:15 | d5bd37f を `git archive` で `/tmp/ccn-pty-rollout/a-d5bd37f` に取り出したもの | 取り出した後が `4922768cd196` |
| incertotech | 20:52:40〜20:52:41 | `https://ccn-konaito-pro.fybe.jp/install/ccn.tar.gz` を新しい空のディレクトリに展開したもの | 展開後が `4922768cd196` |
| vm | 20:53:56〜20:53:57 | `https://ccn.fybe.jp/install/ccn.tar.gz`（更新後の incertotech）を同じく展開したもの | 展開後が `4922768cd196` |

3台とも、出力は「更新した: …。node を再起動した。実行物は ccn」で、終了コードは0だった。束の値が合わなければ止める作りにしておいた。

前回と違うやり方を取ったのは次の2点である。

- konaito-pro の元を、`~/Documents/claude-code-nodes` から `git archive` の取り出しに変えた。`~/Documents/claude-code-nodes` は、このとき別のセッション（fc-teleport-test）の作業ディレクトリだった。main の d5bd37f で clean だったが、作業中に変わりうるためである。
- vm と incertotech には、前回と同じく `orb run -m ubuntu` と `ssh incertotech` で入った。依頼文は「その機械に ccn で子を立てて行う」としていた。ただし ccn の子はノードの子なので、`ccn update` の再起動でその子自身が止まり、結果を読めない。そこで前回の記録のやり方に従った。

更新の直後に次を確かめた。

- konaito-pro: ノードの pid は 42693 から 65083 に変わった。`/api/host` は2秒以内に返った。
- incertotech: 旧の pid 1199 は無くなり、新しい pid は 23382 だった。止まったスレッドを抱えた旧のノードは、再起動で終わった。
- vm: 旧の pid 17244 は無くなり、新しい pid は 21021 だった。

更新後の app の値は、3台とも `4922768cd196` だった。

## 各台での確認（コマンド）

### ccn doctor と peers

- `ccn doctor` の結果は、3台とも更新前と同じだった。
- `ccn peers` では、3台とも healthy だった。

### API、MCP、PTY の試しのセッション

konaito-pro から `bun /tmp/ccn-pty-rollout/check.ts <台>` を実行した。この台本は次を順に行う。konaito-pro は 127.0.0.1:4323 を直に叩く。incertotech と vm は `https://ccn-<台>.fybe.jp` をサービストークンで叩く。呼び手は `agent:konaito-pro/00000000/pty-rollout-check` と名乗った。

1. `GET /api/sessions` の状態コードと件数を見る。
2. `POST /mcp` に initialize と tools/list を送り、`create_session` の入力に `terminal` があるかを見る。
3. `POST /api/sessions` に `{terminal: true, name: "pty-rollout-check", cols: 100, rows: 30}` を送る。cwd、prompt、send、端末への入力は入れない。cwd を省いたので受け口に立つ。
4. `GET /api/sessions/<id>` で kind と capabilities を見る。
5. 6秒待ってから、端末の SSE を直に15秒読む。次に konaito-pro の中継 `127.0.0.1:4323/n/<台>/api/sessions/<id>/terminal` で15秒読む。konaito-pro では中継の道は自分への中継になる。
6. `DELETE /api/sessions/<id>` を送り、4秒後に GET と一覧を見る。

| | konaito-pro | incertotech | vm |
| --- | --- | --- | --- |
| 試しのセッション | `db09c811-14c0-478d-b04c-fbd863b33971` | `d5452577-8bee-4f69-9076-fae957a60100` | `c254e5b1-293d-49df-9d31-bc0789fa989f` |
| 作成の応答 | 201、`kind: "pty"`、`state: "idle"` | 同左 | 同左 |
| cwd | `/Users/konaito/.local/share/ccn/lobby` | `/Users/konaito/.local/share/ccn/lobby` | `/home/konaito/.local/share/ccn/lobby` |
| `capabilities.terminal` | true | true | true |
| 直の SSE | `size`（100x30、epoch つき）、`replay`（1567バイト） | `size`、`replay`（1567バイト） | `size`、`replay`（1566バイト） |
| 中継の SSE | 直と同じ順番と同じ epoch | 同左 | 同左 |
| DELETE | 204 | 204 | 204 |
| DELETE の4秒後 | GET は 404、一覧に同じ id は無い | 同左 | 同左 |
| プロセス | `pgrep -f <id>` が空、`claude agents --json` に無い | 同左（ssh で確認） | 同左（orb で確認） |

konaito-pro では、待たずに SSE を読む版も1回試した（`cbaf06e0-a95f-4953-a121-b006d4f1bcff`）。`size`、`replay`（10バイト）、`data` の順に届いた。止めた後も同じく、GET は 404 で、プロセスも無かった。

この確認で、LaunchAgent（macOS）と systemd --user（vm）の常駐から PTY の claude を起動できた。また、Cloudflare の先の中継（`/n/incertotech/`、`/n/vm/`）でも端末の SSE が返った。どちらも PTY の Driver の記録では確かめていなかった項目である。

### 受け口で立てた PTY に出た信頼の確認

replay の画面の文字を見ると、3台とも claude の信頼の確認が出ていた。文面は「Accessing workspace: <受け口> Quick safety check: Is this a project you created or one you trust?」である。確認には答えていない。答えると `.claude.json` を書き換えるためである。

PTY の Driver の記録では、未信頼の cwd の対話セッションは、信頼の確認に答えるまで hooks を止める。そのため、cwd を省いた `terminal: true` のセッションは、本人が端末で信頼に答えるまで send と承認が動かない見込みである。send を試していないので、この点は確かめていない。

### incertotech の places

konaito-pro から `ccn places --peer incertotech --json` を2回実行した。時間は呼び出しの前後の時刻の差である。

| 回 | 時間 | 件数 | partial | note |
| --- | --- | --- | --- | --- |
| 1回目 | 1.27 秒 | 58件 | true | some folders did not answer in time and were skipped: /Users/konaito/Documents |
| 2回目 | 0.28 秒 | 58件 | true | 同じ |

5a1b160 のときと同じ結果である。places は返るが、`~/Documents` は1秒の上限で読めず、`unreadable` に入る。

places を2回呼んだ後、新しいノード（pid 23382）を `sample` で2秒見た。`__openat_nocancel` で止まったスレッドは1本（Thread_9504970）で、スレッドは全部で19本だった。前回と同じく、places を呼ぶと1本止まる。

### 外からの確認（HTTP）

- `https://ccn.fybe.jp/skill.md` は 200 で、`text/markdown` の 17,096 バイトだった。中身は、d5bd37f の `skills/claude-code-nodes/SKILL.md` の `{{ORIGIN}}` を `https://ccn.fybe.jp` にしたものと diff で一致した。
- 未認証の `POST https://ccn.fybe.jp/mcp`（initialize）は 401 だった。`www-authenticate` は前回と同じだった。
- 未認証の `https://ccn.fybe.jp/api/host` は 401、`/install` は 200 だった。

### 片づけ

試しの PTY のセッションは4つとも DELETE で止めた。片づけの後、3台で生きている node と pty のセッションは0件だった。`/tmp/ccn-pty-rollout` と各台の `/tmp/ccn-pty-bundle.*` は残してある。

## 前の版に戻す手順

runbook（`docs/runbooks/2026-11-11-mcp-skill-md.md` の「戻す」）のとおり、前の版の checkout から `ccn update --from <checkout>` を実行する。`ccn update` は `app.old` を消すので、各台に前の版は残っていない。

- konaito-pro: `ccn update --from /tmp/ccn-pty-rollout/a-5a1b160`。中身は 5a1b160 の `git archive` で、値は `0ff8d8397e95` である。
- incertotech と vm: 同じディレクトリを scp か orb で送り、`ccn update --from <送った先>` を実行する。

今回は戻していない。

## 確かめていないこと

- 本番での PTY の send、承認、中断、端末への入力。試しのセッションには何も入れなかった。
- 受け口の信頼の確認に答えた後の PTY の振る舞い。答えると `.claude.json` を書き換えるので、本人の確認が要る。
- 信頼済みの cwd を渡した `terminal: true` のセッション。
- 認証を通した MCP は、konaito-pro では loopback、ほかの2台ではサービストークンで呼んだ。Access の OAuth を通した MCP の呼び出しは試していない。
- konaito-pro と vm の止まったスレッドの数。sample は incertotech でだけ取った。
- 更新前に数秒だけ出ていた stream-json の claude がどのセッションのものか。
- Claude Town からの端末の口の利用。

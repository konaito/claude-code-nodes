# PTY の SIGWINCH の修正（PR #21）を本番の3台に配った記録（2026-11-12）

PR #21 をマージした main（8b187f1）を、konaito-pro、incertotech、vm の3台に配った。作業は konaito-pro の Specter のペイン（ccn-term）から行った。このペインは人が端末で開いたセッションで、ノードの子ではない。本人は同日に、親 meta-9d の「PR #21 を本番の3台に配っていい？配ると動いている PTY のセッションは全部終わる」という問いに「ターミナル系これで取り組んでください」と答えた。親はこれを、マージと配布の承認として依頼文に書いた。

## 結果のまとめ

| 確かめたこと | konaito-pro | incertotech | vm |
| --- | --- | --- | --- |
| 更新前の中身 | d5bd37f（`4922768cd196`） | 同左 | 同左 |
| 更新後の中身 | 8b187f1（`225ec979b4f1`） | 同左 | 同左 |
| 常駐の bun | 1.3.11 | 1.3.14 | 1.4.4 |
| `ccn doctor` | claude 2.1.322 の ng だけ（前と同じ） | claude 2.1.319 の ng だけ（前と同じ） | 全部 ok |
| `ccn peers` | 3台とも healthy | 同左 | 同左 |
| 試しの PTY の claude の TTY | `ttys034`、STAT `Ss+` | `ttys000`、STAT `Ss+` | `pts/1`、STAT `Ssl+` |
| 60x20 への resize の後の data | 2回、1649バイト | 2回、1649バイト | 1回、1648バイト |
| DELETE の後 | 204。GET は 404 | 同左 | 同左 |
| 再起動で終わった PTY | 1件（16a74e6e） | 0件 | 0件 |

前回の配布（PR #19）の前は、PTY の claude の TTY は `??` だった。PR #21 の記録では、直す前の版で resize の後に届いたのは 208 バイトの部分描画だけだった。

## 更新の前に記録したこと

- 中身の値は前回と同じ計算で出した。`src`、`skills`、`bin`、`package.json`、`bun.lock` の各ファイルの sha256 をまとめた値で、`._` で始まるファイルは除く。8b187f1 を `git archive` で取り出すと `225ec979b4f1`、356a653 を取り出すと `4922768cd196` だった。356a653 と d5bd37f の差は docs だけなので、値は同じになる。
- 3台の `~/.local/share/ccn/app` の値は、どれも `4922768cd196` だった。
- `ccn peers` では、3台とも healthy だった。

### 再起動で止まるセッション

21:53:32 に `ccn ls --peer <台>` で、exited 以外の行を見た。

- konaito-pro では、PTY のセッションが1件あった。`16a74e6e-6871-4c15-8df1-d940eb133bc6`（pty、idle、cwd は `~/Documents/meta`、parent は `local`）である。作成は 21:45:47、最後の動きは 21:47:41 で、claude の pid は 84990、TTY は `??` だった。誰が立てたものかは確かめていない。親 meta-9d に1行で伝えてから更新した。更新の後、pid 84990 は無くなった。
- konaito-pro の terminal の行（人が端末で開いたセッション）は、ノードの子ではない。更新の後も一覧に残った。
- incertotech と vm には、生きている node と pty のセッションが無かった。

## 更新

前回と同じ順番で、3台を `ccn update --from` で更新した。

| 台 | 時刻 | 入れた元 | 束の値の確認 |
| --- | --- | --- | --- |
| konaito-pro | 21:54:14〜21:54:16 | 8b187f1 を `git archive` で `/tmp/ccn-sigwinch-rollout/a-8b187f1` に取り出したもの | 取り出した後が `225ec979b4f1` |
| incertotech | 21:54:51〜21:54:52 | incertotech の上で `https://ccn-konaito-pro.fybe.jp/install/ccn.tar.gz` を新しい空のディレクトリに展開したもの | 展開後が `225ec979b4f1` |
| vm | 21:55:22〜21:55:23 | vm の上で `https://ccn.fybe.jp/install/ccn.tar.gz` を同じく展開したもの | 展開後が `225ec979b4f1` |

3台とも、出力は「更新した: …。node を再起動した。実行物は ccn」で、終了コードは0だった。incertotech には `ssh incertotech`、vm には `orb run -m ubuntu` で入った。ccn の子で入ると、`ccn update` の再起動でその子自身が止まるためである。vm では、macOS で作った tar の拡張ヘッダ（`LIBARCHIVE.xattr.com.apple.provenance`）について GNU tar が警告を出した。展開した中身の値は合っていた。

更新の前後で、ノードの pid は次のように変わった。

- konaito-pro: 65083 から 11922
- incertotech: 23382 から 25888
- vm（systemd の MainPID）: 21021 から 24019

更新後の app の値は、3台とも `225ec979b4f1` だった。

## 各台での確認

konaito-pro から `bun /tmp/ccn-sigwinch-rollout/check.ts <台>` を実行した。konaito-pro は 127.0.0.1:4323 を直に叩き、incertotech と vm は `https://ccn-<台>.fybe.jp` をサービストークンで叩いた。呼び手は `agent:konaito-pro/00000000/sigwinch-rollout-check` と名乗った。台本は次を順に行う。

1. `POST /api/sessions` に `{terminal: true, name: "sigwinch-rollout-check", cols: 120, rows: 40}` を送る。cwd、prompt、send は入れない。cwd を省いたので受け口に立つ。
2. 6秒待ち、`GET /api/sessions/<id>` で claude の pid を取る。その台の上で `ps -o pid,tty,stat,command -p <pid>` を見る。
3. 端末の SSE を開いて2秒読み、`POST …/terminal/resize` に `{cols: 60, rows: 20}` を送る。その後4秒読み、resize の後に届いた data の回数とバイト数を数える。
4. `DELETE /api/sessions/<id>` を送り、4秒後に GET が 404 であることを見る。

| | konaito-pro | incertotech | vm |
| --- | --- | --- | --- |
| 試しのセッション | `a37018ce-417c-433e-b532-56f54a40fc78` | `531d4123-a73e-43da-b46f-1ef74fc3870d` | `d55900e9-cb02-49bf-97c4-f97a0ebf0597` |
| 作成の応答 | 201、`kind: "pty"`、`state: "idle"` | 同左 | 同左 |
| ps | `ttys034`、`Ss+` | `ttys000`、`Ss+` | `pts/1`、`Ssl+` |
| SSE（resize の前） | `size`（120x40）、`replay`（1625バイト） | `size`、`replay`（1625バイト） | `size`、`replay`（1624バイト） |
| resize の応答 | 200。SSE に `size`（60x20、epoch は同じ）が流れた | 同左 | 同左 |
| resize の後の data | 2回、1649バイト | 2回、1649バイト | 1回、1648バイト |
| DELETE | 204、4秒後の GET は 404 | 同左 | 同左 |

STAT の `s` はセッションの頭、`+` は前面のプロセスグループを表す。claude が PTY を制御端末に持ち、その前面にいる。

### 描き直しの中身

konaito-pro で、resize の後に届いた data を取り出して中身を見た（`9d2705c3-4d47-4909-8ccb-4f1800354a88`）。このときは作成から12秒待った。data は `ESC[H` で左上に戻り、`ESC[2K` で行を1行ずつ消してから、信頼の確認の画面を描き直していた。制御列で区切った文字の並びは、いちばん長いもので37文字だった。PR #21 の記録にある `ESC[2J` は、今回の data には無かった。今回の画面は受け口の信頼の確認で、PR #21 の記録の画面（入力欄）とは違う。

同じ台本で、作成から6秒待つ版をもう1回 konaito-pro で回した（`3fc382c3-cead-4820-bf9b-648f263a98c3`）。このときは replay が10バイトで、resize の後の data は0回だった。claude の最初の描画がまだ届いていなかったと見ている。12秒待つ版に変えると、上のとおり描き直しが届いた。

### 片づけ

試しの PTY のセッションは5つとも DELETE で止めた。片づけの後、3台で生きている node と pty のセッションは0件で、`sigwinch-rollout-check` のプロセスも3台とも無かった。`/tmp/ccn-sigwinch-rollout` と、incertotech と vm の `/tmp/ccn-sigwinch-bundle.*` は残してある。

## 前の版に戻す手順

`ccn update` は `app.old` を消すので、各台に前の版は残っていない。戻すときは次のとおりにする。

- 356a653 を `git archive` で空のディレクトリに取り出す。取り出した後の値が `4922768cd196` であることを確かめる。`/tmp/ccn-sigwinch-rollout/a-356a653` に取り出してある。
- konaito-pro では、そのディレクトリを `ccn update --from` に渡す。
- incertotech と vm には、そのディレクトリを scp か orb で送り、`ccn update --from <送った先>` を実行する。

今回は戻していない。

## 確かめていないこと

- 本番での PTY の send、承認、中断、端末への入力。試しのセッションには何も入れなかった。
- 信頼済みの cwd を渡した `terminal: true` のセッションでの描き直し。今回の画面は3台とも受け口の信頼の確認だった。
- Claude Town からの幅の変更。Claude Town 側の子 ct-term に、配り終えたことと版を伝えた。
- 再起動で終わった 16a74e6e を誰が立てたか。

# PR #33（子は孫まで）を本番の3台に配った記録（2026-11-13）

PR #33 をマージした main（c831222）を3台に配った。main には PR #32（会話の件数を jsonl の印で覚える）も入っていて、#32 はこれまで本番に配っていなかった。今回の配布で #32 も3台に入った。作業は konaito-pro の Specter のペイン（ccn-depth）から行った。マージと配布は、親 meta-9d が依頼文で承認した。条件は、本人が使っている PTY のセッションが2分続けて idle になってから配ることと、配った後に同じ id の resume で立て直すことである。

## 結果のまとめ

| 確かめたこと | konaito-pro | incertotech | vm |
| --- | --- | --- | --- |
| 更新前の中身 | 9038627（`583d39d84da3`） | 同左 | 同左 |
| c831222 への更新 | 01:49:41〜01:49:46 | 01:41:18〜01:41:19 | 01:43:42〜01:43:43 |
| ノードの pid | 86213（更新後） | 30682 から 35480 | MainPID 28211 から 34270 |
| 更新後の中身 | c831222（`cda864d0ff8f`） | 同左 | 同左 |
| `~/.config/ccn/child.md` | c831222 の child.md と一致（cmp） | 同左 | 同左 |
| `ccn peers` | healthy | healthy | healthy |

中身の値は前回と同じ `apphash.sh` で出した。`src`、`skills`、`bin`、`package.json`、`bun.lock` の各ファイルの sha256 をまとめた値で、`._` で始まるファイルは除く。c831222 を `git archive` で `/tmp/ccn-depth-rollout/a-c831222` に取り出すと `cda864d0ff8f` だった。

## 配る順と待ち

01:40:51 に3台の生きている pty と node のセッションを見た。incertotech と vm には無く、konaito-pro には pty が7本あった。そこで incertotech と vm に先に配った。

- 束は `/tmp/ccn-depth-rollout/a-c831222` を tar に固めて送った。incertotech には scp、vm には `orb run -m ubuntu` の標準入力で送った。`orb push` は vm の `/tmp` に届かなかった。
- 各台で新しい空のディレクトリに展開し、値が `cda864d0ff8f` であることを確かめてから `ccn update --from` を実行した。
- incertotech は ssh の非対話のシェルに bun の PATH が無いので、`PATH=$HOME/.bun/bin:$PATH` を足して実行した。

konaito-pro は、3台の生きている pty と node が全部 idle で、最後の動きから2分以上たった状態を15秒ごとに見て待った。待つ処理に打ち切りは入れていない。29cf3311 が 01:44 ごろ running で、01:49:41 に全部が2分以上 idle になった。同じ台本の中で、そのまま状態を控え、`ccn update --from` で更新し、立て直した。

## 止まったセッションと立て直し

止まったのは konaito-pro の pty の7本である。立て直しは、loopback から `POST /api/sessions` に `{terminal: true, resume: <id>, cwd, cols, rows}` を送って行った。title があるものは `name` も渡した。大きさは、更新の前に端末の SSE の `size` で控えた値である。

親が `agent:` のものは、元の親の名前を `x-ccn-from` に付けて resume した。名乗らずに resume すると、parent が `local` に変わり、Claude Town の親子が切れるためである。親を先に、子を後に立て直した。fork はしていないので、id は元と同じである。

| セッション | cwd | parent | 大きさ | 立て直した後の pid と TTY | depth |
| --- | --- | --- | --- | --- | --- |
| 29cf3311-1607-4ab7-b210-db1734c1d2b3 | `~/Documents/meta` | local | 61x46 | 86675、`ttys003` | 0 |
| 859e2b1e-6d90-4dc9-8412-c64c0f66aa7b | `~/Documents/meta` | local | 61x54 | 86676、`ttys038` | 0 |
| 452bc6a2-5750-4e39-84d2-5a3635f33cbd | `~/Documents/meta` | local | 61x54 | 86681、`ttys039` | 0 |
| 0fdce7f0-0d68-426e-b28b-6ab00a104cff | `~/Documents/meta` | local | 48x38 | 86687、`ttys040` | 0 |
| b7fb48eb-8729-46fb-94ef-5e4e6592cd44（ct-bench） | `~/Documents/family-computing` | `agent:konaito-pro/29cf3311/lead` | 120x40 | 86788、`ttys044` | 1 |
| fcde771d-6739-490f-9313-e0d674591888（ct-assets） | `~/Documents/family-computing` | `agent:konaito-pro/29cf3311/lead` | 61x54 | 86790、`ttys045` | 1 |
| f742a9ab-b787-48d0-9554-d20a4449f2d2（sidenote ASO） | `~/Documents/sidenote` | `agent:konaito-pro/452bc6a2/meta` | 120x40 | 86798、`ttys047` | 1 |

7本とも 201 が返った。立て直した後の parent は元と同じだった。29cf3311、b7fb48eb、f742a9ab の replay の画面には、会話の続きと入力欄が出ていた。b7fb48eb の状態行は「計測がロック待ちで稼働中」だった。更新でその claude が止まったので、裏で動かしていた計測も止まった可能性がある。確かめていない。

## 各台での確認

### 別のノードをまたぐ連鎖

incertotech と vm を配り終えた後、konaito-pro からサービストークンで `https://ccn-<台>.fybe.jp` を直に叩いた。cwd はホームにし、prompt は入れていないので claude は起動しない。

| 順 | 立てた台 | 呼び手（`x-ccn-from`） | 応答 | depth |
| --- | --- | --- | --- | --- |
| 1 | incertotech | 無し（サービストークン） | 201、366ms | 0 |
| 2 | vm | `agent:incertotech/c56ea8c0/rollout-check` | 201、1607ms | 1 |
| 3 | incertotech | `agent:vm/eb3067eb/rollout-check` | 201、653ms | 2 |
| 4 | vm | `agent:incertotech/140dde2a/rollout-check` | 409、528ms | 呼び手が2 |

4の応答の本文は次のとおりである。

```json
{"error":"孫（深さ2）は子を作れない。仕事は自分でやるか、sub-agent（Agent ツール）を使う（呼び手 agent:incertotech/140dde2a/rollout-check の深さ: 2）","hint":"子を作れるのは深さ1まで（人が立てたセッションが0、その子が1、孫が2）","depth":2,"limit":2}
```

2から4では、立てた台がもう一方の台に `GET /api/depth` を中継で聞いている。立てた3本は DELETE で消した（3本とも 204）。

### 刻みの無い状態からのたどり

マージの前に、手元に試験用のノード（名前 konaito-pro、127.0.0.1:4417、本番と同じ `~/.claude` を読む）を立てた。再起動の後と同じく刻んだ値が無い状態で、`GET /api/depth` を聞いた。29cf3311=0、b7fb48eb=1、fcde771d=1、452bc6a2=0、f742a9ab=1、0fdce7f0=0 だった。このとき、SDK の `firstPrompt` の改行が空白に潰れていて、過去のセッションの parent が読めていなかったことが分かった。PR #33 の2つ目のコミットで直した。

## 前の版に戻す手順

- 9038627 を `git archive` で取り出し、値が `583d39d84da3` であることを確かめて、`ccn update --from` に渡す。`/tmp/ccn-sigwinch-rollout/a-9038627` に取り出してある。
- 戻すとノードが再起動するので、PTY のセッションは同じ手順で立て直す。台本は `/tmp/ccn-depth-rollout/redeploy.ts` にある。

## 確かめていないこと

- 立て直した PTY に、本人が続きを打てるか。
- b7fb48eb の計測が止まったかどうか。
- PR #32 の本番での効き目（CPU の前後の値）。

# PR #28、#29、#30 を本番の3台に配った記録（2026-11-12〜13）

PR #28（PTY の起動直後の入力、端末の SSE のまとめ方、一覧の取り方）と PR #29（PTY の messages に途中の文を出す）をマージした main（f9f147f）を、3台に配った。続けて、PR #30（ccn スキルと child.md）をマージした main（9038627）のうち、`skills/ccn/` の2ファイルだけを、ノードを再起動せずに入れ替えた。作業は konaito-pro の Specter のペイン（ccn-term）から行った。

承認は次のとおりである。

- PR #28 と #29 のマージと配布は、親 meta-9d が依頼文で承認した。条件は2つあった。本人が使っている e8c798cd の世帯が idle のときに配ることと、止まった PTY を resume で立て直すことである。
- PR #30 のマージと配布は、本人が ccn-term のターミナルで2回承認した。1回目は元の PR #30 についてで、2回目は meta-9d が求めた child.md の書き換えについてである。

## 結果のまとめ

| 確かめたこと | konaito-pro | incertotech | vm |
| --- | --- | --- | --- |
| 更新前の中身 | 8b187f1（`225ec979b4f1`） | 同左 | 同左 |
| f9f147f への更新 | 23:59:27〜23:59:29 | 23:31:54〜23:31:55 | 23:32:12 |
| ノードの pid | 11922 から 64542 | 25888 から 30682 | MainPID 24019 から 28211 |
| 9038627 の `skills/ccn/` への入れ替え | 00:06 | 00:06 ごろ | 00:06 ごろ |
| 最後の中身 | 9038627（`583d39d84da3`） | 同左 | 同左 |
| 入れ替えでノードの pid が変わったか | 変わらない（64542） | 変わらない（30682） | 変わらない（28211） |
| `~/.config/ccn/child.md` | 新しい文面と一致（cmp） | 同左 | 同左 |
| 試しの PTY の TTY | `ttys038` | `ttys000` | `pts/1` |
| 60x20 への resize の後の data | 1649バイト | 1649バイト（1024バイトは resize の応答より先に届いた） | 1648バイト |
| 作成の直後の send と途中の文 | 届いた（下に書く） | 確かめていない | 確かめていない |
| ノードの中で測った `/api/sessions` | 1〜14ms | 1〜11ms | 0.1〜0.3ms |

## 配る順と待ち

配る前に、3台の生きている pty と node のセッションを見た。

| 時刻 | 台 | セッション | 状態 |
| --- | --- | --- | --- |
| 23:23:50 | konaito-pro | e8c798cd（pty、`~/Documents/meta`、parent local） | idle、465秒 |
| 23:23:50 | konaito-pro | 0b43afbe（pty、`~/Documents/meta`、parent local、23:23:42 作成） | idle、1秒 |
| 23:23:50 | incertotech | 69d112e0（node、`~`、parent `agent:konaito-pro/e8c798cd/docs`） | idle、748秒 |

0b43afbe は 23:30 ごろ running だった。本人が使っていたので、作業中のセッションが無い incertotech と vm に先に配った。束は konaito-pro の `/install` を通さず、f9f147f を `git archive` で取り出したものを送った。各台で、展開した後の値が `f315ce9b7eb3` であることを確かめてから `ccn update --from` を実行した。incertotech の 69d112e0 は、この更新で終わった。

konaito-pro は、3台の生きている pty と node が全部 idle で、2分以上動いていない状態を15秒ごとに見て待った。待つ処理は20分で打ち切る作りにしていて、23:44 に打ち切れた。気づいたのは 23:59 だった。23:59:17 には e8c798cd が2594秒、0b43afbe が1140秒 idle だったので、23:59:27 に配った。打ち切りから約15分、配るのが遅れた。

## 止まったセッションと立て直し

| 台 | セッション | 止まった時刻 | 立て直し |
| --- | --- | --- | --- |
| incertotech | 69d112e0（node） | 23:31:54 | していない |
| konaito-pro | e8c798cd（pty） | 23:59:27 | 同じ id で resume、61x54、pid 64951、`ttys034` |
| konaito-pro | 0b43afbe（pty） | 23:59:27 | 同じ id で resume、48x38、pid 65322、`ttys037` |

立て直しは、loopback から `POST /api/sessions` に `{terminal: true, resume: <id>, cwd: "/Users/konaito/Documents/meta", cols, rows}` を送って行った。from 行は付けていないので、parent は元と同じ `local` になった。resume で fork はしていないので、id は元と同じである。permission-mode は渡していない。元の起動でも渡しておらず、`auto` は hook から届いた値だった。立て直した後の replay の画面には、2つとも会話の続きと入力欄が出ていた。

## 各台での確認

`/tmp/ccn-sigwinch-rollout/check.ts` で、受け口に 120x40 の試しの PTY を立て、10秒待ってから 60x20 に resize した。PR #27 の記録と同じ台本である。待つ時間を6秒から10秒に変えたのは、前回6秒では claude の最初の描画が間に合わなかった回があったためである。

| | konaito-pro | incertotech | vm |
| --- | --- | --- | --- |
| 試しのセッション | `c79dac24-fc68-4778-b137-002f3eaa18eb` | `1c14b2dd-cec2-421f-a8aa-68a98d7a4f04` | `725d7a4a-0e69-4890-ad26-2810bc114979` |
| 作成の応答 | 201、0.05秒 | 201、8.37秒 | 201、4.13秒 |
| DELETE の後の GET | 404 | 404 | 404 |

incertotech と vm への作成の要求は Cloudflare を通るので、時間にはその道の分が入る。外から8回ずつ `/api/sessions` を呼ぶと、incertotech は 0.39〜1.07秒、vm は 0.20〜3.38秒だった。ノードの中から curl で呼ぶと、incertotech は 1〜11ms、vm は 0.1〜0.3ms だった。外から測った時間の大半は、Cloudflare を通る道の時間と見ている。

konaito-pro では、`~/Documents/claude-code-nodes.wt/terminal-perf`（信頼済み）を cwd にして、model haiku、`bypassPermissions` の PTY を1本立てた。作成の直後に待たずに send すると、200 が返った。messages は次の順に届いた。PR #29 の前は 2、3、5 が出ていなかった。

1. user（from 行と依頼）
2. assistant（thinking）
3. assistant（text「Checking the date now.」）
4. assistant（tool_use Bash）
5. user（tool_result）
6. assistant（text「done」）
7. result

## child.md の入れ替え

`ccn update` はノードを再起動し、PTY のセッションが全部終わる。PR #30 の差分は `skills/ccn/SKILL.md` と `skills/ccn/child.md` だけだった。そこで、各台の `~/.local/share/ccn/app/skills/ccn/` の2ファイルを 9038627 の版で置き換え、`~/.config/ccn/child.md` に child.md を写した。`~/.agents/skills/ccn` は `app/skills/ccn` へのリンクなので、スキルもこれで新しい版になる。入れ替えた後の app の値は3台とも `583d39d84da3` で、9038627 を `git archive` で取り出した値と一致した。

前の child.md は、konaito-pro では `/tmp/ccn-sigwinch-rollout/child.md.before-konaito-pro`、incertotech と vm では `/tmp/child.md.before-9038627` に残してある。

## 前の版に戻す手順

- PR #28、#29 の前に戻すときは、8b187f1 を `git archive` で取り出す。値が `225ec979b4f1` であることを確かめ、`ccn update --from` に渡す。`/tmp/ccn-sigwinch-rollout/a-8b187f1` に取り出してある。
- child.md とスキルだけを戻すときは、f9f147f の `skills/ccn/` の2ファイルで置き換え、child.md を `~/.config/ccn/child.md` に写す。

## 確かめていないこと

- incertotech と vm での、作成の直後の send と途中の文。どちらにも信頼済みのディレクトリが無い。
- 立て直した e8c798cd と 0b43afbe に、本人が続きを打てるか。
- 新しい child.md で、ccn(local) の子が確かめずに進むか。

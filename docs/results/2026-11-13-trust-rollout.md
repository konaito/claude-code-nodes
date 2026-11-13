# PR #48（子を立てる前に cwd を信頼済みにする）を本番の3台に配った記録（2026-11-13）

PR #48 をマージした main（aeb1a64）を3台に配った。作業は konaito-pro の ccn の PTY の子（ccn-trust、04f598da）から行った。親は Meta（4fe4f09b）で、マージと配布は Meta が依頼文で承認した。

## #47 も一緒に入った経緯

aeb1a64 には、別の子 ccn-autostop（d39feb9d）が 18:00 にマージした PR #47（parent が `agent:` の子を、idle のまま10分たったら止める）も入っていた。ccn-autostop はマージまでで、`ccn update` はしていなかった。

ccn-trust はこれに気づかないまま、incertotech と vm に aeb1a64 を配った。配った後に更新前の中身の値を main のコミットと突き合わせて、#47 が入ったことに気づいた。konaito-pro に配る前に台本を止め、Meta に判断を求めた。Meta は aeb1a64 をそのまま配ると決めた（A）。理由は2つあった。#47 は本人が頼んでマージまで済んだ変更（imiworks #295）であること。main と違う版を本番に置くと、次の配布でも同じ判断が要ることである。incertotech と vm はそのままにした。#295 を担当したセッション（8074d764）には、3台に配ることを send_message で伝えた。

## 中身の値

中身の値は `/tmp/ccn-trust-rollout/apphash.sh` で出した。`src`、`skills`、`bin`、`package.json`、`bun.lock` の各ファイルの sha256 をまとめ、先頭12桁を取った値で、`._` で始まるファイルは除く。台本を書き直したので、過去の記録の値とは比べられない。

| コミット | 値 |
| --- | --- |
| aeb1a64（#48 のマージ） | `d71235bb44fc` |
| b8d530d（#47 のマージ） | `4598ea65cb4d` |
| 8b3b6a4（#45 のマージ） | `2d47227f504d` |
| 88c2976（#42 のマージ） | `e1196002839f` |
| 7f3bbad | `38d637bf553f` |

## 結果のまとめ

| 確かめたこと | konaito-pro | incertotech | vm |
| --- | --- | --- | --- |
| 更新前の中身 | 8b3b6a4（`2d47227f504d`） | 7f3bbad（`38d637bf553f`） | 7f3bbad（`38d637bf553f`） |
| 今回入った PR | #47、#48 | #42、#45、#47、#48 | #42、#45、#47、#48 |
| aeb1a64 への更新 | （台本の結果で埋める） | 18:02:32〜18:02:33 | 18:03:44 |
| ノードの pid | （同上） | 42896 から 68574 | MainPID 293 から 1075 |
| 更新後の中身 | （同上） | `d71235bb44fc` | `d71235bb44fc` |
| claude の版 | 2.1.323 | 2.1.319 | 2.1.322 |
| 確認画面（新しい git リポジトリのサブディレクトリ） | （同上） | 出ない | 出ない |
| 確認画面（git worktree の中） | 試していない | 試していない | 出ない |
| send と返事 | （同上） | 200、`pong` | 200、`pong` |

## incertotech と vm

- 配る前の生きているセッションは、incertotech は端末のセッション1本（94e1cf36、idle）だけで、vm には無かった。端末のセッションはノードの更新で止まらない。
- vm は止まっていて、`/n/vm/api/...` が 530 を返した。`orb run` で起動したので、そのまま動かしている。配った後の `ccn peers` は3台とも healthy だった。
- 束は aeb1a64 を `git archive` で取り出して tar に固めた。incertotech には scp、vm には `orb run -m ubuntu` の標準入力で送った。各台で新しい空のディレクトリに展開し、値が `d71235bb44fc` であることを確かめてから `ccn update --from` を実行した。
- 確かめるのは `/tmp/ccn-trust-rollout/verify.ts` で行った。ホームの下に新しい git リポジトリを作り、そのサブディレクトリに PTY の子（haiku）を立てる。10秒後の画面を端末の SSE の replay で読み、HTTP の `POST /api/sessions/<id>/messages` で「reply with the single word pong」を送る。最後に DELETE で止め、試しの項目を claude と同じロックを取って `.claude.json` から消し、リポジトリと会話の置き場も消す。`WT=1` を付けると、空コミットを作って `git worktree add` した先を cwd にする。
- 両方の台で、作成の直後に cwd とルートの項目が true になっていた。画面は確認画面ではなく入力欄だった。messages には user、assistant（`pong`）、result の順に届いた。

## konaito-pro

konaito-pro には ccn-trust は配っていない。#295 を担当したセッション（8074d764）が、18:01 から自分の台本（`~/.local/share/ccn/tools/update-resume.py`、pid 12992）で更新を待っていたためである。ノードを2回再起動しないよう、ccn-trust の台本（`/tmp/ccn-trust-rollout/rollout-pro.ts`）は止めた。8074d764 の台本は `ccn update` の後に印（`withoutHeadless`、`idleStoppable`）を探し、無ければ `~/Documents/claude-code-nodes` を main に pull して `ccn update --from` で入れ直す。

（更新の後の結果で埋める）

## 前の版に戻す手順

- konaito-pro は、8b3b6a4 を `git archive` で取り出した `/tmp/ccn-trust-rollout/a-8b3b6a4`（値 `2d47227f504d`）を `ccn update --from` に渡す。
- incertotech と vm は、7f3bbad を取り出して値が `38d637bf553f` であることを確かめ、`ccn update --from` に渡す。

## 確かめていないこと

- MCP の `send_message` での送信。確かめたのは、同じ処理を通る HTTP の `POST …/messages` である。
- incertotech と konaito-pro での、git worktree の中を cwd にした場合。

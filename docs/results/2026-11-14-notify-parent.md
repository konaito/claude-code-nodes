# 子の知らせを親のセッションに届ける（実機の確認）

2026-11-14 に konaito-pro で、手元に立てた試験用のノードを使って確かめた。本番のノード（4323）とそのセッションには触っていない。

## 条件

- ブランチ `feat/notify-parent`（コミット 27072f4）、Claude Code 2.1.325
- 試験用のノードは `CCN_CONFIG=/tmp/ccn-notify-test/ccn.json bun run src/cli/ccn.ts serve` で立てた。設定は name `ntest`、port 4391、roots `/tmp/ccn-notify-test`、lobby `/tmp/ccn-notify-test/lobby` だけにした。
- 親は pty のセッション（4ff32633、人が立てた形で parent は `local`）にした。知らせが来たらツールを使わずに1行で返すよう、最初の文で頼んだ。
- 子は curl に `x-ccn-from: agent:ntest/4ff32633/lead` を付けて立てた。

## 結果

| 確かめたこと | 子 | 親に届いた文（親の messages の user 行） |
| --- | --- | --- |
| ターンの終わり | node（179a918d）。result は seq 35 | seq 4 `[ccn] 子 work（179a918d）のターンが終わった。read_messages peer=ntest session=179a918d-… after=0 で読んで（読み済みなら返事は不要）` |
| 承認待ち | node（3b348de6）、permission default で Bash を頼んだ | seq 8 `[ccn] 子 work（3b348de6）が承認を待っている: Bash Create probe file and confirm it exists。answer_permission peer=ntest session=3b348de6-… request_id=4c0ea99f-… で答えて` |
| まとめと間引き | 同じ子。許可した後のターン（seq 83）と、親の名で返事を送った後のターン（seq 93） | seq 11 `…のターンが終わった（2回分）。… after=0 …`。承認待ちの知らせから20秒以内だったので1通にまとまった |
| 思わぬ終わり方 | pty（e5bd9463、name np-crash）。claude の pid 8122 に SIGTERM | seq 14 でターンの終わり、seq 17 `[ccn] 子 np-crash（e5bd9463）が終わった: exit 143。会話は create_session peer=ntest resume=e5bd9463-… で続けられる` |
| API で止めた子 | 179a918d と 3b348de6 を DELETE（204） | 15秒待っても親に何も届かなかった |

- 往復しないこと: 親が子に返事を送り、子のターンが終わって親に知らせ、親のターンが終わった（seq 13）。その後、子の側には新しい行が無かった（子の result は seq 83 と 93 だけ）。
- 親の端末の画面にも、`from ccn:ntest/179a918d via ntest` の行と本文が、人が打った文と同じ形で出た。親はそれを読んで1行で返した。
- 子の表示名は、pty の子では name（np-crash）、node の子では cwd の最後の名前（work）になった。

## 片付け

親は API の DELETE で止め、試験用のノードは pid 76262 に SIGTERM を送って止めた。止めた後、`pgrep -f ccn-notify-test` は何も返さなかった。

## 残っていること

- pty の親が承認待ちの間は送れない。10秒から倍々に60秒まで伸ばして15回（約13分）送り直し、それでも受けられなければ捨ててノードのログに書く。

- 別のノードにいる親には送らない。送るには中継で親のノードに頼む口が要る。
- `stop_session` は呼び手を名乗らないので、親が止めたのか人が止めたのかを見分けず、API の stop は全部知らせない。
- 親が自分で `read_messages` で待っている最中にターンが終わると、同じ報告の知らせが後から1通届く。`read_messages` も呼び手を名乗らないため、読んだのが親かどうかで抑えられない。本文に「読み済みなら返事は不要」と書いた。
- pty の親の入力欄に人が打ちかけの文字があるときの動きは試していない。`PtyDriver.send` は貼り付けと Enter を送るので、打ちかけの文字と一緒に送られるおそれがある。

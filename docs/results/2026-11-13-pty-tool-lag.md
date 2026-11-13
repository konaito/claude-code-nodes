# PTY のセッションで tool_use と tool_result が messages に遅れて出る（#43）

## 何が起きた

pty のセッションで、Bash の tool_use は jsonl にすぐ出たが、`GET /api/sessions/<id>/messages` には25秒たっても出なかった。Claude Town では、終わった道具が十数秒から30秒「実行中」のまま残った。

## 原因

`PtyDriver` は hooks が届いたときだけ、SDK の `getSessionMessages` で会話の行を読む。2026-11-13 に `claude -p` へ command の hook を付けて、hook の時点の jsonl の行を数えた。

- PreToolUse の時点で、tool_use の行はもう jsonl にある。PreToolUse の hook を入れていなかったので、承認の要らない道具の tool_use は PostToolUse（道具が終わった後）まで読まれなかった。
- PostToolUse の時点で、tool_result の行はまだ jsonl に無い。結果の行は、次の hook（次の道具の PostToolUse か Stop）まで読まれなかった。

## 直し方

- hooks に PreToolUse を足した。hook には待たせずに応答し、裏で会話の行を読む。
- PostToolUse の後、その tool_use_id の結果の行が出るまで、150、300、600、1200、2400 ミリ秒の間隔で読み直す。出たら止め、全部待っても出なければあきらめる。サブエージェントの道具（hook に agent_id がある）は追わない。
- 読み込みは、走っている1本と、その後に続ける1本にまとめる。hooks が重なっても jsonl を読む回数は増えない。
- `getSessionMessages` に起動した cwd を `dir` で渡す。見つからなければ今までどおり全部のプロジェクトから探す。

## 実機で測った結果

konaito-pro で、origin/main（88c2976）のノードを 4391、修正版を 4392 で立てた。どちらも cwd はこのリポジトリ、権限モードは既定（auto）。`/tmp/ccn-measure/measure.ts` が pty の子を立て、100ミリ秒ごとに jsonl と `messages?after=0` を読み、同じ tool_use_id が出た時刻の差を取った。

| 試し方 | 修正前 tool_use | 修正前 tool_result | 修正後 tool_use | 修正後 tool_result |
| --- | --- | --- | --- | --- |
| `sleep 8` を1回 | 9.23秒 | 1.25秒 | 0.62秒 | 0.31秒 |
| `sleep 6` を2回続けて（1回目） | 6.16秒 | 7.35秒 | 0.52秒 | 0.31秒 |
| `sleep 6` を2回続けて（2回目） | 6.01秒 | 1.08秒 | 0.10秒 | 0.20秒 |

修正前の tool_result の遅れは、次の hook までの時間で決まる。1回だけの道具では Stop がすぐ来るので小さく見える。

待機中の CPU は、両方のノードを60秒置いて `ps -o cputime` で比べた。修正前は 0.01秒、修正後は 0.04秒増えた。どちらも 0.1% 未満で、待機中は読み直しのタイマーを持たない。

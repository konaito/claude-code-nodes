# PTY のセッションを付け直した後も前の会話を返す（2026-11-13）

## 起きていたこと

Claude Town から立てた PTY のセッションで、会話欄が空になるものがあった。
ノードを起動し直すと、Claude Town は PTY のセッションを `terminal: true` と `resume` で付け直す。
`GET /api/sessions/<id>/messages` は、生きているセッションに台帳（メモリ）のイベントだけを返していた。
台帳には付け直した後のイベントしか無いので、前の会話は0件になった。
端末のセッション（Specter などで人が立てたもの）は jsonl から返すので見えていた。

## 直し方

resume で付け直すとき、claude を起動する前に `History.count` で会話の件数を数える。
台帳はその件数（`historyBase`）から seq を振る。
`messages?after=` は、after が `historyBase` より前なら jsonl の会話を履歴の位置で返す。
履歴を読み切ったページには、続けて台帳のイベントを入れる。

cursor と SSE の seq の数え方は今までと同じにした。
CLI の `ccn read` は PTY のセッションを SSE（seq）で読むので、cursor を履歴の件数に変えると CLI が壊れる。
作成の応答に `cursor`（`historyBase`）を入れ、MCP の `create_session` はそれを返す。
cursor を 0 のままにすると、resume した直後の `read_messages` が前の会話の返事を今の返事として読む。

## 試験用のノードでの確認

本番のノード（ポート 4323）には触れず、ポート 4391 に試験用のノードを立てた。
PTY のセッションは1体（2dadd124）だけを使った。

1. `terminal: true` と prompt で立て、PONG1 の返事を受けた。`messages?after=0` は3件（user、assistant、result）だった。
2. ノードを SIGTERM で止めた。`stopPtysOnExit` が claude を止めた。
3. ノードを起動し直し、`terminal: true` と `resume` で付け直した。作成の応答は `"cursor":2` だった。
4. 付け直した直後の `messages?after=0` は2件（PONG1 の user と assistant、seq なし）だった。直す前のコードでは0件になる。
5. cursor 2 のまま1通送った。`messages?after=2` は3件（seq 3、4、5）で、PONG2 の返事を含んだ。
6. `messages?after=0` は5件で、jsonl の2件と台帳の3件が重ならずにつながった。
7. CLI の `ccn send` は `seq=5` を控え、`ccn read` は PONG3 を返して終了コード 0 で終わった。

付け直しの起動だけでは、jsonl の会話の件数は 2 から変わらなかった（手順 3 と 4）。

画面（`/`）も試験用のノードで見た。
同じセッションをもう一度 resume し（作成の応答は `"cursor":6`）、agent-browser で開いた。
開いた直後に前の会話6件（PONG1〜3）が出た。
画面から1通送ると PONG4 が1回だけ出て、開き直しても jsonl の6件と台帳の3件が順に並び、`lastSeq` は 9 だった。
コンソールのエラーは無かった。
送った文が「あなた」と from 行つきの2行で出るのは、画面が送った文を手元で足し、pty が UserPromptSubmit から user のイベントも流すためで、直す前からある。

## 残っていること

- 再起動をまたいで cursor を持ち続ける読み手（Claude Town の会話のキャッシュ、`ccn read` の控え）は、付け直した後の分を読み落とすか、途中から重ねて読むことがある。台帳の seq は result や承認のイベントの分だけ jsonl の件数より先に進むので、再起動の前の cursor と付け直した後の番号がそろわない。実機では、再起動の前の末尾が 3、付け直した後の境界が 2 だった。前の cursor 3 で読むと seq 4 と 5 だけが返り、seq 3（PONG2 を頼んだ user の行）が落ちる。直す前は、付け直した後の番号が 1 から振られるので、もっと多く落ちていた。Claude Town を起動し直せば 0 から読み直してそろう。直すなら、messages の応答に台帳の末尾を入れ、読み手は自分の cursor が末尾を超えていたら 0 から読み直す。
- 付け直した後の分は、今までどおり台帳の上限（2000件）に入る。長く動いたセッションを 0 から読み直すと、`historyBase` と台帳の先頭の間が欠けることがある。
- fork の resume は `historyBase` を 0 のままにした。新しい id の jsonl が、起動の前にはまだ無いため。
- セッションが終わった後の messages は jsonl の位置で数える。生きていた間の cursor とずれるのは、直す前と同じ。
- `/compact` の後に `getSessionMessages` の件数が減るかは確かめていない。

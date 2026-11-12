# PTY の Driver と端末の口の確認

2026-11-12。ブランチ `feat/pty-driver`。設計は Claude Town（`~/Documents/family-computing`）の `docs/design/terminal-panel.md` の「A2 の中身」にある。本人は同日に親 meta-fc の端末で A2 を選んだ。

## 試した環境

- macOS、bun 1.3.11、claude 2.1.322。
- 試験ノードは `CCN_CONFIG=/tmp/ccn-pty-node/ccn.json`（name `ptytest`、port 4417、roots `/tmp/ccn-pty-node`、Access なし）で立てた。本番ノードには触っていない。
- セッションは `--model haiku` で起動した。

## 作る前の実験（`/tmp/ccn-pty-exp`、Bun.Terminal で claude を直接起動）

- `\x1b[200~…\x1b[201~` で貼り付けてから `\r` を押すと、改行を含む文が1つのプロンプトとして入った。UserPromptSubmit の `prompt` に改行がそのまま届いた。
- `--settings` のファイルに書いた http の hooks は、利用者の hooks と一緒に動いた。PermissionRequest の hook が応答を返さない間も、端末には普段の承認画面が出ていた。hook が allow を返すと画面は「Allowed by PermissionRequest hook」で閉じ、ツールが動いた。
- 端末で「1」を押して許可すると、ツールは動いたが hook の要求は切れなかった。Bun のサーバーで要求の abort は起きなかった。
- 端末の承認画面で Esc を押して拒否すると、Stop、PermissionDenied、PostToolUseFailure のどれも届かなかった。
- ツールの実行中に Esc を書くと「Interrupted · What should Claude do instead?」で止まった。このときも Stop は届かなかった。
- Stop の hook の入力には `last_assistant_message` がある。
- `claude agents --json` には、こちらが決めた `--session-id` と `--name` のまま `kind: interactive` で出た。
- 未信頼の cwd の対話セッションは、信頼の確認に答えるまで hooks を止める（hooks の公式文書「Workspace trust」）。`mktemp -d /tmp/...` の新しいディレクトリでは確認は出なかった。

ここから次のことを決めた。

- 最初の文は引数で渡す。起動直後の画面と貼り付けが競合しないため。
- 承認待ちの間の send は 409 で断る。Enter が承認画面の選択になるため。
- 端末で答えた承認は、同じ道具と入力の PostToolUse（PostToolUseFailure）、Stop、UserPromptSubmit で片付ける。hooks が来ない操作（端末への Esc、数字、Enter と API の interrupt）の後は、1.5秒後に `claude agents --json` の `status` と `waitingFor` で照らし合わせる。
- send は SessionStart の hook が届くまで待つ（最大20秒、過ぎたら 409）。prompt 無しで作った直後に貼り付けると文が落ちた（次の節の追加の確認）。SessionStart は command の hook しか使えないので curl で送る。SessionStart が届いた直後（0.74秒）に貼り付けた文は通った。
- hooks の宛先は `http://127.0.0.1:<port>/hooks/pty/<id>` にする。Access の呼び手ではなく、同じ機械（loopback で `cf-connecting-ip` が無い）とセッションごとの token で受ける。token を引数に出さないため、設定は 0600 のファイルで渡す。

## 試験ノードでの確認

`/tmp/ccn-pty-node/live.ts`、`live2.ts`、`live3.ts`、`mcp-live.ts` で HTTP と MCP から叩いた。

| 項目 | 結果 |
| --- | --- |
| 作成 | `POST /api/sessions` に `terminal:true`、`prompt`、`permissionMode:"default"`、`name`、`cols:100`、`rows:30`、`x-ccn-from: agent:ptytest/abcd1234/town` で 201、`kind:"pty"`、`state:"running"` |
| 承認 | `GET /api/sessions/<id>` の `pending` に `toolName:"Bash"` と `input.command` が入った。承認待ちの間の send は 409。`POST …/permissions/<requestId>` の allow でファイルが書かれ、state は idle になった |
| イベント | `messages?after=0` は `user, permission_request, permission_answered, assistant, assistant, result` |
| 一覧 | 1件だけ出た（`kind:"pty"`、`title:"pty-live"`、`parent:"agent:ptytest/abcd1234/town"`、`capabilities.terminal:true`）。同じ id は `claude agents --json` にも `pid` と `name:"pty-live"` で出ていた |
| リサイズ | `POST …/terminal/resize` の 80x24 で、繋いでいる画面に `event: size` の `{"cols":80,"rows":24}` が届いた |
| 入力 | `POST …/terminal/input` の `{"text":"Reply with exactly: typed-ok"}` と `{"data":"DQ=="}`（Enter）で、返事が `typed-ok` になり、画面のバイト列にも出た |
| send | `POST …/messages` で `{"delivered":"pty"}`。返事は `sent-ok` |
| 再接続 | `?after=<最後の id>` で繋ぎ直すと、replay を送らず size から始まった |
| 再生と中継 | `/n/ptytest/api/sessions/<id>/terminal`（自分への中継の道）で `size` の次に `replay`（id 23075）が届いた |
| 端末での拒否 | 承認待ちのときに `terminal/input` で Esc を書くと、4秒後に pending が0、state が idle になり、ファイルは書かれなかった |
| 中断 | ツール（40秒かかるスクリプト）の実行中に `POST …/interrupt` で、4秒後に state が idle、イベントの末尾が `result:interrupted` |
| 停止 | `DELETE` で 204。その後の一覧には履歴の行（`kind:"node"`、`state:"exited"`）として1回だけ出た |
| MCP | `create_session`（terminal、name、as、as_session）、`read_messages`（`stop=permission` の後 `stop=result`）、`get_session` の `pending[].shown`、`answer_permission`、`list_sessions(parent=agent:ptytest/feedbeef/lead)`、`stop_session` が通った |

### 追加の確認（試験ノードを `CLAUDE_CONFIG_DIR` を外して立て直した後）

常駐と同じく `~/.claude` を使う形で、`/tmp/ccn-pty-node/live4.ts` と `live.ts` を通した。

| 項目 | 結果 |
| --- | --- |
| 設定ディレクトリ | `env -u CLAUDE_CONFIG_DIR` で立てたノードでも hooks が届き、承認と返事が通った |
| 作成直後の send | 直す前は、prompt 無しで作った直後の `POST …/messages` の文が届かなかった（イベントが空）。SessionStart を待つように直した後は `user, permission_request` が届いた |
| 承認待ちの照らし合わせ | 承認画面が出ている間の `claude agents --json` は `status:"waiting"`、`waitingFor:"permission prompt"`。この間に ↓ と `\x1b[I`（フォーカス）を `terminal/input` で書いても、3.5秒後に pending は残っていた |
| `/clear` | 端末で `/clear` した後も、`claude agents --json` の同じ pid の sessionId は元のままだった。一覧に別の行（kind terminal）が1つ出たが、利用者の hook（`close-check-state.py`）が同じ cwd で起動した `claude -p` だった。念のため、生きている PTY の pid と同じ行も一覧から除くようにした |
| resume | DELETE した後に `terminal:true` と `resume:<id>` で作ると同じ id で起動した。前の会話で書いた語を聞くと `keep` と答えた |
| allow の入力 | allow で `updatedInput` が無ければ元の入力を返すようにした（NodeDriver と同じ。AskUserQuestion と ExitPlanMode は updatedInput が要る）。直した後も live.ts の承認が通った |

`bun test` は 305 件が通り（1件は CC_LIVE の skip）、`bunx tsc --noEmit -p .` はエラー無し。

## 確かめていないこと

- 別の機械のノードを通した中継（Cloudflare の先）での端末の口。手元の試験ノードは Access が無いので、`/n/<自分>/` の道と、偽の相手への中継の試験だけで確かめた。
- ノードの常駐（LaunchAgent）から起動した PTY。試験ノードは端末から起動した。
- `terminal:true` と `resume` と `fork` の組み合わせ。
- 端末で `/clear` した後に、ノードの台帳の id と会話の id がずれること。hooks の `session_id` は変わる可能性があるが、ノードは最初の id のまま扱う。
- 未信頼のディレクトリで、信頼の確認が端末に出る様子。
- 30本を同時に持ったときの CPU とメモリ。Claude Town 側の子 family-computing が測る。
- 末尾の再生で画面がどこまで戻るか。Claude Town 側で xterm.js に流して確かめる。
- 承認待ちのまま claude が hook を待つ上限。hook の timeout は7日にしてある。

## 制約

- ノードを再起動すると PTY のセッションは全部終わる。会話は残り、`terminal:true` と `resume` で続けられる。
- 人が端末で最初の文を打ったセッションは、終わって台帳から消えた後（30分後）に履歴から parent を引けない。履歴の parent は最初の文の from 行から作るため。
- `read_messages` に出るのは、ターンの終わりの文（Stop の `last_assistant_message`）と使った道具の名前だけ。途中の文は端末の画面にしか出ない。
- 停止した後の一覧の行は履歴から作るので、`kind` は `node` になる。
- SessionStart が届かない（信頼の確認が出ている、curl が無い）と、send は20秒待って 409 を返す。

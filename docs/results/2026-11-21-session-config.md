# モデルと権限モードの切り替え（#64）の実測

2026-11-21 に konaito-pro で確かめた記録。claude 2.1.330、SDK 0.3.318。本番のノード（4323）は使っていない。

## 実装の前の実測

捨ての cwd（`ct-probe-*`）で haiku を起動し、PTY と SDK の両方で試した。表は #64 にある。設計に効いたのは次の4つ。

- 対話の claude に `/model sonnet` を貼ると、`~/.claude/settings.json` に `"model": "sonnet"` が足された。cam の各プロファイルの settings.json はこのファイルへのリンクなので、機械の全セッションの既定が変わる。打った後にキーを消して戻した（14:31 の settings.json.bak と比べ、もとはキーが無かったことを確かめた）。
- Shift+Tab を3回送ると、モードは bypass、manual（default）、acceptEdits、plan の順に変わった。その間に hook は1つも来なかった。statusLine の入力には `permission_mode` が無い。
- 同じ id を `--resume <id> --model sonnet --permission-mode plan` で起動し直すと、次の応答の `message.model` が `claude-sonnet-5-5` になり、UserPromptSubmit の `permission_mode` が `plan` になった。SessionStart（source=resume）には `model` が無い。settings.json は変わらなかった。
- SDK の `setModel("sonnet")` と `setPermissionMode("acceptEdits")` は、次の system/init にそのまま出た。settings.json は変わらなかった。

## 開発用ノードでの確認

worktree の版で、別ポート（4395）と別設定のノードを立てた。設定は `{ "name": "ctprobe", "port": 4395, "roots": ["…/ct-probe-dev"], "lobby": "…/ct-probe-dev/lobby" }`。

| 口 | 種類 | 手順 | 見たもの | 結果 |
| --- | --- | --- | --- | --- |
| HTTP | pty | haiku、default で作り1ターン、`PATCH {"model":"sonnet","permissionMode":"plan"}`、もう1ターン | PATCH の応答は2.9秒で `idle`、`sonnet`、`plan`。pid が替わった。jsonl の2ターン目は api-request が `claude-sonnet-5-5`、user 行の `permissionMode` が `plan` | 効いた |
| MCP | pty | `create_session`、`configure_session`、`send_message`、`get_session` | `get_session` は `sonnet`、`plan`。jsonl の2ターン目は `claude-sonnet-5-5` と `plan` | 効いた |
| MCP | node | 同じ | `get_session` は `claude-sonnet-5-5`、`plan`。`read_messages` の2ターン目の assistant が `claude-sonnet-5-5` | 効いた |

どの回も、終わった後の `~/.claude/settings.json` の sha は始める前と同じだった。

## 見つけて直したもの

- 起動し直した後に、前のターンの thinking の行が遅れて読まれ、その `message.model`（haiku）で一覧の `model` が戻っていた。モデルを決めた時刻より古い行では替えないようにした。
- pty の2ターン目の文の行は、Stop の hook の文で補った分と同じなので ccn には流れない（今までどおり）。そのため、pty の `model` は指定した名前（`sonnet`）のまま残ることがある。

## 片付け

開発用ノードが立てた pty と node のセッションは `stop_session` で止めた。

## 組み込みコマンドの口（POST /api/sessions/<id>/command、MCP の run_command）

開発用ノード（4395）で、MCP から haiku の子に送った。どちらも1通目は from 行つきの send。

| コマンド | pty | node |
| --- | --- | --- |
| `/context` | 効く。出力は jsonl の system の行に書かれ、SDK の `getSessionMessages` が中身を返さない（`includeSystemMessages` でも content と subtype が無い）。ccn には約9秒後に空の result が出る | 効く。`## Context Usage` の表が read_messages に出た |
| `/compact` | 効く。`Compacted (ctrl+o to see full summary)` と hook の結果の行が出て stop=result。間は running | 効く。stop=result（文は無い） |
| `/effort low` | 409（`persists`）で送らない | 効く。「this session only」 |
| `/model sonnet` | 400（`use_configure`） | 400（`use_configure`） |
| `hello` | 400（`not_command`） | 400（`not_command`） |
| `/clear` | 効く。`conversationId` が新しい id になり、すぐ stop=result。次の文の返事も読めた | 効く。`conversationId` が新しい id になった。次の文の返事も読めた |

pty は `/clear` の後に `configure_session` で sonnet に替え、新しい会話の id で `--resume` して3ターン目が `claude-sonnet-5-5` で動いた（jsonl で確認）。read_messages には `[command] /context (from agent:ctprobe/ccccdddd/check)` のように送り手が出た。終わった後の settings.json の sha は始める前と同じだった。

## プロンプト無しの pty で起動し直す（#71）

main（b2bda6e）の開発用ノードで、Claude Town で起きやすい順を試した。

- プロンプト無しで pty を作り、すぐ `PATCH {"model":"sonnet"}`、1通送る: 効いた。
- プロンプト無しで pty を作り、`/context` だけ打ってから `PATCH {"model":"sonnet"}`: セッションが `restart failed` で終わった。
  - `/context` は jsonl に system の行だけを書く。SDK の `getSessionMessages` は空を返し、`getSessionInfo` も undefined を返した。そのため ccn は「会話が無い」と見て `--session-id <同じ id>` で起動し、claude はすぐ終わった。同じ jsonl に `claude -p --resume <id>` は効いた。
  - 会話が読めないときは `--session-id` で起動し、すぐ終わったら `--resume` を試すように直した。直した後は2つとも、次の応答が jsonl で `claude-sonnet-5-5` になった。
- 端末の SSE（`/terminal`）をつないだまま pty の `PATCH {"permissionMode":"plan"}` を送った。20秒の間に `size`、`replay`、`data`（14回）が届き、`exit` は届かなかった。

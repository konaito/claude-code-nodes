# チャット欄からセッションを操作する口（Claude Town 向け）

Claude Town のチャット欄から、モデルの切り替えや組み込みコマンドを起動中の ccn セッションに送るための口の仕様。konaito/claude-code-nodes#64 で作った（PR #65、#66）。実測の記録は `docs/results/2026-11-21-session-config.md` にある。

対象は、ノードが立てたセッション（kind `node` と `pty`）。人が端末で起動したセッション（kind `terminal`）は、どの口も 409 で断る。別のノードのセッションは、今までどおり `/n/<peer>/api/...` の中継で同じ口を使う。

## 1. モデルと権限モードを替える

```
PATCH /api/sessions/<id>
{ "model": "sonnet", "permissionMode": "plan" }
```

MCP では `configure_session`（`session`、`model`、`permission_mode`）を使う。

- どちらか片方だけでもよい。両方とも省くと、何も替えずに今の要約を返す。
- `model` は別名（`opus`、`sonnet`、`haiku`）か id（`claude-sonnet-5-5`、`claude-fable-5[1m]` など）。英数字と `._:-[]` の100字までを受ける。
- `permissionMode` は `default`、`acceptEdits`、`bypassPermissions`、`plan`、`dontAsk`、`auto` のどれか。
- 替わるのはそのセッションだけで、設定ファイル（`~/.claude/settings.json`）は書き換えない。

応答は今の要約（`GET /api/sessions/<id>` と同じ形）。`model` と `permissionMode` に替えた後の値が入る。

### node と pty の違い

| | node（-p の子） | pty（対話の claude） |
| --- | --- | --- |
| 替え方 | SDK の `setModel` と `setPermissionMode` | 同じ id で `claude --resume <id> --model <名前> --permission-mode <モード>` として起動し直す |
| 受けるとき | いつでも。ターンの途中なら、次のモデルの呼び出しから効く | 待機中（`state` が `idle`）のときだけ |
| かかる時間 | すぐ | 約3秒（実測 2.9秒） |
| 失うもの | 無い | 裏で動いているシェルとサブエージェント、端末で選んだセッションだけの設定（effort など）、プロンプトのキャッシュ |
| 端末の画面 | 無い | つながったまま。画面は起動し直した claude の画面に替わる |
| 台帳のイベント | 無い | `config`（`{model, permissionMode}`） |

### 断られるとき

| 状態コード | `code` | 意味 | 次の手 |
| --- | --- | --- | --- |
| 400 | なし | `model` か `permissionMode` の値が外れている | 値を直す |
| 409 | `busy` | pty が動いているか、承認を待っている | 終わるのを待つか、`POST /api/sessions/<id>/interrupt` で止めてから送る |
| 409 | なし（`hint: resume`） | セッションが終わっている | resume して作り直す |
| 409 | なし（`kind` あり） | 端末のセッションなど、替えられない種類 | 替えられない |
| 502 | `restart_failed` | pty の claude が新しい設定で起動しなかった。`rolledBack: true` なら前の設定で動いている | 値を見直す |

### 今の値の読み方

`GET /api/sessions/<id>` の `model` と `permissionMode`。

- node の `model` は system/init の値で、`claude-sonnet-5-5` のような id になる。
- pty の `model` は、起動か `PATCH` で指定した値（`sonnet` のような別名のことがある）か、応答の行のモデルの id のうち新しいほう。
- pty の `permissionMode` は、指定した値か、hook（UserPromptSubmit など）の `permission_mode` のうち新しいほう。人が端末で Shift+Tab を押しても hook が来ないので、次の文を送るまで古い値が出る。

## 2. 組み込みコマンドを送る

```
POST /api/sessions/<id>/command
{ "text": "/compact API の決めごとは残す" }
```

MCP では `run_command`（`session`、`command`、`as`、`as_session`）を使う。

- 文は from 行を付けずに、そのまま入力として送る。`POST /api/sessions/<id>/messages` は本文の前に from 行を付けるので、組み込みコマンドが動かない。
- 送り手は台帳の `command` のイベント（`{text, from}`）に残る。
- 応答は `{ "delivered": "stdin" | "pty" }`。MCP は send_message と同じく `cursor` を返すので、`read_messages` の `after` に渡す。
- コマンドの出力は、合成の assistant の行（`message.model` が `<synthetic>`）と、その後の `result` で届く。

### 断られるとき

| 状態コード | `code` | 意味 |
| --- | --- | --- |
| 400 | `not_command` | 文が `/` で始まらない。ふつうの文は messages で送る |
| 400 | `use_configure` | `/model`。1 の口を使う |
| 400 | `use_stop` | `/exit`、`/quit`。`DELETE /api/sessions/<id>` を使う |
| 409 | `first_message_required` | プロンプト無しで立てたセッションに、まだ1通目が届いていない。先に messages で送る |
| 409 | `persists` | pty の `/effort`、`/fast`。対話の claude は全セッションの設定に保存するので送らない |
| 409 | `no_commands` | 端末のセッション |
| 409 | なし | 終わっている（`hint: resume`）、pty が承認待ち（answer してから送る） |

### コマンドごとの結果（2026-11-21 に実測）

| コマンド | node | pty |
| --- | --- | --- |
| `/context` | 出力が届く | 効くが、出力は端末にしか出ない。約9秒後に空の result が届く |
| `/compact [指示]` | 効く。result が届く（文は無い） | 効く。「Compacted …」と hook の結果の文が届く。間は `state` が `running` |
| `/clear` | 効く。result が届く | 効く。すぐ result が届く |
| `/cost`、`/usage` | 利用量の文が届く | 未確認 |
| `/effort <値>` | 効く。このセッションだけ | 409（`persists`） |
| `/status` | 「isn't available in this environment」 | 未確認 |
| スキル、カスタムコマンド | 未確認（Claude への文になる） | 未確認 |
| 選択画面を開くもの（`/resume`、`/permissions`、`/mcp` など） | 未確認 | 未確認。画面で止まったら interrupt（Esc）で閉じられるはず |

### `/clear` の後

`/clear` で会話の id が替わる。

- ccn の `id` は替わらない。そのまま送信と読み込みに使える。
- 新しい会話の id は `GET /api/sessions/<id>` の `conversationId` に出る。
- pty の台帳には `conversation_reset`（`{conversationId}`）のイベントが出る。
- セッションが終わった後に続きをするときは、`conversationId` を resume する。元の `id` を resume すると `/clear` の前の会話に戻る。
- `/clear` の後の会話は、次に messages で送った文の from 行から親を導く。

## 3. Town で使うときの勧め

- モデルと権限モードの切り替えは、`/model` を文で送らずに 1 の口を使う。pty で `/model` を打つと、機械の全セッションの既定まで書き換わる。
- チャット欄の入力が `/` で始まり、Claude に読ませる文でなければ 2 の口に送る。スキルのように Claude が読む文は、from 行の付く messages でも動くかを確かめてから選ぶ（未確認）。
- pty の切り替えは idle のときだけ受けるので、`state` を見てボタンを無効にするか、409 の `busy` を受けたら「止めてから替える」を出す。

## 作らなかったもの

ターミナルでしかできない操作で、口を作れば Town から扱えるもの。issue に分けた。

| 操作 | 考えられる口 | issue |
| --- | --- | --- |
| effort の切り替え | node は SDK の `applyFlagSettings({effortLevel})`、pty は `--effort` で起動し直す | #67 |
| thinking の切り替え | node は SDK の `setMaxThinkingTokens`、pty は起動の引数 | #67 |
| fast モード | node は `applyFlagSettings({fastMode})`、pty は `--settings` で起動し直す | #67 |
| context、cost、usage の値 | node は SDK の `getContextUsage` と result の利用量。pty は statusLine の入力にある値 | #68 |
| pty の `/context` の出力 | SDK が system の行の中身を返さないので、今は読めない | #68 |
| `/permissions`、`/mcp`、`/resume`、`/rewind`、`/status` | pty では選択画面になる。node は SDK の `mcpServerStatus`、`rewindFiles` など | #69 |

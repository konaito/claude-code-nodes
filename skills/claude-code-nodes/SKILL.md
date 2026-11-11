---
name: claude-code-nodes
description: Claude Code Nodes（ccn）の MCP サーバー（{{ORIGIN}}/mcp）で、複数の機械に置かれた Claude Code のセッションを一覧し、各機械の受け口に依頼を渡して行き先に子セッションを立ててもらい、子に文を送り、返事を待って読み、子の権限プロンプトに答え、中断し、止める。別の機械の Claude Code に作業を任せるとき、ccn のノードやセッションの状況を見るとき、子セッションの承認待ちに答えるときに使う。
---

# Claude Code Nodes（ccn）

この文書は {{ORIGIN}}/skill.md で配っている。ツール名は `ccn:<ツール名>` で書く。`ccn` は MCP サーバーとして足したときの名前で、Claude Code では `mcp__ccn__<ツール名>` と表示される。

## 何か

Claude Code Nodes は、Claude Code がログイン済みの機械ごとに1つずつ動くプログラム（ノード）の集まり。ノードは、その機械の Claude Code セッションを HTTP の API と MCP で開放する。

- どのノードも同じコードで動き、役割の違いは無い。入口（{{ORIGIN}}）は、DNS が向いているノードにすぎない。
- ノードは会話を保存しない。会話の正本は各機械の Claude Code の記録で、ノードはそれを読むだけ。
- ノードどうしは Cloudflare Tunnel と Cloudflare Access でつながる。別の機械のセッションへの操作は、入口のノードが相手のノードへ中継する。
- 仲間のノードの一覧は `ccn:list_peers` で読む。ほかのツールの `peer` には、この一覧の名前を渡す。

## 受け口

各ノードには受け口（lobby）のディレクトリがある。受け口のセッションは、届いた依頼から行き先のディレクトリを探し、そこに子を立てて渡す。

- `ccn:create_session` で `cwd` を省くと、受け口に立つ。`prompt` も省くと、1通目を待つ空のセッションになる。id はすぐ決まり、`state` は `idle` になる。
- 1通目を `ccn:send_message` で送ると動き出す。1通も送られないまま30分たったセッションは消える。
- 受け口は子を立てると、返事に `子: <peer>/<sessionId>` の行を書いて、すぐターンを終える。そのあとは、この子と直接やりとりする。
- 受け口は子を自分と同じ権限モードで立て、子の最初のターンの承認には受け口が答える。受け口のモードと依頼の範囲を超える操作は断り、返事でそのことを伝える。受け口自身を `default` で立てると、受け口の Bash にも承認が要る。
- 行き先を決められないとき、受け口は候補を並べた文で聞き返す。そのときは答えを `ccn:send_message` で受け口に送る。
- 読むだけの依頼（ファイルの中身、git log、状態を見て答える）には、受け口が子を立てずに答える。
- 受け口の場所、許された根（roots）、最近使われた場所は `ccn:list_places` で読める。

## セッションの種類

| 種類 | 何か | できること |
| --- | --- | --- |
| node | ノードが起動した子（`claude -p` と同じ形） | 文を送る、返事を読む、権限に答える、中断、停止、再開 |
| terminal | 人が端末の `claude` で起動したセッション | 文を送る、返事を読む（記録を読み直す） |

terminal に届いた文は「別のセッションからのメッセージ」として扱われる。権限の応答、中断、停止はできず、ツールは状態 409 の理由を返す。

## 呼び手と from 行

ノードは要求ごとに呼び手を決める。

- Access に email でログインした人は、その email が呼び手になる。
- ノード用サービストークンで来た要求と、同じ機械（127.0.0.1）からの要求は、`as` で名乗れる。名乗りは `agent:<ノード名>/<as_session の先頭8文字>/<as>` になる。名乗らなければ、サービストークンは `agent:<トークンの common_name>`、同じ機械は `local` になる。

子に届く文の1行目には、`from <呼び手> via <ノード名>` が付く。子はこの行で、誰から来た依頼かを知る。最初の文の from 行の呼び手が、そのセッションの `parent` になる。親は子を覚えないので、自分の子は `ccn:list_sessions` の `parent` で毎回探す。

## つなぎ方

MCP の口は `{{ORIGIN}}/mcp`（Streamable HTTP、状態なし、POST だけ）。どのノードにも同じ口があり、自分の機械のノードは `http://127.0.0.1:<port>/mcp` で呼べる。port は `~/.config/ccn/ccn.json` の `port`（既定 4322）。

### この機械にノードがあるとき

秘密は要らない。別の機械のセッションは、ツールの `peer` で中継して操作する。

```bash
claude mcp add --transport http ccn http://127.0.0.1:4322/mcp
```

### ノード用サービストークンで外から

ノードを入れていない機械やスクリプトから入口を呼ぶ道。ノードのある機械は、前の節の 127.0.0.1 で足りる。

Access のサービストークンをヘッダで送る。秘密をコマンドの引数や MCP の設定に書かず、Claude Code の `headersHelper` で手元のファイルから読む。ファイルはノードの `ccn.json` と同じ形（`serviceToken` の `clientId` と `clientSecret`）で、0600 にする。

```bash
cat > ~/.config/ccn/mcp-headers.sh <<'SH'
#!/bin/sh
exec jq -c '{"CF-Access-Client-Id": .serviceToken.clientId, "CF-Access-Client-Secret": .serviceToken.clientSecret}' ~/.config/ccn/ccn.json
SH
chmod 700 ~/.config/ccn/mcp-headers.sh
claude mcp add-json --scope user ccn '{"type":"http","url":"{{ORIGIN}}/mcp","headersHelper":"~/.config/ccn/mcp-headers.sh"}'
```

### OAuth で（Claude Code、claude.ai のカスタムコネクタ）

ノードの持ち主が Access アプリで Managed OAuth を有効にしているときだけ使える。有効なら、未認証の要求に Access が 401 と OAuth の案内を返し、クライアントはブラウザでのログインに進む。この道は、まだ本番で通していない。

```bash
claude mcp add --transport http ccn {{ORIGIN}}/mcp
# Claude Code の中で /mcp を開き、ccn を選んでブラウザでログインする
```

claude.ai では、設定のコネクタに `{{ORIGIN}}/mcp` を足してログインする。OAuth で来た呼び手が email として届くなら、`as` は効かず、子の `parent` は email になる。

## ツール

| ツール | すること | 主な引数 |
| --- | --- | --- |
| `ccn:list_peers` | ノードの一覧と healthy、down | なし |
| `ccn:list_sessions` | 1つのノードのセッション一覧。既定は終わっていないものだけ | `peer`、`parent`、`include_exited`、`limit` |
| `ccn:get_session` | 1つの詳細、保留中の承認、`cursor` | `peer`、`session` |
| `ccn:list_places` | 受け口、許された根、最近使われた場所 | `peer`、`limit` |
| `ccn:create_session` | 子を立てる。`cwd` を省くと受け口、`prompt` を省くと1通目を待つ | `peer`、`cwd`、`prompt`、`permission_mode`、`model`、`resume`、`fork`、`as`、`as_session` |
| `ccn:send_message` | 文を1つ送り、送る前の `cursor` を返す | `peer`、`session`、`text`、`as`、`as_session` |
| `ccn:read_messages` | `after` より後を読み、ターンの終わりまで最大50秒待つ | `peer`、`session`、`after`、`wait_seconds`、`max_chars` |
| `ccn:answer_permission` | 子の権限プロンプトに allow か deny で答える | `peer`、`session`、`behavior`、`request_id`、`message` |
| `ccn:interrupt_session` | 子の今のターンを止める。子は生きたまま | `peer`、`session` |
| `ccn:stop_session` | 子のプロセスを止める。会話は残り、`resume` で続けられる | `peer`、`session` |

`session` には、sessionId、その先頭8文字以上、`<peer>/<sessionId>` のどれでも渡せる。`peer` を省くと、MCP の口を出しているノードになる。

## 流れ

行き先のディレクトリを知らないときは、受け口に任せる。

1. `ccn:list_peers` で healthy なノードを選ぶ。
2. `ccn:create_session` を `cwd` と `prompt` を省いて呼び、受け口に空のセッションを立てる。返る `id` を覚える。
3. `ccn:send_message` で依頼を送る。依頼は1通で完結させる（「子への頼み方」の節）。返る `cursor` を覚える。
4. `ccn:read_messages` に `after` として `cursor` を渡し、`stop=result` まで待つ。返事の `子: <peer>/<sessionId>` の行が、立った子になる。聞き返されたら、答えを受け口に送って 3 に戻る。
5. 子の様子は `ccn:read_messages` に `session=<peer>/<sessionId>`、`after=0` を渡して読む。続けて頼むときは、子に `ccn:send_message` で1つ送り、返る `cursor` を `after` にして待つ。
6. 済んだら `ccn:stop_session` で子と受け口を止める。

行き先が分かっているときは、受け口を通さずに立ててよい。

1. `ccn:list_places` で受け口、許された根、最近使われた場所を見る。
2. `ccn:create_session` に `cwd`（許された根の下の絶対パス）を渡す。最初の文があれば `prompt` に入れる。`as` に役割（例 lead）、`as_session` に自分の sessionId を入れると、`parent` で自分の子だけを探せる。返る `id`、`parent`、`cursor` を覚える。
3. `prompt` を省いたときは、`ccn:send_message` で1通目を送る。
4. `ccn:read_messages` に `after` として `cursor` を渡して待つ。結果の最後の行の `stop` で次を決める。

## 待ちと終わり

`ccn:read_messages` は最大50秒で返す（既定30秒）。Cloudflare と MCP クライアントの締め切りより前に返すためで、長い作業は何度も呼んで待つ。最後の行は `stop=<理由> state=<状態> pending=<件数> cursor=<番号> session=<peer>/<id>` の形。

| stop | 意味 | 次にすること |
| --- | --- | --- |
| result | ターンが終わり、返事が出そろった | 読んで次を決める |
| permission | 子がツールの承認を待っている | `[pending]` 行の中身（`command="…"`、`file_path="…"`）を見て、requestId で `ccn:answer_permission` |
| exited | 子のプロセスが終わった | 続けるなら `ccn:create_session` に `resume=<id>`。終わった後の会話は位置で数え直すので、読み直すときは `after=0` |
| timeout | まだ動いている | 同じ `session` で `after=<cursor>` を渡して呼び直す |
| truncated | 文字数の上限に達した | `after=<cursor>` で続きを読む |

返事を急かす文は送らない。子のターンが乱れる。様子は `ccn:get_session` で見る。

## 権限モード

`ccn:create_session` の `permission_mode` を省くと、その機械の Claude Code の設定の既定になる（`auto` の機械もある）。返った `id` を `ccn:get_session` で引くと、実際の `permissionMode` が分かる。

- `default` を渡すと、子はツールを使うたびに承認を待つ（`state` が `waiting_permission`）。親が `ccn:answer_permission` で答える。
- 承認なしで任せるなら `bypassPermissions` を渡す。ccn の CLI の既定はこちら。

## 子への頼み方

- 1通で完結させる。目的、作業ディレクトリ、完了の条件、触ってはいけない範囲を書き、最後に「結果を文で書いて」と頼む。
- 子に質問をさせない。子が質問を出すと止まり、親からは答えられない。「迷ったら自分で決め、決めたことと理由を書く」と書く。
- 子への文は1ターンに1つ。返事を読んでから次を送る。
- 自分が立てていないセッション、人が使っている terminal のセッションには、頼まれない限り送らない。

## できないこと

- terminal のセッションの権限応答、中断、停止。
- ノードの外の機械や、登録されていない機械の操作。
- 許された根（ノードの設定の `roots`）の外の `cwd` での起動。
- 古い版のノードでの、受け口とプロンプト無しの作成。古い版は `cwd is required` か `prompt or resume is required` で断るので、`cwd` と `prompt` を両方渡す。

## CLI（ccn）がある機械

ノードの入った機械には CLI の `ccn` がある。MCP と同じ操作ができ、使い方は `~/.agents/skills/ccn/SKILL.md` にある。

```bash
ccn peers
ccn ls --mine
ccn new --peer <ノード名>                    # 受け口に空のセッションを立てる。<peer>/<id> が返る
ccn run <peer>/<id> "<依頼>" --wait 300      # 受け口に依頼を送り、返事の「子:」の行を読む
ccn new <dir> "<文>" --peer <ノード名> --as <役割>
ccn run <peer>/<id> "<文>" --wait 600
ccn allow <peer>/<id>
ccn stop <peer>/<id>
```

新しい機械をノードにするときは、その機械で `curl -fsSL {{ORIGIN}}/install | sh` を実行し、配る側の機械で `ccn node add <名前>` が出した参加トークンを貼る。

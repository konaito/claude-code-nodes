---
name: claude-code-nodes
description: Claude Code Nodes（ccn）の MCP サーバー（{{ORIGIN}}/mcp）で、複数の機械に置かれた Claude Code のセッションを一覧し、別の機械に子セッションを立て、文を送り、返事を待って読み、子の権限プロンプトに答え、中断し、止める。別の機械の Claude Code に作業を任せるとき、ccn のノードやセッションの状況を見るとき、子セッションの承認待ちに答えるときに使う。
---

# Claude Code Nodes（ccn）

この文書は {{ORIGIN}}/skill.md で配っている。ツール名は `ccn:<ツール名>` で書く。`ccn` は MCP サーバーとして足したときの名前で、Claude Code では `mcp__ccn__<ツール名>` と表示される。

## 何か

Claude Code Nodes は、Claude Code がログイン済みの機械ごとに1つずつ動くプログラム（ノード）の集まり。ノードは、その機械の Claude Code セッションを HTTP の API と MCP で開放する。

- どのノードも同じコードで動き、役割の違いは無い。入口（{{ORIGIN}}）は、DNS が向いているノードにすぎない。
- ノードは会話を保存しない。会話の正本は各機械の Claude Code の記録で、ノードはそれを読むだけ。
- ノードどうしは Cloudflare Tunnel と Cloudflare Access でつながる。別の機械のセッションへの操作は、入口のノードが相手のノードへ中継する。
- 仲間のノードの一覧は `ccn:list_peers` で読む。ほかのツールの `peer` には、この一覧の名前を渡す。

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

### ノード用サービストークンを持つ機械から

Access のサービストークンをヘッダで送る。秘密をコマンドの引数や設定ファイルに書かず、`headersHelper` で手元のファイルから読む。次をプロジェクトの `.mcp.json` に書く。

```json
{
  "mcpServers": {
    "ccn": {
      "type": "http",
      "url": "{{ORIGIN}}/mcp",
      "headersHelper": "jq -c '{\"CF-Access-Client-Id\": .serviceToken.clientId, \"CF-Access-Client-Secret\": .serviceToken.clientSecret}' ~/.config/ccn/ccn.json"
    }
  }
}
```

### OAuth で（Claude Code、claude.ai のカスタムコネクタ）

ノードの持ち主が Access アプリで Managed OAuth を有効にしているときだけ使える。有効なら、未認証の要求に Access が 401 と OAuth の案内を返し、クライアントはブラウザでのログインに進む。

```bash
claude mcp add --transport http ccn {{ORIGIN}}/mcp
# Claude Code の中で /mcp を開き、ccn を選んでブラウザでログインする
```

claude.ai では、設定のコネクタに `{{ORIGIN}}/mcp` を足してログインする。OAuth で来た呼び手は email なので、`as` は効かず、子の `parent` は email になる。

## ツール

| ツール | すること | 主な引数 |
| --- | --- | --- |
| `ccn:list_peers` | ノードの一覧と healthy、down | なし |
| `ccn:list_sessions` | 1つのノードのセッション一覧。既定は終わっていないものだけ | `peer`、`parent`、`include_exited`、`limit` |
| `ccn:get_session` | 1つの詳細、保留中の承認、`cursor` | `peer`、`session` |
| `ccn:create_session` | 子を立てて最初の文を送る | `peer`、`cwd`、`prompt`、`permission_mode`、`model`、`resume`、`fork`、`as`、`as_session` |
| `ccn:send_message` | 文を1つ送り、送る前の `cursor` を返す | `peer`、`session`、`text`、`as`、`as_session` |
| `ccn:read_messages` | `after` より後を読み、ターンの終わりまで最大50秒待つ | `peer`、`session`、`after`、`wait_seconds`、`max_chars` |
| `ccn:answer_permission` | 子の権限プロンプトに allow か deny で答える | `peer`、`session`、`behavior`、`request_id`、`message` |
| `ccn:interrupt_session` | 子の今のターンを止める。子は生きたまま | `peer`、`session` |
| `ccn:stop_session` | 子のプロセスを止める。会話は残り、`resume` で続けられる | `peer`、`session` |

`session` には、sessionId、その先頭8文字以上、`<peer>/<sessionId>` のどれでも渡せる。`peer` を省くと、MCP の口を出しているノードになる。

## 流れ

1. `ccn:list_peers` で healthy なノードを選ぶ。
2. `ccn:create_session` で子を立てる。`cwd` はそのノードで許された根の下の絶対パス。`as` に役割（例 lead）、`as_session` に自分の sessionId を入れると、`parent` で自分の子だけを探せる。返る `id`、`parent`、`cursor` を覚える。
3. `ccn:read_messages` に `after` として `cursor` を渡して待つ。結果の最後の行の `stop` で次を決める。
4. 続けて頼むときは `ccn:send_message` で1つ送り、返る `cursor` を `after` にして `ccn:read_messages` で待つ。
5. 済んだら `ccn:stop_session` で止める。

## 待ちと終わり

`ccn:read_messages` は最大50秒で返す（既定30秒）。Cloudflare と MCP クライアントの締め切りより前に返すためで、長い作業は何度も呼んで待つ。最後の行は `stop=<理由> state=<状態> pending=<件数> cursor=<番号> session=<peer>/<id>` の形。

| stop | 意味 | 次にすること |
| --- | --- | --- |
| result | ターンが終わり、返事が出そろった | 読んで次を決める |
| permission | 子がツールの承認を待っている | `[pending]` 行の requestId で `ccn:answer_permission` |
| exited | 子のプロセスが終わった | 続けるなら `ccn:create_session` に `resume=<id>` |
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

## CLI（ccn）がある機械

ノードの入った機械には CLI の `ccn` がある。MCP と同じ操作ができ、使い方は `~/.agents/skills/ccn/SKILL.md` にある。

```bash
ccn peers
ccn ls --mine
ccn new <dir> "<文>" --peer <ノード名> --as <役割>
ccn run <peer>/<id> "<文>" --wait 600
ccn allow <peer>/<id>
ccn stop <peer>/<id>
```

新しい機械をノードにするときは、その機械で `curl -fsSL {{ORIGIN}}/install | sh` を実行し、配る側の機械で `ccn node add <名前>` が出した参加トークンを貼る。

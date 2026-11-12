---
name: ccn
description: Claude Code Nodes（ccn）で、この機械（ccn(local)）か別の機械（ccn(remote)）に Claude Code のセッション（子）を立て、状況を読み、文を送り、返事を読んで次を決める。Specter の外で子に任せるときは、この機械に ccn(local) で立てる。これが既定の委譲先で、提案は要らない。本人が「/ccn」「子を立てて」「<別のマシン名> で Claude Code を動かして」「子セッションに頼んで」「<別のマシン名> のセッションを見て」「別のマシンの Claude に聞いて」と言ったときも使う。ccn(remote) は、並列のほうが速そうなだけのときは、立てる前に1行で提案して返事を待つ。
---

# ccn（Claude Code Nodes）

自分（親）はこの機械の Claude Code。子は別の機械（またはこの機械）で動く Claude Code のセッションで、`ccn` で扱う。どの機械にも同じノード（Claude Code Nodes）が居て、`~/.config/ccn/ccn.json` のサービストークンで相手のノード（`https://ccn-<ノード名>.fybe.jp`）を直接呼ぶ。材料はそのまま渡されるので、読んで判断するのは親の仕事。

- ccn(local): この機械のノードに立てる子。MCP の `create_session` に `terminal: true` を渡し、端末（PTY）の中の対話の claude として立てる。
- ccn(remote): 別の機械のノードに立てる子。主に CLI の `ccn` で扱う。

Specter の中では、同じ機械の子は specter-agents の `spawn_child` で作る。ccn(local) は使わない。

## いつ使うか

委譲先の順番は、Specter の中か外かで変わる。前の候補が使えないときだけ、次の候補に進む。

- Specter の外: ccn(local)、sub-agent（Agent ツール）、ccn(remote) の順。
- Specter の中: Specter の子（`spawn_child`）、sub-agent、ccn(remote) の順。

ccn(local) は Specter の外の既定の委譲先で、本人への提案は要らない。分けるかどうかと誰に何を任せるかを1行で伝え、返事は待たずに立てる。手順は「ccn(local) の手順」の節にある。

ccn(remote) を立てるのは、本人が「/ccn」か「子を立てて」と言ったときだけにする。

- 依頼の中に互いに独立した作業が2つ以上あり、並列のほうが速そうなときも、勝手には立てない。立てる前に1行で提案し（「incertotech に子を2体立てて A と B を並べたい」）、本人の返事を待つ。
- 例外として、別の機械にあるプロジェクトの実行、書き換え、git 操作は、提案を待たずにその機械へ立てる。受け口で動くセッションも、提案せずに子を立てる。
- 本人が「ここでやって」と言ったときと、この機械にしか無いものを触る作業は、ccn(remote) に出さない。

ccn(remote) を立てると決まったら、次のように進める。

- 子の置き場は `ccn peers` で healthy な別の機械のノード。常時起動の機械（incertotech）を既定にする。同時に走らせるのは5体まで。子ごとに別の作業ディレクトリ（別リポジトリか git worktree）にして、同じファイルを2人に触らせない。
- 手順は、`ccn new` を作業の数だけ、`ccn send` を全部出してから `ccn wait <対象>...` で全員を待つ。1体ずつ `run` で待たない。
- 立てた子と頼んだことは、本人に先に1行で伝える（「incertotech に子を3体立てて、A、B、C を頼んだ」）。終わったら結果をまとめ、子は `ccn stop` で消す。

## ccn(local) の手順

この機械のノードの MCP（`mcp__ccn__*`）で扱う。`peer` は省く。

1. `create_session` で子を立てる。渡す引数は次のとおり。
   - `cwd`: 対象のディレクトリの絶対パス
   - `terminal`: `true`
   - `name`: 一覧と画面に出す表示名
   - `as`: 役割（例 lead、reviewer）
   - `as_session`: 自分の `$CLAUDE_CODE_SESSION_ID`。必ず渡す。省くと `parent` が `agent:<ノード>/<役割>` になり、Claude Town で親子がつながらず、ノードが深さを数えられない。渡すと `agent:<ノード>/<自分の sessionId 先頭8文字>/<役割>` になる
   - `prompt`: 最初の文。省いたら `send_message` で送る
   - `permission_mode`: 省くと、この機械の Claude Code の既定になる。CLI の既定の `bypassPermissions` とは違う
2. 指示は `send_message` で送り、返る `cursor` を控える。子が終わった後の `parent` は1通目の from 行から決まるので、`as` と `as_session` も `create_session` と同じものを渡す。
3. 返事は `read_messages` に `after=<cursor>` を渡して読む。最大50秒で返るので、最後の行の `stop` を見て呼び直す。
4. `stop=permission` なら、`get_session` の `pending` を見て `answer_permission` で答える。承認待ちの間は `send_message` が 409 で断られる。
5. 済んだら `stop_session` で止める。

初めて使うディレクトリでは、claude が端末に信頼の確認を出す。人が端末で答えるまで、承認も返事も届かない。ほかの引数と `stop` の意味は、ノードが配る `/skill.md` にある。

## 仕組み

- ccn(remote) の子は、ノードが `claude -p`（stream-json）で起動するセッション。ccn(local) の子は、ノードが端末（PTY）の中で起動する対話の claude。親の文は子の会話に届き、1行目に `from agent:<ノード名>/<親の sessionId 先頭8文字>/<役割> via <送ったノード名>` が付く。この行から、画面と `ccn ls` の「parent」が親子をたどる。子はそれを本人の作業を親が分けて渡したものとして、本人の依頼と同じに扱う。push、PR、マージ、デプロイ、設定の変更も、親の依頼の範囲なら確かめずに進める（`~/.config/ccn/child.md`）。
- 子は孫までしか作れない。人が立てたセッションが深さ0、その子が1、孫が2で、孫（深さ2）が子を作ろうとすると、ノードが 409 で「孫（深さ2）は子を作れない。仕事は自分でやるか、sub-agent（Agent ツール）を使う」と断る。孫は自分でやるか sub-agent を使う。深さは作成の応答と `ccn show` の `depth` で分かる。受け口は段に数えない。
- 各ノードには受け口（`~/.local/share/ccn/lobby`）がある。`ccn new` で dir を省くと受け口に立つ。受け口のセッションは依頼から行き先のディレクトリを探してそこに子を立て、返事に `子: <ノード名>/<sessionId>` の行を書く。行き先が分からないときに使う。
- 文を省いて立てたセッションは、id がすぐ決まり、1通目（`ccn send`）が届くまで claude を起動しない（`state` は `idle`）。1通も届かないまま30分たつと消える。
- 子の権限プロンプトには親が答えられる。`ccn new` の既定は `--mode bypassPermissions`（承認なし）。`--mode default` で立てると、子がツールを使うたびに `waiting_permission` で止まり、`ccn show` の `pending:` に出る。`ccn allow <対象>` か `ccn deny <対象> <理由>` で答える。
- 子への文は1ターンに1件。子の返事は `ccn read` で読む（SSE で result まで待つ。トンネルが瞬断しても、最後に読んだ seq からつなぎ直す）。子から親へ送り返す道は無い。
- 端末のセッション（人が `claude` で起動したもの。`ccn ls` で `terminal`）にも `ccn send` で届くが、「別セッションからのメッセージ」として扱われ、権限応答と中断はできない。`ccn read` は transcript をポーリングする。
- 子に質問をさせない。文に判断の材料を全部入れ、「迷ったら自分で決めて、決めたことと理由を書け」と書く。子が AskUserQuestion を出すと止まり、親には答えられない。

## 流れ

この節と次の「命令」の節は、CLI で ccn(remote) を扱う手順。ccn(local) は「ccn(local) の手順」の節に従う。

1. `ccn peers` でノードと状態を見る。`ccn ls` で全ノードのセッションを見る。
2. 子が無ければ `ccn new <dir> "<最初の文>" --peer <ノード名> --as <役割>` で立てる。`<ノード名>/<sessionId>` が返る。行き先のディレクトリが分からないときは、`ccn new --peer <ノード名>` で受け口に立て、`ccn run <対象> "<依頼>"` の返事にある `子:` の行の子を使う。
3. `ccn show <対象>` で状況を読む。`state`、`permissionMode`、`parent`、`pending`。
4. 子が1体なら `ccn run <対象> "<文>" --as <役割> --wait 600` で送って返事を待つ。名乗る名前は CLI が `<ノード名>/<自分の sessionId の先頭8文字>/<役割>` に組み立てるので、`--as` は役割名だけ（例: lead、reviewer）。複数なら `ccn send` を全部出してから `ccn wait <対象>... --wait 600`。
5. 終了コードで分ける。0 は返事が出そろった。2 は時間切れで、`ccn read <対象> --wait 600` で続きを待つ。3 は権限待ちで、`ccn show` の pending を見て `ccn allow` か `ccn deny`。4 は子が終了していて、`ccn new --resume <id>` で再開できる。
6. 済んだら `ccn stop <対象>` で子を止める。本人の指示で残す場合はそのまま。

## 命令

```bash
ccn peers                                           # 登録簿（ノード、healthy/down、URL）
ccn places [<語>...] [--peer <名>] [--json]          # 行き先の候補（roots と Documents の直下、README の先頭、remote、最近使ったか）
ccn ls [--peer <名>] [--mine]                        # セッション一覧。--mine は自分が立てた子だけ
ccn show [<対象>]                                    # 1つの詳細と pending（保留中の承認）。Claude Code の中で対象を省くと自分のセッション
ccn new [<dir> ["<文>"]] [--peer <名>] [--mode <permissionMode>] [--model <m>] [--resume <id>] [--as <役割>]
                                                    # dir を省くと受け口、文を省くと1通目を待つ（ccn send で送る）
ccn send <対象> "<文>|-" [--as <役割>]                # 文を送る。- は標準入力。送る前の seq を控える
ccn read <対象> [--after <seq>] [--wait <秒>]         # 返事を読む（既定 120 秒）。終了コード 0/2/3/4
ccn run <対象> "<文>" [--wait <秒>]                   # send のあと read（子が1体のとき）
ccn wait <対象>... [--wait <秒>]                      # 送ってある複数の子を同時に待つ。終了コードはいちばん大きいもの
ccn allow <対象> [requestId]                          # 承認（pending が1件なら requestId 省略可）
ccn deny <対象> [requestId] "<理由>"                   # 拒否
ccn interrupt <対象>                                  # 今のターンを止める
ccn stop <対象>                                       # 子を止める（jsonl は残り、--resume で再開できる）
```

`<対象>` は `<ノード名>/<sessionId の先頭8文字以上>` か sessionId。ノード名を省くと手元のノード。`<文>` を `-` にすると標準入力から読む。`--as` は役割名だけで、使えない文字は `-` になる。

`ccn read` と `ccn run` の最後に `state=<状態> pending=<件数> seq=<番号>` が生のまま出る。終了判定に頼らず自分で見る。

## 命令の書き方

- 1通で自己完結させる。目的、作業ディレクトリ、完了条件、やってはいけないこと、最後に「結果を文で書いて」。
- 長い作業の途中は `ccn show` と `ccn read --wait 0` で見る。催促の文は送らない。子のターンが乱れる。
- 複数の子に同じ前提を伝えるときも、文は子ごとに書く。他の子が何をしているかと、触ってはいけない範囲を入れる。

## 触らないもの

- 自分が立てていないセッション。本人が指定したときだけ送る。一覧には本人の端末セッションも出る。
- この機械で本人が使っている対話セッション。自分（親）も一覧に出るが、自分には送らない。

## 本人への報告

子ごとに、何を頼み、何が返り、何が残っているかを文でまとめる。子の返事をそのまま貼らない。

## 状況の読み方

- `ccn ls` の `parent` で、自分が立てていない子も探せる。
- `state` が `waiting_permission` なら承認待ち。`ccn show` の `pending:` に requestId、ツール名、中身（Bash は `command="…"`、Write、Edit、Read は `file_path="…"`、ほかは主な入力）、子が書いた説明 `("…")` の順で出る。長い値は `…(+N字)` で切れる。答えるときは説明ではなく中身を見る。
- `state` が `exited` なら終了。`exitReason` に理由。`ccn new <dir> "<文>" --resume <id>` で同じ会話を続けられる。
- 端末のセッションは `claude agents --json` の状態で、`running`、`waiting_permission`（権限か質問で止まっている）、`idle` のどれか。

## 設定

- `~/.config/ccn/ccn.json`（0600）。ノードの名前、ポート、domain、サービストークン。参加（`curl -fsSL <入口>/install | sh`）が書く。
- 相手のノードは `https://ccn-<ノード名>.fybe.jp` を直接呼ぶ（改名前のノードは登録簿に `https://cc-<ノード名>.fybe.jp` で出る）。手元のノードは `http://127.0.0.1:<port>` に無認証。別のホストにはトークンを付けない。

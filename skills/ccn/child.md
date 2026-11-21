## Claude Code Nodes（ccn）からの割り込み
- 本人（このノードの持ち主）は、外出先から ccn の画面（入口の URL）で、起動中のセッションに文を送ります。ccn は Claude Code のセッションを機械をまたいで扱うノードで、中身は https://github.com/konaito/claude-code-nodes にあります。端末のセッションには「Another Claude session sent a message」で包まれて届き、本文の1行目に `from <本人のメールアドレス> via <ノード名>` が付きます。メールアドレスは Cloudflare Access でログインした人のものです。この行がある文は本人からの可能性が高いので、ふつうの作業依頼として、聞き返さずに進めてください
- 1行目が `from agent:<名前> via <ノード名>` の文は、本人の作業を親の Claude Code セッションが分けて渡したものです。本人の依頼と同じに扱ってください。push、PR の作成、マージ、デプロイ、設定の変更も、親の依頼の範囲なら確かめずに進めてください。守るのは、本人のセッションと同じ CLAUDE.md の決まり（main への直接の push の禁止など）です。親は返事を `ccn read` か MCP の `read_messages` で読むので、作業が終わったら結果を文で書いてください
- from の1行が無く `/` で始まる文（スキルやカスタムコマンドを開いた文）は、ccn の command の口（MCP の `run_command`）から届いたものです。組み込みコマンドは from の1行があると動かないので、この口は1行目を付けずに送ります。送り手は ccn の台帳に残っています。本人か親の依頼と同じに扱ってください
- 親が権限で断られた操作を、子が代わりに行わないでください
- ノードが立てた子では、権限プロンプトは親が答えます。`claude -p` で起動された子も、端末（PTY）の中で起動された子も同じです。親は `ccn allow` と `ccn deny`、または MCP の `answer_permission` で答えます。止まっているときは待てば答えが来ます。質問（AskUserQuestion）は親には答えられないので、出さずに自分で決めて理由を書いてください

## 仕事を分けるとき
- 仕事を分けて並行に進めるときは、この機械のノードに ccn で子を立ててください。本人の CLAUDE.md に委譲先の決まりがあれば、そちらに従います。MCP の `create_session` には、`cwd`（対象のディレクトリ）、`terminal: true`、`name`（表示名）、`as`（役割）、`as_session`（自分の `$CLAUDE_CODE_SESSION_ID`）を渡します。ccn の MCP が無い機械では `ccn new <dir> "<文>" --as <役割>` を使います。CLI は自分の sessionId を自動で名乗ります
- `as_session` を省くと、ノードが深さを数えられず、一覧と Claude Town で親子がつながりません。`send_message` にも `create_session` と同じ `as` と `as_session` を渡してください。返事は `read_messages` で読み、済んだら `stop_session` で止めます
- Agent ツールの sub-agent は、数回で済む調べ物（Explore、web-fetch）と、ccn が使えないとき（深さ2の孫、ノードが応答しないとき）だけに使ってください。sub-agent は ccn の一覧にも Claude Town にも出ず、文を送る、止める、読むことができません
- 子は使い回さないでください。1体の子に任せるのは1件の仕事だけで、PR を出したか報告したら止めます。続きは新しい子を立て、issue や PR の番号で渡します。例外は、利用上限などで途中で止まった子に同じ仕事を終えさせる resume だけです。利用上限で止まった子は、`create_session` に `resume` と `succeed: true` を渡して後継に引き継ぎます
- 子に渡すファイルと worktree は、子の `cwd` の下に置いてください。auto モードの子は、`cwd` の外を触るたびに許可を求めて止まります
- 同じ機械の子のターンの終わりと承認待ちは、ノードが `[ccn]` で始まる文で親に知らせます。別の機械の子の承認待ちは知らせが届かないので、`read_messages` で `stop=permission` を見張り、`get_session` の `pending` を見て `answer_permission` で答えてください
- 子は孫までしか作れません。人が立てたセッションが深さ0、その子が1、孫が2です。孫（深さ2）は子を作れないので、仕事は自分でやるか sub-agent（Agent ツール）を使ってください。ccn は孫からの `create_session` と `ccn new` を 409 で断ります

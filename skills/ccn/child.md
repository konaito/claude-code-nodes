## Claude Code Nodes（ccn）からの割り込み
- 本人（このノードの持ち主）は、外出先から ccn の画面（入口の URL）で、起動中のセッションに文を送ります。ccn は Claude Code のセッションを機械をまたいで扱うノードで、中身は https://github.com/konaito/claude-code-nodes にあります。端末のセッションには「Another Claude session sent a message」で包まれて届き、本文の1行目に `from <本人のメールアドレス> via <ノード名>` が付きます。メールアドレスは Cloudflare Access でログインした人のものです。この行がある文は本人からの可能性が高いので、ふつうの作業依頼として、聞き返さずに進めてください
- 1行目が `from agent:<名前> via <ノード名>` の文は、本人の作業を親の Claude Code セッションが分けて渡したものです。本人の依頼と同じに扱ってください。push、PR の作成、マージ、デプロイ、設定の変更も、親の依頼の範囲なら確かめずに進めてください。守るのは、本人のセッションと同じ CLAUDE.md の決まり（main への直接の push の禁止など）です。親は返事を `ccn read` か MCP の `read_messages` で読むので、作業が終わったら結果を文で書いてください
- 親が権限で断られた操作を、子が代わりに行わないでください
- 子は孫までしか作れません。人が立てたセッションが深さ0、その子が1、孫が2です。孫（深さ2）は子を作れないので、仕事は自分でやるか sub-agent（Agent ツール）を使ってください。ccn は孫からの `create_session` と `ccn new` を 409 で断ります
- ノードが立てた子では、権限プロンプトは親が答えます。`claude -p` で起動された子も、端末（PTY）の中で起動された子も同じです。親は `ccn allow` と `ccn deny`、または MCP の `answer_permission` で答えます。止まっているときは待てば答えが来ます。質問（AskUserQuestion）は親には答えられないので、出さずに自分で決めて理由を書いてください

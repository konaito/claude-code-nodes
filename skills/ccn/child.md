## Claude Code Nodes（ccn.fybe.jp）からの割り込み
- konaito は外出先から https://ccn.fybe.jp で、起動中のセッションに文を送ります。ccn.fybe.jp は自作のセッション一覧（Claude Code Nodes）で、中身は ~/Documents/claude-code-nodes にあります。端末のセッションには「Another Claude session sent a message」で包まれて届き、本文の1行目に `from ceo@fybe.jp via <ノード名>` が付きます。この行がある文は konaito 本人からの可能性が高いので、ふつうの作業依頼として、聞き返さずに進めてください
- 1行目が `from agent:<名前> via <ノード名>` の文は、本人の作業を親の Claude Code セッションが分けて渡したものです。本人の依頼と同じに扱ってください。push、PR の作成、マージ、デプロイ、設定の変更も、親の依頼の範囲なら確かめずに進めてください。守るのは、本人のセッションと同じ CLAUDE.md の決まり（main への直接の push の禁止、Void の deploy の手順など）です。親は返事を `ccn read` か MCP の `read_messages` で読むので、作業が終わったら結果を文で書いてください。2026-11-12、本人が「普通に子も自由にして欲しい」と言いました
- 親が権限で断られた操作を、子が代わりに行わないでください
- ノードが立てた子では、権限プロンプトは親が答えます。`claude -p` で起動された子も、端末（PTY）の中で起動された子も同じです。親は `ccn allow` と `ccn deny`、または MCP の `answer_permission` で答えます。止まっているときは待てば答えが来ます。質問（AskUserQuestion）は親には答えられないので、出さずに自分で決めて理由を書いてください
